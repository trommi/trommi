//! Failed logins slow down whoever guesses wrong, and nobody else (owner's decision, 9 October 2026): no e-mail
//! address is ever locked.
//!
//! - **Per source and account**: after each failure the same source (the client's address) waits before its next
//!   attempt at that e-mail: 1 s, 2 s, 4 s … up to 15 minutes. That is at most 13 guesses in the first hour and 4
//!   an hour after, per source and account. A success ends it. Other sources are not touched.
//! - **Per account, for sources it does not know**: an account takes 100 attempts an hour from sources that never
//!   signed in to it. Past that, such sources are served one every two seconds, in the order they came: each is
//!   told when its turn is and is checked when it comes back then. That is at most 1 900 guesses an hour per
//!   account from unknown sources, however many they are. A correct credential is never refused for what others
//!   did: from a source the account knows it is checked at once, from a new one in its turn. The line is at most
//!   ten minutes long; while thousands of sources attack one account at once, a device at a place the account
//!   has never seen may have to ask again for a turn. A place it knows is never in that line.
//!
//! The password and the Emergency Kit are counted apart (the account key names which). State is in memory and
//! bounded; keys are hashes of fixed size.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

use sha2::{Digest, Sha256};

pub const BACKOFF_MAX_MS: u64 = 900_000;
pub const ACCOUNT_BUDGET_PER_HOUR: usize = 100;
pub const SLOW_LANE_MS: u64 = 2_000;
/// how far ahead turns are given out
pub const LANE_HORIZON_MS: u64 = 600_000;
/// how long after its turn a source may still come
const TURN_KEPT_MS: u64 = 60_000;
const MAX_ENTRIES: usize = 200_000;

type Key = [u8; 16];

fn key(parts: &[&[u8]]) -> Key {
    let mut h = Sha256::new();
    for p in parts {
        h.update((p.len() as u64).to_be_bytes());
        h.update(p);
    }
    let mut out = [0u8; 16];
    out.copy_from_slice(&h.finalize()[..16]);
    out
}

struct Source {
    failures: u32,
    next_at: u64,
}

#[derive(Default)]
struct State {
    /// (account, source) → its failures and when it may try again
    sources: HashMap<Key, Source>,
    /// account → the times of attempts from unknown sources within the hour
    budgets: HashMap<Key, VecDeque<u64>>,
    /// account → when the slow lane is free next
    lanes: HashMap<Key, u64>,
    /// (account, source) → its turn in the slow lane
    turns: HashMap<Key, u64>,
}

#[derive(Default)]
pub struct LoginThrottle {
    state: Mutex<State>,
}

/// The wait after `failures` failures in a row.
pub fn backoff_ms(failures: u32) -> u64 {
    if failures == 0 {
        0
    } else {
        (1000u64 << (failures - 1).min(20)).min(BACKOFF_MAX_MS)
    }
}

impl LoginThrottle {
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// May this source try this account now? `Err(seconds)`: when to come back. `known`: the account has seen a
    /// successful sign-in from this source before. An admitted attempt must end in `failed` or `succeeded`.
    pub fn admit(&self, account: &[u8], source: &[u8], known: bool, now: u64) -> Result<(), u64> {
        let (a, pair) = (key(&[account]), key(&[account, source]));
        let secs = |ms: u64| ms.div_ceil(1000).max(1);
        let mut s = self.lock();
        // The state is bounded. When it is full, what has run out goes; if it is still full, sources not yet
        // in it are admitted without a record (they stay under the per-address limit and the account's line):
        // a flood of sources never turns into a refusal for everyone.
        let mut full = s.sources.len() + s.turns.len() >= MAX_ENTRIES;
        if full {
            s.sources.retain(|_, v| now < v.next_at + 3_600_000);
            s.turns.retain(|_, turn| now <= *turn + TURN_KEPT_MS);
            full = s.sources.len() + s.turns.len() >= MAX_ENTRIES;
        }
        // the source's own back-off
        if let Some(src) = s.sources.get(&pair) {
            if now < src.next_at {
                return Err(secs(src.next_at - now));
            }
        }
        if !known {
            let spent = {
                let times = s.budgets.entry(a).or_default();
                while times
                    .front()
                    .is_some_and(|t| now.saturating_sub(*t) >= 3_600_000)
                {
                    times.pop_front();
                }
                if times.len() < ACCOUNT_BUDGET_PER_HOUR {
                    times.push_back(now);
                    false
                } else {
                    true
                }
            };
            if spent {
                // the slow lane: one every two seconds, in the order they came
                match s.turns.get(&pair).copied() {
                    Some(turn) if now < turn => return Err(secs(turn - now)),
                    Some(turn) if now <= turn + TURN_KEPT_MS => {
                        s.turns.remove(&pair);
                    }
                    _ => {
                        s.turns.remove(&pair);
                        let free = s.lanes.get(&a).copied().unwrap_or(0);
                        let turn = free.max(now);
                        // the line is at most ten minutes long: a source that finds it full is told to ask
                        // again, without a turn
                        if turn > now + LANE_HORIZON_MS || (full && turn > now) {
                            return Err(60);
                        }
                        s.lanes.insert(a, turn + SLOW_LANE_MS);
                        if turn > now {
                            s.turns.insert(pair, turn);
                            return Err(secs(turn - now));
                        }
                    }
                }
            }
        }
        // while this attempt is checked, the same source does not start another
        let failures = s.sources.get(&pair).map_or(0, |v| v.failures);
        if !full || s.sources.contains_key(&pair) {
            s.sources.insert(
                pair,
                Source {
                    failures,
                    next_at: now + 1000,
                },
            );
        }
        Ok(())
    }

    pub fn failed(&self, account: &[u8], source: &[u8], now: u64) {
        let pair = key(&[account, source]);
        let mut s = self.lock();
        let failures = s
            .sources
            .get(&pair)
            .map_or(0, |v| v.failures)
            .saturating_add(1);
        if s.sources.len() + s.turns.len() < MAX_ENTRIES || s.sources.contains_key(&pair) {
            s.sources.insert(
                pair,
                Source {
                    failures,
                    next_at: now + backoff_ms(failures),
                },
            );
        }
    }

    /// The attempt was admitted but not checked (the hub was busy): the hold is lifted, the failures so far
    /// and their wait stay.
    pub fn not_checked(&self, account: &[u8], source: &[u8], now: u64) {
        let pair = key(&[account, source]);
        let mut s = self.lock();
        if let Some(src) = s.sources.get_mut(&pair) {
            src.next_at = now + backoff_ms(src.failures);
        }
    }

    pub fn succeeded(&self, account: &[u8], source: &[u8]) {
        self.lock().sources.remove(&key(&[account, source]));
    }

    pub fn sweep(&self, now: u64) {
        let mut s = self.lock();
        s.sources.retain(|_, v| now < v.next_at + 86_400_000);
        s.turns.retain(|_, turn| now <= *turn + TURN_KEPT_MS);
        s.budgets.retain(|_, times| {
            times
                .back()
                .is_some_and(|t| now.saturating_sub(*t) < 3_600_000)
        });
        s.lanes.retain(|_, free| now < *free + 3_600_000);
    }
}
