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
use std::fmt;

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

/// One register value as it stands in a payload. A value may hold the key of a file (a board snapshot's
/// attachment), so no value is ever printed.
#[derive(Clone, PartialEq, Eq)]
pub struct Value {
    /// The name.
    pub name: String,
    /// The value as JSON text; `None` deletes the name.
    pub value: Option<String>,
    /// The writer's lamport: one above every lamport it had seen in the group.
    pub lamport: u64,
}

/// `value` as `Debug` shows it: present or not, never its text.
fn redacted(value: &Option<String>) -> &'static str {
    match value {
        Some(_) => "<redacted>",
        None => "null",
    }
}

impl fmt::Debug for Value {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Value")
            .field("name", &self.name)
            .field("value", &redacted(&self.value))
            .field("lamport", &self.lamport)
            .finish()
    }
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
/// for a name the table does not have there, or one above [`MAX_NAME_LEN`], which nobody may write.
pub fn name_owner(name: &str, in_room: bool) -> Option<NameOwner> {
    if name.len() > MAX_NAME_LEN {
        return None;
    }
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
#[derive(Clone, PartialEq, Eq)]
struct Held {
    stamp: Stamp,
    value: Option<String>,
}

/// The longest name, in bytes.
pub const MAX_NAME_LEN: usize = 255;

/// What one register envelope changes.
#[derive(Clone, PartialEq, Eq)]
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
    /// The revision of the registers the envelope was judged against, and the largest lamport seen with it.
    revision: u64,
    largest: u64,
}

impl fmt::Debug for Update {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Update")
            .field("name", &self.name)
            .field("of", &self.of)
            .field("value", &redacted(&self.value))
            .field("current", &self.current)
            .field("stamp", &self.stamp)
            .finish()
    }
}

/// The registers of one group as a reader holds them.
#[derive(Clone, PartialEq, Eq, Default)]
pub struct Registers {
    /// How many updates this state has taken: an update fits only the revision it was judged against.
    revision: u64,
    /// The largest counted lamport seen in the group.
    largest: u64,
    values: BTreeMap<(String, Option<DeviceId>), Held>,
    /// The name each writer uses a register id for, and the id it uses for each name.
    names: BTreeMap<(DeviceId, RegisterId), String>,
    ids: BTreeMap<(DeviceId, String), RegisterId>,
}

impl fmt::Debug for Registers {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Registers")
            .field("largest", &self.largest)
            .field("names", &self.values.keys().collect::<Vec<_>>())
            .finish()
    }
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
            revision: self.revision,
            largest: self.largest.max(counted),
        })
    }

    /// Notes a lamport seen elsewhere in the group: the `lamport` of a Note version's payload (section 9.2.1),
    /// which counts by the same rule. A writer's next lamport lies above it.
    pub fn observe_lamport(&mut self, lamport: u64) {
        self.largest = self.largest.max(counted_lamport(lamport, self.largest));
        self.revision = self.revision.saturating_add(1);
    }

    /// Takes the change of one register envelope. `Error::Internal`, and no change, if the registers no
    /// longer stand as the envelope was judged: an update is applied once, before the next register envelope
    /// of the group is judged.
    pub fn apply(&mut self, update: &Update) -> Result<(), Error> {
        if self.revision != update.revision {
            return Err(Error::Internal("a register update applied out of turn"));
        }
        self.revision = self.revision.saturating_add(1);
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
        Ok(())
    }

    /// The stored form.
    pub fn to_bytes(&self) -> Result<Vec<u8>, Error> {
        let mut writer = Writer::new();
        writer.u64(self.revision);
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
            revision: reader.u64()?,
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
