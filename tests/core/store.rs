//! The store in memory that the tests use: whole batches, the revision check, planned failures, restarts.

use trommi_core::store::{Batch, Entry, Loaded, Storage, StorageError};
use trommi_tests::MemoryStorage;

fn batch(put: &[(&[u8], &[u8])], delete: &[&[u8]]) -> Batch {
    let mut batch = Batch::new();
    for (key, value) in put {
        batch.put(key.to_vec(), value.to_vec());
    }
    for key in delete {
        batch.delete(key.to_vec());
    }
    batch
}

#[test]
fn applies_a_batch_whole_and_counts_the_revision() {
    let mut store = MemoryStorage::new();
    assert_eq!(
        store.load().unwrap(),
        Loaded {
            revision: 0,
            entries: vec![]
        }
    );
    assert!(Batch::new().is_empty());

    store
        .apply(0, batch(&[(b"a", b"1"), (b"b", b"2")], &[]))
        .unwrap();
    store
        .apply(1, batch(&[(b"c", b"3"), (b"a", b"4")], &[b"b", b"missing"]))
        .unwrap();
    let loaded = store.load().unwrap();
    assert_eq!(loaded.revision, 2);
    assert_eq!(
        loaded.entries,
        [
            Entry::new(b"a".to_vec(), b"4".to_vec()),
            Entry::new(b"c".to_vec(), b"3".to_vec())
        ]
    );
    assert_eq!(store.get(b"c"), Some(b"3".to_vec()));
    assert_eq!(store.get(b"b"), None);
}

#[test]
fn a_key_deleted_and_put_in_one_batch_is_put_and_the_later_put_counts() {
    let mut store = MemoryStorage::new();
    store.apply(0, batch(&[(b"a", b"old")], &[])).unwrap();
    store
        .apply(1, batch(&[(b"a", b"new"), (b"a", b"newest")], &[b"a"]))
        .unwrap();
    assert_eq!(store.get(b"a"), Some(b"newest".to_vec()));
}

#[test]
fn refuses_another_revision_and_writes_nothing() {
    let mut store = MemoryStorage::new();
    store.apply(0, batch(&[(b"a", b"1")], &[])).unwrap();
    for wrong in [0, 2, u64::MAX] {
        assert_eq!(
            store.apply(wrong, batch(&[(b"a", b"x")], &[])),
            Err(StorageError::Conflict)
        );
    }
    assert_eq!(
        (store.revision(), store.get(b"a")),
        (1, Some(b"1".to_vec()))
    );
}

#[test]
fn a_second_owner_is_found_out() {
    let mut first = MemoryStorage::new();
    let mut second = first.handle();
    let revision = first.load().unwrap().revision;
    assert_eq!(second.load().unwrap().revision, revision);
    first
        .apply(revision, batch(&[(b"seq", b"1")], &[]))
        .unwrap();
    // The second owner still believes in the revision it loaded.
    assert_eq!(
        second.apply(revision, batch(&[(b"seq", b"1'")], &[])),
        Err(StorageError::Conflict)
    );
    assert_eq!(first.get(b"seq"), Some(b"1".to_vec()));
}

#[test]
fn a_planned_failure_writes_nothing_and_happens_once() {
    let mut store = MemoryStorage::new();
    store.fail_apply(2);
    store.apply(0, batch(&[(b"a", b"1")], &[])).unwrap();
    let failed = store.apply(1, batch(&[(b"a", b"2"), (b"b", b"2")], &[]));
    assert_eq!(failed, Err(StorageError::Failed("planned failure".into())));
    assert_eq!(
        (store.revision(), store.applied(), store.entries().len()),
        (1, 1, 1)
    );
    store.apply(1, batch(&[(b"a", b"3")], &[])).unwrap();
    assert_eq!(store.get(b"a"), Some(b"3".to_vec()));
}

#[test]
fn a_restart_finds_what_was_applied_and_nothing_else() {
    let mut store = MemoryStorage::new();
    store.apply(0, batch(&[(b"a", b"1")], &[])).unwrap();
    store.fail_apply(1);
    assert!(store.apply(1, batch(&[(b"a", b"lost")], &[])).is_err());

    let mut after = store.reopened();
    assert_eq!(
        after.load().unwrap(),
        Loaded {
            revision: 1,
            entries: vec![Entry::new(b"a".to_vec(), b"1".to_vec())]
        }
    );
    // The copy is its own store: writing to it does not reach the first.
    after.apply(1, batch(&[(b"a", b"2")], &[])).unwrap();
    assert_eq!(store.get(b"a"), Some(b"1".to_vec()));
    assert_eq!(after.applied(), 1);
}
