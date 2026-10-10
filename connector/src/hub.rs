//! The hub's routes as a client uses them (`spec/hub-api.md`): JSON over HTTPS with byte strings in base64url,
//! sign-in by signed challenge (spec/v2.md 12.3), the lease header on an agent's writes (13.7), the live stream
//! as server-sent events, and files as raw bodies.
//!
//! Nothing here keeps protocol state or decides anything: the hub is untrusted, and what it returns is checked
//! by the core. A refusal comes back as a [`Fault`] with the hub's code, status and retry-after. No request or
//! answer is logged.
use crate::error::{Fault, Result};
use crate::util::now_ms;
use futures_util::StreamExt as _;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use trommi_core::hub_auth::{HubAddress, SignedHubAuth};
use trommi_core::ids::{base64url_decode, base64url_encode, RoomId};

/// How long a request may take before it counts as failed.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// How long a file may take.
const FILE_TIMEOUT: Duration = Duration::from_secs(600);
/// A token is renewed this long before it runs out.
const TOKEN_MARGIN_MS: u64 = 60_000;
/// The largest JSON answer read: the hub bounds its answers at 8 MiB of content, base64 and framing on top.
const MAX_ANSWER_LEN: usize = 24 << 20;
/// The longest line of the stream that is read; an event holds at most one Commit request (1 MiB) as base64.
const MAX_EVENT_LEN: usize = 4 << 20;

/// Base64url without padding.
pub fn b64(bytes: &[u8]) -> String {
    base64url_encode(bytes)
}

/// The bytes of a base64url field of an answer; `bad-format` when it is missing or not base64url.
pub fn unb64(value: &Value, field: &str) -> Result<Vec<u8>> {
    value
        .get(field)
        .and_then(Value::as_str)
        .and_then(|text| base64url_decode(text).ok())
        .ok_or_else(|| Fault::new("bad-format", format!("the hub's answer has no {field}")))
}

/// Answers a challenge: the device's `HubAuth` and its signature.
pub type Signer = Arc<
    dyn Fn(
            [u8; 32],
        )
            -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<SignedHubAuth>> + Send>>
        + Send
        + Sync,
>;

#[derive(Default)]
struct Token {
    value: String,
    expires_at: u64,
}

/// One hub, and for a signed-in device its room, token and lease.
pub struct Hub {
    http: reqwest::Client,
    address: HubAddress,
    room: Option<RoomId>,
    signer: Option<Signer>,
    token: Mutex<Token>,
    /// One sign-in at a time.
    signing_in: tokio::sync::Mutex<()>,
    /// The lease's generation; 0 while this process holds none.
    lease: AtomicU64,
}

impl std::fmt::Debug for Hub {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Hub({})", self.address.as_str())
    }
}

/// One event of the live stream.
#[derive(Debug, Clone, PartialEq)]
pub struct StreamEvent {
    /// The event's name: `envelope`, `log`, `welcome`, `ping`, …
    pub name: String,
    /// Its JSON.
    pub data: Value,
}

/// The live stream, read event by event.
pub struct Stream {
    body: futures_util::stream::BoxStream<'static, reqwest::Result<bytes::Bytes>>,
    buffer: Vec<u8>,
}

impl Stream {
    /// The next event; none when the hub ended the stream (a token ran out, the device was removed). A stream
    /// that stays silent for longer than the hub's pings allow is an error: the caller connects again.
    pub async fn next(&mut self, silence: Duration) -> Result<Option<StreamEvent>> {
        loop {
            if let Some(event) = self.take_event()? {
                return Ok(Some(event));
            }
            let chunk = tokio::time::timeout(silence, self.body.next())
                .await
                .map_err(|_| Fault::new("offline", "the stream went silent"))?;
            match chunk {
                None => return Ok(None),
                Some(Err(error)) => return Err(transport(&error)),
                Some(Ok(bytes)) => {
                    if self.buffer.len() + bytes.len() > MAX_EVENT_LEN {
                        return Err(Fault::new(
                            "too-large",
                            "an event of the stream is too long",
                        ));
                    }
                    self.buffer.extend_from_slice(&bytes);
                }
            }
        }
    }

    /// Cuts one whole event (up to a blank line) off the buffer. Comments and events without data are passed
    /// over.
    fn take_event(&mut self) -> Result<Option<StreamEvent>> {
        loop {
            let Some(end) = self.buffer.windows(2).position(|pair| pair == b"\n\n") else {
                return Ok(None);
            };
            let block: Vec<u8> = self.buffer.drain(..end + 2).collect();
            let text = String::from_utf8_lossy(&block);
            let mut name = String::new();
            let mut data = String::new();
            for line in text.lines() {
                if let Some(value) = line.strip_prefix("event:") {
                    name = value.trim().to_string();
                } else if let Some(value) = line.strip_prefix("data:") {
                    data.push_str(value.trim_start());
                }
            }
            if name.is_empty() || data.is_empty() {
                continue;
            }
            let data = serde_json::from_str(&data)
                .map_err(|_| Fault::new("bad-format", "an event of the stream is not JSON"))?;
            return Ok(Some(StreamEvent { name, data }));
        }
    }
}

/// A failure below HTTP: the hub was not reached. The text names no URL parameters and no content.
fn transport(error: &reqwest::Error) -> Fault {
    let what = if error.is_timeout() {
        "the hub did not answer in time"
    } else if error.is_connect() {
        "the hub could not be reached"
    } else {
        "the connection to the hub failed"
    };
    Fault::new("offline", what)
}

/// Whether a fault says that what answers is no hub of this protocol, or wants another client: a status
/// without a code of the protocol (a 404 page, a proxy's answer), an answer that is no JSON or no event
/// stream, `client-too-old`. Trying again soon helps nothing; the connector stops and says so.
pub fn is_no_hub(fault: &Fault) -> bool {
    fault.code.starts_with("http-") || fault.code == "bad-format" || fault.code == "client-too-old"
}

/// Whether a fault is worth another try later with the same bytes: the hub was not reached, or it asked to wait.
pub fn is_transient(fault: &Fault) -> bool {
    matches!(
        fault.code.as_str(),
        "offline" | "overloaded" | "rate-limited" | "internal"
    ) || fault.status.is_some_and(|status| status >= 500)
}

impl Hub {
    /// A client for the hub at `address`, which must be a canonical hub address (`https://host[:port]`, or
    /// `http://` for localhost and 127.0.0.1 only). `room` and `signer` make it a signed-in device's.
    pub fn new(address: &str, room: Option<RoomId>, signer: Option<Signer>) -> Result<Hub> {
        let address = HubAddress::parse(address)
            .map_err(|_| Fault::new("bad-format", "the hub's address is not canonical"))?;
        let http = reqwest::Client::builder()
            .user_agent(crate::CLIENT)
            .connect_timeout(Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::none())
            .https_only(address.as_str().starts_with("https://"))
            .build()
            .map_err(|_| Fault::new("internal", "no HTTP client"))?;
        Ok(Hub {
            http,
            address,
            room,
            signer,
            token: Mutex::new(Token::default()),
            signing_in: tokio::sync::Mutex::new(()),
            lease: AtomicU64::new(0),
        })
    }

    /// The hub's canonical address.
    pub fn address(&self) -> &HubAddress {
        &self.address
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.address.as_str())
    }

    /// Reads an answer: its JSON on 200, else the refusal as a fault.
    async fn answer(response: reqwest::Response) -> Result<Value> {
        let status = response.status().as_u16();
        let retry_after = response
            .headers()
            .get("retry-after")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok());
        if response
            .content_length()
            .is_some_and(|len| len > MAX_ANSWER_LEN as u64)
        {
            return Err(Fault::new("too-large", "the hub's answer is too long"));
        }
        // Read piece by piece: a body without a length is bounded as it comes.
        let mut body = Vec::new();
        let mut pieces = response.bytes_stream();
        while let Some(piece) = pieces.next().await {
            let piece = piece.map_err(|e| transport(&e))?;
            if body.len() + piece.len() > MAX_ANSWER_LEN {
                return Err(Fault::new("too-large", "the hub's answer is too long"));
            }
            body.extend_from_slice(&piece);
        }
        let parsed: Option<Value> = serde_json::from_slice(&body).ok();
        if status == 200 {
            return parsed.ok_or_else(|| Fault::new("bad-format", "the hub's answer is not JSON"));
        }
        let value = parsed.unwrap_or(Value::Null);
        // The code is the hub's word and ends up in logs and in what the agent reads: only the shape of a code
        // of the protocol is taken.
        let code = value
            .get("error")
            .and_then(Value::as_str)
            .filter(|code| {
                (1..=40).contains(&code.len())
                    && code
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            })
            .map(str::to_owned)
            .unwrap_or_else(|| {
                if status == 426 {
                    "client-too-old".into()
                } else if status >= 500 {
                    "internal".into()
                } else {
                    format!("http-{status}")
                }
            });
        // The hub's text is shown to the agent: one line, cut, no markup.
        let message: String = value
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("")
            .chars()
            .filter(|c| {
                !c.is_control()
                    && !matches!(*c, '<' | '>' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
            })
            .take(200)
            .collect();
        let mut fault = Fault::new(code, message).status(status);
        fault.retry_after = retry_after;
        // Of what else a refusal carries, only what a caller acts on.
        if value.get("voided") == Some(&Value::Bool(true)) {
            fault.extra.insert("voided".into(), Value::Bool(true));
        }
        Err(fault)
    }

    /// A request without a token: the invite routes, the challenge.
    pub async fn open_call(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Value> {
        let mut request = self
            .http
            .request(method, self.url(path))
            .timeout(REQUEST_TIMEOUT)
            .header("Trommi-Client", crate::CLIENT);
        if let Some(body) = body {
            request = request
                .header("content-type", "application/json")
                .body(body.to_string());
        }
        Self::answer(request.send().await.map_err(|e| transport(&e))?).await
    }

    fn room_path(&self) -> Result<String> {
        self.room
            .map(|room| format!("/v2/rooms/{}", room.to_base64url()))
            .ok_or_else(|| Fault::new("no-room", "this client is not signed in to a room"))
    }

    /// Signs in (12.3): a fresh challenge, the device's signature over it, a token for ten minutes.
    async fn sign_in(&self) -> Result<String> {
        let _one = self.signing_in.lock().await;
        if let Some(token) = self.fresh_token() {
            return Ok(token);
        }
        let signer = self.signer.as_ref().ok_or_else(|| {
            Fault::new("unauthorised", "this client has no device to sign in with")
        })?;
        let room = self.room_path()?;
        let issued = self
            .open_call(reqwest::Method::GET, &format!("{room}/challenge"), None)
            .await?;
        let challenge: [u8; 32] = unb64(&issued, "challenge")?
            .try_into()
            .map_err(|_| Fault::new("bad-format", "the hub's challenge is not 32 bytes"))?;
        let signed = signer(challenge).await?;
        let body = json!({ "auth": b64(&signed.auth), "signature": b64(&signed.signature) });
        let granted = self
            .open_call(
                reqwest::Method::POST,
                &format!("{room}/tokens"),
                Some(&body),
            )
            .await?;
        let value = granted
            .get("token")
            .and_then(Value::as_str)
            .filter(|token| !token.is_empty() && token.is_ascii() && token.len() <= 512)
            .ok_or_else(|| Fault::new("bad-format", "the hub's answer has no token"))?
            .to_string();
        let expires_at = granted
            .get("expires_at")
            .and_then(Value::as_u64)
            .unwrap_or_else(|| now_ms() + 600_000);
        *self.token.lock().unwrap_or_else(|e| e.into_inner()) = Token {
            value: value.clone(),
            expires_at,
        };
        Ok(value)
    }

    fn fresh_token(&self) -> Option<String> {
        let token = self.token.lock().unwrap_or_else(|e| e.into_inner());
        (!token.value.is_empty() && token.expires_at > now_ms() + TOKEN_MARGIN_MS)
            .then(|| token.value.clone())
    }

    fn drop_token(&self) {
        *self.token.lock().unwrap_or_else(|e| e.into_inner()) = Token::default();
    }

    async fn token(&self) -> Result<String> {
        match self.fresh_token() {
            Some(token) => Ok(token),
            None => self.sign_in().await,
        }
    }

    fn with_headers(
        &self,
        request: reqwest::RequestBuilder,
        token: &str,
        write: bool,
    ) -> reqwest::RequestBuilder {
        let request = request
            .header("Trommi-Client", crate::CLIENT)
            .header("authorization", format!("Bearer {token}"));
        match self.lease.load(Ordering::SeqCst) {
            generation if write && generation > 0 => {
                request.header("Trommi-Lease", generation.to_string())
            }
            _ => request,
        }
    }

    /// A request of the signed-in device. A token the hub no longer knows (it restarted) is renewed once.
    pub async fn call(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Value> {
        let write = method != reqwest::Method::GET;
        let mut renewed = false;
        loop {
            let token = self.token().await?;
            let mut request = self
                .with_headers(
                    self.http.request(method.clone(), self.url(path)),
                    &token,
                    write,
                )
                .timeout(REQUEST_TIMEOUT);
            if let Some(body) = body {
                request = request
                    .header("content-type", "application/json")
                    .body(body.to_string());
            }
            let answer = Self::answer(request.send().await.map_err(|e| transport(&e))?).await;
            match answer {
                Err(fault) if fault.code == "unauthorised" && !renewed => {
                    renewed = true;
                    self.drop_token();
                }
                other => return other,
            }
        }
    }

    /// `GET path`.
    pub async fn get(&self, path: &str) -> Result<Value> {
        self.call(reqwest::Method::GET, path, None).await
    }

    /// `POST path` with a JSON body.
    pub async fn post(&self, path: &str, body: &Value) -> Result<Value> {
        self.call(reqwest::Method::POST, path, Some(body)).await
    }

    /// `PUT path` with a JSON body.
    pub async fn put(&self, path: &str, body: &Value) -> Result<Value> {
        self.call(reqwest::Method::PUT, path, Some(body)).await
    }

    /// `DELETE path`.
    pub async fn delete(&self, path: &str) -> Result<Value> {
        self.call(reqwest::Method::DELETE, path, None).await
    }

    /// Takes or renews this device's lease (13.7). `process` is this process's random id; without a held
    /// generation the lease is acquired and every older process loses it, with one it is renewed.
    /// `lease-lost` when another process took it: this one stops writing.
    pub async fn link(&self, process: &[u8; 16], report: &Value) -> Result<u64> {
        let mut body = report.as_object().cloned().unwrap_or_default();
        body.insert("process".into(), json!(b64(process)));
        match self.lease.load(Ordering::SeqCst) {
            0 => {}
            generation => {
                body.insert("generation".into(), json!(generation));
            }
        }
        let answer = self.post("/v2/link", &Value::Object(body)).await?;
        let generation = answer
            .get("generation")
            .and_then(Value::as_u64)
            .filter(|generation| *generation > 0)
            .ok_or_else(|| Fault::new("bad-format", "the hub's answer has no generation"))?;
        self.lease.store(generation, Ordering::SeqCst);
        Ok(generation)
    }

    /// Forgets the lease: the next [`Hub::link`] acquires a new one.
    pub fn drop_lease(&self) {
        self.lease.store(0, Ordering::SeqCst);
    }

    /// Opens the live stream after the change `after`: everything above it first, then what happens.
    pub async fn stream(&self, after: u64) -> Result<Stream> {
        let token = self.token().await?;
        let response = self
            .with_headers(
                self.http
                    .get(self.url(&format!("/v2/stream?after={after}"))),
                &token,
                false,
            )
            .header("accept", "text/event-stream");
        // The answer's head must come in time; the body then lives as long as the stream.
        let response = tokio::time::timeout(REQUEST_TIMEOUT, response.send())
            .await
            .map_err(|_| Fault::new("offline", "the hub did not open the stream in time"))?
            .map_err(|e| transport(&e))?;
        if response.status().as_u16() != 200 {
            let fault = Self::answer(response).await.err();
            if fault.as_ref().is_some_and(|f| f.code == "unauthorised") {
                self.drop_token();
            }
            return Err(fault.unwrap_or_else(|| Fault::new("offline", "no stream")));
        }
        // Anything but an event stream is not this hub's answer (a page of a proxy, another service).
        let is_stream = response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.starts_with("text/event-stream"));
        if !is_stream {
            return Err(Fault::new(
                "bad-format",
                "the hub's stream is no event stream",
            ));
        }
        Ok(Stream {
            body: response.bytes_stream().boxed(),
            buffer: Vec::new(),
        })
    }

    /// Stores a file's bytes as they are (already encrypted; section 11) under `file_id`.
    pub async fn put_file(&self, file_id: &str, bytes: Vec<u8>) -> Result<Value> {
        let token = self.token().await?;
        let request = self
            .with_headers(
                self.http.put(self.url(&format!("/v2/files/{file_id}"))),
                &token,
                true,
            )
            .timeout(FILE_TIMEOUT)
            .header("content-type", "application/octet-stream")
            .body(bytes);
        Self::answer(request.send().await.map_err(|e| transport(&e))?).await
    }

    /// A stored file's bytes, at most `max_len` of them.
    pub async fn get_file(&self, file_id: &str, max_len: usize) -> Result<Vec<u8>> {
        let token = self.token().await?;
        let response = self
            .with_headers(
                self.http.get(self.url(&format!("/v2/files/{file_id}"))),
                &token,
                false,
            )
            .timeout(FILE_TIMEOUT)
            .send()
            .await
            .map_err(|e| transport(&e))?;
        if response.status().as_u16() != 200 {
            return Err(Self::answer(response)
                .await
                .err()
                .unwrap_or_else(|| Fault::new("offline", "no file")));
        }
        let mut out = Vec::new();
        let mut body = response.bytes_stream();
        while let Some(chunk) = body.next().await {
            let chunk = chunk.map_err(|e| transport(&e))?;
            if out.len() + chunk.len() > max_len {
                return Err(Fault::new(
                    "too-large",
                    "the file is larger than a file may be",
                ));
            }
            out.extend_from_slice(&chunk);
        }
        Ok(out)
    }
}
