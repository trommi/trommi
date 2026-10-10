//! A human device is let into a session group again (3.7), and its chain goes on from its Cut (9.0.10): what
//! it signed for an epoch before it was a leaf again stays refused, whoever hands it in and whenever.

use trommi_core::chain::Head;
use trommi_core::device::{Draft, EnvelopeOutcome, Processed};
use trommi_core::ids::GroupId;
use trommi_core::Error;
use trommi_tests::hub::Hub;
use trommi_tests::{
    add_human, add_to_session, added_at, enrol, found_main, found_room, json, learn, new_device,
    new_device_on, now, post_all, post_ok, post_refused, process, publish_some, reopen, sync_all,
    take_welcomes, write, MemoryStorage, TestDevice,
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

#[test]
fn a_device_does_not_merge_its_own_commit_that_adds_a_key_again_of_which_it_holds_more() {
    let mut c = new_device();
    let (mut hub, _, main, mut a, mut agent) = room_with(&mut c);
    sync_all(&hub, &mut c);
    write(&mut hub, &mut c, &chat(&main, "one"));
    for device in [&mut a, &mut agent] {
        sync_all(&hub, device);
    }
    let epoch = a.group(&main).unwrap().epoch;

    // The Commit names the Cut at number 1 and waits. A hub hands the members number 2 of that device
    // before the Commit reaches the log, and denies holding it when the Commit is posted.
    let package = c.key_package(now()).unwrap();
    a.readmit_human(&main, &c.id(), &package, now()).unwrap();
    let entry = a.outbox().remove(0);
    let two = c.seal(&chat(&main, "two"), None, &[], now()).unwrap();
    let bytes = c.outbox().remove(0).parts.remove(0);
    for device in [&mut a, &mut agent] {
        let read = device
            .receive_envelope(&bytes, device.cursor(), true, None, now())
            .unwrap();
        assert_eq!(read.envelope_hash, two.envelope_hash);
        assert_eq!(
            device.chain_head(&main, &read.header.sender).unwrap().seq,
            2
        );
    }
    let answer = hub.post(&a.id(), &entry).unwrap();
    a.outbox_accepted(entry.id, answer).unwrap();
    // Neither the device that made the Commit nor another member merges it.
    let item = hub.log_after(a.cursor()).remove(0);
    assert_eq!(process(&mut a, &item).err(), Some(Error::BadCommit));
    assert_eq!(process(&mut agent, &item).err(), Some(Error::BadCommit));
    for device in [&a, &agent] {
        assert_eq!(device.group(&main).unwrap().epoch, epoch);
        assert_eq!(device.chain_head(&main, &c.id()).unwrap().seq, 2);
    }
}

/// `adder` lets `device` into `group` again (3.7); the device processes its removal and joins again from its
/// Welcome; then everyone reads up.
fn let_in_again(hub: &mut Hub, adder: &mut TestDevice, device: &mut TestDevice, group: &GroupId) {
    let package = device.key_package(now()).unwrap();
    adder
        .readmit_human(group, &device.id(), &package, now())
        .unwrap();
    post_ok(hub, adder);
    let at = added_at(hub);
    let item = hub.log_after(device.cursor()).remove(0);
    assert!(matches!(
        process(device, &item),
        Ok(Processed::Commit { removed: true, .. })
    ));
    assert_eq!(take_welcomes(hub, device, at).len(), 1);
}

#[test]
fn a_device_that_learns_the_past_holds_the_cut_of_the_last_removal() {
    let mut c = new_device();
    let (mut hub, room, main, mut a, mut agent) = room_with(&mut c);
    sync_all(&hub, &mut c);
    write(&mut hub, &mut c, &chat(&main, "one"));
    for device in [&mut a, &mut agent, &mut c] {
        sync_all(&hub, device);
    }
    // Let in again with the Cut at number 1, it writes number 2, which everyone takes.
    let_in_again(&mut hub, &mut a, &mut c, &main);
    for device in [&mut a, &mut agent, &mut c] {
        sync_all(&hub, device);
    }
    let two = write(&mut hub, &mut c, &chat(&main, "two"));
    for device in [&mut a, &mut agent, &mut c] {
        sync_all(&hub, device);
    }
    // It signs number 3, which is held back, and is let in again with the Cut at number 2.
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
    c.envelope_abandon(three.outbox_id).unwrap();
    let_in_again(&mut hub, &mut a, &mut c, &main);
    for device in [&mut a, &mut agent, &mut c] {
        sync_all(&hub, device);
    }
    let cut = Head {
        seq: 2,
        hash: two.envelope_hash,
    };
    assert_eq!(a.chain_cut(&main, &c.id()).unwrap(), Some(cut));

    // A human device that comes later learns the session's past: it holds the Cut of the last removal, and
    // the envelope held back stays refused.
    let mut d = new_device();
    add_human(&mut hub, &mut a, &mut d);
    publish_some(&mut hub, &mut d, 4);
    sync_all(&hub, &mut a);
    add_to_session(&mut hub, &mut a, &mut d, &main);
    sync_all(&hub, &mut d);
    learn(&hub, &mut d, &room).unwrap();
    assert!(learn(&hub, &mut d, &main).unwrap().epochs > 2);
    assert_eq!(d.chain_cut(&main, &c.id()).unwrap(), Some(cut));
    let got = d
        .receive_envelope(&held_back, d.cursor(), true, None, now())
        .unwrap();
    assert_eq!(
        (got.outcome, got.code),
        (EnvelopeOutcome::Refused, Some(Error::RemovedSender))
    );
}

#[test]
fn a_human_device_removed_from_a_session_joins_it_again_with_the_code() {
    use trommi_core::codec;
    use trommi_core::ids::Hash32;
    use trommi_core::mls::profile::{CommitNote, Cut};
    use trommi_tests::forge::Forger;
    use trommi_tests::{add_forger, found_room_on, join_session, test_keys};

    // A human device that obeys MLS only removes another human device's leaf from the main session: a
    // Commit no device builds, and none refuses (5.2.2). The removed device stays a human device of the
    // room and holds the group as one it was removed from.
    let store = MemoryStorage::new();
    let handle = store.handle();
    let (mut a, mut c, mut agent) = (new_device(), new_device_on(store), new_device());
    let mut hub = Hub::new(false);
    let room = found_room_on(&mut hub, &mut a);
    let forger = Forger::new();
    add_forger(&mut hub, &mut a, &forger);
    add_human(&mut hub, &mut a, &mut c);
    publish_some(&mut hub, &mut c, 4);
    publish_some(&mut hub, &mut agent, 4);
    enrol(&mut hub, &mut a, &mut agent);
    sync_all(&hub, &mut c);
    let packages = hub.claim(&[c.id(), agent.id()]).unwrap();
    let packages = [packages, vec![forger.key_package()]].concat();
    let session = a.found_session(&agent.id(), &packages, now()).unwrap();
    post_ok(&mut hub, &mut a);
    let main = GroupId::session(room.room_id(), session);
    let mut forged = forger.join(&hub.welcomes.last().unwrap().bytes);
    for device in [&mut a, &mut c, &mut agent] {
        sync_all(&hub, device);
    }
    let state = a.room_history().unwrap().newest().clone();
    let cut = a.cut_of(&main, &c.id()).unwrap();
    let note = CommitNote {
        room_epoch: state.epoch,
        room_state: state.state,
        time: now(),
        cuts: vec![cut],
        join: false,
    };
    let removal = forger.commit_removing(&mut forged, &codec::encode(&note).unwrap(), &[c.id()]);
    forger.post_commit(&mut hub, &main, &removal).unwrap();
    let item = hub.log_after(c.cursor()).remove(0);
    assert!(matches!(
        process(&mut c, &item),
        Ok(Processed::Commit { removed: true, .. })
    ));
    sync_all(&hub, &mut a);
    assert_eq!(c.group(&main).err(), Some(Error::NotFound));
    assert_eq!(
        cut,
        Cut {
            device: c.id(),
            seq: 0,
            hash: Hash32::ZERO
        }
    );

    // It holds the code and joins from outside (5.2.7, 8.4): its record of the group's past is whole.
    let keys = test_keys();
    join_session(&hub, &mut c, &keys, &main).unwrap();
    post_ok(&mut hub, &mut c);
    for device in [&mut a, &mut c] {
        sync_all(&hub, device);
    }
    assert_eq!(c.group(&main).unwrap().epoch, hub.epoch(&main).unwrap());
    assert!(c.group_past(&main).unwrap().unwrap().learned);
    assert_eq!(
        c.chain_cut(&main, &c.id()).unwrap(),
        Some(Head {
            seq: cut.seq,
            hash: cut.hash
        })
    );
    let epoch = c.group(&main).unwrap().epoch;
    assert!(c.content_key(&main, epoch).is_ok());
    // A restart finds the records whole.
    drop(c);
    let c = reopen(handle.reopened()).unwrap();
    assert!(c.group_past(&main).unwrap().unwrap().learned);
    assert_eq!(c.group(&main).unwrap().epoch, epoch);
}

#[test]
fn what_a_device_writes_after_its_chain_went_back_to_its_cut_makes_its_heads_due() {
    use trommi_core::crypto::SecretBytes;
    use trommi_core::device::HEADS_EVERY_MS;

    let mut c = new_device();
    let (mut hub, _, main, mut a, mut agent) = room_with(&mut c);
    sync_all(&hub, &mut c);
    let one = write(&mut hub, &mut c, &chat(&main, "one"));
    for device in [&mut a, &mut agent, &mut c] {
        sync_all(&hub, device);
    }
    // It signs `heads` as number 2, which is not published, and is let in again with the Cut at number 1.
    let value = c.heads_due(&main, now()).unwrap().unwrap();
    let heads = Draft::Register {
        group: main,
        name: "heads".into(),
        value: Some(SecretBytes::new(value)),
    };
    let sealed = c.seal(&heads, None, &[], now()).unwrap();
    assert_eq!(sealed.seq, one.seq + 1);
    let_in_again(&mut hub, &mut a, &mut c, &main);
    for device in [&mut a, &mut agent, &mut c] {
        sync_all(&hub, device);
    }
    assert_eq!(c.chain_head(&main, &c.id()).unwrap().seq, one.seq);
    c.envelope_abandon(sealed.outbox_id).unwrap();
    // Its next envelope is number 2 again, a chat: that is a change, and its heads are due.
    let again = write(&mut hub, &mut c, &chat(&main, "again"));
    assert_eq!(again.seq, sealed.seq);
    sync_all(&hub, &mut c);
    let later = now() + HEADS_EVERY_MS;
    assert!(c.heads_due(&main, later).unwrap().is_some());
}
