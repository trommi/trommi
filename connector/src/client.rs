//! The client: this device at work in its room. It signs in, holds the lease, takes Welcomes, follows the hub's
//! order (the live stream, and catching up after it was away), posts what waits in the outbox, and hands a
//! human's commands to the connector once the core's gate let them through.
//!
//! **Where state lives.** The [`Vault`] (the core's device and the content chains) is kept on a thread of its
//! own (`keeper.rs`). What is plain data lives in [`Core`] under one async lock: the model, the cursor in the
//! hub's order, the envelopes of this device that the hub has not confirmed. Every step takes that lock, calls
//! the vault, puts what follows from the answer into the journal and commits once: one record per step, and
//! nothing leaves before it (`store.rs`).
//!
//! **The hub's order.** Everything of the room comes with one running change number (spec/v2.md 5.4.1). The
//! client processes items strictly by it, its own envelopes included: an envelope this device sent counts in the
//! model when it comes back at its place. A send therefore posts and then catches up; while the hub is away, the
//! envelope waits in the outbox with the number it was signed under and is posted unchanged later.
use crate::error::{Fault, Result};
use crate::hub::{b64, is_transient, unb64, Hub};
use crate::keeper::Keeper;
use crate::model::{Model, Seen};
use crate::store::Journal;
use crate::util::{hex, now_ms};
use crate::vault::{side_key, ContentDevice, Vault};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use trommi_core::chain::{Mode, Outcome, Served};
use trommi_core::device::{
    log_finding, Accepted, LogEntry, LogFinding, LogKind, Processed, Received, WelcomeExpectation,
};
use trommi_core::envelope::{Envelope, RequestBind, Subject, Timeline};
use trommi_core::ids::{DeviceId, GroupId, Hash32, RoomId};
use trommi_core::mls::profile::Cut;
use trommi_core::objects::{AnswerAction, Command as GateCommand, Decision, OwnRecord};
use trommi_core::store::{OutboxEntry, OutboxKind};

/// A boxed future, for the traits the server implements.
pub type BoxFut<'a, T> = std::pin::Pin<Box<dyn std::future::Future<Output = T> + Send + 'a>>;

const TAG_SYNC: u8 = b'x';
const TAG_PENDING: u8 = b'q';
const TAG_MODEL: u8 = b'm';
const TAG_KV: u8 = b'k';
const TAG_CUTS: u8 = b'u';
/// Commands the gate let through that are not yet noted as handed to the agent, by envelope hash.
const TAG_COMMAND: u8 = b'd';

/// How far one page of the hub's order may move the cursor beyond its last item: the hub looks at most 20 000
/// numbers ahead per call.
const CURSOR_REACH: u64 = 100_000;
/// How often an envelope the hub voided for its epoch is sealed again before the sender hears of it.
const RESEALS: u8 = 3;
/// How many items one catch-up request asks for.
const CHANGES_LIMIT: u64 = 500;
/// The hub pings every 25 s; a stream that is silent for this long is dead.
const STREAM_SILENCE: Duration = Duration::from_secs(70);
/// The lease lives 60 s and is renewed every 20 s (13.7).
const LEASE_EVERY: Duration = Duration::from_secs(20);
/// `heads` is written at most this often (9.0.7).
const HEADS_EVERY_MS: u64 = 10 * 60_000;

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

/// What a joined slot knows of its room: stored once, when the invite was answered.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct RoomRecord {
    /// The hub's canonical address.
    pub hub: String,
    /// The app's origin, for Share links.
    pub app: String,
    /// The room, base64url.
    pub room: String,
    /// The human device that invited this one, base64url: it must have enrolled it (12.1.6).
    pub inviter: String,
    /// The session the invite was for, as hex; empty for a new session.
    #[serde(default)]
    pub invited_session: String,
    /// The room epoch the Offer named: where this device starts to follow the room group.
    #[serde(default)]
    pub room_epoch: u64,
    /// That epoch's `room_state`, base64url.
    #[serde(default)]
    pub room_state: String,
    /// Whether the room group is followed already.
    #[serde(default)]
    pub observing: bool,
    /// Whether the inviter's enrolment of this device was seen.
    #[serde(default)]
    pub enrolled: bool,
}

/// What an envelope of this device is, so that it can be sealed, and sealed again under a new number when the
/// hub voided it for its epoch.
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

/// An envelope of this device that waits for the hub, or for its place in the hub's order.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Pending {
    pub id: u64,
    /// The group, base64url.
    pub group: String,
    pub spec: Spec,
    /// The file ids its header names, base64url.
    pub files: Vec<String>,
    /// The sealed envelope, base64url: posted as it is, however often.
    pub bytes: String,
    /// Its hash, base64url.
    pub hash: String,
    pub seq: u64,
    /// The change number the hub gave it, once it took it.
    #[serde(default)]
    pub change: Option<u64>,
    /// The hub voided it for its epoch: it is sealed again under a new number, and until then it stays here
    /// so that the wish to send it survives a crash.
    #[serde(default)]
    pub rebuild: bool,
    /// How often it was sealed again, and the id of the first envelope it stands in for.
    #[serde(default)]
    pub resealed: u8,
    #[serde(default)]
    pub first: Option<u64>,
}

#[derive(Default, Serialize, Deserialize)]
struct SyncRecord {
    cursor: u64,
    next_id: u64,
    #[serde(default)]
    halted: Option<String>,
    #[serde(default)]
    heads_at: u64,
}

/// What a send reports.
#[derive(Clone, Debug, Default)]
pub struct SentInfo {
    /// The envelope's hash, base64url.
    pub hash: String,
    /// The object a first version or a request made, as hex.
    pub object_id: Option<String>,
    /// The hub's change number, once the hub took the envelope.
    pub envelope_number: Option<u64>,
}

/// The plain state of the client. Taken with [`Client::core`]'s lock.
pub struct Core {
    pub model: Model,
    /// This device's envelopes the hub has not confirmed at their place yet, oldest first.
    pub outbox: Vec<Pending>,
    /// The highest change number processed.
    pub cursor: u64,
    pub room: RoomRecord,
    /// The session groups this device is a leaf of, by session id as hex.
    pub groups: BTreeMap<String, GroupId>,
    /// The main session, as hex.
    main: Option<String>,
    journal: Journal,
    /// Why nothing is processed any more, if so.
    pub halted: Option<String>,
    heads_at: u64,
    /// Groups whose envelopes are to be read again from the hub's first.
    reread: Vec<GroupId>,
    /// Groups a re-admission was asked for in this process.
    asked_readmit: Vec<GroupId>,
    /// The hub's list of Welcomes for this device, as asked for while the current batch is processed.
    welcomes: Option<Value>,
    /// Envelopes that were sealed again after the hub voided them for their epoch, by the first one's id.
    replaced: BTreeMap<u64, Pending>,
    /// Groups a reading-again was asked for since this client last went online (a gap, another device's
    /// heads): once each.
    reread_asked: Vec<GroupId>,
    /// Envelopes of this device the hub voided or refused for good, by pending id.
    failed: BTreeMap<u64, Fault>,
    /// Files this process uploaded or fetched, by file id: the newest few.
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
        for name in self.model.take_dirty() {
            let key = side_key(TAG_MODEL, &[name.as_bytes()]);
            match self.model.record(&name) {
                Some(bytes) => self.journal.put(key, bytes),
                None => self.journal.delete(key),
            }
        }
        let record = SyncRecord {
            cursor: self.cursor,
            next_id: 0,
            halted: self.halted.clone(),
            heads_at: self.heads_at,
        };
        if let Ok(bytes) = serde_json::to_vec(&record) {
            self.journal.put(side_key(TAG_SYNC, &[]), bytes);
        }
    }
    /// Writes everything staged, the model's changes and the cursor included, as one record.
    pub fn commit(&mut self) -> Result<()> {
        self.stage();
        Ok(self.journal.commit()?)
    }
    fn put_pending(&self, pending: &Pending) {
        if let Ok(bytes) = serde_json::to_vec(pending) {
            self.journal
                .put(side_key(TAG_PENDING, &[&pending.id.to_be_bytes()]), bytes);
        }
    }
    /// Asks for a group's envelopes to be read again, at most once per time online.
    fn ask_reread(&mut self, group: GroupId) {
        if !self.reread_asked.contains(&group) {
            self.reread_asked.push(group);
            self.reread.push(group);
        }
    }
    /// Reads the outbox again from the journal: what a step staged there is found even if the step did not
    /// live to note it in memory.
    fn reload_outbox(&mut self) {
        let mut outbox: Vec<Pending> = self
            .journal
            .scan(&side_key(TAG_PENDING, &[])[..2])
            .iter()
            .filter_map(|(_, value)| serde_json::from_slice(value).ok())
            .collect();
        outbox.sort_by_key(|pending: &Pending| pending.id);
        self.outbox = outbox;
    }
    fn drop_pending(&mut self, id: u64) {
        self.outbox.retain(|pending| pending.id != id);
        self.journal
            .delete(side_key(TAG_PENDING, &[&id.to_be_bytes()]));
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

/// This device at work. See the module's documentation.
pub struct Client {
    pub core: CoreLock,
    pub(crate) vault: Keeper<Vault>,
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
    online: AtomicBool,
    /// Wakes the loop: something waits in the outbox.
    wake: tokio::sync::Notify,
    /// What this process last reported with its lease.
    report: std::sync::Mutex<Value>,
}

fn group_of_item(item: &Value) -> Result<GroupId> {
    Ok(GroupId::from_bytes(&unb64(item, "group_id")?)?)
}

fn b64_group(text: &str) -> Result<GroupId> {
    let bytes = trommi_core::ids::base64url_decode(text)?;
    Ok(GroupId::from_bytes(&bytes)?)
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
        let vault = Keeper::spawn(move || Vault::open(for_vault))?;
        let (me, key) = vault
            .call(|v: &mut Vault| {
                (
                    v.me(),
                    trommi_core::crypto::SigningKey::from_seed(v.signing_key().seed().duplicate()),
                )
            })
            .await?;
        let address = trommi_core::hub_auth::HubAddress::parse(&room.hub)
            .map_err(|_| Fault::new("state-damaged", "the stored hub address does not read"))?;
        let signer: crate::hub::Signer = Arc::new(move |challenge| {
            Ok(trommi_core::hub_auth::sign(
                &key, room_id, &address, challenge,
            )?)
        });
        let hub = Arc::new(Hub::new(&room.hub, Some(room_id), Some(signer))?);

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
            .map_err(|_| Fault::new("state-damaged", "the stored cursor does not read"))?
            .unwrap_or_default();
        let mut outbox: Vec<Pending> = Vec::new();
        for (_, value) in journal.scan(&side_key(TAG_PENDING, &[])[..2]) {
            outbox.push(serde_json::from_slice(&value).map_err(|_| {
                Fault::new(
                    "state-damaged",
                    "a stored envelope of the outbox does not read",
                )
            })?);
        }
        outbox.sort_by_key(|pending| pending.id);
        let (events, rx) = tokio::sync::mpsc::unbounded_channel();
        let client = Arc::new(Client {
            core: CoreLock(tokio::sync::Mutex::new(Core {
                model,
                outbox,
                cursor: sync.cursor,
                room,
                groups: BTreeMap::new(),
                main: None,
                journal,
                halted: sync.halted,
                heads_at: sync.heads_at,
                reread: Vec::new(),
                asked_readmit: Vec::new(),
                welcomes: None,
                replaced: BTreeMap::new(),
                reread_asked: Vec::new(),
                failed: BTreeMap::new(),
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
            online: AtomicBool::new(false),
            wake: tokio::sync::Notify::new(),
            report: std::sync::Mutex::new(json!({})),
        });
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
            "not-member" | "removed-sender" | "no-room" => self.set_removed(false).await,
            _ => self.emit(ClientEvent::Error(fault.clone())),
        }
    }

    /// The hub refuses this device as no member: unverified, the state stays.
    async fn set_removed(&self, replaced: bool) {
        let mut core = self.core.lock().await;
        self.set_removed_in(&mut core, replaced, false);
    }

    /// Notes that this device is out, for a caller that holds the core.
    fn set_removed_in(&self, core: &mut Core, replaced: bool, verified: bool) {
        if self.removed.swap(true, Ordering::SeqCst) {
            return;
        }
        let _ = self.stop_signal.send(true);
        core.model.room.connection = "removed".into();
        core.model.room.replaced = replaced;
        self.emit(ClientEvent::Removed { replaced, verified });
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
            let own = self
                .vault
                .call(move |v: &mut Vault| v.own_head(&group))
                .await?;
            let ahead = self
                .hub
                .get(&format!(
                    "/v2/groups/{}/chains/{}?after={}&limit=1",
                    b64(group.as_bytes()),
                    self.me.to_base64url(),
                    own.seq
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
                    .any(|envelope| {
                        envelope.header.sender == me
                            && envelope.header.group == group
                            && envelope.header.seq > own.seq
                            && envelope.verify().is_ok()
                    }),
                Err(fault) if fault.code == "not-found" => false,
                Err(fault) => return Err(fault),
            };
            if ahead {
                let fault = Fault::new(
                    "state-rolled-back",
                    "this connector's stored state is older than what it already sent; nothing is signed with it",
                );
                self.halt(core, &fault)?;
                return Err(fault);
            }
        }
        Ok(())
    }

    /// One round of being online: lease, room group, Welcomes, KeyPackages, the outbox, the hub's order.
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
        let groups: Vec<GroupId> = core.groups.values().copied().collect();
        for group in groups {
            let known = self
                .vault
                .call(move |v: &mut Vault| v.past_known(&group))
                .await?;
            if !known && self.learn_past(&mut core, group).await.is_ok() {
                core.reread.push(group);
            }
        }
        self.publish_key_packages(&mut core).await?;
        self.pump(&mut core).await?;
        self.catch_up(&mut core).await?;
        self.write_heads(&mut core, false).await?;
        core.model.room.connection = "connected".into();
        self.online.store(true, Ordering::SeqCst);
        Ok(())
    }

    /// Starts following the room group (4.4, 12.1.6) at the GroupInfo of the epoch the Offer named, which must
    /// hash to the state it named.
    async fn observe_room(&self, core: &mut Core) -> Result<()> {
        if core.room.observing {
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
        let expected = Hash32::from_base64url(&core.room.room_state)
            .map_err(|_| Fault::new("state-damaged", "the stored room state does not read"))?;
        self.vault
            .call(move |v: &mut Vault| v.device.observe_room(&group_info, Some(&expected)))
            .await??;
        core.room.observing = true;
        put_room_record(&core.journal, &core.room);
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
                    self.emit(ClientEvent::Error(fault));
                    return;
                }
                Err(fault) if is_transient(&fault) => {}
                Err(fault) => self.fatal(&fault).await,
            }
            let mut core = self.core.lock().await;
            if now_ms().saturating_sub(core.heads_at) >= HEADS_EVERY_MS {
                let _ = self.write_heads(&mut core, true).await;
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
        loop {
            if self.is_stopped() {
                return;
            }
            let round = async {
                if !self.is_online() {
                    self.go_online().await?;
                }
                self.follow().await
            };
            match round.await {
                Ok(()) => pause_ms = 1000,
                Err(fault) if is_transient(&fault) || fault.code == "unauthorised" => {}
                Err(fault) if fault.code == "lease-lost" => {
                    self.stopped.store(true, Ordering::SeqCst);
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
                    let commands = self.process_items(&mut core, &[event.data], None).await?;
                    drop(core);
                    self.deliver(commands).await;
                }
                "welcome" => {
                    self.take_welcomes(&mut core, None).await?;
                    self.catch_up(&mut core).await?;
                }
                _ => {}
            }
        }
    }

    /// Hands commands to the owner.
    async fn deliver(&self, commands: Vec<Command>) {
        for command in commands {
            self.emit(ClientEvent::Command(Box::new(command)));
        }
    }

    /// Records that a command had its effect (it was handed to the agent): it is never handed out again.
    pub async fn ledger_mark(&self, envelope_hash: &str) -> Result<()> {
        let hash = Hash32::from_base64url(envelope_hash)?;
        let mut core = self.core.lock().await;
        self.vault
            .call(move |v: &mut Vault| v.gate_finish(&hash))
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
                    core.halted = Some("gone".into());
                    core.commit()?;
                    return Err(Fault::new(
                        "state-too-old",
                        "the hub no longer keeps what this connector missed; the human reconnects this session in the Trommi app",
                    ));
                }
                other => other?,
            };
            let items = answer
                .get("items")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let upto = answer.get("change").and_then(Value::as_u64);
            let before = core.cursor;
            let commands = self.process_items(core, &items, upto).await?;
            self.deliver(commands).await;
            // A page that says there is more and moves nothing is not followed again and again.
            if answer.get("more") != Some(&Value::Bool(true)) || core.cursor == before {
                break;
            }
        }
        let again: Vec<GroupId> = std::mem::take(&mut core.reread);
        for group in again {
            self.reread(core, group).await?;
        }
        Ok(())
    }

    /// Joins every group a Welcome waits for (12.1.5, 5.2.6), and records it.
    ///
    /// A Welcome is taken at its place in the hub's order (5.4.1): the room state its Commit names must have
    /// been processed, or the group fails its first contact for good, and no later entry of the group may have
    /// been passed. `at_item` says that the caller stands right before the first item of a group it does not
    /// hold: everything before it is processed, so the Welcome is taken now. Otherwise the hub's order is
    /// followed to its end first (which takes a Welcome at an item's place if there is one).
    pub(crate) fn take_welcomes<'a>(
        &'a self,
        core: &'a mut Core,
        only: Option<GroupId>,
    ) -> BoxFut<'a, Result<()>> {
        Box::pin(self.take_welcomes_now(core, only))
    }

    async fn take_welcomes_now(&self, core: &mut Core, only: Option<GroupId>) -> Result<()> {
        let at_item = only.is_some();
        let list = self.hub.get("/v2/welcomes").await?;
        let room = self.room;
        let mut joined_any = false;
        if !at_item && list.as_array().is_some_and(|rows| !rows.is_empty()) {
            self.catch_up(core).await?;
        }
        for row in list.as_array().cloned().unwrap_or_default() {
            let (Ok(group), Ok(welcome)) = (group_of_item(&row), unb64(&row, "welcome")) else {
                continue;
            };
            // An agent device is never a leaf of the room group (5.1), and at an item's place only that
            // item's group is joined: another Welcome waits for its own place.
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
                    v.note_epoch(&group, None, &[], now)?;
                    Ok(Some(joined.offending))
                })
                .await?;
            match outcome {
                Ok(None) => {}
                Ok(Some(offending)) => {
                    joined_any = true;
                    if !offending.is_empty() {
                        let me = self.me;
                        eprintln!("[trommi] finding: a session this device was added to has {} leaf(s) the room does not allow{}: its content is not opened until a human device removes them", offending.len(), if offending.contains(&me) { " (this device among them)" } else { "" });
                    }
                    if let Err(fault) = self.learn_past(core, group).await {
                        // The epochs before this device joined stay unknown: what devices wrote that left
                        // before then is not taken. Named, never swallowed.
                        eprintln!(
                            "[trommi] finding: {} (a session's past was not learned)",
                            fault.code
                        );
                        if fault.code == "bad-group" {
                            self.emit(ClientEvent::Error(Fault::new(
                                "bad-group",
                                "a session this agent was added to does not verify from its founding",
                            )));
                        }
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
            core.commit()?;
        }
        if joined_any {
            self.refresh_groups(core).await?;
            core.commit()?;
        }
        Ok(())
    }

    /// Whether a Welcome for `group` waits at the hub and an entry the hub took at `at` is not from before it:
    /// then that entry's place is where the Welcome is taken. The list of Welcomes is asked for once per
    /// batch of entries. The times are the hub's; a wrong one can only cost the join, which the core then
    /// finds out at first contact.
    async fn welcome_due(&self, core: &mut Core, group: &GroupId, at: u64) -> Result<bool> {
        if core.welcomes.is_none() {
            core.welcomes = Some(self.hub.get("/v2/welcomes").await?);
        }
        let wanted = b64(group.as_bytes());
        let since = core
            .welcomes
            .as_ref()
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .find(|row| row.get("group_id").and_then(Value::as_str) == Some(wanted.as_str()))
            .map(|row| row.get("at").and_then(Value::as_u64).unwrap_or(0));
        Ok(since.is_some_and(|since| at >= since))
    }

    /// Every Commit of a group's log, in order, with the `RecoveryAuth` beside a join from outside.
    async fn commits_of(
        &self,
        group: &GroupId,
    ) -> Result<(Vec<(Vec<u8>, Option<Vec<u8>>)>, Vec<u64>)> {
        let mut out = Vec::new();
        let mut changes = Vec::new();
        let mut after = 0u64;
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
                out.push((unb64(item, "bytes")?, auth));
                changes.push(item.get("change").and_then(Value::as_u64).unwrap_or(0));
                after = after.max(item.get("n").and_then(Value::as_u64).unwrap_or(after));
            }
            // A log that says there is more and does not move on, or that is longer than any group's, ends.
            if after == asked_after || out.len() > 1_000_000 {
                return Ok((out, changes));
            }
            if page.get("more") != Some(&Value::Bool(true)) || items.is_empty() {
                return Ok((out, changes));
            }
        }
    }

    /// Learns the epochs of a group before this device joined it, from what the hub keeps (`Vault::learn_past`).
    async fn learn_past(&self, core: &mut Core, group: GroupId) -> Result<()> {
        let room_group = GroupId::room(self.room);
        let info_of = |group: GroupId| async move {
            let info = self
                .hub
                .get(&format!(
                    "/v2/groups/{}/info?epoch=0",
                    b64(group.as_bytes())
                ))
                .await?;
            unb64(&info, "group_info")
        };
        let (room_commits, _) = self.commits_of(&room_group).await?;
        let (commits, changes) = self.commits_of(&group).await?;
        let current = self
            .hub
            .get(&format!("/v2/groups/{}/info", b64(group.as_bytes())))
            .await?;
        let past = crate::vault::Past {
            room_info: info_of(room_group).await?,
            room_commits,
            info: info_of(group).await?,
            commits,
            changes,
            current: unb64(&current, "group_info")?,
        };
        let anchor = (
            core.room.room_epoch,
            Hash32::from_base64url(&core.room.room_state)
                .map_err(|_| Fault::new("state-damaged", "the stored room state does not read"))?,
        );
        let now = now_ms();
        self.vault
            .call(move |v: &mut Vault| -> Result<()> {
                // 5.2.6 first, as the core's device checks it; then the epochs before this device's own.
                v.first_contact(&group, &past)?;
                v.learn_past(&group, &past, anchor, now)
            })
            .await??;
        core.commit()
    }

    /// Tops the KeyPackages at the hub up (section 3: one last-resort always, a hundred single-use ones).
    async fn publish_key_packages(&self, core: &mut Core) -> Result<()> {
        // What the hub still holds is not asked for: uploading again is harmless, and the device makes new
        // ones only when its own count says so. A device that never uploaded has none there.
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

    /// Processes items of the hub's order above the cursor, one after another, and commits once. Returns the
    /// commands the gate let through; they are handed out after the write.
    pub(crate) async fn process_items(
        &self,
        core: &mut Core,
        items: &[Value],
        upto: Option<u64>,
    ) -> Result<Vec<Command>> {
        let mut commands = Vec::new();
        if core.halted.is_some() {
            return Ok(commands);
        }
        core.welcomes = None;
        let mut stopped_early = false;
        for item in items {
            let Some(change) = item.get("change").and_then(Value::as_u64) else {
                continue;
            };
            if change <= core.cursor {
                continue;
            }
            if change > core.cursor.saturating_add(CURSOR_REACH) {
                // The number is the hub's word. One that lies beyond anything a page can reach would carry
                // the cursor past everything to come: the item is not taken, and the cursor stays.
                eprintln!("[trommi] finding: an item of the hub's order names a change far beyond the last one; not taken");
                stopped_early = true;
                break;
            }
            let kind = item.get("kind").and_then(Value::as_str).unwrap_or("");
            let step = if kind == "envelope" {
                self.take_envelope(core, item, change, &mut commands).await
            } else {
                self.take_log(core, item, change, kind == "commit").await
            };
            match step {
                Ok(true) => {
                    // One record per entry (13.2): the state after it, what was derived from it, the cursor.
                    core.cursor = change;
                    core.commit()?;
                }
                Ok(false) => {
                    stopped_early = true;
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
                stopped_early = true;
                break;
            }
        }
        // The page's own end is the hub's word (numbers without items lie between): taken within the reach
        // of one page only, so that a wrong number cannot carry the cursor past everything to come.
        if let (false, Some(upto)) = (stopped_early, upto) {
            if upto <= core.cursor.saturating_add(CURSOR_REACH) {
                core.cursor = core.cursor.max(upto);
            }
        }
        core.commit()?;
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
        if !group.is_room()
            && core
                .session_of_group(&group)
                .is_some_and(|sid| !core.groups.contains_key(&sid))
        {
            // A group this device does not hold. If a Welcome waits for it and this entry is not from before
            // it, this is the Welcome's place in the hub's order (5.4.1): everything before is processed.
            let at = item.get("at").and_then(Value::as_u64).unwrap_or(u64::MAX);
            if self.welcome_due(core, &group, at).await? {
                self.take_welcomes(core, Some(group)).await?;
            }
        }
        let me = self.me;
        let inviter = core.room.inviter.clone();
        let was_enrolled = core.room.enrolled;
        let now = now_ms();
        let outcome = self
            .vault
            .call(move |v: &mut Vault| -> Result<LogOutcome> {
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
                match v.device.process_log_entry(&entry) {
                    Ok(Processed::Commit { facts, removed, .. }) => {
                        if removed {
                            return Ok(LogOutcome::RemovedFrom(group));
                        }
                        let (time, cuts): (u64, Vec<Cut>) = facts
                            .note
                            .map(|note| (note.time, note.cuts))
                            .unwrap_or((now, Vec::new()));
                        let (findings, dropped) = v.note_epoch(&group, Some(time), &cuts, now)?;
                        Ok(LogOutcome::Epoch(findings.len(), dropped.then_some(group)))
                    }
                    Ok(Processed::Observed(facts)) if group.is_room() => {
                        let enrolled = v
                            .device
                            .room_history()
                            .is_some_and(|h| h.newest().is_agent(&me));
                        if enrolled && !was_enrolled {
                            // 12.1.6: only the inviter's enrolment counts.
                            let by_inviter = facts.committer.to_base64url() == inviter;
                            return Ok(LogOutcome::Enrolled(by_inviter));
                        }
                        if !enrolled && was_enrolled {
                            return Ok(LogOutcome::Unenrolled);
                        }
                        Ok(LogOutcome::Nothing)
                    }
                    Ok(Processed::Message(Received::Keys { taken, .. })) if taken > 0 => {
                        Ok(LogOutcome::Keys(group))
                    }
                    Ok(Processed::Message(Received::NewerVersion { .. })) => Ok(LogOutcome::Newer),
                    Ok(_) => Ok(LogOutcome::Nothing),
                    Err(error) => Ok(match log_finding(&error) {
                        LogFinding::Duplicate => LogOutcome::Nothing,
                        LogFinding::Early => LogOutcome::Early,
                        LogFinding::BadGroup => LogOutcome::Bad(error.code()),
                        LogFinding::Local => return Err(error.into()),
                    }),
                }
            })
            .await??;
        match outcome {
            LogOutcome::Nothing => {}
            LogOutcome::Early => return Ok(false),
            LogOutcome::Epoch(findings, dropped) => {
                if findings > 0 {
                    eprintln!("[trommi] finding: equivocation at a removed device's Cut");
                }
                if let Some(group) = dropped {
                    // 9.0.10: what lay beyond the Cut never came. Everything derived from the group's
                    // envelopes is built again from what the hub still serves.
                    core.reread.push(group);
                }
                self.refresh_groups(core).await?;
            }
            LogOutcome::Keys(group) => core.reread.push(group),
            LogOutcome::Newer => {
                self.emit(ClientEvent::Error(Fault::new(
                    "newer-version",
                    "a message of a newer Trommi arrived",
                )));
            }
            LogOutcome::Enrolled(true) => {
                core.room.enrolled = true;
                put_room_record(&core.journal, &core.room);
            }
            LogOutcome::Enrolled(false) => {
                let fault = Fault::new(
                    "bad-invite",
                    "this device was enrolled by another device than the one that invited it",
                );
                core.cursor = change;
                self.halt(core, &fault)?;
                return Err(fault);
            }
            LogOutcome::Unenrolled => {
                core.cursor = change;
                core.commit()?;
                self.set_removed_in(core, false, true);
            }
            LogOutcome::RemovedFrom(group) => {
                let was_main = core.session_of_group(&group) == core.main;
                core.cursor = change;
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

    /// One envelope at its place. `Ok(false)`: its group is not processed that far yet.
    async fn take_envelope(
        &self,
        core: &mut Core,
        item: &Value,
        change: u64,
        commands: &mut Vec<Command>,
    ) -> Result<bool> {
        let bytes = unb64(item, "envelope")?;
        let served = match item.get("void_code").and_then(Value::as_str) {
            Some(code) => Served::Void(
                trommi_core::Error::from_code(code).unwrap_or(trommi_core::Error::BadFormat),
            ),
            None => Served::Stored,
        };
        // The header says which group; nothing of it is trusted before the checks.
        let Ok(header) = Envelope::decode(&bytes).map(|envelope| envelope.header) else {
            // 13.4: what the hub hands out here is no envelope (it may be something else under a wrong name).
            // The cursor stays: nothing is passed over that could not be read.
            eprintln!("[trommi] finding: bad-format (the item at change {change} is no envelope); waiting for the hub to serve it right");
            return Ok(false);
        };
        let group = header.group;
        let Some(session) = core.session_of_group(&group) else {
            return Ok(true);
        };
        if !core.groups.contains_key(&session) {
            let at = item
                .get("received_at")
                .and_then(Value::as_u64)
                .unwrap_or(u64::MAX);
            if self.welcome_due(core, &group, at).await? {
                self.take_welcomes(core, Some(group)).await?;
            }
            if !core.groups.contains_key(&session) {
                // An envelope of a group this device is no leaf of (yet): from before its Welcome.
                return Ok(true);
            }
        }
        match self
            .receive(core, bytes, served, None, change, &session, commands)
            .await
        {
            Err(fault) if fault.code == "group-behind" => Ok(false),
            Err(fault) if fault.code == "replay" => Ok(true),
            Err(fault) if fault.code == "gap" => {
                // An envelope before this one was not taken. The group's envelopes are read again from the
                // hub's first, once per time online; if the gap is still there, it is a finding that stays.
                eprintln!("[trommi] finding: gap (an envelope at change {change} does not follow its sender's last)");
                core.ask_reread(group);
                Ok(true)
            }
            Err(fault) if fault.code == "state-rolled-back" => {
                self.halt(core, &fault)?;
                Err(fault)
            }
            Err(fault)
                if fault.as_core().is_some()
                    && fault.code != "storage"
                    && fault.code != "internal" =>
            {
                // Checks 1 to 6: the envelope takes no place. Never swallowed: named, with its place.
                eprintln!(
                    "[trommi] finding: {} (an envelope at change {change} was not taken)",
                    fault.code
                );
                Ok(true)
            }
            Err(fault) => Err(fault),
            Ok(()) => Ok(true),
        }
    }

    /// Runs an envelope through the vault and puts what it means into the model; with `commands`, also
    /// through the gate.
    #[allow(clippy::too_many_arguments)]
    async fn receive(
        &self,
        core: &mut Core,
        bytes: Vec<u8>,
        served: Served,
        mode: Option<Mode>,
        change: u64,
        session: &str,
        commands: &mut Vec<Command>,
    ) -> Result<()> {
        let now = now_ms();
        let reading_back = mode == Some(Mode::ReadingBack);
        let taken = self
            .vault
            .call(move |v: &mut Vault| {
                let mode = mode.unwrap_or_else(|| {
                    // An envelope of an epoch before this device joined is read back, not met in order.
                    let header = Envelope::decode(&bytes).map(|e| e.header).ok();
                    match header {
                        Some(h) if v.first_epoch(&h.group).is_some_and(|first| h.epoch < first) => {
                            Mode::ReadingBack
                        }
                        _ => Mode::InOrder,
                    }
                });
                v.receive(&bytes, &served, mode, now)
            })
            .await??;
        let taken_heads = taken.heads;
        let receipt = &taken.receipt;
        let header = receipt.envelope().header.clone();
        let hash = receipt.hash();
        let mine = header.sender == self.me;
        if mine {
            let hash_text = hash.to_base64url();
            if let Some(id) = core
                .outbox
                .iter()
                .find(|pending| pending.hash == hash_text && !pending.rebuild)
                .map(|pending| pending.id)
            {
                core.drop_pending(id);
            }
        }
        let human = core
            .model
            .sessions
            .get(session)
            .is_some_and(|s| !s.agent_device_ids.contains(&header.sender.to_base64url()));
        match receipt.outcome() {
            Outcome::Taken { body, .. } => {
                let (payload, raw, bind) = match body {
                    Ok(body) => {
                        let raw = String::from_utf8_lossy(body.payload()).into_owned();
                        let payload = serde_json::from_str::<Value>(&raw)
                            .ok()
                            .and_then(|v| v.as_object().cloned());
                        (payload, raw, Some(body.bind().clone()))
                    }
                    Err(_) => (None, String::new(), None),
                };
                // The card as it stood before this envelope: what an answer is held against.
                let before = match &header.subject {
                    Subject::Answer(f) | Subject::TakeBack(f) => {
                        core.model.cards.get(&hex(f.object_id.as_bytes())).cloned()
                    }
                    _ => None,
                };
                let request = match &header.subject {
                    Subject::Verdict(f) => core
                        .model
                        .permissions
                        .get(&hex(f.object_id.as_bytes()))
                        .cloned(),
                    _ => None,
                };
                core.model.apply(&Seen {
                    change,
                    session,
                    header: &header,
                    hash,
                    payload: payload.as_ref(),
                    raw: &raw,
                    bind: bind.as_ref(),
                    human,
                });
                if let Some(register) = &taken.register {
                    if register.current {
                        core.model.apply_register(
                            session,
                            &register.name,
                            register.value.as_deref(),
                            change,
                            header.time,
                        );
                    }
                }
                let is_command = matches!(
                    header.subject,
                    Subject::Item(_)
                        | Subject::Answer(_)
                        | Subject::Verdict(_)
                        | Subject::TakeBack(_)
                );
                if !mine && is_command && !reading_back && body.is_ok() {
                    self.gate(
                        core, taken, before, request, payload, change, session, commands,
                    )
                    .await?;
                }
            }
            Outcome::Refused(code) | Outcome::Void { code, .. } => {
                if mine {
                    // The number is used up and the envelope counts for nothing.
                    eprintln!(
                        "[trommi] an envelope of this device was voided: {}",
                        code.code()
                    );
                }
                if let Outcome::Void {
                    finding: Some(finding),
                    ..
                } = receipt.outcome()
                {
                    eprintln!("[trommi] finding: {}", finding.code());
                }
            }
            Outcome::Reserved => {
                // 9.0.4: a kind this build does not know. It is no command, whoever sent it: said once as a
                // notice that a newer connector is needed.
                if !mine && !reading_back {
                    self.emit(ClientEvent::Error(Fault::new(
                        "newer-version",
                        "an item of a newer Trommi arrived that this connector cannot read",
                    )));
                }
            }
        }
        if let (Some((behind, equivocation)), false) = (taken_heads, reading_back) {
            if equivocation {
                self.emit(ClientEvent::Error(Fault::new(
                    "equivocation",
                    "another device accepted a different envelope under a number this agent holds",
                )));
            }
            if behind {
                // 9.0.7: another device holds envelopes this one was not served. Read the group again; what
                // is still missing then was withheld.
                eprintln!("[trommi] finding: withheld (another device's heads name envelopes this agent was not served)");
                core.ask_reread(header.group);
            }
        }
        Ok(())
    }

    /// The command gate on a human's envelope (9.0.9, 13.6); what it lets through becomes a [`Command`].
    #[allow(clippy::too_many_arguments)]
    async fn gate(
        &self,
        core: &mut Core,
        taken: crate::vault::Taken,
        before: Option<crate::model::Card>,
        request: Option<crate::model::Permission>,
        payload: Option<Map<String, Value>>,
        change: u64,
        session: &str,
        commands: &mut Vec<Command>,
    ) -> Result<()> {
        let now = now_ms();
        let header = taken.receipt.envelope().header.clone();
        let hash = taken.receipt.hash();
        let decision = self
            .vault
            .call(move |v: &mut Vault| -> Result<Decision> {
                let card_hash = before
                    .as_ref()
                    .and_then(|c| c.version_hash.as_deref())
                    .and_then(|h| Hash32::from_base64url(h).ok());
                let request_hash = request
                    .as_ref()
                    .and_then(|r| Hash32::from_base64url(&r.version_hash).ok());
                let own = match (&taken.receipt.envelope().header.subject, &before, &request) {
                    // A version whose body did not open leaves no payload to hold an answer against.
                    (Subject::Answer(_), Some(card), _) if card.payload.is_empty() => {
                        OwnRecord::None
                    }
                    (Subject::Answer(_), Some(card), _) => match card_hash {
                        Some(hash) => OwnRecord::CardVersion {
                            hash,
                            payload: card.payload.as_bytes(),
                        },
                        None => OwnRecord::None,
                    },
                    (Subject::Verdict(fields), _, Some(request)) => match request_hash {
                        Some(hash) => OwnRecord::Request {
                            hash,
                            bind: RequestBind {
                                request_id: fields.object_id,
                                expires_at: request.expires_at,
                            },
                        },
                        None => OwnRecord::None,
                    },
                    _ => OwnRecord::None,
                };
                v.gate(&taken.receipt, &own, now)
            })
            .await??;
        let mut command = Command {
            session_id: Some(session.to_string()),
            envelope_number: change,
            envelope_hash: hash.to_base64url(),
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
            Decision::Done => return Ok(()),
            Decision::Refused(refusal) => {
                // Not acted on (9.0.9). Said without content: which rule held it back.
                if !matches!(
                    refusal,
                    trommi_core::objects::Refusal::NotAddressed
                        | trommi_core::objects::Refusal::NotACommand
                ) {
                    eprintln!("[trommi] a human's envelope was not acted on: {refusal:?}");
                }
                return Ok(());
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
                command.settled = action == AnswerAction::Answer
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
                command.choices = choices;
            }
            Decision::Act(GateCommand::Verdict(verdict)) => {
                command.command = "verdict".into();
                command.allow = verdict == trommi_core::envelope::Verdict::Allow;
            }
            Decision::Act(GateCommand::TakeBack) => {
                command.command = "decide_again".into();
                command.previous_choices = command
                    .object_id
                    .as_ref()
                    .and_then(|id| core.model.cards.get(id))
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
        Ok(())
    }

    /// Reads a group's envelopes again from the hub's first (after joining it, and after a key handover opened
    /// what could not be read): the chains are verified from number 1, nothing is acted on.
    async fn reread(&self, core: &mut Core, group: GroupId) -> Result<()> {
        let Some(session) = core.session_of_group(&group) else {
            return Ok(());
        };
        if !core.groups.contains_key(&session) {
            return Ok(());
        }
        // Everything is fetched first: nothing is forgotten before what replaces it is in hand.
        let upto = core.cursor;
        let mut after = 0u64;
        let mut fetched: Vec<(u64, Vec<u8>, Served)> = Vec::new();
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
                if change > upto || item.get("kind").and_then(Value::as_str) != Some("envelope") {
                    continue;
                }
                let Ok(bytes) = unb64(&item, "envelope") else {
                    continue;
                };
                if Envelope::decode(&bytes).map(|e| e.header.group).ok() != Some(group) {
                    continue;
                }
                let served = match item.get("void_code").and_then(Value::as_str) {
                    Some(code) => Served::Void(
                        trommi_core::Error::from_code(code)
                            .unwrap_or(trommi_core::Error::BadFormat),
                    ),
                    None => Served::Stored,
                };
                fetched.push((change, bytes, served));
            }
            let next = answer.get("change").and_then(Value::as_u64).unwrap_or(upto);
            if answer.get("more") != Some(&Value::Bool(true)) || next >= upto || next <= after {
                break;
            }
            after = next;
        }
        self.vault
            .call(move |v: &mut Vault| v.forget_received(&group))
            .await??;
        for name in core.model.forget_session(&session) {
            core.journal.delete(side_key(TAG_MODEL, &[name.as_bytes()]));
        }
        let mut unused = Vec::new();
        for (change, bytes, served) in fetched {
            if let Err(fault) = self
                .receive(
                    core,
                    bytes,
                    served,
                    Some(Mode::ReadingBack),
                    change,
                    &session,
                    &mut unused,
                )
                .await
            {
                if fault.as_core().is_none() || fault.code == "storage" || fault.code == "internal"
                {
                    return Err(fault);
                }
                eprintln!(
                    "[trommi] finding: {} (reading a session's history)",
                    fault.code
                );
            }
        }
        core.commit()
    }

    /// Writes this device's `heads` register in every session group whose chains moved (9.0.7).
    async fn write_heads(&self, core: &mut Core, send: bool) -> Result<()> {
        core.heads_at = now_ms();
        let groups: Vec<(String, GroupId)> = core
            .groups
            .iter()
            .map(|(sid, g)| (sid.clone(), *g))
            .collect();
        for (sid, group) in groups {
            let value = self
                .vault
                .call(move |v: &mut Vault| v.heads_value(&group))
                .await??;
            let Some(value) = value else { continue };
            let name = format!("heads/{sid}");
            if core
                .kv_get(&name)
                .and_then(|v| v.as_str().map(String::from))
                .as_deref()
                == Some(&value)
            {
                continue;
            }
            let spec = Spec::Register {
                name: "heads".into(),
                value: Some(value.clone()),
            };
            // A group that takes no envelope now (stale, no key yet) gets its heads another time.
            if self.seal(core, group, spec, Vec::new()).await.is_ok() {
                core.kv_set(&name, &json!(value));
            }
        }
        core.commit()?;
        if send {
            self.pump(core).await?;
        }
        Ok(())
    }

    /// Posts what waits: the device's outbox (Commits, messages, KeyPackages), then this device's envelopes in
    /// their order. Stops at the first request the hub could not be reached for; that one and what follows are
    /// sent again later, unchanged.
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
        core.reload_outbox();
        // An envelope the hub voided for its epoch is sealed again, in the epoch the group stands in now.
        let again: Vec<Pending> = core.outbox.iter().filter(|p| p.rebuild).cloned().collect();
        for old in again {
            let group = b64_group(&old.group)?;
            let sealed = if old.resealed >= RESEALS {
                Err(Fault::new(
                    "wrong-epoch",
                    "the hub keeps refusing this envelope for its epoch",
                ))
            } else {
                self.seal(core, group, old.spec.clone(), old.files.clone())
                    .await
            };
            core.drop_pending(old.id);
            let first = old.first.unwrap_or(old.id);
            match sealed {
                Ok(mut new) => {
                    // What the first one's sender is told of is the envelope that stands in its place.
                    new.resealed = old.resealed + 1;
                    new.first = Some(first);
                    core.put_pending(&new);
                    if let Some(kept) = core.outbox.iter_mut().find(|p| p.id == new.id) {
                        *kept = new.clone();
                    }
                    core.replaced.insert(first, new);
                }
                Err(fault) => {
                    core.failed.insert(first, fault);
                }
            }
            core.commit()?;
        }
        let entries = self.vault.call(|v: &mut Vault| v.device.outbox()).await?;
        for entry in entries {
            let id = entry.id;
            let kind = entry.kind;
            let group = entry.group;
            match self.post_entry(&entry).await {
                Ok(accepted) => {
                    let cuts = core
                        .journal
                        .get(&side_key(TAG_CUTS, &[&id.to_be_bytes()]))
                        .and_then(|bytes| {
                            serde_json::from_slice::<Vec<(String, u64, String)>>(&bytes).ok()
                        })
                        .unwrap_or_default();
                    core.journal
                        .delete(side_key(TAG_CUTS, &[&id.to_be_bytes()]));
                    let now = now_ms();
                    self.vault
                        .call(move |v: &mut Vault| -> Result<()> {
                            v.device.outbox_accepted(id, accepted)?;
                            if let (true, Some(group)) = (
                                matches!(kind, OutboxKind::Commit | OutboxKind::GroupFounding),
                                group,
                            ) {
                                let cuts: Vec<Cut> = cuts
                                    .iter()
                                    .filter_map(|(device, seq, hash)| {
                                        Some(Cut {
                                            device: DeviceId::from_base64url(device).ok()?,
                                            seq: *seq,
                                            hash: Hash32::from_base64url(hash).ok()?,
                                        })
                                    })
                                    .collect();
                                v.note_epoch(&group, Some(now), &cuts, now)?;
                            }
                            Ok(())
                        })
                        .await??;
                    if kind == OutboxKind::KeyPackages {
                        core.kv_set(
                            "key_packages_unused",
                            &json!(trommi_core::device::SINGLE_USE_KEY_PACKAGES),
                        );
                    }
                    core.commit()?;
                    if matches!(kind, OutboxKind::Commit | OutboxKind::GroupFounding) {
                        self.refresh_groups(core).await?;
                        core.commit()?;
                    }
                }
                Err(fault) if is_transient(&fault) => {
                    self.online.store(false, Ordering::SeqCst);
                    return Ok(());
                }
                Err(fault) if fault.code == "lease-lost" || fault.code == "unauthorised" => {
                    return Err(fault)
                }
                Err(fault) => {
                    let code = fault
                        .as_core()
                        .unwrap_or(trommi_core::Error::Internal("refused by the hub"));
                    core.journal
                        .delete(side_key(TAG_CUTS, &[&id.to_be_bytes()]));
                    self.vault
                        .call(move |v: &mut Vault| v.device.outbox_refused(id, &code))
                        .await??;
                    core.failed.insert(u64::MAX - id, fault.clone());
                    core.commit()?;
                    if matches!(fault.code.as_str(), "not-member" | "removed-sender") {
                        return Err(fault);
                    }
                    eprintln!(
                        "[trommi] the hub refused a request of this device: {}",
                        fault.code
                    );
                }
            }
        }
        // This device's envelopes, in the order they were signed.
        let waiting: Vec<Pending> = core
            .outbox
            .iter()
            .filter(|pending| pending.change.is_none() && !pending.rebuild)
            .cloned()
            .collect();
        for pending in waiting {
            if core.model.room.outbox_blocked.is_some() {
                break;
            }
            let body = json!({ "envelope": pending.bytes });
            match self.hub.post("/v2/envelopes", &body).await {
                Ok(answer) => {
                    let change = answer.get("change").and_then(Value::as_u64);
                    if let Some(kept) = core.outbox.iter_mut().find(|p| p.id == pending.id) {
                        kept.change = change.or(Some(0));
                        let kept = kept.clone();
                        core.put_pending(&kept);
                    }
                    core.commit()?;
                }
                Err(fault) if is_transient(&fault) => {
                    self.online.store(false, Ordering::SeqCst);
                    return Ok(());
                }
                Err(fault) if fault.code == "lease-lost" || fault.code == "unauthorised" => {
                    return Err(fault)
                }
                Err(fault) if fault.extra.get("voided") == Some(&Value::Bool(true)) => {
                    // 9.0.8: the number is used up, the chain goes on. What an epoch change voided is sealed
                    // again in the new epoch: the wish stays in the outbox, marked, until the new envelope
                    // is written in its place. Anything else is the sender's to hear.
                    if fault.code == "wrong-epoch" {
                        if let Some(kept) = core.outbox.iter_mut().find(|p| p.id == pending.id) {
                            kept.rebuild = true;
                            let kept = kept.clone();
                            core.put_pending(&kept);
                        }
                        core.commit()?;
                        self.catch_up(core).await?;
                    } else {
                        core.drop_pending(pending.id);
                        core.failed.insert(pending.id, fault);
                        core.commit()?;
                    }
                    return Box::pin(self.pump(core)).await;
                }
                Err(fault) if fault.code == "group-behind" => {
                    // The hub has not reached the epoch this was sealed in; it is posted again later.
                    return Ok(());
                }
                Err(fault) if matches!(fault.code.as_str(), "not-member" | "removed-sender") => {
                    return Err(fault);
                }
                Err(fault) => {
                    // The hub took no number for it, and this device never signs that number again: the
                    // chain in this room stops here rather than fork.
                    eprintln!(
                        "[trommi] the hub refused an envelope of this device for good: {}",
                        fault.code
                    );
                    core.model.room.outbox_blocked = Some(fault.code.clone());
                    core.failed.insert(pending.id, fault);
                    core.commit()?;
                }
            }
        }
        Ok(())
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
            OutboxKind::RoomFounding
            | OutboxKind::ExternalCommit
            | OutboxKind::SealedKey
            | OutboxKind::RecoveryCode
            | OutboxKind::RecoveryCommit
            | OutboxKind::RecoveryFinish => {
                return Err(Fault::new("forbidden", "not a request of an agent device"))
            }
        };
        Ok(Accepted {
            change: answer.get("change").and_then(Value::as_u64),
        })
    }

    /// Seals an envelope of this device and stages it in the outbox. Nothing is posted.
    pub(crate) async fn seal(
        &self,
        core: &mut Core,
        group: GroupId,
        spec: Spec,
        files: Vec<String>,
    ) -> Result<Pending> {
        if let Some(code) = &core.model.room.outbox_blocked {
            return Err(Fault::new(
                "chain-halted",
                format!("the hub refused an earlier envelope of this session for good ({code})"),
            ));
        }
        self.active(core)?;
        let session = core
            .session_of_group(&group)
            .ok_or_else(|| Fault::new("forbidden", "an agent writes into session groups only"))?;
        let draft_spec = crate::agent::resolve(core, &session, &spec)?;
        let now = now_ms();
        // Sealed and put into the outbox in one go on the vault's thread: the chain's step and the envelope it
        // was for are staged together, whatever becomes of this call.
        let pending = self
            .vault
            .call(move |v: &mut Vault| -> Result<Pending> {
                let draft = crate::agent::draft(v, &group, &draft_spec, None, &files)?;
                let sealed = v.seal(&group, &draft, now)?;
                let prefix = side_key(TAG_PENDING, &[]);
                let id = v
                    .journal()
                    .scan(&prefix[..2])
                    .iter()
                    .filter_map(|(_, value)| serde_json::from_slice::<Pending>(value).ok())
                    .map(|pending| pending.id)
                    .max()
                    .unwrap_or(0)
                    + 1;
                let pending = Pending {
                    id,
                    group: b64(group.as_bytes()),
                    spec,
                    files,
                    bytes: b64(&sealed.bytes),
                    hash: sealed.hash.to_base64url(),
                    seq: sealed.seq,
                    change: None,
                    rebuild: false,
                    resealed: 0,
                    first: None,
                };
                v.journal().put(
                    side_key(TAG_PENDING, &[&id.to_be_bytes()]),
                    serde_json::to_vec(&pending)?,
                );
                Ok(pending)
            })
            .await??;
        core.outbox.push(pending.clone());
        Ok(pending)
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
        let pending = self.seal(&mut core, group, spec, files).await?;
        core.commit()?;
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
        if let Some(fault) = core.failed.remove(&pending.id) {
            return Err(fault);
        }
        // If the hub voided it for its epoch, another envelope stands in its place, under another number:
        // that one is what the caller is told of.
        let pending = core.replaced.remove(&pending.id).unwrap_or(pending);
        let object_id = trommi_core::envelope::object_id(&group, &self.me, pending.seq)
            .ok()
            .map(|id| hex(id.as_bytes()));
        let envelope_number = match core.outbox.iter().find(|p| p.id == pending.id) {
            Some(still) => still.change.filter(|change| *change > 0),
            None => Some(core.cursor),
        };
        if envelope_number.is_none() {
            self.wake.notify_one();
        }
        Ok(SentInfo {
            hash: pending.hash,
            object_id,
            envelope_number,
        })
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

    /// Remembers the Cuts of a Commit this device built, until the hub answered it.
    pub(crate) fn remember_cuts(core: &Core, outbox_id: u64, cuts: &[Cut]) {
        let rows: Vec<(String, u64, String)> = cuts
            .iter()
            .map(|cut| (cut.device.to_base64url(), cut.seq, cut.hash.to_base64url()))
            .collect();
        if let Ok(bytes) = serde_json::to_vec(&rows) {
            core.journal
                .put(side_key(TAG_CUTS, &[&outbox_id.to_be_bytes()]), bytes);
        }
    }

    /// A refusal of the hub for a request of the device's outbox since the last call, if any.
    pub(crate) fn take_refusal(core: &mut Core, outbox_id: u64) -> Option<Fault> {
        core.failed.remove(&(u64::MAX - outbox_id))
    }
}

/// What a log entry did, as far as the client acts on it.
enum LogOutcome {
    Nothing,
    Early,
    /// A Commit of a group this device is in was merged; how many findings its Cuts brought, and the group
    /// if a Cut dropped envelopes this device had accepted.
    Epoch(usize, Option<GroupId>),
    Keys(GroupId),
    Newer,
    /// The room enrolled this device; whether its inviter did.
    Enrolled(bool),
    Unenrolled,
    RemovedFrom(GroupId),
    Bad(&'static str),
}
