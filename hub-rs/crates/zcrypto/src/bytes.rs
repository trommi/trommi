//! Bytes: base64url without padding (strict), lowercase hex, the canonical reader and writer (FORMAT.md section 2).

use crate::{fail, ZResult};

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// base64url without padding (RFC 4648 section 5).
pub fn b64u(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 4 / 3 + 2);
    let mut i = 0;
    while i + 2 < bytes.len() {
        let n = ((bytes[i] as u32) << 16) | ((bytes[i + 1] as u32) << 8) | bytes[i + 2] as u32;
        out.push(B64[(n >> 18) as usize] as char);
        out.push(B64[((n >> 12) & 63) as usize] as char);
        out.push(B64[((n >> 6) & 63) as usize] as char);
        out.push(B64[(n & 63) as usize] as char);
        i += 3;
    }
    if i + 1 == bytes.len() {
        let n = (bytes[i] as u32) << 16;
        out.push(B64[(n >> 18) as usize] as char);
        out.push(B64[((n >> 12) & 63) as usize] as char);
    } else if i + 2 == bytes.len() {
        let n = ((bytes[i] as u32) << 16) | ((bytes[i + 1] as u32) << 8);
        out.push(B64[(n >> 18) as usize] as char);
        out.push(B64[((n >> 12) & 63) as usize] as char);
        out.push(B64[((n >> 6) & 63) as usize] as char);
    }
    out
}

fn b64_value(c: u8) -> i32 {
    match c {
        b'A'..=b'Z' => (c - b'A') as i32,
        b'a'..=b'z' => (c - b'a') as i32 + 26,
        b'0'..=b'9' => (c - b'0') as i32 + 52,
        b'-' => 62,
        b'_' => 63,
        _ => -1,
    }
}

/// Strict decoder: no padding, no foreign characters, no non-zero trailing bits.
pub fn unb64u(s: &str) -> ZResult<Vec<u8>> {
    // JS counts UTF-16 units; any non-ASCII character is foreign anyway.
    if !s.is_ascii() {
        // A length that is impossible is reported first in JS only when every unit is counted; non-ASCII is foreign.
        let units = s.encode_utf16().count();
        if units % 4 == 1 {
            return Err(fail("bad-format", "base64url: impossible length"));
        }
        return Err(fail("bad-format", "base64url: foreign character"));
    }
    let b = s.as_bytes();
    if b.len() % 4 == 1 {
        return Err(fail("bad-format", "base64url: impossible length"));
    }
    let mut out = Vec::with_capacity(b.len() * 3 / 4);
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    for &c in b {
        let v = b64_value(c);
        if v < 0 {
            return Err(fail("bad-format", "base64url: foreign character"));
        }
        acc = (acc << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((acc >> bits) & 0xff) as u8);
        }
        acc &= (1u32 << bits) - 1;
    }
    if bits > 0 && (acc & ((1 << bits) - 1)) != 0 {
        return Err(fail("bad-format", "base64url: non-canonical tail"));
    }
    Ok(out)
}

const HEXCHARS: &[u8; 16] = b"0123456789abcdef";
pub fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        s.push(HEXCHARS[(b >> 4) as usize] as char);
        s.push(HEXCHARS[(b & 15) as usize] as char);
    }
    s
}
pub fn unhex(s: &str) -> ZResult<Vec<u8>> {
    let b = s.as_bytes();
    if b.len() % 2 != 0 || !b.iter().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f')) {
        return Err(fail("bad-format", "hex"));
    }
    Ok(b.chunks(2).map(|p| (hv(p[0]) << 4) | hv(p[1])).collect())
}
fn hv(c: u8) -> u8 {
    if c <= b'9' { c - b'0' } else { c - b'a' + 10 }
}
pub fn is_hex(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
}
pub fn arr32(b: &[u8]) -> [u8; 32] {
    let mut a = [0u8; 32];
    a.copy_from_slice(&b[..32]);
    a
}
pub fn arr16(b: &[u8]) -> [u8; 16] {
    let mut a = [0u8; 16];
    a.copy_from_slice(&b[..16]);
    a
}
pub fn is_zero(b: &[u8]) -> bool {
    b.iter().fold(0u8, |a, x| a | x) == 0
}
/// Equality without an early exit (hashes and public values).
pub fn bytes_equal(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |d, (x, y)| d | (x ^ y)) == 0
}

pub const MAX_SAFE: u64 = (1u64 << 53) - 1;

/// The canonical writer: fixed field order, big-endian integers, length-prefixed byte strings.
#[derive(Default)]
pub struct W(pub Vec<u8>);
impl W {
    pub fn new() -> Self { W(Vec::new()) }
    pub fn u8(mut self, v: u8) -> Self { self.0.push(v); self }
    pub fn u16(mut self, v: u16) -> Self { self.0.extend_from_slice(&v.to_be_bytes()); self }
    pub fn u32(mut self, v: u32) -> Self { self.0.extend_from_slice(&v.to_be_bytes()); self }
    pub fn u64(mut self, v: u64) -> Self { self.0.extend_from_slice(&v.to_be_bytes()); self }
    pub fn raw(mut self, b: &[u8]) -> Self { self.0.extend_from_slice(b); self }
    pub fn var16(mut self, b: &[u8]) -> Self { self.0.extend_from_slice(&(b.len() as u16).to_be_bytes()); self.0.extend_from_slice(b); self }
    pub fn var32(mut self, b: &[u8]) -> Self { self.0.extend_from_slice(&(b.len() as u32).to_be_bytes()); self.0.extend_from_slice(b); self }
    pub fn done(self) -> Vec<u8> { self.0 }
}

/// The canonical reader; every failure is `bad-format`.
pub struct R<'a> {
    pub b: &'a [u8],
    pub o: usize,
}
impl<'a> R<'a> {
    pub fn new(b: &'a [u8]) -> Self { R { b, o: 0 } }
    pub fn left(&self) -> usize { self.b.len() - self.o }
    fn want(&self, n: usize, what: &str) -> ZResult<()> {
        if self.left() < n { Err(fail("bad-format", what)) } else { Ok(()) }
    }
    pub fn u8(&mut self) -> ZResult<u8> { self.want(1, "truncated")?; let v = self.b[self.o]; self.o += 1; Ok(v) }
    pub fn u16(&mut self) -> ZResult<u16> { self.want(2, "truncated")?; let v = u16::from_be_bytes([self.b[self.o], self.b[self.o + 1]]); self.o += 2; Ok(v) }
    pub fn u32(&mut self) -> ZResult<u32> { self.want(4, "truncated")?; let v = u32::from_be_bytes(self.b[self.o..self.o + 4].try_into().unwrap()); self.o += 4; Ok(v) }
    pub fn u64(&mut self) -> ZResult<u64> {
        self.want(8, "truncated")?;
        let v = u64::from_be_bytes(self.b[self.o..self.o + 8].try_into().unwrap());
        self.o += 8;
        if v > MAX_SAFE { return Err(fail("bad-format", "integer above 2^53-1")); }
        Ok(v)
    }
    pub fn take(&mut self, n: usize) -> ZResult<&'a [u8]> { self.want(n, "truncated")?; let s = &self.b[self.o..self.o + n]; self.o += n; Ok(s) }
    pub fn take32(&mut self) -> ZResult<[u8; 32]> { Ok(arr32(self.take(32)?)) }
    pub fn take16(&mut self) -> ZResult<[u8; 16]> { Ok(arr16(self.take(16)?)) }
    pub fn var16(&mut self) -> ZResult<&'a [u8]> { let n = self.u16()? as usize; self.take(n) }
    pub fn var32(&mut self) -> ZResult<&'a [u8]> { let n = self.u32()? as usize; self.take(n) }
    /// str16(max): well-formed UTF-8, at most `max` bytes, not starting with a byte order mark.
    pub fn str16(&mut self, max: usize) -> ZResult<String> {
        let raw = self.var16()?;
        if raw.len() > max { return Err(fail("bad-format", "string too long")); }
        let s = std::str::from_utf8(raw).map_err(|_| fail("bad-format", "string is not UTF-8"))?;
        if s.starts_with('\u{feff}') { return Err(fail("bad-format", "a string starts with a byte order mark")); }
        Ok(s.to_string())
    }
    pub fn end(&self) -> ZResult<()> { if self.left() != 0 { Err(fail("bad-format", "trailing bytes")) } else { Ok(()) } }
}
