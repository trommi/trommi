//! The hub's recent history for the admin page's graphs: every 10 s a sample of the server and the hub (CPU,
//! memory, the hub's own memory, requests per second, open streams, live sessions, the pool at work), kept in
//! memory only. The last hour stays at 10 s; older samples are averaged into one per minute and kept for a day.
//! A restart begins a new history.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use crate::app::App;

/// how often a sample is taken
pub const STEP_MS: u64 = 10_000;
/// the fine history: 10 s samples for an hour
pub const FINE_MS: u64 = 3_600_000;
/// the coarse history: one averaged sample a minute, for a day
pub const COARSE_STEP_MS: u64 = 60_000;
pub const COARSE_MS: u64 = 24 * 3_600_000;

/// What each sample holds, in this order.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Series {
    /// share of the CPU time that was not idle, in %
    Cpu = 0,
    /// share of the memory in use, in %
    Mem,
    /// the hub's resident memory, in bytes
    Rss,
    /// requests on the public port per second
    Rps,
    /// open streams
    Streams,
    /// live sessions
    Sessions,
    /// pool jobs at work
    Pool,
}

pub const SERIES: usize = 7;

/// One point in time; a value the hub could not read is NaN.
#[derive(Clone, Copy, Debug)]
pub struct Sample {
    pub at: u64,
    pub v: [f64; SERIES],
}

impl Sample {
    pub fn get(&self, s: Series) -> f64 {
        self.v[s as usize]
    }
}

/// The two rings: 10 s samples for the last hour, minute averages for the last day.
#[derive(Default)]
pub struct History {
    fine: VecDeque<Sample>,
    coarse: VecDeque<Sample>,
    /// the samples of the minute not yet averaged
    minute: Vec<Sample>,
}

fn average(samples: &[Sample]) -> Option<Sample> {
    let last = samples.last()?;
    let mut v = [f64::NAN; SERIES];
    for (k, slot) in v.iter_mut().enumerate() {
        let known: Vec<f64> = samples.iter().map(|s| s.v[k]).filter(|x| x.is_finite()).collect();
        if !known.is_empty() {
            *slot = known.iter().sum::<f64>() / known.len() as f64;
        }
    }
    // (stamped at the start of its minute)
    Some(Sample { at: last.at - last.at % COARSE_STEP_MS, v })
}

impl History {
    /// Adds a sample (samples come in order of time).
    pub fn push(&mut self, s: Sample) {
        if let Some(first) = self.minute.first() {
            if first.at / COARSE_STEP_MS != s.at / COARSE_STEP_MS {
                if let Some(avg) = average(&self.minute) {
                    self.coarse.push_back(avg);
                }
                self.minute.clear();
            }
        }
        self.minute.push(s);
        self.fine.push_back(s);
        while self.fine.front().is_some_and(|f| f.at + FINE_MS < s.at) {
            self.fine.pop_front();
        }
        while self.coarse.front().is_some_and(|c| c.at + COARSE_MS < s.at) {
            self.coarse.pop_front();
        }
    }

    /// The samples of the last `range_ms` up to `now`: the fine ones for an hour or less, else the minute
    /// averages followed by the minute in progress.
    pub fn since(&self, range_ms: u64, now: u64) -> Vec<Sample> {
        let from = now.saturating_sub(range_ms);
        if range_ms <= FINE_MS {
            return self.fine.iter().filter(|s| s.at >= from).copied().collect();
        }
        let mut out: Vec<Sample> = self.coarse.iter().filter(|s| s.at >= from).copied().collect();
        out.extend(average(&self.minute));
        out
    }

    pub fn len(&self) -> (usize, usize) {
        (self.fine.len(), self.coarse.len())
    }

    pub fn is_empty(&self) -> bool {
        self.fine.is_empty()
    }
}

/// The history with what the next sample is measured against.
#[derive(Default)]
pub struct Metrics {
    /// requests on the public port since the start
    pub requests: AtomicU64,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    history: History,
    /// the CPU ticks (all, idle) and requests of the last sample, with its time
    last: Option<(Option<(u64, u64)>, u64, u64)>,
}

impl Metrics {
    pub fn push(&self, s: Sample) {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).history.push(s);
    }

    pub fn since(&self, range_ms: u64, now: u64) -> Vec<Sample> {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).history.since(range_ms, now)
    }

    /// Takes a sample of the server and the hub (the periodic job, every `STEP_MS`).
    pub fn sample(&self, app: &App) {
        let at = crate::util::now();
        let ticks = crate::admin_view::cpu_ticks();
        let requests = self.requests.load(Ordering::Relaxed);
        let mem = std::fs::read_to_string("/proc/meminfo").ok().and_then(|text| {
            crate::admin_view::kb(&text, "MemTotal:").zip(crate::admin_view::kb(&text, "MemAvailable:"))
        });
        let rss = std::fs::read_to_string("/proc/self/status")
            .ok()
            .and_then(|text| crate::admin_view::kb(&text, "VmRSS:"));
        let sessions = app
            .db
            .read(|c| {
                c.query_row(
                    "SELECT count(*) FROM groups WHERE kind != 'room' AND live = 1",
                    [],
                    |r| r.get::<_, i64>(0),
                )
            })
            .ok();
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let mut v = [f64::NAN; SERIES];
        if let Some((last_ticks, last_requests, last_at)) = state.last {
            if let Some(((a0, i0), (a1, i1))) = last_ticks.zip(ticks) {
                let all = a1.saturating_sub(a0);
                if all > 0 {
                    v[Series::Cpu as usize] =
                        100.0 * all.saturating_sub(i1.saturating_sub(i0)) as f64 / all as f64;
                }
            }
            v[Series::Rps as usize] = requests.saturating_sub(last_requests) as f64 * 1000.0
                / at.saturating_sub(last_at).max(1) as f64;
        }
        if let Some((total, available)) = mem {
            v[Series::Mem as usize] = 100.0 * total.saturating_sub(available) as f64 / total.max(1) as f64;
        }
        if let Some(rss) = rss {
            v[Series::Rss as usize] = rss as f64;
        }
        v[Series::Streams as usize] = app.live.count() as f64;
        if let Some(n) = sessions {
            v[Series::Sessions as usize] = n as f64;
        }
        v[Series::Pool as usize] = app.gate.load().0 as f64;
        state.last = Some((ticks, requests, at));
        state.history.push(Sample { at, v });
    }
}
