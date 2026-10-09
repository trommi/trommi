//! The recovery construct of section 8 as pure code: the keys from a code, sealed rows, the authorisation of a
//! join, links between codes, the public checks, and what a device with the code selects from what a hub serves.

use std::collections::BTreeSet;
use trommi_core::codec;
use trommi_core::crypto::{
    self, derive_hpke_keypair, encrypt_with_label, expand_with_label, hmac_sha256, Secret,
    SeededEntropy, SigningKey, SystemEntropy,
};
use trommi_core::device::{Accepted, Device};
use trommi_core::ids::{DeviceId, GroupId, Hash32, RoomId, SessionId};
use trommi_core::mls::observer::{Context, NoSessions, Observer};
use trommi_core::mls::profile::{CommitNote, TrommiRoom, MAX_HUMAN_DEVICES};
use trommi_core::mls::rules::{JoinClaim, RecoveryRules, RoomHistory, RoomState, SealedKeyClaim};
use trommi_core::recovery::{
    self, check_agreement, check_posted_row, commit_hash, follow_anchor, group_info_hash,
    key_changes, lists_authenticated, may_commit, open_links, select_anchor, select_keys,
    take_recovery_auth, AuthMessage, JoinFacts, KeyChange, KeyContext, MacKeys, MacState,
    OldRecovery, Opener, PostedRow, PublicRules, RecoveredKey, RecoveryAuth, RecoveryJoin,
    RecoveryKeys, RecoveryLink, SealedKey, Sealing, Taken,
};
use trommi_core::Error;
use trommi_tests::forge::Forger;
use trommi_tests::{now, MemoryStorage};

const ROOM: RoomId = RoomId::new([0x10; 32]);

fn code(byte: u8) -> Secret<32> {
    Secret::new([byte; 32])
}

fn keys(byte: u8) -> RecoveryKeys {
    RecoveryKeys::from_code(code(byte)).unwrap()
}

fn mac_of(byte: u8) -> Secret<32> {
    keys(byte).finish().key
}

fn device(byte: u8) -> DeviceId {
    DeviceId::new([byte; 32])
}

fn room_group() -> GroupId {
    GroupId::room(ROOM)
}

fn session_group(byte: u8) -> GroupId {
    GroupId::session(ROOM, SessionId::new([byte; 16]))
}

fn content_key(byte: u8) -> Secret<32> {
    Secret::new([byte; 32])
}

fn context(group: GroupId, epoch: u64) -> KeyContext {
    KeyContext::of(
        &group,
        epoch,
        format!("group info {group} {epoch}").as_bytes(),
    )
    .unwrap()
}

/// A row for `group` and `epoch` sealed to the keys of `code_byte`, by a human writer when `human`.
fn row(code_byte: u8, group: GroupId, epoch: u64, key: u8, human: bool) -> SealedKey {
    let keys = keys(code_byte);
    let mac = mac_of(code_byte);
    SealedKey::seal(
        &mut SystemEntropy,
        &Sealing {
            context: context(group, epoch),
            room_epoch: room_epoch_of(code_byte, group, epoch),
            recovery_hpke_key: &keys.public().hpke_key,
            writer: device(0xA1),
            content_key: &content_key(key),
        },
        human.then_some(&mac),
    )
    .unwrap()
}

/// The room epoch a test row names: a room row its own epoch, a session row the first room epoch under its
/// code in [`history_of`] (code 1 from epoch 0, code 2 from 2, code 3 from 4).
fn room_epoch_of(code_byte: u8, group: GroupId, epoch: u64) -> u64 {
    if group.is_room() {
        epoch
    } else {
        u64::from(code_byte.saturating_sub(1)) * 2
    }
}

/// A room that kept the keys of `code_byte` through ten epochs.
fn flat(code_byte: u8) -> RoomHistory {
    let mut history = RoomHistory::new(room_state(0, &[device(0xA1)], code_byte));
    for epoch in 1..10 {
        history
            .record(room_state(epoch, &[device(0xA1)], code_byte))
            .unwrap();
    }
    history
}

/// No session group's Commits were verified.
fn unverified(_: &GroupId, _: u64) -> Option<u64> {
    None
}

fn select(
    rows: &[Vec<u8>],
    openers: &[Opener],
    history: &RoomHistory,
) -> Result<Vec<RecoveredKey>, Error> {
    select_keys(&ROOM, rows, openers, history, &unverified)
}

fn bytes_of(rows: &[SealedKey]) -> Vec<Vec<u8>> {
    rows.iter().map(|row| row.to_bytes().unwrap()).collect()
}

fn room_state(epoch: u64, humans: &[DeviceId], code_byte: u8) -> RoomState {
    let public = keys(code_byte).public();
    RoomState {
        epoch,
        state: Hash32::new([epoch as u8; 32]),
        humans: humans.iter().copied().collect::<BTreeSet<_>>(),
        room: TrommiRoom {
            recovery_signature_key: public.signature_key,
            recovery_hpke_key: public.hpke_key,
            agents: Vec::new(),
        },
    }
}

// ---- the keys ----

#[test]
fn the_three_keys_follow_from_the_code_by_their_labels() {
    let code = code(7);
    let keys = RecoveryKeys::from_code(code.duplicate()).unwrap();
    let sign =
        SigningKey::from_seed(expand_with_label(&code, "trommi recovery sign", &[]).unwrap());
    let hpke_secret: Secret<32> = expand_with_label(&code, "trommi recovery hpke", &[]).unwrap();
    let hpke = derive_hpke_keypair(&hpke_secret).unwrap();
    let mac: Secret<32> = expand_with_label(&code, "trommi recovery mac", &[]).unwrap();

    let public = keys.public();
    assert_eq!(public.signature_key, sign.public());
    assert_eq!(public.hpke_key, hpke.public);
    assert_ne!(public.signature_key, public.hpke_key);
    assert_eq!(keys.signing_key().public(), sign.public());
    assert_eq!(keys.opener().unwrap().recovery_hpke_key(), &hpke.public);

    // Ending the use of the code leaves recovery_mac and the public key it belongs to, nothing else.
    let left = keys.finish();
    assert_eq!(left.key, mac);
    assert_eq!(left.recovery_hpke_key, hpke.public);

    // Another code, other keys.
    let other = RecoveryKeys::from_code(Secret::new([8; 32]))
        .unwrap()
        .public();
    assert_ne!(other.signature_key, public.signature_key);
    assert_ne!(other.hpke_key, public.hpke_key);
}

#[test]
fn a_fresh_code_is_random_and_its_keys_are_the_codes() {
    let (code_a, keys_a) = RecoveryKeys::generate(&mut SystemEntropy).unwrap();
    let (code_b, keys_b) = RecoveryKeys::generate(&mut SystemEntropy).unwrap();
    assert_ne!(code_a, code_b);
    assert_ne!(keys_a.public(), keys_b.public());
    assert_eq!(
        RecoveryKeys::from_code(code_a.duplicate())
            .unwrap()
            .public(),
        keys_a.public()
    );
    assert_eq!(format!("{keys_a:?}").matches("redacted").count(), 4);
}

#[test]
fn a_room_is_tied_to_the_code_by_both_public_keys() {
    let keys = keys(1);
    let state = room_state(0, &[device(1)], 1);
    assert_eq!(keys.check_room(&state.room), Ok(()));
    let mut other = state.room.clone();
    other.recovery_signature_key = [9; 32];
    assert_eq!(keys.check_room(&other), Err(Error::WrongRecovery));
    let mut other = state.room.clone();
    other.recovery_hpke_key = [9; 32];
    assert_eq!(keys.check_room(&other), Err(Error::WrongRecovery));
    assert_eq!(
        keys.check_room(&room_state(0, &[], 2).room),
        Err(Error::WrongRecovery)
    );
}

// ---- SealedKey ----

#[test]
fn a_sealed_key_opens_to_its_content_key_and_carries_the_mac_of_section_8() {
    let opener = keys(1).opener().unwrap();
    let mac = mac_of(1);
    let sealed = row(1, session_group(3), 5, 0x55, true);
    assert_eq!(sealed.open(&opener).unwrap(), content_key(0x55));
    assert_eq!(sealed.mac_state(&mac), Ok(MacState::Valid));
    assert_eq!(sealed.mac_state(&mac_of(2)), Ok(MacState::Invalid));

    // mac = HMAC-SHA-256(recovery_mac, "TrommiSealedKey" ‖ all fields before mac).
    let encoded = sealed.to_bytes().unwrap();
    assert_eq!(encoded.len(), recovery::MAX_SEALED_KEY_LEN);
    let (before, tail) = encoded.split_at(encoded.len() - 33);
    assert_eq!(tail[0], 32);
    let input = [b"TrommiSealedKey".as_slice(), before].concat();
    assert_eq!(tail[1..], hmac_sha256(&mac, &input).unwrap());

    assert_eq!(SealedKey::from_bytes(&encoded).unwrap(), sealed);

    // A non-human writer leaves the mac empty.
    let plain = row(1, room_group(), 0, 0x56, false);
    assert_eq!(plain.mac, None);
    assert_eq!(plain.mac_state(&mac), Ok(MacState::Absent));
    assert_eq!(plain.open(&opener).unwrap(), content_key(0x56));
    assert_eq!(*plain.to_bytes().unwrap().last().unwrap(), 0);
}

#[test]
fn a_sealed_key_opens_only_under_its_own_context_and_key() {
    let opener = keys(1).opener().unwrap();
    let sealed = row(1, room_group(), 4, 0x55, true);
    assert_eq!(
        sealed.open(&keys(2).opener().unwrap()),
        Err(Error::WrongRecovery)
    );

    // The context is HPKE's info: a row moved to another epoch, group or GroupInfo does not open.
    let mut moved = sealed.clone();
    moved.context.epoch = 5;
    assert_eq!(moved.open(&opener), Err(Error::DecryptFailed));
    let mut moved = sealed.clone();
    moved.context.group = session_group(1);
    assert_eq!(moved.open(&opener), Err(Error::DecryptFailed));
    let mut moved = sealed.clone();
    moved.context.group_info = Hash32::new([1; 32]);
    assert_eq!(moved.open(&opener), Err(Error::DecryptFailed));

    // A row that names this key but was sealed to another one does not open either.
    let mut renamed = row(2, room_group(), 4, 0x55, true);
    renamed.recovery_hpke_key = keys(1).public().hpke_key;
    assert_eq!(renamed.open(&opener), Err(Error::DecryptFailed));
}

/// One change to a row.
type Change = Box<dyn Fn(&mut SealedKey)>;

#[test]
fn the_mac_covers_every_field_before_it() {
    let mac = mac_of(1);
    let sealed = row(1, room_group(), 4, 0x55, true);
    let changed: Vec<Change> = vec![
        Box::new(|row| row.context.epoch += 1),
        Box::new(|row| row.context.group = session_group(1)),
        Box::new(|row| row.context.group_info = Hash32::new([1; 32])),
        Box::new(|row| row.room_epoch += 1),
        Box::new(|row| row.recovery_hpke_key[0] ^= 1),
        Box::new(|row| row.sealed.kem_output[0] ^= 1),
        Box::new(|row| row.sealed.ciphertext[0] ^= 1),
        Box::new(|row| row.writer = device(0xA2)),
        Box::new(|row| row.mac.as_mut().unwrap()[31] ^= 1),
    ];
    for change in changed {
        let mut row = sealed.clone();
        change(&mut row);
        assert_eq!(row.mac_state(&mac), Ok(MacState::Invalid));
    }
}

#[test]
fn a_sealed_key_decodes_strictly() {
    let encoded = row(1, room_group(), 4, 0x55, true).to_bytes().unwrap();
    assert!(encoded.len() < recovery::MAX_SEALED_KEY_LEN);

    let mut trailing = encoded.clone();
    trailing.push(0);
    assert_eq!(SealedKey::from_bytes(&trailing), Err(Error::BadFormat));
    for cut in 0..encoded.len() {
        assert_eq!(
            SealedKey::from_bytes(&encoded[..cut]),
            Err(Error::BadFormat)
        );
    }
    assert_eq!(
        SealedKey::from_bytes(&vec![0; recovery::MAX_SEALED_KEY_LEN + 1]),
        Err(Error::BadFormat)
    );

    // Field by field: a group id, a recovery key, a ciphertext or a mac of another length.
    let room = [0x10u8; 32];
    let build = |group: &[u8], key: &[u8], kem: &[u8], ciphertext: &[u8], mac: &[u8]| {
        let mut bytes = Vec::new();
        for (field, prefixed) in [
            (group, true),
            (&[0u8; 8][..], false),
            (&[0u8; 32][..], false),
            (&[0u8; 8][..], false),
            (key, true),
            (kem, true),
            (ciphertext, true),
            (&[0u8; 32][..], false),
            (mac, true),
        ] {
            if prefixed {
                bytes.push(field.len() as u8);
            }
            bytes.extend_from_slice(field);
        }
        SealedKey::from_bytes(&bytes).map(|_| ())
    };
    let (k, c, m) = ([1u8; 32], [2u8; 48], [3u8; 32]);
    assert_eq!(build(&room, &k, &k, &c, &m), Ok(()));
    assert_eq!(build(&room, &k, &k, &c, &[]), Ok(()));
    assert_eq!(build(&room[..31], &k, &k, &c, &m), Err(Error::BadFormat));
    assert_eq!(build(&[0; 40], &k, &k, &c, &m), Err(Error::BadFormat));
    assert_eq!(build(&room, &k[..31], &k, &c, &m), Err(Error::BadFormat));
    assert_eq!(build(&room, &[], &k, &c, &m), Err(Error::BadFormat));
    assert_eq!(build(&room, &k, &k[..31], &c, &m), Err(Error::BadFormat));
    assert_eq!(build(&room, &k, &k, &c[..47], &m), Err(Error::BadFormat));
    assert_eq!(build(&room, &k, &k, &[2; 49], &m), Err(Error::BadFormat));
    assert_eq!(build(&room, &k, &k, &c, &m[..31]), Err(Error::BadFormat));
    assert_eq!(build(&room, &k, &k, &c, &[3; 33]), Err(Error::BadFormat));
    assert_eq!(build(&room, &k, &k, &c, &[3; 1]), Err(Error::BadFormat));
}

// ---- RecoveryAuth ----

struct Join {
    group: GroupId,
    base: Hash32,
    state: Hash32,
    joiner: DeviceId,
    commit: Vec<u8>,
    key: [u8; 32],
    auth: Vec<u8>,
}

fn join() -> Join {
    let keys = keys(1);
    let group = session_group(2);
    let base = KeyContext::of(&group, 6, b"the group info of epoch 6").unwrap();
    let state = Hash32::new([0x77; 32]);
    let joiner = device(0xB1);
    let commit = b"the external commit".to_vec();
    let auth = keys
        .authorise(
            &RecoveryJoin {
                base,
                room_epoch: 3,
                room_state: state,
                joiner,
            },
            &commit,
        )
        .unwrap();
    Join {
        group,
        base: base.group_info,
        state,
        joiner,
        commit,
        key: keys.public().signature_key,
        auth,
    }
}

impl Join {
    fn facts(&self) -> JoinFacts<'_> {
        JoinFacts {
            group: &self.group,
            epoch: 6,
            base_group_info: Some(&self.base),
            room_epoch: 3,
            room_state: &self.state,
            joiner: &self.joiner,
            commit: &self.commit,
            recovery_signature_key: &self.key,
        }
    }

    fn note(&self) -> CommitNote {
        CommitNote {
            room_epoch: 3,
            room_state: self.state,
            time: 1,
            cuts: Vec::new(),
            join: true,
        }
    }
}

#[test]
fn a_recovery_auth_is_the_labelled_signature_over_join_and_commit_hash() {
    let join = join();
    let auth = RecoveryAuth::from_bytes(&join.auth).unwrap();
    assert_eq!(join.auth.len(), recovery::MAX_RECOVERY_AUTH_LEN);
    assert_eq!(auth.commit, commit_hash(&join.commit).unwrap());
    assert_eq!(
        auth.commit,
        crypto::ref_hash("Trommi Commit", &join.commit).unwrap()
    );
    assert_eq!(
        group_info_hash(b"x").unwrap(),
        crypto::ref_hash("Trommi Group Info", b"x").unwrap()
    );
    let signed = [
        codec::encode(&auth.join).unwrap(),
        auth.commit.as_bytes().to_vec(),
    ]
    .concat();
    assert_eq!(
        crypto::verify_with_label(&join.key, "TrommiRecoveryJoin", &signed, &auth.signature),
        Ok(())
    );
    assert_eq!(auth.verify(&join.facts()), Ok(()));
    assert_eq!(auth.to_bytes().unwrap(), join.auth);
}

#[test]
fn a_recovery_auth_fits_only_its_own_join() {
    let join = join();
    let auth = RecoveryAuth::from_bytes(&join.auth).unwrap();
    let other_hash = Hash32::new([0x01; 32]);
    let other_group = session_group(9);
    let other_device = device(0xB2);

    let mut facts = join.facts();
    facts.room_epoch = 4;
    assert_eq!(auth.verify(&facts), Err(Error::BadCommit));
    let mut facts = join.facts();
    facts.room_state = &other_hash;
    assert_eq!(auth.verify(&facts), Err(Error::BadCommit));
    let mut facts = join.facts();
    facts.group = &other_group;
    assert_eq!(auth.verify(&facts), Err(Error::BadCommit));
    let mut facts = join.facts();
    facts.epoch = 7;
    assert_eq!(auth.verify(&facts), Err(Error::BadCommit));
    let mut facts = join.facts();
    facts.base_group_info = Some(&other_hash);
    assert_eq!(auth.verify(&facts), Err(Error::BadCommit));
    let mut facts = join.facts();
    facts.joiner = &other_device;
    assert_eq!(auth.verify(&facts), Err(Error::BadCommit));
    // Moved to another Commit.
    let mut facts = join.facts();
    facts.commit = b"another external commit";
    assert_eq!(auth.verify(&facts), Err(Error::BadCommit));

    // A verifier that does not hold the posted GroupInfo checks the rest.
    let mut facts = join.facts();
    facts.base_group_info = None;
    assert_eq!(auth.verify(&facts), Ok(()));
}

#[test]
fn a_recovery_auth_needs_the_rooms_recovery_signature() {
    let join = join();
    let auth = RecoveryAuth::from_bytes(&join.auth).unwrap();

    // Under another room's recovery key, or the key after a replacement.
    let other = keys(2).public().signature_key;
    let mut facts = join.facts();
    facts.recovery_signature_key = &other;
    assert_eq!(auth.verify(&facts), Err(Error::BadSignature));

    // Signed by a device key instead of the recovery key: a stolen device key authorises nothing.
    let thief = SigningKey::from_seed(Secret::new([0x66; 32]));
    let signed = [
        codec::encode(&auth.join).unwrap(),
        auth.commit.as_bytes().to_vec(),
    ]
    .concat();
    let mut forged = auth.clone();
    forged.signature = crypto::sign_with_label(&thief, "TrommiRecoveryJoin", &signed)
        .unwrap()
        .try_into()
        .unwrap();
    assert_eq!(forged.verify(&join.facts()), Err(Error::BadSignature));

    // A changed signature; a changed field under the old signature.
    for at in [0, 31, 63] {
        let mut changed = auth.clone();
        changed.signature[at] ^= 1;
        assert_eq!(changed.verify(&join.facts()), Err(Error::BadSignature));
    }
    let mut changed = auth.clone();
    changed.join.joiner = device(0xB2);
    let other_device = device(0xB2);
    let mut facts = join.facts();
    facts.joiner = &other_device;
    assert_eq!(changed.verify(&facts), Err(Error::BadSignature));

    // The same content under another label is no RecoveryAuth.
    let mut relabelled = auth.clone();
    relabelled.signature = crypto::sign_with_label(keys(1).signing_key(), "TrommiHubAuth", &signed)
        .unwrap()
        .try_into()
        .unwrap();
    assert_eq!(relabelled.verify(&join.facts()), Err(Error::BadSignature));
}

#[test]
fn the_rules_take_a_join_only_with_its_recovery_auth() {
    let join = join();
    let note = join.note();
    let claim = |recovery_auth| JoinClaim {
        group: &join.group,
        epoch: 6,
        joiner: &join.joiner,
        note: &note,
        commit: &join.commit,
        base_group_info: None,
        recovery_signature_key: &join.key,
        recovery_auth,
    };
    assert_eq!(PublicRules.verify_join(&claim(Some(&join.auth))), Ok(()));
    // No recovery signature at all: there is no other join from outside.
    assert_eq!(PublicRules.verify_join(&claim(None)), Err(Error::BadCommit));
    assert_eq!(
        PublicRules.verify_join(&claim(Some(b""))),
        Err(Error::BadCommit)
    );
    assert_eq!(
        PublicRules.verify_join(&claim(Some(b"test recovery auth"))),
        Err(Error::BadCommit)
    );
    let mut longer = join.auth.clone();
    longer.push(0);
    assert_eq!(
        PublicRules.verify_join(&claim(Some(&longer))),
        Err(Error::BadCommit)
    );
    let mut flipped = join.auth.clone();
    *flipped.last_mut().unwrap() ^= 1;
    assert_eq!(
        PublicRules.verify_join(&claim(Some(&flipped))),
        Err(Error::BadSignature)
    );

    // The note of another room epoch; another Commit; another joiner; the key of another code.
    let mut other_note = join.note();
    other_note.room_epoch = 4;
    let mut moved = claim(Some(&join.auth));
    moved.note = &other_note;
    assert_eq!(PublicRules.verify_join(&moved), Err(Error::BadCommit));
    let mut moved = claim(Some(&join.auth));
    moved.commit = b"another commit";
    assert_eq!(PublicRules.verify_join(&moved), Err(Error::BadCommit));
    let mut moved = claim(Some(&join.auth));
    moved.epoch = 5;
    assert_eq!(PublicRules.verify_join(&moved), Err(Error::BadCommit));
    let other = keys(2).public().signature_key;
    let mut moved = claim(Some(&join.auth));
    moved.recovery_signature_key = &other;
    assert_eq!(PublicRules.verify_join(&moved), Err(Error::BadSignature));
    // The hub holds the GroupInfo posted for the epoch the join builds on, and the join names it.
    let mut held = claim(Some(&join.auth));
    held.base_group_info = Some(&join.base);
    assert_eq!(PublicRules.verify_join(&held), Ok(()));
    let another = Hash32::new([0x02; 32]);
    held.base_group_info = Some(&another);
    assert_eq!(PublicRules.verify_join(&held), Err(Error::BadCommit));
}

#[test]
fn a_recovery_auth_decodes_strictly() {
    let join = join();
    for cut in 0..join.auth.len() {
        assert_eq!(
            RecoveryAuth::from_bytes(&join.auth[..cut]),
            Err(Error::BadFormat)
        );
    }
    let mut trailing = join.auth.clone();
    trailing.push(0);
    assert_eq!(RecoveryAuth::from_bytes(&trailing), Err(Error::BadFormat));
    // A signature of 63 bytes.
    let at = join.auth.len() - 66;
    let mut short = join.auth[..at].to_vec();
    short.push(63);
    short.extend_from_slice(&[0; 63]);
    assert_eq!(RecoveryAuth::from_bytes(&short), Err(Error::BadFormat));
}

// ---- the public check of a SealedKey that comes with a Commit ----

#[test]
fn the_rules_take_a_sealed_key_only_for_its_commit() {
    let hpke = keys(1).public().hpke_key;
    let mac = mac_of(1);
    let group = session_group(2);
    let writer = device(0xA1);
    let info = b"the group info of epoch 5".to_vec();
    let sealing = Sealing {
        context: KeyContext::of(&group, 5, &info).unwrap(),
        room_epoch: 3,
        recovery_hpke_key: &hpke,
        writer,
        content_key: &content_key(1),
    };
    let by_human = SealedKey::seal(&mut SystemEntropy, &sealing, Some(&mac)).unwrap();
    let by_opener = SealedKey::seal(&mut SystemEntropy, &sealing, None).unwrap();
    let claim = SealedKeyClaim {
        group: &group,
        epoch: 5,
        group_info: &info,
        room_epoch: 3,
        recovery_hpke_key: &hpke,
        writer: &writer,
        writer_is_human: true,
    };
    let check = |claim: &SealedKeyClaim<'_>, row: &SealedKey| {
        PublicRules.verify_sealed_key(claim, &row.to_bytes().unwrap())
    };
    assert_eq!(check(&claim, &by_human), Ok(()));
    // The hub cannot check the mac's value: any 32 bytes pass here, and a device with the code ignores the row.
    let mut wrong_mac = by_human.clone();
    wrong_mac.mac = Some([0; 32]);
    assert_eq!(check(&claim, &wrong_mac), Ok(()));

    // A human writer sets a mac; a non-human writer leaves it empty.
    assert_eq!(check(&claim, &by_opener), Err(Error::Incomplete));
    let opener_claim = SealedKeyClaim {
        writer_is_human: false,
        ..claim
    };
    assert_eq!(check(&opener_claim, &by_opener), Ok(()));
    assert_eq!(check(&opener_claim, &by_human), Err(Error::Incomplete));

    // The wrong context: another epoch, group or GroupInfo.
    let other_group = session_group(3);
    for wrong in [
        SealedKeyClaim { epoch: 6, ..claim },
        SealedKeyClaim {
            group: &other_group,
            ..claim
        },
        SealedKeyClaim {
            group_info: b"another group info",
            ..claim
        },
        // The wrong key for the room epoch, the wrong room epoch, a writer that is not the committer.
        SealedKeyClaim {
            recovery_hpke_key: &[9; 32],
            ..claim
        },
        SealedKeyClaim {
            room_epoch: 4,
            ..claim
        },
        SealedKeyClaim {
            writer: &device(0xA2),
            ..claim
        },
    ] {
        assert_eq!(check(&wrong, &by_human), Err(Error::Incomplete));
    }

    // Nothing, and bytes that are no row.
    assert_eq!(
        PublicRules.verify_sealed_key(&claim, &[]),
        Err(Error::Incomplete)
    );
    assert_eq!(
        PublicRules.verify_sealed_key(&claim, b"test sealed key"),
        Err(Error::Incomplete)
    );
}

#[test]
fn a_recovery_auth_message_is_taken_by_the_rule_of_7_4() {
    let own = device(0xA2);
    let inviter = device(0xA1);
    let room = room_state(4, &[inviter, own], 1);
    let hpke = room.room.recovery_hpke_key;
    let mac = mac_of(1);
    let message = AuthMessage {
        sender: &inviter,
        recipient: &own,
        recovery_hpke_key: &hpke,
        recovery_mac: &mac,
    };
    let mut held = MacKeys::new();
    assert!(!may_commit(&held, &room));

    // Not from a human device of that epoch; for another device; naming another key.
    let stranger = device(0xC1);
    let dropped = [
        AuthMessage {
            sender: &stranger,
            ..message
        },
        AuthMessage {
            recipient: &inviter,
            ..message
        },
        AuthMessage {
            recovery_hpke_key: &[9; 32],
            ..message
        },
    ];
    for message in &dropped {
        assert_eq!(
            take_recovery_auth(&mut held, &own, &room, message),
            Ok(Taken::Dropped)
        );
    }
    assert!(!may_commit(&held, &room));

    assert_eq!(
        take_recovery_auth(&mut held, &own, &room, &message),
        Ok(Taken::New)
    );
    assert!(may_commit(&held, &room));
    assert_eq!(held.get(&hpke), Some(&mac));
    assert_eq!(held.iter().count(), 1);

    // Again, and to all: the same value is held already.
    let to_all = AuthMessage {
        recipient: &DeviceId::ZERO,
        ..message
    };
    assert_eq!(
        take_recovery_auth(&mut held, &own, &room, &to_all),
        Ok(Taken::Held)
    );

    // A second, different value is a finding and replaces nothing.
    let other = mac_of(2);
    let second = AuthMessage {
        recovery_mac: &other,
        ..message
    };
    assert_eq!(
        take_recovery_auth(&mut held, &own, &room, &second),
        Err(Error::Equivocation)
    );
    assert_eq!(held.get(&hpke), Some(&mac));

    // After a replacement the new key's mac is taken beside the old one, which stays.
    let replaced = room_state(5, &[inviter, own], 2);
    assert!(!may_commit(&held, &replaced));
    let new_hpke = replaced.room.recovery_hpke_key;
    let new = AuthMessage {
        sender: &inviter,
        recipient: &DeviceId::ZERO,
        recovery_hpke_key: &new_hpke,
        recovery_mac: &other,
    };
    // A message of the epoch before the replacement cannot name the new key.
    assert_eq!(
        take_recovery_auth(&mut held, &own, &room, &new),
        Ok(Taken::Dropped)
    );
    assert_eq!(
        take_recovery_auth(&mut held, &own, &replaced, &new),
        Ok(Taken::New)
    );
    assert!(may_commit(&held, &replaced));
    assert!(held.holds(&hpke));
    assert!(format!("{held:?}").contains("redacted"));
}

// ---- 8.5: the anchor ----

#[test]
fn the_anchor_is_the_newest_room_row_with_a_valid_mac() {
    let keys = keys(1);
    let rows = vec![
        row(1, room_group(), 0, 1, true),
        row(1, room_group(), 3, 2, true),
        row(1, room_group(), 2, 3, true),
        // A later epoch whose row has no valid mac does not block: empty, forged, or under another code.
        row(1, room_group(), 4, 4, false),
        {
            let mut forged = row(1, room_group(), 5, 5, true);
            forged.mac = Some([7; 32]);
            forged
        },
        row(2, room_group(), 6, 6, true),
        // Rows of a session group, however new, anchor nothing.
        row(1, session_group(1), 9, 7, true),
        // A row of another room.
        row(1, GroupId::room(RoomId::new([0x11; 32])), 8, 8, true),
    ];
    let mut served = bytes_of(&rows);
    served.push(b"no row".to_vec());
    served.push(Vec::new());
    assert_eq!(
        select_anchor(&keys, &ROOM, &served),
        Ok(context(room_group(), 3))
    );
    // The order in which the hub serves them does not matter.
    served.reverse();
    assert_eq!(
        select_anchor(&keys, &ROOM, &served),
        Ok(context(room_group(), 3))
    );
}

#[test]
fn without_an_authenticated_room_row_the_code_is_the_wrong_one() {
    let keys = keys(1);
    assert_eq!(select_anchor(&keys, &ROOM, &[]), Err(Error::WrongRecovery));
    // A hub's own room: it knows the public keys and can seal, but holds no recovery_mac.
    let unauthenticated = bytes_of(&[
        row(1, room_group(), 0, 1, false),
        row(1, room_group(), 1, 2, false),
    ]);
    assert_eq!(
        select_anchor(&keys, &ROOM, &unauthenticated),
        Err(Error::WrongRecovery)
    );
    // The rows of another code.
    let others = bytes_of(&[row(2, room_group(), 0, 1, true)]);
    assert_eq!(
        select_anchor(&keys, &ROOM, &others),
        Err(Error::WrongRecovery)
    );
    // The right rows, asked for under another room.
    let real = bytes_of(&[row(1, room_group(), 0, 1, true)]);
    assert_eq!(
        select_anchor(&keys, &RoomId::new([0x11; 32]), &real),
        Err(Error::WrongRecovery)
    );
    assert_eq!(
        select_anchor(&keys, &ROOM, &real).map(|anchor| anchor.epoch),
        Ok(0)
    );
}

#[test]
fn two_anchors_for_one_epoch_are_an_equivocation() {
    let keys = keys(1);
    let honest = row(1, room_group(), 3, 2, true);
    let mut other = honest.clone();
    other.context.group_info = Hash32::new([0x44; 32]);
    let mac = mac_of(1);
    // Whoever holds recovery_mac can authenticate a second GroupInfo for the epoch.
    let resealed = SealedKey::seal(
        &mut SystemEntropy,
        &Sealing {
            context: other.context,
            room_epoch: 0,
            recovery_hpke_key: &keys.public().hpke_key,
            writer: device(0xA3),
            content_key: &content_key(2),
        },
        Some(&mac),
    )
    .unwrap();
    let served = bytes_of(&[
        row(1, room_group(), 2, 1, true),
        honest.clone(),
        resealed.clone(),
    ]);
    assert_eq!(
        select_anchor(&keys, &ROOM, &served),
        Err(Error::Equivocation)
    );
    // Two rows that name the same GroupInfo agree, whoever wrote them.
    let mut second = honest.clone();
    second.writer = device(0xA3);
    second.mac = Some(
        hmac_sha256(&mac, &{
            let encoded = second.to_bytes().unwrap();
            [
                b"TrommiSealedKey".as_slice(),
                &encoded[..encoded.len() - 33],
            ]
            .concat()
        })
        .unwrap(),
    );
    assert_eq!(second.mac_state(&mac), Ok(MacState::Valid));
    assert_eq!(
        select_anchor(&keys, &ROOM, &bytes_of(&[honest.clone(), second])),
        Ok(honest.context)
    );
    // A conflict below the newest authenticated epoch is not the anchor's.
    let newer = row(1, room_group(), 4, 3, true);
    assert_eq!(
        select_anchor(&keys, &ROOM, &bytes_of(&[honest, resealed, newer.clone()])),
        Ok(newer.context)
    );
}

// ---- 8.5: the keys ----

#[test]
fn keys_are_taken_per_group_and_epoch_and_marked() {
    let openers = [keys(1).opener().unwrap()];
    let session = session_group(1);
    let helper = session_group(2);
    let rows = bytes_of(&[
        row(1, room_group(), 0, 10, true),
        row(1, room_group(), 1, 11, true),
        row(1, session, 0, 20, true),
        row(1, session, 1, 21, true),
        // A helper session's rows written by its opener: no mac.
        row(1, helper, 0, 30, false),
        row(1, helper, 1, 31, false),
        // The same epoch also carries a human device's row: that one counts.
        row(1, helper, 2, 32, false),
        row(1, helper, 2, 32, true),
    ]);
    let keys = select(&rows, &openers, &flat(1)).unwrap();
    let found: Vec<(GroupId, u64, bool)> = keys
        .iter()
        .map(|key| (key.group, key.epoch, key.confirmed))
        .collect();
    assert_eq!(
        found,
        vec![
            (room_group(), 0, true),
            (room_group(), 1, true),
            (session, 0, true),
            (session, 1, true),
            (helper, 0, false),
            (helper, 1, false),
            (helper, 2, true),
        ]
    );
    assert_eq!(keys[0].key, content_key(10));
    assert_eq!(keys[3].key, content_key(21));
    assert_eq!(keys[5].key, content_key(31));
    assert_eq!(keys[6].key, content_key(32));
    assert!(format!("{keys:?}").contains("redacted"));
}

#[test]
fn an_unauthenticated_row_never_stands_against_an_authenticated_one() {
    let openers = [keys(1).opener().unwrap()];
    let session = session_group(1);
    // A hub's own row for an epoch that has an authenticated one, whichever comes first.
    for rows in [
        [row(1, session, 4, 66, false), row(1, session, 4, 40, true)],
        [row(1, session, 4, 40, true), row(1, session, 4, 66, false)],
    ] {
        let keys = select(&bytes_of(&rows), &openers, &flat(1)).unwrap();
        assert_eq!(keys.len(), 1);
        assert_eq!(keys[0].key, content_key(40));
        assert!(keys[0].confirmed);
    }
}

#[test]
fn authenticated_rows_that_disagree_are_an_equivocation() {
    let openers = [keys(1).opener().unwrap()];
    let session = session_group(1);
    let rows = bytes_of(&[row(1, session, 4, 40, true), row(1, session, 4, 41, true)]);
    assert_eq!(select(&rows, &openers, &flat(1)), Err(Error::Equivocation));
    // The same key twice, from two writers, agrees.
    let rows = bytes_of(&[row(1, session, 4, 40, true), row(1, session, 4, 40, true)]);
    assert_eq!(select(&rows, &openers, &flat(1)).unwrap().len(), 1);
}

#[test]
fn tampered_rows_open_nothing() {
    let openers = [keys(1).opener().unwrap()];
    let session = session_group(1);
    let real_3 = row(1, session, 3, 30, true);
    let real_4 = row(1, session, 4, 40, true);

    // A swapped row: epoch 4's sealed key served under epoch 3's context. Its mac does not verify.
    let mut swapped = real_3.clone();
    swapped.sealed = real_4.sealed.clone();
    let keys = select(&bytes_of(&[swapped.clone()]), &openers, &flat(1)).unwrap();
    assert!(keys.is_empty());
    // The same without a mac: the context is the sealing's info, so it does not open.
    swapped.mac = None;
    let keys = select(&bytes_of(&[swapped]), &openers, &flat(1)).unwrap();
    assert!(keys.is_empty());

    // A row whose mac was stripped is unconfirmed while alone, and nothing beside the real row.
    let mut stripped = real_4.clone();
    stripped.mac = None;
    let keys = select(&bytes_of(&[stripped.clone()]), &openers, &flat(1)).unwrap();
    assert_eq!((keys.len(), keys[0].confirmed), (1, false));
    let keys = select(&bytes_of(&[stripped, real_4.clone()]), &openers, &flat(1)).unwrap();
    assert_eq!((keys.len(), keys[0].confirmed), (1, true));

    // A wrong context: the real row renamed to another epoch or group.
    let mut renamed = real_4.clone();
    renamed.context.epoch = 5;
    let mut regrouped = real_4.clone();
    regrouped.context.group = session_group(2);
    let keys = select(&bytes_of(&[renamed, regrouped]), &openers, &flat(1)).unwrap();
    assert!(keys.is_empty());

    // A wrong key: a row with a non-empty mac that does not verify is ignored, also when it would open.
    let mut forged = row(1, session, 5, 50, true);
    forged.mac = Some([0; 32]);
    // A row sealed to a key no opener is for; a row of another room.
    let foreign = row(2, session, 6, 60, true);
    let elsewhere = row(
        1,
        GroupId::session(RoomId::new([0x11; 32]), SessionId::new([1; 16])),
        7,
        70,
        true,
    );
    let mut served = bytes_of(&[forged, foreign, elsewhere, real_3]);
    served.push(b"junk".to_vec());
    let keys = select(&served, &openers, &flat(1)).unwrap();
    assert_eq!(keys.len(), 1);
    assert_eq!((keys[0].epoch, &keys[0].key), (3, &content_key(30)));

    // An authenticated row that does not open cannot come from an honest device.
    let mac = mac_of(1);
    let mut broken = row(1, session, 8, 80, true);
    broken.sealed.ciphertext[0] ^= 1;
    let encoded = broken.to_bytes().unwrap();
    let input = [
        b"TrommiSealedKey".as_slice(),
        &encoded[..encoded.len() - 33],
    ]
    .concat();
    broken.mac = Some(hmac_sha256(&mac, &input).unwrap());
    assert_eq!(
        select(&bytes_of(&[broken]), &openers, &flat(1)),
        Err(Error::Equivocation)
    );
}

#[test]
fn the_hub_lists_an_authenticated_row_or_the_device_posts_one() {
    let session = session_group(1);
    let mut held = MacKeys::new();
    held.hold(keys(1).finish()).unwrap();
    let rows = bytes_of(&[
        row(1, session, 3, 30, false),
        row(1, session, 4, 40, true),
        row(2, session, 5, 50, true),
        {
            let mut forged = row(1, session, 6, 60, true);
            forged.mac = Some([1; 32]);
            forged
        },
    ]);
    assert_eq!(lists_authenticated(&rows, &session, 4, &held), Ok(true));
    for epoch in [3, 5, 6, 7] {
        assert_eq!(
            lists_authenticated(&rows, &session, epoch, &held),
            Ok(false)
        );
    }
    assert_eq!(
        lists_authenticated(&rows, &room_group(), 4, &held),
        Ok(false)
    );
    assert_eq!(
        lists_authenticated(&rows, &session, 4, &MacKeys::new()),
        Ok(false)
    );
}

#[test]
fn the_hub_takes_a_posted_row_only_from_its_human_writer_for_the_state_in_force() {
    let writer = device(0xA1);
    let room = room_state(3, &[writer], 1);
    let hpke = room.room.recovery_hpke_key;
    let session = session_group(1);
    let info = b"the group info the hub holds".to_vec();
    let mac = mac_of(1);
    let seal = |room_epoch, hpke: &[u8; 32], mac: Option<&Secret<32>>| {
        SealedKey::seal(
            &mut SystemEntropy,
            &Sealing {
                context: KeyContext::of(&session, 2, &info).unwrap(),
                room_epoch,
                recovery_hpke_key: hpke,
                writer,
                content_key: &content_key(2),
            },
            mac,
        )
        .unwrap()
        .to_bytes()
        .unwrap()
    };
    let posted = PostedRow {
        poster: &writer,
        room_id: &ROOM,
        room: &room,
        group_info: Some(&info),
    };
    let good = seal(3, &hpke, Some(&mac));
    assert_eq!(
        check_posted_row(&good, &posted).map(|row| row.writer),
        Ok(writer)
    );

    assert_eq!(check_posted_row(b"junk", &posted), Err(Error::BadFormat));
    // Posted by another device than its writer; by a device that is no human device.
    let other = device(0xA2);
    let by_other = PostedRow {
        poster: &other,
        ..posted
    };
    assert_eq!(check_posted_row(&good, &by_other), Err(Error::Forbidden));
    let without = room_state(3, &[other], 1);
    let not_human = PostedRow {
        room: &without,
        ..posted
    };
    assert_eq!(check_posted_row(&good, &not_human), Err(Error::Forbidden));
    // For a group of another room.
    let elsewhere = PostedRow {
        room_id: &RoomId::new([0x11; 32]),
        ..posted
    };
    assert_eq!(check_posted_row(&good, &elsewhere), Err(Error::WrongRoom));
    // An older room epoch.
    assert_eq!(
        check_posted_row(&seal(2, &hpke, Some(&mac)), &posted),
        Err(Error::RoomBehind)
    );
    // No GroupInfo held for that group and epoch; another GroupInfo.
    let unknown = PostedRow {
        group_info: None,
        ..posted
    };
    assert_eq!(check_posted_row(&good, &unknown), Err(Error::NotFound));
    let another = PostedRow {
        group_info: Some(b"another group info"),
        ..posted
    };
    assert_eq!(check_posted_row(&good, &another), Err(Error::Incomplete));
    // Without a mac; sealed to a key that is not in force.
    assert_eq!(
        check_posted_row(&seal(3, &hpke, None), &posted),
        Err(Error::Incomplete)
    );
    assert_eq!(
        check_posted_row(&seal(3, &keys(2).public().hpke_key, Some(&mac)), &posted),
        Err(Error::Incomplete)
    );
}

// ---- 8.6 and the links ----

fn history_of(codes: &[u8]) -> RoomHistory {
    let human = device(0xA1);
    let mut history = RoomHistory::new(room_state(0, &[human], codes[0]));
    let mut epoch = 0;
    for code in &codes[1..] {
        // An ordinary Commit, then the one that replaces the keys.
        for code in [codes[epoch as usize / 2], *code] {
            epoch += 1;
            history.record(room_state(epoch, &[human], code)).unwrap();
        }
    }
    history
}

#[test]
fn a_replacement_makes_new_keys_and_a_link_to_the_old_ones() {
    let old = keys(1);
    let history = history_of(&[1]);
    let replacement = old.replace(&mut SystemEntropy, &ROOM, &history).unwrap();
    let new = replacement.keys.public();
    assert_ne!(new, old.public());
    assert_eq!(
        RecoveryKeys::from_code(replacement.code.duplicate())
            .unwrap()
            .public(),
        new
    );

    let link = RecoveryLink::from_bytes(&replacement.link).unwrap();
    assert_eq!(replacement.link.len(), recovery::MAX_RECOVERY_LINK_LEN);
    assert_eq!(link.room_id, ROOM);
    assert_eq!(link.new_recovery_hpke_key, new.hpke_key);
    assert_eq!(link.to_bytes().unwrap(), replacement.link);

    // mac = HMAC-SHA-256(new recovery_mac, "TrommiRecoveryLink" ‖ all fields before mac).
    let new_mac: Secret<32> =
        expand_with_label(&replacement.code, "trommi recovery mac", &[]).unwrap();
    let before = &replacement.link[..replacement.link.len() - 33];
    let input = [b"TrommiRecoveryLink".as_slice(), before].concat();
    assert_eq!(link.mac, hmac_sha256(&new_mac, &input).unwrap());

    // sealed = EncryptWithLabel(new key, "TrommiRecoveryLink", room_id, OldRecovery).
    let new_secret: Secret<32> =
        expand_with_label(&replacement.code, "trommi recovery hpke", &[]).unwrap();
    let opened = crypto::decrypt_with_label(
        &derive_hpke_keypair(&new_secret).unwrap().private,
        "TrommiRecoveryLink",
        ROOM.as_bytes(),
        &link.sealed,
    )
    .unwrap();
    let passed_on: OldRecovery = codec::decode(opened.expose(), 64).unwrap();
    let old_secret: Secret<32> = expand_with_label(&code(1), "trommi recovery hpke", &[]).unwrap();
    assert_eq!(passed_on.hpke_secret, old_secret);
    assert_eq!(passed_on.recovery_mac, mac_of(1));
}

#[test]
fn a_replacement_never_takes_keys_the_room_held_or_a_devices() {
    let seed = [0x5E; 32];
    let mut first = SeededEntropy::new(seed);
    let (drawn, _) = RecoveryKeys::generate(&mut first).unwrap();
    let drawn_public = RecoveryKeys::from_code(drawn.duplicate()).unwrap().public();

    // The room held these keys before: the same draw again is refused.
    let human = device(0xA1);
    let mut history = RoomHistory::new(RoomState {
        room: TrommiRoom {
            recovery_signature_key: drawn_public.signature_key,
            recovery_hpke_key: drawn_public.hpke_key,
            agents: Vec::new(),
        },
        ..room_state(0, &[human], 1)
    });
    history.record(room_state(1, &[human], 1)).unwrap();
    assert_eq!(
        keys(1)
            .replace(&mut SeededEntropy::new(seed), &ROOM, &history)
            .map(|_| ()),
        Err(Error::Entropy)
    );

    // A key that is a device's.
    for as_device in [drawn_public.signature_key, drawn_public.hpke_key] {
        let history = RoomHistory::new(room_state(0, &[human, DeviceId::new(as_device)], 1));
        assert_eq!(
            keys(1)
                .replace(&mut SeededEntropy::new(seed), &ROOM, &history)
                .map(|_| ()),
            Err(Error::Entropy)
        );
    }
    let mut enrolled = room_state(0, &[human], 1);
    enrolled.room.agents = vec![DeviceId::new(drawn_public.hpke_key)];
    assert_eq!(
        keys(1)
            .replace(
                &mut SeededEntropy::new(seed),
                &ROOM,
                &RoomHistory::new(enrolled)
            )
            .map(|_| ()),
        Err(Error::Entropy)
    );

    // A room that never saw them takes them.
    let replacement = keys(1)
        .replace(&mut SeededEntropy::new(seed), &ROOM, &history_of(&[1]))
        .unwrap();
    assert_eq!(replacement.keys.public(), drawn_public);
}

/// The link from the code `new` back to the code `old`, made as the replacing device makes it.
fn link(new: u8, old: u8, room: &RoomId) -> RecoveryLink {
    let new_keys = keys(new);
    let old_secret: Secret<32> =
        expand_with_label(&code(old), "trommi recovery hpke", &[]).unwrap();
    let passed_on = OldRecovery {
        hpke_secret: old_secret,
        recovery_mac: mac_of(old),
    };
    let sealed = encrypt_with_label(
        &mut SystemEntropy,
        &new_keys.public().hpke_key,
        "TrommiRecoveryLink",
        room.as_bytes(),
        &codec::encode(&passed_on).unwrap(),
    )
    .unwrap();
    let mut link = RecoveryLink {
        room_id: *room,
        new_recovery_hpke_key: new_keys.public().hpke_key,
        sealed,
        mac: [0; 32],
    };
    remac(&mut link, &mac_of(new));
    link
}

fn remac(link: &mut RecoveryLink, mac: &Secret<32>) {
    let encoded = link.to_bytes().unwrap();
    let input = [
        b"TrommiRecoveryLink".as_slice(),
        &encoded[..encoded.len() - 33],
    ]
    .concat();
    link.mac = hmac_sha256(mac, &input).unwrap();
}

fn links_of(links: &[RecoveryLink]) -> Vec<Vec<u8>> {
    links.iter().map(|link| link.to_bytes().unwrap()).collect()
}

#[test]
fn the_history_names_every_replacement_of_the_keys() {
    assert_eq!(key_changes(&history_of(&[1])), Vec::new());
    let changes = key_changes(&history_of(&[1, 2, 3]));
    assert_eq!(
        changes,
        vec![
            KeyChange {
                epoch: 2,
                before: keys(1).public().hpke_key,
                after: keys(2).public().hpke_key,
            },
            KeyChange {
                epoch: 4,
                before: keys(2).public().hpke_key,
                after: keys(3).public().hpke_key,
            },
        ]
    );
}

#[test]
fn a_chain_of_two_replacements_opens_every_older_row() {
    let changes = key_changes(&history_of(&[1, 2, 3]));
    let mut links = links_of(&[link(3, 2, &ROOM), link(2, 1, &ROOM)]);
    // What the hub serves beside them: a link of another room, bytes that are no link.
    links.push(link(3, 2, &RoomId::new([0x11; 32])).to_bytes().unwrap());
    links.push(b"no link".to_vec());

    let opened = open_links(&keys(3), &ROOM, &links, &changes).unwrap();
    assert_eq!(opened.missing_link, None);
    let reached: Vec<[u8; 32]> = opened
        .openers
        .iter()
        .map(|opener| *opener.recovery_hpke_key())
        .collect();
    assert_eq!(
        reached,
        vec![
            keys(3).public().hpke_key,
            keys(2).public().hpke_key,
            keys(1).public().hpke_key
        ]
    );
    assert_eq!(opened.openers[2].mac_key().key, mac_of(1));
    assert!(format!("{opened:?}").contains("redacted"));

    // Rows sealed under each of the three codes open, each authenticated under its own code's mac.
    let session = session_group(1);
    let rows = bytes_of(&[
        row(1, room_group(), 0, 10, true),
        row(1, session, 1, 11, true),
        row(2, room_group(), 2, 20, true),
        row(2, session, 2, 21, false),
        row(3, room_group(), 4, 30, true),
        row(3, session, 3, 31, true),
    ]);
    let keys_found = select(&rows, &opened.openers, &history_of(&[1, 2, 3])).unwrap();
    assert_eq!(keys_found.len(), 6);
    assert_eq!(keys_found.iter().filter(|key| key.confirmed).count(), 5);
    assert_eq!(keys_found[0].key, content_key(10));

    // The code in hand alone opens only its own rows; the anchor is never an older code's row.
    let own = [keys(3).opener().unwrap()];
    assert_eq!(
        select(&rows, &own, &history_of(&[1, 2, 3])).unwrap().len(),
        2
    );
    assert_eq!(
        select_anchor(&keys(3), &ROOM, &rows).map(|anchor| anchor.epoch),
        Ok(4)
    );
    assert_eq!(
        select_anchor(&keys(3), &ROOM, &rows[..4]),
        Err(Error::WrongRecovery)
    );

    // An older code walks back from where it stands and learns nothing of what came after.
    let older = open_links(&keys(2), &ROOM, &links, &changes).unwrap();
    assert_eq!(older.openers.len(), 2);
    let first = open_links(&keys(1), &ROOM, &links, &changes).unwrap();
    assert_eq!(first.openers.len(), 1);
    assert_eq!(first.missing_link, None);
}

#[test]
fn a_replaced_code_authenticates_nothing_for_later_epochs() {
    // The room: code 1 at room epochs 0 and 1, code 2 from epoch 2 on. A thief holds code 1.
    let history = history_of(&[1, 2]);
    let changes = key_changes(&history);
    let opened = open_links(&keys(2), &ROOM, &links_of(&[link(2, 1, &ROOM)]), &changes).unwrap();
    let session = session_group(1);
    let forge = |group, epoch, room_epoch, human: bool| {
        let mac = mac_of(1);
        SealedKey::seal(
            &mut SystemEntropy,
            &Sealing {
                context: context(group, epoch),
                room_epoch,
                recovery_hpke_key: &keys(1).public().hpke_key,
                writer: device(0xA1),
                content_key: &content_key(0x66),
            },
            human.then_some(&mac),
        )
        .unwrap()
    };
    // The session's epochs 0 and 1 began under room epoch 0, its epoch 2 under room epoch 2, as the device
    // verified from its Commits.
    let begun =
        |group: &GroupId, epoch: u64| (*group == session).then_some(if epoch < 2 { 0 } else { 2 });
    let real = bytes_of(&[
        row(1, room_group(), 1, 11, true),
        row(2, room_group(), 2, 12, true),
        row(1, session, 1, 21, true),
        row(2, session, 2, 22, true),
    ]);
    let forged = bytes_of(&[
        // Room epoch 2 began under code 2: a row sealed to code 1 is not its row, whatever room epoch it names.
        forge(room_group(), 2, 2, true),
        forge(room_group(), 2, 1, true),
        forge(room_group(), 2, 0, false),
        // The session's epoch 2 began under room epoch 2: a row naming an older room epoch is not its row.
        forge(session, 2, 1, true),
        forge(session, 2, 2, true),
        forge(session, 2, 0, false),
        // A row for a room epoch the history does not hold.
        forge(room_group(), 40, 1, true),
    ]);
    let served = [forged.clone(), real.clone(), forged].concat();
    let found = select_keys(&ROOM, &served, &opened.openers, &history, &begun).unwrap();
    let keys_found: Vec<(u64, &Secret<32>, bool)> = found
        .iter()
        .map(|key| (key.epoch, &key.key, key.confirmed))
        .collect();
    assert_eq!(
        keys_found,
        vec![
            (1, &content_key(11), true),
            (2, &content_key(12), true),
            (1, &content_key(21), true),
            (2, &content_key(22), true),
        ]
    );
    // What the old code may still do: rows for the epochs of its own time, where it was the code. There its
    // second key stands against the real one, and the finding is named.
    let poisoned = [real, bytes_of(&[forge(session, 1, 1, true)])].concat();
    assert_eq!(
        select_keys(&ROOM, &poisoned, &opened.openers, &history, &begun),
        Err(Error::Equivocation)
    );
}

#[test]
fn only_the_code_in_force_replaces() {
    let history = history_of(&[1, 2]);
    assert_eq!(
        keys(1)
            .replace(&mut SystemEntropy, &ROOM, &history)
            .map(|_| ()),
        Err(Error::WrongRecovery)
    );
    assert!(keys(2).replace(&mut SystemEntropy, &ROOM, &history).is_ok());
}

#[test]
fn a_link_is_taken_only_with_its_mac_and_the_key_the_room_held_before() {
    let changes = key_changes(&history_of(&[1, 2, 3]));
    let good = [link(3, 2, &ROOM), link(2, 1, &ROOM)];
    let refused = |links: &[RecoveryLink], changes: &[KeyChange]| {
        open_links(&keys(3), &ROOM, &links_of(links), changes).map(|_| ())
    };
    assert_eq!(refused(&good, &changes), Ok(()));

    // A mac that does not verify under the new key's recovery_mac: flipped, or made under the old one.
    let mut flipped = good[0].clone();
    flipped.mac[0] ^= 1;
    assert_eq!(
        refused(&[flipped, good[1].clone()], &changes),
        Err(Error::WrongRecovery)
    );
    let mut under_old = good[0].clone();
    remac(&mut under_old, &mac_of(2));
    assert_eq!(refused(&[under_old], &changes), Err(Error::WrongRecovery));

    // An authenticated link that hands over another key than the room state held before that Commit.
    let stranger = link(3, 9, &ROOM);
    assert_eq!(
        refused(std::slice::from_ref(&stranger), &changes),
        Err(Error::WrongRecovery)
    );
    // Further back in the chain the same holds.
    assert_eq!(
        refused(&[good[0].clone(), link(2, 9, &ROOM)], &changes),
        Err(Error::WrongRecovery)
    );

    // A sealed part that does not open, or was made for another room, under a valid mac.
    let mut broken = good[0].clone();
    broken.sealed.ciphertext[3] ^= 1;
    remac(&mut broken, &mac_of(3));
    assert_eq!(refused(&[broken], &changes), Err(Error::WrongRecovery));
    let mut moved = link(3, 2, &RoomId::new([0x11; 32]));
    moved.room_id = ROOM;
    remac(&mut moved, &mac_of(3));
    assert_eq!(refused(&[moved], &changes), Err(Error::WrongRecovery));

    // A link for a key the room's state never took in by a Commit: the founding key has no predecessor.
    assert_eq!(
        open_links(&keys(1), &ROOM, &links_of(&[link(1, 9, &ROOM)]), &changes).map(|_| ()),
        Err(Error::WrongRecovery)
    );

    // Two authenticated links for one key that hand over different values.
    let mut second = good[0].clone();
    let other = OldRecovery {
        hpke_secret: expand_with_label(&code(2), "trommi recovery hpke", &[]).unwrap(),
        recovery_mac: mac_of(9),
    };
    second.sealed = encrypt_with_label(
        &mut SystemEntropy,
        &keys(3).public().hpke_key,
        "TrommiRecoveryLink",
        ROOM.as_bytes(),
        &codec::encode(&other).unwrap(),
    )
    .unwrap();
    remac(&mut second, &mac_of(3));
    assert_eq!(
        refused(&[good[0].clone(), second], &changes),
        Err(Error::Equivocation)
    );
    // The same link twice is one link.
    assert_eq!(
        refused(
            &[good[0].clone(), good[0].clone(), good[1].clone()],
            &changes
        ),
        Ok(())
    );
}

#[test]
fn a_withheld_link_closes_the_older_rows_and_is_named() {
    let changes = key_changes(&history_of(&[1, 2, 3]));
    let opened = open_links(&keys(3), &ROOM, &links_of(&[link(3, 2, &ROOM)]), &changes).unwrap();
    assert_eq!(opened.openers.len(), 2);
    assert_eq!(opened.missing_link, Some(keys(2).public().hpke_key));
    let opened = open_links(&keys(3), &ROOM, &[], &changes).unwrap();
    assert_eq!(opened.openers.len(), 1);
    assert_eq!(opened.missing_link, Some(keys(3).public().hpke_key));
}

#[test]
fn a_walk_that_comes_back_to_a_key_it_passed_is_refused() {
    // A history no room can have: the keys of code 1 replaced by those of code 2 and those again by code 1's.
    let (one, two) = (keys(1).public().hpke_key, keys(2).public().hpke_key);
    let changes = [
        KeyChange {
            epoch: 1,
            before: one,
            after: two,
        },
        KeyChange {
            epoch: 2,
            before: two,
            after: one,
        },
    ];
    let links = links_of(&[link(1, 2, &ROOM), link(2, 1, &ROOM)]);
    assert_eq!(
        open_links(&keys(1), &ROOM, &links, &changes).map(|_| ()),
        Err(Error::WrongRecovery)
    );
    // A key that replaced itself.
    let own = [KeyChange {
        epoch: 1,
        before: one,
        after: one,
    }];
    assert_eq!(
        open_links(&keys(1), &ROOM, &links_of(&[link(1, 1, &ROOM)]), &own).map(|_| ()),
        Err(Error::WrongRecovery)
    );
}

#[test]
fn a_link_decodes_strictly() {
    let encoded = link(2, 1, &ROOM).to_bytes().unwrap();
    assert_eq!(encoded.len(), recovery::MAX_RECOVERY_LINK_LEN);
    for cut in 0..encoded.len() {
        assert_eq!(
            RecoveryLink::from_bytes(&encoded[..cut]),
            Err(Error::BadFormat)
        );
    }
    let mut trailing = encoded.clone();
    trailing.push(0);
    assert_eq!(RecoveryLink::from_bytes(&trailing), Err(Error::BadFormat));
    // A link always carries a mac.
    let mut without = encoded[..encoded.len() - 33].to_vec();
    without.push(0);
    assert_eq!(RecoveryLink::from_bytes(&without), Err(Error::BadFormat));
}

// ---- 8.5: the agreement of a GroupInfo with the state reached, on a real room ----

struct Room {
    device: Device<MemoryStorage>,
    group: GroupId,
    /// Every epoch's GroupInfo and `SealedKey` as posted, and the Commit that led to it.
    infos: Vec<Vec<u8>>,
    rows: Vec<Vec<u8>>,
    commits: Vec<Vec<u8>>,
}

/// A room founded with the keys of `code_byte` by a device that holds its recovery_mac, moved on by `updates`
/// own-leaf updates. No hub: the outbox is read and every entry reported as accepted.
fn real_room(code_byte: u8, updates: usize) -> Room {
    let mut device = Device::create(MemoryStorage::new(), Box::new(SystemEntropy)).unwrap();
    let room = device.found_room(&keys(code_byte), now()).unwrap();
    let group = GroupId::room(room);
    let founding = device.outbox().pop().unwrap();
    device
        .outbox_accepted(founding.id, Accepted { change: Some(1) })
        .unwrap();
    let mut room = Room {
        device,
        group,
        infos: vec![founding.parts[0].clone()],
        rows: vec![founding.parts[1].clone()],
        commits: Vec::new(),
    };
    for _ in 0..updates {
        room.update();
    }
    room
}

impl Room {
    fn update(&mut self) {
        self.device.update(&self.group, true, now()).unwrap();
        let entry = self.device.outbox().pop().unwrap();
        let change = self.commits.len() as u64 + 2;
        self.device
            .outbox_accepted(
                entry.id,
                Accepted {
                    change: Some(change),
                },
            )
            .unwrap();
        self.commits.push(entry.parts[0].clone());
        self.infos.push(entry.parts[1].clone());
        self.rows.push(entry.parts[3].clone());
    }
}

fn follow(observer: &mut Observer, commit: &[u8]) -> Result<DeviceId, Error> {
    let context = Context {
        room: None,
        sessions: &NoSessions,
        recovery: &PublicRules,
        max_human_devices: MAX_HUMAN_DEVICES,
    };
    observer
        .process_commit(commit, None, &context)
        .map(|facts| facts.committer)
}

#[test]
fn a_real_devices_rows_anchor_the_room_and_its_group_infos_agree() {
    let room = real_room(1, 3);
    let keys = keys(1);
    let room_id = room.group.room_id();

    // Every row of the device is authenticated and opens to the content key the device holds.
    let found = select_keys(
        &room_id,
        &room.rows,
        &[keys.opener().unwrap()],
        room.device.room_history().unwrap(),
        &unverified,
    )
    .unwrap();
    assert_eq!(found.len(), 4);
    for key in &found {
        assert!(key.confirmed);
        assert_eq!(
            key.key,
            room.device.content_key(&room.group, key.epoch).unwrap()
        );
    }

    // The anchor is the newest epoch; its GroupInfo is the one posted.
    let anchor = select_anchor(&keys, &room_id, &room.rows).unwrap();
    assert_eq!(anchor.epoch, 3);
    assert_eq!(anchor.group_info, group_info_hash(&room.infos[3]).unwrap());
    let observer = follow_anchor(&anchor, &room.infos[3]).unwrap();
    keys.check_room(&observer.history().unwrap().newest().room)
        .unwrap();
    assert_eq!(
        check_agreement(&observer, None, &anchor, &room.infos[3]),
        Ok(())
    );
    // An older, once valid GroupInfo is not the anchor's.
    assert_eq!(
        follow_anchor(&anchor, &room.infos[2]).map(|_| ()),
        Err(Error::WrongRecovery)
    );
    assert_eq!(
        check_agreement(&observer, None, &anchor, &room.infos[2]),
        Err(Error::WrongRecovery)
    );
    assert_eq!(
        follow_anchor(&anchor, b"no group info").map(|_| ()),
        Err(Error::WrongRecovery)
    );
}

#[test]
fn beyond_the_anchor_only_the_state_reached_by_following_agrees() {
    let room = real_room(1, 4);
    let keys = keys(1);
    let room_id = room.group.room_id();
    let committer = room.device.id();

    // The hub withholds the rows of epochs 3 and 4: the anchor is epoch 2.
    let anchor = select_anchor(&keys, &room_id, &room.rows[..3]).unwrap();
    assert_eq!(anchor.epoch, 2);
    let mut observer = follow_anchor(&anchor, &room.infos[2]).unwrap();
    assert_eq!(follow(&mut observer, &room.commits[2]), Ok(committer));
    assert_eq!(follow(&mut observer, &room.commits[3]), Ok(committer));
    assert_eq!(observer.epoch(), Ok(4));

    assert_eq!(
        check_agreement(&observer, Some(&committer), &anchor, &room.infos[4]),
        Ok(())
    );
    // Older states, the anchor's own included, do not agree with the state reached.
    for older in [0, 2, 3] {
        assert_eq!(
            check_agreement(&observer, Some(&committer), &anchor, &room.infos[older]),
            Err(Error::WrongRecovery)
        );
    }
    // Signed by another device than the last Commit's committer; no committer known.
    assert_eq!(
        check_agreement(&observer, Some(&device(0xC1)), &anchor, &room.infos[4]),
        Err(Error::WrongRecovery)
    );
    assert_eq!(
        check_agreement(&observer, None, &anchor, &room.infos[4]),
        Err(Error::WrongRecovery)
    );
    assert_eq!(
        check_agreement(&observer, Some(&committer), &anchor, b"no group info"),
        Err(Error::WrongRecovery)
    );

    // A state before the anchor never agrees, whatever is offered.
    let later = select_anchor(&keys, &room_id, &room.rows).unwrap();
    assert_eq!(later.epoch, 4);
    let behind = follow_anchor(&anchor, &room.infos[2]).unwrap();
    assert_eq!(
        check_agreement(&behind, Some(&committer), &later, &room.infos[2]),
        Err(Error::WrongRecovery)
    );
    // An anchor of another group.
    let mut elsewhere = anchor;
    elsewhere.group = session_group(1);
    assert_eq!(
        check_agreement(&observer, Some(&committer), &elsewhere, &room.infos[4]),
        Err(Error::WrongRecovery)
    );
}

#[test]
fn a_room_of_the_hubs_own_making_is_not_the_codes_room() {
    let real = real_room(1, 1);
    let keys = keys(1);
    let room_id = real.group.room_id();
    let public = keys.public();

    // The hub knows the recovery public keys and founds a room of its own with them. It holds no
    // recovery_mac: the mac on its row is made with a key of its own.
    let hub_device = Forger::new();
    let fake_room = RoomId::new([0x77; 32]);
    let fake_group = hub_device.found_room(
        &GroupId::room(fake_room),
        &TrommiRoom {
            recovery_signature_key: public.signature_key,
            recovery_hpke_key: public.hpke_key,
            agents: Vec::new(),
        },
    );
    let fake_info = hub_device.group_info(&fake_group);
    let fake_row = SealedKey::seal(
        &mut SystemEntropy,
        &Sealing {
            context: KeyContext::of(&GroupId::room(fake_room), 0, &fake_info).unwrap(),
            room_epoch: 0,
            recovery_hpke_key: &public.hpke_key,
            writer: hub_device.id(),
            content_key: &content_key(9),
        },
        Some(&mac_of(9)),
    )
    .unwrap()
    .to_bytes()
    .unwrap();

    // Served alone, under its own room id: no anchor.
    assert_eq!(
        select_anchor(&keys, &fake_room, std::slice::from_ref(&fake_row)),
        Err(Error::WrongRecovery)
    );
    // Served beside the real rows, as the real room's current state: the anchor stays the real one, and the
    // fake GroupInfo neither is the anchor's nor agrees with what following the real room reaches.
    let mut served = real.rows.clone();
    served.push(fake_row);
    let anchor = select_anchor(&keys, &room_id, &served).unwrap();
    assert_eq!(anchor.epoch, 1);
    assert_eq!(
        follow_anchor(&anchor, &fake_info).map(|_| ()),
        Err(Error::WrongRecovery)
    );
    let observer = follow_anchor(&anchor, &real.infos[1]).unwrap();
    assert_eq!(
        check_agreement(&observer, Some(&hub_device.id()), &anchor, &fake_info),
        Err(Error::WrongRecovery)
    );
    // A row copied from the real room and renamed to the fake one loses its mac.
    let mut renamed = SealedKey::from_bytes(&real.rows[0]).unwrap();
    renamed.context.group = GroupId::room(fake_room);
    assert_eq!(
        select_anchor(&keys, &fake_room, &[renamed.to_bytes().unwrap()]),
        Err(Error::WrongRecovery)
    );
}

// ---- malformed input ----

/// A small deterministic generator, so that the damaged inputs are the same on every run.
struct Dice(u64);

impl Dice {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn damage(&mut self, bytes: &[u8]) -> Vec<u8> {
        let mut damaged = bytes.to_vec();
        match self.next() % 4 {
            0 if !damaged.is_empty() => {
                let at = (self.next() as usize) % damaged.len();
                damaged[at] ^= 1 << (self.next() % 8);
            }
            1 => damaged.truncate((self.next() as usize) % (damaged.len() + 1)),
            2 => damaged.extend((0..self.next() % 40).map(|at| at as u8)),
            _ => damaged = (0..self.next() % 400).map(|_| self.next() as u8).collect(),
        }
        damaged
    }
}

#[test]
fn malformed_input_is_refused_and_never_panics() {
    let mut dice = Dice(0x9E37_79B9_7F4A_7C15);
    let keys = keys(1);
    let openers = [keys.opener().unwrap()];
    let join = join();
    let note = join.note();
    let changes = key_changes(&history_of(&[9, 1]));
    let good_rows = bytes_of(&[
        row(1, room_group(), 0, 1, true),
        row(1, room_group(), 1, 2, false),
        row(1, session_group(1), 0, 3, true),
    ]);
    let good_link = link(1, 9, &ROOM).to_bytes().unwrap();
    let info = b"group info".to_vec();
    let writer = device(0xA1);
    let room = room_state(0, &[writer], 1);
    for _ in 0..3000 {
        let rows: Vec<Vec<u8>> = good_rows.iter().map(|row| dice.damage(row)).collect();
        for row in &rows {
            let decoded = SealedKey::from_bytes(row);
            if let Ok(decoded) = &decoded {
                assert_eq!(&decoded.to_bytes().unwrap(), row);
            }
            let claim = SealedKeyClaim {
                group: &join.group,
                epoch: 0,
                group_info: &info,
                room_epoch: 0,
                recovery_hpke_key: &[0; 32],
                writer: &writer,
                writer_is_human: true,
            };
            assert_eq!(
                PublicRules.verify_sealed_key(&claim, row),
                Err(Error::Incomplete)
            );
            let posted = PostedRow {
                poster: &writer,
                room_id: &ROOM,
                room: &room,
                group_info: Some(&info),
            };
            assert!(check_posted_row(row, &posted).is_err());
        }
        // Whatever is served, the selection ends in a result, and never in a key a damaged row carried.
        let _ = select_anchor(&keys, &ROOM, &rows);
        if let Ok(found) = select(&rows, &openers, &flat(1)) {
            for key in found {
                assert!(
                    key.key == content_key(1)
                        || key.key == content_key(2)
                        || key.key == content_key(3)
                );
            }
        }
        let _ = lists_authenticated(&rows, &room_group(), 0, &MacKeys::new());

        let link = dice.damage(&good_link);
        if let Ok(decoded) = RecoveryLink::from_bytes(&link) {
            assert_eq!(decoded.to_bytes().unwrap(), link);
        }
        if link != good_link {
            let opened = open_links(&keys, &ROOM, std::slice::from_ref(&link), &changes);
            assert!(opened.is_err() || opened.is_ok_and(|opened| opened.openers.len() == 1));
        }

        let auth = dice.damage(&join.auth);
        if let Ok(decoded) = RecoveryAuth::from_bytes(&auth) {
            assert_eq!(decoded.to_bytes().unwrap(), auth);
        }
        let claim = JoinClaim {
            group: &join.group,
            epoch: 6,
            joiner: &join.joiner,
            note: &note,
            commit: &join.commit,
            base_group_info: Some(&join.base),
            recovery_signature_key: &join.key,
            recovery_auth: Some(&auth),
        };
        assert_eq!(
            PublicRules.verify_join(&claim).is_ok(),
            auth == join.auth,
            "only the untouched RecoveryAuth authorises"
        );
        let _ = follow_anchor(&context(room_group(), 0), &auth);
    }
}
