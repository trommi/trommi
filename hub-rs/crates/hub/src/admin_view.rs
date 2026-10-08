//! The HTML of the read-only admin page (a port of hub/admin-view.mjs): the overview (tiles, charts) and the data
//! browser (tree, table, row detail). Ciphertext, signed blobs and secrets are shown as size + first 16 bytes hex and
//! can be neither filtered, sorted nor searched; the encrypted body is never decoded; the cleartext envelope header is.

use crate::admin_assets::{BELL, CSS, JS};
use crate::server::Hub;
use parking_lot::Mutex;
use rusqlite::types::Value as V;
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub const PAGE_SIZE: i64 = 50;
const COUNT_CAP: i64 = 10000;

// ---- the source: hub.db read-only, metrics, the data dir ----------------------------------------

pub struct Source {
    pub db_path: PathBuf,
    pub data_dir: Option<PathBuf>,
    pub hub: Option<Arc<Hub>>,
    conn: Mutex<Option<Connection>>,
    cache: Mutex<HashMap<String, (i64, CacheVal)>>,
}
#[derive(Clone)]
enum CacheVal {
    Count(Option<i64>),
    Rows(Vec<(V, i64)>),
    Lines(Vec<(V, V, i64)>),
    Tables(Vec<Table>),
}
impl Source {
    pub fn new(db_path: PathBuf, data_dir: Option<PathBuf>, hub: Option<Arc<Hub>>) -> Source { Source { db_path, data_dir, hub, conn: Mutex::new(None), cache: Mutex::new(HashMap::new()) } }
    /// The read-only connection, opened when hub.db exists.
    pub fn db(&self) -> Option<parking_lot::MappedMutexGuard<'_, Connection>> {
        let mut g = self.conn.lock();
        if g.is_none() {
            if !self.db_path.exists() {
                return None;
            }
            let c = Connection::open_with_flags(&self.db_path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX).ok()?;
            let _ = c.execute_batch("PRAGMA busy_timeout = 5000");
            *g = Some(c);
        }
        Some(parking_lot::MutexGuard::map(g, |c| c.as_mut().unwrap()))
    }
    fn cached(&self, key: &str, ms: i64, f: impl FnOnce() -> CacheVal) -> CacheVal {
        let t = crate::util::wall();
        if let Some((until, v)) = self.cache.lock().get(key) {
            if *until > t {
                return v.clone();
            }
        }
        let v = f();
        let mut c = self.cache.lock();
        if c.len() > 5000 {
            c.clear();
        }
        c.insert(key.to_string(), (t + ms, v.clone()));
        v
    }
}

// ---- small helpers ----------------------------------------------------------------------------

pub fn esc(v: &str) -> String {
    let mut s = String::with_capacity(v.len());
    for c in v.chars() {
        match c {
            '&' => s.push_str("&amp;"),
            '<' => s.push_str("&lt;"),
            '>' => s.push_str("&gt;"),
            '"' => s.push_str("&quot;"),
            '\'' => s.push_str("&#39;"),
            c => s.push(c),
        }
    }
    s
}
fn quote_ident(n: &str) -> String { format!("\"{}\"", n.replace('"', "\"\"")) }
/// OPAQUE_COLUMN of admin-view.mjs.
pub fn is_opaque(c: &str) -> bool {
    matches!(c, "encrypted_body" | "key_sealed" | "key_back_link" | "envelope_header" | "envelope_nonce" | "envelope_signature" | "subscription" | "endpoint" | "escrow_id" | "key_escrow" | "email")
        || c.starts_with("access_token")
        || c.starts_with("signed_")
        || c.ends_with("_signature")
        || c.contains("_secret")
        || c.ends_with("_hash")
        || c.ends_with("_salt")
        || c.ends_with("_wrapped")
}
fn is_device_column(c: &str) -> bool { c == "device_id" || c.ends_with("_device_id") }
/// A number as JavaScript's String(n) prints it.
fn js_num(f: f64) -> String {
    if f.is_nan() {
        return "NaN".into();
    }
    if f.fract() == 0.0 && f.abs() < 1e21 {
        return format!("{}", f as i64);
    }
    format!("{f}")
}
fn plain(v: &V) -> String {
    match v {
        V::Null => "null".into(),
        V::Integer(i) => i.to_string(),
        V::Real(f) => js_num(*f),
        V::Text(t) => t.clone(),
        V::Blob(b) => zcrypto::hex(b),
    }
}
fn is_num(v: &V) -> Option<f64> {
    match v {
        V::Integer(i) => Some(*i as f64),
        V::Real(f) => Some(*f),
        _ => None,
    }
}
/// JavaScript's string slice by UTF-16 units (whole characters).
fn js_slice(s: &str, n: usize) -> String {
    let mut out = String::new();
    let mut units = 0;
    for c in s.chars() {
        units += c.len_utf16();
        if units > n {
            break;
        }
        out.push(c);
    }
    out
}
fn opaque_bytes(v: &V) -> Vec<u8> {
    if let V::Blob(b) = v {
        return b.clone();
    }
    let text = plain(v);
    if !text.is_empty() && text.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-') {
        return crate::push::b64_lenient(&text);
    }
    text.into_bytes()
}

/// One stored value as HTML: NULL, opaque (size + 16 bytes hex), a device id in hex, or escaped text (300 chars).
pub fn render_cell(column: &str, value: &V) -> String {
    match value {
        V::Null => "<span class=\"null\">NULL</span>".into(),
        V::Blob(b) if is_device_column(column) && !is_opaque(column) && b.len() <= 64 => format!("<span class=\"id\">{}</span>", zcrypto::hex(b)),
        v if matches!(v, V::Blob(_)) || is_opaque(column) => {
            let bytes = opaque_bytes(v);
            let hex = zcrypto::hex(&bytes[..bytes.len().min(16)]);
            format!("<span class=\"opaque\">{} B · {}{}</span>", bytes.len(), hex, if bytes.len() > 16 { "…" } else { "" })
        }
        v => {
            let text = plain(v);
            if text.encode_utf16().count() > 300 { esc(&format!("{}…", js_slice(&text, 300))) } else { esc(&text) }
        }
    }
}

pub fn format_bytes(n: f64) -> String {
    if !n.is_finite() {
        return "?".into();
    }
    if n.abs() < 1024.0 {
        return format!("{} B", js_round(n));
    }
    let units = ["KiB", "MiB", "GiB", "TiB"];
    let mut v = n;
    let mut i: i32 = -1;
    loop {
        v /= 1024.0;
        i += 1;
        if !(v.abs() >= 1024.0 && (i as usize) < units.len() - 1) {
            break;
        }
    }
    format!("{} {}", to_fixed(v, if v < 10.0 { 1 } else { 0 }), units[i as usize])
}
/// Math.round
fn js_round(n: f64) -> String { js_num((n + 0.5).floor()) }
/// Number.prototype.toFixed (round half up on the decimal expansion).
pub fn to_fixed(v: f64, d: usize) -> String {
    let s = format!("{:.*}", d, v);
    // Rust rounds an exact tie to even; JavaScript picks the larger n. Correct the exact ties.
    let scale = 10f64.powi(d as i32);
    let scaled = v * scale;
    if (scaled - scaled.trunc()).abs() == 0.5 && (scaled / scale) == v {
        let up = (scaled + if v >= 0.0 { 0.5 } else { -0.5 }).trunc() / scale;
        return format!("{:.*}", d, up);
    }
    s
}
/// toLocaleString('en-US', { maximumFractionDigits: digits }): grouping commas, half-expand rounding.
pub fn fmt_num(n: f64, digits: usize) -> String {
    if !n.is_finite() {
        return "–".into();
    }
    let neg = n < 0.0;
    let s = format!("{}", n.abs());
    let (int, frac) = match s.split_once('.') {
        Some((a, b)) => (a.to_string(), b.to_string()),
        None => (s.clone(), String::new()),
    };
    // round the shortest decimal form, half away from zero
    let mut digits_all: Vec<u8> = int.bytes().chain(frac.bytes()).map(|c| c - b'0').collect();
    let int_len = int.len();
    let keep = int_len + digits;
    if frac.len() > digits {
        let round_up = digits_all[keep] >= 5;
        digits_all.truncate(keep);
        if round_up {
            let mut i = keep;
            loop {
                if i == 0 {
                    digits_all.insert(0, 1);
                    break;
                }
                i -= 1;
                if digits_all[i] == 9 {
                    digits_all[i] = 0;
                } else {
                    digits_all[i] += 1;
                    break;
                }
            }
        }
    }
    let new_int_len = digits_all.len() - digits.min(frac.len());
    let (ip, fp) = digits_all.split_at(new_int_len);
    let ip: String = ip.iter().map(|d| (b'0' + d) as char).collect();
    let mut fp: String = fp.iter().map(|d| (b'0' + d) as char).collect();
    while fp.ends_with('0') {
        fp.pop();
    }
    let ip = if ip.is_empty() { "0".to_string() } else { ip.trim_start_matches('0').to_string() };
    let ip = if ip.is_empty() { "0".to_string() } else { ip };
    let mut grouped = String::new();
    for (i, c) in ip.chars().enumerate() {
        if i > 0 && (ip.len() - i) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(c);
    }
    let zero = grouped == "0" && fp.is_empty();
    format!("{}{}{}", if neg && !zero { "-" } else if neg { "-" } else { "" }, grouped, if fp.is_empty() { String::new() } else { format!(".{fp}") })
}
fn short(id: &str, n: usize) -> String { if id.chars().count() > n + 2 { format!("{}…", id.chars().take(n).collect::<String>()) } else { id.to_string() } }

// ---- time in ADMIN_TZ (Europe/Berlin: CET/CEST by the EU rule; UTC) ------------------------------

fn last_sunday(y: i64, m: i64) -> i64 {
    // days since epoch of the last Sunday of month m of year y
    let first_next = days_from_civil(if m == 12 { y + 1 } else { y }, if m == 12 { 1 } else { m + 1 }, 1);
    let last = first_next - 1;
    let wd = (last + 4).rem_euclid(7); // 1970-01-01 was a Thursday (4); 0 = Sunday
    last - wd
}
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}
fn tz_offset_ms(utc_ms: i64) -> i64 {
    let tz = std::env::var("ADMIN_TZ").unwrap_or_else(|_| "Europe/Berlin".into());
    if tz == "UTC" || tz == "Etc/UTC" || tz == "GMT" {
        return 0;
    }
    let y = crate::util::civil(utc_ms.div_euclid(1000)).0;
    let start = last_sunday(y, 3) * 86400000 + 3600000;
    let end = last_sunday(y, 10) * 86400000 + 3600000;
    if utc_ms >= start && utc_ms < end { 7200000 } else { 3600000 }
}
fn local(ms: i64) -> (i64, i64, i64, i64, i64, i64, i64) {
    let l = ms + tz_offset_ms(ms);
    let (y, mo, d, h, mi, s) = crate::util::civil(l.div_euclid(1000));
    let wd = (l.div_euclid(86400000) + 4).rem_euclid(7);
    (y, mo, d, h, mi, s, wd)
}
const WEEKDAYS: [&str; 7] = ["So.", "Mo.", "Di.", "Mi.", "Do.", "Fr.", "Sa."];
fn date_fmt(ms: i64) -> String {
    let (y, mo, d, h, mi, s, _) = local(ms);
    format!("{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}:{s:02}")
}
fn time_fmt(ms: i64) -> String {
    let (_, _, _, h, mi, _, _) = local(ms);
    format!("{h:02}:{mi:02}")
}
fn day_fmt(ms: i64) -> String {
    let (_, mo, d, _, _, _, wd) = local(ms);
    format!("{}, {d:02}.{mo:02}.", WEEKDAYS[wd as usize])
}
fn day_time_fmt(ms: i64) -> String {
    let (_, _, _, h, mi, _, wd) = local(ms);
    format!("{}, {h:02}:{mi:02}", WEEKDAYS[wd as usize])
}
fn is_time(column: &str, v: &V) -> bool {
    (column.ends_with("_at") || column == "sent_at" || column == "time") && is_num(v).is_some_and(|n| n > 1e11 && n < 1e14)
}
fn file_size(p: &Path) -> f64 { std::fs::metadata(p).map(|m| m.len() as f64).unwrap_or(0.0) }
fn dir_size(dir: &Path, budget: &mut i64) -> f64 {
    let mut total = 0.0;
    let Ok(list) = std::fs::read_dir(dir) else { return 0.0 };
    for e in list.flatten() {
        *budget -= 1;
        if *budget < 0 {
            break;
        }
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_dir() {
            total += dir_size(&e.path(), budget);
        } else if ft.is_file() {
            total += file_size(&e.path());
        }
    }
    total
}

// ---- page frame ----------------------------------------------------------------------------------

fn sha(t: &str) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(zcrypto::prim::sha256(&[t.as_bytes()]))
}
pub fn csp() -> String { format!("default-src 'none'; style-src 'sha256-{}'; script-src 'sha256-{}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'", sha(CSS), sha(JS)) }
fn head(title: &str) -> String {
    format!("<!doctype html><html lang=\"de\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta name=\"color-scheme\" content=\"light dark\"><title>{}</title><style>{CSS}</style></head><body>", esc(title))
}
fn foot() -> String { format!("<script>{JS}</script></body></html>") }
pub fn top_bar(login: &str, csrf: &str, on: &str) -> String {
    let tab = |href: &str, label: &str, key: &str| format!("<a href=\"{href}\"{}>{label}</a>", if on == key { " class=\"on\"" } else { "" });
    format!(
        "<header class=\"top\"><span class=\"brand\">{BELL}<b>Trommi</b> <small>hub admin</small></span><nav>{}{}{}{}</nav>\n<div class=\"who\"><span class=\"login-name\">{}</span><form method=\"post\" action=\"/logout\"><input type=\"hidden\" name=\"csrf\" value=\"{}\"><button>Abmelden</button></form></div></header>",
        tab("/", "Übersicht", "overview"),
        tab("/data", "Daten", "data"),
        tab("/test-accounts", "Test accounts", "tests"),
        tab("/password", "Passwort ändern", "password"),
        esc(login),
        esc(csrf)
    )
}
pub fn render_login_page(login: &str, message: &str) -> String {
    format!(
        "{}<div class=\"login\"><h1>Trommi hub admin</h1><p class=\"muted\">Tailscale login: <span class=\"mono\">{}</span></p>{}\n<form method=\"post\" action=\"/login\"><label>Admin password <input type=\"password\" name=\"password\" autocomplete=\"current-password\" required autofocus></label><button class=\"primary\">Anmelden</button></form></div></body></html>",
        head("Trommi hub admin"),
        esc(login),
        if message.is_empty() { String::new() } else { format!("<p class=\"err\">{}</p>", esc(message)) }
    )
}
pub fn render_password_page(login: &str, csrf: &str, message: &str, min: usize) -> String {
    format!(
        "{}{}<main class=\"page\"><div class=\"head\"><h1>Passwort ändern</h1></div>{}\n<form class=\"form card\" method=\"post\" action=\"/password\"><input type=\"hidden\" name=\"csrf\" value=\"{}\">\n<label>Current password <input type=\"password\" name=\"current\" autocomplete=\"current-password\" required></label>\n<label>New password (at least {min} characters) <input type=\"password\" name=\"new1\" autocomplete=\"new-password\" minlength=\"{min}\" required></label>\n<label>New password again <input type=\"password\" name=\"new2\" autocomplete=\"new-password\" minlength=\"{min}\" required></label>\n<div><button class=\"primary\">change</button> <span class=\"muted\">signs out every admin session</span></div></form></main></body></html>",
        head("Trommi hub admin"),
        top_bar(login, csrf, "password"),
        if message.is_empty() { String::new() } else { format!("<p class=\"err\">{}</p>", esc(message)) },
        esc(csrf)
    )
}

// ---- schema ---------------------------------------------------------------------------------------

#[derive(Clone)]
pub struct Table {
    pub name: String,
    pub columns: Vec<(String, String)>,
    pub names: HashSet<String>,
    pub rowid: bool,
    pub pk: Vec<String>,
}
fn table_info(src: &Source, c: &Connection) -> Vec<Table> {
    let v = src.cached("schema", 5000, || {
        let names: Vec<String> = c.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").and_then(|mut s| s.query_map([], |r| r.get(0))?.collect()).unwrap_or_default();
        CacheVal::Tables(
            names
                .into_iter()
                .map(|name| {
                    let cols: Vec<(String, String, i64)> = c
                        .prepare(&format!("PRAGMA table_info({})", quote_ident(&name)))
                        .and_then(|mut s| s.query_map([], |r| Ok((r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?.unwrap_or_default(), r.get::<_, i64>(5)?)))?.collect())
                        .unwrap_or_default();
                    let rowid = c.prepare(&format!("SELECT rowid FROM {} LIMIT 0", quote_ident(&name))).is_ok();
                    let mut pk: Vec<(i64, String)> = cols.iter().filter(|c| c.2 > 0).map(|c| (c.2, c.0.clone())).collect();
                    pk.sort();
                    Table { names: cols.iter().map(|c| c.0.clone()).collect(), columns: cols.into_iter().map(|c| (c.0, c.1)).collect(), rowid, pk: pk.into_iter().map(|p| p.1).collect(), name }
                })
                .collect(),
        )
    });
    match v {
        CacheVal::Tables(t) => t,
        _ => vec![],
    }
}
fn total_count(src: &Source, c: &Connection, table: &str) -> Option<i64> {
    match src.cached(&format!("count:{table}"), 10000, || CacheVal::Count(c.query_row(&format!("SELECT count(*) AS n FROM {}", quote_ident(table)), [], |r| r.get(0)).ok())) {
        CacheVal::Count(n) => n,
        _ => None,
    }
}
fn col_type(t: &Table, col: &str) -> String { t.columns.iter().find(|c| c.0 == col).map(|c| c.1.to_uppercase()).unwrap_or_default() }
/// A filter value bound as the column stores it: bytes for BLOB columns (hex), numbers for INTEGER columns.
fn bind_for(t: &Table, col: &str, value: &str) -> V {
    let ty = col_type(t, col);
    if ty.contains("BLOB") && !value.is_empty() && value.len() % 2 == 0 && value.bytes().all(|c| c.is_ascii_hexdigit()) {
        return V::Blob(zcrypto::unhex(&value.to_lowercase()).unwrap_or_default());
    }
    if ty.contains("INT") && is_int15(value) {
        return V::Integer(value.parse().unwrap());
    }
    V::Text(value.into())
}
fn is_int15(v: &str) -> bool {
    let d = v.strip_prefix('-').unwrap_or(v);
    !d.is_empty() && d.len() <= 15 && d.bytes().all(|c| c.is_ascii_digit())
}

// ---- state --------------------------------------------------------------------------------------

#[derive(Clone, Default)]
pub struct State {
    pub room: String,
    pub table: Option<Table>,
    pub filters: Vec<(String, String)>,
    pub key: Vec<(String, String)>,
    pub sort: String,
    pub dir: String,
    pub q: String,
    pub page: i64,
    pub tables: Vec<Table>,
}
fn room_ok(v: &str) -> bool { !v.is_empty() && v.len() <= 64 && v.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f')) }
fn parse_state(params: &[(String, String)], tables: &[Table]) -> State {
    let get = |k: &str| params.iter().find(|(a, _)| a == k).map(|(_, v)| v.clone()).unwrap_or_default();
    let room = [get("room"), get("room_id")].into_iter().find(|v| room_ok(v)).unwrap_or_default();
    let tname = if get("t").is_empty() { get("table") } else { get("t") };
    let mut table = tables.iter().find(|t| t.name == tname).cloned();
    let mut filters: Vec<(String, String)> = vec![];
    let mut key = vec![];
    if let Some(t) = &table {
        for (k, v) in params {
            if v.encode_utf16().count() > 256 {
                continue;
            }
            if let Some(col) = k.strip_prefix("f.") {
                if t.names.contains(col) && !is_opaque(col) && col != "room_id" && !filters.iter().any(|(c, _)| c == col) {
                    filters.push((col.into(), v.clone()));
                }
            } else if k == "rowid" && t.rowid && !v.is_empty() && v.len() <= 15 && v.bytes().all(|c| c.is_ascii_digit()) {
                key.push(("rowid".to_string(), v.clone()));
            } else if let Some(col) = k.strip_prefix("k.") {
                if !t.rowid && t.pk.iter().any(|p| p == col) && !is_opaque(col) {
                    key.push((k.clone(), v.clone()));
                }
            }
        }
    }
    if table.is_none() && room.is_empty() {
        table = tables.iter().find(|t| t.name == "envelopes").cloned().or_else(|| tables.first().cloned());
    }
    if table.is_none() && !room.is_empty() {
        table = tables.iter().find(|t| t.name == "envelopes").cloned();
    }
    let sort_col = get("sort");
    let sort = if table.as_ref().is_some_and(|t| t.names.contains(&sort_col)) && !is_opaque(&sort_col) { sort_col } else { String::new() };
    let dir = if get("dir") == "asc" { "asc" } else { "desc" }.to_string();
    let q: String = get("q").trim().chars().take(100).collect();
    let page = parse_int_prefix(&get("page")).unwrap_or(0).clamp(0, 1_000_000);
    State { room, table, filters, key, sort, dir, q, page, tables: tables.to_vec() }
}
/// Number.parseInt(x, 10) || 0
fn parse_int_prefix(s: &str) -> Option<i64> {
    let t = s.trim_start();
    let (neg, rest) = match t.strip_prefix('-') {
        Some(r) => (true, r),
        None => (false, t.strip_prefix('+').unwrap_or(t)),
    };
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    let n: i64 = digits.chars().take(16).collect::<String>().parse().ok()?;
    Some(if neg { -n } else { n })
}

/// application/x-www-form-urlencoded, as URLSearchParams writes it.
fn form_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => out.push(b as char),
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}
#[derive(Default, Clone)]
pub struct Href<'a> {
    pub room: &'a str,
    pub table: &'a str,
    pub filters: Vec<(String, String)>,
    pub q: &'a str,
    pub sort: &'a str,
    pub dir: &'a str,
    pub page: i64,
    pub key: Vec<(String, String)>,
}
pub fn data_href(s: &Href) -> String {
    let mut p: Vec<(String, String)> = vec![];
    let mut set = |k: String, v: String| {
        if let Some(e) = p.iter_mut().find(|(a, _)| *a == k) {
            e.1 = v;
        } else {
            p.push((k, v));
        }
    };
    if !s.room.is_empty() {
        set("room".into(), s.room.into());
    }
    if !s.table.is_empty() {
        set("t".into(), s.table.into());
    }
    for (c, v) in &s.filters {
        set(format!("f.{c}"), v.clone());
    }
    if !s.q.is_empty() {
        set("q".into(), s.q.into());
    }
    if !s.sort.is_empty() {
        set("sort".into(), s.sort.into());
        set("dir".into(), if s.dir.is_empty() { "desc".into() } else { s.dir.into() });
    }
    if s.page != 0 {
        set("page".into(), s.page.to_string());
    }
    for (k, v) in &s.key {
        set(k.clone(), v.clone());
    }
    let text = p.iter().map(|(k, v)| format!("{}={}", form_encode(k), form_encode(v))).collect::<Vec<_>>().join("&");
    format!("/data{}", if text.is_empty() { String::new() } else { format!("?{text}") })
}
fn tname(s: &State) -> &str { s.table.as_ref().map(|t| t.name.as_str()).unwrap_or("") }

fn where_of(t: &Table, s: &State) -> (String, Vec<V>) {
    let mut conds = vec![];
    let mut args = vec![];
    if !s.room.is_empty() && t.names.contains("room_id") {
        conds.push("room_id = ?".to_string());
        args.push(V::Text(s.room.clone()));
    }
    for (col, v) in &s.filters {
        conds.push(format!("{} = ?", quote_ident(col)));
        args.push(bind_for(t, col, v));
    }
    if !s.q.is_empty() {
        let mut ors = vec![];
        let like = format!("{}%", s.q.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
        for (name, ty) in &t.columns {
            if is_opaque(name) {
                continue;
            }
            let ty = ty.to_uppercase();
            if ty.contains("BLOB") {
                if is_device_column(name) && s.q.bytes().all(|c| c.is_ascii_hexdigit()) {
                    ors.push(format!("hex({}) LIKE ?", quote_ident(name)));
                    args.push(V::Text(format!("{}%", s.q.to_uppercase())));
                }
            } else if ty.contains("INT") || ty.contains("REAL") {
                if is_int15(&s.q) {
                    ors.push(format!("{} = ?", quote_ident(name)));
                    args.push(V::Integer(s.q.parse().unwrap()));
                }
            } else {
                ors.push(format!("{} LIKE ? ESCAPE '\\'", quote_ident(name)));
                args.push(V::Text(like.clone()));
            }
        }
        conds.push(if ors.is_empty() { "0".into() } else { format!("({})", ors.join(" OR ")) });
    }
    (if conds.is_empty() { String::new() } else { format!("WHERE {}", conds.join(" AND ")) }, args)
}
fn default_order(t: &Table) -> Vec<String> { if t.rowid { vec!["rowid DESC".into()] } else { t.pk.iter().map(|c| format!("{} DESC", quote_ident(c))).collect() } }

type Row = (Option<i64>, Vec<(String, V)>);
fn row_get<'a>(row: &'a Row, c: &str) -> &'a V { row.1.iter().find(|(k, _)| k == c).map(|(_, v)| v).unwrap_or(&V::Null) }
fn row_key(t: &Table, row: &Row) -> Option<Vec<(String, String)>> {
    if t.rowid {
        return Some(vec![("rowid".into(), row.0.unwrap_or(0).to_string())]);
    }
    if !t.pk.is_empty() && t.pk.iter().all(|c| !is_opaque(c)) {
        return Some(t.pk.iter().map(|c| (format!("k.{c}"), plain(row_get(row, c)))).collect());
    }
    None
}

// ---- names for stored numbers --------------------------------------------------------------------

fn kind_name(n: i64) -> Option<&'static str> {
    Some(match n {
        1 => "timeline_item",
        2 => "object_version",
        3 => "answer",
        4 => "permission_request",
        5 => "verdict",
        6 => "status",
        7 => "decide_again",
        8 => "scribble",
        _ => return None,
    })
}
fn state_name(n: i64) -> Option<&'static str> {
    Some(match n {
        1 => "open",
        2 => "answered",
        3 => "closed",
        _ => return None,
    })
}
fn urgency_name(n: i64) -> Option<&'static str> {
    Some(match n {
        0 => "low",
        1 => "normal",
        2 => "high",
        3 => "critical",
        _ => return None,
    })
}
fn tl_name(n: i64) -> Option<&'static str> {
    Some(match n {
        1 => "chat",
        2 => "scribble",
        _ => return None,
    })
}
fn enum_name(column: &str, v: &V) -> Option<&'static str> {
    let n = match v {
        V::Integer(i) => *i,
        V::Real(f) if f.fract() == 0.0 => *f as i64,
        _ => return None,
    };
    match column {
        "envelope_kind" | "first_kind" => kind_name(n),
        "timeline_kind" => tl_name(n),
        "object_state" => state_name(n),
        "urgency" => urgency_name(n),
        _ => None,
    }
}
fn filter_label(col: &str, v: &str) -> String {
    let d = v.strip_prefix('-').unwrap_or(v);
    let as_num = !d.is_empty() && d.bytes().all(|c| c.is_ascii_digit());
    let n = if as_num { v.parse::<i64>().ok().and_then(|i| enum_name(col, &V::Integer(i))) } else { None };
    format!("{col} = {}", n.map(String::from).unwrap_or_else(|| short(v, 16)))
}

fn cell_link(t: &Table, col: &str, value: &V, s: &State) -> Option<String> {
    if matches!(value, V::Null) || is_opaque(col) {
        return None;
    }
    let v = plain(value);
    let room = s.room.as_str();
    let has = |n: &str| s.tables.iter().any(|t| t.name == n);
    let link = |table: &str, f: &str| data_href(&Href { room, table, filters: vec![(f.to_string(), v.clone())], ..Default::default() });
    if col == "room_id" && room_ok(&v) {
        return Some(data_href(&Href { room: &v, table: "envelopes", ..Default::default() }));
    }
    if col == "object_id" && has("envelopes") {
        return Some(link("envelopes", "object_id"));
    }
    if col == "timeline_id" && has("envelopes") {
        return Some(link("envelopes", "timeline_id"));
    }
    if is_device_column(col) && has("envelopes") && !v.is_empty() && v.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f')) {
        return Some(link("envelopes", "sender_device_id"));
    }
    if col == "attachment_id" && t.name != "attachments" && has("attachments") {
        return Some(link("attachments", "attachment_id"));
    }
    if col == "session_id" && t.name != "session_grants" && has("session_grants") {
        return Some(link("session_grants", "session_id"));
    }
    if col == "invite_id" && t.name != "invites" && has("invites") {
        return Some(link("invites", "invite_id"));
    }
    if (col == "envelope_number" || col.ends_with("_envelope_number")) && t.name != "envelopes" && has("envelopes") && !v.is_empty() && v.bytes().all(|c| c.is_ascii_digit()) {
        return Some(link("envelopes", "envelope_number"));
    }
    None
}
fn id_like(v: &str) -> bool {
    (v.len() >= 16 && v.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f')))
        || ["card/", "session/", "desk/"].iter().any(|p| v.strip_prefix(p).is_some_and(|r| zcrypto::bytes::is_hex(r, 32)))
}
fn cell_html(t: &Table, col: &str, value: &V, s: &State) -> String {
    let mut html = render_cell(col, value);
    if !matches!(value, V::Null) && !is_opaque(col) && !matches!(value, V::Blob(_)) {
        if let Some(name) = enum_name(col, value) {
            html = format!("<span class=\"tag\" title=\"{}\">{}</span>", esc(&plain(value)), esc(name));
        } else if is_time(col, value) {
            html = format!("<span title=\"{}\">{}</span>", esc(&plain(value)), esc(&date_fmt(is_num(value).unwrap() as i64)));
        } else if let V::Text(text) = value {
            if id_like(text) {
                let shown = if text.len() > 24 {
                    let cut = text.find('/').map(|i| i as i64).unwrap_or(-1) + 13;
                    format!("{}…", &text[..cut as usize])
                } else {
                    text.clone()
                };
                html = format!("<span class=\"id\" title=\"{}\">{}</span>", esc(text), esc(&shown));
            }
        }
    } else if let V::Blob(b) = value {
        if is_device_column(col) && !is_opaque(col) && b.len() <= 64 {
            let v = zcrypto::hex(b);
            html = format!("<span class=\"id\" title=\"{v}\">{}…</span>", &v[..v.len().min(12)]);
        }
    }
    match cell_link(t, col, value, s) {
        Some(l) => format!("<a href=\"{}\">{html}</a>", esc(&l)),
        None => html,
    }
}

// ---- the tree --------------------------------------------------------------------------------------

fn node(href: &str, label: &str, count: Option<i64>, on: bool, extra: &str) -> String {
    format!(
        "<a class=\"node{}\" href=\"{}\"{extra}><span>{label}</span>{}</a>",
        if on { " on" } else { "" },
        esc(href),
        count.map(|n| format!("<span class=\"n\">{}</span>", esc(&fmt_num(n as f64, 0)))).unwrap_or_default()
    )
}
fn room_count(src: &Source, c: &Connection, room: &str, table: &str) -> Option<i64> {
    if room.is_empty() {
        return total_count(src, c, table);
    }
    match src.cached(&format!("rc:{room}:{table}"), 10000, || CacheVal::Count(c.query_row(&format!("SELECT count(*) AS n FROM {} WHERE room_id = ?", quote_ident(table)), [room], |r| r.get(0)).ok())) {
        CacheVal::Count(n) => n,
        _ => None,
    }
}
fn grouped(src: &Source, c: &Connection, room: &str, sql: &str) -> Vec<(V, i64)> {
    match src.cached(&format!("g:{room}:{sql}"), 10000, || CacheVal::Rows(c.prepare(sql).and_then(|mut s| s.query_map([room], |r| Ok((r.get::<_, V>(0)?, r.get::<_, i64>(1)?)))?.collect()).unwrap_or_default())) {
        CacheVal::Rows(r) => r,
        _ => vec![],
    }
}
fn render_tree(src: &Source, c: &Connection, s: &State) -> String {
    let tables = &s.tables;
    let has = |n: &str| tables.iter().any(|t| t.name == n);
    let filters_key = |f: &[(String, String)]| {
        let mut v: Vec<String> = f.iter().map(|(c, x)| format!("{c}={x}")).collect();
        v.sort();
        v.join("&")
    };
    let current = format!("{}|{}|{}", s.room, s.table.as_ref().map(|t| t.name.as_str()).unwrap_or("undefined"), filters_key(&s.filters));
    let is_on = |room: &str, table: &str, filters: &[(String, String)]| current == format!("{room}|{table}|{}", filters_key(filters));
    let leaf = |room: &str, table: &str, label: &str, filters: Vec<(String, String)>, count: Option<Option<i64>>| -> String {
        if !has(table) {
            return String::new();
        }
        let n = match count {
            Some(n) => n,
            None => room_count(src, c, room, table),
        };
        format!("<li>{}</li>", node(&data_href(&Href { room, table, filters: filters.clone(), ..Default::default() }), label, n, is_on(room, table, &filters), ""))
    };
    let mut out = vec!["<nav class=\"tree\" id=\"tree\" aria-label=\"Tables\">".to_string()];
    if has("rooms") {
        let mut rooms: Vec<(String, Option<i64>)> = c.prepare("SELECT room_id, last_envelope_number, founded_at FROM rooms ORDER BY last_envelope_number DESC, room_id LIMIT 300").and_then(|mut st| st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<i64>>(1)?)))?.collect()).unwrap_or_default();
        let total = total_count(src, c, "rooms").unwrap_or(0);
        out.push(format!("<div class=\"grp\">Rooms <span class=\"n\">{}</span></div>", fmt_num(total as f64, 0)));
        if total > 8 {
            out.push("<div class=\"find\"><input id=\"roomfilter\" type=\"search\" placeholder=\"Filter rooms by id\" aria-label=\"Filter rooms\" autocomplete=\"off\"></div>".into());
        }
        if !s.room.is_empty() && !rooms.iter().any(|r| r.0 == s.room) {
            rooms.insert(0, (s.room.clone(), None));
        }
        out.push("<ul>".into());
        for (rid, last) in &rooms {
            let open = *rid == s.room;
            let label = format!("<span class=\"mono\">{}</span>", esc(&short(rid, 12)));
            let href = data_href(&Href { room: rid, table: "envelopes", ..Default::default() });
            if !open {
                out.push(format!("<li data-room=\"{}\">{}</li>", esc(rid), node(&href, &label, *last, false, &format!(" title=\"{}\"", esc(rid)))));
                continue;
            }
            out.push(format!("<li data-room=\"{}\"><details open><summary>{}</summary><ul>", esc(rid), node(&href, &label, None, false, &format!(" title=\"{}\"", esc(rid)))));
            out.push(room_subtree(src, c, rid, &leaf, &has, tables));
            out.push("</ul></details></li>".into());
        }
        if total > rooms.len() as i64 {
            out.push(format!("<li class=\"lbl\">{} more: open one by id (?room=…)</li>", fmt_num((total - rooms.len() as i64) as f64, 0)));
        }
        out.push("</ul>".into());
    }
    out.push("<div class=\"grp\">All tables</div><ul>".into());
    for t in tables {
        out.push(format!("<li>{}</li>", node(&data_href(&Href { table: &t.name, ..Default::default() }), &esc(&t.name), total_count(src, c, &t.name), is_on("", &t.name, &[]), "")));
    }
    out.push("</ul></nav>".into());
    out.join("")
}
type Leaf<'a> = dyn Fn(&str, &str, &str, Vec<(String, String)>, Option<Option<i64>>) -> String + 'a;
fn room_subtree(src: &Source, c: &Connection, room: &str, leaf: &Leaf, has: &dyn Fn(&str) -> bool, tables: &[Table]) -> String {
    let mut out: Vec<String> = vec![];
    let mut known: HashSet<String> = ["rooms".to_string()].into();
    let section = |out: &mut Vec<String>, label: &str, inner: String| {
        if !inner.trim().is_empty() {
            out.push(format!("<li class=\"lbl\">{label}</li>{inner}"));
        }
    };
    for n in ["devices", "member_entries"] {
        known.insert(n.into());
    }
    section(&mut out, "Members", format!("{}{}", leaf(room, "devices", "devices", vec![], None), leaf(room, "member_entries", "member_entries", vec![], None)));
    if has("envelopes") {
        known.insert("envelopes".into());
        known.insert("timelines".into());
        let mut parts = vec![leaf(room, "envelopes", "all envelopes", vec![], None)];
        let kinds = grouped(src, c, room, "SELECT envelope_kind AS k, count(*) AS n FROM envelopes WHERE room_id = ? GROUP BY envelope_kind ORDER BY envelope_kind");
        if !kinds.is_empty() {
            parts.push("<li class=\"lbl\">by envelope_kind</li>".into());
            for (k, n) in &kinds {
                parts.push(leaf(room, "envelopes", &esc(enum_name("envelope_kind", k).map(String::from).unwrap_or_else(|| plain(k)).as_str()), vec![("envelope_kind".into(), plain(k))], Some(Some(*n))));
            }
        }
        let tkinds = grouped(src, c, room, "SELECT timeline_kind AS k, count(*) AS n FROM envelopes WHERE room_id = ? AND timeline_kind IS NOT NULL GROUP BY timeline_kind ORDER BY timeline_kind");
        if !tkinds.is_empty() {
            parts.push("<li class=\"lbl\">by timeline_kind</li>".into());
            for (k, n) in &tkinds {
                parts.push(leaf(room, "envelopes", &esc(enum_name("timeline_kind", k).map(String::from).unwrap_or_else(|| plain(k)).as_str()), vec![("timeline_kind".into(), plain(k))], Some(Some(*n))));
            }
        }
        if has("timelines") {
            let sql = "SELECT timeline_kind AS k, timeline_id AS id, item_count AS n FROM timelines WHERE room_id = ? ORDER BY last_envelope_number DESC LIMIT 25";
            let lines = match src.cached(&format!("g:{room}:{sql}"), 10000, || CacheVal::Lines(c.prepare(sql).and_then(|mut s| s.query_map([room], |r| Ok((r.get::<_, V>(0)?, r.get::<_, V>(1)?, r.get::<_, i64>(2)?)))?.collect()).unwrap_or_default())) {
                CacheVal::Lines(l) => l,
                _ => vec![],
            };
            if !lines.is_empty() {
                parts.push(format!("<li class=\"lbl\">timelines ({}, newest)</li>", fmt_num(room_count(src, c, room, "timelines").map(|x| x as f64).unwrap_or(f64::NAN), 0)));
                for (k, id, n) in &lines {
                    let kind = enum_name("timeline_kind", k).map(String::from).unwrap_or_else(|| plain(k));
                    let idt = plain(id);
                    let shown = shorten_timeline(&idt);
                    parts.push(leaf(room, "envelopes", &format!("<span class=\"mono\">{}</span> <span class=\"muted\">{}</span>", esc(&shown), esc(&kind)), vec![("timeline_kind".into(), plain(k)), ("timeline_id".into(), idt.clone())], Some(Some(*n))));
                }
                parts.push(leaf(room, "timelines", "all timelines", vec![], None));
            }
        }
        section(&mut out, "Envelopes", parts.join(""));
    }
    if has("objects") {
        known.insert("objects".into());
        let mut parts = vec![leaf(room, "objects", "all objects", vec![], None)];
        for (k, n) in grouped(src, c, room, "SELECT object_state AS k, count(*) AS n FROM objects WHERE room_id = ? GROUP BY object_state ORDER BY object_state") {
            parts.push(leaf(room, "objects", &esc(enum_name("object_state", &k).map(String::from).unwrap_or_else(|| plain(&k)).as_str()), vec![("object_state".into(), plain(&k))], Some(Some(n))));
        }
        section(&mut out, "Objects", parts.join(""));
    }
    for n in ["attachments", "shares"] {
        known.insert(n.into());
    }
    section(&mut out, "Attachments", format!("{}{}", leaf(room, "attachments", "attachments", vec![], None), leaf(room, "shares", "shares", vec![], None)));
    let keys = ["sealed_room_keys", "key_back_links", "session_grants", "sealed_session_keys", "session_key_back_links"];
    for k in keys {
        known.insert(k.into());
    }
    section(&mut out, "Keys", keys.iter().map(|k| leaf(room, k, k, vec![], None)).collect::<Vec<_>>().join(""));
    for n in ["invites", "join_requests"] {
        known.insert(n.into());
    }
    section(&mut out, "Invites", format!("{}{}", leaf(room, "invites", "invites", vec![], None), leaf(room, "join_requests", "join_requests", vec![], None)));
    known.insert("accounts".into());
    section(&mut out, "Account", leaf(room, "accounts", "accounts", vec![], None));
    let mut rest = vec![];
    for t in tables {
        if !known.contains(&t.name) && t.names.contains("room_id") {
            rest.push(leaf(room, &t.name, &esc(&t.name), vec![], None));
        }
    }
    section(&mut out, "Other", rest.join(""));
    out.join("")
}
/// String(l.id).replace(/^(\w+\/)([0-9a-f]{8})[0-9a-f]+$/, '$1$2…')
fn shorten_timeline(id: &str) -> String {
    if let Some((p, r)) = id.split_once('/') {
        if !p.is_empty() && p.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') && r.len() > 8 && r.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f')) {
            return format!("{p}/{}…", &r[..8]);
        }
    }
    id.to_string()
}

// ---- the table pane ----------------------------------------------------------------------------------

fn crumbs(s: &State) -> String {
    let mut parts = vec!["<span><a href=\"/data\">Data</a></span>".to_string()];
    if !s.room.is_empty() {
        parts.push(format!("<span><a href=\"{}\">room <span class=\"mono\">{}</span></a></span>", esc(&data_href(&Href { room: &s.room, table: "envelopes", ..Default::default() })), esc(&short(&s.room, 12))));
    }
    if let Some(t) = &s.table {
        parts.push(format!("<span>{}</span>", esc(&t.name)));
    }
    format!("<div class=\"crumbs\">{}</div>", parts.join(""))
}
fn query_rows(c: &Connection, sql: &str, args: &[V], rowid: bool) -> rusqlite::Result<Vec<Row>> {
    let mut st = c.prepare(sql)?;
    let names: Vec<String> = st.column_names().iter().map(|s| s.to_string()).collect();
    let rows = st.query_map(rusqlite::params_from_iter(args.iter()), |r| {
        let mut cols = vec![];
        let mut id = None;
        for (i, n) in names.iter().enumerate() {
            let v: V = r.get(i)?;
            if rowid && n == "__rowid" {
                id = match v {
                    V::Integer(x) => Some(x),
                    _ => None,
                };
                continue;
            }
            cols.push((n.clone(), v));
        }
        Ok((id, cols))
    })?;
    rows.collect()
}
fn render_table_pane(src: &Source, c: &Connection, s: &State) -> Result<String, String> {
    let Some(t) = &s.table else { return Ok("<section class=\"pane\"><div class=\"panehead\"><p class=\"muted\">No tables yet.</p></div></section>".into()) };
    let (where_, args) = where_of(t, s);
    let mut order = if s.sort.is_empty() { vec![] } else { vec![format!("{} {}", quote_ident(&s.sort), s.dir.to_uppercase())] };
    order.extend(default_order(t));
    let select = if t.rowid { "SELECT rowid AS __rowid, *" } else { "SELECT *" };
    let sql = format!(
        "{select} FROM {} {where_} {} LIMIT {} OFFSET {}",
        quote_ident(&t.name),
        if order.is_empty() { String::new() } else { format!("ORDER BY {}", order.join(", ")) },
        PAGE_SIZE + 1,
        s.page * PAGE_SIZE
    );
    let mut rows = query_rows(c, &sql, &args, t.rowid).map_err(|e| e.to_string())?;
    let more = rows.len() as i64 > PAGE_SIZE;
    if more {
        rows.pop();
    }
    let mut capped = false;
    let count = if where_.is_empty() {
        total_count(src, c, &t.name).unwrap_or(0)
    } else {
        let n: i64 = c
            .query_row(&format!("SELECT count(*) AS n FROM (SELECT 1 FROM {} {where_} LIMIT {})", quote_ident(&t.name), COUNT_CAP + 1), rusqlite::params_from_iter(args.iter()), |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if n > COUNT_CAP {
            capped = true;
            COUNT_CAP
        } else {
            n
        }
    };
    let room_ignored = !s.room.is_empty() && !t.names.contains("room_id");
    let base = Href { room: &s.room, table: &t.name, filters: s.filters.clone(), q: &s.q, sort: &s.sort, dir: &s.dir, ..Default::default() };
    let mut out = vec!["<section class=\"pane\"><div class=\"panehead\">".to_string(), crumbs(s)];
    out.push(format!(
        "<div class=\"titlerow\"><h2>{}</h2><span class=\"muted\">{}{} rows{}{}</span></div>",
        esc(&t.name),
        fmt_num(count as f64, 0),
        if capped { "+" } else { "" },
        if !s.room.is_empty() && !room_ignored { " in this room" } else { "" },
        if room_ignored { " (no room_id: room filter ignored)" } else { "" }
    ));
    let chips: Vec<String> = s
        .filters
        .iter()
        .map(|(c, v)| {
            let rest: Vec<(String, String)> = s.filters.iter().filter(|(x, _)| x != c).cloned().collect();
            format!(
                "<span class=\"chip\" title=\"{}\"><span>{}</span><a href=\"{}\" aria-label=\"remove filter\">×</a></span>",
                esc(&format!("{c} = {v}")),
                esc(&filter_label(c, v)),
                esc(&data_href(&Href { filters: rest, ..base.clone() }))
            )
        })
        .collect();
    if !chips.is_empty() {
        out.push(format!("<div class=\"chips\">{}</div>", chips.join("")));
    }
    let mut hidden: Vec<(String, String)> = vec![];
    if !s.room.is_empty() {
        hidden.push(("room".into(), s.room.clone()));
    }
    hidden.push(("t".into(), t.name.clone()));
    for (c, v) in &s.filters {
        hidden.push((format!("f.{c}"), v.clone()));
    }
    if !s.sort.is_empty() {
        hidden.push(("sort".into(), s.sort.clone()));
        hidden.push(("dir".into(), s.dir.clone()));
    }
    let from = if count > 0 { s.page * PAGE_SIZE + 1 } else { 0 };
    let to = s.page * PAGE_SIZE + rows.len() as i64;
    let newest = s.sort.is_empty();
    let (newer, older) = if newest { ("newer", "older") } else { ("prev", "next") };
    let prev = if s.page > 0 { format!("<a href=\"{}\">‹ {newer}</a>", esc(&data_href(&Href { page: s.page - 1, ..base.clone() }))) } else { format!("<span class=\"off\">‹ {newer}</span>") };
    let next = if more { format!("<a href=\"{}\">{older} ›</a>", esc(&data_href(&Href { page: s.page + 1, ..base.clone() }))) } else { format!("<span class=\"off\">{older} ›</span>") };
    out.push(format!(
        "<div class=\"tools\"><form method=\"get\" action=\"/data\">{}<input type=\"search\" name=\"q\" value=\"{}\" placeholder=\"Filter: id prefix, number, text\" aria-label=\"Filter rows\"><button>Filter</button></form>\n<div class=\"pager\"><span>{}–{} of {}{} · page {}</span>{prev}{next}</div></div>",
        hidden.iter().map(|(k, v)| format!("<input type=\"hidden\" name=\"{}\" value=\"{}\">", esc(k), esc(v))).collect::<String>(),
        esc(&s.q),
        fmt_num(from as f64, 0),
        fmt_num(to as f64, 0),
        fmt_num(count as f64, 0),
        if capped { "+" } else { "" },
        s.page + 1
    ));
    out.push("</div><div class=\"tablewrap\"><table class=\"grid\"><thead><tr><th></th>".into());
    let shown: Vec<&(String, String)> = if !s.room.is_empty() && !room_ignored { t.columns.iter().filter(|c| c.0 != "room_id").collect() } else { t.columns.iter().collect() };
    for (name, _) in &shown {
        if is_opaque(name) {
            out.push(format!("<th>{}</th>", esc(name)));
            continue;
        }
        let on = s.sort == *name;
        let dir = if on && s.dir == "desc" { "asc" } else { "desc" };
        out.push(format!(
            "<th><a{} href=\"{}\" title=\"sort\">{}{}</a></th>",
            if on { " class=\"on\"" } else { "" },
            esc(&data_href(&Href { room: &s.room, table: &t.name, filters: s.filters.clone(), q: &s.q, sort: name, dir, ..Default::default() })),
            esc(name),
            if on { if s.dir == "desc" { " ↓" } else { " ↑" } } else { "" }
        ));
    }
    out.push("</tr></thead><tbody>".into());
    let selected = s.key.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join("&");
    for row in &rows {
        let key = row_key(t, row);
        let href = key.as_ref().map(|k| data_href(&Href { page: s.page, key: k.clone(), ..base.clone() })).unwrap_or_default();
        let is_sel = key.as_ref().is_some_and(|k| k.iter().map(|(a, b)| format!("{a}={b}")).collect::<Vec<_>>().join("&") == selected);
        out.push(format!(
            "<tr{}{}><td class=\"open\">{}</td>",
            if href.is_empty() { String::new() } else { format!(" data-href=\"{}\"", esc(&href)) },
            if is_sel { " class=\"sel\"" } else { "" },
            if href.is_empty() { String::new() } else { format!("<a href=\"{}\" aria-label=\"open row\">›</a>", esc(&href)) }
        ));
        for (name, _) in &shown {
            let v = row_get(row, name);
            let num = is_num(v).is_some() && enum_name(name, v).is_none() && !is_time(name, v);
            out.push(format!("<td{}>{}</td>", if num { " class=\"num\"" } else { "" }, cell_html(t, name, v, s)));
        }
        out.push("</tr>".into());
    }
    if rows.is_empty() {
        out.push(format!("<tr><td></td><td colspan=\"{}\" class=\"muted\">No rows.</td></tr>", shown.len()));
    }
    out.push("</tbody></table></div></section>".into());
    Ok(out.join(""))
}

// ---- the row detail ----------------------------------------------------------------------------------

fn masked(b: &[u8]) -> String { format!("<span class=\"opaque\">{} B · {}{}</span>", b.len(), zcrypto::hex(&b[..b.len().min(16)]), if b.len() > 16 { "…" } else { "" }) }
fn render_header(h: &zcrypto::envelope::Header, s: &State) -> String {
    let hx = |b: &[u8]| zcrypto::hex(b);
    let dev = |b: &[u8]| {
        let v = hx(b);
        format!("<a class=\"id\" href=\"{}\">{v}</a>", esc(&data_href(&Href { room: &s.room, table: "envelopes", filters: vec![("sender_device_id".into(), v.clone())], ..Default::default() })))
    };
    let mut rows: Vec<(String, String)> = vec![
        ("room".into(), format!("<span class=\"id\">{}</span>", hx(&h.room_id))),
        (
            "key".into(),
            format!("{} key, epoch {}{}", if h.key_scope == 1 { "session" } else { "room" }, h.epoch, h.session_id.map(|sid| format!(" · session <span class=\"id\">{}</span>", hx(&sid))).unwrap_or_default()),
        ),
        ("sender".into(), dev(&h.sender)),
        ("sequence".into(), format!("{} · previous {}", h.seq, masked(&h.prev))),
        ("member log".into(), format!("entry {} · {}", h.log_seq, masked(&h.log_hash))),
        ("recipient".into(), if zcrypto::bytes::is_zero(&h.recipient) { "<span class=\"muted\">everyone</span>".into() } else { dev(&h.recipient) }),
        ("time".into(), format!("{} <span class=\"muted\">({})</span>", esc(&date_fmt(h.time as i64)), esc(&h.time.to_string()))),
        ("kind".into(), format!("{} <span class=\"muted\">({}{})</span>", esc(kind_name(h.kind as i64).map(String::from).unwrap_or_else(|| h.kind.to_string()).as_str()), h.kind, if h.is_head { ", head" } else { ", thread item" })),
        ("push".into(), if h.push { "yes" } else { "no" }.into()),
    ];
    if let Some(card) = &h.card {
        rows.push((
            "object".into(),
            format!(
                "<a class=\"id\" href=\"{}\">{}</a> · {} · {}{}",
                esc(&data_href(&Href { room: &s.room, table: "envelopes", filters: vec![("object_id".into(), hx(&card.id))], ..Default::default() })),
                hx(&card.id),
                esc(state_name(card.state as i64).map(String::from).unwrap_or_else(|| card.state.to_string()).as_str()),
                esc(urgency_name(card.urgency as i64).map(String::from).unwrap_or_else(|| card.urgency.to_string()).as_str()),
                if card.answered_at > 0 { format!(" · answered {}", esc(&date_fmt(card.answered_at as i64))) } else { String::new() }
            ),
        ));
    }
    if let Some(tid) = &h.timeline_id {
        let tk = h.timeline_kind.unwrap_or(0) as i64;
        rows.push((
            "timeline".into(),
            format!(
                "{} · <a class=\"id\" href=\"{}\">{}</a>",
                esc(tl_name(tk).map(String::from).unwrap_or_else(|| tk.to_string()).as_str()),
                esc(&data_href(&Href { room: &s.room, table: "envelopes", filters: vec![("timeline_id".into(), tid.clone())], ..Default::default() })),
                esc(tid)
            ),
        ));
    }
    if !h.blobs.is_empty() {
        rows.push((
            "attachments".into(),
            h.blobs
                .iter()
                .map(|b| format!("<a class=\"id\" href=\"{}\">{}</a>", esc(&data_href(&Href { room: &s.room, table: "attachments", filters: vec![("attachment_id".into(), hx(b))], ..Default::default() })), hx(b)))
                .collect::<Vec<_>>()
                .join("<br>"),
        ));
    }
    rows.push((
        "seen".into(),
        if h.seen.is_empty() { "<span class=\"muted\">none</span>".into() } else { h.seen.iter().map(|x| format!("<span class=\"id\">{}…</span> #{}", &hx(&x.sender)[..12], x.seq)).collect::<Vec<_>>().join("<br>") },
    ));
    format!("<dl class=\"kv\">{}</dl>", rows.iter().map(|(k, v)| format!("<dt>{}</dt><dd>{v}</dd>", esc(k))).collect::<String>())
}
fn relations(t: &Table, row: &Row, s: &State) -> Vec<(String, String)> {
    let rv = plain(row_get(row, "room_id"));
    let room = if !matches!(row_get(row, "room_id"), V::Null) && room_ok(&rv) { rv } else { s.room.clone() };
    let has = |n: &str| s.tables.iter().any(|t| t.name == n);
    let mut links: Vec<(String, String)> = vec![];
    let mut add = |label: String, table: &str, filters: Vec<(String, String)>| {
        if has(table) {
            links.push((label, data_href(&Href { room: &room, table, filters, ..Default::default() })));
        }
    };
    let v = |c: &str| -> Option<String> {
        match row_get(row, c) {
            V::Null => None,
            x => Some(plain(x)),
        }
    };
    if let Some(o) = v("object_id") {
        add("object row".into(), "objects", vec![("object_id".into(), o.clone())]);
        add("all envelopes of this object (versions, answers)".into(), "envelopes", vec![("object_id".into(), o.clone())]);
        add("card timeline (chat on the card)".into(), "envelopes", vec![("timeline_id".into(), format!("card/{o}"))]);
        add("attachments of this object".into(), "attachments", vec![("object_id".into(), o)]);
    }
    if let Some(tl) = v("timeline_id") {
        add("this timeline".into(), "envelopes", vec![("timeline_id".into(), tl)]);
    }
    for (c, _) in &t.columns {
        let Some(x) = v(c) else { continue };
        if !is_device_column(c) || x.is_empty() || !x.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
            continue;
        }
        add(format!("{c}: the device"), "devices", vec![("device_id".into(), x.clone())]);
        add(format!("{c}: its envelopes"), "envelopes", vec![("sender_device_id".into(), x)]);
    }
    if t.name == "devices" {
        if let Some(d) = v("device_id") {
            add("sealed room keys of this device".into(), "sealed_room_keys", vec![("device_id".into(), d.clone())]);
            add("member entries it signed".into(), "member_entries", vec![("signer_device_id".into(), d.clone())]);
            add("agent lease".into(), "agent_leases", vec![("device_id".into(), d)]);
        }
    }
    for c in ["first_envelope_number", "latest_head_envelope_number", "last_envelope_number", "added_entry_number"] {
        let Some(x) = v(c) else { continue };
        if t.name == "rooms" {
            continue;
        }
        if c == "added_entry_number" {
            add("member entry that added it".into(), "member_entries", vec![("entry_number".into(), x)]);
        } else {
            add(c.replace('_', " "), "envelopes", vec![("envelope_number".into(), x)]);
        }
    }
    if let Some(a) = v("attachment_id") {
        add("attachment row".into(), "attachments", vec![("attachment_id".into(), a.clone())]);
        add("shares of it".into(), "shares", vec![("attachment_id".into(), a)]);
    }
    if let Some(ids) = v("attachment_ids") {
        let b = ids.as_bytes();
        let mut i = 0;
        while i + 32 <= b.len() {
            if b[i..i + 32].iter().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f')) {
                let id = &ids[i..i + 32];
                add(format!("attachment {}…", &id[..8]), "attachments", vec![("attachment_id".into(), id.to_string())]);
                i += 32;
            } else {
                i += 1;
            }
        }
    }
    if let Some(sid) = v("session_id") {
        add("session grants".into(), "session_grants", vec![("session_id".into(), sid.clone())]);
        add("sealed session keys".into(), "sealed_session_keys", vec![("session_id".into(), sid)]);
    }
    if let Some(inv) = v("invite_id") {
        add("invite".into(), "invites", vec![("invite_id".into(), inv.clone())]);
        add("join requests".into(), "join_requests", vec![("invite_id".into(), inv)]);
    }
    if !room.is_empty() && t.name != "envelopes" {
        add("room: all envelopes".into(), "envelopes", vec![]);
    }
    let mut seen = HashSet::new();
    links.into_iter().filter(|(_, h)| seen.insert(h.clone())).collect()
}
fn render_detail(c: &Connection, s: &State) -> Result<String, String> {
    let Some(t) = &s.table else { return Ok(String::new()) };
    if s.key.is_empty() {
        return Ok(String::new());
    }
    let key_cols: Vec<String> = s.key.iter().map(|(k, _)| if k == "rowid" { "rowid".into() } else { quote_ident(&k[2..]) }).collect();
    let args: Vec<V> = s.key.iter().map(|(k, v)| if k == "rowid" { V::Integer(v.parse().unwrap_or(0)) } else { bind_for(t, &k[2..], v) }).collect();
    let select = if t.rowid { "SELECT rowid AS __rowid, *" } else { "SELECT *" };
    let sql = format!("{select} FROM {} WHERE {} LIMIT 1", quote_ident(&t.name), key_cols.iter().map(|c| format!("{c} = ?")).collect::<Vec<_>>().join(" AND "));
    let rows = query_rows(c, &sql, &args, t.rowid).map_err(|e| e.to_string())?;
    let close = data_href(&Href { room: &s.room, table: &t.name, filters: s.filters.clone(), q: &s.q, sort: &s.sort, dir: &s.dir, page: s.page, ..Default::default() });
    let mut out = vec![format!(
        "<aside class=\"detail\" aria-label=\"Row\"><header><h3>{} <span class=\"muted\">{}</span></h3><a class=\"close\" href=\"{}\" aria-label=\"close\">×</a></header>",
        esc(&t.name),
        esc(&s.key.iter().map(|(k, v)| format!("{} {}", k.strip_prefix("k.").unwrap_or(k), short(v, 12))).collect::<Vec<_>>().join(" · ")),
        esc(&close)
    )];
    let Some(row) = rows.first() else {
        out.push("<p class=\"muted\">This row does not exist (any more).</p></aside>".into());
        return Ok(out.join(""));
    };
    let rel = relations(t, row, s);
    if !rel.is_empty() {
        out.push(format!("<h4>Related</h4><ul class=\"rel\">{}</ul>", rel.iter().map(|(l, h)| format!("<li><a href=\"{}\">{} →</a></li>", esc(h), esc(l))).collect::<String>()));
    }
    if t.name == "envelopes" && row.1.iter().any(|(k, _)| k == "envelope_header") {
        let bytes = |c: &str| match row_get(row, c) {
            V::Blob(b) => Some(b.clone()),
            _ => None,
        };
        out.push("<h4>Cleartext header, decoded</h4>".into());
        let decoded: Result<zcrypto::envelope::Header, String> = (|| {
            let (h, n, sg, ch) = (bytes("envelope_header"), bytes("envelope_nonce"), bytes("envelope_signature"), bytes("encrypted_body_hash"));
            let n = n.filter(|n| n.len() == 12).ok_or("bad-argument: nonce must be 12 bytes")?;
            let sg = sg.filter(|s| s.len() == 64).ok_or("bad-argument: signature must be 64 bytes")?;
            let ch = ch.filter(|c| c.len() == 32).ok_or("bad-argument: ciphertext hash must be 32 bytes")?;
            let h = h.ok_or("bad-format: not bytes")?;
            let env = zcrypto::envelope::join_envelope(&h, &n, None, &ch, &sg);
            zcrypto::envelope::peek_envelope(&env, false).map(|p| p.header).map_err(|e| e.message)
        })();
        out.push(match decoded {
            Ok(h) => render_header(&h, s),
            Err(e) => format!("<p class=\"note\">The stored header does not decode: {}</p>", esc(&e)),
        });
        out.push("<p class=\"note\">Signed but not encrypted: the hub routes by it. The body stays ciphertext and is shown as size + first bytes only.</p>".into());
    }
    out.push("<h4>All columns</h4><dl class=\"kv\">".into());
    for (name, _) in &t.columns {
        let v = row_get(row, name);
        let mut html;
        if matches!(v, V::Null) || is_opaque(name) || matches!(v, V::Blob(_)) {
            html = render_cell(name, v);
        } else {
            let text = plain(v);
            html = esc(&if text.encode_utf16().count() > 4000 { format!("{}…", js_slice(&text, 4000)) } else { text.clone() });
            if text.len() >= 16 && text.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f')) {
                html = format!("<span class=\"id\">{html}</span>");
            }
            if let Some(n) = enum_name(name, v) {
                html.push_str(&format!(" <span class=\"tag\">{}</span>", esc(n)));
            }
            if is_time(name, v) {
                html.push_str(&format!(" <span class=\"muted\">{}</span>", esc(&date_fmt(is_num(v).unwrap() as i64))));
            }
        }
        let link = cell_link(t, name, v, s);
        out.push(format!("<dt>{}</dt><dd>{}</dd>", esc(name), match link {
            Some(l) => format!("<a href=\"{}\">{html}</a>", esc(&l)),
            None => html,
        }));
    }
    out.push("</dl></aside>".into());
    Ok(out.join(""))
}

/// The data browser: tree | table | (row).
pub fn render_data(src: &Source, params: &[(String, String)], login: &str, csrf: &str) -> Result<String, String> {
    let c = src.db().ok_or("hub.db does not exist yet")?;
    let tables = table_info(src, &c);
    let s = parse_state(params, &tables);
    let detail = render_detail(&c, &s)?;
    let where_ = [if s.room.is_empty() { "all tables".to_string() } else { format!("room {}", short(&s.room, 8)) }, tname(&s).to_string()].into_iter().filter(|x| !x.is_empty()).collect::<Vec<_>>().join(" › ");
    Ok(format!(
        "{}{}<input type=\"checkbox\" id=\"tt\" aria-label=\"show tree\"><label class=\"treetoggle\" for=\"tt\"><span>Tree: <b>{}</b></span></label><div class=\"data{}\">{}{}{}</div>{}",
        head("Daten · Trommi hub admin"),
        if login.is_empty() { String::new() } else { top_bar(login, csrf, "data") },
        esc(&where_),
        if detail.is_empty() { "" } else { " with-detail" },
        render_tree(src, &c, &s),
        render_table_pane(src, &c, &s)?,
        detail,
        foot()
    ))
}

// ---- overview: tiles and charts ------------------------------------------------------------------------

const RANGES: [(&str, i64, &str); 3] = [("1h", 3600000, "1 h"), ("24h", 86400000, "24 h"), ("7d", 7 * 86400000, "7 d")];
fn range_ms(r: &str) -> i64 { RANGES.iter().find(|x| x.0 == r).map(|x| x.1).unwrap() }
fn pct_of(part: f64, whole: f64) -> f64 { if whole > 0.0 { 100.0 * part / whole } else { f64::NAN } }

#[derive(Clone, Copy)]
struct Point {
    at: i64,
    v: [f64; 8],
}
fn f(x: &Value, k: &str) -> f64 { x.get(k).and_then(|v| v.as_f64()).unwrap_or(f64::NAN) }
fn point_of(x: &Value) -> Point {
    let ring = x.get("mem_available_bytes").is_some();
    let cpu = if x.get("cpu_percent").is_some_and(|v| !v.is_null()) { f(x, "cpu_percent") } else if ring && f(x, "cpus") > 0.0 { 100.0 * f(x, "load1") / f(x, "cpus") } else { f64::NAN };
    let ram = if ring { pct_of(f(x, "mem_total_bytes") - f(x, "mem_available_bytes"), f(x, "mem_total_bytes")) } else { f(x, "mem_used_percent") };
    let ingest = if ring { f(x, "envelopes_per_second") * 60.0 } else { f(x, "envelopes_per_minute") };
    let wal = x.get("wal_bytes").and_then(|v| v.as_f64()).unwrap_or(0.0);
    Point { at: x.get("at").and_then(|v| v.as_i64()).unwrap_or(0), v: [cpu, ram, f(x, "disk_free_bytes"), f(x, "open_streams"), ingest, f(x, "request_ms_p95"), f(x, "requests_per_second"), f(x, "sqlite_bytes") + wal] }
}
/// The persisted minutes read-only from <data>/metrics.db (a standalone admin) .
fn read_series_file(dir: &Path, since: i64, points: i64, now: i64) -> Vec<Value> {
    let file = dir.join("metrics.db");
    if !file.exists() {
        return vec![];
    }
    let Ok(c) = Connection::open_with_flags(&file, OpenFlags::SQLITE_OPEN_READ_ONLY) else { return vec![] };
    let step = std::cmp::max(60000, (((now - since) as f64 / points as f64 / 60000.0).ceil() as i64) * 60000);
    let cols = crate::metrics::SERIES_COLUMNS.map(|c| format!("{}({c}) AS {c}", if c == "request_ms_p95" || c == "open_streams" { "MAX" } else { "AVG" })).join(", ");
    let sql = format!("SELECT (at / {step}) * {step} AS at, {cols} FROM metrics_minute WHERE at >= ? GROUP BY at / {step} ORDER BY at");
    let Ok(mut st) = c.prepare(&sql) else { return vec![] };
    st.query_map([since], |r| {
        let mut m = serde_json::Map::new();
        m.insert("at".into(), json!(r.get::<_, i64>(0)?));
        for (i, k) in crate::metrics::SERIES_COLUMNS.iter().enumerate() {
            m.insert(k.to_string(), json!(r.get::<_, Option<f64>>(i + 1)?));
        }
        Ok(Value::Object(m))
    })
    .and_then(|it| it.collect())
    .unwrap_or_default()
}
fn load_points(src: &Source, range: &str, now: i64) -> Vec<Point> {
    let since = now - range_ms(range);
    let ring: Vec<Value> = if range == "1h" { src.hub.as_ref().map(|h| h.metrics.history()).unwrap_or_default().into_iter().filter(|x| x["at"].as_i64().unwrap_or(0) >= since).collect() } else { vec![] };
    let minutes = match &src.hub {
        Some(h) => h.metrics.series(since, 360),
        None => src.data_dir.as_ref().map(|d| read_series_file(d, since, 360, now)).unwrap_or_default(),
    };
    let first_ring = ring.first().and_then(|x| x["at"].as_i64()).unwrap_or(i64::MAX);
    let rows: Vec<&Value> = minutes.iter().filter(|x| x["at"].as_i64().unwrap_or(0).saturating_add(60000) <= first_ring).chain(ring.iter()).collect();
    rows.into_iter().map(point_of).filter(|p| p.at >= since && p.at <= now + 60000).collect()
}
fn pct(v: f64) -> String { format!("{} %", fmt_num(v, if v < 10.0 { 1 } else { 0 })) }
fn ms(v: f64) -> String { format!("{} ms", fmt_num(v, if v < 10.0 { 1 } else { 0 })) }
struct Def {
    key: usize,
    tile: Option<&'static str>,
    title: &'static str,
    fmt: fn(f64) -> String,
    max: Option<f64>,
}
fn defs() -> Vec<Def> {
    vec![
        Def { key: 0, tile: Some("CPU"), title: "CPU", fmt: pct, max: Some(100.0) },
        Def { key: 1, tile: Some("RAM"), title: "RAM used", fmt: pct, max: Some(100.0) },
        Def { key: 2, tile: Some("Disk free"), title: "Disk free (data)", fmt: format_bytes, max: None },
        Def { key: 3, tile: Some("Open streams"), title: "Open streams", fmt: |v| fmt_num(v, 0), max: None },
        Def { key: 4, tile: Some("Ingest"), title: "Ingest, envelopes/min", fmt: |v| fmt_num(v, if v < 10.0 { 1 } else { 0 }), max: None },
        Def { key: 5, tile: Some("Latency"), title: "Request latency p95", fmt: ms, max: None },
        Def { key: 6, tile: None, title: "Requests/s", fmt: |v| fmt_num(v, 1), max: None },
        Def { key: 7, tile: Some("Database"), title: "Database (hub.db + WAL)", fmt: format_bytes, max: None },
    ]
}
fn nice_max(v: f64) -> f64 {
    if !(v > 0.0) {
        return 1.0;
    }
    let p = 10f64.powf(v.log10().floor());
    for m in [1.0, 1.2, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0, 6.0, 8.0, 10.0] {
        if m * p >= v {
            return m * p;
        }
    }
    10.0 * p
}
fn paths(pts: &[(i64, f64)], t0: i64, t1: i64, max: f64, step: i64) -> (String, String) {
    let (mut line, mut area) = (String::new(), String::new());
    let mut seg: Vec<(f64, f64)> = vec![];
    let flush = |seg: &mut Vec<(f64, f64)>, line: &mut String, area: &mut String| {
        if seg.is_empty() {
            return;
        }
        let pts: Vec<String> = seg.iter().map(|(x, y)| format!("{},{}", to_fixed(*x, 1), to_fixed(*y, 1))).collect();
        line.push_str(&format!("M{}", pts.join("L")));
        area.push_str(&format!("M{},200L{}L{},200Z", to_fixed(seg[0].0, 1), pts.join("L"), to_fixed(seg.last().unwrap().0, 1)));
        if seg.len() == 1 {
            line.push_str(&format!("L{},{}", to_fixed(seg[0].0 + 0.01, 2), to_fixed(seg[0].1, 1)));
        }
        seg.clear();
    };
    let mut prev: Option<i64> = None;
    for (at, v) in pts {
        if let Some(p) = prev {
            if (at - p) as f64 > (step as f64 * 3.5).max(150000.0) {
                flush(&mut seg, &mut line, &mut area);
            }
        }
        seg.push((((at - t0) as f64 / (t1 - t0) as f64) * 1000.0, 200.0 - (v.max(0.0) / max) * 200.0));
        prev = Some(*at);
    }
    flush(&mut seg, &mut line, &mut area);
    (line, area)
}
fn time_label(t: i64, range: &str) -> String { if range == "7d" { day_fmt(t) } else { time_fmt(t) } }
fn chart_svg(pts: &[(i64, f64)], t0: i64, t1: i64, max: f64, step: i64, cls: &str) -> String {
    let (line, area) = paths(pts, t0, t1, max, step);
    let plot = cls == "plot";
    format!(
        "<svg class=\"{cls}\" viewBox=\"0 0 1000 200\" preserveAspectRatio=\"none\" aria-hidden=\"true\">{}<path class=\"area\" d=\"{area}\"/><path class=\"line\" d=\"{line}\" vector-effect=\"non-scaling-stroke\"/>{}</svg>",
        if plot { "<g class=\"grid\"><line x1=\"0\" y1=\"0.5\" x2=\"1000\" y2=\"0.5\" vector-effect=\"non-scaling-stroke\"/><line x1=\"0\" y1=\"100\" x2=\"1000\" y2=\"100\" vector-effect=\"non-scaling-stroke\"/><line x1=\"0\" y1=\"199.5\" x2=\"1000\" y2=\"199.5\" vector-effect=\"non-scaling-stroke\"/></g>" } else { "" },
        if plot { "<line class=\"hair\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"200\" vector-effect=\"non-scaling-stroke\"/><line class=\"dot\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"0\" vector-effect=\"non-scaling-stroke\"/>" } else { "" }
    )
}
/// +(x).toFixed(4) as JSON number text
fn round4(x: f64) -> Value {
    let s = to_fixed(x, 4);
    let v: f64 = s.parse().unwrap_or(0.0);
    if v.fract() == 0.0 { json!(v as i64) } else { json!(v) }
}
fn split_value(value: &str) -> (String, String) {
    // /^([\d.,–-]+)\s?(.*)$/
    let mut end = 0;
    for (i, c) in value.char_indices() {
        if c.is_ascii_digit() || c == '.' || c == ',' || c == '–' || c == '-' {
            end = i + c.len_utf8();
        } else {
            break;
        }
    }
    if end == 0 {
        return (value.to_string(), String::new());
    }
    let rest = &value[end..];
    let rest = rest.strip_prefix(char::is_whitespace).unwrap_or(rest);
    (value[..end].to_string(), rest.to_string())
}

pub fn render_overview(src: &Source, started_at: i64, wanted: Option<&str>, now: i64, login: &str, csrf: &str) -> Result<String, String> {
    let range = wanted.filter(|w| RANGES.iter().any(|r| r.0 == *w)).unwrap_or("1h");
    let (t1, t0) = (now, now - range_ms(range));
    let step = if range == "1h" { 10000 } else { std::cmp::max(60000, ((range_ms(range) as f64 / 360.0 / 60000.0).ceil() as i64) * 60000) };
    let points = load_points(src, range, now);
    let data_dir = src.data_dir.clone().unwrap_or_else(|| PathBuf::from("/"));
    let h = crate::metrics::host_stats(&data_dir);
    let cpus = h.cpus as f64;
    let mem_used = h.mem_total - h.mem_available;
    let last = src.hub.as_ref().and_then(|hub| hub.metrics.history().last().cloned());
    let db_size = file_size(&src.db_path) + file_size(&PathBuf::from(format!("{}-wal", src.db_path.display())));
    let mut budget = 200000;
    let attachments_size = src.data_dir.as_ref().map(|d| dir_size(&d.join("attachments"), &mut budget)).unwrap_or(0.0);
    let lf = |k: &str| last.as_ref().and_then(|l| l.get(k)).and_then(|v| v.as_f64());
    let now1 = [
        lf("cpu_percent").unwrap_or(100.0 * h.load[0] / cpus),
        pct_of(mem_used, h.mem_total),
        h.disk_free,
        lf("open_streams").unwrap_or(f64::NAN),
        lf("envelopes_per_second").map(|v| v * 60.0).unwrap_or(f64::NAN),
        lf("request_ms_p95").unwrap_or(f64::NAN),
        lf("requests_per_second").unwrap_or(f64::NAN),
        db_size,
    ];
    let sub = [
        format!("load {} · {} cores", h.load.iter().map(|x| to_fixed(*x, 2)).collect::<Vec<_>>().join(" / "), h.cpus),
        format!("{} of {}", format_bytes(mem_used), format_bytes(h.mem_total)),
        format!("{} of {} free", pct(pct_of(h.disk_free, h.disk_total)), format_bytes(h.disk_total)),
        "live connections now".into(),
        "envelopes per minute".into(),
        "p95, streams excluded".into(),
        "all routes".into(),
        format!("attachments {}", format_bytes(attachments_size)),
    ];
    let mut tiles = vec![];
    let mut charts = vec![];
    for def in defs() {
        let pts: Vec<(i64, f64)> = points.iter().map(|p| (p.at, p.v[def.key])).filter(|p| p.1.is_finite()).collect();
        let peak = pts.iter().fold(0f64, |m, p| m.max(p.1));
        let max = def.max.unwrap_or_else(|| nice_max(peak * 1.1));
        let cur = if now1[def.key].is_finite() { Some(now1[def.key]) } else { pts.last().map(|p| p.1) };
        let value = match cur.filter(|c| c.is_finite()) {
            Some(c) => (def.fmt)(c),
            None => "–".into(),
        };
        let (big, unit) = split_value(&value);
        if let Some(tile) = def.tile {
            tiles.push(format!(
                "<div class=\"tile\"><div class=\"k\">{}</div><div class=\"v\">{}{}</div><div class=\"s\">{}</div>{}</div>",
                esc(tile),
                esc(&big),
                if unit.is_empty() { String::new() } else { format!("<small>{}</small>", esc(&unit)) },
                esc(&sub[def.key]),
                if pts.len() > 1 { chart_svg(&pts, t0, t1, max, step, "spark") } else { "<svg class=\"spark\" aria-hidden=\"true\"></svg>".into() }
            ));
        }
        if pts.is_empty() {
            charts.push(format!(
                "<figure class=\"chart\"><header><h3>{}</h3><span class=\"readout\">no data yet</span></header><div class=\"empty\">{}</div></figure>",
                esc(def.title),
                if range == "1h" { "The first sample comes within 10 s." } else { "Collected every minute from now on." }
            ));
            continue;
        }
        let last_pt = *pts.last().unwrap();
        let hover: Vec<Value> = pts
            .iter()
            .map(|(at, v)| json!([round4((at - t0) as f64 / (t1 - t0) as f64), round4(1.0 - v.max(0.0) / max), format!("{} · {}", if range == "7d" { day_time_fmt(*at) } else { time_fmt(*at) }, (def.fmt)(*v))]))
            .collect();
        let mid = t0 + (t1 - t0) / 2;
        charts.push(format!(
            "<figure class=\"chart\" data-pts=\"{}\"><header><h3>{}</h3><span class=\"readout\">{}</span></header>\n<div class=\"plotwrap\"><span class=\"ylab y100\">{}</span><span class=\"ylab y50\">{}</span><span class=\"ylab y0\">0</span>{}</div>\n<div class=\"xlabs\"><span>{}</span><span>{}</span><span>{}</span></div></figure>",
            esc(&serde_json::to_string(&hover).unwrap()),
            esc(def.title),
            esc(&format!("now {} · peak {}", (def.fmt)(last_pt.1), (def.fmt)(peak))),
            esc(&(def.fmt)(max)),
            esc(&(def.fmt)(max / 2.0)),
            chart_svg(&pts, t0, t1, max, step, "plot"),
            esc(&time_label(t0, range)),
            esc(&time_label(mid, range)),
            esc(&if range == "1h" { "now".to_string() } else { time_label(t1, range) })
        ));
    }
    let seg: String = RANGES.iter().map(|(k, _, label)| format!("<a href=\"/?range={k}\"{}>{label}</a>", if *k == range { " class=\"on\"" } else { "" })).collect();
    let mut hub: Vec<(String, String)> = vec![];
    if started_at > 0 {
        hub.push(("Uptime".into(), format!("{} h {} min", (now - started_at) / 3600000, ((now - started_at) % 3600000) / 60000)));
    }
    if let Some(l) = &last {
        let g = |k: &str| l.get(k).and_then(|v| v.as_f64()).unwrap_or(0.0);
        hub.push(("Hub process".into(), format!("RSS {} · heap {}", format_bytes(g("rss_bytes")), format_bytes(g("heap_used_bytes")))));
        hub.push(("Event loop".into(), format!("lag p99 {} · GC max {}", ms(g("event_loop_lag_p99_ms")), ms(g("gc_max_ms")))));
        hub.push(("Writes".into(), format!("queue {} · stream buffers {}", js_num(g("write_queue_depth")), format_bytes(g("outbound_bytes_total")))));
        hub.push(("SQLite".into(), format!("{} · WAL {}", format_bytes(g("sqlite_bytes")), format_bytes(g("wal_bytes")))));
    } else if src.hub.is_some() {
        hub.push(("Hub".into(), "first metrics sample in under 10 s".into()));
    }
    hub.push(("hub.db".into(), format!("{} · attachments: {}", format_bytes(db_size), format_bytes(attachments_size))));
    let tables_html = match src.db() {
        Some(c) => {
            let tables = table_info(src, &c);
            format!(
                "<ul class=\"tlist\">{}</ul>",
                tables.iter().map(|t| format!("<li><a href=\"{}\"><span>{}</span><span class=\"n\">{}</span></a></li>", esc(&data_href(&Href { table: &t.name, ..Default::default() })), esc(&t.name), esc(&fmt_num(total_count(src, &c, &t.name).map(|n| n as f64).unwrap_or(f64::NAN), 0)))).collect::<String>()
            )
        }
        None => "<p class=\"muted\">hub.db does not exist yet.</p>".into(),
    };
    Ok(format!(
        "{}{}<main class=\"page\">\n<div class=\"head\"><h1>Overview</h1><div class=\"seg\" role=\"tablist\" aria-label=\"Range\">{seg}</div><span class=\"muted\">{}</span></div>\n<div class=\"tiles\">{}</div>\n<div class=\"charts\">{}</div>\n<div class=\"cols\"><section class=\"card\"><h3>Hub</h3><dl class=\"kv\">{}</dl></section>\n<section class=\"card\"><h3>Tables <a class=\"n\" href=\"/data\">open data browser →</a></h3>{tables_html}</section></div>\n</main>{}",
        head("Übersicht · Trommi hub admin"),
        if login.is_empty() { String::new() } else { top_bar(login, csrf, "overview") },
        esc(&date_fmt(now)),
        tiles.join(""),
        charts.join(""),
        hub.iter().map(|(k, v)| format!("<dt>{}</dt><dd>{}</dd>", esc(k), esc(v))).collect::<String>(),
        foot()
    ))
}

// ---- test accounts -----------------------------------------------------------------------------------

/// The accounts whose email ends with @example.org and the delete form (renderTestAccounts of admin-view.mjs).
pub fn render_test_accounts(list: &[crate::delete_room::TestAccount], login: &str, csrf: &str, can_delete: bool, message: &str, result: Option<&Value>) -> String {
    let when = |t: Option<i64>| match t {
        Some(t) if t > 0 => date_fmt(t),
        _ => "–".into(),
    };
    let n = list.len();
    let mut done = String::new();
    if let Some(r) = result {
        let deleted = r["deleted"].as_array().map(|a| a.len()).unwrap_or(0);
        let mut totals: Vec<(String, f64)> = r["totals"].as_object().map(|o| o.iter().filter(|(k, _)| *k != "files").map(|(k, v)| (k.clone(), v.as_f64().unwrap_or(0.0))).collect()).unwrap_or_default();
        totals.sort_by(|a, b| a.0.cmp(&b.0));
        let refused = r["refused"].as_array().cloned().unwrap_or_default();
        done = format!(
            "<section class=\"card\"><h3 class=\"ok\">Deleted {} test room{}</h3><dl class=\"kv\">\n<dt>backup</dt><dd class=\"mono\">{}</dd>\n{}\n<dt>attachment files</dt><dd>{}</dd>\n{}\n</dl><p class=\"note\">Every deleted room is also written to deletions.log in the hub's data directory.</p></section>",
            esc(&fmt_num(deleted as f64, 0)),
            if deleted == 1 { "" } else { "s" },
            esc(r["backup"].as_str().unwrap_or("")),
            totals.iter().map(|(t, c)| format!("<dt>{}</dt><dd>{} rows</dd>", esc(t), esc(&fmt_num(*c, 0)))).collect::<String>(),
            esc(&fmt_num(r["totals"]["files"].as_f64().unwrap_or(0.0), 0)),
            if refused.is_empty() {
                String::new()
            } else {
                format!(
                    "<dt class=\"err\">refused</dt><dd class=\"err\">{}</dd>",
                    refused.iter().map(|x| esc(&format!("{}: {}", x["room_id"].as_str().unwrap_or("").chars().take(12).collect::<String>(), x["message"].as_str().unwrap_or("")))).collect::<Vec<_>>().join("<br>")
                )
            }
        );
    }
    let rows: String = list
        .iter()
        .map(|r| {
            format!(
                "<tr><td class=\"mono\">{}</td><td><a class=\"id\" href=\"{}\">{}…</a></td>\n<td>{}</td><td>{}</td><td class=\"num\">{}</td><td class=\"num\">{}</td></tr>",
                esc(&r.email),
                esc(&data_href(&Href { room: &r.room_id, ..Default::default() })),
                esc(&r.room_id[..12.min(r.room_id.len())]),
                esc(&when(r.created_at)),
                esc(&when(r.last_activity)),
                esc(&fmt_num(r.envelopes as f64, 0)),
                esc(&fmt_num(r.attachments as f64, 0))
            )
        })
        .collect();
    let table = if n > 0 {
        format!("<div class=\"scroll\"><table class=\"grid\"><thead><tr><th>email</th><th>room</th><th>created</th><th>last activity</th><th>envelopes</th><th>attachments</th></tr></thead><tbody>{rows}</tbody></table></div>")
    } else {
        "<p class=\"muted\">No accounts with an email ending in @example.org.</p>".into()
    };
    let form = if n > 0 && can_delete {
        format!("<form class=\"confirm\" method=\"post\" action=\"/test-accounts/delete\"><input type=\"hidden\" name=\"csrf\" value=\"{}\">\n<label for=\"confirm-n\" class=\"muted\">Type {n} to confirm</label><input id=\"confirm-n\" type=\"text\" name=\"confirm\" inputmode=\"numeric\" autocomplete=\"off\" required pattern=\"{n}\">\n<button class=\"danger\">Delete these {n} test rooms</button></form>\n<p class=\"note\">Removes every row of these rooms (account, members, devices, keys, envelopes, cards, attachments and their files, push registrations, links) in one transaction per room, after an online backup of hub.db to backups/ in the data directory. Only rooms whose account email ends with @example.org can be deleted.</p>", esc(csrf))
    } else if n > 0 {
        "<p class=\"note\">Deleting needs the running hub (this listener has no hub attached).</p>".into()
    } else {
        String::new()
    };
    format!(
        "{}{}<main class=\"page\">\n<div class=\"head\"><h1>Test accounts</h1><span class=\"muted\">{} with an email ending in @example.org</span></div>\n{}{done}\n<section class=\"card\">{table}{form}</section>\n</main>{}",
        head("Test accounts · Trommi hub admin"),
        if login.is_empty() { String::new() } else { top_bar(login, csrf, "tests") },
        esc(&fmt_num(n as f64, 0)),
        if message.is_empty() { String::new() } else { format!("<p class=\"err\">{}</p>", esc(message)) },
        foot()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn numbers_as_javascript_formats_them() {
        assert_eq!(fmt_num(1234567.891, 1), "1,234,567.9");
        assert_eq!(fmt_num(0.05, 1), "0.1");
        assert_eq!(fmt_num(2.25, 1), "2.3");
        assert_eq!(fmt_num(12.5, 0), "13");
        assert_eq!(fmt_num(121.0, 0), "121");
        assert_eq!(fmt_num(999.96, 1), "1,000");
        assert_eq!(format_bytes(3000.0), "2.9 KiB");
        assert_eq!(format_bytes(100.0), "100 B");
        assert_eq!(to_fixed(0.25, 1), "0.3");
        assert_eq!(render_cell("signed_entry", &V::Text("AAEC".into())), "<span class=\"opaque\">3 B · 000102</span>");
    }
    #[test]
    fn berlin_time() {
        // 2026-10-04 10:00:05 UTC is 12:00:05 in Berlin (CEST); 2026-01-01 00:00 UTC is 01:00 (CET)
        assert_eq!(date_fmt(1791108005000), "2026-10-04 12:00:05");
        assert_eq!(date_fmt(1767225600000), "2026-01-01 01:00:00");
        assert_eq!(day_fmt(1791108005000), "So., 04.10.");
        assert_eq!(time_fmt(1774745940000), "01:59");
        assert_eq!(time_fmt(1774746000000), "03:00");
    }
}
