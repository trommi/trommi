//! Files (section 11): chunked encryption piece by piece, so that a file never has to be in memory whole, the
//! layout of a stored file for `Range` reads, and Share links.

use crate::guard::Guarded;
use crate::CoreError;
use trommi_core::crypto::{Secret, SystemEntropy};
use trommi_core::files::{self, Decryptor, Encryptor, Layout};
use trommi_core::ids::{FileId, Hash32};

record! {
    /// What opens a stored file: the three fields of an attachment reference. They stand only in the encrypted
    /// body that names the file; `file_key` is a secret.
    secret pub struct FileRef {
        /// The file, 16 bytes: what it is uploaded and fetched under.
        pub file_id: Vec<u8>,
        /// The file's key, 32 bytes.
        pub file_key: Vec<u8>,
        /// The SHA-256 of the stored file, 32 bytes.
        pub sha256: Vec<u8>,
    }
}

impl FileRef {
    fn to_core(&self) -> Result<files::FileRef, CoreError> {
        Ok(files::FileRef {
            file_id: FileId::from_slice(&self.file_id)?,
            file_key: Secret::from_slice(&self.file_key)?,
            sha256: Hash32::from_slice(&self.sha256)?,
        })
    }
}

impl From<&files::FileRef> for FileRef {
    fn from(file: &files::FileRef) -> Self {
        Self {
            file_id: file.file_id.as_bytes().to_vec(),
            file_key: file.file_key.expose().to_vec(),
            sha256: file.sha256.as_bytes().to_vec(),
        }
    }
}

record! {
    /// The end of an encryption: the last stored bytes, and the reference with the file's key.
    pub struct FileEnd {
        /// The last bytes of the stored file.
        pub stored: Vec<u8>,
        /// The reference for the body that names the file.
        pub file: FileRef,
        /// The file's length in plaintext bytes.
        pub plain_len: u64,
        /// The file's length as stored.
        pub stored_len: u64,
    }
}

/// Encrypts one file piece by piece, under a key it makes for that file alone. Everything `update` and `finish`
/// return, in order, is the stored file. At most one chunk (64 KiB) of plaintext is held.
#[cfg_attr(feature = "uniffi", derive(uniffi::Object))]
pub struct FileEncryptor(Guarded<Encryptor>);

#[cfg_attr(feature = "uniffi", uniffi::export)]
impl FileEncryptor {
    /// Starts a new file: a fresh key and a fresh id.
    #[cfg_attr(feature = "uniffi", uniffi::constructor)]
    #[allow(clippy::new_without_default)]
    pub fn new() -> Result<Self, CoreError> {
        Ok(Self(Guarded::new(Encryptor::new(&mut SystemEntropy)?)))
    }

    /// The id of the file being made, 16 bytes: what it is uploaded under.
    pub fn file_id(&self) -> Result<Vec<u8>, CoreError> {
        self.0
            .run(|encryptor| Ok(encryptor.file_id().as_bytes().to_vec()))
    }

    /// Takes the next plaintext bytes and returns the stored bytes that are ready. `too-large` once the file
    /// would pass 64 MiB; nothing was taken then.
    pub fn update(&self, plaintext: Vec<u8>) -> Result<Vec<u8>, CoreError> {
        self.0.run(|encryptor| Ok(encryptor.update(&plaintext)?))
    }

    /// Gives the encryptor up without finishing: its key and what it holds of the file are wiped. After `finish`
    /// or `close` every call is refused with `internal`.
    pub fn close(&self) {
        self.0.close();
    }

    /// Ends the file. The encryptor is used up.
    pub fn finish(&self) -> Result<FileEnd, CoreError> {
        self.0.finish(|encryptor| {
            let (stored, sealed) = encryptor.finish()?;
            Ok(FileEnd {
                stored,
                file: FileRef::from(&sealed.file),
                plain_len: sealed.plain_len,
                stored_len: sealed.stored_len,
            })
        })
    }
}

/// Decrypts a stored file piece by piece. Each chunk is handed out once it opened; a file that was cut, extended
/// or reordered fails at the chunk concerned or in `finish`. **What `update` handed out counts only once
/// `finish` succeeded**: only the end can tell that the bytes are the file its reference names.
#[cfg_attr(feature = "uniffi", derive(uniffi::Object))]
pub struct FileDecryptor(Guarded<Decryptor>);

#[cfg_attr(feature = "uniffi", uniffi::export)]
impl FileDecryptor {
    /// Starts reading the file `file` names.
    #[cfg_attr(feature = "uniffi", uniffi::constructor)]
    pub fn new(file: FileRef) -> Result<Self, CoreError> {
        Ok(Self(Guarded::new(Decryptor::new(&file.to_core()?))))
    }

    /// Gives the decryptor up without finishing: its key and what it holds of the file are wiped. After `finish`
    /// or `close` every call is refused with `internal`.
    pub fn close(&self) {
        self.0.close();
    }

    /// Takes the next stored bytes and returns the plaintext of the chunks that opened.
    pub fn update(&self, stored: Vec<u8>) -> Result<Vec<u8>, CoreError> {
        self.0.run(|decryptor| Ok(decryptor.update(&stored)?))
    }

    /// Ends the file: the plaintext of the final chunk. `decrypt-failed` when the bytes taken are not the file
    /// the reference names. The decryptor is used up.
    pub fn finish(&self) -> Result<Vec<u8>, CoreError> {
        self.0.finish(|decryptor| Ok(decryptor.finish()?))
    }
}

record! {
    /// Where the chunks of one file lie in its stored form.
    pub struct FileLayout {
        /// How many chunks it has.
        pub chunks: u64,
        /// Its length in plaintext bytes.
        pub plain_len: u64,
        /// Its length as stored.
        pub stored_len: u64,
    }
}

impl From<Layout> for FileLayout {
    fn from(layout: Layout) -> Self {
        Self {
            chunks: layout.chunks(),
            plain_len: layout.plain_len(),
            stored_len: layout.stored_len(),
        }
    }
}

/// The layout of a stored file of `stored_len` bytes; `too-large` above the largest file, `bad-format` for a
/// length no stored file has.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn file_layout(stored_len: u64) -> Result<FileLayout, CoreError> {
    Ok(Layout::of_stored(stored_len)?.into())
}

record! {
    /// Where one chunk lies in a stored file: the bytes of a `Range` read.
    pub struct FileChunk {
        /// The offset of its first stored byte.
        pub offset: u64,
        /// How many stored bytes it has.
        pub length: u64,
        /// Whether it is the file's final chunk.
        pub last: bool,
    }
}

/// Where chunk `index` lies in a stored file of `stored_len` bytes; `not-found` for a chunk the file does not
/// have.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn file_chunk(stored_len: u64, index: u64) -> Result<FileChunk, CoreError> {
    let layout = Layout::of_stored(stored_len)?;
    let (offset, length) = layout
        .stored_range(index)
        .ok_or(trommi_core::Error::NotFound)?;
    Ok(FileChunk {
        offset,
        length,
        last: layout.is_last(index),
    })
}

/// Opens chunk `index` of the file `file_id` as read from the stored file (a `Range` read). `last` says whether
/// it is the file's final chunk, as [`file_chunk`] tells. `decrypt-failed` unless it is that chunk of that file
/// under that key, with that mark. A chunk opened this way is authenticated under the file key; that the whole
/// stored file is the one a reference names, only a whole download can tell.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn open_file_chunk(
    file_key: Vec<u8>,
    file_id: Vec<u8>,
    index: u64,
    last: bool,
    sealed: Vec<u8>,
) -> Result<Vec<u8>, CoreError> {
    let key = Secret::<32>::from_slice(&file_key)?;
    Ok(files::open_chunk(
        &key,
        &FileId::from_slice(&file_id)?,
        index,
        last,
        &sealed,
    )?)
}

record! {
    /// A Share link, taken apart. What stands behind its `#` never reaches a server: the browser presents
    /// `secret` to the hub in the header `x-share-secret` and decrypts with the key.
    secret pub struct ShareLink {
        /// The link as text. It holds the secret and the key: it is for the person to hand on, never for a log.
        pub text: String,
        /// The app's origin.
        pub app: String,
        /// What the hub knows the share by, 16 bytes.
        pub share_id: Vec<u8>,
        /// The secret as the header presents it: base64url text.
        pub secret: String,
        /// SHA-256 of the secret, 32 bytes: what the maker registers at the hub.
        pub secret_hash: Vec<u8>,
        /// The file's key, 32 bytes.
        pub file_key: Vec<u8>,
        /// The SHA-256 of the stored file, 32 bytes.
        pub sha256: Vec<u8>,
    }
}

fn text(bytes: &[u8]) -> Result<String, CoreError> {
    String::from_utf8(bytes.to_vec()).map_err(|_| CoreError::internal("text is not UTF-8"))
}

fn share_link(link: &files::ShareLink) -> Result<ShareLink, CoreError> {
    Ok(ShareLink {
        text: text(link.to_text().expose())?,
        app: link.app().to_owned(),
        share_id: link.share_id.as_bytes().to_vec(),
        secret: text(link.secret_base64url().expose())?,
        secret_hash: link.secret_hash()?.as_bytes().to_vec(),
        file_key: link.file_key.expose().to_vec(),
        sha256: link.sha256.as_bytes().to_vec(),
    })
}

/// A new Share link to the file `file` names, with a fresh share id and secret. `bad-format` unless `app` is a
/// canonical origin.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn share_link_create(app: String, file: FileRef) -> Result<ShareLink, CoreError> {
    share_link(&files::ShareLink::create(
        &app,
        &file.to_core()?,
        &mut SystemEntropy,
    )?)
}

/// The Share link `text` is; `bad-format` for anything but the exact form.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn share_link_parse(text: String) -> Result<ShareLink, CoreError> {
    share_link(&files::ShareLink::parse(&text)?)
}

/// Whether a Share link may be registered with this expiry: `bad-format` when it lies more than 180 days after
/// `now_ms`.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn check_share_expiry(expires_at: u64, now_ms: u64) -> Result<(), CoreError> {
    Ok(files::check_share_expiry(expires_at, now_ms)?)
}
