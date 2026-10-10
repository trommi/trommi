//! An own Commit is merged at its place in the hub's order (5.4.1, 13.2), not when the hub answers: what the
//! hub ordered before it opens in the epoch it was made in. A lost answer, the log before the answer, a crash
//! between the two, a founding, and a hub whose answer and log disagree.

use trommi_core::device::{Accepted, Processed, Received};
use trommi_core::ids::GroupId;
use trommi_core::store::OutboxKind;
use trommi_core::Error;
use trommi_tests::hub::Hub;
use trommi_tests::{
    add_human, enrol, found_room, new_device, new_device_on, now, post_ok, process, publish_some,
    reopen, settle, sync_ok, MemoryStorage, TestDevice,
};

/// Two human devices in a room; the first one on a store the test can reopen.
fn pair() -> (Hub, TestDevice, TestDevice, GroupId, MemoryStorage) {
    let store = MemoryStorage::new();
    let handle = store.handle();
    let (mut a, mut b) = (new_device_on(store), new_device());
    let (mut hub, room_group) = found_room(&mut a);
    add_human(&mut hub, &mut a, &mut b);
    settle(&hub, &mut b);
    (hub, a, b, room_group, handle)
}

/// Posts the one entry of the outbox and returns its id and the hub's answer, which is not reported.
fn post_one(hub: &mut Hub, device: &TestDevice) -> (u64, Accepted) {
    let entry = device.outbox().remove(0);
    let accepted = hub.post(&device.id(), &entry).expect("the hub accepts");
    (entry.id, accepted)
}

#[test]
fn what_the_hub_ordered_before_an_accepted_commit_opens_in_its_own_epoch() {
    let (mut hub, mut a, mut b, room_group, _) = pair();
    let cursor = a.cursor();

    // The first device builds a Commit; before it reaches the hub, the second one's message of the same
    // epoch does.
    a.update(&room_group, true, now()).unwrap().unwrap();
    b.send_recovery_auth(&a.id()).unwrap().unwrap();
    post_ok(&mut hub, &mut b);
    let (id, accepted) = post_one(&mut hub, &a);
    assert_eq!(hub.epoch(&room_group), Some(2));

    // The answer is recorded and nothing is merged: the group stands in the old epoch for everything, the
    // cursor stays, and the device commits and sends nothing more in the group.
    a.outbox_accepted(id, accepted).unwrap();
    let summary = a.group(&room_group).unwrap();
    assert_eq!((summary.epoch, summary.pending), (1, true));
    assert_eq!(a.cursor(), cursor);
    assert!(a.outbox().is_empty());
    assert_eq!(a.content_key(&room_group, 2), Err(Error::NoKey));
    assert_eq!(a.update(&room_group, true, now()), Err(Error::Busy));
    assert_eq!(a.send_handover(&room_group, &b.id()), Err(Error::Busy));

    // The log: the message opens in its epoch, then the own Commit is merged at its place.
    let processed = sync_ok(&hub, &mut a);
    assert!(matches!(
        &processed[..],
        [
            Processed::Message(Received::RecoveryAuth { from, .. }),
            Processed::OwnCommit
        ] if *from == b.id()
    ));
    let summary = a.group(&room_group).unwrap();
    assert_eq!((summary.epoch, summary.pending), (2, false));
    assert_eq!(a.cursor(), hub.change());
    sync_ok(&hub, &mut b);
    assert_eq!(
        a.content_key(&room_group, 2).unwrap(),
        b.content_key(&room_group, 2).unwrap()
    );
    // It goes on in the new epoch.
    a.update(&room_group, true, now()).unwrap().unwrap();
    assert_eq!(a.outbox()[0].epoch, 2);
}

#[test]
fn the_log_may_show_the_own_commit_before_the_answer_is_reported() {
    let (mut hub, mut a, _, room_group, _) = pair();
    a.update(&room_group, true, now()).unwrap().unwrap();
    let (id, accepted) = post_one(&mut hub, &a);
    // The stream is faster than the answer: the Commit is merged where the log shows it, and its outbox
    // entry goes with it.
    assert_eq!(sync_ok(&hub, &mut a), [Processed::OwnCommit]);
    let summary = a.group(&room_group).unwrap();
    assert_eq!((summary.epoch, summary.pending), (2, false));
    assert!(a.outbox().is_empty());
    // The answer then finds nothing to record, and a repeated log entry is a duplicate.
    assert_eq!(a.outbox_accepted(id, accepted), Err(Error::NotFound));
    assert_eq!(
        process(&mut a, hub.log.last().unwrap()),
        Err(Error::WrongEpoch)
    );
    assert_eq!(a.group(&room_group).unwrap().epoch, 2);
}

#[test]
fn a_crash_between_the_answer_and_the_log_loses_nothing() {
    let (mut hub, mut a, mut b, room_group, handle) = pair();
    a.update(&room_group, true, now()).unwrap().unwrap();
    b.send_recovery_auth(&a.id()).unwrap().unwrap();
    post_ok(&mut hub, &mut b);
    let (id, accepted) = post_one(&mut hub, &a);
    // A lost answer: the same bytes again get the same answer, and the hub's log holds the Commit once.
    let entry = a.outbox().remove(0);
    assert_eq!(hub.post(&a.id(), &entry), Ok(accepted));
    a.outbox_accepted(id, accepted).unwrap();
    drop(a);

    // What a restart finds: the Commit accepted and still to be merged, nothing to send.
    let mut a = reopen(handle.reopened()).unwrap();
    let summary = a.group(&room_group).unwrap();
    assert_eq!((summary.epoch, summary.pending), (1, true));
    assert!(a.outbox().is_empty());
    assert_eq!(a.update(&room_group, true, now()), Err(Error::Busy));
    let processed = sync_ok(&hub, &mut a);
    assert!(matches!(
        &processed[..],
        [
            Processed::Message(Received::RecoveryAuth { .. }),
            Processed::OwnCommit
        ]
    ));
    sync_ok(&hub, &mut b);
    assert_eq!(
        a.content_key(&room_group, 2).unwrap(),
        b.content_key(&room_group, 2).unwrap()
    );
}

#[test]
fn a_foundings_first_commit_is_merged_where_the_log_shows_it() {
    let (mut hub, mut a, mut b, _, handle) = pair();
    publish_some(&mut hub, &mut b, 2);

    for answer_first in [true, false] {
        let mut agent = new_device();
        enrol(&mut hub, &mut a, &mut agent);
        publish_some(&mut hub, &mut agent, 1);
        settle(&hub, &mut b);
        let packages = hub.claim(&[b.id(), agent.id()]).unwrap();
        let session = a.found_session(&agent.id(), &packages, now()).unwrap();
        let group = GroupId::session(a.room().unwrap(), session);
        let entry = a.outbox().remove(0);
        assert_eq!(entry.kind, OutboxKind::GroupFounding);
        let accepted = hub.post(&a.id(), &entry).unwrap();
        if answer_first {
            // The hub took the founding: the group exists, and its first Commit waits for its place.
            a.outbox_accepted(entry.id, accepted).unwrap();
            let summary = a.group(&group).unwrap();
            assert_eq!((summary.epoch, summary.pending), (0, true));
            assert_eq!(summary.leaves.len(), 1);
            assert_eq!(a.update(&group, true, now()), Err(Error::Busy));
            assert_eq!(a.send_handover(&group, &agent.id()), Err(Error::Busy));
            // A restart changes nothing of it.
            drop(a);
            a = reopen(handle.reopened()).unwrap();
            assert!(a.group(&group).unwrap().pending);
        }
        assert_eq!(sync_ok(&hub, &mut a), [Processed::OwnCommit]);
        if !answer_first {
            assert_eq!(a.outbox_accepted(entry.id, accepted), Err(Error::NotFound));
        }
        let summary = a.group(&group).unwrap();
        assert_eq!((summary.epoch, summary.pending), (1, false));
        assert_eq!(summary.leaves.len(), 3);
        settle(&hub, &mut b);
        assert_eq!(
            a.content_key(&group, 1).unwrap(),
            b.content_key(&group, 1).unwrap()
        );
        // The founder goes on in the group.
        a.update(&group, true, now()).unwrap().unwrap();
        post_ok(&mut hub, &mut a);
        assert_eq!(a.group(&group).unwrap().epoch, 2);
        settle(&hub, &mut b);
    }
}

#[test]
fn the_log_decides_against_an_answer_that_said_accepted() {
    let (mut hub, mut a, mut b, room_group, _) = pair();
    // Both build a Commit for the epoch; the hub takes the second device's. A faulty hub tells the first
    // one that its own was accepted.
    let id = a.update(&room_group, true, now()).unwrap().unwrap();
    let lost = a.outbox()[0].parts[0].clone();
    b.update(&room_group, true, now()).unwrap().unwrap();
    post_ok(&mut hub, &mut b);
    a.outbox_accepted(
        id,
        Accepted {
            change: Some(hub.change()),
        },
    )
    .unwrap();
    assert!(a.group(&room_group).unwrap().pending);

    // The log shows the Commit that took the epoch: it is what every member follows. The own one goes.
    let processed = sync_ok(&hub, &mut a);
    assert!(matches!(
        &processed[..],
        [Processed::Commit { facts, superseded: Some(superseded), removed: false }]
            if facts.committer == b.id() && *superseded == id
    ));
    let summary = a.group(&room_group).unwrap();
    assert_eq!((summary.epoch, summary.pending), (2, false));
    assert_eq!(
        a.content_key(&room_group, 2).unwrap(),
        b.content_key(&room_group, 2).unwrap()
    );
    assert!(hub.log.iter().all(|item| item.bytes != lost));
    // Built again, the change is taken.
    a.update(&room_group, true, now()).unwrap().unwrap();
    post_ok(&mut hub, &mut a);
    sync_ok(&hub, &mut b);
    assert_eq!(
        a.content_key(&room_group, 3).unwrap(),
        b.content_key(&room_group, 3).unwrap()
    );
}
