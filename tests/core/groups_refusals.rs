//! The Commits that must be refused (section 19, item 3), each with its code: by the hub, and by the devices
//! themselves when a hub that checks nothing stored it. Where no operation of a device builds such a Commit,
//! the device's refusal to build it is shown here and the rule on the wire in `rules.rs`, on hand-built facts.

use trommi_core::device::{log_finding, LogFinding, Processed};
use trommi_core::ids::GroupId;
use trommi_core::mls::profile::Cut;
use trommi_core::Error;
use trommi_tests::hub::Hub;
use trommi_tests::{
    add_human, cuts_for, enrol, found_helper, found_main, found_room_on, new_device,
    new_device_with, now, observe, post_all, post_ok, post_refused, process, publish_some, settle,
    sync, sync_ok, TestDevice, TestRecovery, TEST_RECOVERY_AUTH,
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

/// Two human devices, a main session with its agent device, and a second enrolled agent device. Every device
/// holds the stand-in that takes a join from outside, so that such a join is judged by the rules alone.
fn world(checks: bool) -> World {
    let recovery = TestRecovery {
        joins: true,
        ..TestRecovery::default()
    };
    let mut devices: Vec<TestDevice> = (0..4).map(|_| new_device_with(recovery)).collect();
    let (mut other, mut agent, mut b, mut a) = (
        devices.pop().unwrap(),
        devices.pop().unwrap(),
        devices.pop().unwrap(),
        devices.pop().unwrap(),
    );
    let mut hub = Hub::new(checks);
    hub.recovery = recovery;
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

/// Each device processes the log; the last entry is refused with `code`, as the finding `bad-group`.
fn refuse(hub: &Hub, devices: &mut [&mut TestDevice], code: &Error) {
    for device in devices {
        let results = sync(hub, device);
        let error = results.last().unwrap().as_ref().unwrap_err();
        assert_eq!(error, code);
        assert_eq!(log_finding(error), LogFinding::BadGroup);
    }
}

/// Runs `build` on a hub that checks and on one that does not. `build` leaves one Commit in the outbox of the
/// device it returns (by its place in `[a, b, agent, other]`). The checking hub refuses it with `code`; stored
/// by the other hub, it is refused with `code` by every other device that judges the group.
fn refused_by_hub_and_devices(build: fn(&mut World) -> usize, judges: &[usize], code: Error) {
    for checks in [true, false] {
        let mut world = world(checks);
        let committer = build(&mut world);
        let World {
            hub,
            a,
            b,
            agent,
            other,
            ..
        } = &mut world;
        let devices = [a, b, agent, other];
        if checks {
            assert_eq!(
                post_refused(hub, devices[committer]),
                std::slice::from_ref(&code)
            );
            assert!(devices[committer].outbox().is_empty());
        } else {
            post_ok(hub, devices[committer]);
            for judge in judges {
                refuse(hub, &mut [&mut *devices[*judge]], &code);
            }
        }
    }
}

const A: usize = 0;
const B: usize = 1;
const AGENT: usize = 2;
const OTHER: usize = 3;

#[test]
fn an_agent_device_committing_in_the_room_group() {
    // No operation of an agent device builds a Commit of the room group's leaves: it is no leaf.
    // (`rules.rs`, room_commits_follow_5_1: a committer that is no human device is `bad-commit`.)
    let mut built = world(true);
    let package = built.other.key_package(now()).unwrap();
    assert_eq!(
        built
            .agent
            .add_human_device(&built.other.id(), &package, now()),
        Err(Error::Forbidden)
    );
    assert_eq!(
        built.agent.change_agents(&[], &[built.other.id()], now()),
        Err(Error::Forbidden)
    );
    assert_eq!(
        built.agent.update(&built.room_group, true, now()),
        Err(Error::Forbidden)
    );
    // The one Commit it can build there is a join from outside, and that makes no agent device a human device.
    refused_by_hub_and_devices(
        |w| {
            let info = w.hub.group_info(&w.room_group).unwrap().clone();
            w.agent
                .join_from_outside(&info, now(), &mut |_, _| Ok(TEST_RECOVERY_AUTH.to_vec()))
                .unwrap();
            AGENT
        },
        &[A, B, OTHER],
        Error::BadCommit,
    );
}

#[test]
fn an_opener_removing_a_human_leaf() {
    for checks in [true, false] {
        let World {
            mut hub,
            mut a,
            mut b,
            mut agent,
            main,
            ..
        } = world(checks);
        let helper = found_helper(&mut hub, &mut agent, &main, &mut []);
        settle(&hub, &mut a);
        settle(&hub, &mut b);
        let mut device = new_device();
        let package = device.key_package(now()).unwrap();
        agent
            .readmit_helper(&helper, Cut::none(b.id()), &device.id(), &package, now())
            .unwrap();
        if checks {
            assert_eq!(post_refused(&mut hub, &mut agent), [Error::BadCommit]);
            assert_eq!(hub.epoch(&helper), Some(1));
        } else {
            post_ok(&mut hub, &mut agent);
            refuse(&hub, &mut [&mut a, &mut b], &Error::BadCommit);
            assert_eq!(b.group(&helper).unwrap().epoch, 1);
            assert!(b.group(&helper).unwrap().leaves.contains(&b.id()));
        }
    }
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
    refused_by_hub_and_devices(
        |w| {
            let package = w.other.key_package(now()).unwrap();
            w.a.add_to_session(&w.main, &w.other.id(), &package, now())
                .unwrap();
            A
        },
        &[B, AGENT],
        Error::BadCommit,
    );
    // Founded with two: the second agent device is one KeyPackage too many, added like a helper device.
    refused_by_hub_and_devices(
        |w| {
            let mut third = new_device();
            w.a.change_agents(&[third.id()], &[], now()).unwrap();
            post_ok(&mut w.hub, &mut w.a);
            for device in [&mut w.b, &mut w.agent, &mut w.other] {
                settle(&w.hub, device);
            }
            observe(&w.hub, &mut third);
            publish_some(&mut w.hub, &mut w.other, 1);
            let mut packages = w.hub.claim(&[w.b.id(), w.other.id()]).unwrap();
            packages.push(third.key_package(now()).unwrap());
            w.a.found_session(&w.other.id(), &packages, now()).unwrap();
            A
        },
        &[],
        Error::BadCommit,
    );
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
        // The device does not build its return to the room group.
        assert_eq!(
            a.add_human_device(&b.id(), &package, now()),
            Err(Error::BadCommit)
        );
        a.add_to_session(&main, &b.id(), &package, now()).unwrap();
        if checks {
            assert_eq!(post_refused(&mut hub, &mut a), [Error::BadCommit]);
            assert_eq!(hub.epoch(&main), Some(2));
        } else {
            post_ok(&mut hub, &mut a);
            refuse(&hub, &mut [&mut agent], &Error::BadCommit);
            assert_eq!(agent.group(&main).unwrap().epoch, 2);
        }
    }
    // A replaced agent device is enrolled again.
    refused_by_hub_and_devices(
        |w| {
            w.a.change_agents(&[], &[w.other.id()], now()).unwrap();
            post_ok(&mut w.hub, &mut w.a);
            for device in [&mut w.b, &mut w.agent, &mut w.other] {
                settle(&w.hub, device);
            }
            w.a.change_agents(&[w.other.id()], &[], now()).unwrap();
            A
        },
        &[B, AGENT, OTHER],
        Error::BadCommit,
    );
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
