//! Bytes: base64url without padding (strict), lowercase hex, and the canonical writer/reader (FORMAT.md section 2).
use crate::error::{fail, Result, ZError};

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// base64url without padding (RFC 4648 section 5).
pub fn b64u(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 4 / 3 + 4);
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

fn b64_rev(c: u8) -> i32 {
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
pub fn unb64u(s: &str) -> Result<Vec<u8>> {
    let b = s.as_bytes();
    if b.len() % 4 == 1 {
        return fail("bad-format", "base64url: impossible length");
    }
    let mut out = Vec::with_capacity(b.len() * 3 / 4);
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    for &c in b {
        let v = b64_rev(c);
        if v < 0 {
            return fail("bad-format", "base64url: foreign character");
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
        return fail("bad-format", "base64url: non-canonical tail");
    }
    Ok(out)
}

pub fn hex(bytes: &[u8]) -> String {
    const H: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        s.push(H[(b >> 4) as usize] as char);
        s.push(H[(b & 15) as usize] as char);
    }
    s
}

pub fn unhex(s: &str) -> Result<Vec<u8>> {
    if s.len() % 2 != 0 || !s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)) {
        return fail("bad-format", "hex");
    }
    Ok((0..s.len() / 2).map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap()).collect())
}

pub fn is_hex(s: &str, n: usize) -> bool {
    s.len() == n && s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

pub fn concat(parts: &[&[u8]]) -> Vec<u8> {
    let mut out = Vec::with_capacity(parts.iter().map(|p| p.len()).sum());
    for p in parts {
        out.extend_from_slice(p);
    }
    out
}

/// Equality without an early exit.
pub fn bytes_equal(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut d = 0u8;
    for i in 0..a.len() {
        d |= a[i] ^ b[i];
    }
    d == 0
}
pub fn is_zero(b: &[u8]) -> bool {
    b.iter().fold(0u8, |d, x| d | x) == 0
}

pub const MAX_SAFE: u64 = (1u64 << 53) - 1;

/// Canonical writer: fixed field order, big-endian integers, length-prefixed byte strings.
#[derive(Default)]
pub struct W {
    pub out: Vec<u8>,
}
impl W {
    pub fn new() -> Self {
        W { out: Vec::new() }
    }
    pub fn u8(mut self, v: u8) -> Self {
        self.out.push(v);
        self
    }
    pub fn u16(mut self, v: u16) -> Self {
        self.out.extend_from_slice(&v.to_be_bytes());
        self
    }
    pub fn u32(mut self, v: u32) -> Self {
        self.out.extend_from_slice(&v.to_be_bytes());
        self
    }
    pub fn u64(mut self, v: u64) -> Self {
        self.out.extend_from_slice(&v.to_be_bytes());
        self
    }
    pub fn raw(mut self, b: &[u8]) -> Self {
        self.out.extend_from_slice(b);
        self
    }
    pub fn var16(self, b: &[u8]) -> Self {
        self.u16(b.len() as u16).raw(b)
    }
    pub fn var32(self, b: &[u8]) -> Self {
        self.u32(b.len() as u32).raw(b)
    }
    /// str16(max): well-formed UTF-8 (Rust strings always are), at most `max` bytes, no leading BOM.
    pub fn str16(self, s: &str, max: usize) -> Result<Self> {
        if s.len() > max {
            return fail("bad-argument", "string too long");
        }
        if s.starts_with('\u{feff}') {
            return fail("bad-argument", "a string starts with a byte order mark");
        }
        Ok(self.var16(s.as_bytes()))
    }
    pub fn done(self) -> Vec<u8> {
        self.out
    }
}

/// Canonical reader: rejects truncation and trailing bytes.
pub struct R<'a> {
    b: &'a [u8],
    o: usize,
}
impl<'a> R<'a> {
    pub fn new(b: &'a [u8]) -> Self {
        R { b, o: 0 }
    }
    pub fn left(&self) -> usize {
        self.b.len() - self.o
    }
    pub fn pos(&self) -> usize {
        self.o
    }
    fn want(&self, n: usize) -> Result<()> {
        if self.left() < n {
            return fail("bad-format", "truncated");
        }
        Ok(())
    }
    pub fn u8(&mut self) -> Result<u8> {
        self.want(1)?;
        self.o += 1;
        Ok(self.b[self.o - 1])
    }
    pub fn u16(&mut self) -> Result<u16> {
        self.want(2)?;
        let v = u16::from_be_bytes([self.b[self.o], self.b[self.o + 1]]);
        self.o += 2;
        Ok(v)
    }
    pub fn u32(&mut self) -> Result<u32> {
        self.want(4)?;
        let v = u32::from_be_bytes(self.b[self.o..self.o + 4].try_into().unwrap());
        self.o += 4;
        Ok(v)
    }
    pub fn u64(&mut self) -> Result<u64> {
        self.want(8)?;
        let v = u64::from_be_bytes(self.b[self.o..self.o + 8].try_into().unwrap());
        self.o += 8;
        if v > MAX_SAFE {
            return fail("bad-format", "integer above 2^53-1");
        }
        Ok(v)
    }
    pub fn take(&mut self, n: usize) -> Result<Vec<u8>> {
        self.want(n)?;
        let out = self.b[self.o..self.o + n].to_vec();
        self.o += n;
        Ok(out)
    }
    pub fn take_arr<const N: usize>(&mut self) -> Result<[u8; N]> {
        self.want(N)?;
        let mut out = [0u8; N];
        out.copy_from_slice(&self.b[self.o..self.o + N]);
        self.o += N;
        Ok(out)
    }
    pub fn var16(&mut self) -> Result<Vec<u8>> {
        let n = self.u16()? as usize;
        self.take(n)
    }
    pub fn var32(&mut self) -> Result<Vec<u8>> {
        let n = self.u32()? as usize;
        self.take(n)
    }
    pub fn str16(&mut self, max: usize) -> Result<String> {
        let raw = self.var16()?;
        if raw.len() > max {
            return fail("bad-format", "string too long");
        }
        let s = String::from_utf8(raw).map_err(|_| ZError::new("bad-format", "string is not UTF-8"))?;
        if s.starts_with('\u{feff}') {
            return fail("bad-format", "a string starts with a byte order mark");
        }
        Ok(s)
    }
    pub fn rest(&mut self) -> Vec<u8> {
        let out = self.b[self.o..].to_vec();
        self.o = self.b.len();
        out
    }
    pub fn end(&self) -> Result<()> {
        if self.left() != 0 {
            return fail("bad-format", "trailing bytes");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn b64u_round_trip_and_strict() {
        for n in 0..40 {
            let v: Vec<u8> = (0..n).map(|i| (i * 37 + 5) as u8).collect();
            assert_eq!(unb64u(&b64u(&v)).unwrap(), v);
        }
        assert_eq!(b64u(&[0x00, 0xfb, 0xff, 0x10]), "APv_EA");
        assert!(unb64u("APv_EB").is_err()); // non-zero trailing bits
        assert!(unb64u("A").is_err());
        assert!(unb64u("AP=").is_err());
    }
}
