//! storage-file.mjs in Rust: the same files, so either connector can open a slot the other one wrote.
//!
//! `<prefix>state.json` (a snapshot) and `<prefix>state.log` (a journal: one JSON line per write, `[[key, value] | [key]]`),
//! both mode 0600, in a directory of mode 0700. A write returns once its line is appended and fsynced (write-ahead, R4).
//! When the journal outgrows the snapshot (and 1 MiB) the state is written whole (temp file, fsync, rename, directory
//! fsync) and the journal emptied. Opening reads the snapshot and replays the journal; a torn last line is cut off.
//!
//! The device key: a 66-byte key file (FORMAT.md section 4), or, when it was made with the OS keychain, a small key
//! file that names the keychain entry (`keychain.rs`); either way at the same path, so the slot logic is the same.
use crate::crypto::{self, Device};
use crate::error::{Result, ZError};
use serde_json::{Map, Value};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub struct FileStorage {
    pub dir: PathBuf,
    pub file: PathBuf,
    journal: PathBuf,
    key_file: Option<PathBuf>,
    prefix: String,
    inner: Mutex<Inner>,
}
struct Inner {
    map: Map<String, Value>,
    snapshot_bytes: usize,
    journal_bytes: usize,
    failed: Option<String>,
}

fn sync_dir(dir: &Path) {
    if let Ok(f) = fs::File::open(dir) {
        let _ = f.sync_all();
    }
}

impl FileStorage {
    pub fn open(dir: &Path, key_file: Option<&Path>, prefix: &str) -> Result<FileStorage> {
        fs::create_dir_all(dir)?;
        let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
        let file = dir.join(format!("{prefix}state.json"));
        let journal = dir.join(format!("{prefix}state.log"));
        let mut map = Map::new();
        let mut snapshot_bytes = 0;
        match fs::read_to_string(&file) {
            Ok(text) => {
                snapshot_bytes = text.len();
                if let Value::Object(m) = serde_json::from_str(&text)? {
                    map = m;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
        let mut journal_bytes = 0;
        match fs::read(&journal) {
            Ok(bytes) => {
                let mut good = 0usize;
                let mut at = 0usize;
                while let Some(off) = bytes[at..].iter().position(|b| *b == b'\n') {
                    let end = at + off;
                    let Ok(Value::Array(entries)) = serde_json::from_slice::<Value>(&bytes[at..end]) else { break };
                    for e in entries {
                        if let Value::Array(kv) = e {
                            if kv.len() > 1 {
                                if let Some(k) = kv[0].as_str() {
                                    map.insert(k.to_string(), kv[1].clone());
                                }
                            } else if let Some(k) = kv.first().and_then(|k| k.as_str()) {
                                map.remove(k);
                            }
                        }
                    }
                    good = end + 1;
                    at = end + 1;
                }
                if good < bytes.len() {
                    let f = OpenOptions::new().write(true).open(&journal)?;
                    f.set_len(good as u64)?;
                }
                journal_bytes = good;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
        Ok(FileStorage {
            dir: dir.to_path_buf(), file, journal, key_file: key_file.map(|p| p.to_path_buf()), prefix: prefix.into(),
            inner: Mutex::new(Inner { map, snapshot_bytes, journal_bytes, failed: None }),
        })
    }

    pub fn get(&self, key: &str) -> Option<Value> {
        self.inner.lock().unwrap().map.get(key).cloned()
    }
    pub fn set(&self, key: &str, value: Value) -> Result<()> {
        self.set_many(vec![(key.to_string(), Some(value))])
    }
    pub fn delete(&self, key: &str) -> Result<()> {
        self.set_many(vec![(key.to_string(), None)])
    }
    /// One journal line for all of them; None deletes.
    pub fn set_many(&self, entries: Vec<(String, Option<Value>)>) -> Result<()> {
        let mut inner = self.inner.lock().unwrap();
        let mut out = vec![];
        for (k, v) in entries {
            match v {
                None => {
                    inner.map.remove(&k);
                    out.push(Value::Array(vec![Value::String(k)]));
                }
                Some(v) => {
                    inner.map.insert(k.clone(), v.clone());
                    out.push(Value::Array(vec![Value::String(k), v]));
                }
            }
        }
        if out.is_empty() {
            return Ok(());
        }
        let line = serde_json::to_string(&Value::Array(out))? + "\n";
        self.write_now(&mut inner, &line)
    }
    fn write_now(&self, inner: &mut Inner, lines: &str) -> Result<()> {
        if let Some(f) = &inner.failed {
            return Err(ZError::new("storage-failed", f.clone()));
        }
        let fresh = inner.journal_bytes == 0;
        let res = (|| -> std::io::Result<()> {
            let mut f = OpenOptions::new().append(true).create(true).mode(0o600).open(&self.journal)?;
            f.write_all(lines.as_bytes())?;
            f.sync_all()?;
            Ok(())
        })();
        if let Err(e) = res {
            return Err(ZError::new("storage-failed", e.to_string()));
        }
        if fresh {
            sync_dir(&self.dir);
        }
        inner.journal_bytes += lines.len();
        if inner.journal_bytes > (1 << 20).max(inner.snapshot_bytes) {
            self.compact(inner)?;
        }
        Ok(())
    }
    fn compact(&self, inner: &mut Inner) -> Result<()> {
        let tmp = self.file.with_extension(format!("json.{}.tmp", std::process::id()));
        let text = serde_json::to_string(&Value::Object(inner.map.clone()))?;
        {
            let mut f = OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp)?;
            f.write_all(text.as_bytes())?;
            f.sync_all()?;
        }
        fs::rename(&tmp, &self.file)?;
        sync_dir(&self.dir);
        inner.snapshot_bytes = text.len();
        let f = OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&self.journal)?;
        f.sync_all()?;
        inner.journal_bytes = 0;
        Ok(())
    }
    pub fn keys(&self, prefix: &str) -> Vec<String> {
        let mut k: Vec<String> = self.inner.lock().unwrap().map.keys().filter(|k| k.starts_with(prefix)).cloned().collect();
        k.sort();
        k
    }
    /// Ordered [key, value] pairs under a prefix, between after/before (exclusive).
    pub fn range(&self, prefix: &str, after: Option<&str>, before: Option<&str>, limit: Option<usize>, reverse: bool) -> Vec<(String, Value)> {
        let inner = self.inner.lock().unwrap();
        let mut keys: Vec<&String> = inner.map.keys().filter(|k| k.starts_with(prefix) && after.is_none_or(|a| k.as_str() > a) && before.is_none_or(|b| k.as_str() < b)).collect();
        keys.sort();
        if reverse {
            keys.reverse();
        }
        if let Some(l) = limit {
            keys.truncate(l);
        }
        keys.into_iter().map(|k| (k.clone(), inner.map[k].clone())).collect()
    }
    fn key_path(&self, room_id: Option<&str>) -> PathBuf {
        let _ = room_id;
        self.key_file.clone().unwrap_or_else(|| self.dir.join(format!("{}device.key", self.prefix)))
    }
    /// Write the key file (0600): the 66 bytes, or a reference to the keychain entry that holds them.
    pub fn save_device(&self, device: &Device, room_id: Option<&str>, keychain: bool) -> Result<()> {
        let p = self.key_path(room_id);
        if let Some(d) = p.parent() {
            fs::create_dir_all(d)?;
        }
        let bytes = if keychain { crate::keychain::store(&crypto::export_device_secret(device))? } else { crypto::export_device_secret(device) };
        let tmp = PathBuf::from(format!("{}.{}.tmp", p.display(), std::process::id()));
        {
            let mut f = OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp)?;
            f.write_all(&bytes)?;
            f.sync_all()?;
        }
        fs::rename(&tmp, &p)?;
        self.set("device_key_file", Value::String(p.display().to_string()))
    }
    pub fn load_device(&self) -> Result<Option<Device>> {
        let p = self.get("device_key_file").and_then(|v| v.as_str().map(PathBuf::from)).unwrap_or_else(|| self.key_path(None));
        let bytes = match fs::read(&p) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        let st = fs::metadata(&p)?;
        if st.permissions().mode() & 0o077 != 0 {
            return Err(ZError::new("bad-key-file", format!("{} is readable by others (mode {:o}); chmod 600", p.display(), st.permissions().mode() & 0o777)));
        }
        let secret = if crate::keychain::is_reference(&bytes) { crate::keychain::load(&bytes)? } else { bytes };
        Ok(Some(crypto::import_device_secret(&secret)?))
    }
    pub fn flush(&self) {}
}
