//! What a room may hold besides its files' bytes: every count that could otherwise grow without end, in one
//! place. Each is a count of things ever made (a deleted file's id, an archived group and a void record stay
//! as evidence, so they keep counting). The numbers are the defaults; a hub sets others by environment
//! (`HUB_QUOTA_…`). At a limit the hub refuses with the code beside it; nothing is deleted to make room.
//! Recorded in spec/hub-api.md, "Decided for the first hub".

use rusqlite::{params, Connection};

use crate::error::{refuse, Res};
use crate::store::Room;

/// File ids a room has used, stored or deleted, zero-byte ones too. `quota-exceeded`.
pub const FILES: i64 = 50_000;
/// Register ids across all writers and groups of a room. `too-many`; the envelope takes no number.
pub const REGISTERS: i64 = 20_000;
/// Void records of a room. Past it a refusal that would be stored as a void is refused without one and takes no
/// number (`too-many`).
pub const VOIDS: i64 = 100_000;
/// Groups of a room, archived ones too. `too-many`.
pub const GROUPS: i64 = 5_000;
/// Helper devices a room has ever seen. `too-many`.
pub const HELPER_DEVICES: i64 = 10_000;
/// Human and agent devices a room has ever had (a revoked key stays on record: it never returns). `too-many`.
pub const DEVICES: i64 = 10_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Counted {
    Files,
    Registers,
    Voids,
    Groups,
    HelperDevices,
    Devices,
}

impl Counted {
    fn column(self) -> &'static str {
        match self {
            Counted::Files => "file_count",
            Counted::Registers => "register_count",
            Counted::Voids => "void_count",
            Counted::Groups => "group_count",
            Counted::HelperDevices => "helper_count",
            Counted::Devices => "device_count",
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Quotas {
    pub files: i64,
    pub registers: i64,
    pub voids: i64,
    pub groups: i64,
    pub helper_devices: i64,
    pub devices: i64,
}

impl Quotas {
    fn of(&self, what: Counted) -> i64 {
        match what {
            Counted::Files => self.files,
            Counted::Registers => self.registers,
            Counted::Voids => self.voids,
            Counted::Groups => self.groups,
            Counted::HelperDevices => self.helper_devices,
            Counted::Devices => self.devices,
        }
    }

    /// Refuses if the room is at its limit of `what`; counts nothing.
    pub fn room_for(&self, c: &Connection, room: &Room, what: Counted) -> Res<()> {
        let column = what.column();
        let held: i64 = c
            .prepare_cached(&format!("SELECT {column} FROM rooms WHERE room_id = ?1"))?
            .query_row([&room[..]], |r| r.get(0))?;
        if held < self.of(what) {
            Ok(())
        } else {
            Err(Self::refusal(what))
        }
    }

    /// Counts one more of `what` in the room, or refuses at the limit.
    pub fn take(&self, c: &Connection, room: &Room, what: Counted) -> Res<()> {
        let column = what.column();
        let n = c
            .prepare_cached(&format!(
                "UPDATE rooms SET {column} = {column} + 1 WHERE room_id = ?1 AND {column} < ?2"
            ))?
            .execute(params![&room[..], self.of(what)])?;
        if n == 1 {
            return Ok(());
        }
        Err(Self::refusal(what))
    }

    fn refusal(what: Counted) -> crate::error::Refused {
        match what {
            Counted::Files => refuse("quota-exceeded", "the room has used its number of files"),
            Counted::Registers => refuse("too-many", "the room holds its number of registers"),
            Counted::Voids => refuse("too-many", "the room holds its number of void records"),
            Counted::Groups => refuse("too-many", "the room holds its number of groups"),
            Counted::HelperDevices => {
                refuse("too-many", "the room has seen its number of helper devices")
            }
            Counted::Devices => refuse("too-many", "the room has had its number of devices"),
        }
    }
}
