//! Section 8 end to end, on devices and the hub in memory: signing in with the code, the rows and links, the
//! replacement of the code, the whole recovery, and what a hub or a thief of one key tries against them.

use trommi_core::crypto::{Secret, SigningKey, SystemEntropy};
use trommi_core::device::{log_finding, CodeJoin, LogFinding, Processed, Received};
use trommi_core::ids::{DeviceId, GroupId};
use trommi_core::mls::profile::{CommitNote, Cut};
use trommi_core::mls::rules::RoomState;
use trommi_core::recovery::{
    self, check_room, KeyContext, MacState, RecoveryAuth, RecoveryJoin, RecoveryKeys, SealedKey,
    Sealing,
};
use trommi_core::store::{OutboxEntry, OutboxKind};
use trommi_core::{codec, Error};
use trommi_tests::forge::Forger;
use trommi_tests::hub::{Hub, RECOVERY_FOR_MS};
use trommi_tests::{
    add_human, enrol, fetch, found_helper, found_main, found_room_on, join_room, join_session,
    new_device, new_device_on, now, observe, post_all, post_ok, post_refused, publish_some, reopen,
    settle, sign_in, sync, test_code, test_keys, Fetched, MemoryStorage, TestDevice,
};

/// A room with two human devices, a main session with its agent device, and a helper session of that agent
/// with one helper device.
struct World {
    hub: Hub,
    a: TestDevice,
    b: TestDevice,
    agent: TestDevice,
    helper: TestDevice,
    room: GroupId,
    main: GroupId,
    side: GroupId,
    /// The helper devices the opener brought in later.
    helpers: Vec<DeviceId>,
}

fn world(checks: bool) -> World {
    let (mut a, mut b, mut agent, mut helper) =
        (new_device(), new_device(), new_device(), new_device());
    let mut hub = Hub::new(checks);
    let room = found_room_on(&mut hub, &mut a);
    add_human(&mut hub, &mut a, &mut b);
    enrol(&mut hub, &mut a, &mut agent);
    for device in [&mut a, &mut b] {
        publish_some(&mut hub, device, 0);
    }
    publish_some(&mut hub, &mut agent, 1);
    let main = found_main(&mut hub, &mut a, &agent.id());
    settle(&hub, &mut b);
    settle(&hub, &mut agent);
    observe(&hub, &mut helper);
    let side = found_helper(&mut hub, &mut agent, &main, &mut [&mut helper]);
    let mut world = World {
        hub,
        a,
        b,
        agent,
        helper,
        room,
        main,
        side,
        helpers: Vec::new(),
    };
    world.settle_all();
    world
}

impl World {
    fn settle_all(&mut self) {
        for device in [&mut self.a, &mut self.b, &mut self.agent, &mut self.helper] {
            settle(&self.hub, device);
        }
    }

    /// The groups, the room group first.
    fn groups(&self) -> [GroupId; 3] {
        [self.room, self.main, self.side]
    }

    /// Many epochs in all three groups: the human devices update in turn, and the opener brings a helper
    /// device into its helper session, which makes an epoch whose row no human device wrote.
    fn write_epochs(&mut self, rounds: usize) {
        for round in 0..rounds {
            for group in self.groups() {
                let device = if round % 2 == 0 {
                    &mut self.a
                } else {
                    &mut self.b
                };
                device.update(&group, true, now()).unwrap().unwrap();
                post_ok(&mut self.hub, device);
                self.settle_all();
            }
            // A helper session holds seven helper devices at most: beyond three, one is replaced.
            let mut another = new_device();
            observe(&self.hub, &mut another);
            let package = another.key_package(now()).unwrap();
            if self.helpers.len() < 3 {
                self.agent
                    .add_to_session(&self.side, &another.id(), &package, now())
                    .unwrap();
            } else {
                let old = Cut::none(self.helpers.remove(0));
                self.agent
                    .readmit_helper(&self.side, old, &another.id(), &package, now())
                    .unwrap();
            }
            self.helpers.push(another.id());
            post_ok(&mut self.hub, &mut self.agent);
            self.settle_all();
        }
    }
}

/// Every content key that `holder` has of `group`, by epoch.
fn keys_of(hub: &Hub, holder: &TestDevice, group: &GroupId) -> Vec<(u64, Secret<32>)> {
    (0..=hub.epoch(group).unwrap())
        .filter_map(|epoch| Some((epoch, holder.content_key(group, epoch).ok()?)))
        .collect()
}

/// The whole recovery of 8.7 by `device` with the code `keys`, against what `fetched` says the hub serves.
/// Returns the new code.
fn recover(
    hub: &mut Hub,
    device: &mut TestDevice,
    keys: &RecoveryKeys,
    fetched: &Fetched,
) -> Result<(Secret<32>, CodeJoin), Error> {
    let room = fetched.room.group.room_id();
    let (replacement, cuts) = fetched.served(|served| {
        let checked = check_room(keys, served)?;
        let history = checked.observer.history().expect("the room's roles");
        let replacement = keys.replace(&mut SystemEntropy, &room, history)?;
        // No device of this room wrote an envelope: every chain ends at nothing.
        let cuts: Vec<(GroupId, Cut)> = recovery::removals(&checked)?
            .into_iter()
            .flat_map(|(group, gone)| {
                gone.into_iter()
                    .map(move |device| (group, Cut::none(device)))
            })
            .collect();
        Ok::<_, Error>((replacement, cuts))
    })?;
    let built = fetched.served(|served| {
        device.recover(keys, served, &replacement, &cuts, b"sealed copies", now())
    })?;
    hub.account.clear();
    Ok((replacement.code.duplicate(), built))
}

// ---- signing in on a second device ----

#[test]
fn a_second_device_signs_in_with_the_code_while_the_first_still_exists() {
    let mut w = world(true);
    w.write_epochs(2);
    let keys = test_keys();
    let mut c = new_device();

    // The join is built on a copy: until the hub answers the device holds nothing.
    let built = join_room(&w.hub, &mut c, &keys).unwrap();
    assert_eq!(built.missing_link, None);
    assert!(built.unverified.is_empty());
    assert!(c.groups().unwrap().is_empty() && !c.is_human() && c.room().is_none());
    assert_eq!(c.content_key(&w.room, 0), Err(Error::NoKey));
    let entry = c.outbox().remove(0);
    assert_eq!(entry.kind, OutboxKind::ExternalCommit);
    // It comes with its RecoveryAuth, which names the join and is signed with the code's key.
    let auth = RecoveryAuth::from_bytes(&entry.parts[3]).unwrap();
    let before = w.hub.epoch(&w.room).unwrap();
    assert_eq!(auth.join.joiner, c.id());
    assert_eq!(
        (auth.join.base.epoch, auth.join.room_epoch),
        (before, before)
    );
    assert_eq!(
        auth.join.base.group_info,
        recovery::group_info_hash(w.hub.group_info(&w.room).unwrap()).unwrap()
    );
    assert_eq!(auth.commit, recovery::commit_hash(&entry.parts[0]).unwrap());
    // Its row is a human device's: sealed to the room's key, with the mac of the code.
    let row = SealedKey::from_bytes(&entry.parts[2]).unwrap();
    assert_eq!(row.writer, c.id());
    assert_eq!(row.mac_state(&keys.mac_key().key).unwrap(), MacState::Valid);
    assert_eq!(join_room(&w.hub, &mut c, &keys).err(), Some(Error::Busy));

    post_ok(&mut w.hub, &mut c);
    assert!(c.is_human() && c.holds_recovery_mac());
    assert_eq!(w.hub.epoch(&w.room), Some(before + 1));
    assert_eq!(
        w.hub.log.last().unwrap().recovery_auth.as_deref(),
        Some(&entry.parts[3][..])
    );
    // The members follow the join.
    w.settle_all();
    assert_eq!(
        w.a.content_key(&w.room, before + 1).unwrap(),
        c.content_key(&w.room, before + 1).unwrap()
    );
    assert_eq!(w.a.group(&w.room).unwrap().leaves.len(), 3);

    // It holds the whole history of the room group and of both sessions, opened from the rows.
    for group in w.groups() {
        for (epoch, key) in keys_of(&w.hub, &w.a, &group) {
            assert_eq!(
                c.content_key(&group, epoch).unwrap(),
                key,
                "{group} {epoch}"
            );
        }
    }
    // What a human device wrote is confirmed; the helper session's epochs that only its opener sealed are not.
    assert!((0..=before).all(|epoch| c.key_is_confirmed(&w.room, epoch)));
    assert!(!c.key_is_confirmed(&w.side, 0) && !c.key_is_confirmed(&w.side, 1));
    assert_eq!(
        c.content_key(&w.side, 0).unwrap(),
        w.agent.content_key(&w.side, 0).unwrap()
    );
    assert!(c.key_is_confirmed(&w.side, 2));

    // Then every live session group the same way, main session first.
    assert_eq!(w.hub.live_sessions(), [w.main, w.side]);
    for group in [w.main, w.side] {
        join_session(&w.hub, &mut c, &keys, &group).unwrap();
        assert_eq!(c.group(&group).err(), Some(Error::NotFound));
        post_ok(&mut w.hub, &mut c);
        w.settle_all();
        let epoch = w.hub.epoch(&group).unwrap();
        for device in [&w.a, &w.b, &w.agent] {
            assert_eq!(
                device.content_key(&group, epoch).unwrap(),
                c.content_key(&group, epoch).unwrap()
            );
        }
        assert!(c.group(&group).unwrap().leaves.contains(&c.id()));
    }
    // The code is dropped; the device keeps recovery_mac and is a full member: its Commits are followed.
    drop(keys);
    for group in w.groups() {
        c.update(&group, true, now()).unwrap().unwrap();
        post_ok(&mut w.hub, &mut c);
    }
    w.settle_all();
    let epoch = w.hub.epoch(&w.side).unwrap();
    assert_eq!(
        w.helper.content_key(&w.side, epoch).unwrap(),
        c.content_key(&w.side, epoch).unwrap()
    );
    // And it processes the log from its beginning without taking anything twice.
    settle(&w.hub, &mut c);
    assert_eq!(c.cursor(), w.hub.change());
}

#[test]
fn the_wrong_code_joins_nothing() {
    let mut w = world(true);
    w.write_epochs(1);
    let wrong = RecoveryKeys::from_code(Secret::new([0x33; 32])).unwrap();
    let mut c = new_device();
    assert_eq!(
        join_room(&w.hub, &mut c, &wrong).err(),
        Some(Error::WrongRecovery)
    );
    assert!(c.outbox().is_empty() && c.room().is_none());

    // A hub that forges rows for that code still serves a room whose state holds other keys.
    let mut fetched = fetch(&w.hub, &wrong);
    let info = w.hub.group_info(&w.room).unwrap().clone();
    let epoch = w.hub.epoch(&w.room).unwrap();
    let forged = SealedKey::seal(
        &mut SystemEntropy,
        &Sealing {
            context: KeyContext::of(&w.room, epoch, &info).unwrap(),
            room_epoch: epoch,
            recovery_hpke_key: &wrong.public().hpke_key,
            writer: w.a.id(),
            content_key: &Secret::new([1; 32]),
        },
        Some(&wrong.mac_key().key),
    )
    .unwrap();
    fetched.rows.push(forged.to_bytes().unwrap());
    fetched.anchor = info;
    assert_eq!(
        fetched
            .served(|served| c.join_room_with_code(&wrong, served, now()))
            .err(),
        Some(Error::WrongRecovery)
    );
    assert!(c.outbox().is_empty());
}

// ---- a thief of one key ----

/// The newest room state `device` knows.
fn newest(device: &TestDevice) -> RoomState {
    device.room_history().unwrap().newest().clone()
}

/// A join from outside by `thief`, who holds a signature key and no code, as an outbox entry: the Commit that
/// MLS takes, naming the room state `room`, its GroupInfo, some row, and whatever it offers as its
/// `RecoveryAuth`.
fn thiefs_join(
    hub: &Hub,
    room: &RoomState,
    thief: &Forger,
    group: &GroupId,
    auth: impl FnOnce(&RecoveryJoin, &[u8]) -> Vec<u8>,
) -> OutboxEntry {
    let info = hub.group_info(group).unwrap().clone();
    let note = CommitNote {
        room_epoch: room.epoch,
        room_state: room.state,
        time: now(),
        cuts: Vec::new(),
        join: true,
    };
    let (_, forged) = thief.join_from_outside(&info, &codec::encode(&note).unwrap());
    let join = RecoveryJoin {
        base: KeyContext::of(group, forged.epoch, &info).unwrap(),
        room_epoch: room.epoch,
        room_state: room.state,
        joiner: thief.id(),
    };
    let row = SealedKey::seal(
        &mut SystemEntropy,
        &Sealing {
            context: KeyContext::of(group, forged.epoch + 1, &forged.group_info).unwrap(),
            room_epoch: room.epoch,
            recovery_hpke_key: &room.room.recovery_hpke_key,
            writer: thief.id(),
            content_key: &Secret::new([7; 32]),
        },
        Some(&Secret::new([8; 32])),
    )
    .unwrap();
    OutboxEntry {
        id: 0,
        kind: OutboxKind::ExternalCommit,
        group: Some(*group),
        epoch: forged.epoch,
        parts: vec![
            forged.commit.clone(),
            forged.group_info,
            row.to_bytes().unwrap(),
            auth(&join, &forged.commit),
        ],
    }
}

/// A `RecoveryAuth` for `join` and `commit`, signed with `key` instead of the recovery key.
fn signed_with(key: &SigningKey, join: &RecoveryJoin, commit: &[u8]) -> Vec<u8> {
    let commit = recovery::commit_hash(commit).unwrap();
    let content = [codec::encode(join).unwrap(), commit.as_bytes().to_vec()].concat();
    let signature = trommi_core::crypto::sign_with_label(key, "TrommiRecoveryJoin", &content)
        .unwrap()
        .try_into()
        .unwrap();
    RecoveryAuth {
        join: *join,
        commit,
        signature,
    }
    .to_bytes()
    .unwrap()
}

#[test]
fn a_signature_key_alone_opens_no_group() {
    let mut w = world(true);
    let thief = Forger::new();
    let epochs = (w.hub.epoch(&w.room), w.hub.epoch(&w.main));

    // No recovery signature at all: there is no other join from outside.
    let bare = thiefs_join(&w.hub, &newest(&w.a), &thief, &w.room, |_, _| Vec::new());
    assert_eq!(w.hub.post(&thief.id(), &bare), Err(Error::BadCommit));
    let junk = thiefs_join(&w.hub, &newest(&w.a), &thief, &w.room, |_, _| {
        b"no signature".to_vec()
    });
    assert_eq!(w.hub.post(&thief.id(), &junk), Err(Error::BadCommit));
    // A RecoveryAuth with everything right but the key: the thief signs with the device key it holds.
    let own = thiefs_join(&w.hub, &newest(&w.a), &thief, &w.room, |join, commit| {
        signed_with(&thief.key, join, commit)
    });
    assert_eq!(w.hub.post(&thief.id(), &own), Err(Error::BadSignature));
    // Into a session group: its key is no human device's.
    let session = thiefs_join(&w.hub, &newest(&w.a), &thief, &w.main, |join, commit| {
        signed_with(&thief.key, join, commit)
    });
    assert_eq!(w.hub.post(&thief.id(), &session), Err(Error::BadCommit));
    assert_eq!((w.hub.epoch(&w.room), w.hub.epoch(&w.main)), epochs);
    // The refusals left the hub's view of the groups as it was: the members go on.
    w.a.update(&w.room, true, now()).unwrap().unwrap();
    post_ok(&mut w.hub, &mut w.a);
    w.settle_all();
}

#[test]
fn a_stolen_device_key_joins_no_session_from_outside() {
    // The phone's signature key was copied; the phone then updated everywhere. The thief holds the key and
    // nothing current: with a join from outside that takes the phone's old leaf away it would be in again.
    let mut w = world(true);
    let stolen = Forger::new();
    let room = trommi_tests::add_forger(&mut w.hub, &mut w.a, &stolen);
    drop(room);
    w.settle_all();
    assert!(w.hub.history().unwrap().newest().is_human(&stolen.id()));
    for group in [w.room, w.main] {
        for auth in [
            thiefs_join(&w.hub, &newest(&w.a), &stolen, &group, |_, _| Vec::new()),
            thiefs_join(&w.hub, &newest(&w.a), &stolen, &group, |join, commit| {
                signed_with(&stolen.key, join, commit)
            }),
        ] {
            let refusal = w.hub.post(&stolen.id(), &auth).unwrap_err();
            assert!(
                matches!(refusal, Error::BadCommit | Error::BadSignature),
                "{refusal:?}"
            );
        }
    }
}

#[test]
fn an_unauthorised_join_that_a_hub_let_through_is_refused_by_every_member() {
    // A hub that enforces nothing takes a stranger's join from outside while no human device is online. The
    // members refuse it when they come back, and nobody commits on top of it.
    let mut w = world(false);
    let thief = Forger::new();
    for (group, refusal) in [(w.main, Error::BadCommit), (w.room, Error::BadSignature)] {
        let entry = thiefs_join(&w.hub, &newest(&w.a), &thief, &group, |join, commit| {
            signed_with(&thief.key, join, commit)
        });
        let epoch = w.hub.epoch(&group).unwrap();
        w.hub.post(&thief.id(), &entry).unwrap();
        assert_eq!(w.hub.epoch(&group), Some(epoch + 1));
        // The human devices, the agent device (a leaf of the session, an observer of the room) and the
        // helper device (an observer of the room): each keeps its last good state.
        let mut devices = vec![&mut w.a, &mut w.b, &mut w.agent];
        if group.is_room() {
            devices.push(&mut w.helper);
        }
        for device in devices {
            let results = sync(&w.hub, device);
            let error = results.last().unwrap().as_ref().unwrap_err();
            assert_eq!(error, &refusal);
            assert_eq!(log_finding(error), LogFinding::BadGroup);
        }
        assert_eq!(w.a.group(&group).unwrap().epoch, epoch);
    }
    // Without any RecoveryAuth the members refuse just the same.
    let mut w = world(false);
    let entry = thiefs_join(&w.hub, &newest(&w.a), &thief, &w.room, |_, _| Vec::new());
    w.hub.post(&thief.id(), &entry).unwrap();
    let results = sync(&w.hub, &mut w.a);
    assert_eq!(results.last().unwrap(), &Err(Error::BadCommit));
}

#[test]
fn a_recovery_auth_fits_no_other_commit() {
    let mut w = world(true);
    let keys = test_keys();
    // A real join is built and its RecoveryAuth taken by a thief of the wire.
    let mut c = new_device();
    join_room(&w.hub, &mut c, &keys).unwrap();
    let real = c.outbox().remove(0);
    let thief = Forger::new();
    let moved = thiefs_join(&w.hub, &newest(&w.a), &thief, &w.room, |_, _| {
        real.parts[3].clone()
    });
    assert_eq!(w.hub.post(&thief.id(), &moved), Err(Error::BadCommit));
    // Replayed after the real join was taken: the epoch it was made for is gone.
    post_ok(&mut w.hub, &mut c);
    let replayed = thiefs_join(&w.hub, &newest(&w.a), &thief, &w.room, |_, _| {
        real.parts[3].clone()
    });
    assert_eq!(w.hub.post(&thief.id(), &replayed), Err(Error::BadCommit));

    // The same on a hub that checks nothing: the members refuse it.
    let mut open = world(false);
    let mut d = new_device();
    join_room(&open.hub, &mut d, &keys).unwrap();
    let real = d.outbox().remove(0);
    let moved = thiefs_join(&open.hub, &newest(&open.a), &thief, &open.room, |_, _| {
        real.parts[3].clone()
    });
    open.hub.post(&thief.id(), &moved).unwrap();
    let results = sync(&open.hub, &mut open.a);
    assert_eq!(results.last().unwrap(), &Err(Error::BadCommit));
}

#[test]
fn a_join_whose_signature_is_wrong_is_refused_with_bad_signature() {
    let mut w = world(true);
    let keys = test_keys();
    let mut c = new_device();
    join_room(&w.hub, &mut c, &keys).unwrap();
    let mut entry = c.outbox().remove(0);
    let last = entry.parts[3].len() - 1;
    entry.parts[3][last] ^= 1;
    assert_eq!(w.hub.post(&c.id(), &entry), Err(Error::BadSignature));
    // A changed field under the old signature is no better.
    let mut auth = RecoveryAuth::from_bytes(&c.outbox()[0].parts[3]).unwrap();
    auth.join.room_epoch += 1;
    entry.parts[3] = auth.to_bytes().unwrap();
    assert_eq!(w.hub.post(&c.id(), &entry), Err(Error::BadCommit));
    // The join as the device made it is taken, and the device learns of the refusal of nothing.
    post_ok(&mut w.hub, &mut c);
    assert!(c.is_human());
}

// ---- 13.2: a join from outside and a crash ----

#[test]
fn a_crash_between_the_steps_of_a_join_loses_nothing() {
    let mut w = world(true);
    w.write_epochs(1);
    let keys = test_keys();
    let store = MemoryStorage::new();
    let handle = store.handle();
    let mut c = new_device_on(store);
    join_room(&w.hub, &mut c, &keys).unwrap();
    let entry = c.outbox().remove(0);
    drop(c);

    // After a crash the join is still a copy beside the real state, and the request is the same bytes.
    let c = reopen(handle.reopened()).unwrap();
    assert_eq!(c.outbox(), std::slice::from_ref(&entry));
    assert!(c.groups().unwrap().is_empty() && !c.is_human() && !c.holds_recovery_mac());
    assert_eq!(c.content_key(&w.room, 0), Err(Error::NoKey));
    // The hub takes it, the answer is lost in another crash, and the repeated post is answered like the first.
    let answer = w.hub.post(&c.id(), &entry).unwrap();
    let store = handle.reopened();
    drop(c);
    let mut c = reopen(store).unwrap();
    assert_eq!(w.hub.post(&c.id(), &entry), Ok(answer));
    let handle = {
        // A write that fails while the answer is applied leaves the copy a copy.
        let store = handle.reopened();
        let handle = store.handle();
        drop(c);
        c = reopen(store).unwrap();
        handle.fail_apply(1);
        assert!(c.outbox_accepted(entry.id, answer).is_err());
        assert!(!c.is_human() && c.outbox().len() == 1);
        handle
    };
    c.outbox_accepted(entry.id, answer).unwrap();
    assert!(c.is_human() && c.outbox().is_empty() && c.holds_recovery_mac());
    // What is stored is what memory holds: a restart finds the same member, with every key.
    let again = reopen(handle.reopened()).unwrap();
    for group in w.groups() {
        for (epoch, key) in keys_of(&w.hub, &w.a, &group) {
            assert_eq!(again.content_key(&group, epoch).unwrap(), key);
        }
    }
    let epoch = w.hub.epoch(&w.room).unwrap();
    assert_eq!(again.group(&w.room).unwrap().epoch, epoch);
    assert!(!again.key_is_confirmed(&w.side, 0));

    // A refused join leaves nothing behind.
    let store = MemoryStorage::new();
    let handle = store.handle();
    let mut d = new_device_on(store);
    let built = join_room(&w.hub, &mut d, &keys).unwrap();
    d.outbox_refused(built.outbox[0], &Error::EpochTaken)
        .unwrap();
    assert!(d.outbox().is_empty() && d.room().is_none());
    let d = reopen(handle.reopened()).unwrap();
    assert!(d.outbox().is_empty() && d.groups().unwrap().is_empty() && !d.holds_recovery_mac());
    assert_eq!(d.content_key(&w.room, 0), Err(Error::NoKey));
}

// ---- 8.3: the row a human device posts ----

#[test]
fn a_human_device_authenticates_what_an_opener_sealed() {
    let mut w = world(true);
    let epoch = w.hub.epoch(&w.side).unwrap();
    let keys = test_keys();
    // The founding of the helper session was the opener's: no row of it has a mac.
    let opener_rows = |hub: &Hub| -> Vec<SealedKey> {
        hub.sealed_keys
            .iter()
            .filter(|(group, _, _)| *group == w.side)
            .map(|(_, _, row)| SealedKey::from_bytes(row).unwrap())
            .collect()
    };
    assert!(opener_rows(&w.hub).iter().all(|row| row.mac.is_none()));

    // A human device that stands in the epoch finds no row it can verify and posts one, with the GroupInfo
    // the hub holds, which it checks against its own state.
    let info = w.hub.group_info(&w.side).unwrap().clone();
    let other = w.hub.group_info(&w.main).unwrap().clone();
    assert_eq!(
        w.a.post_sealed_key(&w.side, &other, &w.hub.rows()),
        Err(Error::Incomplete)
    );
    let id = w.a.post_sealed_key(&w.side, &info, &w.hub.rows()).unwrap();
    assert!(id.is_some());
    assert_eq!(w.a.outbox()[0].kind, OutboxKind::SealedKey);
    // Only a human device that is the row's writer posts it.
    let entry = w.a.outbox().remove(0);
    assert_eq!(w.hub.post(&w.b.id(), &entry), Err(Error::Forbidden));
    assert_eq!(w.hub.post(&w.agent.id(), &entry), Err(Error::Forbidden));
    post_ok(&mut w.hub, &mut w.a);
    let rows = opener_rows(&w.hub);
    let posted = rows.last().unwrap();
    assert_eq!((posted.context.epoch, posted.writer), (epoch, w.a.id()));
    assert_eq!(
        posted.mac_state(&keys.mac_key().key).unwrap(),
        MacState::Valid
    );
    // Now one is listed: nothing more to post. An agent device posts none.
    assert_eq!(w.b.post_sealed_key(&w.side, &info, &w.hub.rows()), Ok(None));
    assert_eq!(
        w.agent.post_sealed_key(&w.side, &info, &w.hub.rows()),
        Err(Error::Forbidden)
    );

    // A device that signs in finds that epoch confirmed, and the founding epoch not.
    let mut c = new_device();
    sign_in(&mut w.hub, &mut c);
    assert!(c.key_is_confirmed(&w.side, epoch) && !c.key_is_confirmed(&w.side, 0));
    assert_eq!(
        c.content_key(&w.side, epoch).unwrap(),
        w.a.content_key(&w.side, epoch).unwrap()
    );
}

// ---- 8.6: replacing the code ----

#[test]
fn the_code_is_replaced_as_one_request_and_the_new_one_reads_everything() {
    let mut w = world(true);
    w.write_epochs(1);
    let old = test_keys();
    let room_id = w.room.room_id();
    let replacement = old
        .replace(&mut SystemEntropy, &room_id, w.a.room_history().unwrap())
        .unwrap();
    let new_code = replacement.code.duplicate();
    let before = w.hub.epoch(&w.room).unwrap();

    // Only a human device that holds the current code replaces it.
    let wrong = RecoveryKeys::from_code(Secret::new([0x33; 32])).unwrap();
    assert_eq!(
        w.a.replace_code(&wrong, &replacement, b"copies", now()),
        Err(Error::WrongRecovery)
    );
    assert_eq!(
        w.agent.replace_code(&old, &replacement, b"copies", now()),
        Err(Error::Forbidden)
    );
    w.a.replace_code(&old, &replacement, b"copies", now())
        .unwrap();
    let entry = w.a.outbox().remove(0);
    assert_eq!(entry.kind, OutboxKind::RecoveryCode);
    assert_eq!(entry.parts[3], replacement.link);
    // 8.2: the row of that Commit names the new room epoch and is sealed to the new key with the new mac.
    let row = SealedKey::from_bytes(&entry.parts[2]).unwrap();
    assert_eq!(
        (row.context.epoch, row.room_epoch),
        (before + 1, before + 1)
    );
    assert_eq!(row.recovery_hpke_key, replacement.keys.public().hpke_key);
    assert_eq!(
        row.mac_state(&replacement.keys.mac_key().key).unwrap(),
        MacState::Valid
    );

    // The hub applies it whole or not at all: the Commit alone, or with a link for another key, is refused.
    let mut alone = entry.clone();
    alone.kind = OutboxKind::Commit;
    alone.parts = vec![
        entry.parts[0].clone(),
        entry.parts[1].clone(),
        Vec::new(),
        entry.parts[2].clone(),
    ];
    assert_eq!(w.hub.post(&w.a.id(), &alone), Err(Error::Incomplete));
    let mut other_link = entry.clone();
    let stranger = old
        .replace(&mut SystemEntropy, &room_id, w.a.room_history().unwrap())
        .unwrap();
    other_link.parts[3] = stranger.link;
    assert_eq!(w.hub.post(&w.a.id(), &other_link), Err(Error::Incomplete));
    assert_eq!((w.hub.epoch(&w.room), w.hub.links.len()), (Some(before), 0));

    post_ok(&mut w.hub, &mut w.a);
    assert_eq!(w.hub.epoch(&w.room), Some(before + 1));
    assert_eq!(w.hub.links, std::slice::from_ref(&replacement.link));
    assert_eq!(w.hub.account, b"copies");
    let state = w.hub.history().unwrap().newest().room.clone();
    assert_eq!(state.recovery_hpke_key, replacement.keys.public().hpke_key);
    assert_eq!(
        state.recovery_signature_key,
        replacement.keys.public().signature_key
    );

    // 7.4: with the Commit the device sent the new recovery_mac to all; until it arrives the other human
    // device commits nothing.
    assert!(w.a.holds_recovery_mac());
    let item = w.hub.log.last().unwrap().clone();
    assert!(!item.commit && item.group == w.room);
    for commit in w
        .hub
        .log_after(w.b.cursor())
        .iter()
        .filter(|item| item.commit)
    {
        trommi_tests::process(&mut w.b, commit).unwrap();
    }
    assert!(!w.b.holds_recovery_mac());
    assert_eq!(w.b.update(&w.main, true, now()), Err(Error::NoKey));
    let asked = w.a.send_recovery_auth(&w.b.id()).unwrap();
    assert_eq!(w.a.outbox()[0].id, asked);
    post_ok(&mut w.hub, &mut w.a);
    let processed = settle(&w.hub, &mut w.b);
    // The one sent to all reaches it with the log, and the one it asked for brings nothing new.
    let taken: Vec<bool> = processed
        .iter()
        .filter_map(|done| match done {
            Processed::Message(Received::RecoveryAuth { new, .. }) => Some(*new),
            _ => None,
        })
        .collect();
    assert_eq!(taken, [true, false]);
    assert!(w.b.holds_recovery_mac());
    w.settle_all();

    // The room goes on under the new key, in every group.
    for group in w.groups() {
        w.b.update(&group, true, now()).unwrap().unwrap();
        post_ok(&mut w.hub, &mut w.b);
        w.settle_all();
        let row = SealedKey::from_bytes(&w.hub.sealed_keys.last().unwrap().2).unwrap();
        assert_eq!(row.recovery_hpke_key, state.recovery_hpke_key);
        assert_eq!(
            row.mac_state(&replacement.keys.mac_key().key).unwrap(),
            MacState::Valid
        );
    }

    // The old code signs nobody in any more; nor may its holder replace the code again.
    let mut late = new_device();
    assert_eq!(
        join_room(&w.hub, &mut late, &old).err(),
        Some(Error::WrongRecovery)
    );
    assert_eq!(
        old.replace(&mut SystemEntropy, &room_id, w.a.room_history().unwrap())
            .err(),
        Some(Error::WrongRecovery)
    );
    // The new code does, and across the RecoveryLink it reads what was sealed to the old key.
    let new = RecoveryKeys::from_code(new_code).unwrap();
    let built = join_room(&w.hub, &mut late, &new).unwrap();
    assert_eq!(built.missing_link, None);
    post_ok(&mut w.hub, &mut late);
    for group in w.groups() {
        for (epoch, key) in keys_of(&w.hub, &w.a, &group) {
            assert_eq!(
                late.content_key(&group, epoch).unwrap(),
                key,
                "{group} {epoch}"
            );
        }
    }
    assert!((0..=before + 2).all(|epoch| late.key_is_confirmed(&w.room, epoch)));

    // A hub that withholds the link closes the older rows and nothing else, and the device names it.
    let mut fetched = fetch(&w.hub, &new);
    fetched.links.clear();
    let mut blind = new_device();
    let built = fetched
        .served(|served| blind.join_room_with_code(&new, served, now()))
        .unwrap();
    assert_eq!(built.missing_link, Some(state.recovery_hpke_key));
    post_ok(&mut w.hub, &mut blind);
    assert_eq!(blind.content_key(&w.room, 0), Err(Error::NoKey));
    assert!(blind.content_key(&w.room, before + 1).is_ok());
}

// ---- 8.7 and conformance test 1 of section 19 ----

#[test]
fn the_whole_of_section_8_in_one_run() {
    // Found, and write in three groups over many epochs.
    let mut w = world(true);
    w.write_epochs(8);
    let last: Vec<u64> = w
        .groups()
        .iter()
        .map(|group| w.hub.epoch(group).unwrap())
        .collect();
    assert!(last.iter().all(|epoch| *epoch >= 9));
    // What the devices held, before they are lost: every content key of every group and epoch.
    let mut held: Vec<(GroupId, u64, Secret<32>)> = Vec::new();
    for group in w.groups() {
        for holder in [&w.a, &w.agent] {
            for (epoch, key) in keys_of(&w.hub, holder, &group) {
                if !held.iter().any(|(g, e, _)| (*g, *e) == (group, epoch)) {
                    held.push((group, epoch, key));
                }
            }
        }
    }
    assert_eq!(
        held.len() as u64,
        last.iter().map(|epoch| epoch + 1).sum::<u64>()
    );
    let (lost_a, lost_b) = (w.a.id(), w.b.id());
    let World {
        mut hub,
        a,
        b,
        mut agent,
        mut helper,
        room,
        main,
        side,
        ..
    } = w;
    // Every human device is lost.
    drop((a, b));
    let groups = [room, main, side];
    let keys = test_keys();
    let honest = fetch(&hub, &keys);
    let check = |fetched: &Fetched| fetched.served(|served| check_room(&keys, served));
    assert_eq!(check(&honest).unwrap().anchor.epoch, last[0]);

    // --- a hub that offers a room of its own making ---
    // It knows the recovery public keys and every public message; it holds no recovery_mac and no device key.
    let state = hub.history().unwrap().newest().room.clone();
    let hubs_own = Forger::new();
    let fake = hubs_own.found_room(&room, &state);
    let fake_info = hubs_own.group_info(&fake);
    let fake_row = |mac: Option<&Secret<32>>| {
        SealedKey::seal(
            &mut SystemEntropy,
            &Sealing {
                context: KeyContext::of(&room, 0, &fake_info).unwrap(),
                room_epoch: 0,
                recovery_hpke_key: &state.recovery_hpke_key,
                writer: hubs_own.id(),
                content_key: &Secret::new([0x66; 32]),
            },
            mac,
        )
        .unwrap()
        .to_bytes()
        .unwrap()
    };
    let mut own = honest.clone();
    own.room.founding = fake_info.clone();
    own.room.current = fake_info.clone();
    own.room.commits.clear();
    own.anchor = fake_info.clone();
    own.sessions.clear();
    // With rows of its own, with or without a mac: none anchors.
    for rows in [
        vec![fake_row(None)],
        vec![fake_row(Some(&Secret::new([0x67; 32])))],
        Vec::new(),
    ] {
        own.rows = rows;
        assert_eq!(check(&own).err(), Some(Error::WrongRecovery));
    }
    // With the real rows beside its own room: the anchor is the real one, and its room is not that state.
    own.rows = honest.rows.clone();
    own.rows.push(fake_row(None));
    assert_eq!(check(&own).err(), Some(Error::WrongRecovery));
    // Its own GroupInfo offered as the current state of the real room.
    let mut grafted = honest.clone();
    grafted.room.current = fake_info;
    assert_eq!(check(&grafted).err(), Some(Error::WrongRecovery));
    let mut device = new_device();
    assert_eq!(
        recover(&mut hub, &mut device, &keys, &own).err(),
        Some(Error::WrongRecovery)
    );

    // --- an older state ---
    // With every row served, an older GroupInfo as the current one does not agree with the state reached.
    for epoch in [0, last[0] / 2, last[0] - 1] {
        let mut older = honest.clone();
        older.room.current = hub.group_info_at(&room, epoch).unwrap().clone();
        assert_eq!(check(&older).err(), Some(Error::WrongRecovery));
        // Nor does it help to cut the log there.
        older.room.commits.truncate(epoch as usize);
        assert_eq!(check(&older).err(), Some(Error::WrongRecovery));
    }
    // A session group's older GroupInfo: that session does not verify, and a recovery does not go on.
    let mut older = honest.clone();
    older.sessions[0].current = hub.group_info_at(&main, 2).unwrap().clone();
    let checked = check(&older).unwrap();
    assert_eq!(
        checked.sessions[0].as_ref().err(),
        Some(&Error::WrongRecovery)
    );
    assert_eq!(
        recover(&mut hub, &mut device, &keys, &older).err(),
        Some(Error::WrongRecovery)
    );
    // What a hub can do is serve a state that once was the newest, with nothing after it (section 17): the
    // device cannot tell, and the hub that holds the newer state takes no Commit built on the old one.
    let mut once = honest.clone();
    let cut_at = last[0] - 2;
    once.room.commits.truncate(cut_at as usize);
    once.room.current = hub.group_info_at(&room, cut_at).unwrap().clone();
    once.anchor = once.room.current.clone();
    once.rows.retain(|row| {
        let row = SealedKey::from_bytes(row).unwrap();
        !(row.context.group == room && row.context.epoch > cut_at)
    });
    once.sessions.clear();
    let checked = check(&once).unwrap();
    assert_eq!(
        (checked.anchor.epoch, checked.observer.epoch()),
        (cut_at, Ok(cut_at))
    );

    // --- a row without mac ---
    // The newest room row stripped of its mac: the anchor is the epoch before, the walk goes on to the
    // current state all the same, and that epoch's key is taken unconfirmed.
    let strip = |row: &Vec<u8>| {
        let mut row = SealedKey::from_bytes(row).unwrap();
        row.mac = None;
        row.to_bytes().unwrap()
    };
    let is_row = |row: &Vec<u8>, group: &GroupId, epoch: u64| {
        let row = SealedKey::from_bytes(row).unwrap();
        row.context.group == *group && row.context.epoch == epoch
    };
    let mut stripped = honest.clone();
    for row in stripped.rows.iter_mut() {
        if is_row(row, &room, last[0]) || is_row(row, &main, 3) {
            *row = strip(row);
        }
    }
    stripped.anchor = hub.group_info_at(&room, last[0] - 1).unwrap().clone();
    let checked = check(&stripped).unwrap();
    assert_eq!(checked.anchor.epoch, last[0] - 1);
    assert_eq!(checked.observer.epoch(), Ok(last[0]));
    let unconfirmed: Vec<(GroupId, u64)> = checked
        .keys
        .iter()
        .filter(|key| !key.confirmed && key.group != side)
        .map(|key| (key.group, key.epoch))
        .collect();
    assert_eq!(unconfirmed, [(room, last[0]), (main, 3)]);
    assert_eq!(checked.keys.len(), held.len());
    // Every room row stripped: nothing anchors the room.
    let mut bare = honest.clone();
    for row in bare.rows.iter_mut() {
        if SealedKey::from_bytes(row).unwrap().context.group == room {
            *row = strip(row);
        }
    }
    assert_eq!(check(&bare).err(), Some(Error::WrongRecovery));

    // --- a swapped row ---
    // The sealed keys of two epochs exchanged between their rows: neither mac verifies, neither is taken,
    // and no key lands under another epoch.
    let mut swapped = honest.clone();
    let at = |epoch: u64| {
        honest
            .rows
            .iter()
            .position(|row| is_row(row, &main, epoch))
            .unwrap()
    };
    let (first, second) = (at(4), at(5));
    let mut one = SealedKey::from_bytes(&honest.rows[first]).unwrap();
    let mut two = SealedKey::from_bytes(&honest.rows[second]).unwrap();
    std::mem::swap(&mut one.sealed, &mut two.sealed);
    swapped.rows[first] = one.to_bytes().unwrap();
    swapped.rows[second] = two.to_bytes().unwrap();
    let checked = check(&swapped).unwrap();
    assert_eq!(checked.keys.len(), held.len() - 2);
    assert!(!checked
        .keys
        .iter()
        .any(|key| key.group == main && (key.epoch == 4 || key.epoch == 5)));
    for key in &checked.keys {
        let real = held
            .iter()
            .find(|(g, e, _)| (*g, *e) == (key.group, key.epoch));
        assert_eq!(&key.key, &real.unwrap().2);
    }
    // The same without their macs: the context is part of the sealing, they do not open.
    swapped.rows[first] = strip(&swapped.rows[first]);
    swapped.rows[second] = strip(&swapped.rows[second]);
    assert_eq!(check(&swapped).unwrap().keys.len(), held.len() - 2);
    // A row of the room group served twice with two GroupInfos cannot be made without recovery_mac; with
    // it, it is an equivocation (the thief's test below).

    // Nothing of all this reached the device or the hub.
    assert!(device.outbox().is_empty() && device.room().is_none() && !hub.recovery_runs());

    // --- the recovery ---
    hub.open_recovery(&device.id()).unwrap();
    // From now on the room takes nothing else.
    agent
        .add_to_session(
            &side,
            &new_device().id(),
            &new_device().key_package(now()).unwrap(),
            now(),
        )
        .unwrap_err();
    let fetched = fetch(&hub, &keys);
    assert_eq!(fetched, honest);
    let (code_2, built) = recover(&mut hub, &mut device, &keys, &fetched).unwrap();
    drop(keys);
    assert_eq!(built.missing_link, None);
    // The joins of three groups, the room Commit, the clean-up of both sessions, the finish.
    let kinds: Vec<OutboxKind> = device.outbox().iter().map(|entry| entry.kind).collect();
    assert_eq!(kinds.len(), 7);
    assert!(kinds[..6]
        .iter()
        .all(|kind| *kind == OutboxKind::RecoveryCommit));
    assert_eq!(kinds[6], OutboxKind::RecoveryFinish);
    // The device's real state is untouched until the hub publishes.
    assert!(device.groups().unwrap().is_empty() && !device.is_human());
    let change_before = hub.change();
    for (at, entry) in device.outbox().into_iter().enumerate() {
        // Every other reader sees the state from before while the recovery runs.
        assert!(hub.log_after(change_before).is_empty());
        let answer = hub.post(&device.id(), &entry).unwrap();
        device.outbox_accepted(entry.id, answer).unwrap();
        assert_eq!(device.is_human(), at == 6);
    }
    assert!(!hub.recovery_runs());
    assert_eq!(hub.log_after(change_before).len(), 6);

    // The new device is the room's only human device, in every group, with every key that ever was.
    let summary = device.group(&room).unwrap();
    assert_eq!(summary.leaves, [device.id()].into_iter().collect());
    assert_eq!(summary.epoch, last[0] + 2);
    assert_eq!(
        device.group(&main).unwrap().leaves,
        [device.id(), agent.id()].into_iter().collect()
    );
    let in_side = device.group(&side).unwrap();
    assert!(in_side.leaves.contains(&agent.id()) && in_side.leaves.contains(&helper.id()));
    assert!(!in_side.leaves.contains(&lost_a) && !in_side.leaves.contains(&lost_b));
    for group in groups {
        assert!(device.group(&group).unwrap().disallowed.is_empty());
        assert!(hub.stale_leaves(&group).unwrap().is_empty());
        assert_eq!(
            device.group(&group).unwrap().epoch,
            hub.epoch(&group).unwrap()
        );
    }
    for (group, epoch, key) in &held {
        assert_eq!(
            &device.content_key(group, *epoch).unwrap(),
            key,
            "{group} {epoch}"
        );
    }
    // The rows a human device wrote are confirmed; those that only the opener sealed are not.
    assert!(held
        .iter()
        .filter(|(group, _, _)| *group != side)
        .all(|(group, epoch, _)| device.key_is_confirmed(group, *epoch)));
    assert!(!device.key_is_confirmed(&side, 0));
    // The code was replaced in the same act, with its link and the account's copies.
    let new_state = hub.history().unwrap().newest().room.clone();
    let keys_2 = RecoveryKeys::from_code(code_2).unwrap();
    assert_eq!(keys_2.check_room(&new_state), Ok(()));
    assert_ne!(new_state.recovery_hpke_key, state.recovery_hpke_key);
    assert_eq!(hub.links.len(), 1);
    assert_eq!(hub.account, b"sealed copies");
    assert!(device.holds_recovery_mac());

    // The agent and helper devices follow all of it and work on with the new device.
    for other in [&mut agent, &mut helper] {
        settle(&hub, other);
    }
    for group in [main, side] {
        let epoch = hub.epoch(&group).unwrap();
        assert_eq!(
            agent.content_key(&group, epoch).unwrap(),
            device.content_key(&group, epoch).unwrap()
        );
    }
    assert_eq!(
        helper
            .content_key(&side, hub.epoch(&side).unwrap())
            .unwrap(),
        device
            .content_key(&side, hub.epoch(&side).unwrap())
            .unwrap()
    );
    settle(&hub, &mut device);
    assert_eq!(device.cursor(), hub.change());

    // --- more epochs under the new code, and a second human device ---
    let mut second = new_device();
    add_human(&mut hub, &mut device, &mut second);
    publish_some(&mut hub, &mut second, 0);
    for group in [main, side] {
        trommi_tests::add_to_session(&mut hub, &mut device, &mut second, &group);
    }
    for round in 0..3 {
        for group in groups {
            for other in [&mut device, &mut second, &mut agent, &mut helper] {
                settle(&hub, other);
            }
            let writer = if round % 2 == 0 {
                &mut device
            } else {
                &mut second
            };
            writer.update(&group, true, now()).unwrap().unwrap();
            post_ok(&mut hub, writer);
        }
    }
    for other in [&mut device, &mut second, &mut agent, &mut helper] {
        settle(&hub, other);
    }
    for group in groups {
        for (epoch, key) in keys_of(&hub, &device, &group) {
            if !held.iter().any(|(g, e, _)| (*g, *e) == (group, epoch)) {
                held.push((group, epoch, key));
            }
        }
    }
    let lost = [device.id(), second.id()];
    drop((device, second));

    // --- recover again, across the RecoveryLink ---
    // The first code is no code of this room any more.
    let mut again = new_device();
    let old = test_keys();
    assert_eq!(
        fetch(&hub, &old)
            .served(|served| check_room(&old, served))
            .err(),
        Some(Error::WrongRecovery)
    );
    hub.open_recovery(&again.id()).unwrap();
    let fetched = fetch(&hub, &keys_2);
    assert_eq!(fetched.links.len(), 1);
    let (code_3, built) = recover(&mut hub, &mut again, &keys_2, &fetched).unwrap();
    assert_eq!(built.missing_link, None);
    post_ok(&mut hub, &mut again);
    assert!(again.is_human() && !hub.recovery_runs());
    assert_eq!(
        again.group(&room).unwrap().leaves,
        [again.id()].into_iter().collect()
    );
    for group in groups {
        let leaves = again.group(&group).unwrap().leaves;
        assert!(!lost.iter().any(|gone| leaves.contains(gone)));
        assert!(hub.stale_leaves(&group).unwrap().is_empty());
    }
    // Everything of the first code's time was sealed to the first key: it opens across the link, confirmed.
    for (group, epoch, key) in &held {
        assert_eq!(
            &again.content_key(group, *epoch).unwrap(),
            key,
            "{group} {epoch}"
        );
    }
    assert!((0..=last[0]).all(|epoch| again.key_is_confirmed(&room, epoch)));
    assert_eq!(hub.links.len(), 2);
    let keys_3 = RecoveryKeys::from_code(code_3).unwrap();
    assert_eq!(
        keys_3.check_room(&hub.history().unwrap().newest().room),
        Ok(())
    );
    // The third code walks two links back; with one withheld, the first code's time stays closed.
    let fetched = fetch(&hub, &keys_3);
    let checked = fetched
        .served(|served| check_room(&keys_3, served))
        .unwrap();
    assert_eq!(checked.missing_link, None);
    assert!(checked.keys.len() > held.len());
    let mut withheld = fetched.clone();
    withheld.links.remove(0);
    let checked = withheld
        .served(|served| check_room(&keys_3, served))
        .unwrap();
    assert_eq!(checked.missing_link, Some(new_state.recovery_hpke_key));
    assert!(!checked
        .keys
        .iter()
        .any(|key| key.group == room && key.epoch == 0));
    for other in [&mut agent, &mut helper] {
        settle(&hub, other);
    }
    assert_eq!(
        agent.content_key(&main, hub.epoch(&main).unwrap()).unwrap(),
        again.content_key(&main, hub.epoch(&main).unwrap()).unwrap()
    );
    assert_eq!(test_code(), Secret::new([0xC0; 32]));
}

#[test]
fn a_recovery_is_all_or_nothing() {
    let mut w = world(true);
    w.write_epochs(1);
    let keys = test_keys();
    let store = MemoryStorage::new();
    let handle = store.handle();
    let mut device = new_device_on(store);
    let epochs: Vec<Option<u64>> = w.groups().iter().map(|group| w.hub.epoch(group)).collect();
    let change = w.hub.change();

    // Without an open recovery the hub takes none of its parts.
    let fetched = fetch(&w.hub, &keys);
    recover(&mut w.hub, &mut device, &keys, &fetched).unwrap();
    assert_eq!(post_refused(&mut w.hub, &mut device)[0], Error::Gone);
    // One refusal and the device drops all of it: its state is as before.
    assert!(device.outbox().is_empty() && device.room().is_none());
    assert_eq!(device.content_key(&w.room, 0), Err(Error::NoKey));

    // While a recovery runs the room is locked for everybody else; only one runs.
    w.hub.clock = 1_000;
    w.hub.open_recovery(&device.id()).unwrap();
    assert_eq!(w.hub.open_recovery(&w.a.id()), Err(Error::Overloaded));
    w.a.update(&w.room, true, now()).unwrap().unwrap();
    assert_eq!(post_refused(&mut w.hub, &mut w.a), [Error::Overloaded]);
    assert_eq!(
        w.a.post_sealed_key(&w.side, w.hub.group_info(&w.side).unwrap(), &[])
            .map(|id| id.is_some()),
        Ok(true)
    );
    assert_eq!(post_refused(&mut w.hub, &mut w.a), [Error::Overloaded]);

    // The ten minutes pass in the middle: the hub drops what was staged, and so does the device.
    let fetched = fetch(&w.hub, &keys);
    recover(&mut w.hub, &mut device, &keys, &fetched).unwrap();
    let entries = device.outbox();
    for entry in &entries[..3] {
        let answer = w.hub.post(&device.id(), entry).unwrap();
        device.outbox_accepted(entry.id, answer).unwrap();
    }
    // A crash of the device here loses nothing and adopts nothing.
    drop(device);
    let mut device = reopen(handle.reopened()).unwrap();
    assert_eq!(device.outbox().len(), entries.len() - 3);
    assert!(device.groups().unwrap().is_empty() && !device.is_human());
    w.hub.clock += RECOVERY_FOR_MS + 1;
    let refusals = post_refused(&mut w.hub, &mut device);
    assert_eq!(refusals, [Error::Gone]);
    assert!(device.outbox().is_empty() && device.room().is_none());
    assert!(!w.hub.recovery_runs());
    assert_eq!(w.hub.change(), change);
    let now_epochs: Vec<Option<u64>> = w.groups().iter().map(|group| w.hub.epoch(group)).collect();
    assert_eq!(now_epochs, epochs);
    // The room is open again: the others go on as if nothing had been.
    w.a.update(&w.room, true, now()).unwrap().unwrap();
    post_ok(&mut w.hub, &mut w.a);
    w.settle_all();

    // A finish that leaves a human device in the room, or a session unjoined, publishes nothing: here the
    // device is handed one session less than the hub holds.
    w.hub.open_recovery(&device.id()).unwrap();
    let mut fetched = fetch(&w.hub, &keys);
    fetched.sessions.pop();
    recover(&mut w.hub, &mut device, &keys, &fetched).unwrap();
    let answers = post_all(&mut w.hub, &mut device);
    assert_eq!(answers.last().unwrap(), &Err(Error::Incomplete));
    assert!(device.outbox().is_empty() && device.room().is_none() && !w.hub.recovery_runs());
    assert_eq!(w.hub.history().unwrap().newest().humans.len(), 2);
    w.b.update(&w.side, true, now()).unwrap().unwrap();
    post_ok(&mut w.hub, &mut w.b);
    w.settle_all();

    // And then the recovery that goes through. The lost devices learn of their removal from the log.
    w.hub.open_recovery(&device.id()).unwrap();
    let fetched = fetch(&w.hub, &keys);
    recover(&mut w.hub, &mut device, &keys, &fetched).unwrap();
    post_ok(&mut w.hub, &mut device);
    assert!(device.is_human());
    for removed in [&mut w.a, &mut w.b] {
        sync(&w.hub, removed);
        assert_eq!(removed.group(&w.room).err(), Some(Error::NotFound));
    }
    // What a removed device read, it keeps.
    assert!(w.a.content_key(&w.room, 0).is_ok());
}

#[test]
fn a_recovery_cleans_a_session_that_an_interrupted_removal_left_stale() {
    // The second human device was removed from the room, and the remover was lost before it finished: both
    // session groups still hold the removed device's leaf. Then the agent was taken out of the room's list
    // too, and nobody took its session over.
    let mut w = world(true);
    w.write_epochs(1);
    w.a.remove_human_devices(&[Cut::none(w.b.id())], now())
        .unwrap();
    post_ok(&mut w.hub, &mut w.a);
    w.a.change_agents(&[], &[w.agent.id()], now()).unwrap();
    post_ok(&mut w.hub, &mut w.a);
    assert_eq!(w.hub.stale_leaves(&w.main).unwrap().len(), 2);
    assert!(!w.hub.stale_leaves(&w.side).unwrap().is_empty());
    let (gone_b, gone_agent) = (w.b.id(), w.agent.id());

    // A device that signs in joins a stale group all the same: the leaves stay for that one Commit.
    let keys = test_keys();
    let mut c = new_device();
    sign_in(&mut w.hub, &mut c);
    assert_eq!(c.group(&w.main).unwrap().disallowed.len(), 2);
    assert_eq!(c.update(&w.main, true, now()), Err(Error::StaleSession));
    drop(c);

    // The recovery removes, with the other human devices, the revoked agent leaf and the outdated opener
    // leaf, each with its Cut.
    let mut device = new_device();
    w.hub.open_recovery(&device.id()).unwrap();
    let fetched = fetch(&w.hub, &keys);
    let planned =
        fetched.served(|served| recovery::removals(&check_room(&keys, served).unwrap()).unwrap());
    let of = |group: &GroupId| -> Vec<DeviceId> {
        planned
            .iter()
            .find(|(planned, _)| planned == group)
            .map(|(_, gone)| gone.clone())
            .unwrap()
    };
    assert!(of(&w.main).contains(&gone_b) && of(&w.main).contains(&gone_agent));
    assert!(of(&w.side).contains(&gone_b) && of(&w.side).contains(&gone_agent));
    assert!(!of(&w.side).contains(&w.helper.id()));
    assert!(!of(&w.room).contains(&gone_b));

    // A Cut that the caller did not verify is missing: nothing is built.
    let room_id = w.room.room_id();
    let replacement = fetched.served(|served| {
        let checked = check_room(&keys, served).unwrap();
        keys.replace(
            &mut SystemEntropy,
            &room_id,
            checked.observer.history().unwrap(),
        )
        .unwrap()
    });
    assert_eq!(
        fetched
            .served(|served| device.recover(&keys, served, &replacement, &[], b"", now()))
            .err(),
        Some(Error::Incomplete)
    );
    assert!(device.outbox().is_empty() && device.room().is_none());

    recover(&mut w.hub, &mut device, &keys, &fetched).unwrap();
    // The Cuts stand in the notes of the Commits that remove.
    post_ok(&mut w.hub, &mut device);
    assert!(device.is_human() && !w.hub.recovery_runs());
    assert_eq!(
        device.group(&w.main).unwrap().leaves,
        [device.id()].into_iter().collect()
    );
    let leaves = device.group(&w.side).unwrap().leaves;
    assert_eq!(leaves.len(), 3);
    assert!(leaves.contains(&w.helper.id()) && !leaves.contains(&gone_agent));
    for group in w.groups() {
        assert!(w.hub.stale_leaves(&group).unwrap().is_empty());
    }
    // The main session waits for a takeover; its helper session waits with it.
    settle(&w.hub, &mut w.helper);
    assert_eq!(
        w.helper
            .content_key(&w.side, w.hub.epoch(&w.side).unwrap())
            .unwrap(),
        device
            .content_key(&w.side, w.hub.epoch(&w.side).unwrap())
            .unwrap()
    );
}

// ---- section 17: a thief of recovery_mac ----

#[test]
fn what_a_thief_of_recovery_mac_can_and_cannot_do() {
    // recovery_mac lies on every human device and outlives a removal. Whoever copied it can, together with a
    // hostile hub, forge sealed rows until the code is replaced.
    let mut w = world(true);
    w.write_epochs(1);
    let keys = test_keys();
    let stolen = keys.mac_key().key;
    let state = w.hub.history().unwrap().newest().room.clone();
    let honest = fetch(&w.hub, &keys);
    let check = |fetched: &Fetched| fetched.served(|served| check_room(&keys, served));
    let (in_force, writer) = (w.hub.history().unwrap().newest().epoch, w.b.id());
    let forge = |group: GroupId, epoch: u64, info: &[u8], key: u8| {
        SealedKey::seal(
            &mut SystemEntropy,
            &Sealing {
                context: KeyContext::of(&group, epoch, info).unwrap(),
                room_epoch: in_force,
                recovery_hpke_key: &state.recovery_hpke_key,
                writer,
                content_key: &Secret::new([key; 32]),
            },
            Some(&stolen),
        )
        .unwrap()
        .to_bytes()
        .unwrap()
    };
    let room_epoch = w.hub.epoch(&w.room).unwrap();

    // It cannot join: the join needs the recovery signature, which follows from the code alone.
    let thief = Forger::new();
    let entry = thiefs_join(&w.hub, &newest(&w.a), &thief, &w.room, |join, commit| {
        signed_with(&thief.key, join, commit)
    });
    assert_eq!(w.hub.post(&thief.id(), &entry), Err(Error::BadSignature));
    // It cannot open a row: recovery_mac is no decryption key.
    // It cannot hand a device with the code a room of its own making that the device would join: an
    // authenticated row for a GroupInfo of its own anchors there, but the walk from the founding never
    // stands in that state.
    let founder = Forger::new();
    let fake = founder.found_room(&w.room, &state);
    let fake_info = founder.group_info(&fake);
    let mut own = honest.clone();
    own.rows.push(forge(w.room, room_epoch + 5, &fake_info, 1));
    own.anchor = fake_info.clone();
    own.room.current = fake_info.clone();
    assert_eq!(check(&own).err(), Some(Error::WrongRecovery));
    // What it can do with the hub: stand a second authenticated GroupInfo beside the real anchor, or a
    // second authenticated key beside a real one. The device names the equivocation and takes neither.
    let mut second = honest.clone();
    second.rows.push(forge(w.room, room_epoch, &fake_info, 1));
    assert_eq!(check(&second).err(), Some(Error::Equivocation));
    let mut poisoned = honest.clone();
    let info = w.hub.group_info(&w.main).unwrap().clone();
    poisoned
        .rows
        .push(forge(w.main, w.hub.epoch(&w.main).unwrap(), &info, 2));
    assert_eq!(check(&poisoned).err(), Some(Error::Equivocation));
    // And, where the hub withholds the real row, pass a key of its own as confirmed. It opens nothing:
    // content is signed, and a wrong key decrypts no envelope.
    let mut replaced = honest.clone();
    let epoch = w.hub.epoch(&w.main).unwrap();
    replaced.rows.retain(|row| {
        let row = SealedKey::from_bytes(row).unwrap();
        !(row.context.group == w.main && row.context.epoch == epoch)
    });
    replaced.rows.push(forge(w.main, epoch, &info, 2));
    let checked = check(&replaced).unwrap();
    let passed = checked
        .keys
        .iter()
        .find(|key| key.group == w.main && key.epoch == epoch)
        .unwrap();
    assert!(passed.confirmed && passed.key == Secret::new([2; 32]));

    // The replacement of the code ends it: rows under the old recovery_mac count for nothing that began
    // after it.
    let replacement = keys
        .replace(
            &mut SystemEntropy,
            &w.room.room_id(),
            w.a.room_history().unwrap(),
        )
        .unwrap();
    let new = RecoveryKeys::from_code(replacement.code.duplicate()).unwrap();
    w.a.replace_code(&keys, &replacement, b"", now()).unwrap();
    post_ok(&mut w.hub, &mut w.a);
    w.settle_all();
    w.a.update(&w.main, true, now()).unwrap().unwrap();
    post_ok(&mut w.hub, &mut w.a);
    w.settle_all();
    let after = fetch(&w.hub, &new);
    let later = w.hub.epoch(&w.main).unwrap();
    let later_info = w.hub.group_info(&w.main).unwrap().clone();
    let mut late = after.clone();
    late.rows.push(forge(w.main, later, &later_info, 3));
    late.rows
        .push(forge(w.room, w.hub.epoch(&w.room).unwrap(), &fake_info, 3));
    let checked = late.served(|served| check_room(&new, served)).unwrap();
    let real = checked
        .keys
        .iter()
        .find(|key| key.group == w.main && key.epoch == later)
        .unwrap();
    assert_eq!(real.key, w.a.content_key(&w.main, later).unwrap());
    assert!(real.confirmed);
    assert_eq!(checked.anchor.epoch, w.hub.epoch(&w.room).unwrap());
}
