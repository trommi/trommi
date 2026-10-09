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
use crate::device::{DeviceRecovery, SealRequest};
use crate::error::Error;
use crate::ids::{DeviceId, GroupId, Hash32, RoomId};
use crate::mls::observer::Observer;
use crate::mls::profile::{TrommiRoom, RECOVERY_KEY_LEN};
use crate::mls::rules::{JoinClaim, RecoveryRules, RoomHistory, RoomState, SealedKeyClaim};
use std::collections::btree_map::Entry;
use std::collections::{BTreeMap, BTreeSet};

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
    /// The keys of `code`.
    pub fn from_code(code: &Secret<32>) -> Result<Self, Error> {
        let hpke_secret: Secret<32> = crypto::expand_with_label(code, HPKE_LABEL, &[])?;
        Ok(Self {
            sign: SigningKey::from_seed(crypto::expand_with_label(code, SIGN_LABEL, &[])?),
            hpke: crypto::derive_hpke_keypair(&hpke_secret)?,
            hpke_secret,
            mac: crypto::expand_with_label(code, MAC_LABEL, &[])?,
        })
    }

    /// A fresh code, 32 random bytes, with its keys.
    pub fn generate(entropy: &mut dyn Entropy) -> Result<(Secret<32>, Self), Error> {
        let code = Secret::random(entropy)?;
        let keys = Self::from_code(&code)?;
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

    /// What opens and authenticates the rows sealed to this code's key.
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
    /// this code's HPKE secret and `recovery_mac` to it. `history` is the room's, as far as the caller holds it;
    /// the rules refuse the Commit if the room held one of the keys before the history began. A draw that
    /// repeats a held key, or a device's key, is `Error::Entropy`: no honest source does that.
    pub fn replace(
        &self,
        entropy: &mut dyn Entropy,
        room: &RoomId,
        history: &RoomHistory,
    ) -> Result<Replacement, Error> {
        let (code, keys) = Self::generate(entropy)?;
        let public = keys.public();
        let newest = history.newest();
        let repeats = [public.signature_key, public.hpke_key].iter().any(|key| {
            let as_device = DeviceId::new(*key);
            history.held_recovery_key(key)
                || newest.is_human(&as_device)
                || newest.is_agent(&as_device)
        });
        if repeats || public.signature_key == public.hpke_key {
            return Err(Error::Entropy);
        }
        let old = OldRecovery {
            hpke_secret: self.hpke_secret.duplicate(),
            recovery_mac: self.mac.duplicate(),
        };
        let sealed = crypto::encrypt_with_label(
            entropy,
            &public.hpke_key,
            LINK_LABEL,
            room.as_bytes(),
            &codec::encode(&old)?,
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
            base_group_info: None,
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

/// The recovery construct on a device: the public checks, and the making of the `SealedKey` that goes with every
/// Commit and founding. A human device holds the `recovery_mac` keys it was handed or derived; an agent or
/// helper device holds none and leaves `mac` empty.
#[derive(Debug, Default)]
pub struct Sealer {
    macs: MacKeys,
}

impl Sealer {
    /// A sealer that holds no `recovery_mac`: an agent or helper device, or a human device before it was
    /// handed one.
    pub fn new() -> Self {
        Self::default()
    }

    /// A sealer that holds these keys.
    pub fn with(macs: MacKeys) -> Self {
        Self { macs }
    }

    /// The keys held.
    pub fn macs(&self) -> &MacKeys {
        &self.macs
    }

    /// The keys held, to add one.
    pub fn macs_mut(&mut self) -> &mut MacKeys {
        &mut self.macs
    }
}

impl RecoveryRules for Sealer {
    fn verify_join(&self, claim: &JoinClaim<'_>) -> Result<(), Error> {
        PublicRules.verify_join(claim)
    }

    fn verify_sealed_key(
        &self,
        claim: &SealedKeyClaim<'_>,
        sealed_key: &[u8],
    ) -> Result<(), Error> {
        PublicRules.verify_sealed_key(claim, sealed_key)
    }
}

impl DeviceRecovery for Sealer {
    fn seal_key(
        &mut self,
        entropy: &mut dyn Entropy,
        request: &SealRequest<'_>,
    ) -> Result<Vec<u8>, Error> {
        // 7.4: a human device without the recovery_mac of the key in force founds nothing and commits nothing.
        let recovery_mac = if request.writer_is_human {
            Some(
                self.macs
                    .get(request.recovery_hpke_key)
                    .ok_or(Error::NoKey)?,
            )
        } else {
            None
        };
        SealedKey::seal(
            entropy,
            &Sealing {
                context: KeyContext::of(request.group, request.epoch, request.group_info)?,
                room_epoch: request.room_epoch,
                recovery_hpke_key: request.recovery_hpke_key,
                writer: *request.writer,
                content_key: request.content_key,
            },
            recovery_mac,
        )?
        .to_bytes()
    }

    fn rules(&self) -> &dyn RecoveryRules {
        self
    }
}

/// Whether `rows` hold a `SealedKey` for `group` and `epoch` whose `mac` verifies under one of `held` (8.3). A
/// human device that derived that content key and finds none posts one.
pub fn lists_authenticated(
    rows: &[Vec<u8>],
    group: &GroupId,
    epoch: u64,
    held: &MacKeys,
) -> Result<bool, Error> {
    for row in rows
        .iter()
        .filter_map(|row| SealedKey::from_bytes(row).ok())
    {
        if row.context.group != *group || row.context.epoch != epoch {
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

/// The content keys of the room `room` that `openers` open from `rows` (8.5), per group and epoch, ascending.
///
/// The rows of an epoch with a valid `mac` must open to one key, which is taken (`equivocation` when two differ,
/// `decrypt-failed` when one does not open). A row with an empty `mac` is taken only if its epoch has none with
/// a valid one, and its key is marked unconfirmed; of several such rows the first that opens counts. A row
/// whose non-empty `mac` does not verify is ignored, as is a row of another room, a row sealed to a key no
/// opener is for, and bytes that are no row.
pub fn select_keys(
    room: &RoomId,
    rows: &[Vec<u8>],
    openers: &[Opener],
) -> Result<Vec<RecoveredKey>, Error> {
    let mut confirmed: BTreeMap<(GroupId, u64), Secret<32>> = BTreeMap::new();
    let mut unconfirmed: BTreeMap<(GroupId, u64), Secret<32>> = BTreeMap::new();
    for row in rows
        .iter()
        .filter_map(|row| SealedKey::from_bytes(row).ok())
    {
        if row.context.group.room_id() != *room {
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
                let key = row.open(opener)?;
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
