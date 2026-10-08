//! Encrypted attachment bytes as files, <HUB_DATA>/attachments/<room_id>/<attachment_id> (hub/attachments.mjs).

use std::io::Write;
use std::path::{Path, PathBuf};

pub struct Files {
    pub dir: PathBuf,
}

pub enum PutError {
    TooLarge,
    Replay,
    Io(std::io::Error),
    Cut,
}

fn hexish(s: &str) -> bool { !s.is_empty() && s.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f')) }

impl Files {
    pub fn new(dir: PathBuf) -> std::io::Result<Files> {
        std::fs::create_dir_all(&dir)?;
        Ok(Files { dir })
    }
    pub fn file_of(&self, room: &str, id: &str) -> Option<PathBuf> {
        if !hexish(room) || !hexish(id) {
            return None;
        }
        Some(self.dir.join(room).join(id))
    }
    /// A temporary file next to the target, written once (create_new, 0600).
    pub fn begin(&self, room: &str, id: &str) -> Result<(PathBuf, PathBuf, std::fs::File), PutError> {
        let file = self.file_of(room, id).ok_or_else(|| PutError::Io(std::io::Error::other("bad id")))?;
        std::fs::create_dir_all(file.parent().unwrap()).map_err(PutError::Io)?;
        if file.exists() {
            return Err(PutError::Replay);
        }
        let tmp = PathBuf::from(format!("{}.part-{}-{}", file.display(), std::process::id(), zcrypto::hex(&crate::util::random_bytes(6))));
        let mut o = std::fs::OpenOptions::new();
        o.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            o.mode(0o600);
        }
        let f = o.open(&tmp).map_err(PutError::Io)?;
        Ok((file, tmp, f))
    }
    /// Link the finished temporary file into place (fails if someone stored it meanwhile), then remove it.
    pub fn finish(file: &Path, tmp: &Path, mut f: std::fs::File) -> Result<(), PutError> {
        f.flush().map_err(PutError::Io)?;
        drop(f);
        let r = std::fs::hard_link(tmp, file);
        let _ = std::fs::remove_file(tmp);
        match r {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Err(PutError::Replay),
            Err(e) => Err(PutError::Io(e)),
        }
    }
    pub fn delete(&self, room: &str, id: &str) {
        if let Some(f) = self.file_of(room, id) {
            let _ = std::fs::remove_file(f);
        }
    }
    pub fn remove_room(&self, room: &str) {
        if hexish(room) {
            let _ = std::fs::remove_dir_all(self.dir.join(room));
        }
    }
}
