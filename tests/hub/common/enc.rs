//! The test clients' own encoder for the structs of spec/v2.md, written from the spec and independent of the
//! hub's `wire` module: a mistake in the hub's encoding is not repeated here by construction. The hub's structs
//! are used as plain holders of fields; no byte of what a client sends is produced by the hub's code.
//! (Once the core's encodings are merged, this file gives way to the core.)

use sha2::{Digest, Sha256};
use trommi_hub::wire::{
    CommitNote, Cut, Header, HubAuth, InviteRequest, KeyContext, Offer, RecoveryAuth, RecoveryLink,
    Reveal, SealedKey, Subject, TrommiRoom, TrommiSession,
};

/// RFC 9420 section 2.1.2: a vector with its length in one, two or four bytes.
pub fn vl(out: &mut Vec<u8>, bytes: &[u8]) {
    match bytes.len() {
        n @ 0..=63 => out.push(n as u8),
        n @ 64..=16383 => out.extend([0x40 | (n >> 8) as u8, n as u8]),
        n => out.extend([
            0x80 | (n >> 24) as u8,
            (n >> 16) as u8,
            (n >> 8) as u8,
            n as u8,
        ]),
    }
    out.extend(bytes);
}

fn u64be(out: &mut Vec<u8>, v: u64) {
    out.extend(v.to_be_bytes());
}

/// RFC 9420 section 5.2.
pub fn ref_hash(label: &str, value: &[u8]) -> [u8; 32] {
    let mut input = Vec::new();
    vl(&mut input, label.as_bytes());
    vl(&mut input, value);
    Sha256::digest(&input).into()
}

/// RFC 9420 section 5.1.2: what SignWithLabel signs.
pub fn sign_content(label: &str, content: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    vl(
        &mut out,
        [b"MLS 1.0 ", label.as_bytes()].concat().as_slice(),
    );
    vl(&mut out, content);
    out
}

pub fn envelope_hash(header: &[u8], nonce: &[u8], ciphertext_hash: &[u8]) -> [u8; 32] {
    ref_hash(
        "Trommi Envelope",
        &[header, nonce, ciphertext_hash].concat(),
    )
}

pub fn object_id(group_id: &[u8], sender: &[u8; 32], seq: u64) -> [u8; 16] {
    let digest = ref_hash(
        "Trommi Object",
        &[group_id, &sender[..], &seq.to_be_bytes()[..]].concat(),
    );
    digest[..16].try_into().unwrap()
}

/// A full envelope: form 1, header, nonce, ciphertext, signature.
pub fn envelope(header: &[u8], nonce: &[u8], ciphertext: &[u8], signature: &[u8]) -> Vec<u8> {
    let mut out = vec![1u8];
    out.extend(header);
    out.extend(nonce);
    vl(&mut out, ciphertext);
    vl(&mut out, signature);
    out
}

/// A pruned envelope: form 2, header, nonce, the ciphertext's hash, signature.
pub fn pruned_envelope(
    header: &[u8],
    nonce: &[u8],
    ciphertext_hash: &[u8],
    signature: &[u8],
) -> Vec<u8> {
    let mut out = vec![2u8];
    out.extend(header);
    out.extend(nonce);
    out.extend(ciphertext_hash);
    vl(&mut out, signature);
    out
}

/// `Body`: version, bind, payload.
pub fn body(bind: &[u8], payload: &[u8]) -> Vec<u8> {
    let mut out = vec![2u8];
    vl(&mut out, bind);
    vl(&mut out, payload);
    out
}

pub trait Bytes {
    fn bytes(&self) -> Vec<u8>;
}

impl Bytes for TrommiRoom {
    fn bytes(&self) -> Vec<u8> {
        let mut out = Vec::new();
        vl(&mut out, &self.recovery_signature_key);
        vl(&mut out, &self.recovery_hpke_key);
        vl(&mut out, &self.agents.concat());
        out
    }
}

impl Bytes for TrommiSession {
    fn bytes(&self) -> Vec<u8> {
        [&self.room_id[..], &self.session_id[..], &self.parent[..]].concat()
    }
}

impl Bytes for Cut {
    fn bytes(&self) -> Vec<u8> {
        [
            &self.device[..],
            &self.seq.to_be_bytes()[..],
            &self.hash[..],
        ]
        .concat()
    }
}

impl Bytes for CommitNote {
    fn bytes(&self) -> Vec<u8> {
        let mut out = vec![2u8];
        u64be(&mut out, self.room_epoch);
        out.extend(self.room_state);
        u64be(&mut out, self.time);
        let cuts: Vec<u8> = self.cuts.iter().flat_map(|c| c.bytes()).collect();
        vl(&mut out, &cuts);
        out.push(u8::from(self.join));
        out
    }
}

impl Bytes for KeyContext {
    fn bytes(&self) -> Vec<u8> {
        let mut out = Vec::new();
        vl(&mut out, &self.group_id);
        u64be(&mut out, self.epoch);
        out.extend(self.group_info);
        out
    }
}

impl Bytes for SealedKey {
    fn bytes(&self) -> Vec<u8> {
        let mut out = self.context.bytes();
        u64be(&mut out, self.room_epoch);
        vl(&mut out, &self.recovery_hpke_key);
        // HPKECiphertext: kem_output<V>, ciphertext<V>
        vl(&mut out, &self.kem_output);
        vl(&mut out, &self.ciphertext);
        out.extend(self.writer);
        vl(&mut out, &self.mac);
        out
    }
}

/// `join ‖ commit` of a RecoveryAuth: what the recovery key signs.
pub fn recovery_join_and_commit(a: &RecoveryAuth) -> Vec<u8> {
    let mut out = a.base.bytes();
    u64be(&mut out, a.room_epoch);
    out.extend(a.room_state);
    out.extend(a.joiner);
    out.extend(a.commit);
    out
}

impl Bytes for RecoveryAuth {
    fn bytes(&self) -> Vec<u8> {
        let mut out = recovery_join_and_commit(self);
        vl(&mut out, &self.signature);
        out
    }
}

impl Bytes for RecoveryLink {
    fn bytes(&self) -> Vec<u8> {
        let mut out = self.room_id.to_vec();
        vl(&mut out, &self.new_recovery_hpke_key);
        vl(&mut out, &self.kem_output);
        vl(&mut out, &self.ciphertext);
        vl(&mut out, &self.mac);
        out
    }
}

impl Bytes for Header {
    fn bytes(&self) -> Vec<u8> {
        let mut out = vec![2u8, self.kind, self.flags];
        vl(&mut out, &self.group_id);
        u64be(&mut out, self.epoch);
        out.extend(self.sender);
        u64be(&mut out, self.seq);
        out.extend(self.prev);
        out.extend(self.recipient);
        u64be(&mut out, self.time);
        match &self.subject {
            Subject::Item {
                timeline_kind,
                timeline_scope,
                timeline_ref,
            } => {
                out.extend([*timeline_kind, *timeline_scope]);
                out.extend(timeline_ref);
            }
            Subject::Register { register_id } => out.extend(register_id),
            Subject::Object {
                object_id,
                object_type,
                object_state,
                urgency,
                answered_at,
                object_ref,
            } => {
                out.extend(object_id);
                out.extend([*object_type, *object_state, *urgency]);
                u64be(&mut out, *answered_at);
                out.extend(object_ref);
            }
        }
        vl(&mut out, &self.file_ids.concat());
        out
    }
}

impl Bytes for HubAuth {
    fn bytes(&self) -> Vec<u8> {
        let mut out = self.room_id.to_vec();
        vl(&mut out, &self.hub);
        out.extend(self.device);
        out.extend(self.challenge);
        out
    }
}

impl Bytes for Offer {
    fn bytes(&self) -> Vec<u8> {
        let mut out = self.room_id.to_vec();
        out.extend(self.invite_id);
        out.push(self.role);
        out.extend(self.session_id);
        u64be(&mut out, self.expires_at);
        out.extend(self.commitment);
        out.extend(self.inviter);
        u64be(&mut out, self.room_epoch);
        out.extend(self.room_state);
        out
    }
}

impl Bytes for InviteRequest {
    fn bytes(&self) -> Vec<u8> {
        let mut out = self.room_id.to_vec();
        out.extend(self.invite_id);
        vl(&mut out, &self.hub);
        out.push(self.role);
        vl(&mut out, &self.key_package);
        out.extend(self.offer_hash);
        out
    }
}

impl Bytes for Reveal {
    fn bytes(&self) -> Vec<u8> {
        [&self.invite_id[..], &self.nonce[..], &self.request_hash[..]].concat()
    }
}
