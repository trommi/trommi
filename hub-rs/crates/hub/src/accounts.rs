//! Email + password logins (hub/accounts.mjs, README "Accounts"). An account maps an email to ONE room and keeps
//! what a new device needs, all opaque to the hub: a scrypt hash of the client's auth key, the room's recovery code
//! wrapped under the password, and optionally under the Emergency Kit. Same table, same scrypt parameters.

use crate::config::{env_number, Config};
use crate::error::{Fail, HResult};
use crate::http::{json, read_json_ops, Resp};
use crate::limits::Window;
use crate::mail::Mailer;
use crate::server::{Ctx, Hub};
use crate::util::now;
use parking_lot::Mutex;
use rusqlite::{params, OptionalExtension, Row};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use unicode_normalization::UnicodeNormalization;

const HOUR: i64 = 3600000;
const CODE_MS: i64 = 30 * 60000;
const MAX_CLAIMS: usize = 5;

pub struct Accounts {
    pub mailer: Mailer,
    pub ttl: i64,
    pub expire: bool,
    ip_limit: Window,
    max_failures: usize,
    failures: Mutex<indexmap::IndexMap<String, Vec<i64>>>,
    mail_limit: Window,
    resend_limit: Window,
    dummy_salt: Vec<u8>,
}

fn refuse(status: u16, code: &str, msg: &str) -> Fail { Fail::reply(status, code, msg, json!({})) }

pub fn normalise_email(v: Option<&Value>) -> HResult<String> {
    let e: String = match v {
        Some(Value::String(s)) => s.nfc().collect::<String>().trim().to_lowercase(),
        _ => String::new(),
    };
    if crate::util::js_len(&e) > 254 || !email_ok(&e) {
        return Err(refuse(400, "bad-email", "not an email address"));
    }
    Ok(e)
}
/// /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/ (lengths in UTF-16 units, as JavaScript counts them)
fn email_ok(e: &str) -> bool {
    let plain = |s: &str| !s.chars().any(|c| c.is_whitespace() || c == '@' || c == '\u{feff}');
    let Some((local, domain)) = e.split_once('@') else { return false };
    let lu = crate::util::js_len(local);
    if !(1..=64).contains(&lu) || !plain(local) || !plain(domain) {
        return false;
    }
    domain.match_indices('.').any(|(i, _)| {
        let (a, b) = (&domain[..i], &domain[i + 1..]);
        (1..=190).contains(&crate::util::js_len(a)) && (2..=63).contains(&crate::util::js_len(b))
    })
}
fn bytes_arg(v: Option<&Value>, what: &str, len: usize) -> HResult<Vec<u8>> {
    let s = v.and_then(|v| v.as_str()).filter(|s| !s.is_empty() && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-'));
    let Some(s) = s else { return Err(refuse(400, "bad-argument", &format!("{what} (base64url) is missing"))) };
    let b = crate::push::b64_lenient(s);
    if len > 0 && b.len() != len {
        return Err(refuse(400, "bad-argument", &format!("{what} is {len} bytes")));
    }
    if b.len() > 512 {
        return Err(refuse(400, "bad-argument", &format!("{what} is too long")));
    }
    Ok(b)
}
fn int_of(v: Option<&Value>) -> Option<i64> { v.and_then(crate::util::safe_int) }
fn kdf_arg(v: Option<&Value>) -> HResult<String> {
    let bad = || refuse(400, "bad-argument", "kdf: { alg: argon2id, v: 1, m, t, p }");
    let Some(o) = v.and_then(|v| v.as_object()) else { return Err(bad()) };
    let (m, t, p) = (int_of(o.get("m")), int_of(o.get("t")), int_of(o.get("p")));
    if o.get("alg").and_then(|a| a.as_str()) != Some("argon2id") || o.get("v").and_then(|x| x.as_f64()) != Some(1.0) {
        return Err(bad());
    }
    let (Some(m), Some(t), Some(p)) = (m, t, p) else { return Err(bad()) };
    if !(19456..=(1 << 21)).contains(&m) || !(1..=20).contains(&t) || !(1..=8).contains(&p) {
        return Err(bad());
    }
    Ok(serde_json::to_string(&json!({ "alg": "argon2id", "v": 1, "m": m, "t": t, "p": p })).unwrap())
}
/// scrypt N = 16384, r = 8, p = 1, 32 bytes (Node's crypto.scrypt defaults as accounts.mjs sets them).
pub async fn slow_hash(secret: Vec<u8>, salt: Vec<u8>) -> Vec<u8> {
    tokio::task::spawn_blocking(move || {
        let params = scrypt::Params::new(14, 8, 1, 32).unwrap();
        let mut out = vec![0u8; 32];
        scrypt::scrypt(&secret, &salt, &params, &mut out).unwrap();
        out
    })
    .await
    .unwrap()
}
fn code_hash(salt: &[u8], code: &str) -> [u8; 32] { zcrypto::prim::sha256(&[salt, code.as_bytes()]) }

#[derive(Clone)]
struct Account {
    room_id: String,
    email: String,
    email_verified_at: Option<i64>,
    created_at: i64,
    updated_at: i64,
    revision: i64,
    auth_salt: Vec<u8>,
    auth_hash: Vec<u8>,
    key_wrapped: Vec<u8>,
    kdf: String,
    recovery_salt: Option<Vec<u8>>,
    recovery_hash: Option<Vec<u8>>,
    recovery_wrapped: Option<Vec<u8>>,
    code_salt: Option<Vec<u8>>,
    code_hash: Option<Vec<u8>>,
    code_expires_at: Option<i64>,
    code_attempts: i64,
}
const COLS: &str = "room_id, email, email_verified_at, created_at, updated_at, revision, auth_salt, auth_hash, key_wrapped, kdf, recovery_salt, recovery_hash, recovery_wrapped, code_salt, code_hash, code_expires_at, code_attempts";
fn account(r: &Row) -> rusqlite::Result<Account> {
    Ok(Account {
        room_id: r.get(0)?,
        email: r.get(1)?,
        email_verified_at: r.get(2)?,
        created_at: r.get(3)?,
        updated_at: r.get(4)?,
        revision: r.get(5)?,
        auth_salt: r.get(6)?,
        auth_hash: r.get(7)?,
        key_wrapped: r.get(8)?,
        kdf: r.get(9)?,
        recovery_salt: r.get(10)?,
        recovery_hash: r.get(11)?,
        recovery_wrapped: r.get(12)?,
        code_salt: r.get(13)?,
        code_hash: r.get(14)?,
        code_expires_at: r.get(15)?,
        code_attempts: r.get(16)?,
    })
}

impl Accounts {
    pub fn new(cfg: &Config) -> Result<Accounts, String> {
        let mailer = Mailer::new(cfg)?;
        let expire = cfg.get("HUB_ACCOUNT_EXPIRE") == Some("1") || !["log", "off"].contains(&mailer.transport.as_str());
        Ok(Accounts {
            ttl: (env_number(&cfg.env, "HUB_ACCOUNT_UNVERIFIED_HOURS", 24.0) * HOUR as f64) as i64,
            expire,
            ip_limit: Window::new(env_number(&cfg.env, "HUB_LIMIT_LOGINS_PER_IP_10MIN", 30.0), 10 * 60000),
            max_failures: env_number(&cfg.env, "HUB_LIMIT_LOGIN_FAILURES_PER_EMAIL_HOUR", 10.0) as usize,
            failures: Mutex::new(Default::default()),
            mail_limit: Window::new(5.0, HOUR),
            resend_limit: Window::new(1.0, 60000),
            dummy_salt: crate::util::random_bytes(16),
            mailer,
        })
    }
    fn live(&self, a: &Account) -> bool { a.email_verified_at.is_some() || !self.expire || a.created_at > now() - self.ttl }
    /// Unconfirmed claims past their time (only with a real mail transport), and accounts of rooms that no longer exist.
    pub fn sweep(&self, hub: &Hub) -> usize {
        let c = hub.db.w();
        let mut n = 0;
        if self.expire {
            n += c.execute("DELETE FROM accounts WHERE email_verified_at IS NULL AND created_at <= ?", [now() - self.ttl]).unwrap_or(0);
        }
        n += c.execute("DELETE FROM accounts WHERE room_id NOT IN (SELECT room_id FROM rooms)", []).unwrap_or(0);
        n
    }
}

fn rows_of(hub: &Hub, email: &str) -> Vec<Account> {
    let c = hub.db.w();
    let rows: Vec<Account> = c.prepare_cached(&format!("SELECT {COLS} FROM accounts WHERE email = ?")).and_then(|mut s| s.query_map([email], account)?.collect()).unwrap_or_default();
    rows.into_iter().filter(|a| hub.accounts.live(a)).collect()
}
fn row_of_room(hub: &Hub, room: &str) -> Option<Account> {
    let c = hub.db.w();
    row_of_room_c(hub, &c, room)
}
fn row_of_room_c(hub: &Hub, c: &rusqlite::Connection, room: &str) -> Option<Account> {
    let a = c.prepare_cached(&format!("SELECT {COLS} FROM accounts WHERE room_id = ?")).and_then(|mut s| s.query_row([room], account).optional()).ok().flatten();
    a.filter(|a| hub.accounts.live(a))
}

async fn human(hub: &Arc<Hub>, ctx: &Ctx, room: &str) -> HResult<crate::room::Auth> {
    let r = hub.room(room).await?;
    let token = {
        let h = ctx.header("authorization").unwrap_or("");
        match h.strip_prefix("Bearer ") {
            Some(t) if (16..=200).contains(&t.len()) && t.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-') => t.to_string(),
            _ => return Err(Fail::hub("unauthorised", "sign in first: Authorization: Bearer <access_token>")),
        }
    };
    let a = r.core.lock().authorise(&token, true, false)?;
    Ok(a)
}

async fn send_code(hub: &Arc<Hub>, a: &Account) -> bool {
    if hub.accounts.mail_limit.take(&a.email) > 0 {
        return false;
    }
    use rand::Rng;
    let code = format!("{:06}", rand::thread_rng().gen_range(0..1000000));
    let salt = crate::util::random_bytes(16);
    let _ = hub.db.w().execute(
        "UPDATE accounts SET code_salt = ?, code_hash = ?, code_expires_at = ?, code_attempts = 0 WHERE room_id = ?",
        params![salt, &code_hash(&salt, &code)[..], now() + CODE_MS, a.room_id],
    );
    let text = format!("Your code is {code}. It confirms this email address for your Trommi account and works for 30 minutes.\n\nYou did not create a Trommi account? Then ignore this mail; nothing happens without the code.");
    if let Err(e) = hub.accounts.mailer.send(&a.email, &format!("Your Trommi code: {code}"), &text, &|m| hub.log(m)) {
        hub.log(&format!("mail to an account failed: {e}"));
    }
    true
}

async fn challenge_of(hub: &Arc<Hub>, room: &str) -> Option<String> {
    let r = hub.room(room).await.ok()?;
    let c = r.core.lock().challenge();
    Some(zcrypto::b64u(&c))
}

/// Login / recover: per-address limit on every try, per-email limit on failures, one scrypt per row (at least one).
async fn anonymous(hub: &Arc<Hub>, ctx: &mut Ctx, recover: bool) -> HResult<Resp> {
    let acc = &hub.accounts;
    let too_many = |w: u64| Fail::reply(429, "rate-limited", "too many tries; wait a moment", json!({})).retry(w);
    let wait = acc.ip_limit.take(&ctx.ip);
    if wait > 0 {
        return Err(too_many(wait));
    }
    let body = read_json_ops(ctx.take_body(), 4096.0, Duration::from_millis(15000), &ctx.conn).await?;
    let email = normalise_email(body.get("email"))?;
    let field = if recover { "recovery_auth" } else { "auth_key" };
    let secret = bytes_arg(body.get(field), field, 32)?;
    let t = now();
    let fails: Vec<i64> = acc.failures.lock().get(&email).cloned().unwrap_or_default().into_iter().filter(|x| t - x < HOUR).collect();
    if fails.len() >= acc.max_failures {
        return Err(too_many(((fails[0] + HOUR - t) as f64 / 1000.0).ceil() as u64));
    }
    let rows: Vec<Account> = rows_of(hub, &email).into_iter().filter(|a| if recover { a.recovery_hash.is_some() } else { true }).collect();
    let mut hit: Option<Account> = None;
    for a in &rows {
        let (salt, want) = if recover { (a.recovery_salt.clone().unwrap_or_default(), a.recovery_hash.clone().unwrap_or_default()) } else { (a.auth_salt.clone(), a.auth_hash.clone()) };
        let h = slow_hash(secret.clone(), salt).await;
        if h.len() == want.len() && zcrypto::bytes::bytes_equal(&h, &want) && hit.is_none() {
            hit = Some(a.clone());
        }
    }
    if rows.is_empty() {
        slow_hash(secret.clone(), acc.dummy_salt.clone()).await;
    }
    let Some(a) = hit else {
        let mut f = acc.failures.lock();
        let mut list = fails;
        list.push(now());
        f.shift_remove(&email);
        f.insert(email.clone(), list);
        if f.len() > 100000 {
            f.shift_remove_index(0);
        }
        return Err(refuse(401, if recover { "wrong-recovery" } else { "wrong-login" }, "email or secret is wrong"));
    };
    acc.failures.lock().shift_remove(&email);
    let challenge = challenge_of(hub, &a.room_id).await;
    let mut out = if recover {
        json!({ "room_id": a.room_id, "recovery_wrapped": zcrypto::b64u(a.recovery_wrapped.as_deref().unwrap_or(&[])) })
    } else {
        json!({ "room_id": a.room_id, "key_wrapped": zcrypto::b64u(&a.key_wrapped), "kdf": serde_json::from_str::<Value>(&a.kdf).unwrap_or(Value::Null) })
    };
    if let Some(c) = challenge {
        out.as_object_mut().unwrap().insert("challenge".into(), json!(c));
    }
    Ok(json(200, &out))
}

fn swap(cur: Option<&Account>, revision: Option<&Value>) -> HResult<()> {
    let Some(cur) = cur else { return Err(Fail::internal("account vanished")) };
    let r = revision.and_then(crate::util::safe_int);
    if r != Some(cur.revision) {
        return Err(refuse(409, "account-changed", &format!("the account is at revision {}; read it again", cur.revision)));
    }
    Ok(())
}

async fn room_route(hub: &Arc<Hub>, ctx: &mut Ctx, room: &str, sub: Option<&str>) -> HResult<Option<Resp>> {
    let m = ctx.method.clone();
    let deadline = Duration::from_millis(15000);
    if sub.is_none() && m == "POST" {
        let me = human(hub, ctx, room).await?;
        let body = read_json_ops(ctx.take_body(), 8192.0, deadline, &ctx.conn).await?;
        human(hub, ctx, room).await?;
        let email = normalise_email(body.get("email"))?;
        let auth = bytes_arg(body.get("auth_key"), "auth_key", 32)?;
        let wrapped = bytes_arg(body.get("key_wrapped"), "key_wrapped", 61)?;
        let kdf = kdf_arg(body.get("kdf"))?;
        if row_of_room(hub, room).is_some() {
            return Err(refuse(409, "account-exists", "this room has an account already"));
        }
        if rows_of(hub, &email).iter().filter(|r| r.email_verified_at.is_none()).count() >= MAX_CLAIMS {
            return Err(refuse(429, "too-many", "too many open claims on this email; try again tomorrow"));
        }
        let salt = crate::util::random_bytes(16);
        let hash = slow_hash(auth, salt.clone()).await;
        let at = now();
        {
            let c = hub.db.w();
            crate::db::tx(&c, |c| {
                c.execute("DELETE FROM accounts WHERE room_id = ?", [room])?;
                c.execute(
                    "INSERT INTO accounts (room_id, email, created_at, updated_at, revision, auth_salt, auth_hash, key_wrapped, kdf) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)",
                    params![room, email, at, at, salt, hash, wrapped, kdf],
                )?;
                Ok::<_, rusqlite::Error>(())
            })?;
        }
        if let Some(a) = row_of_room(hub, room) {
            send_code(hub, &a).await;
        }
        hub.log(&format!("room {}: account created by {}", &room[..8], &me.id[..8]));
        return Ok(Some(json(201, &json!({ "email": email, "email_verified_at": null, "revision": 1 }))));
    }
    human(hub, ctx, room).await?;
    let Some(r) = row_of_room(hub, room) else { return Err(refuse(404, "not-found", "this room has no account")) };
    if sub.is_none() && m == "GET" {
        let mut v = json!({
            "email": r.email, "email_verified_at": r.email_verified_at, "created_at": r.created_at, "updated_at": r.updated_at, "revision": r.revision,
            "key_wrapped": zcrypto::b64u(&r.key_wrapped), "kdf": serde_json::from_str::<Value>(&r.kdf).unwrap_or(Value::Null), "has_recovery": r.recovery_hash.is_some(),
        });
        if r.email_verified_at.is_none() && hub.accounts.expire {
            v.as_object_mut().unwrap().insert("claim_expires_at".into(), json!(r.created_at + hub.accounts.ttl));
        }
        return Ok(Some(json(200, &v)));
    }
    if sub == Some("password") && m == "PUT" {
        let body = read_json_ops(ctx.take_body(), 8192.0, deadline, &ctx.conn).await?;
        human(hub, ctx, room).await?;
        let auth = bytes_arg(body.get("auth_key"), "auth_key", 32)?;
        let wrapped = bytes_arg(body.get("key_wrapped"), "key_wrapped", 61)?;
        let kdf = kdf_arg(body.get("kdf"))?;
        let salt = crate::util::random_bytes(16);
        let hash = slow_hash(auth, salt.clone()).await;
        {
            let c = hub.db.w();
            c.execute_batch("BEGIN IMMEDIATE")?;
            let cur = row_of_room_c(hub, &c, room);
            if let Err(e) = swap(cur.as_ref(), body.get("revision")) {
                let _ = c.execute_batch("ROLLBACK");
                return Err(e);
            }
            let res = c.execute("UPDATE accounts SET auth_salt = ?, auth_hash = ?, key_wrapped = ?, kdf = ?, revision = revision + 1, updated_at = ? WHERE room_id = ?", params![salt, hash, wrapped, kdf, now(), room]);
            match res {
                Ok(_) => c.execute_batch("COMMIT")?,
                Err(e) => {
                    let _ = c.execute_batch("ROLLBACK");
                    return Err(e.into());
                }
            }
        }
        hub.accounts.failures.lock().shift_remove(&r.email);
        return Ok(Some(json(200, &json!({ "revision": r.revision + 1 }))));
    }
    if sub == Some("recovery") && m == "PUT" {
        let body = read_json_ops(ctx.take_body(), 8192.0, deadline, &ctx.conn).await?;
        human(hub, ctx, room).await?;
        let auth = bytes_arg(body.get("recovery_auth"), "recovery_auth", 32)?;
        let wrapped = bytes_arg(body.get("recovery_wrapped"), "recovery_wrapped", 61)?;
        let salt = crate::util::random_bytes(16);
        let hash = slow_hash(auth, salt.clone()).await;
        {
            let c = hub.db.w();
            c.execute_batch("BEGIN IMMEDIATE")?;
            let cur = row_of_room_c(hub, &c, room);
            if let Err(e) = swap(cur.as_ref(), body.get("revision")) {
                let _ = c.execute_batch("ROLLBACK");
                return Err(e);
            }
            let res = c.execute("UPDATE accounts SET recovery_salt = ?, recovery_hash = ?, recovery_wrapped = ?, revision = revision + 1, updated_at = ? WHERE room_id = ?", params![salt, hash, wrapped, now(), room]);
            match res {
                Ok(_) => c.execute_batch("COMMIT")?,
                Err(e) => {
                    let _ = c.execute_batch("ROLLBACK");
                    return Err(e.into());
                }
            }
        }
        return Ok(Some(json(200, &json!({ "revision": r.revision + 1 }))));
    }
    if sub == Some("verify") && m == "POST" {
        let body = read_json_ops(ctx.take_body(), 1024.0, deadline, &ctx.conn).await?;
        if let Some(v) = r.email_verified_at {
            return Ok(Some(json(200, &json!({ "email": r.email, "email_verified_at": v }))));
        }
        let code = body.get("code").and_then(|c| c.as_str()).filter(|c| c.len() == 6 && c.bytes().all(|x| x.is_ascii_digit()));
        let ok = match (code, &r.code_hash, &r.code_salt, r.code_expires_at) {
            (Some(code), Some(h), Some(s), Some(exp)) => exp > now() && r.code_attempts < 5 && zcrypto::bytes::bytes_equal(&code_hash(s, code), h),
            _ => false,
        };
        if !ok {
            let _ = hub.db.w().execute("UPDATE accounts SET code_attempts = code_attempts + 1 WHERE room_id = ?", [room]);
            return Err(refuse(400, "wrong-code", if r.code_attempts + 1 >= 5 { "wrong code; ask for a new one" } else { "wrong or expired code" }));
        }
        let at = now();
        {
            let c = hub.db.w();
            crate::db::tx(&c, |c| {
                c.execute("UPDATE accounts SET email_verified_at = ?, code_hash = NULL, code_salt = NULL, code_expires_at = NULL, updated_at = ? WHERE room_id = ?", params![at, at, room])?;
                c.execute("DELETE FROM accounts WHERE email = ? AND room_id != ?", params![r.email, room])?;
                Ok::<_, rusqlite::Error>(())
            })?;
        }
        return Ok(Some(json(200, &json!({ "email": r.email, "email_verified_at": at }))));
    }
    if sub == Some("code") && m == "POST" {
        if r.email_verified_at.is_some() {
            return Err(refuse(409, "already-verified", "this email is confirmed"));
        }
        let w = hub.accounts.resend_limit.take(room);
        if w > 0 {
            return Err(refuse(429, "rate-limited", "a new code at most once a minute").retry(w));
        }
        if !send_code(hub, &r).await {
            return Err(refuse(429, "rate-limited", "too many codes to this email this hour"));
        }
        return Ok(Some(json(200, &json!({ "ok": true }))));
    }
    Ok(None)
}

pub async fn handle(hub: &Arc<Hub>, ctx: &mut Ctx) -> HResult<Option<Resp>> {
    let p = ctx.path.clone();
    if p == "/v1/accounts/login" && ctx.method == "POST" {
        return anonymous(hub, ctx, false).await.map(Some);
    }
    if p == "/v1/accounts/recover" && ctx.method == "POST" {
        return anonymous(hub, ctx, true).await.map(Some);
    }
    let Some(rest) = p.strip_prefix("/v1/rooms/") else { return Ok(None) };
    if rest.len() < 64 + 8 || !zcrypto::bytes::is_hex(&rest[..64], 64) {
        return Ok(None);
    }
    let room = &rest[..64];
    let tail = &rest[64..];
    let sub = match tail {
        "/account" => None,
        "/account/password" => Some("password"),
        "/account/recovery" => Some("recovery"),
        "/account/verify" => Some("verify"),
        "/account/code" => Some("code"),
        _ => return Ok(None),
    };
    let room = room.to_string();
    room_route(hub, ctx, &room, sub).await
}

#[allow(dead_code)]
type Unused = HashMap<String, Map<String, Value>>;
