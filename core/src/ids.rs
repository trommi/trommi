//! The identifiers of the protocol, and base64url as links and JSON carry bytes. All of these are public values:
//! they print as hex. An identifier is a fixed number of bytes; whatever reads one from outside goes through
//! `from_slice`, which refuses another length.

use crate::codec::{Decode, Encode, Reader, Writer};
use crate::error::Error;
use std::fmt;

fn write_hex(f: &mut fmt::Formatter<'_>, bytes: &[u8]) -> fmt::Result {
    bytes.iter().try_for_each(|byte| write!(f, "{byte:02x}"))
}

macro_rules! id {
    ($(#[$doc:meta])* $name:ident, $len:literal) => {
        $(#[$doc])*
        #[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
        pub struct $name([u8; $len]);

        impl $name {
            /// Its length in bytes.
            pub const LEN: usize = $len;
            /// All zero bytes: where the format says "none".
            pub const ZERO: Self = Self([0; $len]);

            /// The identifier with these bytes.
            pub const fn new(bytes: [u8; $len]) -> Self {
                Self(bytes)
            }

            /// The identifier with these bytes; `bad-format` for another length.
            pub fn from_slice(bytes: &[u8]) -> Result<Self, Error> {
                bytes.try_into().map(Self).map_err(|_| Error::BadFormat)
            }

            /// Its bytes.
            pub const fn as_bytes(&self) -> &[u8; $len] {
                &self.0
            }

            /// Whether it is [`Self::ZERO`].
            pub fn is_zero(&self) -> bool {
                *self == Self::ZERO
            }

            /// As it stands in JSON and in links.
            pub fn to_base64url(&self) -> String {
                base64url_encode(&self.0)
            }

            /// Read from JSON or a link; `bad-format` for anything but its canonical form.
            pub fn from_base64url(text: &str) -> Result<Self, Error> {
                Self::from_slice(&base64url_decode(text)?)
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write_hex(f, &self.0)
            }
        }

        impl fmt::Debug for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, concat!(stringify!($name), "({})"), self)
            }
        }

        impl Encode for $name {
            fn write(&self, writer: &mut Writer) -> Result<(), Error> {
                writer.fixed(&self.0);
                Ok(())
            }
        }

        impl Decode for $name {
            fn read(reader: &mut Reader<'_>) -> Result<Self, Error> {
                Ok(Self(reader.fixed()?))
            }
        }
    };
}

id!(
    /// A device: its Ed25519 signature key. Ordered as the format sorts devices, ascending by bytes.
    DeviceId, 32
);
id!(
    /// A room: 32 random bytes.
    RoomId, 32
);
id!(
    /// A session: 16 random bytes. Zero as a `parent` means a main session.
    SessionId, 16
);
id!(
    /// A SHA-256 value: a `RefHash`, an envelope hash, a file's hash.
    Hash32, 32
);
id!(
    /// An object (card, note, request, artifact): the first 16 bytes of the hash of its first version.
    ObjectId, 16
);
id!(
    /// A stored file: 16 random bytes.
    FileId, 16
);
id!(
    /// A register as the hub sees it: 16 random bytes its writer chose for one name.
    RegisterId, 16
);
id!(
    /// A Scribble Board: its Desk's id, or [`BoardId::ALL_DESKS`].
    BoardId, 16
);
id!(
    /// An invite: derived from the link's secret.
    InviteId, 16
);
id!(
    /// A Share link as the hub knows it: 16 random bytes.
    ShareId, 16
);
id!(
    /// One turn of an agent, which its work trail steps name: 16 random bytes.
    TurnId, 16
);

impl BoardId {
    /// The board of "All desks".
    pub const ALL_DESKS: Self = Self(*b"all-desks\0\0\0\0\0\0\x09");
}

/// An MLS group of a room: the room group (`room_id`, 32 bytes) or a session group (`room_id ‖ session_id`, 48
/// bytes). No other length is a group id.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct GroupId {
    room: RoomId,
    session: Option<SessionId>,
    /// `room ‖ session`, kept beside the parts so that the bytes can be lent.
    joined: [u8; 48],
}

impl GroupId {
    /// The room group of `room`.
    pub fn room(room: RoomId) -> Self {
        Self {
            room,
            session: None,
            joined: [0; 48],
        }
    }

    /// The group of `session` in `room`.
    pub fn session(room: RoomId, session: SessionId) -> Self {
        let mut joined = [0; 48];
        let parts = room.as_bytes().iter().chain(session.as_bytes());
        for (to, from) in joined.iter_mut().zip(parts) {
            *to = *from;
        }
        Self {
            room,
            session: Some(session),
            joined,
        }
    }

    /// The group these bytes name; `bad-format` unless they are 32 or 48.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, Error> {
        let (room, session) = bytes
            .split_at_checked(RoomId::LEN)
            .ok_or(Error::BadFormat)?;
        let room = RoomId::from_slice(room)?;
        if session.is_empty() {
            Ok(Self::room(room))
        } else {
            Ok(Self::session(room, SessionId::from_slice(session)?))
        }
    }

    /// The MLS `group_id`.
    pub fn as_bytes(&self) -> &[u8] {
        match self.session {
            Some(_) => &self.joined,
            None => self.room.as_bytes(),
        }
    }

    /// The room this group belongs to.
    pub fn room_id(&self) -> RoomId {
        self.room
    }

    /// The session, for a session group.
    pub fn session_id(&self) -> Option<SessionId> {
        self.session
    }

    /// Whether this is the room group.
    pub fn is_room(&self) -> bool {
        self.session.is_none()
    }
}

impl fmt::Display for GroupId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write_hex(f, self.as_bytes())
    }
}

impl fmt::Debug for GroupId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "GroupId({self})")
    }
}

/// `opaque group_id<V>`, as every struct of the format carries a group.
impl Encode for GroupId {
    fn write(&self, writer: &mut Writer) -> Result<(), Error> {
        writer.opaque(self.as_bytes())
    }
}

impl Decode for GroupId {
    fn read(reader: &mut Reader<'_>) -> Result<Self, Error> {
        Self::from_bytes(reader.opaque()?)
    }
}

/// The base64url symbol (RFC 4648 section 5) of six bits.
fn symbol(sextet: u8) -> char {
    char::from(match sextet & 0x3F {
        s @ 0..=25 => b'A'.wrapping_add(s),
        s @ 26..=51 => b'a'.wrapping_add(s.wrapping_sub(26)),
        s @ 52..=61 => b'0'.wrapping_add(s.wrapping_sub(52)),
        62 => b'-',
        _ => b'_',
    })
}

/// The six bits of a base64url symbol.
fn sextet(symbol: u8) -> Option<u8> {
    match symbol {
        b'A'..=b'Z' => Some(symbol.wrapping_sub(b'A')),
        b'a'..=b'z' => Some(symbol.wrapping_sub(b'a').wrapping_add(26)),
        b'0'..=b'9' => Some(symbol.wrapping_sub(b'0').wrapping_add(52)),
        b'-' => Some(62),
        b'_' => Some(63),
        _ => None,
    }
}

/// Bytes as base64url without padding.
pub fn base64url_encode(bytes: &[u8]) -> String {
    let mut text = String::new();
    for chunk in bytes.chunks(3) {
        let mut group = [0u8; 3];
        for (to, from) in group.iter_mut().zip(chunk) {
            *to = *from;
        }
        let [a, b, c] = group;
        let sextets = [a >> 2, a << 4 | b >> 4, b << 2 | c >> 6, c];
        // One byte gives two symbols, two give three, three give four.
        text.extend(
            sextets
                .iter()
                .take(chunk.len().saturating_add(1))
                .map(|s| symbol(*s)),
        );
    }
    text
}

/// The bytes of a base64url text, strictly: no padding, no symbol outside the alphabet, no white space, and no set
/// bit behind the last whole byte, so that every byte string has exactly one text. Anything else is `bad-format`.
pub fn base64url_decode(text: &str) -> Result<Vec<u8>, Error> {
    let mut bytes = Vec::new();
    for chunk in text.as_bytes().chunks(4) {
        let mut sextets = [0u8; 4];
        for (to, from) in sextets.iter_mut().zip(chunk) {
            *to = sextet(*from).ok_or(Error::BadFormat)?;
        }
        let [a, b, c, d] = sextets;
        let group = [a << 2 | b >> 4, b << 4 | c >> 2, c << 6 | d];
        // Two symbols carry one byte, three carry two, four carry three; one symbol alone carries none.
        let whole = chunk
            .len()
            .checked_sub(1)
            .filter(|n| *n > 0)
            .ok_or(Error::BadFormat)?;
        if group.iter().skip(whole).any(|rest| *rest != 0) {
            return Err(Error::BadFormat);
        }
        bytes.extend(group.iter().take(whole));
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codec::{decode, encode};

    #[test]
    fn base64url_is_rfc_4648_without_padding() {
        let cases = [
            ("", ""),
            ("f", "Zg"),
            ("fo", "Zm8"),
            ("foo", "Zm9v"),
            ("foob", "Zm9vYg"),
            ("fooba", "Zm9vYmE"),
            ("foobar", "Zm9vYmFy"),
        ];
        for (plain, text) in cases {
            assert_eq!(base64url_encode(plain.as_bytes()), text);
            assert_eq!(base64url_decode(text).unwrap(), plain.as_bytes());
        }
        assert_eq!(base64url_encode(&[0xFB, 0xFF, 0xFE]), "-__-");
        assert_eq!(base64url_decode("-__-").unwrap(), [0xFB, 0xFF, 0xFE]);
    }

    #[test]
    fn base64url_round_trips_every_short_string() {
        for a in 0..=255u8 {
            assert_eq!(base64url_decode(&base64url_encode(&[a])).unwrap(), [a]);
            for b in (0..=255u8).step_by(7) {
                assert_eq!(
                    base64url_decode(&base64url_encode(&[a, b])).unwrap(),
                    [a, b]
                );
                assert_eq!(
                    base64url_decode(&base64url_encode(&[a, b, a])).unwrap(),
                    [a, b, a]
                );
                assert_eq!(
                    base64url_decode(&base64url_encode(&[b, a, b, a])).unwrap(),
                    [b, a, b, a]
                );
            }
        }
    }

    #[test]
    fn base64url_refuses_everything_but_the_canonical_text() {
        let refused = [
            "Zg==", "Zm8=", "Zg=", // padding
            "Z", "Zm9vY", // a symbol that carries no byte
            "Zh", "Zm9", // set bits behind the last byte
            "Zm+v", "Zm/v", // the other alphabet
            "Zm 9v", "Zm9v\n", " Zg", "Zg\u{e9}",
        ];
        for text in refused {
            assert_eq!(base64url_decode(text), Err(Error::BadFormat), "{text:?}");
        }
        // Each two-symbol text is canonical exactly when its last four bits are zero.
        let canonical = (0..64u8)
            .filter(|s| base64url_decode(&format!("A{}", symbol(*s))).is_ok())
            .count();
        assert_eq!(canonical, 4);
        let canonical = (0..64u8)
            .filter(|s| base64url_decode(&format!("AA{}", symbol(*s))).is_ok())
            .count();
        assert_eq!(canonical, 16);
    }

    #[test]
    fn an_id_has_one_length() {
        assert_eq!(
            DeviceId::from_slice(&[7; 32]).unwrap(),
            DeviceId::new([7; 32])
        );
        assert_eq!(DeviceId::from_slice(&[7; 31]), Err(Error::BadFormat));
        assert_eq!(DeviceId::from_slice(&[7; 33]), Err(Error::BadFormat));
        assert_eq!(SessionId::from_slice(&[]), Err(Error::BadFormat));
        assert!(SessionId::ZERO.is_zero());
        assert!(!SessionId::new([1; 16]).is_zero());
    }

    #[test]
    fn ids_print_as_hex_and_travel_as_base64url() {
        let id = ObjectId::new([0xAB; 16]);
        assert_eq!(id.to_string(), "ab".repeat(16));
        assert_eq!(format!("{id:?}"), format!("ObjectId({})", "ab".repeat(16)));
        assert_eq!(ObjectId::from_base64url(&id.to_base64url()).unwrap(), id);
        assert_eq!(
            ObjectId::from_base64url(&DeviceId::ZERO.to_base64url()),
            Err(Error::BadFormat)
        );
        assert_eq!(
            BoardId::ALL_DESKS.to_string(),
            "616c6c2d6465736b7300000000000009"
        );
    }

    #[test]
    fn devices_sort_by_their_bytes() {
        let mut low = [0; 32];
        low[31] = 9;
        let mut high = [0; 32];
        high[0] = 1;
        let mut devices = [DeviceId::new(high), DeviceId::new(low), DeviceId::ZERO];
        devices.sort();
        assert_eq!(
            devices,
            [DeviceId::ZERO, DeviceId::new(low), DeviceId::new(high)]
        );
    }

    #[test]
    fn a_group_id_is_a_room_or_a_room_and_a_session() {
        let room = RoomId::new([1; 32]);
        let session = SessionId::new([2; 16]);
        let room_group = GroupId::room(room);
        assert_eq!(room_group.as_bytes(), [1; 32]);
        assert_eq!(
            (
                room_group.room_id(),
                room_group.session_id(),
                room_group.is_room()
            ),
            (room, None, true)
        );

        let session_group = GroupId::session(room, session);
        assert_eq!(
            session_group.as_bytes(),
            [[1u8; 32].as_slice(), &[2; 16]].concat()
        );
        assert_eq!(
            (session_group.room_id(), session_group.session_id()),
            (room, Some(session))
        );
        assert!(!session_group.is_room());

        assert_eq!(
            GroupId::from_bytes(room_group.as_bytes()).unwrap(),
            room_group
        );
        assert_eq!(
            GroupId::from_bytes(session_group.as_bytes()).unwrap(),
            session_group
        );
        for len in [0, 1, 16, 31, 33, 47, 49, 64] {
            assert_eq!(
                GroupId::from_bytes(&vec![0; len]),
                Err(Error::BadFormat),
                "{len} bytes"
            );
        }
        // A session of zeros is still a session group: the length decides.
        assert_ne!(
            GroupId::from_bytes(&[0; 48]).unwrap(),
            GroupId::from_bytes(&[0; 32]).unwrap()
        );
        assert_eq!(
            format!("{room_group:?}"),
            format!("GroupId({})", "01".repeat(32))
        );
    }

    #[test]
    fn ids_encode_as_the_format_writes_them() {
        assert_eq!(encode(&FileId::new([5; 16])).unwrap(), [5; 16]);
        assert_eq!(
            decode::<FileId>(&[5; 16], 16).unwrap(),
            FileId::new([5; 16])
        );
        let group = GroupId::session(RoomId::new([1; 32]), SessionId::new([2; 16]));
        let bytes = encode(&group).unwrap();
        assert_eq!(bytes.len(), 49);
        assert_eq!(bytes.first(), Some(&48));
        assert_eq!(decode::<GroupId>(&bytes, 64).unwrap(), group);
        assert_eq!(decode::<GroupId>(&[3, 1, 2, 3], 64), Err(Error::BadFormat));
    }
}
