//! The connector end to end against the real v2 hub (branch `v2-hub`, as a child process): joining by link with
//! the six-emoji check, every kind of write an agent makes, a human's commands through the gate, helper
//! sessions, a restart that keeps the membership, a takeover, and catching up after being away.
mod common;

use common::{eventually, Admitted, HubProc, Human, TempDir};
use serde_json::{json, Map, Value};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc::UnboundedReceiver;
use trommi_connector::client::{Client, ClientEvent, Command};
use trommi_connector::join::join_room;
use trommi_connector::store::Journal;
use trommi_core::ids::GroupId;

/// A connector's client in a slot directory of its own.
struct Agent {
    client: Arc<Client>,
    events: UnboundedReceiver<ClientEvent>,
    dir: TempDir,
    admitted: Admitted,
}

impl Agent {
    /// The next command of the human, at most ten seconds away.
    async fn command(&mut self) -> Command {
        loop {
            let event =
                tokio::time::timeout(std::time::Duration::from_secs(10), self.events.recv())
                    .await
                    .expect("an event in time")
                    .expect("the client lives");
            if let ClientEvent::Command(command) = event {
                let hash = command.envelope_hash.clone();
                if !hash.is_empty() {
                    self.client.ledger_mark(&hash).await.expect("marked");
                }
                return *command;
            }
        }
    }

    /// Reopens the slot without going online first: what a process finds that starts while the hub is away.
    async fn restart_cold(self) -> Agent {
        self.client.stop().await;
        let Agent {
            client,
            events,
            dir,
            admitted,
        } = self;
        drop(events);
        let weak = Arc::downgrade(&client);
        drop(client);
        eventually("the old client is gone", || async {
            weak.strong_count() == 0
        })
        .await;
        let journal = open_when_free(&dir).await;
        let (client, events) = Client::open(journal).await.expect("the slot opens again");
        client.start().await.expect("it starts, online or not");
        Agent {
            client,
            events,
            dir,
            admitted,
        }
    }

    /// Reopens the slot as a new process would: the old client is stopped and dropped first.
    async fn restart(self) -> Agent {
        self.client.stop().await;
        let Agent {
            client,
            events,
            dir,
            admitted,
        } = self;
        drop(events);
        // The journal's lock goes with the last handle; wait for the background tasks to let go.
        let weak = Arc::downgrade(&client);
        drop(client);
        eventually("the old client is gone", || async {
            weak.strong_count() == 0
        })
        .await;
        let journal = open_when_free(&dir).await;
        let (client, events) = Client::open(journal).await.expect("the slot opens again");
        client.start().await.expect("it goes online");
        Agent {
            client,
            events,
            dir,
            admitted,
        }
    }
}

async fn open_when_free(dir: &TempDir) -> Journal {
    for _ in 0..200 {
        match Journal::open(dir.path()) {
            Ok(journal) => return journal,
            Err(trommi_connector::store::StoreError::Locked) => {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await
            }
            Err(other) => panic!("the journal does not open: {other}"),
        }
    }
    panic!("the journal stayed locked");
}

/// Joins a new connector by an invite link of `human`; with `session`, to take that session over.
async fn join(human: &mut Human, session: Option<trommi_core::ids::SessionId>) -> Agent {
    let dir = TempDir::new("agent");
    let journal = Journal::open(dir.path()).expect("a journal");
    let mut invite = human.invite(session).await;
    let shown: Arc<Mutex<Option<[u8; 6]>>> = Arc::new(Mutex::new(None));
    let seen = shown.clone();
    let link = invite.link.clone();
    let for_join = journal.clone();
    let joining = tokio::spawn(async move {
        join_room(
            &link,
            for_join,
            move |code| *seen.lock().unwrap() = Some(code.numbers()),
            50,
            30_000,
        )
        .await
    });
    let admitted = human.admit(&mut invite).await;
    joining.await.expect("the join ran").expect("joined");
    assert_eq!(
        shown.lock().unwrap().expect("the code was shown"),
        admitted.code,
        "both sides show the same six emoji"
    );
    let (client, events) = Client::open(journal).await.expect("the slot opens");
    client.start().await.expect("it goes online");
    Agent {
        client,
        events,
        dir,
        admitted,
    }
}

/// A hub, a human with a room, and a connector in a main session of its own.
async fn room() -> (HubProc, Human, Agent, GroupId) {
    let hub = HubProc::start().await;
    let mut human = Human::found(&hub.url).await;
    let agent = join(&mut human, None).await;
    let group = human.found_session(&agent.admitted).await;
    let client = agent.client.clone();
    eventually("the agent is in its session", || async {
        client.core.lock().await.session_id().is_some()
    })
    .await;
    (hub, human, agent, group)
}

fn fields(value: Value) -> Map<String, Value> {
    value.as_object().cloned().expect("an object")
}

#[tokio::test(flavor = "multi_thread")]
async fn a_connector_joins_by_link_and_talks_both_ways() {
    let (_hub, mut human, mut agent, group) = room().await;

    // The agent writes; the human reads it.
    agent
        .client
        .send_message(
            fields(json!({ "text": "hello from the agent" })),
            None,
            None,
        )
        .await
        .expect("sent");
    human.sync().await;
    assert!(
        human
            .items
            .iter()
            .any(|(_, sender, payload)| *sender == agent.client.device_id()
                && payload["text"] == "hello from the agent"),
        "the human reads the agent's message: {:?}",
        human.findings
    );

    // The human writes; the agent gets it as a command, once.
    human
        .say(
            &group,
            json!({ "content_type": "message", "text": "hello agent" }),
        )
        .await
        .expect("the hub takes it");
    let command = agent.command().await;
    assert_eq!(command.command, "message");
    assert_eq!(command.content["text"], "hello agent");
    assert_eq!(command.sender_device_id, human.id().to_base64url());
    assert!(human.findings.is_empty(), "{:?}", human.findings);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_restart_keeps_the_membership() {
    let (_hub, mut human, agent, group) = room().await;
    agent
        .client
        .send_message(fields(json!({ "text": "before the restart" })), None, None)
        .await
        .expect("sent");
    let me = agent.client.device_id();

    let mut agent = agent.restart().await;
    assert_eq!(agent.client.device_id(), me, "the same device");
    agent
        .client
        .send_message(fields(json!({ "text": "after the restart" })), None, None)
        .await
        .expect("the same member writes on");
    human
        .say(
            &group,
            json!({ "content_type": "message", "text": "still there?" }),
        )
        .await
        .expect("taken");
    assert_eq!(agent.command().await.content["text"], "still there?");
    human.sync().await;
    assert!(human.findings.is_empty(), "{:?}", human.findings);
    let texts: Vec<&str> = human
        .items
        .iter()
        .filter(|(_, sender, _)| *sender == me)
        .filter_map(|(_, _, payload)| payload["text"].as_str())
        .collect();
    assert_eq!(texts, ["before the restart", "after the restart"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_takeover_stops_the_first_connector_and_hands_the_session_on() {
    let (_hub, mut human, mut first, group) = room().await;
    let card = first
        .client
        .send_card(
            fields(json!({
                "card_type": "decision", "title": "Blue or green?", "body": "", "urgency": "normal",
                "options": [{ "key": "blue", "label": "Blue" }, { "key": "green", "label": "Green" }],
                "allows_multiple": false,
            })),
            None,
        )
        .await
        .expect("a card");
    let old = first.client.device_id();

    // The human reconnects the session on another machine: a link for that session, then the takeover.
    let session = group.session_id().expect("a session group");
    let second = join(&mut human, Some(session)).await;
    human.take_over(&group, old, &second.admitted).await;

    // The first connector learns it from the Commit and stops.
    let removed = loop {
        let event = tokio::time::timeout(std::time::Duration::from_secs(10), first.events.recv())
            .await
            .expect("an event in time")
            .expect("the client lives");
        if let ClientEvent::Removed { replaced } = event {
            break replaced;
        }
    };
    assert_eq!(
        first.client.core.lock().await.model.room.connection,
        "removed"
    );
    let _ = removed;

    // The second one sits in the same session, reads what was there, and owns the first one's card.
    let client = second.client.clone();
    let sid = trommi_connector::util::hex(session.as_bytes());
    eventually("the new connector is in the session", || async {
        client.core.lock().await.session_id().as_deref() == Some(sid.as_str())
    })
    .await;
    eventually(
        "it read the session's history with the keys handed over",
        || async {
            client
                .core
                .lock()
                .await
                .model
                .cards
                .get(&card)
                .is_some_and(|c| c.title() == "Blue or green?")
        },
    )
    .await;
    let mut second = second;
    second
        .client
        .revise(
            &card,
            fields(json!({ "body": "Now with a new owner." })),
            None,
        )
        .await
        .expect("the session's agent device owns the card of the device that left");
    human.sync().await;
    assert!(human.findings.is_empty(), "{:?}", human.findings);
    human
        .answer(
            &card,
            json!({ "answer_action": "answer", "choices": ["green"] }),
            &["green"],
            false,
        )
        .await
        .expect("taken");
    let command = second.command().await;
    assert_eq!(command.command, "answer");
    assert_eq!(command.choices, ["green"]);

    // Nothing of the first one reaches the board any more.
    let late = first
        .client
        .send_message(fields(json!({ "text": "am I still here?" })), None, None)
        .await;
    assert!(late.is_err(), "a removed device writes nothing");
}

#[tokio::test(flavor = "multi_thread")]
async fn commands_that_came_while_away_arrive_once_and_in_order() {
    let (_hub, mut human, agent, group) = room().await;
    agent.client.stop().await;
    for text in ["one", "two", "three"] {
        human
            .say(&group, json!({ "content_type": "message", "text": text }))
            .await
            .expect("taken");
    }
    let mut agent = agent.restart().await;
    for text in ["one", "two", "three"] {
        assert_eq!(agent.command().await.content["text"], text);
    }
    // A second restart brings none of them again.
    let mut agent = agent.restart().await;
    human
        .say(&group, json!({ "content_type": "message", "text": "four" }))
        .await
        .expect("taken");
    assert_eq!(agent.command().await.content["text"], "four");
}

#[tokio::test(flavor = "multi_thread")]
async fn what_was_written_while_the_hub_was_away_is_sent_once_it_is_back() {
    let (hub, mut human, agent, _group) = room().await;
    let me = agent.client.device_id();
    let (data, port) = hub.stop();

    // The hub is gone: the envelope is sealed, numbered and stored, and the call returns.
    let sent = agent
        .client
        .send_message(fields(json!({ "text": "written offline" })), None, None)
        .await
        .expect("queued");
    assert!(sent.envelope_number.is_none());
    assert_eq!(agent.client.core.lock().await.outbox.len(), 1);

    // The process dies before the hub is back: nothing but the stored state is left.
    let agent = agent.restart_cold().await;
    assert_eq!(
        agent.client.core.lock().await.outbox.len(),
        1,
        "the outbox is on disk"
    );

    let _hub = HubProc::start_in(data, port).await;
    agent
        .client
        .settle(20_000)
        .await
        .expect("the outbox empties");
    // The hub lost its tokens with its restart: the stand-in signs in again by itself.
    human.sync().await;
    assert!(human.findings.is_empty(), "{:?}", human.findings);
    let texts: Vec<&str> = human
        .items
        .iter()
        .filter(|(_, sender, _)| *sender == me)
        .filter_map(|(_, _, payload)| payload["text"].as_str())
        .collect();
    assert_eq!(
        texts,
        ["written offline"],
        "sent once, with the number it was signed under"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn the_opener_admits_a_helper_device_and_lets_it_back_in_after_it_lost_its_state() {
    let (_hub, mut human, agent, _group) = room().await;
    let session = agent
        .client
        .open_child_session(fields(json!({ "agent_name": "Design" })))
        .await
        .expect("the agent founds the helper session itself");
    let helper_device = |name: &str| {
        let dir = TempDir::new(name);
        let journal = Journal::open(dir.path()).expect("a journal");
        let mut vault = trommi_connector::vault::Vault::create(journal).expect("a device");
        let package = vault
            .device
            .key_package(trommi_connector::util::now_ms())
            .expect("a KeyPackage");
        vault.commit().expect("stored");
        (dir, vault.me(), package)
    };
    let (_dir_a, first, package) = helper_device("helper-a");
    agent
        .client
        .admit_helper(&session, first, package)
        .await
        .expect("the helper device is added");
    // It lost its state: it comes back as a new device with a new key (4.3, 5.3.5).
    let (_dir_b, second, package) = helper_device("helper-b");
    agent
        .client
        .readmit_helper(&session, first, second, package)
        .await
        .expect("the opener replaces the lost device");

    human.sync().await;
    assert!(human.findings.is_empty(), "{:?}", human.findings);
    let helper_group = human
        .vault
        .device
        .groups()
        .expect("groups")
        .into_iter()
        .find(|g| g.session.is_some_and(|s| !s.parent.is_zero()))
        .expect("the human device is in the helper session");
    assert!(helper_group.leaves.contains(&second));
    assert!(!helper_group.leaves.contains(&first));
    assert!(helper_group.disallowed.is_empty());
    // The session still takes the opener's writes.
    agent
        .client
        .send_message(
            fields(json!({ "text": "after the re-admission" })),
            None,
            Some(session),
        )
        .await
        .expect("sent");
    human.sync().await;
    assert!(human.findings.is_empty(), "{:?}", human.findings);
}
