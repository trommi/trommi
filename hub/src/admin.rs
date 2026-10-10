//! The hub's admin page: three read-only pages for whoever runs the hub (`admin_view.rs`: the overview, the
//! accounts, the tables). It listens on 127.0.0.1 (`HUB_ADMIN_HOST` for a container, whose port is then published
//! to the host's loopback only), on a port of its own, and only when a password hash is configured
//! (`HUB_ADMIN_PASSWORD_HASH`); it is never part of the public port. It shows what the hub can see and nothing
//! else: the server's health, rooms and accounts with their counts, the hub's tables with what kind of data each
//! holds, the running version. No content: the hub has none.
//!
//! Sign-in is a plain HTML form (user name "admin", the one password), so a password manager fills it. A right
//! password gives a session cookie: 32 random bytes, `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`, twelve
//! hours, kept in memory only (a restart signs everyone out). The page is reached over https (a TLS proxy in front
//! of the loopback listener), so the browser keeps a `Secure` cookie. The only requests that change anything are
//! `POST /login` and `POST /logout`: both are taken only from the page's own origin (`Origin` equal to the `Host`
//! or `X-Forwarded-Host` the request came with, and no cross-site `Sec-Fetch-Site`), and the cookie is never sent
//! with a request another site starts.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::Incoming;
use hyper::{Method, Request, Response, StatusCode};

use crate::app::App;
use crate::util::{b64, now, random, sha256, unb64};

/// how long a session lasts after sign-in
const SESSION_MS: u64 = 12 * 3_600_000;
const MAX_SESSIONS: usize = 16;
/// the session cookie's name (`__Host-`: only with `Secure`, `Path=/` and no `Domain`)
pub const COOKIE: &str = "__Host-trommi_admin";
/// the longest wait after wrong passwords
const BACKOFF_MAX_MS: u64 = 60_000;
/// the page is computed once for all who ask within this time
const PAGE_MS: u64 = 5_000;
/// connections the admin listener holds at a time, and how long one may last
pub const MAX_CONNECTIONS: usize = 16;
/// the longest password `admin-hash` takes, and the longest form the page reads (such a password, form-encoded)
pub const MAX_PASSWORD: usize = 1024;
const MAX_FORM: usize = 4 * MAX_PASSWORD;
pub const CONNECTION_MS: u64 = 60_000;

/// Sessions and the page's own throttle: after each wrong password the page takes no other for 1 s, 2 s, 4 s …
/// up to a minute, whoever asks (it has one user), and it checks one password at a time.
pub struct Admin {
    state: Mutex<State>,
    /// each page as last computed (by its path and table), and whether one is being computed now
    pages: Mutex<HashMap<String, (u64, String)>>,
    computing: AtomicBool,
}

impl Default for Admin {
    fn default() -> Self {
        Admin {
            state: Default::default(),
            pages: Default::default(),
            computing: AtomicBool::new(false),
        }
    }
}

#[derive(Default)]
struct State {
    /// SHA-256 of each session's cookie value, with the time until which it holds
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

pub(crate) fn esc(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// The bell of the web app, drawn by hand.
const BELL: &str = "<svg viewBox=\"1.5 2.5 23 19\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" \
stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M3.1 19Q12.3 18.6 16.7 19L21 19.3\"/><path d=\"M4.8 18.9Q5.2 15.1 5.7 13.7Q6.2 12.3 \
7.5 11.3Q8.7 10.3 10.3 9.5Q12 8.8 13.7 9.3Q15.3 9.8 16.4 11Q17.5 12.2 18.1 13.7Q18.6 15.2 18.8 17L18.9 18.8\"/><path d=\"M11.8 8.6L12.2 6.9\"/>\
<path d=\"M10 6.6Q11.8 6 12.8 6.4L13.8 6.8\"/><path d=\"M18.5 7.3Q19.5 5.8 19.8 5.2L20 4.5\"/><path d=\"M20.6 10.3Q21.5 9.4 22.3 8.9L23.1 8.5\"/></svg>";

/// The marks of the tables: sealed (a lock) and read by the hub (an eye).
pub(crate) const LOCK: &str = "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><rect x=\"5\" y=\"11\" width=\"14\" height=\"9.5\" rx=\"2\"/>\
<path d=\"M8.2 11V8a3.8 3.8 0 0 1 7.6 0v3\"/></svg>";
pub(crate) const EYE: &str = "<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z\"/>\
<circle cx=\"12\" cy=\"12\" r=\"2.8\"/></svg>";

fn brand() -> String {
    format!("<span class=\"brand\">{BELL}<b>Trommi</b> <small>hub admin</small></span>")
}

/// A whole page: `body` inside the page's frame.
fn page(status: StatusCode, body: &str) -> Response<Full<Bytes>> {
    let html = format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\
<meta name=\"color-scheme\" content=\"light dark\"><title>Trommi hub admin</title><style>{STYLE}</style></head><body>{body}</body></html>"
    );
    Response::builder()
        .status(status)
        .header("content-type", "text/html; charset=utf-8")
        .header("cache-control", "no-store")
        .header("x-content-type-options", "nosniff")
        // (`same-origin`, not `no-referrer`: under that a browser names its form POSTs `Origin: null`)
        .header("referrer-policy", "same-origin")
        .header("cross-origin-resource-policy", "same-origin")
        .header(
            "content-security-policy",
            "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
        )
        .body(Full::new(Bytes::from(html)))
        .expect("a valid response")
}

/// A short page with a note, for what is not the overview.
fn notice(status: StatusCode, note: &str) -> Response<Full<Bytes>> {
    page(
        status,
        &format!(
            "<div class=\"login\">{}<p class=\"muted\">{}</p></div>",
            brand(),
            esc(note)
        ),
    )
}

/// The look of the web app (colours, type, radii), copied from the hub's previous admin page; one inline sheet,
/// no fonts fetched (the faces are used where the system has them). Dark follows the system.
const STYLE: &str = r#":root{color-scheme:light;--bg:#f5f6f2;--surface:#fff;--surface-2:#fafbf8;--sunken:#eceee8;--fg:#141c18;--muted:#5c6862;--faint:#8a958f;
--line:#e1e5df;--line-strong:#c9d0c8;--accent:#1b6a57;--accent-soft:#dcefe8;--warn:#b4551b;--bad:#b3261e;--bad-soft:#fbe0de;
--display:"Bricolage Grotesque","Avenir Next","Segoe UI Variable Display","Segoe UI",system-ui,sans-serif;
--font:"IBM Plex Sans","Segoe UI",system-ui,sans-serif;--mono:"IBM Plex Mono",ui-monospace,"SF Mono",Menlo,monospace}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#0e1311;--surface:#171d1a;--surface-2:#1c2420;--sunken:#111715;--fg:#e9eeea;
--muted:#9aa8a0;--faint:#6c7a73;--line:#252f2a;--line-strong:#35423b;--accent:#6fd0b5;--accent-soft:#17332b;--warn:#f2a56c;--bad:#ff8a80;--bad-soft:#41191a}}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 var(--font);-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%}
h1,h2,h3,p{margin:0}
h1{font:800 1.7rem/1.15 var(--display);letter-spacing:-.01em}
h3{font:700 1.05rem/1.3 var(--display);display:flex;justify-content:space-between;align-items:baseline;gap:10px;margin-bottom:10px}
button,input{font:inherit;color:inherit}
input{background:var(--surface);border:1px solid var(--line-strong);border-radius:8px;padding:8px 11px;min-width:0}
input[readonly]{background:var(--sunken);color:var(--muted)}
:focus{outline:none}
:is(a,button,input):focus-visible{outline:2px solid var(--fg);outline-offset:2px}
button{min-height:36px;background:var(--surface);border:1px solid var(--line-strong);border-radius:999px;padding:0 16px;font-size:.84rem;font-weight:600;cursor:pointer;white-space:nowrap}
button:hover{border-color:var(--fg)}
button.primary{background:var(--fg);border-color:var(--fg);color:var(--bg);min-height:40px}
::selection{background:var(--accent-soft)}
code{font-family:var(--mono);font-size:.8rem}
.muted{color:var(--muted)}.faint{color:var(--faint)}
p.err{padding:9px 14px;border-radius:12px;background:var(--bad-soft);font-size:.84rem;font-weight:500}
.top{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:8px;height:52px;padding:0 20px;background:var(--surface);border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:8px;white-space:nowrap}
.brand svg{width:26px;height:26px;color:var(--accent)}
.brand b{font:800 1.1rem/1 var(--display)}
.brand small{font-size:.72rem;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--faint)}
.who{margin-left:auto;display:flex;align-items:center;gap:12px;font-size:.84rem;color:var(--muted);white-space:nowrap}
.who form{margin:0}.who button{min-height:32px;padding:0 13px}
.page{max-width:1280px;margin:0 auto;padding:28px 24px 56px}
.head{display:flex;align-items:baseline;gap:6px 14px;flex-wrap:wrap;margin-bottom:20px}
.head .muted{font-size:.84rem}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:12px;margin-bottom:12px}
.tile,.card{background:var(--surface);border:1px solid var(--line);border-radius:12px;min-width:0}
.tile{padding:14px 16px 12px}
.tile .k{font-size:.72rem;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--faint)}
.tile .v{font:800 1.7rem/1.3 var(--display);font-variant-numeric:tabular-nums;white-space:nowrap}
.tile .v small{font:500 .84rem var(--font);color:var(--muted);margin-left:4px}
.tile .s{font-size:.78rem;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.card{padding:16px 18px}.card+.card{margin-top:12px}
.count{color:var(--faint);font:500 .78rem var(--font);font-variant-numeric:tabular-nums}
.scroll{overflow:auto}
table.grid{border-collapse:separate;border-spacing:0;font-size:.84rem;min-width:100%}
.grid th{background:var(--surface);border-bottom:1.5px solid var(--fg);text-align:left;font-weight:600;padding:8px 12px 7px;white-space:nowrap;vertical-align:bottom}
.grid td{padding:6px 12px;border-bottom:1px solid var(--line);vertical-align:top}
.grid tr:last-child td{border-bottom:0}
.grid tbody tr:hover td{background:var(--surface-2)}
.grid .n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.grid td.when,.grid td:first-child{white-space:nowrap}
.cm{display:inline-flex;align-items:flex-start;gap:5px;color:var(--muted)}
.cm svg{width:14px;height:14px;flex:none;margin-top:3px;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}
.cm-e2e{color:var(--accent)}.cm-plain svg{color:var(--warn)}
.legend{display:flex;flex-wrap:wrap;gap:6px 22px;font-size:.84rem;color:var(--muted);margin:0 0 12px}
.legend .cm{font-weight:600}
.note{font-size:.78rem;color:var(--muted);margin:10px 0 0}
.login{max-width:400px;margin:14vh auto 0;background:var(--surface);border:1px solid var(--line);border-radius:18px;padding:28px}
.login .brand{margin:0 0 20px}
.login h1{font-size:1.35rem;margin-bottom:4px}
.login form{display:flex;flex-direction:column;gap:14px;margin-top:18px}
.login p.err{margin-top:14px}
.login label{display:flex;flex-direction:column;gap:5px;font-size:.84rem;font-weight:500;color:var(--muted)}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.top nav{display:flex;gap:2px;min-width:0;margin-left:14px}
.top nav a{padding:6px 12px;border-radius:999px;color:var(--muted);font-size:.9rem;font-weight:500;white-space:nowrap}
.top nav a:hover{color:var(--fg);background:var(--sunken);text-decoration:none}
.top nav a.on{background:var(--sunken);color:var(--fg);font-weight:600}
h2.fam{font-size:.72rem;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--faint);margin:4px 0 8px}
.cols{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,2fr);gap:12px;margin-top:12px}
.cols .card+.card{margin-top:0}
.kv{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px 16px;margin:0;font-size:.84rem}
.kv dt{color:var(--muted)}.kv dd{margin:0;min-width:0;overflow-wrap:anywhere}
.tlist{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:0 18px;margin:0 -8px;padding:0;list-style:none;font-size:.84rem}
.tlist a{display:flex;justify-content:space-between;align-items:baseline;gap:8px;padding:4px 8px;border-radius:8px;color:var(--fg)}
.tlist a:hover{background:var(--sunken);text-decoration:none}
code.big{font-size:1.3rem;font-weight:600}
.data{display:grid;grid-template-columns:290px minmax(0,1fr);min-height:calc(100dvh - 52px)}
.pane{padding:24px 24px 56px;min-width:0}
.tree{background:var(--surface-2);border-right:1px solid var(--line);padding:10px 10px 32px;font-size:.84rem;overflow:auto;max-height:calc(100dvh - 52px);position:sticky;top:52px}
.tree .grp{font-size:.72rem;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--faint);padding:14px 8px 5px}
.tree a.node{display:flex;justify-content:space-between;align-items:baseline;gap:8px;padding:5px 8px;border-radius:8px;color:var(--fg);font-weight:600}
.tree a.node:hover{background:var(--sunken);text-decoration:none}
.tree a.node.on,.tree details.on>summary{background:var(--accent-soft)}
.tree summary{display:flex;align-items:center;gap:8px;padding:4px 8px;border-radius:8px;cursor:pointer;list-style:none;white-space:nowrap}
.tree summary::-webkit-details-marker{display:none}
.tree summary:hover{background:var(--sunken)}
.tree summary::before{content:"";align-self:center;flex:none;border:4px solid transparent;border-left:5px solid var(--faint);border-right:0}
.tree details[open]>summary::before{transform:rotate(90deg)}
.tree summary .name{display:inline-flex;align-items:center;gap:4px;overflow:hidden;text-overflow:ellipsis;font-family:var(--mono);font-size:.8rem}
.tree summary .count{margin-left:auto}
.tree .cm svg{margin-top:0}
.cols-list{list-style:none;margin:2px 0 8px 13px;padding:2px 0 2px 9px;border-left:1px solid var(--line-strong);font-size:.78rem}
.cols-list li{display:flex;justify-content:space-between;gap:8px;padding:1px 4px;font-family:var(--mono)}
.cols-list li span:first-child{display:inline-flex;align-items:center;gap:3px;min-width:0;overflow:hidden;text-overflow:ellipsis}
.cols-list li.open{font-family:var(--font);padding-top:4px}
.treetoggle{display:none}
#tt{position:absolute;opacity:0;pointer-events:none;width:1px;height:1px}
@media (max-width:820px){
.top{padding:0 12px}.brand small{display:none}.brand b{display:none}
.top nav{margin-left:4px;overflow-x:auto;scrollbar-width:none}.top nav a{padding:6px 9px;font-size:.84rem}
.who .login-name{display:none}
.cols{grid-template-columns:minmax(0,1fr)}
.data{display:flex;flex-direction:column;min-height:0}
.pane{padding:20px 16px 40px}
.treetoggle{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:11px 16px;border-bottom:1px solid var(--line);background:var(--surface-2);font-size:.84rem;cursor:pointer}
.treetoggle::after{content:"";flex:none;border:5px solid transparent;border-top:6px solid var(--muted);border-bottom:0}
.tree{display:none;position:static;border-right:0;border-bottom:1px solid var(--line);max-height:60vh}
#tt:checked~.data .tree{display:block}
.page{padding:20px 16px 40px}
h1{font-size:1.35rem}
.tile .v{font-size:1.35rem}.tiles{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.tile{padding:12px 13px 10px}
.card{padding:14px}
.login{margin:8vh 16px 0;padding:22px}
}"#;

/// The sign-in form, with a note above it if there is one.
fn login(status: StatusCode, error: &str) -> Response<Full<Bytes>> {
    page(
        status,
        &format!(
            "<div class=\"login\">{}<h1>Sign in</h1><p class=\"muted\">The admin page of this hub. It shows what the hub can see: no content.</p>{}\
<form method=\"post\" action=\"/login\"><label>User <input type=\"text\" name=\"username\" value=\"admin\" autocomplete=\"username\" readonly></label>\
<label>Password <input type=\"password\" name=\"password\" autocomplete=\"current-password\" required autofocus></label>\
<button class=\"primary\">Sign in</button></form></div>",
            brand(),
            if error.is_empty() {
                String::new()
            } else {
                format!("<p class=\"err\">{}</p>", esc(error))
            }
        ),
    )
}

fn wait(seconds: u64) -> Response<Full<Bytes>> {
    let mut answer = login(
        StatusCode::TOO_MANY_REQUESTS,
        &format!("Too many attempts. Try again in {seconds} s."),
    );
    answer.headers_mut().insert("retry-after", seconds.into());
    answer
}

/// To `/`, with this cookie (none if empty).
fn to_start(cookie: String) -> Response<Full<Bytes>> {
    let mut answer = page(StatusCode::SEE_OTHER, "");
    answer
        .headers_mut()
        .insert("location", "/".parse().expect("static"));
    if let Some(value) = Some(&cookie)
        .filter(|c| !c.is_empty())
        .and_then(|c| c.parse().ok())
    {
        answer.headers_mut().insert("set-cookie", value);
    }
    answer
}

/// The session cookie's value, if the request has one of the right form.
fn cookie(req: &Request<Incoming>) -> Option<[u8; 32]> {
    req.headers()
        .get_all("cookie")
        .iter()
        .filter_map(|header| header.to_str().ok())
        .flat_map(|header| header.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(name, _)| *name == COOKIE)
        .and_then(|(_, value)| unb64(value))
        .and_then(|bytes| bytes.try_into().ok())
}

/// Did the page itself send this request? Its `Origin` (which a browser sends with every POST) names the host the
/// request was sent to, and the browser does not say it came from another site.
fn same_origin(req: &Request<Incoming>) -> bool {
    let header = |name: &str| req.headers().get(name).and_then(|v| v.to_str().ok());
    if matches!(header("sec-fetch-site"), Some(site) if site != "same-origin" && site != "none") {
        return false;
    }
    let Some(origin) = header("origin") else {
        return false;
    };
    let Some((_, authority)) = origin.split_once("://") else {
        return false;
    };
    if authority.is_empty() || authority.contains('/') {
        return false;
    }
    [header("host"), header("x-forwarded-host")]
        .into_iter()
        .flatten()
        .any(|host| host.eq_ignore_ascii_case(authority))
}

/// A form's body, read up to `MAX_FORM` bytes and ten seconds.
async fn form(req: Request<Incoming>) -> Option<HashMap<String, Vec<u8>>> {
    let body = Limited::new(req.into_body(), MAX_FORM);
    let bytes = tokio::time::timeout(Duration::from_secs(10), body.collect())
        .await
        .ok()?
        .ok()?
        .to_bytes();
    let mut fields = HashMap::new();
    for pair in bytes.split(|b| *b == b'&').filter(|p| !p.is_empty()) {
        let mut parts = pair.splitn(2, |b| *b == b'=');
        let name = String::from_utf8(unescape(parts.next()?)?).ok()?;
        fields.insert(name, unescape(parts.next().unwrap_or_default())?);
    }
    Some(fields)
}

/// `application/x-www-form-urlencoded`: `+` is a space, `%XX` a byte.
fn unescape(text: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len());
    let mut i = 0;
    while i < text.len() {
        match text[i] {
            b'+' => out.push(b' '),
            b'%' => {
                let hex = std::str::from_utf8(text.get(i + 1..i + 3)?).ok()?;
                out.push(u8::from_str_radix(hex, 16).ok()?);
                i += 2;
            }
            b => out.push(b),
        }
        i += 1;
    }
    Some(out)
}

impl Admin {
    fn signed_in(&self, token: &[u8; 32]) -> bool {
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let t = now();
        s.sessions.retain(|_, until| *until > t);
        s.sessions.contains_key(&sha256(token))
    }

    fn sign_out(&self, token: &[u8; 32]) {
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        s.sessions.remove(&sha256(token));
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

    /// The check is over: `Some(right)`, or `None` if nothing was checked. A right one opens the session `token`.
    fn checked(&self, outcome: Option<bool>, token: &[u8; 32]) {
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
                s.sessions.insert(sha256(token), now() + SESSION_MS);
            }
        }
    }
}

/// A password check that ends in `checked` whatever becomes of the request or the thread.
struct Checking {
    app: Arc<App>,
    token: [u8; 32],
    outcome: Option<bool>,
}

impl Drop for Checking {
    fn drop(&mut self) {
        self.app.admin.checked(self.outcome, &self.token);
    }
}

fn set_cookie(token: &[u8; 32]) -> String {
    format!(
        "{COOKIE}={}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age={}",
        b64(token),
        SESSION_MS / 1000
    )
}

fn clear_cookie() -> String {
    format!("{COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0")
}

/// One request to the admin listener.
pub async fn handle(app: Arc<App>, req: Request<Incoming>) -> Response<Full<Bytes>> {
    let Some(hash) = app.cfg.admin_password_hash.clone() else {
        return notice(StatusCode::NOT_FOUND, "Not found.");
    };
    let session = cookie(&req).filter(|token| app.admin.signed_in(token));
    match (req.method().clone(), req.uri().path()) {
        (Method::GET, "/") => match session {
            Some(_) => shown(app, Page::Overview).await,
            None => login(StatusCode::OK, ""),
        },
        (Method::GET, "/accounts") if session.is_some() => shown(app, Page::Accounts).await,
        (Method::GET, "/tables") if session.is_some() => {
            let named = req
                .uri()
                .query()
                .unwrap_or("")
                .split('&')
                .find_map(|pair| pair.strip_prefix("t="));
            match named.map(crate::admin_view::table_named) {
                None => shown(app, Page::Tables(None)).await,
                Some(Some(table)) => shown(app, Page::Tables(Some(table))).await,
                Some(None) => notice(StatusCode::NOT_FOUND, "No such table."),
            }
        }
        (Method::GET, "/accounts" | "/tables") => to_start(String::new()),
        (Method::POST, "/login") => {
            if !same_origin(&req) {
                return notice(StatusCode::FORBIDDEN, "Sign in from the admin page itself.");
            }
            let Some(password) = form(req).await.and_then(|mut f| f.remove("password")) else {
                return login(StatusCode::BAD_REQUEST, "Type the password.");
            };
            if password.is_empty() || password.len() > MAX_PASSWORD {
                return login(StatusCode::UNAUTHORIZED, "Wrong password.");
            }
            if let Err(seconds) = app.admin.admit() {
                return wait(seconds);
            }
            // The slow hash runs on the hub's pool, and the job itself ends the check: a request that goes away
            // meanwhile leaves nothing open. If the pool is busy, nothing was checked.
            let token: [u8; 32] = random();
            let mut checking = Checking {
                app: app.clone(),
                token,
                outcome: None,
            };
            let right = tokio::task::spawn_blocking(move || {
                checking.outcome = checking.app.pooled(|| verify(&hash, &password)).ok();
                checking.outcome
            })
            .await;
            match right {
                Ok(Some(true)) => {
                    crate::log::info("admin_signed_in", serde_json::json!({}));
                    to_start(set_cookie(&token))
                }
                Ok(Some(false)) => {
                    crate::log::info("admin_wrong_password", serde_json::json!({}));
                    login(StatusCode::UNAUTHORIZED, "Wrong password.")
                }
                _ => notice(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "The hub is busy. Try again in a moment.",
                ),
            }
        }
        (Method::POST, "/logout") => {
            if !same_origin(&req) {
                return notice(
                    StatusCode::FORBIDDEN,
                    "Sign out from the admin page itself.",
                );
            }
            if let Some(token) = session {
                app.admin.sign_out(&token);
                crate::log::info("admin_signed_out", serde_json::json!({}));
            }
            to_start(clear_cookie())
        }
        _ => notice(StatusCode::NOT_FOUND, "Not found."),
    }
}

/// The three pages behind the sign-in.
#[derive(Clone, Copy, PartialEq)]
enum Page {
    Overview,
    Accounts,
    Tables(Option<&'static str>),
}

impl Page {
    fn key(self) -> String {
        match self {
            Page::Overview => "/".into(),
            Page::Accounts => "/accounts".into(),
            Page::Tables(None) => "/tables".into(),
            Page::Tables(Some(t)) => format!("/tables?t={t}"),
        }
    }
}

/// A page inside the top bar with its navigation.
fn signed_in_page(status: StatusCode, on: Page, main: &str) -> Response<Full<Bytes>> {
    let tab = |href: &str, label: &str, here: bool| {
        format!(
            "<a href=\"{href}\"{}>{label}</a>",
            if here {
                " class=\"on\" aria-current=\"page\""
            } else {
                ""
            }
        )
    };
    page(
        status,
        &format!(
            "<header class=\"top\">{}<nav>{}{}{}</nav><div class=\"who\"><span class=\"login-name\">admin</span><form method=\"post\" action=\"/logout\">\
<button>Sign out</button></form></div></header>{}",
            brand(),
            tab("/", "Overview", on == Page::Overview),
            tab("/accounts", "Accounts", on == Page::Accounts),
            tab("/tables", "Tables", matches!(on, Page::Tables(_))),
            if main.starts_with('<') { main.to_string() } else { format!("<main class=\"page\"><p class=\"muted\">{}</p></main>", esc(main)) }
        ),
    )
}

async fn shown(app: Arc<App>, on: Page) -> Response<Full<Bytes>> {
    // a page is computed by one request at a time and kept for a few seconds: it reads every table
    let t = now();
    let key = on.key();
    let cached = {
        let mut pages = app.admin.pages.lock().unwrap_or_else(|e| e.into_inner());
        pages.retain(|_, (at, _)| t < *at + PAGE_MS);
        pages.get(&key).map(|(_, html)| html.clone())
    };
    if let Some(html) = cached {
        return signed_in_page(StatusCode::OK, on, &html);
    }
    if app.admin.computing.swap(true, Ordering::SeqCst) {
        // (an older page is not shown as the hub's state of now)
        return signed_in_page(
            StatusCode::SERVICE_UNAVAILABLE,
            on,
            "The page is being put together. Try again in a moment.",
        );
    }
    let computed = tokio::task::spawn_blocking(move || {
        struct Done(Arc<App>);
        impl Drop for Done {
            fn drop(&mut self) {
                self.0.admin.computing.store(false, Ordering::SeqCst);
            }
        }
        let done = Done(app);
        let html = match on {
            Page::Overview => crate::admin_view::overview(&done.0),
            Page::Accounts => crate::admin_view::accounts(&done.0),
            Page::Tables(t) => crate::admin_view::tables(&done.0, t),
        };
        if let Ok(html) = &html {
            done.0
                .admin
                .pages
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(key, (now(), html.clone()));
        }
        html
    })
    .await;
    match computed {
        Ok(Ok(html)) => signed_in_page(StatusCode::OK, on, &html),
        _ => signed_in_page(
            StatusCode::INTERNAL_SERVER_ERROR,
            on,
            "The database did not answer.",
        ),
    }
}
