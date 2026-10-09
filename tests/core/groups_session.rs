//! A main session (5.2.2, 5.2.5): who holds which key, a founding that misses a KeyPackage, the last-resort
//! KeyPackage, and a device that cannot make the `SealedKey` of its Commits.

use trommi_core::device::key_package_info;
use trommi_core::ids::GroupId;
use trommi_core::Error;
use trommi_tests::{
    add_human, enrol, found_main, found_room, new_device, new_device_with, now, post_ok,
    publish_some, settle, sync_ok, TestRecovery,
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
    assert_eq!(hub.change(), 3);

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
    let mut agents = [new_device(), new_device(), new_device()];
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
    // One last-resort KeyPackage opened the Welcomes of two groups.
    settle(&hub, &mut b);
    for group in &groups {
        assert_eq!(
            b.content_key(group, 1).unwrap(),
            a.content_key(group, 1).unwrap()
        );
    }
    assert_eq!(b.groups().unwrap().len(), 4);

    // `exhaust` plays a hub whose single-use ones were all claimed.
    publish_some(&mut hub, &mut b, 3);
    assert_eq!(hub.unused(&b.id()), 3);
    hub.exhaust(&b.id());
    assert_eq!(hub.claim(&[b.id()]).unwrap(), [last_resort]);
}

#[test]
fn a_device_that_cannot_seal_founds_nothing_and_commits_nothing() {
    let cannot_seal = TestRecovery {
        cannot_seal: true,
        ..TestRecovery::default()
    };
    // It founds no room.
    let mut alone = new_device_with(cannot_seal);
    assert_eq!(
        alone.found_room([0xE1; 32], [0xE2; 32], now()),
        Err(Error::NoKey)
    );
    assert!(alone.outbox().is_empty());
    assert_eq!(alone.room(), None);
    assert!(alone.groups().unwrap().is_empty());

    // As a human device of a room it commits nothing and founds no session.
    let (mut a, mut b, mut agent) = (new_device(), new_device_with(cannot_seal), new_device());
    let (mut hub, room_group) = found_room(&mut a);
    add_human(&mut hub, &mut a, &mut b);
    enrol(&mut hub, &mut a, &mut agent);
    publish_some(&mut hub, &mut a, 1);
    publish_some(&mut hub, &mut agent, 1);
    sync_ok(&hub, &mut b);
    assert_eq!(b.update(&room_group, true, now()), Err(Error::NoKey));
    assert_eq!(
        b.change_agents(&[], &[agent.id()], now()),
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
}
