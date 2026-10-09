//! What a device keeps beside its groups: the count of stroke pieces per epoch (7.2), and a stored state
//! whose parts contradict each other (13.4).

use std::collections::BTreeMap;
use trommi_core::device::{Processed, STROKE_PIECES_PER_EPOCH};
use trommi_core::ids::{BoardId, GroupId, RoomId};
use trommi_core::store::{table, Batch, OutboxKind, Storage};
use trommi_core::Error;
use trommi_tests::{
    add_human, found_room, new_device, new_device_on, now, post_ok, reopen, settle, sync_ok,
    MemoryStorage,
};

type Entries = BTreeMap<Vec<u8>, Vec<u8>>;

fn snapshot(store: &MemoryStorage) -> Entries {
    store
        .entries()
        .into_iter()
        .map(|entry| (entry.key.clone(), entry.value.clone()))
        .collect()
}

/// A store that holds `entries`.
fn store_of(entries: &Entries) -> MemoryStorage {
    let mut store = MemoryStorage::new();
    let mut batch = Batch::new();
    for (key, value) in entries {
        batch.put(key.clone(), value.clone());
    }
    store.apply(0, batch).unwrap();
    store
}

/// `base` with every entry under `prefix` taken from `other` instead.
fn mixed(base: &Entries, other: &Entries, prefix: &[u8]) -> Entries {
    let under = |entries: &Entries| -> Entries {
        entries
            .iter()
            .filter(|(key, _)| key.starts_with(prefix))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect()
    };
    let mut mixed: Entries = base
        .iter()
        .filter(|(key, _)| !key.starts_with(prefix))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    mixed.extend(under(other));
    mixed
}

fn content_key_key(group: &GroupId, epoch: u64) -> Vec<u8> {
    let group = group.as_bytes();
    [
        &[table::CONTENT_KEY, group.len() as u8][..],
        group,
        &epoch.to_be_bytes(),
    ]
    .concat()
}

#[test]
fn a_stored_state_whose_parts_contradict_each_other_does_not_open() {
    const SEED: &[u8] = &[table::DEVICE, 0];
    const RECORD: &[u8] = &[table::DEVICE, 1];
    const GROUPS: &[u8] = &[table::DEVICE, 2];
    let store = MemoryStorage::new();
    let handle = store.handle();
    let (mut a, mut b) = (new_device_on(store), new_device());
    let (mut hub, room_group) = found_room(&mut a);
    add_human(&mut hub, &mut a, &mut b);
    settle(&hub, &mut b);

    // Four states of one device: idle, with a Commit pending, with that Commit accepted, with it merged.
    let idle = snapshot(&handle);
    a.update(&room_group, true, now()).unwrap().unwrap();
    let pending = snapshot(&handle);
    let entry = a.outbox().remove(0);
    let accepted = hub.post(&a.id(), &entry).unwrap();
    a.outbox_accepted(entry.id, accepted).unwrap();
    let waiting = snapshot(&handle);
    sync_ok(&hub, &mut a);
    let merged = snapshot(&handle);
    let epoch = a.group(&room_group).unwrap().epoch;
    for whole in [&idle, &pending, &waiting, &merged] {
        let device = reopen(store_of(whole)).unwrap();
        assert_eq!(device.id(), a.id());
    }

    let other = MemoryStorage::new();
    let stranger = new_device_on(other.handle());
    let mut beyond = merged.clone();
    beyond.insert(content_key_key(&room_group, epoch + 3), vec![7; 32]);
    let mut elsewhere = merged.clone();
    let foreign = GroupId::room(RoomId::new([9; 32]));
    elsewhere.insert(content_key_key(&foreign, 0), vec![7; 32]);
    let contradictions: Vec<(&str, Entries)> = vec![
        (
            "another device's signature key",
            mixed(&merged, &snapshot(&other), SEED),
        ),
        (
            "a group record with a pending Commit that OpenMLS does not hold",
            mixed(&merged, &pending, GROUPS),
        ),
        (
            "a pending Commit that the group record does not know",
            mixed(&pending, &idle, GROUPS),
        ),
        (
            "an accepted Commit whose outbox entry is still there",
            mixed(&pending, &waiting, GROUPS),
        ),
        (
            "a Commit that waits for the hub without its outbox entry",
            mixed(&waiting, &pending, GROUPS),
        ),
        (
            "OpenMLS's state of an earlier epoch",
            mixed(&merged, &idle, &[table::MLS]),
        ),
        (
            "the room's roles of an earlier epoch",
            mixed(&merged, &idle, &[table::ROOM_STATE]),
        ),
        (
            "an outbox entry with an id not yet given out",
            mixed(&idle, &pending, &[table::OUTBOX]),
        ),
        (
            "a cursor behind the group's place",
            mixed(&merged, &idle, RECORD),
        ),
        ("a content key beyond the group's epoch", beyond),
        ("a content key of another room", elsewhere),
    ];
    for (name, entries) in contradictions {
        match reopen(store_of(&entries)) {
            Err(Error::Storage(_)) => {}
            other => panic!("{name}: {:?}", other.map(|device| device.id())),
        }
    }
    drop(stranger);
}

#[test]
fn after_five_thousand_stroke_pieces_in_an_epoch_the_sender_updates() {
    let store = MemoryStorage::new();
    let mut handle = store.handle();
    let (mut a, mut b) = (new_device_on(store), new_device());
    let (mut hub, room_group) = found_room(&mut a);
    add_human(&mut hub, &mut a, &mut b);
    settle(&hub, &mut b);
    let board = BoardId::new([4; 16]);
    assert_eq!(a.update(&room_group, false, now()), Ok(None));
    let stored = hub.log.len();

    // The pieces are relayed and never stored; each is counted in the write that holds it.
    for sent in 1..=STROKE_PIECES_PER_EPOCH {
        let id = a.send_stroke_piece(&board, b"{}").unwrap();
        let entry = a.outbox().pop().unwrap();
        assert_eq!((entry.id, entry.kind), (id, OutboxKind::RelayMessage));
        a.outbox_accepted(id, hub.post(&a.id(), &entry).unwrap())
            .unwrap();
        if sent == 2 {
            // The count is stored: a restart does not begin it again.
            drop(a);
            let store = handle.reopened();
            handle = store.handle();
            a = reopen(store).unwrap();
        }
    }
    assert_eq!(hub.relayed.len() as u64, STROKE_PIECES_PER_EPOCH);
    assert_eq!(hub.log.len(), stored);

    // The next piece is refused: the sender commits an update first, which is due now without being forced.
    assert_eq!(a.send_stroke_piece(&board, b"{}"), Err(Error::EpochFull));
    assert!(a.outbox().is_empty());
    drop(a);
    let mut a = reopen(handle.reopened()).unwrap();
    assert_eq!(a.send_stroke_piece(&board, b"{}"), Err(Error::EpochFull));
    let epoch = a.group(&room_group).unwrap().epoch;
    a.update(&room_group, false, now()).unwrap().unwrap();
    // Until that Commit is merged the epoch is the full one.
    assert_eq!(a.send_stroke_piece(&board, b"{}"), Err(Error::EpochFull));
    post_ok(&mut hub, &mut a);
    assert_eq!(a.group(&room_group).unwrap().epoch, epoch + 1);
    // In the new epoch it draws on, and no further update is due.
    a.send_stroke_piece(&board, b"{}").unwrap();
    post_ok(&mut hub, &mut a);
    assert_eq!(a.update(&room_group, false, now()), Ok(None));

    // Another device's Commit begins an epoch too: the count is per epoch.
    sync_ok(&hub, &mut b);
    for _ in 0..3 {
        b.send_stroke_piece(&board, b"{}").unwrap();
        post_ok(&mut hub, &mut b);
    }
    a.update(&room_group, true, now()).unwrap().unwrap();
    post_ok(&mut hub, &mut a);
    assert!(matches!(
        &sync_ok(&hub, &mut b)[..],
        [Processed::Commit { .. }]
    ));
    assert_eq!(b.update(&room_group, false, now()), Ok(None));
}
