//! Small helpers: the clock (movable in tests), random bytes, base64url, hex, constant-time comparison.

use std::sync::atomic::{AtomicI64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use subtle::ConstantTimeEq;

static CLOCK_OFFSET_MS: AtomicI64 = AtomicI64::new(0);

/// Milliseconds since the Unix epoch.
pub fn now() -> u64 {
    let real = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    (real + CLOCK_OFFSET_MS.load(Ordering::Relaxed)).max(0) as u64
}

/// Moves the clock of this process. Only reachable through the test control switch (`Config::test_control`).
pub fn advance_clock(ms: i64) {
    CLOCK_OFFSET_MS.fetch_add(ms, Ordering::Relaxed);
}

pub fn random<const N: usize>() -> [u8; N] {
    let mut out = [0u8; N];
    getrandom::getrandom(&mut out).expect("the operating system's random source");
    out
}

pub fn b64(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Strict base64url without padding.
pub fn unb64(text: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(text).ok()
}

pub fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

pub fn unhex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2)
        || !text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).ok())
        .collect()
}

pub fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && bool::from(a.ct_eq(b))
}

/// For log lines: enough of an id to follow one thing, not enough to name it elsewhere.
pub fn short(bytes: &[u8]) -> String {
    hex(&bytes[..bytes.len().min(4)])
}

pub fn sha256(bytes: &[u8]) -> [u8; 32] {
    use sha2::Digest;
    sha2::Sha256::digest(bytes).into()
}
