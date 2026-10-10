//! The hub's admin page: one read-only page for whoever runs the hub. It listens on 127.0.0.1 (`HUB_ADMIN_HOST`
//! for a container, whose port is then published to the host's loopback only), on a port of its own, and only when
//! a password hash is configured (`HUB_ADMIN_PASSWORD_HASH`); it is never part of the public port. It shows what
//! the hub can see and nothing else: rooms and accounts with their counts, the hub's tables with what kind of
//! data each holds, the running version and health. No content: the hub has none.
//!
//! Sign-in is HTTP Basic (any user name, the one password). A browser keeps such a credential for the page's own
//! origin, port included, and sends it nowhere else — a cookie would also go to every other port of the host.
//! The page takes `GET /` and nothing else: there is nothing to change, so nothing another site could make a
//! browser do.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use bytes::Bytes;
use http_body_util::Full;
use hyper::body::Incoming;
use hyper::{Method, Request, Response, StatusCode};

use crate::app::App;
use crate::error::Refused;
use crate::util::{now, random, sha256};

/// how long a checked credential is taken without checking it again
const SESSION_MS: u64 = 12 * 3_600_000;
const MAX_SESSIONS: usize = 16;
/// the longest wait after wrong passwords
const BACKOFF_MAX_MS: u64 = 60_000;
/// the page is computed once for all who ask within this time
const PAGE_MS: u64 = 5_000;
/// connections the admin listener holds at a time, and how long one may last
pub const MAX_CONNECTIONS: usize = 16;
/// the longest password `admin-hash` takes, and the longest credential header the page reads (a user name of
/// some hundred bytes beside such a password, in base64)
pub const MAX_PASSWORD: usize = 1024;
const MAX_HEADER: usize = 2048;
pub const CONNECTION_MS: u64 = 60_000;

/// Checked credentials and the page's own throttle: after each wrong password the page takes no other for 1 s,
/// 2 s, 4 s … up to a minute, whoever asks (it has one user), and it checks one password at a time.
pub struct Admin {
    state: Mutex<State>,
    /// keys the fingerprints of checked credentials: new at every start
    key: [u8; 32],
    /// the page as last computed, and whether it is being computed now
    page: Mutex<Option<(u64, String)>>,
    computing: AtomicBool,
}

impl Default for Admin {
    fn default() -> Self {
        Admin {
            state: Default::default(),
            key: random(),
            page: Default::default(),
            computing: AtomicBool::new(false),
        }
    }
}

#[derive(Default)]
struct State {
    /// fingerprints of credentials that were checked and right, with the time until which they are taken
    sessions: HashMap<[u8; 32], u64>,
    failures: u32,
    next_at: u64,
    checking: bool,
}

/// The hash to configure for a password: Argon2id in the PHC text form. (`trommi-hub admin-hash` prints it.)
pub fn hash_password(password: &str) -> String {
    let salt = SaltString::encode_b64(&random::<16>()).expect("sixteen bytes are a salt");
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .expect("default parameters")
        .to_string()
}

fn verify(hash: &str, password: &[u8]) -> bool {
    PasswordHash::new(hash)
        .is_ok_and(|parsed| Argon2::default().verify_password(password, &parsed).is_ok())
}

fn esc(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn page(status: StatusCode, body: &str) -> Response<Full<Bytes>> {
    let html = format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\
<title>Trommi hub</title><style>{STYLE}</style></head><body><main>{body}</main></body></html>"
    );
    Response::builder()
        .status(status)
        .header("content-type", "text/html; charset=utf-8")
        .header("cache-control", "no-store")
        .header("x-content-type-options", "nosniff")
        .header("referrer-policy", "no-referrer")
        .header("cross-origin-resource-policy", "same-origin")
        .header(
            "content-security-policy",
            "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
        )
        .body(Full::new(Bytes::from(html)))
        .expect("a valid response")
}

const STYLE: &str = "body{font:14px/1.45 system-ui,sans-serif;color:#1c1c1a;background:#fbfaf7;margin:0}\
main{max-width:1100px;margin:0 auto;padding:24px 16px}h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:28px 0 8px}\
p{margin:4px 0}.muted{color:#6b6a64}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:5px 10px 5px 0;\
border-bottom:1px solid #e4e1d8;vertical-align:top}th{font-weight:600;color:#6b6a64;font-size:12px}td.n,th.n{text-align:right;\
font-variant-numeric:tabular-nums}code{font:12px ui-monospace,monospace}.scroll{overflow-x:auto}\
@media(prefers-color-scheme:dark){body{color:#e9e7e0;background:#171715}th,.muted{color:#9a988f}th,td{border-color:#33322e}}";

/// Asks the browser for the password.
fn ask(note: &str) -> Response<Full<Bytes>> {
    let mut answer = page(
        StatusCode::UNAUTHORIZED,
        &format!("<h1>Trommi hub</h1><p class=\"muted\">{}</p>", esc(note)),
    );
    answer.headers_mut().insert(
        "www-authenticate",
        "Basic realm=\"Trommi hub admin\", charset=\"UTF-8\""
            .parse()
            .expect("static"),
    );
    answer
}

fn wait(seconds: u64) -> Response<Full<Bytes>> {
    let mut answer = page(
        StatusCode::TOO_MANY_REQUESTS,
        &format!("<h1>Trommi hub</h1><p class=\"muted\">Too many attempts. Try again in {seconds} s.</p>"),
    );
    answer.headers_mut().insert("retry-after", seconds.into());
    answer
}

/// The password of an `authorization: Basic` header (what follows the first colon), and the header's fingerprint.
fn credential(app: &App, req: &Request<Incoming>) -> Option<(Vec<u8>, [u8; 32])> {
    let header = req.headers().get("authorization")?.as_bytes();
    if header.len() > MAX_HEADER {
        return None;
    }
    let text = std::str::from_utf8(header).ok()?;
    // (the scheme's name in any case, RFC 9110)
    let (scheme, encoded) = text.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("Basic") {
        return None;
    }
    let decoded = base64_standard(encoded.trim())?;
    let colon = decoded.iter().position(|b| *b == b':')?;
    let fingerprint = sha256(&[&app.admin.key[..], header].concat());
    Some((decoded[colon + 1..].to_vec(), fingerprint))
}

/// Base64 as Basic authentication writes it: the standard alphabet, with padding.
fn base64_standard(text: &str) -> Option<Vec<u8>> {
    let url: String = text
        .trim_end_matches('=')
        .chars()
        .map(|c| match c {
            '+' => '-',
            '/' => '_',
            '-' | '_' => '!',
            c => c,
        })
        .collect();
    crate::util::unb64(&url)
}

impl Admin {
    fn known(&self, fingerprint: &[u8; 32]) -> bool {
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let t = now();
        s.sessions.retain(|_, until| *until > t);
        s.sessions.contains_key(fingerprint)
    }

    /// May a password be checked now? `Err(seconds)`: when to come back.
    fn admit(&self) -> Result<(), u64> {
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let t = now();
        if s.checking {
            return Err(1);
        }
        if t < s.next_at {
            return Err((s.next_at - t).div_ceil(1000).max(1));
        }
        s.checking = true;
        Ok(())
    }

    /// The check is over: `Some(right)`, or `None` if nothing was checked.
    fn checked(&self, outcome: Option<bool>, fingerprint: &[u8; 32]) {
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        s.checking = false;
        match outcome {
            None => {}
            Some(false) => {
                s.failures = (s.failures + 1).min(30);
                s.next_at = now() + (1000u64 << (s.failures - 1).min(16)).min(BACKOFF_MAX_MS);
            }
            Some(true) => {
                (s.failures, s.next_at) = (0, 0);
                if s.sessions.len() >= MAX_SESSIONS {
                    let oldest = s
                        .sessions
                        .iter()
                        .min_by_key(|(_, until)| **until)
                        .map(|(k, _)| *k);
                    if let Some(oldest) = oldest {
                        s.sessions.remove(&oldest);
                    }
                }
                s.sessions.insert(*fingerprint, now() + SESSION_MS);
            }
        }
    }
}

/// A password check that ends in `checked` whatever becomes of the request or the thread.
struct Checking {
    app: Arc<App>,
    fingerprint: [u8; 32],
    outcome: Option<bool>,
}

impl Drop for Checking {
    fn drop(&mut self) {
        self.app.admin.checked(self.outcome, &self.fingerprint);
    }
}

/// One request to the admin listener.
pub async fn handle(app: Arc<App>, req: Request<Incoming>) -> Response<Full<Bytes>> {
    let Some(hash) = app.cfg.admin_password_hash.clone() else {
        return page(StatusCode::NOT_FOUND, "<p>Not found.</p>");
    };
    if req.method() != Method::GET || req.uri().path() != "/" {
        return page(StatusCode::NOT_FOUND, "<p>Not found.</p>");
    }
    let Some((password, fingerprint)) = credential(&app, &req) else {
        return ask("The admin page of this hub. It shows what the hub can see: no content.");
    };
    if !app.admin.known(&fingerprint) {
        if let Err(seconds) = app.admin.admit() {
            return wait(seconds);
        }
        // The slow hash runs on the hub's pool, and the job itself ends the check: a request that goes away
        // meanwhile leaves nothing open. If the pool is busy, nothing was checked.
        let mut checking = Checking {
            app: app.clone(),
            fingerprint,
            outcome: None,
        };
        let right = tokio::task::spawn_blocking(move || {
            checking.outcome = checking.app.pooled(|| verify(&hash, &password)).ok();
            checking.outcome
        })
        .await;
        match right {
            Ok(Some(true)) => crate::log::info("admin_signed_in", serde_json::json!({})),
            Ok(Some(false)) => {
                crate::log::info("admin_wrong_password", serde_json::json!({}));
                return ask("Wrong password.");
            }
            _ => {
                return page(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "<p>The hub is busy. Try again in a moment.</p>",
                )
            }
        }
    }
    // the page is computed by one request at a time and kept for a few seconds: it reads every table
    let t = now();
    let cached = app
        .admin
        .page
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .filter(|(at, _)| t < at + PAGE_MS)
        .map(|(_, html)| html.clone());
    if let Some(html) = cached {
        return page(StatusCode::OK, &html);
    }
    if app.admin.computing.swap(true, Ordering::SeqCst) {
        // (an older page is not shown as the hub's state of now)
        return page(
            StatusCode::SERVICE_UNAVAILABLE,
            "<p>The page is being put together. Try again in a moment.</p>",
        );
    }
    let shown = app.clone();
    let computed = tokio::task::spawn_blocking(move || {
        struct Done(Arc<App>);
        impl Drop for Done {
            fn drop(&mut self) {
                self.0.admin.computing.store(false, Ordering::SeqCst);
            }
        }
        let done = Done(shown);
        let html = overview(&done.0);
        if let Ok(html) = &html {
            *done.0.admin.page.lock().unwrap_or_else(|e| e.into_inner()) =
                Some((now(), html.clone()));
        }
        html
    })
    .await;
    match computed {
        Ok(Ok(html)) => page(StatusCode::OK, &html),
        _ => page(
            StatusCode::INTERNAL_SERVER_ERROR,
            "<p>The database did not answer.</p>",
        ),
    }
}

/// What each table holds, as spec/hub-api.md "Tables" has it: what the hub reads, and what lies in it sealed.
const TABLES: &[(&str, &str, &str)] = &[
    ("accounts", "e-mail, login hashes, KDF record", "sealed copies of the code"),
    ("passkeys", "passkey public keys", "sealed copies of the code"),
    ("account_rooms", "account → room", ""),
    ("account_sources", "keyed hashes of the addresses an account was signed in to from", ""),
    ("login_sources", "login throttle: hashes of e-mail and source, failures", ""),
    ("login_accounts", "login throttle: an e-mail's hour and line", ""),
    ("login_turns", "login throttle: places in line", ""),
    ("rooms", "room id, founding time, change counter, counts, recovery public keys", ""),
    ("devices", "device public key, role, epochs", ""),
    ("group_members", "the leaves of each group", ""),
    ("key_packages", "KeyPackages (public)", ""),
    ("spent_key_packages", "references of KeyPackages handed out", ""),
    ("groups", "group id, kind, session, epoch, the public group state", ""),
    ("group_log", "Commits (public), sender, times", "application messages"),
    ("group_infos", "GroupInfos (public)", ""),
    ("welcomes", "device, group, time, epoch", "the Welcome (rows written before its own table)"),
    ("welcome_bytes", "group, epoch", "the Welcome, once for every device it adds"),
    ("welcome_ids", "the counter of Welcome ids (one number)", ""),
    ("sealed_keys", "group, epoch, writer, recovery public key", "the sealed content keys"),
    ("recovery_links", "room epoch, recovery public key", "the sealed older recovery key"),
    ("recovery_keys_held", "every recovery public key a room had", ""),
    ("recoveries", "open recoveries: key, times", ""),
    ("recovery_parts", "the Commits of an open recovery (public)", ""),
    ("recovery_memo", "public group state of an open recovery", ""),
    ("envelopes", "signed header: group, sender, numbers, kind, times, timeline, object id, type and state, file ids", "the body"),
    ("epoch_counts", "envelopes per group and epoch", ""),
    ("cards", "object id, state, urgency, owner (index over envelopes)", ""),
    ("permission_requests", "as cards", ""),
    ("artifacts", "as cards", ""),
    ("notes", "as cards", ""),
    ("chats", "timeline, item count (index)", ""),
    ("boards", "timeline, item count (index)", ""),
    ("registers", "group, writer, register id (index)", ""),
    ("files", "file id, uploader, group, object, size, times", "the bytes, beside the database"),
    ("shares", "share id, file, hash of the secret, expiry", ""),
    ("invites", "the signed Offer with its MAC, expiry, use", ""),
    ("invite_requests", "Requests and Reveal of an invite", ""),
    ("requests", "device, kind, group, time", ""),
    ("push_subscriptions", "push endpoints and tokens, level", ""),
    ("live_activities", "Live Activity tokens, the counts last sent", ""),
    ("agent_leases", "device, process, generation, expiry", ""),
];

fn when(ms: i64) -> String {
    // days since 1970 to a date (civil-from-days), UTC
    let secs = ms.div_euclid(1000);
    let (days, rest) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let (d, m) = (
        doy - (153 * mp + 2) / 5 + 1,
        if mp < 10 { mp + 3 } else { mp - 9 },
    );
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02} {:02}:{:02}",
        rest / 3600,
        rest % 3600 / 60
    )
}

fn size(bytes: i64) -> String {
    match bytes {
        b if b >= 1 << 30 => format!("{:.1} GiB", b as f64 / (1u64 << 30) as f64),
        b if b >= 1 << 20 => format!("{:.1} MiB", b as f64 / (1u64 << 20) as f64),
        b if b >= 1 << 10 => format!("{:.1} KiB", b as f64 / 1024.0),
        b => format!("{b} B"),
    }
}

/// The page: read in one snapshot of the database.
fn overview(app: &App) -> Result<String, Refused> {
    const SHOWN: i64 = 500;
    app.db.read(|c| {
        let mut out = String::new();
        let one = |sql: &str| -> rusqlite::Result<i64> { c.query_row(sql, [], |r| r.get(0)) };
        let (rooms, accounts) = (one("SELECT count(*) FROM rooms")?, one("SELECT count(*) FROM accounts")?);
        let (at_work, waiting) = app.gate.load();
        out.push_str(&format!(
            "<h1>Trommi hub</h1><p class=\"muted\">version <code>{}</code> · protocol 2 · {} · database answers · {} rooms · {} accounts · \
{} streams open · {} requests at work · pool {} at work, {} waiting · push to Apple {}</p>",
            esc(&app.cfg.commit),
            esc(&app.cfg.url),
            rooms,
            accounts,
            app.live.count(),
            app.in_flight.load(std::sync::atomic::Ordering::Relaxed),
            at_work,
            waiting,
            if app.apns.is_some() { "configured" } else { "not configured" },
        ));

        // ---- rooms, with what the hub counts in each
        out.push_str("<h2>Rooms</h2><div class=\"scroll\"><table><tr><th>Room</th><th>Account</th><th>Founded</th>\
<th class=\"n\">Human</th><th class=\"n\">Agent</th><th class=\"n\">Helper</th><th class=\"n\">Sessions live</th><th class=\"n\">Archived</th>\
<th class=\"n\">Changes</th><th class=\"n\">Envelopes</th><th class=\"n\">Files</th><th class=\"n\">of quota</th><th class=\"n\">Push</th><th>Last write</th></tr>");
        let mut s = c.prepare(
            "SELECT r.room_id, r.founded_at, r.change, r.file_bytes,
               (SELECT coalesce(a.email, '') FROM account_rooms ar JOIN accounts a ON a.account_id = ar.account_id WHERE ar.room_id = r.room_id),
               (SELECT count(*) FROM devices d WHERE d.room_id = r.room_id AND d.removed_epoch IS NULL AND d.role = 'human'),
               (SELECT count(*) FROM devices d WHERE d.room_id = r.room_id AND d.removed_epoch IS NULL AND d.role = 'agent'),
               (SELECT count(*) FROM devices d WHERE d.room_id = r.room_id AND d.removed_epoch IS NULL AND d.role = 'helper'),
               (SELECT count(*) FROM groups g WHERE g.room_id = r.room_id AND g.kind != 'room' AND g.live = 1),
               (SELECT count(*) FROM groups g WHERE g.room_id = r.room_id AND g.kind != 'room' AND g.live = 0),
               (SELECT count(*) FROM envelopes e WHERE e.room_id = r.room_id),
               (SELECT count(*) FROM push_subscriptions p WHERE p.room_id = r.room_id),
               (SELECT max(e.received_at) FROM envelopes e WHERE e.room_id = r.room_id AND e.change = (SELECT max(change) FROM envelopes WHERE room_id = r.room_id))
             FROM rooms r ORDER BY r.founded_at DESC LIMIT ?1",
        )?;
        let mut rows = s.query([SHOWN])?;
        while let Some(r) = rows.next()? {
            let room: Vec<u8> = r.get(0)?;
            let file_bytes: i64 = r.get(3)?;
            let email: Option<String> = r.get(4)?;
            let last: Option<i64> = r.get(12)?;
            out.push_str(&format!(
                "<tr><td><code>{}</code></td><td>{}</td><td>{}</td><td class=\"n\">{}</td><td class=\"n\">{}</td><td class=\"n\">{}</td>\
<td class=\"n\">{}</td><td class=\"n\">{}</td><td class=\"n\">{}</td><td class=\"n\">{}</td><td class=\"n\">{}</td><td class=\"n\">{:.1} %</td><td class=\"n\">{}</td><td>{}</td></tr>",
                esc(&crate::util::short(&room)),
                match email.as_deref() {
                    None => "<span class=\"muted\">none</span>".to_string(),
                    Some("") => "<span class=\"muted\">without e-mail</span>".to_string(),
                    Some(email) => esc(email),
                },
                when(r.get(1)?),
                r.get::<_, i64>(5)?,
                r.get::<_, i64>(6)?,
                r.get::<_, i64>(7)?,
                r.get::<_, i64>(8)?,
                r.get::<_, i64>(9)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(10)?,
                size(file_bytes),
                file_bytes as f64 * 100.0 / app.cfg.room_quota.max(1) as f64,
                r.get::<_, i64>(11)?,
                last.map(when).unwrap_or_else(|| "<span class=\"muted\">never</span>".into()),
            ));
        }
        out.push_str("</table></div>");
        if rooms > SHOWN {
            out.push_str(&format!("<p class=\"muted\">The newest {SHOWN} of {rooms} rooms.</p>"));
        }

        // ---- the tables, classified
        out.push_str("<h2>Tables</h2><div class=\"scroll\"><table><tr><th>Table</th><th class=\"n\">Rows</th><th>The hub reads</th><th>Sealed: the hub cannot read</th></tr>");
        for (table, reads, sealed) in TABLES {
            // (names from the list above, never from a request)
            let n = one(&format!("SELECT count(*) FROM {table}"))?;
            out.push_str(&format!(
                "<tr><td><code>{table}</code></td><td class=\"n\">{n}</td><td>{}</td><td>{}</td></tr>",
                esc(reads),
                if sealed.is_empty() { "<span class=\"muted\">nothing</span>".to_string() } else { esc(sealed) }
            ));
        }
        out.push_str("</table></div>");
        // a table the list does not know is said, not hidden
        let mut s = c.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")?;
        let unknown: Vec<String> = s
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .filter(|name| name != "login_counts" && !TABLES.iter().any(|(t, _, _)| t == name))
            .collect();
        if !unknown.is_empty() {
            out.push_str(&format!("<p>Not classified yet: <code>{}</code></p>", esc(&unknown.join(", "))));
        }
        Ok::<_, Refused>(out)
    })
}
