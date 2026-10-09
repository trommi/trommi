//! The core's self-test as one call: what both apps show on their information screen. It runs the protocol's
//! main paths on this machine, with devices in memory and nothing sent anywhere, and reports each step with its
//! time and the versions of what ran.

use crate::account::{generate_recovery_code, password_keys};
use crate::content::{Draft, DraftKind, EnvelopeOutcome, ReceivedEnvelope};
use crate::device::CoreDevice;
use crate::files::{FileDecryptor, FileEncryptor};
use crate::invite::{InviteRole, InviteStepKind, SignedOffer, SignedRequest, SignedReveal};
use crate::records::{
    LogEntry, LogEntryKind, LogFinding, OutboxKind, Processed, ProcessedKind, ReceivedKind,
};
use crate::recovery::{recovery_anchor, ServedCommit, ServedGroup, ServedRoom};
use crate::store::MemoryStore;
use crate::{log_finding, open_apns_push, session_group_id, CoreError};
use trommi_core::crypto::{Secret, SystemEntropy};
use trommi_core::hub_auth::{self, HubAddress, IssuedChallenge, SignedHubAuth};
use trommi_core::ids::RoomId;
use trommi_core::push;

/// The version of OpenMLS this library is built on: the exact pin of the workspace.
pub const OPENMLS: &str = "0.9.1";
/// OpenMLS's crypto provider and its version: the exact pin of the workspace.
pub const PROVIDER: &str = "openmls_rust_crypto 0.6.0";

record! {
    /// The versions of what a build is made of.
    pub struct Versions {
        /// `trommi-core`.
        pub core: String,
        /// OpenMLS.
        pub openmls: String,
        /// OpenMLS's crypto provider.
        pub provider: String,
        /// This binding and the generator it is made with.
        pub binding: String,
    }
}

record! {
    /// One step of the self-test.
    pub struct SelfTestStep {
        /// What the step does.
        pub name: String,
        /// Whether it passed.
        pub ok: bool,
        /// How long it took, in microseconds.
        pub micros: u64,
        /// For a failed step, the code and text of its error.
        pub detail: String,
    }
}

record! {
    /// What the self-test found.
    pub struct SelfTestReport {
        /// Whether every step passed.
        pub ok: bool,
        /// The steps in the order they ran. The test stops at the first that fails.
        pub steps: Vec<SelfTestStep>,
        /// The time of all steps together, in microseconds.
        pub micros: u64,
        /// What ran.
        pub versions: Versions,
    }
}

/// The versions of this build.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn versions() -> Versions {
    let generator = if cfg!(feature = "js") {
        "wasm-bindgen 0.2.129"
    } else {
        "UniFFI 0.32.2"
    };
    Versions {
        core: trommi_core::VERSION.to_owned(),
        openmls: OPENMLS.to_owned(),
        provider: PROVIDER.to_owned(),
        binding: format!("{} ({generator})", env!("CARGO_PKG_VERSION")),
    }
}

/// Microseconds on a clock that only moves forward, from the platform: the test measures, it does not date.
#[cfg(not(feature = "js"))]
fn stopwatch() -> impl Fn() -> u64 {
    let start = std::time::Instant::now();
    move || u64::try_from(start.elapsed().as_micros()).unwrap_or(u64::MAX)
}

/// Microseconds from the browser's `performance.now()`, in the page or in a worker.
#[cfg(feature = "js")]
fn stopwatch() -> impl Fn() -> u64 {
    use wasm_bindgen::{JsCast, JsValue};
    let performance =
        js_sys::Reflect::get(&js_sys::global(), &JsValue::from_str("performance")).ok();
    let now = move || {
        let performance = performance.as_ref()?;
        let function = js_sys::Reflect::get(performance, &JsValue::from_str("now")).ok()?;
        let function = function.dyn_ref::<js_sys::Function>()?;
        function.call0(performance).ok()?.as_f64()
    };
    let start = now().unwrap_or(0.0);
    move || ((now().unwrap_or(start) - start).max(0.0) * 1000.0) as u64
}

/// The steps as they run.
struct Run<C: Fn() -> u64> {
    clock: C,
    steps: Vec<SelfTestStep>,
    failed: bool,
}

impl<C: Fn() -> u64> Run<C> {
    /// Runs one step, unless an earlier one failed.
    fn step(&mut self, name: &str, step: impl FnOnce() -> Result<(), CoreError>) {
        if self.failed {
            return;
        }
        let before = (self.clock)();
        let result = step();
        let micros = (self.clock)().saturating_sub(before);
        self.failed = result.is_err();
        self.steps.push(SelfTestStep {
            name: name.to_owned(),
            ok: result.is_ok(),
            micros,
            detail: result
                .err()
                .map_or_else(String::new, |error| error.to_string()),
        });
    }
}

/// A step's own finding: something came out other than it must.
fn expect(holds: bool, what: &str) -> Result<(), CoreError> {
    if holds {
        Ok(())
    } else {
        Err(CoreError::internal(what))
    }
}

/// One thing the hub hands on in its one order: an entry of the log, or a stored envelope.
enum Fed {
    Log(LogEntry),
    Envelope { change: u64, bytes: Vec<u8> },
}

impl Fed {
    fn change(&self) -> u64 {
        match self {
            Fed::Log(entry) => entry.change,
            Fed::Envelope { change, .. } => *change,
        }
    }
}

/// The least a hub does, in memory: one change counter, one order of Commits, messages and envelopes, the
/// Welcomes, and what it serves a device that comes with the recovery code. It verifies nothing: the devices
/// do.
#[derive(Default)]
struct Relay {
    change: u64,
    feed: Vec<Fed>,
    /// Each Welcome with the change number of its Commit.
    welcomes: Vec<(u64, Vec<u8>)>,
    /// The room group's GroupInfo of every epoch, from its founding.
    room_infos: Vec<Vec<u8>>,
    /// Per session group: its founding GroupInfo and its newest.
    session_infos: Vec<(Vec<u8>, Vec<u8>, Vec<u8>)>,
    /// Every SealedKey posted.
    rows: Vec<Vec<u8>>,
}

impl Relay {
    fn next(&mut self) -> u64 {
        self.change += 1;
        self.change
    }

    /// Posts everything in the device's outbox and reports each as accepted.
    fn post(&mut self, device: &CoreDevice) -> Result<(), CoreError> {
        for entry in device.outbox()? {
            let part = |at: usize| entry.parts.get(at).cloned().unwrap_or_default();
            let group = entry.group.clone().unwrap_or_default();
            // Where the Commit, its GroupInfo, its Welcome, its SealedKey and its RecoveryAuth stand among
            // the parts of each kind.
            let commit = match entry.kind {
                OutboxKind::GroupFounding => {
                    self.rows.push(part(1));
                    self.session_infos.push((group.clone(), part(0), part(0)));
                    Some((part(2), part(3), part(4), part(5), None))
                }
                OutboxKind::Commit => Some((part(0), part(1), part(2), part(3), None)),
                OutboxKind::ExternalCommit => {
                    Some((part(0), part(1), Vec::new(), part(2), Some(part(3))))
                }
                _ => None,
            };
            let change = match (entry.kind, commit) {
                (OutboxKind::RoomFounding, _) => {
                    self.room_infos.push(part(0));
                    self.rows.push(part(1));
                    Some(self.next())
                }
                (_, Some((commit, group_info, welcome, sealed_key, recovery_auth))) => {
                    let change = self.next();
                    self.rows.push(sealed_key);
                    if group.len() == RoomId::LEN {
                        self.room_infos.push(group_info);
                    } else if let Some(session) = self
                        .session_infos
                        .iter_mut()
                        .find(|(id, _, _)| *id == group)
                    {
                        session.2 = group_info;
                    }
                    if !welcome.is_empty() {
                        self.welcomes.push((change, welcome));
                    }
                    self.feed.push(Fed::Log(LogEntry {
                        change,
                        group,
                        kind: LogEntryKind::Commit,
                        bytes: commit,
                        recovery_auth,
                    }));
                    Some(change)
                }
                (OutboxKind::Message, _) => {
                    let change = self.next();
                    self.feed.push(Fed::Log(LogEntry {
                        change,
                        group,
                        kind: LogEntryKind::Message,
                        bytes: part(0),
                        recovery_auth: None,
                    }));
                    Some(change)
                }
                (OutboxKind::Envelope, _) => {
                    let change = self.next();
                    self.feed.push(Fed::Envelope {
                        change,
                        bytes: part(0),
                    });
                    Some(change)
                }
                _ => None,
            };
            device.outbox_accepted(entry.id, change)?;
        }
        Ok(())
    }

    /// Hands the device everything after its cursor, in order, with every Welcome at its place. Returns what
    /// the log's entries did and what became of the envelopes; an entry that lies behind what the device
    /// holds is passed over.
    fn sync(
        &self,
        device: &CoreDevice,
        room: &[u8],
        now_ms: u64,
    ) -> Result<(Vec<Processed>, Vec<ReceivedEnvelope>), CoreError> {
        let mut done = Vec::new();
        let mut envelopes = Vec::new();
        let cursor = device.cursor()?;
        for fed in self.feed.iter().filter(|fed| fed.change() > cursor) {
            match fed {
                Fed::Log(entry) => match device.process_log_entry(entry.clone(), now_ms) {
                    Ok(processed) => done.push(processed),
                    Err(error) if log_finding(error.code()) == LogFinding::Duplicate => {}
                    Err(error) => return Err(error),
                },
                Fed::Envelope { change, bytes } => envelopes.push(device.receive_envelope(
                    bytes.clone(),
                    *change,
                    true,
                    None,
                    now_ms,
                )?),
            }
            for (_, welcome) in self.welcomes.iter().filter(|(at, _)| *at == fed.change()) {
                // A Welcome for another device does not open here: that is no finding.
                let _ = device.join_welcome(welcome.clone(), room.to_vec(), None, now_ms);
            }
        }
        Ok((done, envelopes))
    }

    /// One invite from its opening to its Commit: the new device asks, both compute the same code, the inviter
    /// confirms it and posts the Commit. An agent device starts to follow the room before that Commit.
    fn invite(
        &mut self,
        inviter: &CoreDevice,
        newcomer: &CoreDevice,
        role: InviteRole,
        now_ms: u64,
    ) -> Result<(), CoreError> {
        let hub = "https://hub.example".to_owned();
        let app = "https://app.example".to_owned();
        let opened = inviter.invite_open(role, None, app, hub, now_ms)?;
        let offer = SignedOffer {
            offer: opened.offer.clone(),
            signature: opened.signature.clone(),
        };
        let asked = newcomer.join_request(opened.link.clone(), offer, now_ms)?;
        let request = SignedRequest {
            request: asked.request,
            mac: asked.mac,
            signature: asked.signature,
        };
        let accepted = inviter.invite_accept(opened.invite_id.clone(), request, now_ms)?;
        let shown = newcomer.join_reveal(SignedReveal {
            reveal: accepted.reveal.clone(),
            signature: accepted.signature.clone(),
        })?;
        expect(
            shown == accepted.code && shown.emoji.len() == 6,
            "the two sides show different codes",
        )?;
        if role == InviteRole::Agent {
            let at = usize::try_from(asked.room_epoch).ok();
            let info = at.and_then(|at| self.room_infos.get(at)).cloned();
            newcomer.join_observe(info.unwrap_or_default())?;
        }
        let confirmed = inviter.invite_confirm(
            opened.invite_id.clone(),
            accepted.code.numbers.clone(),
            accepted.request_hash.clone(),
            true,
            now_ms,
        )?;
        expect(
            confirmed.is_some(),
            "the confirmed invite was not committed",
        )?;
        self.post(inviter)
    }

    /// A group as the hub serves it to a device that verifies it from its founding.
    fn served(&self, group: &[u8], founding: &[u8], current: &[u8]) -> ServedGroup {
        ServedGroup {
            founding: founding.to_vec(),
            commits: self
                .feed
                .iter()
                .filter_map(|fed| match fed {
                    Fed::Log(entry)
                        if entry.group == group && entry.kind == LogEntryKind::Commit =>
                    {
                        Some(ServedCommit {
                            change: entry.change,
                            commit: entry.bytes.clone(),
                            recovery_auth: entry.recovery_auth.clone(),
                        })
                    }
                    _ => None,
                })
                .collect(),
            current: current.to_vec(),
        }
    }

    /// The room as the hub serves it to a device that comes with the recovery code.
    fn served_room(&self, room: &[u8], code: &[u8]) -> Result<ServedRoom, CoreError> {
        let anchor = recovery_anchor(code.to_vec(), room.to_vec(), self.rows.clone())?;
        let info = |epoch: Option<usize>| {
            epoch
                .and_then(|epoch| self.room_infos.get(epoch))
                .cloned()
                .ok_or_else(|| CoreError::internal("the room has no such GroupInfo"))
        };
        Ok(ServedRoom {
            room: room.to_vec(),
            group: self.served(
                room,
                &info(Some(0))?,
                &info(self.room_infos.len().checked_sub(1))?,
            ),
            anchor: info(usize::try_from(anchor.epoch).ok())?,
            rows: self.rows.clone(),
            links: Vec::new(),
            sessions: self
                .session_infos
                .iter()
                .map(|(group, founding, current)| self.served(group, founding, current))
                .collect(),
        })
    }
}

/// A Chat message of a session, as a draft.
fn chat(session: &[u8], text: &str) -> Draft {
    Draft {
        kind: DraftKind::SessionChat,
        session: Some(session.to_vec()),
        card: None,
        board: None,
        group: None,
        name: None,
        value: None,
        object_id: None,
        request_id: None,
        choices: None,
        closes: None,
        closed: None,
        allow: None,
        urgency: None,
        push: None,
        expires_at: None,
        payload: Some(format!(r#"{{"content_type":"message","text":"{text}"}}"#).into_bytes()),
    }
}

/// Whether one of `envelopes` was applied and carries a Chat message with `text`.
fn brought(envelopes: &[ReceivedEnvelope], text: &str) -> bool {
    envelopes.iter().any(|envelope| {
        envelope.outcome == EnvelopeOutcome::Applied
            && envelope
                .payload
                .as_ref()
                .is_some_and(|payload| String::from_utf8_lossy(payload).contains(text))
    })
}

/// Runs the self-test: two human devices and an agent device in memory found a room and a session, exchange a
/// message, agree on the content keys, remove a device, one of them is opened again from its store, and a new
/// device joins with the recovery code; then a file, a push, the hub's sign-in and the account's password keys. `now_ms` is the time: KeyPackages carry a
/// lifetime that is checked against the clock.
///
/// The last step derives the password keys and is the slow one (Argon2id over 64 MiB): call this off the main
/// thread.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn self_test(now_ms: u64) -> SelfTestReport {
    let clock = stopwatch();
    let mut run = Run {
        clock: &clock,
        steps: Vec::new(),
        failed: false,
    };
    let outcome =
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| scenario(&mut run, now_ms)));
    if outcome.is_err() {
        run.steps.push(SelfTestStep {
            name: "the self-test".to_owned(),
            ok: false,
            micros: 0,
            detail: "internal: a step failed inside the core".to_owned(),
        });
        run.failed = true;
    }
    SelfTestReport {
        ok: !run.failed,
        steps: run.steps,
        micros: clock(),
        versions: versions(),
    }
}

fn scenario<C: Fn() -> u64>(run: &mut Run<C>, now_ms: u64) {
    let store = MemoryStore::default();
    let mut relay = Relay::default();
    let mut devices: Vec<CoreDevice> = Vec::new();
    let mut room = Vec::new();
    let mut session = Vec::new();
    let mut session_group = Vec::new();
    let mut code = Vec::new();

    run.step("three devices make their keys", || {
        devices.push(CoreDevice::create_on(Box::new(store.clone()))?);
        devices.push(CoreDevice::create_on(Box::new(MemoryStore::default()))?);
        devices.push(CoreDevice::create_on(Box::new(MemoryStore::default()))?);
        Ok(())
    });
    let (Some(first), Some(second), Some(agent)) =
        (devices.first(), devices.get(1), devices.get(2))
    else {
        return;
    };

    run.step("the first founds a room", || {
        code = generate_recovery_code()?;
        room = first.found_room(code.clone(), now_ms)?;
        relay.post(first)
    });
    run.step(
        "it invites the second by link: both show the same six emoji",
        || {
            relay.invite(first, second, InviteRole::Human, now_ms)?;
            let welcome = relay.welcomes.last().map(|(_, welcome)| welcome.clone());
            let welcome = welcome.ok_or_else(|| CoreError::internal("no Welcome was made"))?;
            let joined = second.join_invited(welcome, now_ms)?;
            expect(
                joined.offending.is_empty(),
                "the room holds a leaf that does not belong",
            )?;
            // What follows an invite: the history is handed over.
            for step in first.invite_steps()? {
                if step.kind == InviteStepKind::Handover {
                    first.invite_handover(step.invite_id)?;
                }
            }
            relay.post(first)?;
            let epoch = first.group(room.clone())?.epoch;
            expect(
                first.holds_key(room.clone(), epoch)? && second.holds_key(room.clone(), epoch)?,
                "the room's key is not held by both",
            )
        },
    );
    run.step("an agent device is invited and a session founded", || {
        relay.invite(first, agent, InviteRole::Agent, now_ms)?;
        relay.sync(second, &room, now_ms)?;
        let found = first
            .invite_steps()?
            .into_iter()
            .find(|step| step.kind == InviteStepKind::FoundSession)
            .and_then(|step| step.key_package)
            .ok_or_else(|| CoreError::internal("the invite does not ask for a session"))?;
        let packages = vec![second.key_package(now_ms)?, found];
        session = first.found_session(agent.id()?, packages, now_ms)?;
        relay.post(first)?;
        session_group = session_group_id(room.clone(), session.clone())?;
        relay.sync(second, &room, now_ms)?;
        relay.sync(agent, &room, now_ms)?;
        expect(
            agent.group(session_group.clone())?.leaves.len() == 3,
            "the session does not hold its three devices",
        )
    });
    run.step(
        "a Chat message sealed by the first opens at the others",
        || {
            first.seal(
                chat(&session, "the first message"),
                None,
                Vec::new(),
                now_ms,
            )?;
            relay.post(first)?;
            let (_, at_second) = relay.sync(second, &room, now_ms)?;
            let (_, at_agent) = relay.sync(agent, &room, now_ms)?;
            expect(
                brought(&at_second, "the first message") && brought(&at_agent, "the first message"),
                "the message did not open at both",
            )
        },
    );
    run.step("the agent's work trail opens at the first", || {
        let step = br#"{"text":"self-test"}"#.to_vec();
        agent.send_work_trail(session_group.clone(), vec![7; 16], 1, step.clone(), now_ms)?;
        relay.post(agent)?;
        let (opened, _) = relay.sync(first, &room, now_ms)?;
        let message = opened
            .iter()
            .filter(|processed| processed.kind == ProcessedKind::Message)
            .find_map(|processed| processed.message.as_ref());
        expect(
            message.is_some_and(|message| {
                message.kind == ReceivedKind::WorkTrail
                    && message.payload == step
                    && message.number == 1
            }),
            "the message did not arrive as it was sent",
        )
    });
    run.step(
        "the second is removed and reads nothing written after",
        || {
            relay.sync(second, &room, now_ms)?;
            let gone = second.id()?;
            first.remove_human_devices(vec![first.cut_of(room.clone(), gone.clone())?], now_ms)?;
            relay.post(first)?;
            let cut = first.cut_of(session_group.clone(), gone)?;
            first.clean_session(session_group.clone(), vec![cut], None, now_ms)?;
            relay.post(first)?;
            first.seal(
                chat(&session, "after the removal"),
                None,
                Vec::new(),
                now_ms,
            )?;
            relay.post(first)?;
            let (seen, envelopes) = relay.sync(second, &room, now_ms)?;
            expect(
                seen.iter().any(|processed| processed.removed),
                "the removed device did not learn of its removal",
            )?;
            expect(
                !brought(&envelopes, "after the removal"),
                "the removed device read on",
            )?;
            let epoch = first.group(session_group.clone())?.epoch;
            expect(
                first.holds_key(session_group.clone(), epoch)?
                    && !second.holds_key(session_group.clone(), epoch)?,
                "the removed device holds the new key",
            )?;
            let (_, at_agent) = relay.sync(agent, &room, now_ms)?;
            expect(
                brought(&at_agent, "after the removal"),
                "the agent did not read on",
            )
        },
    );
    run.step("the first is opened again from its store", || {
        let id = first.id()?;
        first.close();
        let again = CoreDevice::open_on(Box::new(store.clone()))?;
        expect(
            again.id()? == id && again.group(session_group.clone())?.leaves.len() == 2,
            "the device opened from its store is another",
        )?;
        let signed = again.hub_sign_in("https://hub.example".to_owned(), vec![9; 32])?;
        let hub = HubAddress::parse("https://hub.example")?;
        let issued = IssuedChallenge {
            challenge: [9; 32],
            expires_at: now_ms.saturating_add(1000),
        };
        let signed = SignedHubAuth {
            auth: signed.auth,
            signature: signed.signature,
        };
        let device = hub_auth::verify(&signed, &RoomId::from_slice(&room)?, &hub, &issued, now_ms)?;
        expect(
            device.as_bytes().as_slice() == id,
            "the sign-in is not this device's",
        )
    });
    run.step(
        "a new device joins with the recovery code and holds the earlier key",
        || {
            let newcomer = CoreDevice::create_on(Box::new(MemoryStore::default()))?;
            let served = relay.served_room(&room, &code)?;
            let joined = newcomer.join_room_with_code(code.clone(), served, now_ms)?;
            expect(
                joined.unverified.is_empty() && joined.missing_link.is_none(),
                "the room did not verify whole",
            )?;
            relay.post(&newcomer)?;
            expect(
                newcomer.is_human()? && newcomer.holds_recovery_mac()?,
                "the join left no human device",
            )?;
            let (group, founding, current) = relay
                .session_infos
                .first()
                .cloned()
                .ok_or_else(|| CoreError::internal("no session was founded"))?;
            newcomer.join_session_with_code(
                code.clone(),
                relay.served(&group, &founding, &current),
                now_ms,
            )?;
            relay.post(&newcomer)?;
            // The epoch the session's first message was written in is long over: the code opens its key.
            expect(
                newcomer.holds_key(session_group.clone(), 1)?
                    && newcomer.key_is_confirmed(session_group.clone(), 1)?,
                "the code did not open the session's earlier key",
            )
        },
    );
    run.step("a file is encrypted and decrypted piece by piece", || {
        let plain: Vec<u8> = (0..200_000u32).map(|at| (at % 251) as u8).collect();
        let encryptor = FileEncryptor::new()?;
        let mut stored = Vec::new();
        for piece in plain.chunks(50_000) {
            stored.extend(encryptor.update(piece.to_vec())?);
        }
        let end = encryptor.finish()?;
        stored.extend(end.stored);
        let decryptor = FileDecryptor::new(end.file.clone())?;
        let mut opened = Vec::new();
        for piece in stored.chunks(70_000) {
            opened.extend(decryptor.update(piece.to_vec())?);
        }
        opened.extend(decryptor.finish()?);
        expect(opened == plain, "the file came back changed")?;
        if let Some(byte) = stored.get_mut(100) {
            *byte ^= 1;
        }
        let tampered = FileDecryptor::new(end.file)?;
        let refused = tampered
            .update(stored)
            .and_then(|_| tampered.finish())
            .is_err();
        expect(refused, "a changed file was accepted")
    });
    run.step("a push opens under the app's key", || {
        let key = Secret::<32>::random(&mut SystemEntropy)?;
        let note = push::ApnsPush {
            room_id: RoomId::from_slice(&room)?,
            change: 7,
            urgency: 2,
            ticket: vec![1, 2, 3],
        };
        let sealed = push::seal(&key, &note, &mut SystemEntropy)?;
        let opened = open_apns_push(key.expose().to_vec(), sealed)?;
        expect(
            opened.change == 7 && opened.room_id == room,
            "the push came back changed",
        )
    });
    run.step("the account's password keys (Argon2id)", || {
        let keys = password_keys(
            "self-test@example.org".to_owned(),
            "a password for the self-test".to_owned(),
            None,
        )?;
        expect(keys.auth_key != keys.wrap_key, "the two keys are one")
    });
}
