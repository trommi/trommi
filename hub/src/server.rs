//! The listener, the periodic jobs and the graceful shutdown.

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::{TokioIo, TokioTimer};
use serde_json::json;
use tokio::net::TcpListener;
use tokio::sync::{watch, Notify};

use crate::app::App;
use crate::http::Conn;

/// Counts a request from its arrival until its answer is fully sent.
struct InFlight(Arc<App>);

impl Drop for InFlight {
    fn drop(&mut self) {
        self.0.in_flight.fetch_sub(1, Ordering::Relaxed);
    }
}

fn every(
    app: &Arc<App>,
    period_ms: u64,
    first_ms: u64,
    job: impl Fn(&Arc<App>) + Send + Sync + 'static,
) {
    let app = app.clone();
    let job = Arc::new(job);
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(first_ms)).await;
        let mut tick = tokio::time::interval(Duration::from_millis(period_ms.max(10)));
        loop {
            tick.tick().await;
            if app.closing.load(Ordering::Relaxed) {
                return;
            }
            let (a, j) = (app.clone(), job.clone());
            let _ = tokio::task::spawn_blocking(move || j(&a)).await;
        }
    });
}

pub fn spawn_jobs(app: &Arc<App>) {
    every(
        app,
        app.cfg.retention_every_ms,
        app.cfg.retention_every_ms.min(60_000),
        |a| {
            a.retention();
        },
    );
    every(
        app,
        app.cfg.sweep_every_ms,
        app.cfg.sweep_every_ms.min(30_000),
        |a| a.sweep(),
    );
    every(app, 30_000, 30_000, |a| a.db.maintain());
    every(app, crate::metrics::STEP_MS, 0, |a| a.metrics.sample(a));
    every(app, app.cfg.lease_watch_ms, app.cfg.lease_watch_ms, |a| {
        a.lease_watch()
    });
    every(app, app.cfg.ping_ms, app.cfg.ping_ms, |a| {
        a.live.ping(crate::util::now())
    });
    let beat = app.clone();
    tokio::spawn(async move {
        let mut tick =
            tokio::time::interval(Duration::from_millis(beat.cfg.live_beat_ms.max(1000)));
        loop {
            tick.tick().await;
            if beat.closing.load(Ordering::Relaxed) {
                return;
            }
            beat.live_beat().await;
        }
    });
}

/// The admin page's listener (`admin.rs`), until `stop` is notified. Whoever calls this binds the listener to
/// 127.0.0.1: the page is never served on the public port.
pub async fn serve_admin(app: Arc<App>, listener: TcpListener, stop: Arc<Notify>) {
    // few connections, none for long: the page has one user, and nobody holds the hub's descriptors through it
    let places = Arc::new(tokio::sync::Semaphore::new(crate::admin::MAX_CONNECTIONS));
    loop {
        let accepted = tokio::select! {
            a = listener.accept() => a,
            _ = stop.notified() => return,
        };
        let Ok((socket, _)) = accepted else {
            tokio::time::sleep(Duration::from_millis(50)).await;
            continue;
        };
        // over the limit: the connection is closed at once
        let Ok(place) = places.clone().try_acquire_owned() else {
            continue;
        };
        let app = app.clone();
        tokio::spawn(async move {
            let _place = place;
            let service = service_fn(move |req| {
                let app = app.clone();
                async move { Ok::<_, std::convert::Infallible>(crate::admin::handle(app, req).await) }
            });
            let serving = http1::Builder::new()
                .timer(TokioTimer::new())
                .header_read_timeout(Duration::from_secs(10))
                .serve_connection(TokioIo::new(socket), service);
            let _ =
                tokio::time::timeout(Duration::from_millis(crate::admin::CONNECTION_MS), serving)
                    .await;
        });
    }
}

/// Serves until `stop` is notified, then shuts down: no new connections, idle ones closed at once, busy ones
/// after their answer, every stream ended, at most five seconds for what is in flight.
pub async fn serve(app: Arc<App>, listener: TcpListener, stop: Arc<Notify>) {
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    loop {
        let accepted = tokio::select! {
            a = listener.accept() => a,
            _ = stop.notified() => break,
        };
        let Ok((socket, peer)) = accepted else {
            tokio::time::sleep(Duration::from_millis(50)).await;
            continue;
        };
        let _ = socket.set_nodelay(true);
        let app = app.clone();
        let mut shutdown = shutdown_rx.clone();
        tokio::spawn(async move {
            let conn = Conn::new(peer);
            let (cut, whole) = (conn.cut.clone(), conn.clone());
            let service = service_fn(move |req| {
                let (app, conn) = (app.clone(), conn.next_request());
                async move {
                    app.in_flight.fetch_add(1, Ordering::Relaxed);
                    app.metrics.requests.fetch_add(1, Ordering::Relaxed);
                    let guard = InFlight(app.clone());
                    let (parts, body) = crate::api::handle(app, req, conn).await.into_parts();
                    Ok::<_, std::convert::Infallible>(hyper::Response::from_parts(
                        parts,
                        body.guard(guard),
                    ))
                }
            });
            let serving = http1::Builder::new()
                .timer(TokioTimer::new())
                .header_read_timeout(Duration::from_secs(65))
                .keep_alive(true)
                .serve_connection(TokioIo::new(socket), service);
            tokio::pin!(serving);
            let mut closing = false;
            loop {
                tokio::select! {
                    _ = &mut serving => return,
                    // a cut is its request's: one asked for by an answer that is over, on a connection that
                    // serves another request by now, is not obeyed
                    _ = cut.notified() => {
                        if whole.is_cut() {
                            return;
                        }
                    }
                    changed = shutdown.changed(), if !closing => {
                        if changed.is_err() {
                            return;
                        }
                        closing = true;
                        serving.as_mut().graceful_shutdown();
                    }
                }
            }
        });
    }
    drop(listener);
    app.closing.store(true, Ordering::Relaxed);
    let _ = shutdown_tx.send(true);
    app.live.end_all();
    for _ in 0..100 {
        if app.in_flight.load(Ordering::Relaxed) == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    app.db.checkpoint();
    crate::log::info(
        "stopped",
        json!({ "in_flight": app.in_flight.load(Ordering::Relaxed) }),
    );
}
