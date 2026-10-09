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
