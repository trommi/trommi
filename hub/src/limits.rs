//! Rate limits, in memory: a token bucket (steady rate with bursts) and a sliding window (so many per span).
//! Keys are bounded in number, so a flood of fresh keys cannot grow the maps without end.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

const MAX_KEYS: usize = 100_000;

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
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.len() >= MAX_KEYS && !state.contains_key(key) {
            state.retain(|_, (_, at)| now.saturating_sub(*at) < 60_000);
            if state.len() >= MAX_KEYS {
                return Err(60);
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
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.len() >= MAX_KEYS && !state.contains_key(key) {
            let span = self.span_ms;
            state.retain(|_, hits| hits.back().is_some_and(|t| now.saturating_sub(*t) < span));
            if state.len() >= MAX_KEYS {
                return Err(60);
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
            .remove(key);
    }

    pub fn sweep(&self, now: u64) {
        let span = self.span_ms;
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|_, hits| hits.back().is_some_and(|t| now.saturating_sub(*t) < span));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bucket_gives_its_burst_then_its_rate() {
        let b = Buckets::new(50.0, 200.0);
        for _ in 0..200 {
            b.take(b"d", 1.0, 1_000).unwrap();
        }
        assert_eq!(b.take(b"d", 1.0, 1_000), Err(1));
        // 100 ms later: five more
        for _ in 0..5 {
            b.take(b"d", 1.0, 1_100).unwrap();
        }
        assert!(b.take(b"d", 1.0, 1_100).is_err());
        // another key is not touched
        b.take(b"e", 1.0, 1_100).unwrap();
    }

    #[test]
    fn a_window_counts_hits_within_its_span() {
        let w = Window::new(3, 60_000);
        for t in [0, 1_000, 2_000] {
            w.check(b"ip", t, true).unwrap();
        }
        assert_eq!(w.check(b"ip", 3_000, true), Err(57));
        w.check(b"ip", 60_000, true).unwrap();
        w.clear(b"ip");
        w.check(b"ip", 60_001, true).unwrap();
    }
}
