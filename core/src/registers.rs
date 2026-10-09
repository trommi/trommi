//! Registers (section 9.3): named values of which the newest counts. A value travels as the payload of a
//! register envelope, `{ name, value | null, lamport }`; the header shows only a random id per writer and name.
//! This module reads and writes that payload, applies the lamport rule, knows which role may write which name
//! in which kind of group, and keeps the current value of every name of one group ([`Registers`], plain data
//! that the caller stores).
//!
//! An id inside a name (`device/<device id>`) is base64url, as bytes are in JSON (section 2). A value is JSON
//! text: this module does not look into it.

use crate::chain::{GroupFacts, Role};
use crate::codec::{Reader, Writer};
use crate::crypto::{self, Entropy};
use crate::envelope::{self, Draft, Header, Subject, MAX_PAYLOAD_LEN};
use crate::error::Error;
use crate::ids::{DeviceId, RegisterId};
use serde::Deserialize;
use std::collections::BTreeMap;

/// The longest value, in bytes of compact JSON.
pub const MAX_VALUE_LEN: usize = 4096;
/// A lamport above this counts as 0.
pub const MAX_LAMPORT: u64 = 1 << 48;
/// A lamport more than this above the largest seen counts as 0.
pub const MAX_LAMPORT_JUMP: u64 = 1 << 24;
/// The name under which every device lists the chains it accepted (section 9.0.7).
pub const HEADS: &str = "heads";
/// The prefix of the name that points at a board's snapshot (section 10.2).
pub const BOARD_SNAPSHOT: &str = "board_snapshot/";
/// The largest stored state this module reads.
const MAX_STATE_LEN: usize = 1 << 28;

/// One register value as it stands in a payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Value {
    /// The name.
    pub name: String,
    /// The value as JSON text; `None` deletes the name.
    pub value: Option<String>,
    /// The writer's lamport: one above every lamport it had seen in the group.
    pub lamport: u64,
}

#[derive(Deserialize)]
struct Wire {
    name: String,
    value: serde_json::Value,
    lamport: u64,
}

/// Whether the size of a name's value follows the number of senders in the group: it lists one head per
/// sender, and is bounded by the payload limit instead of [`MAX_VALUE_LEN`].
fn grows_with_senders(name: &str) -> bool {
    name == HEADS || name.starts_with(BOARD_SNAPSHOT)
}

fn value_limit(name: &str) -> usize {
    if grows_with_senders(name) {
        MAX_PAYLOAD_LEN
    } else {
        MAX_VALUE_LEN
    }
}

impl Value {
    /// The value a register envelope's payload holds. `bad-format` unless it is a JSON object with a text
    /// `name`, a `value` (any JSON, or null) and a whole, non-negative `lamport`, each once; other fields are
    /// ignored. `too-large` for a value above [`MAX_VALUE_LEN`].
    pub fn parse(payload: &[u8]) -> Result<Self, Error> {
        if !envelope::is_json_object(payload) {
            return Err(Error::BadFormat);
        }
        let wire: Wire = serde_json::from_slice(payload).map_err(|_| Error::BadFormat)?;
        let value = match wire.value {
            serde_json::Value::Null => None,
            value => Some(serde_json::to_string(&value).map_err(|_| Error::BadFormat)?),
        };
        if value
            .as_ref()
            .is_some_and(|v| v.len() > value_limit(&wire.name))
        {
            return Err(Error::TooLarge);
        }
        Ok(Self {
            name: wire.name,
            value,
            lamport: wire.lamport,
        })
    }

    /// The payload of the register envelope that carries this value. `bad-format` if `value` is not JSON
    /// text; `too-large` above [`MAX_VALUE_LEN`], measured as compact JSON.
    pub fn payload(&self) -> Result<Vec<u8>, Error> {
        let value = match &self.value {
            None => serde_json::Value::Null,
            Some(text) => serde_json::from_str(text).map_err(|_| Error::BadFormat)?,
        };
        let compact = serde_json::to_string(&value).map_err(|_| Error::BadFormat)?;
        if !value.is_null() && compact.len() > value_limit(&self.name) {
            return Err(Error::TooLarge);
        }
        serde_json::to_vec(&serde_json::json!({
            "name": self.name,
            "value": value,
            "lamport": self.lamport,
        }))
        .map_err(|_| Error::Internal("register payload"))
    }
}

/// The lamport a value counts with for a reader whose largest counted lamport in the group so far is
/// `largest_seen`: its own, or 0 if it is above 2^48 or more than 2^24 above the largest seen.
pub fn counted_lamport(lamport: u64, largest_seen: u64) -> u64 {
    if lamport > MAX_LAMPORT || lamport > largest_seen.saturating_add(MAX_LAMPORT_JUMP) {
        0
    } else {
        lamport
    }
}

/// The lamport of a writer's next value: one above the largest it has seen in the group. `too-many` when that
/// would lie above 2^48 and so count for nothing.
pub fn next_lamport(largest_seen: u64) -> Result<u64, Error> {
    largest_seen
        .checked_add(1)
        .filter(|next| *next <= MAX_LAMPORT)
        .ok_or(Error::TooMany)
}

/// What orders the values of one name: the highest counts (section 9.3.2). The same order chooses the current
/// version of a Note (section 9.2.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Stamp {
    /// The counted lamport.
    pub lamport: u64,
    /// The sender.
    pub sender: DeviceId,
    /// The sender's envelope number.
    pub seq: u64,
}

/// Who owns a name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NameOwner {
    /// Room group: shared by the human devices.
    RoomHumans,
    /// Any group: each device writes its own; the value is kept per sender.
    EachDevice,
    /// Any group: only the device the name names.
    NamedDevice(DeviceId),
    /// Session group: its agent or helper devices.
    SessionDevices,
    /// Session group: the human devices.
    SessionHumans,
}

/// The owner of `name` in a room group (`in_room`) or a session group, by the table of section 9.3.3; `None`
/// for a name the table does not have there, which nobody may write.
pub fn name_owner(name: &str, in_room: bool) -> Option<NameOwner> {
    let has_prefix = |prefixes: &[&str]| {
        prefixes.iter().any(|prefix| {
            name.strip_prefix(prefix)
                .is_some_and(|rest| !rest.is_empty())
        })
    };
    if name == HEADS {
        return Some(NameOwner::EachDevice);
    }
    if let Some(id) = name.strip_prefix("device/") {
        return DeviceId::from_base64url(id)
            .ok()
            .map(NameOwner::NamedDevice);
    }
    if in_room {
        let room_humans = ["crown", "kit"].contains(&name)
            || has_prefix(&[
                "desk/",
                "session/",
                "draft/",
                "snooze/",
                "duck/",
                "read/",
                BOARD_SNAPSHOT,
            ]);
        return room_humans.then_some(NameOwner::RoomHumans);
    }
    if name == "goals" {
        return Some(NameOwner::SessionHumans);
    }
    let session_devices =
        ["profile", "heard"].contains(&name) || has_prefix(&["status_line/", "alert/"]);
    session_devices.then_some(NameOwner::SessionDevices)
}

/// Whether a leaf of `role` with the id `sender` may write `name` in that kind of group.
pub fn may_write(name: &str, in_room: bool, role: Role, sender: &DeviceId) -> bool {
    match name_owner(name, in_room) {
        Some(NameOwner::RoomHumans | NameOwner::SessionHumans) => role == Role::Human,
        Some(NameOwner::SessionDevices) => role != Role::Human,
        Some(NameOwner::EachDevice) => true,
        Some(NameOwner::NamedDevice(device)) => device == *sender,
        None => false,
    }
}

/// The value held for one name (for a name each device writes: for one name and sender).
#[derive(Debug, Clone, PartialEq, Eq)]
struct Held {
    stamp: Stamp,
    value: Option<String>,
}

/// What one register envelope changes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Update {
    /// The name.
    pub name: String,
    /// The sender, for a name of which each device holds its own value; `None` for a shared name.
    pub of: Option<DeviceId>,
    /// The value: JSON text, or `None` for a deletion.
    pub value: Option<String>,
    /// Whether this value is now the current one. If not, an earlier envelope carries a higher stamp, and
    /// only the bookkeeping changes.
    pub current: bool,
    stamp: Stamp,
    register: RegisterId,
    largest: u64,
}

/// The registers of one group as a reader holds them.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Registers {
    /// The largest counted lamport seen in the group.
    largest: u64,
    values: BTreeMap<(String, Option<DeviceId>), Held>,
    /// The name each writer uses a register id for, and the id it uses for each name.
    names: BTreeMap<(DeviceId, RegisterId), String>,
    ids: BTreeMap<(DeviceId, String), RegisterId>,
}

fn corrupt(_: Error) -> Error {
    Error::Storage("stored register state does not decode".into())
}

fn read_text(reader: &mut Reader<'_>) -> Result<String, Error> {
    String::from_utf8(reader.opaque()?.to_vec()).map_err(|_| Error::BadFormat)
}

impl Registers {
    /// No value yet.
    pub fn new() -> Self {
        Self::default()
    }

    /// The largest counted lamport seen in the group: a writer's next value carries one more
    /// ([`next_lamport`]).
    pub fn largest_lamport(&self) -> u64 {
        self.largest
    }

    /// The current value of a shared name: JSON text; `None` if it was never written or is deleted.
    pub fn get(&self, name: &str) -> Option<&str> {
        self.values
            .get(&(name.to_owned(), None))
            .and_then(|held| held.value.as_deref())
    }

    /// The current value that `sender` wrote under a name each device writes for itself (`heads`).
    pub fn get_of(&self, name: &str, sender: &DeviceId) -> Option<&str> {
        self.values
            .get(&(name.to_owned(), Some(*sender)))
            .and_then(|held| held.value.as_deref())
    }

    /// Judges the value of a register envelope that passed all nine checks: `header` and the opened
    /// `payload`. `bad-format` for a payload that is no register value, an envelope that is no register, or
    /// a writer that uses a register id for a second name or a second id for a name; `too-large` above the
    /// limit; `forbidden` when the sender's role in the envelope's epoch does not own the name in this kind
    /// of group. On any error the value is not taken. `Ok` is the change to [`Registers::apply`].
    pub fn judge(
        &self,
        facts: &dyn GroupFacts,
        header: &Header,
        payload: &[u8],
    ) -> Result<Update, Error> {
        let Subject::Register(register) = header.subject else {
            return Err(Error::BadFormat);
        };
        let Value {
            name,
            value,
            lamport,
        } = Value::parse(payload)?;
        let role = facts
            .leaf_role(&header.group, header.epoch, &header.sender)?
            .ok_or(Error::Forbidden)?;
        let in_room = header.group.is_room();
        if !may_write(&name, in_room, role, &header.sender) {
            return Err(Error::Forbidden);
        }
        let known_name = self.names.get(&(header.sender, register));
        let known_id = self.ids.get(&(header.sender, name.clone()));
        if known_name.is_some_and(|known| *known != name)
            || known_id.is_some_and(|known| *known != register)
        {
            return Err(Error::BadFormat);
        }
        let of =
            (name_owner(&name, in_room) == Some(NameOwner::EachDevice)).then_some(header.sender);
        let counted = counted_lamport(lamport, self.largest);
        let stamp = Stamp {
            lamport: counted,
            sender: header.sender,
            seq: header.seq,
        };
        let current = self
            .values
            .get(&(name.clone(), of))
            .is_none_or(|held| held.stamp < stamp);
        Ok(Update {
            name,
            of,
            value,
            current,
            stamp,
            register,
            largest: self.largest.max(counted),
        })
    }

    /// Takes the change of one register envelope.
    pub fn apply(&mut self, update: &Update) {
        self.largest = update.largest;
        let sender = update.stamp.sender;
        self.names
            .insert((sender, update.register), update.name.clone());
        self.ids
            .insert((sender, update.name.clone()), update.register);
        if update.current {
            self.values.insert(
                (update.name.clone(), update.of),
                Held {
                    stamp: update.stamp,
                    value: update.value.clone(),
                },
            );
        }
    }

    /// The stored form.
    pub fn to_bytes(&self) -> Result<Vec<u8>, Error> {
        let mut writer = Writer::new();
        writer.u64(self.largest);
        let mut values = Writer::new();
        for ((name, of), held) in &self.values {
            values.opaque(name.as_bytes())?;
            values.fixed(of.unwrap_or(DeviceId::ZERO).as_bytes());
            values.u64(held.stamp.lamport);
            values.fixed(held.stamp.sender.as_bytes());
            values.u64(held.stamp.seq);
            values.u8(u8::from(held.value.is_some()));
            values.opaque(held.value.as_deref().unwrap_or_default().as_bytes())?;
        }
        writer.opaque(&values.into_bytes())?;
        let mut names = Writer::new();
        for ((sender, register), name) in &self.names {
            names.fixed(sender.as_bytes());
            names.fixed(register.as_bytes());
            names.opaque(name.as_bytes())?;
        }
        writer.opaque(&names.into_bytes())?;
        Ok(writer.into_bytes())
    }

    fn read(bytes: &[u8]) -> Result<Self, Error> {
        if bytes.len() > MAX_STATE_LEN {
            return Err(Error::TooLarge);
        }
        let mut reader = Reader::new(bytes);
        let mut registers = Self {
            largest: reader.u64()?,
            ..Self::default()
        };
        let mut values = Reader::new(reader.opaque()?);
        while !values.is_empty() {
            let name = read_text(&mut values)?;
            let of = Some(values.value::<DeviceId>()?).filter(|device| !device.is_zero());
            let stamp = Stamp {
                lamport: values.u64()?,
                sender: values.value()?,
                seq: values.u64()?,
            };
            let present = match values.u8()? {
                0 => false,
                1 => true,
                _ => return Err(Error::BadFormat),
            };
            let text = read_text(&mut values)?;
            if !present && !text.is_empty() {
                return Err(Error::BadFormat);
            }
            let held = Held {
                stamp,
                value: present.then_some(text),
            };
            if registers.values.insert((name, of), held).is_some() {
                return Err(Error::BadFormat);
            }
        }
        let mut names = Reader::new(reader.opaque()?);
        while !names.is_empty() {
            let sender: DeviceId = names.value()?;
            let register: RegisterId = names.value()?;
            let name = read_text(&mut names)?;
            if registers
                .names
                .insert((sender, register), name.clone())
                .is_some()
                || registers.ids.insert((sender, name), register).is_some()
            {
                return Err(Error::BadFormat);
            }
        }
        reader.finish()?;
        Ok(registers)
    }

    /// Reads the stored form; `Error::Storage` if it does not decode.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, Error> {
        Self::read(bytes).map_err(corrupt)
    }
}

/// The register ids this device chose, per name, in one group (section 9.3.1): 16 random bytes for each name,
/// used again for every later value of it. Plain data that the caller stores with the envelope it sends.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct OwnIds {
    ids: BTreeMap<String, RegisterId>,
}

impl OwnIds {
    /// No name written yet.
    pub fn new() -> Self {
        Self::default()
    }

    /// The id for `name`: the one chosen before, or a fresh random one, which is remembered.
    pub fn id_for(&mut self, name: &str, entropy: &mut dyn Entropy) -> Result<RegisterId, Error> {
        if let Some(id) = self.ids.get(name) {
            return Ok(*id);
        }
        let id = RegisterId::new(crypto::random(entropy)?);
        self.ids.insert(name.to_owned(), id);
        Ok(id)
    }

    /// The stored form.
    pub fn to_bytes(&self) -> Result<Vec<u8>, Error> {
        let mut writer = Writer::new();
        for (name, id) in &self.ids {
            writer.opaque(name.as_bytes())?;
            writer.fixed(id.as_bytes());
        }
        Ok(writer.into_bytes())
    }

    /// Reads the stored form; `Error::Storage` if it does not decode.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, Error> {
        let mut reader = Reader::new(bytes);
        let mut own = Self::new();
        while !reader.is_empty() {
            let name = read_text(&mut reader).map_err(corrupt)?;
            let id = reader.value().map_err(corrupt)?;
            if own.ids.insert(name, id).is_some() {
                return Err(corrupt(Error::BadFormat));
            }
        }
        Ok(own)
    }
}

/// The draft of a register envelope that sets `name` to `value` (JSON text; `None` deletes), with a lamport one
/// above the largest the device has seen in the group and the register id it keeps for the name. `own` then
/// holds that id: the caller stores it with the envelope. Whether this device may write the name is judged
/// with [`may_write`] before, and by every reader after.
pub fn write(
    registers: &Registers,
    own: &mut OwnIds,
    name: &str,
    value: Option<&str>,
    entropy: &mut dyn Entropy,
) -> Result<Draft, Error> {
    let payload = Value {
        name: name.to_owned(),
        value: value.map(str::to_owned),
        lamport: next_lamport(registers.largest)?,
    }
    .payload()?;
    let id = own.id_for(name, entropy)?;
    Ok(Draft::register(id, &payload))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chain::testing::*;
    use crate::chain::Receipt;
    use crate::envelope::testing::{device, NoEntropy, TestEntropy};
    use crate::ids::GroupId;
    use serde_json::json;

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
            registers.apply(&update);
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
            let hash = crate::crypto::sha256(format!("{n}{name}").as_bytes()).unwrap();
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
            &Draft::board_item(crate::ids::BoardId::ALL_DESKS, b"{}"),
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
        let mut entropy = TestEntropy(3);
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
        let id = |own: &mut OwnIds, entropy: &mut TestEntropy, name: &str| {
            let draft = write(&registers, own, name, None, entropy).unwrap();
            let slot = crate::chain::OwnChain::new()
                .slot(room(), 0, device(1), NOW)
                .unwrap();
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
}
