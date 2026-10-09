//! Small helpers shared by the whole connector: the clock, text as the board's JavaScript reads it, hex and
//! random bytes.
use serde_json::Value;
use trommi_core::crypto::{Entropy, SystemEntropy};

/// Milliseconds since the Unix epoch, by this machine's clock.
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| since.as_millis() as u64)
}

/// A text without white space at either end, as JavaScript's `trim` cuts it (the board does the same).
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// A JSON value as text, the way JavaScript's `String(v)` writes a string, a number or a boolean.
pub fn js_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "null".into(),
        other => other.to_string(),
    }
}

/// Whether a JSON value counts as given: not null, false, 0 or the empty string.
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|x| x != 0.0 && !x.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// Lower-case hex.
pub fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes
        .iter()
        .fold(String::with_capacity(bytes.len() * 2), |mut out, byte| {
            let _ = write!(out, "{byte:02x}");
            out
        })
}

/// The bytes of a lower-case or upper-case hex text; none for anything else.
pub fn unhex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) || !text.is_ascii() {
        return None;
    }
    text.as_bytes()
        .chunks(2)
        .map(|pair| {
            let digit = |b: u8| (b as char).to_digit(16);
            Some((digit(pair[0])? * 16 + digit(pair[1])?) as u8)
        })
        .collect()
}

/// Whether `text` is exactly `len` lower-case hex digits.
pub fn is_hex(text: &str, len: usize) -> bool {
    text.len() == len
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// The SHA-256 of `data`.
pub fn sha256(data: &[u8]) -> [u8; 32] {
    // The provider's SHA-256 does not fail; an all-zero digest would only make a comparison fail closed.
    trommi_core::crypto::sha256(data).map_or([0; 32], |hash| *hash.as_bytes())
}

/// `N` random bytes from the operating system.
pub fn random<const N: usize>() -> crate::error::Result<[u8; N]> {
    let mut out = [0u8; N];
    SystemEntropy.fill(&mut out)?;
    Ok(out)
}

/// `bytes` random bytes as hex. Falls back to the clock and the process id when the system source fails: the
/// value names a process or a file, it protects nothing.
pub fn random_hex(bytes: usize) -> String {
    let mut out = vec![0u8; bytes];
    if SystemEntropy.fill(&mut out).is_err() {
        let seed = sha256(format!("{} {}", now_ms(), std::process::id()).as_bytes());
        for (i, byte) in out.iter_mut().enumerate() {
            *byte = seed[i % seed.len()];
        }
    }
    hex(&out)
}

/// A random number below `max` (0 for 0), for jitter.
pub fn rand_below(max: u64) -> u64 {
    if max == 0 {
        return 0;
    }
    let bytes: [u8; 8] = random().unwrap_or_else(|_| now_ms().to_le_bytes());
    u64::from_le_bytes(bytes) % max
}
