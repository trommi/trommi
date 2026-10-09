//! The round trip as a program: what the connector's build must be able to link and run on each of its targets.
//!   cargo run --release -p trommi-core --example round_trip

use std::time::Instant;
use trommi_core::{open, seal, Device, MemoryStore};

fn main() {
    const GROUP: &[u8] = b"room-1";
    const LABEL: &str = "trommi body key";
    let start = Instant::now();
    let mut a = Device::create(b"device-a", MemoryStore::new()).unwrap();
    let mut b = Device::create(b"device-b", MemoryStore::new()).unwrap();
    let identities = start.elapsed();

    let start = Instant::now();
    a.found_group(GROUP).unwrap();
    let added = a.add_member(GROUP, &b.key_package().unwrap()).unwrap();
    b.join(&added.welcome).unwrap();
    let key = a.export_key(GROUP, LABEL, b"").unwrap();
    assert_eq!(key, b.export_key(GROUP, LABEL, b"").unwrap());
    let group = start.elapsed();

    let sealed = seal(&key, b"header", b"hello from A").unwrap();
    assert_eq!(open(&key, b"header", &sealed).unwrap(), b"hello from A");

    let commit = a.remove_member(GROUP, &b.signature_key()).unwrap();
    assert!(b.process_commit(GROUP, &commit).unwrap().removed);
    assert!(b.export_key(GROUP, LABEL, b"").is_err());
    assert_ne!(a.export_key(GROUP, LABEL, b"").unwrap(), key);

    let megabyte = vec![0u8; 1 << 20];
    let start = Instant::now();
    let sealed = seal(&key, b"", &megabyte).unwrap();
    let sealing = start.elapsed();
    let start = Instant::now();
    open(&key, b"", &sealed).unwrap();
    let opening = start.elapsed();

    println!(
        "OK {} {}: identities {:.2} ms; found, add, join, export {:.2} ms; 1 MiB seal {:.2} ms, open {:.2} ms; commit {} bytes, welcome {} bytes",
        std::env::consts::OS,
        std::env::consts::ARCH,
        identities.as_secs_f64() * 1e3,
        group.as_secs_f64() * 1e3,
        sealing.as_secs_f64() * 1e3,
        opening.as_secs_f64() * 1e3,
        added.commit.len(),
        added.welcome.len(),
    );
}
