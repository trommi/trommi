//! Device keys in the OS keychain (Secret Service on Linux, Keychain on macOS), with the key file as fallback.
//!
//! A key made with the keychain still has its key file at the slot's path (`<host>-<folder>-<slot>.key`, mode 0600),
//! so every rule about slots (which slot is keyed, putting a slot aside, the owner record) stays as it is; the file
//! then holds one line, `trommi-keychain v1 <account>`, naming the keychain entry (service `trommi-connector`) that
//! holds the 66-byte device secret. A key file with the 66 bytes themselves (every key the JS connector made, and
//! every key made where no keychain answers) is read as before.
//!
//! TROMMI_KEYSTORE: `keychain` (always; fail when none answers), `file` (never), `auto` (default: the keychain when
//! it answers a probe within two seconds, else the file; and always the file in a slot folder that has key files
//! with the secret in them: one shared with the JS connector, see use_keychain_in).
//!
//! Linux: the Secret Service (keyring crate). macOS: the login keychain through `/usr/bin/security` (security_cli.rs),
//! so the macOS build links no Apple framework and cross-compiles without Apple's SDK.
use crate::error::{Result, ZError};

pub const SERVICE: &str = "trommi-connector";
const PREFIX: &[u8] = b"trommi-keychain v1 ";

pub fn is_reference(bytes: &[u8]) -> bool {
    bytes.starts_with(PREFIX)
}

fn account_of(reference: &[u8]) -> Result<String> {
    let rest = std::str::from_utf8(&reference[PREFIX.len()..]).map_err(|_| ZError::new("bad-key-file", "keychain reference"))?.trim().to_string();
    if rest.is_empty() || rest.len() > 64 || !rest.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-') {
        return Err(ZError::new("bad-key-file", "keychain reference"));
    }
    Ok(rest)
}

#[cfg(any(target_os = "macos", test))]
mod security_cli;

/// The OS keychain: Secret Service through the keyring crate on Linux, `/usr/bin/security` on macOS.
#[cfg(all(feature = "keychain", target_os = "linux"))]
mod os {
    use crate::error::{Result, ZError};
    use std::time::Duration;

    /// Run a keychain call on a thread of its own (the Secret Service client must not run inside the async runtime).
    fn on_thread<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static, timeout: Duration) -> Result<T> {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(f());
        });
        rx.recv_timeout(timeout).map_err(|_| ZError::new("keychain", "the keychain did not answer"))?
    }

    fn entry(account: &str) -> Result<keyring::Entry> {
        keyring::Entry::new(super::SERVICE, account).map_err(|e| ZError::new("keychain", e.to_string()))
    }

    pub fn available() -> bool {
        std::env::var_os("DBUS_SESSION_BUS_ADDRESS").is_some()
    }

    pub fn set(account: &str, secret: &[u8], timeout: Duration) -> Result<()> {
        let (a, s) = (account.to_string(), secret.to_vec());
        on_thread(move || entry(&a)?.set_secret(&s).map_err(|e| ZError::new("keychain", e.to_string())), timeout)
    }

    pub fn get(account: &str, timeout: Duration) -> Result<Vec<u8>> {
        let a = account.to_string();
        on_thread(move || entry(&a)?.get_secret().map_err(|e| ZError::new("keychain", e.to_string())), timeout)
    }

    pub fn delete(account: &str, timeout: Duration) -> Result<()> {
        let a = account.to_string();
        on_thread(move || entry(&a)?.delete_credential().map_err(|e| ZError::new("keychain", e.to_string())), timeout)
    }
}

#[cfg(all(feature = "keychain", target_os = "macos"))]
mod os {
    use super::security_cli::{self as cli, SECURITY};
    use crate::error::Result;
    use std::path::Path;
    use std::time::Duration;

    pub fn available() -> bool {
        Path::new(SECURITY).exists()
    }

    pub fn set(account: &str, secret: &[u8], timeout: Duration) -> Result<()> {
        cli::set(Path::new(SECURITY), super::SERVICE, account, secret, timeout)
    }

    pub fn get(account: &str, timeout: Duration) -> Result<Vec<u8>> {
        cli::get(Path::new(SECURITY), super::SERVICE, account, timeout).map(|s| s.to_vec())
    }

    pub fn delete(account: &str, timeout: Duration) -> Result<()> {
        cli::delete(Path::new(SECURITY), super::SERVICE, account, timeout)
    }
}

#[cfg(not(all(feature = "keychain", any(target_os = "linux", target_os = "macos"))))]
mod os {
    use crate::error::{Result, ZError};
    use std::time::Duration;

    fn none<T>() -> Result<T> {
        Err(ZError::new("keychain", "this build has no keychain support"))
    }
    pub fn available() -> bool {
        false
    }
    pub fn set(_: &str, _: &[u8], _: Duration) -> Result<()> {
        none()
    }
    pub fn get(_: &str, _: Duration) -> Result<Vec<u8>> {
        none()
    }
    pub fn delete(_: &str, _: Duration) -> Result<()> {
        none()
    }
}


/// Store a device secret: returns the bytes of the key file that names it.
pub fn store(secret: &[u8]) -> Result<Vec<u8>> {
    let account = crate::crypto::random_hex(16);
    os::set(&account, secret, std::time::Duration::from_secs(30))?;
    let mut out = PREFIX.to_vec();
    out.extend_from_slice(account.as_bytes());
    out.push(b'\n');
    Ok(out)
}

/// The device secret a keychain reference names.
pub fn load(reference: &[u8]) -> Result<Vec<u8>> {
    let account = account_of(reference)?;
    os::get(&account, std::time::Duration::from_secs(30)).map_err(|e| ZError::new("keychain", format!("the key is not in the keychain ({})", e.message)))
}

/// Remove the keychain entry a reference names (tests; a slot put aside keeps its entry, as it keeps its file).
pub fn forget(reference: &[u8]) -> Result<()> {
    let account = account_of(reference)?;
    if !os::available() {
        return Ok(());
    }
    os::delete(&account, std::time::Duration::from_secs(10))
}

/// Whether new keys go into the keychain (TROMMI_KEYSTORE, default auto).
pub fn use_keychain() -> Result<bool> {
    let mode = std::env::var("TROMMI_KEYSTORE").unwrap_or_else(|_| "auto".into());
    match mode.as_str() {
        "file" => Ok(false),
        "keychain" => {
            if probe() {
                Ok(true)
            } else {
                Err(ZError::new("keychain", "TROMMI_KEYSTORE=keychain, but no keychain answered"))
            }
        }
        _ => Ok(probe()),
    }
}

/// Whether a new key in the room's slot folder `dir` goes into the keychain. In `auto` a folder that holds any key
/// file with the secret itself (made by the JS connector, which cannot read the keychain, or with `file`) stays with
/// key files: the folder is shared with a JS connector, and either connector may have to open any of its slots.
pub fn use_keychain_in(dir: &std::path::Path) -> Result<bool> {
    let mode = std::env::var("TROMMI_KEYSTORE").unwrap_or_else(|_| "auto".into());
    if mode != "file" && mode != "keychain" && shared_with_files(dir) {
        return Ok(false);
    }
    use_keychain()
}

/// Whether `dir` holds a key file (`*.key`, also put aside) that is not a keychain reference.
pub fn shared_with_files(dir: &std::path::Path) -> bool {
    let Ok(rd) = std::fs::read_dir(dir) else { return false };
    rd.flatten().any(|e| {
        let name = e.file_name().to_string_lossy().to_string();
        name.ends_with(".key") && std::fs::read(e.path()).map(|b| !is_reference(&b)).unwrap_or(false)
    })
}

/// A store, read and delete of a throwaway entry, within two seconds.
pub fn probe() -> bool {
    if !os::available() {
        return false;
    }
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let account = format!("probe-{}", crate::crypto::random_hex(4));
        let t = std::time::Duration::from_millis(2_000);
        let ok = os::set(&account, b"probe", t).is_ok() && os::get(&account, t).map(|s| s == b"probe").unwrap_or(false);
        let _ = os::delete(&account, t);
        let _ = tx.send(ok);
    });
    rx.recv_timeout(std::time::Duration::from_millis(2_000)).unwrap_or(false)
}
