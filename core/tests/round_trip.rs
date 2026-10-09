//! The round trip the three clients must be able to do: found, add, join, same key, seal and open; remove, new epoch,
//! the removed device has no key any more. Run natively here, in a browser (core/wasm) and from Swift (core/swift).

use trommi_core::{open, seal, Device, ErrorKind, MemoryStore, StateStore, StoreError};

const GROUP: &[u8] = b"room-1";
const LABEL: &str = "trommi body key";

#[test]
fn found_add_join_seal_open_remove() {
    let mut a = Device::create(b"device-a", MemoryStore::new()).unwrap();
    let mut b = Device::create(b"device-b", MemoryStore::new()).unwrap();

    a.found_group(GROUP).unwrap();
    assert_eq!(a.epoch(GROUP).unwrap(), 0);

    let added = a.add_member(GROUP, &b.key_package().unwrap()).unwrap();
    assert_eq!(a.epoch(GROUP).unwrap(), 1);
    assert_eq!(b.join(&added.welcome).unwrap(), GROUP);
    assert_eq!(b.epoch(GROUP).unwrap(), 1);
    assert_eq!(a.members(GROUP).unwrap(), vec![a.signature_key(), b.signature_key()]);
    assert_eq!(b.members(GROUP).unwrap(), a.members(GROUP).unwrap());

    // Both export the same key; another label or context gives another key.
    let key_a = a.export_key(GROUP, LABEL, b"").unwrap();
    let key_b = b.export_key(GROUP, LABEL, b"").unwrap();
    assert_eq!(key_a, key_b);
    assert_ne!(key_a, a.export_key(GROUP, "another label", b"").unwrap());
    assert_ne!(key_a, a.export_key(GROUP, LABEL, b"context").unwrap());

    // A seals, B opens.
    let sealed = seal(&key_a, b"header", b"hello from A").unwrap();
    assert_eq!(open(&key_b, b"header", &sealed).unwrap(), b"hello from A");
    assert_eq!(open(&key_b, b"other header", &sealed).unwrap_err().kind, ErrorKind::Unsealed);
    let mut changed = sealed.clone();
    *changed.last_mut().unwrap() ^= 1;
    assert_eq!(open(&key_b, b"header", &changed).unwrap_err().kind, ErrorKind::Unsealed);

    // A removes B: a new epoch and a new key.
    let commit = a.remove_member(GROUP, &b.signature_key()).unwrap();
    assert_eq!(a.epoch(GROUP).unwrap(), 2);
    assert_eq!(a.members(GROUP).unwrap(), vec![a.signature_key()]);
    let key_a2 = a.export_key(GROUP, LABEL, b"").unwrap();
    assert_ne!(key_a2, key_a);
    let sealed2 = seal(&key_a2, b"header", b"after the removal").unwrap();

    // B before it sees the commit: still the old epoch, the old key, which opens nothing new.
    assert_eq!(b.export_key(GROUP, LABEL, b"").unwrap(), key_a);
    assert_eq!(open(&key_b, b"header", &sealed2).unwrap_err().kind, ErrorKind::Unsealed);

    // B after the commit: removed, and no key at all.
    let processed = b.process_commit(GROUP, &commit).unwrap();
    assert!(processed.removed);
    assert_eq!(b.export_key(GROUP, LABEL, b"").unwrap_err().kind, ErrorKind::Evicted);
}

#[test]
fn a_third_device_follows_by_commit() {
    let mut a = Device::create(b"a", MemoryStore::new()).unwrap();
    let mut b = Device::create(b"b", MemoryStore::new()).unwrap();
    let mut c = Device::create(b"c", MemoryStore::new()).unwrap();
    a.found_group(GROUP).unwrap();
    let added_b = a.add_member(GROUP, &b.key_package().unwrap()).unwrap();
    b.join(&added_b.welcome).unwrap();
    let added_c = a.add_member(GROUP, &c.key_package().unwrap()).unwrap();
    c.join(&added_c.welcome).unwrap();

    // B is a member already: it follows through the commit.
    let processed = b.process_commit(GROUP, &added_c.commit).unwrap();
    assert_eq!((processed.epoch, processed.removed), (2, false));
    let key = a.export_key(GROUP, LABEL, b"").unwrap();
    assert_eq!(b.export_key(GROUP, LABEL, b"").unwrap(), key);
    assert_eq!(c.export_key(GROUP, LABEL, b"").unwrap(), key);

    // The same commit twice, or bytes that are no commit: refused, and the state is as before.
    assert_eq!(b.process_commit(GROUP, &added_c.commit).unwrap_err().kind, ErrorKind::Rejected);
    assert_eq!(b.process_commit(GROUP, b"nonsense").unwrap_err().kind, ErrorKind::Malformed);
    assert_eq!(b.process_commit(GROUP, &added_c.welcome).unwrap_err().kind, ErrorKind::Malformed);
    assert_eq!(b.export_key(GROUP, LABEL, b"").unwrap(), key);
    assert_eq!(b.export_key(b"no such group", LABEL, b"").unwrap_err().kind, ErrorKind::UnknownGroup);
    assert_eq!(a.remove_member(GROUP, b"nobody").unwrap_err().kind, ErrorKind::UnknownMember);

    // A key package is for one use: a second Welcome for the same one finds no key.
    let mut d = Device::create(b"d", MemoryStore::new()).unwrap();
    d.found_group(b"room-2").unwrap();
    assert_eq!(c.join(&added_c.welcome).unwrap_err().kind, ErrorKind::Rejected);
}

#[test]
fn the_state_survives_in_the_store() {
    let mut a = Device::create(b"a", MemoryStore::new()).unwrap();
    let mut b = Device::create(b"b", MemoryStore::new()).unwrap();
    a.found_group(GROUP).unwrap();
    let key_package = b.key_package().unwrap();

    // Both devices are dropped and opened again from what their stores hold; B still has the key package's secret.
    let mut a = Device::load(MemoryStore::from_entries(a.store().load().unwrap())).unwrap();
    let mut b = Device::load(MemoryStore::from_entries(b.store().load().unwrap())).unwrap();
    let added = a.add_member(GROUP, &key_package).unwrap();
    assert_eq!(a.store().batches, 1, "one operation, one batch");
    b.join(&added.welcome).unwrap();

    let a = Device::load(MemoryStore::from_entries(a.store().load().unwrap())).unwrap();
    let b = Device::load(MemoryStore::from_entries(b.store().load().unwrap())).unwrap();
    assert_eq!(a.epoch(GROUP).unwrap(), 1);
    assert_eq!(a.export_key(GROUP, LABEL, b"").unwrap(), b.export_key(GROUP, LABEL, b"").unwrap());

    assert_eq!(Device::load(MemoryStore::new()).err().unwrap().kind, ErrorKind::Malformed);
    assert_eq!(Device::create(b"x", MemoryStore::from_entries(a.store().load().unwrap())).err().unwrap().kind, ErrorKind::Rejected);
}

/// A store that refuses the next batch when told to.
#[derive(Default)]
struct FailingStore {
    inner: MemoryStore,
    fail: std::rc::Rc<std::cell::Cell<bool>>,
}

impl StateStore for FailingStore {
    fn load(&self) -> Result<Vec<(Vec<u8>, Vec<u8>)>, StoreError> {
        self.inner.load()
    }
    fn apply(&mut self, put: Vec<(Vec<u8>, Vec<u8>)>, delete: Vec<Vec<u8>>) -> Result<(), StoreError> {
        if self.fail.replace(false) {
            return Err(StoreError("disk full".into()));
        }
        self.inner.apply(put, delete)
    }
}

#[test]
fn a_failed_write_undoes_the_operation() {
    let fail = std::rc::Rc::new(std::cell::Cell::new(false));
    let mut a = Device::create(b"a", FailingStore { inner: MemoryStore::new(), fail: fail.clone() }).unwrap();
    let mut b = Device::create(b"b", MemoryStore::new()).unwrap();
    a.found_group(GROUP).unwrap();
    let added = a.add_member(GROUP, &b.key_package().unwrap()).unwrap();
    b.join(&added.welcome).unwrap();
    let key = a.export_key(GROUP, LABEL, b"").unwrap();
    let stored = a.store().inner.load().unwrap().len();

    // The store refuses the removal's batch: no commit comes out, the epoch and the key are as before.
    fail.set(true);
    assert_eq!(a.remove_member(GROUP, &b.signature_key()).unwrap_err().kind, ErrorKind::Storage);
    assert_eq!(a.epoch(GROUP).unwrap(), 1);
    assert_eq!(a.export_key(GROUP, LABEL, b"").unwrap(), key);
    assert_eq!(a.members(GROUP).unwrap().len(), 2);
    assert_eq!(a.store().inner.load().unwrap().len(), stored);

    // The next operation stores only its own changes, and the group goes on: B follows the commit.
    let commit = a.remove_member(GROUP, &b.signature_key()).unwrap();
    assert_eq!(a.epoch(GROUP).unwrap(), 2);
    assert!(b.process_commit(GROUP, &commit).unwrap().removed);
    let again = Device::load(MemoryStore::from_entries(a.store().inner.load().unwrap())).unwrap();
    assert_eq!(again.export_key(GROUP, LABEL, b"").unwrap(), a.export_key(GROUP, LABEL, b"").unwrap());
}

#[test]
fn a_welcome_cannot_replace_a_group() {
    let mut a = Device::create(b"a", MemoryStore::new()).unwrap();
    let mut b = Device::create(b"b", MemoryStore::new()).unwrap();
    let mut stranger = Device::create(b"stranger", MemoryStore::new()).unwrap();
    a.found_group(GROUP).unwrap();
    let added = a.add_member(GROUP, &b.key_package().unwrap()).unwrap();
    b.join(&added.welcome).unwrap();
    let key = b.export_key(GROUP, LABEL, b"").unwrap();

    // Someone else founds a group with the same id and welcomes B into it with a fresh key package of B's.
    stranger.found_group(GROUP).unwrap();
    let theirs = stranger.add_member(GROUP, &b.key_package().unwrap()).unwrap();
    assert_eq!(b.join(&theirs.welcome).unwrap_err().kind, ErrorKind::Rejected);
    assert_eq!(b.export_key(GROUP, LABEL, b"").unwrap(), key);
    assert_eq!(b.members(GROUP).unwrap(), a.members(GROUP).unwrap());

    assert_eq!(format!("{:?}", MemoryStore::from_entries(b.store().load().unwrap())).contains("entries"), true);
}
