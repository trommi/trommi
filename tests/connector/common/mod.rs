//! What the connector's end-to-end tests share: the real v2 hub (this workspace's `hub/`) as a child process, and a stand-in for the
//! human's device. The stand-in is the core's `Device` over the connector's journal, driven as an app drives it,
//! and speaks to the hub through the connector's hub client; everything a human's app does in these tests is
//! here, step by step.
#![allow(dead_code)]

pub mod process;

use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use trommi_connector::client::hub_for;
use trommi_connector::error::{Fault, Result};
use trommi_connector::hub::{b64, unb64, Hub};
use trommi_connector::keeper::Keeper;
use trommi_connector::store::Journal;
use trommi_connector::util::{hex, now_ms};
use trommi_connector::vault::Vault;
use trommi_core::crypto::{SecretBytes, SystemEntropy};
use trommi_core::device::{
    Accepted, Draft, EnvelopeOutcome, GroupSummary, InviteStep, LogEntry, LogKind, Processed,
    Received, WelcomeExpectation,
};
use trommi_core::envelope::Subject;
use trommi_core::hub_auth::HubAddress;
use trommi_core::ids::{DeviceId, GroupId, InviteId, ObjectId, RoomId, SessionId};
use trommi_core::invite::{Role, SignedRequest};
use trommi_core::store::{OutboxEntry, OutboxKind};
use trommi_core::Error;

/// A directory under the test run's temporary directory, removed when dropped.
pub struct TempDir(pub PathBuf);

impl TempDir {
    pub fn new(name: &str) -> TempDir {
        let dir = std::env::temp_dir().join(format!(
            "trommi-connector-test-{name}-{}-{}",
            std::process::id(),
            trommi_connector::util::random_hex(4)
        ));
        std::fs::create_dir_all(&dir).expect("a temporary directory");
        TempDir(dir)
    }
    pub fn path(&self) -> &std::path::Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The hub's binary: `TROMMI_HUB_BIN`, or the hub of this workspace, built beside the tests.
pub fn hub_binary() -> PathBuf {
    match std::env::var_os("TROMMI_HUB_BIN") {
        Some(path) => PathBuf::from(path),
        None => process::built("trommi-hub", "trommi-hub"),
    }
}

/// The real hub, running for one test.
pub struct HubProc {
    child: Child,
    pub url: String,
    pub port: u16,
    pub data: TempDir,
}

impl HubProc {
    /// Starts the hub on a free port with an empty data directory and waits until it answers.
    pub async fn start() -> HubProc {
        let data = TempDir::new("hub");
        Self::start_in(data, 0).await
    }

    /// Starts the hub over `data` (a restart keeps its database); `port` 0 picks a free one.
    pub async fn start_in(data: TempDir, port: u16) -> HubProc {
        let binary = hub_binary();
        assert!(
            binary.is_file(),
            "no hub binary at {}: cargo build -p trommi-hub, or set TROMMI_HUB_BIN",
            binary.display()
        );
        let port = if port != 0 {
            port
        } else {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("a free port");
            listener.local_addr().expect("its address").port()
        };
        let url = format!("http://127.0.0.1:{port}");
        let child = Command::new(&binary)
            .env_clear()
            .env("HUB_HOST", "127.0.0.1")
            .env("HUB_PORT", port.to_string())
            .env("HUB_DATA", data.path())
            .env("HUB_URL", &url)
            .env("HUB_QUIET", "1")
            .env("HUB_TEST_CONTROL", "1")
            .env("HUB_LIMIT_FOUND_PER_IP_HOUR", "100000")
            .env("HUB_PUSH_HOSTS", "127.0.0.1:9")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("the hub starts");
        let hub = HubProc {
            child,
            url,
            port,
            data,
        };
        let client = Hub::new(&hub.url, None, None).expect("a client");
        for _ in 0..1200 {
            if client
                .open_call(reqwest::Method::GET, "/healthz", None)
                .await
                .is_ok()
            {
                return hub;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        panic!("the hub did not come up");
    }

    /// Stops the hub and returns its data directory and port, to start it again.
    pub fn stop(mut self) -> (TempDir, u16) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let data = std::mem::replace(&mut self.data, TempDir(PathBuf::new()));
        (data, self.port)
    }
}

impl Drop for HubProc {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// An invite the stand-in made, until its device is in.
pub struct Invite {
    id: InviteId,
    /// The link to hand to the connector.
    pub link: String,
}

/// A device the stand-in admitted.
pub struct Admitted {
    pub device: DeviceId,
    /// The six numbers of the check code, as the app shows them.
    pub code: [u8; 6],
}

/// The human's device: the core's `Device` over a journal, as an app drives it.
pub struct Human {
    vault: Arc<Keeper<Vault>>,
    pub hub: Hub,
    id: DeviceId,
    pub room: RoomId,
    address: HubAddress,
    _dir: TempDir,
    /// The group of every card, Artifact and request seen, by object id as hex.
    objects: BTreeMap<String, GroupId>,
    requests: BTreeSet<String>,
    /// What the stand-in could not take, by code: a test asserts that it stays empty.
    pub findings: Vec<String>,
    /// The work trail steps that opened: (turn, number, step).
    pub trail: Vec<(String, u32, Value)>,
    /// The Chat messages, versions and register values that opened: (session hex, sender, payload).
    pub items: Vec<(String, DeviceId, Value)>,
}

pub fn fault_of(error: Error) -> Fault {
    Fault::from(error)
}

fn payload(value: &Value) -> SecretBytes {
    SecretBytes::new(value.to_string().into_bytes())
}

impl Human {
    /// Runs `job` on the device.
    async fn v<R: Send + 'static>(&self, job: impl FnOnce(&mut Vault) -> R + Send + 'static) -> R {
        self.vault.call(job).await.expect("the device's thread")
    }

    /// A new device that founds a room at the hub and publishes its KeyPackages.
    pub async fn found(url: &str) -> Human {
        let dir = TempDir::new("human");
        let journal = Journal::open(dir.path()).expect("a journal");
        let vault = Arc::new(Keeper::spawn(move || Vault::create(journal)).expect("a device"));
        let (id, room) = vault
            .call(|v: &mut Vault| {
                // The recovery code a human's app shows once; the stand-in forgets it.
                let (_code, keys) =
                    trommi_core::recovery::RecoveryKeys::generate(&mut SystemEntropy)
                        .expect("a code");
                let room = v
                    .device
                    .found_room(&keys, now_ms())
                    .expect("the room is founded");
                v.commit().expect("stored");
                (v.me(), room)
            })
            .await
            .expect("the device's thread");
        let hub = hub_for(&vault, url, room).expect("a client");
        let mut human = Human {
            vault,
            hub,
            id,
            room,
            address: HubAddress::parse(url).expect("the hub's address"),
            _dir: dir,
            objects: BTreeMap::new(),
            requests: BTreeSet::new(),
            findings: Vec::new(),
            trail: Vec::new(),
            items: Vec::new(),
        };
        human.post_all().await.expect("the founding is taken");
        human
            .v(|v| {
                v.device
                    .key_packages_to_upload(0, now_ms())
                    .expect("key packages");
                v.commit().expect("stored");
            })
            .await;
        human.post_all().await.expect("the key packages are taken");
        human
    }

    pub fn id(&self) -> DeviceId {
        self.id
    }

    /// The device a human addresses in a session group: its agent leaf.
    pub async fn seat(&self, group: &GroupId) -> Option<DeviceId> {
        let group = *group;
        self.v(move |v| v.seat(&group)).await
    }

    /// The groups the device is a leaf of.
    pub async fn groups(&self) -> Vec<GroupSummary> {
        self.v(|v| v.device.groups().expect("groups")).await
    }

    async fn post(&self, entry: &OutboxEntry) -> Result<Value> {
        let part = |i: usize| entry.parts.get(i).map(|p| b64(p)).unwrap_or_default();
        let has = |i: usize| entry.parts.get(i).is_some_and(|p| !p.is_empty());
        let group = entry.group.map(|g| b64(g.as_bytes())).unwrap_or_default();
        match entry.kind {
            OutboxKind::RoomFounding => {
                let open = Hub::new(self.address.as_str(), None, None)?;
                open.open_call(
                    reqwest::Method::POST,
                    "/v2/rooms",
                    Some(&json!({ "group_info": part(0), "sealed_key": part(1) })),
                )
                .await
            }
            OutboxKind::GroupFounding => {
                let mut body = json!({
                    "group_info_0": part(0), "sealed_key_0": part(1), "commit": part(2),
                    "group_info": part(3), "sealed_key": part(5),
                });
                if has(4) {
                    body["welcome"] = json!(part(4));
                }
                self.hub.post("/v2/groups", &body).await
            }
            OutboxKind::Commit => {
                let mut body = json!({
                    "epoch": entry.epoch, "commit": part(0), "group_info": part(1),
                    "sealed_key": part(3),
                });
                if has(2) {
                    body["welcome"] = json!(part(2));
                }
                self.hub
                    .post(&format!("/v2/groups/{group}/commits"), &body)
                    .await
            }
            OutboxKind::Message => {
                self.hub
                    .post(
                        &format!("/v2/groups/{group}/messages"),
                        &json!({ "epoch": entry.epoch, "message": part(0) }),
                    )
                    .await
            }
            OutboxKind::KeyPackages => {
                let single: Vec<String> = entry.parts.iter().skip(1).map(|p| b64(p)).collect();
                let mut body = json!({ "single_use": single });
                if has(0) {
                    body["last_resort"] = json!(part(0));
                }
                self.hub.put("/v2/key-packages", &body).await
            }
            OutboxKind::Envelope => {
                self.hub
                    .post("/v2/envelopes", &json!({ "envelope": part(0) }))
                    .await
            }
            OutboxKind::SealedKey => {
                self.hub
                    .put("/v2/sealed-keys", &json!({ "sealed_key": part(0) }))
                    .await
            }
            other => panic!("the stand-in posts no {other:?}"),
        }
    }

    /// Posts the device's outbox and reports each answer; the first refusal is returned.
    pub async fn post_all(&mut self) -> Result<()> {
        let entries = self.v(|v| v.device.outbox()).await;
        for entry in entries {
            let id = entry.id;
            let envelope = entry.kind == OutboxKind::Envelope;
            match self.post(&entry).await {
                Ok(answer) => {
                    let accepted = Accepted {
                        change: answer.get("change").and_then(Value::as_u64),
                    };
                    self.v(move |v| -> Result<()> {
                        v.device.outbox_accepted(id, accepted).map_err(fault_of)?;
                        v.commit()
                    })
                    .await?;
                }
                Err(fault) => {
                    let code = fault.as_core().unwrap_or(Error::Internal("refused"));
                    let voided = fault.extra.get("voided") == Some(&Value::Bool(true));
                    self.v(move |v| -> Result<()> {
                        if voided {
                            v.device.outbox_voided(id).map_err(fault_of)?;
                        } else if envelope {
                            v.device.envelope_abandon(id).map_err(fault_of)?;
                        } else {
                            v.device.outbox_refused(id, &code).map_err(fault_of)?;
                        }
                        v.commit()
                    })
                    .await?;
                    return Err(fault);
                }
            }
        }
        Ok(())
    }

    /// Makes an agent invite (for a new session, or to take `session` over) and publishes its Offer.
    pub async fn invite(&mut self, session: Option<SessionId>) -> Invite {
        self.sync().await;
        let address = self.address.clone();
        let opened = self
            .v(move |v| {
                let opened = v
                    .device
                    .invite_open(
                        Role::Agent,
                        session.as_ref(),
                        "https://app.trommi.example",
                        &address,
                        now_ms(),
                    )
                    .expect("an invite");
                v.commit().expect("stored");
                opened
            })
            .await;
        let offer = &opened.signed_offer;
        self.hub
            .post(
                "/v2/invites",
                &json!({ "offer": b64(&offer.offer), "signature": b64(&offer.signature) }),
            )
            .await
            .expect("the hub takes the Offer");
        Invite {
            id: opened.invite_id,
            link: String::from_utf8_lossy(opened.link.expose()).into_owned(),
        }
    }

    /// Waits for the Request to an invite, reveals, "confirms the emoji" and commits the new device: the
    /// change of `agents` in the room group.
    pub async fn admit(&mut self, invite: &mut Invite) -> Admitted {
        let path = format!("/v2/invites/{}", invite.id.to_base64url());
        let request = loop {
            let served = self.hub.get(&path).await.expect("the invite");
            if let Some(first) = served["requests"].as_array().and_then(|list| list.first()) {
                break SignedRequest {
                    request: unb64(first, "request").expect("request"),
                    mac: unb64(first, "mac").expect("mac"),
                    signature: unb64(first, "signature").expect("signature"),
                };
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        };
        let id = invite.id;
        let accepted = self
            .v(move |v| {
                let accepted = v
                    .device
                    .invite_accept(&id, &request, now_ms())
                    .expect("the Request is accepted");
                v.commit().expect("stored");
                accepted
            })
            .await;
        self.hub
            .put(
                &format!("{path}/reveal"),
                &json!({
                    "reveal": b64(&accepted.signed_reveal.reveal),
                    "signature": b64(&accepted.signed_reveal.signature),
                }),
            )
            .await
            .expect("the Reveal is published");
        // The human compares the six emoji and taps "They match".
        let (code, request_hash) = (accepted.code, accepted.request_hash);
        self.v(move |v| {
            v.device
                .invite_confirm(&id, &code, &request_hash, true, now_ms())
                .expect("the code is confirmed")
                .expect("the device is committed");
            v.commit().expect("stored");
        })
        .await;
        self.post_all().await.expect("the enrolment is taken");
        Admitted {
            device: accepted.new_device,
            code: accepted.code.numbers(),
        }
    }

    /// Does what the device says is left for the devices it committed by link (`invite_steps`), until
    /// nothing is: founding a session, taking one over, handing the history over.
    pub async fn follow_invites(&mut self) {
        for _ in 0..200 {
            self.sync().await;
            let steps = self
                .v(|v| {
                    let steps = v.device.invite_steps().expect("the steps");
                    v.commit().expect("stored");
                    steps
                })
                .await;
            if steps.is_empty() {
                return;
            }
            let mut waited = true;
            for (invite, step) in steps {
                match step {
                    InviteStep::Wait => continue,
                    InviteStep::Commit => {
                        self.v(move |v| {
                            v.device
                                .invite_recommit(&invite, now_ms())
                                .expect("committed again");
                        })
                        .await;
                    }
                    InviteStep::FoundSession { agent, key_package } => {
                        self.v(move |v| {
                            v.device
                                .found_session(&agent, std::slice::from_ref(&key_package), now_ms())
                                .expect("the founding is built");
                        })
                        .await;
                    }
                    InviteStep::TakeOver {
                        group,
                        cuts,
                        agent,
                        key_package,
                    } => {
                        let key_package = match key_package {
                            Some(key_package) => key_package,
                            None => {
                                let claimed = self
                                    .hub
                                    .post(
                                        "/v2/key-packages/claim",
                                        &json!({ "devices": [agent.to_base64url()] }),
                                    )
                                    .await
                                    .expect("a KeyPackage of the agent device");
                                unb64(&claimed["key_packages"], &agent.to_base64url())
                                    .expect("its bytes")
                            }
                        };
                        self.v(move |v| {
                            v.device
                                .clean_session(
                                    &group,
                                    &cuts,
                                    Some((&agent, &key_package)),
                                    now_ms(),
                                )
                                .expect("the takeover is built");
                        })
                        .await;
                    }
                    InviteStep::Handover { .. } => {
                        self.v(move |v| {
                            v.device.invite_handover(&invite).expect("the handover");
                        })
                        .await;
                    }
                    InviteStep::CheckHelpers { session } => {
                        let listed = self
                            .hub
                            .get(&format!("/v2/rooms/{}/groups", self.room.to_base64url()))
                            .await
                            .expect("the room's groups");
                        let parent = b64(session.as_bytes());
                        let helpers: Vec<GroupId> = listed
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter(|row| {
                                row["kind"] == "helper"
                                    && row["live"] != json!(false)
                                    && row["parent"] == parent.as_str()
                            })
                            .filter_map(|row| {
                                GroupId::from_bytes(&unb64(row, "group_id").ok()?).ok()
                            })
                            .collect();
                        // `group-behind`: a Welcome is still to be taken; the next round does.
                        let _ = self
                            .v(move |v| v.device.invite_checked(&invite, &helpers))
                            .await;
                    }
                    InviteStep::AddToSession { .. } => {
                        panic!("the stand-in adds no human device")
                    }
                }
                waited = false;
                self.v(|v| v.commit().expect("stored")).await;
                self.post_all().await.expect("the step is taken");
            }
            if waited {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        }
        panic!("the invite never finished");
    }

    /// Founds the main session of an agent device that was admitted without one. Returns its group.
    pub async fn found_session(&mut self, agent: &Admitted) -> GroupId {
        self.follow_invites().await;
        self.groups()
            .await
            .into_iter()
            .find(|summary| {
                summary.session.is_some_and(|s| s.parent.is_zero())
                    && summary.leaves.contains(&agent.device)
            })
            .expect("the agent device's main session")
            .group
    }

    /// Takes a main session over for the device that was admitted for it (5.3): the old agent device left
    /// `agents` with the enrolment; its leaf is replaced, and the history is handed over.
    pub async fn take_over(&mut self, _group: &GroupId, _old: DeviceId, _new: &Admitted) {
        self.follow_invites().await;
    }

    /// Follows the hub's order up to its end.
    pub async fn sync(&mut self) {
        loop {
            let cursor = self.v(|v| v.device.cursor()).await;
            let answer = self
                .hub
                .get(&format!("/v2/changes?after={cursor}&limit=500"))
                .await
                .expect("changes");
            let items = answer["items"].as_array().cloned().unwrap_or_default();
            for item in &items {
                let change = item["change"].as_u64().unwrap_or(0);
                match item["kind"].as_str() {
                    Some("envelope") => self.take_envelope(item, change).await,
                    Some(kind) => self.take_log(item, change, kind == "commit").await,
                    None => {}
                }
            }
            let moved = self.v(|v| v.device.cursor()).await != cursor;
            if answer["more"] != json!(true) || !moved {
                break;
            }
        }
        // What merging put into the outbox (nothing, for most entries).
        let _ = self.post_all().await;
    }

    async fn take_log(&mut self, item: &Value, change: u64, commit: bool) {
        let group = GroupId::from_bytes(&unb64(item, "group_id").expect("group")).expect("id");
        let bytes = unb64(item, "bytes").expect("bytes");
        let hand = move |v: &mut Vault| {
            let kind = if commit {
                LogKind::Commit {
                    bytes: &bytes,
                    recovery_auth: None,
                }
            } else {
                LogKind::Message { bytes: &bytes }
            };
            let processed = v.device.process_log_entry(
                &LogEntry {
                    change,
                    group,
                    kind,
                },
                now_ms(),
            );
            v.commit().expect("stored");
            (processed, v.device.group(&group).is_ok())
        };
        let (processed, held) = self.v(hand.clone()).await;
        match processed {
            Ok(Processed::Message(Received::WorkTrail {
                turn, number, step, ..
            })) => {
                let step = serde_json::from_slice(&step).unwrap_or(Value::Null);
                self.trail.push((hex(turn.as_bytes()), number, step));
            }
            Ok(_) => {}
            Err(error) => {
                if trommi_core::device::log_finding(&error)
                    != trommi_core::device::LogFinding::Duplicate
                {
                    self.findings.push(format!("log: {}", error.code()));
                }
            }
        }
        // A session an agent founded adds this device: its Welcome belongs at this Commit's place.
        if commit && !held && !group.is_room() {
            let welcomes = self.hub.get("/v2/welcomes").await.expect("welcomes");
            let wanted = b64(group.as_bytes());
            let Some(row) = welcomes
                .as_array()
                .into_iter()
                .flatten()
                .find(|row| row["group_id"] == wanted.as_str())
            else {
                return;
            };
            let welcome = unb64(row, "welcome").expect("welcome");
            let room = self.room;
            let joined = self
                .v(move |v| {
                    let expected = WelcomeExpectation {
                        room,
                        committer: None,
                    };
                    let joined = v.device.join_welcome(&welcome, &expected, now_ms());
                    v.commit().expect("stored");
                    joined.map(|joined| joined.offending.len())
                })
                .await;
            match joined {
                Ok(0) => {
                    // The Commit again: it gives the join its place.
                    let _ = self.v(hand).await;
                }
                Ok(offending) => self
                    .findings
                    .push(format!("welcome: {offending} offending")),
                Err(error) => self.findings.push(format!("welcome: {}", error.code())),
            }
        }
    }

    async fn take_envelope(&mut self, item: &Value, change: u64) {
        let bytes = unb64(item, "envelope").expect("envelope");
        let void_code = item["void_code"]
            .as_str()
            .map(|code| Error::from_code(code).unwrap_or(Error::BadFormat));
        let received = self
            .v(move |v| {
                let received =
                    v.device
                        .receive_envelope(&bytes, change, true, void_code.as_ref(), now_ms());
                v.commit().expect("stored");
                received
            })
            .await;
        let received = match received {
            Ok(received) => received,
            Err(error) => {
                self.findings.push(format!("envelope: {}", error.code()));
                return;
            }
        };
        let header = &received.header;
        let code = received.code.as_ref().map_or("", |code| code.code());
        match received.outcome {
            EnvelopeOutcome::Applied => {}
            EnvelopeOutcome::Refused if matches!(code, "replay" | "group-behind") => return,
            EnvelopeOutcome::Refused => {
                self.findings.push(format!("envelope: {code}"));
                return;
            }
            other => {
                self.findings.push(format!("{other:?}: {code}"));
                return;
            }
        }
        if let Subject::Version(fields) | Subject::Request(fields) = &header.subject {
            let id = hex(fields.object_id.as_bytes());
            if matches!(header.subject, Subject::Request(_)) {
                self.requests.insert(id.clone());
            }
            self.objects.insert(id, header.group);
        }
        if let Some(body) = &received.body {
            let session = header
                .group
                .session_id()
                .map(|sid| hex(sid.as_bytes()))
                .unwrap_or_default();
            let payload = serde_json::from_slice(body.payload()).unwrap_or(Value::Null);
            self.items.push((session, header.sender, payload));
        }
    }

    /// Seals an item, posts it, and follows the hub's order.
    async fn write(&mut self, draft: Draft) -> Result<()> {
        self.sync().await;
        self.v(move |v| -> Result<()> {
            v.device
                .seal(&draft, None, &[], now_ms())
                .map_err(fault_of)?;
            v.commit()
        })
        .await?;
        self.post_all().await
    }

    fn session_of(&self, object: &str) -> SessionId {
        self.objects
            .get(object)
            .and_then(GroupId::session_id)
            .expect("the object is known")
    }

    /// Writes a message into a session's Chat; the device addresses it to the session's agent device.
    pub async fn say(&mut self, group: &GroupId, body: Value) -> Result<()> {
        let session = group.session_id().expect("a session group");
        self.write(Draft::SessionChat {
            session,
            payload: payload(&body),
        })
        .await
    }

    /// Answers a card of the agent.
    pub async fn answer(
        &mut self,
        card: &str,
        body: Value,
        choices: &[&str],
        closes: bool,
    ) -> Result<()> {
        self.sync().await;
        self.write(Draft::Answer {
            session: self.session_of(card),
            object_id: object_id(card),
            choices: choices.iter().map(|choice| choice.to_string()).collect(),
            closes,
            payload: payload(&body),
        })
        .await
    }

    /// Takes the answer in force back.
    pub async fn take_back(&mut self, card: &str) -> Result<()> {
        self.sync().await;
        self.write(Draft::TakeBack {
            session: self.session_of(card),
            object_id: object_id(card),
            payload: payload(&json!({})),
        })
        .await
    }

    /// Allows or denies a permission request of the agent.
    pub async fn verdict(&mut self, request: &str, allow: bool) -> Result<()> {
        self.sync().await;
        self.write(Draft::Verdict {
            session: self.session_of(request),
            request_id: object_id(request),
            allow,
            payload: payload(&json!({})),
        })
        .await
    }

    /// Sets a register of a session group (the Desk's goals for its agent).
    pub async fn set_register(
        &mut self,
        group: &GroupId,
        name: &str,
        value: Option<Value>,
    ) -> Result<()> {
        self.write(Draft::Register {
            group: *group,
            name: name.to_string(),
            value: value.as_ref().map(payload),
        })
        .await
    }

    /// Whether the object is a permission request the stand-in saw.
    pub fn has_request(&self, object: &str) -> bool {
        self.requests.contains(object)
    }

    /// The objects the stand-in saw, by id as hex.
    pub fn object_ids(&self) -> Vec<String> {
        self.objects.keys().cloned().collect()
    }
}

pub fn object_id(hex_id: &str) -> ObjectId {
    ObjectId::from_slice(&trommi_connector::util::unhex(hex_id).expect("hex"))
        .expect("an object id")
}

/// Waits until `check` holds, at most a minute and a half (a busy machine is slow).
pub async fn eventually<F, Fut>(what: &str, mut check: F)
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    for _ in 0..1800 {
        if check().await {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    panic!("never happened: {what}");
}
