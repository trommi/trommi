//! `spec/vectors/recovery.json` read back through the core's public interface: what the file says is what the
//! core derives, opens, accepts and refuses.

use serde_json::Value;
use trommi_core::crypto::Secret;
use trommi_core::ids::{DeviceId, GroupId, Hash32, RoomId};
use trommi_core::mls::observer::{Context, NoSessions, Observer, PostedCommit};
use trommi_core::mls::profile::{Cut, GroupKind, MAX_HUMAN_DEVICES_IN_RECOVERY};
use trommi_core::mls::rules::{CommitFacts, ContextChange};
use trommi_core::recovery::{
    check_room, commit_hash, group_info_hash, key_changes, open_links, MacState, PublicRules,
    RecoveryAuth, RecoveryKeys, RecoveryLink, SealedKey, ServedCommit, ServedGroup, ServedRoom,
};
use trommi_core::Error;
use trommi_tests::vectors::{read, recovery, unhex};

fn bytes(value: &Value) -> Vec<u8> {
    unhex(value.as_str().expect("hex text")).expect("hex")
}

fn array<const N: usize>(value: &Value) -> [u8; N] {
    bytes(value).try_into().expect("the length")
}

fn keys(value: &Value) -> RecoveryKeys {
    RecoveryKeys::from_code(Secret::new(array(&value["code"]))).unwrap()
}

/// What the file says a hub served, checked by `keys`: the room's public state at the current GroupInfo.
fn checked(served: &Value, keys: &RecoveryKeys) -> Result<Observer, Error> {
    let list = |name: &str| -> Vec<Vec<u8>> {
        served[name].as_array().unwrap().iter().map(bytes).collect()
    };
    let commits: Vec<(Vec<u8>, Option<Vec<u8>>)> = served["commits"]
        .as_array()
        .unwrap()
        .iter()
        .map(|commit| {
            let auth = &commit["recovery_auth"];
            (
                bytes(&commit["commit"]),
                (!auth.is_null()).then(|| bytes(auth)),
            )
        })
        .collect();
    let commits: Vec<ServedCommit<'_>> = commits
        .iter()
        .map(|(commit, recovery_auth)| ServedCommit {
            commit,
            recovery_auth: recovery_auth.as_deref(),
        })
        .collect();
    let (founding, current, anchor) = (
        bytes(&served["founding_group_info"]),
        bytes(&served["current_group_info"]),
        bytes(&served["anchor_group_info"]),
    );
    let (rows, links) = (list("rows"), list("links"));
    check_room(
        keys,
        &ServedRoom {
            room: RoomId::new(array(&served["room_id"])),
            group: ServedGroup {
                founding: &founding,
                commits: &commits,
                current: &current,
            },
            anchor: &anchor,
            rows: &rows,
            links: &links,
            sessions: &[],
        },
    )
    .map(|checked| checked.observer)
}

/// The hub's check of a posted Commit of the file against the public state `observer`.
fn posted(observer: &mut Observer, request: &Value, base: &[u8]) -> Result<CommitFacts, Error> {
    let part = |name: &str| {
        request
            .get(name)
            .filter(|part| !part.is_null())
            .map(bytes)
            .filter(|part| !part.is_empty())
    };
    let (commit, group_info, sealed_key) = (
        part("commit").unwrap(),
        part("group_info").unwrap(),
        part("sealed_key").unwrap(),
    );
    let (welcome, recovery_auth) = (part("welcome"), part("recovery_auth"));
    observer.check_posted_commit(
        &PostedCommit {
            commit: &commit,
            group_info: &group_info,
            welcome: welcome.as_deref(),
            sealed_key: &sealed_key,
            recovery_auth: recovery_auth.as_deref(),
            base_group_info: Some(base),
        },
        &Context {
            room: None,
            sessions: &NoSessions,
            recovery: &PublicRules,
            max_human_devices: MAX_HUMAN_DEVICES_IN_RECOVERY,
        },
    )
}

#[test]
fn the_keys_follow_from_the_code() {
    let file = read(recovery::NAME).unwrap();
    for value in [&file["keys"], &file["recovery"]["new_code"]] {
        let keys = keys(value);
        let public = keys.public();
        assert_eq!(
            public.signature_key,
            array(&value["recovery_signature_key"])
        );
        assert_eq!(public.hpke_key, array(&value["recovery_hpke_key"]));
        assert_eq!(keys.signing_key().public(), public.signature_key);
        let mac = keys.finish();
        assert_eq!(mac.key, Secret::new(array(&value["recovery_mac"])));
        assert_eq!(mac.recovery_hpke_key, public.hpke_key);
    }
    assert_eq!(file["now"], recovery::NOW);
}

#[test]
fn the_sealed_key_opens_to_its_content_key() {
    let file = read(recovery::NAME).unwrap();
    let keys = keys(&file["keys"]);
    let value = &file["sealed_key"];
    let row = SealedKey::from_bytes(&bytes(&value["sealed_key"])).unwrap();
    assert_eq!(row.to_bytes().unwrap(), bytes(&value["sealed_key"]));
    assert_eq!(
        row.context.group,
        GroupId::from_bytes(&bytes(&value["group_id"])).unwrap()
    );
    assert_eq!(row.context.epoch, value["epoch"].as_u64().unwrap());
    assert_eq!(
        row.context.group_info,
        group_info_hash(&bytes(&value["group_info"])).unwrap()
    );
    assert_eq!(
        row.context.group_info,
        Hash32::new(array(&value["group_info_hash"]))
    );
    assert_eq!(row.room_epoch, value["room_epoch"].as_u64().unwrap());
    assert_eq!(row.recovery_hpke_key, keys.public().hpke_key);
    assert_eq!(row.writer, DeviceId::new(array(&value["writer"])));
    assert_eq!(row.mac, Some(array(&value["mac"])));
    assert_eq!(row.mac_state(&keys.mac_key().key).unwrap(), MacState::Valid);
    assert_eq!(
        row.open(&keys.opener().unwrap()).unwrap(),
        Secret::new(array(&value["content_key"]))
    );
}

#[test]
fn the_join_with_the_code_is_taken_and_the_one_with_a_wrong_signature_refused() {
    let file = read(recovery::NAME).unwrap();
    let keys = keys(&file["keys"]);
    let join = &file["join"];
    let request = &join["request"];
    let mut observer = checked(&join["served"], &keys).unwrap();
    let base = bytes(&join["served"]["current_group_info"]);

    // The RecoveryAuth says what the file says, about the Commit as posted.
    let auth = RecoveryAuth::from_bytes(&bytes(&request["recovery_auth"])).unwrap();
    let fields = &join["recovery_auth"];
    let joiner = DeviceId::new(array(&join["joiner"]));
    assert_eq!(auth.join.joiner, joiner);
    assert_eq!(auth.join.base.group_info, group_info_hash(&base).unwrap());
    assert_eq!(auth.join.base.epoch, fields["base_epoch"].as_u64().unwrap());
    assert_eq!(auth.join.room_epoch, fields["room_epoch"].as_u64().unwrap());
    assert_eq!(
        auth.join.room_state,
        Hash32::new(array(&fields["room_state"]))
    );
    assert_eq!(
        auth.commit,
        commit_hash(&bytes(&request["commit"])).unwrap()
    );
    assert_eq!(auth.signature, array::<64>(&fields["signature"]));

    // A hub that followed the room takes the request; with another GroupInfo as its base it does not.
    let mut other = observer.fork().unwrap();
    assert_eq!(
        posted(
            &mut other,
            request,
            &bytes(&join["served"]["founding_group_info"])
        )
        .err(),
        Some(Error::BadCommit)
    );
    let facts = posted(&mut observer, request, &base).unwrap();
    assert!(facts.external && facts.committer == joiner);
    assert_eq!(facts.epoch, request["epoch"].as_u64().unwrap());
    // The row beside it opens to the key of the epoch the join led to.
    let row = SealedKey::from_bytes(&bytes(&request["sealed_key"])).unwrap();
    assert_eq!(
        row.open(&keys.opener().unwrap()).unwrap(),
        Secret::new(array(&join["content_key"]))
    );

    // The join whose RecoveryAuth another code's key signed.
    let wrong = &file["wrong_signature"];
    assert_eq!(wrong["error"], "bad-signature");
    let mut observer = checked(&wrong["served"], &keys).unwrap();
    let base = bytes(&wrong["served"]["current_group_info"]);
    assert_eq!(
        posted(&mut observer, &wrong["request"], &base).err(),
        Some(Error::BadSignature)
    );
    assert_ne!(
        array::<32>(&wrong["signed_with"]),
        keys.public().signature_key
    );
}

#[test]
fn the_recovery_removes_with_its_cuts_and_links_the_new_code_to_the_old() {
    let file = read(recovery::NAME).unwrap();
    let keys = keys(&file["keys"]);
    let recovery = &file["recovery"];
    let new = self::keys(&recovery["new_code"]);
    let device = DeviceId::new(array(&recovery["device"]));
    let mut observer = checked(&recovery["served"], &keys).unwrap();
    let old_key = observer.history().unwrap().newest().room.recovery_hpke_key;
    let room = RoomId::new(array(&recovery["served"]["room_id"]));

    // The join, then the Commit that removes every other human device with its Cut and brings the new keys.
    let commits = recovery["commits"].as_array().unwrap();
    assert_eq!(commits.len(), 2);
    let base = bytes(&recovery["served"]["current_group_info"]);
    let join = posted(&mut observer, &commits[0], &base).unwrap();
    assert!(join.external && join.committer == device);
    let base = bytes(&commits[0]["group_info"]);
    let clean = posted(&mut observer, &commits[1], &base).unwrap();
    let cuts: Vec<Cut> = recovery["cuts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|cut| Cut {
            device: DeviceId::new(array(&cut["device"])),
            seq: cut["seq"].as_u64().unwrap(),
            hash: Hash32::new(array(&cut["hash"])),
        })
        .collect();
    assert!(!cuts.is_empty() && cuts.iter().all(|cut| cut.seq > 0));
    assert_eq!(clean.note.as_ref().unwrap().cuts, cuts);
    assert_eq!(
        clean.removes,
        cuts.iter().map(|cut| cut.device).collect::<Vec<_>>()
    );
    let ContextChange::To(GroupKind::Room(state)) = &clean.context else {
        panic!("the Commit replaces the recovery keys");
    };
    assert_eq!(new.check_room(state), Ok(()));
    let history = observer.history().unwrap();
    assert_eq!(history.newest().humans, [device].into_iter().collect());
    assert_eq!(
        history.newest().epoch,
        recovery["room_epoch"].as_u64().unwrap()
    );

    // Its row is sealed to the new key under the new room epoch, with the new mac.
    let row = SealedKey::from_bytes(&bytes(&commits[1]["sealed_key"])).unwrap();
    assert_eq!(row.room_epoch, history.newest().epoch);
    assert_eq!(row.mac_state(&new.mac_key().key).unwrap(), MacState::Valid);
    assert_eq!(
        row.open(&new.opener().unwrap()).unwrap(),
        Secret::new(array(&recovery["content_key"]))
    );

    // The link: authenticated under the new recovery_mac, it hands over the old key and its recovery_mac.
    let link_bytes = bytes(&recovery["finish"]["recovery_link"]);
    assert_eq!(link_bytes, bytes(&recovery["recovery_link"]["link"]));
    let link = RecoveryLink::from_bytes(&link_bytes).unwrap();
    assert_eq!(link.room_id, room);
    assert_eq!(link.new_recovery_hpke_key, new.public().hpke_key);
    assert_eq!(link.mac, array::<32>(&recovery["recovery_link"]["mac"]));
    let opened = open_links(&new, &room, &[link_bytes], &key_changes(history)).unwrap();
    assert_eq!(opened.missing_link, None);
    assert_eq!(opened.openers.len(), 2);
    assert_eq!(opened.openers[1].recovery_hpke_key(), &old_key);
    assert_eq!(opened.openers[1].mac_key().key, keys.mac_key().key);
    // With it the new code opens the rows of the old one.
    let founding = SealedKey::from_bytes(&bytes(&file["sealed_key"]["sealed_key"])).unwrap();
    assert_eq!(
        founding.open(&opened.openers[1]).unwrap(),
        Secret::new(array(&file["sealed_key"]["content_key"]))
    );
    assert!(!bytes(&recovery["finish"]["account"]).is_empty());
}
