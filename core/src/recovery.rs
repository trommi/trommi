//! Recovery, and signing in on a new device (section 8): the keys that follow from the recovery code, the sealed
//! copy of every content key (`SealedKey`), the authorisation of a join from outside (`RecoveryAuth`), the link
//! from a new code back to the one it replaced (`RecoveryLink`), and the checks a device runs on what a hub
//! serves before it joins with the code.
//!
//! Three keys follow from the code. `recovery_sign` authorises a join from outside. `recovery_hpke` opens the
//! sealed content keys. `recovery_mac` authenticates sealed rows and links: HPKE sealing alone is anonymous, so
//! without it a hub could hand a device that signs in a room and a history of its own making. Human devices hold
//! `recovery_mac` ([`MacKeys`]); only a device with the code in hand holds the two key pairs ([`RecoveryKeys`]),
//! and [`RecoveryKeys::finish`] forgets them once the join is done.
//!
//! Everything here works on bytes and on what the caller fetched: no store, no group. The one fact it reads from
//! a followed group is whether a GroupInfo agrees with an observer's state ([`check_agreement`]).

use crate::codec::{self, Decode, Encode, Reader, Writer};
use crate::crypto::{self, Entropy, HpkeCiphertext, HpkeKeyPair, Secret, SigningKey, TAG_LEN};
use crate::error::Error;
use crate::ids::SessionId;
use crate::ids::{DeviceId, GroupId, Hash32, RoomId};
use crate::mls::observer::{Context, Observer};
use crate::mls::profile::{Cut, TrommiRoom, MAX_HUMAN_DEVICES_IN_RECOVERY, RECOVERY_KEY_LEN};
use crate::mls::rules::{
    self, CommitFacts, JoinClaim, Parent, RecoveryRules, RoomHistory, RoomState, SealedKeyClaim,
    SessionFacts,
};
use std::collections::btree_map::Entry;
use std::collections::{BTreeMap, BTreeSet};
use zeroize::Zeroizing;

/// The label that derives the seed of `recovery_sign` from the code.
pub const SIGN_LABEL: &str = "trommi recovery sign";
/// The label that derives what `DeriveKeyPair` is given for `recovery_hpke`.
pub const HPKE_LABEL: &str = "trommi recovery hpke";
/// The label that derives `recovery_mac`.
pub const MAC_LABEL: &str = "trommi recovery mac";
/// The label of a `SealedKey`'s sealing, and the prefix of its `mac` input.
pub const SEALED_KEY_LABEL: &str = "TrommiSealedKey";
/// The label of a `RecoveryLink`'s sealing, and the prefix of its `mac` input.
pub const LINK_LABEL: &str = "TrommiRecoveryLink";
/// The label of the signature in a `RecoveryAuth`.
pub const JOIN_LABEL: &str = "TrommiRecoveryJoin";
/// The label of the hash that names a GroupInfo.
pub const GROUP_INFO_LABEL: &str = "Trommi Group Info";
/// The label of the hash that names a Commit.
pub const COMMIT_LABEL: &str = "Trommi Commit";

/// The length of a `mac`.
pub const MAC_LEN: usize = 32;
/// The length of the signature in a `RecoveryAuth`.
pub const SIGNATURE_LEN: usize = 64;
/// The length of an HPKE encapsulated key of the suite.
const KEM_OUTPUT_LEN: usize = 32;
/// The length of a content key.
const CONTENT_KEY_LEN: usize = 32;
/// The length of an encoded [`OldRecovery`].
const OLD_RECOVERY_LEN: usize = 64;

/// The most bytes of an encoded [`SealedKey`]: a session group's, with its `mac`.
pub const MAX_SEALED_KEY_LEN: usize = 277;
/// The most bytes of an encoded [`RecoveryAuth`]: a session group's.
pub const MAX_RECOVERY_AUTH_LEN: usize = 259;
/// The bytes of an encoded [`RecoveryLink`].
pub const MAX_RECOVERY_LINK_LEN: usize = 213;

/// `RefHash("Trommi Group Info", GroupInfo)`: how a `SealedKey` and a `RecoveryJoin` name a GroupInfo as posted.
pub fn group_info_hash(group_info: &[u8]) -> Result<Hash32, Error> {
    crypto::ref_hash(GROUP_INFO_LABEL, group_info)
}

/// `RefHash("Trommi Commit", Commit)`: how a `RecoveryAuth` names the Commit as posted.
pub fn commit_hash(commit: &[u8]) -> Result<Hash32, Error> {
    crypto::ref_hash(COMMIT_LABEL, commit)
}

fn key_field(reader: &mut Reader<'_>) -> Result<[u8; RECOVERY_KEY_LEN], Error> {
    reader.opaque()?.try_into().map_err(|_| Error::BadFormat)
}

/// An `HPKECiphertext` whose plaintext has `plaintext_len` bytes; any other size is refused.
fn sealed_field(reader: &mut Reader<'_>, plaintext_len: usize) -> Result<HpkeCiphertext, Error> {
    let sealed: HpkeCiphertext = reader.value()?;
    let expected = plaintext_len.checked_add(TAG_LEN);
    if sealed.kem_output.len() != KEM_OUTPUT_LEN || Some(sealed.ciphertext.len()) != expected {
        return Err(Error::BadFormat);
    }
    Ok(sealed)
}

/// The group, epoch and GroupInfo a sealed key or a join belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeyContext {
    /// The group.
    pub group: GroupId,
    /// The epoch.
    pub epoch: u64,
    /// [`group_info_hash`] of the GroupInfo posted for that group and epoch.
    pub group_info: Hash32,
}

impl KeyContext {
    /// The context of `group` at `epoch` with the GroupInfo as it is posted.
    pub fn of(group: &GroupId, epoch: u64, group_info: &[u8]) -> Result<Self, Error> {
        Ok(Self {
            group: *group,
            epoch,
            group_info: group_info_hash(group_info)?,
        })
    }
}

impl Encode for KeyContext {
    fn write(&self, writer: &mut Writer) -> Result<(), Error> {
        writer.value(&self.group)?;
        writer.u64(self.epoch);
        writer.value(&self.group_info)
    }
}

impl Decode for KeyContext {
    fn read(reader: &mut Reader<'_>) -> Result<Self, Error> {
        Ok(Self {
            group: reader.value()?,
            epoch: reader.u64()?,
            group_info: reader.value()?,
        })
    }
}

/// What a `mac` says under one `recovery_mac`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MacState {
    /// It is the HMAC under that key: a human device wrote the row.
    Valid,
    /// The row carries none: a non-human writer.
    Absent,
    /// It is not empty and does not verify.
    Invalid,
}

/// The content key of one group and epoch, sealed to the room's recovery key (8.2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SealedKey {
    /// What the key belongs to.
    pub context: KeyContext,
    /// The room epoch whose state holds the recovery key the row is sealed to.
    pub room_epoch: u64,
    /// That recovery key.
    pub recovery_hpke_key: [u8; RECOVERY_KEY_LEN],
    /// `EncryptWithLabel(recovery_hpke_key, "TrommiSealedKey", KeyContext, content_key)`.
    pub sealed: HpkeCiphertext,
    /// The device that wrote the row.
    pub writer: DeviceId,
    /// `HMAC-SHA-256(recovery_mac, "TrommiSealedKey" ‖ all fields before mac)`; none from a non-human writer.
    pub mac: Option<[u8; MAC_LEN]>,
}

/// What a [`SealedKey`] is made from.
#[derive(Debug)]
pub struct Sealing<'a> {
    /// What the key belongs to.
    pub context: KeyContext,
    /// The room epoch whose state holds `recovery_hpke_key`.
    pub room_epoch: u64,
    /// The recovery key to seal to.
    pub recovery_hpke_key: &'a [u8; RECOVERY_KEY_LEN],
    /// The device that writes the row.
    pub writer: DeviceId,
    /// `content_key(group, epoch)`.
    pub content_key: &'a Secret<32>,
}

impl SealedKey {
    /// Seals a content key. `recovery_mac` is the key of a human writer; a writer without one leaves `mac` empty.
    pub fn seal(
        entropy: &mut dyn Entropy,
        sealing: &Sealing<'_>,
        recovery_mac: Option<&Secret<32>>,
    ) -> Result<Self, Error> {
        let sealed = crypto::encrypt_with_label(
            entropy,
            sealing.recovery_hpke_key,
            SEALED_KEY_LABEL,
            &codec::encode(&sealing.context)?,
            sealing.content_key.expose(),
        )?;
        let mut row = Self {
            context: sealing.context,
            room_epoch: sealing.room_epoch,
            recovery_hpke_key: *sealing.recovery_hpke_key,
            sealed,
            writer: sealing.writer,
            mac: None,
        };
        if let Some(key) = recovery_mac {
            row.mac = Some(crypto::hmac_sha256(key, &row.mac_input()?)?);
        }
        Ok(row)
    }

    fn write_before_mac(&self, writer: &mut Writer) -> Result<(), Error> {
        writer.value(&self.context)?;
        writer.u64(self.room_epoch);
        writer.opaque(&self.recovery_hpke_key)?;
        writer.value(&self.sealed)?;
        writer.value(&self.writer)
    }

    fn mac_input(&self) -> Result<Vec<u8>, Error> {
        let mut input = Writer::new();
        input.fixed(SEALED_KEY_LABEL.as_bytes());
        self.write_before_mac(&mut input)?;
        Ok(input.into_bytes())
    }

    /// What the row's `mac` says under `recovery_mac`, compared in constant time.
    pub fn mac_state(&self, recovery_mac: &Secret<32>) -> Result<MacState, Error> {
        let Some(mac) = &self.mac else {
            return Ok(MacState::Absent);
        };
        if crypto::hmac_verify(recovery_mac, &self.mac_input()?, mac)? {
            Ok(MacState::Valid)
        } else {
            Ok(MacState::Invalid)
        }
    }

    /// The content key, opened with the private half of the recovery key the row names: `wrong-recovery` when
    /// `opener` is for another key, `decrypt-failed` when the row does not open to a content key. Opening says
    /// nothing about who wrote the row: [`SealedKey::mac_state`] does.
    pub fn open(&self, opener: &Opener) -> Result<Secret<32>, Error> {
        if self.recovery_hpke_key != opener.hpke.public {
            return Err(Error::WrongRecovery);
        }
        let opened = crypto::decrypt_with_label(
            &opener.hpke.private,
            SEALED_KEY_LABEL,
            &codec::encode(&self.context)?,
            &self.sealed,
        )?;
        Secret::from_slice(opened.expose()).map_err(|_| Error::DecryptFailed)
    }

    /// The row as it is posted.
    pub fn to_bytes(&self) -> Result<Vec<u8>, Error> {
        codec::encode(self)
    }

    /// Reads a row as it is posted or served; `bad-format` for anything but exactly one well-formed row.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, Error> {
        codec::decode(bytes, MAX_SEALED_KEY_LEN).map_err(|_| Error::BadFormat)
    }
}

impl Encode for SealedKey {
    fn write(&self, writer: &mut Writer) -> Result<(), Error> {
        self.write_before_mac(writer)?;
        match &self.mac {
            Some(mac) => writer.opaque(mac),
            None => writer.opaque(&[]),
        }
    }
}

impl Decode for SealedKey {
    fn read(reader: &mut Reader<'_>) -> Result<Self, Error> {
        Ok(Self {
            context: reader.value()?,
            room_epoch: reader.u64()?,
            recovery_hpke_key: key_field(reader)?,
            sealed: sealed_field(reader, CONTENT_KEY_LEN)?,
            writer: reader.value()?,
            mac: match reader.opaque()? {
                [] => None,
                mac => Some(mac.try_into().map_err(|_| Error::BadFormat)?),
            },
        })
    }
}

/// What a join from outside claims (8.4): the state it builds on, the room state it names, and who joins.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RecoveryJoin {
    /// The group, the epoch the Commit builds on, and the GroupInfo posted for that epoch.
    pub base: KeyContext,
    /// The `room_epoch` of the Commit's note.
    pub room_epoch: u64,
    /// The `room_state` of the Commit's note.
    pub room_state: Hash32,
    /// The device of the Commit's new leaf.
    pub joiner: DeviceId,
}

impl Encode for RecoveryJoin {
    fn write(&self, writer: &mut Writer) -> Result<(), Error> {
        writer.value(&self.base)?;
        writer.u64(self.room_epoch);
        writer.value(&self.room_state)?;
        writer.value(&self.joiner)
    }
}

impl Decode for RecoveryJoin {
    fn read(reader: &mut Reader<'_>) -> Result<Self, Error> {
        Ok(Self {
            base: reader.value()?,
            room_epoch: reader.u64()?,
            room_state: reader.value()?,
            joiner: reader.value()?,
        })
    }
}

/// A join from outside as its verifier sees it: what a [`RecoveryAuth`] must name.
#[derive(Debug, Clone, Copy)]
pub struct JoinFacts<'a> {
    /// The group joined.
    pub group: &'a GroupId,
    /// The epoch the Commit builds on.
    pub epoch: u64,
    /// [`group_info_hash`] of the GroupInfo posted for that epoch, for a verifier that holds it: the hub. A
    /// member holds no posted GroupInfo and checks group and epoch.
    pub base_group_info: Option<&'a Hash32>,
    /// The `room_epoch` of the Commit's note.
    pub room_epoch: u64,
    /// The `room_state` of the Commit's note.
    pub room_state: &'a Hash32,
    /// The credential of the Commit's new leaf.
    pub joiner: &'a DeviceId,
    /// The Commit as posted.
    pub commit: &'a [u8],
    /// The `recovery_signature_key` of the room state at the note's `room_epoch`.
    pub recovery_signature_key: &'a [u8; RECOVERY_KEY_LEN],
}

/// The authorisation of one join from outside: a signature of `recovery_sign` over the join and the hash of its
/// Commit, so that it fits no other Commit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoveryAuth {
    /// What the join claims.
    pub join: RecoveryJoin,
    /// [`commit_hash`] of the external Commit.
    pub commit: Hash32,
    /// `SignWithLabel(recovery_sign, "TrommiRecoveryJoin", join ‖ commit)`.
    pub signature: [u8; SIGNATURE_LEN],
}

impl RecoveryAuth {
    fn signed(join: &RecoveryJoin, commit: &Hash32) -> Result<Vec<u8>, Error> {
        let mut content = Writer::new();
        content.value(join)?;
        content.value(commit)?;
        Ok(content.into_bytes())
    }

    /// Whether this authorises the join `facts` describe (8.4): every field is the Commit's own (`bad-commit`
    /// otherwise), and the signature verifies under the room's `recovery_signature_key` (`bad-signature`).
    pub fn verify(&self, facts: &JoinFacts<'_>) -> Result<(), Error> {
        let join = &self.join;
        let fits = join.room_epoch == facts.room_epoch
            && join.room_state == *facts.room_state
            && join.base.group == *facts.group
            && join.base.epoch == facts.epoch
            && facts
                .base_group_info
                .is_none_or(|posted| join.base.group_info == *posted)
            && join.joiner == *facts.joiner
            && self.commit == commit_hash(facts.commit)?;
        if !fits {
            return Err(Error::BadCommit);
        }
        crypto::verify_with_label(
            facts.recovery_signature_key,
            JOIN_LABEL,
            &Self::signed(join, &self.commit)?,
            &self.signature,
        )
    }

    /// As it is posted beside the Commit.
    pub fn to_bytes(&self) -> Result<Vec<u8>, Error> {
        codec::encode(self)
    }

    /// Reads one as posted or served; `bad-format` for anything but exactly one well-formed `RecoveryAuth`.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, Error> {
        codec::decode(bytes, MAX_RECOVERY_AUTH_LEN).map_err(|_| Error::BadFormat)
    }
}

impl Encode for RecoveryAuth {
    fn write(&self, writer: &mut Writer) -> Result<(), Error> {
        writer.value(&self.join)?;
        writer.value(&self.commit)?;
        writer.opaque(&self.signature)
    }
}

impl Decode for RecoveryAuth {
    fn read(reader: &mut Reader<'_>) -> Result<Self, Error> {
        Ok(Self {
            join: reader.value()?,
            commit: reader.value()?,
            signature: reader.opaque()?.try_into().map_err(|_| Error::BadFormat)?,
        })
    }
}

/// What a replaced code leaves to its successor: enough to open and authenticate the rows sealed to the older
/// key. The older signature key is not passed on.
#[derive(Debug, PartialEq, Eq)]
pub struct OldRecovery {
    /// What `DeriveKeyPair` was given for the older `recovery_hpke`.
    pub hpke_secret: Secret<32>,
    /// The older `recovery_mac`.
    pub recovery_mac: Secret<32>,
}

impl Encode for OldRecovery {
    fn write(&self, writer: &mut Writer) -> Result<(), Error> {
        writer.fixed(self.hpke_secret.expose());
        writer.fixed(self.recovery_mac.expose());
        Ok(())
    }
}

impl Decode for OldRecovery {
    fn read(reader: &mut Reader<'_>) -> Result<Self, Error> {
        Ok(Self {
            hpke_secret: Secret::new(reader.fixed()?),
            recovery_mac: Secret::new(reader.fixed()?),
        })
    }
}

/// The link a replacement of the code leaves at the hub (8.6): the older keys, sealed to the new recovery key
/// and authenticated under the new `recovery_mac`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoveryLink {
    /// The room.
    pub room_id: RoomId,
    /// The recovery key the Commit put into the room's state.
    pub new_recovery_hpke_key: [u8; RECOVERY_KEY_LEN],
    /// `EncryptWithLabel(new_recovery_hpke_key, "TrommiRecoveryLink", room_id, OldRecovery)`.
    pub sealed: HpkeCiphertext,
    /// `HMAC-SHA-256(new recovery_mac, "TrommiRecoveryLink" ‖ all fields before mac)`.
    pub mac: [u8; MAC_LEN],
}

impl RecoveryLink {
    fn write_before_mac(&self, writer: &mut Writer) -> Result<(), Error> {
        writer.value(&self.room_id)?;
        writer.opaque(&self.new_recovery_hpke_key)?;
        writer.value(&self.sealed)
    }

    fn mac_input(&self) -> Result<Vec<u8>, Error> {
        let mut input = Writer::new();
        input.fixed(LINK_LABEL.as_bytes());
        self.write_before_mac(&mut input)?;
        Ok(input.into_bytes())
    }

    /// As it is posted.
    pub fn to_bytes(&self) -> Result<Vec<u8>, Error> {
        codec::encode(self)
    }

    /// Reads one as posted or served; `bad-format` for anything but exactly one well-formed link.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, Error> {
        codec::decode(bytes, MAX_RECOVERY_LINK_LEN).map_err(|_| Error::BadFormat)
    }
}

impl Encode for RecoveryLink {
    fn write(&self, writer: &mut Writer) -> Result<(), Error> {
        self.write_before_mac(writer)?;
        writer.opaque(&self.mac)
    }
}

impl Decode for RecoveryLink {
    fn read(reader: &mut Reader<'_>) -> Result<Self, Error> {
        Ok(Self {
            room_id: reader.value()?,
            new_recovery_hpke_key: key_field(reader)?,
            sealed: sealed_field(reader, OLD_RECOVERY_LEN)?,
            mac: reader.opaque()?.try_into().map_err(|_| Error::BadFormat)?,
        })
    }
}

/// The two recovery public keys as a room's state holds them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RecoveryPublic {
    /// `recovery_signature_key`.
    pub signature_key: [u8; RECOVERY_KEY_LEN],
    /// `recovery_hpke_key`.
    pub hpke_key: [u8; RECOVERY_KEY_LEN],
}

/// What opens and authenticates the rows sealed to one recovery key: its private half and its `recovery_mac`.
/// The one for the code in hand comes from [`RecoveryKeys::opener`], the ones for older codes from
/// [`open_links`].
#[derive(Debug)]
pub struct Opener {
    hpke: HpkeKeyPair,
    mac: Secret<32>,
}

impl Opener {
    fn from_old(old: &OldRecovery) -> Result<Self, Error> {
        Ok(Self {
            hpke: crypto::derive_hpke_keypair(&old.hpke_secret)?,
            mac: old.recovery_mac.duplicate(),
        })
    }

    /// The recovery key whose rows this opens.
    pub fn recovery_hpke_key(&self) -> &[u8; RECOVERY_KEY_LEN] {
        &self.hpke.public
    }

    /// The `recovery_mac` of that key, with the key it belongs to: what a human device keeps.
    pub fn mac_key(&self) -> RecoveryMac {
        RecoveryMac {
            recovery_hpke_key: self.hpke.public,
            key: self.mac.duplicate(),
        }
    }
}

/// A `recovery_mac` with the recovery key it belongs to.
#[derive(Debug, PartialEq, Eq)]
pub struct RecoveryMac {
    /// The `recovery_hpke_key` of the same code.
    pub recovery_hpke_key: [u8; RECOVERY_KEY_LEN],
    /// The key.
    pub key: Secret<32>,
}

/// Everything that follows from a recovery code: both key pairs and `recovery_mac`. Wiped when dropped. A device
/// holds this only while it joins with the code, recovers, or replaces the code; [`RecoveryKeys::finish`] ends
/// that and leaves `recovery_mac`.
#[derive(Debug)]
pub struct RecoveryKeys {
    sign: SigningKey,
    /// What `DeriveKeyPair` was given: a replacement passes it on in its link.
    hpke_secret: Secret<32>,
    hpke: HpkeKeyPair,
    mac: Secret<32>,
}

impl RecoveryKeys {
    /// The keys of `code`. The code is taken and wiped here: whoever still needs it afterwards (to seal the
    /// account's copies of a new code) made a second copy on purpose.
    pub fn from_code(code: Secret<32>) -> Result<Self, Error> {
        let hpke_secret: Secret<32> = crypto::expand_with_label(&code, HPKE_LABEL, &[])?;
        Ok(Self {
            sign: SigningKey::from_seed(crypto::expand_with_label(&code, SIGN_LABEL, &[])?),
            hpke: crypto::derive_hpke_keypair(&hpke_secret)?,
            hpke_secret,
            mac: crypto::expand_with_label(&code, MAC_LABEL, &[])?,
        })
    }

    /// A fresh code, 32 random bytes, with its keys.
    pub fn generate(entropy: &mut dyn Entropy) -> Result<(Secret<32>, Self), Error> {
        let code = Secret::random(entropy)?;
        let keys = Self::from_code(code.duplicate())?;
        Ok((code, keys))
    }

    /// The public keys a room is founded with (8.1).
    pub fn public(&self) -> RecoveryPublic {
        RecoveryPublic {
            signature_key: self.sign.public(),
            hpke_key: self.hpke.public,
        }
    }

    /// Whether `room` holds exactly the two public keys of this code: what ties a room to the code (8.4).
    /// `wrong-recovery` otherwise.
    pub fn check_room(&self, room: &TrommiRoom) -> Result<(), Error> {
        let public = self.public();
        if room.recovery_signature_key == public.signature_key
            && room.recovery_hpke_key == public.hpke_key
        {
            Ok(())
        } else {
            Err(Error::WrongRecovery)
        }
    }

    /// What opens and authenticates the rows sealed to this code's key. It holds a copy of the private key
    /// and outlives [`RecoveryKeys::finish`]: the caller drops it when the rows are opened.
    pub fn opener(&self) -> Result<Opener, Error> {
        Ok(Opener {
            hpke: crypto::derive_hpke_keypair(&self.hpke_secret)?,
            mac: self.mac.duplicate(),
        })
    }

    /// The `RecoveryAuth` of the join `join` made with the Commit `commit`, as it is posted beside it.
    pub fn authorise(&self, join: &RecoveryJoin, commit: &[u8]) -> Result<Vec<u8>, Error> {
        let commit = commit_hash(commit)?;
        let signature = crypto::sign_with_label(
            &self.sign,
            JOIN_LABEL,
            &RecoveryAuth::signed(join, &commit)?,
        )?;
        RecoveryAuth {
            join: *join,
            commit,
            signature: signature
                .try_into()
                .map_err(|_| Error::Internal("signature length"))?,
        }
        .to_bytes()
    }

    /// The private half of `recovery_sign`, for the sign-in to the hub under the recovery key (12.3.2).
    pub fn signing_key(&self) -> &SigningKey {
        &self.sign
    }

    /// Replaces this code (8.6): a fresh code with keys the room never held, and the `RecoveryLink` that hands
    /// this code's HPKE secret and `recovery_mac` to it. Only the code in force replaces: `wrong-recovery` when
    /// the newest state of `history` does not hold this code's keys. `history` is the room's, as far as the
    /// caller holds it; the rules refuse the Commit if the room held one of the keys before the history began.
    /// A draw that repeats a held key, or a device's key, is `Error::Entropy`: no honest source does that.
    pub fn replace(
        &self,
        entropy: &mut dyn Entropy,
        room: &RoomId,
        history: &RoomHistory,
    ) -> Result<Replacement, Error> {
        let newest = history.newest();
        self.check_room(&newest.room)?;
        let (code, keys) = Self::generate(entropy)?;
        let public = keys.public();
        let repeats = [public.signature_key, public.hpke_key].iter().any(|key| {
            let as_device = DeviceId::new(*key);
            history.held_recovery_key(key)
                || newest.is_human(&as_device)
                || newest.is_agent(&as_device)
        });
        if repeats || public.signature_key == public.hpke_key {
            return Err(Error::Entropy);
        }
        // The encoded OldRecovery, in a buffer that is wiped: both halves are secret.
        let mut old = Zeroizing::new([0u8; OLD_RECOVERY_LEN]);
        let halves = self
            .hpke_secret
            .expose()
            .iter()
            .chain(self.mac.expose().iter());
        for (to, from) in old.iter_mut().zip(halves) {
            *to = *from;
        }
        let sealed = crypto::encrypt_with_label(
            entropy,
            &public.hpke_key,
            LINK_LABEL,
            room.as_bytes(),
            old.as_slice(),
        )?;
        let mut link = RecoveryLink {
            room_id: *room,
            new_recovery_hpke_key: public.hpke_key,
            sealed,
            mac: [0; MAC_LEN],
        };
        link.mac = crypto::hmac_sha256(&keys.mac, &link.mac_input()?)?;
        Ok(Replacement {
            code,
            keys,
            link: link.to_bytes()?,
        })
    }

    /// This code's `recovery_mac` with the key it belongs to: what the device keeps beyond the join.
    pub fn mac_key(&self) -> RecoveryMac {
        RecoveryMac {
            recovery_hpke_key: self.hpke.public,
            key: self.mac.duplicate(),
        }
    }

    /// Ends the use of the code: the two key pairs are wiped, `recovery_mac` stays with the device.
    pub fn finish(self) -> RecoveryMac {
        RecoveryMac {
            recovery_hpke_key: self.hpke.public,
            key: self.mac.duplicate(),
        }
    }
}

/// A replacement of the code, before its room Commit is built.
#[derive(Debug)]
pub struct Replacement {
    /// The new code: for the account's new sealed copies, and shown to the person.
    pub code: Secret<32>,
    /// Its keys: the public ones go into the room's state, `recovery_mac` to the other human devices (7.4).
    pub keys: RecoveryKeys,
    /// The `RecoveryLink`, as it is posted with the Commit.
    pub link: Vec<u8>,
}

/// The `recovery_mac` keys a human device holds, by the recovery key each belongs to (8.3). A held key is
/// never replaced.
#[derive(Debug, Default)]
pub struct MacKeys {
    keys: BTreeMap<[u8; RECOVERY_KEY_LEN], Secret<32>>,
}

/// What became of a `recovery_mac` offered to [`MacKeys`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Taken {
    /// It is held now.
    New,
    /// The same value was held already.
    Held,
    /// It was not for this device, or not from a device that may send it: nothing changed.
    Dropped,
}

impl MacKeys {
    /// No key.
    pub fn new() -> Self {
        Self::default()
    }

    /// Holds `mac`. A second, different value for a recovery key that already has one is `equivocation` and
    /// replaces nothing.
    pub fn hold(&mut self, mac: RecoveryMac) -> Result<Taken, Error> {
        match self.keys.get(&mac.recovery_hpke_key) {
            Some(held) if *held == mac.key => Ok(Taken::Held),
            Some(_) => Err(Error::Equivocation),
            None => {
                self.keys.insert(mac.recovery_hpke_key, mac.key);
                Ok(Taken::New)
            }
        }
    }

    /// The `recovery_mac` of `recovery_hpke_key`, if held.
    pub fn get(&self, recovery_hpke_key: &[u8; RECOVERY_KEY_LEN]) -> Option<&Secret<32>> {
        self.keys.get(recovery_hpke_key)
    }

    /// Whether the `recovery_mac` of `recovery_hpke_key` is held.
    pub fn holds(&self, recovery_hpke_key: &[u8; RECOVERY_KEY_LEN]) -> bool {
        self.keys.contains_key(recovery_hpke_key)
    }

    /// Every key held, for the holder's store.
    pub fn iter(&self) -> impl Iterator<Item = RecoveryMac> + '_ {
        self.keys
            .iter()
            .map(|(recovery_hpke_key, key)| RecoveryMac {
                recovery_hpke_key: *recovery_hpke_key,
                key: key.duplicate(),
            })
    }
}

/// A `recovery_auth` message as it was opened (7.4).
#[derive(Debug, Clone, Copy)]
pub struct AuthMessage<'a> {
    /// The leaf that sent it.
    pub sender: &'a DeviceId,
    /// The device it is for, or zeros for all.
    pub recipient: &'a DeviceId,
    /// The recovery key it names.
    pub recovery_hpke_key: &'a [u8; RECOVERY_KEY_LEN],
    /// The `recovery_mac` it carries.
    pub recovery_mac: &'a Secret<32>,
}

/// The acceptance rule of a `recovery_auth` message (7.4), for the device `own`. `room` is the room group's
/// state at the message's epoch. The message is taken if it is addressed to this device or to zeros, its sender
/// was a human device in that epoch, and it names that state's `recovery_hpke_key`; otherwise it is dropped. A
/// second, different value for a key already held is `equivocation` and replaces nothing.
pub fn take_recovery_auth(
    held: &mut MacKeys,
    own: &DeviceId,
    room: &RoomState,
    message: &AuthMessage<'_>,
) -> Result<Taken, Error> {
    let addressed = message.recipient == own || message.recipient.is_zero();
    let fits = addressed
        && room.is_human(message.sender)
        && *message.recovery_hpke_key == room.room.recovery_hpke_key;
    if !fits {
        return Ok(Taken::Dropped);
    }
    held.hold(RecoveryMac {
        recovery_hpke_key: *message.recovery_hpke_key,
        key: message.recovery_mac.duplicate(),
    })
}

/// Whether a human device that holds `held` may found and commit under `room` (7.4): only with the
/// `recovery_mac` of the recovery key in force.
pub fn may_commit(held: &MacKeys, room: &RoomState) -> bool {
    held.holds(&room.room.recovery_hpke_key)
}

/// The public checks of section 8 that members, observers and the hub run on a Commit. It holds no key.
#[derive(Debug, Clone, Copy, Default)]
pub struct PublicRules;

impl RecoveryRules for PublicRules {
    fn verify_join(&self, claim: &JoinClaim<'_>) -> Result<(), Error> {
        // 5.2.7: there is no join from outside without a recovery signature.
        let bytes = claim.recovery_auth.ok_or(Error::BadCommit)?;
        let auth = RecoveryAuth::from_bytes(bytes).map_err(|_| Error::BadCommit)?;
        auth.verify(&JoinFacts {
            group: claim.group,
            epoch: claim.epoch,
            base_group_info: claim.base_group_info,
            room_epoch: claim.note.room_epoch,
            room_state: &claim.note.room_state,
            joiner: claim.joiner,
            commit: claim.commit,
            recovery_signature_key: claim.recovery_signature_key,
        })
    }

    fn verify_sealed_key(
        &self,
        claim: &SealedKeyClaim<'_>,
        sealed_key: &[u8],
    ) -> Result<(), Error> {
        let row = SealedKey::from_bytes(sealed_key).map_err(|_| Error::Incomplete)?;
        let context = KeyContext::of(claim.group, claim.epoch, claim.group_info)?;
        // The value of a mac cannot be checked without the key; that a human writer set one can.
        let fits = row.context == context
            && row.room_epoch == claim.room_epoch
            && row.recovery_hpke_key == *claim.recovery_hpke_key
            && row.writer == *claim.writer
            && row.mac.is_some() == claim.writer_is_human;
        if fits {
            Ok(())
        } else {
            Err(Error::Incomplete)
        }
    }
}

/// A `SealedKey` a human device posts on its own (8.3), as the hub judges it.
#[derive(Debug, Clone, Copy)]
pub struct PostedRow<'a> {
    /// The signed-in device that posts it.
    pub poster: &'a DeviceId,
    /// The room it is signed in to.
    pub room_id: &'a RoomId,
    /// That room's newest state.
    pub room: &'a RoomState,
    /// The GroupInfo the hub holds for the row's group and epoch; none when it holds none.
    pub group_info: Option<&'a [u8]>,
}

/// The hub's check of a posted `SealedKey` (8.3): for a group of the poster's room (`wrong-room`), from a human
/// device that is its `writer` (`forbidden`), naming the current room epoch (`room-behind`), the recovery key in
/// force and the GroupInfo the hub holds for that group and epoch (`not-found` when it holds none), with a `mac`
/// (`incomplete`). Returns the row, which the hub keeps once per group, epoch and writer.
pub fn check_posted_row(bytes: &[u8], posted: &PostedRow<'_>) -> Result<SealedKey, Error> {
    let row = SealedKey::from_bytes(bytes)?;
    if row.context.group.room_id() != *posted.room_id {
        return Err(Error::WrongRoom);
    }
    if row.writer != *posted.poster || !posted.room.is_human(posted.poster) {
        return Err(Error::Forbidden);
    }
    if row.room_epoch != posted.room.epoch {
        return Err(Error::RoomBehind);
    }
    let group_info = posted.group_info.ok_or(Error::NotFound)?;
    let fits = row.mac.is_some()
        && row.recovery_hpke_key == posted.room.room.recovery_hpke_key
        && row.context.group_info == group_info_hash(group_info)?;
    if fits {
        Ok(row)
    } else {
        Err(Error::Incomplete)
    }
}

/// Whether `rows` hold a `SealedKey` for `group` and `epoch` that a device with the code would take as
/// confirmed (8.3, 8.5): its `mac` verifies under one of `held`, and it is sealed to the recovery key in force
/// at its `room_epoch`, which is not below `begun`, the room epoch under which that epoch began. A human
/// device that derived that content key and finds none posts one.
pub fn lists_authenticated(
    rows: &[Vec<u8>],
    place: (&GroupId, u64),
    held: &MacKeys,
    history: &RoomHistory,
    begun: u64,
) -> Result<bool, Error> {
    let (group, epoch) = place;
    for row in rows
        .iter()
        .filter_map(|row| SealedKey::from_bytes(row).ok())
    {
        if row.context.group != *group
            || row.context.epoch != epoch
            || !in_force(&row, history, &|_, _| Began::Under(begun))
        {
            continue;
        }
        let Some(key) = held.get(&row.recovery_hpke_key) else {
            continue;
        };
        if row.mac_state(key)? == MacState::Valid {
            return Ok(true);
        }
    }
    Ok(false)
}

/// The anchor of a join with the code (8.5): among the rows that are well formed, name the room group of `room`
/// and carry a `mac` valid under the `recovery_mac` of the code in hand, the one with the highest epoch. None:
/// `wrong-recovery`. Two that name different GroupInfos for that epoch: `equivocation`. `keys` can only come
/// from a code, never from a `RecoveryLink`.
pub fn select_anchor(
    keys: &RecoveryKeys,
    room: &RoomId,
    rows: &[Vec<u8>],
) -> Result<KeyContext, Error> {
    let group = GroupId::room(*room);
    let mut anchor: Option<KeyContext> = None;
    let mut conflict = false;
    for row in rows
        .iter()
        .filter_map(|row| SealedKey::from_bytes(row).ok())
    {
        if row.context.group != group || row.mac_state(&keys.mac)? != MacState::Valid {
            continue;
        }
        match &anchor {
            Some(held) if row.context.epoch < held.epoch => {}
            Some(held) if row.context.epoch == held.epoch => {
                conflict |= row.context.group_info != held.group_info;
            }
            _ => {
                anchor = Some(row.context);
                conflict = false;
            }
        }
    }
    match anchor {
        Some(_) if conflict => Err(Error::Equivocation),
        Some(anchor) => Ok(anchor),
        None => Err(Error::WrongRecovery),
    }
}

/// Starts following the room group from the anchor's GroupInfo (8.5): its hash, group and epoch must be the
/// row's (`wrong-recovery` otherwise), and it must verify as a GroupInfo with its tree.
pub fn follow_anchor(anchor: &KeyContext, group_info: &[u8]) -> Result<Observer, Error> {
    if group_info_hash(group_info)? != anchor.group_info {
        return Err(Error::WrongRecovery);
    }
    let observer = Observer::follow_room(group_info, None).map_err(|_| Error::WrongRecovery)?;
    if observer.group() != anchor.group || observer.epoch()? != anchor.epoch {
        return Err(Error::WrongRecovery);
    }
    Ok(observer)
}

/// Whether the GroupInfo a hub offers as current agrees with the state an observer reached from the anchor
/// (8.5); `wrong-recovery` otherwise. At the anchor's own epoch it must be the anchor's GroupInfo. Beyond it,
/// it must verify against the observer's tree, carry the observer's GroupContext byte for byte and the
/// confirmation tag of the last Commit followed, and be signed by that Commit's committer, `last_committer`.
/// A GroupInfo of an epoch before the anchor's never agrees.
pub fn check_agreement(
    observer: &Observer,
    last_committer: Option<&DeviceId>,
    anchor: &KeyContext,
    group_info: &[u8],
) -> Result<(), Error> {
    if observer.group() != anchor.group {
        return Err(Error::WrongRecovery);
    }
    let reached = observer.epoch()?;
    if reached == anchor.epoch {
        return if group_info_hash(group_info)? == anchor.group_info {
            Ok(())
        } else {
            Err(Error::WrongRecovery)
        };
    }
    let committer = last_committer
        .filter(|_| reached > anchor.epoch)
        .ok_or(Error::WrongRecovery)?;
    observer
        .check_group_info(group_info, committer)
        .map_err(|error| match error {
            Error::Incomplete => Error::WrongRecovery,
            other => other,
        })
}

/// A Commit of the room group that replaced the recovery keys.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeyChange {
    /// The room epoch the Commit led to: the first whose state holds `after`.
    pub epoch: u64,
    /// The `recovery_hpke_key` the room state held before the Commit.
    pub before: [u8; RECOVERY_KEY_LEN],
    /// The one it put in.
    pub after: [u8; RECOVERY_KEY_LEN],
}

/// Every replacement of the recovery keys that `history` holds, ascending by epoch.
pub fn key_changes(history: &RoomHistory) -> Vec<KeyChange> {
    let states: Vec<&RoomState> = history.states().collect();
    states
        .iter()
        .zip(states.iter().skip(1))
        .filter(|(before, after)| before.room.recovery_hpke_key != after.room.recovery_hpke_key)
        .map(|(before, after)| KeyChange {
            epoch: after.epoch,
            before: before.room.recovery_hpke_key,
            after: after.room.recovery_hpke_key,
        })
        .collect()
}

/// What a code opens: its own key's rows, and through the links the rows of every older key.
#[derive(Debug)]
pub struct Openers {
    /// The opener of the code in hand first, then one per older code, newest first.
    pub openers: Vec<Opener>,
    /// A recovery key that replaced an older one and whose link the hub did not serve: the rows sealed to the
    /// older keys stay closed. The finding is `withheld`.
    pub missing_link: Option<[u8; RECOVERY_KEY_LEN]>,
}

/// The older keys that the links for `current` hand over, where `change` is the Commit that put `current`'s
/// key into the room's state.
fn older_of(
    current: &Opener,
    change: Option<&KeyChange>,
    room: &RoomId,
    links: &[RecoveryLink],
) -> Result<Option<OldRecovery>, Error> {
    let mut older: Option<OldRecovery> = None;
    for link in links
        .iter()
        .filter(|link| link.new_recovery_hpke_key == current.hpke.public)
    {
        let change = change.ok_or(Error::WrongRecovery)?;
        if !crypto::hmac_verify(&current.mac, &link.mac_input()?, &link.mac)? {
            return Err(Error::WrongRecovery);
        }
        let opened = crypto::decrypt_with_label(
            &current.hpke.private,
            LINK_LABEL,
            room.as_bytes(),
            &link.sealed,
        )
        .map_err(|_| Error::WrongRecovery)?;
        let old: OldRecovery =
            codec::decode(opened.expose(), OLD_RECOVERY_LEN).map_err(|_| Error::WrongRecovery)?;
        if crypto::derive_hpke_keypair(&old.hpke_secret)?.public != change.before {
            return Err(Error::WrongRecovery);
        }
        if older.as_ref().is_some_and(|taken| *taken != old) {
            return Err(Error::Equivocation);
        }
        older = Some(old);
    }
    Ok(older)
}

/// Walks the `RecoveryLink`s back from the code in hand to every older code (8.5). `changes` are the room's
/// replacements of the recovery keys from its founding on ([`key_changes`] of a history the caller verified).
///
/// A link belongs to the Commit that put its `new_recovery_hpke_key` into the room's state. It is taken if its
/// `mac` verifies under that key's `recovery_mac` and the key pair derived from its `hpke_secret` has the public
/// key the room state held before that Commit; a link that names a key of this walk and fails either test is
/// `wrong-recovery`, as is a walk that comes back to a key it passed. Two links for one key that open to
/// different values are `equivocation`. Links of another room, of keys outside the walk, and bytes that are no
/// link are passed over.
pub fn open_links(
    keys: &RecoveryKeys,
    room: &RoomId,
    links: &[Vec<u8>],
    changes: &[KeyChange],
) -> Result<Openers, Error> {
    let links: Vec<RecoveryLink> = links
        .iter()
        .filter_map(|link| RecoveryLink::from_bytes(link).ok())
        .filter(|link| link.room_id == *room)
        .collect();
    let mut openers = Vec::new();
    let mut passed = BTreeSet::new();
    let mut missing_link = None;
    let mut next = Some(keys.opener()?);
    while let Some(current) = next.take() {
        let key = current.hpke.public;
        passed.insert(key);
        let change = changes.iter().find(|change| change.after == key);
        match (change, older_of(&current, change, room, &links)?) {
            (Some(change), Some(old)) => {
                if passed.contains(&change.before) {
                    return Err(Error::WrongRecovery);
                }
                next = Some(Opener::from_old(&old)?);
            }
            (Some(_), None) => missing_link = Some(key),
            (None, _) => {}
        }
        openers.push(current);
    }
    Ok(Openers {
        openers,
        missing_link,
    })
}

/// A content key that a code opened.
#[derive(Debug, PartialEq, Eq)]
pub struct RecoveredKey {
    /// The group.
    pub group: GroupId,
    /// The epoch.
    pub epoch: u64,
    /// `content_key(group, epoch)`.
    pub key: Secret<32>,
    /// Whether a row with a valid `mac` carried it. Content of an epoch whose key is not confirmed is shown as
    /// unconfirmed: only a non-human writer vouches for the row.
    pub confirmed: bool,
}

/// Under which room epoch an epoch of a session group began, as far as a device verified it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Began {
    /// The Commit that led to the epoch named this room epoch.
    Under(u64),
    /// The device verified the group, and the group has not reached that epoch: no row is its row.
    Never,
    /// The device did not verify the group's Commits (an archived session): any room epoch may be the one.
    Unverified,
}

/// Whether a row is sealed to the recovery key in force where it belongs: the room state at its `room_epoch`
/// holds the key it names, and that room epoch is not below the one its content epoch began under. For the
/// room group that is the epoch's own state, or the one before it when the key did not change between them;
/// for a session group `begun` says it. So a replaced code authenticates nothing for an epoch that began
/// after it, and no row stands for an epoch a verified group has not reached.
fn in_force(
    row: &SealedKey,
    history: &RoomHistory,
    begun: &dyn Fn(&GroupId, u64) -> Began,
) -> bool {
    let key_at = |epoch: u64| history.at(epoch).map(|state| state.room.recovery_hpke_key);
    let context = &row.context;
    let floor = if context.group.is_room() {
        let before = context.epoch.checked_sub(1).and_then(key_at);
        match (before, key_at(context.epoch)) {
            (Some(before), Some(own)) if before == own => context.epoch.saturating_sub(1),
            (_, Some(_)) => context.epoch,
            (_, None) => return false,
        }
    } else {
        match begun(&context.group, context.epoch) {
            Began::Under(room_epoch) => room_epoch,
            Began::Never => return false,
            Began::Unverified => 0,
        }
    };
    row.room_epoch >= floor && key_at(row.room_epoch) == Some(row.recovery_hpke_key)
}

/// The content keys of the room `room` that `openers` open from `rows` (8.5), per group and epoch, ascending.
/// `history` is the room's from its founding on, as the caller verified it; `begun` says under which room
/// epoch an epoch of a session group began.
///
/// Only rows sealed to the recovery key in force where they belong count: the room state at the row's
/// `room_epoch` holds the key it names, and that is not before the epoch began. Of these, the rows of an epoch
/// with a valid `mac` must open to one key, which is taken (`equivocation` when two differ or one does not
/// open). A row with an empty `mac` is taken only if its epoch has none with a valid one, and its key is marked
/// unconfirmed; of several such rows the first that opens counts. A row whose non-empty `mac` does not verify
/// is ignored, as is a row of another room, a row sealed to a key no opener is for, and bytes that are no row.
pub fn select_keys(
    room: &RoomId,
    rows: &[Vec<u8>],
    openers: &[Opener],
    history: &RoomHistory,
    begun: &dyn Fn(&GroupId, u64) -> Began,
) -> Result<Vec<RecoveredKey>, Error> {
    let mut confirmed: BTreeMap<(GroupId, u64), Secret<32>> = BTreeMap::new();
    let mut unconfirmed: BTreeMap<(GroupId, u64), Secret<32>> = BTreeMap::new();
    for row in rows
        .iter()
        .filter_map(|row| SealedKey::from_bytes(row).ok())
    {
        if row.context.group.room_id() != *room || !in_force(&row, history, begun) {
            continue;
        }
        let Some(opener) = openers
            .iter()
            .find(|opener| opener.hpke.public == row.recovery_hpke_key)
        else {
            continue;
        };
        let place = (row.context.group, row.context.epoch);
        match row.mac_state(&opener.mac)? {
            MacState::Valid => {
                let key = row.open(opener).map_err(|error| match error {
                    Error::DecryptFailed => Error::Equivocation,
                    other => other,
                })?;
                match confirmed.get(&place) {
                    Some(held) if *held != key => return Err(Error::Equivocation),
                    Some(_) => {}
                    None => {
                        confirmed.insert(place, key);
                    }
                }
            }
            MacState::Absent => {
                if let Entry::Vacant(free) = unconfirmed.entry(place) {
                    if let Ok(key) = row.open(opener) {
                        free.insert(key);
                    }
                }
            }
            MacState::Invalid => {}
        }
    }
    unconfirmed.retain(|place, _| !confirmed.contains_key(place));
    let mut keys: Vec<RecoveredKey> = confirmed
        .into_iter()
        .map(|(place, key)| (place, key, true))
        .chain(
            unconfirmed
                .into_iter()
                .map(|(place, key)| (place, key, false)),
        )
        .map(|((group, epoch), key, confirmed)| RecoveredKey {
            group,
            epoch,
            key,
            confirmed,
        })
        .collect();
    keys.sort_by_key(|key| (key.group, key.epoch));
    Ok(keys)
}

/// One Commit of a group's log, as the hub serves it.
#[derive(Debug, Clone, Copy)]
pub struct ServedCommit<'a> {
    /// The room's change number of the Commit: its place in the hub's order across groups.
    pub change: u64,
    /// The Commit.
    pub commit: &'a [u8],
    /// The `RecoveryAuth` stored beside a join from outside.
    pub recovery_auth: Option<&'a [u8]>,
}

/// One group as the hub serves it to a device that joins with the code.
#[derive(Debug, Clone, Copy)]
pub struct ServedGroup<'a> {
    /// The founding GroupInfo (epoch 0).
    pub founding: &'a [u8],
    /// Every Commit since, in the hub's order.
    pub commits: &'a [ServedCommit<'a>],
    /// The GroupInfo the hub offers as current: what the device would join on.
    pub current: &'a [u8],
}

/// A room as the hub serves it to a device that joins with the code. Nothing in it is trusted.
#[derive(Debug, Clone, Copy)]
pub struct ServedRoom<'a> {
    /// The room.
    pub room: RoomId,
    /// The room group.
    pub group: ServedGroup<'a>,
    /// The GroupInfo of the anchor's epoch ([`select_anchor`] names the epoch).
    pub anchor: &'a [u8],
    /// Every `SealedKey` of the room.
    pub rows: &'a [Vec<u8>],
    /// Every `RecoveryLink` of the room.
    pub links: &'a [Vec<u8>],
    /// Every live session group, main sessions before helper sessions.
    pub sessions: &'a [ServedGroup<'a>],
}

/// The Commit that ended an epoch of a walked group: what its note says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WalkedEnd {
    /// The note's `time`.
    pub time: u64,
    /// The Cuts it carries, one per leaf it removed.
    pub cuts: Vec<Cut>,
}

/// One epoch of a group's public history, as a walk from its founding found it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WalkedEpoch {
    /// The devices of the group's leaves in this epoch.
    pub leaves: Vec<DeviceId>,
    /// The `room_epoch` of the Commit that began the epoch; for epoch 0 the founding Commit's, since a
    /// founding is one request.
    pub room_epoch: u64,
    /// The Commit that ended it; none for the epoch the walk stands in.
    pub end: Option<WalkedEnd>,
}

/// A group's public history epoch by epoch, from its founding GroupInfo (epoch 0) through the Commits a walk
/// followed. Every fact in it is read from a Commit that verified against the state before it and obeyed
/// section 5, or from the tree that Commit led to.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Walked {
    /// The epochs, from 0 on.
    pub epochs: Vec<WalkedEpoch>,
}

impl Walked {
    /// A walk that stands at the founding GroupInfo `observer` was started from.
    pub fn begin(observer: &Observer) -> Result<Self, Error> {
        Ok(Self {
            epochs: vec![WalkedEpoch {
                leaves: observer.leaves()?.into_iter().collect(),
                room_epoch: 0,
                end: None,
            }],
        })
    }

    /// Follows the next Commit with `observer` and records the epoch it ends and the one it begins. `at` is
    /// the room epoch that was current at the Commit's place in the hub's order, for a holder whose record
    /// of the room reaches beyond that place ([`Observer::process_commit_at`]); without it the room's
    /// newest state is the one of the place. On a refusal nothing is recorded and the observer is unchanged.
    pub fn follow(
        &mut self,
        observer: &mut Observer,
        commit: &ServedCommit<'_>,
        context: &Context<'_>,
        at: Option<u64>,
    ) -> Result<CommitFacts, Error> {
        let facts = match at {
            Some(at) => {
                observer.process_commit_at(commit.commit, commit.recovery_auth, context, at)?
            }
            None => observer.process_commit(commit.commit, commit.recovery_auth, context)?,
        };
        let leaves = observer.leaves()?.into_iter().collect();
        let (room_epoch, time, cuts) = facts.note.as_ref().map_or((0, 0, Vec::new()), |note| {
            (note.room_epoch, note.time, note.cuts.clone())
        });
        let first = self.epochs.len() == 1;
        if let Some(ended) = self.epochs.last_mut() {
            ended.end = Some(WalkedEnd { time, cuts });
            if first {
                ended.room_epoch = room_epoch;
            }
        }
        self.epochs.push(WalkedEpoch {
            leaves,
            room_epoch,
            end: None,
        });
        Ok(facts)
    }
}

/// A session group that a device verified from its founding (8.4).
#[derive(Debug)]
pub struct CheckedSession {
    /// The group's public state at the GroupInfo the hub offers as current, which agrees with it.
    pub observer: Observer,
    /// Per epoch of the group, the `room_epoch` of the Commit that led to it; for epoch 0 the founding
    /// Commit's.
    pub begun: Vec<u64>,
    /// The group's history epoch by epoch, up to the state the observer stands in.
    pub walked: Walked,
}

/// A room that a device with the code checked (8.5).
#[derive(Debug)]
pub struct CheckedRoom {
    /// The anchor.
    pub anchor: KeyContext,
    /// The room group's public state at the GroupInfo the hub offers as current, which agrees with it; its
    /// history reaches from the founding to there.
    pub observer: Observer,
    /// The session groups, in the order served: each verified from its founding, or the reason it is not.
    /// A session that does not verify is not joined.
    pub sessions: Vec<Result<CheckedSession, Error>>,
    /// The room group's history epoch by epoch, from its founding to the state the observer stands in.
    pub walked: Walked,
    /// The content keys the code opens, each marked confirmed or not.
    pub keys: Vec<RecoveredKey>,
    /// A recovery key whose link to its predecessor the hub did not serve ([`Openers::missing_link`]).
    pub missing_link: Option<[u8; RECOVERY_KEY_LEN]>,
    /// Per room epoch after the founding, the change number of the Commit that led to it: its place in the
    /// hub's order, by which a session Commit is judged against the room state of its place (5.2.1).
    pub places: Vec<(u64, u64)>,
}

/// A session group while it is verified from its founding.
struct Walk<'a> {
    served: &'a ServedGroup<'a>,
    /// The follower, once the group's first Commit came by; taken out while a Commit of it is judged.
    observer: Option<Observer>,
    begun: Vec<u64>,
    walked: Walked,
    last_committer: Option<DeviceId>,
    /// Why the group does not verify, if it does not.
    failed: Option<Error>,
}

/// The sessions as they stand at one place of the hub's order, as the rules ask about them there: all of
/// them, or those before and after the one being judged.
struct Standing<'a, 'b>(&'a [Walk<'b>], &'a [Walk<'b>]);

impl Standing<'_, '_> {
    fn observers(&self) -> impl Iterator<Item = &Observer> {
        self.0
            .iter()
            .chain(self.1.iter())
            .filter(|walk| walk.failed.is_none())
            .filter_map(|walk| walk.observer.as_ref())
    }
}

impl SessionFacts for Standing<'_, '_> {
    fn main_session(&self, session: &SessionId, _: u64) -> Parent {
        // The walk goes in the hub's order: the seat as it stands now is the seat at this place.
        self.observers()
            .find(|observer| observer.session().is_some_and(|s| s.session_id == *session))
            .map_or(Parent::NotAMainSession, |observer| {
                observer.seat_at(u64::MAX)
            })
    }

    fn main_session_of(&self, agent: &DeviceId) -> Option<SessionId> {
        self.observers()
            .filter(|observer| observer.seat_at(u64::MAX) == Parent::Seat(Some(*agent)))
            .find_map(|observer| observer.session().map(|session| session.session_id))
    }

    fn live_helpers(&self, parent: &SessionId) -> usize {
        self.observers()
            .filter(|observer| observer.session().is_some_and(|s| s.parent == *parent))
            .count()
    }
}

impl Walk<'_> {
    /// Follows the next Commit of this group at its place in the hub's order.
    fn step(
        &mut self,
        commit: &ServedCommit<'_>,
        room: &RoomId,
        history: &RoomHistory,
        sessions: &dyn SessionFacts,
        observer: Option<Observer>,
    ) -> Result<Observer, Error> {
        let mut observer = match observer {
            Some(observer) => observer,
            None => {
                let observer = Observer::follow_founding(self.served.founding)?;
                self.walked = Walked::begin(&observer)?;
                observer
            }
        };
        if observer.group().room_id() != *room {
            return Err(Error::WrongRoom);
        }
        let context = Context {
            room: Some(history),
            sessions,
            recovery: &PublicRules,
            max_human_devices: MAX_HUMAN_DEVICES_IN_RECOVERY,
        };
        let facts = self.walked.follow(&mut observer, commit, &context, None)?;
        let room_epoch = facts.note.as_ref().map_or(0, |note| note.room_epoch);
        if self.begun.is_empty() {
            // The founding is one request: epoch 0 began under the room epoch its first Commit names.
            self.begun.push(room_epoch);
        }
        self.begun.push(room_epoch);
        self.last_committer = Some(facts.committer);
        Ok(observer)
    }

    /// The verified group, if the GroupInfo offered as current agrees with the state reached.
    fn finish(self) -> Result<CheckedSession, Error> {
        if let Some(error) = self.failed {
            return Err(error);
        }
        let (Some(observer), Some(committer)) = (self.observer, self.last_committer) else {
            return Err(Error::BadGroup);
        };
        observer
            .check_group_info(self.served.current, &committer)
            .map_err(|_| Error::WrongRecovery)?;
        Ok(CheckedSession {
            observer,
            begun: self.begun,
            walked: self.walked,
        })
    }
}

/// Verifies a session group as any reader does (8.4): from its founding GroupInfo through its Commits against
/// the room states of `history` (`bad-group` when one does not verify or obey section 5, `room-behind` when
/// `history` does not reach back to a room state one names), and requires the
/// GroupInfo offered as current to agree with the state so reached (`wrong-recovery`). `sessions` answers for
/// the room's other sessions: a helper session is verified after its main session. `room_epoch_at` gives the
/// room epoch that was current at a change number of the hub's order: each Commit is judged at its place
/// (5.2.1) and must name that epoch, so a Commit that names a room state from before its place, as a removed
/// device's would, is `bad-group`; `room-behind` when the verifier cannot tell the epoch at a place.
pub fn check_session(
    served: &ServedGroup<'_>,
    room: &RoomId,
    history: &RoomHistory,
    sessions: &dyn SessionFacts,
    room_epoch_at: &dyn Fn(u64) -> Result<u64, Error>,
) -> Result<CheckedSession, Error> {
    let mut observer = Observer::follow_founding(served.founding).map_err(|_| Error::BadGroup)?;
    if observer.group().room_id() != *room {
        return Err(Error::WrongRoom);
    }
    let context = Context {
        room: Some(history),
        sessions,
        recovery: &PublicRules,
        max_human_devices: MAX_HUMAN_DEVICES_IN_RECOVERY,
    };
    let mut begun = Vec::new();
    let mut walked = Walked::begin(&observer)?;
    let mut last_committer = None;
    for served in served.commits {
        let at = room_epoch_at(served.change).map_err(|_| Error::RoomBehind)?;
        let facts = walked
            .follow(&mut observer, served, &context, Some(at))
            .map_err(|error| match error {
                // The verifier does not hold the room state a Commit names: it cannot tell.
                Error::RoomBehind => Error::RoomBehind,
                _ => Error::BadGroup,
            })?;
        let room_epoch = facts.note.as_ref().map_or(0, |note| note.room_epoch);
        if begun.is_empty() {
            // The founding is one request: epoch 0 began under the room epoch its first Commit names.
            begun.push(room_epoch);
        }
        begun.push(room_epoch);
        last_committer = Some(facts.committer);
    }
    let committer = last_committer.ok_or(Error::BadGroup)?;
    observer
        .check_group_info(served.current, &committer)
        .map_err(|_| Error::WrongRecovery)?;
    Ok(CheckedSession {
        observer,
        begun,
        walked,
    })
}

/// Whether the walk from the founding stands, at the anchor's epoch, in the anchor's state.
fn at_anchor(observer: &Observer, anchor: &KeyContext, group_info: &[u8]) -> Result<(), Error> {
    if group_info_hash(group_info)? != anchor.group_info {
        return Err(Error::WrongRecovery);
    }
    observer
        .group_info_signer(group_info)
        .map(|_| ())
        .map_err(|_| Error::WrongRecovery)
}

/// Checks the room a hub serves before a device joins it with the code (8.4, 8.5).
///
/// The anchor is selected from the rows. The Commits of the room group and of every session served are
/// followed as an observer in the hub's order, by their change numbers, each group from its founding
/// GroupInfo: a session Commit is judged against the room state and the other sessions as they stand at its
/// place. A room Commit that does not verify or obey section 5 is `bad-group`; a session that does not verify
/// is named in the result and not joined. At the anchor's epoch the room walk must stand in the state of the
/// anchor's GroupInfo, and the GroupInfo offered as current must agree with the state reached at the end, whose
/// `TrommiRoom` must hold exactly the code's two public keys (`wrong-recovery` for each). Then the links are
/// walked back to older codes and the content keys are selected.
pub fn check_room(keys: &RecoveryKeys, served: &ServedRoom<'_>) -> Result<CheckedRoom, Error> {
    let anchor = select_anchor(keys, &served.room, served.rows)?;
    let group = &served.group;
    let mut observer =
        Observer::follow_room(group.founding, None).map_err(|_| Error::WrongRecovery)?;
    if observer.group() != anchor.group || observer.epoch()? != 0 {
        return Err(Error::WrongRecovery);
    }
    let mut walks: Vec<Walk<'_>> = served
        .sessions
        .iter()
        .map(|served| Walk {
            served,
            observer: None,
            begun: Vec::new(),
            walked: Walked::default(),
            last_committer: None,
            failed: None,
        })
        .collect();
    // Every Commit served, in the hub's order: `None` for the room group, else the session's place.
    let mut order: Vec<(u64, Option<usize>, &ServedCommit<'_>)> = group
        .commits
        .iter()
        .map(|commit| (commit.change, None, commit))
        .collect();
    for (at, session) in served.sessions.iter().enumerate() {
        order.extend(
            session
                .commits
                .iter()
                .map(|commit| (commit.change, Some(at), commit)),
        );
    }
    order.sort_by_key(|(change, _, _)| *change);
    let unique = order
        .iter()
        .zip(order.iter().skip(1))
        .all(|(a, b)| a.0 < b.0);
    if !unique {
        return Err(Error::BadGroup);
    }

    let mut last_committer = None;
    let mut walked = Walked::begin(&observer)?;
    let mut anchored = false;
    let mut places = Vec::new();
    for (_, session, commit) in order {
        let Some(at) = session else {
            if observer.epoch()? == anchor.epoch {
                at_anchor(&observer, &anchor, served.anchor)?;
                anchored = true;
            }
            let context = Context {
                room: None,
                sessions: &Standing(&walks, &[]),
                recovery: &PublicRules,
                max_human_devices: MAX_HUMAN_DEVICES_IN_RECOVERY,
            };
            let facts = walked
                .follow(&mut observer, commit, &context, None)
                .map_err(|_| Error::BadGroup)?;
            places.push((observer.epoch()?, commit.change));
            last_committer = Some(facts.committer);
            continue;
        };
        let history = observer.history().ok_or(Error::Internal("room observer"))?;
        let taken = walks
            .get_mut(at)
            .and_then(|walk| walk.failed.is_none().then(|| walk.observer.take()));
        let Some(taken) = taken else { continue };
        let stepped = {
            let (before, rest) = walks.split_at_mut(at);
            let Some((walk, after)) = rest.split_first_mut() else {
                continue;
            };
            // The group judged is out of the picture while the others answer for the room's sessions.
            let others = Standing(before, after);
            walk.step(commit, &served.room, history, &others, taken)
        };
        if let Some(walk) = walks.get_mut(at) {
            match stepped {
                Ok(followed) => walk.observer = Some(followed),
                Err(Error::WrongRoom) => walk.failed = Some(Error::WrongRoom),
                Err(_) => walk.failed = Some(Error::BadGroup),
            }
        }
    }
    if observer.epoch()? == anchor.epoch {
        at_anchor(&observer, &anchor, served.anchor)?;
        anchored = true;
    }
    if !anchored {
        return Err(Error::WrongRecovery);
    }
    check_agreement(&observer, last_committer.as_ref(), &anchor, group.current)?;
    let history = observer.history().ok_or(Error::Internal("room observer"))?;
    keys.check_room(&history.newest().room)?;

    let opened = open_links(keys, &served.room, served.links, &key_changes(history))?;
    let sessions: Vec<Result<CheckedSession, Error>> =
        walks.into_iter().map(Walk::finish).collect();
    let begun = |group: &GroupId, epoch: u64| {
        let verified = sessions
            .iter()
            .filter_map(|session| session.as_ref().ok())
            .find(|session| session.observer.group() == *group);
        match verified {
            None => Began::Unverified,
            Some(session) => usize::try_from(epoch)
                .ok()
                .and_then(|epoch| session.begun.get(epoch))
                .map_or(Began::Never, |room_epoch| Began::Under(*room_epoch)),
        }
    };
    let recovered = select_keys(&served.room, served.rows, &opened.openers, history, &begun)?;
    Ok(CheckedRoom {
        anchor,
        observer,
        sessions,
        walked,
        keys: recovered,
        missing_link: opened.missing_link,
        places,
    })
}

/// The leaves a recovery removes (8.7), per group, so that the caller can verify each one's chain and name its
/// Cut: from the room group every human device, and from each verified session group every leaf that the room
/// state after that removal, and for a helper session its main session's state, does not allow. Main sessions
/// come before helper sessions.
pub fn removals(checked: &CheckedRoom) -> Result<Vec<(GroupId, Vec<DeviceId>)>, Error> {
    let history = checked
        .observer
        .history()
        .ok_or(Error::Internal("room observer"))?;
    let before = history.newest();
    let mut after = history.clone();
    after.record(RoomState {
        epoch: before
            .epoch
            .checked_add(1)
            .ok_or(Error::Internal("room epoch"))?,
        state: Hash32::ZERO,
        humans: BTreeSet::new(),
        room: before.room.clone(),
    })?;
    let room = after.newest();
    let mut plan = vec![(
        checked.observer.group(),
        before.humans.iter().copied().collect::<Vec<_>>(),
    )];
    // A main session's agent leaf once its own removals are done.
    let mut seats: BTreeMap<SessionId, Option<DeviceId>> = BTreeMap::new();
    let verified = || {
        checked
            .sessions
            .iter()
            .filter_map(|session| session.as_ref().ok())
    };
    for helper in [false, true] {
        for session in verified() {
            let Some(extension) = session.observer.session() else {
                continue;
            };
            if extension.parent.is_zero() == helper {
                continue;
            }
            let parent = if helper {
                seats
                    .get(&extension.parent)
                    .map_or(Parent::NotAMainSession, |seat| Parent::Seat(*seat))
            } else {
                Parent::NotAMainSession
            };
            let leaves = session.observer.leaves()?;
            let gone = rules::disallowed_leaves(&after, room, extension, parent, &leaves);
            if !helper {
                let mut left = leaves
                    .iter()
                    .filter(|leaf| !gone.contains(leaf) && !room.is_human(leaf));
                let seat = left.next().copied();
                seats.insert(extension.session_id, seat.filter(|_| left.next().is_none()));
            }
            plan.push((session.observer.group(), gone));
        }
    }
    Ok(plan)
}
