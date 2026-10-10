//! A Commit is judged at its place in the hub's order (5.2.1, 5.4.1): a session Commit names the room epoch
//! that was current there, neither an older nor a newer one, for a member, for an observer and for a device
//! that signs in with the code. A verifier that does not know a helper session's main session judges nothing
//! of it (5.2.3). A device that joined by Welcome knows the place of its join.

use trommi_core::codec;
use trommi_core::device::{log_finding, LogFinding, Processed, WelcomeExpectation};
use trommi_core::ids::GroupId;
use trommi_core::invite::Role;
use trommi_core::mls::profile::{CommitNote, Cut};
use trommi_core::mls::rules::RoomState;
use trommi_core::Error;
use trommi_tests::forge::Forger;
use trommi_tests::hub::Hub;
use trommi_tests::{
    add_forger, add_human, cuts_for, enrol, found_helper, found_main, found_room_on, join_room,
    join_session, new_device, now, observe, post_ok, post_refused, process, publish_some, settle,
    sync, sync_ok, test_keys, try_invite, TestDevice,
};

/// Two human devices and a main session with its agent device, on a hub that checks or does not.
fn room(checks: bool) -> (Hub, TestDevice, TestDevice, TestDevice, GroupId, GroupId) {
    let (mut a, mut b, mut agent) = (new_device(), new_device(), new_device());
    let mut hub = Hub::new(checks);
    let room_group = found_room_on(&mut hub, &mut a);
    add_human(&mut hub, &mut a, &mut b);
    enrol(&mut hub, &mut a, &mut agent);
    for device in [&mut a, &mut b] {
        publish_some(&mut hub, device, 0);
    }
    publish_some(&mut hub, &mut agent, 1);
    let main = found_main(&mut hub, &mut a, &agent.id());
    settle(&hub, &mut b);
    settle(&hub, &mut agent);
    (hub, a, b, agent, room_group, main)
}

fn note_for(room: &RoomState) -> Vec<u8> {
    codec::encode(&CommitNote {
        room_epoch: room.epoch,
        room_state: room.state,
        time: now(),
        cuts: Vec::new(),
        join: false,
    })
    .unwrap()
}

#[test]
fn a_removed_devices_commit_that_names_the_room_before_its_removal_is_taken_by_nobody() {
    let (mut hub, mut a, mut b, mut agent, room_group, main) = room(false);
    let mut x = new_device();
    add_human(&mut hub, &mut a, &mut x);
    publish_some(&mut hub, &mut x, 0);
    trommi_tests::add_to_session(&mut hub, &mut a, &mut x, &main);
    for device in [&mut b, &mut x, &mut agent] {
        settle(&hub, device);
    }
    let before = hub.epoch(&main).unwrap();
    a.remove_human_devices(&[Cut::none(x.id())], now()).unwrap();
    post_ok(&mut hub, &mut a);

    // The removed device has not seen its removal and commits in the session group, naming the room epoch
    // it knows, where it was a human device. A checking hub answers `room-behind`; this one stores it,
    // behind the room Commit that removed the device.
    x.update(&main, true, now()).unwrap().unwrap();
    let entry = x.outbox().remove(0);
    let accepted = hub.post(&x.id(), &entry).unwrap();
    x.outbox_accepted(entry.id, accepted).unwrap();
    let stored = hub.log.last().unwrap().clone();

    // Every member, and the agent device that follows the room as an observer, judges it against the room
    // state at its place, where its committer is revoked: the Commit names an older one and is never taken.
    for device in [&mut a, &mut b, &mut agent] {
        let results = sync(&hub, device);
        let error = results.last().unwrap().as_ref().unwrap_err();
        assert_eq!(error, &Error::BadGroup);
        assert_eq!(log_finding(error), LogFinding::BadGroup);
        assert_eq!(device.group(&main).unwrap().epoch, before);
        assert_eq!(device.cursor() + 1, stored.change);
        // Handed again under a change number from before the removal it is no more welcome: the device
        // was a leaf of the group when it passed that place, and the entry was not there.
        let mut backdated = stored.clone();
        backdated.change = 1;
        assert_eq!(process(device, &backdated), Err(Error::WrongEpoch));
        assert_eq!(device.group(&main).unwrap().epoch, before);
    }
    for device in [&mut a, &mut b] {
        assert_eq!(device.group(&main).unwrap().disallowed, [x.id()]);
        assert_eq!(device.update(&main, true, now()), Err(Error::StaleSession));
    }
    // The device that made it learns of its removal first, and does not merge its own Commit either.
    let results = sync(&hub, &mut x);
    assert!(matches!(
        &results[..],
        [
            Ok(Processed::Commit { removed: true, .. }),
            Err(Error::BadGroup)
        ]
    ));
    assert_eq!(x.group(&main).unwrap().epoch, before);
    assert!(!x.is_human());

    // A device that signs in with the code replays the groups in the hub's order and finds the same: it
    // joins the room group, and the session group does not verify.
    let keys = test_keys();
    let mut c = new_device();
    join_room(&hub, &mut c, &keys).unwrap();
    post_ok(&mut hub, &mut c);
    assert!(c.is_human());
    assert_eq!(
        join_session(&hub, &mut c, &keys, &main).err(),
        Some(Error::BadGroup)
    );
    assert_eq!(c.group(&main).err(), Some(Error::NotFound));
    assert_eq!(c.group(&room_group).unwrap().leaves.len(), 3);
}

#[test]
fn a_session_commit_is_judged_against_the_room_at_its_own_place() {
    let (mut hub, mut a, mut b, _, room_group, main) = room(true);
    // Away for a while: a session Commit, a room Commit, a session Commit.
    for target in [main, room_group, main] {
        a.update(&target, true, now()).unwrap().unwrap();
        post_ok(&mut hub, &mut a);
    }
    let log = hub.log_after(b.cursor());
    let [first, room_commit, second] = &log[..] else {
        panic!("three Commits");
    };
    // The second session Commit names a room epoch the device has not reached: it came too early.
    assert!(matches!(
        process(&mut b, first),
        Ok(Processed::Commit { .. })
    ));
    let error = process(&mut b, second).unwrap_err();
    assert_eq!(error, Error::RoomBehind);
    assert_eq!(log_finding(&error), LogFinding::Early);
    assert!(matches!(
        process(&mut b, room_commit),
        Ok(Processed::Commit { .. })
    ));
    assert!(matches!(
        process(&mut b, second),
        Ok(Processed::Commit { .. })
    ));

    // A Commit that names the room epoch before the one of its place is behind for good, also for the hub.
    b.update(&main, true, now()).unwrap().unwrap();
    a.update(&room_group, true, now()).unwrap().unwrap();
    post_ok(&mut hub, &mut a);
    assert_eq!(post_refused(&mut hub, &mut b), [Error::RoomBehind]);
}

#[test]
fn nothing_of_a_helper_session_is_judged_without_its_main_session() {
    let (mut hub, mut a, mut b, mut agent, _, main) = room(true);
    // A helper device that follows the room group only: its Welcome into the helper session is early, and
    // uses up nothing. Once it follows the main session it is taken.
    let mut helper = new_device();
    observe(&hub, &mut helper);
    let side = found_helper(&mut hub, &mut agent, &main, &mut [&mut helper]);
    let welcome = hub.welcomes.last().unwrap().bytes.clone();
    let expected = WelcomeExpectation {
        room: main.room_id(),
        committer: Some(agent.id()),
    };
    assert_eq!(
        helper.join_welcome(&welcome, &expected, now()),
        Err(Error::RoomBehind)
    );
    assert!(helper.groups().unwrap().is_empty());
    helper
        .observe_session(hub.group_info(&main).unwrap())
        .unwrap();
    let joined = helper.join_welcome(&welcome, &expected, now()).unwrap();
    assert_eq!((joined.group, joined.offending.len()), (side, 0));
    assert!(helper.group(&side).unwrap().disallowed.is_empty());

    // A human device that is no leaf of the main session takes no Welcome into its helper session.
    for device in [&mut a, &mut b] {
        settle(&hub, device);
    }
    let mut late = new_device();
    add_human(&mut hub, &mut a, &mut late);
    publish_some(&mut hub, &mut late, 1);
    trommi_tests::add_to_session(&mut hub, &mut a, &mut late, &side);
    let of_side = hub.welcomes.last().unwrap().bytes.clone();
    let from_a = WelcomeExpectation {
        room: main.room_id(),
        committer: Some(a.id()),
    };
    assert_eq!(
        late.join_welcome(&of_side, &from_a, now()),
        Err(Error::RoomBehind)
    );
    trommi_tests::add_to_session(&mut hub, &mut a, &mut late, &main);
    let of_main = hub.welcomes.last().unwrap().bytes.clone();
    late.join_welcome(&of_main, &from_a, now()).unwrap();
    let joined = late.join_welcome(&of_side, &from_a, now()).unwrap();
    assert!(joined.offending.is_empty());
    assert_eq!(late.groups().unwrap().len(), 3);
}

#[test]
fn a_device_that_joined_by_welcome_knows_the_place_of_its_join() {
    let (mut hub, mut a, mut b, _, room_group, main) = room(false);
    // A member that obeys MLS only, a human device and a leaf of the session group.
    let forger = Forger::new();
    add_forger(&mut hub, &mut a, &forger);
    a.add_to_session(&main, &forger.id(), &forger.key_package(), now())
        .unwrap();
    post_ok(&mut hub, &mut a);
    let mut forged = forger.join(&hub.welcomes.last().unwrap().bytes);
    settle(&hub, &mut b);

    // A new device joins the room; the room goes on; then the device is added to the session, by a Commit
    // that names the new room epoch.
    let mut late = new_device();
    add_human(&mut hub, &mut a, &mut late);
    publish_some(&mut hub, &mut late, 0);
    let old_room = a.room_history().unwrap().newest().clone();
    let old_place = hub.change();
    let from = hub.change();
    a.update(&room_group, true, now()).unwrap().unwrap();
    post_ok(&mut hub, &mut a);
    trommi_tests::add_to_session(&mut hub, &mut a, &mut late, &main);
    // (the Add, not the session handover the adder sends behind it)
    let adding = hub
        .log
        .iter()
        .rev()
        .find(|item| item.commit && item.group == main)
        .unwrap()
        .clone();
    let welcome = hub.welcomes.last().unwrap().bytes.clone();
    forger.follow(&mut forged, &adding.bytes);
    a.update(&room_group, true, now()).unwrap().unwrap();
    post_ok(&mut hub, &mut a);

    // The new device passes the session's entries before it takes its Welcome.
    for item in hub.log_after(from) {
        process(&mut late, &item).unwrap();
    }
    let expected = WelcomeExpectation {
        room: main.room_id(),
        committer: Some(a.id()),
    };
    late.join_welcome(&welcome, &expected, now()).unwrap();
    // It is handed the Commit that added it: the place of its join, and with it the room epoch below which
    // the group's next Commit may not fall.
    assert_eq!(process(&mut late, &adding), Ok(Processed::Skipped));

    // The forger's Commit for the next epoch names the room epoch from before the join, and a hub hands it
    // under a change number of that time, where that epoch was current.
    let commit = forger.commit(&mut forged, &note_for(&old_room), &[]);
    let mut item = adding.clone();
    item.bytes = commit.commit;
    item.change = old_place;
    // The device knows the place of its join, and no Commit of the group's next epoch lies before it.
    assert_eq!(process(&mut late, &item), Err(Error::WrongEpoch));
    // Nor does one that claims a place behind the join and names the old room epoch: at that place the
    // room stood in a newer one.
    item.change = hub.change() + 1;
    assert_eq!(process(&mut late, &item), Err(Error::BadGroup));
    assert_eq!(late.group(&main).unwrap().epoch, adding.epoch + 1);
    // Handed the same entry a second time, the Commit that added it is a duplicate once the join has its
    // place; and the cleaning goes on as ever.
    assert!(cuts_for(&late, &main).is_empty());
    assert_eq!(sync_ok(&hub, &mut late), [] as [Processed; 0]);
}

#[test]
fn a_key_package_valid_for_longer_than_the_profile_allows_is_refused() {
    let (hub, mut a, _, _, _, _) = room(true);
    let mut forger = Forger::new();
    let ten_years = 10 * 365 * 24 * 60 * 60;
    forger.lifetime_s = Some(ten_years);
    assert!(trommi_core::device::key_package_info(&forger.key_package()).is_ok());
    forger.lifetime_s = Some(ten_years + 60);
    let package = forger.key_package();
    assert_eq!(
        trommi_core::device::key_package_info(&package).err(),
        Some(Error::BadKeyPackage)
    );
    // No Request is made with it (4.5), so no invite lets it in; the inviter's own check of a Request's
    // KeyPackage: `join_invite.rs`.
    assert_eq!(
        try_invite(&mut a, &mut forger.invitee(), Role::Human, None),
        Err(Error::BadKeyPackage)
    );
    assert!(a.outbox().is_empty());
    drop(hub);
}
