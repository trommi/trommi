//! Following without being a member (4.4, 14.1): the hub's observers, their stored state, and what they and
//! the devices refuse: forged roles, joins from outside without the recovery signature, requests whose parts
//! do not belong together, and bytes that are no Commit.

use std::collections::BTreeMap;
use trommi_core::crypto::SystemEntropy;
use trommi_core::device::{
    log_finding, Device, LogEntry, LogFinding, LogKind, Processed, WelcomeExpectation,
};
use trommi_core::ids::{DeviceId, GroupId};
use trommi_core::mls::observer::{Context, NoSessions, Observer};
use trommi_core::mls::profile::Cut;
use trommi_core::mls::rules::Parent;
use trommi_core::store::{table, Batch, Entry, OutboxKind};
use trommi_core::Error;
use trommi_tests::forge::Forger as Founder;
use trommi_tests::hub::Hub;
use trommi_tests::{
    add_human, enrol, found_helper, found_main, found_room_on, new_device, new_device_with, now,
    observe, post_ok, post_refused, process, publish_some, reopen, settle, settle_joining, sync,
    sync_ok, MemoryStorage, TestDevice, TestRecovery, TEST_RECOVERY_AUTH,
};

struct World {
    hub: Hub,
    a: TestDevice,
    b: TestDevice,
    agent: TestDevice,
    /// A second enrolled agent device, without a session.
    other: TestDevice,
    /// A helper device of the helper session.
    h1: TestDevice,
    room_group: GroupId,
    main: GroupId,
    helper: GroupId,
}

/// Two human devices, a main session with its agent device, a helper session with a helper device, and a
/// second agent device.
fn world(checks: bool) -> World {
    let (mut a, mut b, mut agent, mut other) =
        (new_device(), new_device(), new_device(), new_device());
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
    settle(&hub, &mut agent);
    let mut h1 = new_device();
    observe(&hub, &mut h1);
    let helper = found_helper(&mut hub, &mut agent, &main, &mut [&mut h1]);
    for device in [&mut a, &mut b, &mut h1, &mut other] {
        settle(&hub, device);
    }
    World {
        hub,
        a,
        b,
        agent,
        other,
        h1,
        room_group,
        main,
        helper,
    }
}

/// A device that nobody enrolled or added, and one KeyPackage of it.
fn stranger() -> (DeviceId, Vec<u8>) {
    let mut device = new_device();
    let package = device.key_package(now()).unwrap();
    (device.id(), package)
}

#[test]
fn the_hub_follows_every_group_from_public_messages() {
    let World {
        mut hub,
        mut a,
        b,
        agent,
        other,
        h1,
        room_group,
        main,
        helper,
    } = world(true);

    // Members and roles of every group, from GroupInfos and Commits alone.
    let roles = hub.history().unwrap();
    assert_eq!(roles.newest().epoch, 3);
    assert_eq!(
        roles.newest().humans,
        [a.id(), b.id()].into_iter().collect()
    );
    let mut agents = vec![agent.id(), other.id()];
    agents.sort();
    assert_eq!(roles.newest().room.agents, agents);
    assert_eq!(roles.at(0).unwrap().humans, [a.id()].into_iter().collect());
    assert!(roles.at(1).unwrap().room.agents.is_empty());
    assert_eq!(roles.at(2).unwrap().room.agents.len(), 1);
    assert_eq!(roles, a.room_history().unwrap());
    for (group, leaves) in [
        (room_group, vec![a.id(), b.id()]),
        (main, vec![a.id(), b.id(), agent.id()]),
        (helper, vec![a.id(), b.id(), agent.id(), h1.id()]),
    ] {
        let observer = hub.observer(&group).unwrap();
        assert_eq!(observer.group(), group);
        assert_eq!(observer.leaves().unwrap(), leaves.into_iter().collect());
        assert_eq!(observer.epoch().unwrap(), a.group(&group).unwrap().epoch);
        assert_eq!(
            observer.session().copied(),
            a.group(&group).unwrap().session
        );
    }
    assert_eq!(
        hub.observer(&main).unwrap().seat_at(u64::MAX),
        Parent::Seat(Some(agent.id()))
    );
    assert_eq!(
        hub.observer(&helper).unwrap().seat_at(u64::MAX),
        Parent::NotAMainSession
    );
    assert_eq!(hub.observer(&helper).unwrap().previous_room_epoch(), 3);

    // The hub's GroupInfo of each group is the one of its present state, signed by the last committer.
    let room = hub.observer(&room_group).unwrap();
    let info = hub.group_info(&room_group).unwrap();
    assert_eq!(room.check_group_info(info, &a.id()), Ok(()));
    assert_eq!(room.check_group_info(info, &b.id()), Err(Error::Incomplete));
    let older = &hub.group_infos[&(room_group, 2)];
    assert_eq!(
        room.check_group_info(older, &a.id()),
        Err(Error::Incomplete)
    );

    // A removal and a takeover show in the roles at once.
    a.remove_human_devices(&[Cut::none(b.id())], now()).unwrap();
    post_ok(&mut hub, &mut a);
    a.change_agents(&[], &[agent.id()], now()).unwrap();
    post_ok(&mut hub, &mut a);
    let roles = hub.history().unwrap();
    assert_eq!(roles.newest().humans, [a.id()].into_iter().collect());
    assert_eq!(roles.newest().room.agents, [other.id()]);
    assert!(roles.is_revoked(&b.id(), 4) && !roles.is_revoked(&b.id(), 3));
    assert!(roles.is_revoked(&agent.id(), 5) && !roles.is_revoked(&agent.id(), 4));
    assert!(!roles.is_revoked(&other.id(), 5));
    let mut stale = vec![b.id(), agent.id()];
    stale.sort();
    assert_eq!(hub.stale_leaves(&main).unwrap(), stale);
    assert_eq!(hub.stale_leaves(&helper).unwrap(), stale);
}

/// A holder's store of an observer's entries.
#[derive(Default)]
struct Kept(BTreeMap<Vec<u8>, Vec<u8>>);

impl Kept {
    fn apply(&mut self, batch: Batch) {
        for key in &batch.delete {
            self.0.remove(key);
        }
        for entry in &batch.put {
            self.0.insert(entry.key.clone(), entry.value.clone());
        }
    }

    fn entries(&self) -> Vec<Entry> {
        self.0
            .iter()
            .map(|(key, value)| Entry::new(key.clone(), value.clone()))
            .collect()
    }
}

#[test]
fn an_observer_is_stored_and_read_back() {
    let World {
        mut hub,
        mut a,
        mut b,
        room_group,
        main,
        ..
    } = world(true);
    let recovery = TestRecovery::default();
    let context = Context {
        room: None,
        sessions: &NoSessions,
        recovery: &recovery,
        max_human_devices: 32,
    };

    // An observer of the room group, started from the GroupInfo of epoch 1 with the state it was told.
    let told = hub.history().unwrap().at(1).unwrap().state;
    let info = hub.group_infos[&(room_group, 1)].clone();
    assert_eq!(
        Observer::follow_room(&info, Some(&hub.history().unwrap().at(2).unwrap().state)).err(),
        Some(Error::BadFormat)
    );
    assert_eq!(
        Observer::follow_room(hub.group_info(&main).unwrap(), None).err(),
        Some(Error::BadFormat)
    );
    let mut observer = Observer::follow_room(&info, Some(&told)).unwrap();
    let mut kept = Kept::default();
    kept.apply(observer.take_changes().unwrap());
    assert!(observer.take_changes().unwrap().is_empty());
    let room_commits = |hub: &Hub, from: u64| -> Vec<Vec<u8>> {
        hub.log
            .iter()
            .filter(|item| item.group == room_group && item.commit && item.epoch >= from)
            .map(|item| item.bytes.clone())
            .collect()
    };
    for commit in room_commits(&hub, 1) {
        let facts = observer.process_commit(&commit, None, &context).unwrap();
        assert_eq!(facts.committer, a.id());
        kept.apply(observer.take_changes().unwrap());
    }
    assert_eq!(observer.epoch().unwrap(), 3);

    // Read back, it is the same follower: group, epoch, leaves, roles from the epoch it began at.
    let mut loaded = Observer::load(kept.entries()).unwrap();
    assert_eq!(loaded.group(), room_group);
    assert_eq!(loaded.epoch().unwrap(), 3);
    assert_eq!(loaded.leaves().unwrap(), observer.leaves().unwrap());
    assert_eq!(loaded.history(), observer.history());
    assert_eq!(loaded.history().unwrap().at(0), None);
    assert_eq!(
        loaded.history().unwrap().newest(),
        hub.history().unwrap().newest()
    );
    assert!(loaded.take_changes().unwrap().is_empty());

    // Both follow the next Commits alike, and a Commit handed in twice or too early changes nothing.
    b.update(&room_group, true, now()).unwrap().unwrap();
    post_ok(&mut hub, &mut b);
    sync_ok(&hub, &mut a);
    a.remove_human_devices(&[Cut::none(b.id())], now()).unwrap();
    post_ok(&mut hub, &mut a);
    let [update, removal] = &room_commits(&hub, 3)[..] else {
        panic!("two Commits");
    };
    assert_eq!(
        loaded.process_commit(removal, None, &context).err(),
        Some(Error::GroupBehind)
    );
    for follower in [&mut observer, &mut loaded] {
        assert_eq!(
            follower
                .process_commit(update, None, &context)
                .unwrap()
                .committer,
            b.id()
        );
        assert_eq!(
            follower.process_commit(update, None, &context).err(),
            Some(Error::EpochTaken)
        );
        let facts = follower.process_commit(removal, None, &context).unwrap();
        assert_eq!(facts.removes, [b.id()]);
        assert_eq!(follower.epoch().unwrap(), 5);
        assert_eq!(follower.leaves().unwrap(), [a.id()].into_iter().collect());
    }
    assert_eq!(loaded.history(), observer.history());
    assert!(loaded.history().unwrap().is_revoked(&b.id(), 5));
    kept.apply(loaded.take_changes().unwrap());
    let again = Observer::load(kept.entries()).unwrap();
    assert_eq!(again.history(), observer.history());
    assert_eq!(again.epoch().unwrap(), 5);

    // An observer of a session group keeps its record too.
    let room = hub.history().unwrap().at(3).unwrap().clone();
    let mut session = Observer::follow_session(&hub.group_infos[&(main, 1)], &room).unwrap();
    let mut kept_session = Kept::default();
    kept_session.apply(session.take_changes().unwrap());
    let loaded = Observer::load(kept_session.entries()).unwrap();
    assert_eq!(loaded.group(), main);
    assert_eq!(loaded.session(), session.session());
    assert_eq!(loaded.seat_at(3), session.seat_at(3));
    assert!(matches!(loaded.seat_at(3), Parent::Seat(Some(_))));
    assert_eq!(loaded.leaves().unwrap(), session.leaves().unwrap());

    // Stored entries are untrusted: a missing record, a damaged state, a foreign key.
    let whole = kept.entries();
    for at in 0..whole.len() {
        let mut entries = kept.entries();
        entries.remove(at);
        if let Err(error) = Observer::load(entries) {
            assert!(matches!(error, Error::Storage(_)), "entry {at}: {error:?}");
        }
        let mut entries = kept.entries();
        let half = entries[at].value.len() / 2;
        entries[at].value.truncate(half);
        if let Err(error) = Observer::load(entries) {
            assert!(matches!(error, Error::Storage(_)), "entry {at}: {error:?}");
        }
    }
    let mut entries = kept.entries();
    entries.push(Entry::new(vec![9, 9], vec![1]));
    assert!(matches!(Observer::load(entries), Err(Error::Storage(_))));
    assert!(matches!(Observer::load(Vec::new()), Err(Error::Storage(_))));
}

/// Who commits in [`forged`].
#[derive(Clone, Copy, Debug)]
enum Forger {
    A,
    Agent,
    Helper,
}

/// A Commit a device has no right to make, built through the device's own operations. Returns who made it,
/// the group it is for and the code it is refused with.
type Forgery = fn(&mut World) -> (Forger, GroupId, Error);

fn forgeries() -> Vec<(&'static str, Forgery)> {
    vec![
        ("an agent device adds a device to its main session", |w| {
            let (device, package) = stranger();
            w.agent
                .add_to_session(&w.main, &device, &package, now())
                .unwrap();
            (Forger::Agent, w.main, Error::BadCommit)
        }),
        (
            "an agent device adds a human device to its main session",
            |w| {
                let mut c = new_device();
                add_human(&mut w.hub, &mut w.a, &mut c);
                for device in [&mut w.b, &mut w.agent, &mut w.h1, &mut w.other] {
                    settle(&w.hub, device);
                }
                let package = c.key_package(now()).unwrap();
                w.agent
                    .add_to_session(&w.main, &c.id(), &package, now())
                    .unwrap();
                (Forger::Agent, w.main, Error::BadCommit)
            },
        ),
        ("an opener adds an enrolled agent device", |w| {
            let package = w.other.key_package(now()).unwrap();
            w.agent
                .add_to_session(&w.helper, &w.other.id(), &package, now())
                .unwrap();
            (Forger::Agent, w.helper, Error::BadCommit)
        }),
        ("a helper device commits", |w| {
            let (device, package) = stranger();
            w.h1.add_to_session(&w.helper, &device, &package, now())
                .unwrap();
            (Forger::Helper, w.helper, Error::BadCommit)
        }),
        ("a human device is enrolled as an agent device", |w| {
            w.a.change_agents(&[w.b.id()], &[], now()).unwrap();
            (Forger::A, w.room_group, Error::BadCommit)
        }),
        ("a second agent device is added to a main session", |w| {
            let package = w.other.key_package(now()).unwrap();
            w.a.add_to_session(&w.main, &w.other.id(), &package, now())
                .unwrap();
            (Forger::A, w.main, Error::BadCommit)
        }),
        ("a human device adds a helper device", |w| {
            let (device, package) = stranger();
            w.a.add_to_session(&w.helper, &device, &package, now())
                .unwrap();
            (Forger::A, w.helper, Error::BadCommit)
        }),
    ]
}

fn forger(world: &mut World, who: Forger) -> &mut TestDevice {
    match who {
        Forger::A => &mut world.a,
        Forger::Agent => &mut world.agent,
        Forger::Helper => &mut world.h1,
    }
}

#[test]
fn the_hub_refuses_forged_roles() {
    for (name, forge) in forgeries() {
        let mut world = world(true);
        let (who, group, code) = forge(&mut world);
        let epoch = world.hub.epoch(&group);
        let log_len = world.hub.log.len();
        let hub = &mut world.hub;
        let device = match who {
            Forger::A => &mut world.a,
            Forger::Agent => &mut world.agent,
            Forger::Helper => &mut world.h1,
        };
        assert_eq!(post_refused(hub, device), [code], "{name}");
        // Nothing was stored, and the device has put its own state back.
        assert_eq!(
            (hub.epoch(&group), hub.log.len()),
            (epoch, log_len),
            "{name}"
        );
        assert!(device.outbox().is_empty(), "{name}");
        assert_eq!(
            device
                .group(&group)
                .map(|summary| (summary.pending, Some(summary.epoch))),
            Ok((false, epoch)),
            "{name}"
        );
    }
}

#[test]
fn the_devices_refuse_forged_roles_that_a_hub_let_through() {
    for (name, forge) in forgeries() {
        let mut world = world(false);
        let (who, group, code) = forge(&mut world);
        let committer = forger(&mut world, who).id();
        // A hub that checks nothing stores the Commit.
        let mut hub = std::mem::replace(&mut world.hub, Hub::new(false));
        post_ok(&mut hub, forger(&mut world, who));
        let World {
            a,
            b,
            agent,
            other,
            h1,
            ..
        } = &mut world;
        let mut refused = 0;
        for device in [a, b, agent, other, h1] {
            if device.id() == committer {
                continue;
            }
            let held = device.group(&group).ok().map(|summary| summary.epoch);
            let roles = device.room_history().unwrap().newest().epoch;
            let results = sync(&hub, device);
            let last = results.last().unwrap();
            if held.is_none() && !group.is_room() {
                // Not a leaf of that session group: the Commit is not for it.
                assert_eq!(last, &Ok(Processed::Skipped), "{name}");
                continue;
            }
            // A leaf of the group, or a follower of the room group: the Commit is refused with its code, the
            // finding is `bad-group`, and the state stays the last good one.
            let error = last.as_ref().expect_err(name);
            assert_eq!(error, &code, "{name}");
            assert_eq!(log_finding(error), LogFinding::BadGroup, "{name}");
            assert_eq!(
                device.group(&group).ok().map(|summary| summary.epoch),
                held,
                "{name}"
            );
            assert_eq!(
                device.room_history().unwrap().newest().epoch,
                roles,
                "{name}"
            );
            refused += 1;
        }
        assert!(refused >= 2, "{name}: {refused} devices judged it");
    }
}

#[test]
fn what_no_device_builds() {
    let World {
        mut a,
        mut agent,
        mut h1,
        mut other,
        b,
        room_group,
        main,
        helper,
        ..
    } = world(true);
    // The opener removes no human leaf, and a helper device removes nobody: the one operation that replaces
    // a leaf is the opener's, for a helper device. (The rule on the wire: `rules.rs`,
    // helper_session_commits_follow_5_2_3_to_5_2_5.)
    let (device, package) = stranger();
    assert_eq!(
        agent.readmit_helper(&helper, Cut::none(b.id()), &device, &package, now()),
        Err(Error::BadCommit)
    );
    assert_eq!(
        h1.readmit_helper(&helper, Cut::none(agent.id()), &device, &package, now()),
        Err(Error::Forbidden)
    );
    // Agent and helper devices commit nothing in the room group (5.1.4): they are no leaves of it, and no
    // operation of theirs makes such a Commit. (The rule on the wire: `rules.rs`, room_commits_follow_5_1.)
    let (device, package) = stranger();
    for outsider in [&mut agent, &mut h1, &mut other] {
        assert_eq!(
            outsider.add_human_device(&device, &package, now()),
            Err(Error::Forbidden)
        );
        assert_eq!(
            outsider.change_agents(&[device], &[], now()),
            Err(Error::Forbidden)
        );
        assert_eq!(
            outsider.remove_human_devices(&[Cut::none(b.id())], now()),
            Err(Error::Forbidden)
        );
        assert_eq!(outsider.update(&main, true, now()), Err(Error::Forbidden));
        assert_eq!(
            outsider.clean_session(&main, &[], Some((&device, &package)), now()),
            Err(Error::Forbidden)
        );
        assert!(outsider.outbox().is_empty());
    }
    // A human device makes no agent device a human device, removes nobody without a Cut and not itself.
    let of_agent = agent.key_package(now()).unwrap();
    assert_eq!(
        a.add_human_device(&agent.id(), &of_agent, now()),
        Err(Error::BadCommit)
    );
    assert_eq!(a.remove_human_devices(&[], now()), Err(Error::BadCommit));
    assert_eq!(
        a.remove_human_devices(&[Cut::none(a.id())], now()),
        Err(Error::BadCommit)
    );
    assert_eq!(
        a.change_agents(&[], &[device], now()),
        Err(Error::NotMember)
    );
    // A KeyPackage of another device than the one named is not used (4.5).
    assert_eq!(
        a.add_human_device(&device, &of_agent, now()),
        Err(Error::BadKeyPackage)
    );
    assert_eq!(
        a.add_to_session(&main, &device, &of_agent, now()),
        Err(Error::BadKeyPackage)
    );
    assert_eq!(
        a.add_to_session(&room_group, &device, &package, now()),
        Err(Error::BadFormat)
    );
    assert!(a.outbox().is_empty());
}

/// A room whose devices and hub hold the stand-in that authorises joins from outside, or not.
fn room_for_joins(joins: bool) -> (Hub, TestDevice, TestDevice, GroupId, GroupId) {
    let recovery = TestRecovery {
        joins,
        ..TestRecovery::default()
    };
    let (mut a, mut agent) = (new_device_with(recovery), new_device_with(recovery));
    let mut hub = Hub::new(true);
    hub.recovery = recovery;
    let room_group = found_room_on(&mut hub, &mut a);
    enrol(&mut hub, &mut a, &mut agent);
    publish_some(&mut hub, &mut agent, 1);
    let main = found_main(&mut hub, &mut a, &agent.id());
    settle(&hub, &mut agent);
    (hub, a, agent, room_group, main)
}

#[test]
fn a_signature_key_alone_opens_no_group() {
    let (mut hub, mut a, mut agent, room_group, main) = room_for_joins(false);
    let mut thief = new_device();
    observe(&hub, &mut thief);

    // A join from outside whose RecoveryAuth is anything but the recovery signature is refused by the hub.
    let info = hub.group_info(&room_group).unwrap().clone();
    let id = thief
        .join_from_outside(&info, now(), &mut |_, _| Ok(b"not a signature".to_vec()))
        .unwrap();
    assert_eq!(thief.outbox()[0].kind, OutboxKind::ExternalCommit);
    assert_eq!(thief.outbox()[0].id, id);
    assert_eq!(post_refused(&mut hub, &mut thief), [Error::BadSignature]);
    assert!(thief.outbox().is_empty() && thief.groups().unwrap().is_empty());
    assert!(!thief.is_human());
    assert_eq!(hub.epoch(&room_group), Some(1));
    // So is one into a session group, and one with the stand-in's bytes on a hub that takes no join.
    let session_info = hub.group_info(&main).unwrap().clone();
    thief
        .join_from_outside(&session_info, now(), &mut |_, _| {
            Ok(TEST_RECOVERY_AUTH.to_vec())
        })
        .unwrap();
    assert_eq!(post_refused(&mut hub, &mut thief), [Error::BadCommit]);
    thief
        .join_from_outside(&info, now(), &mut |_, _| Ok(TEST_RECOVERY_AUTH.to_vec()))
        .unwrap();
    assert_eq!(post_refused(&mut hub, &mut thief), [Error::BadSignature]);
    // A device that cannot make the RecoveryAuth builds nothing.
    assert_eq!(
        thief.join_from_outside(&info, now(), &mut |_, _| Err(Error::WrongRecovery)),
        Err(Error::WrongRecovery)
    );
    assert!(thief.outbox().is_empty());

    // On a hub that checks nothing the Commit is stored, and the members refuse it themselves.
    let (mut open, mut a2, mut agent2, room_2, main_2) = {
        let recovery = TestRecovery::default();
        let (mut a, mut agent) = (new_device_with(recovery), new_device_with(recovery));
        let mut hub = Hub::new(false);
        let room_group = found_room_on(&mut hub, &mut a);
        enrol(&mut hub, &mut a, &mut agent);
        publish_some(&mut hub, &mut agent, 1);
        let main = found_main(&mut hub, &mut a, &agent.id());
        settle(&hub, &mut agent);
        (hub, a, agent, room_group, main)
    };
    let mut thief = new_device();
    observe(&open, &mut thief);
    let info = open.group_info(&main_2).unwrap().clone();
    thief
        .join_from_outside(&info, now(), &mut |_, _| Ok(TEST_RECOVERY_AUTH.to_vec()))
        .unwrap();
    post_ok(&mut open, &mut thief);
    for device in [&mut a2, &mut agent2] {
        let results = sync(&open, device);
        let error = results.last().unwrap().as_ref().unwrap_err();
        assert_eq!(error, &Error::BadCommit);
        assert_eq!(log_finding(error), LogFinding::BadGroup);
        assert_eq!(device.group(&main_2).unwrap().epoch, 1);
    }
    let info = open.group_info(&room_2).unwrap().clone();
    let mut second = new_device();
    observe(&open, &mut second);
    second
        .join_from_outside(&info, now(), &mut |_, _| Ok(TEST_RECOVERY_AUTH.to_vec()))
        .unwrap();
    post_ok(&mut open, &mut second);
    let results = sync(&open, &mut a2);
    let error = results.last().unwrap().as_ref().unwrap_err();
    assert_eq!(error, &Error::BadSignature);
    assert_eq!(log_finding(error), LogFinding::BadGroup);
    assert_eq!(a2.group(&room_2).unwrap().epoch, 1);
    // The agent device, which follows the room group as an observer, refuses it too.
    let results = sync(&open, &mut agent2);
    assert_eq!(results.last().unwrap(), &Err(Error::BadSignature));

    // Nothing of this touched the first room.
    sync_ok(&hub, &mut a);
    settle(&hub, &mut agent);
    assert_eq!(a.group(&room_group).unwrap().leaves.len(), 1);
}

#[test]
fn a_join_from_outside_replaces_the_real_state_only_when_accepted() {
    let (mut hub, mut a, mut agent, room_group, main) = room_for_joins(true);
    let joins = TestRecovery {
        joins: true,
        ..TestRecovery::default()
    };
    let mut c = new_device_with(joins);
    observe(&hub, &mut c);
    let info = hub.group_info(&room_group).unwrap().clone();
    let mut seen = Vec::new();
    let id = c
        .join_from_outside(&info, now(), &mut |commit, note| {
            seen.push((commit.to_vec(), note.clone()));
            Ok(TEST_RECOVERY_AUTH.to_vec())
        })
        .unwrap();
    // The RecoveryAuth is made over the Commit as it is posted and its note, which names a join.
    let entry = c.outbox().remove(0);
    assert_eq!(
        (entry.id, entry.kind, entry.epoch),
        (id, OutboxKind::ExternalCommit, 1)
    );
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].0, entry.parts[0]);
    assert!(seen[0].1.join && seen[0].1.cuts.is_empty());
    assert_eq!(seen[0].1.room_epoch, 1);
    assert_eq!(entry.parts[3], TEST_RECOVERY_AUTH);

    // Built on a copy: until the hub answers, the device holds no group and no key, and is no human device.
    assert!(c.groups().unwrap().is_empty());
    assert!(!c.is_human());
    assert_eq!(c.content_key(&room_group, 2), Err(Error::NoKey));
    assert_eq!(
        c.join_from_outside(&info, now(), &mut |_, _| Ok(Vec::new())),
        Err(Error::Busy)
    );

    // Refused, the copy is dropped and nothing of it stays.
    c.outbox_refused(id, &Error::Overloaded).unwrap();
    assert!(c.outbox().is_empty() && c.groups().unwrap().is_empty());
    assert_eq!(c.content_key(&room_group, 2), Err(Error::NoKey));
    assert_eq!(hub.epoch(&room_group), Some(1));

    // Built again and accepted, the copy becomes the real state: the device is a human device.
    c.join_from_outside(&info, now(), &mut |_, _| Ok(TEST_RECOVERY_AUTH.to_vec()))
        .unwrap();
    post_ok(&mut hub, &mut c);
    assert_eq!(hub.epoch(&room_group), Some(2));
    assert!(c.is_human());
    let summary = c.group(&room_group).unwrap();
    assert_eq!((summary.epoch, summary.pending), (2, false));
    assert_eq!(summary.leaves, [a.id(), c.id()].into_iter().collect());
    assert!(hub.history().unwrap().newest().is_human(&c.id()));

    // The member follows the join, which the log carries with its RecoveryAuth.
    let item = hub.log.last().unwrap();
    assert_eq!(item.recovery_auth.as_deref(), Some(TEST_RECOVERY_AUTH));
    let processed = sync_ok(&hub, &mut a);
    let [Processed::Commit { facts, .. }] = &processed[..] else {
        panic!("one Commit: {processed:?}");
    };
    assert!(facts.external && facts.committer == c.id() && facts.external_inits == 1);
    assert_eq!(
        a.content_key(&room_group, 2).unwrap(),
        c.content_key(&room_group, 2).unwrap()
    );

    // It then joins the session group the same way: it is in H(r) now.
    settle(&hub, &mut agent);
    let session_info = hub.group_info(&main).unwrap().clone();
    c.join_from_outside(&session_info, now(), &mut |_, _| {
        Ok(TEST_RECOVERY_AUTH.to_vec())
    })
    .unwrap();
    assert_eq!(c.group(&main).err(), Some(Error::NotFound));
    post_ok(&mut hub, &mut c);
    for device in [&mut a, &mut agent] {
        settle(&hub, device);
        assert_eq!(
            device.content_key(&main, 2).unwrap(),
            c.content_key(&main, 2).unwrap()
        );
    }
    assert_eq!(
        c.group(&main).unwrap().leaves,
        [a.id(), agent.id(), c.id()].into_iter().collect()
    );
    // And is a full member: its own Commit is followed by the others.
    c.update(&main, true, now()).unwrap().unwrap();
    post_ok(&mut hub, &mut c);
    sync_ok(&hub, &mut a);
    assert_eq!(
        a.content_key(&main, 3).unwrap(),
        c.content_key(&main, 3).unwrap()
    );

    // A device that is a leaf joins no second time from outside: that would be the return of a device that
    // lost its state under its old key (4.3), with a Remove of its own leaf and no Cut.
    for group in [room_group, main] {
        let info = hub.group_info(&group).unwrap().clone();
        assert_eq!(
            c.join_from_outside(&info, now(), &mut |_, _| Ok(TEST_RECOVERY_AUTH.to_vec())),
            Err(Error::BadCommit)
        );
    }
    assert!(c.outbox().is_empty());
    // Nor does a join from outside reopen a session this device archived (5.2.10).
    a.archive(&main).unwrap();
    let session_info = hub.group_info(&main).unwrap().clone();
    assert_eq!(
        a.join_from_outside(&session_info, now(), &mut |_, _| Ok(
            TEST_RECOVERY_AUTH.to_vec()
        )),
        Err(Error::Gone)
    );
    assert!(a.outbox().is_empty());

    // An agent device does not become a human device this way (4.2), and a member's Commit carries no
    // RecoveryAuth.
    let info = hub.group_info(&room_group).unwrap().clone();
    agent
        .join_from_outside(&info, now(), &mut |_, _| Ok(TEST_RECOVERY_AUTH.to_vec()))
        .unwrap();
    assert_eq!(post_refused(&mut hub, &mut agent), [Error::BadCommit]);
}

#[test]
fn a_join_from_outside_that_lost_its_epoch_is_decided_by_the_log() {
    let (mut hub, mut a, _agent, room_group, main) = room_for_joins(true);
    let joins = TestRecovery {
        joins: true,
        ..TestRecovery::default()
    };
    let auth = || TEST_RECOVERY_AUTH.to_vec();
    let mut c = new_device_with(joins);
    observe(&hub, &mut c);
    settle(&hub, &mut c);

    // Another Commit takes the epoch the join was built on. The join is held back like a member's Commit:
    // out of the outbox, its copy kept, until the log shows which Commit took the epoch.
    let info = hub.group_info(&room_group).unwrap().clone();
    let lost = c
        .join_from_outside(&info, now(), &mut |_, _| Ok(auth()))
        .unwrap();
    a.update(&room_group, true, now()).unwrap().unwrap();
    post_ok(&mut hub, &mut a);
    assert_eq!(post_refused(&mut hub, &mut c), [Error::EpochTaken]);
    assert!(c.outbox().is_empty());
    assert_eq!(
        c.join_from_outside(&info, now(), &mut |_, _| Ok(auth())),
        Err(Error::Busy)
    );
    // It was the other device's: the join is dropped and said so, and the observer has followed that Commit.
    let processed = sync_ok(&hub, &mut c);
    let [Processed::JoinSuperseded {
        superseded,
        observed: Some(facts),
    }] = &processed[..]
    else {
        panic!("the join is superseded: {processed:?}");
    };
    assert_eq!((*superseded, facts.committer), (lost, a.id()));
    assert!(!c.is_human() && c.groups().unwrap().is_empty());
    assert_eq!(c.room_history().unwrap().newest().epoch, 2);

    // Built again on the new epoch, the hub takes it and loses its answer; a hub that forgot the post says
    // `epoch-taken` to the retry. The log shows the device's own Commit: the copy becomes the real state.
    let info = hub.group_info(&room_group).unwrap().clone();
    let id = c
        .join_from_outside(&info, now(), &mut |_, _| Ok(auth()))
        .unwrap();
    let entry = c.outbox().remove(0);
    hub.post(&c.id(), &entry).unwrap();
    c.outbox_refused(id, &Error::EpochTaken).unwrap();
    assert!(c.outbox().is_empty() && !c.is_human());
    assert_eq!(sync_ok(&hub, &mut c), [Processed::OwnCommit]);
    assert!(c.is_human() && c.outbox().is_empty());
    assert_eq!(c.group(&room_group).unwrap().epoch, 3);
    assert_eq!(c.cursor(), hub.change());
    sync_ok(&hub, &mut a);
    assert_eq!(
        a.content_key(&room_group, 3).unwrap(),
        c.content_key(&room_group, 3).unwrap()
    );

    // The same in a session group, which the joiner does not follow: the Commit that took the epoch is
    // nothing it can read, and the join is dropped for it all the same.
    let info = hub.group_info(&main).unwrap().clone();
    let lost = c
        .join_from_outside(&info, now(), &mut |_, _| Ok(auth()))
        .unwrap();
    a.update(&main, true, now()).unwrap().unwrap();
    post_ok(&mut hub, &mut a);
    assert_eq!(post_refused(&mut hub, &mut c), [Error::EpochTaken]);
    assert_eq!(
        sync_ok(&hub, &mut c),
        [Processed::JoinSuperseded {
            superseded: lost,
            observed: None
        }]
    );
    let info = hub.group_info(&main).unwrap().clone();
    c.join_from_outside(&info, now(), &mut |_, _| Ok(auth()))
        .unwrap();
    post_ok(&mut hub, &mut c);
    sync_ok(&hub, &mut a);
    assert_eq!(
        a.content_key(&main, 3).unwrap(),
        c.content_key(&main, 3).unwrap()
    );
}

/// The keys of `store` that belong to an observer, and those of the device's own record of the room's roles.
fn role_entries(store: &MemoryStorage) -> (usize, usize) {
    let entries = store.entries();
    let of = |sub: u8| {
        entries
            .iter()
            .filter(|entry| entry.key.starts_with(&[table::ROOM_STATE, sub]))
            .count()
    };
    (of(1), of(0))
}

#[test]
fn an_observer_that_becomes_a_leaf_keeps_what_it_verified() {
    let (mut hub, mut a, _agent, room_group, _) = room_for_joins(true);
    // Two devices follow the room group from here: one will join with the code, one by Welcome.
    let stores = [MemoryStorage::new(), MemoryStorage::new()];
    let handles = [stores[0].handle(), stores[1].handle()];
    let on = |store: MemoryStorage| -> TestDevice {
        let joins = TestRecovery {
            joins: true,
            ..TestRecovery::default()
        };
        Device::create(store, Box::new(SystemEntropy), Box::new(joins)).unwrap()
    };
    let [first, second] = stores;
    let (mut c, mut d) = (on(first), on(second));
    for device in [&mut c, &mut d] {
        observe(&hub, device);
        settle(&hub, device);
    }
    // A human device comes and is removed again: its key is revoked, and both observers saw it.
    let mut x = new_device();
    add_human(&mut hub, &mut a, &mut x);
    a.remove_human_devices(&[Cut::none(x.id())], now()).unwrap();
    post_ok(&mut hub, &mut a);
    let revoked_at = hub.epoch(&room_group).unwrap();
    for (device, handle) in [(&mut c, &handles[0]), (&mut d, &handles[1])] {
        sync_ok(&hub, device);
        assert!(device
            .room_history()
            .unwrap()
            .is_revoked(&x.id(), revoked_at));
        let (observer, own) = role_entries(handle);
        assert!(observer > 0 && own == 0);
    }

    // One joins with the code, the other is added and joins by Welcome.
    let info = hub.group_info(&room_group).unwrap().clone();
    c.join_from_outside(&info, now(), &mut |_, _| Ok(TEST_RECOVERY_AUTH.to_vec()))
        .unwrap();
    post_ok(&mut hub, &mut c);
    sync_ok(&hub, &mut a);
    sync_ok(&hub, &mut d);
    let package = d.key_package(now()).unwrap();
    a.add_human_device(&d.id(), &package, now()).unwrap();
    post_ok(&mut hub, &mut a);
    assert_eq!(settle_joining(&hub, &mut d).len(), 1);
    sync_ok(&hub, &mut c);

    let package = x.key_package(now()).unwrap();
    for (device, handle) in [(&mut c, &handles[0]), (&mut d, &handles[1])] {
        assert!(device.is_human());
        // The history it followed is its own now, from the epoch it began to follow, with the revocation
        // (4.2); the observer and everything stored of it is gone, in the write of the join.
        let roles = device.room_history().unwrap();
        assert_eq!(roles.newest(), hub.history().unwrap().newest());
        assert!(roles.is_revoked(&x.id(), revoked_at));
        assert_eq!(roles.states().next().unwrap().epoch, 1);
        let (observer, own) = role_entries(handle);
        assert_eq!(observer, 0);
        assert_eq!(own as u64, roles.newest().epoch);
        // So it builds no Add of the revoked key.
        assert_eq!(
            device.add_human_device(&x.id(), &package, now()),
            Err(Error::BadCommit)
        );
        // A restart finds the same device.
        let twin = reopen(handle.reopened()).unwrap();
        assert_eq!(twin.room_history(), device.room_history());
        assert_eq!(twin.groups().unwrap(), device.groups().unwrap());
    }

    // Commits of the room group reach the group it is a leaf of: it stands where the others stand and holds
    // the key of every epoch from its join on.
    a.update(&room_group, true, now()).unwrap().unwrap();
    post_ok(&mut hub, &mut a);
    let epoch = hub.epoch(&room_group).unwrap();
    for device in [&mut c, &mut d] {
        assert!(matches!(
            sync_ok(&hub, device)[..],
            [Processed::Commit { removed: false, .. }]
        ));
        assert_eq!(device.group(&room_group).unwrap().epoch, epoch);
        assert_eq!(
            device.content_key(&room_group, epoch).unwrap(),
            a.content_key(&room_group, epoch).unwrap()
        );
        assert_eq!(
            device.room_history().unwrap().newest(),
            hub.history().unwrap().newest()
        );
    }
}

#[test]
fn a_welcome_must_agree_with_what_the_observer_verified() {
    let (mut hub, mut a, _agent, room_group, _) = room_for_joins(true);
    let anyone = WelcomeExpectation {
        room: room_group.room_id(),
        committer: None,
    };
    // A Welcome into the room group beyond what the device followed comes too early: nothing is used up,
    // and once the device processed the log up to the Commit that added it, the Welcome is taken.
    let mut d = new_device();
    observe(&hub, &mut d);
    let from = hub.change();
    a.update(&room_group, true, now()).unwrap().unwrap();
    post_ok(&mut hub, &mut a);
    let package = d.key_package(now()).unwrap();
    a.add_human_device(&d.id(), &package, now()).unwrap();
    post_ok(&mut hub, &mut a);
    let welcome = hub.welcomes.last().unwrap().bytes.clone();
    assert_eq!(
        d.join_welcome(&welcome, &anyone, now()),
        Err(Error::RoomBehind)
    );
    assert!(d.groups().unwrap().is_empty() && !d.is_human());
    for item in hub.log_after(from) {
        process(&mut d, &item).unwrap();
    }
    let joined = d.join_welcome(&welcome, &anyone, now()).unwrap();
    assert_eq!(joined.epoch, hub.epoch(&room_group).unwrap());
    assert!(d.is_human());

    // A founder that obeys MLS only makes another group under the room's id and adds a device that follows
    // the real room. The state its Welcome brings is not the one the device verified at that epoch; and a
    // Welcome for an epoch before the one the device began to follow at says nothing it could check.
    let mut e = new_device();
    observe(&hub, &mut e);
    let followed = e.room_history().unwrap().clone();
    let epoch = followed.newest().epoch;
    assert!(epoch > 1);
    for at in [epoch, 1] {
        let founder = Founder::new();
        let mut other = founder.found_room(&room_group, &followed.newest().room);
        for _ in 1..at {
            founder.commit(&mut other, b"", &[]);
        }
        let package = e.key_package(now()).unwrap();
        let welcome = founder
            .commit(&mut other, b"", &[package])
            .welcome
            .expect("a Welcome");
        assert_eq!(
            e.join_welcome(&welcome, &anyone, now()),
            Err(Error::BadGroup),
            "a Welcome at epoch {at}"
        );
        assert!(e.groups().unwrap().is_empty() && !e.is_human());
        assert_eq!(e.room_history(), Some(&followed));
    }
    // It still follows the real room.
    a.update(&room_group, true, now()).unwrap().unwrap();
    post_ok(&mut hub, &mut a);
    assert!(matches!(
        process(&mut e, hub.log.last().unwrap()),
        Ok(Processed::Observed(_))
    ));
}

#[test]
fn a_request_whose_parts_do_not_belong_together_is_incomplete() {
    let World {
        mut hub,
        mut a,
        room_group,
        main,
        ..
    } = world(true);
    let room_epoch = hub.epoch(&room_group).unwrap();
    let old_info = hub.group_info(&room_group).unwrap().clone();
    let session_info = hub.group_info(&main).unwrap().clone();

    // An Add: Commit, GroupInfo, Welcome, SealedKey.
    let (device, package) = stranger();
    a.add_human_device(&device, &package, now()).unwrap();
    let entry = a.outbox().remove(0);
    assert_eq!(entry.kind, OutboxKind::Commit);
    assert!(entry.parts.iter().all(|part| !part.is_empty()));
    let with = |at: usize, part: &[u8]| {
        let mut changed = entry.clone();
        changed.parts[at] = part.to_vec();
        changed
    };
    let cases = [
        ("the GroupInfo of the epoch before", with(1, &old_info)),
        ("the GroupInfo of another group", with(1, &session_info)),
        ("no GroupInfo", with(1, &[])),
        ("bytes that are no GroupInfo", with(1, b"group info")),
        ("no Welcome for the Add", with(2, &[])),
        ("bytes that are no Welcome", with(2, &old_info)),
        ("no SealedKey", with(3, &[])),
        (
            "the SealedKey of another epoch",
            with(3, &hub.sealed_keys.last().unwrap().2.clone()),
        ),
    ];
    for (name, changed) in &cases {
        assert_eq!(hub.post(&a.id(), changed), Err(Error::Incomplete), "{name}");
        assert_eq!(hub.epoch(&room_group), Some(room_epoch), "{name}");
    }
    // A GroupInfo with one byte changed no longer verifies under the committer's key.
    let mut flipped = entry.clone();
    let last = flipped.parts[1].len() - 1;
    flipped.parts[1][last] ^= 1;
    assert_eq!(hub.post(&a.id(), &flipped), Err(Error::Incomplete));
    // The request as the device made it is taken.
    post_ok(&mut hub, &mut a);
    assert_eq!(hub.epoch(&room_group), Some(room_epoch + 1));

    // An update has no Add: a Welcome beside it does not belong.
    let welcome = entry.parts[2].clone();
    a.update(&room_group, true, now()).unwrap().unwrap();
    let mut update = a.outbox().remove(0);
    assert!(update.parts[2].is_empty());
    update.parts[2] = welcome;
    assert_eq!(hub.post(&a.id(), &update), Err(Error::Incomplete));
    post_ok(&mut hub, &mut a);
    assert_eq!(hub.epoch(&room_group), Some(room_epoch + 2));
}

#[test]
fn a_founding_whose_parts_do_not_belong_together_is_incomplete() {
    let World {
        mut hub,
        mut a,
        b,
        mut other,
        ..
    } = world(true);
    publish_some(&mut hub, &mut other, 1);
    let packages = hub.claim(&[b.id(), other.id()]).unwrap();
    let session = a.found_session(&other.id(), &packages, now()).unwrap();
    let group = GroupId::session(a.room().unwrap(), session);
    // GroupInfo of epoch 0, its SealedKey, the first Commit, its GroupInfo, its Welcome, its SealedKey.
    let entry = a.outbox().remove(0);
    assert_eq!(
        (entry.kind, entry.parts.len()),
        (OutboxKind::GroupFounding, 6)
    );
    let with = |at: usize, part: &[u8]| {
        let mut changed = entry.clone();
        changed.parts[at] = part.to_vec();
        changed
    };
    let cases = [
        ("no SealedKey of epoch 0", with(1, &[]), Error::Incomplete),
        (
            "the SealedKey of epoch 1 for epoch 0",
            with(1, &entry.parts[5]),
            Error::Incomplete,
        ),
        (
            "the GroupInfo of epoch 0 for epoch 1",
            with(3, &entry.parts[0]),
            Error::Incomplete,
        ),
        ("no Welcome", with(4, &[]), Error::Incomplete),
        ("no SealedKey of epoch 1", with(5, &[]), Error::Incomplete),
        ("no first Commit", with(2, &[]), Error::BadCommit),
    ];
    for (name, changed, code) in &cases {
        assert_eq!(hub.post(&a.id(), changed).as_ref(), Err(code), "{name}");
        assert_eq!(hub.epoch(&group), None, "{name}");
    }
    post_ok(&mut hub, &mut a);
    assert_eq!(hub.epoch(&group), Some(1));
}

#[test]
fn bytes_that_are_no_commit_are_refused_as_such() {
    let World {
        mut hub,
        mut a,
        mut b,
        room_group,
        main,
        ..
    } = world(true);
    let (device, package) = stranger();
    a.add_human_device(&device, &package, now()).unwrap();
    let entry = a.outbox().remove(0);
    b.send_handover(&room_group, &a.id()).unwrap();
    let message = b.outbox().remove(0).parts.remove(0);
    post_ok(&mut hub, &mut b);
    let cursor = b.cursor();

    // Whatever is not a Commit in a PublicMessage: garbage, nothing, a GroupInfo, a Welcome, a KeyPackage, an
    // application message, a Commit with a byte more or less. The spec's standalone proposal is refused at
    // the same place, by its content type; no operation of a device builds one.
    let mut longer = entry.parts[0].clone();
    longer.push(0);
    let shorter = entry.parts[0][..entry.parts[0].len() - 1].to_vec();
    let not_commits: [(&str, &[u8]); 8] = [
        ("garbage", b"\x00\x01\x00\x01 not a commit"),
        ("nothing", b""),
        ("a GroupInfo", &entry.parts[1]),
        ("a Welcome", &entry.parts[2]),
        ("a KeyPackage", &package),
        ("an application message", &message),
        ("a Commit with a trailing byte", &longer),
        ("a Commit cut short", &shorter),
    ];
    for (name, bytes) in not_commits {
        let mut changed = entry.clone();
        changed.parts[0] = bytes.to_vec();
        assert_eq!(hub.post(&a.id(), &changed), Err(Error::BadCommit), "{name}");
        // A member handed the same bytes as a Commit of the log keeps its state.
        let result = b.process_log_entry(&LogEntry {
            change: hub.change() + 1,
            group: room_group,
            kind: LogKind::Commit {
                bytes,
                recovery_auth: None,
            },
        });
        let error = result.expect_err(name);
        assert_eq!(error, Error::BadCommit, "{name}");
        assert_eq!(log_finding(&error), LogFinding::BadGroup, "{name}");
        assert_eq!(b.cursor(), cursor, "{name}");
    }
    assert_eq!(b.group(&room_group).unwrap().epoch, 3);

    // A Commit of one group posted for another, or handed to a member as another group's.
    let mut moved = entry.clone();
    moved.group = Some(main);
    moved.epoch = hub.epoch(&main).unwrap();
    assert_eq!(hub.post(&a.id(), &moved), Err(Error::BadCommit));
    let result = b.process_log_entry(&LogEntry {
        change: hub.change() + 1,
        group: main,
        kind: LogKind::Commit {
            bytes: &entry.parts[0],
            recovery_auth: None,
        },
    });
    assert_eq!(result, Err(Error::BadCommit));
    // A Commit posted by another device than its committer.
    assert_eq!(hub.post(&b.id(), &entry), Err(Error::WrongSender));
    // An application message that is no MLS message is passed over by its receivers (7.0).
    let result = b.process_log_entry(&LogEntry {
        change: hub.change() + 1,
        group: room_group,
        kind: LogKind::Message { bytes: b"garbage" },
    });
    assert_eq!(result, Ok(Processed::Skipped));
}
