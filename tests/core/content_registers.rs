//! Registers (section 9.3) against a model written from the specification's text: random values by three
//! devices of a session, judged by the core and by the model, must leave the same current values; and a
//! register payload under random bytes.

use std::collections::BTreeMap;
use trommi_core::chain::Role;
use trommi_core::envelope::{Header, Subject};
use trommi_core::ids::{DeviceId, GroupId, Hash32, RegisterId, SessionId};
use trommi_core::registers::{counted_lamport, Registers, Value, MAX_VALUE_LEN};
use trommi_core::Error;
use trommi_tests::content::{Dice, View, ROOM};
use trommi_tests::vectors::entropy;

/// The stamp a value counts with (lamport, sender, envelope number), and the value.
type Best = ((u64, DeviceId, u64), Option<String>);

/// 9.3.3 for a session group: who owns a name, and whether each device has its own value of it.
fn owned_by(name: &str, role: Role, sender: &DeviceId) -> Option<bool> {
    let agent = role != Role::Human;
    if name == "heads" {
        Some(true)
    } else if let Some(device) = name.strip_prefix("device/") {
        (device == sender.to_base64url()).then_some(false)
    } else if name == "goals" {
        (!agent).then_some(false)
    } else if name == "profile"
        || name == "heard"
        || name.starts_with("status_line/")
        || name.starts_with("alert/")
    {
        agent.then_some(false)
    } else {
        None
    }
}

#[test]
fn random_values_leave_the_current_ones_the_specification_describes() {
    let mut dice = Dice(entropy("content registers model").unwrap());
    let group = GroupId::session(ROOM, SessionId::new([2; 16]));
    let devices = [
        (DeviceId::new([0x48; 32]), Role::Human),
        (DeviceId::new([0x49; 32]), Role::Human),
        (DeviceId::new([0x41; 32]), Role::Agent),
    ];
    let view = View::new(group, &devices, None);
    let mut names: Vec<String> = [
        "heads",
        "goals",
        "profile",
        "heard",
        "status_line/a",
        "status_line/b",
        "crown",
        "desk/x",
    ]
    .iter()
    .map(|name| (*name).to_owned())
    .collect();
    names.extend(
        devices
            .iter()
            .map(|(device, _)| format!("device/{}", device.to_base64url())),
    );
    let values = ["1", "\"x\"", "{\"a\":[1,2]}", "{}"];
    let (mut taken, mut forbidden) = (0u32, 0u32);

    for _ in 0..200 {
        let mut registers = Registers::new();
        // The model: per name, and per device where each has its own, the best stamp and its value.
        let mut current: BTreeMap<(String, Option<DeviceId>), Best> = BTreeMap::new();
        let mut largest = 0u64;
        let mut ids: BTreeMap<(DeviceId, String), RegisterId> = BTreeMap::new();
        let mut seqs: BTreeMap<DeviceId, u64> = BTreeMap::new();
        for _ in 0..80 {
            let (sender, role) = devices[dice.below(3).unwrap() as usize];
            let name = names[dice.below(names.len() as u64).unwrap() as usize].clone();
            let value = (!dice.one_in(5).unwrap())
                .then(|| values[dice.below(4).unwrap() as usize].to_owned());
            let lamport = match dice.below(12).unwrap() {
                0 => dice.below(largest + 1).unwrap(),
                1 => largest,
                2 => largest + (1 << 24),
                3 => largest + (1 << 24) + 1,
                4 => (1 << 48) + 1,
                5 => 1 << 48,
                6 => u64::MAX,
                _ => largest + 1,
            };
            let seq = seqs.entry(sender).or_insert(0);
            *seq += 1;
            let register = *ids
                .entry((sender, name.clone()))
                .or_insert_with(|| RegisterId::new(dice.bytes().unwrap()));
            let header = Header {
                push: false,
                group,
                epoch: 0,
                sender,
                seq: *seq,
                prev: Hash32::ZERO,
                recipient: DeviceId::ZERO,
                time: 1,
                subject: Subject::Register(register),
                file_ids: Vec::new(),
            };
            let payload = Value {
                name: name.clone(),
                value: value.clone(),
                lamport,
            }
            .payload()
            .unwrap();
            assert_eq!(
                Value::parse(&payload).unwrap(),
                Value {
                    name: name.clone(),
                    value: value.clone(),
                    lamport
                }
            );

            match (
                owned_by(&name, role, &sender),
                registers.judge(&view, &header, &payload),
            ) {
                (Some(each), Ok(update)) => {
                    registers.apply(&update).unwrap();
                    assert!(registers.apply(&update).is_err());
                    // 9.3.2: above 2^48, or more than 2^24 above the largest seen, counts as 0.
                    let counted = if lamport > 1 << 48 || lamport > largest + (1 << 24) {
                        0
                    } else {
                        lamport
                    };
                    assert_eq!(counted, counted_lamport(lamport, largest));
                    largest = largest.max(counted);
                    let stamp = (counted, sender, *seq);
                    let key = (name.clone(), each.then_some(sender));
                    if current.get(&key).is_none_or(|(held, _)| *held < stamp) {
                        current.insert(key, (stamp, value));
                    }
                    taken += 1;
                }
                (None, Err(Error::Forbidden)) => forbidden += 1,
                (expected, got) => {
                    panic!("{name} by {role:?}: the rule says {expected:?}, the core {got:?}")
                }
            }
            assert_eq!(registers.largest_lamport(), largest);
            for ((name, of), (_, value)) in &current {
                let held = match of {
                    Some(device) => registers.get_of(name, device),
                    None => registers.get(name),
                };
                assert_eq!(held, value.as_deref(), "{name}");
            }
            assert_eq!(
                Registers::from_bytes(&registers.to_bytes().unwrap()).unwrap(),
                registers
            );
        }
    }
    assert!(taken > 3_000 && forbidden > 3_000, "{taken} {forbidden}");
}

#[test]
fn a_writer_keeps_one_id_per_name_and_one_name_per_id() {
    let group = GroupId::session(ROOM, SessionId::new([2; 16]));
    let agent = DeviceId::new([0x41; 32]);
    let view = View::new(group, &[(agent, Role::Agent)], None);
    let header = |seq: u64, register: u8| Header {
        push: false,
        group,
        epoch: 0,
        sender: agent,
        seq,
        prev: Hash32::ZERO,
        recipient: DeviceId::ZERO,
        time: 1,
        subject: Subject::Register(RegisterId::new([register; 16])),
        file_ids: Vec::new(),
    };
    let value = |name: &str| {
        Value {
            name: name.to_owned(),
            value: Some("1".to_owned()),
            lamport: 1,
        }
        .payload()
        .unwrap()
    };
    let mut registers = Registers::new();
    let update = registers
        .judge(&view, &header(1, 1), &value("profile"))
        .unwrap();
    registers.apply(&update).unwrap();
    // The hub, which sees only ids, must be able to tell a name's values together.
    assert_eq!(
        registers.judge(&view, &header(2, 1), &value("heard")).err(),
        Some(Error::BadFormat)
    );
    assert_eq!(
        registers
            .judge(&view, &header(2, 2), &value("profile"))
            .err(),
        Some(Error::BadFormat)
    );
    assert!(registers
        .judge(&view, &header(2, 1), &value("profile"))
        .is_ok());
}

#[test]
fn no_bytes_make_the_reader_panic_and_what_is_read_is_written_the_same() {
    let mut dice = Dice(entropy("content registers fuzz").unwrap());
    let seeds: Vec<Vec<u8>> = [
        r#"{"name":"goals","value":{"desk_id":"d","goals":"Ship"},"lamport":7}"#,
        r#"{"name":"crown","value":null,"lamport":0}"#,
        r#"{"name":"status_line/a","value":[1,2.5,"x",true],"lamport":281474976710656}"#,
        r#"{"lamport":1,"value":"v","name":"kit","later":1}"#,
    ]
    .iter()
    .map(|text| text.as_bytes().to_vec())
    .collect();
    for seed in &seeds {
        assert!(Value::parse(seed).is_ok());
    }
    let mut read = 0u32;
    for round in 0..40_000u32 {
        let mut bytes = if round % 8 == 0 {
            (0..dice.below(120).unwrap())
                .map(|_| dice.below(256).unwrap() as u8)
                .collect()
        } else {
            seeds[dice.below(seeds.len() as u64).unwrap() as usize].clone()
        };
        for _ in 0..dice.below(4).unwrap() {
            if bytes.is_empty() {
                break;
            }
            let at = dice.below(bytes.len() as u64).unwrap() as usize;
            match dice.below(3).unwrap() {
                0 => bytes[at] = dice.below(256).unwrap() as u8,
                1 => {
                    bytes.remove(at);
                }
                _ => bytes.insert(
                    at,
                    b"0123456789-[]{}\",:.e"[dice.below(20).unwrap() as usize],
                ),
            }
        }
        if let Ok(value) = Value::parse(&bytes) {
            read += 1;
            // A value reads back as it was read, unless writing refuses it.
            if let Ok(payload) = value.payload() {
                assert_eq!(Value::parse(&payload).unwrap(), value);
            }
        }
    }
    assert!(read > 2_000, "{read}");

    // A key twice is refused, also inside the value; a value above the limit is too large.
    assert_eq!(
        Value::parse(br#"{"name":"a","name":"b","value":1,"lamport":1}"#).err(),
        Some(Error::BadFormat)
    );
    assert_eq!(
        Value::parse(br#"{"name":"a","value":{"k":1,"k":2},"lamport":1}"#).err(),
        Some(Error::BadFormat)
    );
    let long = format!(
        r#"{{"name":"goals","value":"{}","lamport":1}}"#,
        "x".repeat(MAX_VALUE_LEN)
    );
    assert_eq!(Value::parse(long.as_bytes()).err(), Some(Error::TooLarge));
}
