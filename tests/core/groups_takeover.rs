//! Takeover (5.3): a main session's agent device is replaced in one Commit, with or without the session's
//! history; the old device is revoked for good; a session may wait with an empty seat.

use trommi_core::device::{Processed, Received};
use trommi_core::ids::{GroupId, TurnId};
use trommi_core::mls::profile::Cut;
use trommi_core::mls::rules::Parent;
use trommi_core::Error;
use trommi_tests::hub::Hub;
use trommi_tests::{
    add_human, cuts_for, enrol, found_main, found_room, new_device, now, observe, post_ok,
    post_refused, publish_some, settle, sync_ok, TestDevice,
};

struct Room {
    hub: Hub,
    a: TestDevice,
    b: TestDevice,
    /// The session's first agent device.
    old: TestDevice,
    room_group: GroupId,
    group: GroupId,
}

/// Two human devices and a main session that stands in epoch 3.
fn room() -> Room {
    let (mut a, mut b, mut old) = (new_device(), new_device(), new_device());
    let (mut hub, room_group) = found_room(&mut a);
    add_human(&mut hub, &mut a, &mut b);
    enrol(&mut hub, &mut a, &mut old);
    publish_some(&mut hub, &mut b, 1);
    publish_some(&mut hub, &mut old, 1);
    let group = found_main(&mut hub, &mut a, &old.id());
    for _ in 0..2 {
        a.update(&group, true, now()).unwrap().unwrap();
        post_ok(&mut hub, &mut a);
    }
    settle(&hub, &mut b);
    settle(&hub, &mut old);
    assert_eq!(hub.epoch(&group), Some(3));
    Room {
        hub,
        a,
        b,
        old,
        room_group,
        group,
    }
}

/// The new agent device takes the session over: Remove of the old leaf and Add of the new one.
fn take_over(hub: &mut Hub, human: &mut TestDevice, new: &mut TestDevice, group: &GroupId) {
    let package = new.key_package(now()).unwrap();
    let cuts = cuts_for(human, group);
    human
        .clean_session(group, &cuts, Some((&new.id(), &package)), now())
        .unwrap();
    post_ok(hub, human);
}

#[test]
fn a_takeover_with_history_is_one_commit_and_a_handover() {
    let Room {
        mut hub,
        mut a,
        mut b,
        mut old,
        room_group,
        group,
    } = room();
    let mut new = new_device();

    // (a) One room Commit takes the old device out of `agents` and enrols the new one.
    a.change_agents(&[new.id()], &[old.id()], now()).unwrap();
    post_ok(&mut hub, &mut a);
    observe(&hub, &mut new);
    let roles = hub.history().unwrap();
    assert_eq!(roles.newest().room.agents, [new.id()]);
    assert!(roles.is_revoked(&old.id(), roles.newest().epoch));
    // The main session is stale from that Commit on.
    assert_eq!(hub.stale_leaves(&group).unwrap(), [old.id()]);
    assert_eq!(a.group(&group).unwrap().disallowed, [old.id()]);
    assert_eq!(a.update(&group, true, now()), Err(Error::StaleSession));

    // (b) Remove of the old leaf and Add of the new device are one Commit of the session group.
    let log_before = hub.log.len();
    take_over(&mut hub, &mut a, &mut new, &group);
    assert_eq!(hub.log.len(), log_before + 1);
    assert_eq!(hub.epoch(&group), Some(4));
    assert!(hub.stale_leaves(&group).unwrap().is_empty());
    assert_eq!(
        hub.observer(&group).unwrap().seat_at(u64::MAX),
        Parent::Seat(Some(new.id()))
    );
    let processed = sync_ok(&hub, &mut b);
    let [Processed::Commit { .. }, Processed::Commit { facts, removed, .. }] = &processed[..]
    else {
        panic!("the room Commit and the takeover: {processed:?}");
    };
    assert_eq!((facts.epoch, *removed), (3, false));
    assert_eq!(facts.removes, [old.id()]);
    assert_eq!(facts.adds, [new.id()]);
    assert_eq!(facts.note.as_ref().unwrap().cuts, [Cut::none(old.id())]);
    assert_eq!(
        b.group(&group).unwrap().leaves,
        [a.id(), b.id(), new.id()].into_iter().collect()
    );

    // The new device joins and holds the key of the new epoch only.
    settle(&hub, &mut new);
    assert_eq!(new.group(&group).unwrap().epoch, 4);
    assert_eq!(
        new.content_key(&group, 4).unwrap(),
        a.content_key(&group, 4).unwrap()
    );
    for epoch in 0..4 {
        assert_eq!(new.content_key(&group, epoch), Err(Error::NoKey));
    }

    // With history: the key handover of 7.1 in that group, and the new device reads the old epochs.
    a.send_handover(&group, &new.id()).unwrap();
    post_ok(&mut hub, &mut a);
    assert_eq!(
        settle(&hub, &mut new),
        [Processed::Message(Received::Keys {
            from: a.id(),
            taken: 4,
            last: true
        })]
    );
    for epoch in 0..4 {
        assert_eq!(
            new.content_key(&group, epoch).unwrap(),
            a.content_key(&group, epoch).unwrap()
        );
    }
    // It was handed no key of the room group (5.3.4).
    for epoch in 0..=hub.epoch(&room_group).unwrap() {
        assert_eq!(new.content_key(&room_group, epoch), Err(Error::NoKey));
    }
    // The other leaves read the handover and take nothing from it.
    assert_eq!(
        sync_ok(&hub, &mut b),
        [Processed::Message(Received::Dropped)]
    );

    // The old device learns it from the Commit: it is out and derives no key of the new epoch.
    let processed = settle(&hub, &mut old);
    assert!(matches!(
        &processed[..],
        [
            Processed::Observed(_),
            Processed::Commit { removed: true, .. },
            Processed::Skipped
        ]
    ));
    assert_eq!(old.content_key(&group, 4), Err(Error::NoKey));
    assert_eq!(
        old.content_key(&group, 3).unwrap(),
        a.content_key(&group, 3).unwrap()
    );
    assert!(old.groups().unwrap().is_empty());

    // The new device is the session's agent: its work trail is taken.
    let turn = TurnId::new([1; 16]);
    new.send_work_trail(&group, &turn, 1, b"{}", now()).unwrap();
    post_ok(&mut hub, &mut new);
    assert!(matches!(
        &sync_ok(&hub, &mut a)[..],
        [Processed::Message(Received::WorkTrail { from, number: 1, .. })] if *from == new.id()
    ));
}

#[test]
fn a_takeover_without_history_hands_over_nothing_until_asked() {
    let Room {
        mut hub,
        mut a,
        mut old,
        group,
        ..
    } = room();
    let mut new = new_device();
    // Two room Commits this time: the new device is enrolled first, the old one removed later.
    enrol(&mut hub, &mut a, &mut new);
    assert!(hub.stale_leaves(&group).unwrap().is_empty());
    a.change_agents(&[], &[old.id()], now()).unwrap();
    post_ok(&mut hub, &mut a);
    assert_eq!(hub.stale_leaves(&group).unwrap(), [old.id()]);
    take_over(&mut hub, &mut a, &mut new, &group);
    settle(&hub, &mut new);
    settle(&hub, &mut old);

    // Without history the new device reads from its joining on.
    a.update(&group, true, now()).unwrap().unwrap();
    post_ok(&mut hub, &mut a);
    settle(&hub, &mut new);
    for epoch in 0..4 {
        assert_eq!(new.content_key(&group, epoch), Err(Error::NoKey));
    }
    for epoch in 4..=5 {
        assert_eq!(
            new.content_key(&group, epoch).unwrap(),
            a.content_key(&group, epoch).unwrap()
        );
        assert_eq!(old.content_key(&group, epoch), Err(Error::NoKey));
    }
    assert!(a.handovers_sent().is_empty());

    // The human device may send the handover later: the four epochs before the takeover are new to it.
    a.send_handover(&group, &new.id()).unwrap();
    post_ok(&mut hub, &mut a);
    assert_eq!(
        settle(&hub, &mut new),
        [Processed::Message(Received::Keys {
            from: a.id(),
            taken: 4,
            last: true
        })]
    );
    assert_eq!(
        new.content_key(&group, 0).unwrap(),
        a.content_key(&group, 0).unwrap()
    );
}

#[test]
fn a_replaced_agent_device_is_revoked_for_good() {
    let Room {
        mut hub,
        mut a,
        b,
        mut old,
        room_group,
        group,
    } = room();
    let mut new = new_device();
    a.change_agents(&[new.id()], &[old.id()], now()).unwrap();
    post_ok(&mut hub, &mut a);
    observe(&hub, &mut new);
    take_over(&mut hub, &mut a, &mut new, &group);
    settle(&hub, &mut new);
    settle(&hub, &mut old);
    let room_epoch = hub.epoch(&room_group).unwrap();

    // It is never enrolled again.
    a.change_agents(&[old.id()], &[], now()).unwrap();
    assert_eq!(post_refused(&mut hub, &mut a), [Error::BadCommit]);
    assert!(!a.group(&room_group).unwrap().pending);
    // It is never a human device.
    let package = old.key_package(now()).unwrap();
    assert_eq!(
        a.add_human_device(&old.id(), &package, now()),
        Err(Error::BadCommit)
    );
    // It is never added to a session group again, by an Add or as the device that takes over.
    a.add_to_session(&group, &old.id(), &package, now())
        .unwrap();
    assert_eq!(post_refused(&mut hub, &mut a), [Error::BadCommit]);
    a.clean_session(&group, &[], Some((&old.id(), &package)), now())
        .unwrap();
    assert_eq!(post_refused(&mut hub, &mut a), [Error::BadCommit]);
    // It founds nothing and is given no session.
    publish_some(&mut hub, &mut old, 1);
    let packages = hub.claim(&[b.id(), old.id()]).unwrap();
    let before = a.groups().unwrap().len();
    a.found_session(&old.id(), &packages, now()).unwrap();
    assert_eq!(post_refused(&mut hub, &mut a), [Error::BadCommit]);
    assert_eq!(a.groups().unwrap().len(), before);

    // Nothing of this changed a group.
    assert_eq!(hub.epoch(&room_group), Some(room_epoch));
    assert_eq!(hub.epoch(&group), Some(4));
    assert!(a.outbox().is_empty());
    assert_eq!(
        a.group(&group).unwrap().leaves,
        [a.id(), b.id(), new.id()].into_iter().collect()
    );
    // What the old device itself still posts is refused.
    let turn = TurnId::new([2; 16]);
    assert_eq!(
        old.send_work_trail(&group, &turn, 1, b"{}", now()),
        Err(Error::NotFound)
    );
}

#[test]
fn a_session_waits_with_an_empty_seat_for_a_later_takeover() {
    let Room {
        mut hub,
        mut a,
        mut b,
        mut old,
        group,
        ..
    } = room();
    // The agent device is removed and nobody takes over yet: the cleaning has no replacement.
    a.change_agents(&[], &[old.id()], now()).unwrap();
    post_ok(&mut hub, &mut a);
    let cuts = cuts_for(&a, &group);
    assert_eq!(cuts, [Cut::none(old.id())]);
    a.clean_session(&group, &cuts, None, now()).unwrap();
    post_ok(&mut hub, &mut a);
    settle(&hub, &mut old);
    sync_ok(&hub, &mut b);
    assert_eq!(
        hub.observer(&group).unwrap().seat_at(u64::MAX),
        Parent::Seat(None)
    );
    assert_eq!(
        b.group(&group).unwrap().leaves,
        [a.id(), b.id()].into_iter().collect()
    );
    // The session is live without an agent leaf: a human device commits in it.
    assert!(hub.stale_leaves(&group).unwrap().is_empty());
    b.update(&group, true, now()).unwrap().unwrap();
    post_ok(&mut hub, &mut b);
    sync_ok(&hub, &mut a);
    assert_eq!(hub.epoch(&group), Some(5));

    // Later a new agent device is enrolled and takes the seat: an Add alone.
    let mut new = new_device();
    enrol(&mut hub, &mut a, &mut new);
    take_over(&mut hub, &mut a, &mut new, &group);
    settle(&hub, &mut new);
    let processed = sync_ok(&hub, &mut b);
    assert!(matches!(
        &processed[..],
        [_, Processed::Commit { facts, .. }] if facts.adds == [new.id()] && facts.removes.is_empty()
    ));
    assert_eq!(
        hub.observer(&group).unwrap().seat_at(u64::MAX),
        Parent::Seat(Some(new.id()))
    );
    assert_eq!(
        new.content_key(&group, 6).unwrap(),
        b.content_key(&group, 6).unwrap()
    );
    assert_eq!(old.content_key(&group, 4), Err(Error::NoKey));
}

#[test]
fn an_agent_device_is_the_agent_leaf_of_one_live_main_session() {
    let Room {
        mut hub,
        mut a,
        mut b,
        mut old,
        room_group,
        group,
    } = room();
    publish_some(&mut hub, &mut b, 2);
    publish_some(&mut hub, &mut old, 2);

    // A second main session for the same agent device is refused.
    let packages = hub.claim(&[b.id(), old.id()]).unwrap();
    a.found_session(&old.id(), &packages, now()).unwrap();
    assert_eq!(post_refused(&mut hub, &mut a), [Error::BadCommit]);
    assert_eq!(a.groups().unwrap().len(), 2);

    // So is taking a second session over: another agent's session, emptied, does not take it either.
    let mut other = new_device();
    enrol(&mut hub, &mut a, &mut other);
    publish_some(&mut hub, &mut other, 1);
    let second = found_main(&mut hub, &mut a, &other.id());
    a.change_agents(&[], &[other.id()], now()).unwrap();
    post_ok(&mut hub, &mut a);
    let package = old.key_package(now()).unwrap();
    let cuts = cuts_for(&a, &second);
    a.clean_session(&second, &cuts, Some((&old.id(), &package)), now())
        .unwrap();
    assert_eq!(post_refused(&mut hub, &mut a), [Error::BadCommit]);
    assert_eq!(hub.stale_leaves(&second).unwrap(), [other.id()]);

    // Once its session is archived, the device may be given a new one.
    hub.archive(&group);
    a.archive(&group).unwrap();
    assert_eq!(a.update(&group, true, now()), Err(Error::Gone));
    let packages = hub.claim(&[b.id(), old.id()]).unwrap();
    let session = a.found_session(&old.id(), &packages, now()).unwrap();
    post_ok(&mut hub, &mut a);
    let third = GroupId::session(room_group.room_id(), session);
    assert_eq!(hub.epoch(&third), Some(1));
    settle(&hub, &mut old);
    assert_eq!(
        old.content_key(&third, 1).unwrap(),
        a.content_key(&third, 1).unwrap()
    );
}
