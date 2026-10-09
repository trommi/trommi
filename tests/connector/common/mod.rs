//! What the connector's end-to-end tests share: the real v2 hub as a child process, and a stand-in for the
//! human's device. The stand-in is built on `trommi-core` through the connector's own vault (the device, its
//! journal, the content chains) with a recovery construct of its own, and speaks to the hub through the
//! connector's hub client; everything a human's app does in these tests is here, step by step.
#![allow(dead_code)]

use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use trommi_connector::error::{Fault, Result};
use trommi_connector::hub::{b64, unb64, Hub, Signer};
use trommi_connector::store::Journal;
use trommi_connector::util::{hex, now_ms};
use trommi_connector::vault::{ContentDevice, Vault};
use trommi_core::chain::{Mode, Served};
use trommi_core::crypto::{self, Entropy, Secret, SigningKey, SystemEntropy};
use trommi_core::device::{Accepted, DeviceRecovery, LogEntry, LogKind, Processed, SealRequest};
use trommi_core::envelope::{
    AnswerBind, Draft, Envelope, ObjectType, Subject, TakeBackBind, Urgency, Verdict, VerdictBind,
};
use trommi_core::hub_auth::HubAddress;
use trommi_core::ids::{DeviceId, GroupId, Hash32, ObjectId, RoomId, SessionId};
use trommi_core::invite::{InviteTerms, Inviter, Request, Role, SignedRequest};
use trommi_core::mls::profile::Cut;
use trommi_core::mls::rules::{JoinClaim, RecoveryRules, SealedKeyClaim};
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

/// Where the hub's binary is: `TROMMI_HUB_BIN`, or the place the connector's build of branch `v2-hub` puts it.
pub fn hub_binary() -> PathBuf {
    if let Some(path) = std::env::var_os("TROMMI_HUB_BIN") {
        return PathBuf::from(path);
    }
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default();
    home.join(".cache/trommi-work/v2/connector-target/hub/debug/trommi-hub")
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
            "no hub binary at {}: build branch v2-hub (cargo build -p trommi-hub) or set TROMMI_HUB_BIN",
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
        for _ in 0..200 {
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

/// The recovery construct of the stand-in: a `SealedKey` in the layout the hub checks (spec/v2.md section 8),
/// with random bytes where the hub and an agent cannot look, and a `mac` as a human device's row carries.
struct HumanRecovery;

impl RecoveryRules for HumanRecovery {
    fn verify_join(&self, _: &JoinClaim<'_>) -> std::result::Result<(), Error> {
        Err(Error::BadCommit)
    }
    fn verify_sealed_key(
        &self,
        _: &SealedKeyClaim<'_>,
        sealed_key: &[u8],
    ) -> std::result::Result<(), Error> {
        if sealed_key.is_empty() {
            Err(Error::Incomplete)
        } else {
            Ok(())
        }
    }
}

impl DeviceRecovery for HumanRecovery {
    fn seal_key(
        &mut self,
        entropy: &mut dyn Entropy,
        request: &SealRequest<'_>,
    ) -> std::result::Result<Vec<u8>, Error> {
        let mut writer = trommi_core::codec::Writer::new();
        writer.opaque(request.group.as_bytes())?;
        writer.u64(request.epoch);
        writer.fixed(crypto::ref_hash("Trommi Group Info", request.group_info)?.as_bytes());
        writer.u64(request.room_epoch);
        writer.opaque(request.recovery_hpke_key)?;
        writer.opaque(&crypto::random::<32>(entropy)?)?;
        writer.opaque(&crypto::random::<48>(entropy)?)?;
        writer.fixed(request.writer.as_bytes());
        writer.opaque(&crypto::random::<32>(entropy)?)?;
        Ok(writer.into_bytes())
    }
    fn rules(&self) -> &dyn RecoveryRules {
        self
    }
}

/// An invite the stand-in made, until its device is in.
pub struct Invite {
    inviter: Inviter,
    /// The link to hand to the connector.
    pub link: String,
    id: String,
}

/// A device the stand-in admitted.
pub struct Admitted {
    pub device: DeviceId,
    pub key_package: Vec<u8>,
    /// The six numbers of the check code, as the app shows them.
    pub code: [u8; 6],
}

/// The human's device.
pub struct Human {
    pub vault: Vault,
    pub hub: Hub,
    key: SigningKey,
    pub room: RoomId,
    address: HubAddress,
    pub cursor: u64,
    _dir: TempDir,
    /// Card and request versions seen: object id as hex to (group, current hash, owner).
    pub objects: std::collections::BTreeMap<String, (GroupId, Hash32, DeviceId)>,
    /// What the stand-in could not take, by code: a test asserts that it stays empty.
    pub findings: Vec<String>,
    /// The work trail steps that opened: (turn, number, step).
    pub trail: Vec<(String, u32, Value)>,
    /// The Chat messages and register values that opened: (session hex, sender, payload).
    pub items: Vec<(String, DeviceId, Value)>,
    /// A permission request's bind, by object id as hex.
    requests: std::collections::BTreeMap<String, u64>,
}

pub fn fault_of(error: Error) -> Fault {
    Fault::from(error)
}

impl Human {
    /// A new device that founds a room at the hub and publishes its KeyPackages.
    pub async fn found(url: &str) -> Human {
        let dir = TempDir::new("human");
        let journal = Journal::open(dir.path()).expect("a journal");
        let mut vault = Vault::create_with(journal, Box::new(HumanRecovery)).expect("a device");
        let key = SigningKey::from_seed(vault.signing_key().seed().duplicate());
        let recovery_sign = SigningKey::generate(&mut SystemEntropy).expect("a key");
        let recovery_hpke =
            crypto::derive_hpke_keypair(&Secret::random(&mut SystemEntropy).expect("a seed"))
                .expect("a key pair");
        let room = vault
            .device
            .found_room(recovery_sign.public(), recovery_hpke.public, now_ms())
            .expect("the room is founded");
        vault.commit().expect("stored");
        let address = HubAddress::parse(url).expect("the hub's address");
        let signer: Signer = {
            let key = SigningKey::from_seed(key.seed().duplicate());
            let address = address.clone();
            Arc::new(move |challenge| {
                Ok(trommi_core::hub_auth::sign(
                    &key, room, &address, challenge,
                )?)
            })
        };
        let hub = Hub::new(url, Some(room), Some(signer)).expect("a client");
        let mut human = Human {
            vault,
            hub,
            key,
            room,
            address,
            cursor: 0,
            _dir: dir,
            objects: Default::default(),
            findings: Vec::new(),
            trail: Vec::new(),
            items: Vec::new(),
            requests: Default::default(),
        };
        human.post_all().await.expect("the founding is taken");
        human
            .vault
            .note_epoch(&GroupId::room(room), None, &[], now_ms())
            .expect("the room's first epoch");
        human
            .vault
            .device
            .key_packages_to_upload(0, now_ms())
            .expect("key packages");
        human.vault.commit().expect("stored");
        human.post_all().await.expect("the key packages are taken");
        human
    }

    pub fn id(&self) -> DeviceId {
        self.vault.me()
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
            other => panic!("the stand-in posts no {other:?}"),
        }
    }

    /// Posts the device's outbox and applies each answer; the first refusal is returned.
    pub async fn post_all(&mut self) -> Result<()> {
        for entry in self.vault.device.outbox() {
            match self.post(&entry).await {
                Ok(answer) => {
                    let accepted = Accepted {
                        change: answer.get("change").and_then(Value::as_u64),
                    };
                    self.vault
                        .device
                        .outbox_accepted(entry.id, accepted)
                        .map_err(fault_of)?;
                    if let (OutboxKind::Commit | OutboxKind::GroupFounding, Some(group)) =
                        (entry.kind, entry.group)
                    {
                        self.vault
                            .note_epoch(&group, Some(now_ms()), &[], now_ms())?;
                    }
                    self.vault.commit()?;
                }
                Err(fault) => {
                    let code = fault.as_core().unwrap_or(Error::Internal("refused"));
                    self.vault
                        .device
                        .outbox_refused(entry.id, &code)
                        .map_err(fault_of)?;
                    self.vault.commit()?;
                    return Err(fault);
                }
            }
        }
        Ok(())
    }

    /// Makes an agent invite (for a new session, or to take `session` over) and publishes its Offer.
    pub async fn invite(&mut self, session: Option<SessionId>) -> Invite {
        let newest = self
            .vault
            .device
            .room_history()
            .expect("the room")
            .newest()
            .clone();
        let terms = InviteTerms {
            app: "https://app.trommi.example".into(),
            hub: self.address.clone(),
            room_id: self.room,
            role: Role::Agent,
            session_id: session.unwrap_or(SessionId::ZERO),
            room_epoch: newest.epoch,
            room_state: newest.state,
        };
        let inviter =
            Inviter::open(&self.key, terms, now_ms(), &mut SystemEntropy).expect("an invite");
        let offer = inviter.signed_offer();
        let answer = self
            .hub
            .post(
                "/v2/invites",
                &json!({ "offer": b64(&offer.offer), "signature": b64(&offer.signature) }),
            )
            .await
            .expect("the hub takes the Offer");
        let id = answer["invite_id"]
            .as_str()
            .expect("an invite id")
            .to_string();
        let link = String::from_utf8_lossy(inviter.link().to_text().expose()).into_owned();
        Invite { inviter, link, id }
    }

    /// Waits for the Request to an invite, reveals, "confirms the emoji" and enrols the new device as an
    /// agent device of the room.
    pub async fn admit(&mut self, invite: &mut Invite) -> Admitted {
        let request = loop {
            let served = self
                .hub
                .get(&format!("/v2/invites/{}", invite.id))
                .await
                .expect("the invite");
            if let Some(first) = served["requests"].as_array().and_then(|list| list.first()) {
                break SignedRequest {
                    request: unb64(first, "request").expect("request"),
                    mac: unb64(first, "mac").expect("mac"),
                    signature: unb64(first, "signature").expect("signature"),
                };
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        };
        let key_package = Request::decode(&request.request)
            .expect("a Request")
            .key_package;
        let device = trommi_core::device::key_package_info(&key_package)
            .expect("a KeyPackage")
            .device;
        let accepted = invite
            .inviter
            .accept(&self.key, &request, &device, now_ms())
            .expect("the Request is accepted");
        self.hub
            .put(
                &format!("/v2/invites/{}/reveal", invite.id),
                &json!({
                    "reveal": b64(&accepted.reveal.reveal),
                    "signature": b64(&accepted.reveal.signature),
                }),
            )
            .await
            .expect("the Reveal is published");
        // The human compares the six emoji and taps "They match".
        invite
            .inviter
            .confirm(&accepted.code, &accepted.request_hash, now_ms())
            .expect("the code is confirmed");
        self.vault
            .device
            .change_agents(&[device], &[], now_ms())
            .expect("the enrolment is built");
        self.vault.commit().expect("stored");
        self.post_all().await.expect("the enrolment is taken");
        invite.inviter.finish().expect("the invite is done");
        Admitted {
            device,
            key_package,
            code: accepted.code.numbers(),
        }
    }

    /// Founds a main session for an agent device with its KeyPackage. Returns the session's group.
    pub async fn found_session(&mut self, agent: &Admitted) -> GroupId {
        let session = self
            .vault
            .device
            .found_session(&agent.device, &[agent.key_package.clone()], now_ms())
            .expect("the founding is built");
        self.vault.commit().expect("stored");
        self.post_all().await.expect("the founding is taken");
        GroupId::session(self.room, session)
    }

    /// Takes a main session over for `new` (5.3): the old agent device leaves `agents`, then its leaf is
    /// replaced in the session group, and the history is handed over.
    pub async fn take_over(&mut self, group: &GroupId, old: DeviceId, new: &Admitted) {
        self.sync().await;
        self.vault
            .device
            .change_agents(&[], &[old], now_ms())
            .expect("the old device leaves agents");
        self.vault.commit().expect("stored");
        self.post_all().await.expect("taken");
        let head = self.vault.head_of(group, &old);
        let cut = Cut {
            device: old,
            seq: head.seq,
            hash: head.hash,
        };
        self.vault
            .device
            .clean_session(
                group,
                &[cut],
                Some((&new.device, new.key_package.as_slice())),
                now_ms(),
            )
            .expect("the takeover is built");
        self.vault.commit().expect("stored");
        self.post_all().await.expect("the takeover is taken");
        self.vault
            .device
            .send_handover(group, &new.device)
            .expect("the handover is built");
        self.vault.commit().expect("stored");
        self.post_all().await.expect("the handover is taken");
    }

    /// Follows the hub's order up to its end.
    pub async fn sync(&mut self) {
        // Welcomes first: a helper session an agent founded adds this device.
        let welcomes = self.hub.get("/v2/welcomes").await.expect("welcomes");
        for row in welcomes.as_array().cloned().unwrap_or_default() {
            let group = GroupId::from_bytes(&unb64(&row, "group_id").expect("group")).expect("id");
            if self.vault.device.group(&group).is_ok() {
                continue;
            }
            let expected = trommi_core::device::WelcomeExpectation {
                room: self.room,
                committer: None,
            };
            let welcome = unb64(&row, "welcome").expect("welcome");
            match self
                .vault
                .device
                .join_welcome(&welcome, &expected, now_ms())
            {
                Ok(_) => {
                    self.vault
                        .note_epoch(&group, None, &[], now_ms())
                        .expect("its epoch");
                }
                Err(error) => self.findings.push(format!("welcome: {}", error.code())),
            }
            self.vault.commit().expect("stored");
        }
        loop {
            let answer = self
                .hub
                .get(&format!("/v2/changes?after={}&limit=500", self.cursor))
                .await
                .expect("changes");
            for item in answer["items"].as_array().cloned().unwrap_or_default() {
                let change = item["change"].as_u64().unwrap_or(0);
                if change <= self.cursor {
                    continue;
                }
                match item["kind"].as_str() {
                    Some("envelope") => self.take_envelope(&item, change),
                    Some(kind) => self.take_log(&item, change, kind == "commit"),
                    None => {}
                }
                self.cursor = change;
                self.vault.commit().expect("stored");
            }
            self.cursor = self.cursor.max(answer["change"].as_u64().unwrap_or(0));
            if answer["more"] != json!(true) {
                break;
            }
        }
    }

    fn take_log(&mut self, item: &Value, change: u64, commit: bool) {
        let group = GroupId::from_bytes(&unb64(item, "group_id").expect("group")).expect("id");
        let bytes = unb64(item, "bytes").expect("bytes");
        let kind = if commit {
            LogKind::Commit {
                bytes: &bytes,
                recovery_auth: None,
            }
        } else {
            LogKind::Message { bytes: &bytes }
        };
        match self.vault.device.process_log_entry(&LogEntry {
            change,
            group,
            kind,
        }) {
            Ok(Processed::Commit { facts, removed, .. }) if !removed => {
                let (time, cuts) = facts
                    .note
                    .map(|note| (note.time, note.cuts))
                    .unwrap_or((now_ms(), Vec::new()));
                self.vault
                    .note_epoch(&group, Some(time), &cuts, now_ms())
                    .expect("the epoch");
            }
            Ok(Processed::Message(trommi_core::device::Received::WorkTrail {
                turn,
                number,
                step,
                ..
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
    }

    fn take_envelope(&mut self, item: &Value, change: u64) {
        let _ = change;
        let bytes = unb64(item, "envelope").expect("envelope");
        let served = match item["void_code"].as_str() {
            Some(code) => Served::Void(Error::from_code(code).unwrap_or(Error::BadFormat)),
            None => Served::Stored,
        };
        let Ok(envelope) = Envelope::decode(&bytes) else {
            self.findings.push("envelope: bad-format".into());
            return;
        };
        let header = envelope.header.clone();
        match self.vault.receive(&bytes, &served, Mode::InOrder, now_ms()) {
            Ok(taken) => {
                let hash = taken.receipt.hash();
                let session = header
                    .group
                    .session_id()
                    .map(|sid| hex(sid.as_bytes()))
                    .unwrap_or_default();
                let opened = taken.receipt.opened();
                match &header.subject {
                    Subject::Version(fields) | Subject::Request(fields) => {
                        if let trommi_core::chain::Outcome::Taken { .. } = taken.receipt.outcome() {
                            self.objects.insert(
                                hex(fields.object_id.as_bytes()),
                                (header.group, hash, header.sender),
                            );
                        }
                        if let (Subject::Request(_), Some(opened)) = (&header.subject, &opened) {
                            if let trommi_core::envelope::Bind::Request(bind) = opened.body().bind()
                            {
                                self.requests
                                    .insert(hex(fields.object_id.as_bytes()), bind.expires_at);
                            }
                        }
                    }
                    _ => {}
                }
                if let Some(opened) = opened {
                    let payload: Value =
                        serde_json::from_slice(opened.body().payload()).unwrap_or(Value::Null);
                    self.items.push((session, header.sender, payload));
                }
                if let trommi_core::chain::Outcome::Refused(code) = taken.receipt.outcome() {
                    self.findings.push(format!("refused: {}", code.code()));
                }
            }
            Err(fault) if fault.code == "replay" => {}
            Err(fault) => self.findings.push(format!("envelope: {}", fault.code)),
        }
    }

    async fn post_envelope(&mut self, group: &GroupId, draft: &Draft) -> Result<Value> {
        let sealed = self.vault.seal(group, draft, now_ms())?;
        self.vault.commit()?;
        self.hub
            .post("/v2/envelopes", &json!({ "envelope": b64(&sealed.bytes) }))
            .await
    }

    fn seat(&self, group: &GroupId) -> DeviceId {
        self.vault
            .seat(group)
            .expect("the session has an agent leaf")
    }

    /// Writes a message into a session's Chat, addressed to its agent device.
    pub async fn say(&mut self, group: &GroupId, payload: Value) -> Result<Value> {
        let session = group.session_id().expect("a session group");
        let draft = Draft::session_chat(session, self.seat(group), payload.to_string().as_bytes());
        self.post_envelope(group, &draft).await
    }

    /// Answers a card of the agent.
    pub async fn answer(
        &mut self,
        card: &str,
        payload: Value,
        choices: &[&str],
        closes: bool,
    ) -> Result<Value> {
        let (group, version, owner) = *self.objects.get(card).expect("the card is known");
        let object_id = object_id(card);
        let bind = AnswerBind {
            object_id,
            version_hash: version,
            choices: choices.iter().map(|c| c.as_bytes().to_vec()).collect(),
        };
        let draft = Draft::answer(
            bind,
            closes,
            Urgency::Normal,
            owner,
            payload.to_string().as_bytes(),
        );
        self.post_envelope(&group, &draft).await
    }

    /// Takes the answer in force back: `answer_hash` is the answer's envelope hash.
    pub async fn take_back(&mut self, card: &str, answer_hash: Hash32) -> Result<Value> {
        let (group, version, owner) = *self.objects.get(card).expect("the card is known");
        let bind = TakeBackBind {
            object_id: object_id(card),
            previous_hash: answer_hash,
            version_hash: version,
        };
        let draft = Draft::take_back(bind, Urgency::Normal, owner, b"{}");
        self.post_envelope(&group, &draft).await
    }

    /// Allows or denies a permission request of the agent.
    pub async fn verdict(&mut self, request: &str, allow: bool) -> Result<Value> {
        let (group, hash, owner) = *self.objects.get(request).expect("the request is known");
        let bind = VerdictBind {
            request_id: object_id(request),
            request_hash: hash,
            expires_at: *self.requests.get(request).expect("its expiry"),
            verdict: if allow { Verdict::Allow } else { Verdict::Deny },
        };
        let draft = Draft::verdict(bind, Urgency::Normal, owner, b"{}");
        self.post_envelope(&group, &draft).await
    }

    /// Sets a register of a session group (the Desk's goals for its agent).
    pub async fn set_register(
        &mut self,
        group: &GroupId,
        name: &str,
        value: Option<Value>,
    ) -> Result<Value> {
        let text = value.map(|v| v.to_string());
        let draft = self.vault.register_draft(group, name, text.as_deref())?;
        self.post_envelope(group, &draft).await
    }

    /// The newest card of `agent` the stand-in has seen, as hex.
    pub fn object_type_marker() -> ObjectType {
        ObjectType::Card
    }
}

pub fn object_id(hex_id: &str) -> ObjectId {
    ObjectId::from_slice(&trommi_connector::util::unhex(hex_id).expect("hex"))
        .expect("an object id")
}

/// Waits until `check` holds, at most ten seconds.
pub async fn eventually<F, Fut>(what: &str, mut check: F)
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    for _ in 0..200 {
        if check().await {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    panic!("never happened: {what}");
}
