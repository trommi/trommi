//! The vault: this installation's device (`trommi_core::device::Device`) over its journal.
//!
//! The device does everything of the protocol: groups, MLS messages, stored content, joining by link, signing
//! in. What the vault adds is the journal's commit: every operation of the device stages its batch
//! (`store.rs`), and [`Vault::commit`] writes it as one record together with whatever the connector derived
//! from that operation. The client commits before anything of an operation leaves the process.
use crate::error::{Fault, Result};
use crate::store::{CoreStore, Journal, SIDE};
use trommi_core::crypto::SystemEntropy;
use trommi_core::device::Device;
use trommi_core::ids::{DeviceId, GroupId};

/// The key of one of the connector's own entries: [`SIDE`], a tag, then the parts, each with its length so that
/// no key is the start of another.
pub fn side_key(tag: u8, parts: &[&[u8]]) -> Vec<u8> {
    let mut key = vec![SIDE, tag];
    for part in parts {
        key.push(part.len() as u8);
        key.extend_from_slice(part);
    }
    key
}

fn damaged(what: &str) -> Fault {
    Fault::new(
        "state-damaged",
        format!("the stored state does not read ({what})"),
    )
}

/// The device and its journal. See the module's documentation.
pub struct Vault {
    journal: Journal,
    /// The core's device. Whoever calls it commits the vault before anything leaves.
    pub device: Device<CoreStore>,
}

impl std::fmt::Debug for Vault {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Vault({})", self.device.id().to_base64url())
    }
}

impl Vault {
    /// A new device in an empty journal, written before this returns.
    pub fn create(journal: Journal) -> Result<Vault> {
        if !journal.is_empty() {
            return Err(damaged("a new device needs an empty state"));
        }
        let device = Device::create(journal.core_store(), Box::new(SystemEntropy))?;
        let mut vault = Vault { journal, device };
        vault.commit()?;
        Ok(vault)
    }

    /// The device a journal holds. `state-damaged` when anything in it does not read (also a state written
    /// for an earlier core): the human then reconnects the session; nothing is re-keyed here.
    pub fn open(journal: Journal) -> Result<Vault> {
        let device = Device::open(journal.core_store(), Box::new(SystemEntropy))
            .map_err(|error| damaged(&Fault::from(error).text()))?;
        Ok(Vault { journal, device })
    }

    /// The journal, for the connector's other entries.
    pub fn journal(&self) -> &Journal {
        &self.journal
    }

    /// This device's id.
    pub fn me(&self) -> DeviceId {
        self.device.id()
    }

    /// Writes everything staged as one record.
    pub fn commit(&mut self) -> Result<()> {
        Ok(self.journal.commit()?)
    }

    /// The device a human addresses in a session group now: its agent leaf, or a helper session's opener.
    /// Both are the leaf that is an agent device of the room (4.1, 5.2.3).
    pub fn seat(&self, group: &GroupId) -> Option<DeviceId> {
        let summary = self.device.group(group).ok()?;
        let room = self.device.room_history()?.newest();
        summary
            .leaves
            .iter()
            .copied()
            .find(|leaf| room.is_agent(leaf))
    }
}
