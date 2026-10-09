//! Cost: the sizes of what travels and the time of each operation, for groups of 3, 10 and 30 leaves in
//! steady state (every leaf has committed once, so the tree has no blank node), and the time to catch up on
//! 200 Commits. The numbers are printed (`--nocapture`); only loose upper bounds are asserted. Times are of a
//! test build: the dependencies optimised, the core itself not.

use std::time::{Duration, Instant};
use trommi_core::ids::GroupId;
use trommi_core::mls::profile::{Cut, MAX_COMMIT_REQUEST_LEN, MAX_KEY_PACKAGE_LEN};
use trommi_core::store::OutboxEntry;
use trommi_tests::hub::Hub;
use trommi_tests::{
    add_human, found_room, new_device, now, post_ok, process, settle, sync_ok, take_welcomes,
    TestDevice,
};

/// A room group of `leaves` human devices, each of which has committed once.
fn steady_group(leaves: usize) -> (Hub, Vec<TestDevice>, GroupId) {
    let mut devices = vec![new_device()];
    let (mut hub, room_group) = found_room(&mut devices[0]);
    for _ in 1..leaves {
        let mut newcomer = new_device();
        add_human(&mut hub, &mut devices[0], &mut newcomer);
        devices.push(newcomer);
    }
    for at in 0..leaves {
        for device in &mut devices {
            settle(&hub, device);
        }
        devices[at]
            .update(&room_group, true, now())
            .unwrap()
            .unwrap();
        post_ok(&mut hub, &mut devices[at]);
    }
    for device in &mut devices {
        settle(&hub, device);
    }
    (hub, devices, room_group)
}

/// The sizes of a Commit request's parts: Commit, GroupInfo, Welcome.
fn sizes(entry: &OutboxEntry) -> (usize, usize, usize) {
    (
        entry.parts[0].len(),
        entry.parts[1].len(),
        entry.parts[2].len(),
    )
}

fn millis(time: Duration) -> f64 {
    time.as_secs_f64() * 1000.0
}

#[test]
fn sizes_and_times_for_groups_of_3_10_and_30_leaves() {
    println!(
        "leaves | what                | Commit  | GroupInfo | Welcome | build ms | process ms"
    );
    for leaves in [3usize, 10, 30] {
        let (mut hub, mut devices, room_group) = steady_group(leaves);
        let (first, rest) = devices.split_at_mut(1);
        let (committer, other) = (&mut first[0], &mut rest[0]);
        let row = |what: &str, entry: &OutboxEntry, build: Duration, processed: Duration| {
            let (commit, info, welcome) = sizes(entry);
            println!(
                "{leaves:6} | {what:19} | {commit:7} | {info:9} | {welcome:7} | {:8.2} | {:10.2}",
                millis(build),
                millis(processed)
            );
            // One request stays far below the hub's limit for a Commit with its GroupInfo and Welcome.
            assert!(commit + info + welcome < MAX_COMMIT_REQUEST_LEN / 8);
            assert!(build < Duration::from_secs(5) && processed < Duration::from_secs(5));
            (commit, info, welcome)
        };

        // An own-leaf update: a Commit with a path and nothing else.
        let start = Instant::now();
        committer.update(&room_group, true, now()).unwrap().unwrap();
        let build = start.elapsed();
        let entry = committer.outbox().remove(0);
        post_ok(&mut hub, committer);
        let item = hub.log.last().unwrap().clone();
        let start = Instant::now();
        process(other, &item).unwrap();
        let update = row("update", &entry, build, start.elapsed());
        assert_eq!(update.2, 0);

        // An Add: a Commit without a path, with its Welcome; the time to process is the newcomer's join.
        let mut newcomer = new_device();
        let package = newcomer.key_package(now()).unwrap();
        assert!(package.len() < MAX_KEY_PACKAGE_LEN / 4);
        let start = Instant::now();
        committer
            .add_human_device(&newcomer.id(), &package, now())
            .unwrap();
        let build = start.elapsed();
        let entry = committer.outbox().remove(0);
        post_ok(&mut hub, committer);
        let start = Instant::now();
        assert_eq!(take_welcomes(&hub, &mut newcomer, hub.change()).len(), 1);
        let add = row("add, join by Welcome", &entry, build, start.elapsed());
        assert!(add.2 > 0);
        sync_ok(&hub, other);

        // A Remove: a Commit with a path that leaves the removed leaf out.
        let start = Instant::now();
        committer
            .remove_human_devices(&[Cut::none(newcomer.id())], now())
            .unwrap();
        let build = start.elapsed();
        let entry = committer.outbox().remove(0);
        post_ok(&mut hub, committer);
        let item = hub.log.last().unwrap().clone();
        let start = Instant::now();
        process(other, &item).unwrap();
        let remove = row("remove", &entry, build, start.elapsed());
        println!(
            "{leaves:6} | KeyPackage {} bytes, GroupInfo per leaf {} bytes",
            package.len(),
            update.1 / leaves
        );
        // The GroupInfo and the Welcome carry the tree: they grow with the leaves, a Commit with their
        // logarithm.
        assert!(update.1 < 1024 * leaves + 2048);
        assert!(add.2 < 1024 * (leaves + 1) + 4096);
        assert!(update.0 < 8192 && remove.0 < 8192 && add.0 < 2048);
    }
}

#[test]
fn the_time_to_catch_up_on_two_hundred_commits() {
    const COMMITS: usize = 200;
    let (mut a, mut b) = (new_device(), new_device());
    let (mut hub, room_group) = found_room(&mut a);
    add_human(&mut hub, &mut a, &mut b);
    settle(&hub, &mut b);
    let start = Instant::now();
    for _ in 0..COMMITS {
        a.update(&room_group, true, now()).unwrap().unwrap();
        post_ok(&mut hub, &mut a);
    }
    let made = start.elapsed();
    let bytes: usize = hub
        .log_after(b.cursor())
        .iter()
        .map(|item| item.bytes.len())
        .sum();
    let start = Instant::now();
    assert_eq!(sync_ok(&hub, &mut b).len(), COMMITS);
    let caught_up = start.elapsed();
    println!(
        "{COMMITS} Commits in a group of 2: made, checked by the hub and merged in {:.0} ms ({:.2} ms each); \
         caught up in {:.0} ms ({:.2} ms each); {bytes} bytes of Commits ({} each)",
        millis(made),
        millis(made) / COMMITS as f64,
        millis(caught_up),
        millis(caught_up) / COMMITS as f64,
        bytes / COMMITS
    );
    assert!(caught_up < Duration::from_secs(60));
    assert_eq!(
        a.content_key(&room_group, 201).unwrap(),
        b.content_key(&room_group, 201).unwrap()
    );
}
