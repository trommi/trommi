//! What the hub is doing (hub/ops/metrics.mjs): Prometheus text and a ring buffer of the last hour in 10 s samples,
//! folded every minute into <HUB_DATA>/metrics.db (the same table as the Node hub), served only on METRICS_PORT.
//! Node's heap, event-loop and GC figures have no Rust counterpart: their sample fields are 0 and their Prometheus
//! series are replaced by process_* ones (README of hub-rs).

use crate::config::Config;
use parking_lot::Mutex;
use rusqlite::{params, Connection};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

const BUCKETS_MS: [f64; 12] = [1.0, 2.0, 5.0, 10.0, 25.0, 50.0, 100.0, 250.0, 500.0, 1000.0, 2500.0, 10000.0];
const ROUTES: [&str; 16] = ["challenge", "access_tokens", "members", "devices", "sealed_room_keys", "key_back_links", "invites", "envelopes", "threads", "stream", "agent_lease", "agent_sessions", "sessions", "attachments", "push_subscriptions", "usage"];
const SAMPLES: usize = 360;
const MINUTE: i64 = 60000;
const KEEP_MS: i64 = 7 * 24 * 3600000;
pub const SERIES_COLUMNS: [&str; 11] = ["cpu_percent", "mem_used_percent", "disk_free_bytes", "disk_total_bytes", "open_streams", "envelopes_per_minute", "requests_per_second", "request_ms_p95", "sqlite_bytes", "wal_bytes", "rss_bytes"];

/// A bounded route label: "POST envelopes", "GET version", "POST rooms" …
pub fn route_label(method: &str, path: &str) -> String {
    // /^\/v1\/rooms(?:\/[^/]+(?:\/([^/]+))?)?/ (a prefix match, as in metrics.mjs)
    if let Some(rest) = path.strip_prefix("/v1/rooms") {
        let mut name = "rooms";
        if let Some(r) = rest.strip_prefix('/') {
            let seg1_end = r.find('/').unwrap_or(r.len());
            if seg1_end > 0 && r[seg1_end..].starts_with('/') {
                let r2 = &r[seg1_end + 1..];
                let seg2 = &r2[..r2.find('/').unwrap_or(r2.len())];
                if !seg2.is_empty() {
                    name = if ROUTES.contains(&seg2) { seg2 } else { "other" };
                }
            }
        }
        return format!("{method} {name}");
    }
    let top = match path {
        "/v1/version" => "version",
        "/v1/push_key" => "push_key",
        "/healthz" => "healthz",
        _ => "other",
    };
    format!("{method} {top}")
}

#[derive(Clone)]
struct Hist {
    buckets: [u64; 12],
    sum: f64,
    count: u64,
}
impl Hist {
    fn new() -> Hist { Hist { buckets: [0; 12], sum: 0.0, count: 0 } }
    fn observe(&mut self, ms: f64) {
        for (i, b) in BUCKETS_MS.iter().enumerate() {
            if ms <= *b {
                self.buckets[i] += 1;
            }
        }
        self.sum += ms;
        self.count += 1;
    }
}
fn quantile(h: &Hist, p: f64) -> f64 {
    if h.count == 0 {
        return 0.0;
    }
    let want = (h.count as f64 * p).ceil() as u64;
    for (i, b) in BUCKETS_MS.iter().enumerate() {
        if h.buckets[i] >= want {
            return *b;
        }
    }
    BUCKETS_MS[11]
}

struct Inner {
    latency: HashMap<String, Hist>,
    window: Hist,
    requests: indexmap::IndexMap<String, u64>,
    envelopes: u64,
    ring: Vec<Value>,
    minute: Vec<Value>,
    prev: (i64, u64, u64),
    cpu_prev: Option<(u64, u64)>,
}

pub struct Metrics {
    inner: Arc<Mutex<Inner>>,
    /// Scheduler delay (the runtime's counterpart of Node's event-loop lag), ms per 10 ms tick since the last sample.
    pub lag: Arc<Mutex<Vec<f64>>>,
    series: Mutex<Option<Connection>>,
    data_dir: PathBuf,
}

/// Records one request when its answer is done (dropped).
pub struct Mark {
    inner: Arc<Mutex<Inner>>,
    label: String,
    status: u16,
    start: Instant,
}
/// Put on a stream's answer: its time is not latency.
pub struct StreamMark;
impl Drop for Mark {
    fn drop(&mut self) {
        let mut i = self.inner.lock();
        *i.requests.entry(format!("{}|{}", self.label, self.status)).or_insert(0) += 1;
        if self.label == "POST envelopes" && self.status == 200 {
            i.envelopes += 1;
        }
        if self.label != "GET stream" {
            let ms = self.start.elapsed().as_secs_f64() * 1000.0;
            i.latency.entry(self.label.clone()).or_insert_with(Hist::new).observe(ms);
            i.window.observe(ms);
        }
    }
}

fn read(p: &str) -> String { std::fs::read_to_string(p).unwrap_or_default() }
fn cpu_ticks() -> Option<(u64, u64)> {
    let s = read("/proc/stat");
    let line = s.lines().next()?;
    if !line.starts_with("cpu ") {
        return None;
    }
    let v: Vec<u64> = line.split_whitespace().skip(1).filter_map(|x| x.parse().ok()).collect();
    let total: u64 = v.iter().sum();
    let idle = v.get(3).copied().unwrap_or(0) + v.get(4).copied().unwrap_or(0);
    Some((total - idle, total))
}
pub struct Host {
    pub load: [f64; 3],
    pub mem_total: f64,
    pub mem_available: f64,
    pub disk_total: f64,
    pub disk_free: f64,
    pub fds: usize,
    pub cpus: usize,
}
pub fn host_stats(dir: &Path) -> Host {
    let l: Vec<f64> = read("/proc/loadavg").split(' ').take(3).filter_map(|x| x.parse().ok()).collect();
    let mut mem = HashMap::new();
    for line in read("/proc/meminfo").lines() {
        let mut it = line.split_whitespace();
        if let (Some(k), Some(v)) = (it.next(), it.next()) {
            if let Ok(n) = v.parse::<f64>() {
                mem.insert(k.trim_end_matches(':').to_string(), n * 1024.0);
            }
        }
    }
    let (mut dt, mut df) = (0.0, 0.0);
    if let Ok(c) = std::ffi::CString::new(dir.to_string_lossy().as_bytes()) {
        let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
        if unsafe { libc::statvfs(c.as_ptr(), &mut s) } == 0 {
            dt = s.f_blocks as f64 * s.f_frsize as f64;
            df = s.f_bavail as f64 * s.f_frsize as f64;
        }
    }
    Host {
        load: if l.len() == 3 { [l[0], l[1], l[2]] } else { [0.0; 3] },
        mem_total: mem.get("MemTotal").copied().unwrap_or(0.0),
        mem_available: mem.get("MemAvailable").copied().unwrap_or(0.0),
        disk_total: dt,
        disk_free: df,
        fds: std::fs::read_dir("/proc/self/fd").map(|d| d.count()).unwrap_or(0),
        cpus: std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1),
    }
}
pub fn rss_bytes() -> f64 {
    let s = read("/proc/self/statm");
    let pages: f64 = s.split_whitespace().nth(1).and_then(|x| x.parse().ok()).unwrap_or(0.0);
    pages * 4096.0
}

impl Metrics {
    pub fn new(dir: &Path, _cfg: &Config) -> Metrics {
        let series = Connection::open(dir.join("metrics.db")).ok().and_then(|c| {
            c.execute_batch(&format!("CREATE TABLE IF NOT EXISTS metrics_minute (at INTEGER PRIMARY KEY, {})", SERIES_COLUMNS.map(|c| format!("{c} REAL")).join(", "))).ok()?;
            Some(c)
        });
        Metrics {
            inner: Arc::new(Mutex::new(Inner {
                latency: HashMap::new(),
                window: Hist::new(),
                requests: Default::default(),
                envelopes: 0,
                ring: vec![],
                minute: vec![],
                prev: (crate::util::now(), 0, 0),
                cpu_prev: cpu_ticks(),
            })),
            series: Mutex::new(series),
            lag: Arc::new(Mutex::new(vec![])),
            data_dir: dir.to_path_buf(),
        }
    }
    /// Measure how late a 10 ms timer fires (the runtime is busy): p50, p99, max in ms.
    pub fn spawn_lag_monitor(&self) {
        let lag = self.lag.clone();
        tokio::spawn(async move {
            loop {
                let t = Instant::now();
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                let late = (t.elapsed().as_secs_f64() * 1000.0 - 10.0).max(0.0);
                let mut l = lag.lock();
                if l.len() < 100000 {
                    l.push(late);
                }
            }
        });
    }
    fn lag_stats(&self) -> (f64, f64, f64) {
        let mut l = self.lag.lock().clone();
        if l.is_empty() {
            return (0.0, 0.0, 0.0);
        }
        l.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let at = |p: f64| l[((l.len() as f64 * p).ceil() as usize).clamp(1, l.len()) - 1];
        (at(0.5), at(0.99), *l.last().unwrap())
    }
    pub fn request(&self, label: String, status: u16, start: Instant) -> Mark { Mark { inner: self.inner.clone(), label, status, start } }

    /// One 10 s sample (ring buffer; folded into metrics.db per minute).
    pub fn sample(&self, hub: &crate::server::Hub) {
        let host = host_stats(&self.data_dir);
        let (out_total, out_max, count) = hub.outbound();
        let db_bytes = crate::ops::file_size(&hub.db.path) as f64;
        let wal_bytes = crate::ops::file_size(&PathBuf::from(format!("{}-wal", hub.db.path.display()))) as f64;
        let rss = rss_bytes();
        let lag = self.lag_stats();
        self.lag.lock().clear();
        let mut i = self.inner.lock();
        let t = crate::util::now();
        let dt = ((t - i.prev.0).max(1)) as f64 / 1000.0;
        let reqs: u64 = i.requests.values().sum();
        let ticks = cpu_ticks();
        let cpu = match (ticks, i.cpu_prev) {
            (Some(a), Some(b)) if a.1 > b.1 => 100.0 * (a.0 - b.0) as f64 / (a.1 - b.1) as f64,
            _ => 100.0 * host.load[0] / host.cpus as f64,
        };
        i.cpu_prev = ticks;
        let entry = json!({
            "at": t, "envelopes_per_second": (i.envelopes - i.prev.1) as f64 / dt, "requests_per_second": (reqs - i.prev.2) as f64 / dt,
            "write_queue_depth": hub.flow.depth(), "open_streams": count, "outbound_bytes_max": out_max, "outbound_bytes_total": out_total,
            "rss_bytes": rss, "heap_used_bytes": rss, "event_loop_lag_p99_ms": lag.1, "event_loop_lag_max_ms": lag.2, "gc_max_ms": 0,
            "sqlite_bytes": db_bytes, "wal_bytes": wal_bytes, "load1": host.load[0], "mem_available_bytes": host.mem_available, "disk_free_bytes": host.disk_free,
            "cpu_percent": cpu.clamp(0.0, 100.0), "cpus": host.cpus, "mem_total_bytes": host.mem_total, "disk_total_bytes": host.disk_total,
            "request_ms_avg": if i.window.count > 0 { i.window.sum / i.window.count as f64 } else { 0.0 }, "request_ms_p95": quantile(&i.window, 0.95),
        });
        i.ring.push(entry.clone());
        if i.ring.len() > SAMPLES {
            i.ring.remove(0);
        }
        i.prev = (t, i.envelopes, reqs);
        i.window = Hist::new();
        let flush = i.minute.first().is_some_and(|f| f["at"].as_i64().unwrap() / MINUTE != t / MINUTE);
        let list = if flush { std::mem::take(&mut i.minute) } else { vec![] };
        i.minute.push(entry);
        drop(i);
        if flush {
            self.write_minute(list);
        }
    }
    fn write_minute(&self, list: Vec<Value>) {
        if list.is_empty() {
            return;
        }
        let g = self.series.lock();
        let Some(c) = g.as_ref() else { return };
        let n = list.len() as f64;
        let f = |k: &str| list.iter().map(|x| x[k].as_f64().unwrap_or(0.0)).collect::<Vec<_>>();
        let avg = |k: &str| f(k).iter().sum::<f64>() / n;
        let max = |k: &str| f(k).iter().cloned().fold(f64::MIN, f64::max);
        let at = list[0]["at"].as_i64().unwrap() / MINUTE * MINUTE;
        let mem = list.iter().map(|x| { let t = x["mem_total_bytes"].as_f64().unwrap_or(0.0); if t > 0.0 { 100.0 * (t - x["mem_available_bytes"].as_f64().unwrap_or(0.0)) / t } else { 0.0 } }).sum::<f64>() / n;
        let row = [avg("cpu_percent"), mem, avg("disk_free_bytes"), avg("disk_total_bytes"), max("open_streams"), avg("envelopes_per_second") * 60.0, avg("requests_per_second"), max("request_ms_p95"), avg("sqlite_bytes"), avg("wal_bytes"), avg("rss_bytes")];
        let sql = format!("INSERT OR REPLACE INTO metrics_minute (at, {}) VALUES (?{})", SERIES_COLUMNS.join(", "), ", ?".repeat(SERIES_COLUMNS.len()));
        let _ = c.execute(&sql, params![at, row[0], row[1], row[2], row[3], row[4], row[5], row[6], row[7], row[8], row[9], row[10]]);
        if at % 3600000 == 0 {
            let _ = c.execute("DELETE FROM metrics_minute WHERE at < ?", [at - KEEP_MS]);
        }
    }
    pub fn flush(&self) {
        let list = std::mem::take(&mut self.inner.lock().minute);
        self.write_minute(list);
    }
    pub fn history(&self) -> Vec<Value> { self.inner.lock().ring.clone() }
    /// The persisted minutes since `since`, folded into at most `points` buckets.
    pub fn series(&self, since: i64, points: i64) -> Vec<Value> {
        let g = self.series.lock();
        let Some(c) = g.as_ref() else { return vec![] };
        let until = crate::util::now();
        let step = std::cmp::max(MINUTE, (((until - since) as f64 / points as f64 / MINUTE as f64).ceil() as i64) * MINUTE);
        let cols = SERIES_COLUMNS.map(|c| format!("{}({c}) AS {c}", if c == "request_ms_p95" || c == "open_streams" { "MAX" } else { "AVG" })).join(", ");
        let sql = format!("SELECT (at / {step}) * {step} AS at, {cols} FROM metrics_minute WHERE at >= ? GROUP BY at / {step} ORDER BY at");
        let Ok(mut st) = c.prepare(&sql) else { return vec![] };
        st.query_map([since], |r| {
            let mut m = Map::new();
            m.insert("at".into(), json!(r.get::<_, i64>(0)?));
            for (i, k) in SERIES_COLUMNS.iter().enumerate() {
                m.insert(k.to_string(), json!(r.get::<_, Option<f64>>(i + 1)?));
            }
            Ok(Value::Object(m))
        })
        .and_then(|it| it.collect())
        .unwrap_or_default()
    }

    pub fn text(&self, hub: &crate::server::Hub) -> String {
        let host = host_stats(&self.data_dir);
        let (out_total, out_max, count) = hub.outbound();
        let db_bytes = crate::ops::file_size(&hub.db.path);
        let wal_bytes = crate::ops::file_size(&PathBuf::from(format!("{}-wal", hub.db.path.display())));
        let wal = hub.wal_last.lock().clone();
        let i = self.inner.lock();
        let mut lines: Vec<String> = vec![];
        let metric = |lines: &mut Vec<String>, name: &str, ty: &str, help: &str, rows: Vec<(String, f64)>| {
            lines.push(format!("# HELP {name} {help}"));
            lines.push(format!("# TYPE {name} {ty}"));
            for (l, v) in rows {
                lines.push(format!("{name}{l} {}", if v.is_finite() { fmt(v) } else { "0".into() }));
            }
        };
        let one = |lines: &mut Vec<String>, name: &str, ty: &str, help: &str, v: f64| metric(lines, name, ty, help, vec![(String::new(), v)]);
        metric(&mut lines, "trommi_requests_total", "counter", "HTTP requests by route and status.", i.requests.iter().map(|(k, v)| {
            let (route, status) = k.split_once('|').unwrap();
            (format!("{{route=\"{route}\",status=\"{status}\"}}"), *v as f64)
        }).collect());
        lines.push("# HELP trommi_request_duration_ms Request latency (streams excluded).".into());
        lines.push("# TYPE trommi_request_duration_ms histogram".into());
        for (route, h) in &i.latency {
            for (k, le) in BUCKETS_MS.iter().enumerate() {
                lines.push(format!("trommi_request_duration_ms_bucket{{route=\"{route}\",le=\"{}\"}} {}", fmt(*le), h.buckets[k]));
            }
            lines.push(format!("trommi_request_duration_ms_bucket{{route=\"{route}\",le=\"+Inf\"}} {}", h.count));
            lines.push(format!("trommi_request_duration_ms_sum{{route=\"{route}\"}} {}", fmt(h.sum)));
            lines.push(format!("trommi_request_duration_ms_count{{route=\"{route}\"}} {}", h.count));
        }
        one(&mut lines, "trommi_envelopes_ingested_total", "counter", "Envelopes accepted.", i.envelopes as f64);
        one(&mut lines, "trommi_write_queue_depth", "gauge", "Write requests in flight.", hub.flow.depth() as f64);
        one(&mut lines, "trommi_writes_refused_total", "counter", "Writes refused with 503 because the queue was full.", hub.flow.refused_writes.load(Ordering::Relaxed) as f64);
        one(&mut lines, "trommi_open_streams", "gauge", "Open live streams.", count as f64);
        one(&mut lines, "trommi_streams_dropped_total", "counter", "Streams dropped because their send buffer was full.", hub.flow.dropped_streams.load(Ordering::Relaxed) as f64);
        one(&mut lines, "trommi_stream_outbound_bytes", "gauge", "Bytes waiting to be sent, all streams.", out_total as f64);
        one(&mut lines, "trommi_stream_outbound_bytes_max", "gauge", "Bytes waiting to be sent, the fullest stream.", out_max as f64);
        one(&mut lines, "trommi_sqlite_bytes", "gauge", "Size of hub.db.", db_bytes as f64);
        one(&mut lines, "trommi_sqlite_wal_bytes", "gauge", "Size of hub.db-wal.", wal_bytes as f64);
        one(&mut lines, "trommi_sqlite_checkpoint_lag_frames", "gauge", "WAL frames not yet checkpointed at the last checkpoint.", (wal.log_frames - wal.checkpointed_frames) as f64);
        one(&mut lines, "trommi_sqlite_checkpoint_ms", "gauge", "Duration of the last checkpoint.", wal.last_ms);
        one(&mut lines, "process_resident_memory_bytes", "gauge", "Resident memory.", rss_bytes());
        let rss = rss_bytes();
        // Node's names, kept for the dashboards: there is no heap or GC here (heap = the resident set, GC = 0); the
        // event-loop lag is the runtime's scheduler delay of a 10 ms timer.
        metric(&mut lines, "nodejs_heap_bytes", "gauge", "Heap (the Rust hub: resident memory; it has no separate heap).", vec![("{kind=\"used\"}".into(), rss), ("{kind=\"total\"}".into(), rss), ("{kind=\"external\"}".into(), 0.0)]);
        let lag = { let l = self.lag.lock().clone(); drop(l); self.lag_stats() };
        metric(&mut lines, "nodejs_eventloop_lag_ms", "gauge", "Event loop delay since the last sample (the Rust hub: scheduler delay of a 10 ms timer).", vec![("{quantile=\"0.5\"}".into(), lag.0), ("{quantile=\"0.99\"}".into(), lag.1), ("{quantile=\"1\"}".into(), lag.2)]);
        one(&mut lines, "nodejs_gc_pauses_total", "counter", "Garbage collections (the Rust hub has none).", 0.0);
        one(&mut lines, "nodejs_gc_pause_ms_total", "counter", "Time spent in garbage collection (the Rust hub has none).", 0.0);
        one(&mut lines, "process_uptime_seconds", "gauge", "Seconds since the hub started.", hub.started.elapsed().as_secs_f64());
        one(&mut lines, "process_open_fds", "gauge", "Open file descriptors.", host.fds as f64);
        metric(&mut lines, "host_load", "gauge", "Host load average (/proc/loadavg).", host.load.iter().enumerate().map(|(k, v)| (format!("{{minutes=\"{}\"}}", [1, 5, 15][k]), *v)).collect());
        one(&mut lines, "host_cpus", "gauge", "CPUs available.", host.cpus as f64);
        metric(&mut lines, "host_memory_bytes", "gauge", "Host memory (/proc/meminfo).", vec![("{kind=\"total\"}".into(), host.mem_total), ("{kind=\"available\"}".into(), host.mem_available)]);
        metric(&mut lines, "host_data_disk_bytes", "gauge", "The data volume (statfs).", vec![("{kind=\"total\"}".into(), host.disk_total), ("{kind=\"free\"}".into(), host.disk_free)]);
        format!("{}\n", lines.join("\n"))
    }
}
/// A number as JavaScript prints it.
pub fn fmt(v: f64) -> String {
    if v.fract() == 0.0 && v.abs() < 1e21 {
        format!("{}", v as i64)
    } else {
        format!("{v}")
    }
}

#[allow(dead_code)]
static UNUSED: AtomicBool = AtomicBool::new(false);
