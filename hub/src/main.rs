//! The Trommi hub for protocol v2: one binary. `trommi-hub` serves; `trommi-hub healthcheck` asks a running hub
//! on this machine whether it is well (for the container's health check, which has no other tool).

#![forbid(unsafe_code)]

use std::sync::Arc;

use serde_json::json;
use trommi_hub::app::App;
use trommi_hub::config::Config;
use trommi_hub::push::{Network, Recorder, Transport};

fn healthcheck(cfg: &Config) -> i32 {
    use std::io::{Read, Write};
    let address = format!("127.0.0.1:{}", cfg.port);
    let Ok(address) = address.parse() else {
        return 1;
    };
    let Ok(mut socket) =
        std::net::TcpStream::connect_timeout(&address, std::time::Duration::from_secs(3))
    else {
        return 1;
    };
    let _ = socket.set_read_timeout(Some(std::time::Duration::from_secs(3)));
    if socket
        .write_all(b"GET /healthz HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n")
        .is_err()
    {
        return 1;
    }
    let mut answer = [0u8; 15];
    match socket.read_exact(&mut answer) {
        Ok(()) if &answer == b"HTTP/1.1 200 OK" => 0,
        _ => 1,
    }
}

fn main() {
    let cfg = Config::from_env();
    match std::env::args().nth(1).as_deref() {
        None => {}
        Some("healthcheck") => std::process::exit(healthcheck(&cfg)),
        Some("admin-hash") => {
            // the hash to set as HUB_ADMIN_PASSWORD_HASH, for a password read from standard input
            let mut password = String::new();
            let _ = std::io::stdin().read_line(&mut password);
            let password = password.trim_end_matches(['\r', '\n']);
            if password.len() < 12 {
                eprintln!("a password of at least 12 characters, on standard input");
                std::process::exit(2);
            }
            println!("{}", trommi_hub::admin::hash_password(password));
            return;
        }
        Some("version") => {
            println!("{}", cfg.commit);
            return;
        }
        Some(other) => {
            eprintln!("unknown command: {other}");
            std::process::exit(2);
        }
    }
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .max_blocking_threads(64)
        .build()
        .expect("the runtime");
    runtime.block_on(async {
        // pushes go out over HTTPS; if no client can be built, they are recorded and dropped
        let transport: Arc<dyn Transport> = match Network::new() {
            Ok(n) => Arc::new(n),
            Err(e) => {
                eprintln!("push transport unavailable: {e}");
                Arc::new(Recorder::default())
            }
        };
        let listener = match tokio::net::TcpListener::bind((cfg.host.as_str(), cfg.port)).await {
            Ok(l) => l,
            Err(e) => {
                eprintln!("cannot listen on {}:{}: {e}", cfg.host, cfg.port);
                std::process::exit(1);
            }
        };
        let app = match App::new(cfg, transport) {
            Ok(app) => app,
            Err(e) => {
                eprintln!("cannot start: {e}");
                std::process::exit(1);
            }
        };
        trommi_hub::log::info(
            "listening",
            json!({ "port": app.cfg.port, "commit": app.cfg.commit, "apns": app.apns.is_some() }),
        );
        // the admin page: on this machine only (127.0.0.1 unless configured), and only if a password hash is set
        let admin_stop = Arc::new(tokio::sync::Notify::new());
        if app.cfg.admin_password_hash.is_some() {
            match tokio::net::TcpListener::bind((app.cfg.admin_host.as_str(), app.cfg.admin_port))
                .await
            {
                Ok(listener) => {
                    trommi_hub::log::info(
                        "admin_listening",
                        json!({ "host": app.cfg.admin_host, "port": app.cfg.admin_port }),
                    );
                    tokio::spawn(trommi_hub::server::serve_admin(
                        app.clone(),
                        listener,
                        admin_stop.clone(),
                    ));
                }
                // the hub itself runs without it
                Err(e) => eprintln!(
                    "the admin page cannot listen on 127.0.0.1:{}: {e}",
                    app.cfg.admin_port
                ),
            }
        }
        trommi_hub::server::spawn_jobs(&app);
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
        trommi_hub::server::serve(app, listener, stop).await;
    });
    // the runtime would wait for the timers
    std::process::exit(0);
}
