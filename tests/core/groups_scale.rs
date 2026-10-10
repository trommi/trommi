//! A room as it grows to its limit of human devices (section 16), by the real paths: what each step costs
//! in bytes and time, and what the limit refuses. The numbers are printed (`--nocapture`).

use std::time::Instant;
use trommi_core::crypto::SystemEntropy;
use trommi_core::device::ServedEnvelope;
use trommi_core::ids::GroupId;
use trommi_core::invite::Role;
use trommi_core::mls::profile::{Cut, MAX_COMMIT_REQUEST_LEN, MAX_HUMAN_DEVICES, MAX_NOTE_LEN};
use trommi_core::recovery::check_room;
use trommi_core::Error;
use trommi_tests::hub::Hub;
use trommi_tests::{
    enrol, fetch, fetch_group, found_helper, found_main, found_room, join_invited, join_room,
    learn, new_device, new_device_on, now, observe, post_all, post_ok, publish_some, settle,
    test_keys, try_invite, MemoryStorage, TestDevice,
};

/// A room with two human devices that follow everything, a main session and a helper session under it.
struct Scale {
    hub: Hub,
    a: TestDevice,
    a_store: MemoryStorage,
    b: TestDevice,
    room: GroupId,
    main: GroupId,
    helper: GroupId,
    /// The human devices of the room now.
    humans: usize,
}

/// The bytes a store holds.
fn stored(store: &MemoryStorage) -> usize {
    store
        .entries()
        .iter()
        .map(|entry| entry.key.len() + entry.value.len())
        .sum()
}

fn ms(since: Instant) -> u128 {
    since.elapsed().as_millis()
}

/// The parts of the newest outbox entry: a Commit with its GroupInfo, Welcome and `SealedKey`.
fn parts(device: &TestDevice) -> Vec<usize> {
    device
        .outbox()
        .last()
        .map(|entry| entry.parts.iter().map(Vec::len).collect())
        .unwrap_or_default()
}

impl Scale {
    fn new() -> Self {
        let store = MemoryStorage::new();
        let a_store = store.handle();
        let (mut a, mut b, mut agent) = (new_device_on(store), new_device(), new_device());
        let (mut hub, room) = found_room(&mut a);
        trommi_tests::add_human(&mut hub, &mut a, &mut b);
        for device in [&mut a, &mut b] {
            publish_some(&mut hub, device, 0);
        }
        enrol(&mut hub, &mut a, &mut agent);
        publish_some(&mut hub, &mut agent, 1);
        let main = found_main(&mut hub, &mut a, &agent.id());
        settle(&hub, &mut agent);
        let mut worker = new_device();
        observe(&hub, &mut worker);
        worker
            .observe_session(hub.group_info(&main).unwrap())
            .unwrap();
        let helper = found_helper(&mut hub, &mut agent, &main, &mut [&mut worker]);
        settle(&hub, &mut a);
        settle(&hub, &mut b);
        a.invite_steps().unwrap();
        Self {
            hub,
            a,
            a_store,
            b,
            room,
            main,
            helper,
            humans: 2,
        }
    }

    /// One more human device by the real path: the invite, the Add in the room group, and the Add in
    /// each of the two session groups (5.2.7). The newcomer publishes its last-resort KeyPackage and takes no
    /// Welcome; the second member follows every Commit. With `measured` the costs are printed, the newcomer
    /// joins and learns the room's past, and the key handover is sent.
    fn add(&mut self, measured: bool) -> TestDevice {
        let store = MemoryStorage::new();
        let handle = store.handle();
        let mut newcomer = new_device_on(store);
        let built = Instant::now();
        let invited = try_invite(&mut self.a, &mut newcomer, Role::Human, None).unwrap();
        let (build_ms, room_add) = (ms(built), parts(&self.a));
        post_ok(&mut self.hub, &mut self.a);
        let processed = Instant::now();
        settle(&self.hub, &mut self.b);
        let process_ms = ms(processed);
        self.humans += 1;
        let n = self.humans;
        if measured {
            eprintln!(
                "N={n} room Add: commit {} + group info {} + welcome {} bytes; \
                 invite and build {build_ms} ms, a member processes it in {process_ms} ms",
                room_add[0], room_add[1], room_add[2]
            );
            let joining = Instant::now();
            join_invited(&self.hub, &mut newcomer);
            let join_ms = ms(joining);
            settle(&self.hub, &mut newcomer);
            let state = stored(&handle);
            let past = fetch_group(&self.hub, &self.room);
            let served: usize = past.commits.iter().map(|(_, commit, _)| commit.len()).sum();
            let learning = Instant::now();
            learn(&self.hub, &mut newcomer, &self.room).unwrap();
            eprintln!(
                "N={n} the newcomer joins from the Welcome in {join_ms} ms and stores {state} bytes; \
                 it learns the room's past ({} Commits, {served} bytes) in {} ms, then stores {} bytes",
                past.commits.len(),
                ms(learning),
                stored(&handle)
            );
            // 7.1: every content key the inviter holds, for every group of the room.
            let sent = self.a.invite_handover(&invited.invite_id).unwrap();
            let outbox = self.a.outbox();
            let bytes: usize = outbox
                .iter()
                .filter(|entry| sent.contains(&entry.id))
                .flat_map(|entry| entry.parts.iter().map(Vec::len))
                .sum();
            let epochs: u64 = [self.room, self.main, self.helper]
                .iter()
                .map(|group| self.hub.epoch(group).unwrap() + 1)
                .sum();
            eprintln!(
                "N={n} key handover: {} messages, {bytes} bytes for about {epochs} epochs of three groups",
                sent.len()
            );
            post_ok(&mut self.hub, &mut self.a);
        } else {
            self.a.invite_forget(&invited.invite_id).unwrap();
        }
        publish_some(&mut self.hub, &mut newcomer, 0);
        for group in [self.main, self.helper] {
            let package = newcomer.key_package(now()).unwrap();
            let built = Instant::now();
            self.a
                .add_to_session(&group, &newcomer.id(), &package, now())
                .unwrap();
            if measured && group == self.main {
                let sizes = parts(&self.a);
                eprintln!(
                    "N={n} session Add: commit {} + group info {} + welcome {} bytes, built in {} ms",
                    sizes[0],
                    sizes[1],
                    sizes[2],
                    ms(built)
                );
            }
            post_ok(&mut self.hub, &mut self.a);
        }
        settle(&self.hub, &mut self.b);
        self.a.invite_steps().unwrap();
        newcomer
    }

    /// What does not depend on one device: an epoch of the room group in a member's store, the founding of
    /// a new session, the rows of sealed keys.
    fn measure(&mut self) {
        let n = self.humans;
        let before = stored(&self.a_store);
        self.a.update(&self.room, true, now()).unwrap().unwrap();
        post_ok(&mut self.hub, &mut self.a);
        let per_epoch = stored(&self.a_store).saturating_sub(before);
        let largest = self
            .a_store
            .entries()
            .iter()
            .map(|entry| entry.value.len())
            .max()
            .unwrap_or(0);
        eprintln!(
            "N={n} a member stores {} bytes in all (largest entry {largest}); one more epoch of the room \
             group adds {per_epoch} bytes",
            stored(&self.a_store)
        );
        settle(&self.hub, &mut self.b);

        // 5.2.5: the founding of a session is one request with a KeyPackage of every other human device.
        let mut agent = new_device();
        enrol(&mut self.hub, &mut self.a, &mut agent);
        publish_some(&mut self.hub, &mut agent, 1);
        let mut needed: Vec<_> = self
            .a
            .room_history()
            .unwrap()
            .newest()
            .humans
            .iter()
            .copied()
            .filter(|human| *human != self.a.id())
            .collect();
        needed.push(agent.id());
        let packages = self.hub.claim(&needed).unwrap();
        let building = Instant::now();
        let founded = self.a.found_session(&agent.id(), &packages, now());
        let build_ms = ms(building);
        let sizes = parts(&self.a);
        let answers = post_all(&mut self.hub, &mut self.a);
        eprintln!(
            "N={n} session founding: built {:?} in {build_ms} ms; parts {sizes:?} = {} bytes of the \
             {MAX_COMMIT_REQUEST_LEN} a request may have; the hub answers {:?}",
            founded.as_ref().map(|_| ()),
            sizes.iter().sum::<usize>(),
            answers
                .iter()
                .map(|answer| answer.as_ref().map(|_| ()))
                .collect::<Vec<_>>()
        );
        settle(&self.hub, &mut self.b);
        self.a.invite_steps().unwrap();

        let epochs: u64 = std::iter::once(self.room)
            .chain(self.hub.live_sessions())
            .map(|group| self.hub.epoch(&group).unwrap() + 1)
            .sum();
        eprintln!(
            "N={n} sealed keys: {} rows for {epochs} epochs of {} groups",
            self.hub.rows().len(),
            self.hub.live_sessions().len() + 1
        );
    }

    /// A human device is removed (5.2.8): the room Commit, then one Commit in every live session that
    /// holds it.
    fn remove(&mut self, gone: &TestDevice) {
        let n = self.humans;
        let building = Instant::now();
        self.a
            .remove_human_devices(&[Cut::none(gone.id())], now())
            .unwrap();
        let (build_ms, sizes) = (ms(building), parts(&self.a));
        post_ok(&mut self.hub, &mut self.a);
        let processing = Instant::now();
        settle(&self.hub, &mut self.b);
        let process_ms = ms(processing);
        let mut cleaned = 0;
        for group in self.a.groups().unwrap() {
            if group.disallowed.is_empty() {
                continue;
            }
            let cuts: Vec<Cut> = group.disallowed.iter().copied().map(Cut::none).collect();
            self.a
                .clean_session(&group.group, &cuts, None, now())
                .unwrap();
            post_ok(&mut self.hub, &mut self.a);
            cleaned += 1;
        }
        settle(&self.hub, &mut self.b);
        self.humans -= 1;
        eprintln!(
            "N={n} Remove in the room group: commit {} + group info {} bytes, built in {build_ms} ms, \
             processed in {process_ms} ms; then {cleaned} session Commits",
            sizes[0], sizes[1]
        );
    }

    /// The room holds its limit of human devices (section 16): one more is `too-many` before anything is
    /// built or committed, by the code and by link, every time. The same rules refuse such a Commit at the
    /// hub and for every member (`rules.rs`).
    fn is_full(&mut self) {
        assert_eq!(self.humans, MAX_HUMAN_DEVICES);
        let keys = test_keys();
        for _ in 0..2 {
            let mut over = new_device();
            assert_eq!(
                join_room(&self.hub, &mut over, &keys).err(),
                Some(Error::TooMany)
            );
            assert!(over.outbox().is_empty() && over.room().is_none());
            let mut invited = new_device();
            assert_eq!(
                try_invite(&mut self.a, &mut invited, Role::Human, None).err(),
                Some(Error::TooMany)
            );
            assert!(self.a.outbox().is_empty() && !self.a.group(&self.room).unwrap().pending);
        }
        assert_eq!(
            self.hub.history().unwrap().newest().humans.len(),
            MAX_HUMAN_DEVICES
        );
        eprintln!(
            "N={} the room is full: one more is too-many by the code and by link",
            self.humans
        );
    }

    /// Every device is lost: one new device recovers the room with the code (8.7). Its room Commit removes
    /// every other human device, each with its Cut in the note.
    fn recover(mut self) {
        let n = self.humans;
        let keys = test_keys();
        let mut device = new_device();
        self.hub.open_recovery(&device.id()).unwrap();
        let fetched = fetch(&self.hub, &keys);
        let room = fetched.room.group.room_id();
        let checking = Instant::now();
        let replacement = fetched
            .served(|served| {
                let checked = check_room(&keys, served)?;
                let history = checked.observer.history().expect("the room's roles");
                keys.replace(&mut SystemEntropy, &room, history)
            })
            .unwrap();
        let check_ms = ms(checking);
        let chains: Vec<ServedEnvelope<'_>> = Vec::new();
        let building = Instant::now();
        let built = fetched.served(|served| {
            device.recover(
                &keys,
                served,
                &replacement,
                &chains,
                b"sealed copies",
                now(),
            )
        });
        let build_ms = ms(building);
        let sizes: Vec<usize> = device
            .outbox()
            .iter()
            .map(|entry| entry.parts.iter().map(Vec::len).sum())
            .collect();
        self.hub.account.clear();
        let answers = post_all(&mut self.hub, &mut device);
        let refused: Vec<_> = answers.iter().filter_map(|a| a.as_ref().err()).collect();
        eprintln!(
            "N={n} recovery: the room is checked in {check_ms} ms, built {:?} in {build_ms} ms; {} requests, \
             the largest {} bytes (a note of {n} Cuts has about {} bytes of the {MAX_NOTE_LEN} it may have); \
             refused by the hub: {refused:?}; the room then holds {} human device(s)",
            built.as_ref().map(|_| ()),
            sizes.len(),
            sizes.iter().max().copied().unwrap_or(0),
            64 + 72 * n,
            self.hub.history().unwrap().newest().humans.len()
        );
        assert!(built.is_ok() && refused.is_empty());
    }
}

/// Grows a room to each of `sizes` in turn, measures there, and at the last one recovers it.
fn grow_and_measure(sizes: &[usize]) {
    let started = Instant::now();
    let mut room = Scale::new();
    for size in sizes {
        while room.humans + 1 < *size {
            room.add(false);
        }
        let last = room.add(true);
        assert_eq!(room.humans, *size);
        room.measure();
        room.remove(&last);
        eprintln!("N={size} reached after {} s", started.elapsed().as_secs());
    }
    if sizes.last() == Some(&MAX_HUMAN_DEVICES) {
        room.add(false);
        room.is_full();
    }
    room.recover();
    eprintln!("done after {} s", started.elapsed().as_secs());
}

#[test]
fn a_room_grows_to_a_hundred_human_devices() {
    grow_and_measure(&[32, 100]);
}

/// The full run, to the limit of section 16. It takes long; run it alone and in release mode:
/// `cargo test --release -p trommi-tests --locked --test core_groups_scale -- --ignored --nocapture`.
#[test]
#[ignore = "the full run to the limit of human devices"]
fn a_room_grows_to_its_limit_of_human_devices() {
    grow_and_measure(&[32, 100, 250, 500, MAX_HUMAN_DEVICES]);
}
