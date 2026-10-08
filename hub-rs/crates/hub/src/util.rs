//! Small things: the clock (overridable for tests), JSON number checks as JavaScript does them, query strings.

use serde_json::Value;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static TEST_CLOCK: AtomicBool = AtomicBool::new(false);
static TEST_NOW: AtomicI64 = AtomicI64::new(0);

/// Milliseconds since 1970: the hub's `now()`. With the test clock on (HUB_TEST_CONTROL), the time the test
/// process sent last (header x-test-now, or the control route) stands still until it sends another.
pub fn now() -> i64 {
    if TEST_CLOCK.load(Ordering::Relaxed) {
        let t = TEST_NOW.load(Ordering::Relaxed);
        if t > 0 {
            return t;
        }
    }
    wall()
}
pub fn wall() -> i64 { SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0) }
pub fn enable_test_clock() { TEST_CLOCK.store(true, Ordering::Relaxed) }
pub fn set_test_now(t: i64) { TEST_NOW.store(t, Ordering::Relaxed) }

/// "2026-10-08T12-00-00-000Z" (new Date().toISOString() with : and . replaced).
pub fn iso_stamp() -> String {
    let ms = wall();
    let (y, mo, d, h, mi, s) = civil(ms / 1000);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}-{mi:02}-{s:02}-{:03}Z", ms % 1000)
}
/// new Date(ms).toISOString()
pub fn iso_time(ms: i64) -> String {
    let (y, mo, d, h, mi, s) = civil(ms.div_euclid(1000));
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}.{:03}Z", ms.rem_euclid(1000))
}
pub fn civil(secs: i64) -> (i64, i64, i64, i64, i64, i64) {
    let days = secs.div_euclid(86400);
    let rem = secs.rem_euclid(86400);
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d, rem / 3600, (rem % 3600) / 60, rem % 60)
}

/// Number.isSafeInteger(v) for a JSON value: an integer-valued number within ±(2^53 - 1).
pub fn safe_int(v: &Value) -> Option<i64> {
    const MAX: f64 = 9007199254740991.0;
    match v {
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                return if (i as f64).abs() <= MAX { Some(i) } else { None };
            }
            if n.as_u64().is_some() {
                return None;
            }
            let f = n.as_f64()?;
            if f.fract() == 0.0 && f.abs() <= MAX { Some(f as i64) } else { None }
        }
        _ => None,
    }
}
/// JavaScript's `Number(s)` for a header or query value, as far as the hub uses it: an integer, or None.
pub fn js_number_int(s: &str) -> Option<f64> {
    let t = s.trim();
    if t.is_empty() {
        return Some(0.0);
    }
    t.parse::<f64>().ok()
}
/// Length of a string as JavaScript counts it (UTF-16 units).
pub fn js_len(s: &str) -> usize { s.encode_utf16().count() }

/// URLSearchParams: decoded pairs in order.
pub fn query_pairs(q: Option<&str>) -> Vec<(String, String)> {
    let Some(q) = q else { return vec![] };
    q.split('&')
        .filter(|p| !p.is_empty())
        .map(|p| {
            let (k, v) = p.split_once('=').unwrap_or((p, ""));
            (form_decode(k), form_decode(v))
        })
        .collect()
}
fn form_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < b.len() && hexv(b[i + 1]).is_some() && hexv(b[i + 2]).is_some() => {
                out.push(hexv(b[i + 1]).unwrap() * 16 + hexv(b[i + 2]).unwrap());
                i += 3;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}
fn hexv(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

pub struct Query(pub Vec<(String, String)>);
impl Query {
    pub fn get(&self, k: &str) -> Option<&str> { self.0.iter().find(|(a, _)| a == k).map(|(_, v)| v.as_str()) }
    pub fn has(&self, k: &str) -> bool { self.0.iter().any(|(a, _)| a == k) }
}

pub fn random_bytes(n: usize) -> Vec<u8> {
    use rand::RngCore;
    let mut v = vec![0u8; n];
    rand::thread_rng().fill_bytes(&mut v);
    v
}
