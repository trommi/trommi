//! Files and Share links (section 11): chunked sealing and opening, whole and as a stream, the checks of the
//! stored hash, and the link that gives one file to someone outside.

use trommi_core::crypto::{self, Entropy, Secret, SystemEntropy, TAG_LEN};
use trommi_core::files::*;
use trommi_core::ids::{FileId, Hash32, ShareId};
use trommi_core::Error;

const FILE: FileId = FileId::new([0xF1; 16]);

/// The nonce of chunk `index`, as the format gives it: three zeros, the number, the final mark.
fn nonce(index: u64, last: bool) -> [u8; 12] {
    let mut nonce = [0u8; 12];
    nonce[3..11].copy_from_slice(&index.to_be_bytes());
    nonce[11] = u8::from(last);
    nonce
}

/// A chunk sealed by hand, of whatever shape.
fn seal_chunk(
    key: &Secret<32>,
    file_id: &FileId,
    index: u64,
    last: bool,
    plaintext: &[u8],
) -> Result<Vec<u8>, Error> {
    let head = FileHead { file_id: *file_id }.encode();
    crypto::aead_seal(key, &nonce(index, last), &head, plaintext)
}

fn key(byte: u8) -> Secret<32> {
    Secret::new([byte; 32])
}

/// `len` bytes that differ from chunk to chunk.
fn content(len: usize) -> Vec<u8> {
    (0..len)
        .map(|i| (i % 251) as u8 ^ (i >> 16) as u8)
        .collect()
}

/// The source of a test file: its key is `key(1)`, its id `FILE`.
struct OfTheTestFile;
impl Entropy for OfTheTestFile {
    fn fill(&mut self, out: &mut [u8]) -> Result<(), Error> {
        out.fill(if out.len() == 32 { 1 } else { 0xF1 });
        Ok(())
    }
}

fn sealed_file(len: usize) -> (Vec<u8>, Sealed, Vec<u8>) {
    let plain = content(len);
    let (stored, sealed) = encrypt_file(&plain, &mut OfTheTestFile).expect("encrypts");
    assert_eq!(sealed.file.file_id, FILE);
    assert_eq!(sealed.file.file_key, key(1));
    (stored, sealed, plain)
}

fn reference(key: &Secret<32>, file_id: FileId, sha256: &Hash32) -> FileRef {
    FileRef {
        file_id,
        file_key: key.duplicate(),
        sha256: *sha256,
    }
}

/// The reference of the test file for these stored bytes, whatever they are.
fn naming(stored: &[u8]) -> FileRef {
    reference(&key(1), FILE, &crypto::sha256(stored).expect("hashes"))
}

fn decrypt_with(
    key: &Secret<32>,
    file_id: FileId,
    sha256: &Hash32,
    stored: &[u8],
) -> Result<Vec<u8>, Error> {
    decrypt_file(&reference(key, file_id, sha256), stored)
}

struct NoEntropy;
impl Entropy for NoEntropy {
    fn fill(&mut self, _: &mut [u8]) -> Result<(), Error> {
        Err(Error::Entropy)
    }
}

const SIZES: [usize; 9] = [
    0,
    1,
    1000,
    CHUNK_SIZE - 1,
    CHUNK_SIZE,
    CHUNK_SIZE + 1,
    2 * CHUNK_SIZE,
    2 * CHUNK_SIZE + 7,
    3 * CHUNK_SIZE,
];

#[test]
fn the_head_is_version_file_id_and_chunk_size() {
    let head = FileHead { file_id: FILE }.encode();
    let mut expected = vec![2u8];
    expected.extend_from_slice(&[0xF1; 16]);
    expected.extend_from_slice(&[0, 1, 0, 0]);
    assert_eq!(head.as_slice(), expected);
    assert_eq!(FileHead::decode(&head), Ok(FileHead { file_id: FILE }));
}

#[test]
fn a_head_of_another_version_chunk_size_or_length_is_refused() {
    let head = FileHead { file_id: FILE }.encode();
    let with = |at: usize, byte: u8| {
        let mut changed = head;
        changed[at] = byte;
        changed
    };
    assert_eq!(FileHead::decode(&with(0, 3)), Err(Error::NewerVersion));
    assert_eq!(FileHead::decode(&with(0, 255)), Err(Error::NewerVersion));
    assert_eq!(FileHead::decode(&with(0, 1)), Err(Error::BadFormat));
    assert_eq!(FileHead::decode(&with(0, 0)), Err(Error::BadFormat));
    assert_eq!(FileHead::decode(&with(18, 2)), Err(Error::BadFormat));
    assert_eq!(FileHead::decode(&with(20, 1)), Err(Error::BadFormat));
    for len in 0..HEAD_LEN {
        assert_eq!(FileHead::decode(&head[..len]), Err(Error::BadFormat));
    }
    let mut long = head.to_vec();
    long.push(0);
    assert_eq!(FileHead::decode(&long), Err(Error::BadFormat));
}

#[test]
fn a_file_is_its_head_and_its_chunks_under_the_suites_aead() {
    let (stored, sealed, plain) = sealed_file(CHUNK_SIZE + 5);
    let head = FileHead { file_id: FILE }.encode();
    let (first, second) = plain.split_at(CHUNK_SIZE);
    let expected = [
        head.to_vec(),
        crypto::aead_seal(&key(1), &nonce(0, false), &head, first).expect("seals"),
        crypto::aead_seal(&key(1), &nonce(1, true), &head, second).expect("seals"),
    ]
    .concat();
    assert_eq!(stored, expected);
    assert_eq!(sealed.file.sha256, crypto::sha256(&stored).expect("hashes"));
    assert_eq!(sealed.plain_len, plain.len() as u64);
    assert_eq!(sealed.stored_len, stored.len() as u64);
}

#[test]
fn an_empty_file_is_one_empty_chunk() {
    let (stored, sealed, _) = sealed_file(0);
    assert_eq!(stored.len(), HEAD_LEN + TAG_LEN);
    assert_eq!(sealed.plain_len, 0);
    let head = FileHead { file_id: FILE }.encode();
    assert_eq!(
        stored[HEAD_LEN..],
        crypto::aead_seal(&key(1), &nonce(0, true), &head, &[]).expect("seals")
    );
    assert_eq!(
        decrypt_with(&key(1), FILE, &sealed.file.sha256, &stored),
        Ok(vec![])
    );
}

#[test]
fn files_of_every_shape_round_trip() {
    for len in SIZES {
        let (stored, sealed, plain) = sealed_file(len);
        let layout = Layout::of_plain(len as u64).expect("layout");
        assert_eq!(stored.len() as u64, layout.stored_len(), "{len}");
        assert_eq!(Layout::of_stored(stored.len() as u64), Ok(layout), "{len}");
        assert_eq!(
            decrypt_with(&key(1), FILE, &sealed.file.sha256, &stored),
            Ok(plain),
            "{len}"
        );
    }
}

#[test]
fn streaming_gives_the_same_bytes_whatever_the_pieces() {
    for len in SIZES {
        let (stored, sealed, plain) = sealed_file(len);
        for piece in [1usize, 7, 4096, CHUNK_SIZE, CHUNK_SIZE + 1, 3 * CHUNK_SIZE] {
            // One byte at a time is slow: only for the files that fit a chunk or just pass it.
            if piece == 1 && len > CHUNK_SIZE + 1 {
                continue;
            }
            let mut encryptor = Encryptor::new(&mut OfTheTestFile).expect("entropy");
            let mut out = Vec::new();
            for part in plain.chunks(piece) {
                out.extend(encryptor.update(part).expect("takes"));
            }
            let (rest, streamed) = encryptor.finish().expect("finishes");
            out.extend(rest);
            assert_eq!(out, stored, "{len} by {piece}");
            assert_eq!(streamed, sealed, "{len} by {piece}");

            let mut decryptor = Decryptor::new(&sealed.file);
            let mut hasher = FileHasher::new();
            let mut back = Vec::new();
            for part in stored.chunks(piece) {
                hasher.update(part);
                back.extend(decryptor.update(part).expect("opens"));
            }
            back.extend(decryptor.finish().expect("finishes"));
            assert_eq!(back, plain, "{len} by {piece}");
            assert_eq!(hasher.verify(&sealed.file.sha256), Ok(()));
        }
    }
}

#[test]
fn an_encryptor_holds_back_a_full_chunk_until_it_knows_what_follows() {
    let mut encryptor = Encryptor::new(&mut OfTheTestFile).expect("entropy");
    let first = encryptor.update(&content(CHUNK_SIZE)).expect("takes");
    assert_eq!(first.len(), HEAD_LEN);
    let (rest, sealed) = encryptor.finish().expect("finishes");
    assert_eq!(rest.len(), SEALED_CHUNK_LEN);
    assert_eq!(sealed.plain_len, CHUNK_SIZE as u64);

    // Exactly one chunk is one chunk with the final mark, not a full chunk and an empty one.
    let stored = [first, rest].concat();
    assert_eq!(stored.len(), HEAD_LEN + SEALED_CHUNK_LEN);
    assert!(open_chunk(&key(1), &FILE, 0, true, &stored[HEAD_LEN..]).is_ok());
}

#[test]
fn single_chunks_open_at_their_place() {
    let (stored, _, plain) = sealed_file(2 * CHUNK_SIZE + 7);
    let layout = Layout::of_stored(stored.len() as u64).expect("layout");
    assert_eq!(layout.chunks(), 3);
    assert_eq!(layout.plain_len(), plain.len() as u64);
    for index in 0..layout.chunks() {
        let (offset, len) = layout.stored_range(index).expect("a chunk");
        let sealed = &stored[offset as usize..(offset + len) as usize];
        let opened =
            open_chunk(&key(1), &FILE, index, layout.is_last(index), sealed).expect("opens");
        let from = index as usize * CHUNK_SIZE;
        assert_eq!(opened, plain[from..(from + CHUNK_SIZE).min(plain.len())]);
    }
    assert_eq!(layout.stored_range(3), None);
    assert_eq!(layout.chunk_of(0), Some(0));
    assert_eq!(layout.chunk_of(CHUNK_SIZE as u64 - 1), Some(0));
    assert_eq!(layout.chunk_of(CHUNK_SIZE as u64), Some(1));
    assert_eq!(layout.chunk_of(plain.len() as u64 - 1), Some(2));
    assert_eq!(layout.chunk_of(plain.len() as u64), None);
}

#[test]
fn a_chunk_does_not_open_at_another_place_mark_file_or_key() {
    let (stored, _, _) = sealed_file(2 * CHUNK_SIZE + 7);
    let layout = Layout::of_stored(stored.len() as u64).expect("layout");
    let chunk = |index: u64| {
        let (offset, len) = layout.stored_range(index).expect("a chunk");
        &stored[offset as usize..(offset + len) as usize]
    };
    // Another place.
    assert_eq!(
        open_chunk(&key(1), &FILE, 1, false, chunk(0)),
        Err(Error::DecryptFailed)
    );
    // The final mark on a chunk that is not final, and none on the final one.
    assert_eq!(
        open_chunk(&key(1), &FILE, 0, true, chunk(0)),
        Err(Error::DecryptFailed)
    );
    let last_as_inner = open_chunk(&key(1), &FILE, 2, false, chunk(2));
    assert_eq!(last_as_inner, Err(Error::BadFormat));
    // Another file, another key.
    let other = FileId::new([0xF2; 16]);
    assert_eq!(
        open_chunk(&key(1), &other, 0, false, chunk(0)),
        Err(Error::DecryptFailed)
    );
    assert_eq!(
        open_chunk(&key(2), &FILE, 0, false, chunk(0)),
        Err(Error::DecryptFailed)
    );
    // A changed bit.
    let mut changed = chunk(2).to_vec();
    changed[0] ^= 1;
    assert_eq!(
        open_chunk(&key(1), &FILE, 2, true, &changed),
        Err(Error::DecryptFailed)
    );
}

#[test]
fn a_full_final_chunk_does_not_open_as_an_inner_one() {
    let (stored, _, _) = sealed_file(2 * CHUNK_SIZE);
    let last = &stored[HEAD_LEN + SEALED_CHUNK_LEN..];
    assert_eq!(last.len(), SEALED_CHUNK_LEN);
    assert!(open_chunk(&key(1), &FILE, 1, true, last).is_ok());
    assert_eq!(
        open_chunk(&key(1), &FILE, 1, false, last),
        Err(Error::DecryptFailed)
    );
}

#[test]
fn chunks_of_a_shape_no_file_has_do_not_open() {
    let full = vec![0u8; CHUNK_SIZE];
    for len in 0..TAG_LEN {
        assert_eq!(
            open_chunk(&key(1), &FILE, 0, true, &full[..len]),
            Err(Error::BadFormat)
        );
    }
    assert_eq!(
        open_chunk(&key(1), &FILE, 1, true, &full[..TAG_LEN]),
        Err(Error::BadFormat)
    );
    assert_eq!(
        open_chunk(&key(1), &FILE, 0, true, &vec![0; SEALED_CHUNK_LEN + 1]),
        Err(Error::BadFormat)
    );
    assert_eq!(
        open_chunk(&key(1), &FILE, u64::MAX, true, &full[..TAG_LEN + 1]),
        Err(Error::TooLarge)
    );
}

#[test]
fn a_file_cut_at_a_chunk_boundary_fails() {
    let (stored, _, _) = sealed_file(2 * CHUNK_SIZE + 7);
    for chunks in [1usize, 2] {
        let cut = &stored[..HEAD_LEN + chunks * SEALED_CHUNK_LEN];
        let hash = crypto::sha256(cut).expect("hashes");
        assert_eq!(
            decrypt_with(&key(1), FILE, &hash, cut),
            Err(Error::DecryptFailed),
            "{chunks}"
        );
    }
    // Cut to the head alone: there is no chunk at all.
    let head = &stored[..HEAD_LEN];
    let hash = crypto::sha256(head).expect("hashes");
    assert_eq!(
        decrypt_with(&key(1), FILE, &hash, head),
        Err(Error::BadFormat)
    );
}

#[test]
fn a_file_cut_anywhere_fails() {
    let (stored, _, _) = sealed_file(CHUNK_SIZE + 40);
    for len in [
        0,
        1,
        HEAD_LEN - 1,
        HEAD_LEN + 1,
        HEAD_LEN + TAG_LEN - 1,
        HEAD_LEN + TAG_LEN,
        HEAD_LEN + 1000,
        HEAD_LEN + SEALED_CHUNK_LEN - 1,
        HEAD_LEN + SEALED_CHUNK_LEN + 1,
        HEAD_LEN + SEALED_CHUNK_LEN + TAG_LEN,
        stored.len() - 1,
    ] {
        let cut = &stored[..len];
        let hash = crypto::sha256(cut).expect("hashes");
        let result = decrypt_with(&key(1), FILE, &hash, cut);
        assert!(
            matches!(result, Err(Error::DecryptFailed | Error::BadFormat)),
            "{len}: {result:?}"
        );
    }
}

#[test]
fn trailing_bytes_fail() {
    for len in [0, 5, CHUNK_SIZE, CHUNK_SIZE + 5] {
        let (stored, _, _) = sealed_file(len);
        for extra in [1usize, TAG_LEN, TAG_LEN + 1, SEALED_CHUNK_LEN] {
            let mut longer = stored.clone();
            longer.extend(vec![0u8; extra]);
            let hash = crypto::sha256(&longer).expect("hashes");
            let result = decrypt_with(&key(1), FILE, &hash, &longer);
            assert!(
                matches!(result, Err(Error::DecryptFailed | Error::BadFormat)),
                "{len}+{extra}: {result:?}"
            );
        }
    }
}

#[test]
fn an_empty_chunk_behind_others_is_refused() {
    // A writer that sealed a full final chunk without the mark and an empty final chunk behind it.
    let plain = content(CHUNK_SIZE);
    let head = FileHead { file_id: FILE }.encode();
    let stored = [
        head.to_vec(),
        crypto::aead_seal(&key(1), &nonce(0, false), &head, &plain).expect("seals"),
        crypto::aead_seal(&key(1), &nonce(1, true), &head, &[]).expect("seals"),
    ]
    .concat();
    let hash = crypto::sha256(&stored).expect("hashes");
    assert_eq!(
        decrypt_with(&key(1), FILE, &hash, &stored),
        Err(Error::BadFormat)
    );
    assert_eq!(
        Layout::of_stored(stored.len() as u64),
        Err(Error::BadFormat)
    );
    let mut decryptor = Decryptor::new(&naming(&stored));
    assert_eq!(decryptor.update(&stored), Ok(plain));
    assert_eq!(decryptor.finish(), Err(Error::BadFormat));
}

#[test]
fn reordered_chunks_fail() {
    let (stored, _, _) = sealed_file(3 * CHUNK_SIZE);
    let (head, body) = stored.split_at(HEAD_LEN);
    let chunks: Vec<&[u8]> = body.chunks(SEALED_CHUNK_LEN).collect();
    for order in [[1, 0, 2], [0, 2, 1], [2, 1, 0], [0, 0, 2], [0, 1, 1]] {
        let swapped = [head, chunks[order[0]], chunks[order[1]], chunks[order[2]]].concat();
        let hash = crypto::sha256(&swapped).expect("hashes");
        assert_eq!(
            decrypt_with(&key(1), FILE, &hash, &swapped),
            Err(Error::DecryptFailed),
            "{order:?}"
        );
    }
}

#[test]
fn a_swapped_final_mark_fails() {
    // Two files of one key and id, which no honest writer makes: the final chunk of the short one stands at
    // place 0 with the mark, and does not open where the long one's first chunk belongs.
    let plain = content(CHUNK_SIZE + 9);
    let head = FileHead { file_id: FILE }.encode();
    let (first, second) = plain.split_at(CHUNK_SIZE);
    let marked_early = [
        head.to_vec(),
        crypto::aead_seal(&key(1), &nonce(0, true), &head, first).expect("seals"),
        crypto::aead_seal(&key(1), &nonce(1, true), &head, second).expect("seals"),
    ]
    .concat();
    let hash = crypto::sha256(&marked_early).expect("hashes");
    assert_eq!(
        decrypt_with(&key(1), FILE, &hash, &marked_early),
        Err(Error::DecryptFailed)
    );
    let never_marked = [
        head.to_vec(),
        crypto::aead_seal(&key(1), &nonce(0, false), &head, first).expect("seals"),
        crypto::aead_seal(&key(1), &nonce(1, false), &head, second).expect("seals"),
    ]
    .concat();
    let hash = crypto::sha256(&never_marked).expect("hashes");
    assert_eq!(
        decrypt_with(&key(1), FILE, &hash, &never_marked),
        Err(Error::DecryptFailed)
    );
}

#[test]
fn a_wrong_key_fails() {
    for len in [0, 5, CHUNK_SIZE + 5] {
        let (stored, sealed, _) = sealed_file(len);
        assert_eq!(
            decrypt_with(&key(2), FILE, &sealed.file.sha256, &stored),
            Err(Error::DecryptFailed)
        );
    }
}

#[test]
fn a_wrong_hash_fails_before_anything_is_decrypted() {
    let (stored, sealed, _) = sealed_file(5);
    let mut other = *sealed.file.sha256.as_bytes();
    other[31] ^= 1;
    assert_eq!(
        decrypt_with(&key(1), FILE, &Hash32::new(other), &stored),
        Err(Error::DecryptFailed)
    );
    // The hash is compared first: bytes that are no file at all fail on it, not on their form.
    assert_eq!(
        decrypt_with(&key(1), FILE, &sealed.file.sha256, b"not a file"),
        Err(Error::DecryptFailed)
    );
    let mut changed = stored.clone();
    changed[HEAD_LEN] ^= 1;
    assert_eq!(
        decrypt_with(&key(1), FILE, &sealed.file.sha256, &changed),
        Err(Error::DecryptFailed)
    );
    let mut hasher = FileHasher::new();
    hasher.update(&changed);
    assert_eq!(
        hasher.verify(&sealed.file.sha256),
        Err(Error::DecryptFailed)
    );
}

#[test]
fn a_wrong_head_fails() {
    let (stored, _, _) = sealed_file(5);
    let with = |at: usize, byte: u8| {
        let mut changed = stored.clone();
        changed[at] = byte;
        let hash = crypto::sha256(&changed).expect("hashes");
        decrypt_with(&key(1), FILE, &hash, &changed)
    };
    assert_eq!(with(0, 3), Err(Error::NewerVersion));
    assert_eq!(with(0, 1), Err(Error::BadFormat));
    assert_eq!(with(19, 1), Err(Error::BadFormat));
    // The head of another file: the reference names this one.
    assert_eq!(with(1, 0xF2), Err(Error::DecryptFailed));
    let hash = crypto::sha256(&stored).expect("hashes");
    assert_eq!(
        decrypt_with(&key(1), FileId::new([0xF2; 16]), &hash, &stored),
        Err(Error::DecryptFailed)
    );
}

#[test]
fn a_decryptor_that_failed_stays_failed() {
    let (mut stored, _, plain) = sealed_file(2 * CHUNK_SIZE);
    stored[HEAD_LEN + SEALED_CHUNK_LEN - 1] ^= 1;
    let mut decryptor = Decryptor::new(&naming(&stored));
    assert_eq!(decryptor.update(&stored), Err(Error::DecryptFailed));
    assert_eq!(decryptor.update(&[]), Err(Error::DecryptFailed));
    assert_eq!(decryptor.finish(), Err(Error::DecryptFailed));

    // Nothing of a file is handed out unless its chunk opened.
    stored[HEAD_LEN + SEALED_CHUNK_LEN - 1] ^= 1;
    let end = stored.len() - 1;
    stored[end] ^= 1;
    let mut decryptor = Decryptor::new(&naming(&stored));
    assert_eq!(
        decryptor.update(&stored).expect("first chunk"),
        plain[..CHUNK_SIZE]
    );
    assert_eq!(decryptor.finish(), Err(Error::DecryptFailed));
}

#[test]
fn a_decryptor_without_a_whole_head_or_chunk_fails() {
    assert_eq!(Decryptor::new(&naming(&[])).finish(), Err(Error::BadFormat));
    let head = FileHead { file_id: FILE }.encode();
    let mut decryptor = Decryptor::new(&naming(&head[..HEAD_LEN - 1]));
    assert_eq!(decryptor.update(&head[..HEAD_LEN - 1]), Ok(vec![]));
    assert_eq!(decryptor.finish(), Err(Error::BadFormat));
    let mut decryptor = Decryptor::new(&naming(&head));
    assert_eq!(decryptor.update(&head), Ok(vec![]));
    assert_eq!(decryptor.update(&[0; TAG_LEN - 1]), Ok(vec![]));
    assert_eq!(decryptor.finish(), Err(Error::BadFormat));
}

#[test]
fn layouts_cover_exactly_the_lengths_files_have() {
    assert_eq!(Layout::of_plain(0).expect("layout").chunks(), 1);
    assert_eq!(Layout::of_plain(1).expect("layout").chunks(), 1);
    assert_eq!(
        Layout::of_plain(CHUNK_SIZE as u64)
            .expect("layout")
            .chunks(),
        1
    );
    assert_eq!(
        Layout::of_plain(CHUNK_SIZE as u64 + 1)
            .expect("layout")
            .chunks(),
        2
    );
    let largest = Layout::of_plain(MAX_FILE_LEN).expect("layout");
    assert_eq!(largest.chunks(), MAX_CHUNKS);
    assert_eq!(largest.stored_len(), MAX_STORED_LEN);
    assert_eq!(MAX_STORED_LEN, 67_125_269);
    assert_eq!(Layout::of_stored(MAX_STORED_LEN), Ok(largest));
    assert_eq!(Layout::of_plain(MAX_FILE_LEN + 1), Err(Error::TooLarge));
    assert_eq!(Layout::of_stored(MAX_STORED_LEN + 1), Err(Error::TooLarge));
    assert_eq!(Layout::of_stored(u64::MAX), Err(Error::TooLarge));
    assert_eq!(Layout::of_plain(u64::MAX), Err(Error::TooLarge));

    for len in 0..HEAD_LEN + TAG_LEN {
        assert_eq!(Layout::of_stored(len as u64), Err(Error::BadFormat));
    }
    // Behind a full chunk, fewer bytes than a tag and one plaintext byte are no chunk.
    let one_full = (HEAD_LEN + SEALED_CHUNK_LEN) as u64;
    assert!(Layout::of_stored(one_full).is_ok());
    for extra in 1..=TAG_LEN as u64 {
        assert_eq!(Layout::of_stored(one_full + extra), Err(Error::BadFormat));
    }
    assert_eq!(
        Layout::of_stored(one_full + TAG_LEN as u64 + 1)
            .expect("layout")
            .plain_len(),
        CHUNK_SIZE as u64 + 1
    );

    // Every plain length has one stored length, and that stored length gives it back.
    for plain in (0..4 * CHUNK_SIZE as u64).step_by(4099) {
        let layout = Layout::of_plain(plain).expect("layout");
        assert_eq!(Layout::of_stored(layout.stored_len()), Ok(layout));
    }
}

#[test]
fn the_largest_file_is_64_mib() {
    let mut encryptor = Encryptor::new(&mut OfTheTestFile).expect("entropy");
    let piece = vec![0u8; 1 << 20];
    let mut stored_len = 0u64;
    for _ in 0..64 {
        stored_len += encryptor.update(&piece).expect("takes").len() as u64;
    }
    assert_eq!(encryptor.update(&[0]), Err(Error::TooLarge));
    // The refused byte was not taken: the file still ends as the largest one.
    let (rest, sealed) = encryptor.finish().expect("finishes");
    stored_len += rest.len() as u64;
    assert_eq!(sealed.plain_len, MAX_FILE_LEN);
    assert_eq!(sealed.stored_len, MAX_STORED_LEN);
    assert_eq!(stored_len, MAX_STORED_LEN);

    let too_long = vec![0u8; MAX_STORED_LEN as usize + 1];
    assert_eq!(
        decrypt_with(&key(1), FILE, &sealed.file.sha256, &too_long),
        Err(Error::TooLarge)
    );
}

#[test]
fn every_file_gets_a_key_and_an_id_of_its_own() {
    let (_, a) = encrypt_file(b"the same bytes", &mut SystemEntropy).expect("encrypts");
    let (_, b) = encrypt_file(b"the same bytes", &mut SystemEntropy).expect("encrypts");
    assert_ne!(a.file.file_key, b.file.file_key);
    assert_ne!(a.file.file_id, b.file.file_id);
    assert_ne!(a.file.sha256, b.file.sha256);
    let encryptor = Encryptor::new(&mut SystemEntropy).expect("entropy");
    let file_id = encryptor.file_id();
    assert_eq!(
        encryptor.finish().expect("finishes").1.file.file_id,
        file_id
    );
    assert_eq!(Encryptor::new(&mut NoEntropy).err(), Some(Error::Entropy));
    assert_eq!(
        encrypt_file(b"x", &mut NoEntropy).err(),
        Some(Error::Entropy)
    );
}

#[test]
fn a_streamed_download_that_is_not_the_named_file_fails_at_its_end() {
    // Whoever holds the file key can seal another file under the same id; the reference's hash tells.
    let (stored, sealed, _) = sealed_file(CHUNK_SIZE + 9);
    let head = FileHead { file_id: FILE }.encode();
    let other = content(CHUNK_SIZE + 9)
        .iter()
        .map(|byte| byte ^ 0x5a)
        .collect::<Vec<u8>>();
    let (first, second) = other.split_at(CHUNK_SIZE);
    let replaced = [
        head.to_vec(),
        seal_chunk(&key(1), &FILE, 0, false, first).expect("seals"),
        seal_chunk(&key(1), &FILE, 1, true, second).expect("seals"),
    ]
    .concat();
    assert_eq!(replaced.len(), stored.len());
    let mut decryptor = Decryptor::new(&sealed.file);
    assert_eq!(decryptor.update(&replaced), Ok(first.to_vec()));
    assert_eq!(decryptor.finish(), Err(Error::DecryptFailed));
    assert_eq!(
        decrypt_file(&sealed.file, &replaced),
        Err(Error::DecryptFailed)
    );
    // The same bytes under a reference that names them do open.
    assert_eq!(decrypt_file(&naming(&replaced), &replaced), Ok(other));
}

fn file_ref() -> FileRef {
    FileRef {
        file_id: FILE,
        file_key: key(0x11),
        sha256: Hash32::new([0x22; 32]),
    }
}

const KEY_TEXT: &str = "ERERERERERERERERERERERERERERERERERERERERERE";
const HASH_TEXT: &str = "IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI";

#[test]
fn an_attachment_reference_reads_its_three_fields_strictly() {
    let file_id = FILE.to_base64url();
    assert_eq!(
        FileRef::from_base64url(&file_id, KEY_TEXT, HASH_TEXT),
        Ok(file_ref())
    );
    assert_eq!(
        file_ref().file_key_base64url().expose(),
        KEY_TEXT.as_bytes()
    );
    for (id, key, hash) in [
        ("", KEY_TEXT, HASH_TEXT),
        (&file_id[1..], KEY_TEXT, HASH_TEXT),
        (file_id.as_str(), &KEY_TEXT[1..], HASH_TEXT),
        (file_id.as_str(), KEY_TEXT, &HASH_TEXT[1..]),
        (
            file_id.as_str(),
            HASH_TEXT,
            "IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiJ",
        ),
        (
            file_id.as_str(),
            "ERERERERERERERERERERERERERERERERERERERERERE=",
            HASH_TEXT,
        ),
        (
            file_id.as_str(),
            "ERERERERERERERERERERERERERERERERERERERERER+",
            HASH_TEXT,
        ),
    ] {
        assert_eq!(
            FileRef::from_base64url(id, key, hash).err(),
            Some(Error::BadFormat)
        );
    }
    assert!(!format!("{:?}", file_ref()).contains("11"));
}

#[test]
fn a_share_link_is_built_and_read() {
    let link = ShareLink::create("https://app.example.org", &file_ref(), &mut SystemEntropy)
        .expect("creates");
    let text = String::from_utf8(link.to_text().expose().to_vec()).expect("utf-8");
    assert_eq!(
        text,
        format!(
            "https://app.example.org/a/{}#{}.{KEY_TEXT}.{HASH_TEXT}",
            link.share_id.to_base64url(),
            String::from_utf8(link.secret_base64url().expose().to_vec()).expect("utf-8"),
        )
    );
    let read = ShareLink::parse(&text).expect("parses");
    assert_eq!(read, link);
    assert_eq!(read.app(), "https://app.example.org");
    assert_eq!(read.file(FILE), file_ref());

    let other = ShareLink::create("https://app.example.org", &file_ref(), &mut SystemEntropy)
        .expect("creates");
    assert_ne!(other.share_id, link.share_id);
    assert_ne!(other.secret.expose(), link.secret.expose());
}

#[test]
fn a_share_link_needs_a_canonical_app_and_entropy() {
    for app in [
        "app.example.org",
        "https://app.example.org/",
        "https://App.example.org",
        "",
    ] {
        assert_eq!(
            ShareLink::create(app, &file_ref(), &mut SystemEntropy).err(),
            Some(Error::BadFormat)
        );
    }
    assert_eq!(
        ShareLink::create("https://app.example.org", &file_ref(), &mut NoEntropy).err(),
        Some(Error::Entropy)
    );
    assert!(ShareLink::create("http://localhost:5173", &file_ref(), &mut SystemEntropy).is_ok());
}

#[test]
fn a_share_link_of_any_other_form_is_refused() {
    let id = "8fHx8fHx8fHx8fHx8fHx8Q";
    let secret = "MzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzM";
    let good = format!("https://app.example.org/a/{id}#{secret}.{KEY_TEXT}.{HASH_TEXT}");
    let link = ShareLink::parse(&good).expect("parses");
    assert_eq!(link.share_id, ShareId::new([0xF1; 16]));
    assert_eq!(link.secret.expose(), &[0x33; 32]);

    let cases = [
        String::new(),
        "https://app.example.org".into(),
        format!("https://app.example.org/a/{id}"),
        format!("https://app.example.org/a/{id}#"),
        format!("https://app.example.org/a/{id}#{secret}.{KEY_TEXT}"),
        format!("https://app.example.org/a/{id}#{secret}.{KEY_TEXT}.{HASH_TEXT}."),
        format!("https://app.example.org/a/{id}#{secret}.{KEY_TEXT}.{HASH_TEXT}.{HASH_TEXT}"),
        format!("https://app.example.org/a/{id}#.{secret}.{KEY_TEXT}.{HASH_TEXT}"),
        format!("https://app.example.org/a/{id}#{secret}..{HASH_TEXT}"),
        format!("https://app.example.org/a/{id}#{secret}.{KEY_TEXT}.{HASH_TEXT}#x"),
        format!("https://app.example.org/a/{id}#{secret}.{KEY_TEXT}.{HASH_TEXT} "),
        format!(" https://app.example.org/a/{id}#{secret}.{KEY_TEXT}.{HASH_TEXT}"),
        format!("https://app.example.org/a/{id}?x=1#{secret}.{KEY_TEXT}.{HASH_TEXT}"),
        format!("https://app.example.org/a/{id}/#{secret}.{KEY_TEXT}.{HASH_TEXT}"),
        format!("https://app.example.org/b/{id}#{secret}.{KEY_TEXT}.{HASH_TEXT}"),
        format!("https://app.example.org/x/a/{id}#{secret}.{KEY_TEXT}.{HASH_TEXT}"),
        format!("https://app.example.org//a/{id}#{secret}.{KEY_TEXT}.{HASH_TEXT}"),
        format!("https://App.example.org/a/{id}#{secret}.{KEY_TEXT}.{HASH_TEXT}"),
        format!("http://app.example.org/a/{id}#{secret}.{KEY_TEXT}.{HASH_TEXT}"),
        format!("app.example.org/a/{id}#{secret}.{KEY_TEXT}.{HASH_TEXT}"),
        format!("https://app.example.org/a/#{secret}.{KEY_TEXT}.{HASH_TEXT}"),
        format!(
            "https://app.example.org/a/{}#{secret}.{KEY_TEXT}.{HASH_TEXT}",
            &id[1..]
        ),
        format!("https://app.example.org/a/{id}A#{secret}.{KEY_TEXT}.{HASH_TEXT}"),
        format!(
            "https://app.example.org/a/{id}#{}.{KEY_TEXT}.{HASH_TEXT}",
            &secret[1..]
        ),
        format!("https://app.example.org/a/{id}#{secret}A.{KEY_TEXT}.{HASH_TEXT}"),
        format!("https://app.example.org/a/{id}#{secret}=.{KEY_TEXT}.{HASH_TEXT}"),
        format!(
            "https://app.example.org/a/{id}#{secret}.{KEY_TEXT}.{}",
            &HASH_TEXT[1..]
        ),
        // The last symbol of 43 carries four bits and two that must be zero.
        format!(
            "https://app.example.org/a/{id}#{secret}.{KEY_TEXT}.{}J",
            &HASH_TEXT[..42]
        ),
        format!(
            "https://app.example.org/a/{id}#{secret}.{}+.{HASH_TEXT}",
            &KEY_TEXT[..42]
        ),
        format!("https://app.example.org/a/{id}#{secret}%2E{KEY_TEXT}.{HASH_TEXT}"),
    ];
    for case in cases {
        assert_eq!(
            ShareLink::parse(&case).err(),
            Some(Error::BadFormat),
            "{case}"
        );
    }
}

#[test]
fn the_hub_knows_the_secret_only_by_its_hash() {
    let link = ShareLink::create("https://app.example.org", &file_ref(), &mut SystemEntropy)
        .expect("creates");
    let hash = link.secret_hash().expect("hashes");
    assert_eq!(hash, crypto::sha256(link.secret.expose()).expect("hashes"));

    let presented = String::from_utf8(link.secret_base64url().expose().to_vec()).expect("utf-8");
    assert_eq!(share_secret_matches(&presented, &hash), Ok(true));

    let other = ShareLink::create("https://app.example.org", &file_ref(), &mut SystemEntropy)
        .expect("creates");
    let other_text = String::from_utf8(other.secret_base64url().expose().to_vec()).expect("utf-8");
    assert_eq!(share_secret_matches(&other_text, &hash), Ok(false));
    for junk in [
        "",
        "x",
        &presented[1..],
        &format!("{presented}A"),
        "ä",
        &hash.to_base64url(),
    ] {
        assert_eq!(share_secret_matches(junk, &hash), Ok(false), "{junk}");
    }
}

#[test]
fn a_share_expires_at_most_180_days_ahead() {
    let now = 1_700_000_000_000;
    assert_eq!(MAX_SHARE_LIFE_MS, 15_552_000_000);
    assert_eq!(check_share_expiry(now + MAX_SHARE_LIFE_MS, now), Ok(()));
    assert_eq!(check_share_expiry(now + 1, now), Ok(()));
    assert_eq!(check_share_expiry(0, now), Ok(()));
    assert_eq!(
        check_share_expiry(now + MAX_SHARE_LIFE_MS + 1, now),
        Err(Error::BadFormat)
    );
    assert_eq!(check_share_expiry(u64::MAX, now), Err(Error::BadFormat));
    assert_eq!(check_share_expiry(u64::MAX, u64::MAX), Ok(()));
}

#[test]
fn links_and_references_do_not_print_their_secrets() {
    let link = ShareLink::parse(&format!(
        "https://app.example.org/a/8fHx8fHx8fHx8fHx8fHx8Q#MzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzM.{KEY_TEXT}.{HASH_TEXT}"
    ))
    .expect("parses");
    let printed = format!(
        "{link:?} {:?} {:?}",
        link.to_text(),
        link.secret_base64url()
    );
    assert!(!printed.contains("MzMz"));
    assert!(!printed.contains("ERER"));
    assert!(!printed.contains("3333"));
    assert!(!printed.contains("1111"));
    assert!(printed.contains("redacted"));
}

#[test]
fn more_than_the_largest_file_is_refused_without_room_being_made_for_it() {
    let head = FileHead { file_id: FILE }.encode();
    let mut decryptor = Decryptor::new(&naming(&head));
    assert_eq!(decryptor.update(&head), Ok(vec![]));
    let beyond = vec![0u8; MAX_STORED_LEN as usize];
    assert_eq!(decryptor.update(&beyond), Err(Error::TooLarge));
    assert_eq!(decryptor.update(&[]), Err(Error::TooLarge));
}

#[test]
fn the_vectors_read_back() {
    use trommi_tests::vectors::files::{plaintext, reference_of, NAME};
    use trommi_tests::vectors::{hex, read, unhex};

    let file = read(NAME).unwrap();
    let text = |value: &serde_json::Value, key: &str| value[key].as_str().expect(key).to_owned();
    let mut two_chunks = Vec::new();
    for case in file["files"].as_array().unwrap() {
        let stored = unhex(&text(case, "stored")).unwrap();
        let named = reference_of(case).unwrap();
        let plain_len = case["plain_len"].as_u64().unwrap();
        let plain = plaintext(plain_len as usize);
        assert_eq!(
            hex(crypto::sha256(&plain).unwrap().as_bytes()),
            text(case, "plaintext_sha256")
        );
        // The reference's fields as a body's JSON carries them.
        let through_text = FileRef::from_base64url(
            &named.file_id.to_base64url(),
            std::str::from_utf8(named.file_key_base64url().expose()).unwrap(),
            &named.sha256.to_base64url(),
        )
        .unwrap();
        assert_eq!(through_text, named);
        assert_eq!(crypto::sha256(&stored).unwrap(), named.sha256);

        // Whole, as a stream in pieces, and chunk by chunk.
        assert_eq!(decrypt_file(&named, &stored).unwrap(), plain);
        let mut decryptor = Decryptor::new(&named);
        let mut streamed = Vec::new();
        for piece in stored.chunks(4_999) {
            streamed.extend(decryptor.update(piece).unwrap());
        }
        streamed.extend(decryptor.finish().unwrap());
        assert_eq!(streamed, plain);
        let layout = Layout::of_stored(stored.len() as u64).unwrap();
        assert_eq!(layout.plain_len(), plain_len);
        assert_eq!(layout.chunks(), case["chunks"].as_u64().unwrap());
        assert_eq!(layout.stored_len(), case["stored_len"].as_u64().unwrap());
        let mut by_chunk = Vec::new();
        for index in 0..layout.chunks() {
            let (offset, len) = layout.stored_range(index).unwrap();
            let sealed = &stored[offset as usize..(offset + len) as usize];
            by_chunk.extend(
                open_chunk(
                    &named.file_key,
                    &named.file_id,
                    index,
                    layout.is_last(index),
                    sealed,
                )
                .unwrap(),
            );
        }
        assert_eq!(by_chunk, plain);
        assert_eq!(
            FileHead::decode(&stored[..HEAD_LEN]).unwrap().file_id,
            named.file_id
        );
        if layout.chunks() == 2 {
            two_chunks = stored;
        }
    }
    assert_eq!(file["files"].as_array().unwrap().len(), 3);

    for case in file["refused"].as_array().unwrap() {
        let named = reference_of(&case["reference"]).unwrap();
        let stored = match case["stored_is_the_first_bytes_of_the_file_of_two_chunks"].as_u64() {
            Some(len) => two_chunks[..len as usize].to_vec(),
            None => unhex(&text(case, "stored")).unwrap(),
        };
        let code = text(case, "code");
        let why = text(case, "why");
        assert_eq!(
            decrypt_file(&named, &stored).unwrap_err().code(),
            code,
            "{why}"
        );
        // A stream fails too, at the chunk concerned or at its end, whatever it handed out before.
        let mut decryptor = Decryptor::new(&named);
        let streamed = decryptor.update(&stored).and_then(|_| decryptor.finish());
        assert!(streamed.is_err(), "{why}");
    }

    let share = &file["share_link"];
    let link = ShareLink::parse(&text(share, "link")).unwrap();
    assert_eq!(link.app(), text(share, "app"));
    assert_eq!(hex(link.share_id.as_bytes()), text(share, "share_id"));
    assert_eq!(hex(link.secret.expose()), text(share, "secret"));
    assert_eq!(hex(link.file_key.expose()), text(share, "file_key"));
    assert_eq!(hex(link.sha256.as_bytes()), text(share, "sha256"));
    assert_eq!(link.to_text().expose(), text(share, "link").as_bytes());
    let registered = link.secret_hash().unwrap();
    assert_eq!(hex(registered.as_bytes()), text(share, "secret_sha256"));
    let presented = String::from_utf8(link.secret_base64url().expose().to_vec()).unwrap();
    assert_eq!(share_secret_matches(&presented, &registered), Ok(true));
    assert_eq!(
        share_secret_matches(&presented, &Hash32::new([1; 32])),
        Ok(false)
    );
    // The link opens the small file once it was fetched.
    let small = &file["files"][1];
    let file_id = FileId::from_slice(&unhex(&text(share, "file_id")).unwrap()).unwrap();
    let stored = unhex(&text(small, "stored")).unwrap();
    assert_eq!(
        decrypt_file(&link.file(file_id), &stored).unwrap(),
        plaintext(300)
    );
}
