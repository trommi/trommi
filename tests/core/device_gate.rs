//! The command gate on the device (9.0.9, 13.6): an agent or helper device acts on a human's envelope only
//! when every condition holds at the moment it decides.

use trommi_core::crypto::SecretBytes;
use trommi_core::device::{Draft, EnvelopeOutcome};
use trommi_core::envelope::Urgency;
use trommi_core::ids::GroupId;
use trommi_core::objects::{AnswerAction, Command, Decision, Refusal};
use trommi_core::Error;
use trommi_tests::hub::Hub;
use trommi_tests::{
    add_human, enrol, found_helper, found_main, found_room, json, new_device, now, observe,
    post_ok, publish_some, sync_all, write, TestDevice,
};

const ZERO_HASH: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

struct World {
    hub: Hub,
    main: GroupId,
    a: TestDevice,
    b: TestDevice,
    agent: TestDevice,
}

/// Two human devices and an agent in its main session.
fn world() -> World {
    let (mut a, mut b, mut agent) = (new_device(), new_device(), new_device());
    let (mut hub, _) = found_room(&mut a);
    add_human(&mut hub, &mut a, &mut b);
    publish_some(&mut hub, &mut a, 4);
    publish_some(&mut hub, &mut b, 4);
    publish_some(&mut hub, &mut agent, 4);
    enrol(&mut hub, &mut a, &mut agent);
    let main = found_main(&mut hub, &mut a, &agent.id());
    for device in [&mut a, &mut b, &mut agent] {
        sync_all(&hub, device);
    }
    World {
        hub,
        main,
        a,
        b,
        agent,
    }
}

fn chat(group: &GroupId, text: &str) -> Draft {
    Draft::SessionChat {
        session: group.session_id().unwrap(),
        payload: json(&format!(r#"{{"text":"{text}"}}"#)),
    }
}

fn card(group: &GroupId) -> Draft {
    Draft::CardFirst {
        session: group.session_id().unwrap(),
        urgency: Urgency::Normal,
        push: false,
        payload: SecretBytes::new(
            format!(r#"{{"card_type":"info","title":"t","previous_version_hash":"{ZERO_HASH}"}}"#)
                .into_bytes(),
        ),
    }
}

#[test]
fn a_device_that_is_no_human_device_any_more_commands_nothing() {
    let mut w = world();
    let said = write(&mut w.hub, &mut w.b, &chat(&w.main, "delete it all"));
    // The agent has the message, and before it decides the device is removed from the room.
    let got = sync_all(&w.hub, &mut w.agent);
    assert!(got[0].command);
    sync_all(&w.hub, &mut w.a);
    let cut =
        w.a.cut_of(&GroupId::room(w.a.room().unwrap()), &w.b.id())
            .unwrap();
    w.a.remove_human_devices(&[cut], now()).unwrap();
    post_ok(&mut w.hub, &mut w.a);
    sync_all(&w.hub, &mut w.agent);
    assert_eq!(
        w.agent.command(&said.envelope_hash, now()).unwrap(),
        Decision::Refused(Refusal::NotHuman)
    );
    // Asked again, the answer is the same: nothing was recorded as started.
    assert_eq!(
        w.agent.command(&said.envelope_hash, now()).unwrap(),
        Decision::Refused(Refusal::NotHuman)
    );
    assert_eq!(
        w.agent.command_finished(&said.envelope_hash),
        Err(Error::NotFound)
    );
}

#[test]
fn a_command_of_an_epoch_that_ended_counts_for_two_minutes() {
    let mut w = world();
    let first = write(&mut w.hub, &mut w.a, &chat(&w.main, "one"));
    let second = write(&mut w.hub, &mut w.a, &chat(&w.main, "two"));
    sync_all(&w.hub, &mut w.agent);
    sync_all(&w.hub, &mut w.a);
    // The session's epoch ends; the agent processes the Commit now.
    w.a.update(&w.main, true, now()).unwrap().unwrap();
    post_ok(&mut w.hub, &mut w.a);
    let processed = now();
    sync_all(&w.hub, &mut w.agent);
    assert_eq!(
        w.agent
            .command(&first.envelope_hash, processed + 100_000)
            .unwrap(),
        Decision::Act(Command::Chat)
    );
    assert_eq!(
        w.agent
            .command(&second.envelope_hash, processed + 125_000)
            .unwrap(),
        Decision::Refused(Refusal::OldEpoch)
    );
}

#[test]
fn a_helper_device_acts_on_the_answer_to_its_own_card_and_its_opener_does_not() {
    let mut w = world();
    let mut helper = new_device();
    observe(&w.hub, &mut helper);
    helper
        .observe_session(w.hub.group_info(&w.main).unwrap())
        .unwrap();
    let group = found_helper(&mut w.hub, &mut w.agent, &w.main, &mut [&mut helper]);
    for device in [&mut w.a, &mut w.b, &mut w.agent, &mut helper] {
        sync_all(&w.hub, device);
    }
    let made = write(&mut w.hub, &mut helper, &card(&group));
    let card_id = made.object_id.unwrap();
    for device in [&mut w.a, &mut w.agent, &mut helper] {
        let got = sync_all(&w.hub, device);
        assert_eq!(got.last().unwrap().outcome, EnvelopeOutcome::Applied);
    }
    assert_eq!(
        w.a.object_owner(&group, &card_id).unwrap(),
        Some(helper.id())
    );
    let read = write(
        &mut w.hub,
        &mut w.a,
        &Draft::Answer {
            session: group.session_id().unwrap(),
            object_id: card_id,
            choices: Vec::new(),
            closes: true,
            payload: json(r#"{"answer_action":"read"}"#),
        },
    );
    let at_helper = sync_all(&w.hub, &mut helper);
    let at_opener = sync_all(&w.hub, &mut w.agent);
    assert!(at_helper.last().unwrap().command);
    assert!(!at_opener.last().unwrap().command);
    assert_eq!(
        helper.command(&read.envelope_hash, now()).unwrap(),
        Decision::Act(Command::Answer {
            action: AnswerAction::Read,
            choices: Vec::new(),
        })
    );
    assert_eq!(
        w.agent.command(&read.envelope_hash, now()),
        Err(Error::NotFound)
    );
    // A human's Chat message in a helper session goes to its opener.
    let said = write(&mut w.hub, &mut w.a, &chat(&group, "hello"));
    let at_opener = sync_all(&w.hub, &mut w.agent);
    assert_eq!(at_opener.last().unwrap().header.recipient, w.agent.id());
    assert_eq!(
        w.agent.command(&said.envelope_hash, now()).unwrap(),
        Decision::Act(Command::Chat)
    );
}

#[test]
fn a_helper_device_removed_and_added_again_under_its_key_owns_its_card_no_more() {
    let mut w = world();
    let (mut helper, mut other) = (new_device(), new_device());
    for device in [&mut helper, &mut other] {
        observe(&w.hub, device);
    }
    let group = found_helper(&mut w.hub, &mut w.agent, &w.main, &mut [&mut helper]);
    for device in [&mut w.a, &mut w.agent, &mut helper] {
        sync_all(&w.hub, device);
    }
    let made = write(&mut w.hub, &mut helper, &card(&group));
    let card_id = made.object_id.unwrap();
    sync_all(&w.hub, &mut w.a);
    sync_all(&w.hub, &mut w.agent);
    assert_eq!(
        w.a.object_owner(&group, &card_id).unwrap(),
        Some(helper.id())
    );
    // The opener removes the helper device, with its Cut, and adds it again under the same key.
    let cut = w.agent.cut_of(&group, &helper.id()).unwrap();
    let package = other.key_package(now()).unwrap();
    w.agent
        .readmit_helper(&group, cut, &other.id(), &package, now())
        .unwrap();
    post_ok(&mut w.hub, &mut w.agent);
    sync_all(&w.hub, &mut w.agent);
    let again = helper.key_package(now()).unwrap();
    w.agent
        .add_to_session(&group, &helper.id(), &again, now())
        .unwrap();
    post_ok(&mut w.hub, &mut w.agent);
    sync_all(&w.hub, &mut w.agent);
    sync_all(&w.hub, &mut w.a);
    assert!(w.a.group(&group).unwrap().leaves.contains(&helper.id()));
    // The card went to the session's opener when its writer left, for good.
    for device in [&w.a, &w.agent] {
        assert_eq!(
            device.object_owner(&group, &card_id).unwrap(),
            Some(w.agent.id())
        );
    }
    // And the chain of that key stays ended at its Cut.
    assert_eq!(w.a.chain_cut(&group, &helper.id()).unwrap().unwrap().seq, 1);
}
