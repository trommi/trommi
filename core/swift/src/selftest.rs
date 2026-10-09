//! The core's self-test as one call: what both apps show on their information screen. It runs the protocol's
//! main paths on this machine, with devices in memory and nothing sent anywhere, and reports each step with its
//! time and the versions of what ran.

use crate::account::{generate_recovery_code, password_keys};
use crate::device::CoreDevice;
use crate::files::{FileDecryptor, FileEncryptor};
use crate::interim;
use crate::records::{
    Cut, LogEntry, LogEntryKind, LogFinding, OutboxKind, ProcessedKind, ReceivedKind,
};
use crate::store::MemoryStore;
use crate::{log_finding, open_apns_push, session_group_id, CoreError, ErrorCode};
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
        /// The state of the recovery construct in this build: `built`, or a warning that it is a stand-in.
        pub recovery: String,
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
        recovery: interim::RECOVERY.to_owned(),
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

/// The least a hub does, in memory: one change counter, one Commit per group and epoch, the ordered log, the
/// Welcomes and the newest GroupInfo of the room. It verifies nothing: the devices do.
#[derive(Default)]
struct Relay {
    change: u64,
    log: Vec<LogEntry>,
    /// Each Welcome with the change number of its Commit.
    welcomes: Vec<(u64, Vec<u8>)>,
    room_group_info: Vec<u8>,
}

impl Relay {
    /// Posts everything in the device's outbox and reports each as accepted.
    fn post(&mut self, device: &CoreDevice) -> Result<(), CoreError> {
        for entry in device.outbox()? {
            let part = |at: usize| entry.parts.get(at).cloned().unwrap_or_default();
            let group = entry.group.clone().unwrap_or_default();
            // Where the Commit, its GroupInfo and its Welcome stand among the parts of each kind.
            let commit = match entry.kind {
                OutboxKind::GroupFounding => Some((part(2), part(3), part(4))),
                OutboxKind::Commit => Some((part(0), part(1), part(2))),
                _ => None,
            };
            let change = match (entry.kind, commit) {
                (OutboxKind::RoomFounding, _) => {
                    self.room_group_info = part(0);
                    self.change += 1;
                    Some(self.change)
                }
                (_, Some((commit, group_info, welcome))) => {
                    self.change += 1;
                    if group.len() == RoomId::LEN {
                        self.room_group_info = group_info;
                    }
                    if !welcome.is_empty() {
                        self.welcomes.push((self.change, welcome));
                    }
                    self.log.push(LogEntry {
                        change: self.change,
                        group,
                        kind: LogEntryKind::Commit,
                        bytes: commit,
                        recovery_auth: None,
                    });
                    Some(self.change)
                }
                (OutboxKind::Message, _) => {
                    self.change += 1;
                    self.log.push(LogEntry {
                        change: self.change,
                        group,
                        kind: LogEntryKind::Message,
                        bytes: part(0),
                        recovery_auth: None,
                    });
                    Some(self.change)
                }
                _ => None,
            };
            device.outbox_accepted(entry.id, change)?;
        }
        Ok(())
    }

    /// Hands the device the log after its cursor, in order, with every Welcome at its place. Returns what the
    /// entries did; an entry that lies behind what the device holds is passed over.
    fn sync(
        &self,
        device: &CoreDevice,
        room: &[u8],
        now_ms: u64,
    ) -> Result<Vec<crate::Processed>, CoreError> {
        let mut done = Vec::new();
        let cursor = device.cursor()?;
        for entry in self.log.iter().filter(|entry| entry.change > cursor) {
            match device.process_log_entry(entry.clone()) {
                Ok(processed) => done.push(processed),
                Err(error) if log_finding(error.code()) == LogFinding::Duplicate => {}
                Err(error) => return Err(error),
            }
            for (_, welcome) in self
                .welcomes
                .iter()
                .filter(|(change, _)| *change == entry.change)
            {
                // A Welcome for another device does not open here: that is no finding.
                let _ = device.join_welcome(welcome.clone(), room.to_vec(), None, now_ms);
            }
        }
        Ok(done)
    }
}

/// Runs the self-test: two human devices and an agent device in memory found a room and a session, exchange a
/// message, agree on the content keys, remove a device, and one of them is opened again from its store; then a
/// file, a push, the hub's sign-in and the account's password keys. `now_ms` is the time: KeyPackages carry a
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
    let mut session_group = Vec::new();
    let mut key_before = Vec::new();

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
        room = first.found_room(generate_recovery_code()?, now_ms)?;
        relay.post(first)
    });
    run.step("it adds the second, which joins by its Welcome", || {
        let package = second.key_package(now_ms)?;
        first.add_human_device(second.id()?, package, now_ms)?;
        relay.post(first)?;
        let welcome = relay.welcomes.last().map(|(_, welcome)| welcome.clone());
        let welcome = welcome.ok_or_else(|| CoreError::internal("no Welcome was made"))?;
        let joined = second.join_welcome(welcome, room.clone(), Some(first.id()?), now_ms)?;
        expect(
            joined.offending.is_empty(),
            "the room holds a leaf that does not belong",
        )
    });
    run.step("both hold the same key for the room", || {
        let epoch = first.group(room.clone())?.epoch;
        expect(
            first.content_key(room.clone(), epoch)? == second.content_key(room.clone(), epoch)?,
            "the content keys differ",
        )
    });
    run.step("an agent device is enrolled and a session founded", || {
        first.change_agents(vec![agent.id()?], Vec::new(), now_ms)?;
        relay.post(first)?;
        agent.observe_room(relay.room_group_info.clone(), None)?;
        relay.sync(second, &room, now_ms)?;
        let packages = vec![second.key_package(now_ms)?, agent.key_package(now_ms)?];
        let session = first.found_session(agent.id()?, packages, now_ms)?;
        relay.post(first)?;
        session_group = session_group_id(room.clone(), session)?;
        relay.sync(second, &room, now_ms)?;
        relay.sync(agent, &room, now_ms)?;
        let epoch = first.group(session_group.clone())?.epoch;
        key_before = first.content_key(session_group.clone(), epoch)?;
        expect(
            key_before == second.content_key(session_group.clone(), epoch)?
                && key_before == agent.content_key(session_group.clone(), epoch)?,
            "the session's content keys differ",
        )
    });
    run.step("the agent's message opens at the others", || {
        let step = br#"{"text":"self-test"}"#.to_vec();
        agent.send_work_trail(session_group.clone(), vec![7; 16], 1, step.clone(), now_ms)?;
        relay.post(agent)?;
        let opened = relay.sync(first, &room, now_ms)?;
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
    run.step("the second is removed and gets no later key", || {
        let gone = Cut {
            device: second.id()?,
            seq: 0,
            hash: vec![0; 32],
        };
        first.remove_human_devices(vec![gone.clone()], now_ms)?;
        relay.post(first)?;
        first.clean_session(session_group.clone(), vec![gone], None, now_ms)?;
        relay.post(first)?;
        let seen = relay.sync(second, &room, now_ms)?;
        expect(
            seen.iter().any(|processed| processed.removed),
            "the removed device did not learn of its removal",
        )?;
        let epoch = first.group(session_group.clone())?.epoch;
        let key_after = first.content_key(session_group.clone(), epoch)?;
        expect(
            key_after != key_before,
            "the key did not change with the removal",
        )?;
        match second.content_key(session_group.clone(), epoch) {
            Err(error) if error.code() == ErrorCode::NoKey => Ok(()),
            _ => Err(CoreError::internal("the removed device holds the new key")),
        }
    });
    run.step("the first is opened again from its store", || {
        let id = first.id()?;
        let epoch = first.group(session_group.clone())?.epoch;
        let key = first.content_key(session_group.clone(), epoch)?;
        first.close();
        let again = CoreDevice::open_on(Box::new(store.clone()))?;
        expect(
            again.id()? == id && again.content_key(session_group.clone(), epoch)? == key,
            "the device opened from its store is another",
        )?;
        let signed =
            again.hub_sign_in(room.clone(), "https://hub.example".to_owned(), vec![9; 32])?;
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
