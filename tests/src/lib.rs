//! What the tests of the protocol core share: a hub in memory, a stand-in for the recovery construct, and the
//! few steps every scenario repeats (post the outbox, process the log, take the Welcomes).

pub mod forge;
pub mod hub;
pub mod store;

use hub::{Hub, LogItem};
use std::time::{SystemTime, UNIX_EPOCH};
pub use store::MemoryStorage;
use trommi_core::crypto::{Entropy, SystemEntropy};
use trommi_core::device::{
    log_finding, Accepted, Device, DeviceRecovery, Joined, LogEntry, LogFinding, LogKind,
    Processed, SealRequest, WelcomeExpectation,
};
use trommi_core::ids::{DeviceId, GroupId};
use trommi_core::mls::profile::Cut;
use trommi_core::mls::rules::{JoinClaim, RecoveryRules, SealedKeyClaim};
use trommi_core::Error;

/// The `RecoveryAuth` the stand-in accepts.
pub const TEST_RECOVERY_AUTH: &[u8] = b"test recovery auth";

/// A stand-in for the recovery construct of section 8, for tests only: its `SealedKey` is a readable tag and
/// seals nothing, and a join from outside is "authorised" by a fixed byte string when `joins` allows it.
#[derive(Debug, Clone, Copy, Default)]
pub struct TestRecovery {
    /// Whether [`TEST_RECOVERY_AUTH`] authorises a join from outside.
    pub joins: bool,
    /// Whether this device fails to make a `SealedKey`, as a human device without the `recovery_mac` does.
    pub cannot_seal: bool,
}

impl RecoveryRules for TestRecovery {
    fn verify_join(&self, claim: &JoinClaim<'_>) -> Result<(), Error> {
        if self.joins && claim.recovery_auth == Some(TEST_RECOVERY_AUTH) {
            Ok(())
        } else {
            Err(Error::BadSignature)
        }
    }

    fn verify_sealed_key(
        &self,
        claim: &SealedKeyClaim<'_>,
        sealed_key: &[u8],
    ) -> Result<(), Error> {
        let expected = format!(
            "test sealed key {} {} {}",
            claim.group, claim.epoch, claim.room_epoch
        );
        if sealed_key == expected.as_bytes() {
            Ok(())
        } else {
            Err(Error::Incomplete)
        }
    }
}

impl DeviceRecovery for TestRecovery {
    fn seal_key(
        &mut self,
        _: &mut dyn Entropy,
        request: &SealRequest<'_>,
    ) -> Result<Vec<u8>, Error> {
        if self.cannot_seal {
            return Err(Error::NoKey);
        }
        Ok(format!(
            "test sealed key {} {} {}",
            request.group, request.epoch, request.room_epoch
        )
        .into_bytes())
    }

    fn rules(&self) -> &dyn RecoveryRules {
        self
    }
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
    new_device_with(TestRecovery::default())
}

/// A new device with this stand-in.
pub fn new_device_with(recovery: TestRecovery) -> TestDevice {
    Device::create(
        MemoryStorage::new(),
        Box::new(SystemEntropy),
        Box::new(recovery),
    )
    .expect("a new device")
}

/// A new device in `store`. A test keeps `store.handle()` to see what the device wrote, to plan a failing
/// write, and to play a crash.
pub fn new_device_on(store: MemoryStorage) -> TestDevice {
    Device::create(
        store,
        Box::new(SystemEntropy),
        Box::new(TestRecovery::default()),
    )
    .expect("a new device")
}

/// The device a store holds: what a restart finds.
pub fn reopen(store: MemoryStorage) -> Result<TestDevice, Error> {
    Device::open(
        store,
        Box::new(SystemEntropy),
        Box::new(TestRecovery::default()),
    )
}

/// Posts everything in the device's outbox and reports each answer. Returns the answers in order.
pub fn post_all(hub: &mut Hub, device: &mut TestDevice) -> Vec<Result<Accepted, Error>> {
    let mut answers = Vec::new();
    for entry in device.outbox() {
        let answer = hub.post(&device.id(), &entry);
        match &answer {
            Ok(accepted) => device
                .outbox_accepted(entry.id, *accepted)
                .expect("the accepted entry is applied"),
            Err(code) => device
                .outbox_refused(entry.id, code)
                .expect("the refused entry is undone"),
        }
        answers.push(answer);
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
    device.process_log_entry(&LogEntry {
        change: item.change,
        group: item.group,
        kind,
    })
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
        .found_room([0xE1; 32], [0xE2; 32], now())
        .expect("the room is founded");
    post_ok(hub, founder);
    GroupId::room(room)
}

/// `adder` adds the new human device `newcomer` to the room group, and the newcomer joins from its Welcome.
pub fn add_human(hub: &mut Hub, adder: &mut TestDevice, newcomer: &mut TestDevice) {
    let package = newcomer.key_package(now()).expect("a key package");
    adder
        .add_human_device(&newcomer.id(), &package, now())
        .expect("the Add is built");
    post_ok(hub, adder);
    let joined = take_welcomes(hub, newcomer, hub.change());
    assert_eq!(joined.len(), 1, "the newcomer joins the room group");
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
