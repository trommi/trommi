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
fn any_changed_bit_breaks_the_envelope() {
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
fn no_bytes_make_the_decoder_panic_and_what_decodes_encodes_the_same() {
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
