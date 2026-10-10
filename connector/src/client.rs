//! The client: this device at work in its room. It signs in, holds the lease, takes Welcomes, follows the hub's
//! order (the live stream, and catching up after it was away), posts what waits in the device's outbox, and
//! hands a human's commands to the connector once the core's gate let them through.
//!
//! **Where state lives.** The [`Vault`] (the core's device over the journal) is kept on a thread of its own
//! (`keeper.rs`). What is plain data lives in [`Core`] under one lock: the model of the board and a few notes
//! beside the device's outbox. Every step takes that lock, calls the device, puts what follows from the answer
//! into the journal and commits once: one record per step, and nothing leaves before it (`store.rs`).
//!
//! **The hub's order.** Everything of the room comes with one running change number (spec/v1.md 5.4.1). The
//! device has one cursor for the log's entries and the envelopes; the client hands it every item in that
//! order, its own envelopes and Commits included: an envelope this device sent counts in the model when it
//! comes back at its place, and a Commit it made is merged where the log shows it. A write therefore posts and
//! then catches up; while the hub is away, what was sealed waits in the outbox and is posted unchanged later.
use crate::error::{Fault, Result};
use crate::hub::{b64, is_transient, unb64, Hub};
use crate::keeper::Keeper;
use crate::model::{Model, Seen};
use crate::store::Journal;
use crate::util::{hex, now_ms};
use crate::vault::{side_key, Vault};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use trommi_core::device::{
    log_finding, refusal_is_passing, Accepted, EnvelopeOutcome, LogEntry, LogFinding, LogKind,
    Processed, Received, ReceivedEnvelope, Sealed, WelcomeExpectation,
};
use trommi_core::envelope::{Envelope, Subject, Timeline};
use trommi_core::ids::{DeviceId, GroupId, Hash32, RoomId};
use trommi_core::objects::{AnswerAction, Command as GateCommand, Decision};
use trommi_core::recovery::ServedCommit;
use trommi_core::store::{OutboxEntry, OutboxKind};

/// A boxed future, for the traits the server implements.
pub type BoxFut<'a, T> = std::pin::Pin<Box<dyn std::future::Future<Output = T> + Send + 'a>>;

const TAG_SYNC: u8 = b'x';
/// What an envelope in the device's outbox was sealed from, by outbox id: to seal it again when the hub voided
/// it for its epoch.
const TAG_SPEC: u8 = b'q';
const TAG_MODEL: u8 = b'm';
const TAG_KV: u8 = b'k';
/// Commands the gate let through that are not yet noted as handed to the agent, by envelope hash.
const TAG_COMMAND: u8 = b'd';
/// The number of this device's last sealed envelope, by group: what the rollback guard holds the hub's copy
/// of its chain against.
const TAG_OWN: u8 = b'w';

/// How often an envelope the hub voided for its epoch is sealed again before the sender hears of it.
const RESEALS: u8 = 3;
/// Where a device the hub no longer takes reads the public Commits of one of its groups, up to and including
/// the one that removed it (spec/hub-api.md; for thirty days): `GET /v2/groups/{group}/removal?after=<n>`.
const REMOVAL_ROUTE: &str = "removal";
/// After this many rounds in a row in which what answered was no hub of this protocol, the client stops.
const NO_HUB_ROUNDS: u32 = 3;
/// A stream that lived at least this long was a working connection: the pause before the next starts small.
const STREAM_LIVED: Duration = Duration::from_secs(30);
/// The most envelopes that wait for the hub at once; a write beyond it is refused, not queued.
const MAX_WAITING: usize = 500;
/// The most work-trail steps that wait for the hub at once; a step beyond it is dropped (a trail is live).
pub(crate) const MAX_WAITING_STEPS: usize = 100;
/// The most a session's envelopes may weigh when they are read again.
const MAX_REREAD_LEN: usize = 256 << 20;
/// How many items one catch-up request asks for.
const CHANGES_LIMIT: u64 = 500;
/// The hub pings every 25 s; a stream that is silent for this long is dead.
const STREAM_SILENCE: Duration = Duration::from_secs(70);
/// The lease lives 60 s and is renewed every 20 s (13.7).
const LEASE_EVERY: Duration = Duration::from_secs(20);

/// Sleeps `ms` milliseconds.
pub async fn sleep(ms: u64) {
    tokio::time::sleep(Duration::from_millis(ms)).await;
}

/// A command of a human for the agent, after the core's gate (9.0.9).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Command {
    /// It was let through before this process started and never noted as handed over: the agent may or may
    /// not have had it (9.0.9: reported, not repeated).
    pub uncertain: bool,
    /// `message`, `answer`, `trust`, `read`, `shred`, `decide_again`, `verdict`, `unsupported`.
    pub command: String,
    pub session_id: Option<String>,
    /// The hub's change number of the envelope.
    pub envelope_number: u64,
    /// The envelope's hash, base64url.
    pub envelope_hash: String,
    pub sender_device_id: String,
    pub sender_sequence: u64,
    pub sent_at: u64,
    pub object_id: Option<String>,
    /// `chat:session/<id>` or `chat:card/<id>` for a message.
    pub timeline_key: Option<String>,
    /// The envelope's payload.
    pub content: Map<String, Value>,
    pub late: bool,
    pub history: bool,
    pub choices: Vec<String>,
    pub previous_choices: Vec<String>,
    pub allow: bool,
    /// Whether the answer closed the card by itself (a final option).
    pub settled: bool,
    pub unsupported: Option<String>,
    pub what: Option<String>,
}

/// What the client tells its owner.
#[derive(Clone, Debug)]
pub enum ClientEvent {
    /// A human's command.
    Command(Box<Command>),
    /// This device is out of the room or of its session: removed, or another connector took the session over.
    /// `verified`: it processed the Commit that removed it. Otherwise the hub says so (it ends a removed
    /// device's access at once, so the Commit may never reach it): the device stops, and keeps its state.
    Removed { replaced: bool, verified: bool },
    /// Something the owner must know: `lease-lost`, `client-too-old`, `bad-group`, …
    Error(Fault),
    /// This device is a leaf of its main session now.
    Session { session_id: String },
}

/// What a joined slot knows of its room beside the device: stored when the invite was answered.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct RoomRecord {
    /// The hub's canonical address.
    pub hub: String,
    /// The app's origin, for Share links.
    pub app: String,
    /// The room, base64url.
    pub room: String,
    /// The session the invite was for, as hex; empty for a new session.
    #[serde(default)]
    pub invited_session: String,
    /// The room epoch the Offer named: where this device starts to follow the room group.
    #[serde(default)]
    pub room_epoch: u64,
    /// Whether the inviter's enrolment of this device was processed.
    #[serde(default)]
    pub enrolled: bool,
}

/// What an envelope of this device is, so that it can be sealed, and sealed again when the hub voided it for its
/// epoch.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum Spec {
    /// A message in a session's Chat.
    SessionChat { payload: String },
    /// A message in a card's Chat.
    CardChat { card: String, payload: String },
    /// A register value; `value` is JSON text, none deletes.
    Register { name: String, value: Option<String> },
    /// The first version of a card (`object_type` 1) or an Artifact (4).
    First {
        object_type: u8,
        urgency: u8,
        push: bool,
        payload: String,
    },
    /// A later version; the payload's `previous_version_hash` and `object_version` are set when it is sealed.
    Later {
        object: String,
        object_type: u8,
        closed: bool,
        urgency: u8,
        push: bool,
        payload: String,
    },
    /// A permission request.
    Request {
        urgency: u8,
        expires_at: u64,
        payload: String,
    },
}

/// The note beside an envelope in the device's outbox.
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Waiting {
    /// The group, base64url.
    group: String,
    spec: Spec,
    /// The file ids its header names, base64url.
    files: Vec<String>,
    /// The hub voided the envelope for its epoch: it is sealed again in the group's next epoch.
    #[serde(default)]
    rebuild: bool,
    /// How often it was sealed again, and the outbox id of the first envelope it stands in for.
    #[serde(default)]
    resealed: u8,
    #[serde(default)]
    first: Option<u64>,
}

#[derive(Default, Serialize, Deserialize)]
struct SyncRecord {
    #[serde(default)]
    halted: Option<String>,
    /// Groups whose envelopes are to be read again, base64url: kept until the reading is done, so that a
    /// crash in between is made up for at the next start.
    #[serde(default)]
    reread: Vec<String>,
}

/// What a send reports.
#[derive(Clone, Debug, Default)]
pub struct SentInfo {
    /// The envelope's hash, base64url.
    pub hash: String,
    /// The object the envelope belongs to (of a first version or a request: the new object), as hex.
    pub object_id: Option<String>,
    /// The hub's change number, once the hub took the envelope.
    pub envelope_number: Option<u64>,
}

/// The plain state of the client. Taken with [`Client::core`]'s lock.
pub struct Core {
    pub model: Model,
    /// The outbox ids of this device's envelopes the hub has not taken yet, oldest first.
    pub outbox: Vec<u64>,
    /// The device's cursor in the hub's order.
    pub cursor: u64,
    pub room: RoomRecord,
    /// The session groups this device is a leaf of, by session id as hex.
    pub groups: BTreeMap<String, GroupId>,
    /// The main session, as hex.
    main: Option<String>,
    journal: Journal,
    /// Why nothing is processed any more, if so.
    pub halted: Option<String>,
    /// Groups whose envelopes are to be read again from the hub's first.
    reread: Vec<GroupId>,
    /// The list as it was last staged.
    reread_stored: Vec<GroupId>,
    /// Groups a reading-again was asked for since this client last went online: once each.
    reread_asked: Vec<GroupId>,
    /// Groups a re-admission was asked for in this process.
    asked_readmit: Vec<GroupId>,
    /// Requests of this device the hub voided or refused for good, by outbox id (of an envelope that was
    /// sealed again: the first one's).
    failed: BTreeMap<u64, Fault>,
    /// Envelopes that were sealed again after the hub voided them for their epoch, by the first one's id.
    replaced: BTreeMap<u64, Sealed>,
    /// How many findings of the device were already said.
    findings_said: usize,
    /// Files this process uploaded or fetched, by their whole reference: the newest few.
    pub(crate) files: Vec<(String, Vec<u8>)>,
}

impl Core {
    /// The main session, as hex.
    pub fn session_id(&self) -> Option<String> {
        self.main.clone()
    }
    /// Every session this device is a leaf of.
    pub fn session_ids(&self) -> Vec<String> {
        self.groups.keys().cloned().collect()
    }
    /// The helper sessions this device opened.
    pub fn child_session_ids(&self) -> Vec<String> {
        self.groups
            .keys()
            .filter(|sid| Some(*sid) != self.main.as_ref())
            .cloned()
            .collect()
    }
    /// The group of a session; the main session's for none.
    pub fn group_of(&self, session_id: Option<&str>) -> Result<GroupId> {
        let sid = session_id
            .map(str::to_owned)
            .or_else(|| self.main.clone())
            .ok_or_else(|| Fault::new("no-session", "this agent has no session yet"))?;
        self.groups
            .get(&sid)
            .copied()
            .ok_or_else(|| Fault::new("no-session", "this agent is not in that session"))
    }
    fn session_of_group(&self, group: &GroupId) -> Option<String> {
        group.session_id().map(|sid| hex(sid.as_bytes()))
    }
    /// A value of the connector's own, by name (the bridge's state, what waited for another session).
    pub fn kv_get(&self, name: &str) -> Option<Value> {
        self.journal
            .get(&side_key(TAG_KV, &[name.as_bytes()]))
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
    }
    /// Stores such a value; written with the next commit.
    pub fn kv_set(&self, name: &str, value: &Value) {
        self.journal.put(
            side_key(TAG_KV, &[name.as_bytes()]),
            value.to_string().into_bytes(),
        );
    }
    fn stage(&mut self) {
        // The groups still to be read again are part of every record.
        if self.reread != self.reread_stored {
            self.reread_stored = self.reread.clone();
            self.halt_record();
        }
        for name in self.model.take_dirty() {
            let key = side_key(TAG_MODEL, &[name.as_bytes()]);
            match self.model.record(&name) {
                Some(bytes) => self.journal.put(key, bytes),
                None => self.journal.delete(key),
            }
        }
    }
    /// Writes everything staged, the model's changes included, as one record.
    pub fn commit(&mut self) -> Result<()> {
        self.stage();
        Ok(self.journal.commit()?)
    }
    fn waiting(&self, outbox_id: u64) -> Option<Waiting> {
        self.journal
            .get(&side_key(TAG_SPEC, &[&outbox_id.to_be_bytes()]))
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
    }
    fn put_waiting(&self, outbox_id: u64, waiting: &Waiting) {
        if let Ok(bytes) = serde_json::to_vec(waiting) {
            self.journal
                .put(side_key(TAG_SPEC, &[&outbox_id.to_be_bytes()]), bytes);
        }
    }
    fn drop_waiting(&mut self, outbox_id: u64) {
        self.outbox.retain(|id| *id != outbox_id);
        self.journal
            .delete(side_key(TAG_SPEC, &[&outbox_id.to_be_bytes()]));
    }
    /// The number of this device's last sealed envelope in `group`.
    fn own_seq(&self, group: &GroupId) -> u64 {
        self.journal
            .get(&side_key(TAG_OWN, &[group.as_bytes()]))
            .and_then(|bytes| bytes.as_slice().try_into().ok().map(u64::from_be_bytes))
            .unwrap_or(0)
    }
    /// Asks for a group's envelopes to be read again, at most once per time online.
    fn ask_reread(&mut self, group: GroupId) {
        if !self.reread_asked.contains(&group) {
            self.reread_asked.push(group);
            self.reread.push(group);
        }
    }
    fn halt_record(&self) {
        let record = SyncRecord {
            halted: self.halted.clone(),
            reread: self.reread.iter().map(|g| b64(g.as_bytes())).collect(),
        };
        if let Ok(bytes) = serde_json::to_vec(&record) {
            self.journal.put(side_key(TAG_SYNC, &[]), bytes);
        }
    }
}

/// The lock on the [`Core`]. A step takes it, changes the state and commits before it lets go.
pub struct CoreLock(tokio::sync::Mutex<Core>);

/// The held lock. If it is let go while changes are staged and not written (a step that was given up half
/// way: its future was dropped, or it failed between a change and its commit), the journal is poisoned: what
/// is in memory no longer matches any state that may be written, so nothing more is, and the process starts
/// over from the files.
pub struct Held<'a>(tokio::sync::MutexGuard<'a, Core>);

impl CoreLock {
    /// Waits for the lock.
    pub async fn lock(&self) -> Held<'_> {
        Held(self.0.lock().await)
    }
}

impl std::ops::Deref for Held<'_> {
    type Target = Core;
    fn deref(&self) -> &Core {
        &self.0
    }
}

impl std::ops::DerefMut for Held<'_> {
    fn deref_mut(&mut self) -> &mut Core {
        &mut self.0
    }
}

impl Drop for Held<'_> {
    fn drop(&mut self) {
        if self.0.journal.is_dirty() {
            eprintln!("[trommi] a step ended between its changes and its write: nothing more is written by this process");
            self.0.journal.poison();
        }
    }
}

/// The room record of a slot's journal, if the slot was joined.
pub fn room_record(journal: &Journal) -> Option<RoomRecord> {
    journal
        .get(&side_key(TAG_KV, &[b"room"]))
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
}

/// Stages the room record.
pub fn put_room_record(journal: &Journal, record: &RoomRecord) {
    if let Ok(bytes) = serde_json::to_vec(record) {
        journal.put(side_key(TAG_KV, &[b"room"]), bytes);
    }
}

/// A hub client that signs in with the device a keeper holds (`Device::hub_sign_in`).
pub fn hub_for(vault: &Arc<Keeper<Vault>>, address: &str, room: RoomId) -> Result<Hub> {
    let parsed = trommi_core::hub_auth::HubAddress::parse(address)
        .map_err(|_| Fault::new("bad-format", "the hub's address is not canonical"))?;
    let vault = vault.clone();
    let signer: crate::hub::Signer = Arc::new(move |challenge| {
        let (vault, parsed) = (vault.clone(), parsed.clone());
        Box::pin(async move {
            Ok(vault
                .call(move |v: &mut Vault| v.device.hub_sign_in(&parsed, challenge))
                .await??)
        })
    });
    Hub::new(address, Some(room), Some(signer))
}

/// This device at work. See the module's documentation.
pub struct Client {
    pub core: CoreLock,
    pub(crate) vault: Arc<Keeper<Vault>>,
    pub(crate) hub: Arc<Hub>,
    events: tokio::sync::mpsc::UnboundedSender<ClientEvent>,
    me: DeviceId,
    pub(crate) room: RoomId,
    /// This process, for the lease.
    process: [u8; 16],
    stopped: AtomicBool,
    /// Tells the background tasks to end; they hold the client alive until they have.
    stop_signal: tokio::sync::watch::Sender<bool>,
    removed: AtomicBool,
    /// Whether the rollback guard ran in this process: before it has, nothing is signed.
    guarded: AtomicBool,
    /// Set while served Commits are checked for this device's removal: what is found is told once, at the end.
    verifying: AtomicBool,
    /// Whether the removal was verified: this device processed the Commit that removed it.
    removal_verified: AtomicBool,
    online: AtomicBool,
    /// Wakes the loop: something waits in the outbox.
    wake: tokio::sync::Notify,
    /// What this process last reported with its lease.
    report: std::sync::Mutex<Value>,
    /// The code of the last fault the owner was told of: the same one is not said again and again.
    told: std::sync::Mutex<String>,
}

fn group_of_item(item: &Value) -> Result<GroupId> {
    Ok(GroupId::from_bytes(&unb64(item, "group_id")?)?)
}

fn b64_group(text: &str) -> Result<GroupId> {
    let bytes = trommi_core::ids::base64url_decode(text)?;
    Ok(GroupId::from_bytes(&bytes)?)
}

/// What a log entry did, as far as the client acts on it.
enum LogOutcome {
    Nothing,
    Early,
    /// A Commit of a group this device is in was merged; whether it may have removed a leaf.
    Epoch(bool),
    /// A Commit of a session group this device does not hold: its Welcome may wait.
    Unheld,
    Keys(GroupId),
    Newer,
    /// The room enrolled this device.
    Enrolled,
    Unenrolled,
    RemovedFrom(GroupId),
    BadInvite,
    Bad(&'static str),
}

/// An envelope as the device took it, with what the client needs beside.
struct Took {
    received: ReceivedEnvelope,
    /// The gate's answer, for an envelope it can be asked about.
    decision: Option<Decision>,
    cursor: u64,
}

impl Client {
    /// Opens the client over a joined slot: `journal` holds the device and the room record. Nothing is sent
    /// yet; [`Client::start`] goes online.
    pub async fn open(
        journal: Journal,
    ) -> Result<(
        Arc<Client>,
        tokio::sync::mpsc::UnboundedReceiver<ClientEvent>,
    )> {
        let room = room_record(&journal).ok_or_else(|| {
            Fault::new(
                "no-room",
                "this slot holds no room: join with an invite link",
            )
        })?;
        let room_id = RoomId::from_base64url(&room.room)
            .map_err(|_| Fault::new("state-damaged", "the stored room does not read"))?;
        let for_vault = journal.clone();
        let vault = Arc::new(Keeper::spawn(move || Vault::open(for_vault))?);
        let (me, cursor) = vault
            .call(|v: &mut Vault| (v.me(), v.device.cursor()))
            .await?;
        let hub = Arc::new(hub_for(&vault, &room.hub, room_id)?);

        let mut model = Model::new();
        for (key, value) in journal.scan(&side_key(TAG_MODEL, &[])[..2]) {
            // [SIDE, tag, len, name…]
            let name = key
                .get(3..)
                .map(String::from_utf8_lossy)
                .unwrap_or_default();
            if !model.load(&name, &value) {
                return Err(Fault::new(
                    "state-damaged",
                    "a stored record of the board does not read",
                ));
            }
        }
        model.room.room_id = room.room.clone();
        model.room.connection = "offline".into();
        model.project();
        let _ = model.take_dirty();
        let sync: SyncRecord = journal
            .get(&side_key(TAG_SYNC, &[]))
            .map(|bytes| serde_json::from_slice(&bytes))
            .transpose()
            .map_err(|_| Fault::new("state-damaged", "the stored halt does not read"))?
            .unwrap_or_default();
        let (events, rx) = tokio::sync::mpsc::unbounded_channel();
        let client = Arc::new(Client {
            core: CoreLock(tokio::sync::Mutex::new(Core {
                model,
                outbox: Vec::new(),
                cursor,
                room,
                groups: BTreeMap::new(),
                main: None,
                journal,
                halted: sync.halted,
                reread: sync
                    .reread
                    .iter()
                    .filter_map(|text| b64_group(text).ok())
                    .collect(),
                reread_stored: Vec::new(),
                reread_asked: Vec::new(),
                asked_readmit: Vec::new(),
                failed: BTreeMap::new(),
                replaced: BTreeMap::new(),
                findings_said: 0,
                files: Vec::new(),
            })),
            vault,
            hub,
            events,
            me,
            room: room_id,
            process: crate::util::random()?,
            stopped: AtomicBool::new(false),
            stop_signal: tokio::sync::watch::channel(false).0,
            removed: AtomicBool::new(false),
            guarded: AtomicBool::new(false),
            verifying: AtomicBool::new(false),
            removal_verified: AtomicBool::new(false),
            online: AtomicBool::new(false),
            wake: tokio::sync::Notify::new(),
            report: std::sync::Mutex::new(json!({})),
            told: std::sync::Mutex::new(String::new()),
        });
        {
            let mut core = client.core.lock().await;
            client.refresh_outbox(&mut core).await?;
        }
        Ok((client, rx))
    }

    /// This device's id, base64url.
    pub fn me(&self) -> String {
        self.me.to_base64url()
    }

    /// This device's id.
    pub fn device_id(&self) -> DeviceId {
        self.me
    }

    /// Hands an event to the owner.
    pub fn emit(&self, event: ClientEvent) {
        let _ = self.events.send(event);
    }

    /// Resolves once this device is a leaf of its main session; returns the session id.
    pub async fn when_session(&self) -> String {
        loop {
            if let Some(session) = self.core.lock().await.session_id() {
                return session;
            }
            sleep(300).await;
        }
    }

    /// Whether the hub was reached when it was last tried.
    pub fn is_online(&self) -> bool {
        self.online.load(Ordering::SeqCst)
    }

    fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::SeqCst) || self.removed.load(Ordering::SeqCst)
    }

    /// Reads which of this device's envelopes still wait in the device's outbox, and its cursor.
    async fn refresh_outbox(&self, core: &mut Core) -> Result<()> {
        let (ids, cursor) = self
            .vault
            .call(|v: &mut Vault| {
                let ids: Vec<u64> = v
                    .device
                    .outbox()
                    .iter()
                    .filter(|entry| entry.kind == OutboxKind::Envelope)
                    .map(|entry| entry.id)
                    .collect();
                (ids, v.device.cursor())
            })
            .await?;
        core.outbox = ids;
        core.cursor = cursor;
        Ok(())
    }

    /// Brings the groups the device holds into the core: which sessions there are, which is the main one, who
    /// sits in them.
    async fn refresh_groups(&self, core: &mut Core) -> Result<()> {
        let me = self.me;
        let rows = self
            .vault
            .call(move |v: &mut Vault| -> Result<Vec<_>> {
                let humans: Vec<DeviceId> = v
                    .device
                    .room_history()
                    .map(|h| h.newest().humans.iter().copied().collect())
                    .unwrap_or_default();
                Ok(v.device
                    .groups()?
                    .into_iter()
                    .filter_map(|summary| {
                        let session = summary.session?;
                        let others: Vec<String> = summary
                            .leaves
                            .iter()
                            .filter(|leaf| !humans.contains(leaf))
                            .map(DeviceId::to_base64url)
                            .collect();
                        let seat = v.seat(&summary.group).map(|d| d.to_base64url());
                        Some((summary.group, session, others, seat, summary.archived))
                    })
                    .collect())
            })
            .await??;
        let mut groups = BTreeMap::new();
        let mut main = None;
        for (group, session, others, seat, archived) in rows {
            if archived {
                continue;
            }
            let sid = hex(session.session_id.as_bytes());
            let is_main = session.parent.is_zero();
            if is_main && seat.as_deref() == Some(&me.to_base64url()) {
                main = Some(sid.clone());
            }
            let record = core.model.session_of(&sid);
            record.parent = (!is_main).then(|| hex(session.parent.as_bytes()));
            record.agent_device_id = seat;
            record.agent_device_ids = others;
            groups.insert(sid, group);
        }
        let newly = main.is_some() && core.main != main;
        core.groups = groups;
        core.main = main.clone();
        if let (true, Some(session_id)) = (newly, main) {
            self.emit(ClientEvent::Session { session_id });
        }
        Ok(())
    }

    /// Goes online and stays: signs in, takes the lease, catches up, then follows the stream in the
    /// background, coming back with a growing pause whenever the hub is away. Returns once the first attempt
    /// is over; a hub that cannot be reached is no error (the outbox waits), a device that is out is.
    pub async fn start(self: &Arc<Self>) -> Result<()> {
        {
            let mut core = self.core.lock().await;
            self.refresh_groups(&mut core).await?;
            core.commit()?;
        }
        // Commands that were let through before this process started and never noted as handed over.
        let left: Vec<Command> = {
            let core = self.core.lock().await;
            core.journal
                .scan(&side_key(TAG_COMMAND, &[])[..2])
                .iter()
                .filter_map(|(_, value)| serde_json::from_slice::<Command>(value).ok())
                .collect()
        };
        for mut command in left {
            command.uncertain = true;
            self.emit(ClientEvent::Command(Box::new(command)));
        }
        let first = self.go_online().await;
        if let Err(fault) = &first {
            if crate::hub::is_no_hub(fault) {
                // What answers is no hub of this protocol: said so, and not asked again by this client.
                return Err(Fault::new(
                    "hub-unusable",
                    format!("the hub does not answer as a Trommi hub of this version ({}). Update the trommi plugin, then /mcp → trommi → Reconnect", fault.code),
                ));
            }
            if !is_transient(fault) {
                self.fatal(fault).await;
                return first;
            }
        }
        let me = self.clone();
        tokio::spawn(async move { me.run().await });
        let me = self.clone();
        tokio::spawn(async move { me.keep_lease().await });
        Ok(())
    }

    /// Stops the background work. What waits in the outbox stays stored.
    pub async fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        let _ = self.stop_signal.send(true);
        self.wake.notify_waiters();
    }

    /// A fault that ends this client's work: the owner is told what it is.
    async fn fatal(&self, fault: &Fault) {
        match fault.code.as_str() {
            "not-member" | "removed-sender" | "no-room" => {
                // The hub's word alone proves nothing. If it still serves the Commit that removed this
                // device, the device verifies its removal itself; only then is its state wiped (13.5).
                if let Ok(items) = self.removal_items().await {
                    let _ = self.verify_removal(&items).await;
                }
                self.set_removed(false).await
            }
            _ => {
                // Said once per kind of fault, not once per try.
                let mut told = self.told.lock().unwrap_or_else(|e| e.into_inner());
                if *told != fault.code {
                    *told = fault.code.clone();
                    self.emit(ClientEvent::Error(fault.clone()));
                }
            }
        }
    }

    /// The hub refuses this device as no member: unverified, the state stays.
    async fn set_removed(&self, replaced: bool) {
        let mut core = self.core.lock().await;
        self.set_removed_in(&mut core, replaced, false);
    }

    /// Notes that this device is out, for a caller that holds the core.
    fn set_removed_in(&self, core: &mut Core, replaced: bool, verified: bool) {
        // A removal that was only claimed and is verified afterwards is told again, as verified; so is one
        // that turns out to be a takeover.
        let newly_verified = verified && !self.removal_verified.swap(true, Ordering::SeqCst);
        let newly_replaced = replaced && !core.model.room.replaced;
        core.model.room.replaced |= replaced;
        if self.removed.swap(true, Ordering::SeqCst) && !newly_verified && !newly_replaced {
            return;
        }
        let _ = self.stop_signal.send(true);
        core.model.room.connection = "removed".into();
        if !self.verifying.load(Ordering::SeqCst) {
            self.emit(ClientEvent::Removed {
                replaced: core.model.room.replaced,
                verified: self.removal_verified.load(Ordering::SeqCst),
            });
        }
    }

    /// What the hub still serves a device it no longer takes: per group (the room group, and every session
    /// group this device was a leaf of) the Commits up to and including the one that removed it. Merged into
    /// the hub's one order by change number.
    async fn removal_items(&self) -> Result<Vec<Value>> {
        let mut groups = vec![GroupId::room(self.room)];
        groups.extend(self.core.lock().await.groups.values().copied());
        let mut items: Vec<Value> = Vec::new();
        for group in groups {
            let mut after = 0u64;
            // (at most 200 per answer; a group's log up to one Commit is not longer than this)
            for _ in 0..500 {
                let page = match self
                    .hub
                    .get(&format!(
                        "/v2/groups/{}/{REMOVAL_ROUTE}?after={after}",
                        b64(group.as_bytes())
                    ))
                    .await
                {
                    Ok(page) => page,
                    // This device was not removed from that group, or the hub knows no such route.
                    Err(fault) if fault.code == "not-found" || fault.code == "not-member" => break,
                    Err(fault) => return Err(fault),
                };
                let served = page
                    .get("items")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let last = served
                    .iter()
                    .filter_map(|item| item.get("n").and_then(Value::as_u64))
                    .max();
                items.extend(served);
                match last {
                    Some(n) if n > after && page.get("more") == Some(&Value::Bool(true)) => {
                        after = n
                    }
                    _ => break,
                }
            }
        }
        Ok(items)
    }

    /// Hands the device Commits the hub served after it stopped taking this device, in the hub's order. The
    /// device verifies each as any other (signature, rules, its place); nothing is taken on the hub's word.
    /// Returns whether one of them removed this device: from `agents`, or from its main session by a
    /// takeover. Then the owner is told `Removed { verified: true }` and wipes the slot.
    pub async fn verify_removal(&self, items: &[Value]) -> Result<bool> {
        let mut commits: Vec<(u64, &Value)> = items
            .iter()
            .filter(|item| item.get("kind").and_then(Value::as_str) == Some("commit"))
            .filter_map(|item| Some((item.get("change").and_then(Value::as_u64)?, item)))
            .collect();
        commits.sort_by_key(|(change, _)| *change);
        let mut core = self.core.lock().await;
        let before = (
            self.removal_verified.load(Ordering::SeqCst),
            core.model.room.replaced,
        );
        self.verifying.store(true, Ordering::SeqCst);
        let mut failed = None;
        for (change, item) in commits {
            if change <= core.cursor {
                continue;
            }
            match self.take_log(&mut core, item, change, true).await {
                Ok(_) => {
                    if let Err(fault) = core.commit() {
                        failed = Some(fault);
                        break;
                    }
                }
                Err(fault) => {
                    if core.journal.is_dirty() {
                        core.journal.poison();
                    }
                    failed = Some(fault);
                    break;
                }
            }
        }
        self.verifying.store(false, Ordering::SeqCst);
        let verified = self.removal_verified.load(Ordering::SeqCst);
        if (verified, core.model.room.replaced) != before {
            // Told once, with everything the Commits said: taken out of the room, or its session taken over.
            self.emit(ClientEvent::Removed {
                replaced: core.model.room.replaced,
                verified,
            });
        }
        match failed {
            Some(fault) if !verified => Err(fault),
            _ => Ok(verified),
        }
    }

    /// Whether this device is out, and how: `(replaced, verified)`.
    pub async fn removal(&self) -> Option<(bool, bool)> {
        let core = self.core.lock().await;
        self.removed.load(Ordering::SeqCst).then(|| {
            (
                core.model.room.replaced,
                self.removal_verified.load(Ordering::SeqCst),
            )
        })
    }

    /// Whether this client may still sign, post and hand out: not stopped (its lease was lost, or its owner
    /// stopped it), not out of the room, not halted.
    pub(crate) fn active(&self, core: &Core) -> Result<()> {
        if self.removed.load(Ordering::SeqCst) {
            return Err(Fault::new("removed", "this device is out of the room"));
        }
        if self.stopped.load(Ordering::SeqCst) {
            return Err(Fault::new(
                "stopped",
                "this connector stopped working on its room",
            ));
        }
        Self::halted(core)
    }

    /// The fault that says why nothing is processed or sent any more, if so.
    fn halted(core: &Core) -> Result<()> {
        match core.halted.as_deref() {
            None => Ok(()),
            Some(code) => Err(Fault::new(
                code,
                "this connector stopped working on its room; the human reconnects this session in the Trommi app",
            )),
        }
    }

    /// Stops for good: the state on disk is not one this device may go on from.
    fn halt(&self, core: &mut Core, fault: &Fault) -> Result<()> {
        core.halted = Some(fault.code.clone());
        core.model.room.outbox_blocked = Some(fault.code.clone());
        core.halt_record();
        core.commit()?;
        self.emit(ClientEvent::Error(fault.clone()));
        Ok(())
    }

    /// The rollback guard: the hub's copy of this device's own chains must not be ahead of what this state
    /// has signed. If it is, the state is older than what the device already sent (a restored copy of the
    /// directory, a write the disk lost), and signing on would put a second envelope under a used number.
    async fn guard_rollback(&self, core: &mut Core) -> Result<()> {
        let groups: Vec<GroupId> = core.groups.values().copied().collect();
        for group in groups {
            let own = core.own_seq(&group);
            let ahead = self
                .hub
                .get(&format!(
                    "/v2/groups/{}/chains/{}?after={own}&limit=1",
                    b64(group.as_bytes()),
                    self.me.to_base64url(),
                ))
                .await;
            let me = self.me;
            let ahead = match ahead {
                // Only an envelope this device signed itself, in this group, under a number beyond its own
                // chain, is evidence: the hub's word alone halts nothing.
                Ok(page) => page
                    .get("items")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|item| unb64(item, "envelope").ok())
                    .filter_map(|bytes| Envelope::decode(&bytes).ok())
                    .any(|envelope| Self::is_ahead(&envelope, &me, &group, own)),
                Err(fault) if fault.code == "not-found" => false,
                Err(fault) => return Err(fault),
            };
            if ahead {
                return Err(self.rolled_back(core)?);
            }
        }
        self.guarded.store(true, Ordering::SeqCst);
        Ok(())
    }

    /// Whether `envelope` is one this device signed in `group` under a number beyond `own`.
    fn is_ahead(envelope: &Envelope, me: &DeviceId, group: &GroupId, own: u64) -> bool {
        envelope.header.sender == *me
            && envelope.header.group == *group
            && envelope.header.seq > own
            && envelope.verify().is_ok()
    }

    fn rolled_back(&self, core: &mut Core) -> Result<Fault> {
        let fault = Fault::new(
            "state-rolled-back",
            "this connector's stored state is older than what it already sent; nothing is signed with it",
        );
        self.halt(core, &fault)?;
        Ok(fault)
    }

    /// One round of being online: lease, room group, the hub's order, Welcomes, KeyPackages, the outbox.
    async fn go_online(&self) -> Result<()> {
        let report = self
            .report
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        self.hub.link(&self.process, &report).await?;
        let mut core = self.core.lock().await;
        self.active(&core)?;
        core.reread_asked.clear();
        self.observe_room(&mut core).await?;
        self.guard_rollback(&mut core).await?;
        self.catch_up(&mut core).await?;
        self.take_welcomes(&mut core, None).await?;
        // A group whose past could not be learned when it was joined (the hub was away) is tried again.
        let unlearned: Vec<GroupId> = self
            .vault
            .call(|v: &mut Vault| -> Result<Vec<GroupId>> {
                Ok(v.device
                    .groups()?
                    .into_iter()
                    .filter(|summary| !summary.past_learned && !summary.archived)
                    .map(|summary| summary.group)
                    .collect())
            })
            .await??;
        for group in unlearned {
            if self.learn_past(&mut core, group).await.is_ok() {
                core.reread.push(group);
            }
        }
        self.catch_up(&mut core).await?;
        self.publish_key_packages(&mut core).await?;
        self.write_heads(&mut core).await?;
        self.pump(&mut core).await?;
        self.catch_up(&mut core).await?;
        core.model.room.connection = "connected".into();
        self.online.store(true, Ordering::SeqCst);
        Ok(())
    }

    /// Starts following the room group (4.4, 12.1.6) at the GroupInfo of the epoch the Offer named; the
    /// device holds it against the state the Offer named.
    async fn observe_room(&self, core: &mut Core) -> Result<()> {
        let observing = self
            .vault
            .call(|v: &mut Vault| v.device.room_history().is_some())
            .await?;
        if observing {
            return Ok(());
        }
        let room_group = GroupId::room(self.room);
        let info = self
            .hub
            .get(&format!(
                "/v2/groups/{}/info?epoch={}",
                b64(room_group.as_bytes()),
                core.room.room_epoch
            ))
            .await?;
        let group_info = unb64(&info, "group_info")?;
        self.vault
            .call(move |v: &mut Vault| v.device.join_observe(&group_info))
            .await??;
        core.commit()
    }

    /// Keeps the lease: the same process renews it every 20 s; when another process took it, this one stops.
    async fn keep_lease(self: Arc<Self>) {
        let mut stop = self.stop_signal.subscribe();
        loop {
            tokio::select! {
                _ = tokio::time::sleep(LEASE_EVERY) => {}
                _ = stop.changed() => {}
            }
            if self.is_stopped() {
                return;
            }
            let report = self
                .report
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone();
            match self.hub.link(&self.process, &report).await {
                Ok(_) => {}
                Err(fault) if fault.code == "lease-lost" => {
                    self.stopped.store(true, Ordering::SeqCst);
                    let _ = self.stop_signal.send(true);
                    self.emit(ClientEvent::Error(fault));
                    return;
                }
                Err(fault) if is_transient(&fault) => {}
                Err(fault) => self.fatal(&fault).await,
            }
            // 9.0.7: the device says when its heads are due.
            let mut core = self.core.lock().await;
            if self.active(&core).is_ok() && self.write_heads(&mut core).await.is_ok() {
                let _ = self.pump(&mut core).await;
            }
        }
    }

    /// Reports with the lease what this process hears and does (13.7): `hears`, `working`, `last_call_at`.
    pub async fn report_link(&self, report: Value) -> Result<()> {
        *self.report.lock().unwrap_or_else(|e| e.into_inner()) = report.clone();
        self.hub.link(&self.process, &report).await.map(|_| ())
    }

    /// The loop: follow the stream; when it ends or fails, wait and go online again.
    async fn run(self: Arc<Self>) {
        let mut pause_ms = 1000u64;
        let mut no_hub = 0u32;
        loop {
            if self.is_stopped() {
                return;
            }
            let began = std::time::Instant::now();
            let round = async {
                if !self.is_online() {
                    self.go_online().await?;
                }
                self.follow().await
            };
            match round.await {
                // The stream ended (a token ran out). Only one that lived a while resets the pause: a hub
                // that ends every stream at once is asked again more and more slowly.
                Ok(()) => {
                    no_hub = 0;
                    self.told.lock().unwrap_or_else(|e| e.into_inner()).clear();
                    if began.elapsed() >= STREAM_LIVED {
                        pause_ms = 1000;
                    }
                }
                Err(fault) if is_transient(&fault) || fault.code == "unauthorised" => no_hub = 0,
                Err(fault) if crate::hub::is_no_hub(&fault) => {
                    no_hub += 1;
                    if no_hub >= NO_HUB_ROUNDS {
                        // What answers is no hub of this protocol. Asking on helps nothing.
                        self.stopped.store(true, Ordering::SeqCst);
                        let _ = self.stop_signal.send(true);
                        self.emit(ClientEvent::Error(Fault::new(
                            "hub-unusable",
                            format!("the hub does not answer as a Trommi hub of this version ({}); the connector stopped asking. Update the trommi plugin, then /mcp → trommi → Reconnect", fault.code),
                        )));
                        return;
                    }
                }
                Err(fault) if fault.code == "lease-lost" => {
                    self.stopped.store(true, Ordering::SeqCst);
                    let _ = self.stop_signal.send(true);
                    self.emit(ClientEvent::Error(fault));
                    return;
                }
                Err(fault) => {
                    self.fatal(&fault).await;
                    if self.is_stopped() {
                        return;
                    }
                }
            }
            self.online.store(false, Ordering::SeqCst);
            {
                let mut core = self.core.lock().await;
                if core.model.room.connection == "connected" {
                    core.model.room.connection = "offline".into();
                }
            }
            let jitter = crate::util::rand_below(pause_ms / 2 + 1);
            let mut stop = self.stop_signal.subscribe();
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(pause_ms + jitter)) => {}
                _ = self.wake.notified() => {}
                _ = stop.changed() => {}
            }
            pause_ms = (pause_ms * 2).min(60_000);
        }
    }

    /// Reads the stream until it ends: each event is processed at its place.
    async fn follow(&self) -> Result<()> {
        let after = self.core.lock().await.cursor;
        let mut stream = self.hub.stream(after).await?;
        let mut stop = self.stop_signal.subscribe();
        loop {
            let event = tokio::select! {
                event = stream.next(STREAM_SILENCE) => event?,
                _ = stop.changed() => return Ok(()),
                _ = self.wake.notified() => {
                    if self.is_stopped() {
                        return Ok(());
                    }
                    let mut core = self.core.lock().await;
                    self.pump(&mut core).await?;
                    self.catch_up(&mut core).await?;
                    continue;
                }
            };
            let Some(event) = event else {
                return Ok(());
            };
            if self.is_stopped() {
                return Ok(());
            }
            let mut core = self.core.lock().await;
            match event.name.as_str() {
                "envelope" | "log" => {
                    let change = event.data.get("change").and_then(Value::as_u64);
                    let commands = self.process_items(&mut core, &[event.data]).await?;
                    self.after_items(&mut core).await?;
                    let blocked = change.is_some_and(|change| change > core.cursor)
                        && core.halted.is_none()
                        && !self.is_stopped();
                    drop(core);
                    self.deliver(commands).await;
                    if blocked {
                        // The item was not passed (it came before one it needs, or does not read). Nothing
                        // after it is taken from this stream: the hub's order is asked for again, later.
                        return Err(Fault::new(
                            "offline",
                            "an item of the stream could not be taken at its place",
                        ));
                    }
                }
                "welcome" => {
                    self.catch_up(&mut core).await?;
                    self.take_welcomes(&mut core, None).await?;
                    self.after_items(&mut core).await?;
                }
                _ => {}
            }
        }
    }

    /// Hands commands to the owner.
    async fn deliver(&self, commands: Vec<Command>) {
        if self.stopped.load(Ordering::SeqCst) {
            return;
        }
        for command in commands {
            self.emit(ClientEvent::Command(Box::new(command)));
        }
    }

    /// Records that a command had its effect (it was handed to the agent): it is never handed out again.
    pub async fn ledger_mark(&self, envelope_hash: &str) -> Result<()> {
        let hash = Hash32::from_base64url(envelope_hash)?;
        let mut core = self.core.lock().await;
        self.vault
            .call(move |v: &mut Vault| v.device.command_finished(&hash))
            .await??;
        core.journal
            .delete(side_key(TAG_COMMAND, &[envelope_hash.as_bytes()]));
        core.commit()
    }

    /// Fetches everything above the cursor and processes it, until the hub has no more.
    pub(crate) async fn catch_up(&self, core: &mut Core) -> Result<()> {
        Self::halted(core)?;
        loop {
            let answer = self
                .hub
                .get(&format!(
                    "/v2/changes?after={}&limit={CHANGES_LIMIT}",
                    core.cursor
                ))
                .await;
            let answer = match answer {
                Err(fault) if fault.code == "gone" => {
                    // 13.4: the hub no longer has the next entry. This installation is a new device.
                    let fault = Fault::new(
                        "state-too-old",
                        "the hub no longer keeps what this connector missed; the human reconnects this session in the Trommi app",
                    );
                    self.halt(core, &fault)?;
                    return Err(fault);
                }
                other => other?,
            };
            let items = answer
                .get("items")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let before = core.cursor;
            let commands = self.process_items(core, &items).await?;
            self.deliver(commands).await;
            // A page that says there is more and moves nothing is not followed again and again.
            if answer.get("more") != Some(&Value::Bool(true)) || core.cursor == before {
                break;
            }
        }
        self.after_items(core).await
    }

    /// What follows a batch of items: groups to read again, and the device's findings, which are never
    /// swallowed.
    async fn after_items(&self, core: &mut Core) -> Result<()> {
        let mut again: Vec<GroupId> = core.reread.clone();
        again.dedup();
        for group in again {
            let held = core
                .session_of_group(&group)
                .is_some_and(|sid| core.groups.contains_key(&sid));
            if !held {
                core.reread.retain(|waits| *waits != group);
                continue;
            }
            self.reread(core, group).await?;
        }
        let said = core.findings_said;
        let findings: Vec<&'static str> = self
            .vault
            .call(move |v: &mut Vault| -> Result<Vec<&'static str>> {
                Ok(v.device
                    .findings()?
                    .iter()
                    .skip(said)
                    .map(|finding| finding.code.code())
                    .collect())
            })
            .await??;
        core.findings_said += findings.len();
        for code in findings {
            eprintln!("[trommi] finding: {code}");
            if matches!(code, "equivocation" | "bad-group" | "withheld") {
                self.emit(ClientEvent::Error(Fault::new(
                    code,
                    "the device found something wrong in a session; the Trommi app shows it",
                )));
            }
        }
        Ok(())
    }

    /// Joins the groups Welcomes wait for (12.1.6, 5.2.6): `only` that group's, or every one's. A Welcome
    /// belongs at the place of the Commit that made it; after joining, the group's Commits are handed to
    /// the device again from the hub's log, which gives the join its place and catches up what it passed.
    pub(crate) fn take_welcomes<'a>(
        &'a self,
        core: &'a mut Core,
        only: Option<GroupId>,
    ) -> BoxFut<'a, Result<()>> {
        Box::pin(self.take_welcomes_now(core, only))
    }

    /// Every Welcome the hub holds for this device, oldest first. An answer holds at most 8 MiB of Welcomes
    /// (hub-api.md point 22): the device asks again after the last one's `id` until the answer brings nothing
    /// new. A hub that does not page answers the whole list to every form, and the second ask ends it.
    async fn welcome_rows(&self) -> Result<Vec<Value>> {
        let mut rows: Vec<Value> = Vec::new();
        let mut after: Option<u64> = None;
        loop {
            let path = match after {
                Some(id) => format!("/v2/welcomes?after={id}"),
                None => "/v2/welcomes".to_string(),
            };
            let page = self.hub.get(&path).await?;
            let mut last = after;
            for row in page.as_array().cloned().unwrap_or_default() {
                let Some(id) = row.get("id").and_then(Value::as_u64) else {
                    continue;
                };
                if after.is_some_and(|seen| id <= seen) {
                    continue;
                }
                last = Some(last.map_or(id, |l| l.max(id)));
                rows.push(row);
            }
            if last == after {
                return Ok(rows);
            }
            after = last;
        }
    }

    async fn take_welcomes_now(&self, core: &mut Core, only: Option<GroupId>) -> Result<()> {
        let rows = self.welcome_rows().await?;
        let room = self.room;
        let mut joined_any = false;
        for row in rows {
            let (Ok(group), Ok(welcome)) = (group_of_item(&row), unb64(&row, "welcome")) else {
                continue;
            };
            // An agent device is never a leaf of the room group (5.1).
            if group.is_room() || only.is_some_and(|wanted| wanted != group) {
                continue;
            }
            let invited = core.room.invited_session.clone();
            let has_main = core.main.is_some();
            let now = now_ms();
            let outcome = self
                .vault
                .call(move |v: &mut Vault| -> Result<Option<Vec<DeviceId>>> {
                    if v.device.group(&group).is_ok() {
                        return Ok(None);
                    }
                    let expected = WelcomeExpectation {
                        room,
                        committer: None,
                    };
                    let joined = v.device.join_welcome(&welcome, &expected, now)?;
                    // The hub named the group; the Welcome says which it is. And a first main session is
                    // the one the invite was for, if it was for one (12.1.6).
                    let session = v.device.group(&joined.group)?.session;
                    let other_session = session.is_some_and(|s| {
                        s.parent.is_zero()
                            && !has_main
                            && !invited.is_empty()
                            && hex(s.session_id.as_bytes()) != invited
                    });
                    if joined.group != group || joined.group.is_room() || other_session {
                        return Err(Fault::new(
                            "bad-welcome",
                            "a Welcome was for another group than the hub said",
                        ));
                    }
                    Ok(Some(joined.offending))
                })
                .await?;
            match outcome {
                Ok(None) => {}
                Ok(Some(offending)) => {
                    joined_any = true;
                    core.commit()?;
                    if !offending.is_empty() {
                        eprintln!("[trommi] finding: a session this device was added to has {} leaf(s) the room does not allow: its content is not opened until a human device removes them", offending.len());
                    }
                    // The group's Commits again, from the log: the one that added this device gives the
                    // join its place, later ones are caught up.
                    if let Ok(commits) = self.commits_of(&group).await {
                        // Only what lies at or below the cursor: what comes after it comes in the hub's
                        // one order, with everything between.
                        let upto = core.cursor;
                        for (bytes, auth, change) in commits {
                            if change > upto {
                                break;
                            }
                            let now = now_ms();
                            let _ = self
                                .vault
                                .call(move |v: &mut Vault| {
                                    v.device.process_log_entry(
                                        &LogEntry {
                                            change,
                                            group,
                                            kind: LogKind::Commit {
                                                bytes: &bytes,
                                                recovery_auth: auth.as_deref(),
                                            },
                                        },
                                        now,
                                    )
                                })
                                .await?;
                            core.commit()?;
                        }
                    }
                    if let Err(fault) = self.learn_past(core, group).await {
                        // The epochs before this device joined stay unknown: what was written in them is
                        // not taken. Named, never swallowed.
                        eprintln!(
                            "[trommi] finding: {} (a session's past was not learned)",
                            fault.code
                        );
                    }
                    core.reread.push(group);
                }
                Err(fault) if fault.code == "bad-welcome" => {
                    // The device joined something it must not hold. Nothing of it is written: this process
                    // gives its state up as it is in memory and starts again from the files.
                    core.journal.poison();
                    self.emit(ClientEvent::Error(fault.clone()));
                    return Err(fault);
                }
                Err(fault) if fault.code == "room-behind" => {
                    // The room group's log is to be processed further first; the Welcome is taken again.
                    core.commit()?;
                }
                Err(fault) => {
                    // 3.7: a Welcome that does not open used up its KeyPackage: ask to be added again.
                    eprintln!("[trommi] a Welcome was refused: {}", fault.code);
                    core.commit()?;
                    if !core.asked_readmit.contains(&group) && fault.code != "replay" {
                        core.asked_readmit.push(group);
                        let body = json!({ "kind": "readmit", "group": b64(group.as_bytes()) });
                        let _ = self.hub.post("/v2/requests", &body).await;
                    }
                }
            }
        }
        if joined_any {
            self.refresh_groups(core).await?;
            self.refresh_outbox(core).await?;
            core.commit()?;
        }
        Ok(())
    }

    /// Every Commit of a group's log, in order, with the `RecoveryAuth` beside a join from outside and its
    /// change number.
    async fn commits_of(&self, group: &GroupId) -> Result<Vec<(Vec<u8>, Option<Vec<u8>>, u64)>> {
        let mut out = Vec::new();
        let mut after = 0u64;
        let mut weight = 0usize;
        loop {
            let asked_after = after;
            let page = self
                .hub
                .get(&format!(
                    "/v2/groups/{}/log?after={after}&limit=1000&kind=commit",
                    b64(group.as_bytes())
                ))
                .await?;
            let items = page
                .get("items")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            for item in &items {
                if item.get("kind").and_then(Value::as_str) != Some("commit") {
                    continue;
                }
                let auth = item
                    .get("recovery_auth")
                    .filter(|v| !v.is_null())
                    .map(|_| unb64(item, "recovery_auth"))
                    .transpose()?;
                let change = item.get("change").and_then(Value::as_u64).unwrap_or(0);
                let bytes = unb64(item, "bytes")?;
                weight += bytes.len();
                out.push((bytes, auth, change));
                after = after.max(item.get("n").and_then(Value::as_u64).unwrap_or(after));
            }
            // A log that says there is more and does not move on, or that is longer than any group's, ends.
            if page.get("more") != Some(&Value::Bool(true))
                || after == asked_after
                || weight > MAX_REREAD_LEN
            {
                return Ok(out);
            }
        }
    }

    /// Learns the past of a group this device joined later (4.6), from what the hub keeps and the device
    /// verifies: the room group's first, then a helper session's main session, then the group's own.
    async fn learn_past(&self, core: &mut Core, group: GroupId) -> Result<()> {
        let parent = self
            .vault
            .call(move |v: &mut Vault| {
                v.device
                    .group(&group)
                    .ok()
                    .and_then(|summary| summary.session)
                    .filter(|session| !session.parent.is_zero())
                    .map(|session| GroupId::session(session.room_id, session.parent))
            })
            .await?;
        let mut order = vec![GroupId::room(self.room)];
        order.extend(parent);
        order.push(group);
        for of in order {
            let learned = self
                .vault
                .call(move |v: &mut Vault| -> Result<bool> {
                    Ok(match v.device.group(&of) {
                        Ok(summary) => summary.past_learned,
                        Err(_) => v.device.group_past(&of)?.is_none_or(|past| past.learned),
                    })
                })
                .await??;
            if learned {
                continue;
            }
            let founding = self
                .hub
                .get(&format!("/v2/groups/{}/info?epoch=0", b64(of.as_bytes())))
                .await?;
            let founding = unb64(&founding, "group_info")?;
            let commits = self.commits_of(&of).await?;
            self.vault
                .call(move |v: &mut Vault| {
                    let served: Vec<ServedCommit<'_>> = commits
                        .iter()
                        .map(|(bytes, auth, change)| ServedCommit {
                            change: *change,
                            commit: bytes,
                            recovery_auth: auth.as_deref(),
                        })
                        .collect();
                    v.device.learn_history(&of, &founding, &served)
                })
                .await??;
            core.commit()?;
        }
        Ok(())
    }

    /// Tops the KeyPackages at the hub up (section 3: one last-resort always, a hundred single-use ones).
    async fn publish_key_packages(&self, core: &mut Core) -> Result<()> {
        // An upload of none is answered with how many single-use ones the hub still holds.
        let held = self
            .hub
            .put("/v2/key-packages", &json!({ "single_use": [] }))
            .await?;
        let unused = held.get("unused").and_then(Value::as_u64).unwrap_or(0) as usize;
        let now = now_ms();
        self.vault
            .call(move |v: &mut Vault| v.device.key_packages_to_upload(unused, now))
            .await??;
        core.commit()
    }

    /// Hands items of the hub's order to the device, one after another, one record each. Returns the commands
    /// the gate let through; they are handed out after the write.
    pub(crate) async fn process_items(
        &self,
        core: &mut Core,
        items: &[Value],
    ) -> Result<Vec<Command>> {
        let mut commands = Vec::new();
        if core.halted.is_some() {
            return Ok(commands);
        }
        for item in items {
            let Some(change) = item.get("change").and_then(Value::as_u64) else {
                continue;
            };
            if change <= core.cursor {
                continue;
            }
            let kind = item.get("kind").and_then(Value::as_str).unwrap_or("");
            let step = if kind == "envelope" {
                self.take_envelope(core, item, change, &mut commands).await
            } else {
                self.take_log(core, item, change, kind == "commit").await
            };
            match step {
                Ok(true) => core.commit()?,
                Ok(false) => {
                    core.commit()?;
                    break;
                }
                Err(fault) => {
                    // What was processed before is written, and its commands are handed out all the same.
                    // If the failing entry left changes behind, they belong to no whole step: nothing of
                    // them is written, and this process starts again from the files.
                    if core.journal.is_dirty() {
                        core.journal.poison();
                    }
                    self.deliver(std::mem::take(&mut commands)).await;
                    return Err(fault);
                }
            }
            if self.removed.load(Ordering::SeqCst) {
                break;
            }
        }
        Ok(commands)
    }

    /// One Commit or MLS message of the log. `Ok(false)`: it came too early and is tried again.
    async fn take_log(
        &self,
        core: &mut Core,
        item: &Value,
        change: u64,
        commit: bool,
    ) -> Result<bool> {
        let group = group_of_item(item)?;
        let bytes = unb64(item, "bytes")?;
        let recovery_auth = item
            .get("recovery_auth")
            .filter(|v| !v.is_null())
            .map(|_| unb64(item, "recovery_auth"))
            .transpose()?;
        let me = self.me;
        let was_enrolled = core.room.enrolled;
        let now = now_ms();
        let (outcome, cursor) = self
            .vault
            .call(move |v: &mut Vault| -> Result<(LogOutcome, u64)> {
                let kind = if commit {
                    LogKind::Commit {
                        bytes: &bytes,
                        recovery_auth: recovery_auth.as_deref(),
                    }
                } else {
                    LogKind::Message { bytes: &bytes }
                };
                let entry = LogEntry {
                    change,
                    group,
                    kind,
                };
                let outcome = match v.device.process_log_entry(&entry, now) {
                    Ok(Processed::Commit { removed: true, .. }) => LogOutcome::RemovedFrom(group),
                    // A Commit that removes a leaf cuts its chain (9.0.10): what was derived from the group's
                    // envelopes is built again. An own Commit may remove one too.
                    Ok(Processed::Commit { facts, .. }) => {
                        LogOutcome::Epoch(!facts.removes.is_empty())
                    }
                    Ok(Processed::OwnCommit) => LogOutcome::Epoch(true),
                    Ok(Processed::Observed(_)) if group.is_room() => {
                        let enrolled = v
                            .device
                            .room_history()
                            .is_some_and(|h| h.newest().is_agent(&me));
                        match (was_enrolled, enrolled) {
                            (false, true) => LogOutcome::Enrolled,
                            (true, false) => LogOutcome::Unenrolled,
                            _ => LogOutcome::Nothing,
                        }
                    }
                    Ok(Processed::Message(Received::Keys { taken, .. })) if taken > 0 => {
                        LogOutcome::Keys(group)
                    }
                    Ok(Processed::Message(Received::NewerVersion { .. })) => LogOutcome::Newer,
                    Ok(Processed::Skipped)
                        if commit && !group.is_room() && v.device.group(&group).is_err() =>
                    {
                        LogOutcome::Unheld
                    }
                    Ok(_) => LogOutcome::Nothing,
                    // 12.1.6: only the inviter's Commit enrols this device.
                    Err(trommi_core::Error::BadInvite) => LogOutcome::BadInvite,
                    Err(error) => match log_finding(&error) {
                        LogFinding::Duplicate => LogOutcome::Nothing,
                        LogFinding::Early => LogOutcome::Early,
                        LogFinding::BadGroup => LogOutcome::Bad(error.code()),
                        LogFinding::Local => return Err(error.into()),
                    },
                };
                Ok((outcome, v.device.cursor()))
            })
            .await??;
        core.cursor = cursor;
        match outcome {
            LogOutcome::Nothing => {}
            LogOutcome::Early => return Ok(false),
            LogOutcome::Epoch(removes) => {
                if removes && !group.is_room() {
                    core.reread.push(group);
                }
                self.refresh_groups(core).await?;
                self.refresh_outbox(core).await?;
            }
            LogOutcome::Unheld => {
                core.commit()?;
                self.take_welcomes(core, Some(group)).await?;
                self.refresh_outbox(core).await?;
            }
            LogOutcome::Keys(group) => core.reread.push(group),
            LogOutcome::Newer => {
                self.emit(ClientEvent::Error(Fault::new(
                    "newer-version",
                    "a message of a newer Trommi arrived",
                )));
            }
            LogOutcome::Enrolled => {
                core.room.enrolled = true;
                put_room_record(&core.journal, &core.room);
            }
            LogOutcome::BadInvite => {
                let fault = Fault::new(
                    "bad-invite",
                    "this device was enrolled by another device than the one that invited it",
                );
                self.halt(core, &fault)?;
                return Err(fault);
            }
            LogOutcome::Unenrolled => {
                core.commit()?;
                self.set_removed_in(core, false, true);
            }
            LogOutcome::RemovedFrom(group) => {
                let was_main = core.session_of_group(&group) == core.main;
                core.commit()?;
                if was_main {
                    // 13.5: another connector continues the session. This one stops.
                    self.set_removed_in(core, true, true);
                } else {
                    self.refresh_groups(core).await?;
                }
            }
            LogOutcome::Bad(code) => {
                // 13.4, 14.7: the state stays as it was; the entry is reported and nothing more is processed.
                let n = item.get("n").and_then(Value::as_u64).unwrap_or(0);
                let _ = self
                    .hub
                    .post(
                        &format!("/v2/groups/{}/reject", b64(group.as_bytes())),
                        &json!({ "n": n }),
                    )
                    .await;
                let fault = Fault::new(
                    "bad-group",
                    format!("the hub handed out a group change this device cannot take ({code}); the human looks at the room in the Trommi app and reconnects this session"),
                );
                self.halt(core, &fault)?;
                return Err(fault);
            }
        }
        Ok(true)
    }

    /// Hands one envelope to the device, and asks the gate about it if it may be a command.
    async fn hand(
        &self,
        bytes: Vec<u8>,
        change: u64,
        ordered: bool,
        void_code: Option<trommi_core::Error>,
        ask_gate: bool,
    ) -> Result<Took> {
        let now = now_ms();
        self.vault
            .call(move |v: &mut Vault| -> Result<Took> {
                let received =
                    v.device
                        .receive_envelope(&bytes, change, ordered, void_code.as_ref(), now)?;
                let decision = if ask_gate && received.command {
                    Some(v.device.command(&received.envelope_hash, now)?)
                } else {
                    None
                };
                Ok(Took {
                    received,
                    decision,
                    cursor: v.device.cursor(),
                })
            })
            .await?
    }

    /// One envelope at its place. `Ok(false)`: its group's log is to be processed further first.
    async fn take_envelope(
        &self,
        core: &mut Core,
        item: &Value,
        change: u64,
        commands: &mut Vec<Command>,
    ) -> Result<bool> {
        let bytes = unb64(item, "envelope")?;
        let void_code = item.get("void_code").and_then(Value::as_str).map(|code| {
            trommi_core::Error::from_code(code).unwrap_or(trommi_core::Error::BadFormat)
        });
        // The header says which group; nothing of it is trusted before the device's checks.
        let Ok(envelope) = Envelope::decode(&bytes) else {
            // 13.4: what the hub hands out here is no envelope. The cursor stays: nothing is passed over
            // that could not be read.
            eprintln!("[trommi] finding: bad-format (the item at change {change} is no envelope); waiting for the hub to serve it right");
            return Ok(false);
        };
        let group = envelope.header.group;
        if Self::is_ahead(&envelope, &self.me, &group, core.own_seq(&group)) {
            return Err(self.rolled_back(core)?);
        }
        let took = self.hand(bytes, change, true, void_code, true).await?;
        core.cursor = took.cursor;
        let received = &took.received;
        if received.outcome == EnvelopeOutcome::Refused {
            let code = received.code.as_ref().map_or("refused", |code| code.code());
            if took.cursor < change {
                // `group-behind` for a group this device holds: the log first.
                return Ok(false);
            }
            if !matches!(code, "group-behind" | "replay" | "not-found") {
                // Checks 1 to 6: the envelope takes no place. Never swallowed: named, with its place.
                eprintln!(
                    "[trommi] finding: {code} (an envelope at change {change} was not taken)"
                );
                if code == "gap" {
                    core.ask_reread(group);
                }
            }
            return Ok(true);
        }
        if received.replayed {
            core.ask_reread(group);
        }
        if let Some(session) = core
            .session_of_group(&group)
            .filter(|sid| core.groups.contains_key(sid))
        {
            self.apply(core, &took, &session, commands);
        }
        Ok(true)
    }

    /// Puts what a taken envelope means into the model, and what the gate let through into `commands`.
    fn apply(&self, core: &mut Core, took: &Took, session: &str, commands: &mut Vec<Command>) {
        let received = &took.received;
        let header = &received.header;
        let mine = header.sender == self.me;
        let human = core
            .model
            .sessions
            .get(session)
            .is_some_and(|s| !s.agent_device_ids.contains(&header.sender.to_base64url()));
        if let Some(finding) = &received.finding {
            eprintln!("[trommi] finding: {}", finding.code());
        }
        match received.outcome {
            EnvelopeOutcome::Applied | EnvelopeOutcome::Provisional => {}
            EnvelopeOutcome::Chained => {
                let code = received.code.as_ref().map_or("", |code| code.code());
                if code == "newer-version" && !mine {
                    // 9.0.4: no command, whoever sent it: a notice that a newer connector is needed.
                    self.emit(ClientEvent::Error(Fault::new(
                        "newer-version",
                        "an item of a newer Trommi arrived that this connector cannot read",
                    )));
                }
                if mine {
                    eprintln!("[trommi] an envelope of this device was not applied: {code}");
                }
                // One whose body alone failed still counts for its object's state (9.2.1).
                if received.object_after.is_none() {
                    return;
                }
            }
            EnvelopeOutcome::Void => {
                if mine {
                    let code = received.code.as_ref().map_or("", |code| code.code());
                    eprintln!("[trommi] an envelope of this device was voided: {code}");
                }
                return;
            }
            EnvelopeOutcome::Refused => return,
        }
        let (payload, raw) = match &received.body {
            Some(body) => {
                let raw = String::from_utf8_lossy(body.payload()).into_owned();
                let payload = serde_json::from_str::<Value>(&raw)
                    .ok()
                    .and_then(|v| v.as_object().cloned());
                (payload, raw)
            }
            None => (None, String::new()),
        };
        // The card as it stood before this envelope: what an answer's effect is told from.
        let before = match &header.subject {
            Subject::Answer(f) | Subject::TakeBack(f) => {
                core.model.cards.get(&hex(f.object_id.as_bytes())).cloned()
            }
            _ => None,
        };
        core.model.apply(&Seen {
            change: received.change,
            session,
            header,
            hash: received.envelope_hash,
            payload: payload.as_ref(),
            raw: &raw,
            bind: received.body.as_ref().map(|body| body.bind()),
            human,
        });
        if let (Some(register), Some(payload)) = (&received.register, &payload) {
            if register.current && register.of.is_none() {
                let value = payload
                    .get("value")
                    .filter(|value| !value.is_null())
                    .map(Value::to_string);
                core.model.apply_register(
                    session,
                    &register.name,
                    value.as_deref(),
                    received.change,
                    header.time,
                );
            }
        }
        let Some(decision) = &took.decision else {
            return;
        };
        let mut command = Command {
            session_id: Some(session.to_string()),
            envelope_number: received.change,
            envelope_hash: received.envelope_hash.to_base64url(),
            sender_device_id: header.sender.to_base64url(),
            sender_sequence: header.seq,
            sent_at: header.time,
            content: payload.unwrap_or_default(),
            ..Default::default()
        };
        if let Some(fields) = header.subject.object() {
            command.object_id = Some(hex(fields.object_id.as_bytes()));
        }
        match decision {
            Decision::Done => return,
            Decision::Refused(refusal) => {
                // Not acted on (9.0.9). Said without content: which rule held it back.
                if !matches!(
                    refusal,
                    trommi_core::objects::Refusal::NotAddressed
                        | trommi_core::objects::Refusal::NotACommand
                ) {
                    eprintln!("[trommi] a human's envelope was not acted on: {refusal:?}");
                }
                return;
            }
            Decision::Uncertain => {
                // Started before a crash and never finished: reported, not repeated.
                command.command = "unsupported".into();
                command.what = Some(
                    "a command whose effect is uncertain after a restart; ask the human what they meant".into(),
                );
                command.envelope_hash = String::new();
            }
            Decision::Act(GateCommand::Chat) => {
                command.command = "message".into();
                match header.subject {
                    Subject::Item(Timeline::CardChat(card)) => {
                        let id = hex(card.as_bytes());
                        command.timeline_key = Some(format!("chat:card/{id}"));
                        command.object_id = Some(id);
                    }
                    _ => command.timeline_key = Some(format!("chat:session/{session}")),
                }
            }
            Decision::Act(GateCommand::Answer { action, choices }) => {
                let card = command
                    .object_id
                    .as_ref()
                    .and_then(|id| core.model.cards.get(id));
                command.settled = *action == AnswerAction::Answer
                    && card.is_some_and(|c| c.object_state == "closed");
                command.command = match action {
                    AnswerAction::Read => "read",
                    AnswerAction::Shred => "shred",
                    AnswerAction::Answer
                        if command
                            .content
                            .get("trusted")
                            .is_some_and(crate::util::truthy) =>
                    {
                        "trust"
                    }
                    AnswerAction::Answer => "answer",
                }
                .into();
                command.choices = choices.clone();
            }
            Decision::Act(GateCommand::Verdict(verdict)) => {
                command.command = "verdict".into();
                command.allow = *verdict == trommi_core::envelope::Verdict::Allow;
            }
            Decision::Act(GateCommand::TakeBack) => {
                command.command = "decide_again".into();
                command.previous_choices = before
                    .as_ref()
                    .and_then(|c| c.answers.last())
                    .map(|a| a.choice_strs())
                    .unwrap_or_default();
            }
        }
        // Stored with the gate's record: a crash between this write and the hand-over is found at the next
        // start, and the command is reported then, marked as uncertain.
        if !command.envelope_hash.is_empty() {
            if let Ok(bytes) = serde_json::to_vec(&command) {
                core.journal.put(
                    side_key(TAG_COMMAND, &[command.envelope_hash.as_bytes()]),
                    bytes,
                );
            }
        }
        commands.push(command);
    }

    /// Reads a group's envelopes again from the hub's first: after joining it (its chains are verified from
    /// number 1, 9.0.6), after a key handover opened what could not be read, and when the device built the
    /// group's state again. The model of the session is built anew; nothing is acted on.
    async fn reread(&self, core: &mut Core, group: GroupId) -> Result<()> {
        let Some(session) = core.session_of_group(&group) else {
            return Ok(());
        };
        if !core.groups.contains_key(&session) {
            return Ok(());
        }
        // The group's Commits at or below the cursor, again: after a Welcome that was taken late (or a crash
        // right after it) they give the join its place; any other time they are duplicates.
        if let Ok(commits) = self.commits_of(&group).await {
            let upto = core.cursor;
            for (bytes, auth, change) in commits {
                if change > upto {
                    break;
                }
                let now = now_ms();
                let _ = self
                    .vault
                    .call(move |v: &mut Vault| {
                        v.device.process_log_entry(
                            &LogEntry {
                                change,
                                group,
                                kind: LogKind::Commit {
                                    bytes: &bytes,
                                    recovery_auth: auth.as_deref(),
                                },
                            },
                            now,
                        )
                    })
                    .await?;
            }
            core.commit()?;
        }
        // Everything is fetched first: nothing is forgotten before what replaces it is in hand. One entry
        // per change number, and no more than a session's history can weigh.
        let upto = core.cursor;
        let mut after = 0u64;
        let mut fetched: BTreeMap<u64, (Vec<u8>, Option<trommi_core::Error>)> = BTreeMap::new();
        let mut weight = 0usize;
        loop {
            let answer = self
                .hub
                .get(&format!("/v2/changes?after={after}&limit={CHANGES_LIMIT}"))
                .await?;
            for item in answer
                .get("items")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
            {
                let Some(change) = item.get("change").and_then(Value::as_u64) else {
                    continue;
                };
                if change > upto
                    || change <= after
                    || item.get("kind").and_then(Value::as_str) != Some("envelope")
                {
                    continue;
                }
                let Ok(bytes) = unb64(&item, "envelope") else {
                    continue;
                };
                if Envelope::decode(&bytes).map(|e| e.header.group).ok() != Some(group) {
                    continue;
                }
                let void_code = item.get("void_code").and_then(Value::as_str).map(|code| {
                    trommi_core::Error::from_code(code).unwrap_or(trommi_core::Error::BadFormat)
                });
                weight += bytes.len();
                if weight > MAX_REREAD_LEN {
                    return Err(Fault::new(
                        "too-large",
                        "the hub serves more of a session's history than a session can hold",
                    ));
                }
                fetched.insert(change, (bytes, void_code));
            }
            let next = answer.get("change").and_then(Value::as_u64).unwrap_or(upto);
            if answer.get("more") != Some(&Value::Bool(true)) || next >= upto || next <= after {
                break;
            }
            after = next;
        }
        // The registers the model shows of this session: read again from the device afterwards, since an
        // envelope that is read back brings no register change.
        let mut names: Vec<String> = ["profile", "goals", "heard"].map(String::from).to_vec();
        if let Some(record) = core.model.sessions.get(&session) {
            names.extend(
                record
                    .status_lines
                    .iter()
                    .map(|line| format!("status_line/{}", line.id)),
            );
        }
        for name in core.model.forget_session(&session) {
            core.journal.delete(side_key(TAG_MODEL, &[name.as_bytes()]));
        }
        let mut unused = Vec::new();
        // One list, rising by the hub's change number across every sender: an envelope is handed after the
        // ones it builds on (an answer after its card's version), whoever wrote them.
        for (change, (bytes, void_code)) in fetched {
            // Along its sender's chain first: the next envelope of a chain is new, any other was taken
            // before (`replay`). What the chain holds and did not open then is asked for out of order,
            // which shows its body once the key is there (applied when the chain holds that very
            // envelope, provisional otherwise). What the device does not take either way is not applied.
            let voided = void_code.is_some();
            let mut took = self
                .hand(bytes.clone(), change, true, void_code, false)
                .await?;
            let unopened = took.received.body.is_none()
                && !voided
                && matches!(
                    took.received.code.as_ref().map(|code| code.code()),
                    Some("replay" | "no-key" | "pruned" | "decrypt-failed")
                );
            if unopened {
                let again = self.hand(bytes, change, false, None, false).await?;
                if matches!(
                    again.received.outcome,
                    EnvelopeOutcome::Applied | EnvelopeOutcome::Provisional
                ) && again.received.body.is_some()
                {
                    took = again;
                }
            }
            core.cursor = core.cursor.max(took.cursor);
            self.apply(core, &took, &session, &mut unused);
        }
        // What the device holds decides: each object's state and current version, and the registers.
        let cards: Vec<String> = core
            .model
            .cards
            .iter()
            .filter(|(_, card)| card.session_id.as_deref() == Some(session.as_str()))
            .map(|(id, _)| id.clone())
            .collect();
        let held = self
            .vault
            .call(move |v: &mut Vault| {
                let objects: Vec<(String, Option<trommi_core::objects::Object>)> = cards
                    .into_iter()
                    .map(|id| {
                        let object = crate::util::unhex(&id)
                            .and_then(|bytes| trommi_core::ids::ObjectId::from_slice(&bytes).ok())
                            .and_then(|object| v.device.object(&group, &object).ok().flatten());
                        (id, object)
                    })
                    .collect();
                let registers: Vec<(String, Option<String>)> = names
                    .into_iter()
                    .map(|name| {
                        let value = v
                            .device
                            .register(&group, &name)
                            .ok()
                            .flatten()
                            .map(|value| String::from_utf8_lossy(value.expose()).into_owned());
                        (name, value)
                    })
                    .collect();
                (objects, registers)
            })
            .await?;
        let now = now_ms();
        for (id, object) in held.0 {
            core.model.reconcile_card(&id, object.as_ref());
        }
        for (name, value) in held.1 {
            if value.is_some() {
                core.model
                    .apply_register(&session, &name, value.as_deref(), upto, now);
            }
        }
        // Done: the group leaves the list of what is still to be read again, in the same record.
        core.reread.retain(|waits| *waits != group);
        core.commit()
    }

    /// Writes this device's `heads` register in every session group where the device says it is due (9.0.7).
    async fn write_heads(&self, core: &mut Core) -> Result<()> {
        let groups: Vec<GroupId> = core.groups.values().copied().collect();
        for group in groups {
            let now = now_ms();
            let due = self
                .vault
                .call(move |v: &mut Vault| v.device.heads_due(&group, now))
                .await?;
            // A group that takes no envelope now (stale, no key yet) gets its heads another time.
            let Ok(Some(value)) = due else { continue };
            let spec = Spec::Register {
                name: "heads".into(),
                value: Some(String::from_utf8_lossy(&value).into_owned()),
            };
            let _ = self.seal(core, group, spec, Vec::new(), None).await;
            core.commit()?;
        }
        Ok(())
    }

    /// Posts what waits in the device's outbox, in its order. Stops at the first request the hub could not be
    /// reached for; that one and what follows are sent again later, unchanged.
    pub(crate) async fn pump(&self, core: &mut Core) -> Result<()> {
        match self.pump_once(core).await {
            Err(fault) if fault.code == "lease-lost" => {
                // The lease ran out while this process was away, or it never had one (it started while the
                // hub was away). Renewing tells: if another process holds the lease now, this fails for good.
                let report = self
                    .report
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .clone();
                self.hub.link(&self.process, &report).await?;
                self.pump_once(core).await
            }
            other => other,
        }
    }

    async fn pump_once(&self, core: &mut Core) -> Result<()> {
        // Nothing is posted that is not written: a journal whose last write failed refuses here. And nothing
        // by a client that stopped.
        self.active(core)?;
        core.commit()?;
        // An envelope the hub voided for its epoch is sealed again, in the epoch the group stands in now.
        let prefix = side_key(TAG_SPEC, &[]);
        let again: Vec<(u64, Waiting)> = core
            .journal
            .scan(&prefix[..2])
            .iter()
            .filter_map(|(key, value)| {
                let id = key.get(3..11)?.try_into().ok().map(u64::from_be_bytes)?;
                let waiting: Waiting = serde_json::from_slice(value).ok()?;
                waiting.rebuild.then_some((id, waiting))
            })
            .collect();
        for (old_id, old) in again {
            let group = b64_group(&old.group)?;
            let first = old.first.unwrap_or(old_id);
            let sealed = if old.resealed >= RESEALS {
                Err(Fault::new(
                    "wrong-epoch",
                    "the hub keeps refusing this envelope for its epoch",
                ))
            } else {
                self.seal(
                    core,
                    group,
                    old.spec.clone(),
                    old.files.clone(),
                    Some((old.resealed + 1, first)),
                )
                .await
            };
            match sealed {
                // What the first one's sender is told of is the envelope that stands in its place.
                Ok(new) => {
                    core.drop_waiting(old_id);
                    core.replaced.insert(first, new);
                }
                // Not now (a Commit of this device waits, the hub is away): the wish stays noted.
                Err(fault) if matches!(fault.code.as_str(), "busy" | "offline" | "stopped") => {
                    core.commit()?;
                    continue;
                }
                Err(fault) => {
                    core.drop_waiting(old_id);
                    core.failed.insert(first, fault);
                }
            }
            core.commit()?;
        }
        let mut failed_before: Option<u64> = None;
        for _ in 0..10_000 {
            let Some(entry) = self
                .vault
                .call(|v: &mut Vault| v.device.outbox().into_iter().next())
                .await?
            else {
                break;
            };
            if entry.kind == OutboxKind::Envelope && core.model.room.outbox_blocked.is_some() {
                break;
            }
            let id = entry.id;
            // An entry that failed and is still the first is not posted again in the same round.
            if failed_before == Some(id) {
                break;
            }
            let envelope = entry.kind == OutboxKind::Envelope;
            let fault = match self.post_entry(&entry).await {
                Ok(accepted) => {
                    self.vault
                        .call(move |v: &mut Vault| v.device.outbox_accepted(id, accepted))
                        .await??;
                    if envelope {
                        core.drop_waiting(id);
                    }
                    core.commit()?;
                    continue;
                }
                Err(fault) => fault,
            };
            failed_before = Some(id);
            // No hub of this protocol answered: the entry stays, and the caller hears why.
            if crate::hub::is_no_hub(&fault) {
                return Err(fault);
            }
            let code = fault
                .as_core()
                .unwrap_or(trommi_core::Error::Internal("refused by the hub"));
            if fault.code == "lease-lost" || fault.code == "unauthorised" {
                return Err(fault);
            }
            if is_transient(&fault) || refusal_is_passing(&code) {
                self.online.store(false, Ordering::SeqCst);
                return Ok(());
            }
            if !envelope {
                // Final for its entry: the device undoes what it was for (an epoch that was taken is
                // decided by the log).
                self.vault
                    .call(move |v: &mut Vault| v.device.outbox_refused(id, &code))
                    .await??;
                // (`epoch-taken`: the log decides it, where it shows the Commit that took the epoch)
                if fault.code != "epoch-taken" {
                    core.failed.insert(id, fault.clone());
                }
                core.commit()?;
                if matches!(fault.code.as_str(), "not-member" | "removed-sender") {
                    return Err(fault);
                }
                if fault.code != "epoch-taken" {
                    eprintln!(
                        "[trommi] the hub refused a request of this device: {}",
                        fault.code
                    );
                }
                continue;
            }
            let waiting = core.waiting(id);
            let first = waiting.as_ref().and_then(|w| w.first).unwrap_or(id);
            if fault.extra.get("voided") == Some(&Value::Bool(true)) {
                // 9.0.8: the number is used up, the chain goes on. What an epoch change voided is sealed
                // again in the new epoch: the wish stays noted, marked, until the new envelope is written in
                // its place. Anything else is the sender's to hear.
                self.vault
                    .call(move |v: &mut Vault| v.device.outbox_voided(id))
                    .await??;
                match waiting {
                    Some(mut waiting) if fault.code == "wrong-epoch" => {
                        waiting.rebuild = true;
                        core.put_waiting(id, &waiting);
                        core.outbox.retain(|waits| *waits != id);
                        core.commit()?;
                        self.catch_up(core).await?;
                        return Box::pin(self.pump(core)).await;
                    }
                    _ => {
                        core.drop_waiting(id);
                        core.failed.insert(first, fault);
                        core.commit()?;
                    }
                }
                continue;
            }
            if fault.code == "group-behind" {
                // The hub has not reached the epoch this was sealed in; it is posted again later.
                return Ok(());
            }
            if matches!(fault.code.as_str(), "not-member" | "removed-sender") {
                // This device is out of the group: there is nothing more for it to write there.
                self.vault
                    .call(move |v: &mut Vault| v.device.envelope_abandon(id))
                    .await??;
                core.drop_waiting(id);
                core.failed.insert(first, fault.clone());
                core.commit()?;
                return Err(fault);
            }
            // The hub took no number for it, and this device signs no other envelope under that number
            // (9.0.1): the envelope stays in the outbox as it is, and nothing behind it is posted in this
            // process. Its sender hears why.
            eprintln!(
                "[trommi] the hub refused an envelope of this device: {}; it stays in the outbox, and nothing more is sent",
                fault.code
            );
            core.failed.insert(first, fault.clone());
            core.model.room.outbox_blocked = Some(fault.code.clone());
            break;
        }
        self.refresh_outbox(core).await
    }

    /// One entry of the device's outbox as the hub's route for its kind.
    async fn post_entry(&self, entry: &OutboxEntry) -> Result<Accepted> {
        let part = |index: usize| entry.parts.get(index).map(|p| b64(p)).unwrap_or_default();
        let optional = |index: usize| {
            entry
                .parts
                .get(index)
                .filter(|p| !p.is_empty())
                .map(|p| json!(b64(p)))
                .unwrap_or(Value::Null)
        };
        let group = entry.group.map(|g| b64(g.as_bytes())).unwrap_or_default();
        let answer = match entry.kind {
            OutboxKind::GroupFounding => {
                let mut body = json!({
                    "group_info_0": part(0), "sealed_key_0": part(1), "commit": part(2),
                    "group_info": part(3), "sealed_key": part(5),
                });
                if !optional(4).is_null() {
                    body["welcome"] = optional(4);
                }
                self.hub.post("/v2/groups", &body).await?
            }
            OutboxKind::Commit => {
                let mut body = json!({
                    "epoch": entry.epoch, "commit": part(0), "group_info": part(1), "sealed_key": part(3),
                });
                if !optional(2).is_null() {
                    body["welcome"] = optional(2);
                }
                self.hub
                    .post(&format!("/v2/groups/{group}/commits"), &body)
                    .await?
            }
            OutboxKind::Message | OutboxKind::RelayMessage => {
                let mut body = json!({ "epoch": entry.epoch, "message": part(0) });
                if entry.kind == OutboxKind::RelayMessage {
                    body["relay"] = json!(true);
                }
                self.hub
                    .post(&format!("/v2/groups/{group}/messages"), &body)
                    .await?
            }
            OutboxKind::KeyPackages => {
                let single: Vec<String> = entry.parts.iter().skip(1).map(|p| b64(p)).collect();
                let mut body = json!({ "single_use": single });
                if !optional(0).is_null() {
                    body["last_resort"] = optional(0);
                }
                self.hub.put("/v2/key-packages", &body).await?
            }
            OutboxKind::Envelope => {
                self.hub
                    .post("/v2/envelopes", &json!({ "envelope": part(0) }))
                    .await?
            }
            // What only a human device or a device that holds the recovery code makes.
            _ => return Err(Fault::new("forbidden", "not a request of an agent device")),
        };
        Ok(Accepted {
            change: answer.get("change").and_then(Value::as_u64),
        })
    }

    /// Seals an envelope of this device: the device signs it and puts it in its outbox with the advanced
    /// chain, and the note of what it was sealed from is staged with it. Nothing is posted. `again`: it
    /// stands in for an envelope the hub voided (how often by now, and the first one's outbox id).
    pub(crate) async fn seal(
        &self,
        core: &mut Core,
        group: GroupId,
        spec: Spec,
        files: Vec<String>,
        again: Option<(u8, u64)>,
    ) -> Result<Sealed> {
        if let Some(code) = &core.model.room.outbox_blocked {
            return Err(Fault::new(
                "chain-halted",
                format!("the hub refused an earlier envelope of this session for good ({code})"),
            ));
        }
        self.active(core)?;
        // Nothing is signed before this process held its state against the hub's copy of its own chains: a
        // state that was put back from an older copy would sign a used number.
        if !self.guarded.load(Ordering::SeqCst) {
            return Err(Fault::new(
                "offline",
                "the hub has not been reached since this connector started; nothing is signed before it has",
            ));
        }
        // Nothing is queued without a bound while the hub is away (what is sealed again takes the place of
        // one that waited).
        if again.is_none() && core.outbox.len() >= MAX_WAITING {
            return Err(Fault::new(
                "offline",
                "the hub has been away for too long and too much waits for it; nothing more is queued until it is back",
            ));
        }
        let draft = crate::agent::draft(core, &group, &spec)?;
        let now = now_ms();
        let sealed = self
            .vault
            .call(move |v: &mut Vault| -> Result<Sealed> {
                let file_ids: Vec<trommi_core::ids::FileId> = files
                    .iter()
                    .filter_map(|id| trommi_core::ids::FileId::from_base64url(id).ok())
                    .collect();
                let sealed = v.device.seal(&draft, None, &file_ids, now)?;
                // Staged with the device's batch: one record holds the envelope, its number and its note.
                let waiting = Waiting {
                    group: b64(group.as_bytes()),
                    spec,
                    files,
                    rebuild: false,
                    resealed: again.map_or(0, |(count, _)| count),
                    first: again.map(|(_, first)| first),
                };
                v.journal().put(
                    side_key(TAG_SPEC, &[&sealed.outbox_id.to_be_bytes()]),
                    serde_json::to_vec(&waiting)?,
                );
                v.journal().put(
                    side_key(TAG_OWN, &[group.as_bytes()]),
                    sealed.seq.to_be_bytes().to_vec(),
                );
                Ok(sealed)
            })
            .await??;
        core.outbox.push(sealed.outbox_id);
        Ok(sealed)
    }

    /// Seals, writes, posts, and follows the hub's order up to the envelope's place. With the hub away the
    /// envelope stays in the outbox and this returns without a change number.
    pub(crate) async fn send(
        &self,
        session_id: Option<&str>,
        spec: Spec,
        files: Vec<String>,
    ) -> Result<SentInfo> {
        let mut core = self.core.lock().await;
        let group = core.group_of(session_id)?;
        let sealed = self.seal(&mut core, group, spec, files, None).await?;
        core.commit()?;
        let id = sealed.outbox_id;
        let sent = async {
            self.pump(&mut core).await?;
            self.catch_up(&mut core).await
        };
        match sent.await {
            Ok(()) => {}
            Err(fault) if is_transient(&fault) => self.online.store(false, Ordering::SeqCst),
            Err(fault) => {
                drop(core);
                self.fatal(&fault).await;
                return Err(fault);
            }
        }
        if let Some(fault) = core.failed.remove(&id) {
            return Err(fault);
        }
        // If the hub voided it for its epoch, another envelope stands in its place, under another number:
        // that one is what the caller is told of.
        let sealed = core.replaced.remove(&id).unwrap_or(sealed);
        let waits = core.outbox.contains(&sealed.outbox_id);
        if waits {
            self.wake.notify_one();
        }
        Ok(SentInfo {
            hash: sealed.envelope_hash.to_base64url(),
            object_id: sealed.object_id.map(|id| hex(id.as_bytes())),
            envelope_number: (!waits).then_some(core.cursor),
        })
    }

    /// Posts what waits and follows the hub's order: for a caller that put a request of the device into its
    /// outbox (a founding, a Commit, a message). The device's own Commit is merged where the log shows it.
    pub(crate) async fn post_and_follow(&self, core: &mut Core) -> Result<()> {
        core.commit()?;
        self.pump(core).await?;
        self.catch_up(core).await
    }

    /// Waits until nothing of this device waits for the hub, at most `timeout_ms`. `chain-halted` when the
    /// hub refused an envelope for good.
    pub async fn settle(&self, timeout_ms: u64) -> Result<()> {
        let until = now_ms() + timeout_ms;
        loop {
            {
                let mut core = self.core.lock().await;
                if let Some(code) = core.model.room.outbox_blocked.clone() {
                    return Err(Fault::new("chain-halted", code));
                }
                if core.outbox.is_empty() {
                    return Ok(());
                }
                let tried = async {
                    self.pump(&mut core).await?;
                    self.catch_up(&mut core).await
                };
                if let Err(fault) = tried.await {
                    if !is_transient(&fault) {
                        return Err(fault);
                    }
                }
                if core.outbox.is_empty() {
                    return Ok(());
                }
            }
            if now_ms() >= until {
                return Err(Fault::new(
                    "offline",
                    "the hub has not confirmed everything yet; it is sent when the hub is back",
                ));
            }
            sleep(500).await;
        }
    }

    /// A refusal of the hub for a request of the device's outbox since the last call, if any.
    pub(crate) fn take_refusal(core: &mut Core, outbox_id: u64) -> Option<Fault> {
        core.failed.remove(&outbox_id)
    }
}
