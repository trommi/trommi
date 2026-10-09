//! trommi-core for Swift. `Data` in, `Data` and plain records out; an error is an `MlsError` case with a message for
//! logs. The state store is a Swift object (`MlsStateStore`): the core calls it, synchronously, once per operation,
//! while it holds the device: the store must not call back into that device, nor wait for a queue that might.
//! The names carry a prefix because the Swift code that uses this has a `Device` and an `Entry` of its own.

use std::sync::{Arc, Mutex};

uniffi::setup_scaffolding!();

/// One stored entry.
#[derive(uniffi::Record)]
pub struct StateEntry {
    pub key: Vec<u8>,
    pub value: Vec<u8>,
}

/// A store failed (thrown by the Swift store, or its call did not come back).
#[derive(Debug, uniffi::Error)]
pub enum StoreFailure {
    Failed { message: String },
}

impl std::fmt::Display for StoreFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let StoreFailure::Failed { message } = self;
        f.write_str(message)
    }
}
impl std::error::Error for StoreFailure {}

impl From<uniffi::UnexpectedUniFFICallbackError> for StoreFailure {
    fn from(e: uniffi::UnexpectedUniFFICallbackError) -> Self {
        StoreFailure::Failed { message: e.reason }
    }
}

/// Where a device's state lives; implemented in Swift (a locked file in the App Group, SQLite ...). `apply` is one
/// operation's changes: all of them or none.
#[uniffi::export(with_foreign)]
pub trait MlsStateStore: Send + Sync {
    fn load(&self) -> Result<Vec<StateEntry>, StoreFailure>;
    fn apply(&self, put: Vec<StateEntry>, delete: Vec<Vec<u8>>) -> Result<(), StoreFailure>;
}

struct Store(Arc<dyn MlsStateStore>);

impl trommi_core::StateStore for Store {
    fn load(&self) -> Result<Vec<(Vec<u8>, Vec<u8>)>, trommi_core::StoreError> {
        let entries = self.0.load().map_err(|e| trommi_core::StoreError(e.to_string()))?;
        Ok(entries.into_iter().map(|e| (e.key, e.value)).collect())
    }
    fn apply(&mut self, put: Vec<(Vec<u8>, Vec<u8>)>, delete: Vec<Vec<u8>>) -> Result<(), trommi_core::StoreError> {
        let put = put.into_iter().map(|(key, value)| StateEntry { key, value }).collect();
        self.0.apply(put, delete).map_err(|e| trommi_core::StoreError(e.to_string()))
    }
}

#[derive(Debug, uniffi::Error)]
pub enum MlsError {
    Malformed { message: String },
    UnknownGroup { message: String },
    Evicted { message: String },
    UnknownMember { message: String },
    Rejected { message: String },
    Unsealed { message: String },
    Storage { message: String },
}

impl std::fmt::Display for MlsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for MlsError {}

impl From<trommi_core::CoreError> for MlsError {
    fn from(e: trommi_core::CoreError) -> Self {
        use trommi_core::ErrorKind::*;
        let message = e.message;
        match e.kind {
            Malformed => MlsError::Malformed { message },
            UnknownGroup => MlsError::UnknownGroup { message },
            Evicted => MlsError::Evicted { message },
            UnknownMember => MlsError::UnknownMember { message },
            Rejected => MlsError::Rejected { message },
            Unsealed => MlsError::Unsealed { message },
            Storage => MlsError::Storage { message },
        }
    }
}

/// What `addMember` returns: the commit for the members, the Welcome for the newcomer.
#[derive(uniffi::Record)]
pub struct AddedMember {
    pub commit: Vec<u8>,
    pub welcome: Vec<u8>,
}

/// What `processCommit` returns.
#[derive(uniffi::Record)]
pub struct ProcessedCommit {
    pub epoch: u64,
    pub removed: bool,
}

/// One device. Calls are serialised: one at a time per device.
#[derive(uniffi::Object)]
pub struct MlsDevice(Mutex<trommi_core::Device<Store>>);

impl MlsDevice {
    /// A panic inside an earlier call may have left the state in memory half changed: this object is finished, the
    /// caller loads the device again from its store.
    fn device(&self) -> Result<std::sync::MutexGuard<'_, trommi_core::Device<Store>>, MlsError> {
        self.0.lock().map_err(|_| MlsError::Storage { message: "an earlier call panicked: load the device again".into() })
    }

    fn with<T>(
        &self,
        f: impl FnOnce(&mut trommi_core::Device<Store>) -> Result<T, trommi_core::CoreError>,
    ) -> Result<T, MlsError> {
        f(&mut *self.device()?).map_err(MlsError::from)
    }
}

#[uniffi::export]
impl MlsDevice {
    /// A new device in an empty store.
    #[uniffi::constructor]
    pub fn create(identity: Vec<u8>, store: Arc<dyn MlsStateStore>) -> Result<Arc<Self>, MlsError> {
        Ok(Arc::new(MlsDevice(Mutex::new(trommi_core::Device::create(&identity, Store(store))?))))
    }

    /// The device a store holds.
    #[uniffi::constructor]
    pub fn load(store: Arc<dyn MlsStateStore>) -> Result<Arc<Self>, MlsError> {
        Ok(Arc::new(MlsDevice(Mutex::new(trommi_core::Device::load(Store(store))?))))
    }

    pub fn signature_key(&self) -> Result<Vec<u8>, MlsError> {
        Ok(self.device()?.signature_key())
    }

    pub fn key_package(&self) -> Result<Vec<u8>, MlsError> {
        self.with(|d| d.key_package())
    }

    pub fn found_group(&self, group_id: Vec<u8>) -> Result<(), MlsError> {
        self.with(|d| d.found_group(&group_id))
    }

    pub fn add_member(&self, group_id: Vec<u8>, key_package: Vec<u8>) -> Result<AddedMember, MlsError> {
        self.with(|d| d.add_member(&group_id, &key_package)).map(|a| AddedMember { commit: a.commit, welcome: a.welcome })
    }

    pub fn remove_member(&self, group_id: Vec<u8>, signature_key: Vec<u8>) -> Result<Vec<u8>, MlsError> {
        self.with(|d| d.remove_member(&group_id, &signature_key))
    }

    pub fn join(&self, welcome: Vec<u8>) -> Result<Vec<u8>, MlsError> {
        self.with(|d| d.join(&welcome))
    }

    pub fn process_commit(&self, group_id: Vec<u8>, commit: Vec<u8>) -> Result<ProcessedCommit, MlsError> {
        self.with(|d| d.process_commit(&group_id, &commit)).map(|p| ProcessedCommit { epoch: p.epoch, removed: p.removed })
    }

    pub fn epoch(&self, group_id: Vec<u8>) -> Result<u64, MlsError> {
        self.with(|d| d.epoch(&group_id))
    }

    pub fn members(&self, group_id: Vec<u8>) -> Result<Vec<Vec<u8>>, MlsError> {
        self.with(|d| d.members(&group_id))
    }

    pub fn export_key(&self, group_id: Vec<u8>, label: String, context: Vec<u8>) -> Result<Vec<u8>, MlsError> {
        self.with(|d| d.export_key(&group_id, &label, &context)).map(|k| k.to_vec())
    }
}

fn key32(key: &[u8]) -> Result<[u8; 32], MlsError> {
    key.try_into().map_err(|_| MlsError::Malformed { message: "a key is 32 bytes".into() })
}

/// AES-256-GCM under a 32-byte key: nonce ‖ ciphertext ‖ tag.
#[uniffi::export]
pub fn seal_body(key: Vec<u8>, aad: Vec<u8>, body: Vec<u8>) -> Result<Vec<u8>, MlsError> {
    Ok(trommi_core::seal(&key32(&key)?, &aad, &body)?)
}

#[uniffi::export]
pub fn open_body(key: Vec<u8>, aad: Vec<u8>, sealed: Vec<u8>) -> Result<Vec<u8>, MlsError> {
    Ok(trommi_core::open(&key32(&key)?, &aad, &sealed)?)
}
