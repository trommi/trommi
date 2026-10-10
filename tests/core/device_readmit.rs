//! A human device is let into a session group again (3.7), and its chain goes on from its Cut (9.0.10): what
//! it signed for an epoch before it was a leaf again stays refused, whoever hands it in and whenever.

use trommi_core::chain::Head;
use trommi_core::device::{Draft, EnvelopeOutcome, Processed};
use trommi_core::ids::GroupId;
use trommi_core::Error;
use trommi_tests::hub::Hub;
use trommi_tests::{
    add_human, added_at, enrol, found_main, found_room, json, new_device, new_device_on, now,
    post_all, post_ok, post_refused, process, publish_some, reopen, sync_all, take_welcomes, write,
    MemoryStorage, TestDevice,
};

fn chat(group: &GroupId, text: &str) -> Draft {
    Draft::SessionChat {
        session: group.session_id().unwrap(),
        payload: json(&format!(r#"{{"text":"{text}"}}"#)),
    }
}

/// A room with the human device `a`, an agent device, and the human device `late`, added to the room before
/// the main session is founded. Nobody has processed the founding yet.
fn room_with(late: &mut TestDevice) -> (Hub, GroupId, GroupId, TestDevice, TestDevice) {
    let (mut a, mut agent) = (new_device(), new_device());
    let (mut hub, room) = found_room(&mut a);
    add_human(&mut hub, &mut a, late);
    publish_some(&mut hub, &mut a, 4);
    publish_some(&mut hub, late, 4);
    publish_some(&mut hub, &mut agent, 4);
    enrol(&mut hub, &mut a, &mut agent);
    let main = found_main(&mut hub, &mut a, &agent.id());
    sync_all(&hub, &mut a);
    sync_all(&hub, &mut agent);
    (hub, room, main, a, agent)
}

#[test]
fn a_human_device_whose_welcome_failed_is_let_in_again_and_writes_from_its_cut() {
    let mut b = new_device();
    let (mut hub, room, main, mut a, mut agent) = room_with(&mut b);
    // The Welcome into the session does not reach the device: it follows the log and takes none.
    for item in hub.log_after(b.cursor()) {
        let _ = process(&mut b, &item);
    }
    assert_eq!(b.group(&main).err(), Some(Error::NotFound));
    write(&mut hub, &mut a, &chat(&main, "before"));
    sync_all(&hub, &mut agent);

    // It asks with a fresh KeyPackage. Only a human device of the group lets it in, only into a session
    // group, and never itself.
    let package = b.key_package(now()).unwrap();
    assert_eq!(
        a.readmit_human(&room, &b.id(), &package, now()),
        Err(Error::Forbidden)
    );
    assert_eq!(
        agent.readmit_human(&main, &b.id(), &package, now()),
        Err(Error::Forbidden)
    );
    let own = a.key_package(now()).unwrap();
    assert_eq!(
        a.readmit_human(&main, &a.id(), &own, now()),
        Err(Error::BadCommit)
    );
    assert_eq!(
        a.readmit_human(&main, &agent.id(), &package, now()),
        Err(Error::BadCommit)
    );
    // One Commit removes the leaf with its Cut, at nothing, and adds the key again.
    a.readmit_human(&main, &b.id(), &package, now()).unwrap();
    post_ok(&mut hub, &mut a);
    assert_eq!(take_welcomes(&hub, &mut b, added_at(&hub)).len(), 1);
    for device in [&mut a, &mut agent, &mut b] {
        sync_all(&hub, device);
    }
    let epoch = b.group(&main).unwrap().epoch;
    for device in [&a, &agent, &b] {
        let summary = device.group(&main).unwrap();
        assert_eq!(summary.epoch, epoch);
        assert_eq!(
            summary.leaves,
            [a.id(), b.id(), agent.id()].into_iter().collect()
        );
        assert!(!summary.is_stale());
    }
    for device in [&a, &agent] {
        assert_eq!(device.chain_cut(&main, &b.id()).unwrap(), Some(Head::START));
    }

    // Its chain goes on from the Cut: number 1, and every leaf takes it; the agent as a command.
    let said = write(&mut hub, &mut b, &chat(&main, "in at last"));
    assert_eq!(said.seq, 1);
    let writer = b.id();
    for device in [&mut a, &mut agent, &mut b] {
        let got = sync_all(&hub, device);
        let last = got.last().unwrap();
        assert_eq!(
            (last.envelope_hash, last.outcome),
            (said.envelope_hash, EnvelopeOutcome::Applied)
        );
        assert_eq!(device.chain_head(&main, &writer).unwrap().seq, 1);
    }
    assert!(agent.command(&said.envelope_hash, now()).is_ok());
}

#[test]
fn what_a_device_signed_before_it_was_let_in_again_is_refused_by_everyone() {
    let store = MemoryStorage::new();
    let handle = store.handle();
    let mut c = new_device_on(store);
    let (mut hub, _, main, mut a, mut agent) = room_with(&mut c);
    sync_all(&hub, &mut c);
    let one = write(&mut hub, &mut c, &chat(&main, "one"));
    for device in [&mut a, &mut agent, &mut c] {
        sync_all(&hub, device);
    }

    // The device writes number 2, which the hub takes and the other human device has not read. Let in
    // again with the Cut at number 1, its chain would go on under a number the hub holds: `bad-commit`.
    let two = write(&mut hub, &mut c, &chat(&main, "two"));
    let package = c.key_package(now()).unwrap();
    assert_eq!(a.cut_of(&main, &c.id()).unwrap().seq, one.seq);
    a.readmit_human(&main, &c.id(), &package, now()).unwrap();
    assert_eq!(post_refused(&mut hub, &mut a), [Error::BadCommit]);
    assert!(!a.group(&main).unwrap().pending);

    // It signs number 3 for this epoch, and the envelope is held back: by the device, or by a hub.
    for device in [&mut a, &mut agent, &mut c] {
        sync_all(&hub, device);
    }
    let three = c
        .seal(&chat(&main, "three, held back"), None, &[], now())
        .unwrap();
    let held_back = c
        .outbox()
        .into_iter()
        .find(|entry| entry.id == three.outbox_id)
        .unwrap()
        .parts
        .remove(0);
    let before = c.group(&main).unwrap().epoch;

    // Having read up to number 2, the human device lets it in again: the Cut is number 2.
    a.readmit_human(&main, &c.id(), &package, now()).unwrap();
    post_ok(&mut hub, &mut a);
    let cut = Head {
        seq: 2,
        hash: two.envelope_hash,
    };
    // The device itself is removed by that Commit and joins again from its Welcome.
    let at = added_at(&hub);
    let item = hub.log_after(c.cursor()).remove(0);
    assert!(matches!(
        process(&mut c, &item),
        Ok(Processed::Commit { removed: true, .. })
    ));
    assert_eq!(c.group(&main).err(), Some(Error::NotFound));
    assert_eq!(take_welcomes(&hub, &mut c, at).len(), 1);
    for device in [&mut a, &mut agent, &mut c] {
        sync_all(&hub, device);
    }
    let again = c.group(&main).unwrap().epoch;
    assert_eq!(again, before + 1);
    for device in [&a, &agent, &c] {
        assert_eq!(device.chain_cut(&main, &c.id()).unwrap(), Some(cut));
    }

    // The envelope of the epoch before: the hub refuses it without a void record, and so does every device
    // it is handed to, in the hub's order or read back, now and after the chain went on.
    // Handed in at a new place in the hub's order (`ahead` of the cursor), or read back along the chain.
    let refused_by = |device: &mut TestDevice, ahead: u64| {
        let got = device
            .receive_envelope(&held_back, device.cursor() + ahead, true, None, now())
            .unwrap();
        (got.outcome, got.code)
    };
    let refusal = (EnvelopeOutcome::Refused, Some(Error::RemovedSender));
    assert_eq!(post_all(&mut hub, &mut c), [Err(Error::RemovedSender)]);
    assert!(!hub.voided(&c.outbox().remove(0)));
    c.envelope_abandon(three.outbox_id).unwrap();
    for device in [&mut a, &mut agent, &mut c] {
        assert_eq!(refused_by(device, 0), refusal);
    }

    // Its chain goes on from the Cut: number 3 again, with the Cut's hash before it, in the new epoch.
    let back = write(&mut hub, &mut c, &chat(&main, "back"));
    assert_eq!(back.seq, 3);
    let writer = c.id();
    assert_ne!(back.envelope_hash, three.envelope_hash);
    for device in [&mut a, &mut agent, &mut c] {
        let got = sync_all(&hub, device);
        let last = got.last().unwrap();
        assert_eq!(
            (
                last.envelope_hash,
                last.outcome,
                last.header.prev,
                last.header.epoch
            ),
            (
                back.envelope_hash,
                EnvelopeOutcome::Applied,
                cut.hash,
                again
            )
        );
        assert_eq!(refused_by(device, 0), refusal);
        assert_eq!(refused_by(device, 1), refusal);
        assert_eq!(
            device
                .receive_envelope(&held_back, 0, false, None, now())
                .unwrap()
                .code,
            Some(Error::RemovedSender)
        );
    }
    // Everyone agrees on the chain, the hub included, and a restart finds the same.
    let head = Head {
        seq: 3,
        hash: back.envelope_hash,
    };
    for device in [&a, &agent, &c] {
        assert_eq!(device.chain_head(&main, &writer).unwrap(), head);
    }
    let served: Vec<u64> = hub
        .chain_of(&main, &c.id(), 0)
        .iter()
        .map(|stored| stored.header.seq)
        .collect();
    assert_eq!(served, [1, 2, 3]);
    drop(c);
    let mut c = reopen(handle.reopened()).unwrap();
    assert_eq!(c.chain_cut(&main, &c.id()).unwrap(), Some(cut));
    assert_eq!(write(&mut hub, &mut c, &chat(&main, "on")).seq, 4);
}
