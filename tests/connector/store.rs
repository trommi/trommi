//! The connector's state on disk (connector/src/store.rs): what the core's `Storage` contract asks (whole writes,
//! the revision, one owner), what a crash at any point leaves, and what damage is told apart from a torn write.
mod common;

use common::TempDir;
use std::os::unix::fs::PermissionsExt;
use trommi_connector::store::{Journal, StoreError, SIDE};
use trommi_connector::vault::Vault;
use trommi_core::store::{Batch, Storage, StorageError};

fn batch(key: &[u8], value: &[u8]) -> Batch {
    let mut batch = Batch::new();
    batch.put(key.to_vec(), value.to_vec());
    batch
}

fn side(name: &str) -> Vec<u8> {
    let mut key = vec![SIDE];
    key.extend_from_slice(name.as_bytes());
    key
}

/// Applies `count` batches of the core, one record each.
fn fill(journal: &Journal, count: u64) {
    let mut store = journal.core_store();
    let revision = store.load().expect("loads").revision;
    for i in 0..count {
        store
            .apply(revision + i, batch(&[1, i as u8], &[i as u8; 8]))
            .expect("applied");
        journal.commit().expect("written");
    }
}

fn reopen(dir: &TempDir, journal: Journal) -> Journal {
    drop(journal);
    Journal::open(dir.path()).expect("opens again")
}

#[test]
fn a_committed_write_is_there_after_a_restart_and_a_staged_one_is_not() {
    let dir = TempDir::new("store");
    let journal = Journal::open(dir.path()).expect("opens");
    let mut store = journal.core_store();
    assert_eq!(store.load().expect("loads").revision, 0);
    store.apply(0, batch(&[1, 1], b"one")).expect("staged");
    journal.put(side("mine"), b"beside".to_vec());
    journal.commit().expect("written");
    // Staged and never committed: the process dies here.
    store.apply(1, batch(&[1, 2], b"two")).expect("staged");
    journal.put(side("lost"), b"x".to_vec());
    drop(store);

    let journal = reopen(&dir, journal);
    let mut store = journal.core_store();
    let loaded = store.load().expect("loads");
    assert_eq!(
        loaded.revision, 1,
        "the revision counts committed batches of the core"
    );
    assert_eq!(
        loaded.entries.len(),
        1,
        "the core sees its own entries only"
    );
    assert_eq!(loaded.entries[0].value, b"one");
    assert_eq!(
        journal.get(&side("mine")).expect("kept").as_slice(),
        b"beside"
    );
    assert!(journal.get(&side("lost")).is_none());
}

#[test]
fn a_batch_that_names_another_revision_is_refused_and_writes_nothing() {
    let dir = TempDir::new("store");
    let journal = Journal::open(dir.path()).expect("opens");
    let mut store = journal.core_store();
    store.apply(0, batch(&[1, 1], b"one")).expect("staged");
    assert_eq!(
        store.apply(0, batch(&[1, 1], b"other")),
        Err(StorageError::Conflict)
    );
    assert_eq!(
        store.apply(5, batch(&[1, 1], b"other")),
        Err(StorageError::Conflict)
    );
    journal.commit().expect("written");
    assert_eq!(journal.get(&[1, 1]).expect("kept").as_slice(), b"one");
    // A key of the connector's own table never comes from the core.
    assert!(matches!(
        store.apply(1, batch(&side("x"), b"y")),
        Err(StorageError::Failed(_))
    ));
}

#[test]
fn one_process_owns_a_state() {
    let dir = TempDir::new("store");
    let journal = Journal::open(dir.path()).expect("opens");
    assert_eq!(Journal::open(dir.path()).err(), Some(StoreError::Locked));
    // Every handle of the first owner must be gone before the next one gets in.
    let second_handle = journal.clone();
    drop(journal);
    assert_eq!(Journal::open(dir.path()).err(), Some(StoreError::Locked));
    drop(second_handle);
    Journal::open(dir.path()).expect("free again");
}

#[test]
fn the_directory_and_its_files_are_private() {
    let dir = TempDir::new("store");
    let state = dir.path().join("slot");
    let journal = Journal::open(&state).expect("opens");
    fill(&journal, 1);
    let mode = |path: &std::path::Path| {
        std::fs::metadata(path).expect("there").permissions().mode() & 0o777
    };
    assert_eq!(mode(&state), 0o700);
    for name in ["lock", "state.log"] {
        assert_eq!(mode(&state.join(name)), 0o600, "{name}");
    }
}

#[test]
fn a_write_that_was_cut_short_is_dropped_and_what_was_before_stands() {
    let dir = TempDir::new("store");
    let journal = Journal::open(dir.path()).expect("opens");
    fill(&journal, 3);
    drop(journal);
    let log = dir.path().join("state.log");
    let whole = std::fs::read(&log).expect("the log");
    let one = whole.len() / 3;
    // Every length a crash can leave of the third record: nothing, a part of its header, a part of its body,
    // all but its last byte.
    for cut in [0, 2, 7, one / 2, one - 1] {
        std::fs::write(&log, &whole[..2 * one + cut]).expect("cut");
        let journal = Journal::open(dir.path()).expect("a torn tail is no damage");
        let loaded = journal.core_store().load().expect("loads");
        assert_eq!(
            (loaded.revision, loaded.entries.len()),
            (2, 2),
            "cut at {cut}"
        );
        // The next write lands where the torn one was.
        fill(&journal, 1);
        let journal = reopen(&dir, journal);
        assert_eq!(journal.core_store().load().expect("loads").revision, 3);
        drop(journal);
        std::fs::write(&log, &whole).expect("back");
    }
    // The last record whole but with a wrong byte: written by a crash, not acknowledged, dropped.
    let mut flipped = whole.clone();
    *flipped.last_mut().expect("bytes") ^= 1;
    std::fs::write(&log, &flipped).expect("flipped");
    let journal = Journal::open(dir.path()).expect("a torn tail is no damage");
    assert_eq!(journal.core_store().load().expect("loads").revision, 2);
}

#[test]
fn damage_in_the_middle_is_told_and_nothing_is_made_up() {
    let dir = TempDir::new("store");
    let journal = Journal::open(dir.path()).expect("opens");
    fill(&journal, 3);
    drop(journal);
    let log = dir.path().join("state.log");
    let whole = std::fs::read(&log).expect("the log");
    let mut flipped = whole.clone();
    flipped[whole.len() / 3 + 20] ^= 0x40;
    std::fs::write(&log, &flipped).expect("flipped");
    assert!(matches!(
        Journal::open(dir.path()),
        Err(StoreError::Damaged(_))
    ));
    // A record gone from the middle: the numbers no longer follow.
    let one = whole.len() / 3;
    let mut missing = whole[..one].to_vec();
    missing.extend_from_slice(&whole[2 * one..]);
    std::fs::write(&log, &missing).expect("cut out");
    assert!(matches!(
        Journal::open(dir.path()),
        Err(StoreError::Damaged(_))
    ));
    // The files stay as they are: nothing was rewritten, no new key was made.
    assert_eq!(std::fs::read(&log).expect("the log"), missing);
}

#[test]
fn the_log_is_folded_into_a_snapshot_and_a_crash_in_between_loses_nothing() {
    let dir = TempDir::new("store");
    let journal = Journal::open(dir.path()).expect("opens");
    let mut store = journal.core_store();
    // Enough to pass the size at which the log is folded.
    let big = vec![7u8; 300_000];
    for i in 0..5u64 {
        store.apply(i, batch(&[1, i as u8], &big)).expect("staged");
        journal.put(side(&format!("n{i}")), vec![i as u8]);
        let log_before = std::fs::read(dir.path().join("state.log")).expect("the log");
        journal.commit().expect("written");
        if dir.path().join("state.snap").exists() && i == 3 {
            // The crash between the snapshot's rename and the log's emptying: both hold the same records.
            let snapshot = std::fs::read(dir.path().join("state.snap")).expect("the snapshot");
            drop(store);
            drop(journal);
            let log = log_before;
            // The record of this commit was appended before the fold; rebuild the log as it stood then.
            let journal = Journal::open(dir.path()).expect("opens");
            assert_eq!(journal.core_store().load().expect("loads").revision, 4);
            drop(journal);
            std::fs::write(dir.path().join("state.snap"), &snapshot).expect("the snapshot");
            std::fs::write(dir.path().join("state.log"), &log)
                .expect("the old log beside the new snapshot");
            let journal =
                Journal::open(dir.path()).expect("records the snapshot holds are passed over");
            let loaded = journal.core_store().load().expect("loads");
            assert_eq!((loaded.revision, loaded.entries.len()), (4, 4));
            assert_eq!(journal.get(&side("n3")).expect("kept").as_slice(), &[3]);
            return;
        }
    }
    panic!("the log was never folded");
}

#[test]
fn a_snapshot_that_is_not_one_is_damage() {
    let dir = TempDir::new("store");
    drop(Journal::open(dir.path()).expect("opens"));
    for bytes in [
        &b"junk"[..],
        &[0u8; 64][..],
        b"TROMMI-STATE-03\n and more than forty-eight bytes of something else",
    ] {
        std::fs::write(dir.path().join("state.snap"), bytes).expect("written");
        assert!(matches!(
            Journal::open(dir.path()),
            Err(StoreError::Damaged(_))
        ));
    }
}

#[test]
fn a_device_is_the_same_after_a_restart_and_a_damaged_state_is_not_rekeyed() {
    let dir = TempDir::new("store");
    let journal = Journal::open(dir.path()).expect("opens");
    let vault = Vault::create(journal.clone()).expect("a device");
    let id = vault.me();
    drop(vault);
    let journal = reopen(&dir, journal);
    let vault = Vault::open(journal.clone()).expect("the same device");
    assert_eq!(vault.me(), id);
    // A second device in a state that holds one is refused.
    assert!(Vault::create(journal.clone()).is_err());
    drop(vault);
    drop(journal);

    // The device's entries cut off mid-record: opening says so and leaves the files alone.
    let log = dir.path().join("state.log");
    let whole = std::fs::read(&log).expect("the log");
    std::fs::write(&log, &whole[..whole.len() / 2]).expect("cut");
    let journal = Journal::open(dir.path()).expect("a torn tail");
    let opened = Vault::open(journal.clone());
    assert_eq!(
        opened.err().map(|fault| fault.code),
        Some("state-damaged".to_string())
    );
    assert!(journal.is_empty(), "nothing was written in its place");
}

#[test]
fn a_wiped_state_is_gone() {
    let dir = TempDir::new("store");
    let journal = Journal::open(dir.path()).expect("opens");
    fill(&journal, 2);
    journal.wipe().expect("wiped");
    assert!(
        journal.commit().is_err(),
        "a wiped journal writes nothing more"
    );
    let journal = reopen(&dir, journal);
    assert!(journal.is_empty());
}
