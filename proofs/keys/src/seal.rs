//! Trommi's own sealing: the content envelope under an exported epoch key,
//! the archive rows, the copy sealed to the recovery key.

use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::RustCrypto;
use openmls_traits::{
    crypto::OpenMlsCrypto,
    random::OpenMlsRand,
    types::{AeadType, HashType, HpkeAeadType, HpkeCiphertext, HpkeConfig, HpkeKdfType, HpkeKemType},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{Gid, Key, SigKey};

const HPKE: HpkeConfig = HpkeConfig(
    HpkeKemType::DhKem25519,
    HpkeKdfType::HkdfSha256,
    HpkeAeadType::ChaCha20Poly1305,
);

/// The archive key is never used directly: one sub-key per purpose.
const SUB_LINK: &str = "trommi/v2/archive/link";
const SUB_WRAP: &str = "trommi/v2/archive/session-key";

pub fn kdf(crypto: &RustCrypto, key: &[u8], label: &str) -> Key {
    crypto
        .hkdf_expand(HashType::Sha2_256, key, label.as_bytes(), 32)
        .unwrap()
        .as_slice()
        .to_vec()
}

/// nonce(12) || ciphertext || tag(16), ChaCha20-Poly1305.
pub fn aead_seal(crypto: &RustCrypto, key: &[u8], aad: &[u8], pt: &[u8]) -> Vec<u8> {
    let nonce: [u8; 12] = crypto.random_array().unwrap();
    let mut out = nonce.to_vec();
    out.extend(
        crypto
            .aead_encrypt(AeadType::ChaCha20Poly1305, key, pt, &nonce, aad)
            .unwrap(),
    );
    out
}

pub fn aead_open(crypto: &RustCrypto, key: &[u8], aad: &[u8], sealed: &[u8]) -> Result<Vec<u8>, String> {
    if sealed.len() < 28 {
        return Err("sealed value too short".into());
    }
    crypto
        .aead_decrypt(AeadType::ChaCha20Poly1305, key, &sealed[12..], &sealed[..12], aad)
        .map_err(|_| "cannot open: wrong key or changed bytes".to_string())
}

/// kem output(32) || ciphertext || tag(16), HPKE base mode (RFC 9180).
pub fn hpke_seal(crypto: &RustCrypto, pk: &[u8], info: &[u8], pt: &[u8]) -> Vec<u8> {
    let ct = crypto.hpke_seal(HPKE, pk, info, &[], pt).unwrap();
    let mut out = ct.kem_output.as_slice().to_vec();
    out.extend(ct.ciphertext.as_slice());
    out
}

pub fn hpke_open(crypto: &RustCrypto, sk: &[u8], info: &[u8], sealed: &[u8]) -> Result<Vec<u8>, String> {
    if sealed.len() < 48 {
        return Err("sealed value too short".into());
    }
    let ct = HpkeCiphertext {
        kem_output: sealed[..32].to_vec().into(),
        ciphertext: sealed[32..].to_vec().into(),
    };
    crypto
        .hpke_open(HPKE, &ct, sk, info, &[])
        .map_err(|_| "cannot open: wrong recovery key or changed bytes".to_string())
}

/// What the recovery code gives: an HPKE key pair (opens sealed copies) and a
/// signature key pair (authorises an external commit). Both derived from the code.
pub struct Recovery {
    pub hpke_private: Vec<u8>,
    pub hpke_public: Vec<u8>,
    pub signer: SignatureKeyPair,
}

impl Recovery {
    pub fn from_code(crypto: &RustCrypto, code: &str) -> Self {
        // The real thing stretches the code (Argon2id). A hash stands in here.
        let seed = Sha256::digest(format!("trommi/v2/recovery/{code}").as_bytes());
        let kp = crypto
            .derive_hpke_keypair(HPKE, &kdf(crypto, &seed, "hpke"))
            .unwrap();
        Recovery {
            hpke_private: kp.private.to_vec(),
            hpke_public: kp.public,
            signer: signer_from_seed(&kdf(crypto, &seed, "sign")),
        }
    }
}

pub fn signer_from_seed(seed: &[u8]) -> SignatureKeyPair {
    let sk = ed25519_dalek::SigningKey::from_bytes(seed[..32].try_into().unwrap());
    SignatureKeyPair::from_raw(
        SignatureScheme::ED25519,
        sk.to_bytes().to_vec(),
        sk.verifying_key().to_bytes().to_vec(),
    )
}

/// One row per room epoch at the hub: the previous archive key under this
/// epoch's archive key, and this epoch's archive key sealed to the recovery key.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ArchiveRow {
    pub epoch: u64,
    pub prev_epoch: Option<u64>,
    /// AEAD(archive[epoch], archive[prev_epoch]); 60 bytes.
    pub link: Option<Vec<u8>>,
    /// HPKE(recovery public key, archive[epoch]); 80 bytes.
    pub recovery_copy: Vec<u8>,
}

impl ArchiveRow {
    pub fn bytes(&self) -> usize {
        8 + 8 + self.link.as_ref().map_or(0, |l| l.len()) + self.recovery_copy.len()
    }
}

fn link_aad(room: &[u8], epoch: u64, prev: u64) -> Vec<u8> {
    let mut a = b"trommi/v2/archive-link".to_vec();
    a.extend(room);
    a.extend(epoch.to_be_bytes());
    a.extend(prev.to_be_bytes());
    a
}

fn copy_info(room: &[u8], epoch: u64) -> Vec<u8> {
    let mut a = b"trommi/v2/archive-copy".to_vec();
    a.extend(room);
    a.extend(epoch.to_be_bytes());
    a
}

pub fn make_archive_row(
    crypto: &RustCrypto,
    room: &[u8],
    epoch: u64,
    archive: &[u8],
    prev: Option<(u64, &[u8])>,
    recovery_pk: &[u8],
) -> ArchiveRow {
    ArchiveRow {
        epoch,
        prev_epoch: prev.map(|p| p.0),
        link: prev.map(|(pe, pk)| aead_seal(crypto, &kdf(crypto, archive, SUB_LINK), &link_aad(room, epoch, pe), pk)),
        recovery_copy: hpke_seal(crypto, recovery_pk, &copy_info(room, epoch), archive),
    }
}

pub fn open_link(crypto: &RustCrypto, room: &[u8], row: &ArchiveRow, archive: &[u8]) -> Result<Option<(u64, Key)>, String> {
    match (&row.link, row.prev_epoch) {
        (Some(link), Some(pe)) if pe < row.epoch => {
            let k = aead_open(crypto, &kdf(crypto, archive, SUB_LINK), &link_aad(room, row.epoch, pe), link)?;
            if k.len() != 32 {
                return Err("archive link of the wrong length".into());
            }
            Ok(Some((pe, k)))
        }
        (Some(_), _) => Err("archive link that does not point back".into()),
        _ => Ok(None),
    }
}

pub fn open_recovery_copy(crypto: &RustCrypto, room: &[u8], row: &ArchiveRow, sk: &[u8]) -> Result<Key, String> {
    hpke_open(crypto, sk, &copy_info(room, row.epoch), &row.recovery_copy)
}

/// A session group's epoch key sealed under the room's archive key of a named room epoch.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EpochKeyRow {
    pub group: Gid,
    pub epoch: u64,
    pub room_epoch: u64,
    /// AEAD(archive[room_epoch], key); 60 bytes.
    pub sealed: Vec<u8>,
}

fn ek_aad(group: &[u8], epoch: u64, room_epoch: u64) -> Vec<u8> {
    let mut a = b"trommi/v2/epoch-key".to_vec();
    a.extend(group);
    a.extend(epoch.to_be_bytes());
    a.extend(room_epoch.to_be_bytes());
    a
}

pub fn make_epoch_key_row(crypto: &RustCrypto, group: &[u8], epoch: u64, key: &[u8], room_epoch: u64, archive: &[u8]) -> EpochKeyRow {
    EpochKeyRow {
        group: group.to_vec(),
        epoch,
        room_epoch,
        sealed: aead_seal(crypto, &kdf(crypto, archive, SUB_WRAP), &ek_aad(group, epoch, room_epoch), key),
    }
}

pub fn open_epoch_key_row(crypto: &RustCrypto, row: &EpochKeyRow, archive: &[u8]) -> Result<Key, String> {
    aead_open(crypto, &kdf(crypto, archive, SUB_WRAP), &ek_aad(&row.group, row.epoch, row.room_epoch), &row.sealed)
}

/// The content envelope: a clear header the hub can index, a body sealed under
/// the group's exported key of that epoch. (The signature and the per-sender
/// hash chain of the real envelope are not part of this proof.)
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Envelope {
    pub group: Gid,
    pub epoch: u64,
    pub sender: SigKey,
    pub kind: String,
    pub body: Vec<u8>,
}

impl Envelope {
    fn aad(group: &[u8], epoch: u64, sender: &[u8], kind: &str) -> Vec<u8> {
        let mut a = b"trommi/v2/envelope".to_vec();
        a.extend(group);
        a.extend(epoch.to_be_bytes());
        a.extend(sender);
        a.extend(kind.as_bytes());
        a
    }

    pub fn seal(crypto: &RustCrypto, key: &[u8], group: &[u8], epoch: u64, sender: &[u8], kind: &str, body: &[u8]) -> Self {
        Envelope {
            group: group.to_vec(),
            epoch,
            sender: sender.to_vec(),
            kind: kind.to_string(),
            body: aead_seal(crypto, key, &Self::aad(group, epoch, sender, kind), body),
        }
    }

    pub fn open(&self, crypto: &RustCrypto, key: &[u8]) -> Result<Vec<u8>, String> {
        aead_open(crypto, key, &Self::aad(&self.group, self.epoch, &self.sender, &self.kind), &self.body)
    }
}

/// The hand-over: old epoch keys of ONE group, sent as an envelope in that group's
/// current epoch. 40 bytes per epoch in a binary encoding (8 epoch + 32 key).
pub fn handover_body(keys: &[(u64, Key)]) -> Vec<u8> {
    let mut out = Vec::with_capacity(keys.len() * 40);
    for (e, k) in keys {
        out.extend(e.to_be_bytes());
        out.extend(k);
    }
    out
}

pub fn parse_handover(body: &[u8]) -> Result<Vec<(u64, Key)>, String> {
    if body.len() % 40 != 0 {
        return Err("hand-over of the wrong length".into());
    }
    Ok(body
        .chunks(40)
        .map(|c| (u64::from_be_bytes(c[..8].try_into().unwrap()), c[8..].to_vec()))
        .collect())
}
