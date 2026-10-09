//! The object state rule (section 9.2.1) against a model written from the specification's text: random
//! headers, some in order and many not, judged by the core and by the model, must leave the same objects.

use std::collections::BTreeMap;
use trommi_core::chain::Role;
use trommi_core::envelope::{
    self, Header, ObjectFields, ObjectState, ObjectType, Subject, Urgency,
};
use trommi_core::ids::{DeviceId, GroupId, Hash32, ObjectId, SessionId};
use trommi_core::objects::{self, Objects};
use trommi_core::Error;
use trommi_tests::content::{Dice, View, ROOM};
use trommi_tests::vectors::entropy;

/// One object as the specification describes its state.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Modelled {
    object_type: ObjectType,
    owner: DeviceId,
    state: ObjectState,
    current: Hash32,
}

/// 9.2 and 9.2.1 for a main session with one human and one agent device, word for word. `true`: taken.
fn model(
    objects: &mut BTreeMap<ObjectId, Modelled>,
    group: &GroupId,
    human: &DeviceId,
    header: &Header,
    hash: Hash32,
) -> bool {
    let by_human = header.sender == *human;
    let derived = envelope::object_id(group, &header.sender, header.seq).unwrap();
    let begins = |fields: &ObjectFields, objects: &BTreeMap<ObjectId, Modelled>| {
        fields.object_id == derived
            && fields.object_ref.is_zero()
            && fields.state == ObjectState::Open
            && !objects.contains_key(&fields.object_id)
    };
    let (fields, taken) = match &header.subject {
        // A permission request has no later version; an agent device creates it.
        Subject::Request(fields) => {
            let ok =
                !by_human && fields.object_type == ObjectType::Request && begins(fields, objects);
            (
                fields,
                ok.then_some((header.sender, ObjectState::Open, hash)),
            )
        }
        Subject::Version(fields) => {
            let of_session = matches!(fields.object_type, ObjectType::Card | ObjectType::Artifact);
            if fields.object_ref.is_zero() {
                let ok = !by_human && of_session && begins(fields, objects);
                (
                    fields,
                    ok.then_some((header.sender, ObjectState::Open, hash)),
                )
            } else {
                // A later version: names the current one, comes from the owner, is open or closed.
                let ok = objects.get(&fields.object_id).is_some_and(|object| {
                    !by_human
                        && of_session
                        && object.object_type == fields.object_type
                        && fields.object_ref == object.current
                        && object.owner == header.sender
                        && fields.state != ObjectState::Answered
                });
                (fields, ok.then_some((header.sender, fields.state, hash)))
            }
        }
        // An answer: by a human device to the owner, on the current version of an open card.
        Subject::Answer(fields) => {
            let taken = objects.get(&fields.object_id).filter(|object| {
                by_human
                    && fields.object_type == ObjectType::Card
                    && object.object_type == ObjectType::Card
                    && fields.object_ref == object.current
                    && object.state == ObjectState::Open
                    && fields.state != ObjectState::Open
                    && header.recipient == object.owner
            });
            (
                fields,
                taken.map(|object| (object.owner, fields.state, object.current)),
            )
        }
        // A take back: on the current version of an answered card; open again.
        Subject::TakeBack(fields) => {
            let taken = objects.get(&fields.object_id).filter(|object| {
                by_human
                    && fields.object_type == ObjectType::Card
                    && object.object_type == ObjectType::Card
                    && fields.object_ref == object.current
                    && object.state == ObjectState::Answered
                    && fields.state == ObjectState::Open
                    && header.recipient == object.owner
            });
            (
                fields,
                taken.map(|object| (object.owner, ObjectState::Open, object.current)),
            )
        }
        // A verdict: names the request, which is open; closed.
        Subject::Verdict(fields) => {
            let taken = objects.get(&fields.object_id).filter(|object| {
                by_human
                    && fields.object_type == ObjectType::Request
                    && object.object_type == ObjectType::Request
                    && fields.object_ref == object.current
                    && object.state == ObjectState::Open
                    && fields.state == ObjectState::Closed
                    && header.recipient == object.owner
            });
            (
                fields,
                taken.map(|object| (object.owner, ObjectState::Closed, object.current)),
            )
        }
        _ => return true,
    };
    let Some((owner, state, current)) = taken else {
        return false;
    };
    let object_type = objects
        .get(&fields.object_id)
        .map_or(fields.object_type, |object| object.object_type);
    objects.insert(
        fields.object_id,
        Modelled {
            object_type,
            owner,
            state,
            current,
        },
    );
    true
}

#[test]
fn random_headers_leave_the_objects_the_specification_describes() {
    let mut dice = Dice(entropy("content objects model").unwrap());
    let group = GroupId::session(ROOM, SessionId::new([2; 16]));
    let human = DeviceId::new([0x48; 32]);
    let agent = DeviceId::new([0x41; 32]);
    let view = View::new(group, &[(human, Role::Human), (agent, Role::Agent)], None);
    let types = [
        ObjectType::Card,
        ObjectType::Artifact,
        ObjectType::Request,
        ObjectType::Note,
    ];
    let states = [
        ObjectState::Open,
        ObjectState::Answered,
        ObjectState::Closed,
    ];
    let (mut taken_count, mut refused_count) = (0u32, 0u32);

    for _ in 0..300 {
        let mut objects = Objects::new();
        let mut modelled = BTreeMap::new();
        let mut seqs = BTreeMap::from([(human, 0u64), (agent, 0u64)]);
        for _ in 0..60 {
            // Mostly the sender whose turn the rule gives, and mostly what fits the object.
            let known: Vec<(ObjectId, Modelled)> = modelled
                .iter()
                .map(|(id, object): (&ObjectId, &Modelled)| (*id, object.clone()))
                .collect();
            let target = (!known.is_empty() && !dice.one_in(5).unwrap())
                .then(|| known[dice.below(known.len() as u64).unwrap() as usize].clone());
            let kind = dice.below(6).unwrap();
            let sender = match (kind, dice.one_in(8).unwrap()) {
                (0..=2, false) | (3.., true) => agent,
                _ => human,
            };
            let seq = seqs[&sender] + 1;
            seqs.insert(sender, seq);
            let odd = |dice: &mut Dice<_>| dice.one_in(7).unwrap();
            let pick_state = |dice: &mut Dice<_>, usual: ObjectState| {
                if dice.one_in(6).unwrap() {
                    states[dice.below(3).unwrap() as usize]
                } else {
                    usual
                }
            };
            let derived = envelope::object_id(&group, &sender, seq).unwrap();
            let (object_id, object_type, object_ref) = match (&target, kind) {
                (_, 0) => (
                    derived,
                    types[dice.below(2).unwrap() as usize],
                    Hash32::ZERO,
                ),
                (_, 1) => (derived, ObjectType::Request, Hash32::ZERO),
                (Some((id, object)), _) => (
                    if odd(&mut dice) { derived } else { *id },
                    if odd(&mut dice) {
                        types[dice.below(4).unwrap() as usize]
                    } else {
                        object.object_type
                    },
                    if odd(&mut dice) {
                        Hash32::new(dice.bytes().unwrap())
                    } else {
                        object.current
                    },
                ),
                (None, _) => (
                    ObjectId::new(dice.bytes().unwrap()),
                    ObjectType::Card,
                    Hash32::new(dice.bytes().unwrap()),
                ),
            };
            let rarer = dice.one_in(3).unwrap();
            let usual = match kind {
                2 if rarer => ObjectState::Closed,
                3 if rarer => ObjectState::Closed,
                3 => ObjectState::Answered,
                5 => ObjectState::Closed,
                _ => ObjectState::Open,
            };
            let state = pick_state(&mut dice, usual);
            let fields = ObjectFields {
                object_id,
                object_type,
                state,
                urgency: Urgency::Normal,
                answered_at: if state == ObjectState::Open { 0 } else { 5 },
                object_ref,
            };
            let subject = match kind {
                0 | 2 => Subject::Version(fields),
                1 => Subject::Request(fields),
                3 => Subject::Answer(fields),
                4 => Subject::TakeBack(fields),
                _ => Subject::Verdict(fields),
            };
            let recipient = match dice.below(8).unwrap() {
                0 => human,
                1 => DeviceId::ZERO,
                _ => agent,
            };
            let header = Header {
                push: false,
                group,
                epoch: 0,
                sender,
                seq,
                prev: Hash32::ZERO,
                recipient,
                time: 1,
                subject,
                file_ids: Vec::new(),
            };
            let hash = Hash32::new(dice.bytes().unwrap());

            let expected = model(&mut modelled, &group, &human, &header, hash);
            match objects::judge(&view, &objects, &header, &hash) {
                Ok(Some(transition)) => {
                    assert!(expected, "the core takes what the rule refuses: {header:?}");
                    objects.apply(&transition).unwrap();
                    // A transition is applied once.
                    assert!(objects.apply(&transition).is_err());
                    taken_count += 1;
                }
                Err(Error::Forbidden) => {
                    assert!(
                        !expected,
                        "the core refuses what the rule takes: {header:?}"
                    );
                    refused_count += 1;
                }
                other => panic!("{other:?}"),
            }
            assert_eq!(objects.iter().count(), modelled.len());
            for (id, object) in &modelled {
                let held = objects.get(id).unwrap();
                assert_eq!(
                    (held.object_type, held.owner, held.state, held.current),
                    (
                        object.object_type,
                        object.owner,
                        object.state,
                        object.current
                    )
                );
            }
            // The stored form gives the same state back.
            assert_eq!(
                Objects::from_bytes(&objects.to_bytes().unwrap()).unwrap(),
                objects
            );
        }
    }
    // Both happen often enough for the comparison to mean something.
    assert!(
        taken_count > 3_000 && refused_count > 3_000,
        "{taken_count} {refused_count}"
    );
}

/// Who may write what, the object state rule and the command gate, case by case (sections 9.0.9 and 9.2).
mod rules {
    use serde_json::json;
    use trommi_core::chain::{Mode, Outcome, Receipt, Role, Served, LIVE_GRACE_MS};
    use trommi_core::envelope::{
        AnswerBind, Draft, Header, ObjectFields, ObjectState, ObjectType, RequestBind, Subject,
        TakeBackBind, Urgency, Verdict, VerdictBind,
    };
    use trommi_core::ids::{BoardId, DeviceId, GroupId, Hash32, ObjectId, RegisterId, SessionId};
    use trommi_core::objects::*;
    use trommi_core::Error;
    use trommi_tests::room::*;
    use trommi_tests::seal;

    fn first(object_type: ObjectType) -> Draft {
        Draft::first_version(
            object_type,
            Urgency::Normal,
            &version_payload(&Hash32::ZERO, json!({})),
        )
        .unwrap()
    }

    fn later(id: ObjectId, object_type: ObjectType, previous: Hash32, closed: bool) -> Draft {
        Draft::later_version(
            id,
            object_type,
            closed,
            Urgency::Normal,
            previous,
            &version_payload(&previous, json!({})),
        )
        .unwrap()
    }

    fn answer(id: ObjectId, version: Hash32, to: u8, closes: bool) -> Draft {
        let bind = AnswerBind {
            object_id: id,
            version_hash: version,
            choices: Vec::new(),
        };
        Draft::answer(
            bind,
            closes,
            Urgency::Normal,
            device(to),
            &serde_json::to_vec(&json!({ "answer_action": "answer" })).unwrap(),
        )
    }

    fn take_back(id: ObjectId, version: Hash32, answer: Hash32, to: u8) -> Draft {
        let bind = TakeBackBind {
            object_id: id,
            previous_hash: answer,
            version_hash: version,
        };
        Draft::take_back(bind, Urgency::Normal, device(to), b"{}")
    }

    fn verdict(id: ObjectId, request: Hash32, expires_at: u64, to: u8) -> Draft {
        let bind = VerdictBind {
            request_id: id,
            request_hash: request,
            expires_at,
            verdict: Verdict::Allow,
        };
        Draft::verdict(bind, Urgency::Normal, device(to), b"{}")
    }

    fn id_of(receipt: &Receipt) -> ObjectId {
        receipt
            .envelope()
            .header
            .subject
            .object()
            .unwrap()
            .object_id
    }

    fn state(world: &World, group: &GroupId, id: &ObjectId) -> Object {
        world.objects(group).get(id).cloned().unwrap()
    }

    /// Whether the receiver forbids what device `n` signs.
    fn forbidden(world: &mut World, n: u8, group: GroupId, draft: &Draft) -> bool {
        match world.post(n, group, draft).outcome() {
            Outcome::Refused(Error::Forbidden) => true,
            Outcome::Taken { .. } => false,
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_card_goes_from_open_to_answered_and_back_and_closes() {
        let mut world = World::new();
        let v1 = world.post(3, session(), &first(ObjectType::Card));
        let id = id_of(&v1);
        assert_eq!(
            state(&world, &session(), &id),
            Object {
                object_type: ObjectType::Card,
                owner: device(3),
                state: ObjectState::Open,
                current: v1.hash(),
                answer: None,
            }
        );
        // A later version by its owner becomes current.
        let v2 = world.post(3, session(), &later(id, ObjectType::Card, v1.hash(), false));
        assert_eq!(state(&world, &session(), &id).current, v2.hash());
        // A human answers it: answered, the version stays current, the answer is in force.
        let a = world.post(2, session(), &answer(id, v2.hash(), 3, false));
        let now = state(&world, &session(), &id);
        assert_eq!(
            (now.state, now.current, now.answer),
            (ObjectState::Answered, v2.hash(), Some(a.hash()))
        );
        // Taken back: open again.
        world.post(1, session(), &take_back(id, v2.hash(), a.hash(), 3));
        let now = state(&world, &session(), &id);
        assert_eq!((now.state, now.answer), (ObjectState::Open, None));
        // Answered again, this time closing it.
        let a2 = world.post(1, session(), &answer(id, v2.hash(), 3, true));
        let now = state(&world, &session(), &id);
        assert_eq!(
            (now.state, now.answer),
            (ObjectState::Closed, Some(a2.hash()))
        );
        // The owner reopens it with a new version.
        let v3 = world.post(3, session(), &later(id, ObjectType::Card, v2.hash(), false));
        let now = state(&world, &session(), &id);
        assert_eq!(
            (now.state, now.current, now.answer),
            (ObjectState::Open, v3.hash(), None)
        );
        // And closes it with another.
        world.post(3, session(), &later(id, ObjectType::Card, v3.hash(), true));
        assert_eq!(state(&world, &session(), &id).state, ObjectState::Closed);
    }

    #[test]
    fn a_transition_carries_the_state_just_before() {
        let mut world = World::new();
        let v1 = world.post(3, session(), &first(ObjectType::Card));
        let id = id_of(&v1);
        let Outcome::Taken {
            transition: Some(created),
            ..
        } = &v1.outcome()
        else {
            panic!("taken");
        };
        assert_eq!(created.before, None);
        let before = state(&world, &session(), &id);
        let a = world.post(2, session(), &answer(id, v1.hash(), 3, false));
        let Outcome::Taken {
            transition: Some(answered),
            ..
        } = &a.outcome()
        else {
            panic!("taken");
        };
        assert_eq!(answered.before.as_ref(), Some(&before));
        assert_eq!(answered.after, state(&world, &session(), &id));
        assert_eq!(answered.object_id, id);
    }

    #[test]
    fn two_answers_judged_against_one_state_cannot_both_be_applied() {
        let mut world = World::new();
        let v1 = world.post(3, session(), &first(ObjectType::Card));
        let id = id_of(&v1);
        // A second answer is judged before the first is applied.
        let stale_objects = world.objects(&session());
        let b = world.sign(1, session(), &answer(id, v1.hash(), 3, false));
        let judged_early = judge(&world.fake, &stale_objects, &b.envelope.header, &b.hash)
            .unwrap()
            .unwrap();
        // The first answer and its take back leave the card exactly as it was.
        let a = world.post(2, session(), &answer(id, v1.hash(), 3, false));
        world.post(2, session(), &take_back(id, v1.hash(), a.hash(), 3));
        let mut objects = world.objects(&session());
        assert_eq!(objects.get(&id), stale_objects.get(&id));
        assert!(matches!(
            objects.apply(&judged_early),
            Err(Error::Internal(_))
        ));
        assert_eq!(objects, world.objects(&session()));
    }

    #[test]
    fn a_permission_request_is_closed_by_its_verdict() {
        let mut world = World::new();
        let request = world.post(
            3,
            session(),
            &Draft::request(Urgency::High, NOW + 60_000, b"{}"),
        );
        let id = id_of(&request);
        let now = state(&world, &session(), &id);
        assert_eq!(
            (now.object_type, now.state, now.current, now.owner),
            (
                ObjectType::Request,
                ObjectState::Open,
                request.hash(),
                device(3)
            )
        );
        // A verdict on another hash than the request, to another device than its owner, by the agent itself.
        let other = Hash32::new([9; 32]);
        assert!(forbidden(
            &mut world,
            2,
            session(),
            &verdict(id, other, NOW + 60_000, 3)
        ));
        assert!(forbidden(
            &mut world,
            2,
            session(),
            &verdict(id, request.hash(), NOW + 60_000, 1)
        ));
        assert!(forbidden(
            &mut world,
            3,
            session(),
            &verdict(id, request.hash(), NOW + 60_000, 3)
        ));
        assert!(!forbidden(
            &mut world,
            2,
            session(),
            &verdict(id, request.hash(), NOW + 60_000, 3)
        ));
        assert_eq!(state(&world, &session(), &id).state, ObjectState::Closed);
        // A second verdict: the request is no longer open.
        assert!(forbidden(
            &mut world,
            1,
            session(),
            &verdict(id, request.hash(), NOW + 60_000, 3)
        ));
        // A request has no later version, and nobody answers one.
        assert!(forbidden(
            &mut world,
            2,
            session(),
            &answer(id, request.hash(), 3, false)
        ));
        // A human device makes no request; no request lives in the room group.
        assert!(forbidden(
            &mut world,
            2,
            session(),
            &Draft::request(Urgency::Low, 1, b"{}")
        ));
        assert!(forbidden(
            &mut world,
            2,
            room(),
            &Draft::request(Urgency::Low, 1, b"{}")
        ));
    }

    #[test]
    fn first_versions_are_created_only_by_those_who_may() {
        let mut world = World::new();
        // Cards and Artifacts: agent and helper devices, in a session group.
        for object_type in [ObjectType::Card, ObjectType::Artifact] {
            assert!(!forbidden(&mut world, 3, session(), &first(object_type)));
            assert!(!forbidden(
                &mut world,
                4,
                helper_session(),
                &first(object_type)
            ));
            assert!(!forbidden(
                &mut world,
                3,
                helper_session(),
                &first(object_type)
            ));
            assert!(forbidden(&mut world, 2, session(), &first(object_type)));
            assert!(forbidden(&mut world, 1, room(), &first(object_type)));
        }
        // Notes: human devices, in the room group.
        assert!(!forbidden(&mut world, 1, room(), &first(ObjectType::Note)));
        assert!(forbidden(
            &mut world,
            1,
            session(),
            &first(ObjectType::Note)
        ));
        assert!(forbidden(
            &mut world,
            3,
            session(),
            &first(ObjectType::Note)
        ));
        assert_eq!(world.objects(&session()).iter().count(), 2);
        assert_eq!(world.objects(&helper_session()).iter().count(), 4);
        assert_eq!(world.objects(&room()).iter().count(), 1);
    }

    /// The receiver's verdict on a header that no honest writer makes.
    fn forged(
        world: &mut World,
        n: u8,
        group: GroupId,
        draft: &Draft,
        change: impl FnOnce(&mut Header),
    ) -> Outcome {
        let envelope = world.forge(n, group, draft, change);
        world.take(&envelope).unwrap().outcome().clone()
    }

    fn object_mut(header: &mut Header) -> &mut ObjectFields {
        match &mut header.subject {
            Subject::Version(f)
            | Subject::Answer(f)
            | Subject::Request(f)
            | Subject::Verdict(f)
            | Subject::TakeBack(f) => f,
            other => panic!("{other:?}"),
        }
    }

    const REFUSED: Outcome = Outcome::Refused(Error::Forbidden);

    #[test]
    fn a_first_version_must_be_the_one_its_place_derives() {
        let mut world = World::new();
        let draft = first(ObjectType::Card);
        // Another object id than the one derived from group, sender and number.
        let outcome = forged(&mut world, 3, session(), &draft, |h| {
            object_mut(h).object_id = ObjectId::new([7; 16]);
        });
        assert_eq!(outcome, REFUSED);
        // Not open.
        for state in [ObjectState::Answered, ObjectState::Closed] {
            let outcome = forged(&mut world, 3, session(), &draft, |h| {
                object_mut(h).state = state;
            });
            assert_eq!(outcome, REFUSED);
        }
        // A request under the kind version, and a card under the kind request.
        let outcome = forged(&mut world, 3, session(), &draft, |h| {
            object_mut(h).object_type = ObjectType::Request;
        });
        assert_eq!(outcome, REFUSED);
        let request = Draft::request(Urgency::Low, 1, b"{}");
        let outcome = forged(&mut world, 3, session(), &request, |h| {
            object_mut(h).object_type = ObjectType::Card;
        });
        assert_eq!(outcome, REFUSED);
        // A request that names a predecessor.
        let outcome = forged(&mut world, 3, session(), &request, |h| {
            object_mut(h).object_ref = Hash32::new([1; 32]);
        });
        assert_eq!(outcome, REFUSED);
        assert_eq!(world.objects(&session()), Objects::new());
        // The honest one is taken.
        assert!(!forbidden(&mut world, 3, session(), &draft));
    }

    #[test]
    fn a_later_version_needs_the_current_version_and_the_owner() {
        let mut world = World::new();
        let v1 = world.post(3, session(), &first(ObjectType::Card));
        let id = id_of(&v1);
        let stale = Hash32::new([9; 32]);
        // An unknown object; a predecessor that is not current; a writer that does not own it.
        let unknown = ObjectId::new([7; 16]);
        assert!(forbidden(
            &mut world,
            3,
            session(),
            &later(unknown, ObjectType::Card, v1.hash(), false)
        ));
        assert!(forbidden(
            &mut world,
            3,
            session(),
            &later(id, ObjectType::Card, stale, false)
        ));
        assert!(forbidden(
            &mut world,
            2,
            session(),
            &later(id, ObjectType::Card, v1.hash(), false)
        ));
        // Another type than the first version fixed.
        assert!(forbidden(
            &mut world,
            3,
            session(),
            &later(id, ObjectType::Artifact, v1.hash(), false)
        ));
        // A version cannot make its object answered.
        let draft = later(id, ObjectType::Card, v1.hash(), false);
        let outcome = forged(&mut world, 3, session(), &draft, |h| {
            object_mut(h).state = ObjectState::Answered;
        });
        assert_eq!(outcome, REFUSED);
        assert_eq!(state(&world, &session(), &id).current, v1.hash());
        // In a helper session: the helper that made a card owns it, not the opener.
        let h1 = world.post(4, helper_session(), &first(ObjectType::Card));
        let helper_card = id_of(&h1);
        assert!(forbidden(
            &mut world,
            3,
            helper_session(),
            &later(helper_card, ObjectType::Card, h1.hash(), false)
        ));
        assert!(!forbidden(
            &mut world,
            4,
            helper_session(),
            &later(helper_card, ObjectType::Card, h1.hash(), false)
        ));
    }

    #[test]
    fn ownership_passes_to_the_seat_when_the_owner_has_left() {
        let mut world = World::new();
        let v1 = world.post(3, session(), &first(ObjectType::Card));
        let id = id_of(&v1);
        // A takeover: device 6 replaces device 3 as the session's agent.
        world.fake.commit(&session(), NOW, NOW, |leaves| {
            leaves.remove(&device(3));
            leaves.insert(device(6), Role::Agent);
        });
        let card = state(&world, &session(), &id);
        assert_eq!(
            owner(&world.fake, &session(), 0, &card).unwrap(),
            Some(device(3))
        );
        assert_eq!(
            owner(&world.fake, &session(), 1, &card).unwrap(),
            Some(device(6))
        );
        // An answer is now addressed to the new agent.
        assert!(forbidden(
            &mut world,
            2,
            session(),
            &answer(id, v1.hash(), 3, false)
        ));
        assert!(!forbidden(
            &mut world,
            2,
            session(),
            &answer(id, v1.hash(), 6, false)
        ));
        // The new agent writes the next version and is then the recorded owner.
        let v2 = world.post(6, session(), &later(id, ObjectType::Card, v1.hash(), false));
        assert_eq!(state(&world, &session(), &id).owner, device(6));

        // In a helper session an object of a helper that left passes to the opener.
        let h1 = world.post(4, helper_session(), &first(ObjectType::Artifact));
        let artifact = id_of(&h1);
        world.fake.commit(&helper_session(), NOW, NOW, |leaves| {
            leaves.remove(&device(4));
            leaves.insert(device(7), Role::Helper);
        });
        assert!(forbidden(
            &mut world,
            7,
            helper_session(),
            &later(artifact, ObjectType::Artifact, h1.hash(), false)
        ));
        assert!(!forbidden(
            &mut world,
            3,
            helper_session(),
            &later(artifact, ObjectType::Artifact, h1.hash(), true)
        ));
        // While the seat is empty nobody owns it.
        world.fake.commit(&session(), NOW, NOW, |leaves| {
            leaves.remove(&device(6));
        });
        let card = state(&world, &session(), &id);
        assert_eq!(owner(&world.fake, &session(), 2, &card).unwrap(), None);
        assert!(forbidden(
            &mut world,
            2,
            session(),
            &answer(id, v2.hash(), 6, false)
        ));
        assert!(forbidden(
            &mut world,
            2,
            session(),
            &answer(id, v2.hash(), 0, false)
        ));
    }

    #[test]
    fn an_answer_needs_an_open_card_its_current_version_and_its_owner() {
        let mut world = World::new();
        let v1 = world.post(3, session(), &first(ObjectType::Card));
        let id = id_of(&v1);
        let v2 = world.post(3, session(), &later(id, ObjectType::Card, v1.hash(), false));
        // The version before the current one; an unknown card; the agent answering itself; another recipient.
        assert!(forbidden(
            &mut world,
            2,
            session(),
            &answer(id, v1.hash(), 3, false)
        ));
        assert!(forbidden(
            &mut world,
            2,
            session(),
            &answer(ObjectId::new([7; 16]), v2.hash(), 3, false)
        ));
        assert!(forbidden(
            &mut world,
            3,
            session(),
            &answer(id, v2.hash(), 3, false)
        ));
        assert!(forbidden(
            &mut world,
            2,
            session(),
            &answer(id, v2.hash(), 1, false)
        ));
        // An answer that leaves the card open.
        let draft = answer(id, v2.hash(), 3, false);
        let outcome = forged(&mut world, 2, session(), &draft, |h| {
            object_mut(h).state = ObjectState::Open;
            object_mut(h).answered_at = 0;
        });
        assert_eq!(outcome, REFUSED);
        // An answer that claims another type.
        let outcome = forged(&mut world, 2, session(), &draft, |h| {
            object_mut(h).object_type = ObjectType::Artifact;
        });
        assert_eq!(outcome, REFUSED);
        assert_eq!(state(&world, &session(), &id).state, ObjectState::Open);

        let a = world.post(2, session(), &answer(id, v2.hash(), 3, false));
        // Answered: a second answer is refused; so are take backs of the wrong version or to the wrong owner.
        assert!(forbidden(
            &mut world,
            1,
            session(),
            &answer(id, v2.hash(), 3, false)
        ));
        assert!(forbidden(
            &mut world,
            1,
            session(),
            &take_back(id, v1.hash(), a.hash(), 3)
        ));
        assert!(forbidden(
            &mut world,
            1,
            session(),
            &take_back(id, v2.hash(), a.hash(), 2)
        ));
        assert!(forbidden(
            &mut world,
            3,
            session(),
            &take_back(id, v2.hash(), a.hash(), 3)
        ));
        assert!(!forbidden(
            &mut world,
            1,
            session(),
            &take_back(id, v2.hash(), a.hash(), 3)
        ));
        // Open again: nothing to take back.
        assert!(forbidden(
            &mut world,
            1,
            session(),
            &take_back(id, v2.hash(), a.hash(), 3)
        ));
        // An Artifact is not answered.
        let artifact = world.post(3, session(), &first(ObjectType::Artifact));
        let draft = answer(id_of(&artifact), artifact.hash(), 3, false);
        assert!(forbidden(&mut world, 2, session(), &draft));
    }

    #[test]
    fn any_human_device_writes_a_note_version_on_any_other() {
        let mut world = World::new();
        let v1 = world.post(1, room(), &first(ObjectType::Note));
        let id = id_of(&v1);
        // Two devices write on version 1 without knowing of each other; a third version follows the first of
        // those.
        let v2 = world.post(2, room(), &later(id, ObjectType::Note, v1.hash(), false));
        let v3 = world.post(1, room(), &later(id, ObjectType::Note, v1.hash(), false));
        let v4 = world.post(2, room(), &later(id, ObjectType::Note, v2.hash(), true));
        let note = state(&world, &room(), &id);
        for version in [&v1, &v2, &v3, &v4] {
            assert!(world.objects(&room()).is_note_version(&id, &version.hash()));
        }
        assert!(!world
            .objects(&room())
            .is_note_version(&id, &Hash32::new([9; 32])));
        assert_eq!((note.current, note.state), (v4.hash(), ObjectState::Closed));
        // A version on something that is no version of this Note.
        assert!(forbidden(
            &mut world,
            1,
            room(),
            &later(id, ObjectType::Note, Hash32::new([9; 32]), false)
        ));
        // Nobody answers a Note.
        assert!(forbidden(
            &mut world,
            1,
            room(),
            &answer(id, v4.hash(), 1, false)
        ));
    }

    #[test]
    fn chat_is_written_by_the_sessions_devices_and_by_humans_to_its_seat() {
        let mut world = World::new();
        let chat = |session, to: Option<u8>| {
            Draft::session_chat(session, to.map_or(DeviceId::ZERO, device), &payload("x"))
        };
        // The agent, to anyone or no one.
        assert!(!forbidden(&mut world, 3, session(), &chat(SESSION, None)));
        assert!(!forbidden(
            &mut world,
            3,
            session(),
            &chat(SESSION, Some(1))
        ));
        // A human device: only addressed to the session's agent device.
        assert!(!forbidden(
            &mut world,
            2,
            session(),
            &chat(SESSION, Some(3))
        ));
        assert!(forbidden(&mut world, 2, session(), &chat(SESSION, None)));
        assert!(forbidden(&mut world, 2, session(), &chat(SESSION, Some(1))));
        // The timeline of another session than the group's.
        assert!(forbidden(
            &mut world,
            3,
            session(),
            &chat(HELPER_SESSION, None)
        ));
        assert!(forbidden(
            &mut world,
            2,
            session(),
            &chat(SessionId::new([9; 16]), Some(3))
        ));
        // A helper session: its opener and helpers write; a human addresses the opener, not a helper.
        assert!(!forbidden(
            &mut world,
            4,
            helper_session(),
            &chat(HELPER_SESSION, None)
        ));
        assert!(!forbidden(
            &mut world,
            3,
            helper_session(),
            &chat(HELPER_SESSION, None)
        ));
        assert!(!forbidden(
            &mut world,
            1,
            helper_session(),
            &chat(HELPER_SESSION, Some(3))
        ));
        assert!(forbidden(
            &mut world,
            1,
            helper_session(),
            &chat(HELPER_SESSION, Some(4))
        ));
        // No Chat in the room group.
        let mut in_room = World::new();
        in_room.fake.group(&room()).epochs[0]
            .leaves
            .insert(device(3), Role::Agent);
        assert!(forbidden(&mut in_room, 1, room(), &chat(SESSION, Some(3))));
        // While the session waits for a takeover a human device has nobody to address.
        world.fake.commit(&session(), NOW, NOW, |leaves| {
            leaves.remove(&device(3));
        });
        assert!(forbidden(&mut world, 2, session(), &chat(SESSION, Some(3))));
        assert!(forbidden(&mut world, 2, session(), &chat(SESSION, None)));
    }

    #[test]
    fn a_cards_chat_follows_its_session_and_needs_the_card() {
        let mut world = World::new();
        let card = world.post(3, session(), &first(ObjectType::Card));
        let artifact = world.post(3, session(), &first(ObjectType::Artifact));
        let on = |id: ObjectId, to: Option<u8>| {
            Draft::card_chat(id, to.map_or(DeviceId::ZERO, device), &payload("x"))
        };
        assert!(!forbidden(
            &mut world,
            3,
            session(),
            &on(id_of(&card), None)
        ));
        assert!(!forbidden(
            &mut world,
            2,
            session(),
            &on(id_of(&card), Some(3))
        ));
        assert!(forbidden(
            &mut world,
            2,
            session(),
            &on(id_of(&card), Some(1))
        ));
        // An unknown object, an Artifact, a card of another group.
        assert!(forbidden(
            &mut world,
            3,
            session(),
            &on(ObjectId::new([7; 16]), None)
        ));
        assert!(forbidden(
            &mut world,
            3,
            session(),
            &on(id_of(&artifact), None)
        ));
        assert!(forbidden(
            &mut world,
            3,
            helper_session(),
            &on(id_of(&card), None)
        ));
    }

    #[test]
    fn board_items_and_room_registers_are_the_humans() {
        let mut world = World::new();
        let stroke = Draft::board_item(BoardId::ALL_DESKS, &payload("x"));
        let register = Draft::register(RegisterId::new([5; 16]), &payload("x"));
        assert!(!forbidden(&mut world, 1, room(), &stroke));
        assert!(!forbidden(&mut world, 2, room(), &register));
        // A board lives in the room group only.
        assert!(forbidden(&mut world, 1, session(), &stroke));
        assert!(forbidden(&mut world, 3, session(), &stroke));
        // In a session group any leaf writes registers.
        for n in [1, 3] {
            assert!(!forbidden(&mut world, n, session(), &register));
        }
        assert!(!forbidden(&mut world, 4, helper_session(), &register));
        // A device that is no human device, were it a leaf of the room group, writes neither.
        world.fake.group(&room()).epochs[0]
            .leaves
            .insert(device(3), Role::Agent);
        assert!(forbidden(&mut world, 3, room(), &stroke));
        assert!(forbidden(&mut world, 3, room(), &register));
    }

    #[test]
    fn the_push_flag_counts_on_card_versions_and_requests_of_the_sessions_devices() {
        let mut world = World::new();
        let honoured = |world: &mut World, n: u8, group: GroupId, draft: Draft| {
            let sealed = world.sign(n, group, &draft.with_push());
            push_honoured(&world.fake, &sealed.envelope.header).unwrap()
        };
        assert!(honoured(&mut world, 3, session(), first(ObjectType::Card)));
        assert!(honoured(
            &mut world,
            4,
            helper_session(),
            first(ObjectType::Card)
        ));
        assert!(honoured(
            &mut world,
            3,
            session(),
            Draft::request(Urgency::Low, 1, b"{}")
        ));
        // Not on an Artifact, a Chat message, a Note, a register; not from a human device.
        assert!(!honoured(
            &mut world,
            3,
            session(),
            first(ObjectType::Artifact)
        ));
        assert!(!honoured(
            &mut world,
            3,
            session(),
            Draft::session_chat(SESSION, DeviceId::ZERO, b"{}")
        ));
        assert!(!honoured(&mut world, 1, room(), first(ObjectType::Note)));
        assert!(!honoured(&mut world, 2, session(), first(ObjectType::Card)));
        assert!(!honoured(
            &mut world,
            2,
            session(),
            answer(ObjectId::new([1; 16]), Hash32::new([1; 32]), 3, false)
        ));
        // Not without the flag.
        let sealed = world.sign(3, session(), &first(ObjectType::Card));
        assert!(!push_honoured(&world.fake, &sealed.envelope.header).unwrap());
    }

    #[test]
    fn replay_from_headers_gives_the_same_state_and_skips_what_is_cut() {
        let mut world = World::new();
        let mut log: Vec<(Header, Hash32)> = Vec::new();
        let mut post = |world: &mut World, n: u8, draft: &Draft| {
            let receipt = world.post(n, session(), draft);
            log.push((receipt.envelope().header.clone(), receipt.hash()));
            receipt
        };
        let v1 = post(&mut world, 3, &first(ObjectType::Card));
        let id = id_of(&v1);
        let a = post(&mut world, 2, &answer(id, v1.hash(), 3, false));
        post(
            &mut world,
            3,
            &Draft::session_chat(SESSION, DeviceId::ZERO, b"{}"),
        );
        post(&mut world, 2, &first(ObjectType::Card));
        let request = post(&mut world, 3, &Draft::request(Urgency::Low, 1, b"{}"));
        post(
            &mut world,
            1,
            &verdict(id_of(&request), request.hash(), 1, 3),
        );

        let replayed = replay(&world.fake, log.iter().map(|(h, hash)| (h, hash))).unwrap();
        assert_eq!(replayed, world.objects(&session()));
        assert_eq!(replayed.get(&id).unwrap().state, ObjectState::Answered);

        // Device 2 is removed and the remover had accepted nothing of it: its answer never came.
        let without: Vec<_> = log.iter().filter(|(h, _)| h.sender != device(2)).collect();
        let replayed = replay(&world.fake, without.iter().map(|(h, hash)| (h, hash))).unwrap();
        let card = replayed.get(&id).unwrap();
        assert_eq!((card.state, card.answer), (ObjectState::Open, None));
        assert_ne!(Some(a.hash()), card.answer);

        // The stored form.
        let bytes = replayed.to_bytes().unwrap();
        assert_eq!(Objects::from_bytes(&bytes).unwrap(), replayed);
        for len in 0..bytes.len() {
            assert!(matches!(
                Objects::from_bytes(&bytes[..len]),
                Err(Error::Storage(_))
            ));
        }
        let mut damaged = bytes.clone();
        // The first entry's type byte: its id is 16 bytes behind the two-byte length.
        damaged[26] = 9;
        assert!(matches!(
            Objects::from_bytes(&damaged),
            Err(Error::Storage(_))
        ));
        let note_world = {
            let mut w = World::new();
            let v1 = w.post(1, room(), &first(ObjectType::Note));
            w.post(
                2,
                room(),
                &later(id_of(&v1), ObjectType::Note, v1.hash(), false),
            );
            w
        };
        let notes = note_world.objects(&room());
        assert_eq!(
            Objects::from_bytes(&notes.to_bytes().unwrap()).unwrap(),
            notes
        );
    }

    #[test]
    fn a_pruned_envelope_counts_for_the_state() {
        let mut world = World::new();
        let v1 = world.sign(3, session(), &first(ObjectType::Card));
        let receipt = world
            .take_as(
                &v1.envelope.prune().unwrap().encode().unwrap(),
                &Served::Stored,
                Mode::ReadingBack,
            )
            .unwrap();
        assert_eq!(state(&world, &session(), &id_of(&receipt)).current, v1.hash);
    }

    // The command gate.

    struct Desk {
        world: World,
        log: GateLog,
        card: ObjectId,
        version: Hash32,
        card_payload: Vec<u8>,
    }

    /// The agent (device 3) is the receiver and has made a card with two options.
    fn desk(card_extra: serde_json::Value) -> Desk {
        let mut world = World::new();
        world.me = device(3);
        let card_payload = version_payload(&Hash32::ZERO, card_extra);
        let draft = Draft::first_version(ObjectType::Card, Urgency::Normal, &card_payload).unwrap();
        let v1 = world.post(3, session(), &draft);
        Desk {
            card: id_of(&v1),
            version: v1.hash(),
            world,
            log: GateLog::new(),
            card_payload,
        }
    }

    fn two_options() -> serde_json::Value {
        json!({ "options": [{ "key": "yes", "label": "Yes" }, { "key": "no", "label": "No" }] })
    }

    impl Desk {
        fn answer_draft(&self, action: &str, choices: &[&str]) -> Draft {
            let bind = AnswerBind {
                object_id: self.card,
                version_hash: self.version,
                choices: choices.iter().map(|c| c.as_bytes().to_vec()).collect(),
            };
            let payload = serde_json::to_vec(&json!({ "answer_action": action })).unwrap();
            Draft::answer(bind, false, Urgency::Normal, device(3), &payload)
        }

        fn record(&self) -> OwnRecord<'_> {
            OwnRecord::CardVersion {
                hash: self.version,
                payload: &self.card_payload,
            }
        }

        fn gate(&mut self, receipt: &Receipt, own: &OwnRecord<'_>) -> Decision {
            command_gate(
                &self.world.fake,
                &mut self.log,
                &device(3),
                &receipt.opened().unwrap(),
                own,
                self.world.now,
            )
            .unwrap()
        }

        /// A human's answer, through the chain and the gate.
        fn answer(&mut self, action: &str, choices: &[&str]) -> Decision {
            let draft = self.answer_draft(action, choices);
            let receipt = self.world.post(2, session(), &draft);
            let payload = self.card_payload.clone();
            let own = OwnRecord::CardVersion {
                hash: self.version,
                payload: &payload,
            };
            self.gate(&receipt, &own)
        }
    }

    fn act_answer(action: AnswerAction, choices: &[&str]) -> Decision {
        Decision::Act(Command::Answer {
            action,
            choices: choices.iter().map(|c| c.to_string()).collect(),
        })
    }

    #[test]
    fn the_gate_lets_a_valid_answer_through_once() {
        let mut desk = desk(two_options());
        let draft = desk.answer_draft("answer", &["yes"]);
        let receipt = desk.world.post(2, session(), &draft);
        let payload = desk.card_payload.clone();
        let own = OwnRecord::CardVersion {
            hash: desk.version,
            payload: &payload,
        };
        assert_eq!(
            desk.gate(&receipt, &own),
            act_answer(AnswerAction::Answer, &["yes"])
        );
        // Recorded before acting: after a crash the same envelope is not acted on again.
        let stored = GateLog::from_bytes(&desk.log.to_bytes().unwrap()).unwrap();
        assert_eq!(stored, desk.log);
        assert_eq!(desk.gate(&receipt, &own), Decision::Uncertain);
        desk.log.finish(&receipt.hash()).unwrap();
        assert_eq!(desk.gate(&receipt, &own), Decision::Done);
        assert_eq!(
            GateLog::from_bytes(&desk.log.to_bytes().unwrap()).unwrap(),
            desk.log
        );
        assert_eq!(desk.log.finish(&Hash32::new([9; 32])), Err(Error::NotFound));
        assert!(matches!(GateLog::from_bytes(&[1]), Err(Error::Storage(_))));
        let mut bad = desk.log.to_bytes().unwrap();
        *bad.last_mut().unwrap() = 2;
        assert!(matches!(GateLog::from_bytes(&bad), Err(Error::Storage(_))));
    }

    #[test]
    fn the_gate_holds_the_choices_to_the_card_version() {
        let refused = Decision::Refused(Refusal::BadChoice);
        // A card with options and a single choice.
        assert_eq!(
            desk(two_options()).answer("answer", &["no"]),
            act_answer(AnswerAction::Answer, &["no"])
        );
        assert_eq!(desk(two_options()).answer("answer", &[]), refused);
        assert_eq!(desk(two_options()).answer("answer", &["maybe"]), refused);
        assert_eq!(
            desk(two_options()).answer("answer", &["yes", "no"]),
            refused
        );
        assert_eq!(
            desk(two_options()).answer("answer", &["yes", "yes"]),
            refused
        );
        // Several only with `allows_multiple`, and still distinct options of the version.
        let mut multiple = two_options();
        multiple["allows_multiple"] = json!(true);
        assert_eq!(
            desk(multiple.clone()).answer("answer", &["yes", "no"]),
            act_answer(AnswerAction::Answer, &["yes", "no"])
        );
        assert_eq!(
            desk(multiple.clone()).answer("answer", &["yes", "yes"]),
            refused
        );
        assert_eq!(
            desk(multiple.clone()).answer("answer", &["yes", "maybe"]),
            refused
        );
        assert_eq!(desk(multiple).answer("answer", &[]), refused);
        // A card without options takes an answer without choices, and none with.
        for card in [
            json!({}),
            json!({ "options": [] }),
            json!({ "options": null }),
        ] {
            assert_eq!(
                desk(card.clone()).answer("answer", &[]),
                act_answer(AnswerAction::Answer, &[])
            );
            assert_eq!(desk(card).answer("answer", &["yes"]), refused);
        }
        // `read` and `shred` carry none.
        assert_eq!(
            desk(two_options()).answer("read", &[]),
            act_answer(AnswerAction::Read, &[])
        );
        assert_eq!(
            desk(two_options()).answer("shred", &[]),
            act_answer(AnswerAction::Shred, &[])
        );
        assert_eq!(desk(two_options()).answer("read", &["yes"]), refused);
        assert_eq!(desk(two_options()).answer("shred", &["no"]), refused);
    }

    #[test]
    fn the_gate_reads_the_answers_payload_strictly() {
        let mut desk = desk(two_options());
        let mut with_payload = |payload: &[u8], choices: &[&str]| {
            let bind = AnswerBind {
                object_id: desk.card,
                version_hash: desk.version,
                choices: choices.iter().map(|c| c.as_bytes().to_vec()).collect(),
            };
            let draft = Draft::answer(bind, false, Urgency::Normal, device(3), payload);
            let receipt = desk.world.post(2, session(), &draft);
            let card = desk.card_payload.clone();
            let own = OwnRecord::CardVersion {
                hash: desk.version,
                payload: &card,
            };
            let decision = desk.gate(&receipt, &own);
            // The card is open again for the next case.
            let a = receipt.hash();
            let back = take_back(desk.card, desk.version, a, 3);
            desk.world.post(1, session(), &back);
            decision
        };
        let refused = Decision::Refused(Refusal::BadAnswer);
        assert_eq!(with_payload(b"{}", &["yes"]), refused);
        assert_eq!(
            with_payload(br#"{"answer_action":"approve"}"#, &["yes"]),
            refused
        );
        assert_eq!(with_payload(br#"{"answer_action":7}"#, &["yes"]), refused);
        // What the envelope itself refuses never reaches the gate: a key twice, choices that are not the
        // bind's.
        for payload in [
            &br#"{"answer_action":"answer","answer_action":"read"}"#[..],
            br#"{"answer_action":"answer","choices":["no"]}"#,
            br#"{"answer_action":"answer","choices":"yes"}"#,
        ] {
            let mut desk = self::desk(two_options());
            let bind = AnswerBind {
                object_id: desk.card,
                version_hash: desk.version,
                choices: vec![b"yes".to_vec()],
            };
            let draft = Draft::answer(bind, false, Urgency::Normal, device(3), payload);
            let sealed = desk.world.seal_next(2, session(), &draft);
            assert_eq!(sealed.err(), Some(Error::BadFormat));
        }
        // The same choices, and fields the gate does not know.
        assert_eq!(
            with_payload(
                br#"{"answer_action":"answer","choices":["yes"],"note":"ok","trusted":true}"#,
                &["yes"]
            ),
            act_answer(AnswerAction::Answer, &["yes"])
        );
    }

    #[test]
    fn the_gate_refuses_a_sender_that_is_not_human_now() {
        let mut desk = desk(two_options());
        let draft = desk.answer_draft("answer", &["yes"]);
        let receipt = desk.world.post(2, session(), &draft);
        // Device 2 was a human device when it signed, and has been removed from the room since.
        desk.world.fake.humans_now.remove(&device(2));
        let own = desk.record();
        let decision = command_gate(
            &desk.world.fake,
            &mut GateLog::new(),
            &device(3),
            &receipt.opened().unwrap(),
            &own,
            NOW,
        )
        .unwrap();
        assert_eq!(decision, Decision::Refused(Refusal::NotHuman));
        // The agent's own Chat message is no command to a helper.
        let mut world = World::new();
        world.me = device(4);
        let chat = Draft::session_chat(HELPER_SESSION, device(4), &payload("do this"));
        let receipt = world.post(3, helper_session(), &chat);
        let decision = command_gate(
            &world.fake,
            &mut GateLog::new(),
            &device(4),
            &receipt.opened().unwrap(),
            &OwnRecord::None,
            NOW,
        )
        .unwrap();
        assert_eq!(decision, Decision::Refused(Refusal::NotHuman));
    }

    #[test]
    fn the_gate_takes_chat_addressed_to_this_device_only() {
        let mut world = World::new();
        world.me = device(3);
        let mut log = GateLog::new();
        let mut gate = |world: &World, receipt: &Receipt, me: u8| {
            command_gate(
                &world.fake,
                &mut log,
                &device(me),
                &receipt.opened().unwrap(),
                &OwnRecord::None,
                world.now,
            )
            .unwrap()
        };
        let receipt = world.post(
            2,
            session(),
            &Draft::session_chat(SESSION, device(3), &payload("go")),
        );
        // Another device of the group reads it and does not act.
        assert_eq!(
            gate(&world, &receipt, 4),
            Decision::Refused(Refusal::NotAddressed)
        );
        assert_eq!(gate(&world, &receipt, 3), Decision::Act(Command::Chat));
        assert_eq!(gate(&world, &receipt, 3), Decision::Uncertain);
        // A card's Chat is a Chat too.
        let card = world.post(3, session(), &first(ObjectType::Card));
        let receipt = world.post(
            1,
            session(),
            &Draft::card_chat(id_of(&card), device(3), &payload("why?")),
        );
        assert_eq!(gate(&world, &receipt, 3), Decision::Act(Command::Chat));
        // A register, a human's Note or a board item is no command, whoever it names.
        let receipt = world.post(
            2,
            session(),
            &Draft::register(RegisterId::new([1; 16]), b"{}"),
        );
        assert_eq!(
            gate(&world, &receipt, 3),
            Decision::Refused(Refusal::NotAddressed)
        );
        let outcome = forged(
            &mut world,
            2,
            session(),
            &Draft::register(RegisterId::new([1; 16]), b"{}"),
            |h| h.recipient = device(3),
        );
        // Sealed under the header before the change: the body does not open, so nothing reaches the gate.
        assert!(matches!(
            outcome,
            Outcome::Taken {
                body: Err(Error::DecryptFailed),
                ..
            }
        ));
    }

    #[test]
    fn the_gate_refuses_a_kind_that_is_no_command() {
        // A register that names the agent as its recipient.
        let mut world = World::new();
        world.me = device(3);
        let draft = Draft::register(RegisterId::new([1; 16]), b"{}");
        let slot = world.slot(2, session(), 0);
        let mut header = draft.header(&slot).unwrap();
        header.recipient = device(3);
        let sealed = seal::seal_plaintext(
            header,
            &seal::padded_body(&draft, &slot).unwrap(),
            &key(0),
            [7; 12],
            &signer(2),
        )
        .unwrap();
        let receipt = world.take(&sealed.envelope).unwrap();
        let decision = command_gate(
            &world.fake,
            &mut GateLog::new(),
            &device(3),
            &receipt.opened().unwrap(),
            &OwnRecord::None,
            NOW,
        )
        .unwrap();
        assert_eq!(decision, Decision::Refused(Refusal::NotACommand));
    }

    #[test]
    fn the_gate_refuses_an_old_epoch() {
        let mut desk = desk(two_options());
        let draft = desk.answer_draft("answer", &["yes"]);
        let sealed = desk.world.sign(2, session(), &draft);
        // The Commit comes; the answer of the epoch before arrives within the two minutes and is taken.
        desk.world.fake.commit(&session(), NOW, NOW, |_| {});
        desk.world.now = NOW + LIVE_GRACE_MS;
        let receipt = desk.world.take(&sealed.envelope).unwrap();
        let own = desk.record();
        let gate = |desk: &Desk, now: u64| {
            command_gate(
                &desk.world.fake,
                &mut GateLog::new(),
                &device(3),
                &receipt.opened().unwrap(),
                &own,
                now,
            )
            .unwrap()
        };
        assert_eq!(
            gate(&desk, NOW + LIVE_GRACE_MS),
            act_answer(AnswerAction::Answer, &["yes"])
        );
        // The agent gets to it later than two minutes after the Commit.
        assert_eq!(
            gate(&desk, NOW + LIVE_GRACE_MS + 1),
            Decision::Refused(Refusal::OldEpoch)
        );
        // Two epochs back, however fast.
        let mut later = desk.world.fake.clone();
        later.commit(&session(), NOW, NOW, |_| {});
        let decision = command_gate(
            &later,
            &mut GateLog::new(),
            &device(3),
            &receipt.opened().unwrap(),
            &own,
            NOW,
        )
        .unwrap();
        assert_eq!(decision, Decision::Refused(Refusal::OldEpoch));
    }

    #[test]
    fn the_gate_refuses_an_object_this_device_does_not_own() {
        // The helper's card in the helper session: the opener reads the answer and does not own the card.
        let mut world = World::new();
        world.me = device(3);
        let card_payload = version_payload(&Hash32::ZERO, two_options());
        let draft = Draft::first_version(ObjectType::Card, Urgency::Normal, &card_payload).unwrap();
        let v1 = world.post(4, helper_session(), &draft);
        let bind = AnswerBind {
            object_id: id_of(&v1),
            version_hash: v1.hash(),
            choices: vec![b"yes".to_vec()],
        };
        let answer = Draft::answer(
            bind.clone(),
            false,
            Urgency::Normal,
            device(4),
            br#"{"answer_action":"answer"}"#,
        );
        let receipt = world.post(2, helper_session(), &answer);
        let own = OwnRecord::CardVersion {
            hash: v1.hash(),
            payload: &card_payload,
        };
        let gate = |opened: &Opened<'_>, me: u8| {
            command_gate(
                &world.fake,
                &mut GateLog::new(),
                &device(me),
                opened,
                &own,
                NOW,
            )
            .unwrap()
        };
        // It is addressed to the helper, which owns the card: the opener does nothing with it.
        assert_eq!(
            gate(&receipt.opened().unwrap(), 3),
            Decision::Refused(Refusal::NotAddressed)
        );
        assert_eq!(
            gate(&receipt.opened().unwrap(), 4),
            act_answer(AnswerAction::Answer, &["yes"])
        );
        // Addressed to the opener although the helper owns the card: 9.2 forbids it, so no envelope of this
        // shape reaches the gate through the chain.
        let to_opener = Draft::answer(
            bind,
            false,
            Urgency::Normal,
            device(3),
            br#"{"answer_action":"answer"}"#,
        );
        let mut elsewhere = World::new();
        elsewhere.me = device(3);
        elsewhere.post(4, helper_session(), &draft);
        assert!(elsewhere
            .post(2, helper_session(), &to_opener)
            .opened()
            .is_none());
    }

    #[test]
    fn the_gate_holds_an_answer_against_the_state_before_it() {
        let mut desk = desk(two_options());
        let draft = desk.answer_draft("answer", &["yes"]);
        let receipt = desk.world.post(2, session(), &draft);
        let own = desk.record();
        let gate = |opened: &Opened<'_>, own: &OwnRecord<'_>| {
            command_gate(
                &desk.world.fake,
                &mut GateLog::new(),
                &device(3),
                opened,
                own,
                NOW,
            )
            .unwrap()
        };
        assert_eq!(
            gate(&receipt.opened().unwrap(), &own),
            act_answer(AnswerAction::Answer, &["yes"])
        );
        // The device's record is of another version, of another kind, missing, or not a card body.
        let opened = receipt.opened().unwrap();
        let other = OwnRecord::CardVersion {
            hash: Hash32::new([9; 32]),
            payload: &desk.card_payload,
        };
        assert_eq!(gate(&opened, &other), Decision::Refused(Refusal::NoRecord));
        assert_eq!(
            gate(&opened, &OwnRecord::None),
            Decision::Refused(Refusal::NoRecord)
        );
        let request = OwnRecord::Request {
            hash: desk.version,
            bind: RequestBind {
                request_id: desk.card,
                expires_at: 0,
            },
        };
        assert_eq!(
            gate(&opened, &request),
            Decision::Refused(Refusal::NoRecord)
        );
        for payload in [
            &b"[]"[..],
            br#"{"options":"yes"}"#,
            br#"{"options":[{"label":"x"}]}"#,
        ] {
            let damaged = OwnRecord::CardVersion {
                hash: desk.version,
                payload,
            };
            assert_eq!(
                gate(&opened, &damaged),
                Decision::Refused(Refusal::NoRecord)
            );
        }
    }

    #[test]
    fn the_gate_holds_a_verdict_against_the_request() {
        let mut world = World::new();
        world.me = device(3);
        let expires_at = NOW + 60_000;
        let request = world.post(
            3,
            session(),
            &Draft::request(Urgency::High, expires_at, b"{}"),
        );
        let id = id_of(&request);
        let own = OwnRecord::Request {
            hash: request.hash(),
            bind: RequestBind {
                request_id: id,
                expires_at,
            },
        };
        let receipt = world.post(2, session(), &verdict(id, request.hash(), expires_at, 3));
        let gate = |opened: &Opened<'_>, own: &OwnRecord<'_>, now: u64| {
            command_gate(
                &world.fake,
                &mut GateLog::new(),
                &device(3),
                opened,
                own,
                now,
            )
            .unwrap()
        };
        let opened = receipt.opened().unwrap();
        assert_eq!(
            gate(&opened, &own, NOW),
            Decision::Act(Command::Verdict(Verdict::Allow))
        );
        // The clock: before `expires_at`, not at it.
        assert_eq!(
            gate(&opened, &own, expires_at - 1),
            Decision::Act(Command::Verdict(Verdict::Allow))
        );
        assert_eq!(
            gate(&opened, &own, expires_at),
            Decision::Refused(Refusal::Expired)
        );
        // The device's record: missing, of another request, with another expiry.
        assert_eq!(
            gate(&opened, &OwnRecord::None, NOW),
            Decision::Refused(Refusal::NoRecord)
        );
        let other = OwnRecord::Request {
            hash: Hash32::new([9; 32]),
            bind: RequestBind {
                request_id: id,
                expires_at,
            },
        };
        assert_eq!(
            gate(&opened, &other, NOW),
            Decision::Refused(Refusal::NoRecord)
        );
        let longer = OwnRecord::Request {
            hash: request.hash(),
            bind: RequestBind {
                request_id: id,
                expires_at: expires_at + 1,
            },
        };
        assert_eq!(
            gate(&opened, &longer, NOW),
            Decision::Refused(Refusal::RequestMismatch)
        );
        let other_id = OwnRecord::Request {
            hash: request.hash(),
            bind: RequestBind {
                request_id: ObjectId::new([9; 16]),
                expires_at,
            },
        };
        assert_eq!(
            gate(&opened, &other_id, NOW),
            Decision::Refused(Refusal::RequestMismatch)
        );
        // A deny is a command too.
        let mut world = World::new();
        let request = world.post(
            3,
            session(),
            &Draft::request(Urgency::High, expires_at, b"{}"),
        );
        let id = id_of(&request);
        let bind = VerdictBind {
            request_id: id,
            request_hash: request.hash(),
            expires_at,
            verdict: Verdict::Deny,
        };
        let receipt = world.post(
            1,
            session(),
            &Draft::verdict(bind, Urgency::High, device(3), b"{}"),
        );
        let own = OwnRecord::Request {
            hash: request.hash(),
            bind: RequestBind {
                request_id: id,
                expires_at,
            },
        };
        let decision = command_gate(
            &world.fake,
            &mut GateLog::new(),
            &device(3),
            &receipt.opened().unwrap(),
            &own,
            NOW,
        )
        .unwrap();
        assert_eq!(decision, Decision::Act(Command::Verdict(Verdict::Deny)));
    }

    #[test]
    fn the_gate_holds_a_take_back_against_the_answer_in_force() {
        let mut desk = desk(two_options());
        let draft = desk.answer_draft("answer", &["yes"]);
        let a = desk.world.post(2, session(), &draft);
        let back = take_back(desk.card, desk.version, a.hash(), 3);
        let receipt = desk.world.post(1, session(), &back);
        let gate = |opened: &Opened<'_>| {
            command_gate(
                &desk.world.fake,
                &mut GateLog::new(),
                &device(3),
                opened,
                &OwnRecord::None,
                NOW,
            )
            .unwrap()
        };
        assert_eq!(
            gate(&receipt.opened().unwrap()),
            Decision::Act(Command::TakeBack)
        );
        // A take back that names another answer than the one in force passes 9.2.1, which reads headers only,
        // and stops at the gate.
        let mut desk = self::desk(two_options());
        let draft = desk.answer_draft("answer", &["yes"]);
        desk.world.post(2, session(), &draft);
        let back = take_back(desk.card, desk.version, Hash32::new([9; 32]), 3);
        let receipt = desk.world.post(1, session(), &back);
        let decision = command_gate(
            &desk.world.fake,
            &mut GateLog::new(),
            &device(3),
            &receipt.opened().unwrap(),
            &OwnRecord::None,
            NOW,
        )
        .unwrap();
        assert_eq!(decision, Decision::Refused(Refusal::NotTheAnswer));
    }

    #[test]
    fn nothing_reaches_the_gate_that_failed_a_check() {
        let mut desk = desk(two_options());
        // Forbidden: an answer to a version that is not current.
        let bind = AnswerBind {
            object_id: desk.card,
            version_hash: Hash32::new([9; 32]),
            choices: Vec::new(),
        };
        let draft = Draft::answer(bind, false, Urgency::Normal, device(3), b"{}");
        assert!(desk.world.post(2, session(), &draft).opened().is_none());
        // Pruned.
        let draft = desk.answer_draft("answer", &["yes"]);
        let sealed = desk.world.sign(2, session(), &draft);
        let receipt = desk.world.take(&sealed.envelope.prune().unwrap()).unwrap();
        assert!(receipt.opened().is_none());
        // A void record.
        let sealed = desk.world.sign(
            1,
            session(),
            &Draft::session_chat(SESSION, device(3), b"{}"),
        );
        let receipt = desk
            .world
            .take_as(
                &sealed.envelope.prune().unwrap().encode().unwrap(),
                &Served::Void(Error::WrongEpoch),
                Mode::InOrder,
            )
            .unwrap();
        assert!(receipt.opened().is_none());
    }
}
