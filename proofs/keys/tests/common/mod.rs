//! Test support: a room with its stub hub, and the client flows around a commit.
#![allow(dead_code)]

use openmls::prelude::{tls_codec::Serialize as _, ProcessedMessageContent};
use trommi_proof_keys::device::{parse_msg, Change, Device};
use trommi_proof_keys::hub::{Hub, Reject, Rows};
use trommi_proof_keys::rules::{GroupMeta, Kind};
use trommi_proof_keys::seal::{self, Recovery};
use trommi_proof_keys::{hex, unhex, Gid};

pub struct World {
    pub hub: Hub,
    pub rec: Recovery,
    pub room: Gid,
}

pub fn session_meta(room: &[u8], founder: &Device, parent: Option<&[u8]>) -> GroupMeta {
    GroupMeta {
        kind: Kind::Session,
        room: hex(room),
        parent: parent.map(hex),
        founder: hex(&founder.sig()),
        agents: vec![],
        recovery_sign: None,
        recovery_hpke: None,
    }
}

impl World {
    /// The first human device founds the room group. The recovery key's public halves
    /// go into the room statement; the first archive row goes to the hub.
    pub fn found(first: &mut Device, code: &str) -> World {
        let rec = Recovery::from_code(first.crypto(), code);
        let room = b"room-1".to_vec();
        let meta = GroupMeta {
            kind: Kind::Room,
            room: hex(&room),
            parent: None,
            founder: hex(&first.sig()),
            agents: vec![],
            recovery_sign: Some(hex(rec.signer.public())),
            recovery_hpke: Some(hex(&rec.hpke_public)),
        };
        let mut hub = Hub::new();
        let gi = first.found(&room, &meta);
        hub.found_group(&gi).expect("hub takes the room group");
        let row = seal::make_archive_row(first.crypto(), &room, 0, &first.archive[&0], None, &rec.hpke_public);
        hub.archive.insert(0, row);
        World { hub, rec, room }
    }

    pub fn recovery_hpke(&self) -> Vec<u8> {
        unhex(self.hub.meta(&self.room).recovery_hpke.as_ref().unwrap())
    }

    /// A device publishes `n` one-time key packages and one last-resort key package.
    pub fn publish(&mut self, dev: &Device, n: usize) {
        for _ in 0..n {
            self.hub.publish_key_package(&dev.sig(), dev.key_package(false), false);
        }
        self.hub.publish_key_package(&dev.sig(), dev.key_package(true), true);
    }

    /// A commit in the room group by a human device, with its archive row.
    pub fn room_commit(&mut self, dev: &mut Device, change: Change) -> Result<u64, Reject> {
        let room = self.room.clone();
        let new_meta = change.meta.clone();
        let out = dev.commit(&room, change).map_err(Reject::Mls)?;
        let row = dev.archive_row_for_pending(new_meta.as_ref()).map_err(Reject::Mls)?;
        match self.hub.submit(&out, Rows { archive: Some(row), epoch_key: None }) {
            Ok(e) => {
                dev.confirm(&room);
                Ok(e)
            }
            Err(r) => {
                dev.abort(&room);
                Err(r)
            }
        }
    }

    /// A commit in a session group. A human device adds the new epoch's key, sealed
    /// under its newest archive key; an agent cannot (it has no archive key).
    pub fn session_commit(&mut self, dev: &mut Device, gid: &[u8], change: Change) -> Result<u64, Reject> {
        let out = dev.commit(gid, change).map_err(Reject::Mls)?;
        let epoch_key = if dev.room.is_some() {
            let (key, _) = dev.staged_keys(gid);
            Some(dev.epoch_key_row(gid, out.epoch + 1, &key))
        } else {
            None
        };
        match self.hub.submit(&out, Rows { archive: None, epoch_key }) {
            Ok(e) => {
                dev.confirm(gid);
                Ok(e)
            }
            Err(r) => {
                dev.abort(gid);
                Err(r)
            }
        }
    }

    /// Fetches the commits a device has missed in a group and processes them in order.
    pub fn sync(&self, dev: &mut Device, gid: &[u8]) -> Result<usize, String> {
        let view = if dev.room.is_some() { None } else { self.hub.room_view() };
        let commits = self.hub.commits_since(gid, dev.epoch(gid));
        for c in &commits {
            dev.process(gid, c, view.as_ref())?;
        }
        Ok(commits.len())
    }

    /// Fetches and joins every Welcome waiting for a device.
    pub fn welcome(&mut self, dev: &mut Device) -> Vec<Gid> {
        self.hub
            .welcomes_for(&dev.sig())
            .iter()
            .map(|w| dev.join(w).expect("join by Welcome"))
            .collect()
    }

    /// A human device adds a new human device to the room group.
    pub fn add_human(&mut self, adder: &mut Device, new: &mut Device) {
        if self.hub.unused_key_packages(&new.sig()) == 0 {
            self.publish(new, 1);
        }
        let kp = self.hub.take_key_package(&new.sig()).unwrap();
        // the adder knows the new device's signature key from the invite (check code)
        assert_eq!(trommi_proof_keys::device::key_package_owner(&kp, adder.crypto()).unwrap(), new.sig());
        self.room_commit(adder, Change { adds: vec![kp], ..Default::default() })
            .expect("add human device");
        self.welcome(new);
    }

    /// A human device enrols an agent device: its signature key goes into the roster
    /// in the room statement. One room commit.
    pub fn enrol_agent(&mut self, human: &mut Device, agent: &Device) {
        let mut meta = human.meta(&self.room);
        meta.agents.push(hex(&agent.sig()));
        self.room_commit(human, Change { meta: Some(meta), ..Default::default() })
            .expect("enrol agent");
    }

    /// A human device founds a session group and adds the other members in one commit.
    pub fn new_session(&mut self, founder: &mut Device, name: &str, others: &[&Device]) -> Gid {
        let gid = name.as_bytes().to_vec();
        let gi = founder.found(&gid, &session_meta(&self.room, founder, None));
        self.hub.found_group(&gi).expect("hub takes the session group");
        let adds = others
            .iter()
            .map(|d| self.hub.take_key_package(&d.sig()).expect("a key package"))
            .collect();
        self.session_commit(founder, &gid, Change { adds, ..Default::default() })
            .expect("founding commit");
        gid
    }
}

impl World {
    /// A device joins a session group by external commit from the hub's GroupInfo.
    pub fn external_session(&mut self, dev: &mut Device, gid: &[u8]) -> Result<u64, Reject> {
        let out = dev.external_join(&self.hub.group_info(gid), vec![]).map_err(Reject::Mls)?;
        let epoch_key = if dev.room.is_some() {
            let (key, _) = dev.staged_keys(gid);
            Some(dev.epoch_key_row(gid, out.epoch + 1, &key))
        } else {
            None
        };
        match self.hub.submit(&out, Rows { archive: None, epoch_key }) {
            Ok(e) => {
                dev.confirm(gid);
                Ok(e)
            }
            Err(r) => {
                dev.forget(gid);
                Err(r)
            }
        }
    }
}

/// A standard MLS application message (PrivateMessage) in a group.
pub fn app_send(d: &mut Device, gid: &[u8], text: &[u8]) -> Vec<u8> {
    let g = d.groups.get_mut(gid).unwrap();
    g.create_message(&d.prov, &d.signer, text).unwrap().tls_serialize_detached().unwrap()
}

/// Opens a standard MLS application message.
pub fn app_open(d: &mut Device, gid: &[u8], msg: &[u8]) -> Result<Vec<u8>, String> {
    let pm = parse_msg(msg)?.try_into_protocol_message().map_err(|e| format!("{e:?}"))?;
    let g = d.groups.get_mut(gid).unwrap();
    match g.process_message(&d.prov, pm).map_err(|e| format!("{e:?}"))?.into_content() {
        ProcessedMessageContent::ApplicationMessage(m) => Ok(m.into_bytes()),
        other => Err(format!("not readable: {other:?}").chars().take(60).collect()),
    }
}

