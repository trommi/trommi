//! HTTP plumbing: the response body type (with guards that live as long as the answer), JSON answers as
//! server.mjs sends them, reading a JSON body with its limits and deadline, the request's context.

use crate::error::{fail, Fail, HResult};
use bytes::Bytes;
use http_body::{Body as HttpBody, Frame, SizeHint};
use http_body_util::{combinators::UnsyncBoxBody, BodyExt, Full};
use hyper::body::Incoming;
use hyper::{HeaderMap, Response, StatusCode};
use serde_json::Value;
use std::any::Any;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::sync::Notify;

/// The answer's body, and whatever must live until it is sent (a write slot, a metrics record, an in-flight count).
pub struct Body {
    inner: UnsyncBoxBody<Bytes, std::io::Error>,
    guards: Vec<Box<dyn Any + Send + Sync>>,
}
impl Body {
    pub fn full(b: impl Into<Bytes>) -> Body { Body { inner: Full::new(b.into()).map_err(|e| match e {}).boxed_unsync(), guards: vec![] } }
    pub fn empty() -> Body { Body::full(Bytes::new()) }
    pub fn from_box(inner: UnsyncBoxBody<Bytes, std::io::Error>) -> Body { Body { inner, guards: vec![] } }
    pub fn guard(&mut self, g: Box<dyn Any + Send + Sync>) { self.guards.push(g) }
}
impl HttpBody for Body {
    type Data = Bytes;
    type Error = std::io::Error;
    fn poll_frame(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Result<Frame<Bytes>, Self::Error>>> { Pin::new(&mut self.inner).poll_frame(cx) }
    fn is_end_stream(&self) -> bool { self.inner.is_end_stream() }
    fn size_hint(&self) -> SizeHint { self.inner.size_hint() }
}

pub type Resp = Response<Body>;

/// Per connection: the peer, and a switch that cuts the connection (Node's req.destroy()).
#[derive(Clone)]
pub struct Conn {
    pub peer: SocketAddr,
    pub cut: Arc<Notify>,
}
impl Conn {
    pub fn destroy(&self) { self.cut.notify_one() }
    pub fn peer_ip(&self) -> String {
        match self.peer.ip() {
            std::net::IpAddr::V4(v) => v.to_string(),
            std::net::IpAddr::V6(v) => match v.to_ipv4_mapped() {
                Some(m) => format!("::ffff:{m}"),
                None => v.to_string(),
            },
        }
    }
}

/// application/json; charset=utf-8, no-store, with a content-length.
pub fn json(status: u16, body: &Value) -> Resp {
    let text = serde_json::to_string(body).unwrap();
    let mut r = Response::new(Body::full(text.clone()));
    *r.status_mut() = StatusCode::from_u16(status).unwrap();
    let h = r.headers_mut();
    h.insert("content-type", "application/json; charset=utf-8".parse().unwrap());
    h.insert("cache-control", "no-store".parse().unwrap());
    h.insert("content-length", text.len().into());
    r
}

pub fn header<'a>(h: &'a HeaderMap, name: &str) -> Option<&'a str> { h.get(name).and_then(|v| v.to_str().ok()) }

/// The request body, whole, within `max` bytes and `deadline` (else the connection goes: C03).
pub async fn read_body(body: Incoming, max: f64, deadline: Duration, conn: &Conn, too_large: impl Fn() -> Fail) -> HResult<Vec<u8>> {
    let mut body = body;
    let mut out = Vec::new();
    let collect = async {
        while let Some(frame) = body.frame().await {
            let frame = frame.map_err(|_| Fail::destroy())?;
            if let Some(d) = frame.data_ref() {
                out.extend_from_slice(d);
                if out.len() as f64 > max {
                    return Err(too_large());
                }
            }
        }
        Ok(())
    };
    match tokio::time::timeout(deadline, collect).await {
        Ok(Ok(())) => Ok(out),
        Ok(Err(e)) => Err(e),
        Err(_) => {
            conn.destroy();
            Err(Fail::destroy())
        }
    }
}

/// readJson of server.mjs: content-length checked first, the body within 15 s, a JSON object (empty is {}).
pub async fn read_json(body: Incoming, headers: &HeaderMap, max: f64, deadline: Duration, conn: &Conn) -> HResult<serde_json::Map<String, Value>> {
    let too = move || Fail::hub("too-large", &format!("a JSON request is at most {} bytes", max as u64));
    let cl = header(headers, "content-length").and_then(|v| v.trim().parse::<f64>().ok()).unwrap_or(0.0);
    if cl > max {
        return Err(too());
    }
    let raw = read_body(body, max, deadline, conn, too).await?;
    parse_object(&raw).ok_or_else(|| Fail::hub("bad-format", "the request body is not a JSON object"))
}
/// The ops/accounts flavour (refuse 413 with "this request is at most N bytes").
pub async fn read_json_ops(body: Incoming, max: f64, deadline: Duration, conn: &Conn) -> HResult<serde_json::Map<String, Value>> {
    let too = move || Fail::reply(413, "too-large", &format!("this request is at most {} bytes", max as u64), serde_json::json!({}));
    let raw = read_body(body, max, deadline, conn, too).await?;
    parse_object(&raw).ok_or_else(|| Fail::reply(400, "bad-format", "the request body is not a JSON object", serde_json::json!({})))
}
pub fn parse_object(raw: &[u8]) -> Option<serde_json::Map<String, Value>> {
    let text = std::str::from_utf8(raw).ok().map(|s| s.to_string()).unwrap_or_else(|| String::from_utf8_lossy(raw).into_owned());
    let text = if text.is_empty() { "{}".to_string() } else { text };
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(o)) => Some(o),
        _ => None,
    }
}

/// `${what} (base64url) is missing` or the bytes (strict base64url: bad-format).
pub fn b64(v: Option<&Value>, what: &str) -> HResult<Vec<u8>> {
    match v {
        Some(Value::String(s)) if !s.is_empty() => Ok(zcrypto::unb64u(s)?),
        _ => fail("bad-argument", &format!("{what} (base64url) is missing")),
    }
}
pub fn hex_param<'a>(v: Option<&'a str>, len: usize, what: &str) -> HResult<&'a str> {
    match v {
        Some(s) if zcrypto::bytes::is_hex(s, len) => Ok(s),
        _ => fail("bad-argument", &format!("{what} must be lowercase hex")),
    }
}
pub fn hex_value<'a>(v: Option<&'a Value>, len: usize, what: &str) -> HResult<&'a str> { hex_param(v.and_then(|v| v.as_str()), len, what) }

/// intParam: dflt when absent or empty; else a safe integer within [min, max].
pub fn int_param(q: &crate::util::Query, name: &str, dflt: i64, min: i64, max: i64) -> HResult<i64> {
    match q.get(name) {
        None | Some("") => Ok(dflt),
        Some(v) => {
            let n = crate::util::js_number_int(v);
            match n {
                Some(n) if n.fract() == 0.0 && n.abs() <= 9007199254740991.0 && n >= min as f64 && n <= max as f64 => Ok(n as i64),
                _ => fail("bad-argument", &format!("{name} must be an integer from {min} to {max}")),
            }
        }
    }
}
