//! What the device knows about its groups, as the stored-content rules ask it ([`GroupFacts`],
//! [`ChainRecords`]), and where it keeps that: one record per group and epoch with the leaves and their roles,
//! the Cut of every removed device, and one record per accepted envelope.
//!
//! **Epochs.** A record is written when the device begins an epoch: when it founds or joins the group, and in
//! the write that merges a Commit, together with the group state (13.2). The role of a leaf is the one the
//! Commit that began the epoch was judged with, and stays what it was. The Commit that ends an epoch closes its
//! record with the device's clock and the Commit's `time` (check 8), and applies the Cuts it names (9.0.10).
//!
//! **Before the device joined.** A device holds records from the epoch it joined a group at. It does not
//! replay a group's founding GroupInfo and earlier Commits: of an epoch before its first record it answers as a
//! device that has not processed the group that far, and an envelope of such an epoch is `group-behind`
//! (check 2). That refusal consumes nothing.

use super::{Device, GroupMeta};
use crate::chain::{self, Chains, EpochEnd, GroupFacts, Head, OwnChain, Role};
use crate::codec::{self, Decode, Encode, Reader, Writer};
use crate::crypto::Secret;
use crate::envelope::{Header, ObjectType, Subject};
use crate::error::Error;
use crate::ids::{DeviceId, GroupId, Hash32, RoomId};
use crate::mls::observer;
use crate::mls::profile::Cut;
use crate::mls::rules::{Parent, SessionFacts};
use crate::objects::{self, Objects};
use crate::registers::Registers;
use crate::store::{self, table, Batch, Storage};
use openmls::prelude::LeafNodeIndex;
use std::collections::{BTreeMap, BTreeSet};
use zeroize::Zeroizing;

/// The parts of the table of chains.
pub(super) const SUB_EPOCH: u8 = 0;
pub(super) const SUB_CUT: u8 = 1;
pub(super) const SUB_CHAINS: u8 = 2;
pub(super) const SUB_OWN_CHAIN: u8 = 3;
pub(super) const SUB_RECORD: u8 = 4;
pub(super) const SUB_GROUP_STATE: u8 = 5;
pub(super) const SUB_FINDING: u8 = 6;
pub(super) const SUB_OWN_CUTS: u8 = 7;
pub(super) const SUB_PROVISIONAL: u8 = 8;
pub(super) const SUB_BY_HASH: u8 = 9;
pub(super) const SUB_ORIGIN: u8 = 10;
/// The parts of the table of registers.
pub(super) const SUB_REGISTERS: u8 = 0;
pub(super) const SUB_OWN_IDS: u8 = 1;

const ROLE_NONE: u8 = 0;

fn role_byte(role: Option<Role>) -> u8 {
    match role {
        None => ROLE_NONE,
        Some(Role::Human) => 1,
        Some(Role::Agent) => 2,
        Some(Role::Opener) => 3,
        Some(Role::Helper) => 4,
    }
}

fn role_of(byte: u8) -> Result<Option<Role>, Error> {
    Ok(match byte {
        ROLE_NONE => None,
        1 => Some(Role::Human),
        2 => Some(Role::Agent),
        3 => Some(Role::Opener),
        4 => Some(Role::Helper),
        _ => return Err(Error::BadFormat),
    })
}

fn damaged(what: &'static str) -> Error {
    Error::Storage(format!("{what} does not decode"))
}

/// The key of an entry that belongs to a group: the group's length keeps one key from being the start of
/// another.
pub(super) fn group_key(table: u8, sub: u8, group: &GroupId, rest: &[u8]) -> Vec<u8> {
    let id = group.as_bytes();
    store::key(table, &[&[sub, id.len() as u8], id, rest])
}

/// One epoch of a group as the device began it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct EpochFacts {
    /// The leaves, each with the role it had; a leaf the rules give no role has none.
    pub leaves: Vec<(DeviceId, Option<Role>)>,
    /// The agent leaf of a main session, the opener of a helper session.
    pub seat: Option<DeviceId>,
    /// The Commit that ended the epoch.
    pub end: Option<EpochEnd>,
    /// The device did not stand in this epoch: it learned it from the group's public history
    /// ([`super::history`]). Its end was not processed live, so an envelope of it is judged as read back.
    pub learned: bool,
}

impl Encode for EpochFacts {
    fn write(&self, writer: &mut Writer) -> Result<(), Error> {
        let mut leaves = Writer::new();
        for (device, role) in &self.leaves {
            leaves.fixed(device.as_bytes());
            leaves.u8(role_byte(*role));
        }
        writer.opaque(&leaves.into_bytes())?;
        writer.fixed(self.seat.unwrap_or(DeviceId::ZERO).as_bytes());
        writer.u8(u8::from(self.end.is_some()));
        writer.u64(self.end.map_or(0, |end| end.processed_at));
        writer.u64(self.end.map_or(0, |end| end.time));
        writer.u8(u8::from(self.learned));
        Ok(())
    }
}

impl Decode for EpochFacts {
    fn read(reader: &mut Reader<'_>) -> Result<Self, Error> {
        let mut listed = Reader::new(reader.opaque()?);
        let mut leaves = Vec::new();
        while !listed.is_empty() {
            let device: DeviceId = listed.value()?;
            leaves.push((device, role_of(listed.u8()?)?));
        }
        let seat: DeviceId = reader.value()?;
        let ended = match reader.u8()? {
            0 => false,
            1 => true,
            _ => return Err(Error::BadFormat),
        };
        let end = EpochEnd {
            processed_at: reader.u64()?,
            time: reader.u64()?,
        };
        let learned = match reader.u8()? {
            0 => false,
            1 => true,
            _ => return Err(Error::BadFormat),
        };
        Ok(Self {
            leaves,
            seat: Some(seat).filter(|seat| !seat.is_zero()),
            end: ended.then_some(end),
            learned,
        })
    }
}

/// What became of an envelope that took its place in a chain.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Status {
    /// It passed checks 7 and 8: it counts for its object's state.
    Taken = 1,
    /// Check 7 refused it against the object state of its place.
    Forbidden = 2,
    /// It was refused for another reason than the object's state.
    Refused = 3,
    /// The hub served it as a void record.
    Void = 4,
    /// A kind this build does not know.
    Reserved = 5,
}

/// One accepted envelope, under its group, sender and number. What it keeps of a body may hold the keys of
/// files: it is not printed.
#[derive(Clone, PartialEq, Eq)]
pub(super) struct Record {
    /// The hub's change number it came under.
    pub change: u64,
    /// Its `envelope_hash`.
    pub hash: Hash32,
    /// What became of it.
    pub status: Status,
    /// Whether it named its group's newest epoch when it came. One that check 7 refused never met check 8;
    /// only such a one may count after all when the group's state is built again.
    pub fresh: bool,
    /// The code it was refused or voided with, or why its body did not open.
    pub code: Option<Error>,
    /// Its header.
    pub header: Header,
    /// What later steps need of its body: a register's payload, a Note version's lamport, a permission
    /// request's `expires_at`, and on an agent or helper device a card version's payload.
    pub extra: Vec<u8>,
}

impl Encode for Record {
    fn write(&self, writer: &mut Writer) -> Result<(), Error> {
        writer.u64(self.change);
        writer.fixed(self.hash.as_bytes());
        writer.u8(self.status as u8);
        writer.u8(u8::from(self.fresh));
        writer.opaque(self.code.as_ref().map_or("", Error::code).as_bytes())?;
        writer.opaque(&codec::encode(&self.header)?)?;
        writer.opaque(&self.extra)
    }
}

impl Decode for Record {
    fn read(reader: &mut Reader<'_>) -> Result<Self, Error> {
        let change = reader.u64()?;
        let hash = reader.value()?;
        let status = match reader.u8()? {
            1 => Status::Taken,
            2 => Status::Forbidden,
            3 => Status::Refused,
            4 => Status::Void,
            5 => Status::Reserved,
            _ => return Err(Error::BadFormat),
        };
        let fresh = match reader.u8()? {
            0 => false,
            1 => true,
            _ => return Err(Error::BadFormat),
        };
        let code = match reader.opaque()? {
            [] => None,
            code => Some(
                std::str::from_utf8(code)
                    .ok()
                    .and_then(Error::from_code)
                    .ok_or(Error::BadFormat)?,
            ),
        };
        let header = reader.opaque()?;
        let header = codec::decode(header, header.len())?;
        Ok(Self {
            change,
            hash,
            status,
            fresh,
            code,
            header,
            extra: reader.opaque()?.to_vec(),
        })
    }
}

/// What the device keeps per group beside the chains: the highest change number of an accepted envelope, and
/// when it last wrote `heads` with which value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct GroupState {
    pub max_change: u64,
    pub heads_at: u64,
    pub heads_hash: Hash32,
}

impl Default for GroupState {
    fn default() -> Self {
        Self {
            max_change: 0,
            heads_at: 0,
            heads_hash: Hash32::ZERO,
        }
    }
}

impl Encode for GroupState {
    fn write(&self, writer: &mut Writer) -> Result<(), Error> {
        writer.u64(self.max_change);
        writer.u64(self.heads_at);
        writer.fixed(self.heads_hash.as_bytes());
        Ok(())
    }
}

impl Decode for GroupState {
    fn read(reader: &mut Reader<'_>) -> Result<Self, Error> {
        Ok(Self {
            max_change: reader.u64()?,
            heads_at: reader.u64()?,
            heads_hash: reader.value()?,
        })
    }
}

/// The removal of a device from a group: its Cut, and the epoch that began without its leaf. The first one
/// for a device stands.
pub(super) struct Removal {
    pub cut: Head,
    pub epoch: u64,
}

impl Encode for Removal {
    fn write(&self, writer: &mut Writer) -> Result<(), Error> {
        writer.value(&self.cut)?;
        writer.u64(self.epoch);
        Ok(())
    }
}

impl Decode for Removal {
    fn read(reader: &mut Reader<'_>) -> Result<Self, Error> {
        Ok(Self {
            cut: reader.value()?,
            epoch: reader.u64()?,
        })
    }
}

/// The Cuts of an own Commit that waits for the hub, with the outbox entry they belong to.
struct OwnCuts {
    outbox: u64,
    cuts: Vec<Cut>,
}

impl Encode for OwnCuts {
    fn write(&self, writer: &mut Writer) -> Result<(), Error> {
        writer.u64(self.outbox);
        writer.vector(&self.cuts)
    }
}

impl Decode for OwnCuts {
    fn read(reader: &mut Reader<'_>) -> Result<Self, Error> {
        Ok(Self {
            outbox: reader.u64()?,
            cuts: reader.vector()?,
        })
    }
}

/// A finding the device made while it processed a Commit, kept until the client has read it (section 16:
/// never swallowed).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finding {
    /// The group.
    pub group: GroupId,
    /// The device whose chain it is about.
    pub sender: DeviceId,
    /// The finding: `equivocation` when a Cut names another envelope than the one this device had accepted
    /// under the Cut's number.
    pub code: Error,
}

/// The Commit being merged: what it tells the record of the epoch it ends.
#[derive(Debug, Clone)]
pub(super) struct Merging {
    pub end: EpochEnd,
    pub cuts: Vec<Cut>,
}

/// What the content layer holds in memory between the steps of one operation. Nothing here is state of its
/// own: it is rebuilt empty whenever memory is rebuilt from the store.
#[derive(Default)]
pub(super) struct Transient {
    /// The entries of the content tables written or removed since they were last read from the store, so
    /// that a later step of the same operation reads what an earlier one wrote.
    written: BTreeMap<Vec<u8>, Option<Zeroizing<Vec<u8>>>>,
    /// The Commit being merged.
    pub merging: Option<Merging>,
    /// The Cuts of the own Commit just built.
    built: Vec<Cut>,
    /// The clock, as the running operation was told it.
    pub now_ms: u64,
    /// The groups whose `heads` were asked for since this object was opened: the first time is the device
    /// coming online.
    pub heads_asked: BTreeSet<GroupId>,
}

/// Checks one stored entry of the content tables when the device is opened: what does not decode is damaged
/// state.
pub(super) fn check_entry(key: &[u8], value: &[u8]) -> Result<(), Error> {
    let mut rest = Reader::new(key);
    let table = rest.u8().map_err(|_| damaged("a key"))?;
    let checked = match table {
        table::CHAIN => {
            let sub = rest.u8().map_err(|_| damaged("a key"))?;
            match sub {
                SUB_EPOCH => codec::decode::<EpochFacts>(value, value.len()).map(|_| ()),
                SUB_CUT => codec::decode::<Removal>(value, value.len()).map(|_| ()),
                SUB_CHAINS => Chains::from_bytes(value).map(|_| ()),
                SUB_OWN_CHAIN => OwnChain::from_bytes(value).map(|_| ()),
                SUB_RECORD => codec::decode::<Record>(value, value.len()).map(|_| ()),
                SUB_GROUP_STATE => codec::decode::<GroupState>(value, value.len()).map(|_| ()),
                SUB_FINDING => std::str::from_utf8(value)
                    .ok()
                    .and_then(Error::from_code)
                    .map(|_| ())
                    .ok_or(Error::BadFormat),
                SUB_OWN_CUTS => codec::decode::<OwnCuts>(value, value.len()).map(|_| ()),
                SUB_PROVISIONAL => Hash32::from_slice(value).map(|_| ()),
                SUB_ORIGIN => {
                    codec::decode::<super::history::Origin>(value, value.len()).map(|_| ())
                }
                SUB_BY_HASH => {
                    if value.len() == 40 {
                        Ok(())
                    } else {
                        Err(Error::BadFormat)
                    }
                }
                _ => Err(Error::BadFormat),
            }
        }
        table::OBJECT => Objects::from_bytes(value).map(|_| ()),
        table::BOARD => super::content::check_board(value),
        table::INVITE => super::invite::check_entry(key.get(1..).unwrap_or_default(), value),
        table::COMMAND => super::content::check_command(key.get(1..).unwrap_or_default(), value),
        table::REGISTER => match rest.u8().map_err(|_| damaged("a key"))? {
            SUB_REGISTERS => Registers::from_bytes(value).map(|_| ()),
            SUB_OWN_IDS => crate::registers::OwnIds::from_bytes(value).map(|_| ()),
            _ => Err(Error::BadFormat),
        },
        _ => Ok(()),
    };
    checked.map_err(|_| damaged("a stored content entry"))
}

impl<S: Storage> Device<S> {
    // ---- the content tables: read through what the running operation wrote ----

    /// The stored value under `key`, as the running operation left it.
    pub(super) fn stored(&self, key: &[u8]) -> Option<&[u8]> {
        match self.memory.wire.written.get(key) {
            Some(written) => written.as_ref().map(|value| value.as_slice()),
            None => self.mirror.get(key).map(Vec::as_slice),
        }
    }

    /// Writes an entry of the content tables into `batch`.
    pub(super) fn put_stored(&mut self, batch: &mut Batch, key: Vec<u8>, value: Vec<u8>) {
        batch.put(key.clone(), value.clone());
        self.memory
            .wire
            .written
            .insert(key, Some(Zeroizing::new(value)));
    }

    /// Removes an entry of the content tables in `batch`.
    pub(super) fn delete_stored(&mut self, batch: &mut Batch, key: Vec<u8>) {
        // A batch applies its deletions first: what this operation put under the key before goes.
        batch.put.retain(|entry| entry.key != key);
        batch.delete(key.clone());
        self.memory.wire.written.insert(key, None);
    }

    /// Every stored entry whose key starts with `prefix`, ascending by key, as the running operation left
    /// them.
    pub(super) fn stored_under(&self, prefix: &[u8]) -> Vec<(Vec<u8>, Vec<u8>)> {
        let mut found: BTreeMap<&[u8], Option<&[u8]>> = self
            .mirror
            .range(prefix.to_vec()..)
            .take_while(|(key, _)| key.starts_with(prefix))
            .map(|(key, value)| (key.as_slice(), Some(value.as_slice())))
            .collect();
        for (key, value) in self
            .memory
            .wire
            .written
            .range(prefix.to_vec()..)
            .take_while(|(key, _)| key.starts_with(prefix))
        {
            found.insert(key, value.as_ref().map(|value| value.as_slice()));
        }
        found
            .into_iter()
            .filter_map(|(key, value)| Some((key.to_vec(), value?.to_vec())))
            .collect()
    }

    /// Begins an operation of the content layer: what earlier operations wrote is in the store by now.
    pub(super) fn begin(&mut self, now_ms: u64) {
        self.memory.wire.written.clear();
        // An operation that is told no time leaves the clock as it was last told.
        if now_ms != 0 {
            self.memory.wire.now_ms = now_ms;
        }
    }

    // ---- epochs ----

    pub(super) fn epoch_facts(
        &self,
        group: &GroupId,
        epoch: u64,
    ) -> Result<Option<EpochFacts>, Error> {
        self.stored(&group_key(
            table::CHAIN,
            SUB_EPOCH,
            group,
            &epoch.to_be_bytes(),
        ))
        .map(|value| codec::decode(value, value.len()).map_err(|_| damaged("an epoch record")))
        .transpose()
    }

    /// The newest epoch of `group` this device holds a record of. A record of an epoch is never removed, so
    /// the last key under the group's prefix names it, in the store or among what the running operation
    /// wrote.
    pub(super) fn newest_epoch(&self, group: &GroupId) -> Option<u64> {
        let first = group_key(table::CHAIN, SUB_EPOCH, group, &[]);
        let last = group_key(table::CHAIN, SUB_EPOCH, group, &[0xFF; 8]);
        let epoch_of = |key: &Vec<u8>| {
            key.get(first.len()..)
                .and_then(|epoch| <[u8; 8]>::try_from(epoch).ok())
                .map(u64::from_be_bytes)
        };
        let stored = self
            .mirror
            .range(first.clone()..=last.clone())
            .next_back()
            .and_then(|(key, _)| epoch_of(key));
        let written = self
            .memory
            .wire
            .written
            .range(first.clone()..=last)
            .next_back()
            .and_then(|(key, _)| epoch_of(key));
        stored.max(written)
    }

    /// The roles of `leaves` under the room state that the Commit naming `room_epoch` was judged with, and the
    /// seat among them.
    pub(super) fn roles(
        &self,
        group: &GroupId,
        leaves: &[(LeafNodeIndex, DeviceId)],
        room_epoch: u64,
    ) -> Result<EpochFacts, Error> {
        let devices = leaves.iter().map(|(_, device)| *device);
        if group.is_room() {
            return Ok(EpochFacts {
                leaves: devices.map(|device| (device, Some(Role::Human))).collect(),
                seat: None,
                end: None,
                learned: false,
            });
        }
        let session = self
            .memory
            .groups
            .get(group)
            .and_then(|meta| meta.session)
            .ok_or(Error::Internal("a session group without its extension"))?;
        let history = self.history()?;
        let room = history.at(room_epoch).unwrap_or(history.newest());
        let main = session.parent.is_zero();
        let seat = if main {
            observer::seat(&session, leaves, room)
        } else {
            match self.known().main_session(&session.parent, room_epoch) {
                Parent::Seat(seat) => seat,
                // A device that does not follow the main session takes the one enrolled agent device
                // among the leaves for the opener.
                Parent::Unknown => {
                    let mut agents = devices.clone().filter(|device| room.is_agent(device));
                    agents.next().filter(|_| agents.next().is_none())
                }
                Parent::NotAMainSession => None,
            }
            .filter(|seat| devices.clone().any(|device| device == *seat))
        };
        let leaves = devices
            .map(|device| {
                let role = if room.is_human(&device) {
                    Some(Role::Human)
                } else if seat == Some(device) {
                    Some(if main { Role::Agent } else { Role::Opener })
                } else if main {
                    None
                } else {
                    Some(Role::Helper)
                };
                (device, role)
            })
            .collect();
        Ok(EpochFacts {
            leaves,
            seat,
            end: None,
            learned: false,
        })
    }

    /// Records the epoch `group` now stands in, with its leaves. When a Commit is being merged, the record
    /// of the epoch it ended is closed and its Cuts are applied, all in `batch`.
    pub(super) fn record_epoch(
        &mut self,
        batch: &mut Batch,
        group: &GroupId,
        epoch: u64,
        leaves: &[(LeafNodeIndex, DeviceId)],
        room_epoch: u64,
    ) -> Result<(), Error> {
        let merging = self.memory.wire.merging.take();
        let facts = self.roles(group, leaves, room_epoch)?;
        // The first epoch this device stands in is where its own knowledge of the group begins.
        if self.newest_epoch(group).is_none() {
            self.put_origin(batch, group, epoch)?;
        }
        // The device's own chain in the group exists from its first epoch there on.
        let own_chain = group_key(table::CHAIN, SUB_OWN_CHAIN, group, &[]);
        if self.stored(&own_chain).is_none() {
            self.put_stored(batch, own_chain, OwnChain::new().to_bytes()?);
        }
        self.put_stored(
            batch,
            group_key(table::CHAIN, SUB_EPOCH, group, &epoch.to_be_bytes()),
            codec::encode(&facts)?,
        );
        let Some(merging) = merging else {
            return Ok(());
        };
        if let Some(before) = epoch.checked_sub(1) {
            if let Some(mut ended) = self.epoch_facts(group, before)? {
                if ended.end.is_none() {
                    ended.end = Some(merging.end);
                    self.put_stored(
                        batch,
                        group_key(table::CHAIN, SUB_EPOCH, group, &before.to_be_bytes()),
                        codec::encode(&ended)?,
                    );
                }
            }
        }
        for cut in &merging.cuts {
            self.apply_cut(batch, group, cut, epoch)?;
        }
        Ok(())
    }

    /// A Commit of another device is being merged: its note says when it was made and which chains it cuts.
    pub(super) fn merging_foreign(&mut self, note: Option<&crate::mls::profile::CommitNote>) {
        let now = self.memory.wire.now_ms;
        self.memory.wire.merging = note.map(|note| Merging {
            end: EpochEnd {
                processed_at: now,
                time: note.time,
            },
            cuts: note.cuts.clone(),
        });
    }

    /// This device's own Commit with the outbox entry `outbox`, made at `time`, is being merged. The moment
    /// it processes the Commit is the latest clock it was told, and no earlier than the making. The Cuts are
    /// the ones kept with that outbox entry: `Error::Storage` when they are not there, since a Commit that
    /// removes a leaf must end its chain.
    pub(super) fn merging_own(
        &mut self,
        group: &GroupId,
        outbox: u64,
        time: u64,
    ) -> Result<(), Error> {
        let cuts = self
            .stored(&group_key(table::CHAIN, SUB_OWN_CUTS, group, &[]))
            .and_then(|value| codec::decode::<OwnCuts>(value, value.len()).ok())
            .filter(|own| own.outbox == outbox)
            .map(|own| own.cuts)
            .ok_or_else(|| damaged("the Cuts of an own Commit"))?;
        self.memory.wire.merging = Some(Merging {
            end: EpochEnd {
                processed_at: time.max(self.memory.wire.now_ms),
                time,
            },
            cuts,
        });
        Ok(())
    }

    /// A Commit of this device was built with these Cuts: they are kept until it is put in the outbox or
    /// merged.
    pub(super) fn built_cuts(&mut self, cuts: &[Cut]) {
        self.memory.wire.built = cuts.to_vec();
    }

    /// Keeps the Cuts of the own Commit just built, under its outbox entry, until it is merged.
    pub(super) fn keep_own_cuts(
        &mut self,
        batch: &mut Batch,
        group: &GroupId,
        outbox: u64,
    ) -> Result<(), Error> {
        let own = OwnCuts {
            outbox,
            cuts: std::mem::take(&mut self.memory.wire.built),
        };
        self.put_stored(
            batch,
            group_key(table::CHAIN, SUB_OWN_CUTS, group, &[]),
            codec::encode(&own)?,
        );
        Ok(())
    }

    /// The own Commit just built is merged at once, at `now_ms`.
    pub(super) fn merging_now(&mut self, now_ms: u64) {
        self.memory.wire.merging = Some(Merging {
            end: EpochEnd {
                processed_at: now_ms,
                time: now_ms,
            },
            cuts: std::mem::take(&mut self.memory.wire.built),
        });
    }

    // ---- chains, objects, registers ----

    pub(super) fn chains(&self, group: &GroupId) -> Result<Chains, Error> {
        self.stored(&group_key(table::CHAIN, SUB_CHAINS, group, &[]))
            .map_or(Ok(Chains::new()), Chains::from_bytes)
    }

    pub(super) fn put_chains(
        &mut self,
        batch: &mut Batch,
        group: &GroupId,
        chains: &Chains,
    ) -> Result<(), Error> {
        self.put_stored(
            batch,
            group_key(table::CHAIN, SUB_CHAINS, group, &[]),
            chains.to_bytes()?,
        );
        Ok(())
    }

    pub(super) fn object_states(&self, group: &GroupId) -> Result<Objects, Error> {
        self.stored(&group_key(table::OBJECT, 0, group, &[]))
            .map_or(Ok(Objects::new()), Objects::from_bytes)
    }

    pub(super) fn put_objects(
        &mut self,
        batch: &mut Batch,
        group: &GroupId,
        objects: &Objects,
    ) -> Result<(), Error> {
        self.put_stored(
            batch,
            group_key(table::OBJECT, 0, group, &[]),
            objects.to_bytes()?,
        );
        Ok(())
    }

    pub(super) fn registers(&self, group: &GroupId) -> Result<Registers, Error> {
        self.stored(&group_key(table::REGISTER, SUB_REGISTERS, group, &[]))
            .map_or(Ok(Registers::new()), Registers::from_bytes)
    }

    pub(super) fn put_registers(
        &mut self,
        batch: &mut Batch,
        group: &GroupId,
        registers: &Registers,
    ) -> Result<(), Error> {
        self.put_stored(
            batch,
            group_key(table::REGISTER, SUB_REGISTERS, group, &[]),
            registers.to_bytes()?,
        );
        Ok(())
    }

    pub(super) fn group_state(&self, group: &GroupId) -> Result<GroupState, Error> {
        self.stored(&group_key(table::CHAIN, SUB_GROUP_STATE, group, &[]))
            .map_or(Ok(GroupState::default()), |value| {
                codec::decode(value, value.len()).map_err(|_| damaged("a group's content record"))
            })
    }

    pub(super) fn put_group_state(
        &mut self,
        batch: &mut Batch,
        group: &GroupId,
        state: &GroupState,
    ) -> Result<(), Error> {
        self.put_stored(
            batch,
            group_key(table::CHAIN, SUB_GROUP_STATE, group, &[]),
            codec::encode(state)?,
        );
        Ok(())
    }

    // ---- accepted envelopes ----

    fn record_key(group: &GroupId, sender: &DeviceId, seq: u64) -> Vec<u8> {
        group_key(
            table::CHAIN,
            SUB_RECORD,
            group,
            &[&sender.as_bytes()[..], &seq.to_be_bytes()].concat(),
        )
    }

    pub(super) fn record(
        &self,
        group: &GroupId,
        sender: &DeviceId,
        seq: u64,
    ) -> Result<Option<Record>, Error> {
        self.stored(&Self::record_key(group, sender, seq))
            .map(|value| codec::decode(value, value.len()).map_err(|_| damaged("a chain record")))
            .transpose()
    }

    /// The record of the envelope with this hash in `group`.
    pub(super) fn record_by_hash(
        &self,
        group: &GroupId,
        hash: &Hash32,
    ) -> Result<Option<Record>, Error> {
        let Some(place) = self.stored(&group_key(
            table::CHAIN,
            SUB_BY_HASH,
            group,
            hash.as_bytes(),
        )) else {
            return Ok(None);
        };
        let mut reader = Reader::new(place);
        let sender: DeviceId = reader.value().map_err(|_| damaged("a chain index"))?;
        let seq = reader.u64().map_err(|_| damaged("a chain index"))?;
        Ok(self
            .record(group, &sender, seq)?
            .filter(|record| record.hash == *hash))
    }

    pub(super) fn put_envelope_record(
        &mut self,
        batch: &mut Batch,
        group: &GroupId,
        record: &Record,
    ) -> Result<(), Error> {
        let (sender, seq) = (record.header.sender, record.header.seq);
        self.put_stored(
            batch,
            Self::record_key(group, &sender, seq),
            codec::encode(record)?,
        );
        self.put_stored(
            batch,
            group_key(table::CHAIN, SUB_BY_HASH, group, record.hash.as_bytes()),
            [&sender.as_bytes()[..], &seq.to_be_bytes()].concat(),
        );
        Ok(())
    }

    /// Every record of `group`, in the hub's order.
    fn records(&self, group: &GroupId) -> Result<Vec<Record>, Error> {
        let prefix = group_key(table::CHAIN, SUB_RECORD, group, &[]);
        let mut records = self
            .stored_under(&prefix)
            .into_iter()
            .map(|(_, value)| {
                codec::decode::<Record>(&value, value.len()).map_err(|_| damaged("a chain record"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        records.sort_by_key(|record| (record.change, record.header.sender, record.header.seq));
        Ok(records)
    }

    /// The object states of `group` as they stood just before the change number `change`: for an envelope
    /// that comes behind later ones of its group, which is judged at its own place (9.2.1).
    pub(super) fn objects_before(&self, group: &GroupId, change: u64) -> Result<Objects, Error> {
        let facts = Facts(self);
        let mut objects = Objects::new();
        for record in self.records(group)? {
            if record.change >= change || record.status != Status::Taken {
                continue;
            }
            match objects::judge(&facts, &objects, &record.header, &record.hash) {
                Ok(Some(transition)) => objects.apply(&transition)?,
                Ok(None) | Err(Error::Forbidden) => {}
                Err(fault) => return Err(fault),
            }
        }
        Ok(objects)
    }

    /// Builds the object states and registers of `group` again from the records the device holds, in the
    /// hub's order (9.2.1): after a Cut dropped envelopes it had applied (9.0.10), and after an envelope
    /// was accepted behind later ones of its group. Each envelope is judged against the state just before
    /// it, so one that was forbidden where it was first met may count now, and the other way round; void
    /// records and what was refused for another reason stay out.
    pub(super) fn replay_group(&mut self, batch: &mut Batch, group: &GroupId) -> Result<(), Error> {
        let records = self.records(group)?;
        let mut objects = Objects::new();
        let mut registers = Registers::new();
        let mut changed = Vec::new();
        {
            let facts = Facts(self);
            for mut record in records {
                if !matches!(record.status, Status::Taken | Status::Forbidden) {
                    continue;
                }
                let status = match objects::judge(&facts, &objects, &record.header, &record.hash) {
                    // What check 7 refused where it came and that was of an ended epoch stays refused:
                    // it never met check 8.
                    Ok(_) if record.status == Status::Forbidden && !record.fresh => {
                        Status::Forbidden
                    }
                    Ok(transition) => {
                        if let Some(transition) = transition {
                            objects.apply(&transition)?;
                        }
                        Status::Taken
                    }
                    Err(Error::Forbidden) => Status::Forbidden,
                    Err(fault) => return Err(fault),
                };
                if status == Status::Taken {
                    take_extra(&facts, &mut registers, &record)?;
                }
                if status != record.status {
                    record.status = status;
                    record.code = (status == Status::Forbidden).then_some(Error::Forbidden);
                    changed.push(record);
                }
            }
        }
        for record in changed {
            self.put_envelope_record(batch, group, &record)?;
        }
        self.put_objects(batch, group, &objects)?;
        self.put_registers(batch, group, &registers)?;
        self.refresh_undecided(batch, group)
    }

    // ---- Cuts ----

    pub(super) fn removal(
        &self,
        group: &GroupId,
        device: &DeviceId,
    ) -> Result<Option<Removal>, Error> {
        self.stored(&group_key(table::CHAIN, SUB_CUT, group, device.as_bytes()))
            .map(|value| codec::decode(value, value.len()).map_err(|_| damaged("a Cut")))
            .transpose()
    }

    pub(super) fn cut(&self, group: &GroupId, device: &DeviceId) -> Result<Option<Head>, Error> {
        Ok(self.removal(group, device)?.map(|removal| removal.cut))
    }

    /// Ends the chain of a removed device at its Cut (9.0.10): the Cut is kept for ever, the first one for a
    /// device stands; what this device had accepted beyond it is dropped, and the group's object states and
    /// registers are built again without it.
    fn apply_cut(
        &mut self,
        batch: &mut Batch,
        group: &GroupId,
        cut: &Cut,
        epoch: u64,
    ) -> Result<(), Error> {
        if self.cut(group, &cut.device)?.is_some() {
            return Ok(());
        }
        self.end_chain(batch, group, cut, epoch)
    }

    /// Writes the Cut of a removed device and does to its chain what the Cut says, whatever Cut was held
    /// for it before.
    pub(super) fn end_chain(
        &mut self,
        batch: &mut Batch,
        group: &GroupId,
        cut: &Cut,
        epoch: u64,
    ) -> Result<(), Error> {
        let head = Head {
            seq: cut.seq,
            hash: cut.hash,
        };
        self.put_stored(
            batch,
            group_key(table::CHAIN, SUB_CUT, group, cut.device.as_bytes()),
            codec::encode(&Removal { cut: head, epoch })?,
        );
        let mut chains = self.chains(group)?;
        let effect = chain::cut_chain(&Facts(self), &chains, group, &cut.device, &head)?;
        chains.apply_cut(&effect);
        self.put_chains(batch, group, &chains)?;
        if let Some(code) = &effect.finding {
            self.put_stored(
                batch,
                group_key(table::CHAIN, SUB_FINDING, group, cut.device.as_bytes()),
                code.code().as_bytes().to_vec(),
            );
        }
        let Some(from) = effect.drop_from else {
            return Ok(());
        };
        let prefix = group_key(table::CHAIN, SUB_RECORD, group, cut.device.as_bytes());
        for (key, value) in self.stored_under(&prefix) {
            let record: Record =
                codec::decode(&value, value.len()).map_err(|_| damaged("a chain record"))?;
            if record.header.seq >= from {
                self.delete_stored(batch, key);
                self.delete_stored(
                    batch,
                    group_key(table::CHAIN, SUB_BY_HASH, group, record.hash.as_bytes()),
                );
            }
        }
        self.replay_group(batch, group)
    }

    /// The findings made while Commits were processed, until [`Device::findings_read`] clears them.
    pub fn findings(&self) -> Result<Vec<Finding>, Error> {
        self.owner()?;
        let prefix = [table::CHAIN, SUB_FINDING];
        self.stored_under(&prefix)
            .into_iter()
            .map(|(key, value)| {
                let mut rest = Reader::new(key.get(prefix.len()..).unwrap_or_default());
                let group = super::group_after(&mut rest)?;
                let sender = rest.value()?;
                let code = std::str::from_utf8(&value)
                    .ok()
                    .and_then(Error::from_code)
                    .ok_or(Error::BadFormat)?;
                Ok(Finding {
                    group,
                    sender,
                    code,
                })
            })
            .collect::<Result<Vec<_>, Error>>()
            .map_err(|_| damaged("a finding"))
    }

    /// The client has shown the findings: they go.
    pub fn findings_read(&mut self) -> Result<(), Error> {
        self.transact(|this, batch| {
            this.begin(0);
            for (key, _) in this.stored_under(&[table::CHAIN, SUB_FINDING]) {
                this.delete_stored(batch, key);
            }
            Ok(())
        })
    }

    /// The leaves of `group` in its newest recorded epoch that the newest room state does not allow.
    fn unfit_now(&self, group: &GroupId, meta: &GroupMeta) -> Result<bool, Error> {
        let Some(epoch) = self.newest_epoch(group) else {
            return Ok(false);
        };
        let leaves: BTreeSet<DeviceId> = self
            .epoch_facts(group, epoch)?
            .map(|facts| facts.leaves.into_iter().map(|(device, _)| device).collect())
            .unwrap_or_default();
        Ok(!self.disallowed(meta, &leaves, &self.known()).is_empty())
    }
}

/// Takes what a taken envelope's record kept of its body into the registers: a register's value, a Note
/// version's lamport. A value the registers refuse is not taken.
pub(super) fn take_extra(
    facts: &dyn GroupFacts,
    registers: &mut Registers,
    record: &Record,
) -> Result<(), Error> {
    match &record.header.subject {
        Subject::Register(_) if !record.extra.is_empty() => {
            match registers.judge(facts, &record.header, &record.extra) {
                Ok(update) => registers.apply(&update),
                Err(fault @ (Error::Storage(_) | Error::Internal(_))) => Err(fault),
                Err(_) => Ok(()),
            }
        }
        Subject::Version(fields) if fields.object_type == ObjectType::Note => {
            if let Ok(lamport) = <[u8; 8]>::try_from(record.extra.as_slice()) {
                registers.observe_lamport(u64::from_be_bytes(lamport));
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

/// The device's answers to the stored-content rules.
pub(super) struct Facts<'a, S: Storage>(pub &'a Device<S>);

impl<S: Storage> Facts<'_, S> {
    /// The record of `epoch`: `group-behind` for an epoch before the first one this device holds a record
    /// of, which it has not processed.
    fn epoch(&self, group: &GroupId, epoch: u64) -> Result<EpochFacts, Error> {
        self.0.epoch_facts(group, epoch)?.ok_or(Error::GroupBehind)
    }
}

impl<S: Storage> GroupFacts for Facts<'_, S> {
    fn room(&self) -> RoomId {
        self.0.memory.record.room.unwrap_or(RoomId::ZERO)
    }

    fn processed_epoch(&self, group: &GroupId) -> Result<Option<u64>, Error> {
        if !self.0.memory.groups.contains_key(group) {
            return Ok(None);
        }
        Ok(self.0.newest_epoch(group))
    }

    fn leaf_role(
        &self,
        group: &GroupId,
        epoch: u64,
        device: &DeviceId,
    ) -> Result<Option<Role>, Error> {
        Ok(self
            .epoch(group, epoch)?
            .leaves
            .into_iter()
            .find(|(leaf, _)| leaf == device)
            .and_then(|(_, role)| role))
    }

    fn seat(&self, group: &GroupId, epoch: u64) -> Result<Option<DeviceId>, Error> {
        Ok(self.epoch(group, epoch)?.seat)
    }

    fn cut(&self, group: &GroupId, device: &DeviceId) -> Result<Option<Head>, Error> {
        self.0.cut(group, device)
    }

    /// From the record of the removal itself: the epoch that began without the device's leaf. A Commit that
    /// removes a leaf and adds the same key at once is seen this way too.
    fn removed_by(&self, group: &GroupId, epoch: u64, device: &DeviceId) -> Result<bool, Error> {
        Ok(self
            .0
            .removal(group, device)?
            .is_some_and(|removal| removal.epoch <= epoch))
    }

    fn epoch_end(&self, group: &GroupId, epoch: u64) -> Result<Option<EpochEnd>, Error> {
        Ok(self
            .0
            .epoch_facts(group, epoch)?
            .and_then(|facts| facts.end))
    }

    fn is_stale(&self, group: &GroupId) -> Result<bool, Error> {
        match self.0.memory.groups.get(group) {
            Some(meta) if !meta.removed => self.0.unfit_now(group, meta),
            _ => Ok(false),
        }
    }

    fn is_human_now(&self, device: &DeviceId) -> Result<bool, Error> {
        Ok(self
            .0
            .room_history()
            .is_some_and(|history| history.newest().is_human(device)))
    }

    fn content_key(&self, group: &GroupId, epoch: u64) -> Result<Option<Secret<32>>, Error> {
        let distrusted = self
            .0
            .memory
            .groups
            .get(group)
            .is_some_and(|meta| meta.distrusted);
        if distrusted {
            return Ok(None);
        }
        Ok(self
            .0
            .memory
            .keys
            .get(&(*group, epoch))
            .map(Secret::duplicate))
    }
}

impl<S: Storage> chain::ChainRecords for Facts<'_, S> {
    fn accepted_hash(
        &self,
        group: &GroupId,
        sender: &DeviceId,
        seq: u64,
    ) -> Result<Option<Hash32>, Error> {
        Ok(self.0.record(group, sender, seq)?.map(|record| record.hash))
    }
}
