//! The write order (13.2) under failing writes and crashes: whatever is sent is first written with the state
//! it leaves behind, a retry sends the same bytes, and a device that restarts ends where an uninterrupted
//! one does. A failing write is planned in the store; a crash drops the device and opens a new one on what
//! the store holds.

use trommi_core::device::{log_finding, GroupSummary, LogFinding, Processed, Received};
use trommi_core::ids::{DeviceId, GroupId};
use trommi_core::invite::Role;
use trommi_core::store::{OutboxEntry, OutboxKind};
use trommi_core::Error;
use trommi_tests::hub::Hub;
use trommi_tests::{
    add_human, enrol, found_room, hub_address, join_invited, join_room, new_device, new_device_on,
    now, post_all, post_ok, process, publish_some, reopen, settle, sync, sync_ok, test_keys,
    MemoryStorage, TestDevice, APP,
};

/// What a device shows of its state: enough to tell two states apart.
#[derive(Debug, PartialEq)]
struct Shown {
    cursor: u64,
    outbox: Vec<OutboxEntry>,
    groups: Vec<GroupSummary>,
    sent: Vec<(DeviceId, GroupId)>,
    human: bool,
}

fn shown(device: &TestDevice) -> Shown {
    Shown {
        cursor: device.cursor(),
        outbox: device.outbox(),
        groups: device.groups().unwrap(),
        sent: device.handovers_sent(),
        human: device.is_human(),
    }
}

/// A device under test on its store, with a second human device as its peer.
struct Run {
    hub: Hub,
    device: TestDevice,
    handle: MemoryStorage,
    peer: TestDevice,
    room_group: GroupId,
    /// What to interrupt: a crash after this step, a failing write in that step.
    crash_after: Option<usize>,
    fail_at: Option<usize>,
}

impl Run {
    fn start(crash_after: Option<usize>, fail_at: Option<usize>) -> Self {
        let store = MemoryStorage::new();
        let handle = store.handle();
        let (mut device, mut peer) = (new_device_on(store), new_device());
        let (mut hub, room_group) = found_room(&mut device);
        add_human(&mut hub, &mut device, &mut peer);
        settle(&hub, &mut peer);
        Self {
            hub,
            device,
            handle,
            peer,
            room_group,
            crash_after,
            fail_at,
        }
    }

    /// Memory is what is stored: a device opened on the store's content shows the same state.
    fn memory_is_what_is_stored(&self) {
        let twin = reopen(self.handle.reopened()).unwrap();
        assert_eq!(shown(&twin), shown(&self.device));
        assert_eq!(twin.id(), self.device.id());
    }

    /// Runs one step of the device. With a failing write planned for it, the step fails as a storage error
    /// and changes nothing; it is then run again.
    fn step<T>(
        &mut self,
        number: usize,
        mut step: impl FnMut(&mut Hub, &mut TestDevice) -> Result<T, Error>,
    ) -> T {
        if self.fail_at == Some(number) {
            let before = shown(&self.device);
            let revision = self.handle.revision();
            self.handle.fail_apply(1);
            let error = step(&mut self.hub, &mut self.device)
                .err()
                .expect("the write fails");
            assert_eq!(error, Error::Storage("planned failure".into()));
            assert_eq!(log_finding(&error), LogFinding::Local);
            assert_eq!(shown(&self.device), before, "step {number}");
            assert_eq!(self.handle.revision(), revision);
            self.memory_is_what_is_stored();
        }
        let done = step(&mut self.hub, &mut self.device).expect("the step");
        self.memory_is_what_is_stored();
        if self.crash_after == Some(number) {
            let before = shown(&self.device);
            let store = self.handle.reopened();
            self.handle = store.handle();
            self.device = reopen(store).unwrap();
            // Nothing is lost: the outbox holds the same entries under the same ids, byte for byte.
            assert_eq!(
                shown(&self.device),
                before,
                "after a crash behind step {number}"
            );
        }
        done
    }
}

/// Every way to interrupt a run of four steps (built, posted, answer reported, log processed): nowhere, a
/// crash after one, a failing write in one, or both. Posting writes nothing, so no write fails there.
fn interruptions() -> Vec<(Option<usize>, Option<usize>)> {
    let places = [None, Some(1), Some(2), Some(3), Some(4)];
    let mut all = Vec::new();
    for crash_after in places {
        for fail_at in places.into_iter().filter(|step| *step != Some(2)) {
            all.push((crash_after, fail_at));
        }
    }
    all
}

#[test]
fn a_commit_survives_a_crash_or_a_failed_write_at_every_step() {
    let mut ends = Vec::new();
    for (crash_after, fail_at) in interruptions() {
        let mut run = Run::start(crash_after, fail_at);
        let room_group = run.room_group;
        let log_before = run.hub.log.len();
        let mut posted: Vec<Vec<Vec<u8>>> = Vec::new();

        // 1: the operation is built; the Commit is pending and in the outbox.
        run.step(1, |_, device| {
            device
                .update(&room_group, true, now())
                .map(|id| id.unwrap())
        });
        let entry = run.device.outbox().remove(0);
        assert_eq!((entry.kind, entry.epoch), (OutboxKind::Commit, 1));
        assert!(run.device.group(&room_group).unwrap().pending);
        assert_eq!(
            run.device.update(&room_group, true, now()),
            Err(Error::Busy)
        );
        // 2: posted. The device writes nothing here.
        let answer = run.step(2, |hub, device| {
            let entry = device.outbox().remove(0);
            posted.push(entry.parts.clone());
            hub.post(&device.id(), &entry)
        });
        // 3: the answer is reported. A device that lost it posts again and is answered alike.
        run.step(3, |hub, device| {
            let entry = device.outbox().remove(0);
            posted.push(entry.parts.clone());
            assert_eq!(hub.post(&device.id(), &entry), Ok(answer));
            device.outbox_accepted(entry.id, answer)
        });
        // The answer is written, and the Commit waits for its place in the log: the group stands in the old
        // epoch, also after a crash.
        let waiting = run.device.group(&room_group).unwrap();
        assert_eq!((waiting.epoch, waiting.pending), (1, true));
        assert!(run.device.outbox().is_empty());
        assert_eq!(
            run.device.update(&room_group, true, now()),
            Err(Error::Busy)
        );
        // The same bytes under the same id every time, and one Commit for the epoch in the log.
        assert!(posted.iter().all(|parts| *parts == entry.parts));
        assert_eq!(run.hub.log.len(), log_before + 1);
        assert_eq!(run.hub.log.last().unwrap().bytes, entry.parts[0]);
        assert_eq!(run.hub.epoch(&room_group), Some(2));
        // 4: the log is processed: the device merges its Commit where the log shows it; the peer followed the
        // Commit and made the next one.
        sync_ok(&run.hub, &mut run.peer);
        run.peer.update(&room_group, true, now()).unwrap().unwrap();
        post_ok(&mut run.hub, &mut run.peer);
        let processed = run.step(4, |hub, device| {
            let mut results = Vec::new();
            for item in hub.log_after(device.cursor()) {
                results.push(process(device, &item)?);
            }
            Ok(results)
        });
        assert!(matches!(
            &processed[..],
            [
                Processed::OwnCommit,
                Processed::Commit {
                    superseded: None,
                    removed: false,
                    ..
                }
            ]
        ));

        // The end is the one of an uninterrupted run: merged, nothing pending, nothing to send, and the keys
        // of the new epochs are the ones the peer derives.
        for epoch in 2..=3 {
            assert_eq!(
                run.device.content_key(&room_group, epoch).unwrap(),
                run.peer.content_key(&room_group, epoch).unwrap()
            );
        }
        let end = shown(&run.device);
        assert!(end.outbox.is_empty());
        assert_eq!(end.cursor, run.hub.change());
        assert_eq!(
            end.groups
                .iter()
                .map(|group| (group.epoch, group.pending, group.leaves.len()))
                .collect::<Vec<_>>(),
            [(3, false, 2)]
        );
        ends.push((end.cursor, end.human, end.sent.len()));
        // And it goes on: the next Commit builds on the new epoch and is followed by the peer.
        run.device
            .update(&room_group, true, now())
            .unwrap()
            .unwrap();
        post_ok(&mut run.hub, &mut run.device);
        sync_ok(&run.hub, &mut run.peer);
        assert_eq!(
            run.device.content_key(&room_group, 4).unwrap(),
            run.peer.content_key(&room_group, 4).unwrap()
        );
    }
    assert!(ends.iter().all(|end| *end == ends[0]));
    assert_eq!(ends.len(), 20);
}

#[test]
fn an_application_message_survives_a_crash_or_a_failed_write_at_every_step() {
    for (crash_after, fail_at) in interruptions() {
        let mut run = Run::start(crash_after, fail_at);
        let room_group = run.room_group;
        let peer = run.peer.id();
        let log_before = run.hub.log.len();
        let mut posted: Vec<Vec<Vec<u8>>> = Vec::new();

        // 1: the message is encrypted and written with the ratchet state after it.
        run.step(1, |_, device| device.send_handover(&room_group, &peer));
        let entry = run.device.outbox().remove(0);
        assert_eq!((entry.kind, entry.epoch), (OutboxKind::Message, 1));
        assert_eq!(run.device.handovers_sent(), [(peer, room_group)]);
        // 2: posted. 3: the answer is reported, after a second post that is answered alike.
        let answer = run.step(2, |hub, device| {
            let entry = device.outbox().remove(0);
            posted.push(entry.parts.clone());
            hub.post(&device.id(), &entry)
        });
        run.step(3, |hub, device| {
            let entry = device.outbox().remove(0);
            posted.push(entry.parts.clone());
            assert_eq!(hub.post(&device.id(), &entry), Ok(answer));
            device.outbox_accepted(entry.id, answer)
        });
        // The same bytes every time; the hub stored the message once, and the receiver opens it.
        assert!(posted.iter().all(|parts| *parts == entry.parts));
        assert_eq!(run.hub.log.len(), log_before + 1);
        assert_eq!(
            sync_ok(&run.hub, &mut run.peer),
            [Processed::Message(Received::Keys {
                from: run.device.id(),
                taken: 1,
                last: true
            })]
        );
        // 4: the log is processed: a message of the peer.
        let me = run.device.id();
        run.peer.send_handover(&room_group, &me).unwrap();
        post_ok(&mut run.hub, &mut run.peer);
        let received = run.step(4, |hub, device| {
            let mut results = Vec::new();
            for item in hub.log_after(device.cursor()) {
                results.push(process(device, &item)?);
            }
            Ok(results)
        });
        assert_eq!(
            received,
            [Processed::Message(Received::Keys {
                from: run.peer.id(),
                taken: 0,
                last: true
            })]
        );
        assert_eq!(run.device.cursor(), run.hub.change());
        assert!(run.device.outbox().is_empty());
        assert_eq!(run.device.handovers_sent(), [(peer, room_group)]);

        // The next message does not reuse the first one's place in the sender's ratchet: it opens too.
        run.device.send_handover(&room_group, &peer).unwrap();
        assert_ne!(run.device.outbox()[0].parts, entry.parts);
        post_ok(&mut run.hub, &mut run.device);
        assert_eq!(
            sync_ok(&run.hub, &mut run.peer),
            [Processed::Message(Received::Keys {
                from: run.device.id(),
                taken: 0,
                last: true
            })]
        );
    }
}

#[test]
fn a_receiver_survives_a_crash_or_a_failed_write_at_every_entry() {
    // The device under test is the one that processes: a Commit, then a message, then a Commit.
    for (crash_after, fail_at) in interruptions().into_iter().filter(|(crash, fail)| {
        crash.is_none_or(|step| step <= 3) && fail.is_none_or(|step| step <= 3)
    }) {
        let mut run = Run::start(crash_after, fail_at);
        let room_group = run.room_group;
        let me = run.device.id();
        run.peer.update(&room_group, true, now()).unwrap().unwrap();
        post_ok(&mut run.hub, &mut run.peer);
        run.peer.send_handover(&room_group, &me).unwrap();
        post_ok(&mut run.hub, &mut run.peer);
        run.peer.update(&room_group, true, now()).unwrap().unwrap();
        post_ok(&mut run.hub, &mut run.peer);
        let items = run.hub.log_after(run.device.cursor());
        assert_eq!(items.len(), 3);

        let mut results = Vec::new();
        for (at, item) in items.iter().enumerate() {
            let cursor = run.device.cursor();
            results.push(run.step(at + 1, |_, device| process(device, item)));
            // The group state, the content key and the cursor are one write.
            assert!(run.device.cursor() > cursor);
            assert_eq!(run.device.cursor(), item.change);
        }
        assert!(matches!(
            &results[..],
            [
                Processed::Commit { .. },
                Processed::Message(Received::Keys {
                    taken: 0,
                    last: true,
                    ..
                }),
                Processed::Commit { .. }
            ]
        ));
        assert_eq!(run.device.group(&room_group).unwrap().epoch, 3);
        for epoch in 1..=3 {
            assert_eq!(
                run.device.content_key(&room_group, epoch).unwrap(),
                run.peer.content_key(&room_group, epoch).unwrap()
            );
        }
        // Nothing is processed twice after a restart: the log holds nothing more for it.
        assert!(sync(&run.hub, &mut run.device).is_empty());
    }
}

#[test]
fn a_commit_that_lost_its_epoch_is_decided_by_the_log_after_a_restart() {
    for crash in [false, true] {
        let mut run = Run::start(None, None);
        let room_group = run.room_group;
        run.device
            .update(&room_group, true, now())
            .unwrap()
            .unwrap();
        run.peer.update(&room_group, true, now()).unwrap().unwrap();
        post_ok(&mut run.hub, &mut run.peer);
        let own = run.device.outbox().remove(0);
        assert_eq!(
            post_all(&mut run.hub, &mut run.device),
            [Err(Error::EpochTaken)]
        );
        if crash {
            run.crash_after = Some(1);
        }
        // The refusal is written: after a restart the Commit is still held back and still pending.
        run.step(1, |_, _| Ok(()));
        assert!(run.device.outbox().is_empty());
        assert!(run.device.group(&room_group).unwrap().pending);
        let processed = sync_ok(&run.hub, &mut run.device);
        assert!(matches!(
            &processed[..],
            [Processed::Commit { superseded: Some(id), .. }] if *id == own.id
        ));
        assert!(!run.device.group(&room_group).unwrap().pending);
        // Built again, it is another Commit for another epoch.
        run.device
            .update(&room_group, true, now())
            .unwrap()
            .unwrap();
        let again = run.device.outbox().remove(0);
        assert_eq!((own.epoch, again.epoch), (1, 2));
        assert_ne!(again.parts[0], own.parts[0]);
        post_ok(&mut run.hub, &mut run.device);
        sync_ok(&run.hub, &mut run.peer);
        assert_eq!(
            run.device.content_key(&room_group, 3).unwrap(),
            run.peer.content_key(&room_group, 3).unwrap()
        );
    }
}

#[test]
fn a_founding_survives_a_crash_and_a_refusal_leaves_nothing() {
    let mut run = Run::start(Some(1), None);
    let mut agent = new_device();
    enrol(&mut run.hub, &mut run.device, &mut agent);
    publish_some(&mut run.hub, &mut run.peer, 1);
    publish_some(&mut run.hub, &mut agent, 2);
    let needed = [run.peer.id(), agent.id()];

    // Built, then a crash: the founding is still in the outbox, the same request, and the group it made is
    // held as not yet founded.
    let packages = run.hub.claim(&needed).unwrap();
    let agent_id = agent.id();
    let session = run.step(1, |_, device| {
        device.found_session(&agent_id, &packages, now())
    });
    let group = GroupId::session(run.room_group.room_id(), session);
    let entry = run.device.outbox().remove(0);
    assert_eq!(entry.kind, OutboxKind::GroupFounding);
    assert!(run.device.group(&group).unwrap().pending);
    assert_eq!(run.device.update(&group, true, now()), Err(Error::Busy));
    post_ok(&mut run.hub, &mut run.device);
    assert_eq!(run.hub.epoch(&group), Some(1));
    settle(&run.hub, &mut run.peer);
    settle(&run.hub, &mut agent);
    for other in [&run.peer, &agent] {
        assert_eq!(
            other.content_key(&group, 1).unwrap(),
            run.device.content_key(&group, 1).unwrap()
        );
    }

    // The agent device already has its session: a second founding for it is not built.
    let packages = run.hub.claim(&needed).unwrap();
    assert_eq!(
        run.device.found_session(&agent_id, &packages, now()),
        Err(Error::BadCommit)
    );
    run.memory_is_what_is_stored();

    // A founding the hub refuses, reported after a crash: the group and its keys are gone.
    let mut second = new_device();
    enrol(&mut run.hub, &mut run.device, &mut second);
    publish_some(&mut run.hub, &mut second, 1);
    let second_id = second.id();
    let packages = run.hub.claim(&[run.peer.id(), second_id]).unwrap();
    run.crash_after = Some(2);
    let refused = run.step(2, |_, device| {
        device.found_session(&second_id, &packages, now())
    });
    let refused = GroupId::session(run.room_group.room_id(), refused);
    assert!(run.device.content_key(&refused, 0).is_ok());
    // The room goes on before the founding reaches the hub: it names a room epoch behind.
    settle(&run.hub, &mut run.peer);
    run.peer
        .update(&run.room_group, true, now())
        .unwrap()
        .unwrap();
    post_ok(&mut run.hub, &mut run.peer);
    assert_eq!(
        post_all(&mut run.hub, &mut run.device),
        [Err(Error::RoomBehind)]
    );
    assert_eq!(run.device.group(&refused).err(), Some(Error::NotFound));
    assert_eq!(run.device.content_key(&refused, 0), Err(Error::NoKey));
    run.memory_is_what_is_stored();
    assert_eq!(run.device.groups().unwrap().len(), 2);
}

#[test]
fn a_key_packages_private_part_is_written_before_it_leaves_the_device() {
    let mut run = Run::start(None, None);
    let store = MemoryStorage::new();
    let handle = store.handle();
    let mut newcomer = new_device_on(store);
    // One KeyPackage handed over outside the hub, in the Request that answers an invite, and the ones to
    // publish.
    let opened = run
        .device
        .invite_open(Role::Human, None, APP, &hub_address(), now())
        .unwrap();
    let link = String::from_utf8(opened.link.expose().to_vec()).unwrap();
    let request = newcomer
        .join_request(&link, &opened.signed_offer, now())
        .unwrap()
        .signed_request;
    let id = newcomer.key_packages_to_upload(98, now()).unwrap().unwrap();
    let upload = newcomer.outbox().remove(0);
    assert_eq!((upload.id, upload.kind), (id, OutboxKind::KeyPackages));
    assert_eq!(upload.parts.len(), 3);
    drop(newcomer);

    // After a crash the upload is still to be sent, the same bytes, and every Welcome opens.
    let mut newcomer = reopen(handle.reopened()).unwrap();
    assert_eq!(newcomer.outbox(), std::slice::from_ref(&upload));
    post_ok(&mut run.hub, &mut newcomer);
    assert_eq!(run.hub.unused(&newcomer.id()), 2);
    let accepted = run
        .device
        .invite_accept(&opened.invite_id, &request, now())
        .unwrap();
    let code = newcomer.join_reveal(&accepted.signed_reveal).unwrap();
    run.device
        .invite_confirm(
            &opened.invite_id,
            &code,
            &accepted.request_hash,
            true,
            now(),
        )
        .unwrap()
        .unwrap();
    post_ok(&mut run.hub, &mut run.device);
    join_invited(&run.hub, &mut newcomer);
    assert_eq!(
        newcomer.content_key(&run.room_group, 2).unwrap(),
        run.device.content_key(&run.room_group, 2).unwrap()
    );
    // A refused upload takes the private parts with it.
    let mut refused = new_device();
    let id = refused.key_packages_to_upload(99, now()).unwrap().unwrap();
    refused.outbox_refused(id, &Error::TooMany).unwrap();
    assert!(refused.outbox().is_empty());
}

#[test]
fn a_join_from_outside_survives_a_crash_as_a_copy() {
    let mut founder = new_device();
    let (mut hub, room_group) = found_room(&mut founder);
    let store = MemoryStorage::new();
    let handle = store.handle();
    let mut joiner = new_device_on(store);
    join_room(&hub, &mut joiner, &test_keys()).unwrap();
    let entry = joiner.outbox().remove(0);
    drop(joiner);

    // After a crash the join is still a copy beside the real state, and the request is the same.
    let joiner = reopen(handle.reopened()).unwrap();
    assert_eq!(joiner.outbox(), std::slice::from_ref(&entry));
    assert!(joiner.groups().unwrap().is_empty());
    assert!(!joiner.is_human());
    // Accepted, it becomes the real state, also when the answer is reported after another crash.
    let answer = hub.post(&joiner.id(), &entry).unwrap();
    let store = handle.reopened();
    drop(joiner);
    let mut joiner = reopen(store).unwrap();
    assert_eq!(hub.post(&joiner.id(), &entry), Ok(answer));
    joiner.outbox_accepted(entry.id, answer).unwrap();
    assert!(joiner.is_human());
    assert_eq!(joiner.group(&room_group).unwrap().epoch, 1);
    sync_ok(&hub, &mut founder);
    assert_eq!(
        joiner.content_key(&room_group, 1).unwrap(),
        founder.content_key(&room_group, 1).unwrap()
    );
}

#[test]
fn a_second_owner_of_a_stored_state_is_found_out() {
    let mut run = Run::start(None, None);
    let room_group = run.room_group;
    // A second device object opens the same store: both believe in the revision they loaded.
    let mut second = reopen(run.handle.handle()).unwrap();
    assert_eq!(second.id(), run.device.id());
    run.device
        .update(&room_group, true, now())
        .unwrap()
        .unwrap();
    let revision = run.handle.revision();
    let stored = run.handle.entries();

    // Whatever the second one tries to write is refused, and nothing of it reaches the store: it signs no
    // second Commit for the epoch that leaves the device.
    let conflict = Error::Storage("another owner wrote to this state".into());
    assert_eq!(
        second.update(&room_group, true, now()),
        Err(conflict.clone())
    );
    assert_eq!(
        second.send_handover(&room_group, &run.peer.id()),
        Err(conflict.clone())
    );
    assert_eq!(second.key_package(now()), Err(conflict.clone()));
    assert!(second.outbox().is_empty());
    // It is the owner no more, and stops: also what would write nothing or only read is refused, and what it
    // held for sending before the conflict is handed out no more.
    assert!(!second.is_owner() && run.device.is_owner());
    assert_eq!(
        second.update(&room_group, false, now()),
        Err(conflict.clone())
    );
    assert_eq!(second.groups().err(), Some(conflict.clone()));
    assert_eq!(second.group(&room_group).err(), Some(conflict.clone()));
    assert_eq!(
        second.content_key(&room_group, 1).err(),
        Some(conflict.clone())
    );
    assert_eq!(
        second.outbox_accepted(1, Default::default()),
        Err(conflict.clone())
    );
    assert_eq!(run.handle.revision(), revision);
    assert_eq!(run.handle.entries(), stored);
    // It follows the log no further either: the first owner's Commit is its own key's, and it holds no
    // pending Commit to merge.
    post_ok(&mut run.hub, &mut run.device);
    sync_ok(&run.hub, &mut run.peer);
    run.peer.update(&room_group, true, now()).unwrap().unwrap();
    post_ok(&mut run.hub, &mut run.peer);
    let cursor = second.cursor();
    let results = sync(&run.hub, &mut second);
    assert!(!results.is_empty() && results.iter().all(Result::is_err));
    assert_eq!(second.cursor(), cursor);

    // What an object held for sending before it lost the store is handed out no more either: the other
    // owner may have sent or replaced it. Two objects on a copy of the state, each with the same entry.
    let copy = run.handle.reopened();
    let mut first = reopen(copy.handle()).unwrap();
    first.key_packages_to_upload(99, now()).unwrap().unwrap();
    let mut late = reopen(copy.handle()).unwrap();
    assert_eq!(late.outbox(), first.outbox());
    first.key_package(now()).unwrap();
    assert!(late.is_owner() && late.outbox().len() == 1);
    assert_eq!(late.key_package(now()), Err(conflict.clone()));
    assert!(!late.is_owner() && late.outbox().is_empty());
    assert!(first.is_owner() && first.outbox().len() == 1);
    // Opened again under the store's lock, the device is the one the store holds, with that entry.
    drop((first, late));
    let again = reopen(copy).unwrap();
    assert!(again.is_owner() && again.outbox().len() == 1);

    // The first owner goes on undisturbed.
    sync_ok(&run.hub, &mut run.device);
    assert_eq!(run.device.group(&room_group).unwrap().epoch, 3);
    run.memory_is_what_is_stored();
    // A store that is not empty takes no new device.
    assert!(matches!(
        trommi_core::device::Device::create(
            run.handle.handle(),
            Box::new(trommi_core::crypto::SystemEntropy),
        ),
        Err(Error::Storage(_))
    ));
}
