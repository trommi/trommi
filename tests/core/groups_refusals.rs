//! The Commits that must be refused (section 19, item 3), each with its code: by the hub, and by the devices
//! themselves when a hub that checks nothing stored it. Where no operation of a device builds such a Commit,
//! the device's refusal to build it is shown here and the rule on the wire in `rules.rs`, on hand-built facts.
//! And what a member that obeys MLS and not Trommi can send: a message or a note of another version, a work
//! trail step without a number.

use trommi_core::codec;
use trommi_core::crypto::Secret;
use trommi_core::device::{log_finding, LogFinding, Processed, Received, WelcomeExpectation};
use trommi_core::ids::{BoardId, DeviceId, GroupId, Hash32, RoomId, TurnId};
use trommi_core::invite::Role;
use trommi_core::mls::message::{EpochKey, TrommiMessage};
use trommi_core::mls::profile::{CommitNote, Cut, TrommiRoom};
use trommi_core::Error;
use trommi_tests::forge::Forger;
use trommi_tests::hub::Hub;
use trommi_tests::{
    add_forger, add_human, cuts_for, enrol, found_helper, found_main, found_room_on, new_device,
    now, post_all, post_ok, post_refused, process, publish_some, seeded_device, settle, sync,
    sync_ok, try_invite, TestDevice,
};

struct World {
    hub: Hub,
    a: TestDevice,
    b: TestDevice,
    agent: TestDevice,
    other: TestDevice,
    room_group: GroupId,
    main: GroupId,
}

/// The seeds of the keys of the second human device and of the second agent device.
const SECOND: u8 = 0x0B;
const OTHER: u8 = 0x0E;

/// Two human devices, a main session with its agent device, and a second enrolled agent device.
fn world(checks: bool) -> World {
    let (mut other, mut agent, mut b, mut a) = (
        seeded_device(OTHER),
        new_device(),
        seeded_device(SECOND),
        new_device(),
    );
    let mut hub = Hub::new(checks);
    let room_group = found_room_on(&mut hub, &mut a);
    add_human(&mut hub, &mut a, &mut b);
    enrol(&mut hub, &mut a, &mut agent);
    enrol(&mut hub, &mut a, &mut other);
    for device in [&mut a, &mut b] {
        publish_some(&mut hub, device, 0);
    }
    publish_some(&mut hub, &mut agent, 1);
    let main = found_main(&mut hub, &mut a, &agent.id());
    for device in [&mut b, &mut agent, &mut other] {
        settle(&hub, device);
    }
    World {
        hub,
        a,
        b,
        agent,
        other,
        room_group,
        main,
    }
}

#[test]
fn an_agent_device_committing_in_the_room_group() {
    // No operation of an agent device builds a Commit of the room group's leaves: it is no leaf.
    // (`rules.rs`, room_commits_follow_5_1: a committer that is no human device is `bad-commit`.)
    let mut built = world(true);
    for role in [Role::Human, Role::Agent] {
        assert_eq!(
            try_invite(&mut built.agent, &mut new_device(), role, None),
            Err(Error::Forbidden)
        );
    }
    assert_eq!(
        built.agent.remove_agents(&[built.other.id()], now()),
        Err(Error::Forbidden)
    );
    assert_eq!(
        built.agent.update(&built.room_group, true, now()),
        Err(Error::Forbidden)
    );
}

#[test]
fn an_opener_removing_a_human_leaf() {
    // No operation of the opener builds it: the one that removes a leaf replaces a helper device.
    // (`rules.rs`, helper_session_commits_follow_5_2_3_to_5_2_5: the opener removes no human leaf.)
    let World {
        mut hub,
        mut a,
        mut b,
        mut agent,
        main,
        ..
    } = world(true);
    let helper = found_helper(&mut hub, &mut agent, &main, &mut []);
    settle(&hub, &mut a);
    settle(&hub, &mut b);
    let mut device = new_device();
    let package = device.key_package(now()).unwrap();
    assert_eq!(
        agent.readmit_helper(&helper, Cut::none(b.id()), &device.id(), &package, now()),
        Err(Error::BadCommit)
    );
    assert!(agent.outbox().is_empty());
    assert_eq!(hub.epoch(&helper), Some(1));
    assert!(b.group(&helper).unwrap().leaves.contains(&b.id()));
}

#[test]
fn a_founding_commit_missing_a_human_device() {
    let World {
        mut hub,
        mut a,
        mut b,
        mut other,
        ..
    } = world(true);
    publish_some(&mut hub, &mut other, 2);
    // A device does not build it: the founding fails before anything is made.
    // (`rules.rs`, main_session_commits_follow_5_2: a founding that leaves out a device of H(r).)
    let of_agent = hub.claim(&[other.id()]).unwrap();
    assert_eq!(
        a.found_session(&other.id(), &of_agent, now()),
        Err(Error::Incomplete)
    );
    assert!(a.outbox().is_empty());

    // A founder that has not seen a human device join names the room epoch before it: the hub refuses that.
    let mut c = new_device();
    add_human(&mut hub, &mut b, &mut c);
    let packages = hub.claim(&[b.id(), other.id()]).unwrap();
    let session = a.found_session(&other.id(), &packages, now()).unwrap();
    assert_eq!(post_refused(&mut hub, &mut a), [Error::RoomBehind]);
    let group = GroupId::session(a.room().unwrap(), session);
    assert_eq!(hub.epoch(&group), None);
    assert_eq!(a.group(&group).err(), Some(Error::NotFound));
    // Once it has, it cannot found without the newcomer's KeyPackage.
    sync_ok(&hub, &mut a);
    assert_eq!(
        a.found_session(&other.id(), &packages, now()),
        Err(Error::Incomplete)
    );
}

#[test]
fn a_main_session_with_two_agent_leaves() {
    // No device builds it. (The rule on the wire: `rules.rs`, main_session_commits_follow_5_2.)
    let mut w = world(true);
    let package = w.other.key_package(now()).unwrap();
    assert_eq!(
        w.a.add_to_session(&w.main, &w.other.id(), &package, now()),
        Err(Error::BadCommit)
    );
    assert!(w.a.outbox().is_empty() && !w.a.group(&w.main).unwrap().pending);
    // Founded with two: the second agent device is one KeyPackage too many, added like a helper device.
    let mut third = new_device();
    enrol(&mut w.hub, &mut w.a, &mut third);
    for device in [&mut w.b, &mut w.agent, &mut w.other] {
        settle(&w.hub, device);
    }
    publish_some(&mut w.hub, &mut w.other, 1);
    let mut packages = w.hub.claim(&[w.b.id(), w.other.id()]).unwrap();
    packages.push(third.key_package(now()).unwrap());
    assert_eq!(
        w.a.found_session(&w.other.id(), &packages, now()),
        Err(Error::BadCommit)
    );
    assert!(w.a.outbox().is_empty());
    assert_eq!(w.a.groups().unwrap().len(), 2);
}

#[test]
fn a_returning_key() {
    // A removed human device is added to a session group again.
    for checks in [true, false] {
        let World {
            mut hub,
            mut a,
            mut agent,
            mut b,
            main,
            ..
        } = world(checks);
        a.remove_human_devices(&[Cut::none(b.id())], now()).unwrap();
        post_ok(&mut hub, &mut a);
        a.clean_session(&main, &cuts_for(&a, &main), None, now())
            .unwrap();
        post_ok(&mut hub, &mut a);
        settle(&hub, &mut agent);
        let package = b.key_package(now()).unwrap();
        // The device does not build its return to the room group: whoever holds the key answers an
        // invite, the person confirms, and no Commit is made.
        let mut returning = seeded_device(SECOND);
        assert_eq!(returning.id(), b.id());
        assert_eq!(
            try_invite(&mut a, &mut returning, Role::Human, None),
            Err(Error::BadCommit)
        );
        assert!(a.outbox().is_empty());
        // Nor its return to a session group.
        assert_eq!(
            a.add_to_session(&main, &b.id(), &package, now()),
            Err(Error::BadCommit)
        );
        assert_eq!(hub.epoch(&main), Some(2));
        assert_eq!(agent.group(&main).unwrap().epoch, 2);
    }
    // A replaced agent device is enrolled again.
    let mut w = world(true);
    w.a.remove_agents(&[w.other.id()], now()).unwrap();
    post_ok(&mut w.hub, &mut w.a);
    assert_eq!(
        try_invite(&mut w.a, &mut seeded_device(OTHER), Role::Agent, None),
        Err(Error::BadCommit)
    );
    assert!(w.a.outbox().is_empty());
}

#[test]
fn a_stale_room_epoch() {
    let World {
        mut hub,
        mut a,
        mut b,
        room_group,
        main,
        ..
    } = world(true);
    // A session Commit that names another room epoch than the newest is refused by the hub.
    b.update(&main, true, now()).unwrap().unwrap();
    a.update(&room_group, true, now()).unwrap().unwrap();
    post_ok(&mut hub, &mut a);
    assert_eq!(post_refused(&mut hub, &mut b), [Error::RoomBehind]);
    assert!(!b.group(&main).unwrap().pending);
    // Built again on the room state the device has processed, it is taken.
    sync_ok(&hub, &mut b);
    b.update(&main, true, now()).unwrap().unwrap();
    post_ok(&mut hub, &mut b);
    assert_eq!(hub.epoch(&main), Some(2));
    // A device refuses a session Commit whose room epoch it has not reached, until it has.
    // (`rules.rs`, main_session_commits_follow_5_2: a room epoch below the group's previous one.)
    sync_ok(&hub, &mut a);
    a.update(&room_group, true, now()).unwrap().unwrap();
    post_ok(&mut hub, &mut a);
    a.update(&main, true, now()).unwrap().unwrap();
    post_ok(&mut hub, &mut a);
    let [.., room_commit, session_commit] = &hub.log[..] else {
        panic!("two Commits");
    };
    let error = process(&mut b, session_commit).unwrap_err();
    assert_eq!(error, Error::RoomBehind);
    assert_eq!(log_finding(&error), LogFinding::Early);
    assert_eq!(b.group(&main).unwrap().epoch, 2);
    assert!(process(&mut b, room_commit).is_ok());
    assert!(matches!(
        process(&mut b, session_commit),
        Ok(Processed::Commit { .. })
    ));
}

#[test]
fn a_second_commit_for_an_epoch() {
    let World {
        mut hub,
        mut a,
        mut b,
        room_group,
        ..
    } = world(true);
    a.update(&room_group, true, now()).unwrap().unwrap();
    b.update(&room_group, true, now()).unwrap().unwrap();
    let second = b.outbox().remove(0);
    post_ok(&mut hub, &mut a);
    // The hub takes one Commit per group and epoch.
    assert_eq!(post_all(&mut hub, &mut b), [Err(Error::EpochTaken)]);
    assert_eq!(hub.epoch(&room_group), Some(4));
    // A device that merged the first does not take a second for that epoch, wherever it comes from.
    let mut forged = hub.log.last().unwrap().clone();
    forged.bytes = second.parts[0].clone();
    forged.from = b.id();
    let error = process(&mut a, &forged).unwrap_err();
    assert_eq!(error, Error::WrongEpoch);
    assert_eq!(log_finding(&error), LogFinding::Duplicate);
    assert_eq!(a.group(&room_group).unwrap().epoch, 4);
    // The loser follows the first and drops its own.
    assert!(matches!(
        &sync_ok(&hub, &mut b)[..],
        [Processed::Commit {
            superseded: Some(_),
            ..
        }]
    ));
    assert_eq!(
        a.content_key(&room_group, 4).unwrap(),
        b.content_key(&room_group, 4).unwrap()
    );
}

#[test]
fn a_standalone_proposal_and_a_changed_session_extension() {
    // Neither can be built through a device: it has no operation that sends a proposal outside a Commit, and
    // none that proposes group context extensions in a session group. On the wire both are `bad-commit`:
    // a message that is no Commit in a PublicMessage is refused where it is parsed
    // (`groups_observer.rs`, bytes_that_are_no_commit_are_refused_as_such), and a session Commit with a
    // GroupContextExtensions proposal by `rules.rs`, main_session_commits_follow_5_2 (a changed extension)
    // and room_context_changes_follow_5_1_2_and_8 (a session extension in the room group).
    let World {
        mut hub,
        mut a,
        mut b,
        main,
        ..
    } = world(true);
    // What the devices do build leaves a session group's extension as it was founded.
    let founded = a.group(&main).unwrap().session.unwrap();
    for _ in 0..3 {
        a.update(&main, true, now()).unwrap().unwrap();
        post_ok(&mut hub, &mut a);
    }
    sync_ok(&hub, &mut b);
    assert_eq!(b.group(&main).unwrap().session, Some(founded));
    assert_eq!(hub.observer(&main).unwrap().session(), Some(&founded));
    assert_eq!(founded.group_id(), main);
}

/// What the last entry of the log is to `device`.
fn last(hub: &Hub, device: &mut TestDevice) -> Result<Processed, Error> {
    sync(hub, device).pop().expect("an entry")
}

#[test]
fn a_message_or_a_note_of_a_newer_version() {
    let World {
        mut hub,
        mut a,
        mut b,
        mut agent,
        room_group,
        ..
    } = world(false);
    // A human device that sends what no device builds.
    let forger = Forger::new();
    let mut forged = add_forger(&mut hub, &mut a, &forger);
    sync_ok(&hub, &mut b);
    settle(&hub, &mut agent);

    // A stroke piece as the devices send it, then the same bytes under a version above and below this one.
    let piece = TrommiMessage::StrokePiece {
        board: BoardId::new([7; 16]),
        piece: b"{}".to_vec(),
    };
    let mut bytes = codec::encode(&piece).unwrap();
    forger.post_message(&mut hub, &mut forged, &bytes);
    assert!(matches!(
        last(&hub, &mut b),
        Ok(Processed::Message(Received::StrokePiece { from, .. })) if from == forger.id()
    ));
    bytes[0] = 3;
    forger.post_message(&mut hub, &mut forged, &bytes);
    // The newer version is a finding of its own; the message is not read.
    assert_eq!(
        last(&hub, &mut b),
        Ok(Processed::Message(Received::NewerVersion {
            from: forger.id()
        }))
    );
    bytes[0] = 1;
    forger.post_message(&mut hub, &mut forged, &bytes);
    assert_eq!(
        last(&hub, &mut b),
        Ok(Processed::Message(Received::Dropped))
    );

    // A Commit whose note names a newer version: `newer-version` to the members and to an observer, who keep
    // their state; a note that is merely broken stays `bad-commit`.
    let note = CommitNote {
        room_epoch: 0,
        room_state: Hash32::ZERO,
        time: now(),
        cuts: Vec::new(),
        join: false,
    };
    let mut note = codec::encode(&note).unwrap();
    note[0] = 3;
    let epoch = hub.epoch(&room_group).unwrap();
    let newer = forger.commit(&mut forged, &note, &[]);
    forger.post_commit(&mut hub, &room_group, &newer).unwrap();
    for device in [&mut a, &mut b, &mut agent] {
        let error = last(&hub, device).unwrap_err();
        assert_eq!(error, Error::NewerVersion);
        assert_eq!(log_finding(&error), LogFinding::BadGroup);
    }
    assert_eq!(a.group(&room_group).unwrap().epoch, epoch);
    assert_eq!(b.group(&room_group).unwrap().epoch, epoch);
}

#[test]
fn a_work_trail_step_without_a_number() {
    let World {
        mut hub,
        mut a,
        b,
        mut agent,
        main,
        ..
    } = world(false);
    // No device sends one.
    let turn = TurnId::new([4; 16]);
    assert_eq!(
        agent.send_work_trail(&main, &turn, 0, b"{}", now()),
        Err(Error::BadFormat)
    );
    assert!(agent.outbox().is_empty());

    // A helper device that sends what no device builds, in a helper session of the agent.
    let forger = Forger::new();
    let mut packages = hub.claim(&[a.id(), b.id()]).unwrap();
    packages.push(forger.key_package());
    let parent = main.session_id().unwrap();
    let session = agent.found_helper(&parent, &packages, now()).unwrap();
    post_ok(&mut hub, &mut agent);
    let helper = GroupId::session(main.room_id(), session);
    let mut forged = forger.join(&hub.welcomes.last().unwrap().bytes);
    settle(&hub, &mut a);
    assert!(a.group(&helper).unwrap().leaves.contains(&forger.id()));

    let step = |number: u32| {
        codec::encode(&TrommiMessage::WorkTrail {
            turn,
            number,
            time: now(),
            step: b"{}".to_vec(),
        })
        .unwrap()
    };
    forger.post_message(&mut hub, &mut forged, &step(1));
    assert!(matches!(
        last(&hub, &mut a),
        Ok(Processed::Message(Received::WorkTrail { from, number: 1, .. })) if from == forger.id()
    ));
    // Steps count from 1: one numbered 0 is dropped.
    forger.post_message(&mut hub, &mut forged, &step(0));
    assert_eq!(
        last(&hub, &mut a),
        Ok(Processed::Message(Received::Dropped))
    );
    // So is a key handover from a helper device (7.1): keys come from a human device or the opener.
    let handover = TrommiMessage::KeyHandover {
        recipient: a.id(),
        keys: vec![EpochKey {
            group: helper,
            epoch: 0,
            content_key: Secret::new([7; 32]),
        }],
        last: true,
    };
    forger.post_message(&mut hub, &mut forged, &codec::encode(&handover).unwrap());
    assert_eq!(
        last(&hub, &mut a),
        Ok(Processed::Message(Received::Dropped))
    );
    assert_eq!(a.content_key(&helper, 0), Err(Error::NoKey));
}

#[test]
fn a_welcome_into_a_room_with_too_many_devices() {
    // No device builds one: the Add of a 33rd human device and the enrolment of a 257th agent device are
    // refused where they are built and where they are judged (`rules.rs`). A founder that obeys MLS only
    // makes such rooms, and the device it adds refuses the Welcome (section 16).
    let room = |agents: usize| TrommiRoom {
        recovery_signature_key: [0xE1; 32],
        recovery_hpke_key: [0xE2; 32],
        // Ascending: the first two bytes count up.
        agents: (0..agents)
            .map(|at| {
                let mut id = [0x70; 32];
                id[0] = (at >> 8) as u8;
                id[1] = at as u8;
                DeviceId::new(id)
            })
            .collect(),
    };
    for (humans, agents, fits) in [(31, 256, true), (32, 0, false), (1, 257, false)] {
        let founder = Forger::new();
        let group = GroupId::room(RoomId::new([humans as u8; 32]));
        let extension = room(agents);
        assert_eq!(extension.agents.len(), agents);
        let mut forged = founder.found_room(&group, &extension);
        let mut c = new_device();
        let mut packages: Vec<Vec<u8>> = (1..humans).map(|_| Forger::new().key_package()).collect();
        // The founder invites the device, which answers: the Welcome is for the KeyPackage of its Request.
        packages.push(founder.invite(&group.room_id(), &mut c));
        let welcome = founder
            .commit(&mut forged, b"", &packages)
            .welcome
            .expect("a Welcome");
        let expected = WelcomeExpectation {
            room: group.room_id(),
            committer: Some(founder.id()),
        };
        let joined = c.join_welcome(&welcome, &expected, now());
        if fits {
            let joined = joined.expect("32 human devices and 256 agent devices fit");
            assert_eq!(c.group(&joined.group).unwrap().leaves.len(), 32);
        } else {
            assert_eq!(joined, Err(Error::TooMany), "{humans} and {agents}");
            assert!(c.groups().unwrap().is_empty());
            assert_eq!(c.room(), None);
        }
    }
}
