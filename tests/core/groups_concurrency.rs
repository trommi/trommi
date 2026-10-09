//! Ordering (5.4, 13.2): one Commit per epoch, lost answers, duplicates, reordering, and catching up after
//! many changes across many groups, in the hub's order and in no other.

use std::collections::BTreeMap;
use trommi_core::device::{log_finding, LogFinding, Processed, Received};
use trommi_core::ids::{DeviceId, GroupId};
use trommi_core::mls::profile::Cut;
use trommi_core::Error;
use trommi_tests::hub::Hub;
use trommi_tests::{
    add_human, add_to_session, cuts_for, enrol, found_helper, found_main, found_room, new_device,
    new_device_on, now, observe, post_all, post_ok, post_refused, process, publish_some, reopen,
    settle, sync, sync_ok, MemoryStorage, TestDevice,
};

/// Two human devices in a room.
fn pair() -> (Hub, TestDevice, TestDevice, GroupId) {
    let (mut a, mut b) = (new_device(), new_device());
    let (mut hub, room_group) = found_room(&mut a);
    add_human(&mut hub, &mut a, &mut b);
    settle(&hub, &mut b);
    (hub, a, b, room_group)
}

#[test]
fn of_two_commits_for_one_epoch_the_hub_takes_the_first() {
    let (mut hub, mut a, mut b, room_group) = pair();
    let first = a.update(&room_group, true, now()).unwrap().unwrap();
    let second = b.update(&room_group, true, now()).unwrap().unwrap();
    assert_eq!(a.outbox()[0].id, first);
    let lost_bytes = b.outbox()[0].parts[0].clone();
    post_ok(&mut hub, &mut a);
    assert_eq!(hub.epoch(&room_group), Some(2));

    // While its Commit waits for the hub, a device sends no message in that group: it would be of the epoch
    // the Commit ends and reach the hub after it.
    assert_eq!(b.send_handover(&room_group, &a.id()), Err(Error::Busy));
    assert_eq!(b.outbox().len(), 1);

    // The loser hears `epoch-taken`: its Commit is held back, out of the outbox, until the log decides.
    assert_eq!(post_all(&mut hub, &mut b), [Err(Error::EpochTaken)]);
    assert!(b.outbox().is_empty());
    assert!(b.group(&room_group).unwrap().pending);
    assert_eq!(b.update(&room_group, true, now()), Err(Error::Busy));
    assert_eq!(b.send_handover(&room_group, &a.id()), Err(Error::Busy));
    assert_eq!(b.group(&room_group).unwrap().epoch, 1);

    // The log shows the Commit that took the epoch: the own one is dropped for it.
    let processed = sync_ok(&hub, &mut b);
    let [Processed::Commit {
        facts,
        superseded,
        removed: false,
    }] = &processed[..]
    else {
        panic!("one Commit: {processed:?}");
    };
    assert_eq!((facts.committer, facts.epoch), (a.id(), 1));
    assert_eq!(*superseded, Some(second));
    let summary = b.group(&room_group).unwrap();
    assert_eq!((summary.epoch, summary.pending), (2, false));
    assert!(b.outbox().is_empty());
    assert_eq!(
        b.content_key(&room_group, 2).unwrap(),
        a.content_key(&room_group, 2).unwrap()
    );

    // With nothing pending it sends again, and builds its change again, on the new epoch, and succeeds.
    b.send_handover(&room_group, &a.id()).unwrap();
    post_ok(&mut hub, &mut b);
    b.update(&room_group, true, now()).unwrap().unwrap();
    assert_ne!(b.outbox()[0].parts[0], lost_bytes);
    assert_eq!(b.outbox()[0].epoch, 2);
    post_ok(&mut hub, &mut b);
    sync_ok(&hub, &mut a);
    assert_eq!(hub.epoch(&room_group), Some(3));
    assert_eq!(
        a.content_key(&room_group, 3).unwrap(),
        b.content_key(&room_group, 3).unwrap()
    );
    // The dropped Commit never reached the log.
    assert!(hub.log.iter().all(|item| item.bytes != lost_bytes));
}

#[test]
fn a_lost_answer_is_met_with_the_same_bytes_and_the_same_answer() {
    let (mut hub, mut a, mut b, room_group) = pair();
    let id = a.update(&room_group, true, now()).unwrap().unwrap();
    let entry = a.outbox().remove(0);
    let accepted = hub.post(&a.id(), &entry).unwrap();
    let log_len = hub.log.len();

    // The answer is lost. The entry stays, byte for byte, and the hub answers the retry like the first post.
    assert_eq!(a.outbox(), std::slice::from_ref(&entry));
    assert!(a.group(&room_group).unwrap().pending);
    assert_eq!(hub.post(&a.id(), &entry), Ok(accepted));
    assert_eq!(hub.post(&a.id(), &entry), Ok(accepted));
    assert_eq!((hub.epoch(&room_group), hub.log.len()), (Some(2), log_len));
    a.outbox_accepted(id, accepted).unwrap();
    let summary = a.group(&room_group).unwrap();
    assert_eq!((summary.epoch, summary.pending), (2, false));
    assert!(a.outbox().is_empty());
    // An answer for an entry that is gone changes nothing.
    assert_eq!(a.outbox_accepted(id, accepted), Err(Error::NotFound));
    assert_eq!(
        a.outbox_refused(id, &Error::EpochTaken),
        Err(Error::NotFound)
    );
    // The log brings the own Commit by again: nothing more happens.
    assert_eq!(sync_ok(&hub, &mut a), [] as [Processed; 0]);
    sync_ok(&hub, &mut b);
    assert_eq!(
        a.content_key(&room_group, 2).unwrap(),
        b.content_key(&room_group, 2).unwrap()
    );
}

#[test]
fn an_own_commit_met_in_the_log_is_merged_there() {
    let (mut hub, mut a, mut b, room_group) = pair();

    // The answer is lost and the device simply processes the log.
    a.update(&room_group, true, now()).unwrap().unwrap();
    let entry = a.outbox().remove(0);
    hub.post(&a.id(), &entry).unwrap();
    assert_eq!(sync_ok(&hub, &mut a), [Processed::OwnCommit]);
    let summary = a.group(&room_group).unwrap();
    assert_eq!((summary.epoch, summary.pending), (2, false));
    assert!(a.outbox().is_empty());

    // The answer is lost and a hub that forgot the first post says `epoch-taken` to the retry: the log shows
    // that the Commit which took the epoch is the device's own.
    let id = a.update(&room_group, true, now()).unwrap().unwrap();
    let entry = a.outbox().remove(0);
    hub.post(&a.id(), &entry).unwrap();
    a.outbox_refused(id, &Error::EpochTaken).unwrap();
    assert!(a.outbox().is_empty());
    assert!(a.group(&room_group).unwrap().pending);
    assert_eq!(sync_ok(&hub, &mut a), [Processed::OwnCommit]);
    let summary = a.group(&room_group).unwrap();
    assert_eq!((summary.epoch, summary.pending), (3, false));

    let processed = sync_ok(&hub, &mut b);
    assert_eq!(processed.len(), 2);
    for epoch in 2..=3 {
        assert_eq!(
            a.content_key(&room_group, epoch).unwrap(),
            b.content_key(&room_group, epoch).unwrap()
        );
    }
}

#[test]
fn an_accepted_post_does_not_skip_what_the_hub_ordered_before_it() {
    let (mut a, mut b, mut agent) = (new_device(), new_device(), new_device());
    let (mut hub, room_group) = found_room(&mut a);
    add_human(&mut hub, &mut a, &mut b);
    enrol(&mut hub, &mut a, &mut agent);
    publish_some(&mut hub, &mut b, 1);
    publish_some(&mut hub, &mut agent, 1);
    let group = found_main(&mut hub, &mut a, &agent.id());
    settle(&hub, &mut b);

    // A room Commit the second device has not processed yet, then its own message in the session group.
    a.update(&room_group, true, now()).unwrap().unwrap();
    post_ok(&mut hub, &mut a);
    let cursor = b.cursor();
    b.send_handover(&group, &agent.id()).unwrap();
    post_ok(&mut hub, &mut b);
    assert_eq!(b.cursor(), cursor);

    // It still processes the room Commit, and passes over its own message.
    let processed = sync_ok(&hub, &mut b);
    assert!(matches!(
        &processed[..],
        [Processed::Commit { facts, .. }, Processed::Skipped] if facts.group == room_group
    ));
    assert_eq!(b.cursor(), hub.change());
    assert_eq!(
        b.group(&room_group).unwrap().epoch,
        hub.epoch(&room_group).unwrap()
    );
    // With nothing in between, the answer itself moves the cursor.
    b.update(&group, true, now()).unwrap().unwrap();
    post_ok(&mut hub, &mut b);
    assert_eq!(b.cursor(), hub.change());
}

#[test]
fn duplicates_and_reordered_entries_are_refused_and_change_nothing() {
    let (mut a, mut b, mut agent) = (new_device(), new_device(), new_device());
    let (mut hub, room_group) = found_room(&mut a);
    add_human(&mut hub, &mut a, &mut b);
    enrol(&mut hub, &mut a, &mut agent);
    publish_some(&mut hub, &mut b, 1);
    publish_some(&mut hub, &mut agent, 1);
    let group = found_main(&mut hub, &mut a, &agent.id());
    settle(&hub, &mut b);
    let start = b.cursor();

    // Two room Commits, a session Commit that names the newest room epoch, and a message in the room group.
    for _ in 0..2 {
        a.update(&room_group, true, now()).unwrap().unwrap();
        post_ok(&mut hub, &mut a);
    }
    a.update(&group, true, now()).unwrap().unwrap();
    post_ok(&mut hub, &mut a);
    a.send_handover(&room_group, &b.id()).unwrap();
    post_ok(&mut hub, &mut a);
    let [room_1, room_2, session_1, message] = &hub.log_after(start)[..] else {
        panic!("four entries");
    };
    let state = |device: &TestDevice| {
        (
            device.group(&room_group).unwrap().epoch,
            device.group(&group).unwrap().epoch,
        )
    };
    assert_eq!(state(&b), (2, 1));

    // Out of order: a Commit that is not the next of its group, a session Commit whose room epoch the device
    // has not reached, a message of an epoch it has not reached. Each is early and changes nothing.
    let early = [
        (room_2, Error::GroupBehind),
        (session_1, Error::RoomBehind),
        (message, Error::GroupBehind),
    ];
    for (item, code) in early {
        let error = process(&mut b, item).unwrap_err();
        assert_eq!(error, code);
        assert_eq!(log_finding(&error), LogFinding::Early);
        assert_eq!(state(&b), (2, 1));
        assert_eq!(b.cursor(), start);
    }
    assert_eq!(b.content_key(&room_group, 3), Err(Error::NoKey));

    // In order they process.
    for item in [room_1, room_2, session_1] {
        assert!(matches!(
            process(&mut b, item),
            Ok(Processed::Commit { .. })
        ));
    }
    assert!(matches!(
        process(&mut b, message),
        Ok(Processed::Message(Received::Keys { last: true, .. }))
    ));
    assert_eq!(state(&b), (4, 2));
    let keys = (
        b.content_key(&room_group, 4).unwrap(),
        b.content_key(&group, 2).unwrap(),
    );

    // Each of them a second time: it lies at or below the cursor, a duplicate, whatever it holds.
    for item in [room_1, room_2, session_1, message] {
        let error = process(&mut b, item).unwrap_err();
        assert_eq!(error, Error::WrongEpoch);
        assert_eq!(log_finding(&error), LogFinding::Duplicate);
    }
    assert_eq!(state(&b), (4, 2));
    assert_eq!(b.content_key(&room_group, 4).unwrap(), keys.0);
    assert_eq!(b.content_key(&group, 2).unwrap(), keys.1);
    assert_eq!(b.cursor(), hub.change());

    // The hub refuses a repeated Commit for a taken epoch and an application message of a past epoch.
    a.update(&room_group, true, now()).unwrap().unwrap();
    b.send_handover(&room_group, &a.id()).unwrap();
    post_ok(&mut hub, &mut a);
    assert_eq!(post_refused(&mut hub, &mut b), [Error::WrongEpoch]);
    sync_ok(&hub, &mut b);

    // The same Commits under a change number the hub never gave them, above the cursor: each lies behind
    // its group's epoch, and the message opens no second time.
    let mut again = hub.change();
    for item in [room_1, room_2, session_1] {
        again += 1;
        let mut moved = item.clone();
        moved.change = again;
        let error = process(&mut b, &moved).unwrap_err();
        assert_eq!(error, Error::WrongEpoch);
        assert_eq!(log_finding(&error), LogFinding::Duplicate);
    }
    let mut moved = message.clone();
    moved.change = again + 1;
    assert_eq!(process(&mut b, &moved), Ok(Processed::Skipped));
    assert_eq!(b.cursor(), again + 1);

    // An entry that the hub calls a message and that holds a Commit of a group the device is a leaf of is
    // not passed over like a message that does not open: it is refused, and the cursor stays.
    a.update(&group, true, now()).unwrap().unwrap();
    post_ok(&mut hub, &mut a);
    let mut mislabelled = hub.log.last().unwrap().clone();
    assert!(mislabelled.commit);
    mislabelled.change = b.cursor() + 1;
    mislabelled.commit = false;
    let error = process(&mut b, &mislabelled).unwrap_err();
    assert_eq!(error, Error::BadFormat);
    assert_eq!(log_finding(&error), LogFinding::BadGroup);
    assert_eq!((b.cursor(), state(&b)), (again + 1, (5, 2)));
    // Filed under another group it is still what it is: the group is the one the message names.
    mislabelled.group = room_group;
    assert_eq!(process(&mut b, &mislabelled), Err(Error::BadFormat));
    assert_eq!((b.cursor(), state(&b)), (again + 1, (5, 2)));
    mislabelled.group = group;
    // Called what it is, it processes.
    mislabelled.commit = true;
    assert!(matches!(
        process(&mut b, &mislabelled),
        Ok(Processed::Commit { .. })
    ));
    assert_eq!(state(&b), (5, 3));
}

#[test]
fn a_device_catches_up_on_two_hundred_commits() {
    const COMMITS: u64 = 200;
    let (mut hub, mut a, mut b, room_group) = pair();
    for _ in 0..COMMITS {
        a.update(&room_group, true, now()).unwrap().unwrap();
        post_ok(&mut hub, &mut a);
    }
    assert_eq!(hub.epoch(&room_group), Some(1 + COMMITS));
    assert_eq!(b.group(&room_group).unwrap().epoch, 1);

    let processed = sync_ok(&hub, &mut b);
    assert_eq!(processed.len() as u64, COMMITS);
    assert!(processed.iter().all(|done| matches!(
        done,
        Processed::Commit {
            removed: false,
            superseded: None,
            ..
        }
    )));
    assert_eq!(b.group(&room_group).unwrap().epoch, 1 + COMMITS);
    // It holds every epoch's key afterwards.
    for epoch in 1..=1 + COMMITS {
        assert_eq!(
            b.content_key(&room_group, epoch).unwrap(),
            a.content_key(&room_group, epoch).unwrap()
        );
    }
    // And is a full member: its own Commit is followed by the other.
    b.update(&room_group, true, now()).unwrap().unwrap();
    post_ok(&mut hub, &mut b);
    sync_ok(&hub, &mut a);
    assert_eq!(
        a.content_key(&room_group, 2 + COMMITS).unwrap(),
        b.content_key(&room_group, 2 + COMMITS).unwrap()
    );
}

#[test]
fn a_device_catches_up_across_twenty_groups_in_the_hubs_order_only() {
    const SESSIONS: usize = 19;
    const ROUNDS: usize = 78;
    let store = MemoryStorage::new();
    let handle = store.handle();
    let (mut a, mut b) = (new_device(), new_device_on(store));
    let (mut hub, room_group) = found_room(&mut a);
    add_human(&mut hub, &mut a, &mut b);
    publish_some(&mut hub, &mut b, 0);

    // Nineteen main sessions; with the room group, twenty groups.
    let mut agents: Vec<DeviceId> = Vec::new();
    for _ in 0..SESSIONS {
        let mut agent = new_device();
        publish_some(&mut hub, &mut agent, 0);
        agents.push(agent.id());
    }
    a.change_agents(&agents, &[], now()).unwrap();
    post_ok(&mut hub, &mut a);
    let groups: Vec<GroupId> = agents
        .iter()
        .map(|agent| found_main(&mut hub, &mut a, agent))
        .collect();
    settle(&hub, &mut b);
    assert_eq!(b.groups().unwrap().len(), SESSIONS + 1);
    let start = hub.change();
    assert_eq!(b.cursor(), start);

    // The second device is away while devices come and go: per round a human device joins the room and three
    // sessions and is handed the history, three other sessions are updated, every other round a session is
    // taken over by a new agent device, and the human device is removed again from the room and its sessions.
    let mut handovers = 0;
    for round in 0..ROUNDS {
        let mut guest = new_device();
        add_human(&mut hub, &mut a, &mut guest);
        // The handover grows with the history: beyond 400 keys it takes several messages.
        handovers += a.send_handover(&room_group, &guest.id()).unwrap().len();
        post_ok(&mut hub, &mut a);
        for offset in 0..3 {
            let group = groups[(round + offset) % SESSIONS];
            add_to_session(&mut hub, &mut a, &mut guest, &group);
        }
        for offset in 3..6 {
            let group = groups[(round * 5 + offset) % SESSIONS];
            a.update(&group, true, now()).unwrap().unwrap();
            post_ok(&mut hub, &mut a);
        }
        if round % 2 == 0 {
            let at = (round * 7 + 11) % SESSIONS;
            let mut new = new_device();
            a.change_agents(&[new.id()], &[agents[at]], now()).unwrap();
            post_ok(&mut hub, &mut a);
            let package = new.key_package(now()).unwrap();
            let cuts = cuts_for(&a, &groups[at]);
            assert_eq!(cuts, [Cut::none(agents[at])]);
            a.clean_session(&groups[at], &cuts, Some((&new.id(), &package)), now())
                .unwrap();
            post_ok(&mut hub, &mut a);
            agents[at] = new.id();
        }
        a.remove_human_devices(&[Cut::none(guest.id())], now())
            .unwrap();
        post_ok(&mut hub, &mut a);
        for offset in 0..3 {
            let group = groups[(round + offset) % SESSIONS];
            let cuts = cuts_for(&a, &group);
            assert_eq!(cuts, [Cut::none(guest.id())]);
            a.clean_session(&group, &cuts, None, now()).unwrap();
            post_ok(&mut hub, &mut a);
        }
    }
    let changes = (hub.change() - start) as usize;
    assert_eq!(changes, ROUNDS * 11 + ROUNDS / 2 * 2 + handovers);
    assert!(changes >= 1000 && handovers > ROUNDS);
    let log = hub.log_after(start);
    assert_eq!(log.len(), changes);

    // The same log in another order, on a copy of the device: back to front. An entry that is not the next of
    // its group is early, whatever came before, and changes nothing; at most the first Commit of each group
    // finds its place.
    let mut twin = reopen(handle.reopened()).unwrap();
    let epochs = |device: &TestDevice| -> BTreeMap<GroupId, u64> {
        device
            .groups()
            .unwrap()
            .into_iter()
            .map(|summary| (summary.group, summary.epoch))
            .collect()
    };
    let before = epochs(&twin);
    let (mut early, mut merged) = (0usize, 0usize);
    for item in log.iter().rev() {
        let held = epochs(&twin);
        let next = held.get(&item.group) == Some(&item.epoch);
        match process(&mut twin, item) {
            Ok(Processed::Commit { .. }) => {
                assert!(
                    item.commit && next,
                    "only the next Commit of a group is merged"
                );
                merged += 1;
            }
            Ok(Processed::Skipped) => assert!(!item.commit),
            Ok(other) => panic!("nothing else processes out of order: {other:?}"),
            Err(error) => {
                assert_eq!(log_finding(&error), LogFinding::Early, "{error:?}");
                assert_eq!(
                    error,
                    if next && item.commit {
                        Error::RoomBehind
                    } else {
                        Error::GroupBehind
                    }
                );
                assert_eq!(epochs(&twin), held);
                early += 1;
            }
        }
    }
    assert!(merged <= SESSIONS + 1);
    assert!(
        early >= changes - handovers - (SESSIONS + 1),
        "{early} of {changes}"
    );
    for (group, epoch) in epochs(&twin) {
        assert!(epoch <= before[&group] + 1);
    }
    drop(twin);

    // In the hub's order every entry processes.
    let processed = sync_ok(&hub, &mut b);
    assert_eq!(processed.len(), changes);
    let commits = processed
        .iter()
        .filter(|done| matches!(done, Processed::Commit { removed: false, .. }))
        .count();
    let dropped = processed
        .iter()
        .filter(|done| matches!(done, Processed::Message(Received::Dropped)))
        .count();
    assert_eq!((commits, dropped), (changes - handovers, handovers));
    assert_eq!(b.cursor(), hub.change());

    // The device stands where the hub and the device that made the changes stand, in all twenty groups.
    let mine = epochs(&b);
    assert_eq!(mine.len(), SESSIONS + 1);
    assert_eq!(mine, epochs(&a));
    for (at, group) in groups.iter().enumerate() {
        let summary = b.group(group).unwrap();
        assert_eq!(Some(summary.epoch), hub.epoch(group));
        assert_eq!(
            summary.leaves,
            hub.observer(group).unwrap().leaves().unwrap()
        );
        assert_eq!(
            summary.leaves,
            [a.id(), b.id(), agents[at]].into_iter().collect()
        );
        assert!(summary.disallowed.is_empty());
        for epoch in 1..=summary.epoch {
            assert_eq!(
                b.content_key(group, epoch).unwrap(),
                a.content_key(group, epoch).unwrap()
            );
        }
    }
    let room_epoch = hub.epoch(&room_group).unwrap();
    assert_eq!(mine[&room_group], room_epoch);
    for epoch in 1..=room_epoch {
        assert_eq!(
            b.content_key(&room_group, epoch).unwrap(),
            a.content_key(&room_group, epoch).unwrap()
        );
    }
    assert_eq!(
        b.room_history().unwrap().newest(),
        hub.history().unwrap().newest()
    );
}

#[test]
fn a_takeover_races_with_a_helper_founding() {
    let (mut a, mut old) = (new_device(), new_device());
    let (mut hub, _) = found_room(&mut a);
    enrol(&mut hub, &mut a, &mut old);
    publish_some(&mut hub, &mut a, 0);
    publish_some(&mut hub, &mut old, 1);
    let main = found_main(&mut hub, &mut a, &old.id());
    settle(&hub, &mut old);
    let parent = main.session_id().unwrap();

    // The opener builds a helper founding; the room Commit of the takeover reaches the hub first.
    let packages = hub.claim(&[a.id()]).unwrap();
    let lost = old.found_helper(&parent, &packages, now()).unwrap();
    let mut new = new_device();
    a.change_agents(&[new.id()], &[old.id()], now()).unwrap();
    post_ok(&mut hub, &mut a);
    observe(&hub, &mut new);
    // The founding names the room epoch before it and is refused; the device drops the group it had made.
    assert_eq!(post_refused(&mut hub, &mut old), [Error::RoomBehind]);
    let lost = GroupId::session(main.room_id(), lost);
    assert_eq!(hub.epoch(&lost), None);
    assert_eq!(old.group(&lost).err(), Some(Error::NotFound));
    assert_eq!(old.content_key(&lost, 0), Err(Error::NoKey));
    // Tried again on the new room state it is refused for good: the device is no agent device any more.
    settle(&hub, &mut old);
    let packages = hub.claim(&[a.id()]).unwrap();
    old.found_helper(&parent, &packages, now()).unwrap();
    assert_eq!(post_refused(&mut hub, &mut old), [Error::BadCommit]);
    let package = new.key_package(now()).unwrap();
    a.clean_session(
        &main,
        &cuts_for(&a, &main),
        Some((&new.id(), &package)),
        now(),
    )
    .unwrap();
    post_ok(&mut hub, &mut a);
    settle(&hub, &mut new);
    settle(&hub, &mut old);

    // The other way round: the new opener's founding reaches the hub first, then the next takeover's room
    // Commit. The helper session exists and is stale with its main session until both are cleaned.
    let helper = found_helper(&mut hub, &mut new, &main, &mut []);
    let mut third = new_device();
    a.change_agents(&[third.id()], &[new.id()], now()).unwrap();
    post_ok(&mut hub, &mut a);
    observe(&hub, &mut third);
    assert_eq!(hub.epoch(&helper), Some(1));
    for group in [main, helper] {
        assert_eq!(hub.stale_leaves(&group).unwrap(), [new.id()]);
    }
    // The human device learns of the helper session from the log, joins it, and finishes the takeover in
    // both groups: the main session first.
    let results = sync(&hub, &mut a);
    assert!(results.iter().all(Result::is_ok));
    for group in [main, helper] {
        let package = third.key_package(now()).unwrap();
        assert_eq!(a.group(&group).unwrap().disallowed, [new.id()]);
        a.clean_session(
            &group,
            &cuts_for(&a, &group),
            Some((&third.id(), &package)),
            now(),
        )
        .unwrap();
        post_ok(&mut hub, &mut a);
        assert!(hub.stale_leaves(&group).unwrap().is_empty());
    }
    settle(&hub, &mut third);
    for group in [main, helper] {
        assert_eq!(
            third.group(&group).unwrap().leaves,
            [a.id(), third.id()].into_iter().collect()
        );
        assert!(a.group(&group).unwrap().disallowed.is_empty());
        assert!(third
            .content_key(&group, hub.epoch(&group).unwrap())
            .is_ok());
    }
    assert_eq!(
        third.content_key(&main, hub.epoch(&main).unwrap()).unwrap(),
        a.content_key(&main, hub.epoch(&main).unwrap()).unwrap()
    );
    // Open point: the human device joined the helper session after the room Commit that revoked its founder,
    // and its first contact (5.2.6) judges the group against the newest room state, not the one of the
    // founding: it holds the group as distrusted and hands out no key of it, so the keys of the helper session
    // are not compared here.
}

#[test]
fn a_welcome_taken_late_is_caught_up_from_its_place_in_the_log() {
    let (mut a, mut b, mut agent) = (new_device(), new_device(), new_device());
    let (mut hub, room_group) = found_room(&mut a);
    enrol(&mut hub, &mut a, &mut agent);
    publish_some(&mut hub, &mut agent, 1);
    let group = found_main(&mut hub, &mut a, &agent.id());
    add_human(&mut hub, &mut a, &mut b);
    settle(&hub, &mut b);

    // The device is added to the session group, and the group and the room go on.
    let from = hub.change();
    let package = b.key_package(now()).unwrap();
    a.add_to_session(&group, &b.id(), &package, now()).unwrap();
    post_ok(&mut hub, &mut a);
    let welcome = hub.welcomes.last().unwrap().bytes.clone();
    for target in [group, room_group, group] {
        a.update(&target, true, now()).unwrap().unwrap();
        post_ok(&mut hub, &mut a);
    }
    // It processes the log without taking its Welcome: the session's entries are not for it yet, and the
    // cursor passes them.
    let log = hub.log_after(from);
    let done: Vec<_> = log.iter().map(|item| process(&mut b, item)).collect();
    assert!(matches!(
        &done[..],
        [
            Ok(Processed::Skipped),
            Ok(Processed::Skipped),
            Ok(Processed::Commit { .. }),
            Ok(Processed::Skipped)
        ]
    ));
    assert_eq!(b.cursor(), hub.change());

    // It takes the Welcome now, and hands the entries again from the Welcome's place. Those of the group it
    // just joined that are its next Commits process, below the cursor; every other one is a duplicate.
    let expected = trommi_core::device::WelcomeExpectation {
        room: room_group.room_id(),
        committer: Some(a.id()),
    };
    let joined = b.join_welcome(&welcome, &expected, now()).unwrap();
    assert_eq!((joined.group, joined.epoch), (group, 2));
    let again: Vec<_> = log.iter().map(|item| process(&mut b, item)).collect();
    assert!(matches!(
        &again[..],
        [
            Err(Error::WrongEpoch),
            Ok(Processed::Commit { .. }),
            Err(Error::WrongEpoch),
            Ok(Processed::Commit { .. })
        ]
    ));
    assert_eq!(b.cursor(), hub.change());
    let epoch = hub.epoch(&group).unwrap();
    assert_eq!(b.group(&group).unwrap().epoch, epoch);
    for at in 2..=epoch {
        assert_eq!(
            b.content_key(&group, at).unwrap(),
            a.content_key(&group, at).unwrap()
        );
    }
    // A third time every one of them is a duplicate.
    for item in &log {
        assert_eq!(process(&mut b, item), Err(Error::WrongEpoch));
    }
}
