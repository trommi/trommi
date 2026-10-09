//! Live delivery: server-sent events on `GET /v2/stream` (spec/hub-api.md). A stream first catches up from the
//! change number the device names, then gets every event it may see as it happens. Each stream has a bounded
//! queue: a reader that does not keep up is cut and resumes by change number.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
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
    Live,
}

pub struct Stream {
    pub id: u64,
    pub auth: Auth,
    tx: mpsc::UnboundedSender<Msg>,
    pub queued: Arc<AtomicUsize>,
    phase: Mutex<Phase>,
    limit: usize,
}

impl Stream {
    /// Queues bytes for the client. `false`: the stream is over its buffer and was ended.
    fn push(&self, chunk: Bytes) -> bool {
        if self.queued.fetch_add(chunk.len(), Ordering::Relaxed) + chunk.len() > self.limit {
            let _ = self.tx.send(Msg::End);
            return false;
        }
        self.tx.send(Msg::Chunk(chunk)).is_ok()
    }

    /// One event of the catch-up, straight to the client.
    pub fn send_now(&self, chunk: Bytes) -> bool {
        self.push(chunk)
    }

    fn deliver(&self, change: Option<i64>, chunk: Bytes) -> bool {
        let mut phase = self.phase.lock().unwrap_or_else(|e| e.into_inner());
        match &mut *phase {
            Phase::CatchingUp(pending) => {
                let held: usize = pending.iter().map(|(_, c)| c.len()).sum();
                if held + chunk.len() > self.limit {
                    let _ = self.tx.send(Msg::End);
                    return false;
                }
                pending.push((change, chunk));
                true
            }
            Phase::Live => self.push(chunk),
        }
    }

    /// The catch-up reached `sent`: what arrived meanwhile and lies above it follows, then the stream is live.
    pub fn go_live(&self, sent: i64) {
        let mut phase = self.phase.lock().unwrap_or_else(|e| e.into_inner());
        if let Phase::CatchingUp(pending) = std::mem::replace(&mut *phase, Phase::Live) {
            for (change, chunk) in pending {
                if change.is_none_or(|c| c > sent) {
                    self.push(chunk);
                }
            }
        }
    }

    pub fn end(&self) {
        let _ = self.tx.send(Msg::End);
    }

    pub fn is_closed(&self) -> bool {
        self.tx.is_closed()
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

#[derive(Default)]
pub struct Live {
    rooms: Mutex<HashMap<Room, Vec<Arc<Stream>>>>,
    next: AtomicU64,
}

impl Live {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<Room, Vec<Arc<Stream>>>> {
        self.rooms.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// A new stream of a device, in its catch-up phase. `None`: the device has its limit of streams open.
    pub fn open(
        &self,
        auth: Auth,
        per_device: usize,
        buffer: usize,
    ) -> Option<(Arc<Stream>, mpsc::UnboundedReceiver<Msg>)> {
        let mut rooms = self.lock();
        let list = rooms.entry(auth.room).or_default();
        list.retain(|s| !s.is_closed());
        if list.iter().filter(|s| s.auth.device == auth.device).count() >= per_device {
            return None;
        }
        let (tx, rx) = mpsc::unbounded_channel();
        let stream = Arc::new(Stream {
            id: self.next.fetch_add(1, Ordering::Relaxed),
            auth,
            tx,
            queued: Arc::new(AtomicUsize::new(0)),
            phase: Mutex::new(Phase::CatchingUp(Vec::new())),
            limit: buffer,
        });
        list.push(stream.clone());
        Some((stream, rx))
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

    pub fn ping(&self) {
        let chunk = Bytes::from_static(b"event: ping\ndata: {}\n\n");
        for list in self.lock().values() {
            for s in list {
                s.deliver(None, chunk.clone());
            }
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
