//! A device that came later learns its groups' past (4.4, 9.0.5, 9.0.6): from each group's founding GroupInfo
//! through its Commits, taken only when the walk arrives at the device's own state. Then it reads every chain
//! from number 1, and holds the objects and registers an old device holds.

use trommi_core::chain::Role;
use trommi_core::codec;
use trommi_core::crypto::{Secret, SystemEntropy};
use trommi_core::device::{Draft, EnvelopeOutcome, Processed, Received};
use trommi_core::envelope::{self, Urgency};
use trommi_core::ids::BoardId;
use trommi_core::ids::{DeviceId, GroupId, SessionId};
use trommi_core::mls::profile::{CommitNote, TrommiSession};
use trommi_core::objects::Objects;
use trommi_core::recovery::RecoveryKeys;
use trommi_core::store::{table, Batch, Storage};
use trommi_core::Error;
use trommi_tests::forge::Forger;
use trommi_tests::forge_content::{Claim, Pen};
use trommi_tests::hub::content::StoredEnvelope;
use trommi_tests::hub::Hub;
use trommi_tests::{
    add_forger, add_human, add_to_session, close_invites, enrol, enrol_over, fetch_group,
    found_helper, found_main, found_room, json, learn, new_device, new_device_on, now, observe,
    post_all, post_ok, publish_some, reopen, settle, settle_joining, sync_all, test_keys,
    try_invite, write, FetchedGroup, MemoryStorage, TestDevice,
};

const ZERO_HASH: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const DESK: &str = "desk/AAAAAAAAAAAAAAAAAAAAAA";

/// A room with a main session and a helper session and a long past: three writers (a human device, the
/// session's agent device, a helper device), an Add, a Remove with a Cut, a takeover and a replaced code.
struct World {
    hub: Hub,
    /// The human device that was there from the founding.
    old: TestDevice,
    /// The agent device since the takeover.
    agent: TestDevice,
    helper: TestDevice,
    room: GroupId,
    main: GroupId,
    side: GroupId,
    /// Every device that ever wrote.
    writers: Vec<DeviceId>,
    /// The human device that was removed, and its envelope beyond its Cut in the room group.
    removed: DeviceId,
    beyond: StoredEnvelope,
    /// The code in force.
    code: Secret<32>,
    /// A Commit of the room group that lost its epoch to another: valid on its own, and of another branch.
    fork: (u64, Vec<u8>),
}

/// The world while its past is made.
struct Making {
    hub: Hub,
    old: TestDevice,
    agent: TestDevice,
    helper: TestDevice,
    room: GroupId,
    main: GroupId,
    side: GroupId,
    round: u64,
}

fn chat(group: &GroupId, text: &str) -> Draft {
    Draft::SessionChat {
        session: group.session_id().unwrap(),
        payload: json(&format!(r#"{{"text":"{text}"}}"#)),
    }
}

fn card(group: &GroupId, title: &str) -> Draft {
    Draft::CardFirst {
        session: group.session_id().unwrap(),
        urgency: Urgency::Normal,
        push: false,
        payload: json(&format!(
            r#"{{"card_type":"info","title":"{title}","previous_version_hash":"{ZERO_HASH}"}}"#
        )),
    }
}

fn note(lamport: u64) -> Draft {
    Draft::NoteFirst {
        payload: json(&format!(
            r#"{{"text":"n","lamport":{lamport},"previous_version_hash":"{ZERO_HASH}"}}"#
        )),
    }
}

fn desk(room: &GroupId, name: &str) -> Draft {
    Draft::Register {
        group: *room,
        name: DESK.into(),
        value: Some(json(&format!(r#"{{"name":"{name}"}}"#))),
    }
}

impl Making {
    fn sync(&mut self) {
        let hub = &self.hub;
        for device in [&mut self.old, &mut self.agent, &mut self.helper] {
            sync_all(hub, device);
        }
    }

    /// One round: every writer writes in its groups, then each group takes a new epoch.
    fn round(&mut self) {
        self.round += 1;
        let n = self.round;
        let (room, main, side) = (self.room, self.main, self.side);
        write(&mut self.hub, &mut self.old, &note(n));
        write(
            &mut self.hub,
            &mut self.old,
            &desk(&room, &format!("desk {n}")),
        );
        write(
            &mut self.hub,
            &mut self.old,
            &chat(&main, &format!("to the agent {n}")),
        );
        self.sync();
        write(
            &mut self.hub,
            &mut self.agent,
            &card(&main, &format!("card {n}")),
        );
        write(
            &mut self.hub,
            &mut self.agent,
            &chat(&side, &format!("to the helper {n}")),
        );
        self.sync();
        write(
            &mut self.hub,
            &mut self.helper,
            &chat(&side, &format!("done {n}")),
        );
        self.sync();
        for group in [room, main, side] {
            self.old.update(&group, true, now()).unwrap().unwrap();
            post_ok(&mut self.hub, &mut self.old);
            self.sync();
        }
    }

    fn rounds(&mut self, rounds: usize) {
        for _ in 0..rounds {
            self.round();
        }
    }
}

impl World {
    fn groups(&self) -> [GroupId; 3] {
        [self.room, self.main, self.side]
    }

    fn keys(&self) -> RecoveryKeys {
        RecoveryKeys::from_code(self.code.duplicate()).unwrap()
    }

    fn sync(&mut self) {
        let hub = &self.hub;
        for device in [&mut self.old, &mut self.agent, &mut self.helper] {
            sync_all(hub, device);
        }
    }

    /// The same writing as while the past was made.
    fn round(&mut self) {
        let mut making = Making {
            hub: std::mem::replace(&mut self.hub, Hub::new(true)),
            old: std::mem::replace(&mut self.old, new_device()),
            agent: std::mem::replace(&mut self.agent, new_device()),
            helper: std::mem::replace(&mut self.helper, new_device()),
            room: self.room,
            main: self.main,
            side: self.side,
            round: 10_000 + self.hub.change(),
        };
        making.round();
        self.hub = making.hub;
        self.old = making.old;
        self.agent = making.agent;
        self.helper = making.helper;
    }
}

/// The world, with `rounds` rounds of writing between each two events of its past.
fn world(rounds: usize) -> World {
    let (mut old, mut first_agent, mut helper) = (new_device(), new_device(), new_device());
    let (mut hub, room) = found_room(&mut old);
    publish_some(&mut hub, &mut old, 8);
    enrol(&mut hub, &mut old, &mut first_agent);
    publish_some(&mut hub, &mut first_agent, 1);
    let main = found_main(&mut hub, &mut old, &first_agent.id());
    settle(&hub, &mut first_agent);
    observe(&hub, &mut helper);
    helper
        .observe_session(hub.group_info(&main).unwrap())
        .unwrap();
    let side = found_helper(&mut hub, &mut first_agent, &main, &mut [&mut helper]);
    let mut writers = vec![old.id(), first_agent.id(), helper.id()];
    let mut w = Making {
        hub,
        old,
        agent: first_agent,
        helper,
        room,
        main,
        side,
        round: 0,
    };
    w.sync();
    w.rounds(rounds);

    // An Add: a second human device comes, is taken into both sessions, and writes.
    let mut second = new_device();
    add_human(&mut w.hub, &mut w.old, &mut second);
    publish_some(&mut w.hub, &mut second, 4);
    for group in [main, side] {
        add_to_session(&mut w.hub, &mut w.old, &mut second, &group);
        w.sync();
    }
    settle_joining(&w.hub, &mut second);
    sync_all(&w.hub, &mut second);
    writers.push(second.id());
    write(&mut w.hub, &mut second, &note(1_000));
    write(
        &mut w.hub,
        &mut second,
        &chat(&main, "from the second device"),
    );
    w.sync();
    sync_all(&w.hub, &mut second);
    w.rounds(rounds);

    // Two Commits race for one epoch of the room group: the second device's loses and stays a fork.
    sync_all(&w.hub, &mut second);
    second.update(&room, true, now()).unwrap().unwrap();
    let lost = second.outbox().remove(0);
    let fork = (lost.epoch, lost.parts[0].clone());
    w.old.update(&room, true, now()).unwrap().unwrap();
    post_ok(&mut w.hub, &mut w.old);
    assert_eq!(post_all(&mut w.hub, &mut second), [Err(Error::EpochTaken)]);
    w.sync();
    sync_all(&w.hub, &mut second);

    // A Remove with a Cut: the second device wrote once more, which the remover had not accepted.
    let last = write(&mut w.hub, &mut second, &note(2_000));
    let beyond = w
        .hub
        .content
        .envelopes
        .iter()
        .find(|stored| stored.hash == last.envelope_hash)
        .unwrap()
        .clone();
    let cut = w.old.cut_of(&room, &second.id()).unwrap();
    assert_eq!(cut.seq + 1, last.seq);
    w.old.remove_human_devices(&[cut], now()).unwrap();
    post_ok(&mut w.hub, &mut w.old);
    w.sync();
    for group in [main, side] {
        let cut = w.old.cut_of(&group, &second.id()).unwrap();
        w.old.clean_session(&group, &[cut], None, now()).unwrap();
        post_ok(&mut w.hub, &mut w.old);
        w.sync();
    }
    w.rounds(rounds);

    // A takeover: another agent device takes the main session, and with it the helper session.
    let mut next = new_device();
    enrol_over(&mut w.hub, &mut w.old, &mut next, &main);
    // The device that was taken out has nothing more to follow.
    let gone = std::mem::replace(&mut w.agent, next).id();
    w.sync();
    for group in [main, side] {
        let cut = w.old.cut_of(&group, &gone).unwrap();
        let package = w.agent.key_package(now()).unwrap();
        let next = w.agent.id();
        w.old
            .clean_session(&group, &[cut], Some((&next, &package)), now())
            .unwrap();
        post_ok(&mut w.hub, &mut w.old);
        w.sync();
        w.old.send_handover(&group, &next).unwrap();
        post_ok(&mut w.hub, &mut w.old);
    }
    w.sync();
    // The takeover is finished: the session is free for the next one.
    close_invites(&w.hub, &mut w.old);
    assert_eq!(w.agent.groups().unwrap().len(), 2);
    writers.push(w.agent.id());
    w.rounds(rounds);

    // The code is replaced.
    let replacement = test_keys()
        .replace(
            &mut SystemEntropy,
            &room.room_id(),
            w.old.room_history().unwrap(),
        )
        .unwrap();
    w.old
        .replace_code(&test_keys(), &replacement, b"copies", now())
        .unwrap();
    post_ok(&mut w.hub, &mut w.old);
    w.sync();
    w.rounds(rounds);
    World {
        hub: w.hub,
        old: w.old,
        agent: w.agent,
        helper: w.helper,
        room,
        main,
        side,
        writers,
        removed: second.id(),
        beyond,
        code: replacement.code.duplicate(),
        fork,
    }
}

/// Every envelope the hub serves of `group`, in the hub's order; what lies beyond a Cut is not served.
fn served_of(hub: &Hub, group: &GroupId) -> Vec<StoredEnvelope> {
    hub.content
        .envelopes
        .iter()
        .filter(|stored| stored.header.group == *group && !stored.cut)
        .cloned()
        .collect()
}

/// Whether `new` holds of `group` what `old` holds: every writer's chain, every object, the desk.
fn assert_same_view(w: &World, old: &TestDevice, new: &TestDevice, group: &GroupId) {
    for writer in &w.writers {
        assert_eq!(
            new.chain_head(group, writer).unwrap(),
            old.chain_head(group, writer).unwrap(),
            "the chain of {writer} in {group}"
        );
        assert_eq!(
            new.chain_cut(group, writer).unwrap(),
            old.chain_cut(group, writer).unwrap()
        );
    }
    assert_eq!(new.objects(group).unwrap(), old.objects(group).unwrap());
    let read = |device: &TestDevice| {
        device
            .register(group, DESK)
            .unwrap()
            .map(|value| value.expose().to_vec())
    };
    assert_eq!(read(new), read(old));
}

/// Reads every chain of `group` from number 1 in pruned form.
fn read_pruned(w: &World, device: &mut TestDevice, group: &GroupId) {
    let served = served_of(&w.hub, group);
    assert!(served.len() > 5);
    for stored in &served {
        let got = device
            .receive_envelope(
                &stored.pruned(),
                stored.change,
                true,
                stored.void_code.as_ref(),
                now(),
            )
            .unwrap();
        assert_eq!(got.outcome, EnvelopeOutcome::Chained, "{:?}", got.code);
    }
}

/// Reads every chain of `group` from number 1 in pruned form, then every body out of order.
fn read_all(w: &World, device: &mut TestDevice, group: &GroupId) {
    let served = served_of(&w.hub, group);
    assert!(served.len() > 5);
    for stored in &served {
        let got = device
            .receive_envelope(
                &stored.pruned(),
                stored.change,
                true,
                stored.void_code.as_ref(),
                now(),
            )
            .unwrap();
        assert_eq!(got.outcome, EnvelopeOutcome::Chained, "{:?}", got.code);
        assert_eq!(got.code, Some(Error::Pruned));
    }
    for stored in served.iter().rev() {
        let got = device
            .receive_envelope(&stored.bytes, stored.change, false, None, now())
            .unwrap();
        assert_eq!(got.outcome, EnvelopeOutcome::Applied, "{:?}", got.code);
        assert!(got.body.is_some());
    }
}

#[test]
fn a_device_that_joins_by_link_reads_everything_from_number_one() {
    let mut w = world(6);
    let (room, main, side) = (w.room, w.main, w.side);
    assert!(w.hub.epoch(&room).unwrap() >= 30);
    assert!(w.hub.epoch(&main).unwrap() >= 20 && w.hub.epoch(&side).unwrap() >= 20);

    // The Welcome into the room group.
    let mut new = new_device();
    add_human(&mut w.hub, &mut w.old, &mut new);
    publish_some(&mut w.hub, &mut new, 4);
    let joined = new.group(&room).unwrap();
    assert!(joined.own_from > 30 && !joined.past_learned);

    // Before the past is learned an envelope of an earlier epoch is `group-behind` and consumes nothing.
    let first = served_of(&w.hub, &room).remove(0);
    let early = new
        .receive_envelope(&first.bytes, first.change, true, None, now())
        .unwrap();
    assert_eq!(
        (early.outcome, early.code),
        (EnvelopeOutcome::Refused, Some(Error::GroupBehind))
    );
    assert_eq!(new.chain_head(&room, &w.old.id()).unwrap().seq, 0);

    // The room's past, then everything of the room in the hub's order: the envelopes take their places
    // from number 1, without their bodies, since no key of those epochs is here yet.
    let learned = learn(&w.hub, &mut new, &room).unwrap();
    assert_eq!(learned.epochs, joined.own_from);
    assert!(new.group(&room).unwrap().past_learned);
    assert_eq!(learn(&w.hub, &mut new, &room).unwrap().epochs, 0);
    assert_eq!(
        new.room_history().unwrap().states().count() as u64,
        w.hub.epoch(&room).unwrap() + 1
    );
    for stored in served_of(&w.hub, &room) {
        let got = new
            .receive_envelope(&stored.bytes, stored.change, true, None, now())
            .unwrap();
        assert_eq!(
            (got.outcome, got.code),
            (EnvelopeOutcome::Chained, Some(Error::NoKey))
        );
    }
    assert!(new.register(&room, DESK).unwrap().is_none());
    // What lies beyond the Cut that the past brought is refused.
    assert_eq!(
        new.chain_cut(&room, &w.removed).unwrap(),
        w.old.chain_cut(&room, &w.removed).unwrap()
    );
    let beyond = new
        .receive_envelope(&w.beyond.bytes, w.beyond.change, true, None, now())
        .unwrap();
    assert_eq!(beyond.code, Some(Error::RemovedSender));

    // The handover arrives: the bodies open from the bytes handed in again, in any order.
    w.old.send_handover(&room, &new.id()).unwrap();
    post_ok(&mut w.hub, &mut w.old);
    let processed = settle(&w.hub, &mut new);
    assert!(matches!(
        processed.last(),
        Some(Processed::Message(Received::Keys { taken, last: true, .. })) if *taken > 30
    ));
    for stored in served_of(&w.hub, &room).iter().rev() {
        let got = new
            .receive_envelope(&stored.bytes, stored.change, false, None, now())
            .unwrap();
        assert_eq!(got.outcome, EnvelopeOutcome::Applied, "{:?}", got.code);
        assert!(got.body.is_some());
    }
    assert_same_view(&w, &w.old, &new, &room);

    // Handed again, an envelope the chain holds says what it is, and nothing changes: a register names
    // itself and says whether its value is the current one of its name now. A client that rebuilds what
    // it shows from reading back alone learns every name and which value counts.
    let mut current = Vec::new();
    for stored in served_of(&w.hub, &room) {
        let got = new
            .receive_envelope(&stored.bytes, stored.change, false, None, now())
            .unwrap();
        assert_eq!(got.outcome, EnvelopeOutcome::Applied);
        let is_register = matches!(got.header.subject, envelope::Subject::Register(_));
        assert_eq!(got.register.is_some(), is_register);
        assert!(!got.replayed);
        if let Some(register) = got.register.filter(|register| register.current) {
            current.push((register.name, register.of, stored.hash));
        }
    }
    let desks: Vec<_> = current.iter().filter(|(name, _, _)| name == DESK).collect();
    assert_eq!(desks.len(), 1);
    let newest_desk = served_of(&w.hub, &room)
        .into_iter()
        .rfind(|stored| {
            matches!(stored.header.subject, envelope::Subject::Register(_))
                && stored.header.sender == w.old.id()
        })
        .unwrap();
    assert_eq!(desks[0].2, newest_desk.hash);
    let mut names: Vec<_> = current.iter().map(|(name, of, _)| (name, of)).collect();
    names.sort();
    names.dedup();
    assert_eq!(names.len(), current.len());
    assert_same_view(&w, &w.old, &new, &room);

    // The sessions: a session's past needs the room's, a helper session's its main session's.
    for group in [main, side] {
        add_to_session(&mut w.hub, &mut w.old, &mut new, &group);
        w.sync();
    }
    assert_eq!(settle_joining(&w.hub, &mut new).len(), 2);
    assert_eq!(learn(&w.hub, &mut new, &side), Err(Error::GroupBehind));
    for group in [main, side] {
        let before = new.group(&group).unwrap();
        assert!(before.own_from > 20 && !before.past_learned);
        assert_eq!(
            learn(&w.hub, &mut new, &group).unwrap().epochs,
            before.own_from
        );
        read_all(&w, &mut new, &group);
        assert_same_view(&w, &w.old, &new, &group);
    }
    assert!(new.findings().unwrap().is_empty());

    // It goes on as any device: what is written now reaches it and the others alike.
    w.round();
    sync_all(&w.hub, &mut new);
    for group in w.groups() {
        assert_same_view(&w, &w.old, &new, &group);
    }
}

#[test]
fn a_device_that_signs_in_with_the_code_reads_everything_from_number_one() {
    let mut w = world(2);
    // The code was replaced: the device signs in with the new one.
    let mut new = new_device();
    let keys = w.keys();
    trommi_tests::join_room(&w.hub, &mut new, &keys).unwrap();
    post_ok(&mut w.hub, &mut new);
    for group in w.hub.live_sessions() {
        trommi_tests::join_session(&w.hub, &mut new, &keys, &group).unwrap();
        post_ok(&mut w.hub, &mut new);
    }
    w.sync();
    for group in w.groups() {
        let summary = new.group(&group).unwrap();
        assert!(summary.own_from > 10 && summary.past_learned, "{group}");
        // Nothing is fetched a second time for the past.
        assert_eq!(learn(&w.hub, &mut new, &group).unwrap().epochs, 0);
        read_all(&w, &mut new, &group);
        assert_same_view(&w, &w.old, &new, &group);
    }
    let beyond = new
        .receive_envelope(&w.beyond.bytes, w.beyond.change, true, None, now())
        .unwrap();
    assert_eq!(beyond.code, Some(Error::RemovedSender));
    w.round();
    sync_all(&w.hub, &mut new);
    for group in w.groups() {
        assert_same_view(&w, &w.old, &new, &group);
    }
}

#[test]
fn an_agent_device_that_takes_a_session_over_reads_its_past_and_nothing_of_the_room() {
    let mut w = world(2);
    let (room, main, side) = (w.room, w.main, w.side);
    let mut next = new_device();
    enrol_over(&mut w.hub, &mut w.old, &mut next, &main);
    let gone = std::mem::replace(&mut w.agent, next).id();
    w.sync();
    for group in [main, side] {
        let cut = w.old.cut_of(&group, &gone).unwrap();
        let package = w.agent.key_package(now()).unwrap();
        let next = w.agent.id();
        w.old
            .clean_session(&group, &[cut], Some((&next, &package)), now())
            .unwrap();
        post_ok(&mut w.hub, &mut w.old);
        w.sync();
        // With history: the keys of that group are handed over in it.
        w.old.send_handover(&group, &next).unwrap();
        post_ok(&mut w.hub, &mut w.old);
    }
    w.sync();
    let mut next = std::mem::replace(&mut w.agent, new_device());
    assert_eq!(next.groups().unwrap().len(), 2);

    // It follows the room group from the epoch it was enrolled at: the session's Commits name older ones.
    let followed = next.group_past(&room).unwrap().unwrap();
    assert!(followed.from_epoch > 10 && !followed.learned);
    assert_eq!(learn(&w.hub, &mut next, &main), Err(Error::RoomBehind));
    assert_eq!(
        learn(&w.hub, &mut next, &room).unwrap().epochs,
        followed.from_epoch
    );
    assert_eq!(
        next.room_history().unwrap().states().count() as u64,
        w.hub.epoch(&room).unwrap() + 1
    );
    for group in [main, side] {
        assert!(learn(&w.hub, &mut next, &group).unwrap().epochs > 10);
        read_all(&w, &mut next, &group);
        assert_same_view(&w, &w.old, &next, &group);
    }
    // Of the room it holds the public state alone: no key, no envelope, no group.
    assert!(next.groups().unwrap().iter().all(|held| held.group != room));
    for epoch in 0..=w.hub.epoch(&room).unwrap() {
        assert_eq!(next.content_key(&room, epoch), Err(Error::NoKey));
    }
    let first = served_of(&w.hub, &room).remove(0);
    for ordered in [true, false] {
        let got = next
            .receive_envelope(&first.bytes, first.change, ordered, None, now())
            .unwrap();
        assert_eq!(
            (got.outcome, got.code),
            (EnvelopeOutcome::Refused, Some(Error::GroupBehind))
        );
    }
    // A restart finds the same past.
    assert!(next.group_past(&room).unwrap().unwrap().learned);
}

/// A device on a store the test can see, added to the room group of `w`.
fn newcomer(w: &mut World) -> (TestDevice, MemoryStorage) {
    let store = MemoryStorage::new();
    let handle = store.handle();
    let mut new = new_device_on(store);
    add_human(&mut w.hub, &mut w.old, &mut new);
    (new, handle)
}

fn learn_from(
    device: &mut TestDevice,
    group: &GroupId,
    served: &FetchedGroup,
) -> Result<u64, Error> {
    served
        .served(|served| device.learn_history(group, served.founding, served.commits))
        .map(|learned| learned.epochs)
}

#[test]
fn a_hostile_hub_serves_no_past_of_its_own() {
    let mut w = world(1);
    let room = w.room;
    // A third human device, whose Commit loses the epoch that the newcomer's Add takes: a branch of one
    // Commit that is valid in every way.
    let mut third = new_device();
    add_human(&mut w.hub, &mut w.old, &mut third);
    sync_all(&w.hub, &mut third);
    w.sync();
    // And a human device whose key the test holds, which was a leaf in an epoch that ended since.
    let forger = Forger::new();
    add_forger(&mut w.hub, &mut w.old, &forger);
    w.sync();
    sync_all(&w.hub, &mut third);
    let written_in = w.hub.epoch(&room).unwrap();
    let claim = Claim {
        group: room,
        epoch: written_in,
        role: Role::Human,
        seat: None,
        key: w.old.content_key(&room, written_in).unwrap(),
    };
    w.old.update(&room, true, now()).unwrap().unwrap();
    post_ok(&mut w.hub, &mut w.old);
    w.sync();
    sync_all(&w.hub, &mut third);
    third.update(&room, true, now()).unwrap().unwrap();
    let branch = third.outbox().remove(0);
    let (mut new, store) = newcomer(&mut w);
    let from = new.group(&room).unwrap().own_from;
    assert_eq!(branch.epoch + 1, from);
    let real = fetch_group(&w.hub, &room);
    assert_eq!(real.commits.len() as u64, from);

    let mut hostile: Vec<(&str, FetchedGroup)> = Vec::new();
    let mut served = real.clone();
    served.commits.remove(3);
    hostile.push(("a Commit dropped", served));
    let mut served = real.clone();
    served.commits.swap(3, 4);
    hostile.push(("two Commits in the other order", served));
    let mut served = real.clone();
    served.commits[w.fork.0 as usize].1 = w.fork.1.clone();
    hostile.push(("a Commit of another branch in the middle", served));
    let mut served = real.clone();
    served.commits.last_mut().unwrap().1 = branch.parts[0].clone();
    hostile.push(("a valid history that arrives elsewhere", served));
    let mut served = real.clone();
    served.commits.truncate(from as usize - 1);
    hostile.push(("a history cut short", served));
    let mut served = real.clone();
    served.commits.clear();
    hostile.push(("a founding alone", served));
    let first = w.old.room_history().unwrap().at(0).unwrap().room.clone();
    let hub_itself = Forger::new();
    let forged = hub_itself.found_room(&room, &first);
    let mut served = real.clone();
    served.founding = hub_itself.group_info(&forged);
    hostile.push(("a founding of the hub's own making", served));
    let mut served = real.clone();
    served.founding = w.hub.group_info_at(&room, 1).unwrap().clone();
    served.commits.remove(0);
    hostile.push(("a start that is not the founding", served));
    let mut served = real.clone();
    served.founding = fetch_group(&w.hub, &w.main).founding;
    hostile.push(("the founding of another group", served));
    let mut served = real.clone();
    served.commits[2].1 = vec![0xFF; 40];
    hostile.push(("bytes that are no Commit", served));

    let before = store.entries();
    for (what, served) in &hostile {
        assert_eq!(
            learn_from(&mut new, &room, served),
            Err(Error::BadGroup),
            "{what}"
        );
        assert!(store.entries() == before, "{what}: nothing is written");
        assert!(!new.group(&room).unwrap().past_learned);
    }
    assert!(new.findings().unwrap().is_empty());
    // An envelope of the past stays where it was, and the device still works.
    let first = served_of(&w.hub, &room).remove(0);
    let got = new
        .receive_envelope(&first.bytes, first.change, true, None, now())
        .unwrap();
    assert_eq!(got.code, Some(Error::GroupBehind));
    new.update(&room, true, now()).unwrap().unwrap();
    post_ok(&mut w.hub, &mut new);
    // The group's own history is taken, with more Commits behind it than the device needs.
    assert_eq!(
        learn_from(&mut new, &room, &fetch_group(&w.hub, &room)),
        Ok(from)
    );
    let got = new
        .receive_envelope(&first.bytes, first.change, true, None, now())
        .unwrap();
    assert_eq!(
        (got.outcome, got.code),
        (EnvelopeOutcome::Chained, Some(Error::NoKey))
    );
    // What lies beyond a Cut that the past brought is refused.
    let beyond = new
        .receive_envelope(&w.beyond.bytes, w.beyond.change, true, None, now())
        .unwrap();
    assert_eq!(beyond.code, Some(Error::RemovedSender));
    // An envelope of a learned epoch is read back, wherever it stands in the log: its `time` is held
    // against the `time` of the Commit that ended its epoch. One written five minutes after it is not
    // fresh; it keeps its number and is never applied.
    let board_item = envelope::Draft::board_item(
        BoardId::ALL_DESKS,
        br#"{"content_type":"erase","shape_ids":["AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/1/0"]}"#,
    );
    let mut pen = Pen::new(&forger.key);
    let timely = pen.sign(&claim, &board_item, &Objects::new(), now());
    let late = pen.sign(&claim, &board_item, &Objects::new(), now() + 6 * 60 * 1000);
    let ahead = new.cursor() + 10;
    let got = new
        .receive_envelope(&timely.encode().unwrap(), ahead, true, None, now())
        .unwrap();
    assert_eq!(
        (got.outcome, got.code),
        (EnvelopeOutcome::Chained, Some(Error::NoKey))
    );
    let got = new
        .receive_envelope(&late.encode().unwrap(), ahead + 1, true, None, now())
        .unwrap();
    assert_eq!(
        (got.outcome, got.code),
        (EnvelopeOutcome::Chained, Some(Error::WrongEpoch))
    );
    assert_eq!(new.chain_head(&room, &pen.id()).unwrap().seq, 2);
    let _ = third;
}

#[test]
fn a_crash_in_the_middle_of_learning_leaves_nothing_half_written() {
    let mut w = world(1);
    let room = w.room;
    let (mut new, store) = newcomer(&mut w);
    let before = store.entries();
    store.fail_apply(1);
    assert!(matches!(
        learn(&w.hub, &mut new, &room),
        Err(Error::Storage(_))
    ));
    assert!(store.entries() == before);
    assert!(!new.group(&room).unwrap().past_learned);
    // After the crash the device opens as it was, and learns.
    drop(new);
    let mut new = reopen(store.reopened()).unwrap();
    assert!(!new.group(&room).unwrap().past_learned);
    let first = served_of(&w.hub, &room).remove(0);
    let got = new
        .receive_envelope(&first.bytes, first.change, true, None, now())
        .unwrap();
    assert_eq!(got.code, Some(Error::GroupBehind));
    assert!(learn(&w.hub, &mut new, &room).unwrap().epochs > 5);
    let got = new
        .receive_envelope(&first.bytes, first.change, true, None, now())
        .unwrap();
    assert_eq!(got.outcome, EnvelopeOutcome::Chained);
}

#[test]
fn a_damaged_learned_record_does_not_open() {
    let mut w = world(1);
    let room = w.room;
    let (mut new, store) = newcomer(&mut w);
    learn(&w.hub, &mut new, &room).unwrap();
    drop(new);
    assert!(reopen(store.reopened()).is_ok());
    let id = room.as_bytes();
    let record = |epoch: u64| {
        [
            &[table::CHAIN, 0, id.len() as u8][..],
            id,
            &epoch.to_be_bytes(),
        ]
        .concat()
    };
    let origin = [&[table::CHAIN, 10, id.len() as u8][..], id].concat();
    let learned = store.get(&record(2)).unwrap();
    let own = store.get(&record(learned_upto(&store, &origin))).unwrap();
    let flag = |value: &[u8], byte: u8| {
        let mut changed = value.to_vec();
        *changed.last_mut().unwrap() = byte;
        changed
    };
    let mut damages: Vec<(&str, Batch)> = Vec::new();
    let mut batch = Batch::new();
    batch.put(record(2), flag(&learned, 0));
    damages.push(("a learned epoch that says it is the device's own", batch));
    let mut batch = Batch::new();
    batch.put(record(2), flag(&learned, 2));
    damages.push(("a mark that is none", batch));
    let mut batch = Batch::new();
    batch.put(record(2), learned[..learned.len() - 3].to_vec());
    damages.push(("a record cut short", batch));
    let mut batch = Batch::new();
    batch.delete(record(2));
    damages.push(("a hole in the past", batch));
    let mut batch = Batch::new();
    batch.delete(record(0));
    damages.push(("a past without its beginning", batch));
    let mut batch = Batch::new();
    batch.put(record(learned_upto(&store, &origin)), flag(&own, 1));
    damages.push(("an own epoch that says it was learned", batch));
    let mut batch = Batch::new();
    batch.delete(origin.clone());
    damages.push(("no origin", batch));
    let mut batch = Batch::new();
    batch.put(origin.clone(), vec![0xFF; 12]);
    damages.push(("an origin that does not decode", batch));
    // An origin whose context is no GroupContext, or the GroupContext of another epoch.
    let held = store.get(&origin).unwrap();
    let length = held.len();
    let mut batch = Batch::new();
    batch.put(
        origin.clone(),
        [&held[..8], &[1, 0x77], &held[length - 1..]].concat(),
    );
    damages.push(("an origin with a context of one byte", batch));
    let mut batch = Batch::new();
    let mut other_epoch = held.clone();
    other_epoch[7] ^= 1;
    batch.put(origin.clone(), other_epoch);
    damages.push(("an origin with the context of another epoch", batch));
    for (what, batch) in damages {
        let mut damaged = store.reopened();
        let revision = damaged.revision();
        damaged.apply(revision, batch).unwrap();
        assert!(matches!(reopen(damaged), Err(Error::Storage(_))), "{what}");
    }
    // A group the device follows as an observer, of which it keeps no epoch records, has its origin too.
    let watching = MemoryStorage::new();
    let handle = watching.handle();
    let mut follower = new_device_on(watching);
    observe(&w.hub, &mut follower);
    drop(follower);
    assert!(reopen(handle.reopened()).is_ok());
    let mut damaged = handle.reopened();
    let revision = damaged.revision();
    let mut batch = Batch::new();
    batch.delete(origin.clone());
    damaged.apply(revision, batch).unwrap();
    assert!(matches!(reopen(damaged), Err(Error::Storage(_))));
}

/// The epoch a stored origin names.
fn learned_upto(store: &MemoryStorage, origin: &[u8]) -> u64 {
    let value = store.get(origin).unwrap();
    u64::from_be_bytes(value[..8].try_into().unwrap())
}

#[test]
fn first_contact_finds_a_helper_session_that_its_main_sessions_agent_did_not_found() {
    // A hub that checks nothing stores a helper session founded by an agent device that is not the main
    // session's agent leaf. The human devices that were there find it when they join and remove the device;
    // what is left looks like any helper session.
    let (mut a, mut b, mut agent) = (new_device(), new_device(), new_device());
    let mut hub = Hub::new(false);
    let room = trommi_tests::found_room_on(&mut hub, &mut a);
    add_human(&mut hub, &mut a, &mut b);
    for device in [&mut a, &mut b] {
        publish_some(&mut hub, device, 4);
    }
    enrol(&mut hub, &mut a, &mut agent);
    publish_some(&mut hub, &mut agent, 1);
    let main = found_main(&mut hub, &mut a, &agent.id());
    // No device builds this founding: the other agent device is a member that obeys MLS only.
    let other = Forger::new();
    try_invite(
        &mut a,
        &mut other.invitee(),
        trommi_core::invite::Role::Agent,
        None,
    )
    .unwrap();
    post_ok(&mut hub, &mut a);
    settle(&hub, &mut b);
    let packages = hub.claim(&[a.id(), b.id()]).unwrap();
    let session = TrommiSession {
        room_id: room.room_id(),
        session_id: SessionId::new([6; 16]),
        parent: main.session_id().unwrap(),
    };
    let group = session.group_id();
    let mut forged = other.found_session(&session);
    let info_0 = other.group_info(&forged);
    let state = a.room_history().unwrap().newest().clone();
    let note = CommitNote {
        room_epoch: state.epoch,
        room_state: state.state,
        time: now(),
        cuts: Vec::new(),
        join: false,
    };
    let first = other.commit(&mut forged, &codec::encode(&note).unwrap(), &packages);
    other
        .post_founding(&mut hub, &group, &info_0, &first)
        .unwrap();
    for device in [&mut a, &mut b] {
        assert_eq!(settle_joining(&hub, device)[0].offending, [other.id()]);
    }
    // The repair removes the device and adds the opener the group lacks: the main session's agent leaf
    // (5.2.8). The Remove alone would leave the group stale.
    let cuts = trommi_tests::cuts_for(&a, &group);
    assert_eq!(
        a.clean_session(&group, &cuts, None, now()),
        Err(Error::StaleSession)
    );
    let of_agent = hub.claim(&[agent.id()]).unwrap().remove(0);
    a.clean_session(&group, &cuts, Some((&agent.id(), &of_agent)), now())
        .unwrap();
    post_ok(&mut hub, &mut a);
    settle(&hub, &mut b);
    assert!(b.content_key(&group, 2).is_ok());

    // A device that comes later joins a group whose leaves all belong.
    let store = MemoryStorage::new();
    let handle = store.handle();
    let mut late = new_device_on(store);
    add_human(&mut hub, &mut b, &mut late);
    publish_some(&mut hub, &mut late, 4);
    for of in [main, group] {
        add_to_session(&mut hub, &mut b, &mut late, &of);
        settle(&hub, &mut b);
    }
    let joined = settle_joining(&hub, &mut late);
    assert!(joined.len() == 2 && joined.iter().all(|joined| joined.offending.is_empty()));
    let epoch = late.group(&group).unwrap().epoch;
    assert!(late.content_key(&group, epoch).is_ok());
    learn(&hub, &mut late, &room).unwrap();
    learn(&hub, &mut late, &main).unwrap();

    // A history that is not the group's own says nothing about the group.
    let real = fetch_group(&hub, &group);
    let mut short = real.clone();
    short.commits.truncate(1);
    assert_eq!(
        short.served(|served| late.verify_founding(&group, served)),
        Err(Error::BadGroup)
    );
    assert!(late.content_key(&group, epoch).is_ok());
    assert!(late.findings().unwrap().is_empty());

    // Its own history shows who founded it: the finding, and the session is closed.
    assert_eq!(
        real.served(|served| late.verify_founding(&group, served)),
        Err(Error::BadGroup)
    );
    let findings = late.findings().unwrap();
    assert_eq!(findings.len(), 1);
    assert_eq!(
        (findings[0].group, &findings[0].code),
        (group, &Error::BadGroup)
    );
    assert_eq!(late.content_key(&group, epoch), Err(Error::NoKey));
    assert!(!late.group_past(&group).unwrap().unwrap().learned);
    assert_eq!(
        late.seal(&chat(&group, "into a closed session"), None, &[], now())
            .map(|_| ()),
        Err(Error::BadGroup)
    );
    drop(late);
    let mut late = reopen(handle.reopened()).unwrap();
    assert_eq!(late.content_key(&group, epoch), Err(Error::NoKey));
    assert_eq!(late.findings().unwrap().len(), 1);
    // The group's leaves all belong by now, and another device's update changes nothing about its past:
    // the session stays closed.
    b.update(&group, true, now()).unwrap().unwrap();
    post_ok(&mut hub, &mut b);
    settle(&hub, &mut late);
    let epoch = late.group(&group).unwrap().epoch;
    assert_eq!(epoch, hub.epoch(&group).unwrap());
    assert_eq!(late.content_key(&group, epoch), Err(Error::NoKey));
    drop(late);
    let mut late = reopen(handle.reopened()).unwrap();
    assert_eq!(late.content_key(&group, epoch), Err(Error::NoKey));
    // Removed and let in again with a fresh KeyPackage (3.7), it joins from the Welcome a group whose
    // leaves all belong: the session stays closed all the same (5.2.6).
    let package = late.key_package(now()).unwrap();
    b.readmit_human(&group, &late.id(), &package, now())
        .unwrap();
    post_ok(&mut hub, &mut b);
    assert_eq!(settle_joining(&hub, &mut late).len(), 1);
    let epoch = late.group(&group).unwrap().epoch;
    assert_eq!(epoch, hub.epoch(&group).unwrap());
    assert_eq!(late.content_key(&group, epoch), Err(Error::NoKey));
    assert_eq!(late.findings().unwrap().len(), 1);
    drop(late);
    let late = reopen(handle.reopened()).unwrap();
    assert_eq!(late.content_key(&group, epoch), Err(Error::NoKey));
}

fn erase() -> Draft {
    Draft::BoardItem {
        board: BoardId::ALL_DESKS,
        payload: json(
            r#"{"content_type":"erase","shape_ids":["AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/1/0"]}"#,
        ),
    }
}

#[test]
fn a_chain_that_begins_at_a_snapshots_frontier_goes_on_and_is_verified_from_number_one_later() {
    use trommi_core::board::{self, ServedItem, Snapshot};

    let (mut a, mut b, mut c) = (new_device(), new_device(), new_device());
    let (mut hub, room) = found_room(&mut a);
    add_human(&mut hub, &mut a, &mut b);
    add_human(&mut hub, &mut a, &mut c);
    for device in [&mut a, &mut b] {
        sync_all(&hub, device);
    }
    let board_id = BoardId::ALL_DESKS;
    // One device draws three items; another writes the board's snapshot, which covers them.
    for _ in 0..3 {
        write(&mut hub, &mut a, &erase());
    }
    write(&mut hub, &mut a, &desk(&room, "of the drawer"));
    sync_all(&hub, &mut a);
    sync_all(&hub, &mut b);
    let covered = b.chain_head(&room, &a.id()).unwrap();
    assert_eq!(covered.seq, 4);
    let snapshot = Snapshot {
        attachment: r#"{"file_id":"AAAAAAAAAAAAAAAAAAAAAA"}"#.into(),
        frontier: vec![(a.id(), covered)],
        change: b.cursor(),
    };
    write(
        &mut hub,
        &mut b,
        &Draft::Register {
            group: room,
            name: board::snapshot_name(&board_id),
            value: Some(json(&snapshot.value().unwrap())),
        },
    );
    let fifth = write(&mut hub, &mut a, &erase());

    // The third device holds the snapshot writer's chain and nothing of the drawer.
    for stored in hub.chain_of(&room, &b.id(), 0) {
        let got = c
            .receive_envelope(&stored.bytes, stored.change, true, None, now())
            .unwrap();
        assert_eq!(got.outcome, EnvelopeOutcome::Applied);
    }
    let of_drawer = hub.chain_of(&room, &a.id(), 0);
    let take = |device: &mut TestDevice, stored: &StoredEnvelope| {
        device
            .receive_envelope(&stored.pruned(), stored.change, true, None, now())
            .unwrap()
    };
    assert_eq!(take(&mut c, &of_drawer[4]).code, Some(Error::Gap));
    // The load finds the item after the frontier missing from the drawer's chain, and the chain begun.
    let served = [ServedItem {
        sender: a.id(),
        seq: fifth.seq,
        hash: fifth.envelope_hash,
    }];
    assert_eq!(c.board_load(&board_id, &served), Err(Error::Withheld));
    assert_eq!(c.chain_head(&room, &a.id()).unwrap(), covered);
    assert_eq!(
        take(&mut c, &of_drawer[4]).outcome,
        EnvelopeOutcome::Chained
    );
    let loaded = c.board_load(&board_id, &served).unwrap();
    assert_eq!(loaded.fresh, vec![0]);
    assert!(loaded
        .frontier
        .contains(&(a.id(), c.chain_head(&room, &a.id()).unwrap())));
    // The chain goes on.
    let sixth = write(&mut hub, &mut a, &erase());
    let stored = hub.chain_of(&room, &a.id(), 5).remove(0);
    let got = c
        .receive_envelope(&stored.bytes, stored.change, true, None, now())
        .unwrap();
    assert_eq!(got.outcome, EnvelopeOutcome::Applied);
    assert_eq!(
        c.chain_head(&room, &a.id()).unwrap().hash,
        sixth.envelope_hash
    );
    // What the drawer wrote up to the frontier is not held: its register value is unknown here.
    assert!(c.register(&room, DESK).unwrap().is_none());
    // An envelope at the frontier that is fetched out of order is shown unconfirmed.
    let fetched = c
        .receive_envelope(&of_drawer[3].bytes, of_drawer[3].change, false, None, now())
        .unwrap();
    assert_eq!(fetched.outcome, EnvelopeOutcome::Provisional);

    // Later the chain is read from number 1: in its order, up to the frontier's envelope.
    assert_eq!(take(&mut c, &of_drawer[1]).code, Some(Error::Gap));
    for stored in &of_drawer[..4] {
        let got = take(&mut c, stored);
        assert_eq!(
            (got.outcome, got.code),
            (EnvelopeOutcome::Chained, Some(Error::Pruned))
        );
    }
    assert_eq!(take(&mut c, &of_drawer[3]).code, Some(Error::Replay));
    assert_eq!(
        c.chain_head(&room, &a.id()).unwrap().hash,
        sixth.envelope_hash
    );
    // With the bodies, the device holds what the others hold.
    for stored in &of_drawer[..4] {
        let got = c
            .receive_envelope(&stored.bytes, stored.change, false, None, now())
            .unwrap();
        assert_eq!(got.outcome, EnvelopeOutcome::Applied);
    }
    sync_all(&hub, &mut a);
    assert_eq!(
        c.register(&room, DESK).unwrap().unwrap().expose(),
        a.register(&room, DESK).unwrap().unwrap().expose()
    );
    // The snapshot loads again, with the items after it the chain shows.
    assert_eq!(c.board_load(&board_id, &[]), Err(Error::Withheld));
    let both = [
        served[0],
        ServedItem {
            sender: a.id(),
            seq: sixth.seq,
            hash: sixth.envelope_hash,
        },
    ];
    assert_eq!(c.board_load(&board_id, &both).unwrap().fresh, vec![0, 1]);
}

#[test]
fn a_frontier_that_the_chain_does_not_lead_to_is_a_finding() {
    use trommi_core::board::{self, Snapshot};

    let (mut a, mut b) = (new_device(), new_device());
    let (mut hub, room) = found_room(&mut a);
    add_human(&mut hub, &mut a, &mut b);
    let forger = Forger::new();
    add_forger(&mut hub, &mut a, &forger);
    sync_all(&hub, &mut a);
    sync_all(&hub, &mut b);
    let epoch = a.group(&room).unwrap().epoch;
    let claim = Claim {
        group: room,
        epoch,
        role: Role::Human,
        seat: None,
        key: a.content_key(&room, epoch).unwrap(),
    };
    let item = envelope::Draft::board_item(
        BoardId::ALL_DESKS,
        br#"{"content_type":"erase","shape_ids":["AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/1/0"]}"#,
    );
    // A writer signs two envelopes under number 2: the snapshot's writer saw one, the hub serves the other.
    let mut pen = Pen::new(&forger.key);
    let one = pen.sign(&claim, &item, &Objects::new(), now());
    let mut branch = pen.fork();
    let two = pen.sign(&claim, &item, &Objects::new(), now());
    let other_two = branch.sign(&claim, &item, &Objects::new(), now() + 1);
    let other_three = branch.sign(&claim, &item, &Objects::new(), now() + 1);
    let snapshot = Snapshot {
        attachment: r#"{"file_id":"AAAAAAAAAAAAAAAAAAAAAA"}"#.into(),
        frontier: vec![(
            pen.id(),
            trommi_core::chain::Head {
                seq: 2,
                hash: other_two.hash().unwrap(),
            },
        )],
        change: a.cursor(),
    };
    write(
        &mut hub,
        &mut a,
        &Draft::Register {
            group: room,
            name: board::snapshot_name(&BoardId::ALL_DESKS),
            value: Some(json(&snapshot.value().unwrap())),
        },
    );
    sync_all(&hub, &mut b);
    let mut at = b.cursor();
    let mut take = |device: &mut TestDevice, envelope: &envelope::Envelope| {
        at += 1;
        device
            .receive_envelope(&envelope.encode().unwrap(), at, true, None, now())
            .unwrap()
    };
    assert_eq!(b.board_load(&BoardId::ALL_DESKS, &[]).map(|_| ()), Ok(()));
    assert_eq!(take(&mut b, &other_three).outcome, EnvelopeOutcome::Applied);
    // Read from number 1, the chain the hub serves does not lead to the frontier.
    assert_eq!(take(&mut b, &one).outcome, EnvelopeOutcome::Applied);
    let got = take(&mut b, &two);
    assert_eq!(
        (got.outcome, got.code),
        (EnvelopeOutcome::Refused, Some(Error::Equivocation))
    );
    assert_eq!(b.chain_head(&room, &pen.id()).unwrap().seq, 3);
    // The envelope the frontier names completes it.
    assert_eq!(take(&mut b, &other_two).outcome, EnvelopeOutcome::Applied);
    assert_eq!(take(&mut b, &other_two).code, Some(Error::Replay));
}

#[test]
fn a_recovery_cuts_every_chain_where_it_verified_it() {
    // Two human devices and a member whose key the test holds write in the room; then every device is
    // lost.
    let (mut a, mut b) = (new_device(), new_device());
    let (mut hub, room) = found_room(&mut a);
    add_human(&mut hub, &mut a, &mut b);
    let forger = Forger::new();
    add_forger(&mut hub, &mut a, &forger);
    sync_all(&hub, &mut a);
    sync_all(&hub, &mut b);
    for round in 0..3 {
        write(&mut hub, &mut a, &note(round));
        write(&mut hub, &mut b, &desk(&room, "b"));
    }
    let epoch = a.group(&room).unwrap().epoch;
    let claim = Claim {
        group: room,
        epoch,
        role: Role::Human,
        seat: None,
        key: a.content_key(&room, epoch).unwrap(),
    };
    let item = envelope::Draft::board_item(
        BoardId::ALL_DESKS,
        br#"{"content_type":"erase","shape_ids":["AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/1/0"]}"#,
    );
    let mut pen = Pen::new(&forger.key);
    let one = pen.sign(&claim, &item, &Objects::new(), now());
    let mut branch = pen.fork();
    let two = pen.sign(&claim, &item, &Objects::new(), now());
    let other_two = branch.sign(&claim, &item, &Objects::new(), now());
    for envelope in [&one, &two] {
        hub.post(&pen.id(), &trommi_tests::forge_content::posting(envelope))
            .unwrap();
    }
    sync_all(&hub, &mut a);
    let heads: Vec<_> = [a.id(), b.id(), pen.id()]
        .iter()
        .map(|writer| (*writer, a.chain_head(&room, writer).unwrap()))
        .collect();
    assert!(heads.iter().all(|(_, head)| head.seq >= 2));
    drop((a, b));

    let keys = test_keys();
    let stored = trommi_tests::served_chains(&hub);
    let recover = |hub: &mut Hub, device: &mut TestDevice, served: &[(Vec<u8>, u64)]| {
        recover_with(hub, device, &keys, &room, served).map(|_| ())
    };
    let honest: Vec<(Vec<u8>, u64)> = stored
        .iter()
        .map(|stored| (stored.pruned(), stored.change))
        .collect();
    let at = |hash: trommi_core::ids::Hash32| {
        stored
            .iter()
            .position(|stored| stored.hash == hash)
            .unwrap()
    };

    // A hub that serves a chain with a hole, or with another envelope under a number: no Cut is taken from
    // it, and nothing is built.
    let mut device = new_device();
    let mut holed = honest.clone();
    holed.remove(at(one.hash().unwrap()));
    assert_eq!(recover(&mut hub, &mut device, &holed), Err(Error::Gap));
    let mut forked = honest.clone();
    let after = forked[at(two.hash().unwrap())].1;
    forked.push((other_two.prune().unwrap().encode().unwrap(), after + 1_000));
    assert_eq!(
        recover(&mut hub, &mut device, &forked),
        Err(Error::Equivocation)
    );
    let mut swapped = honest.clone();
    // The hub says the second came first. In which order the caller hands them in decides nothing.
    let (first, second) = (at(one.hash().unwrap()), at(two.hash().unwrap()));
    let (earlier, later) = (swapped[first].1, swapped[second].1);
    swapped[first].1 = later;
    swapped[second].1 = earlier;
    assert_eq!(recover(&mut hub, &mut device, &swapped), Err(Error::Gap));
    assert!(device.outbox().is_empty() && device.room().is_none());

    // The chains as they are: every Remove carries the head the device verified from number 1.
    recover(&mut hub, &mut device, &honest).unwrap();
    post_ok(&mut hub, &mut device);
    assert!(device.is_human());
    for (writer, head) in &heads {
        assert_eq!(device.chain_cut(&room, writer).unwrap(), Some(*head));
        assert_eq!(device.chain_head(&room, writer).unwrap(), *head);
    }
    assert_eq!(device.objects(&room).unwrap().len(), 3);
    // What lies beyond a Cut is refused by everyone afterwards: by the device and by the hub.
    let three = pen.sign(&claim, &item, &Objects::new(), now());
    let got = device
        .receive_envelope(
            &three.encode().unwrap(),
            device.cursor() + 1,
            true,
            None,
            now(),
        )
        .unwrap();
    assert_eq!(got.code, Some(Error::RemovedSender));
    assert_eq!(
        hub.post(&pen.id(), &trommi_tests::forge_content::posting(&three)),
        Err(Error::RemovedSender)
    );
}

/// A human device added to the room group and both sessions of `w`, which has learned the room's past and
/// the main session's: the helper session's is still to learn.
fn late_in_both(w: &mut World) -> (TestDevice, MemoryStorage) {
    let (mut late, store) = newcomer(w);
    publish_some(&mut w.hub, &mut late, 4);
    for group in [w.main, w.side] {
        add_to_session(&mut w.hub, &mut w.old, &mut late, &group);
        w.sync();
    }
    assert_eq!(settle_joining(&w.hub, &mut late).len(), 2);
    learn(&w.hub, &mut late, &w.room).unwrap();
    learn(&w.hub, &mut late, &w.main).unwrap();
    (late, store)
}

/// Whether `device` still holds `group` as a good session: it hands out the key and holds no finding.
fn assert_open(device: &TestDevice, group: &GroupId) {
    let epoch = device.group(group).unwrap().epoch;
    assert!(device.content_key(group, epoch).is_ok());
    assert!(device.findings().unwrap().is_empty());
}

#[test]
fn a_later_group_info_served_as_the_founding_closes_nothing() {
    let mut w = world(1);
    let side = w.side;
    let (mut late, store) = late_in_both(&mut w);
    let real = fetch_group(&w.hub, &side);
    let from = late.group(&side).unwrap().own_from;
    let before = store.entries();

    // The GroupInfo of the epoch the device joined at, with no Commit: it stands in the device's own state
    // without any history.
    let mut served = real.clone();
    served.founding = w.hub.group_info_at(&side, from).unwrap().clone();
    served.commits.clear();
    assert_eq!(
        served.served(|served| late.verify_founding(&side, served)),
        Err(Error::BadGroup)
    );
    assert!(store.entries() == before);
    assert_open(&late, &side);

    // A later start with the Commits that follow it.
    let mut served = real.clone();
    served.founding = w.hub.group_info_at(&side, 1).unwrap().clone();
    served.commits.remove(0);
    assert_eq!(
        served.served(|served| late.verify_founding(&side, served)),
        Err(Error::BadGroup)
    );
    assert!(store.entries() == before);
    assert_open(&late, &side);

    assert!(real
        .served(|served| late.verify_founding(&side, served))
        .is_ok());
}

#[test]
fn a_refused_board_load_starts_no_chain_at_a_frontier_the_cut_contradicts() {
    use trommi_core::board::{self, Snapshot};

    let (mut a, mut b) = (new_device(), new_device());
    let (mut hub, room) = found_room(&mut a);
    add_human(&mut hub, &mut a, &mut b);
    let forger = Forger::new();
    add_forger(&mut hub, &mut a, &forger);
    sync_all(&hub, &mut a);
    sync_all(&hub, &mut b);
    let epoch = a.group(&room).unwrap().epoch;
    let claim = Claim {
        group: room,
        epoch,
        role: Role::Human,
        seat: None,
        key: a.content_key(&room, epoch).unwrap(),
    };
    let item = envelope::Draft::board_item(
        BoardId::ALL_DESKS,
        br#"{"content_type":"erase","shape_ids":["AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/1/0"]}"#,
    );
    // The writer signs two envelopes under number 2. The remover accepted one of them: the Cut names it.
    let mut pen = Pen::new(&forger.key);
    let one = pen.sign(&claim, &item, &Objects::new(), now());
    let mut branch = pen.fork();
    let two = pen.sign(&claim, &item, &Objects::new(), now());
    let other_two = branch.sign(&claim, &item, &Objects::new(), now() + 1);
    let mut at = a.cursor();
    for envelope in [&one, &two] {
        at += 1;
        let got = a
            .receive_envelope(&envelope.encode().unwrap(), at, true, None, now())
            .unwrap();
        assert_eq!(got.outcome, EnvelopeOutcome::Applied);
    }
    let cut = a.cut_of(&room, &forger.id()).unwrap();
    assert_eq!((cut.seq, cut.hash), (2, two.hash().unwrap()));
    a.remove_human_devices(&[cut], now()).unwrap();
    post_ok(&mut hub, &mut a);
    sync_all(&hub, &mut b);
    assert_eq!(
        b.chain_cut(&room, &pen.id()).unwrap().map(|cut| cut.seq),
        Some(2)
    );

    // A snapshot whose frontier names the other envelope under the Cut's number.
    let snapshot = Snapshot {
        attachment: r#"{"file_id":"AAAAAAAAAAAAAAAAAAAAAA"}"#.into(),
        frontier: vec![(
            pen.id(),
            trommi_core::chain::Head {
                seq: 2,
                hash: other_two.hash().unwrap(),
            },
        )],
        change: a.cursor(),
    };
    write(
        &mut hub,
        &mut a,
        &Draft::Register {
            group: room,
            name: board::snapshot_name(&BoardId::ALL_DESKS),
            value: Some(json(&snapshot.value().unwrap())),
        },
    );
    sync_all(&hub, &mut b);
    assert_eq!(
        b.board_load(&BoardId::ALL_DESKS, &[]).map(|_| ()),
        Err(Error::Equivocation)
    );
    // The refused load began no chain there: the writer's chain is read from number 1 up to its Cut.
    assert_eq!(b.chain_head(&room, &pen.id()).unwrap().seq, 0);
    let mut at = b.cursor();
    for envelope in [&one, &two] {
        at += 1;
        let got = b
            .receive_envelope(&envelope.encode().unwrap(), at, true, None, now())
            .unwrap();
        assert_ne!(got.outcome, EnvelopeOutcome::Refused, "{:?}", got.code);
    }
    assert_eq!(b.chain_head(&room, &pen.id()).unwrap().seq, 2);
}

#[test]
fn a_board_loads_its_snapshot_again_after_a_cut_dropped_items() {
    use trommi_core::board::{self, ServedItem, Snapshot};

    let (mut a, mut b) = (new_device(), new_device());
    let (mut hub, room) = found_room(&mut a);
    add_human(&mut hub, &mut a, &mut b);
    let forger = Forger::new();
    add_forger(&mut hub, &mut a, &forger);
    sync_all(&hub, &mut a);
    sync_all(&hub, &mut b);
    let epoch = a.group(&room).unwrap().epoch;
    let claim = Claim {
        group: room,
        epoch,
        role: Role::Human,
        seat: None,
        key: a.content_key(&room, epoch).unwrap(),
    };
    let item = envelope::Draft::board_item(
        BoardId::ALL_DESKS,
        br#"{"content_type":"erase","shape_ids":["AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/1/0"]}"#,
    );
    let mut pen = Pen::new(&forger.key);
    let signed: Vec<_> = (0..3)
        .map(|_| pen.sign(&claim, &item, &Objects::new(), now()))
        .collect();
    let post = |hub: &mut Hub, envelope: &envelope::Envelope| {
        hub.post(&pen.id(), &trommi_tests::forge_content::posting(envelope))
            .unwrap();
    };
    // The remover reads the writer's first item and writes a snapshot that covers it.
    post(&mut hub, &signed[0]);
    sync_all(&hub, &mut a);
    let snapshot = Snapshot {
        attachment: r#"{"file_id":"AAAAAAAAAAAAAAAAAAAAAA"}"#.into(),
        frontier: vec![(pen.id(), a.chain_head(&room, &pen.id()).unwrap())],
        change: a.cursor(),
    };
    write(
        &mut hub,
        &mut a,
        &Draft::Register {
            group: room,
            name: board::snapshot_name(&BoardId::ALL_DESKS),
            value: Some(json(&snapshot.value().unwrap())),
        },
    );
    // The remover reads the second item too; the other device reads all three and loads the board with the
    // two after the frontier.
    post(&mut hub, &signed[1]);
    sync_all(&hub, &mut a);
    post(&mut hub, &signed[2]);
    sync_all(&hub, &mut b);
    let served: Vec<ServedItem> = signed[1..]
        .iter()
        .enumerate()
        .map(|(at, envelope)| ServedItem {
            sender: pen.id(),
            seq: at as u64 + 2,
            hash: envelope.hash().unwrap(),
        })
        .collect();
    assert_eq!(
        b.board_load(&BoardId::ALL_DESKS, &served).unwrap().fresh,
        vec![0, 1]
    );
    // The remover had accepted two of them: the Cut drops the third on the other device.
    let cut = a.cut_of(&room, &forger.id()).unwrap();
    assert_eq!(cut.seq, 2);
    a.remove_human_devices(&[cut], now()).unwrap();
    post_ok(&mut hub, &mut a);
    sync_all(&hub, &mut b);
    // The same snapshot loads again: the board is built anew without the dropped item.
    let loaded = b.board_load(&BoardId::ALL_DESKS, &served[..1]).unwrap();
    assert_eq!(loaded.fresh, vec![0]);
    assert!(loaded.frontier.contains(&(
        pen.id(),
        trommi_core::chain::Head {
            seq: 2,
            hash: signed[1].hash().unwrap()
        }
    )));
}

#[test]
fn a_past_whose_places_contradict_the_devices_own_is_not_taken() {
    let mut w = world(1);
    let room = w.room;
    let (mut new, store) = newcomer(&mut w);
    // The device processes a room Commit itself: it knows where that room epoch began in the hub's order.
    w.old.update(&room, true, now()).unwrap().unwrap();
    post_ok(&mut w.hub, &mut w.old);
    sync_all(&w.hub, &mut new);
    let real = fetch_group(&w.hub, &room);
    let before = store.entries();

    // The group's own Commits under change numbers that ascend, and lie beyond that place.
    let mut later = real.clone();
    for (change, _, _) in &mut later.commits {
        *change += 1_000_000;
    }
    assert_eq!(learn_from(&mut new, &room, &later), Err(Error::BadGroup));
    assert!(store.entries() == before);
    assert!(new.findings().unwrap().is_empty());

    assert!(learn_from(&mut new, &room, &real).is_ok());
    drop(new);
    assert!(reopen(store.reopened()).is_ok());
}

/// `served` with the Commit at the change number `real` served under `claimed` instead.
fn moved(served: &FetchedGroup, real: u64, claimed: u64) -> FetchedGroup {
    let mut served = served.clone();
    let at = served
        .commits
        .iter()
        .position(|(change, _, _)| *change == real)
        .unwrap();
    served.commits[at].0 = claimed;
    served
}

/// A takeover in `w` whose three Commits (room, main session, helper session) leave a free change number
/// between the room's and the main session's. Returns that number and the places of the main session's
/// and the helper session's Commit.
fn takeover_with_a_gap(w: &mut World) -> (u64, u64, u64) {
    let (room, main, side) = (w.room, w.main, w.side);
    let mut next = new_device();
    enrol_over(&mut w.hub, &mut w.old, &mut next, &main);
    let gone = std::mem::replace(&mut w.agent, next).id();
    w.sync();
    // Something else of the room takes the next number.
    write(&mut w.hub, &mut w.old, &desk(&room, "between"));
    let free = w.hub.change();
    let mut places = Vec::new();
    for group in [main, side] {
        let cut = w.old.cut_of(&group, &gone).unwrap();
        let package = w.agent.key_package(now()).unwrap();
        let next = w.agent.id();
        w.old
            .clean_session(&group, &[cut], Some((&next, &package)), now())
            .unwrap();
        post_ok(&mut w.hub, &mut w.old);
        places.push(w.hub.change());
        w.sync();
        w.old.send_handover(&group, &next).unwrap();
        post_ok(&mut w.hub, &mut w.old);
    }
    w.sync();
    (free, places[0], places[1])
}

#[test]
fn a_helper_commit_is_judged_against_the_main_sessions_agent_leaf_at_its_place() {
    use trommi_core::device::WelcomeExpectation;

    let mut w = world(1);
    let (room, main, side) = (w.room, w.main, w.side);
    // A human device of the room and the main session, whose Welcome into the helper session waits.
    let mut live = new_device();
    add_human(&mut w.hub, &mut w.old, &mut live);
    publish_some(&mut w.hub, &mut live, 4);
    add_to_session(&mut w.hub, &mut w.old, &mut live, &main);
    w.sync();
    assert_eq!(settle_joining(&w.hub, &mut live).len(), 1);
    add_to_session(&mut w.hub, &mut w.old, &mut live, &side);
    let welcome_at = trommi_tests::added_at(&w.hub);
    w.sync();

    // The takeover. Within one room epoch the main session's agent leaf is the old device, then the new
    // one; the helper session's Commit that makes the new device its opener stands behind that change.
    let (free, main_at, side_at) = takeover_with_a_gap(&mut w);
    assert!(free < main_at && main_at < side_at);

    // A live member that is handed the helper session's Commits late: the Commit claims a place before
    // the main session's change, where the main session's agent leaf was still the old device.
    for item in w.hub.log_after(live.cursor()) {
        let _ = trommi_tests::process(&mut live, &item);
    }
    let welcome = w
        .hub
        .welcomes
        .iter()
        .find(|welcome| welcome.change == welcome_at)
        .unwrap();
    let expected = WelcomeExpectation {
        room: room.room_id(),
        committer: None,
    };
    live.join_welcome(&welcome.bytes, &expected, now()).unwrap();
    let log = w.hub.log_after(0);
    let of_side = |change: u64| {
        log.iter()
            .find(|item| item.change == change && item.group == side)
            .unwrap()
            .clone()
    };
    trommi_tests::process(&mut live, &of_side(welcome_at)).unwrap();
    let mut early = of_side(side_at);
    early.change = free;
    assert!(trommi_tests::process(&mut live, &early).is_err());
    assert_eq!(
        live.group(&side).unwrap().epoch,
        w.hub.epoch(&side).unwrap() - 1
    );
    assert!(matches!(
        trommi_tests::process(&mut live, &of_side(side_at)),
        Ok(Processed::Commit { .. })
    ));

    // A device that learns the past.
    let (mut late, _) = late_in_both(&mut w);
    let real = fetch_group(&w.hub, &side);
    assert_eq!(
        learn_from(&mut late, &side, &moved(&real, side_at, free)),
        Err(Error::BadGroup)
    );
    assert!(learn_from(&mut late, &side, &real).is_ok());

    // A device that signs in with the code.
    let keys = w.keys();
    let mut signer = new_device();
    trommi_tests::join_room(&w.hub, &mut signer, &keys).unwrap();
    post_ok(&mut w.hub, &mut signer);
    trommi_tests::join_session(&w.hub, &mut signer, &keys, &main).unwrap();
    post_ok(&mut w.hub, &mut signer);
    let real = fetch_group(&w.hub, &side);
    let join = |device: &mut TestDevice, served: &FetchedGroup| {
        served.served(|served| device.join_session_with_code(&keys, served, now()))
    };
    assert_eq!(
        join(&mut signer, &moved(&real, side_at, free)).err(),
        Some(Error::BadGroup)
    );
    assert!(join(&mut signer, &real).is_ok());
}

#[test]
fn what_the_hub_says_beside_the_commits_closes_no_session() {
    let mut w = world(1);
    let (main, side) = (w.main, w.side);
    let (free, _, side_at) = takeover_with_a_gap(&mut w);
    // A device signs in with the code: its join of the helper session is a Commit with a `RecoveryAuth`.
    let keys = w.keys();
    let mut signer = new_device();
    trommi_tests::join_room(&w.hub, &mut signer, &keys).unwrap();
    post_ok(&mut w.hub, &mut signer);
    for group in [main, side] {
        trommi_tests::join_session(&w.hub, &mut signer, &keys, &group).unwrap();
        post_ok(&mut w.hub, &mut signer);
    }
    w.sync();
    let (mut late, store) = late_in_both(&mut w);
    let real = fetch_group(&w.hub, &side);
    let joined = real
        .commits
        .iter()
        .position(|(_, _, auth)| auth.is_some())
        .unwrap();

    // Every Commit is the group's own. What is wrong is what the hub alone says.
    let mut hostile: Vec<(&str, FetchedGroup)> = Vec::new();
    let mut served = real.clone();
    served.commits[3].0 = served.commits[2].0;
    hostile.push(("one change number twice", served));
    hostile.push((
        "a Commit placed before its main session's change",
        moved(&real, side_at, free),
    ));
    let mut served = real.clone();
    served.commits[joined].2 = None;
    hostile.push(("a join without its RecoveryAuth", served));
    let mut served = real.clone();
    served.commits[2].2 = real.commits[joined].2.clone();
    hostile.push(("a RecoveryAuth beside an ordinary Commit", served));
    let mut served = real.clone();
    for (change, _, _) in &mut served.commits {
        *change += 1_000_000;
    }
    hostile.push(("every Commit in a later room epoch", served));

    let before = store.entries();
    for (what, served) in &hostile {
        assert_eq!(
            served.served(|served| late.verify_founding(&side, served)),
            Err(Error::BadGroup),
            "{what}"
        );
        assert!(store.entries() == before, "{what}: nothing is written");
        assert_open(&late, &side);
    }
    assert!(real
        .served(|served| late.verify_founding(&side, served))
        .is_ok());
    assert_open(&late, &side);
}

#[test]
fn a_revoked_key_has_no_role_in_an_epoch_that_kept_its_leaf() {
    let mut w = world(1);
    let (room, main, side) = (w.room, w.main, w.side);
    // A human device whose key the test holds, a leaf of the helper session.
    let forger = Forger::new();
    add_forger(&mut w.hub, &mut w.old, &forger);
    w.sync();
    w.old
        .add_to_session(&side, &forger.id(), &forger.key_package(), now())
        .unwrap();
    post_ok(&mut w.hub, &mut w.old);
    w.sync();
    // It is removed from the room. Before anyone cleans the helper session, a device signs in with the
    // code: the stale group takes that join, and its new epoch still holds the revoked key's leaf.
    let cut = w.old.cut_of(&room, &forger.id()).unwrap();
    w.old.remove_human_devices(&[cut], now()).unwrap();
    post_ok(&mut w.hub, &mut w.old);
    w.sync();
    let keys = w.keys();
    let mut signer = new_device();
    trommi_tests::join_room(&w.hub, &mut signer, &keys).unwrap();
    post_ok(&mut w.hub, &mut signer);
    for group in [main, side] {
        trommi_tests::join_session(&w.hub, &mut signer, &keys, &group).unwrap();
        post_ok(&mut w.hub, &mut signer);
    }
    w.sync();
    let kept = w.hub.epoch(&side).unwrap();
    assert!(w.old.group(&side).unwrap().leaves.contains(&forger.id()));

    // The revoked key signs a card in that epoch, as a helper device would.
    let claim = Claim {
        group: side,
        epoch: kept,
        role: Role::Helper,
        seat: Some(w.agent.id()),
        key: w.old.content_key(&side, kept).unwrap(),
    };
    let draft = envelope::Draft::first_version(
        envelope::ObjectType::Card,
        Urgency::Normal,
        format!(r#"{{"card_type":"info","title":"forged","previous_version_hash":"{ZERO_HASH}"}}"#)
            .as_bytes(),
    )
    .unwrap();
    let mut pen = Pen::new(&forger.key);
    let forged = pen.sign(&claim, &draft, &Objects::new(), now());
    let bytes = forged.encode().unwrap();
    // It is handed behind the cursor, as an envelope read back along its chain is.
    let at = w.old.cursor();
    let got = w
        .old
        .receive_envelope(&bytes, at, true, None, now())
        .unwrap();
    assert_ne!(got.outcome, EnvelopeOutcome::Applied);
    let objects = w.old.objects(&side).unwrap();

    // The session is cleaned, and a device that comes later learns that epoch and reads it back.
    let cut = w.old.cut_of(&side, &forger.id()).unwrap();
    w.old.clean_session(&side, &[cut], None, now()).unwrap();
    post_ok(&mut w.hub, &mut w.old);
    w.sync();
    let (mut late, _) = late_in_both(&mut w);
    learn(&w.hub, &mut late, &side).unwrap();
    for ordered in [true, false] {
        let got = late
            .receive_envelope(&bytes, at, ordered, None, now())
            .unwrap();
        assert_ne!(got.outcome, EnvelopeOutcome::Applied, "{:?}", got.code);
    }
    assert_eq!(late.objects(&side).unwrap(), objects);
    assert_eq!(w.old.objects(&side).unwrap(), objects);
}

#[test]
fn a_recovery_served_a_chain_cut_short_cuts_it_where_it_verified_it() {
    use trommi_core::recovery::Replacement;

    let (mut a, mut b) = (new_device(), new_device());
    let (mut hub, room) = found_room(&mut a);
    add_human(&mut hub, &mut a, &mut b);
    let forger = Forger::new();
    add_forger(&mut hub, &mut a, &forger);
    sync_all(&hub, &mut a);
    sync_all(&hub, &mut b);
    write(&mut hub, &mut a, &note(1));
    let epoch = a.group(&room).unwrap().epoch;
    let claim = Claim {
        group: room,
        epoch,
        role: Role::Human,
        seat: None,
        key: a.content_key(&room, epoch).unwrap(),
    };
    let item = envelope::Draft::board_item(
        BoardId::ALL_DESKS,
        br#"{"content_type":"erase","shape_ids":["AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/1/0"]}"#,
    );
    // A lost device wrote three envelopes; the hub took them all.
    let mut pen = Pen::new(&forger.key);
    let written: Vec<envelope::Envelope> = (0..3)
        .map(|_| pen.sign(&claim, &item, &Objects::new(), now()))
        .collect();
    for envelope in &written {
        hub.post(&pen.id(), &trommi_tests::forge_content::posting(envelope))
            .unwrap();
    }
    sync_all(&hub, &mut a);
    assert_eq!(a.chain_head(&room, &pen.id()).unwrap().seq, 3);
    drop((a, b));

    let keys = test_keys();
    let stored = trommi_tests::served_chains(&hub);
    let recover = |hub: &mut Hub, device: &mut TestDevice, served: &[(Vec<u8>, u64)]| {
        recover_with(hub, device, &keys, &room, served)
    };
    let honest: Vec<(Vec<u8>, u64)> = stored
        .iter()
        .map(|stored| (stored.pruned(), stored.change))
        .collect();
    let at = |envelope: &envelope::Envelope| {
        let hash = envelope.hash().unwrap();
        stored
            .iter()
            .position(|stored| stored.hash == hash)
            .unwrap()
    };
    let hash_of = |envelope: &envelope::Envelope| envelope.hash().unwrap();
    let mut device = new_device();

    // The hub serves an envelope under number 2 that nobody signed: the bytes of the real one with
    // another signature. No Cut is taken from an envelope that does not verify, and none beyond it.
    let mut unsigned = written[1].prune().unwrap();
    let mut other_pen = Pen::new(&Forger::new().key);
    other_pen.resign(&mut unsigned);
    let mut forged = honest.clone();
    forged[at(&written[1])].0 = unsigned.encode().unwrap();
    let refused: Result<Replacement, Error> = recover(&mut hub, &mut device, &forged);
    assert_eq!(refused.err(), Some(Error::BadSignature));
    assert!(device.outbox().is_empty() && device.room().is_none());

    // The hub withholds the newest envelopes of that chain. What is left links from number 1 without a
    // hole: the recovery cannot tell it from the whole chain, and cuts at the head it verified. This is
    // the limit of section 17: a hub can withhold the newest envelopes of a sender, and a Cut is the
    // remover's view.
    let mut short = honest.clone();
    short.remove(at(&written[2]));
    short.remove(at(&written[1]));
    let replacement = recover(&mut hub, &mut device, &short).unwrap();
    post_ok(&mut hub, &mut device);
    let cut = device.chain_cut(&room, &pen.id()).unwrap().unwrap();
    assert_eq!((cut.seq, cut.hash), (1, hash_of(&written[0])));
    assert_eq!(device.chain_head(&room, &pen.id()).unwrap(), cut);

    // What lies beyond the Cut is refused from then on, though its writer signed it before the recovery:
    // by the device that recovered, by the hub, and by a device that signs in later and learns the Cut
    // from the room's Commits.
    let new_keys = RecoveryKeys::from_code(replacement.code.duplicate()).unwrap();
    let mut later = new_device();
    trommi_tests::join_room(&hub, &mut later, &new_keys).unwrap();
    post_ok(&mut hub, &mut later);
    assert_eq!(later.chain_cut(&room, &pen.id()).unwrap(), Some(cut));
    for reader in [&mut device, &mut later] {
        for (ordered, envelope) in [(true, &written[1]), (false, &written[2])] {
            let at = reader.cursor() + 1;
            let got = reader
                .receive_envelope(&envelope.encode().unwrap(), at, ordered, None, now())
                .unwrap();
            assert_eq!(
                (got.outcome, got.code),
                (EnvelopeOutcome::Refused, Some(Error::RemovedSender))
            );
        }
        // The envelope at the Cut is the chain's own.
        let at = reader.cursor() + 1;
        let got = reader
            .receive_envelope(&written[0].encode().unwrap(), at, true, None, now())
            .unwrap();
        assert_ne!(got.code, Some(Error::RemovedSender));
    }
    let next = pen.sign(&claim, &item, &Objects::new(), now());
    assert_eq!(
        hub.post(&pen.id(), &trommi_tests::forge_content::posting(&next)),
        Err(Error::RemovedSender)
    );
}

/// The whole recovery of 8.7 by `device` with the code `keys`, against the room as the hub holds it and
/// the chains `served`: envelopes in pruned form, each with its change number. Returns the new code's keys.
fn recover_with(
    hub: &mut Hub,
    device: &mut TestDevice,
    keys: &RecoveryKeys,
    room: &GroupId,
    served: &[(Vec<u8>, u64)],
) -> Result<trommi_core::recovery::Replacement, Error> {
    let marked: Vec<(Vec<u8>, u64, Option<Error>)> = served
        .iter()
        .map(|(bytes, change)| (bytes.clone(), *change, None))
        .collect();
    recover_marked(hub, device, keys, room, &marked)
}

/// [`recover_with`], each envelope with the void marker the hub serves it with.
fn recover_marked(
    hub: &mut Hub,
    device: &mut TestDevice,
    keys: &RecoveryKeys,
    room: &GroupId,
    served: &[(Vec<u8>, u64, Option<Error>)],
) -> Result<trommi_core::recovery::Replacement, Error> {
    use trommi_core::device::ServedEnvelope;
    use trommi_core::recovery::check_room;

    hub.open_recovery(&device.id()).unwrap();
    let fetched = trommi_tests::fetch(hub, keys);
    let replacement = fetched.served(|served| {
        let checked = check_room(keys, served)?;
        keys.replace(
            &mut SystemEntropy,
            &room.room_id(),
            checked.observer.history().unwrap(),
        )
    })?;
    let chains: Vec<ServedEnvelope<'_>> = served
        .iter()
        .map(|(bytes, change, void_code)| ServedEnvelope {
            bytes,
            change: *change,
            void_code: void_code.as_ref(),
        })
        .collect();
    let built = fetched
        .served(|served| device.recover(keys, served, &replacement, &chains, b"copies", now()));
    if built.is_err() {
        hub.drop_recovery();
    }
    built.map(|_| replacement)
}

#[test]
fn a_recovery_reads_the_chains_in_the_hubs_order_however_they_are_handed_in() {
    // One lost device wrote a Note, the other a version that builds on it.
    let (mut a, mut b) = (new_device(), new_device());
    let (mut hub, room) = found_room(&mut a);
    add_human(&mut hub, &mut a, &mut b);
    sync_all(&hub, &mut a);
    sync_all(&hub, &mut b);
    let first = write(&mut hub, &mut a, &note(1));
    sync_all(&hub, &mut a);
    sync_all(&hub, &mut b);
    let id = first.object_id.unwrap();
    let version = Draft::NoteVersion {
        object_id: id,
        closed: false,
        payload: json(&format!(
            r#"{{"text":"n","lamport":2,"previous_version_hash":"{}"}}"#,
            first.envelope_hash.to_base64url()
        )),
    };
    let second = write(&mut hub, &mut b, &version);
    sync_all(&hub, &mut a);
    assert_eq!(
        a.object(&room, &id).unwrap().unwrap().current,
        second.envelope_hash
    );
    let (writer, follower) = (a.id(), b.id());
    drop((a, b));

    let keys = test_keys();
    let stored = trommi_tests::served_chains(&hub);
    let of = |sender: DeviceId| -> Vec<(Vec<u8>, u64)> {
        stored
            .iter()
            .filter(|stored| stored.header.sender == sender)
            .map(|stored| (stored.pruned(), stored.change))
            .collect()
    };
    let mut device = new_device();
    // Two different envelopes under one change number: the hub gives every envelope its own.
    let mut twice = [of(writer), of(follower)].concat();
    twice[1].1 = twice[0].1;
    assert_eq!(
        recover_with(&mut hub, &mut device, &keys, &room, &twice).err(),
        Some(Error::BadFormat)
    );
    // One envelope handed twice, once as stored and once as a void record, in either order.
    let once = [of(writer), of(follower)].concat();
    for void_first in [false, true] {
        let mut marked: Vec<(Vec<u8>, u64, Option<Error>)> = once
            .iter()
            .map(|(bytes, change)| (bytes.clone(), *change, None))
            .collect();
        let mut voided = marked[0].clone();
        voided.2 = Some(Error::TooLarge);
        if void_first {
            marked.insert(0, voided);
        } else {
            marked.push(voided);
        }
        assert_eq!(
            recover_marked(&mut hub, &mut device, &keys, &room, &marked).err(),
            Some(Error::BadFormat)
        );
    }
    // Device after device, the follower's chain first, and one envelope handed twice.
    let mut by_device = [of(follower), of(writer)].concat();
    by_device.push(by_device[0].clone());
    recover_with(&mut hub, &mut device, &keys, &room, &by_device).unwrap();
    post_ok(&mut hub, &mut device);
    // The version found the Note it builds on: both were read where the hub's order has them.
    assert_eq!(
        device.object(&room, &id).unwrap().unwrap().current,
        second.envelope_hash
    );
    for sender in [writer, follower] {
        assert_eq!(device.chain_head(&room, &sender).unwrap().seq, 1);
    }
}

/// Hands the walk of `group` one slice of Commits.
fn hand(
    device: &mut TestDevice,
    group: &GroupId,
    commits: &[trommi_tests::GroupCommit],
) -> Result<u64, Error> {
    trommi_tests::served_commits(commits, |slice| device.learn_slice(group, slice))
        .map(|progress| progress.epoch)
}

#[test]
fn a_past_is_learned_in_slices_and_counts_only_when_it_is_finished() {
    let mut w = world(2);
    let room = w.room;
    let (mut new, store) = newcomer(&mut w);
    let real = fetch_group(&w.hub, &room);
    let from = new.group(&room).unwrap().own_from;
    let first = served_of(&w.hub, &room).remove(0);
    let before = store.entries();

    // The start, then the Commits five at a time. Until the finish nothing of it is the device's state.
    let progress = new.learn_start(&room, &real.founding).unwrap();
    assert_eq!((progress.epoch, progress.upto), (0, from));
    let mut reached = 0;
    for slice in real.commits.chunks(5) {
        reached = hand(&mut new, &room, slice).unwrap();
        assert!(store.entries() == before);
        assert!(!new.group(&room).unwrap().past_learned);
        let got = new
            .receive_envelope(&first.bytes, first.change, true, None, now())
            .unwrap();
        assert_eq!(got.code, Some(Error::GroupBehind));
    }
    assert_eq!(reached, from);
    assert!(store.entries() == before);
    assert_eq!(new.learn_finish(&room).unwrap().epochs, from);
    assert!(new.group(&room).unwrap().past_learned);
    let got = new
        .receive_envelope(&first.bytes, first.change, true, None, now())
        .unwrap();
    assert_eq!(got.outcome, EnvelopeOutcome::Chained);
    // Nothing to learn is no error, at any step.
    assert_eq!(new.learn_start(&room, &real.founding).unwrap().epoch, from);
    assert_eq!(hand(&mut new, &room, &real.commits[..2]), Ok(from));
    assert_eq!(new.learn_finish(&room).unwrap().epochs, 0);

    // The same history, handed in wrongly, to a device that has not learned it.
    let (mut other, store) = newcomer(&mut w);
    let real = fetch_group(&w.hub, &room);
    let from = other.group(&room).unwrap().own_from;
    let before = store.entries();
    let unlearned = |device: &TestDevice| {
        assert!(store.entries() == before);
        assert!(!device.group(&room).unwrap().past_learned);
    };
    // No walk was started.
    assert_eq!(
        hand(&mut other, &room, &real.commits[..5]),
        Err(Error::NotFound)
    );
    assert_eq!(other.learn_finish(&room), Err(Error::NotFound));
    // A finish without all slices.
    other.learn_start(&room, &real.founding).unwrap();
    hand(&mut other, &room, &real.commits[..5]).unwrap();
    assert_eq!(other.learn_finish(&room), Err(Error::BadGroup));
    assert_eq!(
        hand(&mut other, &room, &real.commits[5..10]),
        Err(Error::NotFound)
    );
    unlearned(&other);
    // A slice handed twice.
    other.learn_start(&room, &real.founding).unwrap();
    hand(&mut other, &room, &real.commits[..5]).unwrap();
    assert_eq!(
        hand(&mut other, &room, &real.commits[..5]),
        Err(Error::BadGroup)
    );
    assert_eq!(other.learn_finish(&room), Err(Error::NotFound));
    unlearned(&other);
    // A slice out of turn.
    other.learn_start(&room, &real.founding).unwrap();
    assert_eq!(
        hand(&mut other, &room, &real.commits[5..10]),
        Err(Error::BadGroup)
    );
    unlearned(&other);
    // A hub that changes the history between two slices: a Commit of another branch is valid where it
    // stands, and nothing of the group's own history follows it.
    let fork = w.fork.0 as usize;
    other.learn_start(&room, &real.founding).unwrap();
    hand(&mut other, &room, &real.commits[..fork]).unwrap();
    let branch = (real.commits[fork].0, w.fork.1.clone(), None);
    assert_eq!(hand(&mut other, &room, &[branch]), Ok(fork as u64 + 1));
    assert_eq!(
        hand(&mut other, &room, &real.commits[fork + 1..fork + 2]),
        Err(Error::BadGroup)
    );
    unlearned(&other);
    // A slice above the stated size is refused, and the walk stands where it was.
    other.learn_start(&room, &real.founding).unwrap();
    hand(&mut other, &room, &real.commits[..3]).unwrap();
    let many = vec![real.commits[3].clone(); trommi_core::recovery::MAX_SLICE_COMMITS + 1];
    assert_eq!(hand(&mut other, &room, &many), Err(Error::TooLarge));
    assert_eq!(hand(&mut other, &room, &real.commits[3..]), Ok(from));
    // The write of the finish fails: nothing of the walk is written, and the walk is gone.
    store.fail_apply(1);
    assert!(matches!(other.learn_finish(&room), Err(Error::Storage(_))));
    unlearned(&other);
    assert_eq!(other.learn_finish(&room), Err(Error::NotFound));
    // A device that is opened again in the middle of a walk holds none, and is what it was.
    other.learn_start(&room, &real.founding).unwrap();
    hand(&mut other, &room, &real.commits[..7]).unwrap();
    drop(other);
    let mut other = reopen(store.reopened()).unwrap();
    assert!(!other.group(&room).unwrap().past_learned);
    assert_eq!(
        hand(&mut other, &room, &real.commits[7..]),
        Err(Error::NotFound)
    );
    // It starts again, and learns.
    other.learn_start(&room, &real.founding).unwrap();
    for slice in real.commits.chunks(9) {
        hand(&mut other, &room, slice).unwrap();
    }
    assert_eq!(other.learn_finish(&room).unwrap().epochs, from);

    // The device holds one walk at a time: a start for another group replaces the walk held.
    let (mut third, _) = newcomer(&mut w);
    let real = fetch_group(&w.hub, &room);
    third.learn_start(&room, &real.founding).unwrap();
    hand(&mut third, &room, &real.commits[..3]).unwrap();
    assert!(third.learn_start(&w.main, &real.founding).is_err());
    assert_eq!(
        hand(&mut third, &room, &real.commits[3..6]),
        Err(Error::NotFound)
    );
}

#[test]
fn a_walk_in_slices_closes_a_session_only_by_its_own_history() {
    // The helper session of the first-contact test, read in slices: a walk that meets a Commit which
    // broke the rules reads on, and the finish closes the session if the history is the group's own.
    let mut w = world(1);
    let side = w.side;
    let (free, _, side_at) = takeover_with_a_gap(&mut w);
    let (mut late, store) = late_in_both(&mut w);
    let real = fetch_group(&w.hub, &side);
    let before = store.entries();
    // The hub's word fails in the middle; the rest is the group's own: nothing is closed.
    let lied = moved(&real, side_at, free);
    late.learn_start(&side, &lied.founding).unwrap();
    for slice in lied.commits.chunks(4) {
        hand(&mut late, &side, slice).unwrap();
    }
    assert_eq!(late.learn_finish(&side), Err(Error::BadGroup));
    assert!(store.entries() == before);
    assert_open(&late, &side);
    // The same with the end of the history withheld: it does not arrive, and says nothing.
    late.learn_start(&side, &lied.founding).unwrap();
    hand(&mut late, &side, &lied.commits[..lied.commits.len() - 1]).unwrap();
    assert_eq!(late.learn_finish(&side), Err(Error::BadGroup));
    assert_open(&late, &side);
    late.learn_start(&side, &real.founding).unwrap();
    for slice in real.commits.chunks(4) {
        hand(&mut late, &side, slice).unwrap();
    }
    assert!(late.learn_finish(&side).is_ok());
    assert_open(&late, &side);
}

#[test]
fn a_helper_sessions_past_keeps_its_opener_when_the_main_session_is_archived() {
    let mut w = world(1);
    let (main, side) = (w.main, w.side);
    let (mut late, _) = late_in_both(&mut w);
    let real = fetch_group(&w.hub, &side);
    // The main session is archived between the start of the helper session's walk and its finish.
    late.learn_start(&side, &real.founding).unwrap();
    for slice in real.commits.chunks(4) {
        hand(&mut late, &side, slice).unwrap();
    }
    late.archive(&main).unwrap();
    assert!(late.learn_finish(&side).unwrap().epochs > 2);
    // Every envelope of the past is read as the old device read it: the opener's too.
    read_pruned(&w, &mut late, &side);
    assert_same_view(&w, &w.old, &late, &side);

    // The same for a device on which the main session was archived before the walk began.
    let (mut other, _) = late_in_both(&mut w);
    other.archive(&main).unwrap();
    assert!(learn(&w.hub, &mut other, &side).unwrap().epochs > 2);
    read_pruned(&w, &mut other, &side);
    assert_same_view(&w, &w.old, &other, &side);
}

#[test]
fn a_walk_whose_places_the_devices_own_log_contradicts_by_its_finish_is_not_taken() {
    let (mut a, mut b, mut agent) = (new_device(), new_device(), new_device());
    let (mut hub, room) = found_room(&mut a);
    publish_some(&mut hub, &mut a, 4);
    enrol(&mut hub, &mut a, &mut agent);
    publish_some(&mut hub, &mut agent, 1);
    add_human(&mut hub, &mut a, &mut b);
    publish_some(&mut hub, &mut b, 4);
    // A device that signed in with the code, which joins the session with it too.
    let keys = trommi_tests::test_keys();
    let mut c = new_device();
    trommi_tests::join_room(&hub, &mut c, &keys).unwrap();
    post_ok(&mut hub, &mut c);
    publish_some(&mut hub, &mut c, 4);
    sync_all(&hub, &mut a);
    let main = found_main(&mut hub, &mut a, &agent.id());
    assert_eq!(settle_joining(&hub, &mut b).len(), 1);
    let log_of = |hub: &Hub, device: &mut TestDevice| {
        for item in hub.log_after(device.cursor()) {
            let _ = trommi_tests::process(device, &item);
        }
    };
    log_of(&hub, &mut c);
    learn(&hub, &mut b, &room).unwrap();
    let real = fetch_group(&hub, &main);
    assert_eq!(real.commits.len(), 1);

    // The session's founding Commit is served under a change number far behind the log: the room epoch
    // it names is the newest the device knows, so the slice passes.
    let far = moved(&real, real.commits[0].0, hub.change() + 1_000);
    b.learn_start(&main, &far.founding).unwrap();
    hand(&mut b, &main, &far.commits).unwrap();
    assert_eq!(c.session_check_start(&far.founding), Ok(main));
    trommi_tests::served_commits(&far.commits, |slice| c.session_check_slice(&main, slice))
        .unwrap();
    // Before the finish the device processes a room Commit that lies before that number: there, the
    // room stood in a later epoch than the one the Commit names.
    a.update(&room, true, now()).unwrap().unwrap();
    post_ok(&mut hub, &mut a);
    sync_all(&hub, &mut b);
    log_of(&hub, &mut c);
    assert_eq!(b.learn_finish(&main), Err(Error::BadGroup));
    assert_eq!(
        c.join_session_checked(&keys, &main, &far.current, now()),
        Err(Error::BadGroup)
    );
    assert!(c.outbox().is_empty());
    assert!(!b.group_past(&main).unwrap().unwrap().learned);
    assert!(b.findings().unwrap().is_empty());
    // The history at its true place is taken.
    assert_eq!(learn(&hub, &mut b, &main).unwrap().epochs, 1);
}
