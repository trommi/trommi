//! The hub as one value: its configuration, database, observer, streams, sign-in state and limits; and what
//! follows a committed transaction (live events, ended tokens and streams, pushes, deleted files).

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use rusqlite::params;
use serde_json::{json, Value};

use crate::accounts::Accounts;
use crate::config::Config;
use crate::db::Db;
use crate::delivery::Ctx;
use crate::error::{refuse, Refused, Res};
use crate::limits::{Buckets, Window};
use crate::live::Live;
use crate::observer::MlsObserver;
use crate::push::{self, Apns, ApnsRegistration, Text, Transport, Vapid, WebSubscription};
use crate::session::Sessions;
use crate::store::{self, Auth, Effects, Event, PushJob, Room, Who};
use crate::util::{self, b64, short};

pub struct Limits {
    pub envelopes: Buckets,
    pub pieces: Buckets,
    pub claims: Buckets,
    pub open_requests: Buckets,
    pub shares: Buckets,
    pub pushes: Buckets,
    pub requests: Buckets,
    pub foundings: Window,
    pub logins: Window,
    pub login_failures: Window,
}

pub struct App {
    pub cfg: Config,
    pub db: Db,
    pub obs: MlsObserver,
    pub live: Live,
    pub sessions: Sessions,
    pub accounts: Accounts,
    pub limits: Limits,
    pub files: PathBuf,
    pub transport: Arc<dyn Transport>,
    pub vapid: Vapid,
    pub apns: Option<Apns>,
    pub ticket_key: [u8; 32],
    pub closing: AtomicBool,
    pub in_flight: AtomicUsize,
    live_due: Mutex<HashSet<Room>>,
    /// per room: the bytes and the number of uploads in progress
    uploads: Mutex<HashMap<Room, (u64, usize)>>,
    lost_since: Mutex<HashMap<(Room, [u8; 32]), u64>>,
    pub started_at: u64,
}

/// A 32-byte secret of the hub's own, kept beside the database (mode 0600), made on first start.
fn own_secret(dir: &std::path::Path, name: &str) -> std::io::Result<[u8; 32]> {
    let path = dir.join(name);
    if let Ok(held) = std::fs::read(&path) {
        if let Ok(key) = <[u8; 32]>::try_from(&held[..]) {
            return Ok(key);
        }
    }
    let key = util::random::<32>();
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    std::io::Write::write_all(&mut options.open(&path)?, &key)?;
    Ok(key)
}

impl App {
    pub fn new(cfg: Config, transport: Arc<dyn Transport>) -> Result<Arc<App>, String> {
        if !crate::config::canonical_address(&cfg.url) {
            return Err(format!(
                "HUB_URL is not a canonical hub address: {}",
                cfg.url
            ));
        }
        std::fs::create_dir_all(&cfg.data).map_err(|e| format!("data directory: {e}"))?;
        let db = Db::open(&cfg.data.join("hub.db")).map_err(|e| format!("database: {e}"))?;
        let files = cfg.data.join("files");
        std::fs::create_dir_all(&files).map_err(|e| format!("files directory: {e}"))?;
        let vapid_secret =
            own_secret(&cfg.data, "vapid.key").map_err(|e| format!("vapid key: {e}"))?;
        let vapid =
            Vapid::from_secret(&vapid_secret, &cfg.push_subject).ok_or("vapid key unusable")?;
        let ticket_key =
            own_secret(&cfg.data, "push-ticket.key").map_err(|e| format!("ticket key: {e}"))?;
        let apns = match (&cfg.apns_key_pem, &cfg.apns_key_id, &cfg.apns_team_id) {
            (Some(pem), Some(id), Some(team)) => Apns::new(
                pem,
                id,
                team,
                cfg.apns_topics.clone(),
                cfg.apns_hosts.clone(),
            ),
            _ => None,
        };
        let mut origins = cfg.origins.clone();
        if origins.is_empty() {
            origins.push("https://app.trommi.com".to_string());
        }
        let limits = Limits {
            envelopes: Buckets::new(cfg.envelopes_per_second, cfg.envelope_burst),
            pieces: Buckets::new(cfg.pieces_per_second, cfg.pieces_per_second * 2.0),
            claims: Buckets::new(2.0, 200.0),
            open_requests: Buckets::new(
                cfg.open_requests_per_ip_minute / 60.0,
                cfg.open_requests_per_ip_minute,
            ),
            shares: Buckets::new(1.0, 60.0),
            pushes: Buckets::new(10.0 / 60.0, 10.0),
            requests: Buckets::new(0.2, 10.0),
            foundings: Window::new(cfg.foundings_per_ip_hour, 3_600_000),
            logins: Window::new(cfg.logins_per_ip_10min, 600_000),
            login_failures: Window::new(cfg.login_failures_per_email_hour, 3_600_000),
        };
        crate::log::set_quiet(cfg.quiet);
        Ok(Arc::new(App {
            accounts: Accounts::new(origins),
            cfg,
            db,
            obs: MlsObserver::default(),
            live: Live::default(),
            sessions: Sessions::default(),
            limits,
            files,
            transport,
            vapid,
            apns,
            ticket_key,
            closing: AtomicBool::new(false),
            in_flight: AtomicUsize::new(0),
            live_due: Mutex::new(HashSet::new()),
            uploads: Mutex::new(HashMap::new()),
            lost_since: Mutex::new(HashMap::new()),
            started_at: util::now(),
        }))
    }

    /// Reserves room for an upload of `bytes` in a room whose files hold `used`: refused when stored and
    /// arriving bytes together pass the quota, or when the room has 16 uploads in progress.
    pub fn reserve_upload(self: &Arc<Self>, room: &Room, bytes: u64, used: u64) -> Res<UploadSlot> {
        let mut uploads = self.uploads.lock().unwrap_or_else(|e| e.into_inner());
        let (arriving, count) = uploads.get(room).copied().unwrap_or((0, 0));
        if count >= 16 {
            return Err(
                refuse("too-many", "this room has its limit of uploads in progress").retry(5),
            );
        }
        if bytes > 0 && used + arriving + bytes > self.cfg.room_quota {
            return Err(crate::files::over_quota(
                used + arriving,
                self.cfg.room_quota,
            ));
        }
        uploads.insert(*room, (arriving + bytes, count + 1));
        Ok(UploadSlot {
            app: self.clone(),
            room: *room,
            bytes,
        })
    }

    /// One transaction of writes; what follows from it happens only if it was committed. Its live events are
    /// published before the next writer gets its turn: streams see changes in the order of their numbers.
    pub fn write<T>(self: &Arc<Self>, f: impl FnOnce(&Ctx, &mut Effects) -> Res<T>) -> Res<T> {
        let fx = std::cell::RefCell::new(Effects::default());
        let out = self.db.write_then(
            |c| {
                let x = Ctx {
                    c,
                    obs: &self.obs,
                    cfg: &self.cfg,
                    now: util::now(),
                };
                f(&x, &mut fx.borrow_mut())
            },
            |_| {
                let mut fx = fx.borrow_mut();
                self.cut_off(&fx);
                for ev in std::mem::take(&mut fx.events) {
                    self.publish(&ev);
                }
            },
        )?;
        self.after(fx.into_inner());
        Ok(out)
    }

    /// A write of a signed-in device in its room. Inside the transaction the device's standing is checked again
    /// (it may have been removed while the request waited for its turn); the write is refused while the room is
    /// in recovery (8.7: it takes nothing else for ten minutes), and for an agent device without its current
    /// lease (13.7).
    pub fn write_as<T>(
        self: &Arc<Self>,
        auth: &Auth,
        lease: Lease,
        f: impl FnOnce(&Ctx, &mut Effects) -> Res<T>,
    ) -> Res<T> {
        self.write(|x, fx| {
            still(x, auth)?;
            if crate::delivery::open_recovery_of(x.c, &auth.room, x.now)?.is_some() {
                return Err(refuse(
                    "overloaded",
                    "the room is being recovered: try again in a moment",
                )
                .retry(30));
            }
            if let (Who::Agent, Lease::Needed(given)) = (auth.who, lease) {
                check_lease(x, auth, given)?;
            }
            f(x, fx)
        })
    }

    /// A write under the recovery key (the routes of a recovery): its standing is checked again inside the
    /// transaction; the room's lock is its own.
    pub fn write_recovery<T>(
        self: &Arc<Self>,
        auth: &Auth,
        f: impl FnOnce(&Ctx, &mut Effects) -> Res<T>,
    ) -> Res<T> {
        self.write(|x, fx| {
            if auth.who != Who::Spent {
                still(x, auth)?;
            }
            f(x, fx)
        })
    }

    pub fn read<T>(&self, f: impl FnOnce(&Ctx) -> Res<T>) -> Res<T> {
        self.db.read(|c| {
            f(&Ctx {
                c,
                obs: &self.obs,
                cfg: &self.cfg,
                now: util::now(),
            })
        })
    }

    /// 14.4: a removal ends the removed device's streams at once, and a replaced recovery key's too. (Their
    /// tokens are refused from here on: every request checks the present standing.)
    fn cut_off(&self, fx: &Effects) {
        for (room, device) in &fx.recheck {
            let gone = self
                .db
                .read(|c| store::standing(c, room, device))
                .map(|s| s.is_none())
                .unwrap_or(false);
            if gone {
                self.live.end_where(room, |a| &a.device == device);
            }
        }
        for room in &fx.recovery_replaced {
            self.live.end_where(room, |a| a.who == Who::Recovery);
        }
    }

    /// What follows a committed transaction and needs no order: files, pushes, the Live Activity.
    pub fn after(self: &Arc<Self>, fx: Effects) {
        for ev in &fx.events {
            self.publish(ev);
        }
        for (room, file) in &fx.unlink {
            let _ = std::fs::remove_file(crate::files::path(&self.files, room, file));
        }
        for job in fx.pushes {
            let app = self.clone();
            spawn(async move { app.send_push(job).await });
        }
        for room in fx.live {
            self.live_soon(room);
        }
    }

    fn publish(&self, ev: &Event) {
        if !self.live.has_audience(ev) {
            return;
        }
        // an envelope event carries the envelope itself; a log event names group and n, the device fetches
        let data = match (ev.name, ev.change) {
            ("envelope", Some(change)) => match self
                .db
                .read(|c| crate::content::envelope_at(c, &ev.room, change, false))
            {
                Ok(Some(item)) => item,
                _ => return,
            },
            ("log", Some(change)) => match self
                .db
                .read(|c| crate::delivery::log_at(c, &ev.room, change))
            {
                Ok(Some(item)) => item,
                _ => return,
            },
            _ => ev.data.clone(),
        };
        self.live.publish(ev, &data);
    }

    // ---- push (15.1, 15.2)

    async fn send_push(self: Arc<Self>, job: PushJob) {
        let now = util::now();
        if let Some(sender) = &job.sender {
            // at most ten content pushes a minute from one device; the rest wait for the app to be opened
            if self
                .limits
                .pushes
                .take(&[&job.room[..], &sender[..]].concat(), 1.0, now)
                .is_err()
            {
                return;
            }
        }
        let lost = job.envelope.is_none();
        let rows: Vec<(i64, [u8; 32], String, String, Option<Vec<u8>>, Option<Vec<u8>>, Option<Vec<u8>>, Option<String>, Option<String>)> = self
            .db
            .read(|c| {
                let mut s = c.prepare_cached(
                    "SELECT p.id, p.device, p.kind, p.endpoint, p.p256dh, p.auth, p.apns_key, p.environment, p.topic FROM push_subscriptions p
                     JOIN devices d ON d.room_id = p.room_id AND d.device = p.device AND d.role = 'human' AND d.removed_epoch IS NULL
                     WHERE p.room_id = ?1 AND (p.level = 'all' OR ?2 >= 2 OR ?3 = 1)",
                )?;
                let rows = s
                    .query_map(params![&job.room[..], job.urgency, lost], |r| {
                        Ok((r.get(0)?, store::fixed::<32>(r.get(1)?)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok::<_, Refused>(rows)
            })
            .unwrap_or_default();
        for (id, device, kind, endpoint, p256dh, auth, apns_key, environment, topic) in rows {
            // 15.1: every human device except the sender
            if job.sender == Some(device) {
                continue;
            }
            let request = if kind == "web_push" {
                let sub = WebSubscription {
                    endpoint,
                    p256dh: p256dh.unwrap_or_default(),
                    auth: auth.unwrap_or_default(),
                };
                push::web_push_request(
                    &self.vapid,
                    &sub,
                    &self.cfg.push_hosts,
                    &job.room,
                    job.change,
                    job.urgency,
                    now,
                )
            } else {
                let text = match (lost, job.urgency >= 2) {
                    (true, _) => Text::AgentLost,
                    (false, true) => Text::Urgent,
                    (false, false) => Text::Question,
                };
                let ticket = (!lost)
                    .then(|| push::ticket(&self.ticket_key, &job.room, &device, job.change, now));
                match (
                    &self.apns,
                    apns_key.and_then(|k| <[u8; 32]>::try_from(k).ok()),
                    environment,
                    topic,
                ) {
                    (Some(apns), Some(key), Some(environment), Some(topic)) => apns.alert(
                        &ApnsRegistration {
                            token: endpoint,
                            key,
                            environment,
                            topic,
                        },
                        text,
                        &job.room,
                        job.change,
                        job.urgency,
                        ticket.as_deref(),
                        now,
                    ),
                    _ => None,
                }
            };
            let Some(request) = request else { continue };
            match self.transport.send(request).await {
                Ok((status, reason)) if push::gone(status, &reason) => {
                    let _ = self.db.write(|c| {
                        c.execute("DELETE FROM push_subscriptions WHERE id = ?1", [id])
                            .map(|_| ())
                            .map_err(Refused::from)
                    });
                }
                Ok((status, reason)) if status >= 400 => {
                    if status == 403 && reason == "ExpiredProviderToken" {
                        if let Some(apns) = &self.apns {
                            apns.forget_token();
                        }
                    }
                    crate::log::warn(
                        "push_refused",
                        json!({ "kind": kind, "status": status, "reason": reason }),
                    );
                }
                Ok(_) => {}
                Err(e) => crate::log::warn("push_failed", json!({ "kind": kind, "error": e })),
            }
        }
    }

    // ---- Live Activity (15.3)

    /// After a change, at most every `live_ms`: one round for the room.
    pub fn live_soon(self: &Arc<Self>, room: Room) {
        if self.apns.is_none()
            || !self
                .live_due
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(room)
        {
            return;
        }
        let app = self.clone();
        spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(app.cfg.live_ms)).await;
            app.live_due
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&room);
            app.live_round(room, false).await;
        });
    }

    /// The two counts Apple sees: agent devices whose link report says working, and open cards and permission
    /// requests.
    pub fn live_counts(&self, room: &Room) -> Res<(u64, u64)> {
        let now = util::now();
        self.db.read(|c| {
            let working: i64 = c
                .prepare_cached("SELECT count(*) FROM agent_leases WHERE room_id = ?1 AND working = 1 AND expires_at > ?2")?
                .query_row(params![&room[..], now as i64], |r| r.get(0))?;
            let waiting: i64 = c
                .prepare_cached(
                    "SELECT (SELECT count(*) FROM cards WHERE room_id = ?1 AND state = 1) + (SELECT count(*) FROM permission_requests WHERE room_id = ?1 AND state = 1)",
                )?
                .query_row([&room[..]], |r| r.get(0))?;
            Ok((working as u64, waiting as u64))
        })
    }

    pub async fn live_round(self: &Arc<Self>, room: Room, beat: bool) {
        let Some(apns) = &self.apns else { return };
        let Ok((working, waiting)) = self.live_counts(&room) else {
            return;
        };
        let now = util::now();
        type Row = (
            [u8; 32],
            String,
            String,
            String,
            Option<String>,
            Option<String>,
            Option<i64>,
            Option<i64>,
            Option<i64>,
            Option<i64>,
        );
        let rows: Vec<Row> = self
            .db
            .read(|c| {
                let mut s = c.prepare_cached(
                    "SELECT device, environment, topic, tag, start_token, activity_token, started_at, sent_working, sent_waiting, sent_at FROM live_activities WHERE room_id = ?1",
                )?;
                let rows = s
                    .query_map([&room[..]], |r| {
                        Ok((store::fixed::<32>(r.get(0)?)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok::<_, Refused>(rows)
            })
            .unwrap_or_default();
        for (
            device,
            environment,
            topic,
            tag,
            start_token,
            activity_token,
            started_at,
            sent_working,
            sent_waiting,
            sent_at,
        ) in rows
        {
            // start when work begins and none runs (again only after it ended or 8 hours); update when a count
            // changed or the beat is due; end when no agent works
            let running = started_at.is_some_and(|t| now.saturating_sub(t as u64) < 8 * 3_600_000);
            let changed =
                sent_working != Some(working as i64) || sent_waiting != Some(waiting as i64);
            let beat_due = beat
                && sent_at
                    .is_none_or(|t| now.saturating_sub(t as u64) * 10 >= self.cfg.live_beat_ms * 9);
            let (event, token) = if working > 0 && !running {
                ("start", start_token)
            } else if running && working == 0 {
                ("end", activity_token)
            } else if running && (changed || beat_due) {
                ("update", activity_token)
            } else {
                continue;
            };
            let started = match event {
                "start" => Some(now as i64),
                "end" => None,
                _ => started_at,
            };
            let mut dead = false;
            let mut delivered = token.is_none() && event != "start";
            if let Some(token) = &token {
                if let Some(request) = apns.live_activity(
                    &environment,
                    token,
                    &topic,
                    &tag,
                    event,
                    working,
                    waiting,
                    self.cfg.live_beat_ms,
                    now,
                ) {
                    if let Ok((status, reason)) = self.transport.send(request).await {
                        dead = push::gone(status, &reason);
                        delivered = status < 300;
                    }
                }
            }
            // what was not delivered is not recorded as sent: the next round tries again (a start without a
            // token to start with never counts as started)
            if !delivered && !dead {
                continue;
            }
            let column = if event == "start" {
                "start_token"
            } else {
                "activity_token"
            };
            let _ = self.db.write(|c| {
                c.execute(
                    "UPDATE live_activities SET started_at = ?1, sent_working = ?2, sent_waiting = ?3, sent_at = ?4 WHERE room_id = ?5 AND device = ?6",
                    params![if delivered { started } else { started_at }, working as i64, waiting as i64, now as i64, &room[..], &device[..]],
                )?;
                if dead {
                    c.execute(&format!("UPDATE live_activities SET {column} = NULL WHERE room_id = ?1 AND device = ?2"), params![&room[..], &device[..]])?;
                }
                Ok::<_, Refused>(())
            });
        }
    }

    /// Every ten minutes while one runs: the same counts again, so that the activity does not go stale.
    pub async fn live_beat(self: &Arc<Self>) {
        let rooms: Vec<Room> = self
            .db
            .read(|c| {
                let mut s = c.prepare_cached(
                    "SELECT DISTINCT room_id FROM live_activities WHERE started_at IS NOT NULL",
                )?;
                let rows = s
                    .query_map([], |r| store::fixed::<32>(r.get(0)?))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok::<_, Refused>(rows)
            })
            .unwrap_or_default();
        for room in rooms {
            self.live_round(room, true).await;
        }
    }

    // ---- presence

    pub fn presence(self: &Arc<Self>, room: &Room, device: &[u8; 32], data: Value) {
        self.publish(&Event {
            room: *room,
            audience: store::Audience {
                humans: true,
                others: vec![],
                except: None,
            },
            name: "presence",
            change: None,
            data,
        });
        let _ = device;
    }

    /// An agent device's last stream closed: if it stays away for `loss_ms` and its lease ran out, the human
    /// devices are told ("An agent lost its connection.").
    pub fn stream_closed(self: &Arc<Self>, auth: Auth) {
        if self.closing.load(Ordering::Relaxed) {
            return;
        }
        let online = self.live.online(&auth.room, &auth.device);
        self.presence(
            &auth.room,
            &auth.device,
            json!({ "device": b64(&auth.device), "online": online }),
        );
        if auth.who != Who::Agent || online {
            return;
        }
        let since = util::now();
        self.lost_since
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert((auth.room, auth.device), since);
        let app = self.clone();
        spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(app.cfg.loss_ms)).await;
            let still = app
                .lost_since
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(&(auth.room, auth.device))
                == Some(&since);
            if !still
                || app.live.online(&auth.room, &auth.device)
                || app.closing.load(Ordering::Relaxed)
            {
                return;
            }
            app.lost_since
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&(auth.room, auth.device));
            let leased = app
                .db
                .read(|c| {
                    Ok::<_, Refused>(c.prepare_cached("SELECT 1 FROM agent_leases WHERE room_id = ?1 AND device = ?2 AND expires_at > ?3")?.exists(params![
                        &auth.room[..],
                        &auth.device[..],
                        util::now() as i64
                    ])?)
                })
                .unwrap_or(true);
            let standing = app
                .db
                .read(|c| store::standing(c, &auth.room, &auth.device))
                .ok()
                .flatten();
            if leased || standing != Some(Who::Agent) {
                return;
            }
            crate::log::info(
                "agent_lost",
                json!({ "room": short(&auth.room), "device": short(&auth.device) }),
            );
            let change = app
                .db
                .read(|c| store::room_row(c, &auth.room))
                .map(|r| r.change)
                .unwrap_or(0);
            app.clone()
                .send_push(PushJob {
                    room: auth.room,
                    sender: None,
                    change,
                    urgency: 2,
                    envelope: None,
                })
                .await;
            app.live_soon(auth.room);
        });
    }

    pub fn stream_opened(self: &Arc<Self>, auth: &Auth) {
        self.lost_since
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&(auth.room, auth.device));
        self.presence(
            &auth.room,
            &auth.device,
            json!({ "device": b64(&auth.device), "online": true }),
        );
    }

    // ---- jobs

    /// 9.4: prunes what is due. Returns how many objects were pruned.
    pub fn retention(self: &Arc<Self>) -> usize {
        let mut total = 0;
        loop {
            let mut fx = Effects::default();
            let n = crate::content::prune_due(
                &self.db,
                util::now(),
                self.cfg.retention_days,
                200,
                &mut fx,
            )
            .unwrap_or(0);
            self.after(fx);
            total += n;
            if n == 0 {
                break;
            }
        }
        let messages = self.sweep_messages().unwrap_or(0);
        if total > 0 || messages > 0 {
            crate::log::info(
                "retention",
                json!({ "objects_pruned": total, "messages_deleted": messages }),
            );
        }
        total
    }

    /// Application messages (work trail, key handovers already read) are kept 30 days; Commits stay.
    fn sweep_messages(&self) -> Res<usize> {
        let cutoff = util::now().saturating_sub(self.cfg.retention_days * 86_400_000) as i64;
        let mut total = 0;
        loop {
            let n = self.db.write(|c| {
                Ok::<_, Refused>(c.execute(
                    "DELETE FROM group_log WHERE (group_id, n) IN (SELECT group_id, n FROM group_log WHERE kind = 'message' AND at <= ?1 LIMIT 2000)",
                    [cutoff],
                )?)
            })?;
            total += n;
            if n < 2000 {
                return Ok(total);
            }
        }
    }

    /// The small sweeps: uploads nobody named, expired shares, invites, requests, leases, old welcomes of removed
    /// devices, rate-limit state.
    pub fn sweep(self: &Arc<Self>) {
        let now = util::now();
        let mut fx = Effects::default();
        let files = crate::files::sweep_pending(&self.db, now, &mut fx).unwrap_or(0);
        self.after(fx);
        let parts = crate::files::sweep_parts(&self.files);
        let _ = self.db.write(|c| {
            c.execute("DELETE FROM shares WHERE expires_at <= ?1", [now as i64])?;
            c.execute(
                "DELETE FROM invites WHERE expires_at <= ?1",
                [now.saturating_sub(86_400_000) as i64],
            )?;
            c.execute(
                "DELETE FROM requests WHERE at <= ?1",
                [now.saturating_sub(7 * 86_400_000) as i64],
            )?;
            c.execute(
                "DELETE FROM recoveries WHERE expires_at <= ?1",
                [now.saturating_sub(86_400_000) as i64],
            )?;
            c.execute(
                "DELETE FROM key_packages WHERE expires_at <= ?1",
                [now as i64],
            )?;
            Ok::<_, Refused>(())
        });
        self.limits.envelopes.sweep(now);
        self.limits.pieces.sweep(now);
        self.limits.claims.sweep(now);
        self.limits.open_requests.sweep(now);
        self.limits.shares.sweep(now);
        self.limits.pushes.sweep(now);
        self.limits.foundings.sweep(now);
        self.limits.logins.sweep(now);
        self.limits.login_failures.sweep(now);
        if files > 0 || parts > 0 {
            crate::log::info(
                "sweep",
                json!({ "pending_files_deleted": files, "stale_parts_removed": parts }),
            );
        }
    }
}

/// The room for one upload in progress; given back when dropped.
pub struct UploadSlot {
    app: Arc<App>,
    room: Room,
    bytes: u64,
}

impl Drop for UploadSlot {
    fn drop(&mut self) {
        let mut uploads = self.app.uploads.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((arriving, count)) = uploads.get(&self.room).copied() {
            if count <= 1 {
                uploads.remove(&self.room);
            } else {
                uploads.insert(self.room, (arriving.saturating_sub(self.bytes), count - 1));
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lease {
    /// a write that an agent device makes under its lease: the generation its `Trommi-Lease` header carried
    Needed(Option<u64>),
    NotNeeded,
}

/// The asker still has the standing its token was checked with: asked again inside the write's transaction.
pub fn still(x: &Ctx, auth: &Auth) -> Res<()> {
    if store::standing(x.c, &auth.room, &auth.device)? == Some(auth.who) {
        Ok(())
    } else {
        Err(refuse("not-member", "this device is no longer in the room"))
    }
}

/// 13.7: every write of an agent device carries its lease's generation; an older one is refused.
fn check_lease(x: &Ctx, auth: &Auth, given: Option<u64>) -> Res<()> {
    let held: Option<(i64, i64)> = {
        use rusqlite::OptionalExtension;
        x.c.prepare_cached(
            "SELECT generation, expires_at FROM agent_leases WHERE room_id = ?1 AND device = ?2",
        )?
        .query_row(params![&auth.room[..], &auth.device[..]], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .optional()?
    };
    match (held, given) {
        (Some((generation, expires)), Some(g))
            if generation as u64 == g && expires as u64 > x.now =>
        {
            Ok(())
        }
        _ => Err(refuse(
            "lease-lost",
            "this process does not hold the device's lease",
        )),
    }
}

/// `POST /v2/link` (13.7): a new process id acquires the lease with a generation one above the last, valid 60 s;
/// the same process renews it and keeps its generation; a renewal under an older generation fails.
pub fn link(x: &Ctx, auth: &Auth, v: &Value) -> Res<Value> {
    if auth.who != Who::Agent {
        return Err(refuse("forbidden", "an agent device holds a lease"));
    }
    use rusqlite::OptionalExtension;
    let process = v["process"]
        .as_str()
        .and_then(util::unb64)
        .filter(|p| p.len() == 16)
        .ok_or_else(|| refuse("bad-format", "process: 16 random bytes"))?;
    let held: Option<(Vec<u8>, i64)> =
        x.c.prepare_cached(
            "SELECT process, generation FROM agent_leases WHERE room_id = ?1 AND device = ?2",
        )?
        .query_row(params![&auth.room[..], &auth.device[..]], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .optional()?;
    let generation = match (&held, v["generation"].as_u64()) {
        // a renewal: the same process under its own generation
        (Some((p, g)), Some(given)) if util::same(p, &process) && *g as u64 == given => *g,
        (_, Some(_)) => {
            return Err(refuse(
                "lease-lost",
                "another process took this device's lease",
            ))
        }
        // acquiring: of two processes on one state the later wins
        (Some((_, g)), None) => g + 1,
        (None, None) => 1,
    };
    let expires = x.now + 60_000;
    x.c.prepare_cached(
        "INSERT INTO agent_leases (room_id, device, process, generation, expires_at, hears, working, last_call_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT (room_id, device) DO UPDATE SET process = excluded.process, generation = excluded.generation, expires_at = excluded.expires_at,
           hears = excluded.hears, working = excluded.working, last_call_at = excluded.last_call_at",
    )?
    .execute(params![
        &auth.room[..],
        &auth.device[..],
        process,
        generation,
        expires as i64,
        v["hears"].as_bool().unwrap_or(false),
        v["working"].as_bool().unwrap_or(false),
        v["last_call_at"].as_i64().unwrap_or(0).max(0)
    ])?;
    Ok(json!({ "generation": generation, "expires_at": expires }))
}

/// Runs a future on the runtime if there is one (there is none in a plain unit test).
pub fn spawn(f: impl std::future::Future<Output = ()> + Send + 'static) {
    if let Ok(rt) = tokio::runtime::Handle::try_current() {
        rt.spawn(f);
    }
}
