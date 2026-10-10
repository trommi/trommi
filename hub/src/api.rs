//! The routes of spec/hub-api.md, every one under `/v2/`. Bodies are JSON; byte strings are base64url. A route
//! parses its request, calls into the module that owns the rule, and answers; no rule lives here.

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use hyper::body::Incoming;
use hyper::{Method, Request, Response};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::app::App;
use crate::content::{self, Posted};
use crate::delivery::{self, CommitBody, Founding, Scope};
use crate::error::{refuse, Refused, Res};
use crate::http::{self, Answer, Body, Conn, ReqBody};
use crate::store::{self, Auth, Who};
use crate::util::{b64, now, unb64, unhex};
use crate::{accounts, files, invites, live};

/// What a route needs of a request, once its body is read.
struct Rq {
    method: Method,
    path: Vec<String>,
    query: Vec<(String, String)>,
    bearer: Option<String>,
    lease: Option<u64>,
    found_token: Option<String>,
    ip: String,
    body: Value,
}

impl Rq {
    fn q(&self, name: &str) -> Option<&str> {
        self.query
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }
    fn q_int(&self, name: &str) -> Res<Option<i64>> {
        match self.q(name) {
            None => Ok(None),
            Some(v) if v.len() <= 18 && !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()) => {
                Ok(v.parse().ok())
            }
            Some(_) => Err(refuse("bad-format", format!("{name}: a number"))),
        }
    }
    fn bytes(&self, name: &str) -> Res<Vec<u8>> {
        field(&self.body, name)
    }
    fn opt_bytes(&self, name: &str) -> Res<Option<Vec<u8>>> {
        match &self.body[name] {
            Value::Null => Ok(None),
            _ => self.bytes(name).map(Some),
        }
    }
    fn auth(&self, app: &App, c: &rusqlite::Connection) -> Res<Auth> {
        let auth = app.sessions.authorise(c, self.bearer.as_deref(), now())?;
        if auth.who == Who::Spent {
            // the key of a finished recovery: only that finish may be asked again
            let finish =
                self.path.len() == 6 && self.path[3] == "recovery" && self.path[5] == "finish";
            if !finish {
                return Err(refuse("not-member", "this recovery key was replaced"));
            }
        }
        Ok(auth)
    }
}

fn field(v: &Value, name: &str) -> Res<Vec<u8>> {
    v[name]
        .as_str()
        .and_then(unb64)
        .ok_or_else(|| refuse("bad-format", format!("{name}: base64url bytes")))
}

/// An id in a path: base64url. A 16-byte id may also be 32 hex digits (as timelines are written).
fn id<const N: usize>(text: &str) -> Res<[u8; N]> {
    let bytes = if N == 16 && text.len() == 32 {
        unhex(text)
    } else {
        unb64(text)
    };
    bytes
        .and_then(|b| b.try_into().ok())
        .ok_or_else(|| refuse("bad-format", "an id in the path is not what it must be"))
}

fn group_id(text: &str) -> Res<Vec<u8>> {
    unb64(text)
        .filter(|g| g.len() == 32 || g.len() == 48)
        .ok_or_else(|| refuse("bad-format", "a group id is 32 or 48 bytes, base64url"))
}

fn commit_body(v: &Value) -> Res<CommitBody> {
    Ok(CommitBody {
        epoch: v["epoch"]
            .as_u64()
            .ok_or_else(|| refuse("bad-format", "epoch: the epoch the Commit builds on"))?,
        commit: field(v, "commit")?,
        group_info: field(v, "group_info")?,
        welcome: if v["welcome"].is_null() {
            None
        } else {
            Some(field(v, "welcome")?)
        },
        sealed_key: field(v, "sealed_key")?,
        recovery_auth: if v["recovery_auth"].is_null() {
            None
        } else {
            Some(field(v, "recovery_auth")?)
        },
    })
}

fn own_room(auth: &Auth, text: &str) -> Res<()> {
    if id::<32>(text)? == auth.room {
        Ok(())
    } else {
        Err(refuse("wrong-room", "signed in to another room"))
    }
}

fn limited<T>(result: Result<T, u64>) -> Res<T> {
    result.map_err(|seconds| refuse("rate-limited", "too many requests").retry(seconds))
}

/// The address a request came from. Behind the tunnel on the same host, the tunnel's header names the client;
/// it is believed only from a private peer and only when configured.
fn client_ip(app: &App, conn: &Conn, headers: &hyper::HeaderMap) -> String {
    let peer = conn.peer.ip();
    let private = match peer {
        std::net::IpAddr::V4(v4) => v4.is_loopback() || v4.is_private(),
        std::net::IpAddr::V6(v6) => v6.is_loopback() || (v6.segments()[0] & 0xfe00) == 0xfc00,
    };
    // the header must be an address; it is keyed in its one canonical spelling
    let address = match http::header(headers, "cf-connecting-ip")
        .and_then(|h| h.parse::<std::net::IpAddr>().ok())
    {
        Some(named) if app.cfg.trust_proxy_header && private => named.to_canonical(),
        _ => peer.to_canonical(),
    };
    // one IPv6 network (/64) is one source: its holder has every address in it
    match address {
        std::net::IpAddr::V6(v6) => {
            let s = v6.segments();
            format!("{:x}:{:x}:{:x}:{:x}::/64", s[0], s[1], s[2], s[3])
        }
        v4 => v4.to_string(),
    }
}

fn allowed_origin(app: &App, origin: &str) -> bool {
    app.accounts.origins.iter().any(|o| o == origin)
        || (app.cfg.test_control
            && (origin.starts_with("http://localhost") || origin.starts_with("http://127.0.0.1")))
}

/// `Trommi-Client: <kind>/<major>.<minor>.<patch>` against the configured minimum.
fn client_too_old(app: &App, header: Option<&str>) -> bool {
    let Some(min) = &app.cfg.min_client else {
        return false;
    };
    let parse = |v: &str| -> Option<Vec<u64>> {
        v.rsplit('/')
            .next()?
            .split('.')
            .map(|p| p.parse().ok())
            .collect()
    };
    match (header.and_then(parse), parse(min)) {
        (Some(have), Some(need)) => have < need,
        (None, _) => true,
        _ => false,
    }
}

pub async fn handle(app: Arc<App>, req: Request<Incoming>, conn: Conn) -> Answer {
    let origin = http::header(req.headers(), "origin")
        .filter(|o| allowed_origin(&app, o))
        .map(str::to_string);
    let hsts = app.cfg.hsts;
    let mut answer = respond(app, req, conn).await;
    if let Some(origin) = origin {
        let h = answer.headers_mut();
        if let Ok(v) = origin.parse() {
            h.insert("access-control-allow-origin", v);
        }
        h.insert("vary", "Origin".parse().expect("static"));
        h.insert(
            "access-control-expose-headers",
            "content-range, content-length, retry-after"
                .parse()
                .expect("static"),
        );
    }
    answer
        .headers_mut()
        .insert("x-content-type-options", "nosniff".parse().expect("static"));
    if hsts {
        answer.headers_mut().insert(
            "strict-transport-security",
            "max-age=63072000; includeSubDomains; preload"
                .parse()
                .expect("static"),
        );
    }
    answer
}

async fn respond(app: Arc<App>, req: Request<Incoming>, conn: Conn) -> Answer {
    if app.closing.load(Ordering::Relaxed) {
        return http::refusal(&refuse("overloaded", "the hub is restarting").retry(1));
    }
    let (parts, body) = req.into_parts();
    // an unread body is drained for as long as its announced length needs, never longer than the longest legal
    // upload; without a length, for a minute
    let announced: u64 = http::header(&parts.headers, "content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let drain = Duration::from_secs(60 + announced.min(app.cfg.file_limit) / 16_384);
    let mut body = ReqBody::new(body, conn.clone(), drain);
    let path: Vec<String> = parts
        .uri
        .path()
        .split('/')
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    let segs: Vec<&str> = path.iter().map(String::as_str).collect();
    if parts.method == Method::OPTIONS {
        return Response::builder()
            .status(204)
            .header("access-control-allow-methods", "GET, POST, PUT, DELETE")
            .header("access-control-allow-headers", "authorization, content-type, trommi-client, trommi-lease, x-share-secret, x-found-token, range, last-event-id")
            .header("access-control-max-age", "86400")
            .body(Body::empty())
            .expect("a valid response");
    }
    if segs == ["healthz"] {
        // the database answers, or the hub is not healthy
        let ok = app
            .db
            .read(|c| {
                c.query_row("SELECT 1", [], |r| r.get::<_, i64>(0))
                    .map_err(Refused::from)
            })
            .is_ok();
        return http::json(
            if ok { 200 } else { 503 },
            &json!({ "ok": ok, "commit": app.cfg.commit, "protocol_version": 2 }),
        );
    }
    if segs.first() != Some(&"v2") {
        return http::refusal(&refuse("not-found", "every route is under /v2/"));
    }
    if client_too_old(&app, http::header(&parts.headers, "trommi-client")) {
        return http::refusal(&refuse(
            "client-too-old",
            "this client is too old for this hub",
        ));
    }
    let ip = client_ip(&app, &conn, &parts.headers);
    let bearer = http::header(&parts.headers, "authorization").map(str::to_string);
    let lease = http::header(&parts.headers, "trommi-lease").and_then(|l| l.parse().ok());
    let query = http::query(parts.uri.query());
    let found_token = http::header(&parts.headers, "x-found-token").map(str::to_string);

    // the routes that stream
    let streamed = match (&parts.method, &segs[1..]) {
        (&Method::GET, ["stream"]) => Some(
            stream(
                &conn,
                &app,
                bearer.as_deref(),
                lease,
                &query,
                http::header(&parts.headers, "last-event-id"),
            )
            .await,
        ),
        (&Method::PUT, ["files", file]) => Some(
            upload(
                &app,
                bearer.as_deref(),
                lease,
                file,
                &parts.headers,
                &mut body,
            )
            .await,
        ),
        (&Method::GET, ["files", file]) => Some(
            download(
                &app,
                bearer.as_deref(),
                file,
                http::header(&parts.headers, "range"),
            )
            .await,
        ),
        (&Method::GET, ["shares", share]) => Some(
            shared(
                &app,
                &ip,
                share,
                http::header(&parts.headers, "x-share-secret"),
                http::header(&parts.headers, "range"),
            )
            .await,
        ),
        _ => None,
    };
    if let Some(result) = streamed {
        return result.unwrap_or_else(|r| http::refusal(&r));
    }

    // The admission queue: so many requests are worked on at a time. One more is told to come back, before its
    // body is read, and holds nothing meanwhile.
    let _admitted = match Admitted::enter(&app, &ip) {
        Some(a) => a,
        None => {
            return http::refusal(
                &refuse("overloaded", "the hub is busy: try again in a moment").retry(1),
            )
        }
    };
    let raw = match body
        .read(
            app.cfg.json_limit,
            Duration::from_millis(app.cfg.body_timeout_ms),
        )
        .await
    {
        Ok(raw) => raw,
        Err(r) => return http::refusal(&r),
    };
    let parsed: Value = if raw.is_empty() {
        json!({})
    } else {
        match serde_json::from_slice(&raw) {
            Ok(v @ Value::Object(_)) => v,
            // a passkey sign-in has one answer for every failure, this one too
            _ if path == ["v2", "account", "passkey", "login"] => json!({}),
            _ => return http::refusal(&refuse("bad-format", "the body is one JSON object")),
        }
    };
    let rq = Rq {
        method: parts.method,
        path,
        query,
        bearer,
        lease,
        found_token,
        ip,
        body: parsed,
    };
    let worker = app.clone();
    // the place among the requests at work goes with the work: it is held until the answer is made, also if
    // the client has gone meanwhile
    let admitted = _admitted;
    let result = tokio::task::spawn_blocking(move || {
        let _admitted = admitted;
        route(&worker, &rq).map(|v| v.to_string())
    })
    .await;
    match result {
        Ok(Ok(text)) => http::json_text(200, text),
        Ok(Err(r)) => {
            if r.code == "internal" {
                crate::log::warn("internal_error", json!({ "message": r.message }));
                return http::refusal(&refuse("internal", "internal error"));
            }
            http::refusal(&r)
        }
        Err(_) => {
            crate::log::warn("handler_panicked", json!({}));
            http::refusal(&refuse("internal", "internal error"))
        }
    }
}

/// A place among the requests being worked on; given back when dropped.
struct Admitted(Arc<App>, String);

impl Admitted {
    /// So many requests at work in all, and so many of one address (a few slow senders do not take every place).
    fn enter(app: &Arc<App>, ip: &str) -> Option<Admitted> {
        if app.admitted.fetch_add(1, Ordering::Relaxed) >= app.cfg.admitted {
            app.admitted.fetch_sub(1, Ordering::Relaxed);
            return None;
        }
        let mut per = app
            .admitted_per_address
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let count = per.entry(ip.to_string()).or_insert(0);
        if *count >= app.cfg.admitted_per_address {
            drop(per);
            app.admitted.fetch_sub(1, Ordering::Relaxed);
            return None;
        }
        *count += 1;
        drop(per);
        Some(Admitted(app.clone(), ip.to_string()))
    }
}

impl Drop for Admitted {
    fn drop(&mut self) {
        self.0.admitted.fetch_sub(1, Ordering::Relaxed);
        let mut per = self
            .0
            .admitted_per_address
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let Some(count) = per.get_mut(&self.1) {
            *count -= 1;
            if *count == 0 {
                per.remove(&self.1);
            }
        }
    }
}

fn route(app: &Arc<App>, rq: &Rq) -> Res<Value> {
    let segs: Vec<&str> = rq.path.iter().skip(1).map(String::as_str).collect();
    let m = &rq.method;
    let t = now();
    let open_limit = || limited(app.limits.open_requests.take(rq.ip.as_bytes(), 1.0, t));
    // expensive requests of one device: ten a second, bursts of sixty
    let heavy_limit = |auth: &Auth| {
        limited(
            app.limits
                .heavy
                .take(&[&auth.room[..], &auth.device[..]].concat(), 1.0, t),
        )
    };
    let read_auth = || app.read(|x| rq.auth(app, x.c));
    match (m.as_str(), &segs[..]) {
        // ---- no token
        ("POST", ["account", "login"]) => login(app, rq, false),
        ("POST", ["account", "recover"]) => login(app, rq, true),
        ("POST", ["account", "passkey", "challenge"]) => {
            open_limit()?;
            // with it the id an account gets that is made with a passkey registered on this challenge
            let challenge = app.accounts.challenge(None, t);
            let id = accounts::id_of_challenge(&challenge);
            Ok(json!({ "challenge": b64(&challenge), "account": accounts::id_text(&id), "user_handle": b64(&id) }))
        }
        ("POST", ["account", "passkey", "login"]) => {
            limited(app.limits.logins.check(rq.ip.as_bytes(), t, true))?;
            // the signature is checked on the pool, reading only; every failure of this route is the one answer
            let checked = match app.heavy(|c, _| app.accounts.passkey_login(c, &rq.body, t))?.1 {
                Ok(found) => found,
                Err(r) if r.code == "bad-format" => None,
                Err(other) => return Err(other),
            };
            let Some((account, copy, credential, sign_count, revision)) = checked else {
                return Err(refuse("wrong-login", "e-mail or secret is wrong"));
            };
            // recorded and answered in a transaction that still finds that passkey on that account
            app.write(|x, _| {
                if accounts::revision_of(x.c, account)? != revision || !accounts::passkey_used(x.c, account, &credential, sign_count, x.now)? {
                    return Err(refuse("overloaded", "the account changed under this login: try again").retry(1));
                }
                // the account knows this source from now on, as after a password
                accounts::remember_source(x.c, account, &crate::push::source_hash(&app.ticket_key, &rq.ip), x.now)?;
                login_answer(app, x.c, account, &copy)
            })
        }
        ("POST", ["rooms"]) => {
            limited(app.limits.foundings.check(rq.ip.as_bytes(), t, true))?;
            // who may found a room is this hub's policy: anyone, whoever brings the hub's word, or nobody
            match app.cfg.founding {
                crate::config::Founding::Open => {}
                crate::config::Founding::Closed => return Err(refuse("forbidden", "this hub founds no rooms")),
                crate::config::Founding::Token => {
                    let word = app.cfg.found_token.as_deref().unwrap_or("");
                    let given = rq.found_token.as_deref().unwrap_or("");
                    if word.is_empty() || !crate::util::same(given.as_bytes(), word.as_bytes()) {
                        return Err(refuse("forbidden", "this hub founds rooms by invitation"));
                    }
                }
            }
            let (group_info, sealed_key) = (rq.bytes("group_info")?, rq.bytes("sealed_key")?);
            let account = &rq.body["account"];
            let (entries, pre) = app.heavy(|_, memo| {
                crate::prepare::room(memo, &group_info);
                accounts::Prehashed::of(&[&account["kit"], &account["password"]])
            })?;
            app.write_with(entries, None, |x, _| {
                let founded = delivery::found_room(x, &group_info, &sealed_key)?;
                // an account, if one comes with the founding, is made in the same transaction
                if !founded.again && !account.is_null() {
                    app.accounts.create(x.c, &founded.room, account, x.now, &pre)?;
                }
                Ok(json!({ "room_id": b64(&founded.room) }))
            })
        }
        ("GET", ["rooms", room, "challenge"]) => {
            open_limit()?;
            let room = id::<32>(room)?;
            // a challenge is handed out for any room id: whether a room exists is not told here
            Ok(json!({ "challenge": b64(&app.sessions.challenge(&room, t)) }))
        }
        // signing out: the token ends at once, and the device's streams with it
        ("DELETE", ["token"]) => {
            let auth = read_auth()?;
            app.sessions.revoke(rq.bearer.as_deref());
            app.live.cut_where(&auth.room, |a| a.device == auth.device);
            Ok(json!({}))
        }
        ("POST", ["rooms", room, "tokens"]) => {
            open_limit()?;
            let room = id::<32>(room)?;
            let (auth, signature) = (rq.bytes("auth")?, rq.bytes("signature")?);
            let (token, expires_at, who) = app.read(|x| app.sessions.sign_in(x.c, x.obs, &app.cfg.url, &room, &auth, &signature, x.now))?;
            let role = match who {
                Some(Who::Human) => "human",
                Some(Who::Agent) => "agent",
                Some(Who::Helper) => "helper",
                Some(Who::Recovery | Who::Spent) => "recovery",
                // no standing: good for `GET /v2/groups/{group}/removal` only
                None => "removed",
            };
            Ok(json!({ "token": token, "expires_at": expires_at, "role": role }))
        }
        ("GET", ["invites", invite]) => {
            open_limit()?;
            let invite = id::<16>(invite)?;
            app.read(|x| {
                let asker = rq.auth(app, x.c).ok();
                invites::read(x.c, &invite, asker.as_ref(), x.now)
            })
        }
        ("POST", ["invites", invite, "request"]) => {
            open_limit()?;
            let invite = id::<16>(invite)?;
            let (request, mac, signature) = (rq.bytes("request")?, rq.bytes("mac")?, rq.bytes("signature")?);
            // the Request's KeyPackage is validated on the pool
            let key_package = crate::wire::InviteRequest::parse(&request)?.key_package;
            let (entries, ()) = app.heavy(|_, memo| crate::prepare::key_packages(memo, &[&key_package]))?;
            app.write_with(entries, None, |x, fx| invites::request(x, &invite, &request, &mac, &signature, fx))
        }
        ("GET", ["invites", invite, "reveal"]) => {
            open_limit()?;
            let invite = id::<16>(invite)?;
            app.read(|x| invites::read_reveal(x.c, &invite))
        }
        ("GET", ["push-envelope"]) => {
            open_limit()?;
            let (room, device, change) = crate::push::check_ticket(&app.ticket_key, rq.q("ticket").unwrap_or(""), t)?;
            app.read(|x| {
                let wrong = || refuse("unauthorised", "the ticket is wrong or ran out");
                if store::standing(x.c, &room, &device)? != Some(Who::Human) {
                    return Err(wrong());
                }
                // an envelope beyond a Cut is served on the chain route only
                content::envelope_at(x.c, &room, change, false)?.filter(|item| item["cut"] != true).ok_or_else(wrong)
            })
        }

        // ---- the account, by a human device of the room
        ("POST", ["account"]) => {
            let auth = read_auth()?;
            auth.human()?;
            heavy_limit(&auth)?;
            let pre = app.pooled(|| accounts::Prehashed::of(&[&rq.body["kit"], &rq.body["password"]]))?;
            app.write_as(&auth, rq.lease, |x, _| app.accounts.create(x.c, &auth.room, &rq.body, x.now, &pre))
        }
        ("GET", ["account"]) => app.read(|x| {
            let auth = rq.auth(app, x.c)?;
            auth.human()?;
            accounts::account_view(x.c, accounts::account_of(x.c, &auth.room)?)
        }),
        ("PUT", ["account", what @ ("password" | "kit")]) => {
            // who asks comes first: nobody without a human device's token has the hub make a slow hash
            let auth = read_auth()?;
            auth.human()?;
            heavy_limit(&auth)?;
            let pre = app.pooled(|| accounts::Prehashed::of(&[&rq.body]))?;
            app.write_as(&auth, rq.lease, |x, _| match *what {
                "password" => accounts::put_password(x.c, &auth.room, &rq.body, x.now, &pre),
                _ => accounts::put_kit(x.c, &auth.room, &rq.body, x.now, &pre),
            })
        }
        ("PUT", ["account", "email"]) => {
            let auth = read_auth()?;
            auth.human()?;
            heavy_limit(&auth)?;
            let pre = app.pooled(|| accounts::Prehashed::of(&[&rq.body["kit"]]))?;
            app.write_as(&auth, rq.lease, |x, _| accounts::put_email(x.c, &auth.room, &rq.body, x.now, &pre))
        }
        ("POST", ["account", "passkeys", "challenge"]) => app.read(|x| {
            // a human device, or the recovery key before it finishes (8.7: a passkey made anew): with the
            // challenge the account's id, which that passkey must carry as its user handle
            let auth = rq.auth(app, x.c)?;
            if !matches!(auth.who, Who::Human | Who::Recovery) {
                return Err(refuse("forbidden", "a human device or the recovery key"));
            }
            let account = accounts::account_of(x.c, &auth.room)?;
            let revision = accounts::revision_of(x.c, account)?;
            let handle = accounts::handle_of(x.c, account)?;
            // (with it what a new kit needs to be made in the account's form: 8.8.2)
            let email: Option<String> = x.c.query_row("SELECT email FROM accounts WHERE account_id = ?1", [account], |r| r.get(0))?;
            Ok(json!({
                "challenge": b64(&app.accounts.challenge(Some((account, revision)), x.now)),
                "account": accounts::id_text(&handle),
                "user_handle": b64(&handle),
                "kit_form": if email.is_some() { "email" } else { "id" },
                "email": email,
            }))
        }),
        ("POST", ["account", "passkeys"]) => human_write(app, rq, |x, auth| app.accounts.add_passkey(x.c, &auth.room, &rq.body, x.now)),
        ("DELETE", ["account", "passkeys", credential]) => {
            let credential = unb64(credential).ok_or_else(|| refuse("bad-format", "a credential id, base64url"))?;
            human_write(app, rq, |x, auth| accounts::delete_passkey(x.c, &auth.room, &credential, x.now))
        }

        // ---- groups: the MLS delivery service
        ("POST", ["groups"]) => {
            let founding = Founding { group_info_0: rq.bytes("group_info_0")?, sealed_key_0: rq.bytes("sealed_key_0")?, first: commit_body(&json!({
                "epoch": 0, "commit": rq.body["commit"], "group_info": rq.body["group_info"], "welcome": rq.body["welcome"], "sealed_key": rq.body["sealed_key"],
            }))? };
            let auth = read_auth()?;
            heavy_limit(&auth)?;
            let (entries, ()) = app.heavy(|_, memo| crate::prepare::founding(memo, &founding.group_info_0, &founding.first))?;
            app.write_as_with(entries, &auth, rq.lease, |x, fx| Ok(json!({ "group_id": b64(&delivery::found_session(x, &auth, &founding, fx)?) })))
        }
        ("POST", ["groups", group, "commits"]) => {
            let (group, body) = (group_id(group)?, commit_body(&rq.body)?);
            let auth = read_auth()?;
            heavy_limit(&auth)?;
            // the Commit is verified on the group's public state outside the write lock; the transaction takes
            // the result only if the group still stands where it stood
            let (entries, ()) = app.heavy(|c, memo| crate::prepare::commit(c, memo, &auth.room, &group, &body))?;
            app.write_as_with(entries, &auth, rq.lease, |x, fx| {
                let a = delivery::commit(x, &auth, &group, &body, &mut Scope::default(), fx)?;
                Ok(json!({ "epoch": a.epoch, "change": a.change }))
            })
        }
        ("POST", ["groups", group, "reject"]) => {
            let group = group_id(group)?;
            let n = rq.body["n"].as_i64().ok_or_else(|| refuse("bad-format", "n: the log number of the Commit"))?;
            let auth = read_auth()?;
            limited(app.limits.requests.take(&[&auth.room[..], &auth.device[..]].concat(), 1.0, t))?;
            app.write_as(&auth, rq.lease, |x, fx| delivery::reject(x, &auth, &group, n, fx))
        }
        ("POST", ["groups", group, "archive"]) => {
            let group = group_id(group)?;
            let auth = read_auth()?;
            app.write_as(&auth, rq.lease, |x, fx| delivery::archive(x, &auth, &group, fx))
        }
        // 13.5: a removed device fetches the Commits that prove its removal; its token names it, it has no standing
        ("GET", ["groups", group, "removal"]) => {
            let group = group_id(group)?;
            let after = rq.q_int("after")?.unwrap_or(0);
            let (room, device) = app.sessions.bearer(rq.bearer.as_deref(), t).ok_or_else(|| refuse("unauthorised", "sign in"))?;
            limited(app.limits.heavy.take(&[&room[..], &device[..]].concat(), 1.0, t))?;
            app.read(|x| delivery::removal(x.c, &room, &device, &group, after, x.now))
        }
        ("GET", ["groups", group, "log"]) => {
            let group = group_id(group)?;
            let (after, limit) = (rq.q_int("after")?.unwrap_or(0), rq.q_int("limit")?.unwrap_or(200).clamp(1, 1000));
            app.read(|x| delivery::log(x.c, &rq.auth(app, x.c)?, &group, after, limit, rq.q("kind") == Some("commit")))
        }
        ("POST", ["groups", group, "messages"]) => {
            let group = group_id(group)?;
            let epoch = rq.body["epoch"].as_u64().ok_or_else(|| refuse("bad-format", "epoch"))?;
            let message = rq.bytes("message")?;
            let relay = rq.body["relay"].as_bool().unwrap_or(false);
            let auth = read_auth()?;
            if relay {
                // 16: stroke pieces, 20 per second per device
                limited(app.limits.pieces.check(&[&auth.room[..], &auth.device[..]].concat(), t, true))?;
            } else {
                limited(app.limits.envelopes.take(&[&auth.room[..], &auth.device[..]].concat(), 1.0, t))?;
            }
            app.write_as(&auth, rq.lease, |x, fx| delivery::message(x, &auth, &group, epoch, &message, relay, fx))
        }
        ("GET", ["groups", group, "info"]) => {
            let group = group_id(group)?;
            let epoch = rq.q_int("epoch")?.map(|e| e as u64);
            app.read(|x| delivery::info(x.c, &rq.auth(app, x.c)?, &group, epoch))
        }
        ("GET", ["groups", group, "chains", sender]) => {
            let (group, sender) = (group_id(group)?, id::<32>(sender)?);
            let (after, limit) = (rq.q_int("after")?, rq.q_int("limit")?);
            app.read(|x| content::chain(x.c, &rq.auth(app, x.c)?, &group, &sender, after, limit))
        }
        ("GET", ["rooms", room, "groups"]) => app.read(|x| {
            let auth = rq.auth(app, x.c)?;
            own_room(&auth, room)?;
            match rq.q_int("limit")? {
                // the paged form; without `limit` the whole list, as before
                Some(limit) => delivery::group_page(x.c, &auth, rq.q_int("after")?.unwrap_or(0), limit.clamp(1, 1000)),
                None => Ok(Value::Array(delivery::group_list(x.c, &auth)?)),
            }
        }),
        ("GET", ["welcomes"]) => {
            let after = rq.q_int("after")?.unwrap_or(0);
            app.read(|x| delivery::welcomes(x.c, &rq.auth(app, x.c)?, after))
        }
        ("PUT", ["key-packages"]) => {
            let single_use: Vec<Vec<u8>> = match &rq.body["single_use"] {
                Value::Null => vec![],
                Value::Array(a) if a.len() <= app.cfg.key_packages => {
                    a.iter().map(|v| v.as_str().and_then(unb64).ok_or_else(|| refuse("bad-format", "single_use: KeyPackages, base64url"))).collect::<Res<_>>()?
                }
                _ => return Err(refuse("bad-format", "single_use: at most 100 KeyPackages")),
            };
            let last_resort = rq.opt_bytes("last_resort")?;
            let auth = read_auth()?;
            heavy_limit(&auth)?;
            let (entries, ()) = app.heavy(|_, memo| {
                let all: Vec<&[u8]> = single_use.iter().map(Vec::as_slice).chain(last_resort.as_deref()).collect();
                crate::prepare::key_packages(memo, &all)
            })?;
            app.write_as_with(entries, &auth, rq.lease, |x, _| delivery::put_key_packages(x, &auth, &single_use, last_resort.as_deref()))
        }
        ("POST", ["key-packages", "claim"]) => {
            let devices: Vec<[u8; 32]> = match &rq.body["devices"] {
                Value::Array(a) if !a.is_empty() && a.len() <= crate::observer::MAX_LEAVES => a.iter().map(|v| id::<32>(v.as_str().unwrap_or(""))).collect::<Res<_>>()?,
                _ => return Err(refuse("bad-format", "devices: 1 to 1024 device ids")),
            };
            let auth = read_auth()?;
            limited(app.limits.claims.take(&[&auth.room[..], &auth.device[..]].concat(), devices.len() as f64, t))?;
            app.write_as(&auth, rq.lease, |x, _| delivery::claim_key_packages(x, &auth, &devices))
        }
        ("PUT", ["sealed-keys"]) => {
            let key = rq.bytes("sealed_key")?;
            let auth = read_auth()?;
            app.write_as(&auth, rq.lease, |x, _| delivery::put_sealed_key(x, &auth, &key))
        }
        ("GET", ["sealed-keys"]) => {
            let (after, limit) = (rq.q_int("after")?.unwrap_or(0), rq.q_int("limit")?.unwrap_or(500).clamp(1, 2000));
            app.read(|x| delivery::sealed_keys(x.c, &rq.auth(app, x.c)?, after, limit))
        }
        ("POST", ["requests"]) => {
            let kind = match rq.body["kind"].as_str() {
                Some("readmit") => "readmit",
                Some("handover") => "handover",
                Some("session") => "session",
                _ => return Err(refuse("bad-format", "kind: readmit, handover or session")),
            };
            let group = match rq.body["group"].as_str() {
                Some(g) => Some(group_id(g)?),
                None => None,
            };
            let key_package = rq.opt_bytes("key_package")?;
            let auth = read_auth()?;
            limited(app.limits.requests.take(&[&auth.room[..], &auth.device[..]].concat(), 1.0, t))?;
            app.write_as(&auth, rq.lease, |x, fx| delivery::add_request(x, &auth, kind, group.as_deref(), key_package.as_deref(), None, json!({}), fx))
        }
        ("GET", ["requests"]) => app.read(|x| delivery::requests(x.c, &rq.auth(app, x.c)?)),

        // ---- recovery (8.6, 8.7)
        ("POST", ["rooms", room, "recovery"]) => {
            let auth = read_auth()?;
            own_room(&auth, room)?;
            app.write_recovery(Default::default(), None, &auth, |x, _| delivery::recovery_open(x, &auth))
        }
        ("POST", ["rooms", room, "recovery", recovery, "commits"]) => {
            let recovery = id::<16>(recovery)?;
            let group = match rq.body["group_id"].as_str() {
                Some(g) => group_id(g)?,
                None => return Err(refuse("bad-format", "group_id: the group this part is for")),
            };
            let body = commit_body(&rq.body)?;
            let auth = read_auth()?;
            own_room(&auth, room)?;
            // Verified outside the write lock on the state the parts before it leave for its group; then, in a
            // short transaction, checked against what those parts leave behind (their writes are replayed and
            // rolled back; their cryptography is not repeated) and kept apart. Nothing of it is published.
            heavy_limit(&auth)?;
            let (entries, commit_key) = app.heavy(|c, memo| crate::prepare::recovery_part(c, memo, &auth.room, &recovery, &group, &body))?;
            let stored = entries.clone();
            app.write_recovery(entries, Some(&recovery), &auth, |x, _| {
                if delivery::recovery_has(x, &auth, &recovery, &group, &body)? {
                    return Ok(json!({ "epoch": body.epoch + 1, "kept": true }));
                }
                x.c.execute_batch("SAVEPOINT rehearsal").map_err(Refused::from)?;
                let rehearsed = delivery::recovery_rehearse(x, &auth, &recovery, &group, &body);
                x.c.execute_batch("ROLLBACK TO rehearsal; RELEASE rehearsal").map_err(Refused::from)?;
                let accepted = rehearsed?;
                delivery::recovery_keep(x, &auth, &recovery, &group, &body, commit_key.as_ref(), &stored)?;
                Ok(json!({ "epoch": accepted.epoch, "kept": true }))
            })
        }
        ("POST", ["rooms", room, "recovery", recovery, "finish"]) => {
            let recovery = id::<16>(recovery)?;
            let link = rq.bytes("recovery_link")?;
            let hash: [u8; 32] = Sha256::digest(rq.body.to_string().as_bytes()).into();
            let auth = read_auth()?;
            own_room(&auth, room)?;
            heavy_limit(&auth)?;
            let pre = app.pooled(|| accounts::Prehashed::of(&[&rq.body["account"]["kit"], &rq.body["account"]["password"]]))?;
            // every part was verified when it came: publishing replays their writes from what was kept
            app.write_recovery(Default::default(), Some(&recovery), &auth, |x, fx| {
                let (answer, published_now) = delivery::recovery_finish(x, &auth, &recovery, &link, &hash, fx)?;
                if published_now {
                    app.accounts.replace_copies(x.c, &auth.room, &rq.body["account"], x.now, &pre)?;
                }
                Ok(answer)
            })
        }
        ("DELETE", ["rooms", room, "recovery", recovery]) => {
            let recovery = id::<16>(recovery)?;
            let auth = read_auth()?;
            own_room(&auth, room)?;
            app.write_recovery(Default::default(), None, &auth, |x, _| delivery::recovery_drop(x, &auth, &recovery))
        }
        ("POST", ["rooms", room, "recovery-code"]) => {
            let body = commit_body(&rq.body["commit"])?;
            let link = crate::wire::RecoveryLink::parse(&rq.bytes("recovery_link")?)?;
            let auth = read_auth()?;
            own_room(&auth, room)?;
            auth.human()?;
            // 8.6: the room Commit with new recovery keys, its RecoveryLink and the account's new copies: whole or not at all
            heavy_limit(&auth)?;
            let (entries, pre) = app.heavy(|c, memo| {
                crate::prepare::commit(c, memo, &auth.room, &auth.room, &body);
                accounts::Prehashed::of(&[&rq.body["account"]["kit"], &rq.body["account"]["password"]])
            })?;
            app.write_as_with(entries, &auth, rq.lease, |x, fx| {
                let mut scope = Scope { link: Some(link), ..Default::default() };
                let a = delivery::commit(x, &auth, &auth.room, &body, &mut scope, fx)?;
                if !scope.keys_replaced && a.change > 0 {
                    // a retried request finds its Commit accepted; a Commit that replaces nothing is not this route's
                    let replaced = x.c.prepare_cached("SELECT 1 FROM recovery_links WHERE room_id = ?1 AND room_epoch = ?2")?.exists(rusqlite::params![&auth.room[..], a.epoch as i64])?;
                    if !replaced {
                        return Err(refuse("bad-commit", "this route takes the Commit that replaces the recovery keys"));
                    }
                    return Ok(json!({ "epoch": a.epoch, "change": a.change }));
                }
                app.accounts.replace_copies(x.c, &auth.room, &rq.body["account"], x.now, &pre)?;
                Ok(json!({ "epoch": a.epoch, "change": a.change }))
            })
        }

        // ---- content
        ("POST", ["envelopes"]) => {
            let envelope = rq.bytes("envelope")?;
            let auth = read_auth()?;
            limited(app.limits.envelopes.take(&[&auth.room[..], &auth.device[..]].concat(), 1.0, t))?;
            match app.write_as(&auth, rq.lease, |x, fx| content::post_envelope(x, &auth, &envelope, fx))? {
                Posted::Stored { change } => Ok(json!({ "change": change })),
                Posted::Voided(refusal) => Err(refusal),
            }
        }
        ("GET", ["desk"]) => app.read(|x| content::desk(x.c, &rq.auth(app, x.c)?)),
        ("GET", ["chats", scope, timeline, "items"]) => {
            let key = content::chat_key(scope, timeline)?;
            let (before, limit) = (rq.q_int("before")?, rq.q_int("limit")?);
            app.read(|x| content::chat_items(x.c, &rq.auth(app, x.c)?, &key, before, limit))
        }
        ("GET", ["boards", board]) => {
            let board = id::<16>(board)?;
            let (after, limit) = (rq.q_int("after_change")?, rq.q_int("limit")?);
            app.read(|x| content::board_items(x.c, &rq.auth(app, x.c)?, &board, after, limit))
        }
        ("GET", [kind @ ("cards" | "notes" | "permission-requests" | "artifacts"), object]) => {
            let object = id::<16>(object)?;
            let table = if *kind == "permission-requests" { "permission_requests" } else { kind };
            let (after, limit) = (rq.q_int("after")?, rq.q_int("limit")?);
            app.read(|x| content::object_envelopes(x.c, &rq.auth(app, x.c)?, table, &object, after, limit))
        }
        ("GET", ["changes"]) => {
            let (after, limit) = (rq.q_int("after")?.unwrap_or(0), rq.q_int("limit")?);
            app.read(|x| content::changes(x.c, &rq.auth(app, x.c)?, after, limit))
        }

        // ---- files and shares
        ("DELETE", ["files", file]) => {
            let file = id::<16>(file)?;
            let auth = read_auth()?;
            app.write_as(&auth, rq.lease, |x, fx| files::delete(x, &auth, &file, fx))
        }
        ("POST", ["shares"]) => {
            let share: [u8; 16] = rq.bytes("share_id")?.try_into().map_err(|_| refuse("bad-format", "share_id: 16 bytes"))?;
            let hash: [u8; 32] = rq.bytes("secret_hash")?.try_into().map_err(|_| refuse("bad-format", "secret_hash: 32 bytes"))?;
            let file: [u8; 16] = rq.bytes("file_id")?.try_into().map_err(|_| refuse("bad-format", "file_id: 16 bytes"))?;
            let expires = rq.body["expires_at"].as_u64().ok_or_else(|| refuse("bad-format", "expires_at"))?;
            let auth = read_auth()?;
            app.write_as(&auth, rq.lease, |x, _| files::share(x, &auth, &share, &hash, &file, expires))
        }
        ("DELETE", ["shares", share]) => {
            let share = id::<16>(share)?;
            let auth = read_auth()?;
            app.write_as(&auth, rq.lease, |x, _| files::unshare(x, &auth, &share))
        }

        // ---- invites, by human devices
        ("POST", ["invites"]) => {
            // `mac` may be left out for now; when it is there (null too) it must be the 32 bytes
            let mac = match rq.body.get("mac") {
                None => None,
                Some(_) => Some(rq.bytes("mac")?),
            };
            let (offer, signature) = (rq.bytes("offer")?, rq.bytes("signature")?);
            let auth = read_auth()?;
            app.write_as(&auth, rq.lease, |x, _| invites::publish(x, &auth, &offer, &signature, mac.as_deref()))
        }
        ("PUT", ["invites", invite, "reveal"]) => {
            let invite = id::<16>(invite)?;
            let (reveal, signature) = (rq.bytes("reveal")?, rq.bytes("signature")?);
            let auth = read_auth()?;
            app.write_as(&auth, rq.lease, |x, _| invites::reveal(x, &auth, &invite, &reveal, &signature))
        }
        ("DELETE", ["invites", invite]) => {
            let invite = id::<16>(invite)?;
            let auth = read_auth()?;
            app.write_as(&auth, rq.lease, |x, _| invites::burn(x, &auth, &invite))
        }

        // ---- push, Live Activity, presence
        ("POST", ["push"]) => human_write(app, rq, |x, auth| push_register(app, x, auth, &rq.body)),
        ("GET", ["push"]) => app.read(|x| {
            let auth = rq.auth(app, x.c)?;
            auth.human()?;
            let mut s = x.c.prepare_cached("SELECT kind, endpoint, level, created_at FROM push_subscriptions WHERE room_id = ?1 AND device = ?2 ORDER BY id")?;
            let rows = s
                .query_map(rusqlite::params![&auth.room[..], &auth.device[..]], |r| {
                    Ok(json!({ "kind": r.get::<_, String>(0)?, "endpoint": r.get::<_, String>(1)?, "level": r.get::<_, String>(2)?, "created_at": r.get::<_, i64>(3)? }))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(json!({ "subscriptions": rows, "vapid_public_key": b64(&app.vapid.public), "apns": app.apns.is_some() }))
        }),
        ("DELETE", ["push"]) => human_write(app, rq, |x, auth| {
            let endpoint = rq.body["endpoint"].as_str();
            let n = x.c.execute(
                "DELETE FROM push_subscriptions WHERE room_id = ?1 AND device = ?2 AND (?3 IS NULL OR endpoint = ?3)",
                rusqlite::params![&auth.room[..], &auth.device[..], endpoint],
            )?;
            Ok(json!({ "deleted": n }))
        }),
        ("POST", ["live-activity"]) => {
            let auth = read_auth()?;
            auth.human()?;
            let answer = app.write_as(&auth, rq.lease, |x, _| live_activity_register(app, x, &auth, &rq.body))?;
            // a token that is new has been sent nothing: once it is stored, a round sends it the counts
            app.live_soon(auth.room);
            Ok(answer)
        }
        ("POST", ["link"]) => {
            let auth = read_auth()?;
            // not under the room's recovery lock (a lease must be kept alive through a recovery), but under the
            // device's present standing; its report reaches the human devices in the order of the writes
            app.write(|x, fx| {
                crate::app::still(x, &auth)?;
                let answer = crate::app::link(x, &auth, &rq.body)?;
                fx.live.push(auth.room);
                fx.events.push(store::Event {
                    room: auth.room,
                    audience: store::Audience { humans: true, others: vec![], except: None },
                    name: "presence",
                    change: None,
                    data: json!({
                        "device": b64(&auth.device), "online": true, "hears": rq.body["hears"].as_bool().unwrap_or(false),
                        "working": rq.body["working"].as_bool().unwrap_or(false), "last_call_at": rq.body["last_call_at"].as_i64().unwrap_or(0),
                    }),
                });
                Ok(answer)
            })
        }

        // ---- switches for tests: the clock and the jobs, only when the hub was started with test control
        ("POST", ["__test", what]) if app.cfg.test_control => match *what {
            "clock" => {
                crate::util::advance_clock(rq.body["advance_ms"].as_i64().unwrap_or(0));
                Ok(json!({ "now": now() }))
            }
            "retention" => Ok(json!({ "pruned": app.retention() })),
            "sweep" => {
                app.sweep();
                Ok(json!({}))
            }
            _ => Err(refuse("not-found", "no such switch")),
        },
        _ => Err(refuse("not-found", "no such route")),
    }
}

fn human_write(
    app: &Arc<App>,
    rq: &Rq,
    f: impl FnOnce(&delivery::Ctx, &Auth) -> Res<Value>,
) -> Res<Value> {
    let auth = app.read(|x| rq.auth(app, x.c))?;
    auth.human()?;
    app.write_as(&auth, rq.lease, |x, _| f(x, &auth))
}

/// What a login's check came to.
enum Checked {
    Found(i64, Vec<u8>),
    Wrong,
    Wait(u64),
}

/// An admitted check that ends without a result (its thread died) is taken off the record.
struct Checking<'a> {
    app: &'a App,
    account: &'a [u8],
    source: &'a [u8],
    attempt: Option<i64>,
}

impl Drop for Checking<'_> {
    fn drop(&mut self) {
        if let Some(attempt) = self.attempt {
            let _ = self
                .app
                .db
                .write(|c| crate::throttle::not_checked(c, self.account, self.source, attempt));
        }
    }
}

/// `POST /v2/account/login` and `/recover`: one answer for an unknown e-mail and a wrong secret, at one cost.
/// Failures slow their source down and lock nobody (`throttle.rs`).
fn login(app: &Arc<App>, rq: &Rq, kit: bool) -> Res<Value> {
    use crate::throttle::{self, Verdict};
    // when the request came: a turn in line is kept by coming in time
    let arrived = now();
    limited(app.limits.logins.check(rq.ip.as_bytes(), arrived, true))?;
    // the password and the Emergency Kit are throttled apart
    // (an account is named by its e-mail; a kit also by the account's id, and that is then its key here)
    let named = accounts::name_of(&rq.body).key();
    let account_key = format!("{}:{named}", if kit { "kit" } else { "password" });
    let account_key = account_key.as_bytes();
    // the source as the account knows it: a keyed hash of the address
    let source = crate::push::source_hash(&app.ticket_key, &rq.ip);
    let throttled = app.cfg.login_throttle;
    let (row, known) = app.read(|x| {
        // a source waiting out its own failures is told so before anything is spent on it
        if throttled {
            if let Some(wait) = throttle::own_wait(x.c, account_key, &source, x.now)? {
                return Err(refuse("rate-limited", "too many requests").retry(wait));
            }
        }
        let row = app.accounts.login_row(x.c, &rq.body, kit)?;
        let known = accounts::knows_source(x.c, row.account(), &source)?;
        Ok((row, known))
    })?;
    let revision = row.revision();
    // The slow hash is made on the pool with no database connection held. The attempt is admitted there, at the
    // moment its check starts: time spent waiting for the pool lets nobody check faster than the throttle says.
    let checked = app.pooled(|| -> Res<Checked> {
        if !throttled {
            return Ok(app
                .accounts
                .check_login(row)
                .map_or(Checked::Wrong, |(a, copy)| Checked::Found(a, copy)));
        }
        // (the time is taken under the write lock: waiting for it lets nobody start sooner than the line says)
        let finish = |attempt: i64, found: &Option<(i64, Vec<u8>)>| {
            app.db.write(|c| match found {
                Some(_) => throttle::succeeded(c, account_key, &source, attempt),
                None => throttle::failed(c, account_key, &source, attempt, now()),
            })
        };
        match app
            .db
            .write(|c| throttle::admit(c, account_key, &source, known, now(), arrived))?
        {
            Verdict::Own(wait) => Ok(Checked::Wait(wait)),
            Verdict::Line { wait, early: None } => {
                // the same work as a check
                app.accounts.spend(&row);
                Ok(Checked::Wait(wait))
            }
            Verdict::Line {
                wait,
                early: Some(attempt),
            } => {
                // a source the account knows: checked on record; a wrong credential is told to wait its turn
                let mut checking = Checking {
                    app,
                    account: account_key,
                    source: &source,
                    attempt: Some(attempt),
                };
                let found = app.accounts.check_login(row);
                finish(attempt, &found)?;
                checking.attempt = None;
                Ok(found.map_or(Checked::Wait(wait), |(a, copy)| Checked::Found(a, copy)))
            }
            Verdict::Check { attempt } => {
                let mut checking = Checking {
                    app,
                    account: account_key,
                    source: &source,
                    attempt: Some(attempt),
                };
                let found = app.accounts.check_login(row);
                finish(attempt, &found)?;
                checking.attempt = None;
                Ok(found.map_or(Checked::Wrong, |(a, copy)| Checked::Found(a, copy)))
            }
        }
    })??;
    let (account, copy) = match checked {
        Checked::Found(account, copy) => (account, copy),
        Checked::Wait(wait) => return Err(refuse("rate-limited", "too many requests").retry(wait)),
        Checked::Wrong => {
            return Err(refuse(
                if kit { "wrong-recovery" } else { "wrong-login" },
                "e-mail or secret is wrong",
            ))
        }
    };
    // The answer is made in a transaction that finds the account as the check found it: a password or kit
    // replaced meanwhile makes this login start over.
    app.write(|x, _| {
        if accounts::revision_of(x.c, account)? != revision {
            return Err(refuse(
                "overloaded",
                "the account changed under this login: try again",
            )
            .retry(1));
        }
        accounts::remember_source(x.c, account, &source, x.now)?;
        login_answer(app, x.c, account, &copy)
    })
}

/// The rooms of an account (one for now), each with the sealed copy and a sign-in challenge for the recovery key.
fn login_answer(app: &Arc<App>, c: &rusqlite::Connection, account: i64, copy: &[u8]) -> Res<Value> {
    let t = now();
    let (kdf, email, handle): (Option<String>, Option<String>, Vec<u8>) = c.query_row(
        "SELECT kdf, email, user_handle FROM accounts WHERE account_id = ?1",
        [account],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    let rooms: Vec<Value> = accounts::rooms_of(c, account)?
        .iter()
        .map(|room| json!({ "room_id": b64(room), "sealed_copy": b64(copy), "challenge": b64(&app.sessions.challenge(room, t)) }))
        .collect();
    // (who signed in is told which account it is: its id, and its e-mail if it has one)
    Ok(
        json!({ "rooms": rooms, "kdf": kdf.and_then(|k| serde_json::from_str::<Value>(&k).ok()), "account": accounts::id_text(&handle), "email": email }),
    )
}

fn push_register(app: &Arc<App>, x: &delivery::Ctx, auth: &Auth, v: &Value) -> Res<Value> {
    let level = match v["level"].as_str() {
        Some("all") => "all",
        Some("knocking") => "knocking",
        _ => return Err(refuse("bad-format", "level: all or knocking")),
    };
    let count: i64 = x.c.query_row(
        "SELECT count(*) FROM push_subscriptions WHERE room_id = ?1 AND device = ?2",
        rusqlite::params![&auth.room[..], &auth.device[..]],
        |r| r.get(0),
    )?;
    let bad = |m: &str| refuse("bad-format", m.to_string());
    if let Some(web) = v.get("web_push").filter(|w| !w.is_null()) {
        let endpoint = web["endpoint"]
            .as_str()
            .ok_or_else(|| bad("web_push.endpoint"))?;
        if crate::push::endpoint_origin(endpoint, &app.cfg.push_hosts).is_none() {
            return Err(bad("web_push.endpoint: not a push service this hub calls"));
        }
        let p256dh = field(&web["keys"], "p256dh")?;
        let secret = field(&web["keys"], "auth")?;
        if p256dh.len() != 65 || secret.len() != 16 {
            return Err(bad("web_push.keys"));
        }
        upsert_push(
            x,
            auth,
            count,
            "web_push",
            endpoint,
            Some(&p256dh),
            Some(&secret),
            None,
            None,
            None,
            level,
            app.cfg.push_subscriptions_per_device,
        )
    } else if let Some(apns) = v.get("apns").filter(|w| !w.is_null()) {
        let (token, environment, topic) = (
            apns["token"].as_str().unwrap_or(""),
            apns["environment"].as_str().unwrap_or(""),
            apns["topic"].as_str().unwrap_or(""),
        );
        let key = field(apns, "key")?;
        let accepted = app
            .apns
            .as_ref()
            .is_some_and(|a| a.accepts(token, environment, topic));
        if !accepted || key.len() != 32 {
            return Err(bad(
                "apns: token, key, environment or topic not accepted by this hub",
            ));
        }
        upsert_push(
            x,
            auth,
            count,
            "apns",
            token,
            None,
            None,
            Some(&key),
            Some(environment),
            Some(topic),
            level,
            app.cfg.push_subscriptions_per_device,
        )
    } else {
        Err(bad("web_push or apns"))
    }
}

#[allow(clippy::too_many_arguments)]
fn upsert_push(
    x: &delivery::Ctx,
    auth: &Auth,
    count: i64,
    kind: &str,
    endpoint: &str,
    p256dh: Option<&[u8]>,
    secret: Option<&[u8]>,
    apns_key: Option<&[u8]>,
    environment: Option<&str>,
    topic: Option<&str>,
    level: &str,
    max: usize,
) -> Res<Value> {
    let held =
        x.c.prepare_cached(
            "SELECT 1 FROM push_subscriptions WHERE room_id = ?1 AND device = ?2 AND endpoint = ?3",
        )?
        .exists(rusqlite::params![
            &auth.room[..],
            &auth.device[..],
            endpoint
        ])?;
    if !held && count as usize >= max {
        return Err(refuse(
            "too-many",
            "a device has at most 10 push registrations",
        ));
    }
    x.c.prepare_cached(
        "INSERT INTO push_subscriptions (room_id, device, kind, endpoint, p256dh, auth, apns_key, environment, topic, level, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT (room_id, device, endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, apns_key = excluded.apns_key,
           environment = excluded.environment, topic = excluded.topic, level = excluded.level",
    )?
    .execute(rusqlite::params![&auth.room[..], &auth.device[..], kind, endpoint, p256dh, secret, apns_key, environment, topic, level, x.now as i64])?;
    Ok(json!({ "registered": true }))
}

fn live_activity_register(app: &Arc<App>, x: &delivery::Ctx, auth: &Auth, v: &Value) -> Res<Value> {
    let bad = |m: &str| refuse("bad-format", m.to_string());
    let (token, tag, environment, topic) = (
        v["token"].as_str().unwrap_or(""),
        v["tag"].as_str().unwrap_or(""),
        v["environment"].as_str().unwrap_or(""),
        v["topic"].as_str().unwrap_or(""),
    );
    let accepted = app
        .apns
        .as_ref()
        .is_some_and(|a| a.accepts(token, environment, topic));
    if !accepted
        || tag.is_empty()
        || tag.len() > 64
        || !tag.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err(bad(
            "live-activity: token, tag, environment or topic not accepted by this hub",
        ));
    }
    let column = match v["kind"].as_str() {
        Some("start") => "start_token",
        Some("activity") => "activity_token",
        _ => return Err(bad("kind: start or activity")),
    };
    x.c.prepare_cached(&format!(
        "INSERT INTO live_activities (room_id, device, environment, topic, tag, {column}, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (room_id, device) DO UPDATE SET environment = excluded.environment, topic = excluded.topic, tag = excluded.tag,
           sent_working = CASE WHEN {column} IS excluded.{column} THEN sent_working END,
           sent_waiting = CASE WHEN {column} IS excluded.{column} THEN sent_waiting END,
           {column} = excluded.{column}"
    ))?
    .execute(rusqlite::params![&auth.room[..], &auth.device[..], environment, topic, tag, token, x.now as i64])?;
    Ok(json!({ "registered": true }))
}

// ---- the stream

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Res<T> + Send + 'static) -> Res<T> {
    tokio::task::spawn_blocking(f)
        .await
        .unwrap_or_else(|_| Err(refuse("internal", "internal error")))
}

struct StreamGuard {
    app: Arc<App>,
    auth: Auth,
    id: u64,
}

impl Drop for StreamGuard {
    fn drop(&mut self) {
        self.app.live.close(&self.auth.room, self.id);
        self.app.stream_closed(self.auth);
    }
}

/// `GET /v2/stream?after=`: server-sent events; resumes by change number (`after`, or `Last-Event-ID`).
async fn stream(
    conn: &Conn,
    app: &Arc<App>,
    bearer: Option<&str>,
    lease: Option<u64>,
    query: &[(String, String)],
    last_event_id: Option<&str>,
) -> Res<Answer> {
    let (a, bearer) = (app.clone(), bearer.map(str::to_string));
    let token = bearer.clone();
    let (auth, until) =
        blocking(move || a.read(|x| a.sessions.authorise_until(x.c, bearer.as_deref(), x.now)))
            .await?;
    if auth.who == Who::Spent {
        return Err(refuse("not-member", "this recovery key was replaced"));
    }
    let after: Option<i64> = query
        .iter()
        .find(|(k, _)| k == "after")
        .map(|(_, v)| v.as_str())
        .or(last_event_id)
        .and_then(|v| v.parse().ok())
        .filter(|v| *v >= 0);
    // A new stream ends the device's older ones (a browser may never close the stream of a reloaded page).
    // An agent device's processes overlap while one restarts: there only the lease holder's stream replaces
    // the others, a stale holder is told `lease-lost`, and a stream opened without `Trommi-Lease` (a client
    // before this rule) takes its place beside them, as before, within the limit.
    let replace = match (auth.who, lease) {
        (Who::Agent, Some(given)) => {
            let a = app.clone();
            blocking(move || a.read(|x| crate::app::check_lease(x.c, &auth, Some(given), x.now)))
                .await?;
            true
        }
        (Who::Agent, None) => false,
        _ => true,
    };
    // the stream lives as long as the token it was opened with; the device resumes with a new one
    let generation = if auth.who == Who::Agent { lease } else { None };
    let (s, rx) = match app.live.open(
        auth,
        replace,
        generation,
        app.cfg.streams_per_device,
        app.cfg.stream_buffer_bytes,
        until,
        Some(conn.clone()),
    ) {
        Ok(opened) => opened,
        Err(live::Refused::TooMany) => {
            return Err(refuse(
                "too-many",
                "this device has its limit of streams open",
            ))
        }
        Err(live::Refused::LeaseLost) => {
            return Err(refuse(
                "lease-lost",
                "this process does not hold the device's lease",
            ))
        }
    };
    // the device may have been removed between the check of its token and the registration of its stream
    let (a, registered) = (app.clone(), s.clone());
    let standing =
        blocking(move || a.read(|x| store::standing(x.c, &auth.room, &auth.device))).await?;
    if standing != Some(auth.who) {
        registered.end();
        app.live.close(&auth.room, registered.id);
        return Err(refuse("not-member", "this device is no longer in the room"));
    }
    // or signed out meanwhile: a sign-out removes the token first and cuts the registered streams after, so
    // either it found this stream or this check finds the token gone
    if !app.sessions.holds(token.as_deref(), now()) {
        registered.end();
        app.live.close(&auth.room, registered.id);
        return Err(refuse("unauthorised", "sign in"));
    }
    // at the moment its token runs out the stream is over, whether anything is sent then or not
    let deadline = s.clone();
    let left = until.saturating_sub(now());
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(left)).await;
        deadline.expire();
    });
    let opened = app.clone();
    blocking(move || {
        opened.stream_opened(&auth);
        Ok(())
    })
    .await?;
    let guard = StreamGuard {
        app: app.clone(),
        auth,
        id: s.id,
    };
    s.send_now(bytes::Bytes::from_static(b": trommi hub\n\n"));
    let catch_up = app.clone();
    let queued = s.queued.clone();
    let gone = s.gone.clone();
    tokio::task::spawn_blocking(move || {
        let Some(mut cursor) = after else {
            // no cursor: live from here on
            s.go_live(i64::MIN);
            return;
        };
        loop {
            let page = catch_up.read(|x| content::changes(x.c, &s.auth, cursor, Some(256)));
            let Ok(page) = page else {
                s.end();
                return;
            };
            for item in page["items"].as_array().into_iter().flatten() {
                let name = if item["kind"] == "envelope" {
                    "envelope"
                } else {
                    "log"
                };
                if !s.send_now(live::sse(name, item["change"].as_i64(), item)) {
                    return;
                }
            }
            cursor = page["change"].as_i64().unwrap_or(cursor);
            if page["more"] != true {
                break;
            }
            // a reader that does not keep up is not fed faster than it reads
            while s.queued.load(Ordering::Relaxed) > 256 * 1024 && !s.is_closed() {
                std::thread::sleep(Duration::from_millis(20));
            }
            if s.is_closed() {
                return;
            }
        }
        s.go_live(cursor);
    });
    Ok(Response::builder()
        .status(200)
        .header("content-type", "text/event-stream; charset=utf-8")
        .header("cache-control", "no-cache, no-transform")
        .header("x-accel-buffering", "no")
        .body(Body::events(rx, queued, until, gone).guard(guard))
        .expect("a valid response"))
}

// ---- files

fn file_answer(
    size: u64,
    range: Option<&str>,
    immutable: bool,
    path: std::path::PathBuf,
) -> Res<Answer> {
    let (status, start, end) = match http::range(range, size) {
        Ok(None) => (200, 0, size.saturating_sub(1)),
        Ok(Some((a, b))) => (206, a, b),
        Err(()) => {
            let mut answer = http::refusal(&refuse("range", "the range cannot be served"));
            if let Ok(v) = format!("bytes */{size}").parse() {
                answer.headers_mut().insert("content-range", v);
            }
            return Ok(answer);
        }
    };
    let length = if size == 0 { 0 } else { end - start + 1 };
    let (tx, rx) = tokio::sync::mpsc::channel::<std::io::Result<bytes::Bytes>>(4);
    tokio::spawn(async move {
        use tokio::io::{AsyncReadExt, AsyncSeekExt};
        let mut file = match tokio::fs::File::open(&path).await {
            Ok(f) => f,
            Err(e) => {
                let _ = tx.send(Err(e)).await;
                return;
            }
        };
        if file.seek(std::io::SeekFrom::Start(start)).await.is_err() {
            return;
        }
        let mut left = length;
        let mut buffer = vec![0u8; 65536];
        while left > 0 {
            let want = buffer.len().min(left as usize);
            match file.read(&mut buffer[..want]).await {
                Ok(0) => {
                    let _ = tx.send(Err(std::io::ErrorKind::UnexpectedEof.into())).await;
                    return;
                }
                Ok(n) => {
                    left -= n as u64;
                    // a reader that stalls for 30 s is dropped
                    match tokio::time::timeout(
                        Duration::from_secs(30),
                        tx.send(Ok(bytes::Bytes::copy_from_slice(&buffer[..n]))),
                    )
                    .await
                    {
                        Ok(Ok(())) => {}
                        _ => return,
                    }
                }
                Err(e) => {
                    let _ = tx.send(Err(e)).await;
                    return;
                }
            }
        }
    });
    let mut builder = Response::builder()
        .status(status)
        .header("content-type", "application/octet-stream")
        .header("accept-ranges", "bytes")
        .header("content-length", length)
        .header(
            "cache-control",
            if immutable {
                "private, max-age=31536000, immutable"
            } else {
                "private, no-store"
            },
        );
    if status == 206 {
        builder = builder.header("content-range", format!("bytes {start}-{end}/{size}"));
    }
    Ok(builder.body(Body::chunks(rx)).expect("a valid response"))
}

async fn download(
    app: &Arc<App>,
    bearer: Option<&str>,
    file: &str,
    range: Option<&str>,
) -> Res<Answer> {
    let file = id::<16>(file)?;
    let (a, bearer) = (app.clone(), bearer.map(str::to_string));
    let (auth, row) = blocking(move || {
        a.read(|x| {
            let auth = a.sessions.authorise(x.c, bearer.as_deref(), x.now)?;
            let row = files::readable(x.c, &auth, &file)?;
            Ok((auth, row))
        })
    })
    .await?;
    file_answer(
        row.size,
        range,
        true,
        files::path(&app.files, &auth.room, &file),
    )
}

async fn shared(
    app: &Arc<App>,
    ip: &str,
    share: &str,
    secret: Option<&str>,
    range: Option<&str>,
) -> Res<Answer> {
    limited(app.limits.shares.take(ip.as_bytes(), 1.0, now()))?;
    let missing = || refuse("not-found", "no such share, or it ran out");
    let share = id::<16>(share).map_err(|_| missing())?;
    let secret = secret.and_then(unb64);
    let a = app.clone();
    let (room, file, size) =
        blocking(move || a.read(|x| files::open_share(x.c, &share, secret.as_deref(), x.now)))
            .await?;
    file_answer(size, range, false, files::path(&app.files, &room, &file))
}

/// `PUT /v2/files/{file_id}`: the bytes, written once. The asker is checked before the body is read and again
/// after it: a device removed during the upload stores nothing.
async fn upload(
    app: &Arc<App>,
    bearer: Option<&str>,
    lease: Option<u64>,
    file: &str,
    headers: &hyper::HeaderMap,
    body: &mut ReqBody,
) -> Res<Answer> {
    let file = id::<16>(file)?;
    let announced: Option<u64> =
        http::header(headers, "content-length").and_then(|v| v.parse().ok());
    let (a, bearer) = (app.clone(), bearer.map(str::to_string));
    let (auth, used, again) = blocking(move || {
        a.read(|x| {
            let auth = a.sessions.authorise(x.c, bearer.as_deref(), x.now)?;
            let (used, again) = files::admit(x, &auth, &file, announced)?;
            Ok((auth, used, again))
        })
    })
    .await?;
    let limit = app.cfg.file_limit;
    // Room for the bytes is reserved before the first one is read, and given back however the upload ends: what
    // is being uploaded counts against the room's quota like what is stored.
    let _reserved = app.reserve_upload(
        &auth.room,
        if again { 0 } else { announced.unwrap_or(limit) },
        used,
    )?;
    let io = |e: std::io::Error| {
        crate::log::warn(
            "file_write_failed",
            json!({ "error": e.kind().to_string() }),
        );
        refuse("internal", "internal error")
    };
    let mut up =
        tokio::task::block_in_place(|| files::Upload::begin(&app.files, &auth.room, &file))
            .map_err(io)?;
    let deadline = Duration::from_secs(60 + announced.unwrap_or(limit) / 16_384);
    tokio::time::timeout(deadline, async {
        loop {
            match tokio::time::timeout(Duration::from_secs(30), body.frame()).await {
                Err(_) => return Err(refuse("bad-format", "the upload stalled")),
                Ok(None) => return Ok(()),
                Ok(Some(Err(_))) => return Err(refuse("bad-format", "the upload broke off")),
                Ok(Some(Ok(frame))) => {
                    if let Ok(data) = frame.into_data() {
                        if up.size + data.len() as u64 > limit {
                            return Err(refuse("too-large", "a file is at most 64 MiB"));
                        }
                        tokio::task::block_in_place(|| up.write(&data)).map_err(io)?;
                    }
                }
            }
        }
    })
    .await
    .unwrap_or_else(|_| Err(refuse("bad-format", "the upload took too long")))?;
    let sha256 = tokio::task::block_in_place(|| up.seal()).map_err(io)?;
    let size = up.size;
    let a = app.clone();
    // The row and the file's place in one transaction: a deletion of the row cannot come between the two, and a
    // device removed during the upload stores nothing.
    blocking(move || {
        a.write_as(&auth, lease, |x, _| {
            if let files::Stored::New = files::record(x, &auth, &file, size, &sha256)? {
                up.place().map_err(|e| {
                    crate::log::warn(
                        "file_write_failed",
                        json!({ "error": e.kind().to_string() }),
                    );
                    refuse("internal", "internal error")
                })?;
            }
            Ok(())
        })
    })
    .await?;
    Ok(http::json(
        200,
        &json!({ "file_id": b64(&file), "size": size, "sha256": b64(&sha256) }),
    ))
}
