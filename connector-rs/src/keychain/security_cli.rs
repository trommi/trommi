//! The macOS login keychain through Apple's own `security` tool (`/usr/bin/security`), so the build needs no Apple
//! SDK (no Security.framework to link) and cross-compiles from Linux.
//!
//! The secret never goes on a command line (where `ps` shows it to every user): it is written as hex to the stdin of
//! `security -i`, which reads the `add-generic-password` command from there. Reading it back is
//! `find-generic-password -w`, whose stdout is a pipe of ours. Accounts and the service are checked to be
//! `[A-Za-z0-9-]` before they reach the command line or that stdin line, so nothing can be injected.
//!
//! The item's access list is the one `security` gives it: `security` itself may read it without a prompt. Any process
//! of the user can therefore read it through `security` once the keychain is unlocked, as with the Secret Service on
//! Linux or the key file; a binary that changes with every update would get a keychain prompt each time otherwise.
//!
//! Every call has a deadline; a `security` that does not answer in time (a locked keychain asking for a password) is
//! killed.
use crate::error::{Result, ZError};
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use zeroize::{Zeroize, Zeroizing};

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const SECURITY: &str = "/usr/bin/security";

fn err(msg: impl Into<String>) -> ZError {
    ZError::new("keychain", msg.into())
}

fn checked(name: &str) -> Result<()> {
    if name.is_empty() || name.len() > 64 || !name.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-') {
        return Err(err("keychain: bad account or service name"));
    }
    Ok(())
}

struct Out {
    code: Option<i32>,
    stdout: Zeroizing<Vec<u8>>,
    stderr: String,
}

/// Run `bin args`, with `input` on stdin, killed after `timeout`.
fn run(bin: &Path, args: &[&str], input: Option<&[u8]>, timeout: Duration) -> Result<Out> {
    let mut cmd = Command::new(bin);
    cmd.args(args).stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped());
    // (ETXTBSY: a script just written while another thread forks; only the tests write one)
    let mut tries = 0;
    let mut child = loop {
        match cmd.spawn() {
            Ok(c) => break c,
            Err(e) if e.raw_os_error() == Some(libc::ETXTBSY) && tries < 20 => {
                tries += 1;
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(e) => return Err(err(format!("{}: {e}", bin.display()))),
        }
    };
    if let Some(data) = input {
        let mut stdin = child.stdin.take().expect("piped stdin");
        let wrote = stdin.write_all(data);
        drop(stdin);
        if let Err(e) = wrote {
            let _ = child.kill();
            let _ = child.wait();
            return Err(err(format!("{}: {e}", bin.display())));
        }
    }
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(err("the keychain did not answer"));
            }
            Err(e) => return Err(err(e.to_string())),
        }
    };
    // (the outputs are a few hundred bytes: they fit the pipe, so reading after the exit cannot block)
    let mut stdout = Zeroizing::new(Vec::new());
    let mut stderr = Vec::new();
    if let Some(mut o) = child.stdout.take() {
        let _ = o.read_to_end(&mut stdout);
    }
    if let Some(mut e) = child.stderr.take() {
        let _ = e.read_to_end(&mut stderr);
    }
    Ok(Out { code: status.code(), stdout, stderr: String::from_utf8_lossy(&stderr).trim().to_string() })
}

fn failed(what: &str, out: &Out) -> ZError {
    let code = out.code.map(|c| c.to_string()).unwrap_or_else(|| "a signal".into());
    if out.stderr.is_empty() {
        err(format!("security {what}: exit {code}"))
    } else {
        err(format!("security {what}: {} (exit {code})", out.stderr))
    }
}

/// Store `secret` under (service, account), replacing an item that is there.
pub fn set(bin: &Path, service: &str, account: &str, secret: &[u8], timeout: Duration) -> Result<()> {
    checked(service)?;
    checked(account)?;
    let mut line = Zeroizing::new(format!("add-generic-password -U -a {account} -s {service} -w "));
    for b in secret {
        line.push_str(&format!("{b:02x}"));
    }
    line.push('\n');
    let started = Instant::now();
    let out = run(bin, &["-i"], Some(line.as_bytes()), timeout)?;
    if out.code != Some(0) || !out.stderr.is_empty() {
        return Err(failed("add-generic-password", &out));
    }
    // (`security -i` may exit 0 after a command failed: read it back)
    let back = get(bin, service, account, timeout.saturating_sub(started.elapsed()).max(Duration::from_millis(500)))?;
    if back.as_slice() != secret {
        return Err(err("security add-generic-password: the keychain gave back another secret"));
    }
    Ok(())
}

/// The secret under (service, account).
pub fn get(bin: &Path, service: &str, account: &str, timeout: Duration) -> Result<Zeroizing<Vec<u8>>> {
    checked(service)?;
    checked(account)?;
    let out = run(bin, &["find-generic-password", "-a", account, "-s", service, "-w"], None, timeout)?;
    if out.code != Some(0) {
        return Err(failed("find-generic-password", &out));
    }
    let text = out.stdout.trim_ascii();
    if text.is_empty() || text.len() % 2 != 0 {
        return Err(err("security find-generic-password: not a Trommi secret"));
    }
    let mut secret = Zeroizing::new(Vec::with_capacity(text.len() / 2));
    for pair in text.chunks(2) {
        let hi = (pair[0] as char).to_digit(16);
        let lo = (pair[1] as char).to_digit(16);
        match (hi, lo) {
            (Some(h), Some(l)) => secret.push((h * 16 + l) as u8),
            _ => {
                secret.zeroize();
                return Err(err("security find-generic-password: not a Trommi secret"));
            }
        }
    }
    Ok(secret)
}

/// Remove the item under (service, account).
pub fn delete(bin: &Path, service: &str, account: &str, timeout: Duration) -> Result<()> {
    checked(service)?;
    checked(account)?;
    let out = run(bin, &["delete-generic-password", "-a", account, "-s", service], None, timeout)?;
    if out.code != Some(0) {
        return Err(failed("delete-generic-password", &out));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;

    /// A stand-in for `security`: items are files in its folder; it logs its argv and every line read on stdin.
    const FAKE: &str = r#"#!/bin/sh
d=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
printf '%s\n' "$*" >> "$d/argv.log"
[ -f "$d/hang" ] && exec sleep 30
mkdir -p "$d/store"
one() {
  cmd=$1; shift; a=; s=; w=
  while [ $# -gt 0 ]; do
    case "$1" in
      -a) a=$2; shift 2 ;;
      -s) s=$2; shift 2 ;;
      -U) shift ;;
      -w) if [ "$cmd" = add-generic-password ]; then w=$2; shift 2; else shift; fi ;;
      *) echo "security: unknown option $1" >&2; return 2 ;;
    esac
  done
  f="$d/store/$s.$a"
  case "$cmd" in
    add-generic-password) [ -f "$d/refuse" ] && { echo "security: SecKeychainItemCreateFromContent: User interaction is not allowed." >&2; return 0; }; printf '%s' "$w" > "$f" ;;
    find-generic-password) [ -f "$f" ] || { echo "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain." >&2; return 44; }; cat "$f"; echo ;;
    delete-generic-password) [ -f "$f" ] || { echo "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain." >&2; return 44; }; rm "$f" ;;
    *) echo "security: unknown command $cmd" >&2; return 2 ;;
  esac
}
if [ "$1" = -i ]; then
  while IFS= read -r line; do printf '%s\n' "$line" >> "$d/stdin.log"; set -- $line; one "$@"; done
  exit 0
fi
one "$@"
"#;

    struct Fake {
        dir: PathBuf,
    }
    impl Fake {
        fn new() -> Fake {
            let dir = std::env::temp_dir().join(format!("trommi-security-{}", crate::crypto::random_hex(8)));
            std::fs::create_dir_all(&dir).unwrap();
            let bin = dir.join("security");
            std::fs::write(&bin, FAKE).unwrap();
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
            Fake { dir }
        }
        fn bin(&self) -> PathBuf {
            self.dir.join("security")
        }
        fn log(&self, name: &str) -> String {
            std::fs::read_to_string(self.dir.join(name)).unwrap_or_default()
        }
    }
    impl Drop for Fake {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }
    const T: Duration = Duration::from_secs(10);

    #[test]
    fn set_get_delete_round_trip() {
        let f = Fake::new();
        let secret: Vec<u8> = (0..66u8).map(|i| i.wrapping_mul(37) ^ 0xa5).collect();
        let hex: String = secret.iter().map(|b| format!("{b:02x}")).collect();
        set(&f.bin(), "trommi-connector", "0123abcd", &secret, T).unwrap();
        assert_eq!(get(&f.bin(), "trommi-connector", "0123abcd", T).unwrap().as_slice(), secret.as_slice());
        // the secret went through stdin, never through argv
        assert!(f.log("stdin.log").contains(&hex), "on stdin");
        assert!(f.log("stdin.log").starts_with("add-generic-password -U -a 0123abcd -s trommi-connector -w "));
        assert!(!f.log("argv.log").contains(&hex), "not in argv: {}", f.log("argv.log"));
        assert!(f.log("argv.log").lines().any(|l| l == "-i"));
        assert!(f.log("argv.log").lines().any(|l| l == "find-generic-password -a 0123abcd -s trommi-connector -w"));
        delete(&f.bin(), "trommi-connector", "0123abcd", T).unwrap();
        let e = get(&f.bin(), "trommi-connector", "0123abcd", T).unwrap_err();
        assert!(e.to_string().contains("could not be found"), "{e}");
        assert!(delete(&f.bin(), "trommi-connector", "0123abcd", T).is_err());
    }

    #[test]
    fn set_replaces() {
        let f = Fake::new();
        set(&f.bin(), "svc", "acc", b"one", T).unwrap();
        set(&f.bin(), "svc", "acc", b"two", T).unwrap();
        assert_eq!(get(&f.bin(), "svc", "acc", T).unwrap().as_slice(), b"two");
    }

    #[test]
    fn a_failed_add_is_an_error_even_with_exit_0() {
        let f = Fake::new();
        std::fs::write(f.dir.join("refuse"), "").unwrap();
        let e = set(&f.bin(), "svc", "acc", b"secret", T).unwrap_err();
        assert!(e.to_string().contains("User interaction is not allowed"), "{e}");
    }

    #[test]
    fn names_that_could_inject_are_refused_before_security_runs() {
        let f = Fake::new();
        for bad in ["", "a b", "a\nadd-generic-password", "a;b", "a -w", &"x".repeat(65)] {
            assert!(set(&f.bin(), "svc", bad, b"s", T).is_err(), "{bad:?}");
            assert!(get(&f.bin(), bad, "acc", T).is_err(), "{bad:?}");
            assert!(delete(&f.bin(), "svc", bad, T).is_err(), "{bad:?}");
        }
        assert_eq!(f.log("argv.log"), "", "security never ran");
    }

    #[test]
    fn what_is_not_hex_is_not_a_secret() {
        let f = Fake::new();
        std::fs::create_dir_all(f.dir.join("store")).unwrap();
        std::fs::write(f.dir.join("store/svc.acc"), "not hex!").unwrap();
        assert!(get(&f.bin(), "svc", "acc", T).is_err());
        std::fs::write(f.dir.join("store/svc.acc"), "abc").unwrap();
        assert!(get(&f.bin(), "svc", "acc", T).is_err());
    }

    #[test]
    fn a_security_that_hangs_is_killed_at_the_deadline() {
        let f = Fake::new();
        std::fs::write(f.dir.join("hang"), "").unwrap();
        let t0 = Instant::now();
        let e = get(&f.bin(), "svc", "acc", Duration::from_millis(300)).unwrap_err();
        assert!(e.to_string().contains("did not answer"), "{e}");
        assert!(t0.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn no_security_is_an_error() {
        assert!(get(Path::new("/nonexistent/security"), "svc", "acc", T).is_err());
    }
}
