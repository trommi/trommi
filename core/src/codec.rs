//! The TLS presentation language as RFC 9420 section 2 uses it: integers big-endian, `opaque x[N]` as its bytes,
//! and a variable-length vector `<V>` as its content behind a length in bytes, written as a variable-length integer
//! in the fewest bytes that hold it (1, 2 or 4; at most 2^30 - 1). The length prefix is read and written by the
//! `tls_codec` crate, the one OpenMLS encodes its own `<V>` vectors with, so both agree byte for byte.
//!
//! A struct of the specification implements [`Encode`] and [`Decode`] by naming its fields in order on a
//! [`Writer`] and a [`Reader`]. [`decode`] refuses trailing bytes and input above the caller's limit. Decoding
//! borrows from the input, never panics, and a vector grows only by elements actually read: a length prefix alone
//! allocates nothing.

use crate::error::Error;
use tls_codec::{DeserializeBytes, TlsVarInt};
use zeroize::Zeroize;

/// The longest content a variable-length vector holds, in bytes.
pub const MAX_VECTOR_LEN: usize = (1 << 30) - 1;
/// The most bytes the length of a vector takes.
const MAX_LENGTH_PREFIX_LEN: usize = 4;

/// A value with an encoding.
pub trait Encode {
    /// Appends the encoding of `self`. Fails with `too-large` when a vector exceeds [`MAX_VECTOR_LEN`].
    fn write(&self, writer: &mut Writer) -> Result<(), Error>;
}

/// A value that is read from its encoding.
pub trait Decode: Sized {
    /// Reads one value from the front of `reader`. Fails with `bad-format`.
    fn read(reader: &mut Reader<'_>) -> Result<Self, Error>;
}

/// The encoding of `value`.
pub fn encode<T: Encode + ?Sized>(value: &T) -> Result<Vec<u8>, Error> {
    let mut writer = Writer::new();
    value.write(&mut writer)?;
    Ok(writer.into_bytes())
}

/// The value that `bytes` encode, whole: `too-large` above `max_len` bytes, `bad-format` for anything that is not
/// exactly one encoded value.
pub fn decode<T: Decode>(bytes: &[u8], max_len: usize) -> Result<T, Error> {
    if bytes.len() > max_len {
        return Err(Error::TooLarge);
    }
    let mut reader = Reader::new(bytes);
    let value = T::read(&mut reader)?;
    reader.finish()?;
    Ok(value)
}

/// Builds an encoding field by field. A secret may pass through, so no copy of what it holds is left behind:
/// it is wiped when the writer is dropped, and when it must grow the bytes move to a new buffer and the old
/// one is wiped before it is freed. A writer that will hold a secret is best made with its final size
/// ([`Writer::with_capacity`]) and then never moves at all.
#[derive(Default)]
pub struct Writer {
    bytes: Vec<u8>,
}

impl Writer {
    /// An empty writer.
    pub fn new() -> Self {
        Self::default()
    }

    /// An empty writer with room for `capacity` bytes: up to there it does not move what it holds.
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            bytes: Vec::with_capacity(capacity),
        }
    }

    /// Makes room for `more` bytes. The vector never grows by itself, which would free its old buffer as it
    /// is: a larger one is made, filled, and the old one wiped.
    fn reserve(&mut self, more: usize) {
        let needed = self.bytes.len().saturating_add(more);
        if needed <= self.bytes.capacity() {
            return;
        }
        let capacity = needed.max(self.bytes.capacity().saturating_mul(2)).max(64);
        let mut grown = Vec::with_capacity(capacity);
        grown.extend_from_slice(&self.bytes);
        self.bytes.zeroize();
        self.bytes = grown;
    }

    /// `uint8`.
    pub fn u8(&mut self, value: u8) {
        self.fixed(&[value]);
    }

    /// `uint16`.
    pub fn u16(&mut self, value: u16) {
        self.fixed(&value.to_be_bytes());
    }

    /// `uint32`.
    pub fn u32(&mut self, value: u32) {
        self.fixed(&value.to_be_bytes());
    }

    /// `uint64`.
    pub fn u64(&mut self, value: u64) {
        self.fixed(&value.to_be_bytes());
    }

    /// `opaque x[N]`, and any bytes that stand in an encoding as they are.
    pub fn fixed(&mut self, bytes: &[u8]) {
        self.reserve(bytes.len());
        self.bytes.extend_from_slice(bytes);
    }

    /// `opaque x<V>`.
    pub fn opaque(&mut self, bytes: &[u8]) -> Result<(), Error> {
        if bytes.len() > MAX_VECTOR_LEN {
            return Err(Error::TooLarge);
        }
        self.reserve(bytes.len().saturating_add(MAX_LENGTH_PREFIX_LEN));
        tls_codec::vlen::write_length(&mut self.bytes, bytes.len()).map_err(|_| Error::TooLarge)?;
        self.bytes.extend_from_slice(bytes);
        Ok(())
    }

    /// A struct in place.
    pub fn value<T: Encode + ?Sized>(&mut self, value: &T) -> Result<(), Error> {
        value.write(self)
    }

    /// `T x<V>`: the elements one after another behind their total length in bytes.
    pub fn vector<T: Encode>(&mut self, items: &[T]) -> Result<(), Error> {
        let mut content = Writer::new();
        for item in items {
            item.write(&mut content)?;
        }
        self.opaque(&content.bytes)
    }

    /// How many bytes were written.
    pub fn len(&self) -> usize {
        self.bytes.len()
    }

    /// Whether nothing was written.
    pub fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }

    /// The bytes written, in the buffer they were written to: the caller wipes them if they are secret.
    pub fn into_bytes(mut self) -> Vec<u8> {
        std::mem::take(&mut self.bytes)
    }
}

impl Drop for Writer {
    fn drop(&mut self) {
        self.bytes.zeroize();
    }
}

/// Reads an encoding field by field. Every failure is `bad-format`.
pub struct Reader<'a> {
    rest: &'a [u8],
}

impl<'a> Reader<'a> {
    /// A reader at the start of `bytes`.
    pub fn new(bytes: &'a [u8]) -> Self {
        Self { rest: bytes }
    }

    /// The next `len` bytes as they are.
    pub fn take(&mut self, len: usize) -> Result<&'a [u8], Error> {
        let (head, tail) = self.rest.split_at_checked(len).ok_or(Error::BadFormat)?;
        self.rest = tail;
        Ok(head)
    }

    /// `opaque x[N]`.
    pub fn fixed<const N: usize>(&mut self) -> Result<[u8; N], Error> {
        self.take(N)?.try_into().map_err(|_| Error::BadFormat)
    }

    /// `uint8`.
    pub fn u8(&mut self) -> Result<u8, Error> {
        Ok(u8::from_be_bytes(self.fixed()?))
    }

    /// `uint16`.
    pub fn u16(&mut self) -> Result<u16, Error> {
        Ok(u16::from_be_bytes(self.fixed()?))
    }

    /// `uint32`.
    pub fn u32(&mut self) -> Result<u32, Error> {
        Ok(u32::from_be_bytes(self.fixed()?))
    }

    /// `uint64`.
    pub fn u64(&mut self) -> Result<u64, Error> {
        Ok(u64::from_be_bytes(self.fixed()?))
    }

    /// `opaque x<V>`: its content. A length not written in the fewest bytes is refused.
    pub fn opaque(&mut self) -> Result<&'a [u8], Error> {
        let (length, rest) =
            TlsVarInt::tls_deserialize_bytes(self.rest).map_err(|_| Error::BadFormat)?;
        let length = usize::try_from(length.value()).map_err(|_| Error::BadFormat)?;
        if length > MAX_VECTOR_LEN {
            return Err(Error::BadFormat);
        }
        self.rest = rest;
        self.take(length)
    }

    /// A struct in place.
    pub fn value<T: Decode>(&mut self) -> Result<T, Error> {
        T::read(self)
    }

    /// `T x<V>`: elements until the vector's bytes are used up exactly.
    pub fn vector<T: Decode>(&mut self) -> Result<Vec<T>, Error> {
        let mut content = Reader::new(self.opaque()?);
        let mut items = Vec::new();
        while !content.is_empty() {
            let before = content.remaining();
            items.push(T::read(&mut content)?);
            // An element of no bytes would never end the loop.
            if content.remaining() == before {
                return Err(Error::BadFormat);
            }
        }
        Ok(items)
    }

    /// How many bytes are left.
    pub fn remaining(&self) -> usize {
        self.rest.len()
    }

    /// Whether everything was read.
    pub fn is_empty(&self) -> bool {
        self.rest.is_empty()
    }

    /// Ends the reading: bytes left over are refused.
    pub fn finish(self) -> Result<(), Error> {
        if self.rest.is_empty() {
            Ok(())
        } else {
            Err(Error::BadFormat)
        }
    }
}

/// `opaque x<V>` as a value of its own, for a vector of byte strings (`Opaque x<V>`).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Opaque(pub Vec<u8>);

impl Encode for Opaque {
    fn write(&self, writer: &mut Writer) -> Result<(), Error> {
        writer.opaque(&self.0)
    }
}

impl Decode for Opaque {
    fn read(reader: &mut Reader<'_>) -> Result<Self, Error> {
        Ok(Self(reader.opaque()?.to_vec()))
    }
}

impl<const N: usize> Encode for [u8; N] {
    fn write(&self, writer: &mut Writer) -> Result<(), Error> {
        writer.fixed(self);
        Ok(())
    }
}

impl<const N: usize> Decode for [u8; N] {
    fn read(reader: &mut Reader<'_>) -> Result<Self, Error> {
        reader.fixed()
    }
}

macro_rules! integer {
    ($type:ty, $method:ident) => {
        impl Encode for $type {
            fn write(&self, writer: &mut Writer) -> Result<(), Error> {
                writer.$method(*self);
                Ok(())
            }
        }
        impl Decode for $type {
            fn read(reader: &mut Reader<'_>) -> Result<Self, Error> {
                reader.$method()
            }
        }
    };
}
integer!(u8, u8);
integer!(u16, u16);
integer!(u32, u32);
integer!(u64, u64);

#[cfg(test)]
mod tests {
    use super::*;
    use tls_codec::{Serialize as _, TlsSerialize, TlsSize, VLBytes};

    #[derive(Debug, Clone, PartialEq, Eq)]
    struct Inner {
        id: [u8; 4],
        note: Vec<u8>,
    }
    impl Encode for Inner {
        fn write(&self, w: &mut Writer) -> Result<(), Error> {
            w.fixed(&self.id);
            w.opaque(&self.note)
        }
    }
    impl Decode for Inner {
        fn read(r: &mut Reader<'_>) -> Result<Self, Error> {
            Ok(Self {
                id: r.fixed()?,
                note: r.opaque()?.to_vec(),
            })
        }
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    struct Outer {
        a: u8,
        b: u16,
        c: u32,
        d: u64,
        key: [u8; 32],
        name: Vec<u8>,
        inner: Inner,
        list: Vec<Inner>,
        words: Vec<Opaque>,
    }
    impl Encode for Outer {
        fn write(&self, w: &mut Writer) -> Result<(), Error> {
            w.u8(self.a);
            w.u16(self.b);
            w.u32(self.c);
            w.u64(self.d);
            w.fixed(&self.key);
            w.opaque(&self.name)?;
            w.value(&self.inner)?;
            w.vector(&self.list)?;
            w.vector(&self.words)
        }
    }
    impl Decode for Outer {
        fn read(r: &mut Reader<'_>) -> Result<Self, Error> {
            Ok(Self {
                a: r.u8()?,
                b: r.u16()?,
                c: r.u32()?,
                d: r.u64()?,
                key: r.fixed()?,
                name: r.opaque()?.to_vec(),
                inner: r.value()?,
                list: r.vector()?,
                words: r.vector()?,
            })
        }
    }

    /// The same two structs as the `tls_codec` derives encode them.
    #[derive(Debug, TlsSerialize, TlsSize)]
    struct TlsInner {
        id: [u8; 4],
        note: VLBytes,
    }
    #[derive(Debug, TlsSerialize, TlsSize)]
    struct TlsOuter {
        a: u8,
        b: u16,
        c: u32,
        d: u64,
        key: [u8; 32],
        name: VLBytes,
        inner: TlsInner,
        list: Vec<TlsInner>,
        words: Vec<VLBytes>,
    }

    fn sample(name_len: usize, list_len: usize) -> Outer {
        let inner = |i: usize| Inner {
            id: [i as u8; 4],
            note: vec![0xAB; i % 70],
        };
        Outer {
            a: 0x01,
            b: 0x0203,
            c: 0x0405_0607,
            d: 0x0809_0A0B_0C0D_0E0F,
            key: [7; 32],
            name: vec![0x5A; name_len],
            inner: inner(3),
            list: (0..list_len).map(inner).collect(),
            words: vec![Opaque(vec![]), Opaque(b"yes".to_vec()), Opaque(vec![1; 64])],
        }
    }

    fn as_tls_codec(o: &Outer) -> Vec<u8> {
        let inner = |i: &Inner| TlsInner {
            id: i.id,
            note: VLBytes::new(i.note.clone()),
        };
        TlsOuter {
            a: o.a,
            b: o.b,
            c: o.c,
            d: o.d,
            key: o.key,
            name: VLBytes::new(o.name.clone()),
            inner: inner(&o.inner),
            list: o.list.iter().map(inner).collect(),
            words: o.words.iter().map(|w| VLBytes::new(w.0.clone())).collect(),
        }
        .tls_serialize_detached()
        .unwrap()
    }

    #[test]
    fn encodes_as_tls_codec_does_and_reads_it_back() {
        // Lengths on both sides of every prefix width: 1 byte up to 63, 2 bytes up to 16383, then 4.
        for (name_len, list_len) in [
            (0, 0),
            (1, 1),
            (63, 2),
            (64, 9),
            (16383, 40),
            (16384, 300),
            (70_000, 3),
        ] {
            let value = sample(name_len, list_len);
            let bytes = encode(&value).unwrap();
            assert_eq!(
                bytes,
                as_tls_codec(&value),
                "name {name_len}, list {list_len}"
            );
            assert_eq!(decode::<Outer>(&bytes, bytes.len()).unwrap(), value);
        }
    }

    #[test]
    fn length_prefixes_are_the_documented_ones() {
        let prefix = |len: usize| {
            let mut w = Writer::new();
            w.opaque(&vec![0; len]).unwrap();
            let mut bytes = w.into_bytes();
            bytes.truncate(bytes.len() - len);
            bytes
        };
        assert_eq!(prefix(0), [0x00]);
        assert_eq!(prefix(63), [0x3F]);
        assert_eq!(prefix(64), [0x40, 0x40]);
        assert_eq!(prefix(16383), [0x7F, 0xFF]);
        assert_eq!(prefix(16384), [0x80, 0x00, 0x40, 0x00]);
    }

    #[test]
    fn refuses_trailing_bytes_and_truncation() {
        let bytes = encode(&sample(5, 2)).unwrap();
        let mut longer = bytes.clone();
        longer.push(0);
        assert_eq!(decode::<Outer>(&longer, 1 << 20), Err(Error::BadFormat));
        for cut in 0..bytes.len() {
            assert_eq!(
                decode::<Outer>(&bytes[..cut], 1 << 20),
                Err(Error::BadFormat),
                "cut at {cut}"
            );
        }
    }

    #[test]
    fn refuses_input_above_the_limit() {
        let bytes = encode(&sample(5, 2)).unwrap();
        assert_eq!(
            decode::<Outer>(&bytes, bytes.len() - 1),
            Err(Error::TooLarge)
        );
    }

    #[test]
    fn refuses_a_length_not_in_the_fewest_bytes() {
        // 5 written in two bytes, in four and in eight.
        for prefix in [
            &[0x40, 0x05][..],
            &[0x80, 0, 0, 5],
            &[0xC0, 0, 0, 0, 0, 0, 0, 5],
        ] {
            let mut bytes = prefix.to_vec();
            bytes.extend_from_slice(b"hello");
            assert_eq!(decode::<Opaque>(&bytes, 64), Err(Error::BadFormat));
        }
        assert_eq!(
            decode::<Opaque>(b"\x05hello", 64),
            Ok(Opaque(b"hello".to_vec()))
        );
    }

    #[test]
    fn refuses_a_length_beyond_the_input_without_allocating_for_it() {
        // 2^30 - 1 bytes announced, in a vector of bytes and in a vector of structs; and a length above the maximum.
        let huge = [0xBF, 0xFF, 0xFF, 0xFF, 1, 2, 3];
        assert_eq!(decode::<Opaque>(&huge, 64), Err(Error::BadFormat));
        assert_eq!(
            Reader::new(&huge).vector::<Inner>().err(),
            Some(Error::BadFormat)
        );
        let beyond = [0xC0, 0, 0, 0, 0x40, 0, 0, 0];
        assert_eq!(decode::<Opaque>(&beyond, 64), Err(Error::BadFormat));
        assert_eq!(decode::<Opaque>(&[], 64), Err(Error::BadFormat));
    }

    #[test]
    fn a_vector_must_end_with_its_last_element() {
        // Two bytes of content for elements of four.
        assert_eq!(
            Reader::new(&[2, 9, 9]).vector::<[u8; 4]>().err(),
            Some(Error::BadFormat)
        );
        // Six bytes: one element and half of another.
        assert_eq!(
            Reader::new(&[6, 1, 1, 1, 1, 2, 2])
                .vector::<[u8; 4]>()
                .err(),
            Some(Error::BadFormat)
        );
        // Elements of no bytes never end.
        assert_eq!(
            Reader::new(&[1, 0]).vector::<[u8; 0]>().err(),
            Some(Error::BadFormat)
        );
        assert_eq!(
            Reader::new(&[4, 1, 2, 3, 4]).vector::<[u8; 2]>().unwrap(),
            [[1, 2], [3, 4]]
        );
        assert_eq!(
            Reader::new(&[0]).vector::<[u8; 2]>().unwrap(),
            Vec::<[u8; 2]>::new()
        );
    }

    #[test]
    fn integers_are_big_endian() {
        assert_eq!(encode(&0x0102u16).unwrap(), [1, 2]);
        assert_eq!(encode(&0x0102_0304u32).unwrap(), [1, 2, 3, 4]);
        assert_eq!(
            encode(&0x0102_0304_0506_0708u64).unwrap(),
            [1, 2, 3, 4, 5, 6, 7, 8]
        );
        assert_eq!(
            decode::<u64>(&[1, 2, 3, 4, 5, 6, 7, 8], 8),
            Ok(0x0102_0304_0506_0708)
        );
        assert_eq!(decode::<u32>(&[1, 2, 3], 8), Err(Error::BadFormat));
    }

    #[test]
    fn no_input_makes_the_reader_panic() {
        // Every string of up to three bytes from a small alphabet of telling values, then a few longer ones.
        let alphabet = [0x00, 0x01, 0x3F, 0x40, 0x7F, 0x80, 0xBF, 0xC0, 0xFF];
        let mut inputs: Vec<Vec<u8>> = vec![vec![]];
        for a in alphabet {
            inputs.push(vec![a]);
            for b in alphabet {
                inputs.push(vec![a, b]);
                for c in alphabet {
                    inputs.push(vec![a, b, c]);
                    inputs.push([&[a, b, c][..], &[0xFF; 9]].concat());
                }
            }
        }
        for input in inputs {
            let _ = decode::<Outer>(&input, 1 << 20);
            let _ = decode::<Opaque>(&input, 1 << 20);
            let _ = Reader::new(&input).vector::<Inner>();
            let _ = Reader::new(&input).vector::<Opaque>();
        }
    }
}
