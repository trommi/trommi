//! Lifetimes and single-use KeyPackages (section 3, 3.6, 3.7, 4.5): OpenMLS checks a lifetime against the
//! system's clock wherever the profile does not skip it, so a time far in the past makes an expired leaf or
//! KeyPackage here.

use std::collections::BTreeMap;
use trommi_core::device::{key_package_info, Processed, WelcomeExpectation};
use trommi_core::ids::GroupId;
use trommi_core::invite::Role;
use trommi_core::mls::key_package::verify_key_package_of;
use trommi_core::mls::observer::Observer;
use trommi_core::mls::profile::Cut;
use trommi_core::store::{table, Batch, Storage};
use trommi_core::Error;
use trommi_tests::hub::Hub;
use trommi_tests::{
    add_human, enrol, found_main, found_room, found_room_on, hub_address, join_invited, new_device,
    new_device_on, now, post_ok, post_refused, publish_some, reopen, settle, stranger, sync_ok,
    try_invite, MemoryStorage, TestDevice, APP,
};

const HOUR_MS: u64 = 60 * 60 * 1000;
const ELEVEN_YEARS_MS: u64 = 11 * 365 * 24 * HOUR_MS;

#[test]
fn a_founders_expired_leaf_stops_observers_and_no_join_by_welcome() {
    // A room founded eleven years ago: the founder's leaf ran out a year ago.
    let long_ago = now() - ELEVEN_YEARS_MS;
    let mut a = new_device();
    let room = a.found_room(&trommi_tests::test_keys(), long_ago).unwrap();
    let room_group = GroupId::room(room);
    let founding = a.outbox().remove(0);
    // A hub that follows the group verifies the tree and refuses the founding; so does any observer.
    let mut checking = Hub::new(true);
    assert_eq!(checking.post(&a.id(), &founding), Err(Error::BadSignature));
    assert_eq!(
        Observer::follow_room(&founding.parts[0], None).err(),
        Some(Error::BadSignature)
    );
    let mut hub = Hub::new(false);
    post_ok(&mut hub, &mut a);

    // A device still joins by Welcome: joins skip the lifetime check.
    let mut b = new_device();
    add_human(&mut hub, &mut a, &mut b);
    assert_eq!(
        b.content_key(&room_group, 1).unwrap(),
        a.content_key(&room_group, 1).unwrap()
    );
    assert_eq!(b.group(&room_group).unwrap().leaves.len(), 2);
    // And follows the founder's Commits. An observer still cannot start: the tree holds the expired leaf
    // until its owner's next Commit replaces it by one from an update path, which has no lifetime.
    assert_eq!(
        Observer::follow_room(hub.group_info(&room_group).unwrap(), None).err(),
        Some(Error::BadSignature)
    );
    a.update(&room_group, true, now()).unwrap().unwrap();
    post_ok(&mut hub, &mut a);
    settle(&hub, &mut b);
    assert_eq!(
        b.content_key(&room_group, 2).unwrap(),
        a.content_key(&room_group, 2).unwrap()
    );
    let observer = Observer::follow_room(hub.group_info(&room_group).unwrap(), None).unwrap();
    assert_eq!(observer.epoch().unwrap(), 2);
    assert_eq!(observer.leaves().unwrap().len(), 2);
}

#[test]
fn a_device_removed_while_the_tree_holds_an_expired_leaf_knows_it_is_out() {
    // A room whose founder's leaf ran out, on a hub that checks nothing, with a second human device.
    let mut a = new_device();
    let room = a
        .found_room(&trommi_tests::test_keys(), now() - ELEVEN_YEARS_MS)
        .unwrap();
    let room_group = GroupId::room(room);
    let mut hub = Hub::new(false);
    post_ok(&mut hub, &mut a);
    let mut b = new_device();
    add_human(&mut hub, &mut a, &mut b);
    settle(&hub, &mut b);
    assert!(b.is_human());

    // The founder removes it. The removed device goes on as an observer of the room group from the public
    // state it held as a leaf, which it verified when it joined: no lifetime is checked again, so the
    // expired leaf does not stop it. It knows the state that removed it.
    a.remove_human_devices(&[Cut::none(b.id())], now()).unwrap();
    post_ok(&mut hub, &mut a);
    let processed = sync_ok(&hub, &mut b);
    assert!(matches!(
        processed[..],
        [Processed::Commit { removed: true, .. }]
    ));
    assert!(!b.is_human());
    let roles = b.room_history().unwrap();
    assert_eq!(roles.newest().epoch, 2);
    assert!(roles.newest().is_human(&a.id()) && roles.is_revoked(&b.id(), 2));
    assert_eq!(b.group(&room_group).err(), Some(Error::NotFound));
    assert_eq!(b.update(&room_group, true, now()), Err(Error::Forbidden));
    assert!(b.content_key(&room_group, 1).is_ok());
    // And follows the room group on.
    a.update(&room_group, true, now()).unwrap().unwrap();
    post_ok(&mut hub, &mut a);
    assert!(matches!(
        sync_ok(&hub, &mut b)[..],
        [Processed::Observed(_)]
    ));
    assert_eq!(b.room_history().unwrap().newest().epoch, 3);
}

#[test]
fn a_key_package_outside_its_lifetime_is_refused() {
    let (mut a, mut agent) = (new_device(), new_device());
    let (mut hub, room_group) = found_room(&mut a);
    enrol(&mut hub, &mut a, &mut agent);
    publish_some(&mut hub, &mut agent, 1);
    let main = found_main(&mut hub, &mut a, &agent.id());
    let store = MemoryStorage::new();
    let handle = store.handle();
    let mut c = new_device_on(store);
    let fresh = c.key_package(now()).unwrap();
    let info = key_package_info(&fresh).unwrap();
    assert_eq!((info.device, info.last_resort), (c.id(), false));
    // From an hour ago to ten years ahead.
    let ten_years = 10 * 365 * 24 * HOUR_MS;
    assert!(info.not_after_ms > now() + ten_years - HOUR_MS);
    assert!(info.not_after_ms <= now() + ten_years);

    // One that ran out, and one that is not valid yet. No device answers an invite with such a one, and
    // none is taken where a KeyPackage is handed over.
    let open = |a: &mut TestDevice, at: u64| {
        let opened = a
            .invite_open(Role::Human, None, APP, &hub_address(), at)
            .unwrap();
        let link = String::from_utf8(opened.link.expose().to_vec()).unwrap();
        (opened, link)
    };
    for made in [now() - ELEVEN_YEARS_MS, now() + 3 * HOUR_MS] {
        let package = c.key_package(made).unwrap();
        // The invite is opened by a clock that agrees with the device's (12.1.2): it is open at the moment the
        // device answers it.
        let (opened, link) = open(&mut a, made);
        assert_eq!(key_package_info(&package), Err(Error::BadKeyPackage));
        assert_eq!(
            verify_key_package_of(&package, &c.id()),
            Err(Error::BadKeyPackage)
        );
        assert_eq!(
            c.join_request(&link, &opened.signed_offer, made),
            Err(Error::BadKeyPackage)
        );
        assert_eq!(
            a.add_to_session(&main, &c.id(), &package, now()),
            Err(Error::BadKeyPackage)
        );
        assert_eq!(
            a.clean_session(&main, &[], Some((&c.id(), &package)), now()),
            Err(Error::BadKeyPackage)
        );
        assert_eq!(
            a.found_session(&c.id(), std::slice::from_ref(&package), now()),
            Err(Error::BadKeyPackage)
        );
    }
    assert!(a.outbox().is_empty());
    assert!(!a.group(&room_group).unwrap().pending);
    // The hub stores none of them: the upload is refused, and the device drops their private parts.
    let stored = handle.entries().len();
    c.key_packages_to_upload(98, now() - ELEVEN_YEARS_MS)
        .unwrap()
        .unwrap();
    // A last-resort and two single-use ones, each with its record and its private part, and the upload.
    assert_eq!(handle.entries().len(), stored + 7);
    assert_eq!(post_refused(&mut hub, &mut c), [Error::BadKeyPackage]);
    assert!(c.outbox().is_empty());
    assert_eq!(handle.entries().len(), stored);
    assert_eq!(hub.unused(&c.id()), 0);
    assert_eq!(hub.claim(&[c.id()]), Err(Error::NotFound));
    // A KeyPackage of another device than the one named, and bytes that are none.
    assert_eq!(
        verify_key_package_of(&fresh, &a.id()),
        Err(Error::BadKeyPackage)
    );
    assert_eq!(key_package_info(b"key package"), Err(Error::BadKeyPackage));
    let mut flipped = fresh.clone();
    let last = flipped.len() - 1;
    flipped[last] ^= 1;
    assert_eq!(key_package_info(&flipped), Err(Error::BadKeyPackage));
    // A fresh one is taken: the one of the Request the device answers the invite with.
    let (opened, link) = open(&mut a, now());
    let request = c
        .join_request(&link, &opened.signed_offer, now())
        .unwrap()
        .signed_request;
    let accepted = a.invite_accept(&opened.invite_id, &request, now()).unwrap();
    let code = c.join_reveal(&accepted.signed_reveal).unwrap();
    a.invite_confirm(
        &opened.invite_id,
        &code,
        &accepted.request_hash,
        true,
        now(),
    )
    .unwrap()
    .unwrap();
    post_ok(&mut hub, &mut a);
    assert_eq!(join_invited(&hub, &mut c).group, room_group);
}

#[test]
fn a_refused_welcome_uses_up_its_single_use_key_package() {
    let (mut a, mut agent) = (new_device(), new_device());
    let (mut hub, room_group) = found_room(&mut a);
    let room = room_group.room_id();
    enrol(&mut hub, &mut a, &mut agent);
    publish_some(&mut hub, &mut agent, 1);
    let main = found_main(&mut hub, &mut a, &agent.id());

    // The newcomer was told who would add it; the Welcome is committed by another device.
    let mut c = new_device();
    let package = try_invite(&mut a, &mut c, Role::Human, None)
        .unwrap()
        .key_package;
    post_ok(&mut hub, &mut a);
    let welcome = hub.welcomes.last().unwrap().bytes.clone();
    let told = WelcomeExpectation {
        room,
        committer: Some(stranger(9)),
    };
    assert_eq!(
        c.join_welcome(&welcome, &told, now()),
        Err(Error::BadInvite)
    );
    assert!(c.groups().unwrap().is_empty());
    assert_eq!(c.room(), None);
    assert_eq!(c.content_key(&room_group, 2), Err(Error::NoKey));
    // The refusal used the KeyPackage up: the same Welcome, now expected rightly, is for no KeyPackage this
    // device holds.
    let right = WelcomeExpectation {
        room,
        committer: Some(a.id()),
    };
    assert_eq!(
        c.join_welcome(&welcome, &right, now()),
        Err(Error::NotMember)
    );
    assert_eq!(c.join_invited(&welcome, now()), Err(Error::NotMember));
    // Nor does a second Welcome made with that KeyPackage open: the one of a session group.
    a.add_to_session(&main, &c.id(), &package, now()).unwrap();
    post_ok(&mut hub, &mut a);
    let second = hub.welcomes.last().unwrap().bytes.clone();
    assert_ne!(second, welcome);
    assert_eq!(
        c.join_welcome(&second, &right, now()),
        Err(Error::NotMember)
    );
    assert!(c.groups().unwrap().is_empty());

    // A Welcome for another room than the expected one is refused and uses its KeyPackage up too.
    let mut d = new_device();
    let package = try_invite(&mut a, &mut d, Role::Human, None)
        .unwrap()
        .key_package;
    post_ok(&mut hub, &mut a);
    let welcome = hub.welcomes.last().unwrap().bytes.clone();
    let elsewhere = WelcomeExpectation {
        room: trommi_core::ids::RoomId::new([7; 32]),
        committer: None,
    };
    assert_eq!(
        d.join_welcome(&welcome, &elsewhere, now()),
        Err(Error::WrongRoom)
    );
    let anyone = WelcomeExpectation {
        room,
        committer: None,
    };
    assert_eq!(
        d.join_welcome(&welcome, &anyone, now()),
        Err(Error::NotMember)
    );
    // Bytes that are no Welcome.
    assert_eq!(
        d.join_welcome(b"welcome", &anyone, now()),
        Err(Error::BadFormat)
    );
    assert_eq!(
        d.join_welcome(&package, &anyone, now()),
        Err(Error::BadFormat)
    );
    // Bytes above the limit of a Commit's request are refused for their size, before they are parsed: also
    // a Welcome with bytes behind it.
    let limit = trommi_core::mls::profile::MAX_COMMIT_REQUEST_LEN;
    let mut long = welcome.clone();
    long.resize(limit, 0);
    assert_eq!(d.join_welcome(&long, &anyone, now()), Err(Error::BadFormat));
    long.push(0);
    assert_eq!(d.join_welcome(&long, &anyone, now()), Err(Error::TooLarge));

    // The last-resort KeyPackage is not used up by a refusal, and a Welcome never replaces a held group. A
    // room group's Welcome answers a Request, whose KeyPackage is a single-use one: the last-resort one opens
    // the Welcome of a session group.
    let mut e = new_device();
    publish_some(&mut hub, &mut e, 0);
    add_human(&mut hub, &mut a, &mut e);
    let last_resort = hub.claim(&[e.id()]).unwrap().remove(0);
    assert!(key_package_info(&last_resort).unwrap().last_resort);
    a.add_to_session(&main, &e.id(), &last_resort, now())
        .unwrap();
    post_ok(&mut hub, &mut a);
    let welcome = hub.welcomes.last().unwrap().bytes.clone();
    assert_eq!(
        e.join_welcome(&welcome, &told, now()),
        Err(Error::BadInvite)
    );
    let joined = e.join_welcome(&welcome, &right, now()).unwrap();
    assert_eq!((joined.group, joined.added_by), (main, a.id()));
    assert_eq!(joined.epoch, hub.epoch(&main).unwrap());
    assert_eq!(e.join_welcome(&welcome, &right, now()), Err(Error::Replay));
    sync_ok(&hub, &mut a);
    assert_eq!(
        e.content_key(&main, joined.epoch).unwrap(),
        a.content_key(&main, joined.epoch).unwrap()
    );
}

#[test]
fn the_last_resort_key_package_is_retired_when_its_replacement_was_accepted() {
    const DAY_MS: u64 = 24 * HOUR_MS;
    let (mut a, mut agent) = (new_device(), new_device());
    let (mut hub, room_group) = found_room(&mut a);
    // A session group to be added to: there a KeyPackage is claimed at the hub, and a last-resort one is
    // what the hub hands out last.
    enrol(&mut hub, &mut a, &mut agent);
    publish_some(&mut hub, &mut agent, 1);
    let main = found_main(&mut hub, &mut a, &agent.id());
    let anyone = WelcomeExpectation {
        room: room_group.room_id(),
        committer: None,
    };
    let start = now();

    // A device with a last-resort KeyPackage at the hub. After 30 days it makes the next one; its clock is
    // ahead, the hub refuses a KeyPackage whose lifetime has not begun, and the refused one's private part
    // goes. That happens twice, 31 days apart.
    let mut b = new_device();
    add_human(&mut hub, &mut a, &mut b);
    publish_some(&mut hub, &mut b, 0);
    let current = hub.claim(&[b.id()]).unwrap().remove(0);
    for days in [31, 62] {
        b.key_packages_to_upload(100, start + days * DAY_MS)
            .unwrap()
            .unwrap();
        assert_eq!(post_refused(&mut hub, &mut b), [Error::BadKeyPackage]);
    }
    // The one the hub still hands out was never replaced: it is the current one and opens a Welcome.
    assert_eq!(
        hub.claim(&[b.id()]).unwrap(),
        std::slice::from_ref(&current)
    );
    a.add_to_session(&main, &b.id(), &current, now()).unwrap();
    post_ok(&mut hub, &mut a);
    let welcome = hub.welcomes.last().unwrap().bytes.clone();
    let joined = b.join_welcome(&welcome, &anyone, now()).unwrap();
    assert_eq!(joined.group, main);

    // A device whose uploads waited: its first last-resort KeyPackage is at the hub, the second was made 31
    // days later and the third 31 days after that, and the hub takes both only now. Each replaces what was
    // made before it and nothing made after it; the period a replaced one is kept for begins when the device
    // is next told the time, not when its replacement was made.
    #[derive(Clone, Copy, Debug)]
    enum Then {
        FirstStillOpens,
        NewestIsCurrent,
        FirstIsGone,
    }
    for then in [
        Then::FirstStillOpens,
        Then::NewestIsCurrent,
        Then::FirstIsGone,
    ] {
        let mut c = new_device();
        add_human(&mut hub, &mut a, &mut c);
        c.key_packages_to_upload(100, start - 62 * DAY_MS)
            .unwrap()
            .unwrap();
        post_ok(&mut hub, &mut c);
        let first = hub.claim(&[c.id()]).unwrap().remove(0);
        c.key_packages_to_upload(100, start - 31 * DAY_MS)
            .unwrap()
            .unwrap();
        c.key_packages_to_upload(100, start).unwrap().unwrap();
        assert_eq!(c.outbox().len(), 2);
        post_ok(&mut hub, &mut c);
        let newest = hub.claim(&[c.id()]).unwrap().remove(0);
        assert_ne!(newest, first);
        // The next day the device is told the time: nothing is due, and the periods begin.
        assert_eq!(c.key_packages_to_upload(100, start + DAY_MS), Ok(None));
        let (with, opens) = match then {
            Then::FirstStillOpens => (&first, true),
            Then::NewestIsCurrent => {
                // A month on the next one is due; the one the hub holds is still the current one.
                let due = c.key_packages_to_upload(100, start + 31 * DAY_MS).unwrap();
                assert!(due.is_some());
                (&newest, true)
            }
            Then::FirstIsGone => {
                let due = c.key_packages_to_upload(100, start + 32 * DAY_MS).unwrap();
                assert!(due.is_some());
                (&first, false)
            }
        };
        a.add_to_session(&main, &c.id(), with, now()).unwrap();
        post_ok(&mut hub, &mut a);
        let welcome = hub.welcomes.last().unwrap().bytes.clone();
        let joined = c.join_welcome(&welcome, &anyone, now());
        if opens {
            assert_eq!(joined.unwrap().group, main, "{then:?}");
        } else {
            assert_eq!(joined, Err(Error::NotMember), "{then:?}");
        }
    }
}

#[test]
fn no_pre_shared_key_is_used_or_stored() {
    // No operation of a device proposes a PreSharedKey (3.6): a Commit holds Adds, Removes, a change of the
    // room's extension, or nothing, and a Commit with any other proposal is `bad-commit`
    // (`rules.rs`, room_commits_follow_5_1: a forbidden proposal).
    // What a store returns is checked before OpenMLS reads it: an entry of a kind the profile never writes
    // (a PSK, a stored signature key pair, a queued proposal) is damaged state.
    let store = MemoryStorage::new();
    let handle = store.handle();
    let mut a = new_device_on(store);
    let mut hub = Hub::new(true);
    let room_group = found_room_on(&mut hub, &mut a);
    a.update(&room_group, true, now()).unwrap().unwrap();
    post_ok(&mut hub, &mut a);
    drop(a);
    let stored: BTreeMap<Vec<u8>, Vec<u8>> = handle
        .entries()
        .iter()
        .map(|entry| (entry.key.clone(), entry.value.clone()))
        .collect();
    // What the device wrote holds none of them, and opens.
    for label in [&b"Psk"[..], b"SignatureKeyPair", b"QueuedProposal"] {
        assert!(stored
            .keys()
            .all(|key| key[0] != table::MLS || !key[1..].starts_with(label)));
    }
    assert!(reopen(handle.reopened()).is_ok());
    for label in [
        &b"Psk"[..],
        b"SignatureKeyPair",
        b"QueuedProposal",
        b"Unknown",
    ] {
        let mut store = handle.reopened();
        let revision = store.load().unwrap().revision;
        let mut batch = Batch::new();
        let key = [&[table::MLS][..], label, b"\"id\"", &[0, 1]].concat();
        batch.put(key, b"{}".to_vec());
        store.apply(revision, batch).unwrap();
        let error = reopen(store).expect_err("the store is refused");
        assert_eq!(
            error,
            Error::Storage("an MLS entry does not decode".into()),
            "{}",
            String::from_utf8_lossy(label)
        );
    }
}
