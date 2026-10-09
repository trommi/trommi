//! Rate limits, in memory: a token bucket (steady rate with bursts) and a sliding window (so many per span).
//! Keys are bounded in number, so a flood of fresh keys cannot grow the maps without end.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

const MAX_KEYS: usize = 100_000;

/// A key of fixed size, whatever a request sent: a limiter never holds request text.
fn fixed_key(key: &[u8]) -> [u8; 16] {
    use sha2::{Digest, Sha256};
    let mut out = [0u8; 16];
    out.copy_from_slice(&Sha256::digest(key)[..16]);
    out
}

pub struct Buckets {
    rate: f64,
    burst: f64,
    state: Mutex<HashMap<Vec<u8>, (f64, u64)>>,
}

impl Buckets {
    pub fn new(rate_per_second: f64, burst: f64) -> Self {
        Buckets {
            rate: rate_per_second,
            burst,
            state: Mutex::new(HashMap::new()),
        }
    }

    /// Takes `cost` tokens. `Err(seconds)`: how long to wait.
    pub fn take(&self, key: &[u8], cost: f64, now: u64) -> Result<(), u64> {
        let key = &fixed_key(key)[..];
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.len() >= MAX_KEYS && !state.contains_key(key) {
            state.retain(|_, (_, at)| now.saturating_sub(*at) < 60_000);
            if state.len() >= MAX_KEYS {
                // full of keys that are all in use: the newcomer is let through unrecorded rather than everyone
                // refused; those on record keep their limits
                return Ok(());
            }
        }
        let (tokens, at) = state.entry(key.to_vec()).or_insert((self.burst, now));
        *tokens = (*tokens + now.saturating_sub(*at) as f64 / 1000.0 * self.rate).min(self.burst);
        *at = now;
        if *tokens >= cost {
            *tokens -= cost;
            Ok(())
        } else {
            Err(((cost - *tokens) / self.rate).ceil().max(1.0) as u64)
        }
    }

    pub fn sweep(&self, now: u64) {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|_, (_, at)| now.saturating_sub(*at) < 3_600_000);
    }
}

pub struct Window {
    max: usize,
    span_ms: u64,
    state: Mutex<HashMap<Vec<u8>, VecDeque<u64>>>,
}

impl Window {
    pub fn new(max: usize, span_ms: u64) -> Self {
        Window {
            max,
            span_ms,
            state: Mutex::new(HashMap::new()),
        }
    }

    /// `Err(seconds)` when the key has used its `max` within the span; `record` adds a hit.
    pub fn check(&self, key: &[u8], now: u64, record: bool) -> Result<(), u64> {
        let key = &fixed_key(key)[..];
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if !record && !state.contains_key(key) {
            return Ok(());
        }
        if state.len() >= MAX_KEYS && !state.contains_key(key) {
            let span = self.span_ms;
            state.retain(|_, hits| hits.back().is_some_and(|t| now.saturating_sub(*t) < span));
            if state.len() >= MAX_KEYS {
                // full of keys that are all in use: the newcomer is let through unrecorded rather than everyone
                // refused; those on record keep their limits
                return Ok(());
            }
        }
        let hits = state.entry(key.to_vec()).or_default();
        while hits
            .front()
            .is_some_and(|t| now.saturating_sub(*t) >= self.span_ms)
        {
            hits.pop_front();
        }
        if hits.len() >= self.max {
            let oldest = hits.front().copied().unwrap_or(now);
            return Err(((oldest + self.span_ms).saturating_sub(now) / 1000).max(1));
        }
        if record {
            hits.push_back(now);
        }
        Ok(())
    }

    pub fn clear(&self, key: &[u8]) {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&fixed_key(key)[..]);
    }

    pub fn sweep(&self, now: u64) {
        let span = self.span_ms;
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|_, hits| hits.back().is_some_and(|t| now.saturating_sub(*t) < span));
    }
}
