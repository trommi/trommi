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

/// Reads `N` secret bytes from base64url. Text of another length than `N` bytes have is refused unread.
fn secret_from_base64url<const N: usize>(text: &str) -> Result<Secret<N>, Error> {
    if text.len() != (N * 4).div_ceil(3) {
        return Err(Error::BadFormat);
    }
    Secret::from_slice(&Zeroizing::new(ids::base64url_decode(text)?))
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
            file_id: FileId::from_base64url(file_id)?,
            file_key: secret_from_base64url(file_key)?,
            sha256: Hash32::from_base64url(sha256)?,
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
            share_id: ShareId::from_base64url(share_id)?,
            secret: secret_from_base64url(secret)?,
            file_key: secret_from_base64url(file_key)?,
            sha256: Hash32::from_base64url(sha256)?,
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
    let Ok(secret) = secret_from_base64url::<32>(presented) else {
        return Ok(false);
    };
    Ok(crypto::ct_eq(
        crypto::sha256(secret.expose())?.as_bytes(),
        secret_hash.as_bytes(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::SystemEntropy;

    const FILE: FileId = FileId::new([0xF1; 16]);

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
    fn the_nonce_is_three_zeros_the_chunk_number_and_the_final_mark() {
        assert_eq!(nonce(0, false), [0; 12]);
        assert_eq!(nonce(0, true), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
        assert_eq!(
            nonce(0x0102_0304_0506_0708, true),
            [0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 1]
        );
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
    fn chunks_of_a_shape_no_file_has_are_refused() {
        let full = vec![0u8; CHUNK_SIZE];
        assert_eq!(
            seal_chunk(&key(1), &FILE, 0, false, &full[1..]),
            Err(Error::BadFormat)
        );
        assert_eq!(
            seal_chunk(&key(1), &FILE, 0, false, &[]),
            Err(Error::BadFormat)
        );
        assert_eq!(
            seal_chunk(&key(1), &FILE, 1, true, &[]),
            Err(Error::BadFormat)
        );
        let long = vec![0u8; CHUNK_SIZE + 1];
        assert_eq!(
            seal_chunk(&key(1), &FILE, 0, true, &long),
            Err(Error::BadFormat)
        );
        assert_eq!(
            seal_chunk(&key(1), &FILE, MAX_CHUNKS, true, &[1]),
            Err(Error::TooLarge)
        );
        assert!(seal_chunk(&key(1), &FILE, MAX_CHUNKS - 1, true, &[1]).is_ok());

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
        assert!(
            ShareLink::create("http://localhost:5173", &file_ref(), &mut SystemEntropy).is_ok()
        );
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

        let presented =
            String::from_utf8(link.secret_base64url().expose().to_vec()).expect("utf-8");
        assert_eq!(share_secret_matches(&presented, &hash), Ok(true));

        let other = ShareLink::create("https://app.example.org", &file_ref(), &mut SystemEntropy)
            .expect("creates");
        let other_text =
            String::from_utf8(other.secret_base64url().expose().to_vec()).expect("utf-8");
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
}
