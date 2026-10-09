//! Under the cargo feature `vectors` a played-through room repeats byte for byte: with the same seeds, the
//! same clock and the same order of calls, every request a device posts is the same, in one process and in
//! another. The seeded source gives the keys; the provider's HPKE operations derive their ephemeral keys
//! from a seed and their inputs. Nothing of it is in a shipped build.
//!
//! One limit: a Commit that removes two or more leaves. OpenMLS 0.9.1 collects the Remove proposals of a
//! Commit it builds in a `HashMap` by leaf index (`member_specific_proposals` in
//! `ProposalQueue::filter_proposals`, `src/group/mls_group/proposal_store.rs`), whose order is seeded anew
//! for every map, so the proposals come out in an order the core does not choose. The core hands the leaf
//! indexes over in ascending order of device id; OpenMLS orders them again, inside the pinned crate, and
//! nothing the core passes in changes that. Such a Commit is valid in either order and every receiver
//! takes it; it is only not a fixed byte string, so no vector is made of one. The last test shows it.

use std::collections::BTreeSet;
use trommi_core::crypto::{sha256, SeededEntropy};
use trommi_core::device::{Accepted, Device, WelcomeExpectation};
use trommi_core::ids::{GroupId, Hash32};
use trommi_core::mls::profile::Cut;
use trommi_core::store::OutboxKind;
use trommi_tests::hub::Hub;
use trommi_tests::{process, test_keys, MemoryStorage, TestDevice};

/// The clock of every run: fixed, and inside the lifetime OpenMLS checks against the system's for ten years.
const NOW: u64 = 1_790_000_000_000;

/// What was posted, in order: the kind of each request and the SHA-256 of each of its parts.
type Trace = Vec<(OutboxKind, Vec<Hash32>)>;

fn device(seed: u8) -> TestDevice {
    Device::create(
        MemoryStorage::new(),
        Box::new(SeededEntropy::new([seed; 32])),
    )
    .unwrap()
}

/// Posts the outbox, records it, and processes the log up to what was accepted, until nothing is left.
fn post(hub: &mut Hub, device: &mut TestDevice, trace: &mut Trace) {
    for _ in 0..4 {
        let outbox = device.outbox();
        if outbox.is_empty() {
            return;
        }
        for entry in outbox {
            let parts = entry
                .parts
                .iter()
                .map(|part| sha256(part).unwrap())
                .collect();
            trace.push((entry.kind, parts));
            let accepted: Accepted = hub.post(&device.id(), &entry).expect("the hub accepts");
            device.outbox_accepted(entry.id, accepted).unwrap();
            follow(hub, device);
        }
    }
    panic!("the outbox does not empty");
}

/// Processes the log after the device's cursor.
fn follow(hub: &Hub, device: &mut TestDevice) {
    for item in hub.log_after(device.cursor()) {
        let _ = process(device, &item);
    }
}

/// Takes the newest Welcome and hands the Commit that made it again.
fn join(hub: &Hub, device: &mut TestDevice, by: &TestDevice) {
    let welcome = hub.welcomes.last().unwrap();
    let expected = WelcomeExpectation {
        room: by.room().unwrap(),
        committer: Some(by.id()),
    };
    device
        .join_welcome(&welcome.bytes, &expected, NOW)
        .expect("the Welcome is taken");
    for item in hub.log.iter().filter(|item| item.change >= welcome.change) {
        let _ = process(device, item);
    }
}

fn add(hub: &mut Hub, a: &mut TestDevice, newcomer: &mut TestDevice, trace: &mut Trace) {
    let package = newcomer.key_package(NOW).unwrap();
    a.add_human_device(&newcomer.id(), &package, NOW).unwrap();
    post(hub, a, trace);
    join(hub, newcomer, a);
}

/// A room played through: founding, an Add with its Welcome, an update, a single Remove, a change of
/// `agents`, a session founding and a takeover. With `two_removes`, a Commit that removes two leaves follows.
fn play(two_removes: bool) -> Trace {
    let mut trace = Trace::new();
    let mut hub = Hub::new(true);
    let (mut a, mut b, mut c) = (device(1), device(2), device(3));
    let (mut agent, mut next) = (device(4), device(5));

    let room = a.found_room(&test_keys(), NOW).unwrap();
    let room_group = GroupId::room(room);
    post(&mut hub, &mut a, &mut trace);
    add(&mut hub, &mut a, &mut b, &mut trace);
    a.update(&room_group, true, NOW).unwrap().unwrap();
    post(&mut hub, &mut a, &mut trace);
    add(&mut hub, &mut a, &mut c, &mut trace);
    a.remove_human_devices(&[Cut::none(c.id())], NOW).unwrap();
    post(&mut hub, &mut a, &mut trace);
    follow(&hub, &mut b);

    // The agent device, its session, and the takeover by another.
    a.change_agents(&[agent.id()], &[], NOW).unwrap();
    post(&mut hub, &mut a, &mut trace);
    agent
        .observe_room(hub.group_info(&room_group).unwrap(), None)
        .unwrap();
    follow(&hub, &mut b);
    let packages = [b.key_package(NOW).unwrap(), agent.key_package(NOW).unwrap()];
    let session = a.found_session(&agent.id(), &packages, NOW).unwrap();
    let group = GroupId::session(room, session);
    post(&mut hub, &mut a, &mut trace);
    join(&hub, &mut b, &a);
    join(&hub, &mut agent, &a);
    a.change_agents(&[next.id()], &[agent.id()], NOW).unwrap();
    post(&mut hub, &mut a, &mut trace);
    next.observe_room(hub.group_info(&room_group).unwrap(), None)
        .unwrap();
    let package = next.key_package(NOW).unwrap();
    a.clean_session(
        &group,
        &[Cut::none(agent.id())],
        Some((&next.id(), &package)),
        NOW,
    )
    .unwrap();
    post(&mut hub, &mut a, &mut trace);
    join(&hub, &mut next, &a);
    a.send_handover(&group, &next.id()).unwrap();
    post(&mut hub, &mut a, &mut trace);

    if two_removes {
        let (mut d, mut e) = (device(6), device(7));
        add(&mut hub, &mut a, &mut d, &mut trace);
        add(&mut hub, &mut a, &mut e, &mut trace);
        a.remove_human_devices(&[Cut::none(d.id()), Cut::none(e.id())], NOW)
            .unwrap();
        post(&mut hub, &mut a, &mut trace);
    }
    trace
}

fn digest(trace: &Trace) -> String {
    let mut all = Vec::new();
    for (kind, parts) in trace {
        all.push(*kind as u8);
        all.push(parts.len() as u8);
        for part in parts {
            all.extend_from_slice(part.as_bytes());
        }
    }
    sha256(&all).unwrap().to_string()
}

/// The digest of [`play`] without the two Removes: the same in every process.
const PLAYED: &str = "39f9f042cc0a7e1067f85f281d4231a6c2e7e263bc8e7b0cf4f8b439a9fe5a09";

#[test]
fn the_same_seeds_give_the_same_bytes_twice_in_one_process() {
    let (first, second) = (play(false), play(false));
    assert!(first.len() >= 12, "{} requests", first.len());
    for (at, (one, other)) in first.iter().zip(&second).enumerate() {
        assert_eq!(one, other, "request {at}");
    }
    assert_eq!(first.len(), second.len());
    // Every kind the walk is meant to cover was posted.
    let kinds: BTreeSet<u8> = first.iter().map(|(kind, _)| *kind as u8).collect();
    for kind in [
        OutboxKind::RoomFounding,
        OutboxKind::Commit,
        OutboxKind::GroupFounding,
        OutboxKind::Message,
    ] {
        assert!(kinds.contains(&(kind as u8)), "{kind:?}");
    }
}

#[test]
fn the_same_seeds_give_the_same_bytes_in_another_process() {
    // What this process plays is what the process that wrote the digest down played.
    assert_eq!(digest(&play(false)), PLAYED);
}

#[test]
fn a_commit_with_two_removes_is_ordered_by_openmls() {
    // Everything before the Commit with two Removes repeats; that Commit itself comes out in one of two
    // orders of its proposals, which OpenMLS picks through a randomly seeded set.
    let runs: Vec<Trace> = (0..24).map(|_| play(true)).collect();
    let before = play(false).len() + 4;
    let mut last_commits = BTreeSet::new();
    for run in &runs {
        assert_eq!(run[..before], runs[0][..before]);
        let (kind, parts) = run.last().unwrap();
        assert_eq!(*kind, OutboxKind::Commit);
        last_commits.insert(parts[0]);
    }
    assert_eq!(last_commits.len(), 2, "the orders of two Removes");
}
