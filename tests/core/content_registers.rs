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
        || name
            .strip_prefix("status_line/")
            .is_some_and(|id| !id.is_empty())
        || name.strip_prefix("alert/").is_some_and(|id| !id.is_empty())
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
        "status_line/",
        "alert/",
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

/// Register values, the lamport rule, names and their owners, case by case (section 9.3).
mod rules {
    use serde_json::json;
    use std::collections::BTreeMap;
    use trommi_core::chain::{Receipt, Role};
    use trommi_core::crypto::SeededEntropy;
    use trommi_core::envelope::{self, Draft, Subject};
    use trommi_core::ids::{GroupId, RegisterId};
    use trommi_core::registers::*;
    use trommi_core::Error;
    use trommi_tests::room::*;

    fn value(name: &str, value: Option<&str>, lamport: u64) -> Vec<u8> {
        Value {
            name: name.into(),
            value: value.map(Into::into),
            lamport,
        }
        .payload()
        .unwrap()
    }

    /// A receiver with the registers it has taken, per group.
    struct Scene {
        world: World,
        registers: BTreeMap<GroupId, Registers>,
    }

    impl Scene {
        fn new() -> Self {
            Self {
                world: World::new(),
                registers: BTreeMap::new(),
            }
        }

        fn registers(&self, group: &GroupId) -> Registers {
            self.registers.get(group).cloned().unwrap_or_default()
        }

        /// A register envelope of device `n` through the chain and into the registers.
        fn set_with_id(
            &mut self,
            n: u8,
            group: GroupId,
            id: RegisterId,
            payload: &[u8],
        ) -> Result<Update, Error> {
            let draft = Draft::register(id, payload);
            let receipt: Receipt = self.world.post(n, group, &draft);
            let opened = receipt.opened().ok_or(Error::Forbidden)?;
            let registers = self.registers.entry(group).or_default();
            let update =
                registers.judge(&self.world.fake, opened.header(), opened.body().payload())?;
            registers.apply(&update)?;
            Ok(update)
        }

        /// The same, with one register id per sender and name.
        fn set(
            &mut self,
            n: u8,
            group: GroupId,
            name: &str,
            text: Option<&str>,
            lamport: u64,
        ) -> Result<Update, Error> {
            let hash = trommi_core::crypto::sha256(format!("{n}{name}").as_bytes()).unwrap();
            let id = RegisterId::from_slice(&hash.as_bytes()[..16]).unwrap();
            self.set_with_id(n, group, id, &value(name, text, lamport))
        }
    }

    #[test]
    fn a_value_round_trips_through_its_payload() {
        let cases = [
            Value {
                name: "desk/abc".into(),
                value: Some(r#"{"name":"Work","order":2}"#.into()),
                lamport: 7,
            },
            Value {
                name: "crown".into(),
                value: None,
                lamport: 0,
            },
            Value {
                name: "kit".into(),
                value: Some("[1,2,3]".into()),
                lamport: MAX_LAMPORT,
            },
            Value {
                name: "heard".into(),
                value: Some("\"text\"".into()),
                lamport: u64::MAX,
            },
        ];
        for case in cases {
            let payload = case.payload().unwrap();
            assert_eq!(Value::parse(&payload).unwrap(), case);
            assert!(envelope::Body::new(envelope::Bind::None, &payload).is_ok());
        }
        // The payload is the object the format names.
        let payload = value("crown", Some(r#"{ "a" : 1 }"#), 3);
        let parsed: serde_json::Value = serde_json::from_slice(&payload).unwrap();
        assert_eq!(
            parsed,
            json!({ "name": "crown", "value": { "a": 1 }, "lamport": 3 })
        );
        // No value is printed.
        let secret = Value {
            name: "board_snapshot/x".into(),
            value: Some(r#"{"file_key":"c2VjcmV0"}"#.into()),
            lamport: 1,
        };
        assert!(!format!("{secret:?}").contains("c2VjcmV0"));
        // A reader ignores fields it does not know.
        let extra = br#"{"name":"crown","value":1,"lamport":2,"schema_version":2,"x":[]}"#;
        assert_eq!(Value::parse(extra).unwrap().value.as_deref(), Some("1"));
    }

    #[test]
    fn a_payload_that_is_no_register_value_is_refused() {
        let cases: [&[u8]; 14] = [
            b"",
            b"[]",
            br#"["crown",1,2]"#,
            b"{}",
            br#"{"name":"crown","lamport":1}"#,
            br#"{"name":"crown","value":1}"#,
            br#"{"value":1,"lamport":1}"#,
            br#"{"name":7,"value":1,"lamport":1}"#,
            br#"{"name":"crown","value":1,"lamport":-1}"#,
            br#"{"name":"crown","value":1,"lamport":1.5}"#,
            br#"{"name":"crown","value":1,"lamport":"1"}"#,
            br#"{"name":"crown","value":1,"lamport":18446744073709551616}"#,
            br#"{"name":"crown","name":"kit","value":1,"lamport":1}"#,
            br#"{"name":"crown","value":1,"lamport":1} x"#,
        ];
        for payload in cases {
            assert_eq!(
                Value::parse(payload),
                Err(Error::BadFormat),
                "{}",
                String::from_utf8_lossy(payload)
            );
        }
        // A writer's value that is not JSON.
        let bad = Value {
            name: "crown".into(),
            value: Some("{".into()),
            lamport: 1,
        };
        assert_eq!(bad.payload(), Err(Error::BadFormat));
    }

    #[test]
    fn a_value_is_at_most_four_kibibytes() {
        let text = |len: usize| format!("\"{}\"", "a".repeat(len - 2));
        let at_limit = Value {
            name: "crown".into(),
            value: Some(text(MAX_VALUE_LEN)),
            lamport: 1,
        };
        let payload = at_limit.payload().unwrap();
        assert_eq!(Value::parse(&payload).unwrap(), at_limit);
        let over = Value {
            value: Some(text(MAX_VALUE_LEN + 1)),
            ..at_limit.clone()
        };
        assert_eq!(over.payload(), Err(Error::TooLarge));
        // A reader holds a received value to the same limit.
        let raw = format!(
            r#"{{"name":"crown","value":{},"lamport":1}}"#,
            text(MAX_VALUE_LEN + 1)
        );
        assert_eq!(Value::parse(raw.as_bytes()), Err(Error::TooLarge));
        // The two names that list one head per sender are bounded by the payload alone.
        for name in ["heads", "board_snapshot/abc"] {
            let long = Value {
                name: name.into(),
                value: Some(text(3 * MAX_VALUE_LEN)),
                lamport: 1,
            };
            assert_eq!(Value::parse(&long.payload().unwrap()).unwrap(), long);
        }
    }

    #[test]
    fn the_lamport_counts_within_its_bounds_only() {
        assert_eq!(counted_lamport(0, 0), 0);
        assert_eq!(counted_lamport(1, 0), 1);
        assert_eq!(counted_lamport(MAX_LAMPORT_JUMP, 0), MAX_LAMPORT_JUMP);
        assert_eq!(counted_lamport(MAX_LAMPORT_JUMP + 1, 0), 0);
        assert_eq!(
            counted_lamport(100 + MAX_LAMPORT_JUMP, 100),
            100 + MAX_LAMPORT_JUMP
        );
        assert_eq!(counted_lamport(101 + MAX_LAMPORT_JUMP, 100), 0);
        // Below the largest seen is fine: it is an older value.
        assert_eq!(counted_lamport(5, 1_000_000_000), 5);
        // 2^48 counts, one above does not, however much was seen.
        assert_eq!(counted_lamport(MAX_LAMPORT, MAX_LAMPORT - 1), MAX_LAMPORT);
        assert_eq!(counted_lamport(MAX_LAMPORT + 1, MAX_LAMPORT), 0);
        assert_eq!(counted_lamport(u64::MAX, u64::MAX), 0);
        assert_eq!(counted_lamport(u64::MAX, 0), 0);

        assert_eq!(next_lamport(0), Ok(1));
        assert_eq!(next_lamport(MAX_LAMPORT - 1), Ok(MAX_LAMPORT));
        assert_eq!(next_lamport(MAX_LAMPORT), Err(Error::TooMany));
        assert_eq!(next_lamport(u64::MAX), Err(Error::TooMany));
    }

    #[test]
    fn the_current_value_has_the_highest_lamport_then_sender_then_number() {
        let mut reader = Scene::new();
        let get = |reader: &Scene| reader.registers(&room()).get("crown").map(str::to_owned);
        assert_eq!(get(&reader), None);
        assert!(
            reader
                .set(1, room(), "crown", Some("1"), 1)
                .unwrap()
                .current
        );
        assert_eq!(get(&reader).as_deref(), Some("1"));
        // A higher lamport wins, whoever writes and whenever it arrives.
        assert!(
            reader
                .set(2, room(), "crown", Some("2"), 5)
                .unwrap()
                .current
        );
        assert!(
            !reader
                .set(1, room(), "crown", Some("3"), 4)
                .unwrap()
                .current
        );
        assert_eq!(get(&reader).as_deref(), Some("2"));
        // The same lamport: the higher sender id wins.
        let (low, high) = if device(1) < device(2) {
            (1, 2)
        } else {
            (2, 1)
        };
        assert!(
            reader
                .set(high, room(), "crown", Some("4"), 9)
                .unwrap()
                .current
        );
        assert!(
            !reader
                .set(low, room(), "crown", Some("5"), 9)
                .unwrap()
                .current
        );
        assert_eq!(get(&reader).as_deref(), Some("4"));
        // The same lamport and sender: the higher envelope number wins.
        assert!(
            reader
                .set(high, room(), "crown", Some("6"), 9)
                .unwrap()
                .current
        );
        assert_eq!(get(&reader).as_deref(), Some("6"));
        // A null deletes, and is itself the current value.
        assert!(reader.set(low, room(), "crown", None, 10).unwrap().current);
        assert_eq!(get(&reader), None);
        assert!(
            !reader
                .set(high, room(), "crown", Some("7"), 9)
                .unwrap()
                .current
        );
        assert_eq!(get(&reader), None);
        assert_eq!(reader.registers(&room()).largest_lamport(), 10);
        // Names do not touch each other.
        reader.set(1, room(), "kit", Some("\"k\""), 1).unwrap();
        assert_eq!(reader.registers(&room()).get("kit"), Some("\"k\""));
        assert_eq!(get(&reader), None);
    }

    #[test]
    fn a_lamport_out_of_bounds_counts_as_zero() {
        let mut reader = Scene::new();
        reader.set(1, room(), "crown", Some("1"), 3).unwrap();
        // A jump of more than 2^24 above the largest seen: counts as 0, so it loses against lamport 3.
        let update = reader
            .set(2, room(), "crown", Some("2"), 4 + MAX_LAMPORT_JUMP)
            .unwrap();
        assert!(!update.current);
        assert_eq!(reader.registers(&room()).get("crown"), Some("1"));
        assert_eq!(reader.registers(&room()).largest_lamport(), 3);
        // Exactly 2^24 above counts.
        assert!(
            reader
                .set(2, room(), "crown", Some("3"), 3 + MAX_LAMPORT_JUMP)
                .unwrap()
                .current
        );
        assert_eq!(
            reader.registers(&room()).largest_lamport(),
            3 + MAX_LAMPORT_JUMP
        );
        // Above 2^48: 0.
        assert!(
            !reader
                .set(1, room(), "crown", Some("4"), MAX_LAMPORT + 1)
                .unwrap()
                .current
        );
        // A value that counts as 0 is still the current one of a name nobody wrote before.
        assert!(
            reader
                .set(1, room(), "kit", Some("5"), u64::MAX)
                .unwrap()
                .current
        );
        assert_eq!(reader.registers(&room()).get("kit"), Some("5"));
        assert!(reader.set(1, room(), "kit", Some("6"), 1).unwrap().current);
    }

    #[test]
    fn each_name_belongs_to_a_role_and_a_kind_of_group() {
        let me = device(1);
        let own = format!("device/{}", me.to_base64url());
        let other = format!("device/{}", device(2).to_base64url());
        let long_name = format!("status_line/{}", "a".repeat(MAX_NAME_LEN));
        assert!(may_write(
            &long_name[..MAX_NAME_LEN],
            false,
            Role::Agent,
            &me
        ));
        // (name, room: human, session: human, session: agent, session: helper)
        let table = [
            ("desk/x", true, false, false, false),
            ("session/x", true, false, false, false),
            ("crown", true, false, false, false),
            ("kit", true, false, false, false),
            ("draft/x", true, false, false, false),
            ("snooze/x", true, false, false, false),
            ("duck/x", true, false, false, false),
            ("read/session/x", true, false, false, false),
            ("board_snapshot/x", true, false, false, false),
            (own.as_str(), true, true, true, true),
            (other.as_str(), false, false, false, false),
            ("heads", true, true, true, true),
            ("profile", false, false, true, true),
            ("status_line/x", false, false, true, true),
            ("heard", false, false, true, true),
            ("alert/x", false, false, true, true),
            ("goals", false, true, false, false),
            // Names the table does not have.
            ("", false, false, false, false),
            ("desk/", false, false, false, false),
            ("desk", false, false, false, false),
            ("crown/x", false, false, false, false),
            ("status_line/", false, false, false, false),
            ("device/", false, false, false, false),
            ("device/short", false, false, false, false),
            ("Heads", false, false, false, false),
            ("room_snapshot", false, false, false, false),
            (long_name.as_str(), false, false, false, false),
        ];
        for (name, room_human, session_human, session_agent, session_helper) in table {
            assert_eq!(
                may_write(name, true, Role::Human, &me),
                room_human,
                "{name}"
            );
            assert_eq!(
                may_write(name, false, Role::Human, &me),
                session_human,
                "{name}"
            );
            assert_eq!(
                may_write(name, false, Role::Agent, &me),
                session_agent,
                "{name}"
            );
            assert_eq!(
                may_write(name, false, Role::Opener, &me),
                session_agent,
                "{name}"
            );
            assert_eq!(
                may_write(name, false, Role::Helper, &me),
                session_helper,
                "{name}"
            );
        }
        assert_eq!(name_owner("heads", true), Some(NameOwner::EachDevice));
        assert_eq!(name_owner(&own, false), Some(NameOwner::NamedDevice(me)));
        assert_eq!(name_owner("goals", true), None);
        assert_eq!(name_owner("profile", true), None);
    }

    #[test]
    fn a_reader_takes_a_name_only_from_the_role_that_owns_it() {
        let mut reader = Scene::new();
        // In a session group any leaf writes register envelopes (9.2); the name decides whose count.
        assert_eq!(
            reader.set(2, session(), "profile", Some("1"), 1).err(),
            Some(Error::Forbidden)
        );
        assert_eq!(
            reader.set(3, session(), "goals", Some("1"), 1).err(),
            Some(Error::Forbidden)
        );
        assert_eq!(
            reader.set(3, session(), "desk/x", Some("1"), 1).err(),
            Some(Error::Forbidden)
        );
        assert_eq!(
            reader.set(3, session(), "no such name", Some("1"), 1).err(),
            Some(Error::Forbidden)
        );
        assert!(reader.set(3, session(), "profile", Some("1"), 1).is_ok());
        assert!(reader.set(2, session(), "goals", Some("2"), 1).is_ok());
        assert!(reader
            .set(4, helper_session(), "status_line/a", Some("3"), 1)
            .is_ok());
        // A forbidden value moves nothing, not even the largest lamport seen.
        assert_eq!(
            reader.set(2, session(), "heard", Some("1"), 1000).err(),
            Some(Error::Forbidden)
        );
        assert_eq!(reader.registers(&session()).largest_lamport(), 1);
        assert_eq!(reader.registers(&session()).get("heard"), None);
        // A device's own name: only that device.
        let name = |n: u8| format!("device/{}", device(n).to_base64url());
        assert!(reader.set(3, session(), &name(3), Some("1"), 2).is_ok());
        assert_eq!(
            reader.set(2, session(), &name(3), Some("2"), 3).err(),
            Some(Error::Forbidden)
        );
        assert_eq!(reader.registers(&session()).get(&name(3)), Some("1"));
        // The role is the one of the envelope's epoch: a device that became the agent later.
        reader.world.fake.commit(&session(), NOW, NOW, |leaves| {
            leaves.remove(&device(3));
            leaves.insert(device(6), Role::Agent);
        });
        assert!(reader.set(6, session(), "profile", Some("9"), 3).is_ok());
    }

    #[test]
    fn an_update_is_applied_once_and_a_notes_lamport_counts() {
        let mut reader = Scene::new();
        let update = reader.set(1, room(), "crown", Some("1"), 5).unwrap();
        let mut registers = reader.registers(&room());
        // The same update again: the registers have moved on since it was judged.
        assert!(matches!(registers.apply(&update), Err(Error::Internal(_))));
        assert_eq!(registers, reader.registers(&room()));
        assert!(!format!("{update:?}").contains("\"1\""));
        // A Note version's lamport moves the largest seen, by the same bounds.
        registers.observe_lamport(9);
        assert_eq!(registers.largest_lamport(), 9);
        registers.observe_lamport(3);
        registers.observe_lamport(10 + MAX_LAMPORT_JUMP);
        assert_eq!(registers.largest_lamport(), 9);
        assert_eq!(next_lamport(registers.largest_lamport()), Ok(10));
    }

    #[test]
    fn heads_are_kept_per_device() {
        let mut reader = Scene::new();
        reader
            .set(2, session(), "heads", Some(r#"{"a":1}"#), 1)
            .unwrap();
        // The agent's later value does not replace the human's.
        let update = reader
            .set(3, session(), "heads", Some(r#"{"b":2}"#), 2)
            .unwrap();
        assert_eq!((update.of, update.current), (Some(device(3)), true));
        let registers = reader.registers(&session());
        assert_eq!(registers.get_of("heads", &device(2)), Some(r#"{"a":1}"#));
        assert_eq!(registers.get_of("heads", &device(3)), Some(r#"{"b":2}"#));
        assert_eq!(registers.get_of("heads", &device(1)), None);
        assert_eq!(registers.get("heads"), None);
        // A device's own newer value replaces its older one.
        reader
            .set(2, session(), "heads", Some(r#"{"a":3}"#), 3)
            .unwrap();
        assert_eq!(
            reader.registers(&session()).get_of("heads", &device(2)),
            Some(r#"{"a":3}"#)
        );
    }

    #[test]
    fn a_writer_keeps_one_register_id_per_name() {
        let mut reader = Scene::new();
        reader
            .set_with_id(
                1,
                room(),
                RegisterId::new([7; 16]),
                &value("crown", Some("1"), 1),
            )
            .unwrap();
        // The same id for another name; another id for the same name.
        assert_eq!(
            reader
                .set_with_id(
                    1,
                    room(),
                    RegisterId::new([7; 16]),
                    &value("kit", Some("1"), 2)
                )
                .err(),
            Some(Error::BadFormat)
        );
        assert_eq!(
            reader
                .set_with_id(
                    1,
                    room(),
                    RegisterId::new([8; 16]),
                    &value("crown", Some("2"), 2)
                )
                .err(),
            Some(Error::BadFormat)
        );
        assert_eq!(reader.registers(&room()).get("crown"), Some("1"));
        assert_eq!(reader.registers(&room()).get("kit"), None);
        // Another writer may use the same bytes for its own name.
        reader
            .set_with_id(
                2,
                room(),
                RegisterId::new([7; 16]),
                &value("kit", Some("3"), 2),
            )
            .unwrap();
        // And the first writer goes on under its id.
        reader
            .set_with_id(
                1,
                room(),
                RegisterId::new([7; 16]),
                &value("crown", Some("4"), 3),
            )
            .unwrap();
        assert_eq!(reader.registers(&room()).get("crown"), Some("4"));
        // An envelope that is no register carries no register value.
        let sealed = reader.world.sign(
            1,
            room(),
            &Draft::board_item(trommi_core::ids::BoardId::ALL_DESKS, b"{}"),
        );
        assert_eq!(
            Registers::new()
                .judge(&reader.world.fake, &sealed.envelope.header, b"{}")
                .err(),
            Some(Error::BadFormat)
        );
    }

    #[test]
    fn a_device_writes_with_its_next_lamport_and_its_own_ids() {
        let mut reader = Scene::new();
        reader.set(2, room(), "crown", Some("1"), 41).unwrap();
        let registers = reader.registers(&room());
        let mut own = OwnIds::new();
        let mut entropy = seeded(3);
        let draft = write(
            &registers,
            &mut own,
            "crown",
            Some(r#"{"x":1}"#),
            &mut entropy,
        )
        .unwrap();
        let receipt = reader.world.post(1, room(), &draft);
        let opened = receipt.opened().unwrap();
        let sent = Value::parse(opened.body().payload()).unwrap();
        assert_eq!(
            sent,
            Value {
                name: "crown".into(),
                value: Some(r#"{"x":1}"#.into()),
                lamport: 42
            }
        );
        let Subject::Register(first_id) = opened.header().subject else {
            panic!("a register");
        };
        // The same name again: the same id. Another name: another id.
        let id = |own: &mut OwnIds, entropy: &mut SeededEntropy, name: &str| {
            let draft = write(&registers, own, name, None, entropy).unwrap();
            let slot = World::new().slot(1, room(), 0);
            match draft.header(&slot).unwrap().subject {
                Subject::Register(id) => id,
                other => panic!("{other:?}"),
            }
        };
        assert_eq!(id(&mut own, &mut entropy, "crown"), first_id);
        let kit = id(&mut own, &mut entropy, "kit");
        assert_ne!(kit, first_id);
        let stored = OwnIds::from_bytes(&own.to_bytes().unwrap()).unwrap();
        assert_eq!(stored, own);
        let mut stored = stored;
        assert_eq!(id(&mut stored, &mut entropy, "kit"), kit);
        assert!(matches!(
            OwnIds::from_bytes(&[5, 1]),
            Err(Error::Storage(_))
        ));

        // Without randomness no id, and nothing is remembered.
        let mut fresh = OwnIds::new();
        assert_eq!(
            write(&registers, &mut fresh, "crown", None, &mut NoEntropy).err(),
            Some(Error::Entropy)
        );
        assert_eq!(fresh, OwnIds::new());
        assert_eq!(
            write(&registers, &mut fresh, "crown", Some("{"), &mut entropy).err(),
            Some(Error::BadFormat)
        );
    }

    #[test]
    fn register_state_round_trips_and_refuses_damage() {
        let mut reader = Scene::new();
        reader.set(1, room(), "crown", Some("1"), 1).unwrap();
        reader.set(2, room(), "kit", None, 2).unwrap();
        reader.set(2, room(), "heads", Some("{}"), 3).unwrap();
        reader.set(1, room(), "heads", Some("{}"), 4).unwrap();
        let registers = reader.registers(&room());
        assert!(!format!("{registers:?}").contains("{}"));
        let bytes = registers.to_bytes().unwrap();
        assert_eq!(Registers::from_bytes(&bytes).unwrap(), registers);
        assert_eq!(
            Registers::from_bytes(&Registers::new().to_bytes().unwrap()).unwrap(),
            Registers::new()
        );
        for len in 0..bytes.len() {
            assert!(
                matches!(Registers::from_bytes(&bytes[..len]), Err(Error::Storage(_))),
                "cut at {len}"
            );
        }
        let mut longer = bytes.clone();
        longer.push(0);
        assert!(matches!(
            Registers::from_bytes(&longer),
            Err(Error::Storage(_))
        ));
    }

    #[test]
    fn goals_keep_to_twenty_lines_of_two_hundred_characters() {
        let lines = |n: usize, len: usize| vec!["ä".repeat(len); n].join("\n");
        let desk = |goals: &str| json!({ "name": "Desk", "order": 1, "goals": goals }).to_string();
        let handed = |goals: &str| {
            json!({ "desk_id": "d", "desk_name": "Desk", "goals": goals }).to_string()
        };
        let registers = Registers::new();
        let write_as = |name: &str, value: &str| {
            write(
                &registers,
                &mut OwnIds::new(),
                name,
                Some(value),
                &mut seeded(1),
            )
            .map(|_| ())
        };
        // What a reader makes of the same value, written by a device that does not keep the limits.
        let read_as = |name: &str, value: &str| {
            let payload = format!(r#"{{"name":"{name}","value":{value},"lamport":1}}"#);
            Value::parse(payload.as_bytes()).map(|_| ())
        };
        for name in ["desk/abc", "goals"] {
            let value: &dyn Fn(&str) -> String = if name == "goals" { &handed } else { &desk };
            for fits in [
                lines(20, 40),
                lines(1, 200),
                lines(1, 0),
                "Ship it".to_owned(),
            ] {
                assert_eq!(write_as(name, &value(&fits)), Ok(()), "{name}");
                assert_eq!(read_as(name, &value(&fits)), Ok(()), "{name}");
            }
            for beyond in [lines(21, 1), lines(1, 201), lines(20, 1) + "\n"] {
                assert_eq!(
                    write_as(name, &value(&beyond)),
                    Err(Error::TooLarge),
                    "{name}"
                );
                assert_eq!(
                    read_as(name, &value(&beyond)),
                    Err(Error::TooLarge),
                    "{name}"
                );
            }
            // No Goals: null, or no field. Goals that are no text are no value of the name.
            for none in [
                r#"{"name":"Desk","goals":null}"#,
                r#"{"name":"Desk"}"#,
                "null",
            ] {
                assert_eq!(read_as(name, none), Ok(()), "{name}");
            }
            assert_eq!(write_as(name, r#"{"goals":null}"#), Ok(()));
            for odd in [
                r#"{"goals":["a","b"]}"#,
                r#"{"goals":7}"#,
                r#"{"goals":{}}"#,
            ] {
                assert_eq!(write_as(name, odd), Err(Error::BadFormat), "{name}");
                assert_eq!(read_as(name, odd), Err(Error::BadFormat), "{name}");
            }
        }
        // Two hundred characters, not bytes: the line above is 400 bytes long. And only Goals are held to it.
        assert_eq!(lines(1, 200).len(), 400);
        // The limit of every value holds beside it: twenty full lines fit in 4 KiB as plain letters and not
        // as letters of two bytes.
        let full = vec!["a".repeat(200); 20].join("\n");
        assert_eq!(write_as("goals", &handed(&full)), Ok(()));
        assert_eq!(read_as("goals", &handed(&full)), Ok(()));
        assert!(handed(&lines(20, 200)).len() > MAX_VALUE_LEN);
        assert_eq!(
            write_as("goals", &handed(&lines(20, 200))),
            Err(Error::TooLarge)
        );
        assert_eq!(write_as("session/abc", &desk(&lines(30, 1))), Ok(()));
        assert_eq!(read_as("profile", &desk(&lines(1, 300))), Ok(()));
        assert_eq!((MAX_GOALS_LINES, MAX_GOALS_LINE_LEN), (20, 200));

        // A reader does not take such a value: the Goals an agent reads stay the ones before it.
        let mut scene = Scene::new();
        let payload = |goals: &str, lamport: u64| {
            format!(
                r#"{{"name":"goals","value":{},"lamport":{lamport}}}"#,
                handed(goals)
            )
        };
        let id = RegisterId::new([4; 16]);
        assert!(scene
            .set_with_id(1, session(), id, payload("Ship it", 1).as_bytes())
            .is_ok());
        assert_eq!(
            scene
                .set_with_id(1, session(), id, payload(&lines(21, 1), 2).as_bytes())
                .err(),
            Some(Error::TooLarge)
        );
        let kept = scene.registers[&session()].get("goals").unwrap().to_owned();
        assert_eq!(kept, handed("Ship it"));
    }
}
