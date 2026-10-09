//! What the tests of the protocol core share: a hub in memory, a stand-in for the recovery construct, and the
//! few steps every scenario repeats (post the outbox, process the log, take the Welcomes).

pub mod hub;

use hub::{Hub, LogItem};
use std::time::{SystemTime, UNIX_EPOCH};
use trommi_core::crypto::{Entropy, SystemEntropy};
use trommi_core::device::{
    Accepted, Device, DeviceRecovery, Joined, LogEntry, LogKind, Processed, SealRequest,
    WelcomeExpectation,
};
use trommi_core::ids::DeviceId;
use trommi_core::mls::rules::{JoinClaim, RecoveryRules, SealedKeyClaim};
use trommi_core::store::MemoryStorage;
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
    let Some(room) = device
        .room()
        .or_else(|| hub.history().map(|_| hub_room(hub)))
    else {
        return Vec::new();
    };
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

/// A device id that no device holds.
pub fn stranger(byte: u8) -> DeviceId {
    DeviceId::new([byte; 32])
}
