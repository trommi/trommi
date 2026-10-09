//! Helper sessions (5.2.3 to 5.2.6, 5.3.3, 5.3.5): founded by the main session's agent leaf, their opener,
//! with every human device and up to seven helper devices; what the hub refuses; first contact.

use trommi_core::device::{Joined, Processed, Received, WelcomeExpectation};
use trommi_core::ids::{GroupId, SessionId, TurnId};
use trommi_core::mls::profile::{Cut, TrommiSession};
use trommi_core::Error;
use trommi_tests::forge::Forger;
use trommi_tests::hub::Hub;
use trommi_tests::{
    add_forger, add_human, cuts_for, enrol, found_helper, found_main, found_room_on, new_device,
    now, observe, post_ok, post_refused, publish_some, settle, settle_joining, sync_ok, TestDevice,
};

struct Room {
    hub: Hub,
    a: TestDevice,
    b: TestDevice,
    agent: TestDevice,
    room_group: GroupId,
    /// The main session's group and id.
    main: GroupId,
    parent: SessionId,
}

/// Two human devices and a main session with its agent device, on a hub that checks or does not.
fn room(checks: bool) -> Room {
    let (mut a, mut b, mut agent) = (new_device(), new_device(), new_device());
    let mut hub = Hub::new(checks);
    let room_group = found_room_on(&mut hub, &mut a);
    add_human(&mut hub, &mut a, &mut b);
    enrol(&mut hub, &mut a, &mut agent);
    // The human devices are added to every session with their last-resort KeyPackage.
    for device in [&mut a, &mut b] {
        publish_some(&mut hub, device, 0);
    }
    publish_some(&mut hub, &mut agent, 1);
    let main = found_main(&mut hub, &mut a, &agent.id());
    settle(&hub, &mut b);
    settle(&hub, &mut agent);
    Room {
        hub,
        a,
        b,
        agent,
        room_group,
        parent: main.session_id().unwrap(),
        main,
    }
}

/// A new helper device that follows the room group.
fn helper_device(hub: &Hub) -> TestDevice {
    let mut device = new_device();
    observe(hub, &mut device);
    device
}

#[test]
fn the_opener_founds_a_helper_session_with_every_human_device() {
    let Room {
        mut hub,
        mut a,
        mut b,
        mut agent,
        room_group,
        main,
        parent,
    } = room(true);
    let mut h1 = helper_device(&hub);
    // A helper device may follow its main session's group as an observer too.
    h1.observe_session(hub.group_info(&main).unwrap()).unwrap();

    // The opener founds without a human's approval: one request, every human device and its helper device.
    let group = found_helper(&mut hub, &mut agent, &main, &mut [&mut h1]);
    assert_eq!(hub.epoch(&group), Some(1));
    let leaves = [a.id(), b.id(), agent.id(), h1.id()].into_iter().collect();
    assert_eq!(hub.observer(&group).unwrap().leaves().unwrap(), leaves);
    // First contact: the human devices find the founding made by the main session's agent leaf.
    for device in [&mut a, &mut b, &mut h1] {
        let joined = settle_joining(&hub, device);
        assert_eq!(
            joined,
            [Joined {
                group,
                epoch: 1,
                added_by: agent.id(),
                offending: vec![]
            }]
        );
        let summary = device.group(&group).unwrap();
        assert_eq!(summary.session.unwrap().parent, parent);
        assert_eq!(summary.leaves, leaves);
        assert_eq!(
            device.content_key(&group, 1).unwrap(),
            agent.content_key(&group, 1).unwrap()
        );
    }
    // The helper device holds no key of the room group or of the main session.
    assert_eq!(h1.groups().unwrap().len(), 1);
    assert_eq!(h1.content_key(&main, 1), Err(Error::NoKey));
    assert_eq!(h1.content_key(&room_group, 2), Err(Error::NoKey));

    // Its work trail is read by the human devices.
    let turn = TurnId::new([3; 16]);
    h1.send_work_trail(&group, &turn, 1, b"{}", now()).unwrap();
    post_ok(&mut hub, &mut h1);
    assert!(matches!(
        &sync_ok(&hub, &mut a)[..],
        [Processed::Message(Received::WorkTrail { from, .. })] if *from == h1.id()
    ));

    // The opener adds a second helper device and hands it the group's keys.
    let mut h2 = helper_device(&hub);
    let package = h2.key_package(now()).unwrap();
    agent
        .add_to_session(&group, &h2.id(), &package, now())
        .unwrap();
    post_ok(&mut hub, &mut agent);
    agent.send_handover(&group, &h2.id()).unwrap();
    post_ok(&mut hub, &mut agent);
    let processed = settle(&hub, &mut h2);
    assert_eq!(
        processed.last(),
        Some(&Processed::Message(Received::Keys {
            from: agent.id(),
            taken: 2,
            last: true
        }))
    );
    assert_eq!(
        h2.content_key(&group, 0).unwrap(),
        agent.content_key(&group, 0).unwrap()
    );
    // A human device takes keys from the opener of a helper session; a helper device sends no handover
    // (`groups_refusals.rs`, a_work_trail_step_without_a_number: one sent all the same is dropped).
    settle(&hub, &mut h1);
    assert_eq!(h1.send_handover(&group, &a.id()), Err(Error::Forbidden));
    sync_ok(&hub, &mut a);
    assert_eq!(a.content_key(&group, 0), Err(Error::NoKey));
    agent.send_handover(&group, &a.id()).unwrap();
    post_ok(&mut hub, &mut agent);
    assert_eq!(
        sync_ok(&hub, &mut a).last(),
        Some(&Processed::Message(Received::Keys {
            from: agent.id(),
            taken: 1,
            last: true
        }))
    );
    assert_eq!(
        a.content_key(&group, 0).unwrap(),
        agent.content_key(&group, 0).unwrap()
    );
}

#[test]
fn a_helper_device_that_lost_its_state_is_readmitted_by_the_opener() {
    let Room {
        mut hub,
        mut a,
        mut agent,
        main,
        ..
    } = room(true);
    let mut h1 = helper_device(&hub);
    let group = found_helper(&mut hub, &mut agent, &main, &mut [&mut h1]);
    settle(&hub, &mut h1);
    settle(&hub, &mut a);

    // It comes back as a new device with a new key: Remove of the old leaf and Add of the new, one Commit.
    let mut again = helper_device(&hub);
    let package = again.key_package(now()).unwrap();
    agent
        .readmit_helper(&group, Cut::none(h1.id()), &again.id(), &package, now())
        .unwrap();
    post_ok(&mut hub, &mut agent);
    agent.send_handover(&group, &again.id()).unwrap();
    post_ok(&mut hub, &mut agent);
    assert_eq!(hub.epoch(&group), Some(2));

    let processed = sync_ok(&hub, &mut a);
    assert!(matches!(
        &processed[..],
        [Processed::Commit { facts, .. }, Processed::Message(Received::Dropped)]
            if facts.committer == agent.id() && facts.removes == [h1.id()] && facts.adds == [again.id()]
    ));
    let processed = settle(&hub, &mut again);
    assert_eq!(
        processed.last(),
        Some(&Processed::Message(Received::Keys {
            from: agent.id(),
            taken: 2,
            last: true
        }))
    );
    for epoch in 0..=2 {
        assert_eq!(
            again.content_key(&group, epoch).unwrap(),
            agent.content_key(&group, epoch).unwrap()
        );
    }
    // The old device is out and holds no key of the new epoch.
    let processed = settle(&hub, &mut h1);
    assert!(matches!(
        processed.first(),
        Some(Processed::Commit { removed: true, .. })
    ));
    assert_eq!(h1.content_key(&group, 2), Err(Error::NoKey));
    // A human device readmits nobody, and neither does a helper device: only the opener.
    assert_eq!(
        a.readmit_helper(&group, Cut::none(again.id()), &h1.id(), &package, now()),
        Err(Error::Forbidden)
    );
    let mut third = helper_device(&hub);
    let package = third.key_package(now()).unwrap();
    assert_eq!(
        again.readmit_helper(&group, Cut::none(agent.id()), &third.id(), &package, now()),
        Err(Error::Forbidden)
    );
    // A helper device hands no key over either (7.1): a human device or the opener does.
    assert_eq!(again.send_handover(&group, &a.id()), Err(Error::Forbidden));
    assert!(again.outbox().is_empty());
    // The device that comes back has a new key (4.3), and the leaf that goes is a helper device's: not a
    // human device's and not the opener's own.
    let same_key = again.key_package(now()).unwrap();
    assert_eq!(
        agent.readmit_helper(&group, Cut::none(again.id()), &again.id(), &same_key, now()),
        Err(Error::BadCommit)
    );
    for kept in [a.id(), agent.id()] {
        assert_eq!(
            agent.readmit_helper(&group, Cut::none(kept), &third.id(), &package, now()),
            Err(Error::BadCommit)
        );
    }
    assert!(agent.outbox().is_empty());
}

#[test]
fn the_hub_refuses_what_a_helper_session_may_not_hold() {
    let Room {
        mut hub,
        mut a,
        mut b,
        mut agent,
        main,
        parent,
        ..
    } = room(true);
    let mut h1 = helper_device(&hub);
    let group = found_helper(&mut hub, &mut agent, &main, &mut [&mut h1]);
    for device in [&mut a, &mut b, &mut h1] {
        settle(&hub, device);
    }
    let humans = [a.id(), b.id()];

    // A human device founds no helper session. (The rule on the wire: `rules.rs`,
    // helper_session_commits_follow_5_2_3_to_5_2_5.)
    let packages = hub.claim(&[b.id()]).unwrap();
    assert_eq!(
        a.found_helper(&parent, &packages, now()),
        Err(Error::Forbidden)
    );
    // Nor does an agent device that is not the main session's agent leaf.
    let mut other = new_device();
    enrol(&mut hub, &mut a, &mut other);
    settle(&hub, &mut agent);
    settle(&hub, &mut h1);
    sync_ok(&hub, &mut b);
    let packages = hub.claim(&humans).unwrap();
    other.found_helper(&parent, &packages, now()).unwrap();
    assert_eq!(post_refused(&mut hub, &mut other), [Error::BadCommit]);
    assert!(other.groups().unwrap().is_empty());
    // A founding that leaves a human device out is not built.
    let one = hub.claim(&[a.id()]).unwrap();
    assert_eq!(
        agent.found_helper(&parent, &one, now()),
        Err(Error::Incomplete)
    );
    // A helper session hangs under a live main session of the room.
    let packages = hub.claim(&humans).unwrap();
    agent
        .found_helper(&SessionId::new([9; 16]), &packages, now())
        .unwrap();
    assert_eq!(post_refused(&mut hub, &mut agent), [Error::BadCommit]);

    // The opener removes no human leaf: it builds no such Commit.
    let mut h2 = helper_device(&hub);
    let package = h2.key_package(now()).unwrap();
    assert_eq!(
        agent.readmit_helper(&group, Cut::none(b.id()), &h2.id(), &package, now()),
        Err(Error::BadCommit)
    );
    // The opener adds no enrolled agent device and no human device.
    let of_other = other.key_package(now()).unwrap();
    agent
        .add_to_session(&group, &other.id(), &of_other, now())
        .unwrap();
    assert_eq!(post_refused(&mut hub, &mut agent), [Error::BadCommit]);
    let mut c = new_device();
    add_human(&mut hub, &mut a, &mut c);
    settle(&hub, &mut agent);
    settle(&hub, &mut h1);
    let of_c = c.key_package(now()).unwrap();
    agent.add_to_session(&group, &c.id(), &of_c, now()).unwrap();
    assert_eq!(post_refused(&mut hub, &mut agent), [Error::BadCommit]);
    // A human device adds it (5.2.7).
    a.add_to_session(&group, &c.id(), &of_c, now()).unwrap();
    post_ok(&mut hub, &mut a);
    settle(&hub, &mut agent);
    settle(&hub, &mut h1);

    // A helper device commits nothing.
    h1.add_to_session(&group, &h2.id(), &package, now())
        .unwrap();
    assert_eq!(post_refused(&mut hub, &mut h1), [Error::BadCommit]);
    // The opener commits in no other group: not in its own main session.
    agent
        .add_to_session(&main, &h2.id(), &package, now())
        .unwrap();
    assert_eq!(post_refused(&mut hub, &mut agent), [Error::BadCommit]);
    assert_eq!(hub.epoch(&main), Some(1));

    // Seven helper devices, and no eighth.
    for _ in 0..6 {
        let package = new_device().key_package(now()).unwrap();
        let info = trommi_core::device::key_package_info(&package).unwrap();
        agent
            .add_to_session(&group, &info.device, &package, now())
            .unwrap();
        post_ok(&mut hub, &mut agent);
    }
    assert_eq!(hub.observer(&group).unwrap().leaves().unwrap().len(), 11);
    agent
        .add_to_session(&group, &h2.id(), &package, now())
        .unwrap();
    assert_eq!(post_refused(&mut hub, &mut agent), [Error::TooMany]);
    assert_eq!(hub.epoch(&group), Some(8));
    assert!(agent.outbox().is_empty() && !agent.group(&group).unwrap().pending);
}

#[test]
fn a_main_session_has_at_most_thirty_two_live_helper_sessions() {
    let Room {
        mut hub,
        mut agent,
        a,
        b,
        main,
        parent,
        ..
    } = room(true);
    let mut groups = Vec::new();
    for _ in 0..32 {
        groups.push(found_helper(&mut hub, &mut agent, &main, &mut []));
    }
    assert!(groups.iter().all(|group| hub.epoch(group) == Some(1)));
    let packages = hub.claim(&[a.id(), b.id()]).unwrap();
    agent.found_helper(&parent, &packages, now()).unwrap();
    assert_eq!(post_refused(&mut hub, &mut agent), [Error::TooMany]);
    assert_eq!(agent.groups().unwrap().len(), 33);

    // An archived helper session is not live: its place is free again.
    hub.archive(&groups[0]);
    agent.archive(&groups[0]).unwrap();
    let another = found_helper(&mut hub, &mut agent, &main, &mut []);
    assert_eq!(hub.epoch(&another), Some(1));
}

#[test]
fn after_a_takeover_the_helper_sessions_are_stale_until_cleaned_with_the_new_opener() {
    let Room {
        mut hub,
        mut a,
        mut b,
        mut agent,
        main,
        ..
    } = room(true);
    let mut h1 = helper_device(&hub);
    let group = found_helper(&mut hub, &mut agent, &main, &mut [&mut h1]);
    for device in [&mut a, &mut b, &mut h1] {
        settle(&hub, device);
    }
    let turn = TurnId::new([4; 16]);

    // (a) The old agent device leaves `agents`: its main session and the helper session it opened are stale.
    let mut new = new_device();
    a.change_agents(&[new.id()], &[agent.id()], now()).unwrap();
    post_ok(&mut hub, &mut a);
    observe(&hub, &mut new);
    assert_eq!(hub.stale_leaves(&main).unwrap(), [agent.id()]);
    assert_eq!(hub.stale_leaves(&group).unwrap(), [agent.id()]);
    // The helper device writes nothing there: the hub refuses it, and once it saw the room Commit, so does
    // the device itself. The old opener founds nothing more.
    h1.send_work_trail(&group, &turn, 1, b"{}", now()).unwrap();
    assert_eq!(post_refused(&mut hub, &mut h1), [Error::StaleSession]);
    settle(&hub, &mut h1);
    assert_eq!(
        h1.send_work_trail(&group, &turn, 1, b"{}", now()),
        Err(Error::StaleSession)
    );
    let packages = hub.claim(&[a.id(), b.id()]).unwrap();
    agent
        .found_helper(&main.session_id().unwrap(), &packages, now())
        .unwrap();
    assert_eq!(post_refused(&mut hub, &mut agent), [Error::RoomBehind]);
    settle(&hub, &mut agent);
    agent
        .found_helper(&main.session_id().unwrap(), &packages, now())
        .unwrap();
    assert_eq!(post_refused(&mut hub, &mut agent), [Error::BadCommit]);

    // The helper session cannot be given its new opener before the main session has it.
    let package = new.key_package(now()).unwrap();
    assert_eq!(a.group(&group).unwrap().disallowed, [agent.id()]);
    a.clean_session(
        &group,
        &cuts_for(&a, &group),
        Some((&new.id(), &package)),
        now(),
    )
    .unwrap();
    assert_eq!(post_refused(&mut hub, &mut a), [Error::BadCommit]);

    // (b) The takeover in the main session, (c) the same in the helper session.
    let of_main = new.key_package(now()).unwrap();
    a.clean_session(
        &main,
        &cuts_for(&a, &main),
        Some((&new.id(), &of_main)),
        now(),
    )
    .unwrap();
    post_ok(&mut hub, &mut a);
    assert_eq!(hub.stale_leaves(&group).unwrap(), [agent.id()]);
    a.clean_session(
        &group,
        &cuts_for(&a, &group),
        Some((&new.id(), &package)),
        now(),
    )
    .unwrap();
    post_ok(&mut hub, &mut a);
    assert!(hub.stale_leaves(&group).unwrap().is_empty());
    assert!(hub.stale_leaves(&main).unwrap().is_empty());

    // The new device is the helper session's opener: it adds a helper device, and the helper device that
    // stayed writes again.
    assert_eq!(settle_joining(&hub, &mut new).len(), 2);
    settle(&hub, &mut h1);
    sync_ok(&hub, &mut b);
    let mut h2 = helper_device(&hub);
    let of_h2 = h2.key_package(now()).unwrap();
    new.add_to_session(&group, &h2.id(), &of_h2, now()).unwrap();
    post_ok(&mut hub, &mut new);
    settle(&hub, &mut h1);
    h1.send_work_trail(&group, &turn, 1, b"{}", now()).unwrap();
    post_ok(&mut hub, &mut h1);
    let processed = sync_ok(&hub, &mut b);
    assert!(matches!(
        &processed[..],
        [Processed::Commit { facts, .. }, Processed::Message(Received::WorkTrail { from, .. })]
            if facts.committer == new.id() && *from == h1.id()
    ));
    assert_eq!(
        b.group(&group).unwrap().leaves,
        [a.id(), b.id(), new.id(), h1.id(), h2.id()]
            .into_iter()
            .collect()
    );
    // The old opener is out of both groups.
    settle(&hub, &mut agent);
    assert!(agent.groups().unwrap().is_empty());
    assert_eq!(agent.content_key(&group, 2), Err(Error::NoKey));
}

#[test]
fn while_the_seat_is_empty_a_helper_session_waits_without_an_opener() {
    let Room {
        mut hub,
        mut a,
        mut b,
        mut agent,
        main,
        ..
    } = room(true);
    let mut h1 = helper_device(&hub);
    let group = found_helper(&mut hub, &mut agent, &main, &mut [&mut h1]);
    for device in [&mut a, &mut b, &mut h1] {
        settle(&hub, device);
    }
    a.change_agents(&[], &[agent.id()], now()).unwrap();
    post_ok(&mut hub, &mut a);
    for id in [main, group] {
        a.clean_session(&id, &cuts_for(&a, &id), None, now())
            .unwrap();
        post_ok(&mut hub, &mut a);
    }
    // The helper leaf stays until the takeover (5.3.3).
    assert_eq!(
        hub.observer(&group).unwrap().leaves().unwrap(),
        [a.id(), b.id(), h1.id()].into_iter().collect()
    );
    assert!(hub.stale_leaves(&group).unwrap().is_empty());
    // Only human devices commit, and they add no helper device and remove no leaf the room allows.
    let package = new_device().key_package(now()).unwrap();
    let stranger = trommi_core::device::key_package_info(&package)
        .unwrap()
        .device;
    a.add_to_session(&group, &stranger, &package, now())
        .unwrap();
    assert_eq!(post_refused(&mut hub, &mut a), [Error::BadCommit]);
    settle(&hub, &mut h1);
    h1.add_to_session(&group, &stranger, &package, now())
        .unwrap();
    assert_eq!(post_refused(&mut hub, &mut h1), [Error::BadCommit]);
    a.update(&group, true, now()).unwrap().unwrap();
    post_ok(&mut hub, &mut a);
    assert_eq!(hub.epoch(&group), Some(3));
}

#[test]
fn first_contact_finds_a_helper_session_that_was_not_made_by_its_opener() {
    // A hub that checks nothing stores a helper session founded by an agent device that is not the main
    // session's agent leaf.
    let Room {
        mut hub,
        mut a,
        mut b,
        main,
        parent,
        ..
    } = room(false);
    let mut other = new_device();
    enrol(&mut hub, &mut a, &mut other);
    sync_ok(&hub, &mut b);
    let packages = hub.claim(&[a.id(), b.id()]).unwrap();
    let session = other.found_helper(&parent, &packages, now()).unwrap();
    post_ok(&mut hub, &mut other);
    let group = GroupId::session(main.room_id(), session);

    // Each human device joins, finds the leaf that does not belong, and opens none of the session's content.
    for device in [&mut a, &mut b] {
        let joined = settle_joining(&hub, device);
        assert_eq!(
            joined,
            [Joined {
                group,
                epoch: 1,
                added_by: other.id(),
                offending: vec![other.id()]
            }]
        );
        assert_eq!(device.content_key(&group, 1), Err(Error::NoKey));
        assert_eq!(device.group(&group).unwrap().disallowed, [other.id()]);
        // It writes nothing into the group.
        assert_eq!(device.update(&group, true, now()), Err(Error::StaleSession));
        assert_eq!(
            device.send_handover(&group, &other.id()),
            Err(Error::BadGroup)
        );
    }
    // What is sent in the group it does not open: neither a step of the device that made the session nor a
    // handover of the other human device, which a hub that checks nothing stores.
    let turn = TurnId::new([9; 16]);
    other
        .send_work_trail(&group, &turn, 1, b"{}", now())
        .unwrap();
    post_ok(&mut hub, &mut other);
    for device in [&mut a, &mut b] {
        assert_eq!(sync_ok(&hub, device), [Processed::Skipped]);
        assert_eq!(device.content_key(&group, 1), Err(Error::NoKey));
    }

    // It removes the offending leaf. Open point: 5.2.6 says such a session's content is never opened; a
    // device that processed the cleaning hands the keys out from then on, the device that made it does not.
    a.clean_session(&group, &cuts_for(&a, &group), None, now())
        .unwrap();
    post_ok(&mut hub, &mut a);
    sync_ok(&hub, &mut b);
    for device in [&a, &b] {
        let summary = device.group(&group).unwrap();
        assert_eq!((summary.epoch, summary.disallowed.len()), (2, 0));
        assert_eq!(summary.leaves, [a.id(), b.id()].into_iter().collect());
    }
}

#[test]
fn first_contact_finds_more_helper_devices_than_a_helper_session_holds() {
    let Room {
        mut hub,
        mut a,
        mut b,
        agent,
        main,
        parent,
        ..
    } = room(false);
    // A human device that builds what no device builds: a helper session of its own making with eight
    // helper devices, which it adds the other human devices and the main session's agent to.
    let forger = Forger::new();
    add_forger(&mut hub, &mut a, &forger);
    sync_ok(&hub, &mut b);
    let session = TrommiSession {
        room_id: main.room_id(),
        session_id: SessionId::new([5; 16]),
        parent,
    };
    let helpers: Vec<Forger> = (0..8).map(|_| Forger::new()).collect();
    let mut packages = hub.claim(&[a.id(), b.id(), agent.id()]).unwrap();
    packages.extend(helpers.iter().map(Forger::key_package));
    let mut group = forger.found_session(&session);
    let welcome = forger
        .commit(&mut group, b"", &packages)
        .welcome
        .expect("a Welcome");
    let expected = WelcomeExpectation {
        room: main.room_id(),
        committer: None,
    };
    let mut many: Vec<_> = helpers.iter().map(Forger::id).collect();
    many.sort_unstable();
    for device in [&mut a, &mut b] {
        // Each human device finds the helper devices, seven at most by 5.2.3, and opens nothing of it.
        let joined = device.join_welcome(&welcome, &expected, now()).unwrap();
        assert_eq!(joined.group, session.group_id());
        assert_eq!(joined.offending, many);
        assert_eq!(device.content_key(&joined.group, 1), Err(Error::NoKey));
        assert_eq!(
            device.send_handover(&joined.group, &agent.id()),
            Err(Error::BadGroup)
        );
    }
}
