//! Rate limits: token buckets (server.mjs buckets) and timestamp windows (ops/http.mjs windowLimit).

use crate::util::now;
use indexmap::IndexMap;
use parking_lot::Mutex;
use std::collections::HashMap;

struct Bucket {
    tokens: f64,
    at: i64,
}
/// `rate` per second, up to `burst`. take() -> 0 if allowed, else seconds to wait.
pub struct Buckets {
    rate: f64,
    burst: f64,
    map: Mutex<HashMap<String, Bucket>>,
}
impl Buckets {
    pub fn new(rate: f64, burst: f64) -> Self { Buckets { rate, burst, map: Mutex::new(HashMap::new()) } }
    pub fn take(&self, key: &str) -> u64 {
        let t = now();
        let mut map = self.map.lock();
        if !map.contains_key(key) {
            if map.len() >= 100000 {
                map.retain(|_, b| t - b.at <= 60000);
            }
            map.insert(key.to_string(), Bucket { tokens: self.burst, at: t });
        }
        let b = map.get_mut(key).unwrap();
        b.tokens = (b.tokens + ((t - b.at) as f64 / 1000.0) * self.rate).min(self.burst);
        b.at = t;
        if b.tokens >= 1.0 {
            b.tokens -= 1.0;
            return 0;
        }
        ((1.0 - b.tokens) / self.rate).ceil().max(0.0) as u64
    }
    pub fn sweep(&self) {
        let t = now();
        self.map.lock().retain(|_, b| t - b.at <= 3600000);
    }
}

/// allow(key) is false once `max` hits fell into the last `window_ms`. Capped at `keys` keys (oldest out).
pub struct Window {
    max: usize,
    window_ms: i64,
    keys: usize,
    map: Mutex<IndexMap<String, Vec<i64>>>,
}
impl Window {
    pub fn new(max: f64, window_ms: i64) -> Self { Window { max: max as usize, window_ms, keys: 100000, map: Mutex::new(IndexMap::new()) } }
    /// 0 if allowed (and counted), else seconds until the next hit is allowed.
    pub fn take(&self, key: &str) -> u64 {
        let t = now();
        let mut map = self.map.lock();
        let mut hits: Vec<i64> = map.shift_remove(key).unwrap_or_default().into_iter().filter(|x| t - x < self.window_ms).collect();
        if map.len() >= self.keys {
            map.shift_remove_index(0);
        }
        if hits.len() >= self.max {
            let w = ((hits[0] + self.window_ms - t) as f64 / 1000.0).ceil().max(1.0) as u64;
            map.insert(key.to_string(), hits);
            return w;
        }
        hits.push(t);
        map.insert(key.to_string(), hits);
        0
    }
}
