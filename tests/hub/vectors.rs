//! Fixed bytes for every struct of spec/v1.md that the hub reads, written out by hand from the spec's
//! definitions (field by field, with the length prefixes of RFC 9420 section 2.1.2), and digests computed outside
//! this code base (Python's hashlib over the same hand-written layout). Three things must agree with them: what
//! the hub parses, what the hub encodes, and what the test clients' own encoder (`common/enc.rs`) encodes. A
//! mistake shared by the hub's parser and its encoder cannot pass here.

mod common;

use common::enc::{self, Bytes};
use trommi_hub::wire::*;

/// Hex pieces, concatenated. Nothing else: every length prefix below is written by hand.
fn hex(parts: &[&str]) -> Vec<u8> {
    let all: String = parts.concat().split_whitespace().collect();
    (0..all.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&all[i..i + 2], 16).unwrap())
        .collect()
}

/// `byte` repeated `n` times, as hex.
fn rep(byte: &str, n: usize) -> String {
    byte.repeat(n)
}

fn ascii(text: &str) -> String {
    text.bytes().map(|b| format!("{b:02x}")).collect()
}

const TIME: &str = "0000018bcfe56800"; // 1 700 000 000 000 ms

fn group48() -> String {
    rep("11", 32) + &rep("22", 16)
}

fn header_item_hex() -> String {
    [
        "02", // version
        "01", // kind: item
        "01", // flags: push
        "30", // group_id<V>: 48 bytes
        &group48(),
        "0000000000000003", // epoch
        &rep("01", 32),     // sender
        "0000000000000009", // seq
        &rep("dd", 32),     // prev
        &rep("04", 32),     // recipient
        TIME,
        "01",           // timeline_kind: chat
        "02",           // timeline_scope: session
        &rep("22", 16), // timeline_ref
        "10",           // file_ids<V>: one id
        &rep("f1", 16),
    ]
    .concat()
}

fn header_item() -> Header {
    Header {
        kind: KIND_ITEM,
        flags: FLAG_PUSH,
        group_id: hex(&[&group48()]),
        epoch: 3,
        sender: [1; 32],
        seq: 9,
        prev: [0xdd; 32],
        recipient: [4; 32],
        time: 1_700_000_000_000,
        subject: Subject::Item {
            timeline_kind: TIMELINE_CHAT,
            timeline_scope: SCOPE_SESSION,
            timeline_ref: [0x22; 16],
        },
        file_ids: vec![[0xf1; 16]],
    }
}

#[test]
fn group_statements_and_the_commit_note() {
    let session = hex(&[&rep("11", 32), &rep("22", 16), &rep("00", 16)]);
    let expected = TrommiSession {
        room_id: [0x11; 32],
        session_id: [0x22; 16],
        parent: [0; 16],
    };
    assert_eq!(TrommiSession::parse(&session).unwrap(), expected);
    assert_eq!(
        (expected.encode(), expected.bytes()),
        (session.clone(), session)
    );

    let room = hex(&[
        "20",
        &rep("aa", 32), // recovery_signature_key<V>
        "20",
        &rep("bb", 32), // recovery_hpke_key<V>
        "4040",         // agents<V>: 64 bytes, a two-byte length
        &rep("01", 32),
        &rep("02", 32),
    ]);
    let expected = TrommiRoom {
        recovery_signature_key: vec![0xaa; 32],
        recovery_hpke_key: vec![0xbb; 32],
        agents: vec![[1; 32], [2; 32]],
    };
    assert_eq!(TrommiRoom::parse(&room).unwrap(), expected);
    assert_eq!((expected.encode(), expected.bytes()), (room.clone(), room));

    let note = hex(&[
        "02",               // version
        "0000000000000005", // room_epoch
        &rep("cc", 32),     // room_state
        TIME,
        "4048",             // cuts<V>: one Cut of 72 bytes
        &rep("01", 32),     //   device
        "0000000000000003", //   seq
        &rep("dd", 32),     //   hash
        "00",               // join
    ]);
    let expected = CommitNote {
        room_epoch: 5,
        room_state: [0xcc; 32],
        time: 1_700_000_000_000,
        cuts: vec![Cut {
            device: [1; 32],
            seq: 3,
            hash: [0xdd; 32],
        }],
        join: false,
    };
    assert_eq!(CommitNote::parse(&note).unwrap(), expected);
    assert_eq!((expected.encode(), expected.bytes()), (note.clone(), note));
}

#[test]
fn the_structs_of_recovery() {
    let sealed = hex(&[
        "30",
        &group48(),         // KeyContext.group_id<V>
        "0000000000000007", // KeyContext.epoch
        &rep("ee", 32),     // KeyContext.group_info
        "0000000000000005", // room_epoch
        "20",
        &rep("bb", 32), // recovery_hpke_key<V>
        "20",
        &rep("c1", 32), // HPKECiphertext.kem_output<V>
        "30",
        &rep("c2", 48), // HPKECiphertext.ciphertext<V>: a 32-byte key and the AEAD's tag
        &rep("01", 32), // writer
        "20",
        &rep("c3", 32), // mac<V>
    ]);
    let expected = SealedKey {
        context: KeyContext {
            group_id: hex(&[&group48()]),
            epoch: 7,
            group_info: [0xee; 32],
        },
        room_epoch: 5,
        recovery_hpke_key: vec![0xbb; 32],
        kem_output: vec![0xc1; 32],
        ciphertext: vec![0xc2; 48],
        writer: [1; 32],
        mac: vec![0xc3; 32],
    };
    assert_eq!(SealedKey::parse(&sealed).unwrap(), expected);
    assert_eq!(
        (expected.encode(), expected.bytes()),
        (sealed.clone(), sealed.clone())
    );
    // an opener leaves the tag empty: the last vector has length zero
    let mut untagged = sealed[..sealed.len() - 33].to_vec();
    untagged.push(0);
    assert_eq!(SealedKey::parse(&untagged).unwrap().mac, Vec::<u8>::new());

    let signed = [
        "20",
        &rep("11", 32),     // RecoveryJoin.base.group_id<V>: the room group
        "0000000000000004", // base.epoch
        &rep("ee", 32),     // base.group_info
        "0000000000000004", // room_epoch
        &rep("cc", 32),     // room_state
        &rep("03", 32),     // joiner
        &rep("c4", 32),     // commit
    ]
    .concat();
    let auth = hex(&[&signed, "4040", &rep("c5", 64)]); // signature<V>
    let expected = RecoveryAuth {
        base: KeyContext {
            group_id: vec![0x11; 32],
            epoch: 4,
            group_info: [0xee; 32],
        },
        room_epoch: 4,
        room_state: [0xcc; 32],
        joiner: [3; 32],
        commit: [0xc4; 32],
        signature: vec![0xc5; 64],
    };
    assert_eq!(RecoveryAuth::parse(&auth).unwrap(), expected);
    assert_eq!((expected.encode(), expected.bytes()), (auth.clone(), auth));
    // what the recovery key signs: join ‖ commit
    assert_eq!(
        (expected.signed(), enc::recovery_join_and_commit(&expected)),
        (hex(&[&signed]), hex(&[&signed]))
    );

    let link = hex(&[
        &rep("11", 32), // room_id
        "20",
        &rep("b2", 32), // new_recovery_hpke_key<V>
        "20",
        &rep("c1", 32), // kem_output<V>
        "4050",
        &rep("c6", 80), // ciphertext<V>: OldRecovery (64 bytes) and the tag
        "20",
        &rep("c3", 32), // mac<V>
    ]);
    let expected = RecoveryLink {
        room_id: [0x11; 32],
        new_recovery_hpke_key: vec![0xb2; 32],
        kem_output: vec![0xc1; 32],
        ciphertext: vec![0xc6; 80],
        mac: vec![0xc3; 32],
    };
    assert_eq!(RecoveryLink::parse(&link).unwrap(), expected);
    assert_eq!((expected.encode(), expected.bytes()), (link.clone(), link));
}

#[test]
fn headers_and_envelopes() {
    let item = hex(&[&header_item_hex()]);
    assert_eq!(item.len(), 207);
    assert_eq!(Header::parse(&item).unwrap(), header_item());
    assert_eq!(
        (header_item().encode(), header_item().bytes()),
        (item.clone(), item.clone())
    );

    let register = hex(&[
        "02",
        "06",
        "00", // version, kind: register, flags
        "20",
        &rep("11", 32),     // group_id<V>: the room group
        "0000000000000001", // epoch
        &rep("01", 32),     // sender
        "0000000000000001", // seq
        &rep("00", 32),     // prev: the first envelope
        &rep("00", 32),     // recipient: nobody
        TIME,
        &rep("a6", 16), // register_id
        "00",           // file_ids<V>: none
    ]);
    let expected = Header {
        kind: KIND_REGISTER,
        flags: 0,
        group_id: vec![0x11; 32],
        epoch: 1,
        sender: [1; 32],
        seq: 1,
        prev: ZERO32,
        recipient: ZERO32,
        time: 1_700_000_000_000,
        subject: Subject::Register {
            register_id: [0xa6; 16],
        },
        file_ids: vec![],
    };
    assert_eq!(Header::parse(&register).unwrap(), expected);
    assert_eq!(
        (expected.encode(), expected.bytes()),
        (register.clone(), register)
    );

    let answer = hex(&[
        "02",
        "03",
        "00", // version, kind: answer, flags
        "30",
        &group48(),
        "0000000000000003",
        &rep("05", 32),     // sender
        "0000000000000002", // seq
        &rep("dd", 32),     // prev
        &rep("01", 32),     // recipient: the card's owner
        TIME,
        &rep("a7", 16), // object_id
        "01",           // object_type: card
        "02",           // object_state: answered
        "03",           // urgency: critical
        TIME,           // answered_at
        &rep("a8", 32), // object_ref: the version answered
        "00",           // file_ids<V>
    ]);
    let expected = Header {
        kind: KIND_ANSWER,
        flags: 0,
        group_id: hex(&[&group48()]),
        epoch: 3,
        sender: [5; 32],
        seq: 2,
        prev: [0xdd; 32],
        recipient: [1; 32],
        time: 1_700_000_000_000,
        subject: Subject::Object {
            object_id: [0xa7; 16],
            object_type: TYPE_CARD,
            object_state: STATE_ANSWERED,
            urgency: 3,
            answered_at: 1_700_000_000_000,
            object_ref: [0xa8; 32],
        },
        file_ids: vec![],
    };
    assert_eq!(Header::parse(&answer).unwrap(), expected);
    assert_eq!(
        (expected.encode(), expected.bytes()),
        (answer.clone(), answer)
    );

    // an envelope, full and pruned; SHA-256 of 272 bytes 0xc9 and the envelope hash come from Python's hashlib
    let ciphertext_hash = "2ce07c135d2f87989c757f0be9b635c02fc1bcdb0762ba123d6959ac31d9966e";
    let envelope_hash = hex(&["53a9118a387dc58bcbd301aee66ae5b376beba2b99a92d6a56c5c41a0e96a2da"]);
    let full = hex(&[
        "01", // form: full
        &header_item_hex(),
        &rep("0c", 12), // nonce
        "4110",
        &rep("c9", 272), // ciphertext<V>: a padded body of 256 bytes and the tag
        "4040",
        &rep("c5", 64), // signature<V>
    ]);
    let pruned = hex(&[
        "02",
        &header_item_hex(),
        &rep("0c", 12),
        ciphertext_hash,
        "4040",
        &rep("c5", 64),
    ]);
    let (f, p) = (
        Envelope::parse(&full).unwrap(),
        Envelope::parse(&pruned).unwrap(),
    );
    assert_eq!(
        (
            f.header.clone(),
            f.header_bytes.clone(),
            f.nonce,
            f.signature.clone()
        ),
        (header_item(), item.clone(), [0x0c; 12], vec![0xc5; 64])
    );
    assert_eq!(
        (f.body.as_deref(), p.body.as_deref()),
        (Some(&[0xc9u8; 272][..]), None)
    );
    assert_eq!(f.body_hash.to_vec(), hex(&[ciphertext_hash]));
    assert_eq!(
        (f.hash().to_vec(), p.hash().to_vec()),
        (envelope_hash.clone(), envelope_hash.clone())
    );
    assert_eq!(
        enc::envelope_hash(&item, &[0x0c; 12], &hex(&[ciphertext_hash])).to_vec(),
        envelope_hash
    );
    // both encoders give these bytes back
    assert_eq!(
        encode_envelope(
            &item,
            &[0x0c; 12],
            Some(&[0xc9; 272]),
            &f.body_hash,
            &[0xc5; 64]
        ),
        full
    );
    assert_eq!(
        encode_envelope(&item, &[0x0c; 12], None, &f.body_hash, &[0xc5; 64]),
        pruned
    );
    assert_eq!(
        enc::envelope(&item, &[0x0c; 12], &[0xc9; 272], &[0xc5; 64]),
        full
    );
    assert_eq!(
        enc::pruned_envelope(&item, &[0x0c; 12], &f.body_hash, &[0xc5; 64]),
        pruned
    );
}

#[test]
fn sign_in_and_the_invite() {
    let hub = "http://127.0.0.1:8790"; // 21 characters
    let auth = hex(&[
        &rep("11", 32), // room_id
        "15",
        &ascii(hub),    // hub<V>
        &rep("01", 32), // device
        &rep("a9", 32), // challenge
    ]);
    let expected = HubAuth {
        room_id: [0x11; 32],
        hub: hub.as_bytes().to_vec(),
        device: [1; 32],
        challenge: [0xa9; 32],
    };
    assert_eq!(HubAuth::parse(&auth).unwrap(), expected);
    assert_eq!((expected.encode(), expected.bytes()), (auth.clone(), auth));

    let offer = hex(&[
        &rep("11", 32),     // room_id
        &rep("ab", 16),     // invite_id
        "01",               // role: human device
        &rep("00", 16),     // session_id
        TIME,               // expires_at
        &rep("ac", 32),     // commitment
        &rep("01", 32),     // inviter
        "0000000000000005", // room_epoch
        &rep("cc", 32),     // room_state
    ]);
    let expected = Offer {
        room_id: [0x11; 32],
        invite_id: [0xab; 16],
        role: 1,
        session_id: [0; 16],
        expires_at: 1_700_000_000_000,
        commitment: [0xac; 32],
        inviter: [1; 32],
        room_epoch: 5,
        room_state: [0xcc; 32],
    };
    assert_eq!(Offer::parse(&offer).unwrap(), expected);
    assert_eq!(
        (expected.encode(), expected.bytes()),
        (offer.clone(), offer)
    );

    let request = hex(&[
        &rep("11", 32), // room_id
        &rep("ab", 16), // invite_id
        "15",
        &ascii(hub), // hub<V>
        "01",        // role
        "03",
        "aabbcc",       // key_package<V>
        &rep("ad", 32), // offer_hash
    ]);
    let expected = InviteRequest {
        room_id: [0x11; 32],
        invite_id: [0xab; 16],
        hub: hub.as_bytes().to_vec(),
        role: 1,
        key_package: vec![0xaa, 0xbb, 0xcc],
        offer_hash: [0xad; 32],
    };
    assert_eq!(InviteRequest::parse(&request).unwrap(), expected);
    assert_eq!(
        (expected.encode(), expected.bytes()),
        (request.clone(), request)
    );

    let reveal = hex(&[&rep("ab", 16), &rep("ae", 32), &rep("af", 32)]);
    let expected = Reveal {
        invite_id: [0xab; 16],
        nonce: [0xae; 32],
        request_hash: [0xaf; 32],
    };
    assert_eq!(Reveal::parse(&reveal).unwrap(), expected);
    assert_eq!(
        (expected.encode(), expected.bytes()),
        (reveal.clone(), reveal)
    );
}

#[test]
fn the_labelled_hash_and_signature_input_of_rfc_9420() {
    // RefHash("Trommi Object", 01 02 03) = SHA-256(0d "Trommi Object" 03 010203), from Python's hashlib
    let expected = hex(&["2edf10acb249e629c227d5dfa758ec94482b06336185afc09f0c7b1fce49ba40"]);
    assert_eq!(ref_hash("Trommi Object", &[1, 2, 3]).to_vec(), expected);
    assert_eq!(
        enc::ref_hash("Trommi Object", &[1, 2, 3]).to_vec(),
        expected
    );
    // SignWithLabel signs: opaque label<V> = "MLS 1.0 " + label; opaque content<V>
    let signed = hex(&["15", &ascii("MLS 1.0 TrommiHubAuth"), "03", &ascii("abc")]);
    assert_eq!(sign_content("TrommiHubAuth", b"abc"), signed);
    assert_eq!(enc::sign_content("TrommiHubAuth", b"abc"), signed);
    // object_id: the first 16 bytes of RefHash("Trommi Object", group_id ‖ sender ‖ seq), from Python's hashlib
    let id = hex(&["47db512cfe722b7473fd09574b69bc4a"]);
    assert_eq!(object_id(&hex(&[&group48()]), &[1; 32], 9).to_vec(), id);
    assert_eq!(
        enc::object_id(&hex(&[&group48()]), &[1; 32], 9).to_vec(),
        id
    );
}
