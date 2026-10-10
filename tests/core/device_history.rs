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
    add_forger, add_human, add_to_session, enrol, fetch_group, found_helper, found_main,
    found_room, json, learn, new_device, new_device_on, now, observe, post_all, post_ok,
    publish_some, reopen, settle, settle_joining, sync_all, test_keys, write, FetchedGroup,
    MemoryStorage, TestDevice,
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
    w.old
        .change_agents(&[next.id()], &[w.agent.id()], now())
        .unwrap();
    post_ok(&mut w.hub, &mut w.old);
    observe(&w.hub, &mut next);
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
    w.old
        .change_agents(&[next.id()], &[w.agent.id()], now())
        .unwrap();
    post_ok(&mut w.hub, &mut w.old);
    observe(&w.hub, &mut next);
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
    a.change_agents(&[other.id()], &[], now()).unwrap();
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
    let cuts = trommi_tests::cuts_for(&a, &group);
    a.clean_session(&group, &cuts, None, now()).unwrap();
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
    let late = reopen(handle.reopened()).unwrap();
    assert_eq!(late.content_key(&group, epoch), Err(Error::NoKey));
    assert_eq!(late.findings().unwrap().len(), 1);
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
    assert_eq!(c.board_load(&board_id, &[]), Err(Error::Replay));
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
    use trommi_core::device::ServedEnvelope;
    use trommi_core::recovery::check_room;

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
        hub.open_recovery(&device.id()).unwrap();
        let fetched = trommi_tests::fetch(hub, &keys);
        let replacement = fetched.served(|served| {
            let checked = check_room(&keys, served)?;
            keys.replace(
                &mut SystemEntropy,
                &room.room_id(),
                checked.observer.history().unwrap(),
            )
        })?;
        let chains: Vec<ServedEnvelope<'_>> = served
            .iter()
            .map(|(bytes, change)| ServedEnvelope {
                bytes,
                change: *change,
                void_code: None,
            })
            .collect();
        let built = fetched.served(|served| {
            device.recover(&keys, served, &replacement, &chains, b"copies", now())
        });
        if built.is_err() {
            hub.drop_recovery();
        }
        built.map(|_| ())
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
    let (first, second) = (at(one.hash().unwrap()), at(two.hash().unwrap()));
    swapped.swap(first, second);
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
