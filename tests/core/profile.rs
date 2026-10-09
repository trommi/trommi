//! The encodings of the profile (section 3): the two group extensions and the note of every Commit.

use trommi_core::codec;
use trommi_core::ids::{DeviceId, Hash32, RoomId, SessionId};
use trommi_core::mls::profile::*;
use trommi_core::Error;

fn device(byte: u8) -> DeviceId {
    DeviceId::new([byte; 32])
}

fn room() -> TrommiRoom {
    TrommiRoom {
        recovery_signature_key: [1; 32],
        recovery_hpke_key: [2; 32],
        agents: vec![device(3), device(4)],
    }
}

#[test]
fn room_extension_round_trips_and_is_strict() {
    let bytes = codec::encode(&room()).unwrap();
    assert_eq!(bytes.len(), 33 + 33 + 2 + 64);
    assert_eq!(codec::decode::<TrommiRoom>(&bytes, 4096).unwrap(), room());

    let mut unsorted = room();
    unsorted.agents.reverse();
    assert_eq!(codec::encode(&unsorted), Err(Error::BadFormat));
    let mut doubled = room();
    doubled.agents = vec![device(3), device(3)];
    assert_eq!(codec::encode(&doubled), Err(Error::BadFormat));

    // The same on reading: descending agents, an agent of 31 bytes, a short recovery key, trailing bytes.
    let mut swapped = bytes.clone();
    swapped[68..132].rotate_left(32);
    assert_eq!(
        codec::decode::<TrommiRoom>(&swapped, 4096),
        Err(Error::BadFormat)
    );
    let mut short = bytes.clone();
    short[67] = 63;
    short.pop();
    assert_eq!(
        codec::decode::<TrommiRoom>(&short, 4096),
        Err(Error::BadFormat)
    );
    let mut short_key = vec![31];
    short_key.extend_from_slice(&bytes[2..]);
    assert_eq!(
        codec::decode::<TrommiRoom>(&short_key, 4096),
        Err(Error::BadFormat)
    );
    let mut trailing = bytes;
    trailing.push(0);
    assert_eq!(
        codec::decode::<TrommiRoom>(&trailing, 4096),
        Err(Error::BadFormat)
    );
}

#[test]
fn session_extension_round_trips() {
    let session = TrommiSession {
        room_id: RoomId::new([7; 32]),
        session_id: SessionId::new([8; 16]),
        parent: SessionId::ZERO,
    };
    let bytes = codec::encode(&session).unwrap();
    assert_eq!(bytes.len(), 64);
    assert_eq!(codec::decode::<TrommiSession>(&bytes, 64).unwrap(), session);
    assert_eq!(session.group_id().as_bytes().len(), 48);
    assert_eq!(
        codec::decode::<TrommiSession>(&bytes[..63], 64),
        Err(Error::BadFormat)
    );
}

#[test]
fn commit_note_round_trips_and_is_strict() {
    let note = CommitNote {
        room_epoch: 5,
        room_state: Hash32::new([9; 32]),
        time: 1_700_000_000_000,
        cuts: vec![
            Cut::none(device(1)),
            Cut {
                device: device(2),
                seq: 7,
                hash: Hash32::new([3; 32]),
            },
        ],
        join: true,
    };
    let bytes = codec::encode(&note).unwrap();
    assert_eq!(bytes.len(), 1 + 8 + 32 + 8 + 2 + 144 + 1);
    assert_eq!(
        codec::decode::<CommitNote>(&bytes, MAX_NOTE_LEN).unwrap(),
        note
    );

    let mut unsorted = note.clone();
    unsorted.cuts.reverse();
    assert_eq!(codec::encode(&unsorted), Err(Error::BadFormat));

    let mut newer = bytes.clone();
    newer[0] = 3;
    assert_eq!(
        codec::decode::<CommitNote>(&newer, MAX_NOTE_LEN),
        Err(Error::NewerVersion)
    );
    let mut older = bytes.clone();
    older[0] = 1;
    assert_eq!(
        codec::decode::<CommitNote>(&older, MAX_NOTE_LEN),
        Err(Error::BadFormat)
    );
    let mut flag = bytes.clone();
    *flag.last_mut().unwrap() = 2;
    assert_eq!(
        codec::decode::<CommitNote>(&flag, MAX_NOTE_LEN),
        Err(Error::BadFormat)
    );
    // The second Cut's device made equal to the first's: a duplicate.
    let mut doubled = bytes.clone();
    doubled.copy_within(51..83, 51 + 72);
    assert_eq!(
        codec::decode::<CommitNote>(&doubled, MAX_NOTE_LEN),
        Err(Error::BadFormat)
    );
    assert_eq!(
        codec::decode::<CommitNote>(&bytes, bytes.len() - 1),
        Err(Error::TooLarge)
    );
}
