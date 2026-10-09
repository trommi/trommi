//! The hub's admin page: one read-only page for whoever runs the hub. It listens on 127.0.0.1 (`HUB_ADMIN_HOST`
//! for a container, whose port is then published to the host's loopback only), on a port of its own, and only when a password hash is configured (`HUB_ADMIN_PASSWORD_HASH`); it is never part of the
//! public port. It shows what the hub can see and nothing else: rooms and accounts with their counts, the hub's
//! tables with what kind of data each holds, the running version and health. No content: the hub has none.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::Incoming;
use hyper::{Method, Request, Response, StatusCode};

use crate::app::App;
use crate::error::Refused;
use crate::util::{b64, now, random, same};

/// how long a sign-in lasts
const SESSION_MS: u64 = 12 * 3_600_000;
const MAX_SESSIONS: usize = 16;
/// the longest wait after wrong passwords
const BACKOFF_MAX_MS: u64 = 60_000;
const COOKIE: &str = "trommi_admin";

/// Sign-ins and the page's own throttle: after each wrong password the page takes no other for 1 s, 2 s, 4 s …
/// up to a minute, whoever asks (it has one user), and it checks one password at a time.
#[derive(Default)]
pub struct Admin {
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
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

fn verify(hash: &str, password: &str) -> bool {
    PasswordHash::new(hash).is_ok_and(|parsed| {
        Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok()
    })
}

fn esc(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn page(status: StatusCode, title: &str, body: &str) -> Response<Full<Bytes>> {
    let html = format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\
<title>{title}</title><style>{STYLE}</style></head><body><main>{body}</main></body></html>",
        title = esc(title)
    );
    Response::builder()
        .status(status)
        .header("content-type", "text/html; charset=utf-8")
        .header("cache-control", "no-store")
        .header("x-content-type-options", "nosniff")
        .header("referrer-policy", "no-referrer")
        .header(
            "content-security-policy",
            "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
        )
        .body(Full::new(Bytes::from(html)))
        .expect("a valid response")
}

const STYLE: &str = "body{font:14px/1.45 system-ui,sans-serif;color:#1c1c1a;background:#fbfaf7;margin:0}\
main{max-width:1100px;margin:0 auto;padding:24px 16px}h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:28px 0 8px}\
p{margin:4px 0}.muted{color:#6b6a64}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:5px 10px 5px 0;\
border-bottom:1px solid #e4e1d8;vertical-align:top}th{font-weight:600;color:#6b6a64;font-size:12px}td.n,th.n{text-align:right;\
font-variant-numeric:tabular-nums}code{font:12px ui-monospace,monospace}.scroll{overflow-x:auto}\
input,button{font:inherit;padding:6px 10px;border:1px solid #b9b6ab;border-radius:6px;background:#fff;color:inherit}\
form.out{float:right}\
@media(prefers-color-scheme:dark){body{color:#e9e7e0;background:#171715}th,.muted{color:#9a988f}th,td{border-color:#33322e}\
input,button{background:#22221f;border-color:#55534c}}";

fn redirect(cookie: Option<String>) -> Response<Full<Bytes>> {
    let mut answer = Response::builder()
        .status(StatusCode::SEE_OTHER)
        .header("location", "/")
        .header("cache-control", "no-store");
    if let Some(cookie) = cookie {
        answer = answer.header("set-cookie", cookie);
    }
    answer
        .body(Full::new(Bytes::new()))
        .expect("a valid response")
}

fn login_page(status: StatusCode, note: &str) -> Response<Full<Bytes>> {
    page(
        status,
        "Trommi hub",
        &format!(
            "<h1>Trommi hub</h1><p class=\"muted\">{}</p>\
<form method=\"post\" action=\"/login\"><p><input type=\"password\" name=\"password\" autocomplete=\"current-password\" autofocus required> \
<button>Sign in</button></p></form>",
            esc(note)
        ),
    )
}

fn session_of(req: &Request<Incoming>) -> Option<[u8; 32]> {
    let cookies = req.headers().get("cookie")?.to_str().ok()?;
    cookies.split(';').find_map(|c| {
        let (name, value) = c.trim().split_once('=')?;
        (name == COOKIE)
            .then(|| crate::util::unb64(value))
            .flatten()?
            .try_into()
            .ok()
    })
}

impl Admin {
    fn signed_in(&self, session: Option<[u8; 32]>) -> bool {
        let Some(session) = session else {
            return false;
        };
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let t = now();
        s.sessions.retain(|_, until| *until > t);
        // (compared in constant time: the cookie is the secret)
        s.sessions.keys().any(|held| same(held, &session))
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

    fn checked(&self, right: bool) -> Option<[u8; 32]> {
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        s.checking = false;
        if !right {
            s.failures = (s.failures + 1).min(30);
            s.next_at = now() + (1000u64 << (s.failures - 1).min(16)).min(BACKOFF_MAX_MS);
            return None;
        }
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
        let session = random::<32>();
        s.sessions.insert(session, now() + SESSION_MS);
        Some(session)
    }

    fn sign_out(&self, session: Option<[u8; 32]>) {
        if let Some(session) = session {
            self.state
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .sessions
                .retain(|held, _| !same(held, &session));
        }
    }
}

/// One request to the admin listener.
pub async fn handle(app: Arc<App>, req: Request<Incoming>) -> Response<Full<Bytes>> {
    let Some(hash) = app.cfg.admin_password_hash.clone() else {
        return page(StatusCode::NOT_FOUND, "Trommi hub", "<p>Not found.</p>");
    };
    let session = session_of(&req);
    let path = req.uri().path().to_string();
    match (req.method().clone(), path.as_str()) {
        (Method::GET, "/") => {
            if !app.admin.signed_in(session) {
                return login_page(
                    StatusCode::OK,
                    "The admin page of this hub. It shows what the hub can see: no content.",
                );
            }
            let shown = app.clone();
            match tokio::task::spawn_blocking(move || overview(&shown)).await {
                Ok(Ok(html)) => page(StatusCode::OK, "Trommi hub", &html),
                _ => page(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Trommi hub",
                    "<p>The database did not answer.</p>",
                ),
            }
        }
        (Method::POST, "/login") => {
            // a form posted from another site signs nobody in
            if req
                .headers()
                .get("sec-fetch-site")
                .is_some_and(|v| v != "same-origin" && v != "none")
            {
                return login_page(StatusCode::FORBIDDEN, "Sign in on this page.");
            }
            let Ok(body) = Limited::new(req.into_body(), 4096).collect().await else {
                return login_page(StatusCode::BAD_REQUEST, "That was not a sign-in.");
            };
            let body = body.to_bytes();
            let password = form_value(&body, "password").unwrap_or_default();
            if let Err(seconds) = app.admin.admit() {
                let mut answer = login_page(
                    StatusCode::TOO_MANY_REQUESTS,
                    &format!("Too many attempts. Try again in {seconds} s."),
                );
                answer.headers_mut().insert("retry-after", seconds.into());
                return answer;
            }
            // the slow hash runs on the hub's pool; if the pool is busy, nothing was checked
            let pool = app.clone();
            let right =
                tokio::task::spawn_blocking(move || pool.pooled(|| verify(&hash, &password))).await;
            match right {
                Ok(Ok(right)) => match app.admin.checked(right) {
                    Some(session) => {
                        crate::log::info("admin_signed_in", serde_json::json!({}));
                        redirect(Some(format!(
                            "{COOKIE}={}; Path=/; HttpOnly; SameSite=Strict; Max-Age={}",
                            b64(&session),
                            SESSION_MS / 1000
                        )))
                    }
                    None => {
                        crate::log::info("admin_wrong_password", serde_json::json!({}));
                        login_page(StatusCode::UNAUTHORIZED, "Wrong password.")
                    }
                },
                _ => {
                    app.admin
                        .state
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .checking = false;
                    login_page(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "The hub is busy. Try again in a moment.",
                    )
                }
            }
        }
        (Method::POST, "/logout") => {
            app.admin.sign_out(session);
            redirect(Some(format!(
                "{COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"
            )))
        }
        _ => page(StatusCode::NOT_FOUND, "Trommi hub", "<p>Not found.</p>"),
    }
}

/// One value of an `application/x-www-form-urlencoded` body.
fn form_value(body: &[u8], name: &str) -> Option<String> {
    let text = std::str::from_utf8(body).ok()?;
    text.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        (key == name).then(|| percent_decode(value))
    })
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if bytes.get(i + 1..i + 3).is_some() => {
                match std::str::from_utf8(&bytes[i + 1..i + 3])
                    .ok()
                    .and_then(|h| u8::from_str_radix(h, 16).ok())
                {
                    Some(b) => {
                        out.push(b);
                        i += 2;
                    }
                    None => out.push(b'%'),
                }
            }
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
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
    ("welcomes", "device, group, time", "the Welcome"),
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
    ("invites", "the signed Offer, expiry, use", ""),
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
            "<form class=\"out\" method=\"post\" action=\"/logout\"><button>Sign out</button></form>\
<h1>Trommi hub</h1><p class=\"muted\">version <code>{}</code> · protocol 2 · {} · database answers · {} rooms · {} accounts · \
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
               (SELECT a.email FROM account_rooms ar JOIN accounts a ON a.account_id = ar.account_id WHERE ar.room_id = r.room_id),
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
                email.as_deref().map(esc).unwrap_or_else(|| "<span class=\"muted\">none</span>".into()),
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
