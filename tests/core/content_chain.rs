//! Envelope chains (section 9.0): the receiver's nine checks in their order, Cuts, void records, provisional
//! envelopes and `heads`, against a room written by hand.

use serde_json::json;
use trommi_core::chain::*;
use trommi_core::codec::{self, Writer};
use trommi_core::crypto::{Entropy, Secret};
use trommi_core::envelope::{
    self, Body, Content, Draft, Envelope, ObjectType, Slot, Subject, Urgency,
};
use trommi_core::ids::{BoardId, DeviceId, GroupId, Hash32, RegisterId, RoomId, SessionId};
use trommi_core::objects::Objects;
use trommi_core::Error;
use trommi_tests::room::*;
use trommi_tests::seal;

fn chat(text: &str) -> Draft {
    Draft::session_chat(SESSION, device(3), &payload(text))
}

fn agent_chat(text: &str) -> Draft {
    Draft::session_chat(SESSION, DeviceId::ZERO, &payload(text))
}

fn stroke() -> Draft {
    Draft::board_item(BoardId::ALL_DESKS, &payload("stroke"))
}

fn card() -> Draft {
    Draft::first_version(
        ObjectType::Card,
        Urgency::Normal,
        &version_payload(&Hash32::ZERO, json!({ "title": "?" })),
    )
    .unwrap()
}

fn taken(receipt: &Receipt) -> &Result<Body, Error> {
    match &receipt.outcome() {
        Outcome::Taken { body, .. } => body,
        other => panic!("not taken: {other:?}"),
    }
}

#[test]
fn a_chain_of_three_is_accepted_in_order() {
    let mut world = World::new();
    let mut prev = Hash32::ZERO;
    for (seq, text) in [(1, "one"), (2, "two"), (3, "three")] {
        let receipt = world.post(2, session(), &chat(text));
        assert_eq!(receipt.envelope().header.seq, seq);
        assert_eq!(receipt.envelope().header.prev, prev);
        assert_eq!(
            *receipt.advance(),
            Advance {
                sender: device(2),
                prev: Head {
                    seq: seq - 1,
                    hash: prev
                },
                head: Head {
                    seq,
                    hash: receipt.hash()
                },
                epoch: 0,
                revision: seq - 1
            }
        );
        assert_eq!(taken(&receipt).as_ref().unwrap().payload(), payload(text));
        prev = receipt.hash();
    }
    let chains = world.chains(&session());
    assert_eq!(chains.head(&device(2)), Head { seq: 3, hash: prev });
    assert_eq!(chains.head(&device(3)), Head::START);
    assert_eq!(chains.count(0), 3);
    // Chains of different senders and groups do not touch.
    world.post(3, session(), &agent_chat("hi"));
    world.post(2, room(), &stroke());
    assert_eq!(world.chains(&session()).head(&device(3)).seq, 1);
    assert_eq!(world.chains(&session()).head(&device(2)).seq, 3);
    assert_eq!(world.chains(&room()).head(&device(2)).seq, 1);
}

#[test]
fn check_1_refuses_bad_encodings_and_other_rooms() {
    let mut world = World::new();
    let sealed = world.sign(2, session(), &chat("x"));
    let bytes = sealed.envelope.encode().unwrap();
    let take = |world: &mut World, bytes: &[u8]| {
        world
            .take_as(bytes, &Served::Stored, Mode::InOrder)
            .map(|_| ())
    };

    assert_eq!(
        take(&mut world, &bytes[..bytes.len() - 1]),
        Err(Error::BadFormat)
    );
    let mut flags = bytes.clone();
    flags[3] = 2;
    assert_eq!(take(&mut world, &flags), Err(Error::BadFormat));
    let mut newer = bytes.clone();
    newer[1] = 3;
    assert_eq!(take(&mut world, &newer), Err(Error::NewerVersion));
    assert_eq!(
        take(&mut world, &vec![0; envelope::MAX_ENVELOPE_LEN + 1]),
        Err(Error::TooLarge)
    );

    let other_room = GroupId::session(RoomId::new([9; 32]), SESSION);
    world
        .fake
        .add_group(other_room, &[(device(2), Role::Human)]);
    let foreign = world.sign(2, other_room, &chat("x"));
    assert_eq!(
        take(&mut world, &foreign.envelope.encode().unwrap()),
        Err(Error::WrongRoom)
    );
    // Nothing was consumed.
    assert_eq!(world.chains(&session()), Chains::new());
    assert!(take(&mut world, &bytes).is_ok());
}

#[test]
fn check_2_refuses_an_epoch_or_group_not_yet_processed() {
    let mut world = World::new();
    let ahead = world.sign_in_epoch(2, session(), 1, &chat("x"));
    assert_eq!(world.take(&ahead.envelope).err(), Some(Error::GroupBehind));
    let unknown = GroupId::session(ROOM, SessionId::new([8; 16]));
    let mut sender = World::new();
    sender.fake.add_group(unknown, &[(device(2), Role::Human)]);
    let sealed = sender.sign(2, unknown, &chat("x"));
    assert_eq!(world.take(&sealed.envelope).err(), Some(Error::GroupBehind));
    // Once the Commit is processed the envelope is taken.
    world.fake.commit(&session(), NOW, NOW, |_| {});
    assert!(world.take(&ahead.envelope).is_ok());
}

#[test]
fn check_3_refuses_a_sender_that_was_no_leaf_in_the_epoch() {
    let mut world = World::new();
    // Device 5 is a leaf of nothing.
    let sealed = world.sign(5, session(), &agent_chat("x"));
    assert_eq!(world.take(&sealed.envelope).err(), Some(Error::NotMember));
    // The agent is no leaf of the room group.
    let sealed = world.sign(3, room(), &stroke());
    assert_eq!(world.take(&sealed.envelope).err(), Some(Error::NotMember));
    // Device 5 joins in epoch 1: its envelope naming epoch 0 is still refused.
    world.fake.commit(&session(), NOW, NOW, |leaves| {
        leaves.insert(device(5), Role::Human);
    });
    let early = world.sign_in_epoch(5, session(), 0, &chat("x"));
    assert_eq!(world.take(&early.envelope).err(), Some(Error::NotMember));
    assert_eq!(world.chains(&session()), Chains::new());
}

#[test]
fn check_4_ends_a_removed_senders_chain_at_its_cut() {
    let mut world = World::new();
    let first = world.post(2, session(), &chat("one"));
    let second = world.sign(2, session(), &chat("two"));
    let third = world.sign(2, session(), &chat("three"));
    // The remover had accepted number 2. This receiver holds number 1.
    world.fake.commit(&session(), NOW, NOW, |leaves| {
        leaves.remove(&device(2));
    });
    let cut = Head {
        seq: 2,
        hash: second.hash,
    };
    world.fake.group(&session()).cuts.insert(device(2), cut);
    let effect = cut_chain(
        &world.fake,
        &world.chains(&session()),
        &session(),
        &device(2),
        &cut,
    )
    .unwrap();
    assert_eq!(
        (effect.head, effect.drop_from, effect.finding),
        (None, None, None)
    );

    // Beyond the Cut: refused, in whatever order it comes.
    assert_eq!(
        world.take(&third.envelope).err(),
        Some(Error::RemovedSender)
    );
    // Up to the Cut the chain is still read.
    let receipt = world
        .take_as(
            &second.envelope.encode().unwrap(),
            &Served::Stored,
            Mode::ReadingBack,
        )
        .unwrap();
    assert_eq!(receipt.advance().head, cut);
    assert_eq!(
        world.take(&third.envelope).err(),
        Some(Error::RemovedSender)
    );
    assert_eq!(world.chains(&session()).head(&device(2)), cut);
    assert_ne!(first.hash(), second.hash);
}

#[test]
fn check_4_finds_another_envelope_at_the_cut() {
    let mut world = World::new();
    world.post(2, session(), &chat("one"));
    // The sender signs two envelopes under number 2: the remover saw one, this receiver is served the other.
    let seen_by_remover = world.sign(2, session(), &chat("two"));
    world
        .own
        .insert((session(), 2), world.chains(&session()).head(&device(2)));
    let served_here = world.sign(2, session(), &chat("two, again"));
    world.fake.commit(&session(), NOW, NOW, |leaves| {
        leaves.remove(&device(2));
    });
    world.fake.group(&session()).cuts.insert(
        device(2),
        Head {
            seq: 2,
            hash: seen_by_remover.hash,
        },
    );
    assert_eq!(
        world
            .take_as(
                &served_here.envelope.encode().unwrap(),
                &Served::Stored,
                Mode::ReadingBack
            )
            .err(),
        Some(Error::Equivocation)
    );
    // A Cut of nothing refuses everything.
    let mut world = World::new();
    let sealed = world.sign(2, session(), &chat("one"));
    world
        .fake
        .group(&session())
        .cuts
        .insert(device(2), Head::START);
    assert_eq!(
        world.take(&sealed.envelope).err(),
        Some(Error::RemovedSender)
    );
}

#[test]
fn check_5_refuses_a_wrong_signature_before_the_chain_moves() {
    let mut world = World::new();
    let sealed = world.sign(2, session(), &chat("x"));
    let mut forged = sealed.envelope.clone();
    forged.signature[10] ^= 1;
    assert_eq!(world.take(&forged).err(), Some(Error::BadSignature));
    // Signed by another leaf than the header names.
    let mut renamed = sealed.envelope.clone();
    renamed.header.sender = device(1);
    assert_eq!(world.take(&renamed).err(), Some(Error::BadSignature));
    // A header changed after signing.
    let mut moved = sealed.envelope.clone();
    moved.header.time += 1;
    assert_eq!(world.take(&moved).err(), Some(Error::BadSignature));
    assert_eq!(world.chains(&session()), Chains::new());
    assert!(world.take(&sealed.envelope).is_ok());
}

#[test]
fn check_6_tells_replay_equivocation_gap_and_chain_break() {
    let mut world = World::new();
    let one = world.sign(2, session(), &chat("one"));
    let two = world.sign(2, session(), &chat("two"));
    let three = world.sign(2, session(), &chat("three"));

    // A gap: number 2 before number 1.
    assert_eq!(world.take(&two.envelope).err(), Some(Error::Gap));
    assert_eq!(world.take(&three.envelope).err(), Some(Error::Gap));
    world.take(&one.envelope).unwrap();
    assert_eq!(world.take(&three.envelope).err(), Some(Error::Gap));
    // A replay of the last and of an earlier one.
    assert_eq!(world.take(&one.envelope).err(), Some(Error::Replay));
    world.take(&two.envelope).unwrap();
    assert_eq!(world.take(&one.envelope).err(), Some(Error::Replay));
    assert_eq!(world.take(&two.envelope).err(), Some(Error::Replay));

    // A second envelope under number 2, and one under number 1.
    let slot = |seq, prev| Slot {
        group: session(),
        epoch: 0,
        sender: device(2),
        seq,
        prev,
        time: NOW,
    };
    let mut forge = |slot: Slot| {
        seal::seal_at(
            &chat("other"),
            &slot,
            &key(0),
            &signer(2),
            &mut world.entropy,
        )
        .unwrap()
        .envelope
    };
    let second_two = forge(slot(2, one.hash));
    let second_one = forge(slot(1, Hash32::ZERO));
    // The right number with a `prev` that is not the last accepted hash.
    let broken_three = forge(slot(3, one.hash));
    assert_eq!(world.take(&second_two).err(), Some(Error::Equivocation));
    assert_eq!(world.take(&second_one).err(), Some(Error::Equivocation));
    assert_eq!(world.take(&broken_three).err(), Some(Error::ChainBreak));
    // Without a record of number 1 the receiver cannot tell, and takes it for a replay.
    world.fake.accepted.remove(&(session(), device(2), 1));
    assert_eq!(world.take(&second_one).err(), Some(Error::Replay));

    // None of this moved the chain.
    assert_eq!(
        world.chains(&session()).head(&device(2)),
        Head {
            seq: 2,
            hash: two.hash
        }
    );
    world.take(&three.envelope).unwrap();
}

#[test]
fn check_7_chains_a_forbidden_envelope_and_applies_nothing() {
    let mut world = World::new();
    // A human device may not create a card.
    let sealed = world.sign(2, session(), &card());
    let receipt = world.take(&sealed.envelope).unwrap();
    assert_eq!(*receipt.outcome(), Outcome::Refused(Error::Forbidden));
    assert!(receipt.opened().is_none());
    assert_eq!(world.objects(&session()), Objects::new());
    // The chain has advanced: the sender's next envelope links to the refused one.
    let next = world.post(2, session(), &chat("next"));
    assert_eq!(next.envelope().header.prev, receipt.hash());
    assert_eq!(next.envelope().header.seq, 2);
    assert_eq!(world.chains(&session()).count(0), 2);
}

#[test]
fn check_8_live_gives_an_old_epoch_two_minutes() {
    let mut world = World::new();
    let early = world.sign(2, session(), &chat("written before the Commit"));
    let late = world.sign(2, session(), &chat("too late"));
    world.fake.commit(&session(), NOW, NOW, |_| {});

    world.now = NOW + LIVE_GRACE_MS;
    assert!(taken(&world.take(&early.envelope).unwrap()).is_ok());
    world.now = NOW + LIVE_GRACE_MS + 1;
    let receipt = world.take(&late.envelope).unwrap();
    assert_eq!(*receipt.outcome(), Outcome::Refused(Error::WrongEpoch));
    // Chained all the same.
    assert_eq!(world.chains(&session()).head(&device(2)).seq, 2);
    // An envelope of the current epoch is fresh at any time, and a clock that ran backwards harms nothing.
    world.now = NOW + 10 * LIVE_GRACE_MS;
    assert!(taken(&world.post(2, session(), &chat("now"))).is_ok());
    let old = world.sign_in_epoch(1, session(), 0, &chat("old"));
    world.now = NOW - 5;
    assert!(taken(&world.take(&old.envelope).unwrap()).is_ok());
}

#[test]
fn check_8_reading_back_compares_the_times_of_envelope_and_commit() {
    let mut world = World::new();
    let commit_time = NOW + 1000;
    world.now = commit_time + READ_BACK_GRACE_MS;
    let in_time = world.sign(2, session(), &chat("in time"));
    world.now += 1;
    let late = world.sign(2, session(), &chat("late"));
    // The Commit was processed long ago: reading back does not ask for that.
    world.fake.commit(&session(), NOW, commit_time, |_| {});
    world.now = NOW + 365 * 24 * 3600 * 1000;

    let back = |world: &mut World, envelope: &Envelope| {
        world
            .take_as(
                &envelope.encode().unwrap(),
                &Served::Stored,
                Mode::ReadingBack,
            )
            .unwrap()
    };
    assert!(taken(&back(&mut world, &in_time.envelope)).is_ok());
    assert_eq!(
        *back(&mut world, &late.envelope).outcome(),
        Outcome::Refused(Error::WrongEpoch)
    );
    // The same early envelope, read live a year later, is refused.
    let mut live = World::new();
    live.now = commit_time;
    let sealed = live.sign(2, session(), &chat("in time"));
    live.fake.commit(&session(), NOW, commit_time, |_| {});
    live.now = NOW + 365 * 24 * 3600 * 1000;
    assert_eq!(
        *live.take(&sealed.envelope).unwrap().outcome(),
        Outcome::Refused(Error::WrongEpoch)
    );
}

#[test]
fn check_9_gives_each_body_failure_its_code_and_still_counts_the_header() {
    let mut world = World::new();
    // No key for the epoch.
    world.fake.group(&session()).epochs[0].no_key = true;
    let sealed = world.sign(3, session(), &card());
    let receipt = world.take(&sealed.envelope).unwrap();
    let Outcome::Taken { transition, body } = &receipt.outcome() else {
        panic!("taken");
    };
    assert_eq!(body, &Err(Error::NoKey));
    // The object exists all the same: its state follows the headers.
    assert!(transition.is_some());
    assert!(receipt.opened().is_none());
    assert_eq!(world.objects(&session()).iter().count(), 1);
    world.fake.group(&session()).epochs[0].no_key = false;

    // A pruned envelope carries the chain.
    let sealed = world.sign(3, session(), &agent_chat("pruned"));
    let pruned = sealed.envelope.prune().unwrap();
    let receipt = world.take(&pruned).unwrap();
    assert_eq!(taken(&receipt), &Err(Error::Pruned));
    assert_eq!(receipt.hash(), sealed.hash);

    // A body sealed under another key.
    let slot = world.slot(3, session(), 0);
    let wrong_key = seal::seal_at(
        &agent_chat("x"),
        &slot,
        &Secret::new([9; 32]),
        &signer(3),
        &mut world.entropy,
    )
    .unwrap();
    let receipt = world.take(&wrong_key.envelope).unwrap();
    assert_eq!(taken(&receipt), &Err(Error::DecryptFailed));
    assert_eq!(world.chains(&session()).head(&device(3)).seq, 3);
}

#[test]
fn a_reserved_kind_is_verified_and_chained_and_nothing_else() {
    let mut world = World::new();
    let one = world.post(2, session(), &chat("one"));
    let mut envelope = world.forge(2, session(), &chat("two"), |header| {
        header.subject = Subject::Reserved {
            kind: 9,
            block: [0xEE; envelope::OBJECT_BLOCK_LEN],
        };
    });
    let receipt = world.take(&envelope).unwrap();
    assert_eq!(*receipt.outcome(), Outcome::Reserved);
    assert_eq!(receipt.envelope().header.prev, one.hash());
    assert_eq!(world.chains(&session()).head(&device(2)).seq, 2);
    // With a wrong signature it is refused like any other.
    let mut forged = envelope.clone();
    forged.header.seq = 3;
    assert_eq!(world.take(&forged).err(), Some(Error::BadSignature));
    // The hub takes none.
    let mut hub = World::new();
    hub.fake.hub = true;
    envelope.header.seq = 1;
    assert_eq!(
        hub_take(
            &hub.fake,
            &hub.fake,
            &Chains::new(),
            &Objects::new(),
            &device(2),
            &envelope.encode().unwrap(),
            NOW
        )
        .err(),
        Some(Error::BadFormat)
    );
    // Nor is one shown before its chain arrives.
    assert_eq!(
        provisional(
            &world.fake,
            &world.fake,
            &world.chains(&session()),
            &receipt.envelope().encode().unwrap(),
            NOW
        )
        .err(),
        Some(Error::NewerVersion)
    );
}

fn void(world: &mut World, envelope: &Envelope, code: Error, mode: Mode) -> Outcome {
    world
        .take_as(
            &envelope.prune().unwrap().encode().unwrap(),
            &Served::Void(code),
            mode,
        )
        .unwrap()
        .outcome()
        .clone()
}

#[test]
fn a_void_record_is_chained_and_never_applied() {
    let mut world = World::new();
    // The hub voided a card that a human device tried to create: the receiver finds the same.
    let forbidden = world.sign(2, session(), &card());
    assert_eq!(
        void(
            &mut world,
            &forbidden.envelope,
            Error::Forbidden,
            Mode::InOrder
        ),
        Outcome::Void {
            code: Error::Forbidden,
            finding: None
        }
    );
    assert_eq!(world.objects(&session()), Objects::new());
    assert_eq!(world.chains(&session()).head(&device(2)).seq, 1);
    assert_eq!(world.chains(&session()).count(0), 1);
    // The next envelope links to the void record.
    let next = world.post(2, session(), &chat("next"));
    assert_eq!(next.envelope().header.prev, forbidden.hash);

    // A void record still has to pass checks 1 to 6.
    let again = world.sign(2, session(), &chat("x"));
    let mut forged = again.envelope.prune().unwrap();
    forged.signature[0] ^= 1;
    assert_eq!(
        world
            .take_as(
                &forged.encode().unwrap(),
                &Served::Void(Error::Forbidden),
                Mode::InOrder
            )
            .err(),
        Some(Error::BadSignature)
    );
}

#[test]
fn a_void_of_another_sender_that_cannot_be_checked_again_is_a_finding() {
    let finding = Some(Error::HubVoidedOther);
    let mut world = World::new();

    // `forbidden` on an envelope the receiver's own rules allow.
    let allowed = world.sign(2, session(), &chat("fine"));
    assert_eq!(
        void(
            &mut world,
            &allowed.envelope,
            Error::Forbidden,
            Mode::InOrder
        ),
        Outcome::Void {
            code: Error::Forbidden,
            finding: finding.clone()
        }
    );
    // `wrong-epoch` on an envelope of the current epoch; fine once the epoch has ended.
    let current = world.sign(2, session(), &chat("x"));
    assert_eq!(
        void(
            &mut world,
            &current.envelope,
            Error::WrongEpoch,
            Mode::InOrder
        ),
        Outcome::Void {
            code: Error::WrongEpoch,
            finding: finding.clone()
        }
    );
    let old = world.sign(2, session(), &chat("x"));
    world.fake.commit(&session(), NOW, NOW, |_| {});
    assert_eq!(
        void(&mut world, &old.envelope, Error::WrongEpoch, Mode::InOrder),
        Outcome::Void {
            code: Error::WrongEpoch,
            finding: None
        }
    );
    // `stale-session`: checked against the state of the moment, so only in the hub's order.
    let sealed = world.sign(2, session(), &chat("x"));
    assert_eq!(
        void(
            &mut world,
            &sealed.envelope,
            Error::StaleSession,
            Mode::InOrder
        ),
        Outcome::Void {
            code: Error::StaleSession,
            finding: finding.clone()
        }
    );
    world.fake.group(&session()).stale = true;
    let sealed = world.sign(2, session(), &chat("x"));
    assert_eq!(
        void(
            &mut world,
            &sealed.envelope,
            Error::StaleSession,
            Mode::InOrder
        ),
        Outcome::Void {
            code: Error::StaleSession,
            finding: None
        }
    );
    let sealed = world.sign(2, session(), &chat("x"));
    assert_eq!(
        void(
            &mut world,
            &sealed.envelope,
            Error::StaleSession,
            Mode::ReadingBack
        ),
        Outcome::Void {
            code: Error::StaleSession,
            finding: finding.clone()
        }
    );
    world.fake.group(&session()).stale = false;
    // `epoch-full` below the limit; `too-large`, which a pruned record cannot show; any other code.
    for code in [Error::EpochFull, Error::TooLarge, Error::RateLimited] {
        let sealed = world.sign(2, session(), &chat("x"));
        assert_eq!(
            void(&mut world, &sealed.envelope, code.clone(), Mode::InOrder),
            Outcome::Void {
                code,
                finding: finding.clone()
            }
        );
    }
    // `epoch-full` at the limit.
    let mut full = World::new();
    full.chains
        .insert(session(), chains_with_count(0, MAX_ENVELOPES_PER_EPOCH));
    let sealed = full.sign(2, session(), &chat("x"));
    assert_eq!(
        void(&mut full, &sealed.envelope, Error::EpochFull, Mode::InOrder),
        Outcome::Void {
            code: Error::EpochFull,
            finding: None
        }
    );

    // A code no void record may carry is a finding even on the receiver's own envelope.
    let mut own = World::new();
    own.me = device(2);
    let sealed = own.sign(2, session(), &chat("x"));
    assert_eq!(
        void(
            &mut own,
            &sealed.envelope,
            Error::BadSignature,
            Mode::InOrder
        ),
        Outcome::Void {
            code: Error::BadSignature,
            finding: finding.clone()
        }
    );
    // So is a void record that still carries its body.
    let sealed = own.sign(2, session(), &chat("x"));
    let receipt = own
        .take_as(
            &sealed.envelope.encode().unwrap(),
            &Served::Void(Error::WrongEpoch),
            Mode::InOrder,
        )
        .unwrap();
    assert_eq!(
        *receipt.outcome(),
        Outcome::Void {
            code: Error::WrongEpoch,
            finding: finding.clone()
        }
    );
    // The receiver's own voided envelope is no finding: the hub told it why.
    let mut own = World::new();
    own.me = device(2);
    let sealed = own.sign(2, session(), &chat("x"));
    assert_eq!(
        void(&mut own, &sealed.envelope, Error::TooLarge, Mode::InOrder),
        Outcome::Void {
            code: Error::TooLarge,
            finding: None
        }
    );
}

#[test]
fn a_stale_session_and_a_full_epoch_are_refused_after_the_chain() {
    let mut world = World::new();
    world.fake.group(&session()).stale = true;
    let sealed = world.sign(2, session(), &chat("x"));
    assert_eq!(
        *world.take(&sealed.envelope).unwrap().outcome(),
        Outcome::Refused(Error::StaleSession)
    );
    // Reading back, the state of the moment says nothing about then.
    let sealed = world.sign(2, session(), &chat("x"));
    let receipt = world
        .take_as(
            &sealed.envelope.encode().unwrap(),
            &Served::Stored,
            Mode::ReadingBack,
        )
        .unwrap();
    assert!(taken(&receipt).is_ok());
    world.fake.group(&session()).stale = false;

    let mut full = World::new();
    full.chains
        .insert(session(), chains_with_count(0, MAX_ENVELOPES_PER_EPOCH - 1));
    assert!(taken(&full.post(2, session(), &chat("the last one"))).is_ok());
    let sealed = full.sign(2, session(), &chat("one too many"));
    assert_eq!(
        *full.take(&sealed.envelope).unwrap().outcome(),
        Outcome::Refused(Error::EpochFull)
    );
}

#[test]
fn an_oversize_body_is_the_hubs_to_refuse_and_counts_the_same_in_both_forms_on_a_device() {
    // The agent's first card version over a sealed body of 65 553 bytes.
    let sealed = oversize(3, session(), &card());
    let Content::Full(ciphertext) = &sealed.envelope.content else {
        panic!("full form");
    };
    assert_eq!(ciphertext.len(), 65_553);
    let pruned = sealed.envelope.prune().unwrap();

    // The hub chains it and refuses it: a void record, no object.
    let mut hub = World::new();
    hub.fake.hub = true;
    let receipt = hub.hub_take(3, &sealed.envelope).unwrap();
    assert_eq!(*receipt.outcome(), Outcome::Refused(Error::TooLarge));
    assert_eq!(hub.objects(&session()), Objects::new());
    assert_eq!(hub.chains(&session()).head(&device(3)).seq, 1);

    // Served as that void record, every device chains it and applies nothing, in order and reading back; the
    // reason cannot be checked again, which is the finding.
    for mode in [Mode::InOrder, Mode::ReadingBack] {
        let mut device = World::new();
        let receipt = device
            .take_as(
                &pruned.encode().unwrap(),
                &Served::Void(Error::TooLarge),
                mode,
            )
            .unwrap();
        assert_eq!(
            *receipt.outcome(),
            Outcome::Void {
                code: Error::TooLarge,
                finding: Some(Error::HubVoidedOther)
            }
        );
        assert_eq!(device.objects(&session()), Objects::new());
        assert_eq!(device.chains(&session()), hub.chains(&session()));
    }

    // A hub that hides the marker and serves the record as stored: a device cannot tell from the pruned
    // form, which carries no length, so the full form counts the same. Both devices hold the same object;
    // neither reads a body.
    for mode in [Mode::InOrder, Mode::ReadingBack] {
        let mut with_body = World::new();
        let mut without = World::new();
        let full = with_body
            .take_as(&sealed.envelope.encode().unwrap(), &Served::Stored, mode)
            .unwrap();
        let bare = without
            .take_as(&pruned.encode().unwrap(), &Served::Stored, mode)
            .unwrap();
        let Outcome::Taken { transition, body } = full.outcome() else {
            panic!("taken: {:?}", full.outcome());
        };
        assert_eq!(body, &Err(Error::TooLarge));
        assert!(full.opened().is_none());
        let Outcome::Taken {
            transition: bare_transition,
            body: bare_body,
        } = bare.outcome()
        else {
            panic!("taken: {:?}", bare.outcome());
        };
        assert_eq!(bare_body, &Err(Error::Pruned));
        assert!(transition.is_some());
        assert_eq!(transition, bare_transition);
        assert_eq!(with_body.objects(&session()), without.objects(&session()));
        assert_eq!(with_body.objects(&session()).iter().count(), 1);
        assert_eq!(with_body.chains(&session()), without.chains(&session()));
    }

    // Out of order it is not shown: its body does not open.
    let device = World::new();
    assert_eq!(
        provisional(
            &device.fake,
            &device.fake,
            &Chains::new(),
            &sealed.envelope.encode().unwrap(),
            NOW
        )
        .err(),
        Some(Error::TooLarge)
    );
}

#[test]
fn the_hub_takes_a_new_envelope_in_full_form_only() {
    let mut hub = World::new();
    hub.fake.hub = true;
    let sealed = hub.sign(3, session(), &card());
    let pruned = sealed.envelope.prune().unwrap();
    assert_eq!(hub.hub_take(3, &pruned).err(), Some(Error::BadFormat));
    // It took no number and made no object: the full form is still the sender's first.
    assert_eq!(hub.chains(&session()), Chains::new());
    assert_eq!(hub.objects(&session()), Objects::new());
    let receipt = hub.hub_take(3, &sealed.envelope).unwrap();
    assert!(matches!(
        receipt.outcome(),
        Outcome::Taken {
            transition: Some(_),
            ..
        }
    ));
    // A device reads the same record back pruned.
    let mut device = World::new();
    assert!(device.take(&pruned).is_ok());
    assert_eq!(device.objects(&session()), hub.objects(&session()));
}

#[test]
fn the_hub_runs_the_same_checks_without_the_body() {
    let mut hub = World::new();
    hub.fake.hub = true;
    let take = |hub: &mut World, signed_in: u8, envelope: &Envelope| {
        let group = envelope.header.group;
        let receipt = hub_take(
            &hub.fake,
            &hub.fake,
            &hub.chains(&group),
            &hub.objects(&group),
            &device(signed_in),
            &envelope.encode().unwrap(),
            hub.now,
        )?;
        hub.record(&receipt);
        Ok::<_, Error>(receipt)
    };

    let sealed = hub.sign(3, session(), &card());
    // Posted by another device than the one that signed it.
    assert_eq!(
        take(&mut hub, 2, &sealed.envelope).err(),
        Some(Error::WrongSender)
    );
    let receipt = take(&mut hub, 3, &sealed.envelope).unwrap();
    let Outcome::Taken { transition, body } = &receipt.outcome() else {
        panic!("taken");
    };
    assert_eq!(body, &Err(Error::NoKey));
    assert!(transition.is_some());
    // The same bytes again take no second number.
    assert_eq!(
        take(&mut hub, 3, &sealed.envelope).err(),
        Some(Error::Replay)
    );
    // What 9.2 forbids becomes a void record.
    let forbidden = hub.sign(2, session(), &card());
    assert_eq!(
        *take(&mut hub, 2, &forbidden.envelope).unwrap().outcome(),
        Outcome::Refused(Error::Forbidden)
    );
    // Checks 1 to 6 as on a device.
    let mut forged = hub.sign(2, session(), &chat("x")).envelope;
    forged.signature[0] ^= 1;
    assert_eq!(take(&mut hub, 2, &forged).err(), Some(Error::BadSignature));

    // Freshness at the hub: the epoch before, within two minutes of the Commit's arrival, and no older one.
    let mut hub = World::new();
    hub.fake.hub = true;
    let in_time = hub.sign(2, session(), &chat("x"));
    let late = hub.sign(2, session(), &chat("x"));
    let two_back = hub.sign(2, session(), &chat("x"));
    hub.fake.commit(&session(), NOW, NOW, |_| {});
    hub.now = NOW + LIVE_GRACE_MS;
    assert!(matches!(
        take(&mut hub, 2, &in_time.envelope).unwrap().outcome(),
        Outcome::Taken { .. }
    ));
    hub.now += 1;
    assert_eq!(
        *take(&mut hub, 2, &late.envelope).unwrap().outcome(),
        Outcome::Refused(Error::WrongEpoch)
    );
    hub.fake.commit(&session(), hub.now, hub.now, |_| {});
    assert_eq!(
        *take(&mut hub, 2, &two_back.envelope).unwrap().outcome(),
        Outcome::Refused(Error::WrongEpoch)
    );
    // A device in the hub's order gives that envelope its two minutes after the newest Commit it ended in.
    hub.fake.group(&session()).stale = true;
    let sealed = hub.sign(2, session(), &chat("x"));
    assert_eq!(
        *take(&mut hub, 2, &sealed.envelope).unwrap().outcome(),
        Outcome::Refused(Error::StaleSession)
    );
}

#[test]
fn a_provisional_envelope_is_accepted_when_the_chain_reaches_it() {
    let mut world = World::new();
    let one = world.sign(2, session(), &chat("one"));
    let two = world.sign(2, session(), &chat("two"));
    let fetch = |world: &World, envelope: &Envelope| {
        provisional(
            &world.fake,
            &world.fake,
            &world.chains(&session()),
            &envelope.encode().unwrap(),
            world.now,
        )
    };
    // A page of the Chat brings number 2 before the chain has reached it.
    let page = fetch(&world, &two.envelope).unwrap();
    assert_eq!(page.standing, Standing::Provisional);
    assert_eq!(page.body.payload(), payload("two"));
    assert_eq!(world.chains(&session()), Chains::new());

    let first = world.take(&one.envelope).unwrap();
    assert_eq!(page.confirm(&first), Ok(Standing::Provisional));
    let second = world.take(&two.envelope).unwrap();
    assert_eq!(page.confirm(&second), Ok(Standing::Accepted));
    // Fetched again later, it is accepted at once.
    assert_eq!(
        fetch(&world, &two.envelope).unwrap().standing,
        Standing::Chained
    );
    assert_eq!(
        fetch(&world, &one.envelope).unwrap().standing,
        Standing::Chained
    );
    // Another sender's step says nothing about it.
    let other = world.post(3, session(), &agent_chat("x"));
    assert_eq!(page.confirm(&other), Ok(Standing::Provisional));
}

#[test]
fn a_provisional_envelope_that_the_chain_contradicts_is_a_hash_mismatch() {
    let mut world = World::new();
    let one = world.sign(2, session(), &chat("one"));
    let two = world.sign(2, session(), &chat("two"));
    // The page shows another number 2 than the chain will bring.
    let other_two = seal::seal_at(
        &chat("two, as the page had it"),
        &Slot {
            group: session(),
            epoch: 0,
            sender: device(2),
            seq: 2,
            prev: one.hash,
            time: NOW,
        },
        &key(0),
        &signer(2),
        &mut world.entropy,
    )
    .unwrap();
    let fetch = |world: &World, envelope: &Envelope| {
        provisional(
            &world.fake,
            &world.fake,
            &world.chains(&session()),
            &envelope.encode().unwrap(),
            world.now,
        )
    };
    let page = fetch(&world, &other_two.envelope).unwrap();
    world.take(&one.envelope).unwrap();
    let second = world.take(&two.envelope).unwrap();
    assert_eq!(page.confirm(&second), Err(Error::HashMismatch));
    // Fetched after the chain passed that number: the same finding, for the last number and an earlier one.
    assert_eq!(
        fetch(&world, &other_two.envelope).err(),
        Some(Error::HashMismatch)
    );
    world.post(2, session(), &chat("three"));
    assert_eq!(
        fetch(&world, &other_two.envelope).err(),
        Some(Error::HashMismatch)
    );
}

#[test]
fn a_provisional_envelope_passes_checks_1_to_5_and_7_to_9() {
    let mut world = World::new();
    let fetch = |world: &World, envelope: &Envelope| {
        provisional(
            &world.fake,
            &world.fake,
            &world.chains(&envelope.header.group),
            &envelope.encode().unwrap(),
            world.now,
        )
        .map(|p| p.standing)
    };
    let good = world.sign(2, session(), &chat("x"));
    assert_eq!(fetch(&world, &good.envelope), Ok(Standing::Provisional));

    let mut forged = good.envelope.clone();
    forged.signature[0] ^= 1;
    assert_eq!(fetch(&world, &forged), Err(Error::BadSignature));
    let stranger = world.sign(5, session(), &agent_chat("x"));
    assert_eq!(fetch(&world, &stranger.envelope), Err(Error::NotMember));
    let ahead = world.sign_in_epoch(2, session(), 1, &chat("x"));
    assert_eq!(fetch(&world, &ahead.envelope), Err(Error::GroupBehind));
    // Check 7: an agent may not write a board item, a human device may not create a card.
    let by_human = world.sign(2, session(), &card());
    assert_eq!(fetch(&world, &by_human.envelope), Err(Error::Forbidden));
    // Check 9.
    assert_eq!(
        fetch(&world, &good.envelope.prune().unwrap()),
        Err(Error::Pruned)
    );
    world.fake.group(&session()).epochs[0].no_key = true;
    assert_eq!(fetch(&world, &good.envelope), Err(Error::NoKey));
    world.fake.group(&session()).epochs[0].no_key = false;
    // Check 8, as when reading back.
    world.now = NOW + READ_BACK_GRACE_MS + 1;
    let late = world.sign(1, session(), &chat("x"));
    world.fake.commit(&session(), NOW, NOW, |_| {});
    assert_eq!(fetch(&world, &late.envelope), Err(Error::WrongEpoch));
    assert_eq!(fetch(&world, &good.envelope), Ok(Standing::Provisional));
    // A removed sender's envelope beyond its Cut.
    world
        .fake
        .group(&session())
        .cuts
        .insert(device(2), Head::START);
    assert_eq!(fetch(&world, &good.envelope), Err(Error::RemovedSender));
}

#[test]
fn a_cut_drops_what_the_receiver_had_accepted_beyond_it() {
    let mut world = World::new();
    let one = world.post(2, session(), &chat("one"));
    let two = world.post(2, session(), &chat("two"));
    let three = world.post(2, session(), &chat("three"));
    let cut_at = |world: &World, cut: Head| {
        cut_chain(
            &world.fake,
            &world.chains(&session()),
            &session(),
            &device(2),
            &cut,
        )
        .unwrap()
    };

    // The remover had accepted number 1 only.
    let cut = Head {
        seq: 1,
        hash: one.hash(),
    };
    let effect = cut_at(&world, cut);
    assert_eq!(
        effect,
        CutEffect {
            sender: device(2),
            head: Some(cut),
            drop_from: Some(2),
            finding: None
        }
    );
    // The remover had accepted everything this receiver has, or more.
    let all = Head {
        seq: 3,
        hash: three.hash(),
    };
    assert_eq!(
        (cut_at(&world, all).head, cut_at(&world, all).drop_from),
        (None, None)
    );
    let more = Head {
        seq: 9,
        hash: Hash32::new([9; 32]),
    };
    assert_eq!(cut_at(&world, more).head, None);
    // The remover had accepted nothing.
    let effect = cut_at(&world, Head::START);
    assert_eq!(
        (effect.head, effect.drop_from, effect.finding.clone()),
        (Some(Head::START), Some(1), None)
    );
    // The remover names another envelope under number 2, or under the receiver's last number.
    for seq in [2, 3] {
        let other = Head {
            seq,
            hash: Hash32::new([7; 32]),
        };
        let effect = cut_at(&world, other);
        assert_eq!(
            (effect.head, effect.drop_from, effect.finding),
            (Some(other), Some(seq), Some(Error::Equivocation))
        );
    }

    let mut chains = world.chains(&session());
    chains.apply_cut(&cut_at(&world, cut));
    assert_eq!(chains.head(&device(2)), cut);
    chains.apply_cut(&cut_at(&world, Head::START));
    assert_eq!(chains.head(&device(2)), Head::START);
    assert!(chains.heads().is_empty());
    assert_ne!(two.hash(), three.hash());
}

#[test]
fn heads_name_every_accepted_chain() {
    let mut world = World::new();
    assert_eq!(heads_value(&world.chains(&session())).unwrap(), "{}");
    let human = world.post(2, session(), &chat("x"));
    world.post(3, session(), &agent_chat("x"));
    let agent = world.post(3, session(), &agent_chat("y"));
    let value = heads_value(&world.chains(&session())).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&value).unwrap();
    assert_eq!(
        parsed[device(3).to_base64url()],
        json!([2, agent.hash().to_base64url()])
    );
    assert_eq!(
        parsed[device(2).to_base64url()],
        json!([1, human.hash().to_base64url()])
    );
    assert_eq!(
        parse_heads(&value).unwrap(),
        world.chains(&session()).heads()
    );
    assert_eq!(parse_heads("{}").unwrap(), Vec::new());
}

#[test]
fn heads_are_read_strictly() {
    let sender = device(2).to_base64url();
    let hash = Hash32::new([5; 32]).to_base64url();
    let good = format!(r#"{{"{sender}":[3,"{hash}"]}}"#);
    assert_eq!(parse_heads(&good).unwrap().len(), 1);
    let cases = [
        "[]".to_string(),
        "null".to_string(),
        format!(r#"{{"{sender}":[0,"{hash}"]}}"#),
        format!(r#"{{"{sender}":[3]}}"#),
        format!(r#"{{"{sender}":[3,"{hash}",1]}}"#),
        format!(r#"{{"{sender}":["3","{hash}"]}}"#),
        format!(r#"{{"{sender}":[-1,"{hash}"]}}"#),
        format!(r#"{{"{sender}":[3.5,"{hash}"]}}"#),
        format!(r#"{{"{sender}":[3,"{sender}x"]}}"#),
        format!(r#"{{"{sender}=":[3,"{hash}"]}}"#),
        format!(r#"{{"short":[3,"{hash}"]}}"#),
        format!(r#"{{"{sender}":[3,"{hash}"],"{sender}":[3,"{hash}"]}}"#),
        format!(r#"{{"{sender}":[3,"{hash}"]}} x"#),
    ];
    for text in cases {
        assert_eq!(parse_heads(&text), Err(Error::BadFormat), "{text}");
    }
}

#[test]
fn heads_show_what_a_reader_lacks_and_what_differs() {
    let mut writer = World::new();
    let one = writer.post(2, session(), &chat("one"));
    let two = writer.post(2, session(), &chat("two"));
    let named = writer.chains(&session()).heads();
    let compare = |world: &World, named: &[(DeviceId, Head)]| {
        compare_heads(&world.fake, &world.chains(&session()), &session(), named)
            .unwrap()
            .into_iter()
            .map(|(_, standing)| standing)
            .collect::<Vec<_>>()
    };

    // A reader that was served nothing, then one envelope, then both.
    let mut reader = World::new();
    assert_eq!(compare(&reader, &named), [HeadStanding::Behind { have: 0 }]);
    reader.take(one.envelope()).unwrap();
    let standing = compare(&reader, &named);
    assert_eq!(standing, [HeadStanding::Behind { have: 1 }]);
    // The hub has nothing more: withheld.
    assert_eq!(standing[0].after_fetch(), Err(Error::Withheld));
    reader.take(two.envelope()).unwrap();
    assert_eq!(compare(&reader, &named), [HeadStanding::Held]);
    assert_eq!(HeadStanding::Held.after_fetch(), Ok(()));

    // A head that names another hash under the reader's last number, and under an earlier one.
    let other = |seq| {
        vec![(
            device(2),
            Head {
                seq,
                hash: Hash32::new([7; 32]),
            },
        )]
    };
    assert_eq!(compare(&reader, &other(2)), [HeadStanding::Equivocation]);
    assert_eq!(compare(&reader, &other(1)), [HeadStanding::Equivocation]);
    assert_eq!(
        HeadStanding::Equivocation.after_fetch(),
        Err(Error::Equivocation)
    );
    // An earlier number that the reader holds, and one it keeps no record of.
    let earlier = vec![(
        device(2),
        Head {
            seq: 1,
            hash: one.hash(),
        },
    )];
    assert_eq!(compare(&reader, &earlier), [HeadStanding::Held]);
    reader.fake.accepted.remove(&(session(), device(2), 1));
    assert_eq!(compare(&reader, &earlier), [HeadStanding::Unknown]);
    assert_eq!(HeadStanding::Unknown.after_fetch(), Ok(()));
}

#[test]
fn the_sender_never_gives_one_number_twice() {
    let world = World::new();
    let mut entropy = seeded(5);
    let mut seal = |own: &mut OwnChain, draft: &Draft, n: u8| {
        seal_next(
            &world.fake,
            &Chains::new(),
            &Objects::new(),
            own,
            draft,
            session(),
            &signer(n),
            NOW,
            &mut entropy,
        )
    };
    let mut own = OwnChain::new();
    let first = seal(&mut own, &chat("one"), 2).unwrap();
    assert_eq!(first.envelope.header.seq, 1);
    assert_eq!(first.envelope.header.prev, Hash32::ZERO);
    assert_eq!(first.envelope.header.epoch, 0);
    assert_eq!(first.envelope.header.time, NOW);
    // Signing moved the chain on: the same call again signs the next number.
    assert_eq!(
        own.head(),
        Head {
            seq: 1,
            hash: first.hash
        }
    );
    // The stored state is what the next envelope builds on.
    let mut stored = OwnChain::from_bytes(&own.to_bytes().unwrap()).unwrap();
    assert_eq!(stored, own);
    let second = seal(&mut stored, &chat("two"), 2).unwrap();
    assert_eq!(second.envelope.header.seq, 2);
    assert_eq!(second.envelope.header.prev, first.hash);
    let third = seal(&mut stored, &chat("two"), 2).unwrap();
    assert_eq!(third.envelope.header.seq, 3);
    // A receiver accepts them in order.
    let mut receiver = World::new();
    for outgoing in [&first, &second, &third] {
        receiver.take(&outgoing.envelope).unwrap();
    }

    // Refusals use up nothing.
    let before = stored.head();
    assert_eq!(seal(&mut stored, &card(), 2).err(), Some(Error::Forbidden));
    assert_eq!(
        seal(&mut stored, &chat("x"), 5).err(),
        Some(Error::NotMember)
    );
    let too_long = Draft::session_chat(SESSION, device(3), &payload(&"a".repeat(60_000)));
    assert_eq!(seal(&mut stored, &too_long, 2).err(), Some(Error::TooLarge));
    assert_eq!(stored.head(), before);
}

#[test]
fn the_sender_refuses_what_the_hub_would_void() {
    let mut world = World::new();
    let seal = |world: &World, chains: &Chains, group: GroupId, entropy: &mut dyn Entropy| {
        let mut own = OwnChain::new();
        let result = seal_next(
            &world.fake,
            chains,
            &Objects::new(),
            &mut own,
            &chat("x"),
            group,
            &signer(2),
            NOW,
            entropy,
        );
        assert_eq!(own, OwnChain::new());
        result.map(|_| ())
    };
    let mut entropy = seeded(5);
    assert_eq!(
        seal(&world, &Chains::new(), session(), &mut NoEntropy),
        Err(Error::Entropy)
    );
    let unknown = GroupId::session(ROOM, SessionId::new([8; 16]));
    assert_eq!(
        seal(&world, &Chains::new(), unknown, &mut entropy),
        Err(Error::GroupBehind)
    );
    let foreign = GroupId::session(RoomId::new([9; 32]), SESSION);
    assert_eq!(
        seal(&world, &Chains::new(), foreign, &mut entropy),
        Err(Error::WrongRoom)
    );
    let full = chains_with_count(0, MAX_ENVELOPES_PER_EPOCH);
    assert_eq!(
        seal(&world, &full, session(), &mut entropy),
        Err(Error::EpochFull)
    );
    world.fake.group(&session()).stale = true;
    assert_eq!(
        seal(&world, &Chains::new(), session(), &mut entropy),
        Err(Error::StaleSession)
    );
    world.fake.group(&session()).stale = false;
    world.fake.group(&session()).epochs[0].no_key = true;
    assert_eq!(
        seal(&world, &Chains::new(), session(), &mut entropy),
        Err(Error::NoKey)
    );
    // A device whose chain a Cut ended signs nothing more there, even as a leaf again.
    world.fake.group(&session()).epochs[0].no_key = false;
    world
        .fake
        .group(&session())
        .cuts
        .insert(device(2), Head::START);
    assert_eq!(
        seal(&world, &Chains::new(), session(), &mut entropy),
        Err(Error::RemovedSender)
    );
}

#[test]
fn a_step_is_applied_once_and_in_turn() {
    let mut world = World::new();
    let one = world.sign(2, session(), &chat("one"));
    let card = world.sign(3, session(), &card());
    let receipt = receive(
        &world.fake,
        &world.fake,
        &Chains::new(),
        &Objects::new(),
        &device(1),
        &one.envelope.encode().unwrap(),
        &Served::Stored,
        Mode::InOrder,
        NOW,
    )
    .unwrap();
    let mut chains = Chains::new();
    chains.apply(receipt.advance()).unwrap();
    assert!(matches!(
        chains.apply(receipt.advance()),
        Err(Error::Internal(_))
    ));
    assert_eq!(chains.count(0), 1);
    // Two envelopes of different senders checked against the same state: only one step fits.
    let other = world.sign(1, session(), &chat("x"));
    let second = receive(
        &world.fake,
        &world.fake,
        &Chains::new(),
        &Objects::new(),
        &device(1),
        &other.envelope.encode().unwrap(),
        &Served::Stored,
        Mode::InOrder,
        NOW,
    )
    .unwrap();
    assert!(matches!(
        chains.apply(second.advance()),
        Err(Error::Internal(_))
    ));
    assert_eq!(
        Chains::from_bytes(&chains.to_bytes().unwrap()).unwrap(),
        chains
    );
    // A transition judged against a state that has moved on since.
    let receipt = world.take(&card.envelope).unwrap();
    let Outcome::Taken {
        transition: Some(transition),
        ..
    } = &receipt.outcome()
    else {
        panic!("taken");
    };
    let mut objects = world.objects(&session());
    assert!(matches!(objects.apply(transition), Err(Error::Internal(_))));
    assert_eq!(objects, world.objects(&session()));
}

#[test]
fn a_provisional_envelope_that_its_chain_refuses_is_dropped() {
    let mut world = World::new();
    // An answer to a version that is not current passes what a page can check of 9.2, and is refused when
    // the chain brings it.
    let v1 = world.post(3, session(), &card());
    let id = v1.envelope().header.subject.object().unwrap().object_id;
    let bind = envelope::AnswerBind {
        object_id: id,
        version_hash: Hash32::new([9; 32]),
        choices: Vec::new(),
    };
    let draft = Draft::answer(bind, false, Urgency::Normal, device(3), b"{}");
    let sealed = world.sign(2, session(), &draft);
    let fetch = |world: &World, envelope: &Envelope| {
        provisional(
            &world.fake,
            &world.fake,
            &world.chains(&session()),
            &envelope.encode().unwrap(),
            NOW,
        )
        .unwrap()
    };
    let page = fetch(&world, &sealed.envelope);
    assert_eq!(page.standing, Standing::Provisional);
    let receipt = world.take(&sealed.envelope).unwrap();
    assert_eq!(page.confirm(&receipt), Err(Error::Forbidden));
    // The same for one the hub serves as a void record.
    let sealed = world.sign(2, session(), &chat("x"));
    let page = fetch(&world, &sealed.envelope);
    let receipt = world
        .take_as(
            &sealed.envelope.prune().unwrap().encode().unwrap(),
            &Served::Void(Error::WrongEpoch),
            Mode::InOrder,
        )
        .unwrap();
    assert_eq!(page.confirm(&receipt), Err(Error::WrongEpoch));
}

#[test]
fn chain_state_round_trips_and_refuses_damage() {
    let mut world = World::new();
    world.post(2, session(), &chat("x"));
    world.post(3, session(), &agent_chat("x"));
    world.fake.commit(&session(), NOW, NOW, |_| {});
    world.post(3, session(), &agent_chat("y"));
    let chains = world.chains(&session());
    let bytes = chains.to_bytes().unwrap();
    assert_eq!(Chains::from_bytes(&bytes).unwrap(), chains);
    assert_eq!(
        Chains::from_bytes(&Chains::new().to_bytes().unwrap()).unwrap(),
        Chains::new()
    );
    for len in 0..bytes.len() {
        assert!(matches!(
            Chains::from_bytes(&bytes[..len]),
            Err(Error::Storage(_))
        ));
    }
    let mut longer = bytes.clone();
    longer.push(0);
    assert!(matches!(
        Chains::from_bytes(&longer),
        Err(Error::Storage(_))
    ));
    // The same sender twice.
    struct HeadEntry(DeviceId, Head);
    impl codec::Encode for HeadEntry {
        fn write(&self, writer: &mut Writer) -> Result<(), Error> {
            writer.fixed(self.0.as_bytes());
            writer.value(&self.1)
        }
    }
    let twice = [
        HeadEntry(device(2), Head::START),
        HeadEntry(device(2), Head::START),
    ];
    let mut writer = Writer::new();
    writer.u64(0);
    writer.vector(&twice).unwrap();
    writer.vector::<HeadEntry>(&[]).unwrap();
    writer.vector::<HeadEntry>(&[]).unwrap();
    // With one of the two entries the same bytes are a chain state.
    let mut once = Writer::new();
    once.u64(0);
    once.vector(&twice[..1]).unwrap();
    once.vector::<HeadEntry>(&[]).unwrap();
    once.vector::<HeadEntry>(&[]).unwrap();
    assert!(Chains::from_bytes(&once.into_bytes()).is_ok());
    assert!(matches!(
        Chains::from_bytes(&writer.into_bytes()),
        Err(Error::Storage(_))
    ));

    assert_eq!(
        OwnChain::from_bytes(&OwnChain::new().to_bytes().unwrap()).unwrap(),
        OwnChain::new()
    );
    assert!(matches!(
        OwnChain::from_bytes(&[0; 39]),
        Err(Error::Storage(_))
    ));
    assert!(matches!(
        OwnChain::from_bytes(&[1; 41]),
        Err(Error::Storage(_))
    ));
    // A number without a hash, a hash without a number.
    let mut odd = [0u8; 40];
    odd[7] = 1;
    assert!(matches!(OwnChain::from_bytes(&odd), Err(Error::Storage(_))));
    let mut odd = [0u8; 40];
    odd[39] = 1;
    assert!(matches!(OwnChain::from_bytes(&odd), Err(Error::Storage(_))));
}

#[test]
fn a_board_snapshots_frontier_starts_chains_beyond_number_one() {
    let mut writer = World::new();
    let one = writer.post(2, room(), &stroke());
    let two = writer.post(2, room(), &stroke());
    let three = writer.sign(2, room(), &stroke());
    let four = writer.sign(2, room(), &stroke());

    let mut reader = World::new();
    reader.chains.insert(
        room(),
        Chains::from_frontier(&writer.chains(&room()).heads()),
    );
    assert_eq!(reader.take(&four.envelope).err(), Some(Error::Gap));
    let receipt = reader
        .take_as(
            &three.envelope.prune().unwrap().encode().unwrap(),
            &Served::Stored,
            Mode::ReadingBack,
        )
        .unwrap();
    assert_eq!(taken(&receipt), &Err(Error::Pruned));
    reader.take(&four.envelope).unwrap();
    let chains = reader.chains(&room());
    assert_eq!(chains.started_at(&device(2)).map(|head| head.seq), Some(2));
    assert_eq!(
        Chains::from_bytes(&chains.to_bytes().unwrap()).unwrap(),
        chains
    );
    // What lies up to the frontier is read from number 1 at any time later, in its order, and leads to
    // the frontier's envelope; the chain's head stays where it is.
    assert_eq!(reader.take(two.envelope()).err(), Some(Error::Gap));
    reader.take(one.envelope()).unwrap();
    assert_eq!(reader.take(one.envelope()).err(), Some(Error::Replay));
    assert_eq!(reader.chains(&room()).head(&device(2)).seq, 4);
    reader.take(two.envelope()).unwrap();
    assert_eq!(reader.chains(&room()).started_at(&device(2)), None);
    assert_eq!(reader.take(two.envelope()).err(), Some(Error::Replay));
    assert_eq!(reader.chains(&room()).head(&device(2)).seq, 4);

    // A frontier that names another envelope than the chain holds under its number is found out there.
    let mut other = World::new();
    let wrong = Head {
        seq: 2,
        hash: Hash32::new([9; 32]),
    };
    let mut chains = Chains::new();
    chains.start_at(device(2), wrong).unwrap();
    assert!(chains.start_at(device(2), wrong).is_err());
    other.chains.insert(room(), chains);
    other.take(one.envelope()).unwrap();
    assert_eq!(other.take(two.envelope()).err(), Some(Error::Equivocation));
    assert_eq!(other.chains(&room()).started_at(&device(2)), Some(wrong));
}

#[test]
fn a_register_and_a_reserved_kind_change_no_object() {
    let mut world = World::new();
    let draft = Draft::register(RegisterId::new([5; 16]), &payload("x"));
    let receipt = world.post(2, room(), &draft);
    assert!(matches!(
        receipt.outcome(),
        Outcome::Taken {
            transition: None,
            body: Ok(_)
        }
    ));
    assert!(receipt.opened().is_some());
}

#[test]
fn a_cut_at_a_frontiers_number_moves_the_frontier_to_the_cut() {
    let mut writer = World::new();
    let one = writer.post(2, room(), &stroke());
    let two = writer.post(2, room(), &stroke());
    // A chain that began at a frontier naming another envelope under number 2 than the chain holds.
    let wrong = Head {
        seq: 2,
        hash: Hash32::new([9; 32]),
    };
    let mut reader = World::new();
    let mut chains = Chains::new();
    chains.start_at(device(2), wrong).unwrap();
    // The device is removed, and its Cut names the chain's own envelope under that number.
    let cut = Head {
        seq: 2,
        hash: two.hash(),
    };
    let effect = cut_chain(&reader.fake, &chains, &room(), &device(2), &cut).unwrap();
    assert_eq!(effect.finding, Some(Error::Equivocation));
    chains.apply_cut(&effect);
    assert_eq!(chains.head(&device(2)), cut);
    // The frontier is the Cut now: what is read from number 1 leads there.
    assert_eq!(chains.started_at(&device(2)), Some(cut));
    let stored = chains.to_bytes().unwrap();
    assert_eq!(Chains::from_bytes(&stored).unwrap(), chains);
    reader.fake.commit(&room(), NOW, NOW, |leaves| {
        leaves.remove(&device(2));
    });
    reader.fake.group(&room()).cuts.insert(device(2), cut);
    reader.chains.insert(room(), chains);
    for envelope in [one.envelope(), two.envelope()] {
        reader
            .take_as(
                &envelope.encode().unwrap(),
                &Served::Stored,
                Mode::ReadingBack,
            )
            .unwrap();
    }
    assert_eq!(reader.chains(&room()).started_at(&device(2)), None);

    // A stored chain that stands at its frontier's number on another envelope than the frontier's is damaged.
    let mut contradicting = Chains::new();
    contradicting.start_at(device(2), wrong).unwrap();
    let mut bytes = contradicting.to_bytes().unwrap();
    assert_eq!(Chains::from_bytes(&bytes).unwrap(), contradicting);
    let at = bytes
        .windows(32)
        .position(|window| window == [9; 32])
        .unwrap();
    bytes[at] = 8;
    assert!(matches!(Chains::from_bytes(&bytes), Err(Error::Storage(_))));
}
