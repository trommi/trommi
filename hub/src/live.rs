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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn auth(device: u8, who: Who) -> Auth {
        Auth {
            room: [1; 32],
            device: [device; 32],
            who,
        }
    }

    fn drain(rx: &mut mpsc::UnboundedReceiver<Msg>) -> Vec<String> {
        let mut out = vec![];
        while let Ok(m) = rx.try_recv() {
            match m {
                Msg::Chunk(b) => out.push(String::from_utf8(b.to_vec()).unwrap()),
                Msg::End => out.push("END".into()),
            }
        }
        out
    }

    fn event(
        change: Option<i64>,
        humans: bool,
        others: Vec<Device>,
        except: Option<Device>,
    ) -> Event {
        Event {
            room: [1; 32],
            audience: Audience {
                humans,
                others,
                except,
            },
            name: "envelope",
            change,
            data: json!({}),
        }
    }

    #[test]
    fn events_reach_only_their_audience() {
        let live = Live::default();
        let (h, mut hrx) = live.open(auth(1, Who::Human), 8, 1 << 20).unwrap();
        let (a, mut arx) = live.open(auth(2, Who::Agent), 8, 1 << 20).unwrap();
        let (r, mut rrx) = live.open(auth(3, Who::Recovery), 8, 1 << 20).unwrap();
        for s in [&h, &a, &r] {
            s.go_live(0);
        }
        let e1 = event(Some(5), true, vec![], None);
        live.publish(&e1, &json!({ "n": 1 }));
        let e2 = event(Some(6), true, vec![[2; 32]], Some([1; 32]));
        live.publish(&e2, &json!({ "n": 2 }));
        assert_eq!(
            drain(&mut hrx),
            vec!["id: 5\nevent: envelope\ndata: {\"n\":1}\n\n"]
        );
        assert_eq!(
            drain(&mut arx),
            vec!["id: 6\nevent: envelope\ndata: {\"n\":2}\n\n"]
        );
        assert!(drain(&mut rrx).is_empty());
        // another room hears nothing
        let other = Event {
            room: [9; 32],
            ..e1
        };
        assert!(!live.has_audience(&other));
    }

    #[test]
    fn what_arrives_during_the_catch_up_follows_it_once() {
        let live = Live::default();
        let (s, mut rx) = live.open(auth(1, Who::Human), 8, 1 << 20).unwrap();
        live.publish(&event(Some(7), true, vec![], None), &json!({ "n": 7 }));
        live.publish(&event(Some(9), true, vec![], None), &json!({ "n": 9 }));
        live.publish(&event(None, true, vec![], None), &json!({ "relay": true }));
        assert!(drain(&mut rx).is_empty());
        // the catch-up itself sent everything up to 8
        s.go_live(8);
        let got = drain(&mut rx);
        assert_eq!(got.len(), 2);
        assert!(got[0].contains("\"n\":9") && got[1].contains("relay"));
    }

    #[test]
    fn a_device_has_a_limit_of_streams_and_a_slow_reader_is_cut() {
        let live = Live::default();
        let mut keep = vec![];
        for _ in 0..2 {
            keep.push(live.open(auth(1, Who::Human), 2, 64).unwrap());
        }
        assert!(live.open(auth(1, Who::Human), 2, 64).is_none());
        assert!(live.open(auth(2, Who::Human), 2, 64).is_some());
        let (s, rx) = &mut keep[0];
        s.go_live(0);
        live.publish(
            &event(Some(1), true, vec![], None),
            &json!({ "pad": "x".repeat(100) }),
        );
        assert_eq!(drain(rx), vec!["END"]);
        live.end_where(&[1; 32], |a| a.device == [1; 32]);
        // the second stream was still catching up: it overflowed its waiting room, and is ended again by name
        assert!(drain(&mut keep[1].1).iter().all(|m| m == "END"));
    }
}
