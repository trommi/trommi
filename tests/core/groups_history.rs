//! History for a device that comes later (6.2, 6.3, 7.1): old content keys travel in a key handover, are
//! taken once, never replace a held key and never reach a device they are not for.

use trommi_core::codec;
use trommi_core::crypto::Secret;
use trommi_core::device::{Processed, Received};
use trommi_core::ids::{GroupId, RoomId, SessionId};
use trommi_core::mls::message::{EpochKey, TrommiMessage};
use trommi_core::Error;
use trommi_tests::forge::Forger;
use trommi_tests::hub::Hub;
use trommi_tests::{
    add_forger, add_human, add_to_session, enrol, found_main, found_room, new_device, now, post_ok,
    process, publish_some, settle, sync_ok, TestDevice,
};

/// A room of one human device with one main session, each group some epochs old.
fn room_with_history() -> (Hub, TestDevice, TestDevice, GroupId, GroupId) {
    let (mut a, mut agent) = (new_device(), new_device());
    let (mut hub, room_group) = found_room(&mut a);
    enrol(&mut hub, &mut a, &mut agent);
    publish_some(&mut hub, &mut agent, 1);
    let group = found_main(&mut hub, &mut a, &agent.id());
    for _ in 0..2 {
        a.update(&room_group, true, now()).unwrap().unwrap();
        post_ok(&mut hub, &mut a);
        a.update(&group, true, now()).unwrap().unwrap();
        post_ok(&mut hub, &mut a);
    }
    settle(&hub, &mut agent);
    assert_eq!(hub.epoch(&room_group), Some(3));
    assert_eq!(hub.epoch(&group), Some(3));
    (hub, a, agent, room_group, group)
}

fn keys_received(processed: &[Processed]) -> Vec<&Received> {
    processed
        .iter()
        .filter_map(|done| match done {
            Processed::Message(received) => Some(received),
            _ => None,
        })
        .collect()
}

#[test]
fn a_new_human_device_is_handed_every_old_key() {
    let (mut hub, mut a, mut agent, room_group, group) = room_with_history();
    let mut b = new_device();
    add_human(&mut hub, &mut a, &mut b);
    // It holds the key of the epoch it joined at and nothing older.
    assert_eq!(b.group(&room_group).unwrap().epoch, 4);
    for epoch in 0..4 {
        assert_eq!(b.content_key(&room_group, epoch), Err(Error::NoKey));
    }
    let joined_key = b.content_key(&room_group, 4).unwrap();

    // The adder hands over, in the room group, every key it holds for every group of the room.
    let sent = a.send_handover(&room_group, &b.id()).unwrap();
    assert_eq!(sent.len(), 1);
    assert_eq!(a.handovers_sent(), [(b.id(), room_group)]);
    post_ok(&mut hub, &mut a);
    let processed = sync_ok(&hub, &mut b);
    // Room epochs 0 to 3 and session epochs 0 to 3 are new to it; the room key of epoch 4 it holds already.
    assert_eq!(
        keys_received(&processed),
        [&Received::Keys {
            from: a.id(),
            taken: 8,
            last: true
        }]
    );
    for epoch in 0..=3 {
        assert_eq!(
            b.content_key(&room_group, epoch).unwrap(),
            a.content_key(&room_group, epoch).unwrap()
        );
        assert_eq!(
            b.content_key(&group, epoch).unwrap(),
            a.content_key(&group, epoch).unwrap()
        );
    }
    assert_eq!(b.content_key(&room_group, 4).unwrap(), joined_key);

    // The sender keeps the record until the recipient is seen to read.
    a.handover_read(&room_group, &b.id()).unwrap();
    assert!(a.handovers_sent().is_empty());

    // It is then added to the session and derives that group's keys from there on by itself.
    add_to_session(&mut hub, &mut a, &mut b, &group);
    settle(&hub, &mut b);
    settle(&hub, &mut agent);
    assert_eq!(b.group(&group).unwrap().epoch, 4);
    assert_eq!(
        b.content_key(&group, 4).unwrap(),
        agent.content_key(&group, 4).unwrap()
    );

    // A second handover brings nothing new and replaces nothing.
    a.send_handover(&room_group, &b.id()).unwrap();
    post_ok(&mut hub, &mut a);
    let processed = sync_ok(&hub, &mut b);
    assert_eq!(
        keys_received(&processed),
        [&Received::Keys {
            from: a.id(),
            taken: 0,
            last: true
        }]
    );
    assert_eq!(b.content_key(&room_group, 4).unwrap(), joined_key);
}

#[test]
fn a_handover_is_for_its_recipient_only() {
    let (mut hub, mut a, _agent, room_group, _) = room_with_history();
    let (mut b, mut c) = (new_device(), new_device());
    add_human(&mut hub, &mut a, &mut b);
    add_human(&mut hub, &mut a, &mut c);
    sync_ok(&hub, &mut b);
    a.send_handover(&room_group, &c.id()).unwrap();
    post_ok(&mut hub, &mut a);

    // The other human device opens the message and takes nothing from it.
    let processed = sync_ok(&hub, &mut b);
    assert_eq!(keys_received(&processed), [&Received::Dropped]);
    assert_eq!(b.content_key(&room_group, 0), Err(Error::NoKey));
    let processed = sync_ok(&hub, &mut c);
    assert!(matches!(
        keys_received(&processed)[..],
        [&Received::Keys { last: true, .. }]
    ));
    assert_eq!(
        c.content_key(&room_group, 0).unwrap(),
        a.content_key(&room_group, 0).unwrap()
    );
    // The hub's answer moved the sender's cursor past its own message: met again it is a duplicate. Where
    // the log brings it by above the cursor, the sender cannot open it (3.6) and skips it.
    let mut own = hub.log.last().unwrap().clone();
    assert!(!own.commit);
    assert_eq!(process(&mut a, &own), Err(Error::WrongEpoch));
    own.change = a.cursor() + 1;
    assert_eq!(process(&mut a, &own), Ok(Processed::Skipped));
}

#[test]
fn a_key_for_an_epoch_its_group_has_not_reached_is_not_taken() {
    let (mut hub, mut a, mut agent, room_group, group) = room_with_history();
    let mut b = new_device();
    add_human(&mut hub, &mut a, &mut b);
    add_to_session(&mut hub, &mut a, &mut b, &group);
    settle(&hub, &mut b);
    assert_eq!(b.group(&group).unwrap().epoch, 4);

    // The session moves on to epoch 5, then the handover is sent in the room group.
    a.update(&group, true, now()).unwrap().unwrap();
    post_ok(&mut hub, &mut a);
    a.send_handover(&room_group, &b.id()).unwrap();
    post_ok(&mut hub, &mut a);
    let [commit, handover] = &hub.log_after(b.cursor())[..] else {
        panic!("a Commit and a message");
    };
    // The two change places: as if the hub had ordered the message before the Commit.
    let (mut commit, mut handover) = (commit.clone(), handover.clone());
    std::mem::swap(&mut commit.change, &mut handover.change);
    let (commit, handover) = (&commit, &handover);

    // Handed the message before the Commit, the device takes the keys up to its own epoch of each group:
    // room epochs 0 to 3 and session epochs 0 to 3, not the session's epoch 5.
    assert_eq!(
        process(&mut b, handover),
        Ok(Processed::Message(Received::Keys {
            from: a.id(),
            taken: 8,
            last: true
        }))
    );
    assert_eq!(b.content_key(&group, 5), Err(Error::NoKey));
    // It derives that key itself when it processes the Commit.
    assert!(matches!(
        process(&mut b, commit),
        Ok(Processed::Commit { removed: false, .. })
    ));
    settle(&hub, &mut agent);
    assert_eq!(
        b.content_key(&group, 5).unwrap(),
        agent.content_key(&group, 5).unwrap()
    );
}

#[test]
fn a_session_handover_carries_that_groups_keys_only() {
    let (mut hub, mut a, mut agent, room_group, group) = room_with_history();
    let mut other_agent = new_device();
    enrol(&mut hub, &mut a, &mut other_agent);
    publish_some(&mut hub, &mut other_agent, 1);
    let other = found_main(&mut hub, &mut a, &other_agent.id());
    settle(&hub, &mut agent);

    // The agent joined at epoch 1; the human device hands it the session's keys, of which epoch 0 is new.
    assert_eq!(agent.content_key(&group, 0), Err(Error::NoKey));
    a.send_handover(&group, &agent.id()).unwrap();
    post_ok(&mut hub, &mut a);
    assert_eq!(a.handovers_sent(), [(agent.id(), group)]);
    let processed = settle(&hub, &mut agent);
    assert_eq!(
        keys_received(&processed),
        [&Received::Keys {
            from: a.id(),
            taken: 1,
            last: true
        }]
    );
    assert_eq!(
        agent.content_key(&group, 0).unwrap(),
        a.content_key(&group, 0).unwrap()
    );
    // Nothing of the room group or of the other session came with it (5.3.4).
    for epoch in 0..=hub.epoch(&room_group).unwrap() {
        assert_eq!(agent.content_key(&room_group, epoch), Err(Error::NoKey));
    }
    for epoch in 0..=1 {
        assert!(a.content_key(&other, epoch).is_ok());
        assert_eq!(agent.content_key(&other, epoch), Err(Error::NoKey));
    }

    // An agent device hands no key over in a main session.
    assert_eq!(agent.send_handover(&group, &a.id()), Err(Error::Forbidden));
    assert!(agent.outbox().is_empty());
    // A handover goes through a group the sender is a leaf of.
    assert_eq!(
        agent.send_handover(&room_group, &a.id()),
        Err(Error::NotFound)
    );
}

#[test]
fn a_handed_key_is_bound_by_what_the_device_knows_of_its_group() {
    let (mut hub, mut a, _agent, room_group, group) = room_with_history();
    let mut b = new_device();
    add_human(&mut hub, &mut a, &mut b);
    // A human device that hands over what no device hands over.
    let forger = Forger::new();
    let mut forged = add_forger(&mut hub, &mut a, &forger);
    sync_ok(&hub, &mut b);
    let room_epoch = hub.epoch(&room_group).unwrap();
    let joins_at = hub.epoch(&group).unwrap() + 1;
    let key = |byte: u8| Secret::new([byte; 32]);
    let mut hand = |hub: &mut Hub, b: &mut TestDevice, keys: Vec<(GroupId, u64, u8)>| {
        let message = TrommiMessage::KeyHandover {
            recipient: b.id(),
            keys: keys
                .into_iter()
                .map(|(group, epoch, byte)| EpochKey {
                    group,
                    epoch,
                    content_key: key(byte),
                })
                .collect(),
            last: true,
        };
        forger.post_message(hub, &mut forged, &codec::encode(&message).unwrap());
        let processed = sync_ok(hub, b);
        match processed.last() {
            Some(Processed::Message(Received::Keys { taken, .. })) => *taken,
            other => panic!("a handover: {other:?}"),
        }
    };

    // The device is no leaf of the session group yet: it cannot tell how far that group is, and takes its
    // keys as they come (7.1: a newcomer is handed every key before it is added to the sessions). Of a
    // group it holds it takes no key beyond its own epoch, and none of a group of another room.
    let never_joined = GroupId::session(room_group.room_id(), SessionId::new([9; 16]));
    let elsewhere = GroupId::session(RoomId::new([8; 32]), SessionId::new([9; 16]));
    let taken = hand(
        &mut hub,
        &mut b,
        vec![
            (group, 0, 1),
            (group, joins_at, 2),
            (group, joins_at + 5, 3),
            (never_joined, u64::MAX, 4),
            (elsewhere, 0, 5),
            (room_group, room_epoch + 1, 6),
        ],
    );
    assert_eq!(taken, 4);
    assert_eq!(b.content_key(&group, joins_at).unwrap(), key(2));
    assert_eq!(b.content_key(&elsewhere, 0), Err(Error::NoKey));
    assert_eq!(
        b.content_key(&room_group, room_epoch + 1),
        Err(Error::NoKey)
    );

    // It joins the session group. The key of the epoch it joined at is the one it derived, not the one it
    // was handed, and the handed keys of later epochs, which the group had not reached, are gone. What was
    // handed for earlier epochs stays: it opens something or nothing (content is signed).
    add_to_session(&mut hub, &mut a, &mut b, &group);
    settle(&hub, &mut b);
    assert_eq!(b.group(&group).unwrap().epoch, joins_at);
    assert_eq!(
        b.content_key(&group, joins_at).unwrap(),
        a.content_key(&group, joins_at).unwrap()
    );
    assert_eq!(b.content_key(&group, joins_at + 5), Err(Error::NoKey));
    assert_eq!(b.content_key(&group, 0).unwrap(), key(1));
    assert_eq!(b.content_key(&never_joined, u64::MAX).unwrap(), key(4));
    // From here on the group bounds what the device takes for it.
    let taken = hand(
        &mut hub,
        &mut b,
        vec![(group, joins_at + 1, 7), (group, joins_at - 1, 8)],
    );
    assert_eq!(taken, 1);
    assert_eq!(b.content_key(&group, joins_at + 1), Err(Error::NoKey));
    assert_eq!(b.content_key(&group, joins_at - 1).unwrap(), key(8));
}
