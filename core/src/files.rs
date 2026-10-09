//! Files and Share links (section 11): chunked sealing under a file key, the link's parts.
//!
//! ```text
//! struct { uint8 version = 2;  opaque file_id[16];  uint32 chunk_size; } FileHead;       chunk_size = 65536
//! file    = FileHead ‖ chunk_0 ‖ chunk_1 ‖ …
//! chunk_i = AEAD.Seal(file_key, nonce_i, aad = FileHead, plaintext[i × 65536 …])
//! nonce_i = 0x00 0x00 0x00 ‖ uint64 i ‖ uint8 last                                        last = 1 on the final chunk
//! ```
//!
//! A file has one stored form: every chunk but the last holds exactly 65536 bytes, the last holds what is left,
//! and it is empty only when the whole file is. The chunk number and the final mark stand in the nonce, the head
//! is the associated data: a chunk opens only at its own place in its own file, and a file that ends early ends
//! in a chunk without the final mark, which does not open as one.
//!
//! Three ways to use it:
//!
//! - whole buffers: [`encrypt_file`], [`decrypt_file`] (which compares the stored file's SHA-256 first, 11.2);
//! - streaming, without holding the file: [`Encryptor`] and [`Decryptor`] take any pieces and give out what is
//!   ready. A decryptor hands out a chunk as soon as it opened; that the file is whole is known only when
//!   [`Decryptor::finish`] succeeds, which also compares the SHA-256 of everything it was given;
//! - single chunks for a `Range` read: [`Layout`] says where chunk `i` lies, [`open_chunk`] opens it, relying on
//!   the chunk's own authentication.
//!
//! The file key is 32 fresh random bytes per file and is used for nothing else: with the nonces being counters,
//! a key used for a second file would repeat them. An [`Encryptor`] therefore makes its own key and file id and
//! gives the key out only with the finished file; nothing here seals under a key the caller brings.

use crate::crypto::{self, Entropy, Secret, SecretBytes, NONCE_LEN, TAG_LEN};
use crate::error::Error;
use crate::hub_auth::is_canonical_origin;
use crate::ids::{self, FileId, Hash32, ShareId};
use sha2::{Digest, Sha256};
use zeroize::{Zeroize, Zeroizing};

/// The version byte of a file head.
const VERSION: u8 = 2;
/// The plaintext bytes of every chunk but the last.
pub const CHUNK_SIZE: usize = 65536;
/// The length of an encoded [`FileHead`].
pub const HEAD_LEN: usize = 21;
/// The stored length of a full chunk.
pub const SEALED_CHUNK_LEN: usize = CHUNK_SIZE + TAG_LEN;
/// The largest file, in plaintext bytes: 64 MiB.
pub const MAX_FILE_LEN: u64 = 64 << 20;
/// The chunks of the largest file.
pub const MAX_CHUNKS: u64 = MAX_FILE_LEN / CHUNK_SIZE as u64;
/// The stored length of the largest file: its head, its bytes and one tag per chunk.
pub const MAX_STORED_LEN: u64 = HEAD_LEN as u64 + MAX_FILE_LEN + MAX_CHUNKS * TAG_LEN as u64;
/// The longest life of a Share link: 180 days.
pub const MAX_SHARE_LIFE_MS: u64 = 180 * 24 * 60 * 60 * 1000;

const CHUNK_SIZE_U64: u64 = CHUNK_SIZE as u64;
const SEALED_CHUNK_LEN_U64: u64 = SEALED_CHUNK_LEN as u64;
const HEAD_LEN_U64: u64 = HEAD_LEN as u64;
const TAG_LEN_U64: u64 = TAG_LEN as u64;

/// The head of a stored file. Version and chunk size have one value each, so the file's id says it all.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileHead {
    /// The file.
    pub file_id: FileId,
}

impl FileHead {
    /// The 21 bytes a stored file starts with, and the associated data of each of its chunks.
    pub fn encode(&self) -> [u8; HEAD_LEN] {
        let mut head = [0u8; HEAD_LEN];
        let (version, rest) = head.split_at_mut(1);
        let (file_id, chunk_size) = rest.split_at_mut(FileId::LEN);
        version.fill(VERSION);
        file_id.copy_from_slice(self.file_id.as_bytes());
        chunk_size.copy_from_slice(&(CHUNK_SIZE as u32).to_be_bytes());
        head
    }

    /// The head these bytes are: `newer-version` for a version above 2, `bad-format` for another length, an
    /// older version or another chunk size.
    pub fn decode(bytes: &[u8]) -> Result<Self, Error> {
        let (version, rest) = bytes.split_first().ok_or(Error::BadFormat)?;
        let (file_id, chunk_size) = rest
            .split_first_chunk::<{ FileId::LEN }>()
            .ok_or(Error::BadFormat)?;
        if bytes.len() != HEAD_LEN {
            return Err(Error::BadFormat);
        }
        if *version > VERSION {
            return Err(Error::NewerVersion);
        }
        if *version != VERSION || chunk_size != (CHUNK_SIZE as u32).to_be_bytes() {
            return Err(Error::BadFormat);
        }
        Ok(Self {
            file_id: FileId::new(*file_id),
        })
    }
}

/// `0x00 0x00 0x00 ‖ uint64 index ‖ uint8 last`.
fn nonce(index: u64, last: bool) -> [u8; NONCE_LEN] {
    let mut nonce = [0u8; NONCE_LEN];
    let (_, rest) = nonce.split_at_mut(3);
    let (counter, mark) = rest.split_at_mut(8);
    counter.copy_from_slice(&index.to_be_bytes());
    mark.fill(u8::from(last));
    nonce
}

/// Whether a chunk of `plain_len` bytes may stand at `index`: `too-large` beyond the largest file, `bad-format`
/// for a chunk that is not full before the last, longer than full, or empty anywhere but in an empty file.
fn check_shape(index: u64, last: bool, plain_len: usize) -> Result<(), Error> {
    if index >= MAX_CHUNKS {
        return Err(Error::TooLarge);
    }
    let shaped = if last {
        plain_len <= CHUNK_SIZE && (plain_len > 0 || index == 0)
    } else {
        plain_len == CHUNK_SIZE
    };
    if shaped {
        Ok(())
    } else {
        Err(Error::BadFormat)
    }
}

/// Seals chunk `index` of file `file_id`: `plaintext` is exactly [`CHUNK_SIZE`] bytes, or with `last` what is
/// left of the file. `bad-format` for another length, `too-large` for a chunk beyond the largest file. Only an
/// [`Encryptor`] calls it, once per chunk number under its own key.
fn seal_chunk(
    key: &Secret<32>,
    file_id: &FileId,
    index: u64,
    last: bool,
    plaintext: &[u8],
) -> Result<Vec<u8>, Error> {
    check_shape(index, last, plaintext.len())?;
    let head = FileHead { file_id: *file_id }.encode();
    crypto::aead_seal(key, &nonce(index, last), &head, plaintext)
}

/// Opens chunk `index` of file `file_id` as read from the stored file (a `Range` read). `last` says whether it is
/// the file's final chunk, which [`Layout`] knows from the stored length. `decrypt-failed` unless it is that
/// chunk of that file under that key, with that mark; `bad-format` for a length no such chunk has; `too-large`
/// for a chunk beyond the largest file.
pub fn open_chunk(
    key: &Secret<32>,
    file_id: &FileId,
    index: u64,
    last: bool,
    sealed: &[u8],
) -> Result<Vec<u8>, Error> {
    let plain_len = sealed.len().checked_sub(TAG_LEN).ok_or(Error::BadFormat)?;
    check_shape(index, last, plain_len)?;
    let head = FileHead { file_id: *file_id }.encode();
    crypto::aead_open(key, &nonce(index, last), &head, sealed)
}

/// Where the chunks of one file lie in its stored form.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Layout {
    chunks: u64,
    plain_len: u64,
}

impl Layout {
    /// The layout of a file of `plain_len` bytes; `too-large` above [`MAX_FILE_LEN`].
    pub fn of_plain(plain_len: u64) -> Result<Self, Error> {
        if plain_len > MAX_FILE_LEN {
            return Err(Error::TooLarge);
        }
        Ok(Self {
            chunks: plain_len.div_ceil(CHUNK_SIZE_U64).max(1),
            plain_len,
        })
    }

    /// The layout of a stored file of `stored_len` bytes; `too-large` above [`MAX_STORED_LEN`], `bad-format` for
    /// a length no stored file has.
    pub fn of_stored(stored_len: u64) -> Result<Self, Error> {
        if stored_len > MAX_STORED_LEN {
            return Err(Error::TooLarge);
        }
        let body = stored_len
            .checked_sub(HEAD_LEN_U64)
            .ok_or(Error::BadFormat)?;
        let chunks = body.div_ceil(SEALED_CHUNK_LEN_U64);
        let full_chunks = chunks.checked_sub(1).ok_or(Error::BadFormat)?;
        let last_plain = full_chunks
            .checked_mul(SEALED_CHUNK_LEN_U64)
            .and_then(|before| body.checked_sub(before))
            .and_then(|last_sealed| last_sealed.checked_sub(TAG_LEN_U64))
            .ok_or(Error::BadFormat)?;
        if last_plain == 0 && full_chunks > 0 {
            return Err(Error::BadFormat);
        }
        let plain_len = full_chunks
            .checked_mul(CHUNK_SIZE_U64)
            .and_then(|before| before.checked_add(last_plain))
            .ok_or(Error::BadFormat)?;
        Self::of_plain(plain_len)
    }

    /// How many chunks the file has: at least one.
    pub fn chunks(&self) -> u64 {
        self.chunks
    }

    /// The file's length in plaintext bytes.
    pub fn plain_len(&self) -> u64 {
        self.plain_len
    }

    /// The file's length as stored.
    pub fn stored_len(&self) -> u64 {
        // At most MAX_STORED_LEN, since both terms are bounded by the largest file.
        HEAD_LEN_U64
            .saturating_add(self.plain_len)
            .saturating_add(self.chunks.saturating_mul(TAG_LEN_U64))
    }

    /// Whether chunk `index` is the final one.
    pub fn is_last(&self, index: u64) -> bool {
        index.checked_add(1) == Some(self.chunks)
    }

    /// The chunk that holds the plaintext byte at `offset`; `None` beyond the end.
    pub fn chunk_of(&self, offset: u64) -> Option<u64> {
        (offset < self.plain_len).then_some(offset / CHUNK_SIZE_U64)
    }

    /// Where chunk `index` lies in the stored file, as (offset, length): the bytes of a `Range` read. `None` for
    /// a chunk the file does not have.
    pub fn stored_range(&self, index: u64) -> Option<(u64, u64)> {
        if index >= self.chunks {
            return None;
        }
        let offset = index
            .checked_mul(SEALED_CHUNK_LEN_U64)?
            .checked_add(HEAD_LEN_U64)?;
        let len = if self.is_last(index) {
            self.stored_len().checked_sub(offset)?
        } else {
            SEALED_CHUNK_LEN_U64
        };
        Some((offset, len))
    }
}

/// SHA-256 over a stored file as it passes by: what an attachment reference names, and what a whole download is
/// compared with (11.2).
#[derive(Clone, Default)]
pub struct FileHasher(Sha256);

impl FileHasher {
    /// A hasher that has seen nothing.
    pub fn new() -> Self {
        Self::default()
    }

    /// Takes the next bytes of the stored file.
    pub fn update(&mut self, stored: &[u8]) {
        self.0.update(stored);
    }

    /// The SHA-256 of everything taken.
    pub fn finish(self) -> Result<Hash32, Error> {
        Hash32::from_slice(self.0.finalize().as_slice()).map_err(|_| Error::Internal("hash length"))
    }

    /// `decrypt-failed` unless everything taken is the file `expected` names.
    pub fn verify(self, expected: &Hash32) -> Result<(), Error> {
        if crypto::ct_eq(self.finish()?.as_bytes(), expected.as_bytes()) {
            Ok(())
        } else {
            Err(Error::DecryptFailed)
        }
    }
}

/// What an encryptor reports when the file is complete.
#[derive(Debug, PartialEq, Eq)]
pub struct Sealed {
    /// The file's id, its key and the SHA-256 of the stored file: for the body that names the file.
    pub file: FileRef,
    /// The file's length in plaintext bytes.
    pub plain_len: u64,
    /// The file's length as stored.
    pub stored_len: u64,
}

/// Encrypts one file piece by piece, under a key it makes for that file alone. Everything
/// [`Encryptor::update`] and [`Encryptor::finish`] return, in order, is the stored file. At most one chunk of
/// plaintext is held, and wiped when it is sealed or dropped.
pub struct Encryptor {
    key: Secret<32>,
    file_id: FileId,
    index: u64,
    plain_len: u64,
    pending: Zeroizing<Vec<u8>>,
    hasher: FileHasher,
    head_written: bool,
}

impl Encryptor {
    /// Starts a new file: a fresh key and a fresh id, 32 and 16 random bytes.
    pub fn new(entropy: &mut dyn Entropy) -> Result<Self, Error> {
        Ok(Self {
            key: Secret::random(entropy)?,
            file_id: FileId::new(crypto::random(entropy)?),
            index: 0,
            plain_len: 0,
            pending: Zeroizing::new(Vec::with_capacity(CHUNK_SIZE)),
            hasher: FileHasher::new(),
            head_written: false,
        })
    }

    /// The id of the file being made: what it is uploaded under.
    pub fn file_id(&self) -> FileId {
        self.file_id
    }

    fn write(&mut self, out: &mut Vec<u8>, stored: &[u8]) {
        self.hasher.update(stored);
        out.extend_from_slice(stored);
    }

    fn write_head(&mut self, out: &mut Vec<u8>) {
        if !self.head_written {
            self.head_written = true;
            let head = FileHead {
                file_id: self.file_id,
            }
            .encode();
            self.write(out, &head);
        }
    }

    fn seal_pending(&mut self, out: &mut Vec<u8>, last: bool) -> Result<(), Error> {
        let sealed = seal_chunk(&self.key, &self.file_id, self.index, last, &self.pending)?;
        self.pending.zeroize();
        self.index = self.index.saturating_add(1);
        self.write(out, &sealed);
        Ok(())
    }

    /// Takes the next plaintext bytes and returns the stored bytes that are ready. `too-large` once the file
    /// would pass [`MAX_FILE_LEN`]; nothing was taken then.
    pub fn update(&mut self, plaintext: &[u8]) -> Result<Vec<u8>, Error> {
        let plain_len = u64::try_from(plaintext.len())
            .ok()
            .and_then(|more| self.plain_len.checked_add(more))
            .filter(|total| *total <= MAX_FILE_LEN)
            .ok_or(Error::TooLarge)?;
        self.plain_len = plain_len;

        let mut out = Vec::new();
        self.write_head(&mut out);
        let mut input = plaintext;
        loop {
            // A full chunk is sealed only once a byte follows it: the final chunk carries another mark.
            let room = CHUNK_SIZE.saturating_sub(self.pending.len());
            match input.split_at_checked(room) {
                Some((fill, rest)) if !rest.is_empty() => {
                    self.pending.extend_from_slice(fill);
                    self.seal_pending(&mut out, false)?;
                    input = rest;
                }
                _ => {
                    self.pending.extend_from_slice(input);
                    return Ok(out);
                }
            }
        }
    }

    /// Ends the file: the last stored bytes, and the reference with the file's key.
    pub fn finish(mut self) -> Result<(Vec<u8>, Sealed), Error> {
        let mut out = Vec::new();
        self.write_head(&mut out);
        self.seal_pending(&mut out, true)?;
        let layout = Layout::of_plain(self.plain_len)?;
        let sealed = Sealed {
            file: FileRef {
                file_id: self.file_id,
                file_key: self.key.duplicate(),
                sha256: self.hasher.finish()?,
            },
            plain_len: layout.plain_len(),
            stored_len: layout.stored_len(),
        };
        Ok((out, sealed))
    }
}

/// Decrypts a stored file piece by piece. Each chunk is handed out once it opened; a file that was cut, extended
/// or reordered fails at the chunk concerned or in [`Decryptor::finish`], so what was handed out before counts
/// only once `finish` succeeded. After a failure every further call fails the same way.
///
/// Each chunk is authenticated on its own under the file key. That the file is the one the reference names is
/// the SHA-256 of the stored bytes, which only the end can tell: `finish` compares it before it opens the final
/// chunk. A caller that must not touch a byte before that comparison holds the download and uses
/// [`decrypt_file`].
pub struct Decryptor {
    key: Secret<32>,
    file_id: FileId,
    sha256: Hash32,
    /// The hash of what was taken; `None` when the caller compared it already.
    hasher: Option<FileHasher>,
    /// How many stored bytes were taken.
    taken: u64,
    index: u64,
    head: Vec<u8>,
    head_checked: bool,
    pending: Vec<u8>,
    failed: Option<Error>,
}

impl Decryptor {
    /// Starts reading the file `file` names.
    pub fn new(file: &FileRef) -> Self {
        Self::start(file, Some(FileHasher::new()))
    }

    fn start(file: &FileRef, hasher: Option<FileHasher>) -> Self {
        Self {
            key: file.file_key.duplicate(),
            file_id: file.file_id,
            sha256: file.sha256,
            hasher,
            taken: 0,
            index: 0,
            head: Vec::with_capacity(HEAD_LEN),
            head_checked: false,
            pending: Vec::with_capacity(SEALED_CHUNK_LEN),
            failed: None,
        }
    }

    fn open_pending(&mut self, out: &mut Vec<u8>, last: bool) -> Result<(), Error> {
        let plain = Zeroizing::new(open_chunk(
            &self.key,
            &self.file_id,
            self.index,
            last,
            &self.pending,
        )?);
        self.pending.clear();
        self.index = self.index.saturating_add(1);
        out.extend_from_slice(&plain);
        Ok(())
    }

    /// Takes the head from the front of `input` and checks it once it is whole; returns what follows it.
    fn take_head<'a>(&mut self, input: &'a [u8]) -> Result<&'a [u8], Error> {
        if self.head_checked {
            return Ok(input);
        }
        let missing = HEAD_LEN.saturating_sub(self.head.len());
        let (head, rest) = input.split_at_checked(missing).unwrap_or((input, &[]));
        self.head.extend_from_slice(head);
        if self.head.len() == HEAD_LEN {
            if FileHead::decode(&self.head)?.file_id != self.file_id {
                return Err(Error::DecryptFailed);
            }
            self.head_checked = true;
        }
        Ok(rest)
    }

    fn take(&mut self, stored: &[u8], out: &mut Vec<u8>) -> Result<(), Error> {
        // More than the largest file is refused before any of it is hashed.
        self.taken = u64::try_from(stored.len())
            .ok()
            .and_then(|more| self.taken.checked_add(more))
            .filter(|taken| *taken <= MAX_STORED_LEN)
            .ok_or(Error::TooLarge)?;
        if let Some(hasher) = &mut self.hasher {
            hasher.update(stored);
        }
        let mut input = self.take_head(stored)?;
        loop {
            // A full chunk is opened only once a byte follows it: until then it may be the final one.
            let room = SEALED_CHUNK_LEN.saturating_sub(self.pending.len());
            match input.split_at_checked(room) {
                Some((fill, rest)) if !rest.is_empty() => {
                    self.pending.extend_from_slice(fill);
                    self.open_pending(out, false)?;
                    input = rest;
                }
                _ => {
                    self.pending.extend_from_slice(input);
                    return Ok(());
                }
            }
        }
    }

    fn end(&mut self, out: &mut Vec<u8>) -> Result<(), Error> {
        if !self.head_checked || self.pending.len() < TAG_LEN {
            return Err(Error::BadFormat);
        }
        if let Some(hasher) = self.hasher.take() {
            hasher.verify(&self.sha256)?;
        }
        self.open_pending(out, true)
    }

    fn guarded(
        &mut self,
        step: impl FnOnce(&mut Self, &mut Vec<u8>) -> Result<(), Error>,
    ) -> Result<Vec<u8>, Error> {
        if let Some(error) = &self.failed {
            return Err(error.clone());
        }
        let mut out = Zeroizing::new(Vec::new());
        match step(self, &mut out) {
            Ok(()) => Ok(std::mem::take(&mut *out)),
            Err(error) => {
                self.failed = Some(error.clone());
                Err(error)
            }
        }
    }

    /// Takes the next stored bytes and returns the plaintext of the chunks that opened. `newer-version` or
    /// `bad-format` for a head that is none, `decrypt-failed` for a head of another file or a chunk that does not
    /// open at its place, `too-large` beyond the largest file.
    pub fn update(&mut self, stored: &[u8]) -> Result<Vec<u8>, Error> {
        self.guarded(|this, out| this.take(stored, out))
    }

    /// Ends the file: the plaintext of the final chunk. `bad-format` when the bytes end before a chunk could,
    /// or in an empty chunk behind others; `decrypt-failed` when the bytes taken are not the file the reference's
    /// SHA-256 names, or what came last is not the file's final chunk: the file was cut, or something was
    /// appended.
    pub fn finish(mut self) -> Result<Vec<u8>, Error> {
        self.guarded(|this, out| this.end(out))
    }
}

/// Encrypts a whole file under a fresh key: the stored bytes, and the reference with that key. `too-large`
/// above [`MAX_FILE_LEN`].
pub fn encrypt_file(
    plaintext: &[u8],
    entropy: &mut dyn Entropy,
) -> Result<(Vec<u8>, Sealed), Error> {
    let mut encryptor = Encryptor::new(entropy)?;
    let mut stored = encryptor.update(plaintext)?;
    let (rest, sealed) = encryptor.finish()?;
    stored.extend_from_slice(&rest);
    Ok((stored, sealed))
}

/// Decrypts a whole download of the file `file` names. `too-large` above [`MAX_STORED_LEN`]. The stored bytes
/// are compared with the reference's SHA-256 before anything is decrypted (`decrypt-failed`); then `bad-format`,
/// `newer-version` and `decrypt-failed` as [`Decryptor`] gives them.
pub fn decrypt_file(file: &FileRef, stored: &[u8]) -> Result<Vec<u8>, Error> {
    let stored_len = u64::try_from(stored.len())
        .ok()
        .filter(|len| *len <= MAX_STORED_LEN)
        .ok_or(Error::TooLarge)?;
    let mut hasher = FileHasher::new();
    hasher.update(stored);
    hasher.verify(&file.sha256)?;
    Layout::of_stored(stored_len)?;

    let mut decryptor = Decryptor::start(file, None);
    let mut plain = Zeroizing::new(decryptor.update(stored)?);
    plain.extend_from_slice(&Zeroizing::new(decryptor.finish()?));
    Ok(std::mem::take(&mut *plain))
}

/// Reads the `N` bytes of a key, a secret, an id or a hash from base64url, straight into the place that is
/// wiped when dropped: no buffer on the heap holds them on the way. Text of another length than `N` bytes
/// have is refused unread.
fn fixed_from_base64url<const N: usize>(text: &str) -> Result<Secret<N>, Error> {
    let mut bytes = Zeroizing::new([0u8; N]);
    ids::base64url_decode_into(text, bytes.as_mut_slice())?;
    Ok(Secret::new(*bytes))
}

/// What opens a stored file: the fields `file_id`, `file_key` and `sha256` of an attachment reference (9.1.1).
/// They stand only in the encrypted body that names the file.
#[derive(Debug, PartialEq, Eq)]
pub struct FileRef {
    /// The file.
    pub file_id: FileId,
    /// The file's key.
    pub file_key: Secret<32>,
    /// The SHA-256 of the stored file.
    pub sha256: Hash32,
}

impl FileRef {
    /// The reference with these three fields as a body's JSON carries them, base64url each; `bad-format` for
    /// anything else.
    pub fn from_base64url(file_id: &str, file_key: &str, sha256: &str) -> Result<Self, Error> {
        Ok(Self {
            file_id: FileId::new(*fixed_from_base64url(file_id)?.expose()),
            file_key: fixed_from_base64url(file_key)?,
            sha256: Hash32::new(*fixed_from_base64url(sha256)?.expose()),
        })
    }

    /// `file_key` as a body's JSON carries it: base64url, as secret text.
    pub fn file_key_base64url(&self) -> SecretBytes {
        SecretBytes::new(ids::base64url_encode(self.file_key.expose()).into_bytes())
    }
}

/// A Share link (11.5): `<app>/a/<share_id>#<secret>.<file_key>.<sha256>`, where `<app>` is the app's origin in
/// the canonical spelling of a hub address. What stands behind the `#` never reaches a server: the browser keeps
/// it, presents `secret` to the hub in a header, and decrypts with the key.
#[derive(Debug, PartialEq, Eq)]
pub struct ShareLink {
    app: String,
    /// What the hub knows the share by.
    pub share_id: ShareId,
    /// What the hub serves the file for; the hub holds only its SHA-256.
    pub secret: Secret<32>,
    /// The file's key.
    pub file_key: Secret<32>,
    /// The SHA-256 of the stored file.
    pub sha256: Hash32,
}

impl ShareLink {
    /// A new link to the file `file` names, with a fresh share id and secret. `bad-format` unless `app` is a
    /// canonical origin.
    pub fn create(app: &str, file: &FileRef, entropy: &mut dyn Entropy) -> Result<Self, Error> {
        if !is_canonical_origin(app) {
            return Err(Error::BadFormat);
        }
        Ok(Self {
            app: app.to_owned(),
            share_id: ShareId::new(crypto::random(entropy)?),
            secret: Secret::random(entropy)?,
            file_key: file.file_key.duplicate(),
            sha256: file.sha256,
        })
    }

    /// The link `text` is. `bad-format` for anything but the exact form: a canonical origin, `/a/`, the share id,
    /// `#`, and the three parts, each canonical base64url of its length.
    pub fn parse(text: &str) -> Result<Self, Error> {
        let (address, fragment) = text.split_once('#').ok_or(Error::BadFormat)?;
        let (app, share_id) = address.rsplit_once("/a/").ok_or(Error::BadFormat)?;
        if !is_canonical_origin(app) {
            return Err(Error::BadFormat);
        }
        let mut parts = fragment.split('.');
        let (Some(secret), Some(file_key), Some(sha256), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return Err(Error::BadFormat);
        };
        Ok(Self {
            app: app.to_owned(),
            share_id: ShareId::new(*fixed_from_base64url(share_id)?.expose()),
            secret: fixed_from_base64url(secret)?,
            file_key: fixed_from_base64url(file_key)?,
            sha256: Hash32::new(*fixed_from_base64url(sha256)?.expose()),
        })
    }

    /// The app's origin.
    pub fn app(&self) -> &str {
        &self.app
    }

    /// The link as text. It holds the secret and the key: it is for the person to hand on, never for a log.
    pub fn to_text(&self) -> SecretBytes {
        // Room for the whole link, so that no shorter copy of it is left behind while it grows.
        let mut text = Zeroizing::new(String::with_capacity(self.app.len() + 160));
        text.push_str(&self.app);
        text.push_str("/a/");
        text.push_str(&self.share_id.to_base64url());
        text.push('#');
        text.push_str(&Zeroizing::new(ids::base64url_encode(self.secret.expose())));
        text.push('.');
        text.push_str(&Zeroizing::new(ids::base64url_encode(
            self.file_key.expose(),
        )));
        text.push('.');
        text.push_str(&self.sha256.to_base64url());
        SecretBytes::new(text.as_bytes().to_vec())
    }

    /// SHA-256 of the secret: what the maker registers at the hub with the share id, the file and the expiry.
    pub fn secret_hash(&self) -> Result<Hash32, Error> {
        crypto::sha256(self.secret.expose())
    }

    /// The secret as the header `x-share-secret` presents it: base64url, as secret text.
    pub fn secret_base64url(&self) -> SecretBytes {
        SecretBytes::new(ids::base64url_encode(self.secret.expose()).into_bytes())
    }

    /// The attachment fields that open the file once it was fetched.
    pub fn file(&self, file_id: FileId) -> FileRef {
        FileRef {
            file_id,
            file_key: self.file_key.duplicate(),
            sha256: self.sha256,
        }
    }
}

/// Whether a Share link may be registered with this expiry: `bad-format` when it lies more than 180 days after
/// `now_ms`.
pub fn check_share_expiry(expires_at: u64, now_ms: u64) -> Result<(), Error> {
    if expires_at > now_ms.saturating_add(MAX_SHARE_LIFE_MS) {
        return Err(Error::BadFormat);
    }
    Ok(())
}

/// Hub side: whether the secret a request presents (the text of `x-share-secret`) is the one whose SHA-256 was
/// registered. Compared in constant time; text that is not the base64url of 32 bytes matches nothing.
pub fn share_secret_matches(presented: &str, secret_hash: &Hash32) -> Result<bool, Error> {
    let Ok(secret) = fixed_from_base64url::<32>(presented) else {
        return Ok(false);
    };
    Ok(crypto::ct_eq(
        crypto::sha256(secret.expose())?.as_bytes(),
        secret_hash.as_bytes(),
    ))
}

#[cfg(test)]
mod tests {
    //! What the public interface does not show: the nonce of a chunk, the shapes the sealing refuses, and
    //! the count of bytes a decryptor took.

    use super::*;

    const FILE: FileId = FileId::new([0xF1; 16]);

    fn key() -> Secret<32> {
        Secret::new([1; 32])
    }

    #[test]
    fn the_nonce_is_three_zeros_the_chunk_number_and_the_final_mark() {
        assert_eq!(nonce(0, false), [0; 12]);
        assert_eq!(nonce(0, true), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
        assert_eq!(
            nonce(0x0102_0304_0506_0708, true),
            [0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 1]
        );
    }

    #[test]
    fn chunks_of_a_shape_no_file_has_are_not_sealed() {
        let full = vec![0u8; CHUNK_SIZE];
        assert_eq!(
            seal_chunk(&key(), &FILE, 0, false, &full[1..]),
            Err(Error::BadFormat)
        );
        assert_eq!(
            seal_chunk(&key(), &FILE, 0, false, &[]),
            Err(Error::BadFormat)
        );
        assert_eq!(
            seal_chunk(&key(), &FILE, 1, true, &[]),
            Err(Error::BadFormat)
        );
        let long = vec![0u8; CHUNK_SIZE + 1];
        assert_eq!(
            seal_chunk(&key(), &FILE, 0, true, &long),
            Err(Error::BadFormat)
        );
        assert_eq!(
            seal_chunk(&key(), &FILE, MAX_CHUNKS, true, &[1]),
            Err(Error::TooLarge)
        );
        assert!(seal_chunk(&key(), &FILE, MAX_CHUNKS - 1, true, &[1]).is_ok());
    }

    #[test]
    fn more_bytes_than_the_largest_file_has_are_refused_as_they_come() {
        let file = FileRef {
            file_id: FILE,
            file_key: key(),
            sha256: Hash32::ZERO,
        };
        let mut decryptor = Decryptor::new(&file);
        let head = FileHead { file_id: FILE }.encode();
        assert_eq!(decryptor.update(&head), Ok(vec![]));
        decryptor.taken = MAX_STORED_LEN;
        assert_eq!(decryptor.update(&[0]), Err(Error::TooLarge));
        assert_eq!(decryptor.update(&[]), Err(Error::TooLarge));
    }
}
