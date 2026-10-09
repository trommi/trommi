//! The device: the one stateful object an app holds, as plain calls with plain data.
//!
//! Each call is one of the core's device (`trommi_core::device`), whose documentation is the full text. What this
//! layer adds: ids and bytes are checked at the edge (`bad-format`), one caller is inside at a time, and a device
//! that failed inside the core is closed for good.
//!
//! **How a host uses it.** Open the device over its store. Every operation writes its new state and everything
//! it wants sent in one write; nothing is handed back for sending except through [`CoreDevice::outbox`]. Post
//! each entry, then report the hub's answer with [`CoreDevice::outbox_accepted`] or
//! [`CoreDevice::outbox_refused`]. After a restart the same entries are listed again and are sent again
//! unchanged. Feed the hub's log to [`CoreDevice::process_log_entry`] in the hub's order.
//!
//! **Time** is the host's: every call that needs it takes `now_ms`, milliseconds since 1970. **Randomness** is
//! the system's source, read inside the core.

use crate::error::core_error;
use crate::guard::Guarded;
use crate::interim::{self, InterimRecovery};
use crate::records::{
    board_id, device_id, group_id, hash32, room_id, session_id, turn_id, Cut, GroupSummary,
    HandoverSent, Joined, LogEntry, LogEntryKind, LogFinding, OutboxEntry, Processed, Replacement,
    RoomRoles, SignedHubAuth,
};
use crate::store::{AnyStore, Seed};
use crate::{CoreError, ErrorCode};
use std::sync::PoisonError;
use trommi_core::crypto::{Secret, SigningKey, SystemEntropy};
use trommi_core::device::{self as core, Accepted, Device, LogKind, WelcomeExpectation};
use trommi_core::hub_auth::{self, HubAddress, CHALLENGE_LEN};
use trommi_core::store::Storage;

/// The core's device over any store. The core's type is not `Send` only because it holds the recovery
/// construct as a boxed trait object without that bound.
struct Inner(Device<AnyStore>);

// SAFETY: every part of the device is owned data that may move between threads. The one part the compiler
// cannot see through is the boxed recovery construct, and the only value ever put there is `InterimRecovery`,
// a struct without fields. The device is reached only through `Guarded`, one thread at a time.
unsafe impl Send for Inner {}

/// One device: its signature key, the groups it is a leaf of, its content keys and its outbox, over the store
/// the host gave it. Exactly one such object works on a stored state at a time.
#[cfg_attr(feature = "uniffi", derive(uniffi::Object))]
pub struct CoreDevice {
    device: Guarded<Inner>,
    seed: Seed,
    #[cfg(feature = "js")]
    writes: crate::store::Writes,
}

impl CoreDevice {
    /// The core's device over `store`, new or as stored, and where its key's seed is found.
    fn build(
        store: Box<dyn Storage + Send>,
        create: bool,
    ) -> Result<(Guarded<Inner>, Seed), CoreError> {
        let (store, seed) = AnyStore::new(store);
        let opened = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            if create {
                Device::create(store, Box::new(SystemEntropy), Box::new(InterimRecovery))
            } else {
                Device::open(store, Box::new(SystemEntropy), Box::new(InterimRecovery))
            }
        }))
        .map_err(|_| CoreError::internal("the device failed to open inside the core"))??;
        Ok((Guarded::new(Inner(opened)), seed))
    }

    /// A new device in the empty store `store`: a fresh signature key, no room yet. `storage` when the store
    /// is not empty.
    pub fn create_on(store: Box<dyn Storage + Send>) -> Result<Self, CoreError> {
        let (device, seed) = Self::build(store, true)?;
        Ok(Self {
            device,
            seed,
            #[cfg(feature = "js")]
            writes: Default::default(),
        })
    }

    /// The device `store` holds. `storage` when anything in it does not decode or fit together.
    pub fn open_on(store: Box<dyn Storage + Send>) -> Result<Self, CoreError> {
        let (device, seed) = Self::build(store, false)?;
        Ok(Self {
            device,
            seed,
            #[cfg(feature = "js")]
            writes: Default::default(),
        })
    }

    fn read<R>(
        &self,
        call: impl FnOnce(&Device<AnyStore>) -> Result<R, CoreError>,
    ) -> Result<R, CoreError> {
        self.device.run(|inner| call(&inner.0))
    }

    fn write<R>(
        &self,
        call: impl FnOnce(&mut Device<AnyStore>) -> Result<R, CoreError>,
    ) -> Result<R, CoreError> {
        self.device.run(|inner| call(&mut inner.0))
    }
}

/// The browser's way in: the page read the store before, and takes the writes after every call.
#[cfg(feature = "js")]
impl CoreDevice {
    /// A new device over what the page loaded, which must be an empty store.
    pub fn create_loaded(loaded: crate::store::StoredState) -> Result<Self, CoreError> {
        let (store, writes) = crate::store::QueueStore::new(loaded);
        let (device, seed) = Self::build(Box::new(store), true)?;
        Ok(Self {
            device,
            seed,
            writes,
        })
    }

    /// The device that what the page loaded holds.
    pub fn open_loaded(loaded: crate::store::StoredState) -> Result<Self, CoreError> {
        let (store, writes) = crate::store::QueueStore::new(loaded);
        let (device, seed) = Self::build(Box::new(store), false)?;
        Ok(Self {
            device,
            seed,
            writes,
        })
    }

    /// The writes made since the last call of this, oldest first: the page stores each in one transaction
    /// before it lets the result of the call that made them reach anyone.
    pub fn take_writes(&self) -> Vec<crate::store::StoreWrite> {
        std::mem::take(&mut *self.writes.lock().unwrap_or_else(PoisonError::into_inner))
    }
}

#[cfg(feature = "uniffi")]
#[uniffi::export]
impl CoreDevice {
    /// A new device in the empty store `store`: a fresh signature key, no room yet. `storage` when the store
    /// is not empty.
    #[uniffi::constructor]
    pub fn create(store: std::sync::Arc<dyn crate::store::CoreStore>) -> Result<Self, CoreError> {
        Self::create_on(Box::new(crate::store::ForeignStore(store)))
    }

    /// The device `store` holds. `storage` when anything in it does not decode or fit together.
    #[uniffi::constructor]
    pub fn open(store: std::sync::Arc<dyn crate::store::CoreStore>) -> Result<Self, CoreError> {
        Self::open_on(Box::new(crate::store::ForeignStore(store)))
    }
}

#[cfg_attr(feature = "uniffi", uniffi::export)]
impl CoreDevice {
    /// Closes the device and wipes what it holds in memory. Every later call is refused; the stored state is
    /// untouched and can be opened again.
    pub fn close(&self) {
        self.device.close();
        *self.seed.lock().unwrap_or_else(PoisonError::into_inner) = None;
    }

    /// The device id: its signature public key, 32 bytes.
    pub fn id(&self) -> Result<Vec<u8>, CoreError> {
        self.read(|device| Ok(device.id().as_bytes().to_vec()))
    }

    /// The room this device belongs to, once it founded or joined one: 32 bytes.
    pub fn room(&self) -> Result<Option<Vec<u8>>, CoreError> {
        self.read(|device| Ok(device.room().map(|room| room.as_bytes().to_vec())))
    }

    /// The highest change number of the hub's log this device processed.
    pub fn cursor(&self) -> Result<u64, CoreError> {
        self.read(|device| Ok(device.cursor()))
    }

    /// Whether this device is a human device now.
    pub fn is_human(&self) -> Result<bool, CoreError> {
        self.read(|device| Ok(device.is_human()))
    }

    /// Whether this object is still the owner of its stored state. It is not once a write met a conflict:
    /// another owner wrote. Every operation then answers `storage`, the outbox is empty, and the state is
    /// opened again under the store's lock.
    pub fn is_owner(&self) -> Result<bool, CoreError> {
        self.read(|device| Ok(device.is_owner()))
    }

    /// The room's roles at its newest epoch as this device knows them; none before it follows a room.
    pub fn room_roles(&self) -> Result<Option<RoomRoles>, CoreError> {
        self.read(|device| {
            Ok(device
                .room_history()
                .map(|history| RoomRoles::from(history.newest())))
        })
    }

    /// The groups this device is a leaf of.
    pub fn groups(&self) -> Result<Vec<GroupSummary>, CoreError> {
        self.read(|device| Ok(device.groups()?.into_iter().map(Into::into).collect()))
    }

    /// One group this device is a leaf of; `not-found` otherwise.
    pub fn group(&self, group: Vec<u8>) -> Result<GroupSummary, CoreError> {
        self.read(|device| Ok(device.group(&group_id(&group)?)?.into()))
    }

    /// The content key of `group` at `epoch`, 32 bytes; `no-key` when it is not held, or the group failed its
    /// first contact. The key opens and seals everything stored for that group and epoch: it is handed to the
    /// code that does that and to nothing else, and never logged or stored outside the device's store.
    pub fn content_key(&self, group: Vec<u8>, epoch: u64) -> Result<Vec<u8>, CoreError> {
        self.read(|device| {
            let key = device.content_key(&group_id(&group)?, epoch)?;
            Ok(key.expose().to_vec())
        })
    }

    /// Everything waiting to be sent, in the order to send it. An entry stays until the hub's answer was
    /// reported; a Commit refused with `epoch-taken` is held back until the log decided it.
    pub fn outbox(&self) -> Result<Vec<OutboxEntry>, CoreError> {
        self.read(|device| Ok(device.outbox().into_iter().map(Into::into).collect()))
    }

    /// The hub accepted the outbox entry `id`: the entry goes and its consequence is applied in the same
    /// write. `change` is the change number the hub gave it, where it gives one.
    pub fn outbox_accepted(&self, id: u64, change: Option<u64>) -> Result<(), CoreError> {
        self.write(|device| Ok(device.outbox_accepted(id, Accepted { change })?))
    }

    /// The hub refused the outbox entry `id` with `code`. `epoch-taken` for a Commit: it is held back, and the
    /// caller processes the log, which decides it. Any other refusal undoes what the entry was for. A code
    /// this version does not know is reported as `internal` and undoes the entry like any other.
    pub fn outbox_refused(&self, id: u64, code: ErrorCode) -> Result<(), CoreError> {
        self.write(|device| Ok(device.outbox_refused(id, &core_error(code))?))
    }

    /// Makes the KeyPackages this device should publish now, given how many unused single-use ones the hub
    /// still holds. Returns the outbox entry's id, or none when nothing is due.
    pub fn key_packages_to_upload(
        &self,
        unused_at_hub: u32,
        now_ms: u64,
    ) -> Result<Option<u64>, CoreError> {
        self.write(|device| Ok(device.key_packages_to_upload(unused_at_hub as usize, now_ms)?))
    }

    /// Makes one KeyPackage that reaches whoever adds this device outside the hub: a helper device's for its
    /// opener, a new device's for its invite. Its private part is stored before it is returned.
    pub fn key_package(&self, now_ms: u64) -> Result<Vec<u8>, CoreError> {
        self.write(|device| Ok(device.key_package(now_ms)?))
    }

    /// Founds the room with the recovery code `recovery_code` (32 bytes, from
    /// [`crate::generate_recovery_code`]) and posts its founding. Returns the room's id, 32 random bytes.
    pub fn found_room(&self, recovery_code: Vec<u8>, now_ms: u64) -> Result<Vec<u8>, CoreError> {
        let code = Secret::<32>::from_slice(&recovery_code)?;
        self.write(|device| {
            let (signature_key, hpke_key) = interim::public_keys(code.expose())?;
            let room = device.found_room(signature_key, hpke_key, now_ms)?;
            Ok(room.as_bytes().to_vec())
        })
    }

    /// Founds a main session as a human device, adding the agent device `agent` and every other human device
    /// of the room. `key_packages` holds exactly one KeyPackage of each of them (`incomplete` otherwise).
    /// Returns the session id, 16 bytes.
    pub fn found_session(
        &self,
        agent: Vec<u8>,
        key_packages: Vec<Vec<u8>>,
        now_ms: u64,
    ) -> Result<Vec<u8>, CoreError> {
        self.write(|device| {
            let session = device.found_session(&device_id(&agent)?, &key_packages, now_ms)?;
            Ok(session.as_bytes().to_vec())
        })
    }

    /// Founds a helper session under the main session `parent` as its opener, adding every human device of
    /// the room and the helper devices whose KeyPackages are given. Returns the session id, 16 bytes.
    pub fn found_helper(
        &self,
        parent: Vec<u8>,
        key_packages: Vec<Vec<u8>>,
        now_ms: u64,
    ) -> Result<Vec<u8>, CoreError> {
        self.write(|device| {
            let session = device.found_helper(&session_id(&parent)?, &key_packages, now_ms)?;
            Ok(session.as_bytes().to_vec())
        })
    }

    /// Adds the human device `device` to the room group with its KeyPackage. The caller then hands the history
    /// over ([`CoreDevice::send_handover`]) and adds it to every live session group
    /// ([`CoreDevice::add_to_session`]). Returns the outbox entry's id.
    pub fn add_human_device(
        &self,
        device: Vec<u8>,
        key_package: Vec<u8>,
        now_ms: u64,
    ) -> Result<u64, CoreError> {
        self.write(|inner| {
            Ok(inner.add_human_device(&device_id(&device)?, &key_package, now_ms)?)
        })
    }

    /// Adds `device` to the session group `group` with its KeyPackage: a human device missing from a live
    /// session, or a helper device, by the opener. Returns the outbox entry's id.
    pub fn add_to_session(
        &self,
        group: Vec<u8>,
        device: Vec<u8>,
        key_package: Vec<u8>,
        now_ms: u64,
    ) -> Result<u64, CoreError> {
        self.write(|inner| {
            Ok(inner.add_to_session(
                &group_id(&group)?,
                &device_id(&device)?,
                &key_package,
                now_ms,
            )?)
        })
    }

    /// Changes the room's enrolled agent devices: `enrol` are added, `remove` taken out. Removing one makes
    /// its main session and the helper sessions it opened stale. Returns the outbox entry's id.
    pub fn change_agents(
        &self,
        enrol: Vec<Vec<u8>>,
        remove: Vec<Vec<u8>>,
        now_ms: u64,
    ) -> Result<u64, CoreError> {
        self.write(|device| {
            let enrol = enrol
                .iter()
                .map(|id| device_id(id))
                .collect::<Result<Vec<_>, _>>()?;
            let remove = remove
                .iter()
                .map(|id| device_id(id))
                .collect::<Result<Vec<_>, _>>()?;
            Ok(device.change_agents(&enrol, &remove, now_ms)?)
        })
    }

    /// Removes human devices from the room group, each with its Cut there. The session groups that hold one
    /// are stale from this Commit on; the caller finishes each with [`CoreDevice::clean_session`] once this
    /// Commit was accepted. Returns the outbox entry's id.
    pub fn remove_human_devices(&self, cuts: Vec<Cut>, now_ms: u64) -> Result<u64, CoreError> {
        self.write(|device| {
            let cuts = cuts
                .iter()
                .map(Cut::to_core)
                .collect::<Result<Vec<_>, _>>()?;
            Ok(device.remove_human_devices(&cuts, now_ms)?)
        })
    }

    /// The Commit that makes a stale session group live again: it removes every leaf the room state does not
    /// allow, each with its Cut, and may add one device in the same Commit. `cuts` must name exactly the
    /// leaves to go. Returns the outbox entry's id.
    pub fn clean_session(
        &self,
        group: Vec<u8>,
        cuts: Vec<Cut>,
        replacement: Option<Replacement>,
        now_ms: u64,
    ) -> Result<u64, CoreError> {
        self.write(|device| {
            let cuts = cuts
                .iter()
                .map(Cut::to_core)
                .collect::<Result<Vec<_>, _>>()?;
            let replacement = replacement
                .as_ref()
                .map(|replacement| {
                    Ok::<_, CoreError>((device_id(&replacement.device)?, &replacement.key_package))
                })
                .transpose()?;
            Ok(device.clean_session(
                &group_id(&group)?,
                &cuts,
                replacement
                    .as_ref()
                    .map(|(id, package)| (id, package.as_slice())),
                now_ms,
            )?)
        })
    }

    /// The opener replaces a helper device that lost its state: Remove of the old leaf with its Cut and Add
    /// of the new device in one Commit. Returns the outbox entry's id.
    pub fn readmit_helper(
        &self,
        group: Vec<u8>,
        old: Cut,
        device: Vec<u8>,
        key_package: Vec<u8>,
        now_ms: u64,
    ) -> Result<u64, CoreError> {
        self.write(|inner| {
            Ok(inner.readmit_helper(
                &group_id(&group)?,
                old.to_core()?,
                &device_id(&device)?,
                &key_package,
                now_ms,
            )?)
        })
    }

    /// The own-leaf update of a human device: an empty Commit when its leaf in `group` is older than seven
    /// days and its last update there older than a day, or at once when `forced`. Returns the outbox entry's
    /// id, or none when nothing is due.
    pub fn update(
        &self,
        group: Vec<u8>,
        forced: bool,
        now_ms: u64,
    ) -> Result<Option<u64>, CoreError> {
        self.write(|device| Ok(device.update(&group_id(&group)?, forced, now_ms)?))
    }

    /// Records that a human device archived the session: the device commits and sends nothing more in its
    /// group. The group's keys stay.
    pub fn archive(&self, group: Vec<u8>) -> Result<(), CoreError> {
        self.write(|device| Ok(device.archive(&group_id(&group)?)?))
    }

    /// Joins the group a Welcome is for. The Welcome must be for one of this device's KeyPackages, for a
    /// group of the room `room` that this device does not hold, and, where the joiner was told who adds it
    /// (its inviter), committed by `committer`.
    pub fn join_welcome(
        &self,
        welcome: Vec<u8>,
        room: Vec<u8>,
        committer: Option<Vec<u8>>,
        now_ms: u64,
    ) -> Result<Joined, CoreError> {
        self.write(|device| {
            let expected = WelcomeExpectation {
                room: room_id(&room)?,
                committer: committer.as_deref().map(device_id).transpose()?,
            };
            Ok(device.join_welcome(&welcome, &expected, now_ms)?.into())
        })
    }

    /// Starts following the room group as an observer, for a device that is not a human device: from the
    /// GroupInfo of the epoch it was told, which must hash to `expected_state` where one is given.
    pub fn observe_room(
        &self,
        group_info: Vec<u8>,
        expected_state: Option<Vec<u8>>,
    ) -> Result<(), CoreError> {
        self.write(|device| {
            let expected = expected_state.as_deref().map(hash32).transpose()?;
            Ok(device.observe_room(&group_info, expected.as_ref())?)
        })
    }

    /// Starts following a main session's group as an observer, as a helper device does for the session its
    /// helper session hangs under.
    pub fn observe_session(&self, group_info: Vec<u8>) -> Result<(), CoreError> {
        self.write(|device| Ok(device.observe_session(&group_info)?))
    }

    /// Processes one entry of the hub's ordered log: the group state after it, the content key of a new epoch
    /// and the cursor are written together. Entries are handed in the hub's order across groups. A refusal
    /// changes nothing; [`crate::log_finding`] says what its code means for the caller.
    pub fn process_log_entry(&self, entry: LogEntry) -> Result<Processed, CoreError> {
        self.write(|device| {
            let kind = match entry.kind {
                LogEntryKind::Commit => LogKind::Commit {
                    bytes: &entry.bytes,
                    recovery_auth: entry.recovery_auth.as_deref(),
                },
                LogEntryKind::Message => LogKind::Message {
                    bytes: &entry.bytes,
                },
            };
            let processed = device.process_log_entry(&core::LogEntry {
                change: entry.change,
                group: group_id(&entry.group)?,
                kind,
            })?;
            Ok(processed.into())
        })
    }

    /// Hands old content keys to `recipient` in `group`, in as many messages as needed. Returns the outbox
    /// entries' ids.
    pub fn send_handover(&self, group: Vec<u8>, recipient: Vec<u8>) -> Result<Vec<u64>, CoreError> {
        self.write(|device| Ok(device.send_handover(&group_id(&group)?, &device_id(&recipient)?)?))
    }

    /// The handovers this device sent and whose recipient is not yet known to read.
    pub fn handovers_sent(&self) -> Result<Vec<HandoverSent>, CoreError> {
        self.read(|device| {
            Ok(device
                .handovers_sent()
                .into_iter()
                .map(|(recipient, group)| HandoverSent {
                    recipient: recipient.as_bytes().to_vec(),
                    group: group.as_bytes().to_vec(),
                })
                .collect())
        })
    }

    /// The recipient is known to read: the record of the handover through `group` goes.
    pub fn handover_read(&self, group: Vec<u8>, recipient: Vec<u8>) -> Result<(), CoreError> {
        self.write(|device| Ok(device.handover_read(&group_id(&group)?, &device_id(&recipient)?)?))
    }

    /// Sends the points of a stroke still being drawn: room group, human devices, relayed and not stored.
    /// Returns the outbox entry's id.
    pub fn send_stroke_piece(&self, board: Vec<u8>, piece: Vec<u8>) -> Result<u64, CoreError> {
        self.write(|device| Ok(device.send_stroke_piece(&board_id(&board)?, &piece)?))
    }

    /// Sends one step of the running turn: a session group, from its agent or helper devices. `number` counts
    /// from 1 within `turn`; `step` is the application's JSON. Returns the outbox entry's id.
    pub fn send_work_trail(
        &self,
        group: Vec<u8>,
        turn: Vec<u8>,
        number: u32,
        step: Vec<u8>,
        now_ms: u64,
    ) -> Result<u64, CoreError> {
        self.write(|device| {
            Ok(device.send_work_trail(
                &group_id(&group)?,
                &turn_id(&turn)?,
                number,
                &step,
                now_ms,
            )?)
        })
    }

    /// Signs the hub's sign-in challenge (32 bytes) for the room `room` at the hub `hub`, which must be the
    /// hub's canonical address. The result is posted as it is; the token the hub answers with is the host's.
    pub fn hub_sign_in(
        &self,
        room: Vec<u8>,
        hub: String,
        challenge: Vec<u8>,
    ) -> Result<SignedHubAuth, CoreError> {
        let challenge: [u8; CHALLENGE_LEN] = challenge
            .as_slice()
            .try_into()
            .map_err(|_| CoreError::bad_format("the challenge is not 32 bytes"))?;
        // Inside the device's lock, so that a closed or failed device signs nothing.
        self.read(|_| {
            let seed = self.seed.lock().unwrap_or_else(PoisonError::into_inner);
            let seed = seed
                .as_ref()
                .ok_or_else(|| CoreError::internal("the device's key is not in its store"))?;
            let key = SigningKey::from_seed(seed.duplicate());
            let signed =
                hub_auth::sign(&key, room_id(&room)?, &HubAddress::parse(&hub)?, challenge)?;
            Ok(SignedHubAuth {
                auth: signed.auth,
                signature: signed.signature,
            })
        })
    }
}

/// What a refusal of [`CoreDevice::process_log_entry`] with `code` means for the caller.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn log_finding(code: ErrorCode) -> LogFinding {
    match core::log_finding(&core_error(code)) {
        core::LogFinding::Early => LogFinding::Early,
        core::LogFinding::Duplicate => LogFinding::Duplicate,
        core::LogFinding::BadGroup => LogFinding::BadGroup,
        core::LogFinding::Local => LogFinding::Local,
    }
}
