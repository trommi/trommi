//! One room as the hub's checks see it: the storage of hub/store.mjs roomStorage(), on rusqlite.

use crate::db::{derive_row, DeriveRow};
use rusqlite::{params, Connection, OptionalExtension};
use zcrypto::envelope::{Header, TIMELINE_CHAT};
use zcrypto::log::{LogState, ENTRY_ADD, ENTRY_GENESIS, ENTRY_RECOVER, ENTRY_REMOVE};
use zcrypto::{hex, ROLE_HUMAN};

pub type R<T> = rusqlite::Result<T>;

pub fn action_name(ty: u8) -> &'static str {
    match ty {
        ENTRY_GENESIS => "room_founded",
        ENTRY_ADD => "device_added",
        ENTRY_REMOVE => "devices_removed",
        ENTRY_RECOVER => "recovery",
        _ => "unknown",
    }
}

#[derive(Clone, Debug)]
pub struct JoinRequest {
    pub hash: String,
    pub bytes: Vec<u8>,
    pub device: String,
    pub at: i64,
}
#[derive(Clone, Debug)]
pub struct Invite {
    pub id: String,
    pub role: String,
    pub inviter: String,
    pub expires_at: i64,
    pub used_at: Option<i64>,
    pub burned_at: Option<i64>,
    pub offer: Vec<u8>,
    pub requests: Vec<JoinRequest>,
    pub reveal: Option<(Vec<u8>, String)>,
    pub member: Option<String>,
    pub entry_seq: Option<i64>,
}
#[derive(Clone, Debug)]
pub struct Lease {
    pub instance: String,
    pub generation: i64,
    pub expires_at: i64,
}
pub struct ObjectInfo {
    pub owner: String,
    pub first_kind: u8,
    pub key_scope: u8,
    pub session_id: Option<String>,
}

pub struct Store<'a> {
    pub c: &'a Connection,
    pub room: &'a str,
}

impl<'a> Store<'a> {
    pub fn new(c: &'a Connection, room: &'a str) -> Self { Store { c, room } }

    pub fn entries(&self) -> R<Vec<Vec<u8>>> {
        self.c.prepare_cached("SELECT signed_entry FROM member_entries WHERE room_id = ? ORDER BY entry_number")?.query_map([self.room], |r| r.get(0))?.collect()
    }
    pub fn entry_times(&self) -> R<Vec<i64>> {
        self.c.prepare_cached("SELECT received_at FROM member_entries WHERE room_id = ? ORDER BY entry_number")?.query_map([self.room], |r| r.get(0))?.collect()
    }
    #[allow(clippy::too_many_arguments)]
    pub fn append_entry(&self, entry: &[u8], seq: u32, hash: &str, prev: &str, ty: u8, signer: &str, at: i64, state: &LogState, removed: &[String]) -> R<()> {
        self.c
            .prepare_cached("INSERT INTO member_entries (room_id, entry_number, previous_entry_hash, entry_hash, entry_action, signer_device_id, signed_entry, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")?
            .execute(params![self.room, seq, prev, hash, action_name(ty), signer, entry, at])?;
        if seq == 0 {
            self.c.prepare_cached("INSERT INTO rooms (room_id, founded_at, last_entry_number) VALUES (?, ?, 0)")?.execute(params![self.room, at])?;
        } else {
            self.c.prepare_cached("UPDATE rooms SET last_entry_number = ? WHERE room_id = ?")?.execute(params![seq, self.room])?;
        }
        for m in state.members.values() {
            self.c
                .prepare_cached(
                    "INSERT INTO devices (room_id, device_id, device_role, key_signing_public, key_exchange_public, added_entry_number, removed_entry_number, removal_cut_sequence, removal_cut_hash)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (room_id, device_id) DO UPDATE SET removed_entry_number = excluded.removed_entry_number,
          removal_cut_sequence = excluded.removal_cut_sequence, removal_cut_hash = excluded.removal_cut_hash",
                )?
                .execute(params![
                    self.room,
                    hex(&m.id),
                    if m.role == ROLE_HUMAN { "human" } else { "agent" },
                    &m.sign_pub[..],
                    &m.kex_pub[..],
                    m.added_seq,
                    m.removed_seq,
                    m.cut.map(|c| c.0 as i64),
                    m.cut.map(|c| c.1.to_vec())
                ])?;
        }
        for d in removed {
            self.c.prepare_cached("DELETE FROM push_subscriptions WHERE room_id = ? AND device_id = ?")?.execute(params![self.room, d])?;
        }
        Ok(())
    }
    pub fn get_lease(&self, id: &str) -> R<Option<Lease>> {
        self.c
            .prepare_cached("SELECT process_instance, lease_generation, expires_at FROM agent_leases WHERE room_id = ? AND device_id = ?")?
            .query_row(params![self.room, id], |r| Ok(Lease { instance: r.get(0)?, generation: r.get(1)?, expires_at: r.get(2)? }))
            .optional()
    }
    pub fn put_lease(&self, id: &str, l: &Lease) -> R<()> {
        self.c
            .prepare_cached("INSERT INTO agent_leases (room_id, device_id, process_instance, lease_generation, expires_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (room_id, device_id) DO UPDATE SET process_instance = excluded.process_instance, lease_generation = excluded.lease_generation, expires_at = excluded.expires_at")?
            .execute(params![self.room, id, l.instance, l.generation, l.expires_at])?;
        Ok(())
    }
    pub fn delete_lease(&self, id: &str) -> R<()> {
        self.c.prepare_cached("DELETE FROM agent_leases WHERE room_id = ? AND device_id = ?")?.execute(params![self.room, id])?;
        Ok(())
    }
    pub fn put_wrap(&self, epoch: u32, id: &str, sealed: &[u8]) -> R<()> {
        self.c.prepare_cached("INSERT OR IGNORE INTO sealed_room_keys (room_id, key_epoch, device_id, key_sealed) VALUES (?, ?, ?, ?)")?.execute(params![self.room, epoch, id, sealed])?;
        Ok(())
    }
    pub fn wraps(&self, id: &str, after: i64) -> R<Vec<(i64, Vec<u8>)>> {
        self.c
            .prepare_cached("SELECT key_epoch, key_sealed FROM sealed_room_keys WHERE room_id = ? AND device_id = ? AND key_epoch > ? ORDER BY key_epoch")?
            .query_map(params![self.room, id, after], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect()
    }
    pub fn put_back_link(&self, epoch: u32, link: &[u8]) -> R<()> {
        self.c.prepare_cached("INSERT OR IGNORE INTO key_back_links (room_id, key_epoch, key_back_link) VALUES (?, ?, ?)")?.execute(params![self.room, epoch, link])?;
        Ok(())
    }
    pub fn back_links(&self) -> R<Vec<(i64, Vec<u8>)>> {
        self.c.prepare_cached("SELECT key_epoch, key_back_link FROM key_back_links WHERE room_id = ? ORDER BY key_epoch")?.query_map([self.room], |r| Ok((r.get(0)?, r.get(1)?)))?.collect()
    }
    #[allow(clippy::too_many_arguments)]
    pub fn put_grant(&self, sid: &str, bytes: &[u8], number: u32, hash: &str, prev_hash: &str, epoch: u32, signer: &str, at: i64) -> R<()> {
        self.c
            .prepare_cached("INSERT INTO session_grants (room_id, session_id, grant_number, previous_grant_hash, grant_hash, session_key_epoch, signer_device_id, signed_grant, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")?
            .execute(params![self.room, sid, number, prev_hash, hash, epoch, signer, bytes, at])?;
        Ok(())
    }
    pub fn grants(&self, sid: &str) -> R<Vec<(Vec<u8>, i64)>> {
        self.c
            .prepare_cached("SELECT signed_grant, received_at FROM session_grants WHERE room_id = ? AND session_id = ? ORDER BY grant_number")?
            .query_map(params![self.room, sid], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect()
    }
    pub fn sessions_created_by(&self, signer: &str) -> R<i64> {
        self.c.prepare_cached("SELECT COUNT(*) FROM session_grants WHERE room_id = ? AND grant_number = 0 AND signer_device_id = ?")?.query_row(params![self.room, signer], |r| r.get(0))
    }
    pub fn sessions(&self) -> R<Vec<(String, i64, i64)>> {
        self.c
            .prepare_cached("SELECT session_id, MAX(grant_number) AS last_grant_number, MAX(session_key_epoch) AS session_key_epoch FROM session_grants WHERE room_id = ? GROUP BY session_id ORDER BY session_id")?
            .query_map([self.room], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect()
    }
    pub fn put_session_wrap(&self, sid: &str, epoch: u32, id: &str, sealed: &[u8]) -> R<()> {
        self.c
            .prepare_cached("INSERT OR IGNORE INTO sealed_session_keys (room_id, session_id, session_key_epoch, device_id, key_sealed) VALUES (?, ?, ?, ?, ?)")?
            .execute(params![self.room, sid, epoch, id, sealed])?;
        Ok(())
    }
    pub fn session_wraps(&self, sid: &str, id: &str, after: i64) -> R<Vec<(i64, Vec<u8>)>> {
        self.c
            .prepare_cached("SELECT session_key_epoch, key_sealed FROM sealed_session_keys WHERE room_id = ? AND session_id = ? AND device_id = ? AND session_key_epoch > ? ORDER BY session_key_epoch")?
            .query_map(params![self.room, sid, id, after], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect()
    }
    pub fn put_session_back_link(&self, sid: &str, epoch: u32, link: &[u8]) -> R<()> {
        self.c
            .prepare_cached("INSERT OR IGNORE INTO session_key_back_links (room_id, session_id, session_key_epoch, key_back_link) VALUES (?, ?, ?, ?)")?
            .execute(params![self.room, sid, epoch, link])?;
        Ok(())
    }
    pub fn session_back_links(&self, sid: &str) -> R<Vec<(i64, Vec<u8>)>> {
        self.c
            .prepare_cached("SELECT session_key_epoch, key_back_link FROM session_key_back_links WHERE room_id = ? AND session_id = ? ORDER BY session_key_epoch")?
            .query_map(params![self.room, sid], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect()
    }

    fn invite_of(&self, row: (String, String, String, Vec<u8>, i64, Option<Vec<u8>>, Option<String>, Option<i64>, Option<String>, Option<i64>)) -> R<Invite> {
        let (id, role, inviter, offer, expires_at, reveal, answered, used_at, added, burned_at) = row;
        let requests = self
            .c
            .prepare_cached("SELECT request_hash, device_id, signed_request, received_at FROM join_requests WHERE room_id = ? AND invite_id = ? ORDER BY received_at, rowid")?
            .query_map(params![self.room, id], |r| Ok(JoinRequest { hash: r.get(0)?, device: r.get(1)?, bytes: r.get(2)?, at: r.get(3)? }))?
            .collect::<R<Vec<_>>>()?;
        let entry_seq = match &added {
            Some(d) => self.c.prepare_cached("SELECT added_entry_number FROM devices WHERE room_id = ? AND device_id = ?")?.query_row(params![self.room, d], |r| r.get(0)).optional()?,
            None => None,
        };
        Ok(Invite {
            id,
            role,
            inviter,
            expires_at,
            used_at,
            burned_at,
            offer,
            requests,
            reveal: match (reveal, answered) {
                (Some(b), Some(h)) => Some((b, h)),
                (Some(b), None) => Some((b, String::new())),
                _ => None,
            },
            member: added,
            entry_seq,
        })
    }
    const INVITE_COLS: &'static str = "invite_id, device_role, inviter_device_id, signed_offer, expires_at, signed_reveal, answered_request_hash, used_at, added_device_id, burned_at";
    pub fn invite(&self, id: &str) -> R<Option<Invite>> {
        let row = self
            .c
            .prepare_cached(&format!("SELECT {} FROM invites WHERE room_id = ? AND invite_id = ?", Self::INVITE_COLS))?
            .query_row(params![self.room, id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?)))
            .optional()?;
        row.map(|r| self.invite_of(r)).transpose()
    }
    /// Only the open ones (the limit of open invites); "now" here is the wall clock, as in store.mjs.
    pub fn open_invites(&self) -> R<Vec<Invite>> {
        let rows: Vec<_> = self
            .c
            .prepare_cached(&format!("SELECT {} FROM invites WHERE room_id = ? AND used_at IS NULL AND burned_at IS NULL AND expires_at >= ?", Self::INVITE_COLS))?
            .query_map(params![self.room, crate::util::wall() - 60000], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?)))?
            .collect::<R<_>>()?;
        rows.into_iter().map(|r| self.invite_of(r)).collect()
    }
    /// Not in a transaction of its own: the callers wrap it (hub/store.mjs putInvite).
    pub fn put_invite(&self, inv: &Invite) -> R<()> {
        self.c
            .prepare_cached(
                "INSERT INTO invites (room_id, invite_id, device_role, inviter_device_id, signed_offer, expires_at, signed_reveal, answered_request_hash, used_at, added_device_id, burned_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (room_id, invite_id) DO UPDATE SET signed_reveal = excluded.signed_reveal,
          answered_request_hash = excluded.answered_request_hash, used_at = excluded.used_at, added_device_id = excluded.added_device_id, burned_at = excluded.burned_at",
            )?
            .execute(params![
                self.room,
                inv.id,
                inv.role,
                inv.inviter,
                inv.offer,
                inv.expires_at,
                inv.reveal.as_ref().map(|r| r.0.clone()),
                inv.reveal.as_ref().map(|r| r.1.clone()),
                inv.used_at,
                inv.member,
                inv.burned_at
            ])?;
        for q in &inv.requests {
            self.c
                .prepare_cached("INSERT OR IGNORE INTO join_requests (room_id, invite_id, request_hash, device_id, signed_request, received_at) VALUES (?, ?, ?, ?, ?, ?)")?
                .execute(params![self.room, inv.id, q.hash, q.device, q.bytes, q.at])?;
        }
        Ok(())
    }

    /// Store an envelope (or a void record) with its header columns; derived rows and attachment bindings in the same step.
    #[allow(clippy::too_many_arguments)]
    pub fn append_envelope(&self, h: &Header, sender: &str, hash: &[u8], recipient: bool, push: bool, time: i64, header_bytes: &[u8], nonce: &[u8], ciphertext: Option<&[u8]>, ct_hash: &[u8], signature: &[u8], void_code: Option<&str>) -> R<i64> {
        let n: i64 = self.c.prepare_cached("SELECT last_envelope_number FROM rooms WHERE room_id = ?")?.query_row([self.room], |r| r.get(0))?;
        let n = n + 1;
        let is_void = void_code.is_some();
        let object_id = if is_void { None } else { h.card.as_ref().map(|c| hex(&c.id)) };
        let card = if is_void { None } else { h.card.as_ref() };
        let timeline_kind = if is_void { None } else { h.timeline_kind.map(|x| x as i64) };
        let timeline_id = if is_void { None } else { h.timeline_id.clone() };
        let attachment_ids = if !h.blobs.is_empty() && !is_void { Some(h.blobs.iter().map(|b| hex(b)).collect::<Vec<_>>().join(",")) } else { None };
        self.c
            .prepare_cached(
                "INSERT INTO envelopes (room_id, envelope_number, sender_device_id, sender_sequence, previous_envelope_hash, envelope_hash, key_epoch, recipient_device_id,
          object_id, object_state, urgency, answered_at, envelope_kind, timeline_kind, timeline_id, send_push, attachment_ids, padded_size, sent_at, received_at,
          envelope_header, envelope_nonce, encrypted_body, encrypted_body_hash, envelope_signature, void_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )?
            .execute(params![
                self.room,
                n,
                &h.sender[..],
                h.seq as i64,
                &h.prev[..],
                hash,
                h.epoch,
                if recipient { Some(h.recipient.to_vec()) } else { None },
                object_id,
                card.map(|c| c.state as i64),
                card.map(|c| c.urgency as i64),
                card.map(|c| c.answered_at as i64),
                h.kind,
                timeline_kind,
                timeline_id,
                push as i64,
                attachment_ids,
                ciphertext.map(|c| c.len() as i64 - 16).unwrap_or(0),
                h.time as i64,
                time,
                header_bytes,
                nonce,
                ciphertext,
                ct_hash,
                signature,
                void_code
            ])?;
        self.c.prepare_cached("UPDATE rooms SET last_envelope_number = ? WHERE room_id = ?")?.execute(params![n, self.room])?;
        if is_void {
            return Ok(n);
        }
        derive_row(
            self.c,
            &DeriveRow {
                room_id: self.room,
                envelope_number: n,
                sender,
                object_id: object_id.as_deref(),
                object_state: card.map(|c| c.state as i64),
                urgency: card.map(|c| c.urgency as i64),
                answered_at: card.map(|c| c.answered_at as i64),
                timeline_kind,
                timeline_id: timeline_id.as_deref(),
            },
        )?;
        let owner = object_id.clone().or_else(|| {
            let t = h.timeline_id.as_deref()?;
            if h.timeline_kind == Some(TIMELINE_CHAT) && t.len() == 37 && t.starts_with("card/") && zcrypto::bytes::is_hex(&t[5..], 32) {
                Some(t[5..].to_string())
            } else {
                None
            }
        });
        if let Some(owner) = owner {
            for b in &h.blobs {
                self.c
                    .prepare_cached("UPDATE attachments SET object_id = ? WHERE room_id = ? AND attachment_id = ? AND object_id IS NULL AND uploader_device_id = ?")?
                    .execute(params![owner, self.room, hex(b), sender])?;
            }
        }
        for b in &h.blobs {
            self.c
                .prepare_cached("UPDATE attachments SET referenced_at = ? WHERE room_id = ? AND attachment_id = ? AND uploader_device_id = ? AND referenced_at IS NULL")?
                .execute(params![time, self.room, hex(b), sender])?;
        }
        Ok(n)
    }

    /// What the hub needs to judge a write to an object: its creator, the kind and key scope of its first envelope.
    pub fn object_info(&self, oid: &str) -> R<Option<ObjectInfo>> {
        let r: Option<(String, i64, Vec<u8>)> = self
            .c
            .prepare_cached(
                "SELECT o.owner_device_id, e.envelope_kind, e.envelope_header FROM objects o JOIN envelopes e ON e.room_id = o.room_id AND e.envelope_number = o.first_envelope_number
        WHERE o.room_id = ? AND o.object_id = ?",
            )?
            .query_row(params![self.room, oid], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .optional()?;
        Ok(r.map(|(owner, kind, hb)| {
            let key_scope = hb.get(38).copied().unwrap_or(0);
            ObjectInfo { owner, first_kind: kind as u8, key_scope, session_id: if key_scope == 1 && hb.len() >= 55 { Some(hex(&hb[39..55])) } else { None } }
        }))
    }
    pub fn chain_heads(&self) -> R<Vec<([u8; 32], i64, [u8; 32])>> {
        let rows: Vec<(Vec<u8>, i64, Vec<u8>)> = self
            .c
            .prepare_cached("SELECT sender_device_id, MAX(sender_sequence) AS seq, envelope_hash FROM envelopes WHERE room_id = ? GROUP BY sender_device_id")?
            .query_map([self.room], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<R<_>>()?;
        Ok(rows.into_iter().filter(|r| r.0.len() == 32 && r.2.len() == 32).map(|r| (zcrypto::bytes::arr32(&r.0), r.1, zcrypto::bytes::arr32(&r.2))).collect())
    }
    pub fn envelope_hash(&self, sender: &[u8], seq: i64) -> R<Option<[u8; 32]>> {
        let r: Option<Vec<u8>> = self
            .c
            .prepare_cached("SELECT envelope_hash FROM envelopes WHERE room_id = ? AND sender_device_id = ? AND sender_sequence = ?")?
            .query_row(params![self.room, sender, seq], |r| r.get(0))
            .optional()?;
        Ok(r.filter(|h| h.len() == 32).map(|h| zcrypto::bytes::arr32(&h)))
    }
}
