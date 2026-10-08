//! Primitives (FORMAT.md sections 1, 3, 4, 5): labelled SHA-256, HKDF, Ed25519, X25519 sealed box, AES-256-GCM.

use crate::bytes::{arr32, is_zero, W};
use crate::{fail, label, obj, ZResult, VERSION};
use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use sha2::{Digest, Sha256};

pub fn sha256(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}
/// SHA-256(utf8(label) || 0x00 || parts...)
pub fn hash(label: &str, parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(label.as_bytes());
    h.update([0u8]);
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}
/// HKDF-SHA-256 with info = utf8(label) || 0x00 || context.
pub fn hkdf(ikm: &[u8], salt: &[u8], label: &str, context: &[u8], length: usize) -> Vec<u8> {
    let hk = hkdf::Hkdf::<Sha256>::new(Some(salt), ikm);
    let mut info = Vec::with_capacity(label.len() + 1 + context.len());
    info.extend_from_slice(label.as_bytes());
    info.push(0);
    info.extend_from_slice(context);
    let mut out = vec![0u8; length];
    hk.expand(&info, &mut out).expect("hkdf length");
    out
}
pub fn label_bytes(label: &str) -> Vec<u8> {
    let mut v = label.as_bytes().to_vec();
    v.push(0);
    v
}

pub fn device_id(sign_pub: &[u8], kex_pub: &[u8]) -> [u8; 32] {
    hash(label::DEVICE_ID, &[sign_pub, kex_pub])
}

/// Ed25519 over utf8(label) || 0x00 || message. False for a malformed key or signature, never an error.
pub fn verify(sign_pub: &[u8], label: &str, message: &[u8], signature: &[u8]) -> bool {
    if signature.len() != 64 || sign_pub.len() != 32 {
        return false;
    }
    let Ok(key) = ed25519_dalek::VerifyingKey::from_bytes(&arr32(sign_pub)) else { return false };
    let sig = ed25519_dalek::Signature::from_bytes(signature.try_into().unwrap());
    let mut m = label_bytes(label);
    m.extend_from_slice(message);
    // Cofactorless, canonical S, as OpenSSL (Node's WebCrypto) checks.
    use ed25519_dalek::Verifier;
    key.verify(&m, &sig).is_ok()
}

/// A device from two 32-byte seeds (the recovery key, key files, test vectors).
#[derive(Clone)]
pub struct Device {
    pub id: [u8; 32],
    pub sign_pub: [u8; 32],
    pub kex_pub: [u8; 32],
    pub sign_key: ed25519_dalek::SigningKey,
    pub kex_key: x25519_dalek::StaticSecret,
}
impl Device {
    pub fn from_seeds(sign_seed: &[u8; 32], kex_seed: &[u8; 32]) -> Device {
        let sign_key = ed25519_dalek::SigningKey::from_bytes(sign_seed);
        let kex_key = x25519_dalek::StaticSecret::from(*kex_seed);
        let sign_pub = sign_key.verifying_key().to_bytes();
        let kex_pub = x25519_dalek::PublicKey::from(&kex_key).to_bytes();
        Device { id: device_id(&sign_pub, &kex_pub), sign_pub, kex_pub, sign_key, kex_key }
    }
    pub fn sign(&self, label: &str, message: &[u8]) -> [u8; 64] {
        use ed25519_dalek::Signer;
        let mut m = label_bytes(label);
        m.extend_from_slice(message);
        self.sign_key.sign(&m).to_bytes()
    }
    /// 0x01 0x0c signSeed(32) kexSeed(32)
    pub fn secret_file(&self) -> Vec<u8> {
        W::new().u8(VERSION).u8(obj::DEVICE_SECRET).raw(&self.sign_key.to_bytes()).raw(&self.kex_key.to_bytes()).done()
    }
}

fn x25519(priv_key: &x25519_dalek::StaticSecret, pub_key: &[u8]) -> ZResult<[u8; 32]> {
    if pub_key.len() != 32 {
        return Err(fail("bad-argument", "X25519 public key must be 32 bytes"));
    }
    let shared = priv_key.diffie_hellman(&x25519_dalek::PublicKey::from(arr32(pub_key))).to_bytes();
    if is_zero(&shared) {
        return Err(fail("bad-key", "X25519 gave the all-zero secret"));
    }
    Ok(shared)
}
fn seal_keys(shared: &[u8], eph_pub: &[u8], recipient_pub: &[u8]) -> (Vec<u8>, Vec<u8>) {
    let mut salt = eph_pub.to_vec();
    salt.extend_from_slice(recipient_pub);
    let okm = hkdf(shared, &salt, label::SEALED_BOX, &[], 44);
    (okm[..32].to_vec(), okm[32..].to_vec())
}

pub fn gcm_seal(key: &[u8], nonce: &[u8], aad: &[u8], plain: &[u8]) -> Vec<u8> {
    let c = Aes256Gcm::new_from_slice(key).expect("AES key");
    c.encrypt(Nonce::from_slice(nonce), Payload { msg: plain, aad }).expect("gcm")
}
pub fn gcm_open(key: &[u8], nonce: &[u8], aad: &[u8], ct: &[u8]) -> ZResult<Vec<u8>> {
    let c = Aes256Gcm::new_from_slice(key).map_err(|_| fail("bad-argument", "AES key must be 32 bytes"))?;
    c.decrypt(Nonce::from_slice(nonce), Payload { msg: ct, aad }).map_err(|_| fail("decrypt-failed", "authentication tag does not match"))
}

/// 0x01 0x04 ephemeralPub(32) ciphertext+tag, with a given ephemeral private key (vectors) .
pub fn seal_with(eph_seed: &[u8; 32], recipient_kex_pub: &[u8], plaintext: &[u8], aad: &[u8]) -> ZResult<Vec<u8>> {
    let eph = x25519_dalek::StaticSecret::from(*eph_seed);
    let eph_pub = x25519_dalek::PublicKey::from(&eph).to_bytes();
    let shared = x25519(&eph, recipient_kex_pub)?;
    let (key, nonce) = seal_keys(&shared, &eph_pub, recipient_kex_pub);
    let mut out = vec![VERSION, obj::SEALED];
    out.extend_from_slice(&eph_pub);
    out.extend_from_slice(&gcm_seal(&key, &nonce, aad, plaintext));
    Ok(out)
}
pub fn open_sealed(device: &Device, sealed: &[u8], aad: &[u8]) -> ZResult<Vec<u8>> {
    let mut r = crate::bytes::R::new(sealed);
    header(&mut r, obj::SEALED)?;
    let eph_pub = r.take(32)?;
    let ct = r.take(r.left())?;
    if ct.len() < 16 {
        return Err(fail("bad-format", "sealed box too short"));
    }
    let shared = x25519(&device.kex_key, eph_pub)?;
    let (key, nonce) = seal_keys(&shared, eph_pub, &device.kex_pub);
    gcm_open(&key, &nonce, aad, ct)
}

/// Version byte and object type of a top-level object.
pub fn header(r: &mut crate::bytes::R, ty: u8) -> ZResult<()> {
    let v = r.u8()?;
    if v != VERSION {
        return Err(fail("bad-version", &format!("version {v} is not supported")));
    }
    let t = r.u8()?;
    if t != ty {
        return Err(fail("bad-format", &format!("object type {t}, expected {ty}")));
    }
    Ok(())
}

/// The recovery key pair from the 32 code bytes (FORMAT.md section 12).
pub fn recovery_device(code: &[u8]) -> Device {
    let s = hkdf(code, &[], label::RECOVERY_SIGN, &[], 32);
    let k = hkdf(code, &[], label::RECOVERY_KEX, &[], 32);
    Device::from_seeds(&arr32(&s), &arr32(&k))
}
const CROCKFORD: &[u8] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
pub fn format_recovery_code(bytes: &[u8]) -> String {
    let mut chars = Vec::new();
    let mut acc: u32 = 0;
    let mut bits = 0;
    for &b in bytes {
        acc = (acc << 8) | b as u32;
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            chars.push(CROCKFORD[((acc >> bits) & 31) as usize]);
        }
        acc &= (1 << bits) - 1;
    }
    if bits > 0 {
        chars.push(CROCKFORD[((acc << (5 - bits)) & 31) as usize]);
    }
    chars.chunks(4).map(|c| String::from_utf8(c.to_vec()).unwrap()).collect::<Vec<_>>().join("-")
}
pub fn parse_recovery_code(text: &str) -> ZResult<Vec<u8>> {
    let mut out = Vec::new();
    let mut acc: u32 = 0;
    let mut bits = 0;
    let mut n = 0;
    for c in text.chars() {
        if c == ' ' || c == '-' || c == '\t' || c == '\n' {
            continue;
        }
        let c = match c.to_ascii_uppercase() {
            'O' => '0',
            'I' | 'L' => '1',
            x => x,
        };
        let Some(v) = CROCKFORD.iter().position(|&x| x as char == c) else { return Err(fail("bad-recovery-code", "not a recovery code")) };
        n += 1;
        acc = (acc << 5) | v as u32;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push(((acc >> bits) & 0xff) as u8);
        }
        acc &= (1 << bits) - 1;
    }
    if n != 52 || out.len() != 32 || acc != 0 {
        return Err(fail("bad-recovery-code", "not a recovery code"));
    }
    Ok(out)
}
