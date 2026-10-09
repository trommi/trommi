//! Stored content through the device (section 9): what a device writes reaches the hub from its outbox, comes
//! back in the hub's order, and leaves the same chains, objects and registers on every device.

use trommi_core::chain::HeadStanding;
use trommi_core::crypto::SecretBytes;
use trommi_core::device::{Draft, EnvelopeOutcome, ReceivedEnvelope, HEADS_EVERY_MS};
use trommi_core::envelope::{Bind, ObjectState, Urgency, Verdict};
use trommi_core::ids::{DeviceId, GroupId, SessionId};
use trommi_core::objects::{AnswerAction, Command, Decision, Refusal};
use trommi_core::Error;
use trommi_tests::hub::Hub;
use trommi_tests::{
    add_human, enrol, found_main, found_room, json, new_device, now, publish_some, sync_all, write,
    TestDevice,
};

/// A room with one human device and an agent in its main session.
struct World {
    hub: Hub,
    room: GroupId,
    session: SessionId,
    group: GroupId,
    human: TestDevice,
    agent: TestDevice,
}

fn world() -> World {
    world_with(None)
}

/// The same room with a second human device, which is in the session from its founding.
fn world_of_two() -> (World, TestDevice) {
    let mut other = new_device();
    let world = world_with(Some(&mut other));
    (world, other)
}

fn world_with(other: Option<&mut TestDevice>) -> World {
    let mut human = new_device();
    let mut agent = new_device();
    let (mut hub, room) = found_room(&mut human);
    publish_some(&mut hub, &mut agent, 4);
    if let Some(other) = other {
        add_human(&mut hub, &mut human, other);
        publish_some(&mut hub, other, 4);
        enrol(&mut hub, &mut human, &mut agent);
        let _ = found_main(&mut hub, &mut human, &agent.id());
        sync_all(&hub, other);
    } else {
        enrol(&mut hub, &mut human, &mut agent);
        let _ = found_main(&mut hub, &mut human, &agent.id());
    }
    sync_all(&hub, &mut human);
    sync_all(&hub, &mut agent);
    let group = human
        .groups()
        .unwrap()
        .into_iter()
        .find(|summary| summary.session.is_some())
        .unwrap()
        .group;
    World {
        hub,
        room,
        session: group.session_id().unwrap(),
        group,
        human,
        agent,
    }
}

const ZERO_HASH: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

fn card(title: &str, previous: &str) -> SecretBytes {
    json(&format!(
        r#"{{"card_type":"decision","title":"{title}","options":[{{"key":"yes"}},{{"key":"no"}}],"object_version":1,"previous_version_hash":"{previous}"}}"#
    ))
}

/// Both devices take everything new; returns what the first got.
fn both(world: &mut World) -> (Vec<ReceivedEnvelope>, Vec<ReceivedEnvelope>) {
    (
        sync_all(&world.hub, &mut world.human),
        sync_all(&world.hub, &mut world.agent),
    )
}

#[test]
fn a_card_is_answered_taken_back_and_answered_again_and_each_passes_the_gate_once() {
    let mut w = world();
    let sealed = write(
        &mut w.hub,
        &mut w.agent,
        &Draft::CardFirst {
            session: w.session,
            urgency: Urgency::High,
            push: true,
            payload: card("Ship it?", ZERO_HASH),
        },
    );
    let card_id = sealed.object_id.unwrap();
    let (at_human, at_agent) = both(&mut w);
    assert_eq!(at_human.len(), 1);
    assert_eq!(at_human[0].outcome, EnvelopeOutcome::Applied);
    assert_eq!(at_human[0].envelope_hash, sealed.envelope_hash);
    assert!(at_human[0].header.push);
    assert_eq!(at_agent[0].outcome, EnvelopeOutcome::Applied);
    let seen = w.human.object(&w.group, &card_id).unwrap().unwrap();
    assert_eq!(seen.state, ObjectState::Open);
    assert_eq!(seen.owner, w.agent.id());
    assert_eq!(seen.current, sealed.envelope_hash);
    assert_eq!(
        w.human.object_owner(&w.group, &card_id).unwrap(),
        Some(w.agent.id())
    );

    // The human answers; the answer is addressed to the card's owner by the device.
    let answer = Draft::Answer {
        session: w.session,
        object_id: card_id,
        choices: vec!["yes".into()],
        closes: false,
        payload: json(r#"{"answer_action":"answer","choices":["yes"]}"#),
    };
    let answered = write(&mut w.hub, &mut w.human, &answer);
    let (_, at_agent) = both(&mut w);
    assert_eq!(at_agent.len(), 1);
    assert!(at_agent[0].command);
    assert_eq!(at_agent[0].header.recipient, w.agent.id());
    assert_eq!(
        at_agent[0].object_after.as_ref().unwrap().1.state,
        ObjectState::Answered
    );
    assert_eq!(
        w.agent.commands_pending().unwrap(),
        vec![answered.envelope_hash]
    );
    // The gate lets it through exactly once.
    let decision = w.agent.command(&answered.envelope_hash, now()).unwrap();
    assert_eq!(
        decision,
        Decision::Act(Command::Answer {
            action: AnswerAction::Answer,
            choices: vec!["yes".into()],
        })
    );
    assert!(w.agent.commands_pending().unwrap().is_empty());
    assert_eq!(
        w.agent.command(&answered.envelope_hash, now()).unwrap(),
        Decision::Uncertain
    );
    w.agent.command_finished(&answered.envelope_hash).unwrap();
    assert_eq!(
        w.agent.command(&answered.envelope_hash, now()).unwrap(),
        Decision::Done
    );
    // A human device has no gate.
    assert_eq!(
        w.human.command(&answered.envelope_hash, now()),
        Err(Error::Forbidden)
    );

    // Taken back: the card is open again, and the agent is told to stop.
    let back = write(
        &mut w.hub,
        &mut w.human,
        &Draft::TakeBack {
            session: w.session,
            object_id: card_id,
            payload: json("{}"),
        },
    );
    both(&mut w);
    assert_eq!(
        w.agent.command(&back.envelope_hash, now()).unwrap(),
        Decision::Act(Command::TakeBack)
    );
    w.agent.command_finished(&back.envelope_hash).unwrap();
    for device in [&w.human, &w.agent] {
        let card = device.object(&w.group, &card_id).unwrap().unwrap();
        assert_eq!(card.state, ObjectState::Open);
        assert_eq!(card.answer, None);
    }

    // Answered again, this time closing the card; a choice the card does not offer does not pass the gate.
    let wrong = write(
        &mut w.hub,
        &mut w.human,
        &Draft::Answer {
            session: w.session,
            object_id: card_id,
            choices: vec!["maybe".into()],
            closes: true,
            payload: json(r#"{"answer_action":"answer"}"#),
        },
    );
    both(&mut w);
    assert_eq!(
        w.agent.command(&wrong.envelope_hash, now()).unwrap(),
        Decision::Refused(Refusal::BadChoice)
    );
    for device in [&w.human, &w.agent] {
        let card = device.object(&w.group, &card_id).unwrap().unwrap();
        assert_eq!(card.state, ObjectState::Closed);
    }
    assert_eq!(
        w.hub.objects(&w.group).get(&card_id),
        w.human.object(&w.group, &card_id).unwrap().as_ref()
    );
    // A closed card takes no answer: the device refuses to write it.
    assert_eq!(
        w.human.seal(&answer, None, &[], now()).map(|_| ()),
        Err(Error::Forbidden)
    );
}

fn text(received: &ReceivedEnvelope) -> String {
    String::from_utf8(received.body.as_ref().unwrap().payload().to_vec()).unwrap()
}

#[test]
fn a_permission_request_takes_one_verdict_before_it_expires() {
    let mut w = world();
    let session = w.session;
    let request = move |expires_at| Draft::PermissionRequest {
        session,
        urgency: Urgency::Critical,
        expires_at,
        push: true,
        payload: json(r#"{"tool_name":"Bash","description":"run","input_preview":"ls"}"#),
    };
    let expires_at = now() + 60_000;
    let first = write(&mut w.hub, &mut w.agent, &request(expires_at));
    let request_id = first.object_id.unwrap();
    let (at_human, _) = both(&mut w);
    let Bind::Request(bind) = at_human[0].body.as_ref().unwrap().bind() else {
        panic!("a request binds its expiry");
    };
    assert_eq!((bind.request_id, bind.expires_at), (request_id, expires_at));

    let verdict = move |request_id, allow| Draft::Verdict {
        session,
        request_id,
        allow,
        payload: json("{}"),
    };
    let allowed = write(&mut w.hub, &mut w.human, &verdict(request_id, true));
    let (_, at_agent) = both(&mut w);
    let Bind::Verdict(bound) = at_agent[0].body.as_ref().unwrap().bind() else {
        panic!("a verdict binds the request");
    };
    assert_eq!(bound.request_hash, first.envelope_hash);
    assert_eq!(bound.expires_at, expires_at);
    assert_eq!(
        w.agent.command(&allowed.envelope_hash, now()).unwrap(),
        Decision::Act(Command::Verdict(Verdict::Allow))
    );
    w.agent.command_finished(&allowed.envelope_hash).unwrap();
    let closed = w.human.object(&w.group, &request_id).unwrap().unwrap();
    assert_eq!(closed.state, ObjectState::Closed);
    // A second verdict on it is not written.
    assert_eq!(
        w.human
            .seal(&verdict(request_id, false), None, &[], now())
            .map(|_| ()),
        Err(Error::Forbidden)
    );

    // A verdict that the agent reads after the request ran out lets nothing happen.
    let short = write(&mut w.hub, &mut w.agent, &request(now() + 5_000));
    both(&mut w);
    let late = write(
        &mut w.hub,
        &mut w.human,
        &verdict(short.object_id.unwrap(), true),
    );
    both(&mut w);
    assert_eq!(
        w.agent.command(&late.envelope_hash, now() + 6_000).unwrap(),
        Decision::Refused(Refusal::Expired)
    );
    // A verdict on a request this device never opened cannot be written.
    assert_eq!(
        w.human
            .seal(&verdict(first.object_id.unwrap(), true), None, &[], now())
            .map(|_| ()),
        Err(Error::Forbidden)
    );
}

#[test]
fn chat_runs_on_a_session_and_on_a_card_and_only_a_humans_reaches_the_gate() {
    let mut w = world();
    let said = write(
        &mut w.hub,
        &mut w.human,
        &Draft::SessionChat {
            session: w.session,
            payload: json(r#"{"content_type":"message","text":"go on"}"#),
        },
    );
    let (at_human, at_agent) = both(&mut w);
    assert_eq!(at_human[0].outcome, EnvelopeOutcome::Applied);
    assert!(!at_human[0].command);
    assert!(at_agent[0].command);
    assert_eq!(at_agent[0].header.recipient, w.agent.id());
    assert!(text(&at_agent[0]).contains("go on"));
    assert_eq!(
        w.agent.command(&said.envelope_hash, now()).unwrap(),
        Decision::Act(Command::Chat)
    );

    // The agent's answer is addressed to nobody and is no command for anyone.
    let reply = write(
        &mut w.hub,
        &mut w.agent,
        &Draft::SessionChat {
            session: w.session,
            payload: json(r#"{"content_type":"message","text":"done","terminal":"answer"}"#),
        },
    );
    let (at_human, at_agent) = both(&mut w);
    assert_eq!(at_human[0].header.recipient, DeviceId::ZERO);
    assert!(text(&at_human[0]).contains("done"));
    assert!(!at_agent[0].command);
    assert_eq!(
        w.agent.command(&reply.envelope_hash, now()),
        Err(Error::NotFound)
    );

    // A message the agent addresses to itself is not a human's: the gate refuses it.
    let own = w
        .agent
        .seal(
            &Draft::SessionChat {
                session: w.session,
                payload: json(r#"{"text":"rm -rf"}"#),
            },
            Some(&w.agent.id()),
            &[],
            now(),
        )
        .unwrap();
    trommi_tests::post_ok(&mut w.hub, &mut w.agent);
    let (_, at_agent) = both(&mut w);
    assert!(at_agent[0].command);
    assert_eq!(
        w.agent.command(&own.envelope_hash, now()).unwrap(),
        Decision::Refused(Refusal::NotHuman)
    );

    // A card's own Chat exists once the card does.
    let session = w.session;
    let chat = move |card| Draft::CardChat {
        session,
        card,
        payload: json(r#"{"text":"why?"}"#),
    };
    let made = write(
        &mut w.hub,
        &mut w.agent,
        &Draft::CardFirst {
            session: w.session,
            urgency: Urgency::Normal,
            push: false,
            payload: card("Why", ZERO_HASH),
        },
    );
    let unknown = trommi_core::ids::ObjectId::new([9; 16]);
    assert_eq!(
        w.human.seal(&chat(unknown), None, &[], now()).map(|_| ()),
        Err(Error::Forbidden)
    );
    both(&mut w);
    let asked = write(&mut w.hub, &mut w.human, &chat(made.object_id.unwrap()));
    both(&mut w);
    assert_eq!(
        w.agent.command(&asked.envelope_hash, now()).unwrap(),
        Decision::Act(Command::Chat)
    );
    // A human may not write a card, nor an agent an answer.
    let forged = Draft::CardFirst {
        session: w.session,
        urgency: Urgency::Normal,
        push: false,
        payload: card("Mine", ZERO_HASH),
    };
    assert_eq!(
        w.human.seal(&forged, None, &[], now()).map(|_| ()),
        Err(Error::Forbidden)
    );
}

#[test]
fn a_note_takes_versions_of_two_writers() {
    let (mut w, mut other) = world_of_two();
    let note = |previous: &str, lamport: u64| {
        json(&format!(
            r#"{{"text":"n","lamport":{lamport},"previous_version_hash":"{previous}"}}"#
        ))
    };
    let first = write(
        &mut w.hub,
        &mut w.human,
        &Draft::NoteFirst {
            payload: note(ZERO_HASH, 1),
        },
    );
    let id = first.object_id.unwrap();
    assert_eq!(first.group, w.room);
    sync_all(&w.hub, &mut w.human);
    sync_all(&w.hub, &mut other);
    // Both write a version on the first, neither knowing the other's.
    let follows = first.envelope_hash.to_base64url();
    let version = |lamport| Draft::NoteVersion {
        object_id: id,
        closed: false,
        payload: note(&follows, lamport),
    };
    let mine = write(&mut w.hub, &mut w.human, &version(2));
    let theirs = write(&mut w.hub, &mut other, &version(2));
    for device in [&mut w.human, &mut other] {
        let got = sync_all(&w.hub, device);
        assert_eq!(got.len(), 2);
        assert!(got.iter().all(|r| r.outcome == EnvelopeOutcome::Applied));
        // The hub keeps the newest by arrival, and so does every device.
        let note = device.object(&w.room, &id).unwrap().unwrap();
        assert_eq!(note.current, theirs.envelope_hash);
        assert_ne!(mine.envelope_hash, theirs.envelope_hash);
    }
    assert_eq!(
        w.hub.objects(&w.room).get(&id),
        other.object(&w.room, &id).unwrap().as_ref()
    );
    // An agent device is no leaf of the room group and writes no Note.
    assert_eq!(
        w.agent.seal(&version(3), None, &[], now()).map(|_| ()),
        Err(Error::NotMember)
    );
}

#[test]
fn registers_follow_the_lamport_rule_across_devices() {
    let (mut w, mut other) = world_of_two();
    let (room, group) = (w.room, w.group);
    let desk = move |name: &str| Draft::Register {
        group: room,
        name: "desk/AAAAAAAAAAAAAAAAAAAAAA".into(),
        value: Some(json(&format!(r#"{{"name":"{name}"}}"#))),
    };
    // Two devices write the same name without having seen each other: the same lamport, and the higher
    // sender wins on both.
    write(&mut w.hub, &mut w.human, &desk("mine"));
    write(&mut w.hub, &mut other, &desk("theirs"));
    let winner = if w.human.id() > other.id() {
        "mine"
    } else {
        "theirs"
    };
    let read = move |device: &TestDevice| {
        let value = device
            .register(&room, "desk/AAAAAAAAAAAAAAAAAAAAAA")
            .unwrap()
            .unwrap();
        String::from_utf8(value.expose().to_vec()).unwrap()
    };
    let got = sync_all(&w.hub, &mut w.human);
    assert_eq!(got.len(), 2);
    assert_eq!(
        got[0].register.as_ref().unwrap().name,
        "desk/AAAAAAAAAAAAAAAAAAAAAA"
    );
    assert!(got[0].register.as_ref().unwrap().current);
    assert_eq!(
        got[1].register.as_ref().unwrap().current,
        winner == "theirs"
    );
    sync_all(&w.hub, &mut other);
    assert!(read(&w.human).contains(winner));
    assert_eq!(read(&w.human), read(&other));
    // Whoever writes next has seen both: its lamport is one above, and it wins whatever its id.
    let loser = if winner == "mine" {
        &mut other
    } else {
        &mut w.human
    };
    write(&mut w.hub, loser, &desk("later"));
    sync_all(&w.hub, &mut w.human);
    sync_all(&w.hub, &mut other);
    assert!(read(&w.human).contains("later"));
    assert_eq!(read(&w.human), read(&other));
    // A deletion is a value too.
    write(
        &mut w.hub,
        &mut w.human,
        &Draft::Register {
            group: w.room,
            name: "desk/AAAAAAAAAAAAAAAAAAAAAA".into(),
            value: None,
        },
    );
    sync_all(&w.hub, &mut other);
    assert_eq!(
        other
            .register(&w.room, "desk/AAAAAAAAAAAAAAAAAAAAAA")
            .unwrap(),
        None
    );

    // Each name has its owners: the agent's registers in its session, the humans' in the room.
    let session_register = move |name: &str| Draft::Register {
        group,
        name: name.into(),
        value: Some(json(r#"{"label":"x"}"#)),
    };
    for name in ["profile", "status_line/1", "heard", "alert/abc"] {
        write(&mut w.hub, &mut w.agent, &session_register(name));
        assert_eq!(
            w.human
                .seal(&session_register(name), None, &[], now())
                .map(|_| ()),
            Err(Error::Forbidden)
        );
    }
    assert_eq!(
        w.agent
            .seal(&session_register("goals"), None, &[], now())
            .map(|_| ()),
        Err(Error::Forbidden)
    );
    assert_eq!(
        w.human
            .seal(&session_register("no such name"), None, &[], now())
            .map(|_| ()),
        Err(Error::Forbidden)
    );
    write(&mut w.hub, &mut w.human, &session_register("goals"));
    // What the agent is handed of the room group, of which it is no leaf, is not for it.
    for received in sync_all(&w.hub, &mut w.agent) {
        if received.header.group == w.group {
            assert_eq!(received.outcome, EnvelopeOutcome::Applied);
        } else {
            assert_eq!(received.code, Some(Error::GroupBehind));
        }
    }
    assert!(w.agent.register(&w.group, "goals").unwrap().is_some());
    sync_all(&w.hub, &mut w.human);
    assert!(w.human.register(&w.group, "profile").unwrap().is_some());
    assert!(w
        .human
        .register(&w.group, "status_line/1")
        .unwrap()
        .is_some());
}

#[test]
fn heads_are_due_when_a_head_changed_and_show_what_a_reader_lacks() {
    let (mut w, mut other) = world_of_two();
    let start = now();
    // Nothing accepted yet: nothing to say.
    assert_eq!(w.human.heads_due(&w.room, start).unwrap(), None);
    let note = Draft::NoteFirst {
        payload: json(&format!(
            r#"{{"text":"n","previous_version_hash":"{ZERO_HASH}"}}"#
        )),
    };
    let first = write(&mut w.hub, &mut w.human, &note);
    sync_all(&w.hub, &mut w.human);
    let value = w.human.heads_due(&w.room, start).unwrap().unwrap();
    let heads = Draft::Register {
        group: w.room,
        name: "heads".into(),
        value: Some(SecretBytes::new(value)),
    };
    write(&mut w.hub, &mut w.human, &heads);
    sync_all(&w.hub, &mut w.human);
    // The heads register itself moved the own chain, but while connected the next one waits ten minutes.
    let written = now();
    assert_eq!(w.human.heads_due(&w.room, written + 1).unwrap(), None);
    assert!(w
        .human
        .heads_due(&w.room, written + HEADS_EVERY_MS)
        .unwrap()
        .is_some());

    // The other device is handed the heads but not the Note: it holds less than the head names.
    let served = w.hub.changes_after(other.cursor());
    for change in &served {
        if let trommi_tests::hub::content::Change::Envelope(stored) = change {
            if stored.hash != first.envelope_hash {
                let got = trommi_tests::take_envelope(&mut other, stored);
                assert_eq!(got.code, Some(Error::Gap));
            }
        }
    }
    // It reads the chain of the writer from its own head on, and compares.
    for stored in w.hub.chain_of(&w.room, &w.human.id(), 0) {
        other
            .receive_envelope(&stored.bytes, stored.change, true, None, now())
            .unwrap();
    }
    let standings = other.compare_heads(&w.room, &w.human.id()).unwrap();
    assert_eq!(standings, vec![(w.human.id(), HeadStanding::Held)]);
    assert_eq!(
        other.cut_of(&w.room, &w.human.id()).unwrap().seq,
        2,
        "the last envelope accepted"
    );
}
