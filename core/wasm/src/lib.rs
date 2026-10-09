//! trommi-core for the browser. Bytes are `Uint8Array`, an epoch is a `bigint`, an error is an `Error` whose `name`
//! is the kind (`Malformed`, `UnknownGroup`, `Evicted`, `UnknownMember`, `Rejected`, `Unsealed`, `Storage`).
//!
//! State: the core is synchronous and IndexedDB is not, so the store here is a queue. The page reads everything once
//! (`Device.load(entries)`), and after every call that changes state it takes the changes (`takeChanges()`), writes
//! them in one IndexedDB transaction and only then lets the returned bytes leave the device. If that transaction
//! fails, this device is ahead of the disk: the page drops it and loads again from what is stored. One device per
//! store at a time (a Web Lock held from before the load): the page's job, not built here. What the page stores are
//! the device's private keys as plain bytes: it wraps them before they reach IndexedDB.

use js_sys::{Array, Uint8Array};
use trommi_core::{CoreError, StateStore, StoreError};
use wasm_bindgen::prelude::*;

type Entry = (Vec<u8>, Vec<u8>);

#[derive(Default)]
struct QueueStore {
    initial: Vec<Entry>,
    put: Vec<Entry>,
    delete: Vec<Vec<u8>>,
}

impl StateStore for QueueStore {
    fn load(&self) -> Result<Vec<Entry>, StoreError> {
        Ok(self.initial.clone())
    }
    fn apply(&mut self, put: Vec<Entry>, delete: Vec<Vec<u8>>) -> Result<(), StoreError> {
        // A later batch wins over an earlier one for the same key.
        for key in &delete {
            self.put.retain(|(k, _)| k != key);
        }
        for (key, _) in &put {
            self.put.retain(|(k, _)| k != key);
            self.delete.retain(|k| k != key);
        }
        self.put.extend(put);
        self.delete.extend(delete);
        Ok(())
    }
}

fn js_error(e: CoreError) -> JsValue {
    let error = js_sys::Error::new(&e.message);
    error.set_name(&format!("{:?}", e.kind));
    error.into()
}

fn bytes(value: &[u8]) -> Uint8Array {
    Uint8Array::from(value)
}

fn key32(key: &[u8]) -> Result<[u8; 32], JsValue> {
    key.try_into().map_err(|_| {
        let error = js_sys::Error::new("a key is 32 bytes");
        error.set_name("Malformed");
        error.into()
    })
}

/// What `addMember` returns: the commit for the members, the Welcome for the newcomer.
#[wasm_bindgen]
pub struct Added {
    commit: Vec<u8>,
    welcome: Vec<u8>,
}

#[wasm_bindgen]
impl Added {
    #[wasm_bindgen(getter)]
    pub fn commit(&self) -> Uint8Array {
        bytes(&self.commit)
    }
    #[wasm_bindgen(getter)]
    pub fn welcome(&self) -> Uint8Array {
        bytes(&self.welcome)
    }
}

/// What `processCommit` returns.
#[wasm_bindgen]
pub struct Processed {
    pub epoch: u64,
    pub removed: bool,
}

/// What `takeChanges` returns: `put` is [key, value, key, value, ...], `remove` is [key, ...].
#[wasm_bindgen]
pub struct Changes {
    put: Array,
    remove: Array,
}

#[wasm_bindgen]
impl Changes {
    #[wasm_bindgen(getter)]
    pub fn put(&self) -> Array {
        self.put.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn remove(&self) -> Array {
        self.remove.clone()
    }
}

#[wasm_bindgen]
pub struct Device(trommi_core::Device<QueueStore>);

#[wasm_bindgen]
impl Device {
    /// A new device. Its first state is waiting in `takeChanges()`.
    pub fn create(identity: &[u8]) -> Result<Device, JsValue> {
        trommi_core::Device::create(identity, QueueStore::default()).map(Device).map_err(js_error)
    }

    /// The device stored before: `entries` is [key, value, key, value, ...], everything the page's store holds.
    pub fn load(entries: Array) -> Result<Device, JsValue> {
        let flat: Vec<Vec<u8>> = entries.iter().map(|v| Uint8Array::new(&v).to_vec()).collect();
        let initial = flat.chunks_exact(2).map(|pair| (pair[0].clone(), pair[1].clone())).collect();
        trommi_core::Device::load(QueueStore { initial, ..Default::default() }).map(Device).map_err(js_error)
    }

    /// Everything changed since the last call, to be written in one transaction.
    #[wasm_bindgen(js_name = takeChanges)]
    pub fn take_changes(&mut self) -> Changes {
        let store = self.0.store_mut();
        let put = Array::new();
        for (key, value) in store.put.drain(..) {
            put.push(&bytes(&key));
            put.push(&bytes(&value));
        }
        let remove = Array::new();
        for key in store.delete.drain(..) {
            remove.push(&bytes(&key));
        }
        Changes { put, remove }
    }

    #[wasm_bindgen(js_name = signatureKey)]
    pub fn signature_key(&self) -> Uint8Array {
        bytes(&self.0.signature_key())
    }

    #[wasm_bindgen(js_name = keyPackage)]
    pub fn key_package(&mut self) -> Result<Uint8Array, JsValue> {
        self.0.key_package().map(|b| bytes(&b)).map_err(js_error)
    }

    #[wasm_bindgen(js_name = foundGroup)]
    pub fn found_group(&mut self, group_id: &[u8]) -> Result<(), JsValue> {
        self.0.found_group(group_id).map_err(js_error)
    }

    #[wasm_bindgen(js_name = addMember)]
    pub fn add_member(&mut self, group_id: &[u8], key_package: &[u8]) -> Result<Added, JsValue> {
        let added = self.0.add_member(group_id, key_package).map_err(js_error)?;
        Ok(Added { commit: added.commit, welcome: added.welcome })
    }

    #[wasm_bindgen(js_name = removeMember)]
    pub fn remove_member(&mut self, group_id: &[u8], signature_key: &[u8]) -> Result<Uint8Array, JsValue> {
        self.0.remove_member(group_id, signature_key).map(|b| bytes(&b)).map_err(js_error)
    }

    pub fn join(&mut self, welcome: &[u8]) -> Result<Uint8Array, JsValue> {
        self.0.join(welcome).map(|b| bytes(&b)).map_err(js_error)
    }

    #[wasm_bindgen(js_name = processCommit)]
    pub fn process_commit(&mut self, group_id: &[u8], commit: &[u8]) -> Result<Processed, JsValue> {
        let processed = self.0.process_commit(group_id, commit).map_err(js_error)?;
        Ok(Processed { epoch: processed.epoch, removed: processed.removed })
    }

    pub fn epoch(&self, group_id: &[u8]) -> Result<u64, JsValue> {
        self.0.epoch(group_id).map_err(js_error)
    }

    /// The members' signature keys, in tree order.
    pub fn members(&self, group_id: &[u8]) -> Result<Array, JsValue> {
        let members = self.0.members(group_id).map_err(js_error)?;
        Ok(members.iter().map(|m| JsValue::from(bytes(m))).collect())
    }

    #[wasm_bindgen(js_name = exportKey)]
    pub fn export_key(&self, group_id: &[u8], label: &str, context: &[u8]) -> Result<Uint8Array, JsValue> {
        self.0.export_key(group_id, label, context).map(|k| bytes(&k)).map_err(js_error)
    }
}

/// AES-256-GCM under a 32-byte key: nonce ‖ ciphertext ‖ tag.
#[wasm_bindgen]
pub fn seal(key: &[u8], aad: &[u8], body: &[u8]) -> Result<Uint8Array, JsValue> {
    trommi_core::seal(&key32(key)?, aad, body).map(|b| bytes(&b)).map_err(js_error)
}

#[wasm_bindgen]
pub fn open(key: &[u8], aad: &[u8], sealed: &[u8]) -> Result<Uint8Array, JsValue> {
    trommi_core::open(&key32(key)?, aad, sealed).map(|b| bytes(&b)).map_err(js_error)
}
