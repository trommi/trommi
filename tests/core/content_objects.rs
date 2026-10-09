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
