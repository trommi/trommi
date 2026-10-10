//! The three pages of the admin page (`admin.rs` signs in and frames them): the overview (the server's health and
//! the hub's counts), the accounts (with their rooms), and the tables (each with what it holds, its columns, its
//! number of rows and, where it holds nothing sealed and nothing of signing in or pushing, a few of its rows with
//! ids shortened and every other byte string shown by its length only). Nothing sealed is ever shown, and no
//! e-mail address in full.

use std::path::Path;
use std::sync::atomic::Ordering;
use std::time::Duration;

use rusqlite::types::ValueRef;
use rusqlite::Connection;

use crate::admin::{esc, EYE, LOCK};
use crate::app::App;
use crate::error::Refused;
use crate::metrics::{self, Sample, Series};
use crate::util::{hex, now, short};

/// What each table holds, as spec/hub-api.md "Tables" has it: its group on the page, what the hub reads, and what
/// lies in it sealed.
pub const TABLES: &[(&str, &str, &str, &str)] = &[
    ("Accounts and sign-in", "accounts", "e-mail, login hashes, KDF record", "sealed copies of the code"),
    ("Accounts and sign-in", "passkeys", "passkey public keys", "sealed copies of the code"),
    ("Accounts and sign-in", "account_rooms", "account → room", ""),
    ("Accounts and sign-in", "account_sources", "keyed hashes of the addresses an account was signed in to from", ""),
    ("Accounts and sign-in", "login_sources", "login throttle: hashes of e-mail and source, failures", ""),
    ("Accounts and sign-in", "login_accounts", "login throttle: an e-mail's hour and line", ""),
    ("Accounts and sign-in", "login_turns", "login throttle: places in line", ""),
    ("Rooms and devices", "rooms", "room id, founding time, change counter, counts, recovery public keys", ""),
    ("Rooms and devices", "devices", "device public key, role, epochs", ""),
    ("Rooms and devices", "requests", "device, kind, group, time", ""),
    ("Rooms and devices", "agent_leases", "device, process, generation, expiry", ""),
    ("Groups", "groups", "group id, kind, session, epoch, the public group state", ""),
    ("Groups", "group_members", "the leaves of each group", ""),
    ("Groups", "group_log", "Commits (public), sender, times", "application messages"),
    ("Groups", "group_infos", "GroupInfos (public)", ""),
    ("Groups", "key_packages", "KeyPackages (public)", ""),
    ("Groups", "spent_key_packages", "references of KeyPackages handed out", ""),
    ("Groups", "welcomes", "device, group, time, epoch", "the Welcome (rows written before its own table)"),
    ("Groups", "welcome_bytes", "group, epoch", "the Welcome, once for every device it adds"),
    ("Groups", "welcome_ids", "the counter of Welcome ids (one number)", ""),
    ("Keys and recovery", "sealed_keys", "group, epoch, writer, recovery public key", "the sealed content keys"),
    ("Keys and recovery", "recovery_links", "room epoch, recovery public key", "the sealed older recovery key"),
    ("Keys and recovery", "recovery_keys_held", "every recovery public key a room had", ""),
    ("Keys and recovery", "recoveries", "open recoveries: key, times", ""),
    ("Keys and recovery", "recovery_parts", "the Commits of an open recovery (public)", ""),
    ("Keys and recovery", "recovery_memo", "public group state of an open recovery", ""),
    ("Content index", "envelopes", "signed header: group, sender, numbers, kind, times, timeline, object id, type and state, file ids", "the body"),
    ("Content index", "epoch_counts", "envelopes per group and epoch", ""),
    ("Content index", "cards", "object id, state, urgency, owner (index over envelopes)", ""),
    ("Content index", "permission_requests", "as cards", ""),
    ("Content index", "artifacts", "as cards", ""),
    ("Content index", "notes", "as cards", ""),
    ("Content index", "chats", "timeline, item count (index)", ""),
    ("Content index", "boards", "timeline, item count (index)", ""),
    ("Content index", "registers", "group, writer, register id (index)", ""),
    ("Content index", "board_frontiers", "board, device, declared or bound to a snapshot value, numbers per writer, kept file ids, time (10.9)", ""),
    ("Files and invites", "files", "file id, uploader, group, object, size, times", "the bytes, beside the database"),
    ("Files and invites", "shares", "share id, file, hash of the secret, expiry", ""),
    ("Files and invites", "invites", "the signed Offer with its MAC, expiry, use", ""),
    ("Files and invites", "invite_requests", "Requests and Reveal of an invite", ""),
    ("Push", "push_subscriptions", "push endpoints and tokens, level", ""),
    ("Push", "live_activities", "Live Activity tokens, the counts last sent", ""),
];

/// Tables whose rows are not shown although nothing in them is sealed: who signed in from where, and the
/// addresses and tokens pushes go to.
const PRIVATE: &[&str] = &[
    "account_sources",
    "login_sources",
    "login_accounts",
    "login_turns",
    "shares",
    "push_subscriptions",
    "live_activities",
];

/// The columns that hold what the hub cannot read.
const SEALED: &[(&str, &str)] = &[
    ("accounts", "password_copy"),
    ("accounts", "kit_copy"),
    ("passkeys", "sealed_copy"),
    ("group_log", "bytes"),
    ("welcomes", "bytes"),
    ("welcome_bytes", "bytes"),
    ("sealed_keys", "sealed"),
    ("recovery_links", "sealed"),
    ("envelopes", "body"),
];

/// Text columns whose values are shown (a word out of a short fixed list each); any other text by its length.
const WORDS: &[&str] = &[
    "role",
    "kind",
    "level",
    "environment",
    "kit_form",
    "void_code",
    "transports",
];

/// Byte columns that name something (a room, a device, a group …): shown as their first four bytes in hex.
fn names_something(column: &str) -> bool {
    column.ends_with("_id")
        || matches!(
            column,
            "device"
                | "sender"
                | "recipient"
                | "owner"
                | "writer"
                | "uploader"
                | "inviter"
                | "founder"
                | "created_by"
                | "committer"
                | "parent"
                | "timeline"
                | "process"
                | "revealed_device"
        )
}

fn is_time(column: &str) -> bool {
    column.ends_with("_at") || column == "at" || column == "time"
}

/// How a column's values appear in the rows shown.
fn shown_as(table: &str, column: &str, kind: &str) -> &'static str {
    if SEALED.contains(&(table, column)) {
        "sealed"
    } else if kind.eq_ignore_ascii_case("INTEGER") || kind.eq_ignore_ascii_case("REAL") {
        if is_time(column) {
            "time"
        } else {
            "number"
        }
    } else if kind.eq_ignore_ascii_case("TEXT") && WORDS.contains(&column) {
        "word"
    } else if kind.eq_ignore_ascii_case("BLOB") && names_something(column) {
        "short id"
    } else {
        "length only"
    }
}

/// An e-mail address as the page shows it: its first character and its ending (`a•••@•••.org`).
pub fn mask_email(email: &str) -> String {
    match email.rsplit_once('@') {
        Some((local, domain)) => {
            let first = local.chars().next().map(String::from).unwrap_or_default();
            match domain.rsplit_once('.') {
                Some((_, tld)) => format!("{first}•••@•••.{tld}"),
                None => format!("{first}•••@•••"),
            }
        }
        None => "•••".into(),
    }
}

pub fn when(ms: i64) -> String {
    // days since 1970 to a date (civil-from-days), UTC
    let secs = ms.div_euclid(1000);
    let (days, rest) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let (d, m) = (
        doy - (153 * mp + 2) / 5 + 1,
        if mp < 10 { mp + 3 } else { mp - 9 },
    );
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02} {:02}:{:02}",
        rest / 3600,
        rest % 3600 / 60
    )
}

pub fn size(bytes: u64) -> String {
    match bytes {
        b if b >= 1 << 40 => format!("{:.1} TiB", b as f64 / (1u64 << 40) as f64),
        b if b >= 1 << 30 => format!("{:.1} GiB", b as f64 / (1u64 << 30) as f64),
        b if b >= 1 << 20 => format!("{:.1} MiB", b as f64 / (1u64 << 20) as f64),
        b if b >= 1 << 10 => format!("{:.1} KiB", b as f64 / 1024.0),
        b => format!("{b} B"),
    }
}

fn span(ms: u64) -> String {
    let m = ms / 60_000;
    match m {
        m if m >= 1440 => format!("{} d {} h", m / 1440, m % 1440 / 60),
        m if m >= 60 => format!("{} h {} min", m / 60, m % 60),
        m => format!("{m} min"),
    }
}

fn tile(key: &str, value: &str, small: &str, sub: &str) -> String {
    format!(
        "<div class=\"tile\"><div class=\"k\">{key}</div><div class=\"v\">{}{}</div><div class=\"s\">{}</div></div>",
        esc(value),
        if small.is_empty() { String::new() } else { format!("<small>{}</small>", esc(small)) },
        esc(sub)
    )
}

// ---- the graphs ---------------------------------------------------------------------------------------------

/// A tile with a graph under its numbers.
fn tile_graph(key: &str, value: &str, small: &str, sub: &str, graph: &str) -> String {
    let plain = tile(key, value, small, sub);
    format!("{}{graph}</div>", &plain[..plain.len() - "</div>".len()])
}

/// How a series' values read.
fn shown_value(series: Series, v: f64) -> String {
    match series {
        Series::Cpu | Series::Mem => format!("{v:.0} %"),
        Series::Rss => size(v.max(0.0) as u64),
        Series::Rps => {
            if v < 10.0 {
                format!("{v:.1}/s")
            } else {
                format!("{v:.0}/s")
            }
        }
        _ => format!("{v:.0}"),
    }
}

/// A small line graph of one series over `range_ms` up to `now`, drawn as inline SVG, with a line under it: the
/// time it covers ("since start" when the history is shorter) and the highest value in it. Percentages are drawn
/// against 100, everything else against its own highest value.
pub fn graph(samples: &[Sample], series: Series, range_ms: u64, now: u64) -> String {
    const W: f64 = 300.0;
    const H: f64 = 48.0;
    let from = now.saturating_sub(range_ms);
    let step = if range_ms <= metrics::FINE_MS { metrics::STEP_MS } else { metrics::COARSE_STEP_MS };
    let points: Vec<(u64, f64)> = samples
        .iter()
        .filter(|s| s.at >= from && s.at <= now)
        .map(|s| (s.at, s.get(series)))
        .filter(|(_, v)| v.is_finite())
        .collect();
    let peak = points.iter().map(|p| p.1).fold(0.0, f64::max);
    let top = match series {
        Series::Cpu | Series::Mem => 100.0,
        _ => (peak * 1.15).max(1.0),
    };
    let x = |at: u64| (at.saturating_sub(from)) as f64 / range_ms.max(1) as f64 * W;
    let y = |v: f64| H - 1.0 - (v.max(0.0) / top).min(1.0) * (H - 2.0);
    // a gap of more than three steps (the hub was busy or stopped) breaks the line
    let mut runs: Vec<Vec<(f64, f64)>> = Vec::new();
    let mut last_at = None;
    for &(at, v) in &points {
        if last_at.is_none_or(|l: u64| at > l + 3 * step) {
            runs.push(Vec::new());
        }
        runs.last_mut().expect("a run").push((x(at), y(v)));
        last_at = Some(at);
    }
    let (mut line, mut area) = (String::new(), String::new());
    for run in &runs {
        let path: Vec<String> = run.iter().map(|(px, py)| format!("{px:.1},{py:.1}")).collect();
        line.push_str(&format!("M{}", path.join("L")));
        if run.len() == 1 {
            line.push_str("h0.1");
        }
        area.push_str(&format!(
            "M{:.1},{H}L{}L{:.1},{H}Z",
            run[0].0,
            path.join("L"),
            run[run.len() - 1].0
        ));
    }
    let span = if range_ms <= metrics::FINE_MS { "last hour" } else { "last 24 h" };
    let covered = match points.first() {
        None => "first sample within 10 s".to_string(),
        // (the history begins with the hub's start: a restart loses it)
        Some(&(first, _)) if first > from + 3 * step => {
            format!("since start · {}", span_short(now.saturating_sub(first)))
        }
        Some(_) => span.to_string(),
    };
    format!(
        "<svg class=\"spark\" viewBox=\"0 0 {W} {H}\" preserveAspectRatio=\"none\" aria-hidden=\"true\">\
<line class=\"base\" x1=\"0\" y1=\"{b}\" x2=\"{W}\" y2=\"{b}\" vector-effect=\"non-scaling-stroke\"/>\
<path class=\"area\" d=\"{area}\"/><path class=\"line\" d=\"{line}\" vector-effect=\"non-scaling-stroke\"/></svg>\
<div class=\"gcap\"><span>{}</span><span>{}</span></div>",
        esc(&covered),
        if points.is_empty() { String::new() } else { format!("max {}", esc(&shown_value(series, peak))) },
        b = H - 0.5,
    )
}

/// A short time span: seconds under a minute, else as `span`.
fn span_short(ms: u64) -> String {
    if ms < 60_000 {
        format!("{} s", ms / 1000)
    } else {
        span(ms)
    }
}

// ---- the server -----------------------------------------------------------------------------------------------

/// What the server says of itself, read from /proc and the file system (Linux; elsewhere these stay empty).
#[derive(Default)]
struct Host {
    cpus: usize,
    /// share of the CPU time that was not idle, over a quarter of a second
    busy: Option<f64>,
    load: Option<[f64; 3]>,
    mem: Option<(u64, u64)>,
    disk: Option<(u64, u64)>,
    up_ms: Option<u64>,
    rss: Option<u64>,
}

/// `cpu` of /proc/stat: all time and idle time (idle and waiting for I/O), in ticks.
pub(crate) fn cpu_ticks() -> Option<(u64, u64)> {
    let stat = std::fs::read_to_string("/proc/stat").ok()?;
    let line = stat.lines().next()?.strip_prefix("cpu ")?;
    let ticks: Vec<u64> = line
        .split_whitespace()
        .filter_map(|n| n.parse().ok())
        .collect();
    // user nice system idle iowait irq softirq steal (guest time is counted in user already)
    let all = ticks.iter().take(8).sum();
    Some((all, ticks.get(3)? + ticks.get(4).copied().unwrap_or(0)))
}

/// A `/proc/meminfo` or `/proc/self/status` value in kB, as bytes.
pub(crate) fn kb(text: &str, key: &str) -> Option<u64> {
    let line = text.lines().find(|l| l.starts_with(key))?;
    let n: u64 = line[key.len()..]
        .trim()
        .trim_end_matches("kB")
        .trim()
        .parse()
        .ok()?;
    Some(n * 1024)
}

fn host(data: &Path) -> Host {
    let first = cpu_ticks();
    std::thread::sleep(Duration::from_millis(250));
    let busy = first.zip(cpu_ticks()).and_then(|((a0, i0), (a1, i1))| {
        let all = a1.saturating_sub(a0);
        (all > 0).then(|| 100.0 * all.saturating_sub(i1.saturating_sub(i0)) as f64 / all as f64)
    });
    let load = std::fs::read_to_string("/proc/loadavg")
        .ok()
        .and_then(|text| {
            let n: Vec<f64> = text
                .split_whitespace()
                .take(3)
                .filter_map(|x| x.parse().ok())
                .collect();
            (n.len() == 3).then(|| [n[0], n[1], n[2]])
        });
    let mem = std::fs::read_to_string("/proc/meminfo")
        .ok()
        .and_then(|text| kb(&text, "MemTotal:").zip(kb(&text, "MemAvailable:")));
    let disk = rustix::fs::statvfs(data)
        .ok()
        .map(|s| (s.f_blocks * s.f_frsize, s.f_bavail * s.f_frsize));
    let up_ms = std::fs::read_to_string("/proc/uptime")
        .ok()
        .and_then(|text| text.split_whitespace().next()?.parse::<f64>().ok())
        .map(|s| (s * 1000.0) as u64);
    let rss = std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|text| kb(&text, "VmRSS:"));
    Host {
        cpus: std::thread::available_parallelism().map_or(1, |n| n.get()),
        busy,
        load,
        mem,
        disk,
        up_ms,
        rss,
    }
}

/// The release this hub was started from: the updater runs it as `releases/hub-v123/trommi-hub`.
fn release() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?.file_name()?.to_str()?;
    dir.strip_prefix("hub-")
        .filter(|v| v.starts_with('v'))
        .map(str::to_string)
}

fn file_len(path: &Path) -> u64 {
    std::fs::metadata(path).map_or(0, |m| m.len())
}

// ---- the overview ---------------------------------------------------------------------------------------------

/// The overview: the server's health, then the hub's counts, read in one snapshot of the database.
pub fn overview(app: &App, range_ms: u64) -> Result<String, Refused> {
    let h = host(&app.cfg.data);
    let db = app.cfg.data.join("hub.db");
    let db_bytes = file_len(&db) + file_len(&app.cfg.data.join("hub.db-wal"));
    app.db.read(|c| {
        let one = |sql: &str| -> rusqlite::Result<i64> { c.query_row(sql, [], |r| r.get(0)) };
        let rooms = one("SELECT count(*) FROM rooms")?;
        let accounts = one("SELECT count(*) FROM accounts")?;
        let devices = one("SELECT count(*) FROM devices WHERE removed_epoch IS NULL")?;
        let agents = one("SELECT count(*) FROM devices WHERE removed_epoch IS NULL AND role = 'agent'")?;
        let sessions = one("SELECT count(*) FROM groups WHERE kind != 'room' AND live = 1")?;
        let archived = one("SELECT count(*) FROM groups WHERE kind != 'room' AND live = 0")?;
        let file_bytes = one("SELECT coalesce(sum(file_bytes), 0) FROM rooms")?;
        let web_push = one("SELECT count(*) FROM push_subscriptions WHERE kind = 'web_push'")?;
        let apns = one("SELECT count(*) FROM push_subscriptions WHERE kind = 'apns'")?;
        let live_activities = one("SELECT count(*) FROM live_activities")?;
        let (at_work, waiting) = app.gate.load();
        let release = release();
        let t = now();
        let samples = app.metrics.since(range_ms, t);
        let g = |series: Series| graph(&samples, series, range_ms, t);
        let day = range_ms > metrics::FINE_MS;

        let mut out = format!(
            "<main class=\"page\"><div class=\"head\"><h1>Overview</h1><span class=\"muted\">version <code>{}</code> · {} · protocol 2 · {}</span>\
<nav class=\"seg\" aria-label=\"Graphs\"><a href=\"/\"{}>1 h</a><a href=\"/?range=24h\"{}>24 h</a></nav></div>",
            esc(&app.cfg.commit),
            match &release {
                Some(r) => format!("release <code>{}</code>", esc(r)),
                None => "not from a release".into(),
            },
            when(t as i64),
            if day { "" } else { " class=\"on\" aria-current=\"true\"" },
            if day { " class=\"on\" aria-current=\"true\"" } else { "" },
        );

        out.push_str("<h2 class=\"fam\">Server</h2><div class=\"tiles\">");
        let cores = format!("{} core{}", h.cpus, if h.cpus == 1 { "" } else { "s" });
        out.push_str(&match (h.busy, h.load) {
            (Some(busy), load) => tile_graph(
                "CPU",
                &format!("{busy:.0}"),
                "%",
                &match load {
                    Some(l) => format!("{cores} · load {:.2} {:.2} {:.2}", l[0], l[1], l[2]),
                    None => cores,
                },
                &g(Series::Cpu),
            ),
            (None, Some(l)) => tile_graph("CPU", &format!("{:.2}", l[0]), "load", &cores, &g(Series::Cpu)),
            (None, None) => tile_graph("CPU", "–", "", &cores, &g(Series::Cpu)),
        });
        out.push_str(&match h.mem {
            Some((total, available)) => {
                let used = total.saturating_sub(available);
                tile_graph(
                    "Memory",
                    &format!("{:.0}", 100.0 * used as f64 / total.max(1) as f64),
                    "%",
                    &format!("{} of {}", size(used), size(total)),
                    &g(Series::Mem),
                )
            }
            None => tile("Memory", "–", "", "not known here"),
        });
        out.push_str(&match h.disk {
            Some((total, free)) => tile(
                "Disk",
                &format!("{:.0}", 100.0 * total.saturating_sub(free) as f64 / total.max(1) as f64),
                "% used",
                &format!("{} free of {}", size(free), size(total)),
            ),
            None => tile("Disk", "–", "", "not known here"),
        });
        out.push_str(&tile(
            "Uptime",
            &span(t.saturating_sub(app.started_at)),
            "",
            &match h.up_ms {
                Some(up) => format!("hub · server up {}", span(up)),
                None => "hub".into(),
            },
        ));
        out.push_str(&tile_graph(
            "Hub memory",
            &h.rss.map_or("–".into(), size),
            "",
            "resident, this process",
            &g(Series::Rss),
        ));
        out.push_str(&tile("Database", &size(db_bytes), "", &format!("files {}", size(file_bytes.max(0) as u64))));
        out.push_str("</div>");

        out.push_str("<h2 class=\"fam\">Hub</h2><div class=\"tiles\">");
        out.push_str(&tile("Rooms", &rooms.to_string(), "", &format!("{devices} device{} · {agents} agent{}", if devices == 1 { "" } else { "s" }, if agents == 1 { "" } else { "s" })));
        out.push_str(&tile("Accounts", &accounts.to_string(), "", "e-mail or passkey"));
        out.push_str(&tile_graph("Sessions", &sessions.to_string(), "live", &format!("{archived} archived"), &g(Series::Sessions)));
        out.push_str(&tile_graph("Streams", &app.live.count().to_string(), "open", "devices listening now", &g(Series::Streams)));
        let rps = samples.last().map(|s| s.get(Series::Rps)).filter(|v| v.is_finite());
        out.push_str(&tile_graph(
            "Requests",
            &rps.map_or("–".into(), |v| if v < 10.0 { format!("{v:.1}") } else { format!("{v:.0}") }),
            "/s",
            &format!("{} at work · public port", app.in_flight.load(Ordering::Relaxed)),
            &g(Series::Rps),
        ));
        out.push_str(&tile_graph("Pool", &at_work.to_string(), "at work", &format!("{waiting} waiting"), &g(Series::Pool)));
        out.push_str(&tile(
            "Push",
            &(web_push + apns).to_string(),
            "registered",
            &format!("{web_push} web · {apns} Apple · {live_activities} live"),
        ));
        out.push_str(&tile(
            "Push to Apple",
            if app.apns.is_some() { "on" } else { "off" },
            "",
            if app.apns.is_some() { "configured" } else { "not configured" },
        ));
        out.push_str("</div>");

        // ---- the hub's settings beside the tables with their counts
        let kv = [
            ("Version", format!("<code>{}</code>", esc(&app.cfg.commit))),
            ("Release", release.as_deref().map_or("<span class=\"faint\">not from a release</span>".into(), |r| format!("<code>{}</code>", esc(r)))),
            ("Public address", esc(&app.cfg.url)),
            ("Started", format!("{} UTC", when(app.started_at as i64))),
            ("Push to Apple", if app.apns.is_some() { "configured".into() } else { "not configured".into() }),
            ("Room quota", size(app.cfg.room_quota)),
            ("Rooms at most", app.cfg.max_rooms.to_string()),
        ];
        out.push_str("<div class=\"cols\"><section class=\"card\"><h3>Hub</h3><dl class=\"kv\">");
        for (k, v) in kv {
            out.push_str(&format!("<dt>{k}</dt><dd>{v}</dd>"));
        }
        out.push_str(&format!(
            "</dl></section><section class=\"card\"><h3>Tables <span class=\"count\"><a href=\"/tables\">all {}</a></span></h3><ul class=\"tlist\">",
            TABLES.len()
        ));
        for (_, table, _, _) in TABLES {
            // (names from the list above, never from a request)
            let n = one(&format!("SELECT count(*) FROM {table}"))?;
            out.push_str(&format!(
                "<li><a href=\"/tables?t={table}\"><span>{table}</span><span class=\"count\">{n}</span></a></li>"
            ));
        }
        out.push_str("</ul></section></div></main>");
        Ok::<_, Refused>(out)
    })
}

// ---- the accounts ---------------------------------------------------------------------------------------------

/// The accounts, then the rooms with the counts the hub keeps of each.
pub fn accounts(app: &App) -> Result<String, Refused> {
    const SHOWN: i64 = 500;
    app.db.read(|c| {
        let one = |sql: &str| -> rusqlite::Result<i64> { c.query_row(sql, [], |r| r.get(0)) };
        let (accounts, rooms) = (one("SELECT count(*) FROM accounts")?, one("SELECT count(*) FROM rooms")?);
        let mut out = format!(
            "<main class=\"page\"><div class=\"head\"><h1>Accounts</h1><span class=\"muted\">{accounts} account{} · {rooms} room{} · e-mail addresses masked</span></div>",
            if accounts == 1 { "" } else { "s" },
            if rooms == 1 { "" } else { "s" },
        );
        out.push_str(&format!(
            "<section class=\"card\"><h3>Accounts <span class=\"count\">{accounts}</span></h3><div class=\"scroll\"><table class=\"grid\"><thead><tr>\
<th>Account</th><th>E-mail</th><th>Signs in with</th><th class=\"n\">Passkeys</th><th class=\"n\">Rooms</th><th>Created</th><th>Changed</th><th>Last passkey use</th></tr></thead><tbody>"
        ));
        let mut s = c.prepare(
            "SELECT a.account_id, a.email, a.auth_hash IS NOT NULL, a.created_at, a.updated_at,
               (SELECT count(*) FROM passkeys p WHERE p.account_id = a.account_id),
               (SELECT count(*) FROM account_rooms ar WHERE ar.account_id = a.account_id),
               (SELECT max(p.last_used_at) FROM passkeys p WHERE p.account_id = a.account_id)
             FROM accounts a ORDER BY a.created_at DESC LIMIT ?1",
        )?;
        let mut rows = s.query([SHOWN])?;
        let mut any = false;
        while let Some(r) = rows.next()? {
            any = true;
            let email: Option<String> = r.get(1)?;
            let password: bool = r.get(2)?;
            let passkeys: i64 = r.get(5)?;
            let ways: Vec<&str> = [(password, "password"), (passkeys > 0, "passkey")]
                .into_iter()
                .filter_map(|(on, name)| on.then_some(name))
                .collect();
            let used: Option<i64> = r.get(7)?;
            out.push_str(&format!(
                "<tr><td><code>#{}</code></td><td><code>{}</code></td><td>{}</td><td class=\"n\">{passkeys}</td><td class=\"n\">{}</td>\
<td class=\"when\">{}</td><td class=\"when\">{}</td><td class=\"when\">{}</td></tr>",
                r.get::<_, i64>(0)?,
                match email.as_deref() {
                    Some(e) => esc(&mask_email(e)),
                    None => "<span class=\"faint\">none</span>".into(),
                },
                if ways.is_empty() { "<span class=\"faint\">nothing yet</span>".into() } else { ways.join(", ") },
                r.get::<_, i64>(6)?,
                when(r.get(3)?),
                when(r.get(4)?),
                used.map(when).unwrap_or_else(|| "<span class=\"faint\">never</span>".into()),
            ));
        }
        if !any {
            out.push_str("<tr><td colspan=\"8\" class=\"faint\">No accounts yet.</td></tr>");
        }
        out.push_str("</tbody></table></div>");
        if accounts > SHOWN {
            out.push_str(&format!("<p class=\"note\">The newest {SHOWN} of {accounts} accounts.</p>"));
        }
        out.push_str("</section>");

        // ---- rooms, with what the hub counts in each
        out.push_str(&format!(
            "<section class=\"card\"><h3>Rooms <span class=\"count\">{rooms}</span></h3><div class=\"scroll\"><table class=\"grid\"><thead><tr>\
<th>Room</th><th>Account</th><th>Founded</th><th class=\"n\">Human</th><th class=\"n\">Agent</th><th class=\"n\">Helper</th>\
<th class=\"n\">Sessions live</th><th class=\"n\">Archived</th><th class=\"n\">Changes</th><th class=\"n\">Envelopes</th><th class=\"n\">Files</th>\
<th class=\"n\">of quota</th><th class=\"n\">Push</th><th>Last write</th></tr></thead><tbody>"
        ));
        let mut s = c.prepare(
            "SELECT r.room_id, r.founded_at, r.change, r.file_bytes,
               (SELECT ar.account_id FROM account_rooms ar WHERE ar.room_id = r.room_id),
               (SELECT count(*) FROM devices d WHERE d.room_id = r.room_id AND d.removed_epoch IS NULL AND d.role = 'human'),
               (SELECT count(*) FROM devices d WHERE d.room_id = r.room_id AND d.removed_epoch IS NULL AND d.role = 'agent'),
               (SELECT count(*) FROM devices d WHERE d.room_id = r.room_id AND d.removed_epoch IS NULL AND d.role = 'helper'),
               (SELECT count(*) FROM groups g WHERE g.room_id = r.room_id AND g.kind != 'room' AND g.live = 1),
               (SELECT count(*) FROM groups g WHERE g.room_id = r.room_id AND g.kind != 'room' AND g.live = 0),
               (SELECT count(*) FROM envelopes e WHERE e.room_id = r.room_id),
               (SELECT count(*) FROM push_subscriptions p WHERE p.room_id = r.room_id),
               (SELECT max(e.received_at) FROM envelopes e WHERE e.room_id = r.room_id AND e.change = (SELECT max(change) FROM envelopes WHERE room_id = r.room_id))
             FROM rooms r ORDER BY r.founded_at DESC LIMIT ?1",
        )?;
        let mut rows = s.query([SHOWN])?;
        let mut any = false;
        while let Some(r) = rows.next()? {
            any = true;
            let room: Vec<u8> = r.get(0)?;
            let file_bytes: i64 = r.get(3)?;
            let account: Option<i64> = r.get(4)?;
            let last: Option<i64> = r.get(12)?;
            out.push_str(&format!(
                "<tr><td><code>{}</code></td><td>{}</td><td class=\"when\">{}</td><td class=\"n\">{}</td><td class=\"n\">{}</td><td class=\"n\">{}</td>\
<td class=\"n\">{}</td><td class=\"n\">{}</td><td class=\"n\">{}</td><td class=\"n\">{}</td><td class=\"n\">{}</td><td class=\"n\">{:.1} %</td><td class=\"n\">{}</td><td class=\"when\">{}</td></tr>",
                esc(&short(&room)),
                account.map_or("<span class=\"faint\">none</span>".into(), |a| format!("<code>#{a}</code>")),
                when(r.get(1)?),
                r.get::<_, i64>(5)?,
                r.get::<_, i64>(6)?,
                r.get::<_, i64>(7)?,
                r.get::<_, i64>(8)?,
                r.get::<_, i64>(9)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(10)?,
                size(file_bytes.max(0) as u64),
                file_bytes as f64 * 100.0 / app.cfg.room_quota.max(1) as f64,
                r.get::<_, i64>(11)?,
                last.map(when).unwrap_or_else(|| "<span class=\"faint\">never</span>".into()),
            ));
        }
        if !any {
            out.push_str("<tr><td colspan=\"14\" class=\"faint\">No rooms yet.</td></tr>");
        }
        out.push_str("</tbody></table></div>");
        if rooms > SHOWN {
            out.push_str(&format!("<p class=\"note\">The newest {SHOWN} of {rooms} rooms.</p>"));
        }
        out.push_str("<p class=\"note\">No content: the hub has none. A room is one person's whole board; its account is shown by number.</p></section></main>");
        Ok::<_, Refused>(out)
    })
}

// ---- the tables -----------------------------------------------------------------------------------------------

/// The table a request names, if it is one of the list (the page never puts a name from a request into SQL).
pub fn table_named(name: &str) -> Option<&'static str> {
    TABLES.iter().map(|(_, t, _, _)| *t).find(|t| *t == name)
}

/// name, declared type, part of the primary key
fn columns(c: &Connection, table: &str) -> rusqlite::Result<Vec<(String, String, bool)>> {
    let mut s = c.prepare(&format!("PRAGMA table_info({table})"))?;
    let rows = s.query_map([], |r| {
        Ok((
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, i64>(5)? > 0,
        ))
    })?;
    rows.collect()
}

fn mark(how: &str) -> String {
    match how {
        "sealed" => format!("<span class=\"cm cm-e2e\">{LOCK}<span>sealed</span></span>"),
        "length only" => "<span class=\"faint\">length only</span>".into(),
        how => format!("<span class=\"cm cm-plain\">{EYE}<span>{how}</span></span>"),
    }
}

/// One value of a row, as `shown_as` says.
fn cell(table: &str, column: &str, value: ValueRef) -> String {
    match value {
        ValueRef::Null => "<span class=\"faint\">null</span>".into(),
        ValueRef::Integer(n) if is_time(column) && n > 100_000_000_000 => when(n),
        ValueRef::Integer(n) => n.to_string(),
        ValueRef::Real(x) => format!("{x}"),
        ValueRef::Text(t) if WORDS.contains(&column) && t.len() <= 40 => {
            esc(&String::from_utf8_lossy(t))
        }
        ValueRef::Text(t) => format!("<span class=\"faint\">{} chars</span>", t.len()),
        ValueRef::Blob(b) if SEALED.contains(&(table, column)) => {
            format!(
                "<span class=\"cm cm-e2e\">{LOCK}<span>{}</span></span>",
                size(b.len() as u64)
            )
        }
        ValueRef::Blob(b) if names_something(column) && !b.is_empty() => {
            format!(
                "<code>{}</code>",
                if b.len() > 4 {
                    format!("{}…", short(b))
                } else {
                    hex(b)
                }
            )
        }
        ValueRef::Blob(b) => format!("<span class=\"faint\">{}</span>", size(b.len() as u64)),
    }
}

/// The tables: a side list of every table, each opened for its columns and number of rows, and the chosen one
/// (or the whole list, classified) beside it.
pub fn tables(app: &App, chosen: Option<&str>) -> Result<String, Refused> {
    const ROWS: usize = 10;
    app.db.read(|c| {
        let one = |sql: &str| -> rusqlite::Result<i64> { c.query_row(sql, [], |r| r.get(0)) };
        let mut counts = Vec::with_capacity(TABLES.len());
        for (_, table, _, _) in TABLES {
            counts.push(one(&format!("SELECT count(*) FROM {table}"))?);
        }

        // ---- the side list
        let mut side = String::from("<nav class=\"tree\" aria-label=\"Tables\">");
        side.push_str(&format!(
            "<a class=\"node all{}\" href=\"/tables\"><span>All tables</span><span class=\"count\">{}</span></a>",
            if chosen.is_none() { " on" } else { "" },
            TABLES.len()
        ));
        let mut group = "";
        for ((g, table, _, sealed), n) in TABLES.iter().zip(&counts) {
            if *g != group {
                group = g;
                side.push_str(&format!("<div class=\"grp\">{g}</div>"));
            }
            let open = chosen == Some(*table);
            side.push_str(&format!(
                "<details{}><summary><span class=\"name\">{}{table}</span><span class=\"count\">{n}</span></summary><ul class=\"cols-list\">",
                if open { " open class=\"on\"" } else { "" },
                if sealed.is_empty() { String::new() } else { format!("<span class=\"cm cm-e2e\" title=\"holds sealed content\">{LOCK}</span>") },
            ));
            for (name, kind, key) in columns(c, table)? {
                let how = shown_as(table, &name, &kind);
                side.push_str(&format!(
                    "<li><span>{}{}</span><span class=\"faint\">{}</span></li>",
                    if how == "sealed" { format!("<span class=\"cm cm-e2e\">{LOCK}</span>") } else { String::new() },
                    if key { format!("<b>{}</b>", esc(&name)) } else { esc(&name) },
                    esc(&kind.to_lowercase())
                ));
            }
            side.push_str(&format!("<li class=\"open\"><a href=\"/tables?t={table}\">Open {table} →</a></li></ul></details>"));
        }
        side.push_str("</nav>");

        // ---- the chosen table, or all of them
        let mut main = String::from("<main class=\"pane\">");
        match chosen {
            None => {
                main.push_str(&format!(
                    "<div class=\"head\"><h1>Tables</h1><span class=\"muted\">{} tables · what the hub reads in each and what lies in it sealed</span></div>\
<section class=\"card\"><p class=\"legend\"><span class=\"cm cm-plain\">{EYE}The hub reads</span><span class=\"cm cm-e2e\">{LOCK}Sealed: the hub cannot read</span></p>\
<div class=\"scroll\"><table class=\"grid\"><thead><tr><th>Table</th><th class=\"n\">Rows</th><th>The hub reads</th><th>Sealed</th></tr></thead><tbody>",
                    TABLES.len()
                ));
                for ((_, table, reads, sealed), n) in TABLES.iter().zip(&counts) {
                    main.push_str(&format!(
                        "<tr><td><a href=\"/tables?t={table}\"><code>{table}</code></a></td><td class=\"n\">{n}</td><td><span class=\"cm cm-plain\">{EYE}<span>{}</span></span></td><td>{}</td></tr>",
                        esc(reads),
                        if sealed.is_empty() {
                            "<span class=\"faint\">nothing</span>".to_string()
                        } else {
                            format!("<span class=\"cm cm-e2e\">{LOCK}<span>{}</span></span>", esc(sealed))
                        }
                    ));
                }
                main.push_str("</tbody></table></div>");
                // a table the list does not know is said, not hidden
                let mut s = c.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")?;
                let unknown: Vec<String> = s
                    .query_map([], |r| r.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?
                    .into_iter()
                    .filter(|name| name != "login_counts" && table_named(name).is_none())
                    .collect();
                if !unknown.is_empty() {
                    main.push_str(&format!("<p class=\"err\">Not classified yet: <code>{}</code></p>", esc(&unknown.join(", "))));
                }
                main.push_str("</section>");
            }
            Some(table) => {
                let (i, (group, _, reads, sealed)) = TABLES
                    .iter()
                    .enumerate()
                    .find(|(_, t)| t.1 == table)
                    .expect("a table of the list");
                let n = counts[i];
                main.push_str(&format!(
                    "<div class=\"head\"><h1><code class=\"big\">{table}</code></h1><span class=\"muted\">{group} · {n} row{}</span></div>\
<section class=\"card\"><dl class=\"kv\"><dt>The hub reads</dt><dd><span class=\"cm cm-plain\">{EYE}<span>{}</span></span></dd><dt>Sealed</dt><dd>{}</dd></dl></section>",
                    if n == 1 { "" } else { "s" },
                    esc(reads),
                    if sealed.is_empty() {
                        "<span class=\"faint\">nothing</span>".to_string()
                    } else {
                        format!("<span class=\"cm cm-e2e\">{LOCK}<span>{}</span></span>", esc(sealed))
                    }
                ));
                let cols = columns(c, table)?;
                main.push_str(&format!(
                    "<section class=\"card\"><h3>Columns <span class=\"count\">{}</span></h3><div class=\"scroll\"><table class=\"grid\"><thead><tr><th>Column</th><th>Type</th><th>Key</th><th>In the rows below</th></tr></thead><tbody>",
                    cols.len()
                ));
                for (name, kind, key) in &cols {
                    main.push_str(&format!(
                        "<tr><td><code>{}</code></td><td class=\"muted\">{}</td><td>{}</td><td>{}</td></tr>",
                        esc(name),
                        esc(&kind.to_lowercase()),
                        if *key { "primary" } else { "" },
                        mark(shown_as(table, name, kind))
                    ));
                }
                main.push_str("</tbody></table></div></section>");

                main.push_str(&format!("<section class=\"card\"><h3>Rows <span class=\"count\">{}</span></h3>", n.min(ROWS as i64)));
                if !sealed.is_empty() {
                    main.push_str("<p class=\"muted\">Not shown: this table holds sealed content. Its columns and its number of rows are all the page says of it.</p>");
                } else if PRIVATE.contains(&table) {
                    main.push_str("<p class=\"muted\">Not shown: this table holds who signs in from where, or where pushes go. Its columns and its number of rows are all the page says of it.</p>");
                } else if n == 0 {
                    main.push_str("<p class=\"muted\">No rows.</p>");
                } else {
                    main.push_str("<div class=\"scroll\"><table class=\"grid\"><thead><tr>");
                    for (name, _, _) in &cols {
                        main.push_str(&format!("<th>{}</th>", esc(name)));
                    }
                    main.push_str("</tr></thead><tbody>");
                    let mut s = c.prepare(&format!("SELECT * FROM {table} LIMIT {ROWS}"))?;
                    let mut rows = s.query([])?;
                    while let Some(r) = rows.next()? {
                        main.push_str("<tr>");
                        for (k, (name, _, _)) in cols.iter().enumerate() {
                            main.push_str(&format!("<td>{}</td>", cell(table, name, r.get_ref(k)?)));
                        }
                        main.push_str("</tr>");
                    }
                    main.push_str("</tbody></table></div>");
                    main.push_str(&format!(
                        "<p class=\"note\">The first {ROWS} rows at most. Ids by their first four bytes, times in UTC, any other bytes and text by their length only.</p>"
                    ));
                }
                main.push_str("</section>");
            }
        }
        main.push_str("</main>");
        Ok::<_, Refused>(format!(
            "<input type=\"checkbox\" id=\"tt\" aria-label=\"Show the tables\"><label class=\"treetoggle\" for=\"tt\"><span>Tables: <b>{}</b></span></label>\
<div class=\"data\">{side}{main}</div>",
            chosen.unwrap_or("all")
        ))
    })
}
