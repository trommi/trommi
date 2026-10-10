//! HTTP plumbing on hyper, no framework: the response body type, reading a request body within a size and a time,
//! and draining what a refused request did not read.

use std::any::Any;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use bytes::Bytes;
use http_body_util::BodyExt;
use hyper::body::{Body as HttpBody, Frame, Incoming};
use hyper::header::{HeaderMap, HeaderValue};
use hyper::{Response, StatusCode};
use serde_json::Value;
use tokio::sync::{mpsc, Notify};

use crate::error::{refuse, Refused, Res};
use crate::live::Msg;

/// One connection: its peer and a switch that cuts it.
#[derive(Clone)]
pub struct Conn {
    pub peer: SocketAddr,
    /// wakes the connection's task to look whether it is to be cut
    pub cut: Arc<Notify>,
    /// the number of the request the connection serves now (HTTP/1: one after another)
    pub serving: Arc<std::sync::atomic::AtomicU64>,
    /// the highest request number whose answer asked for the cut
    pub cut_for: Arc<std::sync::atomic::AtomicU64>,
    /// this request's number
    pub request: u64,
}

impl Conn {
    pub fn new(peer: SocketAddr) -> Self {
        Conn {
            peer,
            cut: Arc::new(Notify::new()),
            serving: Default::default(),
            cut_for: Default::default(),
            request: 0,
        }
    }

    /// The same connection, serving its next request.
    pub fn next_request(&self) -> Self {
        let request = self.serving.fetch_add(1, Ordering::SeqCst) + 1;
        Conn {
            request,
            ..self.clone()
        }
    }

    /// Cuts the connection under this request's answer. A connection that has gone on to a later request is
    /// left alone: the cut is this answer's, not the next one's.
    pub fn destroy(&self) {
        self.cut_for.fetch_max(self.request, Ordering::SeqCst);
        self.cut.notify_one();
    }

    /// Asked by the connection's task when it is woken: is the request it serves now the one to be cut?
    pub fn is_cut(&self) -> bool {
        self.cut_for.load(Ordering::SeqCst) == self.serving.load(Ordering::SeqCst)
    }
}

/// A response body: bytes in hand, or chunks from a channel (a stream of events, a file). Guards are dropped
/// when the body is: they count requests in flight and close streams.
pub struct Body {
    kind: Kind,
    _guards: Vec<Box<dyn Any + Send + Sync>>,
}

enum Kind {
    Full(Option<Bytes>),
    Channel {
        rx: mpsc::UnboundedReceiver<Msg>,
        queued: Option<Arc<AtomicUsize>>,
        /// nothing is handed on from then on: the token the stream was opened with has run out
        until: u64,
        /// or was signed out
        gone: Arc<std::sync::atomic::AtomicBool>,
    },
    Bounded(mpsc::Receiver<std::io::Result<Bytes>>),
}

impl Body {
    pub fn full(bytes: impl Into<Bytes>) -> Self {
        Body {
            kind: Kind::Full(Some(bytes.into())),
            _guards: vec![],
        }
    }
    pub fn empty() -> Self {
        Body {
            kind: Kind::Full(None),
            _guards: vec![],
        }
    }
    pub fn events(
        rx: mpsc::UnboundedReceiver<Msg>,
        queued: Arc<AtomicUsize>,
        until: u64,
        gone: Arc<std::sync::atomic::AtomicBool>,
    ) -> Self {
        Body {
            kind: Kind::Channel {
                rx,
                queued: Some(queued),
                until,
                gone,
            },
            _guards: vec![],
        }
    }
    pub fn chunks(rx: mpsc::Receiver<std::io::Result<Bytes>>) -> Self {
        Body {
            kind: Kind::Bounded(rx),
            _guards: vec![],
        }
    }
    pub fn guard(mut self, g: impl Any + Send + Sync) -> Self {
        self._guards.push(Box::new(g));
        self
    }
}

impl HttpBody for Body {
    type Data = Bytes;
    type Error = std::io::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Self::Error>>> {
        match &mut self.kind {
            Kind::Full(bytes) => Poll::Ready(
                bytes
                    .take()
                    .filter(|b| !b.is_empty())
                    .map(|b| Ok(Frame::data(b))),
            ),
            Kind::Channel { until, gone, .. }
                if crate::util::now() >= *until || gone.load(Ordering::SeqCst) =>
            {
                Poll::Ready(None)
            }
            Kind::Channel { rx, queued, .. } => match rx.poll_recv(cx) {
                Poll::Ready(Some(Msg::Chunk(b))) => {
                    if let Some(q) = queued {
                        q.fetch_sub(b.len().min(q.load(Ordering::Relaxed)), Ordering::Relaxed);
                    }
                    Poll::Ready(Some(Ok(Frame::data(b))))
                }
                Poll::Ready(Some(Msg::End)) | Poll::Ready(None) => Poll::Ready(None),
                Poll::Pending => Poll::Pending,
            },
            Kind::Bounded(rx) => match rx.poll_recv(cx) {
                Poll::Ready(Some(Ok(b))) => Poll::Ready(Some(Ok(Frame::data(b)))),
                Poll::Ready(Some(Err(e))) => Poll::Ready(Some(Err(e))),
                Poll::Ready(None) => Poll::Ready(None),
                Poll::Pending => Poll::Pending,
            },
        }
    }
}

pub type Answer = Response<Body>;

pub fn json(status: u16, value: &Value) -> Answer {
    json_text(status, value.to_string())
}

/// An answer whose JSON is already text.
pub fn json_text(status: u16, bytes: String) -> Answer {
    Response::builder()
        .status(StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR))
        .header("content-type", "application/json; charset=utf-8")
        .header("cache-control", "no-store")
        .header("content-length", bytes.len())
        .body(Body::full(bytes))
        .expect("a valid response")
}

pub fn refusal(r: &Refused) -> Answer {
    let mut answer = json(r.status(), &r.body());
    if let Some(seconds) = r.retry_after {
        answer
            .headers_mut()
            .insert("retry-after", HeaderValue::from(seconds));
    }
    answer
}

pub fn header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|v| v.to_str().ok())
}

/// A request body that is read to its end even when the handler answered without reading it. Without this a
/// refusal sent while the client is still sending ends in a connection reset instead of the status: the kernel
/// answers the unread bytes with a reset. The drain is bounded in time; past that the connection is cut.
pub struct ReqBody {
    inner: Option<Incoming>,
    conn: Conn,
    idle: Duration,
    within: Duration,
}

impl ReqBody {
    /// `within`: how long an unread rest may take to arrive before the connection is cut: a minute, and for a
    /// body of announced length the time that length needs at 16 KiB/s. A body without a length that a route
    /// refused gets the minute.
    pub fn new(inner: Incoming, conn: Conn, within: Duration) -> Self {
        ReqBody {
            inner: Some(inner),
            conn,
            idle: Duration::from_secs(30),
            within,
        }
    }

    pub async fn frame(&mut self) -> Option<Result<Frame<Bytes>, hyper::Error>> {
        let next = self.inner.as_mut()?.frame().await;
        if !matches!(next, Some(Ok(_))) {
            // the end or an error: nothing is left to drain
            self.inner = None;
        }
        next
    }

    /// The whole body, at most `limit` bytes, within `within`; a body that runs over the time cuts the connection.
    pub async fn read(&mut self, limit: usize, within: Duration) -> Res<Vec<u8>> {
        let conn = self.conn.clone();
        let all = async {
            let mut out = Vec::new();
            while let Some(frame) = self.frame().await {
                let frame =
                    frame.map_err(|_| refuse("bad-format", "the request body broke off"))?;
                if let Ok(data) = frame.into_data() {
                    if out.len() + data.len() > limit {
                        return Err(refuse("too-large", "the request body is too large"));
                    }
                    out.extend_from_slice(&data);
                }
            }
            Ok(out)
        };
        match tokio::time::timeout(within, all).await {
            Ok(r) => r,
            Err(_) => {
                conn.destroy();
                Err(refuse("bad-format", "the request body took too long"))
            }
        }
    }
}

impl Drop for ReqBody {
    fn drop(&mut self) {
        let Some(mut body) = self.inner.take() else {
            return;
        };
        if body.is_end_stream() {
            return;
        }
        let Ok(rt) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let (conn, idle, within) = (self.conn.clone(), self.idle, self.within);
        rt.spawn(async move {
            let rest = async {
                loop {
                    match tokio::time::timeout(idle, body.frame()).await {
                        Ok(Some(Ok(_))) => {}
                        Ok(Some(Err(_))) | Ok(None) => return true,
                        Err(_) => return false,
                    }
                }
            };
            if !matches!(tokio::time::timeout(within, rest).await, Ok(true)) {
                conn.destroy();
            }
        });
    }
}

/// `a=1&b=x` of a request target. Values are not percent-decoded: every parameter of this API is a number or
/// base64url.
pub fn query(q: Option<&str>) -> Vec<(String, String)> {
    q.unwrap_or("")
        .split('&')
        .filter(|p| !p.is_empty())
        .map(|p| match p.split_once('=') {
            Some((k, v)) => (k.to_string(), v.to_string()),
            None => (p.to_string(), String::new()),
        })
        .collect()
}

/// A single byte range of a file of `size` bytes: `bytes=a-b`, `bytes=a-`, `bytes=-n`. `Ok(None)`: no range
/// asked. `Err`: not satisfiable.
#[allow(clippy::result_unit_err)]
pub fn range(header: Option<&str>, size: u64) -> Result<Option<(u64, u64)>, ()> {
    let Some(h) = header else { return Ok(None) };
    let spec = h.strip_prefix("bytes=").ok_or(())?;
    if spec.contains(',') {
        return Err(());
    }
    let (a, b) = spec.split_once('-').ok_or(())?;
    let number = |s: &str| {
        if s.len() <= 19 && !s.is_empty() && s.bytes().all(|c| c.is_ascii_digit()) {
            s.parse::<u64>().map_err(|_| ())
        } else {
            Err(())
        }
    };
    let (start, end) = match (a.is_empty(), b.is_empty()) {
        (true, true) => return Err(()),
        (true, false) => {
            let n = number(b)?;
            if n == 0 {
                return Err(());
            }
            (size.saturating_sub(n), size.saturating_sub(1))
        }
        (false, true) => (number(a)?, size.saturating_sub(1)),
        (false, false) => (number(a)?, number(b)?.min(size.saturating_sub(1))),
    };
    if size == 0 || start >= size || start > end {
        return Err(());
    }
    Ok(Some((start, end)))
}
