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

use crate::content::{
    self, BoardLoaded, ChainHead, CommandDecision, Draft, Finding, HeadStanding, ObjectView,
    ReceivedEnvelope, Sealed, ServedItem,
};
use crate::content::{Fed, FeedItem, FeedOutcome};
use crate::error::core_error;
use crate::guard::{Guarded, Quiet};
use crate::invite::{
    check_code, CheckCode, InviteAccepted, InviteConfirmed, InviteOpened, InviteRole, InviteStep,
    JoinRequest, SignedOffer, SignedRequest, SignedReveal,
};
use crate::records::ReceivedMessage;
use crate::records::{
    board_id, device_id, group_id, hash32, room_id, session_id, turn_id, Cut, GroupSummary,
    HandoverSent, Joined, LogEntry, LogEntryKind, LogFinding, OutboxEntry, Processed, Replacement,
    RoomRoles, SignedHubAuth,
};
use crate::recovery::{
    self, with_chains, with_commits, with_group, with_room, CodeJoin, GroupPast, Learned,
    RecoveryPlan, ServedCommit, ServedEnvelope, ServedGroup, ServedRoom,
};
use crate::store::AnyStore;
use crate::{CoreError, ErrorCode};
#[cfg(feature = "js")]
use std::sync::PoisonError;
use trommi_core::crypto::SystemEntropy;
use trommi_core::device::{self as core, Accepted, Device, LogKind, WelcomeExpectation};
use trommi_core::hub_auth::{HubAddress, CHALLENGE_LEN};
use trommi_core::ids::InviteId;
use trommi_core::invite;
use trommi_core::recovery::{self as construct, Replacement as NewCode};
use trommi_core::store::Storage;

/// The core's device over any store, and a new recovery code between its making and the Commit that puts it in
/// force.
struct Inner {
    device: Device<AnyStore>,
    replacement: Option<NewCode>,
}

/// One device: its signature key, the groups it is a leaf of, its content keys and its outbox, over the store
/// the host gave it. Exactly one such object works on a stored state at a time.
#[cfg_attr(feature = "uniffi", derive(uniffi::Object))]
pub struct CoreDevice {
    device: Guarded<Inner>,
    #[cfg(feature = "js")]
    writes: crate::store::Writes,
}

impl CoreDevice {
    /// The core's device over `store`, new or as stored.
    fn build(store: Box<dyn Storage + Send>, create: bool) -> Result<Guarded<Inner>, CoreError> {
        let store = AnyStore(store);
        let _quiet = Quiet::enter();
        let device = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            if create {
                Device::create(store, Box::new(SystemEntropy))
            } else {
                Device::open(store, Box::new(SystemEntropy))
            }
        }))
        .map_err(|_| CoreError::internal("the device failed to open inside the core"))??;
        Ok(Guarded::new(Inner {
            device,
            replacement: None,
        }))
    }

    /// A new device in the empty store `store`: a fresh signature key, no room yet. `storage` when the store
    /// is not empty.
    pub fn create_on(store: Box<dyn Storage + Send>) -> Result<Self, CoreError> {
        Ok(Self {
            device: Self::build(store, true)?,
            #[cfg(feature = "js")]
            writes: Default::default(),
        })
    }

    /// The device `store` holds. `storage` when anything in it does not decode or fit together.
    pub fn open_on(store: Box<dyn Storage + Send>) -> Result<Self, CoreError> {
        Ok(Self {
            device: Self::build(store, false)?,
            #[cfg(feature = "js")]
            writes: Default::default(),
        })
    }

    fn read<R>(
        &self,
        call: impl FnOnce(&Device<AnyStore>) -> Result<R, CoreError>,
    ) -> Result<R, CoreError> {
        self.device.run(|inner| call(&inner.device))
    }

    fn write<R>(
        &self,
        call: impl FnOnce(&mut Device<AnyStore>) -> Result<R, CoreError>,
    ) -> Result<R, CoreError> {
        self.device.run(|inner| call(&mut inner.device))
    }
}

/// The browser's way in: the page read the store before, and takes the writes after every call.
#[cfg(feature = "js")]
impl CoreDevice {
    /// A new device over what the page loaded, which must be an empty store.
    pub fn create_loaded(loaded: crate::store::StoredState) -> Result<Self, CoreError> {
        let (store, writes) = crate::store::QueueStore::new(loaded);
        Ok(Self {
            device: Self::build(Box::new(store), true)?,
            writes,
        })
    }

    /// The device that what the page loaded holds.
    pub fn open_loaded(loaded: crate::store::StoredState) -> Result<Self, CoreError> {
        let (store, writes) = crate::store::QueueStore::new(loaded);
        Ok(Self {
            device: Self::build(Box::new(store), false)?,
            writes,
        })
    }

    /// The writes made since the last call of this, oldest first: the page stores each in one transaction
    /// before it lets the result of the call that made them reach anyone. A closed device hands out none.
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
        Self::create_on(Box::new(crate::store::ForeignStore::new(store)))
    }

    /// The device `store` holds. `storage` when anything in it does not decode or fit together.
    #[uniffi::constructor]
    pub fn open(store: std::sync::Arc<dyn crate::store::CoreStore>) -> Result<Self, CoreError> {
        Self::open_on(Box::new(crate::store::ForeignStore::new(store)))
    }
}

#[cfg_attr(feature = "uniffi", uniffi::export)]
impl CoreDevice {
    /// Closes the device and wipes what it holds in memory. Every later call is refused; the stored state is
    /// untouched and can be opened again.
    pub fn close(&self) {
        let closed = self.device.close();
        // In a browser, what was written and not stored yet goes with the device: it holds private keys.
        #[cfg(feature = "js")]
        if closed {
            self.writes
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clear();
        }
        let _ = closed;
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

    /// Whether this device holds the content key of `group` at `epoch`. The key itself is not handed out: what
    /// it seals is written with [`CoreDevice::seal`] and opened by [`CoreDevice::receive_envelope`], after the
    /// checks of the sender's chain.
    pub fn holds_key(&self, group: Vec<u8>, epoch: u64) -> Result<bool, CoreError> {
        self.read(
            |device| match device.content_key(&group_id(&group)?, epoch) {
                Ok(_) => Ok(true),
                Err(trommi_core::Error::NoKey) => Ok(false),
                Err(error) => Err(error.into()),
            },
        )
    }

    /// Everything waiting to be sent, in the order to send it. An entry stays until the hub's answer was
    /// reported; a Commit refused with `epoch-taken` is held back until the log decided it.
    pub fn outbox(&self) -> Result<Vec<OutboxEntry>, CoreError> {
        self.read(|device| Ok(device.outbox().into_iter().map(Into::into).collect()))
    }

    /// The hub accepted the outbox entry `id`: the entry goes. `change` is the change number the hub gave it,
    /// where it gives one. An accepted Commit is not merged here: it is merged when
    /// [`CoreDevice::process_log_entry`] reaches it in the log, at its place among the entries of every group.
    pub fn outbox_accepted(&self, id: u64, change: Option<u64>) -> Result<(), CoreError> {
        self.write(|device| Ok(device.outbox_accepted(id, Accepted { change })?))
    }

    /// The hub refused the outbox entry `id` with `code`.
    ///
    /// A refusal that says nothing about the request (`internal`, `overloaded`, `rate-limited`,
    /// `unauthorised`, `bad-challenge`, `client-too-old`, `lease-lost`) changes nothing: the entry stays and
    /// the same bytes are sent again. `epoch-taken` for a Commit: it is held back, and the caller processes the
    /// log, which decides it. Any other refusal undoes what the entry was for: the pending Commit is cleared,
    /// a founding's group is dropped, the KeyPackages' private parts go.
    ///
    /// A code this version does not know, and no answer at all, are not reported here: the entry is sent
    /// again. A code that no hub answers with is `bad-format`.
    pub fn outbox_refused(&self, id: u64, code: ErrorCode) -> Result<(), CoreError> {
        if !is_hub_code(code) {
            return Err(CoreError::bad_format("not a code a hub answers with"));
        }
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
    /// [`crate::generate_recovery_code`]) and posts its founding. The device keeps the key that authenticates
    /// the room's sealed keys, and nothing else of the code. Returns the room's id, 32 random bytes.
    pub fn found_room(&self, recovery_code: Vec<u8>, now_ms: u64) -> Result<Vec<u8>, CoreError> {
        let keys = recovery::keys(&recovery_code)?;
        self.write(|device| Ok(device.found_room(&keys, now_ms)?.as_bytes().to_vec()))
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

    /// Takes agent devices out of the room's enrolled agent devices. Removing one makes its main session and
    /// the helper sessions it opened stale. An agent device is enrolled by an invite alone
    /// ([`CoreDevice::invite_confirm`]). Returns the outbox entry's id.
    pub fn remove_agents(&self, remove: Vec<Vec<u8>>, now_ms: u64) -> Result<u64, CoreError> {
        self.write(|device| {
            let remove = remove
                .iter()
                .map(|id| device_id(id))
                .collect::<Result<Vec<_>, _>>()?;
            Ok(device.remove_agents(&remove, now_ms)?)
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

    /// Lets a human device into a session group again whose Welcome it could not use: one Commit that removes
    /// its leaf, with the Cut this device holds for it, and adds the same key with the fresh KeyPackage it
    /// asked with; its chain goes on from that Cut. Any human device of the group does this (`forbidden` for
    /// another device, and in the room group, where a device that cannot join comes back as a new device);
    /// `bad-commit` for a device that is no human device of the room, for this device itself, and when the
    /// hub holds an envelope of the device beyond the Cut. Returns the outbox entry's id.
    pub fn readmit_human(
        &self,
        group: Vec<u8>,
        device: Vec<u8>,
        key_package: Vec<u8>,
        now_ms: u64,
    ) -> Result<u64, CoreError> {
        self.write(|inner| {
            Ok(inner.readmit_human(
                &group_id(&group)?,
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

    /// Joins the group a Welcome is for. The Welcome must be for one of this device's KeyPackages and for a
    /// group of the room `room` that this device does not hold.
    ///
    /// `committer` is the device that must have committed the Add. **A device that joins by an invite names its
    /// inviter here**: without it the Welcome of anyone who holds one of this device's KeyPackages is taken.
    /// None is for the Welcomes that follow in a room the device already belongs to (a session it is added
    /// to), where the room's own rules say who may add.
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
    /// GroupInfo of the epoch it was told, which must hash to `expected_state`. **A device that was invited
    /// gives the room state its invite named**: without it whatever GroupInfo the hub serves is followed.
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
    /// and the cursor are written together. Entries are handed strictly in the order of their change numbers
    /// across groups, this device's own accepted Commits among them: that is where they are merged. A refusal
    /// changes nothing; [`crate::log_finding`] says what its code means for the caller.
    ///
    /// `now_ms` is this device's clock: when it processed the Commit that ended an epoch decides how long an
    /// envelope of that epoch is still taken.
    pub fn process_log_entry(&self, entry: LogEntry, now_ms: u64) -> Result<Processed, CoreError> {
        self.write(|device| log_entry(device, &entry, now_ms))
    }

    /// Catching up: hands the device several things of the hub's one order in one call, each a log entry or a
    /// stored envelope at its place, in the order of their change numbers. It does for each what
    /// [`CoreDevice::process_log_entry`] and [`CoreDevice::receive_envelope`] (in order) do, and stops at the
    /// first that is refused: the outcomes of the ones before it are returned with the place and code of the
    /// refusal, and nothing after it was touched.
    ///
    /// Every item is still one write of its own, in order. What the call saves is the host's part: in a
    /// browser the writes of the whole call are stored in one transaction before the call answers, so nothing
    /// is acknowledged that is not stored, and a failed transaction closes the device as after any failed
    /// write. A few hundred items per call is a good size.
    pub fn feed(&self, items: Vec<FeedItem>, now_ms: u64) -> Result<Fed, CoreError> {
        self.write(|device| {
            let mut outcomes = Vec::with_capacity(items.len());
            for item in &items {
                let outcome = match (&item.entry, &item.envelope) {
                    (Some(entry), None) => {
                        log_entry(device, entry, now_ms).map(|processed| FeedOutcome {
                            processed: Some(processed),
                            envelope: None,
                        })
                    }
                    (None, Some(served)) => content::void_code(served.void_code)
                        .and_then(|void| {
                            Ok(device.receive_envelope(
                                &served.bytes,
                                served.change,
                                true,
                                void.as_ref(),
                                now_ms,
                            )?)
                        })
                        .map(|received| FeedOutcome {
                            processed: None,
                            envelope: Some(received.into()),
                        }),
                    _ => Err(CoreError::bad_format(
                        "an item is a log entry or an envelope",
                    )),
                };
                match outcome {
                    Ok(outcome) => outcomes.push(outcome),
                    Err(error) => {
                        return Ok(Fed {
                            refused_at: Some(u32::try_from(outcomes.len()).unwrap_or(u32::MAX)),
                            code: Some(error.code()),
                            message: Some(error.message().to_owned()),
                            outcomes,
                        })
                    }
                }
            }
            Ok(Fed {
                outcomes,
                refused_at: None,
                code: None,
                message: None,
            })
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
    /// Returns the outbox entry's id. `epoch-full` when the epoch took its share of pieces: an update of the
    /// room group is due first ([`CoreDevice::update`], forced).
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

    /// Whether this device holds the key that authenticates the room's sealed keys under the recovery code in
    /// force. A human device that does not founds nothing and commits nothing: it asks another human device
    /// for it, which answers with [`CoreDevice::send_recovery_auth`].
    pub fn holds_recovery_mac(&self) -> Result<bool, CoreError> {
        self.read(|device| Ok(device.holds_recovery_mac()))
    }

    /// Whether the content key of `group` at `epoch` is vouched for: the device derived it itself, or a human
    /// device's sealed key names it. Content of an epoch whose key is not confirmed is shown as unconfirmed.
    pub fn key_is_confirmed(&self, group: Vec<u8>, epoch: u64) -> Result<bool, CoreError> {
        self.read(|device| Ok(device.key_is_confirmed(&group_id(&group)?, epoch)))
    }

    /// Sends the key that authenticates the room's sealed keys to `recipient`, or to all with 32 zero bytes:
    /// room group, from a human device that holds it (`no-key` otherwise). Returns the outbox entry's id, or
    /// none while a Commit of this device is pending in the room group: it is then sent when that is decided.
    pub fn send_recovery_auth(&self, recipient: Vec<u8>) -> Result<Option<u64>, CoreError> {
        self.write(|device| Ok(device.send_recovery_auth(&device_id(&recipient)?)?))
    }

    /// Posts the sealed key of the epoch `group` stands in, vouched for by this device, when the hub lists
    /// none this device can verify: `listed` are the sealed keys the hub lists for it, `group_info` the
    /// GroupInfo it holds for that epoch. Returns the outbox entry's id, or none when one is listed.
    pub fn post_sealed_key(
        &self,
        group: Vec<u8>,
        group_info: Vec<u8>,
        listed: Vec<Vec<u8>>,
    ) -> Result<Option<u64>, CoreError> {
        self.write(|device| Ok(device.post_sealed_key(&group_id(&group)?, &group_info, &listed)?))
    }

    /// First contact with a session group this device joined by Welcome: verifies the group from its founding
    /// through its Commits against the room states this device holds. `bad-group` is the finding: the device
    /// then opens none of the session's content. `room-behind` and `group-behind` are no findings: process
    /// further and ask again.
    pub fn verify_founding(&self, group: Vec<u8>, served: ServedGroup) -> Result<(), CoreError> {
        self.write(|device| {
            let group = group_id(&group)?;
            with_group(
                &served,
                |served| Ok(device.verify_founding(&group, served)?),
            )
        })
    }

    /// Signs in on a new device with the recovery code: checks the room the hub serves and builds the join of
    /// the room group from outside. Nothing of the device's state changes until the hub accepted the outbox
    /// entry; then it is a human device and holds every content key the code opened. It joins each live
    /// session group next ([`CoreDevice::join_session_with_code`]).
    pub fn join_room_with_code(
        &self,
        recovery_code: Vec<u8>,
        served: ServedRoom,
        now_ms: u64,
    ) -> Result<CodeJoin, CoreError> {
        let keys = recovery::keys(&recovery_code)?;
        self.write(|device| {
            with_room(&served, |served| {
                Ok(device.join_room_with_code(&keys, served, now_ms)?.into())
            })
        })
    }

    /// Joins a live session group with the recovery code, as a human device that joined the room group with
    /// it. Main sessions are joined before their helper sessions. Returns the outbox entry's id.
    pub fn join_session_with_code(
        &self,
        recovery_code: Vec<u8>,
        served: ServedGroup,
        now_ms: u64,
    ) -> Result<u64, CoreError> {
        let keys = recovery::keys(&recovery_code)?;
        self.write(|device| {
            with_group(&served, |served| {
                Ok(device.join_session_with_code(&keys, served, now_ms)?)
            })
        })
    }

    /// Makes a new recovery code to replace the one in force, `recovery_code`, and returns it (32 bytes): for
    /// the account's new sealed copies, and shown to the person. The device keeps what belongs to it in memory
    /// until [`CoreDevice::replace_code`]; nothing is stored or sent yet, and a second call makes another code.
    /// `wrong-recovery` unless `recovery_code` is the code in force.
    pub fn new_recovery_code(&self, recovery_code: Vec<u8>) -> Result<Vec<u8>, CoreError> {
        let keys = recovery::keys(&recovery_code)?;
        self.device.run(|inner| {
            let room = inner.device.room().ok_or(trommi_core::Error::NoRoom)?;
            let history = inner
                .device
                .room_history()
                .ok_or(trommi_core::Error::NoRoom)?;
            let replacement = keys.replace(&mut SystemEntropy, &room, history)?;
            let code = replacement.code.expose().to_vec();
            inner.replacement = Some(replacement);
            Ok(code)
        })
    }

    /// Replaces the recovery code with the one [`CoreDevice::new_recovery_code`] made, as a human device that
    /// holds the code in force: one request with the room Commit, the link from the old code, and `account`,
    /// the account's sealed copies of the new code. When the hub accepted it, the device sends the new
    /// authentication key to every human device. `incomplete` when no new code was made. Returns the outbox
    /// entry's id.
    pub fn replace_code(
        &self,
        recovery_code: Vec<u8>,
        account: Vec<u8>,
        now_ms: u64,
    ) -> Result<u64, CoreError> {
        let keys = recovery::keys(&recovery_code)?;
        self.device.run(|inner| {
            let replacement = inner
                .replacement
                .as_ref()
                .ok_or(trommi_core::Error::Incomplete)?;
            let entry = inner
                .device
                .replace_code(&keys, replacement, &account, now_ms)?;
            inner.replacement = None;
            Ok(entry)
        })
    }

    /// Prepares the whole recovery, when every device is lost, on a new device with the code: checks the room
    /// the hub serves after the recovery was opened there, makes the new code, and names the leaves the
    /// recovery removes. The caller verifies each one's chain, names its Cut, seals the new code for the
    /// account, and calls [`CoreDevice::recover`].
    pub fn prepare_recovery(
        &self,
        recovery_code: Vec<u8>,
        served: ServedRoom,
    ) -> Result<RecoveryPlan, CoreError> {
        let keys = recovery::keys(&recovery_code)?;
        self.device.run(|inner| {
            with_room(&served, |served| {
                let checked = construct::check_room(&keys, served)?;
                let history = checked
                    .observer
                    .history()
                    .ok_or(trommi_core::Error::Internal("room history"))?;
                let replacement = keys.replace(&mut SystemEntropy, &served.room, history)?;
                let plan = RecoveryPlan {
                    new_code: replacement.code.expose().to_vec(),
                    removals: recovery::removals(&checked)?,
                };
                inner.replacement = Some(replacement);
                Ok(plan)
            })
        })
    }

    /// The whole recovery, as [`CoreDevice::prepare_recovery`] prepared it: the device joins the room group and
    /// every session group from outside, removes every other human device together with the replacement of
    /// the code, and then every leaf the new room state does not allow.
    ///
    /// `chains` are the envelopes of the devices to go (the plan's removals name them), in pruned form as the
    /// hub's chain route serves them, in the hub's order. The device verifies each chain from number 1 and
    /// takes the Cut from the head it verified; a chain that does not hold (`gap`, `chain-break`, a second
    /// envelope under a number) fails the recovery with that code. A device of which nothing is handed in is
    /// cut at nothing. `account` are the account's sealed copies of the new code. The outbox entries are
    /// posted in order; the device's state changes only when the hub accepted the last.
    pub fn recover(
        &self,
        recovery_code: Vec<u8>,
        served: ServedRoom,
        chains: Vec<ServedEnvelope>,
        account: Vec<u8>,
        now_ms: u64,
    ) -> Result<CodeJoin, CoreError> {
        let keys = recovery::keys(&recovery_code)?;
        self.device.run(|inner| {
            let replacement = inner
                .replacement
                .as_ref()
                .ok_or(trommi_core::Error::Incomplete)?;
            let built = with_room(&served, |served| {
                with_chains(&chains, |chains| {
                    Ok(inner.device.recover(
                        &keys,
                        served,
                        replacement,
                        chains,
                        &account,
                        now_ms,
                    )?)
                })
            })?;
            inner.replacement = None;
            Ok(built.into())
        })
    }

    /// Learns the past of `group` from its public history, for a device that joined by link: `founding` is the
    /// group's founding GroupInfo, `commits` its Commits from the first on, in order. The room group is
    /// learned first, then main sessions, then helper sessions (`room-behind`, `group-behind` otherwise). The
    /// history is taken only if it arrives at this device's own state (`bad-group` otherwise, and nothing is
    /// written). Envelopes of the earlier epochs, refused with `group-behind` until then, are handed to
    /// [`CoreDevice::receive_envelope`] again afterwards; their bodies open once the key handover arrived.
    pub fn learn_history(
        &self,
        group: Vec<u8>,
        founding: Vec<u8>,
        commits: Vec<ServedCommit>,
    ) -> Result<Learned, CoreError> {
        self.write(|device| {
            let group = group_id(&group)?;
            with_commits(&commits, |commits| {
                let learned = device.learn_history(&group, &founding, commits)?;
                Ok(Learned {
                    epochs: learned.epochs,
                })
            })
        })
    }

    /// Where this device's knowledge of `group` begins and whether its past was learned; none for a group it
    /// neither is a leaf of nor follows. A followed group is not in [`CoreDevice::groups`]: this is how its
    /// past is asked for.
    pub fn group_past(&self, group: Vec<u8>) -> Result<Option<GroupPast>, CoreError> {
        self.read(|device| {
            Ok(device
                .group_past(&group_id(&group)?)?
                .map(|past| GroupPast {
                    from_epoch: past.from_epoch,
                    learned: past.learned,
                }))
        })
    }

    /// Seals one item as this device's next envelope in its group and puts it in the outbox. The number is used
    /// for good, and after a crash the same bytes are sent again.
    ///
    /// `recipient`: none lets the device address the item as the rules ask (a human's Chat message to the
    /// session's agent device or opener; an answer, take back or verdict to the object's owner; nobody
    /// otherwise). `file_ids` are the files the payload refers to, 16 bytes each.
    ///
    /// Refused before anything is signed, and without using a number: what the hub would refuse, `busy` while
    /// a Commit of this device in the group waits for the hub, `gone` in an archived session, `bad-group` in a
    /// group that failed its first contact, `not-found` for an object this device does not know.
    pub fn seal(
        &self,
        draft: Draft,
        recipient: Option<Vec<u8>>,
        file_ids: Vec<Vec<u8>>,
        now_ms: u64,
    ) -> Result<Sealed, CoreError> {
        self.write(|device| {
            let recipient = recipient.as_deref().map(device_id).transpose()?;
            let files = content::file_ids(&file_ids)?;
            let sealed = device.seal(&draft.into_core()?, recipient.as_ref(), &files, now_ms)?;
            Ok(sealed.into())
        })
    }

    /// The hub refused the envelope of the outbox entry `id` and keeps its number as a void record. The entry
    /// goes; the number stays used.
    pub fn outbox_voided(&self, id: u64) -> Result<(), CoreError> {
        self.write(|device| Ok(device.outbox_voided(id)?))
    }

    /// Gives up on the envelope of the outbox entry `id`, which the hub refused without taking its number: for
    /// a device that is out of the group (`not-member`, `removed-sender`). The number stays used.
    pub fn envelope_abandon(&self, id: u64) -> Result<(), CoreError> {
        self.write(|device| Ok(device.envelope_abandon(id)?))
    }

    /// Takes one envelope from the hub and writes what follows from it in one write.
    ///
    /// `ordered`: the envelope comes at its place, by the changes route or the stream, or along its sender's
    /// chain. With `change` above the cursor it moves the cursor to `change`; the caller hands the entries of
    /// the log and the envelopes in one order, by change number. At or below the cursor it is read back. Not
    /// `ordered`: the envelope was fetched out of order (a page of a Chat, an object) and is at most
    /// provisional; the chain is not touched. `void_code`: the hub served it as a void record with this code.
    ///
    /// The result says what became of it. A refusal with `group-behind` for a group this device is a leaf of
    /// leaves the cursor: the caller processes the log first. The call itself fails only for a failure of this
    /// device, or for bytes that are no envelope at all (`bad-format`, `too-large`, `newer-version`).
    pub fn receive_envelope(
        &self,
        envelope: Vec<u8>,
        change: u64,
        ordered: bool,
        void_code: Option<ErrorCode>,
        now_ms: u64,
    ) -> Result<ReceivedEnvelope, CoreError> {
        self.write(|device| {
            let void = content::void_code(void_code)?;
            Ok(device
                .receive_envelope(&envelope, change, ordered, void.as_ref(), now_ms)?
                .into())
        })
    }

    /// Takes a stroke piece the hub only passed on: it is in no log and has no change number, so the cursor
    /// stays. None for a message this device cannot open, or of a group it is no leaf of. `bad-format`, with
    /// nothing consumed, for a message that opens to anything but a stroke piece; `group-behind` for a message
    /// of an epoch the device has not reached.
    pub fn receive_relay(
        &self,
        group: Vec<u8>,
        message: Vec<u8>,
        now_ms: u64,
    ) -> Result<Option<ReceivedMessage>, CoreError> {
        self.write(|device| {
            Ok(device
                .receive_relay(&group_id(&group)?, &message, now_ms)?
                .map(Into::into))
        })
    }

    /// The value of the register `heads` to write in `group` now, as JSON; none when nothing is due. The
    /// caller seals it as a register under the name `heads`, which records the writing.
    pub fn heads_due(&self, group: Vec<u8>, now_ms: u64) -> Result<Option<Vec<u8>>, CoreError> {
        self.write(|device| Ok(device.heads_due(&group_id(&group)?, now_ms)?))
    }

    /// Compares the `heads` that `writer` wrote in `group` with this device's own chains there: per named
    /// sender whether this device holds the named envelope, holds less, or holds another under the number.
    pub fn compare_heads(
        &self,
        group: Vec<u8>,
        writer: Vec<u8>,
    ) -> Result<Vec<HeadStanding>, CoreError> {
        self.read(|device| {
            Ok(device
                .compare_heads(&group_id(&group)?, &device_id(&writer)?)?
                .into_iter()
                .map(|(sender, standing)| HeadStanding::of(&sender, standing))
                .collect())
        })
    }

    /// The Cut of `device` in `group` for a Commit that removes it: the last envelope of that device this
    /// device accepted there, number 0 and zeros if none.
    pub fn cut_of(&self, group: Vec<u8>, device: Vec<u8>) -> Result<Cut, CoreError> {
        self.read(|inner| {
            Ok(content::cut(
                &inner.cut_of(&group_id(&group)?, &device_id(&device)?)?,
            ))
        })
    }

    /// The last envelope of `sender` this device accepted in `group`; number 0 and zeros if none.
    pub fn chain_head(&self, group: Vec<u8>, sender: Vec<u8>) -> Result<ChainHead, CoreError> {
        self.read(|device| {
            Ok(device
                .chain_head(&group_id(&group)?, &device_id(&sender)?)?
                .into())
        })
    }

    /// The Cut that ended the chain of `device` in `group`, once this device processed the Commit that removed
    /// it. Whatever was shown of that device beyond it is dropped.
    pub fn chain_cut(
        &self,
        group: Vec<u8>,
        device: Vec<u8>,
    ) -> Result<Option<ChainHead>, CoreError> {
        self.read(|inner| {
            Ok(inner
                .chain_cut(&group_id(&group)?, &device_id(&device)?)?
                .map(Into::into))
        })
    }

    /// The state of the object `object_id` of `group`, as the envelopes accepted so far leave it.
    pub fn object(
        &self,
        group: Vec<u8>,
        object_id: Vec<u8>,
    ) -> Result<Option<ObjectView>, CoreError> {
        self.read(|device| {
            let id = trommi_core::ids::ObjectId::from_slice(&object_id)?;
            Ok(device
                .object(&group_id(&group)?, &id)?
                .map(|object| ObjectView::of(&id, &object)))
        })
    }

    /// Every object of `group` with its state, ascending by id.
    pub fn objects(&self, group: Vec<u8>) -> Result<Vec<ObjectView>, CoreError> {
        self.read(|device| {
            Ok(device
                .objects(&group_id(&group)?)?
                .iter()
                .map(|(id, object)| ObjectView::of(id, object))
                .collect())
        })
    }

    /// The device that owns `object_id` now: the writer of its newest version while it is a leaf, then the
    /// session's agent device or opener.
    pub fn object_owner(
        &self,
        group: Vec<u8>,
        object_id: Vec<u8>,
    ) -> Result<Option<Vec<u8>>, CoreError> {
        self.read(|device| {
            let id = trommi_core::ids::ObjectId::from_slice(&object_id)?;
            Ok(device
                .object_owner(&group_id(&group)?, &id)?
                .map(|owner| owner.as_bytes().to_vec()))
        })
    }

    /// The current value of the shared register `name` in `group`, as JSON text; none if it was never written
    /// or is deleted.
    pub fn register(&self, group: Vec<u8>, name: String) -> Result<Option<Vec<u8>>, CoreError> {
        self.read(|device| {
            Ok(device
                .register(&group_id(&group)?, &name)?
                .map(|value| value.expose().to_vec()))
        })
    }

    /// The current value that `sender` wrote under a name each device writes for itself (`heads`,
    /// `device/<id>`).
    pub fn register_of(
        &self,
        group: Vec<u8>,
        name: String,
        sender: Vec<u8>,
    ) -> Result<Option<Vec<u8>>, CoreError> {
        self.read(|device| {
            Ok(device
                .register_of(&group_id(&group)?, &name, &device_id(&sender)?)?
                .map(|value| value.expose().to_vec()))
        })
    }

    /// Loads `board` from what this device holds: the newest snapshot, the Cuts of the room group, and every
    /// writer's chain after the snapshot's frontier. `served` are the board's items the hub gave. The result
    /// says which served items the snapshot covers and which are to be added to it ([`crate::board_reduce`]).
    /// Refused: `withheld`, `hash-mismatch`, `equivocation`, `replay`, `removed-sender`, `gap`, `chain-break`,
    /// `forbidden`; `not-found` without a snapshot.
    pub fn board_load(
        &self,
        board: Vec<u8>,
        served: Vec<ServedItem>,
    ) -> Result<BoardLoaded, CoreError> {
        self.write(|device| {
            let served = served
                .iter()
                .map(|item| {
                    Ok(trommi_core::board::ServedItem {
                        sender: device_id(&item.sender)?,
                        seq: item.seq,
                        hash: hash32(&item.hash)?,
                    })
                })
                .collect::<Result<Vec<_>, CoreError>>()?;
            Ok(device.board_load(&board_id(&board)?, &served)?.into())
        })
    }

    /// The command gate, for an agent or helper device: whether to act on the envelope with this hash. Only an
    /// envelope that came through its sender's chain, passed every check and is addressed to this device can
    /// be asked about (`not-found` for any other). `act` is answered once per envelope, after the command was
    /// recorded as started: the caller acts, then calls [`CoreDevice::command_finished`].
    pub fn command(
        &self,
        envelope_hash: Vec<u8>,
        now_ms: u64,
    ) -> Result<CommandDecision, CoreError> {
        self.write(|device| Ok(device.command(&hash32(&envelope_hash)?, now_ms)?.into()))
    }

    /// The effect of the command the gate let through is complete.
    pub fn command_finished(&self, envelope_hash: Vec<u8>) -> Result<(), CoreError> {
        self.write(|device| Ok(device.command_finished(&hash32(&envelope_hash)?)?))
    }

    /// The envelopes the gate was not asked about yet, by hash: after a restart, what arrived and was stored
    /// before the caller could decide on it.
    pub fn commands_pending(&self) -> Result<Vec<Vec<u8>>, CoreError> {
        self.read(|device| {
            Ok(device
                .commands_pending()?
                .iter()
                .map(|hash| hash.as_bytes().to_vec())
                .collect())
        })
    }

    /// The commands the gate let through that were never reported as finished: their effect is uncertain. They
    /// are reported to the human, not repeated.
    pub fn commands_uncertain(&self) -> Result<Vec<Vec<u8>>, CoreError> {
        self.read(|device| {
            Ok(device
                .commands_uncertain()?
                .iter()
                .map(|hash| hash.as_bytes().to_vec())
                .collect())
        })
    }

    /// The findings made while Commits were processed, until [`CoreDevice::findings_read`] clears them.
    pub fn findings(&self) -> Result<Vec<Finding>, CoreError> {
        self.read(|device| Ok(device.findings()?.into_iter().map(Into::into).collect()))
    }

    /// The client has shown the findings: they go.
    pub fn findings_read(&self) -> Result<(), CoreError> {
        self.write(|device| Ok(device.findings_read()?))
    }

    /// Opens an invite: for a human device, or for an agent device, which founds a new main session or, with
    /// `session_id`, takes that one over. `app` is the app's origin for the link, `hub` the canonical address
    /// of the hub the room lives on. Only a human device invites; at most 16 invites are open at once. The
    /// invite lives ten minutes from `now_ms`.
    pub fn invite_open(
        &self,
        role: InviteRole,
        session_id: Option<Vec<u8>>,
        app: String,
        hub: String,
        now_ms: u64,
    ) -> Result<InviteOpened, CoreError> {
        self.write(|device| {
            let session = session_id
                .as_deref()
                .map(crate::records::session_id)
                .transpose()?;
            let opened = device.invite_open(
                role.into(),
                session.as_ref(),
                &app,
                &HubAddress::parse(&hub)?,
                now_ms,
            )?;
            Ok(InviteOpened {
                invite_id: opened.invite_id.as_bytes().to_vec(),
                link: String::from_utf8(opened.link.expose().to_vec())
                    .map_err(|_| CoreError::internal("the link is not text"))?,
                expires_at: opened.expires_at,
                offer: opened.signed_offer.offer.clone(),
                signature: opened.signed_offer.signature.clone(),
            })
        })
    }

    /// Accepts a Request for the invite: the first one with the link's MAC that matches the invite and is
    /// signed by the key of the KeyPackage it carries. Returns what to publish and the code to show; asked
    /// again with the same Request, the same is returned. A refused Request leaves the invite as it was.
    pub fn invite_accept(
        &self,
        invite_id: Vec<u8>,
        request: SignedRequest,
        now_ms: u64,
    ) -> Result<InviteAccepted, CoreError> {
        self.write(|device| {
            let request = invite::SignedRequest {
                request: request.request,
                mac: request.mac,
                signature: request.signature,
            };
            Ok(device
                .invite_accept(&InviteId::from_slice(&invite_id)?, &request, now_ms)?
                .into())
        })
    }

    /// The person compared the six emoji. `matches` false: the invite is burned, and none is returned. True:
    /// `code` (the six numbers) and `request_hash` are what this device showed them for; both are computed
    /// again, and only if they are the same (`code-not-confirmed` otherwise) is the new device committed. The
    /// Commit is put in the outbox; [`CoreDevice::invite_steps`] says what follows.
    pub fn invite_confirm(
        &self,
        invite_id: Vec<u8>,
        code: Vec<u8>,
        request_hash: Vec<u8>,
        matches: bool,
        now_ms: u64,
    ) -> Result<Option<InviteConfirmed>, CoreError> {
        self.write(|device| {
            let confirmed = device.invite_confirm(
                &InviteId::from_slice(&invite_id)?,
                &check_code(&code)?,
                &hash32(&request_hash)?,
                matches,
                now_ms,
            )?;
            Ok(confirmed.map(Into::into))
        })
    }

    /// Builds the Commit of a confirmed invite again, after another Commit took its epoch. Returns the outbox
    /// entry's id.
    pub fn invite_recommit(&self, invite_id: Vec<u8>, now_ms: u64) -> Result<u64, CoreError> {
        self.write(|device| Ok(device.invite_recommit(&InviteId::from_slice(&invite_id)?, now_ms)?))
    }

    /// What is left to do for every device this one committed by link. The steps are read from the state of
    /// the groups, so they are the same after a restart, and a step that was taken is not named again. An
    /// invite with nothing left is finished: its record goes in this call and it is listed no more.
    pub fn invite_steps(&self) -> Result<Vec<InviteStep>, CoreError> {
        self.write(|device| {
            Ok(device
                .invite_steps()?
                .into_iter()
                .map(|(invite_id, step)| InviteStep::of(&invite_id, step))
                .collect())
        })
    }

    /// Sends the key handover of the invite's first step of the kind `handover`. Returns the outbox entries'
    /// ids. `busy` when no handover is to be sent now.
    pub fn invite_handover(&self, invite_id: Vec<u8>) -> Result<Vec<u64>, CoreError> {
        self.write(|device| Ok(device.invite_handover(&InviteId::from_slice(&invite_id)?)?))
    }

    /// Answers a step of the kind `checkHelpers`: `helpers` are the groups of the live helper sessions the hub
    /// lists under the session that was taken over. `group-behind` when this device does not hold one of them
    /// (its Welcome is still to be taken); `busy` when another step is left. Otherwise the next
    /// [`CoreDevice::invite_steps`] finishes the invite.
    pub fn invite_checked(
        &self,
        invite_id: Vec<u8>,
        helpers: Vec<Vec<u8>>,
    ) -> Result<(), CoreError> {
        self.write(|device| {
            let helpers = helpers
                .iter()
                .map(|group| group_id(group))
                .collect::<Result<Vec<_>, _>>()?;
            Ok(device.invite_checked(&InviteId::from_slice(&invite_id)?, &helpers)?)
        })
    }

    /// A takeover without history: no handover is sent for this invite, now or in a helper session taken over
    /// later. Only the handover steps go; a takeover that is still to do stays listed.
    pub fn invite_forget(&self, invite_id: Vec<u8>) -> Result<(), CoreError> {
        self.write(|device| Ok(device.invite_forget(&InviteId::from_slice(&invite_id)?)?))
    }

    /// As the new device: checks the Offer served for `link` and answers it with a fresh KeyPackage of this
    /// device, stored before the Request is returned. A device joins one room, once (`room-exists`).
    pub fn join_request(
        &self,
        link: String,
        offer: SignedOffer,
        now_ms: u64,
    ) -> Result<JoinRequest, CoreError> {
        self.write(|device| {
            let offer = invite::SignedOffer {
                offer: offer.offer,
                signature: offer.signature,
            };
            let request = device.join_request(&link, &offer, now_ms)?;
            Ok(JoinRequest::of(
                request,
                &invite::Offer::decode(&offer.offer)?,
            ))
        })
    }

    /// As the new device: checks the Reveal and returns the code to show.
    pub fn join_reveal(&self, reveal: SignedReveal) -> Result<CheckCode, CoreError> {
        self.write(|device| {
            let reveal = invite::SignedReveal {
                reveal: reveal.reveal,
                signature: reveal.signature,
            };
            Ok(CheckCode::from(&device.join_reveal(&reveal)?))
        })
    }

    /// As an invited agent device: starts following the room group from the GroupInfo of the room epoch its
    /// Offer names, which must hash to the room state the Offer names. It takes itself for enrolled only by
    /// its inviter's Commit.
    pub fn join_observe(&self, group_info: Vec<u8>) -> Result<(), CoreError> {
        self.write(|device| Ok(device.join_observe(&group_info)?))
    }

    /// As an invited human device: joins the room group from the Welcome that answers its Request. What the
    /// Welcome must be (the Offer's room, committed by the inviter, for the Request's KeyPackage) is read from
    /// the stored invite, not given by the caller.
    pub fn join_invited(&self, welcome: Vec<u8>, now_ms: u64) -> Result<Joined, CoreError> {
        self.write(|device| Ok(device.join_invited(&welcome, now_ms)?.into()))
    }

    /// Signs the hub's sign-in challenge (32 bytes) with this device's key, for the room it belongs to at the
    /// hub `hub`, which must be the hub's canonical address. A device that is joining by link signs for the
    /// room of its invite once it checked the Reveal ([`CoreDevice::join_reveal`]), and only at the invite's
    /// hub (`bad-invite` for another). `no-room` for a device without a room and without such an invite. The
    /// result is posted as it is; the token the hub answers with is the host's.
    pub fn hub_sign_in(&self, hub: String, challenge: Vec<u8>) -> Result<SignedHubAuth, CoreError> {
        let challenge: [u8; CHALLENGE_LEN] = challenge
            .as_slice()
            .try_into()
            .map_err(|_| CoreError::bad_format("the challenge is not 32 bytes"))?;
        self.read(|device| {
            let signed = device.hub_sign_in(&HubAddress::parse(&hub)?, challenge)?;
            Ok(SignedHubAuth {
                auth: signed.auth,
                signature: signed.signature,
            })
        })
    }
}

/// One entry of the log, handed to the device.
fn log_entry(
    device: &mut Device<AnyStore>,
    entry: &LogEntry,
    now_ms: u64,
) -> Result<Processed, CoreError> {
    let kind = match entry.kind {
        LogEntryKind::Commit => LogKind::Commit {
            bytes: &entry.bytes,
            recovery_auth: entry.recovery_auth.as_deref(),
        },
        LogEntryKind::Message => LogKind::Message {
            bytes: &entry.bytes,
        },
    };
    let processed = device.process_log_entry(
        &core::LogEntry {
            change: entry.change,
            group: group_id(&entry.group)?,
            kind,
        },
        now_ms,
    )?;
    Ok(processed.into())
}

/// Whether `code` can be a hub's answer to a request (the table of section 16). What only a client finds
/// (`withheld`, `no-key`, `decrypt-failed` and the like), the account's own checks and what a device says only of
/// itself are no hub's answer; `equivocation` and `newer-version` are both.
fn is_hub_code(code: ErrorCode) -> bool {
    crate::error::is_core_code(code)
        && !matches!(
            code,
            ErrorCode::Withheld
                | ErrorCode::HubVoidedOther
                | ErrorCode::BadGroup
                | ErrorCode::NoKey
                | ErrorCode::Pruned
                | ErrorCode::DecryptFailed
                | ErrorCode::CodeNotConfirmed
                | ErrorCode::HashMismatch
                | ErrorCode::Cut
        )
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
