//! trommi-hub: the thin hub in Rust. `trommi-hub` serves (the environment of hub/server.mjs);
//! `trommi-hub backup <file>` writes an online copy of hub.db (VACUUM INTO, for hub/deploy-backup.sh);
//! `trommi-hub healthcheck` asks GET /healthz on the local port (the image's HEALTHCHECK).

mod accounts;
mod admin;
mod admin_assets;
mod admin_view;
mod config;
mod control;
mod db;
mod error;
mod files;
mod http;
mod limits;
mod mail;
mod metrics;
mod ops;
#[cfg(test)]
mod ops_tests;
mod push;
mod room;
mod server;
mod store;
mod stream;
mod util;

/// mimalloc: steadier memory than glibc's per-thread arenas under a multi-threaded runtime, and fast on musl.
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

use crate::http::Conn;
use crate::server::Hub;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::{TokioIo, TokioTimer};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::net::TcpListener;
use tokio::sync::Notify;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(|s| s.as_str()) {
        Some("backup") => std::process::exit(backup(args.get(2).map(|s| s.as_str()))),
        Some("healthcheck") => std::process::exit(healthcheck()),
        Some("hash") => std::process::exit(admin::hash_command()),
        Some("admin") => std::process::exit(admin_only(&args[2..])),
        Some("--version") | Some("version") => {
            println!("trommi-hub {} (commit {})", env!("CARGO_PKG_VERSION"), std::env::var("COMMIT").unwrap_or_else(|_| "dev".into()));
        }
        _ => {
            let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
            if let Err(e) = rt.block_on(run()) {
                eprintln!("[hub] {e}");
                std::process::exit(1);
            }
        }
    }
}

/// VACUUM INTO: a consistent online copy of hub.db, as deploy-backup.sh made it with node:sqlite.
fn backup(out: Option<&str>) -> i32 {
    let Some(out) = out else {
        eprintln!("usage: trommi-hub backup <file>");
        return 2;
    };
    let data = std::env::var("HUB_DATA").unwrap_or_else(|_| "/data".into());
    let r = rusqlite::Connection::open(std::path::Path::new(&data).join("hub.db")).and_then(|c| {
        c.execute_batch("PRAGMA busy_timeout = 5000")?;
        c.execute("VACUUM INTO ?", [out])
    });
    match r {
        Ok(_) => 0,
        Err(e) => {
            eprintln!("backup failed: {e}");
            1
        }
    }
}

/// `trommi-hub admin --db <hub.db> [--data <dir>] [--host 127.0.0.1] [--port 8791] [--published-loopback]`: the admin
/// page alone, on a hub.db another process writes (ADMIN_LOGINS, ADMIN_PASSWORD_HASH from the environment).
fn admin_only(args: &[String]) -> i32 {
    let opt = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
    if let Some(t) = std::env::var("HUB_TEST_NOW").ok().and_then(|v| v.parse::<i64>().ok()) {
        util::enable_test_clock();
        util::set_test_now(t);
    }
    let Some(db) = opt("--db") else {
        eprintln!("usage: trommi-hub admin --db <hub.db> [--data <dir>] [--host 127.0.0.1] [--port 8791] [--published-loopback]");
        return 2;
    };
    let opts = admin::Options {
        db_path: db.into(),
        data_dir: opt("--data").map(Into::into),
        host: opt("--host").unwrap_or_else(|| "127.0.0.1".into()),
        port: opt("--port").and_then(|p| p.parse().ok()).unwrap_or(8791),
        allow_published_loopback: args.iter().any(|a| a == "--published-loopback"),
        logins: std::env::var("ADMIN_LOGINS").unwrap_or_default(),
        password_hash: std::env::var("ADMIN_PASSWORD_HASH").unwrap_or_default(),
    };
    let host = opts.host.clone();
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
    rt.block_on(async move {
        match admin::start_with(opts, None, std::sync::Arc::new(|m: &str| eprintln!("[admin] {m}"))).await {
            Ok(port) => {
                println!("[hub] admin on {host}:{port}");
                let _ = tokio::signal::ctrl_c().await;
                0
            }
            Err(e) => {
                eprintln!("{e}");
                1
            }
        }
    })
}

fn healthcheck() -> i32 {
    use std::io::{Read, Write};
    let port = std::env::var("HUB_PORT").ok().and_then(|p| p.parse::<u16>().ok()).unwrap_or(8790);
    let Ok(mut s) = std::net::TcpStream::connect_timeout(&format!("127.0.0.1:{port}").parse().unwrap(), Duration::from_secs(3)) else { return 1 };
    let _ = s.set_read_timeout(Some(Duration::from_secs(3)));
    if s.write_all(b"GET /healthz HTTP/1.1\r\nhost: 127.0.0.1\r\nconnection: close\r\n\r\n").is_err() {
        return 1;
    }
    let mut buf = String::new();
    let _ = s.read_to_string(&mut buf);
    if buf.starts_with("HTTP/1.1 200") { 0 } else { 1 }
}

async fn run() -> Result<(), String> {
    let t0 = Instant::now();
    let cfg = config::Config::from_env();
    if cfg.test_control {
        util::enable_test_clock();
    }
    let listener = TcpListener::bind((cfg.host.as_str(), cfg.port)).await.map_err(|e| format!("listen {}:{}: {e}", cfg.host, cfg.port))?;
    let port = listener.local_addr().unwrap().port();
    let hub_url = cfg.hub_url.clone().unwrap_or_else(|| format!("http://127.0.0.1:{port}"));
    let hub = Arc::new(Hub::new(cfg.clone(), hub_url.clone())?);
    let stop = Arc::new(Notify::new());
    spawn_timers(&hub);
    hub.metrics.spawn_lag_monitor();
    if let Some(p) = cfg.get("METRICS_PORT") {
        let host = cfg.get("METRICS_HOST").unwrap_or("127.0.0.1").to_string();
        match TcpListener::bind((host.as_str(), p.parse::<u16>().unwrap_or(0))).await {
            Ok(l) => {
                hub.log(&format!("metrics on {host}:{}", l.local_addr().unwrap().port()));
                tokio::spawn(serve_metrics(hub.clone(), l));
            }
            Err(e) => return Err(format!("metrics listener: {e}")),
        }
    }
    if let Some(p) = cfg.get("ADMIN_PORT") {
        let host = cfg.get("ADMIN_HOST").unwrap_or("127.0.0.1").to_string();
        match admin::start(hub.clone(), &host, p.parse::<u16>().unwrap_or(0)).await {
            Ok(port) => hub.log(&format!("admin on {host}:{port}")),
            Err(e) => hub.log(&format!("admin not started: {e}")),
        }
    }
    hub.log(&format!("listening on {}:{} as {}, commit {}, ready in {:.1} ms", cfg.host, port, hub_url, cfg.commit, t0.elapsed().as_secs_f64() * 1000.0));
    {
        let stop = stop.clone();
        tokio::spawn(async move {
            let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).unwrap();
            let mut int = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt()).unwrap();
            tokio::select! { _ = term.recv() => {}, _ = int.recv() => {} }
            stop.notify_one();
        });
    }
    // Every connection watches `shutdown`: on close an idle keep-alive connection goes at once and a busy one after
    // its answer (Node's server.close() + closeAllConnections()), so clients see a closed socket, never a late 503.
    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let Ok((sock, peer)) = accepted else { continue };
                let _ = sock.set_nodelay(true);
                let hub = hub.clone();
                let mut shutdown = shutdown_rx.clone();
                tokio::spawn(async move {
                    let conn = Conn { peer, cut: Arc::new(Notify::new()) };
                    let cut = conn.cut.clone();
                    let svc = service_fn(move |req| {
                        let (hub, conn) = (hub.clone(), conn.clone());
                        async move { Ok::<_, std::convert::Infallible>(hub.serve(req, conn).await) }
                    });
                    let fut = http1::Builder::new().timer(TokioTimer::new()).header_read_timeout(Duration::from_secs(65)).keep_alive(true).serve_connection(TokioIo::new(sock), svc);
                    tokio::pin!(fut);
                    let mut graceful = false;
                    loop {
                        tokio::select! {
                            _ = &mut fut => break,
                            _ = cut.notified() => break,
                            r = shutdown.changed(), if !graceful => {
                                if r.is_err() || *shutdown.borrow() { fut.as_mut().graceful_shutdown(); graceful = true; }
                            }
                        }
                    }
                });
            }
            _ = stop.notified() => break,
        }
    }
    // close(): no new connections, refuse new requests, end the streams, wait (at most 5 s) for the requests in flight.
    drop(listener);
    hub.closing.store(true, Ordering::Release);
    let _ = shutdown_tx.send(true);
    hub.end_all_streams();
    let wait = async {
        while hub.in_flight.load(Ordering::Acquire) > 0 {
            let n = hub.drained.notified();
            if hub.in_flight.load(Ordering::Acquire) == 0 {
                break;
            }
            let _ = tokio::time::timeout(Duration::from_millis(50), n).await;
        }
    };
    let _ = tokio::time::timeout(Duration::from_secs(5), wait).await;
    hub.metrics.flush();
    let _ = hub.db.w().execute_batch("PRAGMA wal_checkpoint(PASSIVE)");
    // Leave at once: the runtime would wait for timer tasks.
    std::process::exit(0)
}

fn spawn_timers(hub: &Arc<Hub>) {
    let every = |hub: &Arc<Hub>, ms: u64, first: Option<u64>, f: fn(&Arc<Hub>)| {
        let hub = hub.clone();
        tokio::spawn(async move {
            if let Some(d) = first {
                tokio::time::sleep(Duration::from_millis(d)).await;
                if !hub.closing.load(Ordering::Acquire) {
                    f(&hub);
                }
            }
            let mut t = tokio::time::interval(Duration::from_millis(ms.max(1)));
            t.tick().await;
            loop {
                t.tick().await;
                if hub.closing.load(Ordering::Acquire) {
                    break;
                }
                let h = hub.clone();
                let _ = tokio::task::spawn_blocking(move || f(&h)).await;
            }
        });
    };
    every(hub, hub.cfg.stream_cap_every_ms, None, |h| {
        h.cap_streams();
    });
    every(hub, 30000, None, |h| {
        if let Err(e) = db::vacuum_step(&h.db.w(), 2048) {
            h.log(&format!("vacuum: {e}"));
        }
    });
    every(hub, hub.cfg.retention_every_ms, Some(60000), |h| {
        h.prune(h.cfg.limits.retention_days);
    });
    every(hub, 600000, None, |h| {
        h.sweep_pending(3600000);
    });
    every(hub, 600000, None, |h| h.sweep_limits());
    every(hub, 10000, None, |h| {
        if let Err(e) = ops::checkpoint(&h.db.w(), &h.db.path, h.cfg.wal_truncate_bytes, &h.wal_last) {
            h.log(&format!("ops: {e}"));
        }
    });
    every(hub, 600000, Some(0), |h| {
        let ids = h.tests.expired(&h.db.w());
        for id in ids {
            h.remove_test_room(&id);
        }
    });
    every(hub, 10000, None, |h| h.metrics.sample(h));
    every(hub, 3600000, None, |h| {
        h.accounts.sweep(h);
    });
}

async fn serve_metrics(hub: Arc<Hub>, l: TcpListener) {
    loop {
        let Ok((sock, _)) = l.accept().await else { continue };
        let hub = hub.clone();
        tokio::spawn(async move {
            let svc = service_fn(move |req: hyper::Request<hyper::body::Incoming>| {
                let hub = hub.clone();
                async move {
                    let r = if req.method() == "GET" && req.uri() == "/metrics" {
                        let mut r = hyper::Response::new(http::Body::full(hub.metrics.text(&hub)));
                        r.headers_mut().insert("content-type", "text/plain; version=0.0.4".parse().unwrap());
                        r
                    } else if req.method() == "GET" && req.uri() == "/metrics/history" {
                        http::json(200, &serde_json::json!({ "interval_ms": 10000, "samples": hub.metrics.history() }))
                    } else {
                        http::json(404, &serde_json::json!({ "error": "not-found", "message": "GET /metrics or /metrics/history" }))
                    };
                    Ok::<_, std::convert::Infallible>(r)
                }
            });
            let _ = http1::Builder::new().serve_connection(TokioIo::new(sock), svc).await;
        });
    }
}
