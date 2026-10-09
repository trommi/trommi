//! Stored content (section 9) through the public interface: a session's story with one envelope of every
//! kind, against `spec/vectors/envelope.json`, a hub that misbehaves, and random bytes.

use serde_json::Value;
use trommi_core::chain::{hub_take, receive, Mode, Outcome, Served};
use trommi_core::crypto::Secret;
use trommi_core::envelope::{Content, Envelope, ObjectState, MAX_ENVELOPE_LEN};
use trommi_core::ids::DeviceId;
use trommi_core::objects;
use trommi_core::Error;
use trommi_tests::content::{story, Dice, Story, Told, View, STORY_KEY};
use trommi_tests::seal;
use trommi_tests::vectors::envelope::NAME;
use trommi_tests::vectors::{entropy, hex, read, unhex};

fn list<'a>(file: &'a Value, key: &str) -> &'a Vec<Value> {
    file[key].as_array().expect(key)
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().expect(key)
}

fn told() -> Story {
    story(&mut entropy("content envelope story").unwrap()).unwrap()
}

/// Receives stored bytes at a device, in the hub's order, and stores what that changes.
fn take(view: &mut View, me: &DeviceId, bytes: &[u8], time: u64) -> Result<Outcome, Error> {
    let receipt = receive(
        view,
        view,
        &view.chains,
        &view.objects,
        me,
        bytes,
        &Served::Stored,
        Mode::InOrder,
        time,
    )?;
    view.store(&receipt)?;
    Ok(receipt.outcome().clone())
}

#[test]
fn the_story_has_every_kind_and_ends_with_both_objects_closed() {
    let story = told();
    let mut kinds: Vec<u8> = story
        .told
        .iter()
        .map(|told| Envelope::decode(&told.bytes).unwrap().header.subject.kind())
        .collect();
    kinds.sort_unstable();
    kinds.dedup();
    assert_eq!(kinds, vec![1, 2, 3, 4, 5, 6, 7]);

    let mut device = story.view(true);
    for told in &story.told {
        let outcome = take(&mut device, &story.human, &told.bytes, told.time).unwrap();
        let Outcome::Taken { body, .. } = outcome else {
            panic!("{}: {outcome:?}", told.what);
        };
        assert_eq!(body.unwrap().payload(), told.payload, "{}", told.what);
    }
    assert_eq!(device.objects.iter().count(), 2);
    assert!(device
        .objects
        .iter()
        .all(|(_, object)| object.state == ObjectState::Closed));
}

#[test]
fn an_envelope_has_one_encoding_and_its_pruned_form_carries_the_chain() {
    let story = told();
    let key = Secret::new(STORY_KEY);
    for told in &story.told {
        let envelope = Envelope::decode(&told.bytes).unwrap();
        assert_eq!(envelope.encode().unwrap(), told.bytes);
        assert_eq!(envelope.verify().unwrap(), told.hash);
        assert_eq!(envelope.open(&key).unwrap().payload(), told.payload);
        assert_eq!(
            envelope.open(&Secret::new([8; 32])).err(),
            Some(Error::DecryptFailed)
        );

        let pruned = envelope.prune().unwrap();
        let bytes = pruned.encode().unwrap();
        assert!(bytes.len() < told.bytes.len());
        assert_eq!(Envelope::decode(&bytes).unwrap(), pruned);
        assert_eq!(pruned.verify().unwrap(), told.hash);
        assert_eq!(pruned.open(&key).err(), Some(Error::Pruned));
        assert_eq!(pruned.prune().unwrap(), pruned);
        // The sealed body is padded to one of the nine sizes, so its length says little about the payload.
        let Content::Full(sealed) = &envelope.content else {
            panic!("pruned");
        };
        let padded = sealed.len() - 16;
        assert!(
            padded.is_power_of_two() && (256..=65_536).contains(&padded),
            "{}",
            told.what
        );
    }
}

#[test]
fn the_cores_sealing_is_the_formulas_written_a_second_time() {
    let story = told();
    let key = Secret::new(STORY_KEY);
    for told in &story.told {
        let envelope = Envelope::decode(&told.bytes).unwrap();
        let Content::Full(sealed) = &envelope.content else {
            panic!("pruned");
        };
        // The padded body is the version, the bind and the payload, then zeros up to the next size.
        let aad = trommi_core::codec::encode(&envelope.header).unwrap();
        let padded = trommi_core::crypto::aead_open(&key, &envelope.nonce, &aad, sealed).unwrap();
        let body = envelope.open(&key).unwrap();
        let by_hand = seal::padded(
            &seal::body_bytes(2, &seal::bind_bytes(body.bind()).unwrap(), body.payload()).unwrap(),
        );
        assert_eq!(padded, by_hand, "{}", told.what);
        // Sealed and hashed by hand under the same nonce, it is the same envelope up to the signature, which
        // verifies over the same hash.
        let mut again = envelope.clone();
        again.content = Content::Full(
            trommi_core::crypto::aead_seal(&key, &envelope.nonce, &aad, &by_hand).unwrap(),
        );
        assert_eq!(again, envelope, "{}", told.what);
        assert_eq!(again.verify().unwrap(), told.hash);
    }
}

#[test]
fn the_hub_and_every_device_agree_on_the_objects_from_headers_alone() {
    let story = told();
    let mut hub = story.view(false);
    let mut with_bodies = story.view(true);
    let mut pruned_only = story.view(true);
    let mut without_key = story.view(false);
    let mut headers = Vec::new();
    for told in &story.told {
        let receipt = hub_take(
            &hub,
            &hub,
            &hub.chains,
            &hub.objects,
            &told.sender,
            &told.bytes,
            told.time,
        )
        .unwrap();
        hub.store(&receipt).unwrap();
        take(&mut with_bodies, &story.agent, &told.bytes, told.time).unwrap();
        let envelope = Envelope::decode(&told.bytes).unwrap();
        let pruned = envelope.prune().unwrap().encode().unwrap();
        let outcome = take(&mut pruned_only, &story.human, &pruned, told.time).unwrap();
        assert!(
            matches!(
                outcome,
                Outcome::Taken {
                    body: Err(Error::Pruned),
                    ..
                }
            ),
            "{}",
            told.what
        );
        let outcome = take(&mut without_key, &story.human, &told.bytes, told.time).unwrap();
        assert!(
            matches!(
                outcome,
                Outcome::Taken {
                    body: Err(Error::NoKey),
                    ..
                }
            ),
            "{}",
            told.what
        );
        headers.push((envelope.header, told.hash));
    }
    for view in [&with_bodies, &pruned_only, &without_key] {
        assert_eq!(view.objects, hub.objects);
        assert_eq!(view.chains, hub.chains);
    }
    let replayed =
        objects::replay(&hub, headers.iter().map(|(header, hash)| (header, hash))).unwrap();
    for (id, object) in hub.objects.iter() {
        assert_eq!(replayed.get(id), Some(object));
    }
    assert_eq!(replayed.iter().count(), hub.objects.iter().count());
}

#[test]
fn a_hub_that_replays_drops_or_reorders_is_caught_and_consumes_nothing() {
    let story = told();
    let from = |sender: DeviceId| -> Vec<&Told> {
        story
            .told
            .iter()
            .filter(|told| told.sender == sender)
            .collect()
    };
    let agent = from(story.agent);

    // Replayed: an envelope the device already holds.
    let mut device = story.view(true);
    take(&mut device, &story.human, &agent[0].bytes, agent[0].time).unwrap();
    let before = device.chains.clone();
    assert_eq!(
        take(&mut device, &story.human, &agent[0].bytes, agent[0].time).err(),
        Some(Error::Replay)
    );
    assert_eq!(device.chains, before);

    // Dropped: the sender's next envelope is missing, the one after it does not link.
    assert_eq!(
        take(&mut device, &story.human, &agent[2].bytes, agent[2].time).err(),
        Some(Error::Gap)
    );
    assert_eq!(device.chains, before);
    assert_eq!(device.objects.iter().count(), 1);

    // Reordered: the second before the first.
    let mut device = story.view(true);
    assert_eq!(
        take(&mut device, &story.human, &agent[1].bytes, agent[1].time).err(),
        Some(Error::Gap)
    );
    assert_eq!(device.chains.clone(), story.view(true).chains);

    // Handed to another group's device: a device that never processed this group.
    let mut elsewhere = View::new(
        trommi_core::ids::GroupId::room(trommi_tests::content::ROOM),
        &story.leaves(),
        Some(STORY_KEY),
    );
    assert_eq!(
        take(&mut elsewhere, &story.human, &agent[0].bytes, agent[0].time).err(),
        Some(Error::GroupBehind)
    );

    // From a device that is no leaf.
    let mut strangers = View::new(story.group, &story.leaves()[..1], Some(STORY_KEY));
    assert_eq!(
        take(&mut strangers, &story.human, &agent[0].bytes, agent[0].time).err(),
        Some(Error::NotMember)
    );
}

#[test]
fn sampled_single_bit_changes_break_the_envelope() {
    let story = told();
    let mut dice = Dice(entropy("content envelope bits").unwrap());
    for told in &story.told {
        let pruned = Envelope::decode(&told.bytes)
            .unwrap()
            .prune()
            .unwrap()
            .encode()
            .unwrap();
        for original in [&told.bytes, &pruned] {
            for _ in 0..300 {
                let mut bytes = original.clone();
                let at = dice.below(bytes.len() as u64).unwrap() as usize;
                bytes[at] ^= 1 << dice.below(8).unwrap();
                let accepted = Envelope::decode(&bytes).and_then(|envelope| envelope.verify());
                assert!(accepted.is_err(), "{} at byte {at}", told.what);
                let mut device = story.view(true);
                assert!(take(&mut device, &story.human, &bytes, told.time).is_err());
            }
        }
    }
}

#[test]
fn sampled_bytes_never_make_the_decoder_panic_and_what_decodes_encodes_the_same() {
    let story = told();
    let mut dice = Dice(entropy("content envelope fuzz").unwrap());
    let mut seeds: Vec<Vec<u8>> = story.told.iter().map(|told| told.bytes.clone()).collect();
    for told in &story.told {
        seeds.push(
            Envelope::decode(&told.bytes)
                .unwrap()
                .prune()
                .unwrap()
                .encode()
                .unwrap(),
        );
    }
    let key = Secret::new(STORY_KEY);
    let mut decoded = 0u32;
    for round in 0..60_000u32 {
        let mut bytes = if round % 10 == 0 {
            (0..dice.below(300).unwrap())
                .map(|_| dice.below(256).unwrap() as u8)
                .collect()
        } else {
            seeds[dice.below(seeds.len() as u64).unwrap() as usize].clone()
        };
        for _ in 0..dice.below(4).unwrap() {
            if bytes.is_empty() {
                break;
            }
            // Mostly in the header, where the structure is.
            let span = if dice.one_in(3).unwrap() {
                bytes.len()
            } else {
                bytes.len().min(160)
            };
            let at = dice.below(span as u64).unwrap() as usize;
            match dice.below(5).unwrap() {
                0 => bytes[at] = dice.below(256).unwrap() as u8,
                1 => bytes[at] ^= 1 << dice.below(8).unwrap(),
                2 => bytes[at] = [0, 1, 2, 7, 8, 255][dice.below(6).unwrap() as usize],
                3 => {
                    bytes.remove(at);
                }
                _ => bytes.insert(at, dice.below(256).unwrap() as u8),
            }
        }
        if let Ok(envelope) = Envelope::decode(&bytes) {
            decoded += 1;
            assert_eq!(envelope.encode().unwrap(), bytes);
            let _ = envelope.verify();
            let _ = envelope.open(&key);
            let pruned = envelope.prune().unwrap();
            assert_eq!(pruned.hash().unwrap(), envelope.hash().unwrap());
        }
        let mut device = story.view(true);
        let _ = take(&mut device, &story.human, &bytes, story.told[0].time);
    }
    // The round is worth something only if many changed envelopes still decode.
    assert!(decoded > 5_000, "{decoded}");
    let long = vec![1u8; MAX_ENVELOPE_LEN + 1];
    assert_eq!(Envelope::decode(&long).err(), Some(Error::TooLarge));
}

#[test]
fn the_vectors_read_back() {
    let file = read(NAME).unwrap();
    let key = Secret::<32>::from_slice(&unhex(text(&file, "content_key")).unwrap()).unwrap();
    let mut heads: std::collections::BTreeMap<String, (u64, String)> = Default::default();
    for case in list(&file, "envelopes") {
        let full = unhex(text(case, "full")).unwrap();
        let envelope = Envelope::decode(&full).unwrap();
        let hash = envelope.verify().unwrap();
        assert_eq!(hex(hash.as_bytes()), text(case, "envelope_hash"));
        assert_eq!(hex(envelope.header.sender.as_bytes()), text(case, "sender"));
        assert_eq!(
            u64::from(envelope.header.subject.kind()),
            case["kind"].as_u64().unwrap()
        );
        assert_eq!(envelope.header.time, case["time"].as_u64().unwrap());
        assert_eq!(
            hex(envelope.header.group.as_bytes()),
            text(&file, "group_id")
        );
        assert_eq!(
            envelope.open(&key).unwrap().payload(),
            text(case, "payload").as_bytes()
        );
        assert_eq!(
            hex(&envelope.prune().unwrap().encode().unwrap()),
            text(case, "pruned")
        );

        // Each sender's chain: numbers from 1, each naming the hash before it.
        let (seq, prev) = heads
            .get(text(case, "sender"))
            .cloned()
            .unwrap_or((0, hex(&[0; 32])));
        assert_eq!(envelope.header.seq, seq + 1);
        assert_eq!(case["seq"].as_u64().unwrap(), seq + 1);
        assert_eq!(hex(envelope.header.prev.as_bytes()), prev);
        assert_eq!(text(case, "prev"), prev);
        heads.insert(
            text(case, "sender").to_owned(),
            (seq + 1, text(case, "envelope_hash").to_owned()),
        );
    }
    for case in list(&file, "refused") {
        let bytes = unhex(text(case, "bytes")).unwrap();
        let result = match text(case, "at") {
            "decode" => Envelope::decode(&bytes).map(|_| ()),
            _ => Envelope::decode(&bytes).unwrap().verify().map(|_| ()),
        };
        assert_eq!(
            result.expect_err("refused").code(),
            text(case, "code"),
            "{}",
            text(case, "why")
        );
    }
}

/// The envelope's format, binds, padding, hash and signature, case by case (section 9).
mod format {
    use serde_json::json;
    use trommi_core::codec::{self, Writer};
    use trommi_core::crypto::{self, Entropy, Secret, SigningKey};
    use trommi_core::envelope::*;
    use trommi_core::ids::{
        BoardId, DeviceId, FileId, GroupId, Hash32, ObjectId, RegisterId, RoomId, SessionId,
    };
    use trommi_core::Error;
    use trommi_tests::room::{
        core_seal, device, key, payload, seeded, signer, version_payload, NoEntropy,
    };
    use trommi_tests::seal::{self, padded, padded_to};

    fn room_group() -> GroupId {
        GroupId::room(RoomId::new([1; 32]))
    }

    fn session_group() -> GroupId {
        GroupId::session(RoomId::new([1; 32]), SessionId::new([2; 16]))
    }

    fn slot(group: GroupId, sender: u8, seq: u64, prev: Hash32) -> Slot {
        Slot {
            group,
            epoch: 3,
            sender: device(sender),
            seq,
            prev,
            time: 1_700_000_000_000,
        }
    }

    fn sealed(draft: &Draft, slot: &Slot) -> Sealed {
        let sender = (1..=9).find(|n| device(*n) == slot.sender).unwrap();
        core_seal(draft, slot, &signer(sender), &mut seeded(slot.seq)).unwrap()
    }

    /// The core's sealing at `slot` under the key of the slot's epoch.
    fn seal(
        draft: &Draft,
        slot: &Slot,
        content_key: &Secret<32>,
        signer: &SigningKey,
        entropy: &mut dyn Entropy,
    ) -> Result<Sealed, Error> {
        assert_eq!(*content_key, key(slot.epoch));
        core_seal(draft, slot, signer, entropy)
    }

    fn fields(object_ref: Hash32) -> ObjectFields {
        ObjectFields {
            object_id: ObjectId::new([7; 16]),
            object_type: ObjectType::Card,
            state: ObjectState::Open,
            urgency: Urgency::High,
            answered_at: 0,
            object_ref,
        }
    }

    /// One draft of each kind, with the group it belongs in.
    fn one_of_each() -> Vec<(GroupId, Draft)> {
        let version = Hash32::new([9; 32]);
        let answer_bind = AnswerBind {
            object_id: ObjectId::new([7; 16]),
            version_hash: version,
            choices: vec![b"yes".to_vec(), b"later".to_vec()],
        };
        let verdict_bind = VerdictBind {
            request_id: ObjectId::new([8; 16]),
            request_hash: Hash32::new([10; 32]),
            expires_at: 99,
            verdict: Verdict::Deny,
        };
        let take_back_bind = TakeBackBind {
            object_id: ObjectId::new([7; 16]),
            previous_hash: Hash32::new([11; 32]),
            version_hash: version,
        };
        vec![
            (
                session_group(),
                Draft::session_chat(SessionId::new([2; 16]), device(2), &payload("hello")),
            ),
            (
                session_group(),
                Draft::card_chat(ObjectId::new([7; 16]), DeviceId::ZERO, &payload("on it")),
            ),
            (
                room_group(),
                Draft::board_item(BoardId::ALL_DESKS, &payload("stroke")),
            ),
            (
                room_group(),
                Draft::register(RegisterId::new([5; 16]), &payload("register")),
            ),
            (
                session_group(),
                Draft::first_version(
                    ObjectType::Card,
                    Urgency::High,
                    &version_payload(&Hash32::ZERO, json!({ "title": "Ship it?" })),
                )
                .unwrap()
                .with_push()
                .with_files(vec![FileId::new([3; 16]), FileId::new([4; 16])]),
            ),
            (
                session_group(),
                Draft::later_version(
                    ObjectId::new([7; 16]),
                    ObjectType::Artifact,
                    true,
                    Urgency::Low,
                    version,
                    &version_payload(&version, json!({ "title": "Report" })),
                )
                .unwrap(),
            ),
            (
                session_group(),
                Draft::request(Urgency::Critical, 99, &payload("run tests")).with_push(),
            ),
            (
                session_group(),
                Draft::answer(answer_bind, false, Urgency::High, device(2), &payload("a")),
            ),
            (
                session_group(),
                Draft::verdict(verdict_bind, Urgency::Normal, device(2), &payload("v")),
            ),
            (
                session_group(),
                Draft::take_back(take_back_bind, Urgency::High, device(2), &payload("t")),
            ),
        ]
    }

    #[test]
    fn every_kind_round_trips_full_and_pruned() {
        for (index, (group, draft)) in one_of_each().into_iter().enumerate() {
            let slot = slot(group, 1, index as u64 + 1, Hash32::new([index as u8; 32]));
            let sealed = sealed(&draft, &slot);
            let bytes = sealed.envelope.encode().unwrap();
            let decoded = Envelope::decode(&bytes).unwrap();
            assert_eq!(decoded, sealed.envelope);
            assert_eq!(decoded.encode().unwrap(), bytes);
            assert_eq!(decoded.verify().unwrap(), sealed.hash);

            let body = decoded.open(&key(3)).unwrap();
            assert_eq!(body.payload(), draft.body(&slot).unwrap().payload());
            assert_eq!(format!("{body:?}"), "Body(<redacted>)");

            let pruned = decoded.prune().unwrap();
            assert!(pruned.is_pruned());
            assert_eq!(pruned.hash().unwrap(), sealed.hash);
            assert_eq!(pruned.verify().unwrap(), sealed.hash);
            assert_eq!(pruned.open(&key(3)), Err(Error::Pruned));
            let pruned_bytes = pruned.encode().unwrap();
            assert!(pruned_bytes.len() < 400);
            assert_eq!(Envelope::decode(&pruned_bytes).unwrap(), pruned);
            assert_eq!(pruned.prune().unwrap(), pruned);
        }
    }

    #[test]
    fn the_header_is_laid_out_as_the_format_says() {
        let draft = Draft::board_item(BoardId::ALL_DESKS, &payload("x"));
        let sealed = sealed(&draft, &slot(room_group(), 1, 5, Hash32::new([6; 32])));
        let bytes = codec::encode(&sealed.envelope.header).unwrap();
        let expected = [
            &[2u8, 1, 0, 32][..],
            &[1; 32],
            &3u64.to_be_bytes(),
            device(1).as_bytes(),
            &5u64.to_be_bytes(),
            &[6; 32],
            &[0; 32],
            &1_700_000_000_000u64.to_be_bytes(),
            &[2, 3],
            BoardId::ALL_DESKS.as_bytes(),
            &[0],
        ]
        .concat();
        assert_eq!(bytes, expected);

        // An envelope: form, header, nonce, the sealed body behind its length, the signature behind its length.
        let envelope = sealed.envelope.encode().unwrap();
        assert_eq!(envelope[0], 1);
        assert_eq!(&envelope[1..1 + bytes.len()], bytes.as_slice());
        let after_nonce = 1 + bytes.len() + crypto::NONCE_LEN;
        // 272 bytes of ciphertext need a two-byte length: 0x4110.
        assert_eq!(&envelope[after_nonce..after_nonce + 2], [0x41, 0x10]);
        // So do the 64 bytes of the signature: 0x4040.
        assert_eq!(envelope.len(), after_nonce + 2 + 272 + 2 + SIGNATURE_LEN);
        assert_eq!(&envelope[envelope.len() - 66..][..2], [0x40, 0x40]);

        // The object block of the other kinds is 59 bytes.
        let draft = Draft::request(Urgency::Low, 1, &payload("x"));
        let header = draft
            .header(&slot(room_group(), 1, 5, Hash32::ZERO))
            .unwrap();
        assert_eq!(
            codec::encode(&header).unwrap().len(),
            bytes.len() - 18 + OBJECT_BLOCK_LEN
        );
    }

    #[test]
    fn the_kind_sets_the_object_fields_from_the_bind() {
        let drafts = one_of_each();
        let header = |index: usize| {
            let (group, draft) = &drafts[index];
            draft.header(&slot(*group, 1, 4, Hash32::ZERO)).unwrap()
        };
        let object = |index: usize| *header(index).subject.object().unwrap();

        let first = object(4);
        assert_eq!(
            first.object_id,
            object_id(&session_group(), &device(1), 4).unwrap()
        );
        assert_eq!(
            (first.state, first.object_ref, first.answered_at),
            (ObjectState::Open, Hash32::ZERO, 0)
        );
        assert!(header(4).push);
        assert_eq!(header(4).file_ids.len(), 2);

        let later = object(5);
        assert_eq!(
            (later.state, later.object_ref, later.object_type),
            (
                ObjectState::Closed,
                Hash32::new([9; 32]),
                ObjectType::Artifact
            )
        );

        let request = object(6);
        assert_eq!(
            request.object_id,
            object_id(&session_group(), &device(1), 4).unwrap()
        );
        assert_eq!(
            (request.object_type, request.state, request.object_ref),
            (ObjectType::Request, ObjectState::Open, Hash32::ZERO)
        );

        let answer = object(7);
        assert_eq!(
            (answer.state, answer.object_ref, answer.answered_at),
            (
                ObjectState::Answered,
                Hash32::new([9; 32]),
                1_700_000_000_000
            )
        );
        assert_eq!(header(7).recipient, device(2));

        let verdict = object(8);
        assert_eq!(
            (verdict.state, verdict.object_ref, verdict.object_type),
            (
                ObjectState::Closed,
                Hash32::new([10; 32]),
                ObjectType::Request
            )
        );

        let take_back = object(9);
        assert_eq!(
            (take_back.state, take_back.object_ref),
            (ObjectState::Open, Hash32::new([9; 32]))
        );
        assert_eq!(header(3).subject.kind(), 6);
        assert_eq!(header(0).subject.kind(), 1);
        assert!(header(0).subject.object().is_none());
    }

    #[test]
    fn the_object_id_follows_from_group_sender_and_number() {
        let id = object_id(&session_group(), &device(1), 1).unwrap();
        let input = [
            session_group().as_bytes(),
            device(1).as_bytes(),
            &1u64.to_be_bytes(),
        ]
        .concat();
        let hash = crypto::ref_hash("Trommi Object", &input).unwrap();
        assert_eq!(id.as_bytes(), &hash.as_bytes()[..16]);
        assert_ne!(id, object_id(&session_group(), &device(1), 2).unwrap());
        assert_ne!(id, object_id(&session_group(), &device(2), 1).unwrap());
        assert_ne!(id, object_id(&room_group(), &device(1), 1).unwrap());
    }

    #[test]
    fn hash_and_signature_are_the_labelled_ones() {
        let draft = Draft::board_item(BoardId::ALL_DESKS, &payload("x"));
        let sealed = sealed(&draft, &slot(room_group(), 1, 1, Hash32::ZERO));
        let Content::Full(ciphertext) = &sealed.envelope.content else {
            panic!("full form");
        };
        let input = [
            codec::encode(&sealed.envelope.header).unwrap().as_slice(),
            &sealed.envelope.nonce,
            crypto::sha256(ciphertext).unwrap().as_bytes(),
        ]
        .concat();
        assert_eq!(
            sealed.hash,
            crypto::ref_hash("Trommi Envelope", &input).unwrap()
        );
        crypto::verify_with_label(
            device(1).as_bytes(),
            "TrommiEnvelope",
            sealed.hash.as_bytes(),
            &sealed.envelope.signature,
        )
        .unwrap();
        // The body is sealed with the header as associated data.
        let padded = crypto::aead_open(
            &key(3),
            &sealed.envelope.nonce,
            &codec::encode(&sealed.envelope.header).unwrap(),
            ciphertext,
        )
        .unwrap();
        assert_eq!(padded.len(), 256);
        assert_eq!(padded[0], 2);
    }

    #[test]
    fn padding_fills_exactly_the_next_bucket() {
        for (text_len, padded_len) in [
            (10, 256),
            (220, 256),
            (300, 512),
            (900, 1024),
            (40_000, 65_536),
        ] {
            let payload = payload(&"a".repeat(text_len));
            let draft = Draft::board_item(BoardId::ALL_DESKS, &payload);
            let sealed = sealed(&draft, &slot(room_group(), 1, 1, Hash32::ZERO));
            let Content::Full(ciphertext) = &sealed.envelope.content else {
                panic!("full form");
            };
            assert_eq!(ciphertext.len(), padded_len + crypto::TAG_LEN, "{text_len}");
            assert_eq!(sealed.envelope.open(&key(3)).unwrap().payload(), payload);
        }

        // A body of exactly 256 bytes is not padded: version (1), bind length (1), payload length (2), 252.
        let exact = format!("{{\"t\":\"{}\"}}", "a".repeat(244));
        assert_eq!(exact.len(), 252);
        let one_more = format!("{{\"t\":\"{}\"}}", "a".repeat(245));
        for (payload, padded_len) in [(exact, 256), (one_more, 512)] {
            let draft = Draft::board_item(BoardId::ALL_DESKS, payload.as_bytes());
            let sealed = sealed(&draft, &slot(room_group(), 1, 1, Hash32::ZERO));
            let Content::Full(ciphertext) = &sealed.envelope.content else {
                panic!("full form");
            };
            assert_eq!(ciphertext.len(), padded_len + crypto::TAG_LEN);
        }
    }

    /// An envelope whose padded plaintext is `padded`, sealed and signed like a real one.
    fn with_plaintext(subject: Subject, padded: &[u8]) -> Envelope {
        let header = Header {
            push: false,
            group: session_group(),
            epoch: 3,
            sender: device(1),
            seq: 1,
            prev: Hash32::ZERO,
            recipient: DeviceId::ZERO,
            time: 5,
            subject,
            file_ids: Vec::new(),
        };
        let nonce = [7; crypto::NONCE_LEN];
        let aad = codec::encode(&header).unwrap();
        let ciphertext = crypto::aead_seal(&key(3), &nonce, &aad, padded).unwrap();
        let mut envelope = Envelope {
            header,
            nonce,
            content: Content::Full(ciphertext),
            signature: [0; SIGNATURE_LEN],
        };
        let hash = envelope.hash().unwrap();
        envelope.signature = crypto::sign_with_label(&signer(1), "TrommiEnvelope", hash.as_bytes())
            .unwrap()
            .try_into()
            .unwrap();
        envelope
    }

    fn raw_body(version: u8, bind: &[u8], payload: &[u8]) -> Vec<u8> {
        seal::body_bytes(version, bind, payload).unwrap()
    }

    #[test]
    fn open_refuses_bad_padding_binds_and_payloads() {
        let item = Subject::Item(Timeline::SessionChat(SessionId::new([2; 16])));
        let good = raw_body(2, &[], b"{}");
        let open = |subject: Subject, padded: &[u8]| with_plaintext(subject, padded).open(&key(3));

        assert!(open(item, &padded(&good)).is_ok());
        // A larger bucket than the body needs.
        assert_eq!(open(item, &padded_to(&good, 512)), Err(Error::BadFormat));
        // A byte of the padding is not zero.
        let mut dirty = padded(&good);
        dirty[255] = 1;
        assert_eq!(open(item, &dirty), Err(Error::BadFormat));
        let mut dirty = padded(&good);
        dirty[good.len()] = 0x80;
        assert_eq!(open(item, &dirty), Err(Error::BadFormat));
        // Body versions.
        assert_eq!(
            open(item, &padded(&raw_body(3, &[], b"{}"))),
            Err(Error::NewerVersion)
        );
        assert_eq!(
            open(item, &padded(&raw_body(1, &[], b"{}"))),
            Err(Error::BadFormat)
        );
        // Payloads that are not a JSON object.
        for payload in [&b""[..], b"[]", b"1", b"{", b"{} x", b"\xff", b"null"] {
            assert_eq!(
                open(item, &padded(&raw_body(2, &[], payload))),
                Err(Error::BadFormat),
                "{payload:?}"
            );
        }
        // A payload above the limit, in a body that still fits the largest bucket.
        let long = format!("{{\"t\":\"{}\"}}", "a".repeat(60_000));
        assert_eq!(
            open(item, &padded(&raw_body(2, &[], long.as_bytes()))),
            Err(Error::BadFormat)
        );
        // A key twice, at any depth; a schema this version does not know.
        for payload in [
            &br#"{"a":1,"a":2}"#[..],
            br#"{"a":{"b":1,"b":1}}"#,
            br#"{"a":[{"b":1,"b":2}]}"#,
            br#"{"schema_version":"2"}"#,
            br#"{"schema_version":-1}"#,
        ] {
            assert_eq!(
                open(item, &padded(&raw_body(2, &[], payload))),
                Err(Error::BadFormat),
                "{payload:?}"
            );
        }
        assert_eq!(
            open(item, &padded(&raw_body(2, &[], br#"{"schema_version":3}"#))),
            Err(Error::NewerVersion)
        );
        assert!(open(
            item,
            &padded(&raw_body(2, &[], br#"{"schema_version":2,"a":{"a":1}}"#))
        )
        .is_ok());
        // An item carries no bind.
        assert_eq!(
            open(item, &padded(&raw_body(2, &[0; 24], b"{}"))),
            Err(Error::BadFormat)
        );
        // A truncated body.
        assert_eq!(
            open(item, &padded_to(&[2, 5, 1], 256)),
            Err(Error::BadFormat)
        );
        assert_eq!(open(item, &[0; 256]), Err(Error::BadFormat));
    }

    #[test]
    fn open_checks_each_bind_against_its_kind_and_header() {
        let reference = Hash32::new([9; 32]);
        let block = fields(reference);
        let open = |subject: Subject, bind: &Bind| {
            let body = raw_body(2, &seal::bind_bytes(bind).unwrap(), b"{}");
            with_plaintext(subject, &padded(&body)).open(&key(3))
        };
        let answer = AnswerBind {
            object_id: block.object_id,
            version_hash: reference,
            choices: vec![b"a".to_vec()],
        };
        let request = RequestBind {
            request_id: block.object_id,
            expires_at: 7,
        };
        let verdict = VerdictBind {
            request_id: block.object_id,
            request_hash: reference,
            expires_at: 7,
            verdict: Verdict::Allow,
        };
        let take_back = TakeBackBind {
            object_id: block.object_id,
            previous_hash: Hash32::new([4; 32]),
            version_hash: reference,
        };

        let body = open(Subject::Answer(block), &Bind::Answer(answer.clone())).unwrap();
        assert_eq!(body.bind(), &Bind::Answer(answer.clone()));
        let body = open(Subject::Request(block), &Bind::Request(request)).unwrap();
        assert_eq!(body.bind(), &Bind::Request(request));
        let body = open(Subject::Verdict(block), &Bind::Verdict(verdict)).unwrap();
        assert_eq!(body.bind(), &Bind::Verdict(verdict));
        let body = open(Subject::TakeBack(block), &Bind::TakeBack(take_back)).unwrap();
        assert_eq!(body.bind(), &Bind::TakeBack(take_back));

        // An answer whose choices are not text, or not those its payload names.
        let with_payload = |bind: &AnswerBind, payload: &[u8]| {
            let body = raw_body(
                2,
                &seal::bind_bytes(&Bind::Answer(bind.clone())).unwrap(),
                payload,
            );
            with_plaintext(Subject::Answer(block), &padded(&body)).open(&key(3))
        };
        assert!(with_payload(&answer, br#"{"choices":["a"]}"#).is_ok());
        assert_eq!(
            with_payload(&answer, br#"{"choices":["b"]}"#).err(),
            Some(Error::BadFormat)
        );
        assert_eq!(
            with_payload(&answer, br#"{"choices":[]}"#).err(),
            Some(Error::BadFormat)
        );
        assert_eq!(
            with_payload(&answer, br#"{"choices":"a"}"#).err(),
            Some(Error::BadFormat)
        );
        assert_eq!(
            with_payload(&answer, br#"{"choices":null}"#).err(),
            Some(Error::BadFormat)
        );
        let not_text = AnswerBind {
            choices: vec![vec![0xFF]],
            ..answer.clone()
        };
        assert_eq!(with_payload(&not_text, b"{}").err(), Some(Error::BadFormat));
        // A bind of another kind, or none.
        assert_eq!(
            open(Subject::Answer(block), &Bind::TakeBack(take_back)),
            Err(Error::BadFormat)
        );
        assert_eq!(
            open(Subject::Verdict(block), &Bind::None),
            Err(Error::BadFormat)
        );
        assert_eq!(
            open(Subject::Request(block), &Bind::Verdict(verdict)),
            Err(Error::BadFormat)
        );
        // A bind that names another object or another reference than the header.
        let other_object = ObjectId::new([8; 16]);
        let other_hash = Hash32::new([5; 32]);
        let cases = [
            (
                Subject::Answer(block),
                Bind::Answer(AnswerBind {
                    object_id: other_object,
                    ..answer.clone()
                }),
            ),
            (
                Subject::Answer(block),
                Bind::Answer(AnswerBind {
                    version_hash: other_hash,
                    ..answer.clone()
                }),
            ),
            (
                Subject::Request(block),
                Bind::Request(RequestBind {
                    request_id: other_object,
                    ..request
                }),
            ),
            (
                Subject::Verdict(block),
                Bind::Verdict(VerdictBind {
                    request_id: other_object,
                    ..verdict
                }),
            ),
            (
                Subject::Verdict(block),
                Bind::Verdict(VerdictBind {
                    request_hash: other_hash,
                    ..verdict
                }),
            ),
            (
                Subject::TakeBack(block),
                Bind::TakeBack(TakeBackBind {
                    object_id: other_object,
                    ..take_back
                }),
            ),
            (
                Subject::TakeBack(block),
                Bind::TakeBack(TakeBackBind {
                    version_hash: other_hash,
                    ..take_back
                }),
            ),
        ];
        for (subject, bind) in cases {
            assert_eq!(open(subject, &bind), Err(Error::BadFormat), "{bind:?}");
        }
    }

    #[test]
    fn binds_are_read_strictly() {
        let block = fields(Hash32::new([9; 32]));
        let open = |subject: Subject, bind: &[u8]| {
            with_plaintext(subject, &padded(&raw_body(2, bind, b"{}"))).open(&key(3))
        };
        let verdict = [&[7u8; 16][..], &[9; 32], &7u64.to_be_bytes()].concat();
        assert!(open(
            Subject::Verdict(block),
            &[verdict.as_slice(), &[1]].concat()
        )
        .is_ok());
        for byte in [0u8, 3, 255] {
            let bind = [verdict.as_slice(), &[byte]].concat();
            assert_eq!(open(Subject::Verdict(block), &bind), Err(Error::BadFormat));
        }
        // Trailing bytes and missing bytes.
        let bind = [verdict.as_slice(), &[1, 0]].concat();
        assert_eq!(open(Subject::Verdict(block), &bind), Err(Error::BadFormat));
        assert_eq!(
            open(Subject::Verdict(block), &verdict),
            Err(Error::BadFormat)
        );
        assert_eq!(
            open(Subject::Request(block), &[7; 23]),
            Err(Error::BadFormat)
        );
        assert_eq!(
            open(Subject::Request(block), &[7; 25]),
            Err(Error::BadFormat)
        );

        // Choices: at most 64, each at most 256 bytes.
        let answer = |choices: Vec<Vec<u8>>| {
            let mut writer = Writer::new();
            writer.fixed(&[7; 16]);
            writer.fixed(&[9; 32]);
            let choices: Vec<codec::Opaque> = choices.into_iter().map(codec::Opaque).collect();
            writer.vector(&choices).unwrap();
            writer.into_bytes()
        };
        assert!(open(Subject::Answer(block), &answer(vec![vec![1; 256]; 64])).is_ok());
        assert!(open(Subject::Answer(block), &answer(Vec::new())).is_ok());
        assert_eq!(
            open(Subject::Answer(block), &answer(vec![vec![1]; 65])),
            Err(Error::BadFormat)
        );
        assert_eq!(
            open(Subject::Answer(block), &answer(vec![vec![1; 257]])),
            Err(Error::BadFormat)
        );
        // The same limits for a writer.
        for choices in [vec![vec![1u8]; 65], vec![vec![1u8; 257]]] {
            let bind = AnswerBind {
                object_id: block.object_id,
                version_hash: block.object_ref,
                choices,
            };
            let draft = Draft::answer(bind, false, Urgency::Low, device(2), b"{}");
            let result = seal(
                &draft,
                &slot(session_group(), 1, 1, Hash32::ZERO),
                &key(3),
                &signer(1),
                &mut seeded(1),
            );
            assert_eq!(result, Err(Error::TooLarge));
        }
    }

    #[test]
    fn a_version_names_its_predecessor_in_header_and_payload() {
        let previous = Hash32::new([9; 32]);
        let seal_version = |draft: Draft| {
            seal(
                &draft,
                &slot(session_group(), 1, 1, Hash32::ZERO),
                &key(3),
                &signer(1),
                &mut seeded(2),
            )
        };
        let later = |payload: &[u8]| {
            Draft::later_version(
                ObjectId::new([7; 16]),
                ObjectType::Card,
                false,
                Urgency::Low,
                previous,
                payload,
            )
            .unwrap()
        };
        assert!(seal_version(later(&version_payload(&previous, json!({})))).is_ok());
        let cases = [
            version_payload(&Hash32::new([8; 32]), json!({})),
            version_payload(&Hash32::ZERO, json!({})),
            b"{}".to_vec(),
            br#"{"previous_version_hash":null}"#.to_vec(),
            br#"{"previous_version_hash":7}"#.to_vec(),
            br#"{"previous_version_hash":"not base64!"}"#.to_vec(),
            format!(
                r#"{{"previous_version_hash":"{0}","previous_version_hash":"{0}"}}"#,
                previous.to_base64url()
            )
            .into_bytes(),
        ];
        for payload in cases {
            assert_eq!(seal_version(later(&payload)), Err(Error::BadFormat));
        }
        // The first version names zeros.
        let first =
            |payload: &[u8]| Draft::first_version(ObjectType::Card, Urgency::Low, payload).unwrap();
        assert!(seal_version(first(&version_payload(&Hash32::ZERO, json!({})))).is_ok());
        assert_eq!(
            seal_version(first(&version_payload(&previous, json!({})))),
            Err(Error::BadFormat)
        );

        // A reader holds a received version to the same rule.
        let body = raw_body(2, &[], &version_payload(&Hash32::new([8; 32]), json!({})));
        let envelope = with_plaintext(Subject::Version(fields(previous)), &padded(&body));
        assert_eq!(envelope.open(&key(3)), Err(Error::BadFormat));
        let body = raw_body(2, &[], &version_payload(&previous, json!({})));
        let envelope = with_plaintext(Subject::Version(fields(previous)), &padded(&body));
        assert!(envelope.open(&key(3)).is_ok());
    }

    #[test]
    fn drafts_refuse_what_no_kind_allows() {
        assert!(Draft::first_version(ObjectType::Request, Urgency::Low, b"{}").is_err());
        assert!(Draft::later_version(
            ObjectId::new([7; 16]),
            ObjectType::Request,
            false,
            Urgency::Low,
            Hash32::new([1; 32]),
            b"{}"
        )
        .is_err());
        assert!(Draft::later_version(
            ObjectId::new([7; 16]),
            ObjectType::Card,
            false,
            Urgency::Low,
            Hash32::ZERO,
            b"{}"
        )
        .is_err());
        // No header of a reserved kind is written under a known kind's number.
        let mut header = Draft::board_item(BoardId::ALL_DESKS, b"{}")
            .header(&slot(room_group(), 1, 1, Hash32::ZERO))
            .unwrap();
        header.subject = Subject::Reserved {
            kind: 7,
            block: [0; OBJECT_BLOCK_LEN],
        };
        assert_eq!(codec::encode(&header), Err(Error::BadFormat));
    }

    #[test]
    fn seal_refuses_oversize_and_failing_entropy() {
        let slot = slot(room_group(), 1, 1, Hash32::ZERO);
        let try_seal = |draft: &Draft| seal(draft, &slot, &key(3), &signer(1), &mut seeded(1));

        let at_limit = format!("{{\"t\":\"{}\"}}", "a".repeat(MAX_PAYLOAD_LEN - 8));
        assert_eq!(at_limit.len(), MAX_PAYLOAD_LEN);
        let draft = Draft::board_item(BoardId::ALL_DESKS, at_limit.as_bytes());
        let sealed = try_seal(&draft).unwrap();
        assert_eq!(
            sealed.envelope.open(&key(3)).unwrap().payload(),
            at_limit.as_bytes()
        );
        let over = format!("{{\"t\":\"{}\"}}", "a".repeat(MAX_PAYLOAD_LEN - 7));
        let draft = Draft::board_item(BoardId::ALL_DESKS, over.as_bytes());
        assert_eq!(try_seal(&draft), Err(Error::TooLarge));

        // A payload within its limit whose bind pushes the body over the largest padded size.
        let bind = AnswerBind {
            object_id: ObjectId::new([7; 16]),
            version_hash: Hash32::new([9; 32]),
            choices: vec![vec![1; 256]; 64],
        };
        let draft = Draft::answer(bind, false, Urgency::Low, device(2), at_limit.as_bytes());
        let in_session = self::slot(session_group(), 1, 1, Hash32::ZERO);
        assert_eq!(
            seal(&draft, &in_session, &key(3), &signer(1), &mut seeded(1)),
            Err(Error::TooLarge)
        );

        let files = |n: usize| {
            Draft::board_item(BoardId::ALL_DESKS, b"{}").with_files(vec![FileId::new([1; 16]); n])
        };
        assert_eq!(
            try_seal(&files(255))
                .unwrap()
                .envelope
                .header
                .file_ids
                .len(),
            255
        );
        assert_eq!(try_seal(&files(256)), Err(Error::TooLarge));

        let draft = Draft::board_item(BoardId::ALL_DESKS, b"{}");
        assert_eq!(
            seal(&draft, &slot, &key(3), &signer(1), &mut NoEntropy),
            Err(Error::Entropy)
        );
        let draft = Draft::board_item(BoardId::ALL_DESKS, b"not json");
        assert_eq!(try_seal(&draft), Err(Error::BadFormat));
    }

    #[test]
    fn nonces_are_fresh_and_the_wrong_key_or_header_opens_nothing() {
        let draft = Draft::board_item(BoardId::ALL_DESKS, &payload("x"));
        let slot = slot(room_group(), 1, 1, Hash32::ZERO);
        let mut entropy = seeded(42);
        let first = seal(&draft, &slot, &key(3), &signer(1), &mut entropy).unwrap();
        let second = seal(&draft, &slot, &key(3), &signer(1), &mut entropy).unwrap();
        assert_ne!(first.envelope.nonce, second.envelope.nonce);
        assert_ne!(first.hash, second.hash);

        assert_eq!(first.envelope.open(&key(4)), Err(Error::DecryptFailed));
        let mut moved = first.envelope.clone();
        moved.header.time += 1;
        assert_eq!(moved.open(&key(3)), Err(Error::DecryptFailed));
        let mut moved = first.envelope.clone();
        moved.nonce[0] ^= 1;
        assert_eq!(moved.open(&key(3)), Err(Error::DecryptFailed));
        let mut moved = first.envelope.clone();
        if let Content::Full(ciphertext) = &mut moved.content {
            ciphertext[0] ^= 1;
        }
        assert_eq!(moved.open(&key(3)), Err(Error::DecryptFailed));
    }

    #[test]
    fn any_change_breaks_the_signature() {
        let draft = Draft::session_chat(SessionId::new([2; 16]), device(2), &payload("x"));
        let sealed = sealed(&draft, &slot(session_group(), 1, 1, Hash32::ZERO));
        let bytes = sealed.envelope.encode().unwrap();
        let pruned = sealed.envelope.prune().unwrap().encode().unwrap();
        for original in [bytes, pruned] {
            let mut refused = 0;
            for index in (0..original.len()).step_by(3) {
                let mut changed = original.clone();
                changed[index] ^= 0x01;
                match Envelope::decode(&changed) {
                    Ok(envelope) => {
                        assert_eq!(envelope.verify(), Err(Error::BadSignature), "byte {index}");
                    }
                    Err(error) => {
                        assert!(
                            matches!(error, Error::BadFormat | Error::NewerVersion),
                            "byte {index}: {error}"
                        );
                        refused += 1;
                    }
                }
            }
            assert!(refused > 0);
        }
        let mut other = sealed.envelope.clone();
        other.header.sender = device(2);
        assert_eq!(other.verify(), Err(Error::BadSignature));
    }

    /// The decoding of an item in a session group after `change` to its encoding.
    fn changed(change: impl FnOnce(&mut Vec<u8>)) -> Result<Envelope, Error> {
        let draft = Draft::session_chat(SessionId::new([2; 16]), device(2), &payload("x"));
        let sealed = sealed(&draft, &slot(session_group(), 1, 1, Hash32::ZERO));
        let mut bytes = sealed.envelope.encode().unwrap();
        change(&mut bytes);
        Envelope::decode(&bytes)
    }

    #[test]
    fn decode_refuses_versions_flags_kinds_and_values() {
        // Offsets: form 0, version 1, kind 2, flags 3, group length 4, group 5..53, epoch 53, sender 61,
        // seq 93, prev 101, recipient 133, time 165, timeline kind 173, scope 174, ref 175, file ids 191.
        assert!(changed(|_| {}).is_ok());
        assert_eq!(changed(|b| b[1] = 3), Err(Error::NewerVersion));
        assert_eq!(changed(|b| b[1] = 255), Err(Error::NewerVersion));
        assert_eq!(changed(|b| b[1] = 1), Err(Error::BadFormat));
        assert_eq!(changed(|b| b[1] = 0), Err(Error::BadFormat));
        assert_eq!(changed(|b| b[2] = 0), Err(Error::BadFormat));
        for flags in [2u8, 3, 0x80, 0xFF] {
            assert_eq!(changed(|b| b[3] = flags), Err(Error::BadFormat));
        }
        assert!(changed(|b| b[3] = 1).unwrap().header.push);
        // The form.
        assert_eq!(changed(|b| b[0] = 0), Err(Error::BadFormat));
        assert_eq!(changed(|b| b[0] = 3), Err(Error::BadFormat));
        // A number of zero.
        assert_eq!(
            changed(|b| b[93..101].copy_from_slice(&[0; 8])),
            Err(Error::BadFormat)
        );
        // Timeline kinds and scopes: only chat/card, chat/session and board/desk exist.
        for (kind, scope) in [(0, 2), (3, 2), (1, 0), (1, 3), (2, 1), (2, 2), (2, 4)] {
            assert_eq!(
                changed(|b| {
                    b[173] = kind;
                    b[174] = scope;
                }),
                Err(Error::BadFormat),
                "{kind}/{scope}"
            );
        }
        for (kind, scope) in [(1, 1), (1, 2), (2, 3)] {
            assert!(changed(|b| {
                b[173] = kind;
                b[174] = scope;
            })
            .is_ok());
        }
        // A group id that is neither 32 nor 48 bytes.
        assert_eq!(changed(|b| b[4] = 47), Err(Error::BadFormat));
    }

    #[test]
    fn decode_refuses_object_values_outside_the_table() {
        let header = Header {
            push: false,
            group: session_group(),
            epoch: 0,
            sender: device(1),
            seq: 1,
            prev: Hash32::ZERO,
            recipient: DeviceId::ZERO,
            time: 0,
            subject: Subject::Answer(fields(Hash32::new([9; 32]))),
            file_ids: Vec::new(),
        };
        let encoded = codec::encode(&header).unwrap();
        assert_eq!(codec::decode::<Header>(&encoded, 4096).unwrap(), header);
        // The object block starts at 172: id (16), type 188, state 189, urgency 190.
        let raw = |offset: usize, value: u8| {
            let mut bytes = encoded.clone();
            bytes[offset] = value;
            codec::decode::<Header>(&bytes, 4096)
        };
        for value in [0u8, 5, 255] {
            assert_eq!(raw(188, value), Err(Error::BadFormat), "type {value}");
        }
        for value in [0u8, 4, 255] {
            assert_eq!(raw(189, value), Err(Error::BadFormat), "state {value}");
        }
        for value in [4u8, 255] {
            assert_eq!(raw(190, value), Err(Error::BadFormat), "urgency {value}");
        }
        for value in 1..=4u8 {
            assert!(raw(188, value).is_ok());
        }
        for value in 1..=3u8 {
            assert!(raw(189, value).is_ok());
        }
        // `answered_at` is 0 while open.
        let mut answered = encoded.clone();
        answered[198] = 1;
        assert_eq!(
            codec::decode::<Header>(&answered, 4096),
            Err(Error::BadFormat)
        );
        answered[189] = 2;
        assert!(codec::decode::<Header>(&answered, 4096).is_ok());
        for value in 0..=3u8 {
            assert!(raw(190, value).is_ok());
        }
        assert_eq!(ObjectType::from_byte(4), Ok(ObjectType::Artifact));
        assert_eq!(Verdict::from_byte(2), Ok(Verdict::Deny));
        assert_eq!(Urgency::Critical.byte(), 3);
    }

    #[test]
    fn reserved_kinds_parse_with_the_object_block_and_open_nothing() {
        let header = Header {
            push: true,
            group: room_group(),
            epoch: 3,
            sender: device(1),
            seq: 2,
            prev: Hash32::new([1; 32]),
            recipient: DeviceId::ZERO,
            time: 9,
            // Values no known kind allows: a newer Trommi may give them a meaning.
            subject: Subject::Reserved {
                kind: 8,
                block: [0xEE; OBJECT_BLOCK_LEN],
            },
            file_ids: vec![FileId::new([3; 16])],
        };
        for kind in [8u8, 100, 255] {
            let mut header = header.clone();
            header.subject = Subject::Reserved {
                kind,
                block: [0xEE; OBJECT_BLOCK_LEN],
            };
            let bytes = codec::encode(&header).unwrap();
            let decoded = codec::decode::<Header>(&bytes, 4096).unwrap();
            assert_eq!(decoded, header);
            assert!(decoded.subject.is_reserved());
            assert_eq!(decoded.subject.kind(), kind);
            assert!(decoded.subject.object().is_none());
        }
        let envelope = with_plaintext(header.subject, &padded(&raw_body(2, &[], b"{}")));
        envelope.verify().unwrap();
        assert_eq!(envelope.open(&key(3)), Err(Error::NewerVersion));
        // A known kind with the same block is refused: its values are judged.
        let mut bytes = codec::encode(&header).unwrap();
        bytes[1] = 2;
        assert_eq!(codec::decode::<Header>(&bytes, 4096), Err(Error::BadFormat));
    }

    #[test]
    fn decode_refuses_truncated_trailing_and_oversize_input() {
        let draft = Draft::first_version(
            ObjectType::Card,
            Urgency::High,
            &version_payload(&Hash32::ZERO, json!({})),
        )
        .unwrap()
        .with_files(vec![FileId::new([3; 16])]);
        let sealed = sealed(&draft, &slot(session_group(), 1, 1, Hash32::ZERO));
        for bytes in [
            sealed.envelope.encode().unwrap(),
            sealed.envelope.prune().unwrap().encode().unwrap(),
        ] {
            for len in 0..bytes.len() {
                assert!(Envelope::decode(&bytes[..len]).is_err(), "cut at {len}");
            }
            let mut longer = bytes.clone();
            longer.push(0);
            assert_eq!(Envelope::decode(&longer), Err(Error::BadFormat));
        }
        assert_eq!(
            Envelope::decode(&vec![0; MAX_ENVELOPE_LEN + 1]),
            Err(Error::TooLarge)
        );
        assert_eq!(Envelope::decode(&[]), Err(Error::BadFormat));
    }

    #[test]
    fn decode_refuses_bad_ciphertext_lengths_signatures_and_file_lists() {
        let draft = Draft::board_item(BoardId::ALL_DESKS, &payload("x"));
        let sealed = sealed(&draft, &slot(room_group(), 1, 1, Hash32::ZERO));
        let rebuilt = |content: Content| {
            let mut envelope = sealed.envelope.clone();
            envelope.content = content;
            Envelope::decode(&envelope.encode().unwrap())
        };
        for len in [0usize, 15, 16, 271, 273, 300, 512, 65_536, 65_551] {
            assert_eq!(
                rebuilt(Content::Full(vec![0; len])),
                Err(Error::BadFormat),
                "{len}"
            );
        }
        for len in [272usize, 528, 65_552] {
            assert!(rebuilt(Content::Full(vec![0; len])).is_ok(), "{len}");
        }
        // Longer than any padded body: read, marked, and never opened.
        let oversize = rebuilt(Content::Full(vec![0; 65_553])).unwrap();
        assert!(oversize.is_oversize());
        assert_eq!(oversize.open(&key(3)), Err(Error::TooLarge));

        // A signature of another length.
        let bytes = sealed.envelope.encode().unwrap();
        let front = &bytes[..bytes.len() - 66];
        for len in [0usize, 63, 65] {
            let mut writer = Writer::new();
            writer.fixed(front);
            writer.opaque(&vec![5; len]).unwrap();
            let changed = writer.into_bytes();
            assert_eq!(Envelope::decode(&changed), Err(Error::BadFormat), "{len}");
        }

        // File ids: whole ids only, at most 255.
        let header_with_files = |content: &[u8]| {
            let mut bytes = codec::encode(&sealed.envelope.header).unwrap();
            bytes.pop();
            let mut writer = Writer::new();
            writer.opaque(content).unwrap();
            bytes.extend(writer.into_bytes());
            codec::decode::<Header>(&bytes, 8192)
        };
        assert_eq!(header_with_files(&[1; 15]), Err(Error::BadFormat));
        assert_eq!(header_with_files(&[1; 17]), Err(Error::BadFormat));
        assert_eq!(
            header_with_files(&[1; 16 * 255]).unwrap().file_ids.len(),
            255
        );
        assert_eq!(header_with_files(&[1; 16 * 256]), Err(Error::BadFormat));
        let mut too_many = sealed.envelope.header.clone();
        too_many.file_ids = vec![FileId::new([1; 16]); 256];
        assert_eq!(codec::encode(&too_many), Err(Error::TooLarge));
        let mut zero = sealed.envelope.header.clone();
        zero.seq = 0;
        assert_eq!(codec::encode(&zero), Err(Error::BadFormat));
    }

    #[test]
    fn hostile_bytes_never_panic() {
        let mut entropy = seeded(7);
        let draft = Draft::request(Urgency::Low, 5, &payload("x"));
        let valid = sealed(&draft, &slot(session_group(), 1, 1, Hash32::ZERO))
            .envelope
            .encode()
            .unwrap();
        for round in 0..3000usize {
            let bytes = if round % 2 == 0 {
                let mut bytes = valid.clone();
                let mut places = [0u8; 8];
                entropy.fill(&mut places).unwrap();
                for pair in places.chunks(2) {
                    let index = (usize::from(pair[0]) * 3) % bytes.len().min(400);
                    bytes[index] = pair[1];
                }
                bytes
            } else {
                let mut len = [0u8; 2];
                entropy.fill(&mut len).unwrap();
                let mut bytes = vec![0u8; usize::from(u16::from_be_bytes(len)) % 600];
                entropy.fill(&mut bytes).unwrap();
                bytes
            };
            if let Ok(envelope) = Envelope::decode(&bytes) {
                assert_eq!(envelope.encode().unwrap(), bytes);
                let _ = envelope.verify();
                let _ = envelope.open(&key(3));
                let _ = envelope.prune();
            }
        }
    }
}
