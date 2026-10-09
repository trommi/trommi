//! What a device keeps beside its groups: the count of stroke pieces per epoch (7.2), and a stored state
//! whose parts contradict each other (13.4).

use trommi_core::device::{Processed, STROKE_PIECES_PER_EPOCH};
use trommi_core::ids::BoardId;
use trommi_core::store::OutboxKind;
use trommi_core::Error;
use trommi_tests::{
    add_human, found_room, new_device, new_device_on, now, post_ok, reopen, settle, sync_ok,
    MemoryStorage,
};

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
