//! Live delivery: server-sent events on `GET /v2/stream` (spec/hub-api.md). A stream first catches up from the
//! change number the device names, then gets every event it may see as it happens. Each stream has a bounded
//! queue: a reader that does not keep up is cut and resumes by change number.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use serde_json::Value;
use tokio::sync::mpsc;

use crate::observer::Device;
use crate::store::{Audience, Auth, Event, Room, Who};

pub enum Msg {
    Chunk(Bytes),
    End,
}

enum Phase {
    /// catching up from the database: live events wait here, with their change number
    CatchingUp(Vec<(Option<i64>, Bytes)>),
    /// live; the highest change number sent so far: an event at or below it was sent by the catch-up
    Live(i64),
}

pub struct Stream {
    pub id: u64,
    pub auth: Auth,
    /// an agent device's: the lease generation it was opened under (13.7)
    pub generation: Option<u64>,
    tx: mpsc::UnboundedSender<Msg>,
    pub queued: Arc<AtomicUsize>,
    phase: Mutex<Phase>,
    limit: usize,
    /// when the token it was opened with runs out: the stream ends then, and the device resumes with a new one
    pub expires_at: u64,
    ended: AtomicBool,
    /// set by `cut_now`: the body hands nothing on any more
    pub gone: Arc<AtomicBool>,
    /// cuts the connection under the stream: a reader that stalls never reads the end of its stream
    cut: Option<crate::http::Conn>,
}

impl Stream {
    /// Over its buffer: the stream is over for good. Nothing more is queued for it, what waited is dropped, and
    /// its connection is cut.
    fn overflow(&self) {
        if !self.ended.swap(true, Ordering::Relaxed) {
            let closed = self.tx.send(Msg::End).is_err();
            // (a stream whose body is gone holds no connection any more)
            if let (Some(conn), false) = (&self.cut, closed) {
                conn.destroy();
            }
        }
    }

    /// Queues bytes for the client. `false`: the stream is over.
    fn push(&self, chunk: Bytes) -> bool {
        if self.ended.load(Ordering::Relaxed) {
            return false;
        }
        // nothing is sent on a stream whose token has run out
        if crate::util::now() >= self.expires_at {
            // (not `expire`: the caller may hold the stream's phase)
            self.overflow();
            return false;
        }
        if self.queued.fetch_add(chunk.len(), Ordering::Relaxed) + chunk.len() > self.limit {
            self.overflow();
            return false;
        }
        self.tx.send(Msg::Chunk(chunk)).is_ok()
    }

    /// One event of the catch-up, straight to the client.
    pub fn send_now(&self, chunk: Bytes) -> bool {
        self.push(chunk)
    }

    fn deliver(&self, change: Option<i64>, chunk: Bytes) -> bool {
        if self.ended.load(Ordering::Relaxed) {
            return false;
        }
        let mut phase = self.phase.lock().unwrap_or_else(|e| e.into_inner());
        match &mut *phase {
            Phase::CatchingUp(pending) => {
                let held: usize = pending.iter().map(|(_, c)| c.len()).sum();
                if held + chunk.len() > self.limit {
                    pending.clear();
                    drop(phase);
                    self.overflow();
                    return false;
                }
                pending.push((change, chunk));
                true
            }
            Phase::Live(sent) => {
                if let Some(c) = change {
                    if c <= *sent {
                        return true;
                    }
                    *sent = c;
                }
                self.push(chunk)
            }
        }
    }

    /// The catch-up reached `sent`: what arrived meanwhile and lies above it follows, then the stream is live.
    pub fn go_live(&self, sent: i64) {
        let mut phase = self.phase.lock().unwrap_or_else(|e| e.into_inner());
        let mut high = sent;
        if let Phase::CatchingUp(pending) = std::mem::replace(&mut *phase, Phase::Live(sent)) {
            for (change, chunk) in pending {
                if change.is_none_or(|c| c > high) {
                    high = change.unwrap_or(high);
                    self.push(chunk);
                }
            }
        }
        *phase = Phase::Live(high);
    }

    /// The token the stream was opened with has run out: it is over at once. What waited to be sent is not
    /// sent; the connection is cut. The device resumes with a new token by change number.
    pub fn expire(&self) {
        if let Phase::CatchingUp(pending) =
            &mut *self.phase.lock().unwrap_or_else(|e| e.into_inner())
        {
            pending.clear();
        }
        self.overflow();
        // a stream that had ended already (its reader stalled before the end) still holds a connection: cut
        // whatever happened before; what was queued is dropped by the body, which knows the time
        // (a stream whose body is gone holds no connection any more: that connection may serve someone else)
        if let (Some(conn), false) = (&self.cut, self.tx.is_closed()) {
            conn.destroy();
        }
    }

    /// Over at once, like `expire`, and whatever the body still holds is dropped (it reads `gone`).
    pub fn cut_now(&self) {
        self.gone.store(true, Ordering::SeqCst);
        self.expire();
    }

    pub fn end(&self) {
        if !self.ended.swap(true, Ordering::Relaxed) {
            let _ = self.tx.send(Msg::End);
        }
    }

    pub fn is_closed(&self) -> bool {
        self.ended.load(Ordering::Relaxed) || self.tx.is_closed()
    }
}

/// One event in the wire form of server-sent events.
pub fn sse(name: &str, id: Option<i64>, data: &Value) -> Bytes {
    let mut s = String::new();
    if let Some(id) = id {
        s.push_str(&format!("id: {id}\n"));
    }
    s.push_str(&format!("event: {name}\ndata: {data}\n\n"));
    Bytes::from(s)
}

/// Why a stream is not opened.
#[derive(Debug, PartialEq, Eq)]
pub enum Refused {
    /// the device has its limit of streams open
    TooMany,
    /// a stream of a later lease generation of the device is open: this process no longer holds the lease
    LeaseLost,
}

#[derive(Default)]
pub struct Live {
    rooms: Mutex<HashMap<Room, Vec<Arc<Stream>>>>,
    next: AtomicU64,
}

impl Live {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<Room, Vec<Arc<Stream>>>> {
        self.rooms.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// A new stream of a device, in its catch-up phase. With `replace` it ends the device's older streams at
    /// once (their connections are cut and their places freed): a device holds one stream, and one whose old
    /// stream was never closed by its client (a page reloaded under a service worker keeps it) is not locked out
    /// by them. An agent device's stream carries the lease `generation` it was opened under: it replaces only
    /// streams of the same or an earlier generation (or none), and a stream of a later one being open means this
    /// process lost the lease, whenever its own check of the lease ran (`LeaseLost`, nothing cut). `TooMany`: the
    /// device has its limit of streams open (only without `replace`).
    #[allow(clippy::too_many_arguments)]
    pub fn open(
        &self,
        auth: Auth,
        replace: bool,
        generation: Option<u64>,
        per_device: usize,
        buffer: usize,
        expires_at: u64,
        cut: Option<crate::http::Conn>,
    ) -> Result<(Arc<Stream>, mpsc::UnboundedReceiver<Msg>), Refused> {
        let mut rooms = self.lock();
        let list = rooms.entry(auth.room).or_default();
        list.retain(|s| !s.is_closed());
        let own = |s: &&Arc<Stream>| s.auth.device == auth.device;
        if let Some(g) = generation {
            if list
                .iter()
                .filter(own)
                .any(|s| s.generation.is_some_and(|other| other > g))
            {
                return Err(Refused::LeaseLost);
            }
        }
        if replace {
            for older in list.iter().filter(own) {
                if generation.is_none() || older.generation.is_none_or(|o| Some(o) <= generation) {
                    older.cut_now();
                }
            }
        }
        list.retain(|s| !s.is_closed());
        if list.iter().filter(own).count() >= per_device {
            return Err(Refused::TooMany);
        }
        let (tx, rx) = mpsc::unbounded_channel();
        let stream = Arc::new(Stream {
            id: self.next.fetch_add(1, Ordering::Relaxed),
            auth,
            generation,
            tx,
            queued: Arc::new(AtomicUsize::new(0)),
            phase: Mutex::new(Phase::CatchingUp(Vec::new())),
            limit: buffer,
            expires_at,
            ended: AtomicBool::new(false),
            gone: Arc::new(AtomicBool::new(false)),
            cut,
        });
        list.push(stream.clone());
        Ok((stream, rx))
    }

    pub fn close(&self, room: &Room, id: u64) {
        let mut rooms = self.lock();
        if let Some(list) = rooms.get_mut(room) {
            list.retain(|s| s.id != id);
            if list.is_empty() {
                rooms.remove(room);
            }
        }
    }

    fn matching(&self, room: &Room, audience: &Audience) -> Vec<Arc<Stream>> {
        let rooms = self.lock();
        let Some(list) = rooms.get(room) else {
            return vec![];
        };
        list.iter()
            .filter(|s| audience.except != Some(s.auth.device))
            .filter(|s| match s.auth.who {
                Who::Human => audience.humans,
                Who::Agent | Who::Helper => audience.others.contains(&s.auth.device),
                // the recovery key reads by request, it follows nothing live
                Who::Recovery | Who::Spent => false,
            })
            .cloned()
            .collect()
    }

    /// Whether anyone would get this event: saves loading what it carries.
    pub fn has_audience(&self, ev: &Event) -> bool {
        !self.matching(&ev.room, &ev.audience).is_empty()
    }

    pub fn publish(&self, ev: &Event, data: &Value) {
        let chunk = sse(ev.name, ev.change, data);
        for s in self.matching(&ev.room, &ev.audience) {
            s.deliver(ev.change, chunk.clone());
        }
    }

    /// Ends every stream of a device (14.4), or of every asker of a room for which `which` holds.
    /// Ends streams at once: what waited to be sent is not sent, and the connection is cut.
    pub fn cut_where(&self, room: &Room, which: impl Fn(&Auth) -> bool) {
        let rooms = self.lock();
        if let Some(list) = rooms.get(room) {
            for s in list.iter().filter(|s| which(&s.auth)) {
                s.cut_now();
            }
        }
    }

    pub fn end_where(&self, room: &Room, which: impl Fn(&Auth) -> bool) {
        let rooms = self.lock();
        if let Some(list) = rooms.get(room) {
            for s in list.iter().filter(|s| which(&s.auth)) {
                s.end();
            }
        }
    }

    pub fn end_all(&self) {
        for list in self.lock().values() {
            for s in list {
                s.end();
            }
        }
    }

    /// The keep-alive of every stream; and the end of those whose token ran out or that are over.
    pub fn ping(&self, now: u64) {
        let chunk = Bytes::from_static(b"event: ping\ndata: {}\n\n");
        for list in self.lock().values_mut() {
            for s in list.iter() {
                if s.expires_at <= now {
                    s.expire();
                } else {
                    s.deliver(None, chunk.clone());
                }
            }
            list.retain(|s| !s.is_closed());
        }
    }

    pub fn online(&self, room: &Room, device: &Device) -> bool {
        self.lock()
            .get(room)
            .is_some_and(|l| l.iter().any(|s| &s.auth.device == device && !s.is_closed()))
    }

    pub fn count(&self) -> usize {
        self.lock().values().map(|l| l.len()).sum()
    }
}
