//! No copy of a secret is left behind in memory that was given back: every buffer a key, a link's secret or a
//! sealed body's plaintext passed through is wiped before it is freed. The allocator of this test program looks
//! into every block as it is freed, and into every block that is moved to grow, for the marks of the secrets
//! the test uses.

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

use trommi_core::chain::{seal_next, Chains, OwnChain, Role};
use trommi_core::codec::Writer;
use trommi_core::crypto::{Entropy, Secret, SigningKey};
use trommi_core::envelope::Draft;
use trommi_core::files::{share_secret_matches, FileRef, ShareLink};
use trommi_core::hub_auth::HubAddress;
use trommi_core::ids::{self, GroupId, Hash32, RoomId, SessionId};
use trommi_core::invite::{InviteLink, InviteTerms, Inviter, Role as InviteRole};
use trommi_core::objects::Objects;
use trommi_core::push::{self, ApnsPush};
use trommi_core::Error;
use trommi_tests::content::{View, ROOM};
use trommi_tests::room::NoEntropy;

/// The secret of this test: 32 bytes that stand nowhere else.
const KEY: [u8; 32] = [
    0xA5, 0x5A, 0xC3, 0x3C, 0x96, 0x69, 0xF0, 0x0F, 0xE1, 0x1E, 0xD2, 0x2D, 0xB4, 0x4B, 0x87, 0x78,
    0x13, 0x31, 0x57, 0x75, 0x9B, 0xB9, 0xDF, 0xFD, 0x24, 0x42, 0x68, 0x86, 0xAC, 0xCA, 0xE0, 0x0E,
];
/// Its base64url.
const KEY_TEXT: &str = "pVrDPJZp8A_hHtIttEuHeBMxV3Wbud_9JEJohqzK4A4";
/// What gives a copy away: the first bytes of the secret, and of its text.
const MARKS: [&[u8]; 2] = [&[0xA5, 0x5A, 0xC3, 0x3C, 0x96, 0x69], b"pVrDPJZp"];

/// How many freed or moved blocks held a mark.
static LEFT_BEHIND: AtomicUsize = AtomicUsize::new(0);

struct Watching;

fn holds_a_mark(block: &[u8]) -> bool {
    MARKS
        .iter()
        .any(|mark| block.windows(mark.len()).any(|window| window == *mark))
}

// SAFETY: every call is passed on to the system allocator with the arguments it was given; a block is only
// read, within the size it was allocated with, before it is given back.
unsafe impl GlobalAlloc for Watching {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        unsafe { System.alloc(layout) }
    }

    unsafe fn dealloc(&self, block: *mut u8, layout: Layout) {
        if holds_a_mark(unsafe { std::slice::from_raw_parts(block, layout.size()) }) {
            LEFT_BEHIND.fetch_add(1, Ordering::SeqCst);
        }
        unsafe { System.dealloc(block, layout) }
    }

    unsafe fn realloc(&self, block: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        // A block that grows may move, and the system frees the old one unseen: it counts as freed here.
        if holds_a_mark(unsafe { std::slice::from_raw_parts(block, layout.size()) }) {
            LEFT_BEHIND.fetch_add(1, Ordering::SeqCst);
        }
        unsafe { System.realloc(block, layout, new_size) }
    }
}

#[global_allocator]
static ALLOCATOR: Watching = Watching;

/// What was left behind while `step` ran.
fn left_behind(step: impl FnOnce()) -> usize {
    let before = LEFT_BEHIND.load(Ordering::SeqCst);
    step();
    LEFT_BEHIND.load(Ordering::SeqCst) - before
}

/// A source that gives the secret out whenever 32 bytes are asked for, which is what a key or a link's secret
/// takes; an id or a nonce, which are public, gets other bytes.
struct TheKey;

impl Entropy for TheKey {
    fn fill(&mut self, out: &mut [u8]) -> Result<(), Error> {
        if out.len() == KEY.len() {
            out.copy_from_slice(&KEY);
        } else {
            out.fill(0x11);
        }
        Ok(())
    }
}

const APP: &str = "https://app.example.org";

/// Everything in one test: the count is the program's, and no other test may free a block meanwhile.
#[test]
fn no_freed_block_holds_a_secret() {
    assert_eq!(ids::base64url_encode(&KEY), KEY_TEXT);
    // The watch itself works: a buffer freed as it is counts, one that was wiped does not.
    assert_eq!(left_behind(|| drop(KEY.to_vec())), 1);
    assert_eq!(left_behind(|| drop(zeroed(KEY.to_vec()))), 0);
    assert_eq!(
        left_behind(|| {
            let mut growing = Vec::new();
            for byte in KEY {
                growing.push(byte);
            }
            drop(zeroed(growing));
        }),
        2,
        "a vector that grows leaves a copy behind at each step"
    );

    // base64url, both ways: one buffer of the final length; a refused text leaves nothing.
    let refused = [KEY_TEXT, "!"].concat();
    assert_eq!(
        left_behind(|| {
            drop(zeroed(ids::base64url_decode(KEY_TEXT).unwrap()));
            drop(zeroed(ids::base64url_encode(&KEY).into_bytes()));
            assert_eq!(ids::base64url_decode(&refused), Err(Error::BadFormat));
            let mut place = [0u8; 32];
            ids::base64url_decode_into(KEY_TEXT, &mut place).unwrap();
            assert_eq!(place, KEY);
        }),
        0,
        "base64url"
    );
    drop(zeroed(refused.into_bytes()));

    // A writer that grows with a secret in it.
    assert_eq!(
        left_behind(|| {
            let mut writer = Writer::new();
            writer.fixed(&KEY);
            for _ in 0..20_000 {
                writer.u64(7);
            }
            writer.opaque(&[1; 70_000]).unwrap();
            drop(zeroed(writer.into_bytes()));
            let mut unfinished = Writer::new();
            unfinished.opaque(&KEY).unwrap();
            unfinished.opaque(&[2; 5_000]).unwrap();
        }),
        0,
        "a writer"
    );

    // An attachment's key, and a Share link read, written and compared.
    let id = ids::base64url_encode(&[0xF1; 16]);
    let hash = Hash32::new([7; 32]).to_base64url();
    let link = format!("{APP}/a/{id}#{KEY_TEXT}.{KEY_TEXT}.{hash}");
    assert_eq!(
        left_behind(|| {
            let file = FileRef::from_base64url(&id, KEY_TEXT, &hash).unwrap();
            assert_eq!(file.file_key, Secret::new(KEY));
            drop(file.file_key_base64url());
            let share = ShareLink::parse(&link).unwrap();
            assert_eq!(share.to_text().expose(), link.as_bytes());
            drop(share.secret_base64url());
            let registered = share.secret_hash().unwrap();
            assert_eq!(share_secret_matches(KEY_TEXT, &registered), Ok(true));
            let fresh = ShareLink::create(APP, &file, &mut TheKey).unwrap();
            assert_eq!(fresh.secret, Secret::new(KEY));
            drop(fresh.to_text());
        }),
        0,
        "files and Share links"
    );
    drop(zeroed(link.into_bytes()));

    // An invite: its link read and written, and the inviter's state stored and read back.
    let hub = HubAddress::parse("https://hub.example.org").unwrap();
    let hub_text = ids::base64url_encode(hub.as_str().as_bytes());
    let room = RoomId::new([7; 32]);
    let link = format!(
        "{APP}/join#v2.{hub_text}.{}.{KEY_TEXT}",
        room.to_base64url()
    );
    let inviter_key = SigningKey::from_seed(Secret::new([1; 32]));
    assert_eq!(
        left_behind(|| {
            let read = InviteLink::parse(&link).unwrap();
            assert_eq!(read.to_text().expose(), link.as_bytes());
            let terms = InviteTerms {
                app: APP.into(),
                hub: hub.clone(),
                room_id: room,
                role: InviteRole::Human,
                session_id: SessionId::ZERO,
                room_epoch: 1,
                room_state: Hash32::new([5; 32]),
            };
            // The link's secret and the nonce are both the secret of this test.
            let inviter = Inviter::open(&inviter_key, terms, 1_000, &mut TheKey).unwrap();
            assert_eq!(inviter.link().to_text().expose(), link.as_bytes());
            let stored = inviter.to_stored().unwrap();
            assert!(holds_a_mark(stored.expose()));
            let again = Inviter::from_stored(stored.expose()).unwrap();
            assert_eq!(again.offer(), inviter.offer());
            assert!(Inviter::open(
                &inviter_key,
                InviteTerms {
                    app: APP.into(),
                    hub: hub.clone(),
                    room_id: room,
                    role: InviteRole::Human,
                    session_id: SessionId::ZERO,
                    room_epoch: 1,
                    room_state: Hash32::new([5; 32]),
                },
                1_000,
                &mut NoEntropy
            )
            .is_err());
        }),
        0,
        "an invite"
    );
    drop(zeroed(link.into_bytes()));

    // An envelope whose body names a file's key, sealed. Opening one is not watched here: the provider's AEAD
    // hands the plaintext over in a copy of the buffer it decrypted in, and frees that buffer as it is.
    let human = SigningKey::from_seed(Secret::new([2; 32]));
    let human_id = trommi_core::ids::DeviceId::new(human.public());
    let group = GroupId::room(ROOM);
    let view = View::new(group, &[(human_id, Role::Human)], Some([9; 32]));
    let payload =
        format!(r#"{{"schema_version":2,"content_type":"note","file_key":"{KEY_TEXT}"}}"#);
    let mut opened = None;
    assert_eq!(
        left_behind(|| {
            let draft = Draft::board_item(trommi_core::ids::BoardId::ALL_DESKS, payload.as_bytes());
            let sealed = seal_next(
                &view,
                &Chains::new(),
                &Objects::new(),
                &mut OwnChain::new(),
                &draft,
                group,
                &human,
                1_000,
                &mut TheKey,
            )
            .unwrap();
            opened = Some(sealed.envelope);
        }),
        0,
        "an envelope's body"
    );
    let body = opened
        .expect("an envelope")
        .open(&Secret::new([9; 32]))
        .unwrap();
    assert_eq!(body.payload(), payload.as_bytes());
    drop(body);
    drop(zeroed(payload.into_bytes()));

    // A push ticket, sealed.
    let mut notification = ApnsPush {
        room_id: room,
        change: 7,
        urgency: 1,
        ticket: KEY.repeat(8),
    };
    let push_key = Secret::new([3; 32]);
    let mut sealed = Vec::new();
    assert_eq!(
        left_behind(|| {
            sealed = push::seal(&push_key, &notification, &mut TheKey).unwrap();
        }),
        0,
        "a push ticket"
    );
    let mut read = push::open(&push_key, &sealed).unwrap();
    assert_eq!(read, notification);
    wipe(&mut read.ticket);
    wipe(&mut notification.ticket);
}

/// Uses no secret of the watched test: what it frees holds no mark.
#[test]
fn bytes_of_a_known_length_are_read_strictly_into_their_place() {
    for len in 0..70usize {
        let bytes: Vec<u8> = (0..len).map(|i| (i * 37 + len) as u8).collect();
        let text = ids::base64url_encode(&bytes);
        assert_eq!(text.len(), ids::base64url_len(len));
        assert_eq!(text.capacity(), text.len());
        let mut place = vec![0xEE; len];
        assert_eq!(ids::base64url_decode_into(&text, &mut place), Ok(()));
        assert_eq!(place, bytes);
        assert_eq!(ids::base64url_decode(&text).unwrap(), bytes);

        // Another length, either way, is refused unread; the place is wiped.
        for other in [len + 1, len.saturating_sub(1), len + 3] {
            if other == len {
                continue;
            }
            let mut place = vec![0xEE; other];
            assert_eq!(
                ids::base64url_decode_into(&text, &mut place),
                Err(Error::BadFormat)
            );
            assert!(place.iter().all(|byte| *byte == 0));
        }
        // A symbol outside the alphabet, at any place: refused, and nothing of what was read stays.
        for at in 0..text.len() {
            let mut bad = text.clone().into_bytes();
            bad[at] = b'=';
            let bad = String::from_utf8(bad).unwrap();
            let mut place = vec![0xEE; len];
            assert_eq!(
                ids::base64url_decode_into(&bad, &mut place),
                Err(Error::BadFormat)
            );
            assert!(place.iter().all(|byte| *byte == 0));
            assert_eq!(ids::base64url_decode(&bad), Err(Error::BadFormat));
        }
    }
    // A set bit behind the last whole byte: the text of no byte string.
    let mut place = [0xEE; 1];
    assert_eq!(ids::base64url_decode_into("AA", &mut place), Ok(()));
    assert_eq!(
        ids::base64url_decode_into("AB", &mut place),
        Err(Error::BadFormat)
    );
    assert_eq!(place, [0]);
}

fn wipe(bytes: &mut [u8]) {
    bytes.fill(0);
    std::hint::black_box(&bytes);
}

/// The buffer with nothing left in it, as a caller hands one back that held a secret.
fn zeroed(mut bytes: Vec<u8>) -> Vec<u8> {
    wipe(&mut bytes);
    bytes
}
