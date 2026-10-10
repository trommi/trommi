//! What the updater may ask of the machine now that it is not root, and what is fixed on the server: the helper
//! that starts and stops the hub (hub/deploy/hub-ctl.sh) with the updater's client for it, the hub's pre-start
//! script that copies the database (hub/deploy/hub-prestart.sh), and the units as they are installed.
//!
//! What these tests cannot show is the separation of users itself (that needs root to set up): see the README.

use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use trommi_hub_updater::{HubCtl, Service};

fn deploy_file(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../hub/deploy")
        .join(name)
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "trommi-rights-{name}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A stand-in for `systemctl` that writes down what it was asked and fails when told to.
fn fake_systemctl(dir: &Path, fails: bool) -> String {
    let bin = dir.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let script = format!(
        "#!/bin/sh\necho \"$*\" >> '{}'\n{}",
        dir.join("asked").display(),
        if fails {
            "echo 'Job for trommi-hub.service failed because the control process exited with error code.' >&2\nexit 1\n"
        } else {
            "exit 0\n"
        }
    );
    std::fs::write(bin.join("systemctl"), script).unwrap();
    std::fs::set_permissions(
        bin.join("systemctl"),
        std::fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    format!("{}:{}", bin.display(), std::env::var("PATH").unwrap())
}

fn asked(dir: &Path) -> Vec<String> {
    std::fs::read_to_string(dir.join("asked"))
        .unwrap_or_default()
        .lines()
        // after a start the helper also asks whether the unit is up: a question, not an order
        .filter(|l| !l.starts_with("is-active "))
        .map(str::to_string)
        .collect()
}

/// One request to the helper, as systemd hands it a connection: the request on standard input, the answer out.
fn helper(path: &str, request: &[u8]) -> String {
    let mut child = Command::new("sh")
        .arg(deploy_file("hub-ctl.sh"))
        .env("PATH", path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(request).unwrap();
    let mut answer = String::new();
    child
        .stdout
        .take()
        .unwrap()
        .read_to_string(&mut answer)
        .unwrap();
    child.wait().unwrap();
    answer.trim().to_string()
}

#[test]
fn the_helper_starts_and_stops_the_hub_and_does_nothing_else() {
    let dir = scratch("ctl");
    let path = fake_systemctl(&dir, false);
    assert_eq!(helper(&path, b"start\n"), "ok");
    assert_eq!(helper(&path, b"stop\n"), "ok");
    assert_eq!(
        asked(&dir),
        ["start trommi-hub.service", "stop trommi-hub.service"]
    );

    // another unit, another verb, more words, an attempt at the shell, nothing at all: refused, and nothing is run
    for request in [
        &b"start trommi-hub-updater.service\n"[..],
        b"start ssh.service\n",
        b"restart\n",
        b"daemon-reload\n",
        b"enable\n",
        b"start; touch /tmp/x\n",
        b" start\n",
        b"START\n",
        b"$(reboot)\n",
        b"\n",
        b"",
    ] {
        let answer = helper(&path, request);
        assert!(
            answer.starts_with("failed: only start and stop"),
            "{request:?}: {answer}"
        );
    }
    assert_eq!(asked(&dir).len(), 2, "nothing more was asked of systemd");
    // only the first line counts
    assert_eq!(helper(&path, b"stop\nstart ssh.service\n"), "ok");
    assert_eq!(asked(&dir).last().unwrap(), "stop trommi-hub.service");

    // a failure of systemd comes back as words, not as silence
    let dir = scratch("ctl-fails");
    let path = fake_systemctl(&dir, true);
    let answer = helper(&path, b"start\n");
    assert!(
        answer.starts_with("failed: Job for trommi-hub.service failed"),
        "{answer}"
    );
    let _ = std::fs::remove_dir_all(dir);
}

/// The helper behind a socket, as on the server: every connection gets one run of the script.
fn helper_socket(dir: &Path, path: String) -> PathBuf {
    let socket = dir.join("ctl.sock");
    let listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let out = stream.try_clone().unwrap();
            let _ = Command::new("sh")
                .arg(deploy_file("hub-ctl.sh"))
                .env("PATH", &path)
                .stdin(Stdio::from(std::os::fd::OwnedFd::from(stream)))
                .stdout(Stdio::from(std::os::fd::OwnedFd::from(out)))
                .status();
        }
    });
    socket
}

#[test]
fn the_updater_reaches_the_hub_only_through_the_helper() {
    let dir = scratch("client");
    let socket = helper_socket(&dir, fake_systemctl(&dir, false));
    let ctl = HubCtl { socket };
    ctl.stop().unwrap();
    ctl.start().unwrap();
    assert_eq!(
        asked(&dir),
        ["stop trommi-hub.service", "start trommi-hub.service"]
    );

    let failing = scratch("client-fails");
    let socket = helper_socket(&failing, fake_systemctl(&failing, true));
    let error = HubCtl { socket }.start().unwrap_err();
    assert!(
        error.contains("failed: Job for trommi-hub.service failed"),
        "{error}"
    );

    // no helper there (or a socket that is not the updater's to open): an error, not a hang
    let error = HubCtl {
        socket: dir.join("none.sock"),
    }
    .start()
    .unwrap_err();
    assert!(error.contains("hub helper"), "{error}");

    // the program has no other way: it runs no systemctl and nothing as another user
    for file in ["lib.rs", "main.rs"] {
        let source = std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../hub/updater/src")
                .join(file),
        )
        .unwrap();
        for word in [
            "\"systemctl\"",
            "\"sudo\"",
            "\"pkexec\"",
            "\"runuser\"",
            "daemon-reload",
        ] {
            assert!(!source.contains(word), "{file} names {word}");
        }
    }
    let _ = std::fs::remove_dir_all(dir);
    let _ = std::fs::remove_dir_all(failing);
}

// ---- the copy of the database, made by the hub's unit ----

struct Hub {
    dir: PathBuf,
}

impl Hub {
    fn new(name: &str) -> Hub {
        let dir = scratch(name);
        for sub in ["deploy/releases", "data/files", "backups", "run"] {
            std::fs::create_dir_all(dir.join(sub)).unwrap();
        }
        for (file, bytes) in [
            ("hub.db", "database"),
            ("hub.db-wal", "wal"),
            ("hub.db-shm", "shm"),
            ("vapid.key", "key"),
            ("files/upload", "a file"),
        ] {
            std::fs::write(dir.join("data").join(file), bytes).unwrap();
        }
        Hub { dir }
    }

    fn current(&self, target: &str) {
        let link = self.dir.join("deploy/current");
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink(target, link).unwrap();
    }

    fn prestart(&self) -> bool {
        Command::new("sh")
            .arg(deploy_file("hub-prestart.sh"))
            .args([
                self.dir.join("deploy"),
                self.dir.join("data"),
                self.dir.join("backups"),
                self.dir.join("run"),
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .success()
    }

    fn copies(&self) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(self.dir.join("backups"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .filter(|n| n.starts_with("before-"))
            .collect();
        names.sort();
        names
    }
}

impl Drop for Hub {
    fn drop(&mut self) {
        let _ = std::fs::set_permissions(
            self.dir.join("backups"),
            std::fs::Permissions::from_mode(0o700),
        );
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[test]
fn the_database_is_copied_before_another_release_starts() {
    let hub = Hub::new("copy");
    hub.current("releases/hub-v5");
    assert!(hub.prestart());
    let copies = hub.copies();
    assert_eq!(copies.len(), 1);
    assert!(copies[0].starts_with("before-hub-v5-"), "{copies:?}");
    let copy = hub.dir.join("backups").join(&copies[0]);
    for (file, bytes) in [
        ("hub.db", "database"),
        ("hub.db-wal", "wal"),
        ("hub.db-shm", "shm"),
        ("vapid.key", "key"),
    ] {
        assert_eq!(std::fs::read_to_string(copy.join(file)).unwrap(), bytes);
        assert_eq!(
            std::fs::metadata(copy.join(file))
                .unwrap()
                .permissions()
                .mode()
                & 0o077,
            0,
            "{file} is the hub's alone"
        );
    }
    assert!(
        !copy.join("files").exists() && !copy.join("upload").exists(),
        "not the files people uploaded"
    );

    // the same release again (a restart, a reboot, a crash): no further copy
    assert!(hub.prestart());
    assert!(hub.prestart());
    assert_eq!(hub.copies().len(), 1);

    // another release, also the one before coming back: one copy each; the three newest stay
    for release in ["hub-v6", "hub-v5", "hub-v7", "hub-v8"] {
        std::thread::sleep(std::time::Duration::from_millis(1100));
        hub.current(&format!("releases/{release}"));
        assert!(hub.prestart());
    }
    let copies = hub.copies();
    assert_eq!(copies.len(), 3, "{copies:?}");
    assert!(copies.iter().any(|c| c.starts_with("before-hub-v8-")));
    assert!(!copies.iter().any(|c| c.starts_with("before-hub-v6-")));

    // a link that names no release: nothing is copied, nothing fails (the hub will not start anyway)
    for odd in [
        "../../etc",
        "releases/hub-v9; touch x",
        "releases/hub-v",
        "releases/connector-v3",
        "releases/hub-v1x",
    ] {
        hub.current(odd);
        assert!(hub.prestart(), "{odd}");
    }
    assert_eq!(hub.copies().len(), 3);
}

#[test]
fn a_copy_that_fails_stops_the_first_start_of_that_release_and_only_that() {
    let hub = Hub::new("copyfails");
    hub.current("releases/hub-v5");
    assert!(hub.prestart());
    // no room for a copy (here: the folder cannot be written)
    std::fs::set_permissions(
        hub.dir.join("backups"),
        std::fs::Permissions::from_mode(0o500),
    )
    .unwrap();
    if std::fs::write(hub.dir.join("backups/probe"), b"").is_ok() {
        return; // run as root: the folder cannot be closed this way
    }
    hub.current("releases/hub-v6");
    assert!(
        !hub.prestart(),
        "a new release does not start on data that could not be copied"
    );
    // the updater puts hub-v5 back: no copy is due for it, it starts
    hub.current("releases/hub-v5");
    assert!(hub.prestart());
    // hub-v6 once more: it starts without a copy rather than never
    hub.current("releases/hub-v6");
    assert!(hub.prestart());
    assert_eq!(hub.copies().len(), 1);
    // with room again the copy is made and the note of the failure goes
    std::fs::set_permissions(
        hub.dir.join("backups"),
        std::fs::Permissions::from_mode(0o700),
    )
    .unwrap();
    assert!(hub.prestart());
    assert_eq!(hub.copies().len(), 2);
    assert!(!hub.dir.join("run/copy-failed").exists());
    // the release before coming back (a rollback) starts whether or not a copy can be made
    std::fs::set_permissions(
        hub.dir.join("backups"),
        std::fs::Permissions::from_mode(0o500),
    )
    .unwrap();
    hub.current("releases/hub-v5");
    assert!(hub.prestart());
    assert!(hub.prestart());
}

// ---- the units as they are installed ----

fn unit(name: &str) -> Vec<String> {
    std::fs::read_to_string(deploy_file(name))
        .unwrap()
        .lines()
        .filter(|l| !l.starts_with('#') && !l.is_empty())
        .map(str::to_string)
        .collect()
}

fn values<'a>(lines: &'a [String], key: &str) -> Vec<&'a str> {
    lines
        .iter()
        .filter_map(|l| l.strip_prefix(key).and_then(|r| r.strip_prefix('=')))
        .collect()
}

#[test]
fn neither_the_updater_nor_the_hub_is_root_and_each_writes_only_its_own() {
    let updater = unit("trommi-hub-updater.service");
    assert_eq!(values(&updater, "User"), ["trommi-updater"]);
    assert_eq!(values(&updater, "ReadWritePaths"), ["/srv/trommi/deploy"]);
    assert_eq!(
        values(&updater, "ExecStart"),
        ["/srv/trommi/deploy/updater/trommi-hub-updater serve"]
    );
    let hub = unit("trommi-hub.service");
    assert_eq!(values(&hub, "User"), ["trommi"]);
    assert_eq!(
        values(&hub, "ReadWritePaths"),
        ["/srv/trommi/data /srv/trommi/backups"]
    );
    assert!(values(&hub, "ExecStart")[0].ends_with(" /srv/trommi/deploy/current/trommi-hub"));
    for lines in [&updater, &hub] {
        assert_eq!(values(lines, "NoNewPrivileges"), ["yes"]);
        assert_eq!(
            values(lines, "CapabilityBoundingSet"),
            [""],
            "no capability at all"
        );
        assert_eq!(values(lines, "AmbientCapabilities"), [""]);
        assert_eq!(values(lines, "ProtectSystem"), ["strict"]);
        assert_eq!(values(lines, "RestrictSUIDSGID"), ["yes"]);
        // nothing is run with the `+` or `!` that would lift the user
        for key in ["ExecStart", "ExecStartPre", "ExecStartPost", "ExecStop"] {
            for value in values(lines, key) {
                assert!(
                    !value.trim_start_matches('-').starts_with(['+', '!']),
                    "{key}={value}"
                );
            }
        }
    }
    // the one piece that is root: the helper, reachable by the updater's user alone, running one fixed script
    let socket = unit("trommi-hub-ctl.socket");
    assert_eq!(values(&socket, "SocketUser"), ["trommi-updater"]);
    assert_eq!(values(&socket, "SocketMode"), ["0600"]);
    assert_eq!(values(&socket, "Accept"), ["yes"]);
    let helper = unit("trommi-hub-ctl@.service");
    assert_eq!(
        values(&helper, "ExecStart"),
        ["/bin/sh /usr/local/lib/trommi/hub-ctl.sh"]
    );
    assert!(values(&helper, "User").is_empty());
    // what a release brings is two programs: no unit, no script
    let build = std::fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../.github/workflows/build.yml"),
    )
    .unwrap();
    assert!(!build.contains("out/trommi-hub.service"));
}
