//! Removal of a human device (5.2.8): the room Commit, the stale session groups, and whoever comes next
//! finishing the Removes. Nothing is taken from or for the removed device in between.

use trommi_core::device::{Processed, Received};
use trommi_core::ids::{GroupId, TurnId};
use trommi_core::mls::profile::Cut;
use trommi_core::Error;
use trommi_tests::hub::Hub;
use trommi_tests::{
    add_human, cuts_for, enrol, found_main, found_room, found_room_on, new_device, new_device_on,
    now, post_ok, post_refused, publish_some, reopen, settle, sync, sync_ok, MemoryStorage,
    TestDevice,
};

struct Room {
    hub: Hub,
    a: TestDevice,
    b: TestDevice,
    /// The device that is removed.
    x: TestDevice,
    agent: TestDevice,
    room_group: GroupId,
    group: GroupId,
}

/// Three human devices and one main session with its agent device.
fn room() -> Room {
    let (mut a, mut b, mut x, mut agent) = (new_device(), new_device(), new_device(), new_device());
    let (mut hub, room_group) = found_room(&mut a);
    add_human(&mut hub, &mut a, &mut b);
    add_human(&mut hub, &mut a, &mut x);
    enrol(&mut hub, &mut a, &mut agent);
    for device in [&mut b, &mut x, &mut agent] {
        publish_some(&mut hub, device, 1);
    }
    let group = found_main(&mut hub, &mut a, &agent.id());
    for device in [&mut b, &mut x, &mut agent] {
        settle(&hub, device);
    }
    Room {
        hub,
        a,
        b,
        x,
        agent,
        room_group,
        group,
    }
}

#[test]
fn a_removed_human_device_leaves_its_sessions_stale_until_another_device_cleans_them() {
    let Room {
        mut hub,
        mut a,
        mut b,
        mut x,
        mut agent,
        room_group,
        group,
    } = room();
    let turn = TurnId::new([7; 16]);
    assert_eq!(hub.epoch(&room_group), Some(3));
    let old_room_key = x.content_key(&room_group, 3).unwrap();
    let old_session_key = x.content_key(&group, 1).unwrap();

    // The room Commit removes the device with its Cut.
    a.remove_human_devices(&[Cut::none(x.id())], now()).unwrap();
    post_ok(&mut hub, &mut a);
    assert_eq!(hub.epoch(&room_group), Some(4));
    assert!(!hub.history().unwrap().newest().is_human(&x.id()));
    assert!(hub.history().unwrap().is_revoked(&x.id(), 4));
    // From here on the session group is stale: it still holds the leaf.
    assert_eq!(hub.stale_leaves(&group).unwrap(), [x.id()]);

    // The hub takes nothing for it, whoever posts: an application message is refused as stale, a Commit of a
    // device that has not seen the room Commit names an older room epoch.
    b.send_handover(&group, &agent.id()).unwrap();
    assert_eq!(post_refused(&mut hub, &mut b), [Error::StaleSession]);
    agent
        .send_work_trail(&group, &turn, 1, b"{}", now())
        .unwrap();
    assert_eq!(post_refused(&mut hub, &mut agent), [Error::StaleSession]);
    b.update(&group, true, now()).unwrap().unwrap();
    assert_eq!(post_refused(&mut hub, &mut b), [Error::RoomBehind]);
    assert!(!b.group(&group).unwrap().pending);

    // The removed device's own posts are refused in every group.
    x.send_handover(&room_group, &a.id()).unwrap();
    x.send_handover(&group, &agent.id()).unwrap();
    assert_eq!(
        post_refused(&mut hub, &mut x),
        [Error::WrongEpoch, Error::StaleSession]
    );
    x.update(&group, true, now()).unwrap().unwrap();
    assert_eq!(post_refused(&mut hub, &mut x), [Error::RoomBehind]);
    x.update(&room_group, true, now()).unwrap().unwrap();
    assert_eq!(post_refused(&mut hub, &mut x), [Error::EpochTaken]);
    assert_eq!(hub.epoch(&group), Some(1));
    assert_eq!(hub.epoch(&room_group), Some(4));

    // A device that processed the room Commit sees the stale group and writes nothing into it itself.
    let processed = sync_ok(&hub, &mut b);
    let [Processed::Commit {
        facts,
        removed: false,
        superseded: None,
    }] = &processed[..]
    else {
        panic!("one Commit: {processed:?}");
    };
    assert_eq!(facts.removes, [x.id()]);
    assert_eq!(facts.note.as_ref().unwrap().cuts, [Cut::none(x.id())]);
    assert_eq!(b.group(&group).unwrap().disallowed, [x.id()]);
    assert_eq!(b.update(&group, true, now()), Err(Error::StaleSession));
    assert_eq!(
        b.send_handover(&group, &agent.id()),
        Err(Error::StaleSession)
    );
    settle(&hub, &mut agent);
    assert_eq!(
        agent.send_work_trail(&group, &turn, 1, b"{}", now()),
        Err(Error::StaleSession)
    );
    assert!(b.outbox().is_empty() && agent.outbox().is_empty());
    // A Commit that leaves the leaf in, or names another, is not the cleaning.
    assert_eq!(
        b.clean_session(&group, &[], None, now()),
        Err(Error::BadCommit)
    );
    assert_eq!(
        b.clean_session(&group, &[Cut::none(agent.id())], None, now()),
        Err(Error::BadCommit)
    );

    // The removed device learns of its removal from the log: it derives no key of the new room epoch and
    // holds the room group no more. Open point: it cannot compute the room state of the epoch that removed it
    // (OpenMLS gives a removed member no full group context), so its record of the roles ends one epoch
    // earlier and `is_human` stays true; what it then builds names that older room epoch and is refused.
    let processed = sync(&hub, &mut x);
    assert!(matches!(
        processed[..],
        [Ok(Processed::Commit {
            removed: true,
            superseded: Some(_),
            ..
        })]
    ));
    assert_eq!(x.content_key(&room_group, 4), Err(Error::NoKey));
    assert_eq!(x.group(&room_group).err(), Some(Error::NotFound));
    assert_eq!(x.update(&room_group, true, now()), Err(Error::NotFound));
    x.update(&group, true, now()).unwrap().unwrap();
    assert_eq!(post_refused(&mut hub, &mut x), [Error::RoomBehind]);

    // Another human device than the remover finishes: the Remove with the Cut in the session group.
    b.clean_session(&group, &cuts_for(&b, &group), None, now())
        .unwrap();
    post_ok(&mut hub, &mut b);
    assert_eq!(hub.epoch(&group), Some(2));
    assert!(hub.stale_leaves(&group).unwrap().is_empty());
    let processed = sync_ok(&hub, &mut a);
    assert!(matches!(
        &processed[..],
        [Processed::Commit { facts, removed: false, .. }] if facts.committer == b.id() && facts.removes == [x.id()]
    ));
    assert!(a.group(&group).unwrap().disallowed.is_empty());
    assert_eq!(
        a.group(&group).unwrap().leaves,
        [a.id(), b.id(), agent.id()].into_iter().collect()
    );

    // The removed device derives no key of the session's new epoch; what it read, it keeps.
    sync(&hub, &mut x);
    assert_eq!(x.content_key(&group, 2), Err(Error::NoKey));
    x.send_handover(&group, &agent.id()).unwrap();
    assert_eq!(post_refused(&mut hub, &mut x), [Error::WrongEpoch]);
    assert_eq!(x.content_key(&room_group, 3).unwrap(), old_room_key);
    assert_eq!(x.content_key(&group, 1).unwrap(), old_session_key);
    assert_eq!(a.content_key(&group, 1).unwrap(), old_session_key);
    assert!(a.content_key(&group, 2).unwrap() != old_session_key);

    // The group is live again for those who stay.
    settle(&hub, &mut agent);
    agent
        .send_work_trail(&group, &turn, 1, b"{}", now())
        .unwrap();
    post_ok(&mut hub, &mut agent);
    let processed = sync_ok(&hub, &mut a);
    assert_eq!(
        processed,
        [Processed::Message(Received::WorkTrail {
            from: agent.id(),
            turn,
            number: 1,
            time: match &processed[0] {
                Processed::Message(Received::WorkTrail { time, .. }) => *time,
                _ => 0,
            },
            step: b"{}".to_vec(),
        })]
    );
    assert_eq!(
        a.content_key(&group, 2).unwrap(),
        agent.content_key(&group, 2).unwrap()
    );

    // A revoked key returns nowhere (4.2): the device refuses to build the Add to the room group, and the
    // hub refuses the Add to the session group.
    let package = x.key_package(now()).unwrap();
    assert_eq!(
        a.add_human_device(&x.id(), &package, now()),
        Err(Error::BadCommit)
    );
    a.add_to_session(&group, &x.id(), &package, now()).unwrap();
    assert_eq!(post_refused(&mut hub, &mut a), [Error::BadCommit]);
    assert!(!a.group(&group).unwrap().pending);
    assert_eq!(hub.epoch(&group), Some(2));
}

#[test]
fn a_hub_that_checks_nothing_does_not_keep_a_removed_device_in() {
    let (mut a, mut b, mut x, mut agent) = (new_device(), new_device(), new_device(), new_device());
    let mut hub = Hub::new(false);
    let room_group = found_room_on(&mut hub, &mut a);
    add_human(&mut hub, &mut a, &mut b);
    add_human(&mut hub, &mut a, &mut x);
    enrol(&mut hub, &mut a, &mut agent);
    for device in [&mut b, &mut x, &mut agent] {
        publish_some(&mut hub, device, 1);
    }
    let group = found_main(&mut hub, &mut a, &agent.id());
    for device in [&mut b, &mut x] {
        settle(&hub, device);
    }
    a.remove_human_devices(&[Cut::none(x.id())], now()).unwrap();
    post_ok(&mut hub, &mut a);

    // The removed device has not seen its removal and commits in the session group, naming the room epoch
    // it knows, where it was a human device. A checking hub answers `room-behind`; this one stores it. In the
    // room group its Commit comes too late for the epoch.
    x.update(&group, true, now()).unwrap().unwrap();
    post_ok(&mut hub, &mut x);
    x.update(&room_group, true, now()).unwrap().unwrap();
    assert_eq!(post_refused(&mut hub, &mut x), [Error::EpochTaken]);

    // The members judge the stored Commit against the room state it names (5.2.1) and follow it, but the
    // group stays stale for them under the room state they hold: they write nothing into it.
    for device in [&mut a, &mut b] {
        let processed = settle(&hub, device);
        assert!(matches!(
            processed.last(),
            Some(Processed::Commit { facts, removed: false, .. }) if facts.committer == x.id()
        ));
        let summary = device.group(&group).unwrap();
        assert_eq!((summary.epoch, &summary.disallowed[..]), (2, &[x.id()][..]));
        assert_eq!(device.update(&group, true, now()), Err(Error::StaleSession));
        assert_eq!(
            device.send_handover(&group, &agent.id()),
            Err(Error::StaleSession)
        );
    }

    // The cleaning removes the leaf all the same, and the removed device derives nothing after it.
    b.clean_session(&group, &cuts_for(&b, &group), None, now())
        .unwrap();
    post_ok(&mut hub, &mut b);
    sync_ok(&hub, &mut a);
    let results = sync(&hub, &mut x);
    assert!(matches!(
        results[..2],
        [
            Ok(Processed::Commit { removed: true, .. }),
            Ok(Processed::OwnCommit)
        ]
    ));
    assert!(a.group(&group).unwrap().disallowed.is_empty());
    assert_eq!(
        a.content_key(&group, 3).unwrap(),
        b.content_key(&group, 3).unwrap()
    );
    assert!(x.content_key(&group, 2).is_ok());
    assert_eq!(x.content_key(&group, 3), Err(Error::NoKey));
    assert_eq!(x.content_key(&room_group, 4), Err(Error::NoKey));
}

#[test]
fn a_removal_across_fifty_sessions_is_finished_by_another_device_after_a_crash() {
    const SESSIONS: usize = 50;
    let store = MemoryStorage::new();
    let handle = store.handle();
    let (mut a, mut b, mut x) = (new_device_on(store), new_device(), new_device());
    let (mut hub, room_group) = found_room(&mut a);
    add_human(&mut hub, &mut a, &mut b);
    add_human(&mut hub, &mut a, &mut x);
    // Fifty agent devices, enrolled in one Commit; the two other human devices are added to every session
    // with their last-resort KeyPackage.
    let mut agents: Vec<TestDevice> = (0..SESSIONS).map(|_| new_device()).collect();
    let ids: Vec<_> = agents.iter().map(TestDevice::id).collect();
    a.change_agents(&ids, &[], now()).unwrap();
    post_ok(&mut hub, &mut a);
    for device in agents.iter_mut().chain([&mut b, &mut x]) {
        publish_some(&mut hub, device, 0);
    }
    let groups: Vec<GroupId> = ids
        .iter()
        .map(|agent| found_main(&mut hub, &mut a, agent))
        .collect();
    settle(&hub, &mut b);
    settle(&hub, &mut x);
    assert_eq!(x.groups().unwrap().len(), SESSIONS + 1);

    // The room Commit is accepted, and the removing device crashes before it hears the answer.
    a.remove_human_devices(&[Cut::none(x.id())], now()).unwrap();
    let entry = a.outbox().remove(0);
    let accepted = hub.post(&a.id(), &entry).unwrap();
    drop(a);
    assert_eq!(hub.epoch(&room_group), Some(4));
    for group in &groups {
        assert_eq!(hub.stale_leaves(group).unwrap(), [x.id()]);
    }

    // In between nothing is accepted from the removed device, in any of the fifty groups or the room group.
    for group in &groups {
        x.send_handover(group, &b.id()).unwrap();
    }
    x.send_handover(&room_group, &b.id()).unwrap();
    let refused = post_refused(&mut hub, &mut x);
    assert_eq!(refused.len(), SESSIONS + 1);
    assert_eq!(refused[..SESSIONS], vec![Error::StaleSession; SESSIONS]);
    assert_eq!(refused[SESSIONS], Error::WrongEpoch);
    x.update(&groups[0], true, now()).unwrap().unwrap();
    assert_eq!(post_refused(&mut hub, &mut x), [Error::RoomBehind]);
    // Nor from anyone else for those groups, and nothing that would bring the device back.
    b.send_handover(&groups[1], &b.id()).unwrap();
    assert_eq!(post_refused(&mut hub, &mut b), [Error::StaleSession]);
    let log_before = hub.log.len();

    // Another human device comes next and finishes all fifty.
    sync_ok(&hub, &mut b);
    let stale: Vec<GroupId> = b
        .groups()
        .unwrap()
        .into_iter()
        .filter(|summary| !summary.disallowed.is_empty())
        .map(|summary| summary.group)
        .collect();
    assert_eq!(stale.len(), SESSIONS);
    let package = x.key_package(now()).unwrap();
    for group in &stale {
        assert_eq!(
            b.add_to_session(group, &x.id(), &package, now()),
            Err(Error::StaleSession)
        );
        b.clean_session(group, &cuts_for(&b, group), None, now())
            .unwrap();
        post_ok(&mut hub, &mut b);
    }
    assert_eq!(hub.log.len(), log_before + SESSIONS);
    for group in &groups {
        assert_eq!(hub.epoch(group), Some(2));
        assert!(hub.stale_leaves(group).unwrap().is_empty());
        assert!(!hub
            .observer(group)
            .unwrap()
            .leaves()
            .unwrap()
            .contains(&x.id()));
    }
    b.add_to_session(&groups[0], &x.id(), &package, now())
        .unwrap();
    assert_eq!(post_refused(&mut hub, &mut b), [Error::BadCommit]);

    // The removing device restarts: its Commit is still in the outbox, the same bytes, and the hub answers
    // the repeated post like the first. It then finds every session cleaned by the other device.
    let mut a = reopen(handle.reopened()).unwrap();
    assert_eq!(a.outbox(), std::slice::from_ref(&entry));
    assert!(a.group(&room_group).unwrap().pending);
    assert_eq!(hub.post(&a.id(), &entry), Ok(accepted));
    post_ok(&mut hub, &mut a);
    assert_eq!(a.group(&room_group).unwrap().epoch, 4);
    let processed = sync_ok(&hub, &mut a);
    let cleaned = processed
        .iter()
        .filter(|done| matches!(done, Processed::Commit { facts, .. } if facts.committer == b.id() && facts.removes == [x.id()]))
        .count();
    assert_eq!(cleaned, SESSIONS);
    for group in &groups {
        let summary = a.group(group).unwrap();
        assert_eq!((summary.epoch, summary.disallowed.len()), (2, 0));
        assert_eq!(
            a.content_key(group, 2).unwrap(),
            b.content_key(group, 2).unwrap()
        );
    }

    // The removed device is told of its removal and holds no key of any new epoch.
    let processed = sync(&hub, &mut x);
    assert!(matches!(
        processed.first(),
        Some(Ok(Processed::Commit { removed: true, .. }))
    ));
    assert_eq!(x.content_key(&room_group, 4), Err(Error::NoKey));
    for group in &groups {
        assert_eq!(x.content_key(group, 2), Err(Error::NoKey));
        assert!(x.content_key(group, 1).is_ok());
    }
}
