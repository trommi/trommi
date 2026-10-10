//! A main session (5.2.2, 5.2.5): who holds which key, a founding that misses a KeyPackage, the last-resort
//! KeyPackage, and a device that cannot make the `SealedKey` of its Commits.

use trommi_core::device::{key_package_info, Processed, Received};
use trommi_core::ids::GroupId;
use trommi_core::invite::Role;
use trommi_core::Error;
use trommi_tests::forge::Forger;
use trommi_tests::join_invited;
use trommi_tests::{
    add_human, enrol, found_main, found_room, new_device, now, post_ok, process, publish_some,
    settle, sync_ok, try_invite, try_invite_at,
};

#[test]
fn a_session_is_shared_and_its_agent_holds_no_room_key() {
    let (mut a, mut b, mut agent) = (new_device(), new_device(), new_device());
    let (mut hub, room_group) = found_room(&mut a);
    add_human(&mut hub, &mut a, &mut b);
    enrol(&mut hub, &mut a, &mut agent);
    publish_some(&mut hub, &mut b, 1);
    publish_some(&mut hub, &mut agent, 1);
    let group = found_main(&mut hub, &mut a, &agent.id());
    settle(&hub, &mut b);
    settle(&hub, &mut agent);

    // The session group stands in epoch 1 with the two human devices and the agent device.
    assert_eq!(hub.epoch(&group), Some(1));
    let leaves = [a.id(), b.id(), agent.id()].into_iter().collect();
    for device in [&a, &b, &agent] {
        let summary = device.group(&group).unwrap();
        assert_eq!((summary.epoch, &summary.leaves), (1, &leaves));
        assert!(summary.disallowed.is_empty());
        assert!(summary.session.unwrap().parent.is_zero());
    }
    let key = a.content_key(&group, 1).unwrap();
    assert_eq!(b.content_key(&group, 1).unwrap(), key);
    assert_eq!(agent.content_key(&group, 1).unwrap(), key);
    // Epoch 0 was the founder's alone.
    assert!(a.content_key(&group, 0).is_ok());
    assert_eq!(b.content_key(&group, 0), Err(Error::NoKey));
    assert_eq!(agent.content_key(&group, 0), Err(Error::NoKey));

    // The agent device is no leaf of the room group and holds no key of it (5.3.4).
    assert!(!agent.is_human());
    assert!(a.is_human() && b.is_human());
    let held: Vec<GroupId> = agent.groups().unwrap().iter().map(|g| g.group).collect();
    assert_eq!(held, [group]);
    assert_eq!(agent.group(&room_group).err(), Some(Error::NotFound));
    let room_epoch = hub.epoch(&room_group).unwrap();
    assert_eq!(room_epoch, 2);
    for epoch in 0..=room_epoch {
        assert_eq!(agent.content_key(&room_group, epoch), Err(Error::NoKey));
    }
    assert!(!hub
        .observer(&room_group)
        .unwrap()
        .leaves()
        .unwrap()
        .contains(&agent.id()));
}

#[test]
fn the_content_keys_of_a_group_differ_per_epoch() {
    let (mut a, mut b, mut agent) = (new_device(), new_device(), new_device());
    let (mut hub, room_group) = found_room(&mut a);
    add_human(&mut hub, &mut a, &mut b);
    enrol(&mut hub, &mut a, &mut agent);
    publish_some(&mut hub, &mut b, 1);
    publish_some(&mut hub, &mut agent, 1);
    let group = found_main(&mut hub, &mut a, &agent.id());
    // An own-leaf update in each group.
    a.update(&room_group, true, now()).unwrap().unwrap();
    post_ok(&mut hub, &mut a);
    a.update(&group, true, now()).unwrap().unwrap();
    post_ok(&mut hub, &mut a);
    settle(&hub, &mut b);
    assert_eq!(hub.epoch(&room_group), Some(3));
    assert_eq!(hub.epoch(&group), Some(2));

    let mut keys = Vec::new();
    for epoch in 0..=3 {
        keys.push(a.content_key(&room_group, epoch).unwrap());
    }
    for epoch in 0..=2 {
        keys.push(a.content_key(&group, epoch).unwrap());
    }
    for (at, key) in keys.iter().enumerate() {
        assert!(
            keys.iter().skip(at + 1).all(|other| other != key),
            "key {at} is used once"
        );
    }
    // The second device derives the same keys from the epoch it joined at, and no other.
    assert_eq!(b.content_key(&room_group, 0), Err(Error::NoKey));
    for epoch in 1..=3 {
        assert_eq!(
            b.content_key(&room_group, epoch).unwrap(),
            a.content_key(&room_group, epoch).unwrap()
        );
    }
    assert_eq!(
        b.content_key(&group, 2).unwrap(),
        a.content_key(&group, 2).unwrap()
    );
    // No key is held for an epoch that was not reached.
    assert_eq!(a.content_key(&room_group, 4), Err(Error::NoKey));
}

#[test]
fn a_founding_with_a_missing_key_package_fails_and_is_tried_again() {
    let (mut a, mut b, mut agent) = (new_device(), new_device(), new_device());
    let (mut hub, room_group) = found_room(&mut a);
    add_human(&mut hub, &mut a, &mut b);
    enrol(&mut hub, &mut a, &mut agent);
    publish_some(&mut hub, &mut agent, 2);

    // The hub holds no KeyPackage of the second human device: the claim hands out nothing at all.
    assert_eq!(hub.claim(&[b.id(), agent.id()]), Err(Error::NotFound));
    assert_eq!(hub.unused(&agent.id()), 2);

    // With the agent's alone the founding is refused before anything is built or stored.
    let of_agent = hub.claim(&[agent.id()]).unwrap();
    assert_eq!(hub.unused(&agent.id()), 1);
    assert_eq!(
        a.found_session(&agent.id(), &of_agent, now()),
        Err(Error::Incomplete)
    );
    assert!(a.outbox().is_empty());
    assert_eq!(a.groups().unwrap().len(), 1);
    // Two KeyPackages of one device do not stand in for the missing one.
    let twice = [of_agent[0].clone(), of_agent[0].clone()];
    assert_eq!(
        a.found_session(&agent.id(), &twice, now()),
        Err(Error::BadKeyPackage)
    );
    assert!(a.outbox().is_empty());
    assert_eq!(hub.change(), 4);

    // Tried again with fresh ones; what was handed out stays used.
    publish_some(&mut hub, &mut b, 1);
    let fresh = hub.claim(&[b.id(), agent.id()]).unwrap();
    assert_ne!(fresh[1], of_agent[0]);
    assert_eq!(hub.unused(&agent.id()), 0);
    let session = a.found_session(&agent.id(), &fresh, now()).unwrap();
    post_ok(&mut hub, &mut a);
    let group = GroupId::session(room_group.room_id(), session);
    assert_eq!(hub.epoch(&group), Some(1));
    settle(&hub, &mut b);
    settle(&hub, &mut agent);
    assert_eq!(b.group(&group).unwrap().leaves.len(), 3);
    assert_eq!(
        agent.content_key(&group, 1).unwrap(),
        a.content_key(&group, 1).unwrap()
    );
}

#[test]
fn the_last_resort_key_package_serves_several_groups() {
    let (mut a, mut b) = (new_device(), new_device());
    let (mut hub, _) = found_room(&mut a);
    add_human(&mut hub, &mut a, &mut b);
    publish_some(&mut hub, &mut b, 1);
    let mut agents: Vec<_> = (0..8).map(|_| new_device()).collect();
    for agent in &mut agents {
        enrol(&mut hub, &mut a, agent);
        publish_some(&mut hub, agent, 1);
    }
    sync_ok(&hub, &mut b);

    // The first founding takes the single-use KeyPackage; it is handed out once.
    let single_use = hub.claim(&[b.id()]).unwrap().remove(0);
    assert!(!key_package_info(&single_use).unwrap().last_resort);
    assert_eq!(hub.unused(&b.id()), 0);
    // From then on the hub hands out the last-resort one, every time.
    let last_resort = hub.claim(&[b.id()]).unwrap().remove(0);
    assert!(key_package_info(&last_resort).unwrap().last_resort);
    assert_eq!(hub.claim(&[b.id()]).unwrap().first(), Some(&last_resort));

    let mut groups = Vec::new();
    for (at, agent) in agents.iter().enumerate() {
        let of_b = if at == 0 { &single_use } else { &last_resort };
        let of_agent = hub.claim(&[agent.id()]).unwrap().remove(0);
        let session = a
            .found_session(&agent.id(), &[of_b.clone(), of_agent], now())
            .unwrap();
        post_ok(&mut hub, &mut a);
        groups.push(GroupId::session(a.room().unwrap(), session));
    }
    // One last-resort KeyPackage opened the Welcomes of seven groups: a device added to more live sessions
    // than it has single-use KeyPackages left is not left out of any (5.2.5, 5.2.7).
    settle(&hub, &mut b);
    for group in &groups {
        assert_eq!(
            b.content_key(group, 1).unwrap(),
            a.content_key(group, 1).unwrap()
        );
    }
    assert_eq!(b.groups().unwrap().len(), 9);

    // `exhaust` plays a hub whose single-use ones were all claimed.
    publish_some(&mut hub, &mut b, 3);
    assert_eq!(hub.unused(&b.id()), 3);
    hub.exhaust(&b.id());
    assert_eq!(hub.claim(&[b.id()]).unwrap(), [last_resort]);
}

#[test]
fn a_human_device_without_the_recovery_mac_founds_nothing_and_commits_nothing() {
    // 7.4: a device that was added and has not yet been handed the recovery_mac of the key in force.
    let (mut a, mut b, mut agent) = (new_device(), new_device(), new_device());
    let (mut hub, room_group) = found_room(&mut a);
    try_invite(&mut a, &mut b, Role::Human, None).unwrap();
    post_ok(&mut hub, &mut a);
    join_invited(&hub, &mut b);
    enrol(&mut hub, &mut a, &mut agent);
    publish_some(&mut hub, &mut a, 1);
    publish_some(&mut hub, &mut agent, 1);
    // The message that carries the key has not reached it: it processes the Commits alone.
    for item in hub.log_after(b.cursor()).iter().filter(|item| item.commit) {
        process(&mut b, item).unwrap();
    }
    assert!(a.holds_recovery_mac() && !b.holds_recovery_mac());
    assert_eq!(b.update(&room_group, true, now()), Err(Error::NoKey));
    assert_eq!(b.remove_agents(&[agent.id()], now()), Err(Error::NoKey));
    // Nor does it let a device in: the Commit of an invite it confirms is not built.
    assert_eq!(
        try_invite(&mut b, &mut new_device(), Role::Human, None),
        Err(Error::NoKey)
    );
    let packages = hub.claim(&[a.id(), agent.id()]).unwrap();
    assert_eq!(
        b.found_session(&agent.id(), &packages, now()),
        Err(Error::NoKey)
    );
    assert!(b.outbox().is_empty());
    let summary = b.group(&room_group).unwrap();
    assert_eq!((summary.epoch, summary.pending), (2, false));
    assert_eq!(b.groups().unwrap().len(), 1);

    // Its state is whole: it follows the next Commit and derives the same key.
    a.update(&room_group, true, now()).unwrap().unwrap();
    post_ok(&mut hub, &mut a);
    sync_ok(&hub, &mut b);
    assert_eq!(
        b.content_key(&room_group, 3).unwrap(),
        a.content_key(&room_group, 3).unwrap()
    );
    // It asks, and a device that holds the recovery_mac sends it again (7.4): then it commits.
    assert!(!b.holds_recovery_mac());
    a.send_recovery_auth(&b.id()).unwrap();
    post_ok(&mut hub, &mut a);
    let processed = sync_ok(&hub, &mut b);
    assert!(matches!(
        processed.last(),
        Some(Processed::Message(Received::RecoveryAuth { from, new: true, .. })) if *from == a.id()
    ));
    assert!(b.holds_recovery_mac());
    b.update(&room_group, true, now()).unwrap().unwrap();
    post_ok(&mut hub, &mut b);
}

#[test]
fn the_own_leaf_update_counts_from_the_last_commit_with_a_path() {
    const HOUR_MS: u64 = 60 * 60 * 1000;
    const DAY_MS: u64 = 24 * HOUR_MS;
    let mut a = new_device();
    let start = now();
    let (mut hub, room_group) = found_room(&mut a);

    // A leaf younger than seven days needs no update (5.2.9).
    assert_eq!(a.update(&room_group, false, start + 6 * DAY_MS), Ok(None));
    // An Add on the sixth day: a Commit without a path, which leaves the committer's leaf as it was. The new
    // device's clock stands where the inviter's does (12.1.2), and its KeyPackage is valid by the real clock:
    // a member that makes its KeyPackage by OpenMLS alone.
    let joiner = Forger::new();
    try_invite_at(
        &mut a,
        &mut joiner.invitee(),
        Role::Human,
        None,
        start + 6 * DAY_MS,
    )
    .unwrap();
    post_ok(&mut hub, &mut a);
    // So the leaf is seven days old a day later, and the update is due.
    let due = a
        .update(&room_group, false, start + 7 * DAY_MS + HOUR_MS)
        .unwrap();
    assert!(due.is_some(), "the Add renewed nothing");
    post_ok(&mut hub, &mut a);
    // The update has a path: the next one is due seven days after it.
    assert_eq!(a.update(&room_group, false, start + 14 * DAY_MS), Ok(None));
    let due = a
        .update(&room_group, false, start + 14 * DAY_MS + 2 * HOUR_MS)
        .unwrap();
    assert!(due.is_some());
    post_ok(&mut hub, &mut a);
    assert_eq!(hub.epoch(&room_group), Some(3));
}
