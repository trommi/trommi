//! What the tests of the protocol core share: a hub in memory, the recovery code every test room is founded
//! with, and the few steps every scenario repeats (post the outbox, process the log, take the Welcomes, fetch
//! what a device that joins with the code is served).

pub mod content;
pub mod forge;
pub mod forge_content;
pub mod hub;
pub mod store;

use hub::content::{Change, StoredEnvelope};
use hub::{Hub, LogItem};
use std::time::{SystemTime, UNIX_EPOCH};
pub use store::MemoryStorage;
use trommi_core::crypto::SecretBytes;
use trommi_core::crypto::{Secret, SystemEntropy};
use trommi_core::device::{
    log_finding, Accepted, CodeJoin, Device, Joined, LogEntry, LogFinding, LogKind, Processed,
    WelcomeExpectation,
};
use trommi_core::device::{Draft, ReceivedEnvelope, Sealed};
use trommi_core::ids::{DeviceId, GroupId};
use trommi_core::mls::profile::Cut;
use trommi_core::recovery::{select_anchor, RecoveryKeys, ServedCommit, ServedGroup, ServedRoom};
use trommi_core::Error;

/// The recovery code of every room the tests found.
pub fn test_code() -> Secret<32> {
    Secret::new([0xC0; 32])
}

/// The keys of [`test_code`].
pub fn test_keys() -> RecoveryKeys {
    RecoveryKeys::from_code(test_code()).expect("the keys of the code")
}

/// A device in the tests.
pub type TestDevice = Device<MemoryStorage>;

/// The clock: OpenMLS checks KeyPackage lifetimes against the system's, so the tests use it too.
pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_millis() as u64)
}

/// A new device in a new store.
pub fn new_device() -> TestDevice {
    new_device_on(MemoryStorage::new())
}

/// A new device in `store`. A test keeps `store.handle()` to see what the device wrote, to plan a failing
/// write, and to play a crash.
pub fn new_device_on(store: MemoryStorage) -> TestDevice {
    Device::create(store, Box::new(SystemEntropy)).expect("a new device")
}

/// The device a store holds: what a restart finds.
pub fn reopen(store: MemoryStorage) -> Result<TestDevice, Error> {
    Device::open(store, Box::new(SystemEntropy))
}

/// Posts everything in the device's outbox and reports each answer, and again whatever an answer left to send
/// (the `recovery_mac` a device owes after its Add was accepted, 7.4). Returns the answers in order.
pub fn post_all(hub: &mut Hub, device: &mut TestDevice) -> Vec<Result<Accepted, Error>> {
    let mut answers = Vec::new();
    let mut kept = std::collections::BTreeSet::new();
    for _ in 0..8 {
        let outbox = device.outbox();
        if outbox.iter().all(|entry| kept.contains(&entry.id)) {
            break;
        }
        for entry in outbox {
            // A refusal may have taken other entries with it (a recovery goes whole).
            if !device.outbox().iter().any(|held| held.id == entry.id) || kept.contains(&entry.id) {
                continue;
            }
            let answer = hub.post(&device.id(), &entry);
            match &answer {
                Ok(accepted) => device
                    .outbox_accepted(entry.id, *accepted)
                    .expect("the accepted entry is applied"),
                // 9.0.8: an envelope refused with `voided: true` keeps its number; refused otherwise, it
                // stays in the outbox, and is not posted again in this round.
                Err(_) if hub.voided(&entry) => device
                    .outbox_voided(entry.id)
                    .expect("the voided entry goes"),
                Err(code) => {
                    device
                        .outbox_refused(entry.id, code)
                        .expect("the refused entry is undone");
                    kept.insert(entry.id);
                }
            }
            answers.push(answer);
        }
    }
    answers
}

/// Posts the outbox and expects every entry to be accepted.
pub fn post_ok(hub: &mut Hub, device: &mut TestDevice) {
    for answer in post_all(hub, device) {
        answer.expect("the hub accepts");
    }
}

/// Hands one log item to a device.
pub fn process(device: &mut TestDevice, item: &LogItem) -> Result<Processed, Error> {
    let kind = if item.commit {
        LogKind::Commit {
            bytes: &item.bytes,
            recovery_auth: item.recovery_auth.as_deref(),
        }
    } else {
        LogKind::Message { bytes: &item.bytes }
    };
    device.process_log_entry(
        &LogEntry {
            change: item.change,
            group: item.group,
            kind,
        },
        now(),
    )
}

/// Processes the hub's log after the device's cursor, in order, and takes every Welcome that is for the device
/// at its place in that order. Returns what each entry did.
pub fn sync(hub: &Hub, device: &mut TestDevice) -> Vec<Result<Processed, Error>> {
    let mut results = Vec::new();
    for item in hub.log_after(device.cursor()) {
        results.push(process(device, &item));
        take_welcomes(hub, device, item.change);
    }
    results
}

/// Processes the log and expects every entry to process.
pub fn sync_ok(hub: &Hub, device: &mut TestDevice) -> Vec<Processed> {
    sync(hub, device)
        .into_iter()
        .map(|result| result.expect("the entry processes"))
        .collect()
}

/// Joins every group whose Welcome at `change` is for this device.
pub fn take_welcomes(hub: &Hub, device: &mut TestDevice, change: u64) -> Vec<Joined> {
    let room = device.room().unwrap_or_else(|| hub_room(hub));
    let expected = WelcomeExpectation {
        room,
        committer: None,
    };
    hub.welcomes
        .iter()
        .filter(|welcome| welcome.change == change)
        .filter_map(|welcome| device.join_welcome(&welcome.bytes, &expected, now()).ok())
        .collect()
}

fn hub_room(hub: &Hub) -> trommi_core::ids::RoomId {
    hub.log
        .first()
        .map(|item| item.group.room_id())
        .or_else(|| {
            hub.group_infos
                .keys()
                .next()
                .map(|(group, _)| group.room_id())
        })
        .unwrap_or(trommi_core::ids::RoomId::ZERO)
}

/// Publishes the device's KeyPackages: a last-resort one and single-use ones up to the full number.
pub fn publish_key_packages(hub: &mut Hub, device: &mut TestDevice) {
    let unused = hub.unused(&device.id());
    device
        .key_packages_to_upload(unused, now())
        .expect("key packages are made");
    post_ok(hub, device);
}

/// `adder` adds `forger` to the room group as a human device. Returns the room group as the forger holds it.
pub fn add_forger(
    hub: &mut Hub,
    adder: &mut TestDevice,
    forger: &forge::Forger,
) -> openmls::group::MlsGroup {
    adder
        .add_human_device(&forger.id(), &forger.key_package(), now())
        .expect("the Add is built");
    post_ok(hub, adder);
    forger.join(&hub.welcomes.last().expect("a Welcome").bytes)
}

/// A device id that no device holds.
pub fn stranger(byte: u8) -> DeviceId {
    DeviceId::new([byte; 32])
}

/// Publishes a last-resort KeyPackage and `single_use` single-use ones: enough for a scenario, and quick.
pub fn publish_some(hub: &mut Hub, device: &mut TestDevice, single_use: usize) {
    let held = trommi_core::device::SINGLE_USE_KEY_PACKAGES.saturating_sub(single_use);
    device
        .key_packages_to_upload(held, now())
        .expect("key packages are made");
    post_ok(hub, device);
}

/// A checking hub and the room `founder` founds on it. Returns the hub and the room group.
pub fn found_room(founder: &mut TestDevice) -> (Hub, GroupId) {
    let mut hub = Hub::new(true);
    let group = found_room_on(&mut hub, founder);
    (hub, group)
}

/// Founds the room on `hub`. Returns the room group.
pub fn found_room_on(hub: &mut Hub, founder: &mut TestDevice) -> GroupId {
    let room = founder
        .found_room(&test_keys(), now())
        .expect("the room is founded");
    post_ok(hub, founder);
    GroupId::room(room)
}

/// The change number of the newest Welcome: where the Commit that added its device stands in the log.
pub fn added_at(hub: &Hub) -> u64 {
    hub.welcomes.last().map_or(0, |welcome| welcome.change)
}

/// `adder` adds the new human device `newcomer` to the room group, and the newcomer joins from its Welcome.
pub fn add_human(hub: &mut Hub, adder: &mut TestDevice, newcomer: &mut TestDevice) {
    let package = newcomer.key_package(now()).expect("a key package");
    adder
        .add_human_device(&newcomer.id(), &package, now())
        .expect("the Add is built");
    // The Add, and behind it the recovery_mac the adder owes the newcomer (7.4).
    post_ok(hub, adder);
    let added = added_at(hub);
    let joined = take_welcomes(hub, newcomer, added);
    assert_eq!(joined.len(), 1, "the newcomer joins the room group");
    for item in hub.log_after(added) {
        if !item.commit && item.group.is_room() {
            process(newcomer, &item).expect("the recovery_mac is taken");
        }
    }
    assert!(newcomer.holds_recovery_mac());
}

/// `adder` adds the human device `newcomer` to the session group `group` (5.2.7); the newcomer joins when it
/// next processes the log.
pub fn add_to_session(
    hub: &mut Hub,
    adder: &mut TestDevice,
    newcomer: &mut TestDevice,
    group: &GroupId,
) {
    let package = newcomer.key_package(now()).expect("a key package");
    adder
        .add_to_session(group, &newcomer.id(), &package, now())
        .expect("the Add is built");
    post_ok(hub, adder);
}

/// Starts `device` following the room group as an observer, from the hub's current GroupInfo (4.4).
pub fn observe(hub: &Hub, device: &mut TestDevice) {
    let room = hub_room(hub);
    let info = hub
        .group_info(&GroupId::room(room))
        .expect("the room's GroupInfo");
    device
        .observe_room(info, None)
        .expect("the room is followed");
}

/// `human` enrols `agent` as an agent device; the agent then follows the room group from that epoch.
pub fn enrol(hub: &mut Hub, human: &mut TestDevice, agent: &mut TestDevice) {
    human
        .change_agents(&[agent.id()], &[], now())
        .expect("the enrolment is built");
    post_ok(hub, human);
    observe(hub, agent);
}

/// `founder` founds a main session for `agent` with a KeyPackage claimed for it and for every other human
/// device of the room. Returns the session group; the others join when they next process the log.
pub fn found_main(hub: &mut Hub, founder: &mut TestDevice, agent: &DeviceId) -> GroupId {
    let room = founder.room().expect("a room");
    let mut needed: Vec<DeviceId> = founder
        .room_history()
        .expect("the room's roles")
        .newest()
        .humans
        .iter()
        .copied()
        .filter(|human| *human != founder.id())
        .collect();
    needed.push(*agent);
    let packages = hub.claim(&needed).expect("a KeyPackage of each");
    let session = founder
        .found_session(agent, &packages, now())
        .expect("the founding is built");
    post_ok(hub, founder);
    GroupId::session(room, session)
}

/// The opener `agent` founds a helper session under the main session group `parent`, with a KeyPackage claimed
/// for every human device and one made by each of `helpers`. Returns the helper session's group.
pub fn found_helper(
    hub: &mut Hub,
    agent: &mut TestDevice,
    parent: &GroupId,
    helpers: &mut [&mut TestDevice],
) -> GroupId {
    let room = agent.room().expect("a room");
    let humans: Vec<DeviceId> = agent
        .room_history()
        .expect("the room's roles")
        .newest()
        .humans
        .iter()
        .copied()
        .collect();
    let mut packages = hub.claim(&humans).expect("a KeyPackage of each");
    for helper in helpers {
        packages.push(helper.key_package(now()).expect("a key package"));
    }
    let parent = parent.session_id().expect("a session group");
    let session = agent
        .found_helper(&parent, &packages, now())
        .expect("the founding is built");
    post_ok(hub, agent);
    GroupId::session(room, session)
}

/// Processes the log like [`sync`] and expects every entry to process, except that entries behind what the
/// device holds are passed over: a device that began to follow a group at a later epoch meets the group's
/// earlier Commits as duplicates. Returns what the other entries did.
pub fn settle(hub: &Hub, device: &mut TestDevice) -> Vec<Processed> {
    sync(hub, device)
        .into_iter()
        .filter_map(|result| match result {
            Ok(processed) => Some(processed),
            Err(error) => {
                assert_eq!(
                    log_finding(&error),
                    LogFinding::Duplicate,
                    "the entry processes: {error:?}"
                );
                None
            }
        })
        .collect()
}

/// The Cuts for the leaves the room no longer allows in `group`, as `device` sees it: none of them has an
/// accepted envelope here.
pub fn cuts_for(device: &TestDevice, group: &GroupId) -> Vec<Cut> {
    device
        .group(group)
        .expect("the group")
        .disallowed
        .into_iter()
        .map(Cut::none)
        .collect()
}

/// Posts the outbox and expects every entry to be refused. Returns the codes in order.
pub fn post_refused(hub: &mut Hub, device: &mut TestDevice) -> Vec<Error> {
    post_all(hub, device)
        .into_iter()
        .map(|answer| answer.expect_err("the hub refuses"))
        .collect()
}

/// Processes the log like [`settle`] and returns the groups the device joined from Welcomes on the way.
pub fn settle_joining(hub: &Hub, device: &mut TestDevice) -> Vec<Joined> {
    let mut joined = Vec::new();
    for item in hub.log_after(device.cursor()) {
        if let Err(error) = process(device, &item) {
            assert_eq!(
                log_finding(&error),
                LogFinding::Duplicate,
                "the entry processes: {error:?}"
            );
        }
        joined.extend(take_welcomes(hub, device, item.change));
    }
    joined
}
pub mod vectors;

/// One group as a hub serves it to a device that joins with the code. A test changes the fields to play a
/// hub that lies.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchedGroup {
    pub group: GroupId,
    /// The founding GroupInfo.
    pub founding: Vec<u8>,
    /// Every Commit since, each with its change number and its `RecoveryAuth`.
    pub commits: Vec<(u64, Vec<u8>, Option<Vec<u8>>)>,
    /// The GroupInfo offered as current.
    pub current: Vec<u8>,
}

/// A room as a hub serves it to a device that joins with the code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fetched {
    pub room: FetchedGroup,
    /// The GroupInfo of the anchor's epoch.
    pub anchor: Vec<u8>,
    pub rows: Vec<Vec<u8>>,
    pub links: Vec<Vec<u8>>,
    /// The live session groups, main sessions first.
    pub sessions: Vec<FetchedGroup>,
}

/// What the hub holds of one group.
pub fn fetch_group(hub: &Hub, group: &GroupId) -> FetchedGroup {
    FetchedGroup {
        group: *group,
        founding: hub.group_info_at(group, 0).cloned().unwrap_or_default(),
        commits: hub.commits_of(group),
        current: hub.group_info(group).cloned().unwrap_or_default(),
    }
}

/// What the hub serves a device that holds `keys`: the room group, the rows and links, every live session
/// group, and the GroupInfo of the epoch that the device's anchor names.
pub fn fetch(hub: &Hub, keys: &RecoveryKeys) -> Fetched {
    let group = GroupId::room(hub_room(hub));
    let rows = hub.rows();
    let anchor = select_anchor(keys, &group.room_id(), &rows)
        .ok()
        .and_then(|anchor| hub.group_info_at(&group, anchor.epoch))
        .cloned()
        .unwrap_or_default();
    Fetched {
        room: fetch_group(hub, &group),
        anchor,
        rows,
        links: hub.links.clone(),
        sessions: hub
            .live_sessions()
            .iter()
            .map(|session| fetch_group(hub, session))
            .collect(),
    }
}

impl FetchedGroup {
    /// Hands `use_it` this group as the core takes it.
    pub fn served<T>(&self, use_it: impl FnOnce(&ServedGroup<'_>) -> T) -> T {
        let commits: Vec<ServedCommit<'_>> = self
            .commits
            .iter()
            .map(|(change, commit, recovery_auth)| ServedCommit {
                change: *change,
                commit,
                recovery_auth: recovery_auth.as_deref(),
            })
            .collect();
        use_it(&ServedGroup {
            founding: &self.founding,
            commits: &commits,
            current: &self.current,
        })
    }
}

impl Fetched {
    /// Hands `use_it` this room as the core takes it.
    pub fn served<T>(&self, use_it: impl FnOnce(&ServedRoom<'_>) -> T) -> T {
        let commits: Vec<Vec<ServedCommit<'_>>> = self
            .sessions
            .iter()
            .map(|session| {
                session
                    .commits
                    .iter()
                    .map(|(change, commit, recovery_auth)| ServedCommit {
                        change: *change,
                        commit,
                        recovery_auth: recovery_auth.as_deref(),
                    })
                    .collect()
            })
            .collect();
        let sessions: Vec<ServedGroup<'_>> = self
            .sessions
            .iter()
            .zip(&commits)
            .map(|(session, commits)| ServedGroup {
                founding: &session.founding,
                commits,
                current: &session.current,
            })
            .collect();
        self.room.served(|group| {
            use_it(&ServedRoom {
                room: self.room.group.room_id(),
                group: *group,
                anchor: &self.anchor,
                rows: &self.rows,
                links: &self.links,
                sessions: &sessions,
            })
        })
    }
}

/// `device` signs in with the code `keys` (8.4): it builds its join of the room group from what the hub
/// serves. Nothing is posted yet.
pub fn join_room(
    hub: &Hub,
    device: &mut TestDevice,
    keys: &RecoveryKeys,
) -> Result<CodeJoin, Error> {
    fetch(hub, keys).served(|served| device.join_room_with_code(keys, served, now()))
}

/// `device`, a human device that joined the room with the code, builds its join of the session `group`.
pub fn join_session(
    hub: &Hub,
    device: &mut TestDevice,
    keys: &RecoveryKeys,
    group: &GroupId,
) -> Result<u64, Error> {
    fetch_group(hub, group).served(|served| device.join_session_with_code(keys, served, now()))
}

/// `device` signs in with the code of the tests' rooms and joins the room group and every live session group.
pub fn sign_in(hub: &mut Hub, device: &mut TestDevice) {
    let keys = test_keys();
    join_room(hub, device, &keys).expect("the join is built");
    post_ok(hub, device);
    for group in hub.live_sessions() {
        join_session(hub, device, &keys, &group).expect("the join is built");
        post_ok(hub, device);
    }
}

/// Hands `device` everything of the room above its cursor in the hub's order: the log's entries, the Welcomes
/// at their place, and the envelopes. Returns what became of each envelope.
pub fn sync_all(hub: &Hub, device: &mut TestDevice) -> Vec<ReceivedEnvelope> {
    let mut received = Vec::new();
    for change in hub.changes_after(device.cursor()) {
        match change {
            Change::Log(item) => {
                if let Err(error) = process(device, &item) {
                    assert_eq!(
                        log_finding(&error),
                        LogFinding::Duplicate,
                        "the entry processes: {error:?}"
                    );
                }
                take_welcomes(hub, device, item.change);
            }
            Change::Envelope(stored) => received.push(take_envelope(device, &stored)),
        }
    }
    received
}

/// Hands one envelope to a device as the hub serves it in its order.
pub fn take_envelope(device: &mut TestDevice, stored: &StoredEnvelope) -> ReceivedEnvelope {
    device
        .receive_envelope(
            &stored.bytes,
            stored.change,
            true,
            stored.void_code.as_ref(),
            now(),
        )
        .expect("the device takes the envelope")
}

/// Seals `draft` on `device`, posts it, and expects the hub to accept it. Returns what sealing made.
pub fn write(hub: &mut Hub, device: &mut TestDevice, draft: &Draft) -> Sealed {
    let sealed = device
        .seal(draft, None, &[], now())
        .expect("the item seals");
    post_ok(hub, device);
    sealed
}

/// A JSON payload as a draft takes it.
pub fn json(text: &str) -> SecretBytes {
    SecretBytes::new(text.as_bytes().to_vec())
}
