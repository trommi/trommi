//! `spec/vectors/files.json`: an empty, a small and a two-chunk file as stored, what a reader refuses of
//! them, and a Share link (section 11).

use serde_json::{json, Value};
use trommi_core::crypto::{self, Entropy, Secret};
use trommi_core::files::{
    decrypt_file, encrypt_file, FileRef, Layout, ShareLink, CHUNK_SIZE, HEAD_LEN, SEALED_CHUNK_LEN,
};
use trommi_core::ids::{FileId, Hash32};
use trommi_core::Error;

use super::{entropy, hex};

/// The name of the file.
pub const NAME: &str = "files";
/// The app's origin in the Share link.
pub const APP: &str = "https://app.example.org";

/// The plaintext of a file of `len` bytes: byte `i` is `(i mod 251) xor (i >> 16)`, so that the chunks differ.
pub fn plaintext(len: usize) -> Vec<u8> {
    (0..len)
        .map(|i| (i % 251) as u8 ^ (i >> 16) as u8)
        .collect()
}

/// The lengths of the three files: empty, small, and one byte more than a chunk and nine.
pub const LENGTHS: [(&str, usize); 3] = [
    ("an empty file", 0),
    ("a small file", 300),
    ("a file of two chunks", CHUNK_SIZE + 9),
];

fn reference(file: &FileRef, sha256: &Hash32) -> Value {
    json!({
        "file_id": hex(file.file_id.as_bytes()),
        "file_key": hex(file.file_key.expose()),
        "sha256": hex(sha256.as_bytes()),
    })
}

/// A stored file that a reader refuses: its reference, the stored bytes, and the code. `cut_to` says that the
/// stored bytes are the first so many of the file of two chunks, which the file then does not repeat.
struct Refused {
    why: &'static str,
    reference: Value,
    stored: Vec<u8>,
    cut_to: Option<usize>,
    code: Error,
}

fn refused(small: &(Vec<u8>, FileRef), two: &(Vec<u8>, FileRef)) -> Result<Vec<Refused>, Error> {
    let own = |stored: &[u8], file: &FileRef| -> Result<Value, Error> {
        Ok(reference(file, &crypto::sha256(stored)?))
    };
    let (stored, file) = small;
    let mut flipped = stored.clone();
    if let Some(byte) = flipped.get_mut(HEAD_LEN + 5) {
        *byte ^= 1;
    }
    let (long, of_two) = two;
    let boundary = long
        .get(..HEAD_LEN + SEALED_CHUNK_LEN)
        .ok_or(Error::Internal("two chunks"))?;
    let within = long
        .get(..HEAD_LEN + SEALED_CHUNK_LEN + 4)
        .ok_or(Error::Internal("two chunks"))?;
    let mut longer = stored.clone();
    longer.push(0);
    let mut other_head = stored.clone();
    if let Some(byte) = other_head.get_mut(1) {
        *byte ^= 1;
    }
    let mut newer = stored.clone();
    if let Some(version) = newer.first_mut() {
        *version = 3;
    }
    Ok(vec![
        Refused {
            why: "the reference names another hash than the stored file has",
            reference: reference(file, &Hash32::new([0x11; 32])),
            stored: stored.clone(),
            cut_to: None,
            code: Error::DecryptFailed,
        },
        Refused {
            why: "a changed byte in the stored file, under the hash of the file as it was",
            reference: reference(file, &file.sha256),
            stored: flipped.clone(),
            cut_to: None,
            code: Error::DecryptFailed,
        },
        Refused {
            why: "a changed byte in a chunk, under the hash of the changed file",
            reference: own(&flipped, file)?,
            stored: flipped,
            cut_to: None,
            code: Error::DecryptFailed,
        },
        Refused {
            why: "the file of two chunks cut at the chunk boundary, under the hash of what is left: no final mark",
            reference: own(boundary, of_two)?,
            stored: boundary.to_vec(),
            cut_to: Some(boundary.len()),
            code: Error::DecryptFailed,
        },
        Refused {
            why: "the file of two chunks cut within its second chunk, under the hash of what is left",
            reference: own(within, of_two)?,
            stored: within.to_vec(),
            cut_to: Some(within.len()),
            code: Error::BadFormat,
        },
        Refused {
            why: "a byte behind the final chunk, under the hash of the longer file",
            reference: own(&longer, file)?,
            stored: longer,
            cut_to: None,
            code: Error::DecryptFailed,
        },
        Refused {
            why: "the head of another file id, under the hash of the changed file",
            reference: own(&other_head, file)?,
            stored: other_head,
            cut_to: None,
            code: Error::DecryptFailed,
        },
        Refused {
            why: "a head of version 3, under the hash of the changed file",
            reference: own(&newer, file)?,
            stored: newer,
            cut_to: None,
            code: Error::NewerVersion,
        },
        Refused {
            why: "no chunk behind the head",
            reference: own(stored.get(..HEAD_LEN).unwrap_or_default(), file)?,
            stored: stored.get(..HEAD_LEN).unwrap_or_default().to_vec(),
            cut_to: None,
            code: Error::BadFormat,
        },
    ])
}

/// The reference a case states, read back.
pub fn reference_of(value: &Value) -> Option<FileRef> {
    let bytes = |name: &str| super::unhex(value[name].as_str()?);
    Some(FileRef {
        file_id: FileId::from_slice(&bytes("file_id")?).ok()?,
        file_key: Secret::from_slice(&bytes("file_key")?).ok()?,
        sha256: Hash32::from_slice(&bytes("sha256")?).ok()?,
    })
}

fn decrypt_file_of(reference: &Value, stored: &[u8]) -> Result<Vec<u8>, Error> {
    let file = reference_of(reference).ok_or(Error::Internal("a reference"))?;
    decrypt_file(&file, stored)
}

fn made(len: usize, entropy: &mut dyn Entropy) -> Result<(Vec<u8>, FileRef), Error> {
    let (stored, sealed) = encrypt_file(&plaintext(len), entropy)?;
    Ok((stored, sealed.file))
}

/// Makes the file.
pub fn generate() -> Result<Value, Error> {
    let mut entropy = entropy(NAME)?;
    let mut files = Vec::new();
    let mut kept = Vec::new();
    for (what, len) in LENGTHS {
        let (stored, file) = made(len, &mut entropy)?;
        let layout = Layout::of_stored(stored.len() as u64)?;
        let mut entry = reference(&file, &file.sha256);
        if let Some(entry) = entry.as_object_mut() {
            entry.insert("what".into(), what.into());
            entry.insert("plain_len".into(), len.into());
            entry.insert(
                "plaintext_sha256".into(),
                hex(crypto::sha256(&plaintext(len))?.as_bytes()).into(),
            );
            entry.insert("stored_len".into(), stored.len().into());
            entry.insert("chunks".into(), layout.chunks().into());
            entry.insert("stored".into(), hex(&stored).into());
        }
        files.push(entry);
        kept.push((stored, file));
    }
    let [_, small, two] = kept.as_slice() else {
        return Err(Error::Internal("three files"));
    };
    let share = ShareLink::create(APP, &small.1, &mut entropy)?;
    let link = String::from_utf8(share.to_text().expose().to_vec())
        .map_err(|_| Error::Internal("vector text"))?;
    Ok(json!({
        "about": "Files and Share links (spec/v2.md section 11). files: three files as stored, FileHead and chunks (hex), each with the three fields of its attachment reference (file_id, file_key, sha256 of the stored file), its length and the SHA-256 of its plaintext; the plaintext of a file is byte i = (i mod 251) xor (i >> 16). refused: a reference and stored bytes that a whole download does not decrypt to a file, with the code; where the stored bytes are the file of two chunks cut short, their number stands instead of the bytes. share_link: a link to the small file, its parts, and the SHA-256 of the secret, which is what the hub is given.",
        "files": files,
        "refused": refused(small, two)?.iter().map(|case| {
            debug_assert_eq!(decrypt_file_of(&case.reference, &case.stored).err(), Some(case.code.clone()));
            match case.cut_to {
                Some(len) => json!({
                    "why": case.why,
                    "reference": case.reference,
                    "stored_is_the_first_bytes_of_the_file_of_two_chunks": len,
                    "code": case.code.code(),
                }),
                None => json!({
                    "why": case.why,
                    "reference": case.reference,
                    "stored": hex(&case.stored),
                    "code": case.code.code(),
                }),
            }
        }).collect::<Vec<_>>(),
        "share_link": {
            "app": APP,
            "file_id": hex(small.1.file_id.as_bytes()),
            "share_id": hex(share.share_id.as_bytes()),
            "secret": hex(share.secret.expose()),
            "file_key": hex(share.file_key.expose()),
            "sha256": hex(share.sha256.as_bytes()),
            "secret_sha256": hex(share.secret_hash()?.as_bytes()),
            "link": link,
        },
    }))
}
