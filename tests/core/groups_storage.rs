//! Damaged stored state (13.2, 13.4): a store's entries are input like any other. Whatever a damaged entry
//! does, opening the device returns a storage error or a device whose operations return results; nothing
//! panics. Nothing here catches a panic: one fails the test.

use std::collections::BTreeMap;
use trommi_core::ids::GroupId;
use trommi_core::store::{table, Entry};
use trommi_core::Error;
use trommi_tests::hub::{Hub, LogItem};
use trommi_tests::{
    add_human, enrol, found_helper, found_main, found_room, new_device, new_device_on, now,
    observe, post_ok, process, publish_some, reopen, settle, MemoryStorage, TestDevice,
    TEST_RECOVERY_AUTH,
};

/// The labels OpenMLS's storage puts in front of its keys.
const MLS_LABELS: [&str; 22] = [
    "KeyPackage",
    "Psk",
    "EncryptionKeyPair",
    "SignatureKeyPair",
    "EpochKeyPairs",
    "Tree",
    "GroupContext",
    "ApplicationExportTree",
    "InterimTranscriptHash",
    "ConfirmationTag",
    "MlsGroupJoinConfig",
    "OwnLeafNodes",
    "GroupState",
    "QueuedProposal",
    "ProposalQueueRefs",
    "OwnLeafNodeIndex",
    "EpochSecrets",
    "ResumptionPsk",
    "MessageSecrets",
    "RetainedKeyPackageMaterial",
    "RetainedKeyPackageEpoch",
    "VcOperationTree",
];

fn mls_label(key: &[u8]) -> String {
    MLS_LABELS
        .iter()
        .filter(|label| key.starts_with(label.as_bytes()))
        .max_by_key(|label| label.len())
        .map_or_else(|| "an unknown label".to_string(), |label| label.to_string())
}

/// What kind of entry a key names: its table, the kind within the table, and for OpenMLS's entries the label.
fn class(key: &[u8]) -> String {
    let (first, rest) = key.split_first().expect("a key");
    let sub = rest.first().copied().unwrap_or(0);
    match *first {
        table::DEVICE => format!(
            "device/{}",
            [
                "key",
                "record",
                "group",
                "key package",
                "staged join",
                "handover sent",
                "handed key"
            ]
            .get(usize::from(sub))
            .unwrap_or(&"?")
        ),
        table::MLS => format!("mls/{}", mls_label(rest)),
        table::CONTENT_KEY => "content key".to_string(),
        table::ROOM_STATE if sub == 0 => "room state/own history".to_string(),
        table::ROOM_STATE => {
            // An observer's entry: the group, then the observer's own key.
            let group_len = usize::from(rest[1]);
            let own = &rest[2 + group_len..];
            let kind = if group_len == 32 { "room" } else { "session" };
            match own.split_first() {
                Some((0, key)) => format!("observer of a {kind} group/mls/{}", mls_label(key)),
                Some((1, _)) => format!("observer of a {kind} group/record"),
                Some((2, _)) => format!("observer of a {kind} group/room state"),
                _ => format!("observer of a {kind} group/?"),
            }
        }
        table::OUTBOX => "outbox".to_string(),
        other => format!("table {other:#04x}"),
    }
}

/// The ways an entry is damaged.
fn damages(value: &[u8]) -> Vec<(&'static str, Option<Vec<u8>>)> {
    let mut all: Vec<(&'static str, Option<Vec<u8>>)> =
        vec![("deleted", None), ("emptied", Some(Vec::new()))];
    if value.is_empty() {
        all.push(("one byte put in", Some(vec![0])));
        return all;
    }
    all.push(("cut in half", Some(value[..value.len() / 2].to_vec())));
    all.push(("cut by a byte", Some(value[..value.len() - 1].to_vec())));
    let mut longer = value.to_vec();
    longer.push(0);
    all.push(("a byte longer", Some(longer)));
    for (name, at) in [
        ("first byte flipped", 0),
        ("middle byte flipped", value.len() / 2),
        ("last byte flipped", value.len() - 1),
    ] {
        let mut flipped = value.to_vec();
        flipped[at] ^= 0x01;
        all.push((name, Some(flipped.clone())));
        flipped[at] ^= 0xFE;
        all.push((name, Some(flipped)));
    }
    all
}

/// A store with `entries`, at the revision of `like`.
fn store_with(like: &MemoryStorage, entries: &BTreeMap<Vec<u8>, Vec<u8>>) -> MemoryStorage {
    use trommi_core::store::{Batch, Storage};
    let mut store = MemoryStorage::new();
    let mut revision = 0;
    // The revision is counted up by empty writes, then everything is put in one batch.
    while revision + 1 < like.revision() {
        store
            .apply(revision, {
                let mut batch = Batch::new();
                batch.put(vec![0xFF], Vec::new());
                batch
            })
            .unwrap();
        revision += 1;
    }
    let mut batch = Batch::new();
    batch.delete(vec![0xFF]);
    for (key, value) in entries {
        batch.put(key.clone(), value.clone());
    }
    store.apply(revision, batch).unwrap();
    store
}

/// Uses a device that opened on a damaged store: every operation returns, with a result or an error.
fn exercise(mut device: TestDevice, log: &[LogItem], groups: &[GroupId]) -> usize {
    let mut errors = 0;
    let mut count = |failed: bool| errors += usize::from(failed);
    count(device.groups().is_err());
    let _ = (
        device.outbox(),
        device.cursor(),
        device.is_human(),
        device.handovers_sent(),
    );
    for group in groups {
        count(device.group(group).is_err());
        for epoch in 0..4 {
            count(device.content_key(group, epoch).is_err());
        }
    }
    // The log goes on: Commits and messages of the other devices.
    let cursor = device.cursor();
    for item in log.iter().filter(|item| item.change > cursor) {
        count(process(&mut device, item).is_err());
    }
    // The device's own operations, and the answers to what waits in its outbox.
    for group in groups {
        count(device.update(group, true, now()).is_err());
        count(device.send_handover(group, &device.id()).is_err());
        count(
            device
                .send_work_trail(
                    group,
                    &trommi_core::ids::TurnId::new([1; 16]),
                    1,
                    b"{}",
                    now(),
                )
                .is_err(),
        );
    }
    count(device.key_package(now()).is_err());
    count(device.key_packages_to_upload(99, now()).is_err());
    for (at, entry) in device.outbox().into_iter().enumerate() {
        let answer = if at % 2 == 0 {
            device.outbox_accepted(entry.id, Default::default())
        } else {
            device.outbox_refused(entry.id, &Error::Overloaded)
        };
        count(answer.is_err());
    }
    count(device.groups().is_err());
    errors
}

/// Damages entries of `store` one at a time, a sample of every class, and opens a device on each.
fn damage_everything(name: &str, store: &MemoryStorage, hub: &Hub, groups: &[GroupId]) {
    let stored: BTreeMap<Vec<u8>, Vec<u8>> = store
        .entries()
        .iter()
        .map(|entry: &Entry| (entry.key.clone(), entry.value.clone()))
        .collect();
    // The undamaged state opens and works.
    let whole = reopen(store_with(store, &stored)).unwrap();
    let healthy = exercise(whole, &hub.log, groups);

    let mut classes: BTreeMap<String, Vec<&Vec<u8>>> = BTreeMap::new();
    for key in stored.keys() {
        classes.entry(class(key)).or_default().push(key);
    }
    let (mut refused, mut opened, mut tried) = (0usize, 0usize, 0usize);
    for (class, keys) in &classes {
        // Of a class with many entries: the first two and the last.
        let mut sample: Vec<&Vec<u8>> = keys.iter().take(2).copied().collect();
        if keys.len() > 2 {
            sample.extend(keys.last());
        }
        for key in sample {
            for (damage, value) in damages(&stored[key]) {
                let mut entries = stored.clone();
                match value {
                    Some(value) => entries.insert(key.clone(), value),
                    None => entries.remove(key),
                };
                tried += 1;
                match reopen(store_with(store, &entries)) {
                    Err(Error::Storage(_)) => refused += 1,
                    Err(other) => panic!("{name}, {class} {damage}: opening failed with {other:?}"),
                    Ok(device) => {
                        opened += 1;
                        exercise(device, &hub.log, groups);
                    }
                }
            }
        }
    }
    println!(
        "{name}: {} entries in {} classes, {tried} damaged states: {refused} refused at opening, {opened} opened; \
         the undamaged device met {healthy} errors in its exercise",
        stored.len(),
        classes.len()
    );
    let listed: Vec<String> = classes
        .iter()
        .map(|(class, keys)| format!("{class} ({})", keys.len()))
        .collect();
    println!("  {}", listed.join(", "));
    assert!(refused > tried / 3, "{name}: {refused} of {tried}");
}

#[test]
fn a_damaged_entry_is_a_storage_error_or_a_device_that_still_answers() {
    // A human device, an agent device and a helper device, each on its own store, in a room with a main
    // session and a helper session; each holds a pending Commit or founding, messages and KeyPackages in its
    // outbox, and there are entries in the log none of them has processed.
    let stores: Vec<MemoryStorage> = (0..3).map(|_| MemoryStorage::new()).collect();
    let (human_store, agent_store, helper_store) =
        (stores[0].handle(), stores[1].handle(), stores[2].handle());
    let mut stores = stores.into_iter();
    let mut a = new_device();
    let mut human = new_device_on(stores.next().unwrap());
    let mut agent = new_device_on(stores.next().unwrap());
    let mut helper = new_device_on(stores.next().unwrap());
    let (mut hub, room_group) = found_room(&mut a);
    add_human(&mut hub, &mut a, &mut human);
    a.send_handover(&room_group, &human.id()).unwrap();
    post_ok(&mut hub, &mut a);
    enrol(&mut hub, &mut a, &mut agent);
    for device in [&mut a, &mut human] {
        publish_some(&mut hub, device, 2);
    }
    publish_some(&mut hub, &mut agent, 1);
    let main = found_main(&mut hub, &mut a, &agent.id());
    settle(&hub, &mut agent);
    observe(&hub, &mut helper);
    helper
        .observe_session(hub.group_info(&main).unwrap())
        .unwrap();
    let group = found_helper(&mut hub, &mut agent, &main, &mut [&mut helper]);
    for device in [&mut a, &mut human, &mut helper] {
        settle(&hub, device);
    }
    a.update(&main, true, now()).unwrap().unwrap();
    post_ok(&mut hub, &mut a);
    for device in [&mut human, &mut agent, &mut helper] {
        settle(&hub, device);
    }
    let groups = [room_group, main, group];

    // What each leaves unsent: Commits pending, a founding, messages, KeyPackages.
    human.update(&room_group, true, now()).unwrap().unwrap();
    human.update(&main, true, now()).unwrap().unwrap();
    human.send_handover(&group, &helper.id()).unwrap();
    human.key_packages_to_upload(98, now()).unwrap().unwrap();
    human.key_package(now()).unwrap();
    let packages = hub.claim(&[a.id(), human.id()]).unwrap();
    agent
        .found_helper(&main.session_id().unwrap(), &packages, now())
        .unwrap();
    let extra = new_device().key_package(now()).unwrap();
    let extra_device = trommi_core::device::key_package_info(&extra)
        .unwrap()
        .device;
    agent
        .add_to_session(&group, &extra_device, &extra, now())
        .unwrap();
    agent
        .send_work_trail(
            &main,
            &trommi_core::ids::TurnId::new([2; 16]),
            1,
            b"{}",
            now(),
        )
        .unwrap();
    helper
        .send_work_trail(
            &group,
            &trommi_core::ids::TurnId::new([3; 16]),
            1,
            b"{}",
            now(),
        )
        .unwrap();
    helper.key_package(now()).unwrap();
    drop((human, agent, helper));

    // What the log holds beyond their cursors: Commits in the room group and the main session, a message.
    a.update(&room_group, true, now()).unwrap().unwrap();
    post_ok(&mut hub, &mut a);
    a.update(&main, true, now()).unwrap().unwrap();
    post_ok(&mut hub, &mut a);
    a.send_handover(&room_group, &a.id()).unwrap();
    post_ok(&mut hub, &mut a);

    // A device that follows the room group and holds a join from outside as a copy beside its state.
    let store = MemoryStorage::new();
    let joiner_store = store.handle();
    let mut joiner = new_device_on(store);
    observe(&hub, &mut joiner);
    let info = hub.group_info(&room_group).unwrap().clone();
    joiner
        .join_from_outside(&info, now(), &mut |_, _| Ok(TEST_RECOVERY_AUTH.to_vec()))
        .unwrap();
    drop(joiner);

    damage_everything("a human device", &human_store, &hub, &groups);
    damage_everything("an agent device", &agent_store, &hub, &groups);
    damage_everything("a helper device", &helper_store, &hub, &groups);
    damage_everything(
        "a device joining from outside",
        &joiner_store,
        &hub,
        &groups,
    );
}

#[test]
fn a_stored_group_in_an_epoch_no_group_reaches_is_damaged() {
    // A human device, and a device that follows the room group and a main session's group as an observer.
    let stores: Vec<MemoryStorage> = (0..2).map(|_| MemoryStorage::new()).collect();
    let handles = [stores[0].handle(), stores[1].handle()];
    let mut stores = stores.into_iter();
    let mut human = new_device_on(stores.next().unwrap());
    let mut follower = new_device_on(stores.next().unwrap());
    let mut agent = new_device();
    let (mut hub, _) = found_room(&mut human);
    enrol(&mut hub, &mut human, &mut agent);
    publish_some(&mut hub, &mut agent, 1);
    let main = found_main(&mut hub, &mut human, &agent.id());
    observe(&hub, &mut follower);
    follower
        .observe_session(hub.group_info(&main).unwrap())
        .unwrap();
    drop((human, follower));

    // The stored group context of a group the device is a leaf of, and of one it follows, with the epoch put
    // far up: where OpenMLS's count would run over on the next Commit, or halfway there.
    let cases = [
        ("a member", &handles[0], "mls/GroupContext"),
        (
            "an observer",
            &handles[1],
            "observer of a session group/mls/GroupContext",
        ),
    ];
    for (name, handle, wanted) in cases {
        let stored: BTreeMap<Vec<u8>, Vec<u8>> = handle
            .entries()
            .iter()
            .map(|entry| (entry.key.clone(), entry.value.clone()))
            .collect();
        assert!(reopen(store_with(handle, &stored)).is_ok(), "{name}");
        let key = stored
            .keys()
            .find(|key| class(key) == wanted)
            .unwrap_or_else(|| panic!("{name}: a stored group context"))
            .clone();
        for (epoch, damaged) in [
            (u64::MAX, true),
            (u64::MAX / 2 + 1, true),
            (u64::MAX / 2, false),
        ] {
            let mut context: serde_json::Value = serde_json::from_slice(&stored[&key]).unwrap();
            assert!(context["epoch"].is_u64(), "{name}");
            context["epoch"] = epoch.into();
            let mut entries = stored.clone();
            entries.insert(key.clone(), serde_json::to_vec(&context).unwrap());
            match reopen(store_with(handle, &entries)) {
                Err(Error::Storage(_)) => assert!(damaged, "{name}, epoch {epoch}"),
                Err(other) => panic!("{name}, epoch {epoch}: {other:?}"),
                // Below that the device opens, and its operations return.
                Ok(device) => {
                    assert!(!damaged, "{name}, epoch {epoch}");
                    let _ = device.groups();
                }
            }
        }
    }
}
