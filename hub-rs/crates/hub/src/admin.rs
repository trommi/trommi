//! The read-only admin page (hub/admin.mjs): its own listener (ADMIN_PORT), two checks on every request: the
//! Tailscale-User-Login header names a login of ADMIN_LOGINS, and a 12 h session from the admin password (scrypt hash
//! in <data>/admin-password-hash, or ADMIN_PASSWORD_HASH while that file does not exist). Hub data is opened
//! read-only; the only write is the password hash file. The HTML is admin_view.rs.

use crate::admin_view::{self as view, Source};
use crate::http::{header, Body};
use crate::server::Hub;
use bytes::Bytes;
use http_body_util::BodyExt;
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::net::TcpListener;
use unicode_normalization::UnicodeNormalization;

const SESSION_MS: i64 = 12 * 60 * 60 * 1000;
const COOKIE: &str = "trommi_admin";
const MIN_PASSWORD: usize = 16;
const FAIL_WINDOW_MS: i64 = 15 * 60 * 1000;
const FAILS_PER_LOGIN: usize = 5;
const FAILS_GLOBAL: usize = 20;
pub const PASSWORD_FILE: &str = "admin-password-hash";

// ---- password hashing: scrypt:<N>:<r>:<p>:<salt b64url>:<hash b64url> ----------------------------------

pub fn hash_password(password: &str) -> String {
    let salt = crate::util::random_bytes(16);
    let pw: String = password.nfc().collect();
    let mut out = vec![0u8; 32];
    scrypt::scrypt(pw.as_bytes(), &salt, &scrypt::Params::new(14, 8, 1, 32).unwrap(), &mut out).unwrap();
    format!("scrypt:16384:8:1:{}:{}", zcrypto::b64u(&salt), zcrypto::b64u(&out))
}
pub fn verify_password(password: &str, stored: &str) -> bool {
    let parts: Vec<&str> = stored.trim().split(':').collect();
    if parts.len() != 6 || parts[0] != "scrypt" {
        return false;
    }
    let num = |s: &str| s.parse::<u64>().ok();
    let (Some(n), Some(r), Some(p)) = (num(parts[1]), num(parts[2]), num(parts[3])) else { return false };
    if n > 1 << 20 || r > 32 || p > 16 || !n.is_power_of_two() || n < 2 {
        return false;
    }
    let salt = crate::push::b64_lenient(parts[4]);
    let expected = crate::push::b64_lenient(parts[5]);
    if expected.len() < 16 {
        return false;
    }
    let Ok(params) = scrypt::Params::new(n.trailing_zeros() as u8, r as u32, p as u32, expected.len()) else { return false };
    let pw: String = password.nfc().collect();
    let mut got = vec![0u8; expected.len()];
    if scrypt::scrypt(pw.as_bytes(), &salt, &params, &mut got).is_err() {
        return false;
    }
    zcrypto::bytes::bytes_equal(&got, &expected)
}

/// `trommi-hub hash`: reads a password from stdin and prints its hash (for ADMIN_PASSWORD_HASH).
pub fn hash_command() -> i32 {
    use std::io::Read;
    let mut s = String::new();
    let _ = std::io::stdin().read_to_string(&mut s);
    let pw = s.strip_suffix("\r\n").or_else(|| s.strip_suffix('\n')).unwrap_or(&s);
    if pw.chars().count() < MIN_PASSWORD {
        eprintln!("password needs at least {MIN_PASSWORD} characters");
        return 1;
    }
    println!("{}", hash_password(pw));
    0
}

pub fn parse_logins(v: &str) -> Vec<String> { v.split(',').map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty()).collect() }

struct Session {
    login: String,
    expires_at: i64,
    csrf: String,
}
pub struct Admin {
    allowed: Vec<String>,
    password_file: Option<PathBuf>,
    env_hash: String,
    sessions: Mutex<HashMap<String, Session>>,
    failures: Mutex<Vec<(String, i64)>>,
    started_at: i64,
    pub src: Source,
}

pub struct Options {
    pub db_path: PathBuf,
    pub data_dir: Option<PathBuf>,
    pub host: String,
    pub port: u16,
    pub allow_published_loopback: bool,
    pub logins: String,
    pub password_hash: String,
}

/// Start the listener; Err with the reason (loopback only, ADMIN_LOGINS required, a busy port).
pub async fn start_with(opts: Options, hub: Option<Arc<Hub>>, log: Arc<dyn Fn(&str) + Send + Sync>) -> Result<u16, String> {
    let loopback = ["127.0.0.1", "::1", "localhost"].contains(&opts.host.as_str());
    if !loopback && !(opts.allow_published_loopback && opts.host == "0.0.0.0") {
        return Err("admin: binds a loopback address only (the Tailscale-User-Login header is trusted only from tailscale serve on this host)".into());
    }
    let allowed = parse_logins(&opts.logins);
    if allowed.is_empty() {
        return Err("admin: ADMIN_LOGINS is required (comma list of Tailscale logins); there is no default".into());
    }
    let admin = Arc::new(Admin {
        allowed,
        password_file: opts.data_dir.as_ref().map(|d| d.join(PASSWORD_FILE)),
        env_hash: opts.password_hash.trim().to_string(),
        sessions: Mutex::new(HashMap::new()),
        failures: Mutex::new(vec![]),
        started_at: crate::util::now(),
        src: Source::new(opts.db_path.clone(), opts.data_dir.clone(), hub),
    });
    if admin.current_hash().is_none() {
        log("admin: no admin password hash set; refusing every request");
    }
    let host = if opts.host == "localhost" { "127.0.0.1".to_string() } else { opts.host.clone() };
    let listener = TcpListener::bind((host.as_str(), opts.port)).await.map_err(|e| format!("admin: listen {host}:{}: {e}", opts.port))?;
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let Ok((sock, _)) = listener.accept().await else { continue };
            let (admin, log) = (admin.clone(), log.clone());
            tokio::spawn(async move {
                let svc = service_fn(move |req| {
                    let (admin, log) = (admin.clone(), log.clone());
                    async move { Ok::<_, std::convert::Infallible>(admin.serve(req, &*log).await) }
                });
                let _ = http1::Builder::new().serve_connection(TokioIo::new(sock), svc).await;
            });
        }
    });
    Ok(port)
}

/// Wired into the hub with ADMIN_PORT (ADMIN_HOST, ADMIN_PUBLISHED_LOOPBACK, ADMIN_LOGINS, ADMIN_PASSWORD_HASH).
pub async fn start(hub: Arc<Hub>, host: &str, port: u16) -> Result<u16, String> {
    let dir = PathBuf::from(&hub.cfg.data_dir);
    let opts = Options {
        db_path: dir.join("hub.db"),
        data_dir: Some(dir),
        host: host.into(),
        port,
        allow_published_loopback: hub.cfg.get("ADMIN_PUBLISHED_LOOPBACK") == Some("1"),
        logins: hub.cfg.get("ADMIN_LOGINS").unwrap_or("").into(),
        password_hash: hub.cfg.get("ADMIN_PASSWORD_HASH").unwrap_or("").into(),
    };
    let h = hub.clone();
    start_with(opts, Some(hub), Arc::new(move |m: &str| h.log(m))).await
}

fn parse_cookies(h: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for part in h.split(';') {
        if let Some(i) = part.find('=') {
            if i > 0 {
                out.insert(part[..i].trim().to_string(), part[i + 1..].trim().to_string());
            }
        }
    }
    out
}
fn safe_equal(a: &str, b: &str) -> bool { zcrypto::bytes::bytes_equal(a.as_bytes(), b.as_bytes()) }

fn resp(status: u16, body: impl Into<Bytes>, ty: &str, extra: &[(&str, String)]) -> Response<Body> {
    let mut r = Response::new(Body::full(body.into()));
    *r.status_mut() = StatusCode::from_u16(status).unwrap();
    let h = r.headers_mut();
    h.insert("content-type", ty.parse().unwrap());
    h.insert("content-security-policy", view::csp().parse().unwrap());
    h.insert("cache-control", "no-store".parse().unwrap());
    h.insert("x-content-type-options", "nosniff".parse().unwrap());
    h.insert("referrer-policy", "no-referrer".parse().unwrap());
    for (k, v) in extra {
        h.insert(hyper::header::HeaderName::from_bytes(k.as_bytes()).unwrap(), v.parse().unwrap());
    }
    r
}
const HTML: &str = "text/html; charset=utf-8";
const TEXT: &str = "text/plain; charset=utf-8";
fn cookie(value: &str, max_age: i64) -> String { format!("{COOKIE}={value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age={max_age}") }
fn redirect(to: &str, extra: &[(&str, String)]) -> Response<Body> {
    let mut e = vec![("location", to.to_string())];
    e.extend(extra.iter().cloned());
    resp(303, "", "text/plain", &e)
}

async fn read_form(body: Incoming) -> Result<Vec<(String, String)>, ()> {
    let mut body = body;
    let mut out = Vec::new();
    while let Some(f) = body.frame().await {
        let f = f.map_err(|_| ())?;
        if let Some(d) = f.data_ref() {
            out.extend_from_slice(d);
            if out.len() > 4096 {
                return Err(());
            }
        }
    }
    Ok(crate::util::query_pairs(Some(&String::from_utf8_lossy(&out))))
}
fn form_get<'a>(f: &'a [(String, String)], k: &str) -> &'a str { f.iter().find(|(a, _)| a == k).map(|(_, v)| v.as_str()).unwrap_or("") }

impl Admin {
    fn current_hash(&self) -> Option<String> {
        if let Some(f) = &self.password_file {
            if let Ok(t) = std::fs::read_to_string(f) {
                let t = t.trim();
                if !t.is_empty() {
                    return Some(t.to_string());
                }
            }
        }
        if self.env_hash.is_empty() { None } else { Some(self.env_hash.clone()) }
    }
    fn write_hash(&self, hash: &str) -> std::io::Result<()> {
        let f = self.password_file.as_ref().ok_or_else(|| std::io::Error::other("no data dir"))?;
        let tmp = PathBuf::from(format!("{}.tmp-{}", f.display(), std::process::id()));
        crate::push::write_private(&tmp, format!("{hash}\n").as_bytes())?;
        std::fs::rename(&tmp, f)
    }
    fn limited(&self, login: &str) -> bool {
        let cutoff = crate::util::now() - FAIL_WINDOW_MS;
        let mut f = self.failures.lock();
        f.retain(|x| x.1 >= cutoff);
        f.len() >= FAILS_GLOBAL || f.iter().filter(|x| x.0 == login).count() >= FAILS_PER_LOGIN
    }
    fn fail(&self, login: &str) { self.failures.lock().push((login.into(), crate::util::now())) }
    fn session_for(&self, cookies: Option<&str>, login: &str) -> Option<(String, String)> {
        let token = parse_cookies(cookies.unwrap_or("")).get(COOKIE).cloned()?;
        let mut sessions = self.sessions.lock();
        let s = sessions.get(&token)?;
        if s.expires_at <= crate::util::now() {
            sessions.remove(&token);
            return None;
        }
        if s.login != login {
            return None;
        }
        Some((token, s.csrf.clone()))
    }

    async fn serve(self: &Arc<Self>, req: Request<Incoming>, log: &(dyn Fn(&str) + Send + Sync)) -> Response<Body> {
        let (parts, body) = req.into_parts();
        let login = header(&parts.headers, "tailscale-user-login").unwrap_or("").trim().to_lowercase();
        if login.is_empty() {
            return resp(403, "forbidden: missing Tailscale-User-Login (reach this page only via tailscale serve)\n", TEXT, &[]);
        }
        if !self.allowed.contains(&login) {
            return resp(403, "forbidden: this Tailscale login is not allowed\n", TEXT, &[]);
        }
        let Some(hash) = self.current_hash() else { return resp(403, "forbidden: no admin password set (trommi-hub hash)\n", TEXT, &[]) };
        let path = parts.uri.path().to_string();
        let method = parts.method.as_str().to_string();
        let params = crate::util::query_pairs(parts.uri.query());
        if path == "/login" && method == "POST" {
            if self.limited(&login) {
                return resp(429, "too many attempts, try again later\n", TEXT, &[("retry-after", (FAIL_WINDOW_MS / 1000).to_string())]);
            }
            let Ok(form) = read_form(body).await else { return resp(413, "too large\n", TEXT, &[]) };
            let pw = form_get(&form, "password").to_string();
            let h = hash.clone();
            let ok = tokio::task::spawn_blocking(move || verify_password(&pw, &h)).await.unwrap_or(false);
            if !ok {
                self.fail(&login);
                return resp(403, view::render_login_page(&login, "Wrong password."), HTML, &[]);
            }
            self.failures.lock().retain(|f| f.0 != login);
            let token = zcrypto::b64u(&crate::util::random_bytes(32));
            self.sessions.lock().insert(token.clone(), Session { login: login.clone(), expires_at: crate::util::now() + SESSION_MS, csrf: zcrypto::b64u(&crate::util::random_bytes(16)) });
            return redirect("/", &[("set-cookie", cookie(&token, SESSION_MS / 1000))]);
        }
        let Some((token, csrf)) = self.session_for(header(&parts.headers, "cookie"), &login) else {
            if method == "GET" || method == "HEAD" {
                return resp(403, if method == "HEAD" { String::new() } else { view::render_login_page(&login, "") }, HTML, &[]);
            }
            return resp(403, "forbidden: sign in first\n", TEXT, &[]);
        };
        if method == "POST" {
            let Ok(form) = read_form(body).await else { return resp(413, "too large\n", TEXT, &[]) };
            if !safe_equal(form_get(&form, "csrf"), &csrf) {
                return resp(403, "forbidden: bad form token\n", TEXT, &[]);
            }
            if path == "/logout" {
                self.sessions.lock().remove(&token);
                return redirect("/", &[("set-cookie", cookie("", 0))]);
            }
            if path == "/password" {
                if self.limited(&login) {
                    return resp(429, "too many attempts, try again later\n", TEXT, &[]);
                }
                let (current, new1, new2) = (form_get(&form, "current").to_string(), form_get(&form, "new1").to_string(), form_get(&form, "new2").to_string());
                let h = hash.clone();
                let ok = tokio::task::spawn_blocking(move || verify_password(&current, &h)).await.unwrap_or(false);
                if !ok {
                    self.fail(&login);
                    return resp(403, view::render_password_page(&login, &csrf, "Current password is wrong.", MIN_PASSWORD), HTML, &[]);
                }
                if new1 != new2 {
                    return resp(400, view::render_password_page(&login, &csrf, "The new passwords differ.", MIN_PASSWORD), HTML, &[]);
                }
                if new1.chars().count() < MIN_PASSWORD {
                    return resp(400, view::render_password_page(&login, &csrf, &format!("The new password needs at least {MIN_PASSWORD} characters."), MIN_PASSWORD), HTML, &[]);
                }
                let h = tokio::task::spawn_blocking(move || hash_password(&new1)).await.unwrap();
                if let Err(e) = self.write_hash(&h) {
                    log(&format!("admin: {e}"));
                    return resp(500, "internal error\n", TEXT, &[]);
                }
                self.sessions.lock().clear();
                log(&format!("admin: password changed by {login}; all sessions ended"));
                return redirect("/", &[("set-cookie", cookie("", 0))]);
            }
            return resp(404, "not found\n", TEXT, &[]);
        }
        if method != "GET" && method != "HEAD" {
            return resp(405, "method not allowed\n", TEXT, &[]);
        }
        let head = method == "HEAD";
        if path == "/password" {
            return resp(200, if head { String::new() } else { view::render_password_page(&login, &csrf, "", MIN_PASSWORD) }, HTML, &[]);
        }
        let wants_data = path == "/data" || (path == "/" && params.iter().any(|(k, _)| k == "table"));
        if path != "/" && path != "/data" {
            return resp(404, "not found\n", TEXT, &[]);
        }
        let src = &self.src;
        let started = self.started_at;
        let page = if wants_data {
            // (the connection's guard must be gone before render_data takes it again)
            let exists = src.db().is_some();
            if !exists {
                return resp(503, "hub.db does not exist yet\n", TEXT, &[]);
            }
            view::render_data(src, &params, &login, &csrf)
        } else {
            let range = params.iter().find(|(k, _)| k == "range").map(|(_, v)| v.clone());
            view::render_overview(src, started, range.as_deref(), crate::util::now(), &login, &csrf)
        };
        match page {
            Ok(p) => resp(200, if head { String::new() } else { p }, HTML, &[]),
            Err(e) => {
                log(&format!("admin: {e}"));
                resp(500, "internal error\n", TEXT, &[])
            }
        }
    }
}
