//! `trommi-hub-updater` serves the deploy endpoint on the tailnet address (under systemd).
//! `trommi-hub-updater deploy hub-v123` and `trommi-hub-updater status` are for root on the server: the same steps,
//! the same lock, the same checks of signature, content and version.
//!
//! Configuration by environment (`/etc/trommi/updater.env`):
//!
//! | name | default | |
//! |---|---|---|
//! | `UPDATER_LISTEN` | none | the tailnet address and port, e.g. `100.101.102.103:9443`; anything outside the tailnet's ranges is refused |
//! | `UPDATER_REPOSITORY` | `trommi/trommi` | where releases come from |
//! | `UPDATER_PUBLIC_KEY` | `/etc/trommi/release-public-key.pem` | the pinned public half of the release signing key |
//! | `UPDATER_TARGET` | this machine's, `…-unknown-linux-musl` | which binary of a release is this server's |
//! | `UPDATER_ROOT` | `/srv/trommi` | releases, links, state, backups |
//! | `UPDATER_DATA` | `<root>/data` | the hub's data directory |
//! | `UPDATER_UNIT` | `trommi-hub.service` | the unit that is stopped and started |
//! | `UPDATER_HEALTH_URL` | `http://127.0.0.1:8790/healthz` | |
//! | `UPDATER_HEALTH_SECONDS` | `60` | how long a new hub has to become well |
//! | `UPDATER_UPDATER_UNIT` | `trommi-hub-updater.service` | this program's own unit (restarted after `deploy` on the command line brought a new updater) |
//! | `UPDATER_CALLER_TAGS` | `tag:trommi-ci` | tailnet tags whose devices may call |
//! | `UPDATER_CALLER_USERS` | none | tailnet logins whose own (untagged) devices may call: the owner |

#![forbid(unsafe_code)]

use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use trommi_hub_updater::{log, public_key, serve, Config, Systemd, Tailnet, Updater};

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

/// Tailscale's address ranges: 100.64.0.0/10 and fd7a:115c:a1e0::/48.
fn on_tailnet(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.octets()[0] == 100 && (v4.octets()[1] & 0xc0) == 64,
        IpAddr::V6(v6) => v6.segments()[..3] == [0xfd7a, 0x115c, 0xa1e0],
    }
}

fn config() -> Result<(Config, String), String> {
    let root = PathBuf::from(env("UPDATER_ROOT").unwrap_or_else(|| "/srv/trommi".into()));
    let key_path =
        env("UPDATER_PUBLIC_KEY").unwrap_or_else(|| "/etc/trommi/release-public-key.pem".into());
    let key = public_key(
        &std::fs::read_to_string(&key_path).map_err(|e| format!("{key_path}: {e}"))?,
    )
    .map_err(|e| format!("{key_path}: {e}"))?;
    let seconds = env("UPDATER_HEALTH_SECONDS")
        .and_then(|v| v.parse().ok())
        .unwrap_or(60);
    let cfg = Config {
        repository: env("UPDATER_REPOSITORY").unwrap_or_else(|| "trommi/trommi".into()),
        api: "https://api.github.com".into(),
        key,
        target: env("UPDATER_TARGET")
            .unwrap_or_else(|| format!("{}-unknown-linux-musl", std::env::consts::ARCH)),
        data: env("UPDATER_DATA").map_or_else(|| root.join("data"), PathBuf::from),
        root,
        health_url: env("UPDATER_HEALTH_URL")
            .unwrap_or_else(|| "http://127.0.0.1:8790/healthz".into()),
        health_wait: Duration::from_secs(seconds),
        health_every: Duration::from_secs(1),
        lock_wait: Duration::from_secs(600),
    };
    let unit = env("UPDATER_UNIT").unwrap_or_else(|| "trommi-hub.service".into());
    Ok((cfg, unit))
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (cfg, unit) = match config() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("cannot start: {e}");
            std::process::exit(1);
        }
    };
    let updater = match Updater::new(cfg, Arc::new(Systemd { unit })) {
        Ok(u) => u,
        Err(e) => {
            eprintln!("cannot start: {e}");
            std::process::exit(1);
        }
    };
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .worker_threads(2)
        .build()
        .expect("the runtime");
    let code = runtime.block_on(async {
        match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
            [] | ["serve"] => run(updater).await,
            ["status"] => {
                println!("{:#}", updater.status().await);
                0
            }
            ["deploy", tag] => {
                let outcome = updater.deploy(tag).await;
                println!("{:#}", serde_json::to_value(&outcome).expect("an outcome"));
                if updater.replaced() {
                    // the serving updater is the old program: let systemd start the one now in place
                    let unit = env("UPDATER_UPDATER_UNIT")
                        .unwrap_or_else(|| "trommi-hub-updater.service".into());
                    let restarted = trommi_hub_updater::run(
                        "systemctl",
                        &["try-restart", "--no-block", &unit],
                        Duration::from_secs(30),
                    );
                    if let Err(e) = restarted {
                        eprintln!("the new updater is in place but was not started: {e}");
                    }
                }
                i32::from(!outcome.ok)
            }
            _ => {
                eprintln!("usage: trommi-hub-updater [serve | status | deploy hub-v<N>]");
                2
            }
        }
    });
    std::process::exit(code);
}

async fn run(updater: Arc<Updater>) -> i32 {
    let Some(listen) = env("UPDATER_LISTEN").and_then(|v| v.parse::<SocketAddr>().ok()) else {
        eprintln!("cannot start: UPDATER_LISTEN must be an address and a port");
        return 1;
    };
    if !on_tailnet(listen.ip()) {
        eprintln!("cannot start: {listen} is not a tailnet address; the endpoint listens nowhere else");
        return 1;
    }
    // First of all, before the tailnet is needed: a deploy that was cut off is settled and the hub is started.
    // The hub is not started at boot by itself, so that a release whose health was never known does not serve.
    updater.recover().await;
    // The tailnet address may not be there yet (boot, Tailscale updating itself): wait for it rather than end,
    // so that a new updater on trial is not taken for broken. systemd ends a start that takes too long.
    let listener = loop {
        match tokio::net::TcpListener::bind(listen).await {
            Ok(l) => break l,
            Err(e) if e.kind() == std::io::ErrorKind::AddrNotAvailable => {
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
            Err(e) => {
                eprintln!("cannot listen on {listen}: {e}");
                return 1;
            }
        }
    };
    let list = |name: &str, default: &str| -> Vec<String> {
        std::env::var(name)
            .unwrap_or_else(|_| default.to_string())
            .split(',')
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .collect()
    };
    let callers = Tailnet {
        tags: list("UPDATER_CALLER_TAGS", "tag:trommi-ci"),
        users: list("UPDATER_CALLER_USERS", ""),
    };
    log(
        "listening",
        json!({ "on": listen.to_string(), "repository": updater.cfg.repository, "target": updater.cfg.target,
                "caller_tags": callers.tags, "caller_users": callers.users }),
    );
    // up: a trial of this program ends here, and systemd is told
    updater.confirm();
    notify_ready();
    let stop = Arc::new(tokio::sync::Notify::new());
    let signalled = stop.clone();
    tokio::spawn(async move {
        use tokio::signal::unix::{signal, SignalKind};
        let (mut term, mut int) = (
            signal(SignalKind::terminate()).expect("SIGTERM"),
            signal(SignalKind::interrupt()).expect("SIGINT"),
        );
        tokio::select! { _ = term.recv() => {}, _ = int.recv() => {} }
        signalled.notify_one();
    });
    serve(updater, listener, Arc::new(callers), stop).await;
    0
}

/// Tells systemd (`Type=notify`) that the updater is up. A new updater that never gets here is not kept.
fn notify_ready() {
    use std::os::linux::net::SocketAddrExt;
    use std::os::unix::net::{SocketAddr, UnixDatagram};
    let Some(path) = std::env::var_os("NOTIFY_SOCKET") else {
        return;
    };
    let address = match path.as_encoded_bytes().strip_prefix(b"@") {
        Some(name) => SocketAddr::from_abstract_name(name),
        None => SocketAddr::from_pathname(&path),
    };
    if let (Ok(address), Ok(socket)) = (address, UnixDatagram::unbound()) {
        let _ = socket.send_to_addr(b"READY=1", &address);
    }
}
