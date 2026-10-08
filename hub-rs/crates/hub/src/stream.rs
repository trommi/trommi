//! A live stream's send side (ops/flow.mjs): a bounded buffer per stream. What waits in it is what the client has not
//! read yet (Node's writableLength): over HUB_STREAM_BUFFER_BYTES the stream is dropped and resumes by cursor. While a
//! stream catches up, live chunks wait in `pending` and are sent after the catch-up, newer than what it sent.

use crate::http::Conn;
use bytes::Bytes;
use http_body::{Body as HttpBody, Frame};
use parking_lot::Mutex;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};
use tokio::sync::{mpsc, Notify};

pub enum Msg {
    Data(Bytes),
    End,
}
/// One chunk for the streams of a room: its text, and the envelope number it carries (resume rule).
#[derive(Clone)]
pub struct Chunk {
    pub text: Bytes,
    pub n: Option<i64>,
}

#[derive(Clone, Debug)]
pub struct Client {
    pub kind: String,
    pub version: String,
}

pub struct Stream {
    pub id: u64,
    pub room: String,
    pub device_id: String,
    pub lease_generation: Option<i64>,
    pub client: Option<Client>,
    tx: mpsc::UnboundedSender<Msg>,
    pub queued: AtomicUsize,
    pending: Mutex<Option<(Vec<Chunk>, usize)>>,
    pub ended: AtomicBool,
    pub destroyed: AtomicBool,
    pub drained: Notify,
    pub gone: Notify,
    conn: Conn,
    pub buffer_limit: usize,
    pub dropped: Arc<AtomicU64>,
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

impl Stream {
    pub fn new(room: &str, device_id: &str, lease_generation: Option<i64>, client: Option<Client>, conn: Conn, buffer_limit: usize, dropped: Arc<AtomicU64>) -> (Arc<Stream>, mpsc::UnboundedReceiver<Msg>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let s = Arc::new(Stream {
            id: NEXT_ID.fetch_add(1, Ordering::Relaxed),
            room: room.into(),
            device_id: device_id.into(),
            lease_generation,
            client,
            tx,
            queued: AtomicUsize::new(0),
            pending: Mutex::new(Some((vec![], 0))),
            ended: AtomicBool::new(false),
            destroyed: AtomicBool::new(false),
            drained: Notify::new(),
            gone: Notify::new(),
            conn,
            buffer_limit,
            dropped,
        });
        (s, rx)
    }
    /// writableEnded || destroyed
    pub fn over(&self) -> bool { self.ended.load(Ordering::Acquire) || self.destroyed.load(Ordering::Acquire) }
    pub fn catching_up(&self) -> bool { self.pending.lock().is_some() }
    pub fn pending_bytes(&self) -> usize { self.pending.lock().as_ref().map(|p| p.1).unwrap_or(0) }
    /// res.write
    pub fn write(&self, b: Bytes) {
        if self.over() {
            return;
        }
        self.queued.fetch_add(b.len(), Ordering::AcqRel);
        let _ = self.tx.send(Msg::Data(b));
    }
    /// res.end([text]): the queued bytes go out, then the answer ends.
    pub fn end(&self, last: Option<Bytes>) {
        if self.over() {
            return;
        }
        if let Some(b) = last {
            self.write(b);
        }
        self.ended.store(true, Ordering::Release);
        let _ = self.tx.send(Msg::End);
        self.gone.notify_waiters();
    }
    /// res.destroy(): the connection is cut at once.
    pub fn destroy(&self) {
        if self.destroyed.swap(true, Ordering::AcqRel) {
            return;
        }
        self.conn.destroy();
        self.gone.notify_waiters();
        self.drained.notify_waiters();
    }
    fn drop_for_buffer(&self) {
        self.dropped.fetch_add(1, Ordering::Relaxed);
        self.destroy();
    }
    /// flow.send: queued while catching up, written when live; over the buffer -> dropped.
    pub fn send(&self, c: &Chunk) {
        {
            let mut p = self.pending.lock();
            if let Some((list, bytes)) = p.as_mut() {
                list.push(c.clone());
                *bytes += c.text.len();
                if *bytes > self.buffer_limit {
                    drop(p);
                    self.drop_for_buffer();
                }
                return;
            }
        }
        self.write(c.text.clone());
        if self.queued.load(Ordering::Acquire) > self.buffer_limit {
            self.drop_for_buffer();
        }
    }
    /// The catch-up is done: what arrived meanwhile (newer than `sent`) goes out, then live.
    pub fn go_live(&self, sent: i64) {
        let mut p = self.pending.lock();
        if let Some((list, _)) = p.take() {
            for c in list {
                if c.n.is_none_or(|n| n > sent) {
                    self.write(c.text);
                }
            }
        }
    }
}

/// The SSE answer's body: reads the stream's queue; dropped (the client went, or the answer ended) -> `on_close`.
pub struct SseBody {
    rx: mpsc::UnboundedReceiver<Msg>,
    stream: Arc<Stream>,
    on_close: Option<Box<dyn FnOnce() + Send>>,
}
impl SseBody {
    pub fn new(rx: mpsc::UnboundedReceiver<Msg>, stream: Arc<Stream>, on_close: Box<dyn FnOnce() + Send>) -> SseBody { SseBody { rx, stream, on_close: Some(on_close) } }
}
impl HttpBody for SseBody {
    type Data = Bytes;
    type Error = std::io::Error;
    fn poll_frame(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Result<Frame<Bytes>, std::io::Error>>> {
        if self.stream.destroyed.load(Ordering::Acquire) {
            return Poll::Ready(Some(Err(std::io::Error::other("stream dropped"))));
        }
        match self.rx.poll_recv(cx) {
            Poll::Ready(Some(Msg::Data(b))) => {
                self.stream.queued.fetch_sub(b.len(), Ordering::AcqRel);
                self.stream.drained.notify_waiters();
                Poll::Ready(Some(Ok(Frame::data(b))))
            }
            Poll::Ready(Some(Msg::End)) | Poll::Ready(None) => Poll::Ready(None),
            Poll::Pending => Poll::Pending,
        }
    }
}
impl Drop for SseBody {
    fn drop(&mut self) {
        self.stream.ended.store(true, Ordering::Release);
        self.stream.gone.notify_waiters();
        self.stream.drained.notify_waiters();
        if let Some(f) = self.on_close.take() {
            f();
        }
    }
}
