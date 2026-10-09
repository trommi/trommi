//! Failed logins slow down whoever guesses wrong, and nobody else (owner's decision, 9 October 2026): no e-mail
//! address is ever locked.
//!
//! - **Per source and account**: after each failure the same source (the client's address) waits before its next
//!   attempt at that e-mail: 1 s, 2 s, 4 s … up to 15 minutes. That is at most 13 guesses in the first hour and 4
//!   an hour after, per source and account. A success ends it. Other sources are not touched.
//! - **Per account, for sources it does not know**: an account takes 100 attempts an hour from sources that never
//!   signed in to it. Past that, such sources are served one every two seconds, in the order they came: each is
//!   told when its turn is and is checked when it comes back then, never sooner than two seconds after the one
//!   before it. That is at most 1 900 guesses an hour per
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
    /// the attempt being checked now: its number and when it began
    checking: Option<(u64, u64)>,
}

#[derive(Default)]
struct Lane {
    /// when the next turn that is given out will be
    next_turn: u64,
    /// when the lane last let an attempt through
    last_served: u64,
}

#[derive(Default)]
struct State {
    /// (account, source) → its failures and when it may try again
    sources: HashMap<Key, Source>,
    /// account → the times of attempts from unknown sources within the hour
    budgets: HashMap<Key, VecDeque<u64>>,
    /// account → its slow lane
    lanes: HashMap<Key, Lane>,
    /// (account, source) → its turn in the slow lane
    turns: HashMap<Key, u64>,
    next_attempt: u64,
}

#[derive(Default)]
pub struct LoginThrottle {
    state: Mutex<State>,
}

/// An admitted attempt: it ends in exactly one of `failed`, `succeeded` or `not_checked`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Attempt(u64);

/// The wait after `failures` failures in a row.
pub fn backoff_ms(failures: u32) -> u64 {
    if failures == 0 {
        0
    } else {
        (1000u64 << (failures - 1).min(20)).min(BACKOFF_MAX_MS)
    }
}

/// A check that has not ended after this long is taken for lost (its request died).
const CHECK_MS: u64 = 30_000;

impl LoginThrottle {
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// May this source try this account now? `Err(seconds)`: when to come back. `known`: the account has seen a
    /// successful sign-in from this source before.
    pub fn admit(
        &self,
        account: &[u8],
        source: &[u8],
        known: bool,
        now: u64,
    ) -> Result<Attempt, u64> {
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
        // the source's own state: one check at a time, and its back-off
        if let Some(src) = s.sources.get(&pair) {
            if let Some((_, since)) = src.checking {
                if now < since + CHECK_MS {
                    return Err(1);
                }
            }
            if now < src.next_at {
                return Err(secs(src.next_at - now));
            }
        }
        if !known {
            let spent = {
                if s.budgets.len() >= MAX_ENTRIES && !s.budgets.contains_key(&a) {
                    s.budgets.retain(|_, times| {
                        times
                            .back()
                            .is_some_and(|t| now.saturating_sub(*t) < 3_600_000)
                    });
                }
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
                // The slow lane: turns are given out two seconds apart, in the order sources came; and whatever
                // the turns say, the lane lets one attempt through every two seconds at most.
                let (next_turn, last_served) = s
                    .lanes
                    .get(&a)
                    .map_or((0, 0), |l| (l.next_turn, l.last_served));
                let held = s
                    .turns
                    .get(&pair)
                    .copied()
                    .filter(|turn| now <= *turn + TURN_KEPT_MS);
                let turn = match held {
                    Some(turn) => turn,
                    None => {
                        let turn = next_turn.max(now);
                        // the line is at most ten minutes long: a source that finds it full is told to ask
                        // again, without a turn
                        if turn > now + LANE_HORIZON_MS || (full && turn > now) {
                            return Err(60);
                        }
                        s.lanes.entry(a).or_default().next_turn = turn + SLOW_LANE_MS;
                        if turn > now {
                            s.turns.insert(pair, turn);
                        }
                        turn
                    }
                };
                if now < turn {
                    return Err(secs(turn - now));
                }
                if now < last_served + SLOW_LANE_MS {
                    // its turn has come, the lane is not free yet: it keeps its place
                    s.turns.insert(pair, turn);
                    return Err(secs(last_served + SLOW_LANE_MS - now));
                }
                s.turns.remove(&pair);
                s.lanes.entry(a).or_default().last_served = now;
            }
        }
        s.next_attempt += 1;
        let id = s.next_attempt;
        if !full || s.sources.contains_key(&pair) {
            let src = s.sources.entry(pair).or_insert(Source {
                failures: 0,
                next_at: 0,
                checking: None,
            });
            src.checking = Some((id, now));
        }
        Ok(Attempt(id))
    }

    /// Ends an attempt, if it is the one this source is at (a result that comes late changes nothing).
    fn end(
        &self,
        account: &[u8],
        source: &[u8],
        attempt: Attempt,
        then: impl FnOnce(&mut Source) -> bool,
    ) {
        let pair = key(&[account, source]);
        let mut s = self.lock();
        let Some(src) = s.sources.get_mut(&pair) else {
            return;
        };
        if src.checking.map(|(id, _)| id) != Some(attempt.0) {
            return;
        }
        src.checking = None;
        if !then(src) {
            s.sources.remove(&pair);
        }
    }

    pub fn failed(&self, account: &[u8], source: &[u8], attempt: Attempt, now: u64) {
        self.end(account, source, attempt, |src| {
            src.failures = src.failures.saturating_add(1);
            src.next_at = now + backoff_ms(src.failures);
            true
        });
    }

    pub fn succeeded(&self, account: &[u8], source: &[u8], attempt: Attempt) {
        self.end(account, source, attempt, |_| false);
    }

    /// The attempt was admitted but not checked (the hub was busy): the failures so far and their wait stay.
    pub fn not_checked(&self, account: &[u8], source: &[u8], attempt: Attempt) {
        self.end(account, source, attempt, |src| src.failures > 0);
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
        s.lanes
            .retain(|_, lane| now < lane.next_turn.max(lane.last_served) + 3_600_000);
    }
}
