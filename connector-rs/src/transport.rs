//! transport.mjs: the hub's routes (README "Routes"), sign-in by signed challenge, token refresh, deadlines and GET
//! retries, the lease header, the version headers. The SSE stream itself is read by the client (client.rs).
use crate::crypto::{b64u, is_hex, unb64u};
use crate::error::{Result, ZError};
use crate::model::now_ms;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const REFRESH_BEFORE_MS: u64 = 60_000;
pub const REQUEST_TIMEOUT_MS: u64 = 30_000;
pub const ATTACHMENT_TIMEOUT_MS: u64 = 120_000;
const GET_RETRIES: [u64; 2] = [300, 1000];

/// R9: https:// + lowercase host [+ :port], no path; plain http only for a local or private development hub.
pub fn normalise_hub_url(url: &str) -> Result<String> {
    let bad = |m: &str| ZError::new("bad-argument", m);
    let u = url::Url::parse(url.trim()).map_err(|_| bad("not a hub address"))?;
    let host = u.host_str().unwrap_or("").to_lowercase();
    let local = regex::Regex::new(r"^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$").unwrap().is_match(&host)
        || host.ends_with(".local") || host.ends_with(".ts.net");
    if u.scheme() != "https" && !(u.scheme() == "http" && local) {
        return Err(bad("a hub address is https:// (plain http only for a local hub)"));
    }
    if !u.username().is_empty() || u.password().is_some() || u.query().is_some() || u.fragment().is_some() || !u.path().trim_end_matches('/').is_empty() {
        return Err(bad("a hub address has no path, query or credentials"));
    }
    let port = u.port().map(|p| format!(":{p}")).unwrap_or_default();
    Ok(format!("{}://{}{}", u.scheme(), host, port))
}

/// Every id that goes into a URL path is lowercase hex of its exact length.
pub fn check_id(what: &str, v: &str) -> Result<String> {
    let n = match what {
        "room_id" => 64,
        "attachment_id" | "invite_id" | "session_id" | "share_id" => 32,
        _ => 0,
    };
    if !is_hex(v, n) {
        return Err(ZError::new("bad-argument", format!("{what} must be {n} lowercase hex characters")));
    }
    Ok(v.to_string())
}

pub type Signer = Arc<dyn Fn(&[u8]) -> Result<Vec<u8>> + Send + Sync>;

/// What the hub tells the client by itself: too old, the lease lost for good, a 403 on the stream.
#[derive(Debug, Clone)]
pub enum HubEvent {
    TooOld(ZError),
    LeaseLost(ZError),
}

struct HubState {
    token: Option<String>,
    token_expires_at: u64,
    lease_generation: Option<u64>,
    lease_instance: Option<String>,
    unreachable: bool,
    lease_recovery_at: u64,
    read_only: bool,
}

pub struct Hub {
    pub hub_url: String,
    pub room_id: Option<String>,
    pub client_name: Option<String>,
    http: reqwest::Client,
    signer: Option<Signer>,
    st: Mutex<HubState>,
    signing: tokio::sync::Mutex<()>,
    recovering: tokio::sync::Mutex<()>,
    pub wake: tokio::sync::Notify,
    pub events: Mutex<Option<tokio::sync::mpsc::UnboundedSender<HubEvent>>>,
}

pub struct Opts<'a> {
    pub body: Option<Value>,
    pub raw: Option<Vec<u8>>,
    pub auth: bool,
    pub headers: Vec<(&'a str, String)>,
    pub query: Vec<(&'a str, String)>,
    pub binary: bool,
    pub lease: bool,
    pub timeout_ms: Option<u64>,
}
impl Default for Opts<'_> {
    fn default() -> Self {
        Opts { body: None, raw: None, auth: true, headers: vec![], query: vec![], binary: false, lease: false, timeout_ms: None }
    }
}
pub enum Answer {
    Json(Value),
    Bytes(Vec<u8>),
}
impl Answer {
    pub fn json(self) -> Value {
        match self {
            Answer::Json(v) => v,
            Answer::Bytes(_) => Value::Null,
        }
    }
    pub fn bytes(self) -> Vec<u8> {
        match self {
            Answer::Bytes(b) => b,
            Answer::Json(_) => vec![],
        }
    }
}

pub fn http_client() -> reqwest::Client {
    reqwest::Client::builder().pool_idle_timeout(Duration::from_secs(30)).build().expect("HTTP client")
}

impl Hub {
    pub fn new(hub_url: &str, room_id: Option<String>, client_name: Option<String>, signer: Option<Signer>) -> Result<Hub> {
        Ok(Hub {
            hub_url: normalise_hub_url(hub_url)?, room_id, client_name, http: http_client(), signer,
            st: Mutex::new(HubState { token: None, token_expires_at: 0, lease_generation: None, lease_instance: None, unreachable: false, lease_recovery_at: 0, read_only: false }),
            signing: tokio::sync::Mutex::new(()), recovering: tokio::sync::Mutex::new(()), wake: tokio::sync::Notify::new(), events: Mutex::new(None),
        })
    }
    pub fn url(&self, path: &str) -> String {
        format!("{}/v1{}", self.hub_url, path)
    }
    pub fn room_path(&self, path: &str) -> Result<String> {
        Ok(format!("/rooms/{}{}", check_id("room_id", self.room_id.as_deref().unwrap_or(""))?, path))
    }
    pub fn lease_generation(&self) -> Option<u64> {
        self.st.lock().unwrap().lease_generation
    }
    pub fn set_lease_generation(&self, g: Option<u64>) {
        self.st.lock().unwrap().lease_generation = g;
    }
    pub fn lease_instance(&self) -> Option<String> {
        self.st.lock().unwrap().lease_instance.clone()
    }
    pub fn set_lease_instance(&self, i: Option<String>) {
        self.st.lock().unwrap().lease_instance = i;
    }
    pub fn clear_token(&self) {
        self.st.lock().unwrap().token = None;
    }
    pub fn set_read_only(&self, r: bool) {
        self.st.lock().unwrap().read_only = r;
    }
    fn emit(&self, e: HubEvent) {
        if let Some(tx) = self.events.lock().unwrap().as_ref() {
            let _ = tx.send(e);
        }
    }

    /// Sign in with a signed challenge; one sign-in at a time.
    pub async fn sign_in(&self, given: Option<String>) -> Result<Value> {
        let _g = self.signing.lock().await;
        if let Some(c) = given {
            match self.take_token(Some(c)).await {
                Ok(v) => return Ok(v),
                Err(e) if e.status == Some(401) || e.status == Some(400) => {}
                Err(e) => return Err(e),
            }
        }
        self.take_token(None).await
    }
    async fn take_token(&self, challenge: Option<String>) -> Result<Value> {
        let Some(signer) = self.signer.clone() else { return Err(ZError::new("unauthorised", "no signer for this hub client")) };
        let challenge = match challenge {
            Some(c) => c,
            None => self.request("POST", &self.room_path("/challenge")?, Opts { auth: false, ..Default::default() }).await?.json()["challenge"].as_str().unwrap_or("").to_string(),
        };
        let signed = signer(&unb64u(&challenge)?)?;
        let r = self.request("POST", &self.room_path("/access_tokens")?, Opts { auth: false, body: Some(json!({ "signed_challenge": b64u(&signed) })), ..Default::default() }).await?.json();
        let mut st = self.st.lock().unwrap();
        st.token = r["access_token"].as_str().map(String::from);
        st.token_expires_at = r["expires_at"].as_u64().unwrap_or(0);
        Ok(r)
    }
    pub async fn auth_header(&self) -> Result<String> {
        let need = {
            let st = self.st.lock().unwrap();
            st.token.is_none() || now_ms() + REFRESH_BEFORE_MS > st.token_expires_at
        };
        if need {
            self.sign_in(None).await?;
        }
        Ok(format!("Bearer {}", self.st.lock().unwrap().token.clone().unwrap_or_default()))
    }
    pub fn base_headers(&self) -> Vec<(&'static str, String)> {
        let mut h = vec![];
        if let Some(c) = &self.client_name {
            h.push(("trommi-client", c.clone()));
        }
        h.push(("trommi-protocol", "1".to_string()));
        h
    }
    pub fn lease_headers(&self) -> Vec<(&'static str, String)> {
        match self.lease_generation() {
            Some(g) => vec![("x-lease-generation", g.to_string())],
            None => vec![],
        }
    }

    /// One request; a GET that met a network failure, its deadline or a 502/503/504 is tried twice more.
    pub async fn request(&self, method: &str, path: &str, o: Opts<'_>) -> Result<Answer> {
        let idempotent = method == "GET" || method == "HEAD";
        let mut attempt = 0;
        loop {
            match self.request_once(method, path, &o, false, false).await {
                Ok(a) => return Ok(a),
                Err(e) => {
                    let st = e.status.unwrap_or(999);
                    if !idempotent || attempt >= GET_RETRIES.len() || !(st == 0 || st == 502 || st == 503 || st == 504) {
                        return Err(e);
                    }
                    let wait = 5000.min(e.retry_after.map(|r| r * 1000).filter(|x| *x > 0).unwrap_or(GET_RETRIES[attempt])) + rand_ms(200);
                    tokio::time::sleep(Duration::from_millis(wait)).await;
                    attempt += 1;
                }
            }
        }
    }

    fn request_once<'a>(&'a self, method: &'a str, path: &'a str, o: &'a Opts<'a>, retried: bool, lease_retried: bool) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Answer>> + Send + 'a>> {
        Box::pin(async move {
            let generation = self.lease_generation();
            let mut req = self.http.request(method.parse().unwrap(), self.url(path));
            for (k, v) in self.base_headers().into_iter().chain(o.headers.iter().map(|(k, v)| (*k, v.clone()))) {
                req = req.header(k, v);
            }
            if o.lease {
                for (k, v) in self.lease_headers() {
                    req = req.header(k, v);
                }
            }
            if o.auth {
                req = req.header("authorization", self.auth_header().await?);
            }
            if let Some(raw) = &o.raw {
                req = req.header("content-type", "application/octet-stream").body(raw.clone());
            } else if let Some(b) = &o.body {
                req = req.header("content-type", "application/json").body(serde_json::to_vec(b)?);
            }
            let q: Vec<(&str, String)> = o.query.iter().map(|(k, v)| (*k, v.clone())).collect();
            if !q.is_empty() {
                req = req.query(&q);
            }
            let limit = o.timeout_ms.unwrap_or(if o.raw.is_some() || o.binary { ATTACHMENT_TIMEOUT_MS } else { REQUEST_TIMEOUT_MS });
            let fut = async {
                let res = req.send().await.map_err(|e| {
                    self.st.lock().unwrap().unreachable = true;
                    ZError::new("offline", format!("hub not reachable: {e}")).status(0)
                })?;
                let status = res.status().as_u16();
                if status >= 500 {
                    self.st.lock().unwrap().unreachable = true;
                } else {
                    let was = std::mem::replace(&mut self.st.lock().unwrap().unreachable, false);
                    if was {
                        self.wake.notify_waiters();
                    }
                }
                if status == 401 && o.auth && !retried {
                    self.clear_token();
                    return Err(ZError::new("__retry401", ""));
                }
                if status == 426 {
                    let e = ZError::new("client-too-old", "this client is too old for the hub: update it").status(426);
                    self.emit(HubEvent::TooOld(e.clone()));
                    return Err(e);
                }
                if !(200..300).contains(&status) {
                    let retry_after = res.headers().get("retry-after").and_then(|v| v.to_str().ok()).and_then(|s| s.parse::<u64>().ok());
                    let reason = res.status().canonical_reason().unwrap_or("").to_string();
                    let err: Value = res.json().await.unwrap_or(json!({}));
                    let mut e = ZError::new(err["error"].as_str().map(String::from).unwrap_or_else(|| format!("http-{status}")), err["message"].as_str().map(String::from).unwrap_or(reason)).status(status);
                    e.retry_after = retry_after;
                    e.body = Some(err);
                    return Err(e);
                }
                if o.binary {
                    let b = res.bytes().await.map_err(|e| ZError::new("offline", format!("the answer broke off: {e}")).status(0))?;
                    return Ok(Answer::Bytes(b.to_vec()));
                }
                let text = res.text().await.map_err(|e| ZError::new("offline", format!("the answer broke off: {e}")).status(0))?;
                Ok(Answer::Json(if text.is_empty() { json!({}) } else { serde_json::from_str(&text).map_err(|e| ZError::new("bad-format", e.to_string()))? }))
            };
            let r = match tokio::time::timeout(Duration::from_millis(limit), fut).await {
                Ok(r) => r,
                Err(_) => Err(ZError::new("offline", format!("the hub did not answer within {} s", (limit as f64 / 1000.0).round())).status(0)),
            };
            match r {
                Err(e) if e.code == "__retry401" => self.request_once(method, path, o, true, lease_retried).await,
                Err(e) if e.code == "lease-lost" && o.lease && !lease_retried => {
                    let mut again = self.lease_generation() != generation;
                    if !again {
                        match self.recover_lease().await {
                            Ok(true) => again = true,
                            Ok(false) => self.emit(HubEvent::LeaseLost(e.clone())),
                            Err(_) => return Err(e),
                        }
                    }
                    if again {
                        return self.request_once(method, path, o, retried, true).await;
                    }
                    Err(e)
                }
                r => r,
            }
        })
    }

    /// R4: renew the lease after a lease-lost: true if this process holds it again, false only if another live process
    /// holds it. Any other failure is no verdict (an error). One renewal at a time, at least a second apart.
    pub async fn recover_lease(&self) -> Result<bool> {
        let Some(instance) = self.lease_instance() else { return Ok(false) };
        let _g = self.recovering.lock().await;
        let wait = 1000i64 - (now_ms() as i64 - self.st.lock().unwrap().lease_recovery_at as i64);
        if wait > 0 {
            tokio::time::sleep(Duration::from_millis(wait as u64)).await;
        }
        self.st.lock().unwrap().lease_recovery_at = now_ms();
        match self.agent_lease(&instance, true).await {
            Ok(r) => {
                self.set_lease_generation(r["lease_generation"].as_u64());
                Ok(true)
            }
            Err(e) if e.code == "lease-lost" => Ok(false),
            Err(e) => Err(e),
        }
    }

    fn refuse_if_read_only(&self) -> Result<()> {
        if self.st.lock().unwrap().read_only {
            return Err(ZError::new("follower", "this tab reads only: the writer tab sends"));
        }
        Ok(())
    }

    // ---- routes ----
    pub async fn members(&self, after: i64, invite_id: Option<&str>) -> Result<Value> {
        let mut q = vec![("after_entry_number", after.to_string())];
        if let Some(i) = invite_id {
            q.push(("invite_id", i.to_string()));
        }
        Ok(self.request("GET", &self.room_path("/members")?, Opts { auth: invite_id.is_none(), query: q, ..Default::default() }).await?.json())
    }
    pub async fn devices(&self) -> Result<Value> {
        Ok(self.request("GET", &self.room_path("/devices")?, Opts::default()).await?.json())
    }
    pub async fn sealed_room_keys(&self, after: u32) -> Result<Value> {
        Ok(self.request("GET", &self.room_path("/sealed_room_keys")?, Opts { query: vec![("after_key_epoch", after.to_string())], ..Default::default() }).await?.json())
    }
    pub async fn get_invite(&self, invite_id: &str) -> Result<Value> {
        Ok(self.request("GET", &self.room_path(&format!("/invites/{}", check_id("invite_id", invite_id)?))?, Opts { auth: false, ..Default::default() }).await?.json())
    }
    pub async fn post_request(&self, invite_id: &str, signed_request: &str) -> Result<Value> {
        Ok(self.request("POST", &self.room_path(&format!("/invites/{}/requests", check_id("invite_id", invite_id)?))?, Opts { auth: false, body: Some(json!({ "signed_request": signed_request })), ..Default::default() }).await?.json())
    }
    pub async fn join_status(&self, invite_id: &str, request_hash: &str) -> Result<Value> {
        Ok(self.request("GET", &self.room_path(&format!("/invites/{}/status", check_id("invite_id", invite_id)?))?, Opts { auth: false, query: vec![("request_hash", request_hash.into())], ..Default::default() }).await?.json())
    }
    pub async fn post_envelope(&self, envelope: &str) -> Result<Value> {
        self.refuse_if_read_only()?;
        Ok(self.request("POST", &self.room_path("/envelopes")?, Opts { body: Some(json!({ "envelope": envelope })), headers: self.lease_headers(), ..Default::default() }).await?.json())
    }
    pub async fn envelopes(&self, after: u64, limit: u64, newest: bool) -> Result<Value> {
        let mut q = vec![("after_envelope_number", after.to_string()), ("limit", limit.to_string())];
        if newest {
            q.push(("newest", "1".into()));
        }
        Ok(self.request("GET", &self.room_path("/envelopes")?, Opts { query: q, ..Default::default() }).await?.json())
    }
    pub async fn threads(&self, timeline_kind: &str, timeline_id: &str, before: Option<u64>, after: Option<u64>, limit: u64) -> Result<Value> {
        let mut q = vec![("timeline_kind", timeline_kind.to_string()), ("timeline_id", timeline_id.to_string())];
        if let Some(b) = before {
            q.push(("before_envelope_number", b.to_string()));
        }
        if let Some(a) = after {
            q.push(("after_envelope_number", a.to_string()));
        }
        q.push(("limit", limit.to_string()));
        Ok(self.request("GET", &self.room_path("/threads")?, Opts { query: q, ..Default::default() }).await?.json())
    }
    pub async fn agent_lease(&self, process_instance: &str, renew: bool) -> Result<Value> {
        self.refuse_if_read_only()?;
        let body = if renew { json!({ "process_instance": process_instance, "renew": true }) } else { json!({ "process_instance": process_instance }) };
        Ok(self.request("POST", &self.room_path("/agent_lease")?, Opts { body: Some(body), ..Default::default() }).await?.json())
    }
    pub async fn sessions(&self) -> Result<Value> {
        Ok(self.request("GET", &self.room_path("/sessions")?, Opts::default()).await?.json())
    }
    pub async fn session_grants(&self, sid: &str, after: i64) -> Result<Value> {
        Ok(self.request("GET", &self.room_path(&format!("/sessions/{}/grants", check_id("session_id", sid)?))?, Opts { query: vec![("after_grant_number", after.to_string())], ..Default::default() }).await?.json())
    }
    pub async fn post_session_grant(&self, sid: &str, body: Value) -> Result<Value> {
        self.refuse_if_read_only()?;
        Ok(self.request("POST", &self.room_path(&format!("/sessions/{}/grants", check_id("session_id", sid)?))?, Opts { auth: false, body: Some(body), ..Default::default() }).await?.json())
    }
    pub async fn session_bundle(&self, ids: Option<&[String]>) -> Result<Value> {
        let mut q = vec![];
        if let Some(ids) = ids {
            for i in ids {
                check_id("session_id", i)?;
            }
            q.push(("session_ids", ids.join(",")));
        }
        Ok(self.request("GET", &self.room_path("/session_grants")?, Opts { query: q, ..Default::default() }).await?.json())
    }
    pub async fn sealed_session_keys(&self, sid: &str, after: u32) -> Result<Value> {
        Ok(self.request("GET", &self.room_path(&format!("/sessions/{}/sealed_session_keys", check_id("session_id", sid)?))?, Opts { query: vec![("after_session_key_epoch", after.to_string())], ..Default::default() }).await?.json())
    }
    pub async fn session_back_links(&self, sid: &str) -> Result<Value> {
        Ok(self.request("GET", &self.room_path(&format!("/sessions/{}/key_back_links", check_id("session_id", sid)?))?, Opts::default()).await?.json())
    }
    pub async fn agent_link(&self, report: Value) -> Result<Value> {
        Ok(self.request("POST", &self.room_path("/agent_link")?, Opts { body: Some(report), lease: true, ..Default::default() }).await?.json())
    }
    /// The same as a process's last word: under the generation it holds, never renewed.
    pub async fn agent_link_last(&self, report: Value, timeout_ms: u64) -> Result<Value> {
        Ok(self.request("POST", &self.room_path("/agent_link")?, Opts { body: Some(report), headers: self.lease_headers(), timeout_ms: Some(timeout_ms), ..Default::default() }).await?.json())
    }
    pub async fn agent_watch(&self, working: bool) -> Result<Value> {
        Ok(self.request("POST", &self.room_path("/agent_watch")?, Opts { body: Some(json!({ "working": working })), lease: true, ..Default::default() }).await?.json())
    }
    pub async fn put_attachment(&self, id: &str, bytes: Vec<u8>) -> Result<Value> {
        Ok(self.request("PUT", &self.room_path(&format!("/attachments/{}", check_id("attachment_id", id)?))?, Opts { raw: Some(bytes), lease: true, ..Default::default() }).await?.json())
    }
    pub async fn get_attachment(&self, id: &str) -> Result<Vec<u8>> {
        Ok(self.request("GET", &self.room_path(&format!("/attachments/{}", check_id("attachment_id", id)?))?, Opts { binary: true, ..Default::default() }).await?.bytes())
    }
    pub async fn post_share(&self, attachment_id: &str, body: Value) -> Result<Value> {
        Ok(self.request("POST", &self.room_path(&format!("/attachments/{}/shares", check_id("attachment_id", attachment_id)?))?, Opts { body: Some(body), ..Default::default() }).await?.json())
    }
    pub async fn delete_share(&self, attachment_id: &str, share_id: &str) -> Result<Value> {
        Ok(self.request("DELETE", &self.room_path(&format!("/attachments/{}/shares/{}", check_id("attachment_id", attachment_id)?, check_id("share_id", share_id)?))?, Opts::default()).await?.json())
    }
    pub async fn version(&self) -> Result<Value> {
        Ok(self.request("GET", "/version", Opts { auth: false, headers: vec![("accept", "application/json".into())], ..Default::default() }).await?.json())
    }

    /// The stream's response (the client reads the SSE records).
    pub async fn open_stream(&self, after: u64) -> Result<reqwest::Response> {
        let mut req = self.http.get(format!("{}?after_envelope_number={after}", self.url(&self.room_path("/stream")?)));
        for (k, v) in self.base_headers() {
            req = req.header(k, v);
        }
        req = req.header("authorization", self.auth_header().await?).header("accept", "text/event-stream");
        for (k, v) in self.lease_headers() {
            req = req.header(k, v);
        }
        req.send().await.map_err(|e| ZError::new("offline", format!("hub not reachable: {e}")).status(0))
    }
}

pub fn rand_ms(max: u64) -> u64 {
    let b = crate::crypto::random_bytes(4);
    (u32::from_be_bytes(b.try_into().unwrap()) as u64) % max.max(1)
}
