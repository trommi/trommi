//! Failed logins slow down whoever guesses wrong, and nobody else (owner's decision, 9 October 2026): no e-mail
//! address is ever locked.
//!
//! - **Per source and account**: after each failed check the same source (the client's address) waits before its
//!   next check at that e-mail: 1 s, 2 s, 4 s … up to 15 minutes. That is at most 13 guesses in the first hour
//!   and 4 an hour after, per source and account, whatever else happens. A success ends it. A source has one
//!   check at an account running at a time, however long it takes. Other sources are not touched.
//! - **Per account**: an account takes 100 checks in an hour. Past that, sources stand in line: turns are given
//!   out two seconds apart, in the order sources came, and a turn is good for one check, from its time until
//!   five seconds after, for a request that reaches the hub in that time (it may then wait for the hub's pool).
//!   Nobody else can take it; who comes later than that asks for a new one. That is at most
//!   2 010 checks per account in any hour on record, however many sources there are (1 800 turns of that hour,
//!   the few given out before it that are still good, twice the 100 where two of its hours meet), beside the
//!   early checks of the few sources it knows.
//! - **The rightful owner always gets in.** From a source the account knows, a credential is checked at once
//!   also while the source stands in line (an early check): the right one gets in whatever others do. From a
//!   new source it is checked at its turn, at most ten minutes later.
//! - **One answer.** A wrong credential in line is answered the same from every source — the same words, the
//!   turn's wait, the same work: a known source whose early check failed is told to wait its turn like any
//!   other. (What is left to tell them apart: see spec/hub-api.md.)
//!
//! The password and the Emergency Kit are counted apart (the account key names which). The state lies in the
//! database: a restart resets nothing. It is bounded: per account, and in all (see the constants). Every
//! function here runs inside a write transaction and takes the time there: an attempt is admitted at the moment
//! its check starts.

use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};

use crate::error::Res;

pub const BACKOFF_MAX_MS: u64 = 900_000;
pub const ACCOUNT_BUDGET_PER_HOUR: i64 = 100;
pub const SLOW_LANE_MS: u64 = 2_000;
/// how far ahead turns are given out
pub const LANE_HORIZON_MS: u64 = 600_000;
/// how long after its time a turn is good (the answer's whole seconds, a slow network)
pub const TURN_GOOD_MS: u64 = 5_000;
/// how long a request that came in time may wait inside the hub and still have its turn
pub const HELD_MS: u64 = crate::memo::GATE_WAIT_MS + 1_000;
/// Sources an account keeps a record of. One more makes it forget the one whose wait ran out longest ago; if
/// none has run out, a source it has no record of waits. The sources an account knows always have theirs.
pub const SOURCES_PER_ACCOUNT: i64 = 5_000;
/// The same over all accounts, and e-mails that have none (beside the records of sources an account knows:
/// at most 16 for each account).
pub const SOURCES: i64 = 500_000;
/// E-mails whose hour is on record. One more makes the hub forget the oldest hour.
pub const ACCOUNTS: i64 = 200_000;
const HOUR_MS: u64 = 3_600_000;
const DAY_MS: u64 = 86_400_000;

type Key = [u8; 16];

fn key(part: &[u8]) -> Key {
    let mut out = [0u8; 16];
    out.copy_from_slice(&Sha256::digest(part)[..16]);
    out
}

/// The wait after `failures` failures in a row.
pub fn backoff_ms(failures: u32) -> u64 {
    if failures == 0 {
        0
    } else {
        (1000u64 << (failures - 1).min(20)).min(BACKOFF_MAX_MS)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// The check starts now, on record. It ends in exactly one of `failed`, `succeeded` or `not_checked`.
    Check { attempt: i64 },
    /// The source waits out its own failures (or has a check running): answered at once, nothing spent.
    Own(u64),
    /// The source stands in the account's line and is told to come back in so many seconds. The answer costs
    /// one hash. `early`: the account knows the source, so that hash is a real check on record, ending like any
    /// (`failed`, `succeeded`, `not_checked`): a correct credential gets in, a wrong one is told to wait.
    Line { wait: u64, early: Option<i64> },
}

fn secs(ms: u64) -> u64 {
    ms.div_ceil(1000).max(1)
}

fn count(c: &Connection, column: &str, by: i64) -> Res<()> {
    c.execute(
        &format!("UPDATE login_counts SET {column} = max(0, {column} + ?1)"),
        [by],
    )?;
    Ok(())
}

struct Own {
    on_record: bool,
    wait: Option<u64>,
    /// the record was made while the tables were full
    over: bool,
}

fn own_state(c: &Connection, a: &Key, s: &Key, now: u64) -> Res<Own> {
    let row: Option<(i64, Option<i64>, bool)> = c
        .prepare_cached(
            "SELECT next_at, checking, over FROM login_sources WHERE account = ?1 AND source = ?2",
        )?
        .query_row(params![&a[..], &s[..]], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .optional()?;
    Ok(match row {
        Some((_, Some(_), over)) => Own {
            on_record: true,
            wait: Some(1),
            over,
        },
        Some((next_at, None, over)) => Own {
            on_record: true,
            wait: (now < next_at as u64).then(|| secs(next_at as u64 - now)),
            over,
        },
        None => Own {
            on_record: false,
            wait: None,
            over: false,
        },
    })
}

/// A source's own state, read only (asked before the hub spends anything on the request; `admit` asks again).
/// A source that stands in line is not answered here: its answer is the line's, at the line's cost.
pub fn own_wait(c: &Connection, account: &[u8], source: &[u8], now: u64) -> Res<Option<u64>> {
    let (a, s) = (key(account), key(source));
    let in_line: bool = c
        .prepare_cached(
            "SELECT 1 FROM login_turns WHERE account = ?1 AND source = ?2 AND good_until >= ?3",
        )?
        .exists(params![&a[..], &s[..], now as i64])?;
    let own = own_state(c, &a, &s, now)?;
    Ok(if in_line || own.over { None } else { own.wait })
}

/// Room for one more source on record, by forgetting one whose wait has run out. `false`: there is none.
fn room_for_source(c: &Connection, a: &Key, asker: &Key, now: u64) -> Res<bool> {
    let forget = |of_account: bool| -> Res<bool> {
        let sql = if of_account {
            "DELETE FROM login_sources WHERE rowid = (SELECT rowid FROM login_sources INDEXED BY login_sources_by_account_wait
             WHERE account = ?1 AND checking IS NULL AND next_at <= ?2 AND source != ?3 ORDER BY next_at LIMIT 1)"
        } else {
            "DELETE FROM login_sources WHERE rowid = (SELECT rowid FROM login_sources INDEXED BY login_sources_by_wait
             WHERE checking IS NULL AND next_at <= ?2 AND NOT (account = ?1 AND source = ?3) ORDER BY next_at LIMIT 1)"
        };
        let gone = c
            .prepare_cached(sql)?
            .execute(params![&a[..], now as i64, &asker[..]])?;
        count(c, "sources", -(gone as i64))?;
        Ok(gone > 0)
    };
    let held: i64 = c
        .prepare_cached("SELECT count(*) FROM login_sources WHERE account = ?1 AND over = 0")?
        .query_row([&a[..]], |r| r.get(0))?;
    if held >= SOURCES_PER_ACCOUNT && !forget(true)? {
        return Ok(false);
    }
    let all: i64 = c
        .prepare_cached("SELECT sources FROM login_counts")?
        .query_row([], |r| r.get(0))?;
    Ok(all < SOURCES || forget(false)?)
}

/// Room for one more e-mail's hour, by forgetting the oldest, with its line.
fn room_for_account(c: &Connection) -> Res<()> {
    let all: i64 = c
        .prepare_cached("SELECT accounts FROM login_counts")?
        .query_row([], |r| r.get(0))?;
    if all >= ACCOUNTS {
        let oldest: Option<Vec<u8>> = c
            .prepare_cached("SELECT account FROM login_accounts ORDER BY budget_start LIMIT 1")?
            .query_row([], |r| r.get(0))
            .optional()?;
        if let Some(oldest) = oldest {
            c.prepare_cached("DELETE FROM login_turns WHERE account = ?1")?
                .execute([&oldest])?;
            let gone = c
                .prepare_cached("DELETE FROM login_accounts WHERE account = ?1")?
                .execute([&oldest])?;
            count(c, "accounts", -(gone as i64))?;
        }
    }
    Ok(())
}

/// May this source's attempt at this account be checked now? `known`: the account has seen a successful sign-in
/// from this source before. Called when the check is about to start, with the time of that moment (`now`) and
/// the time its request reached the hub (`arrived`): a turn is kept by coming in time, whatever the request
/// then waits for inside the hub (at most `HELD_MS`, the pool's longest wait).
pub fn admit(
    c: &Connection,
    account: &[u8],
    source: &[u8],
    known: bool,
    now: u64,
    arrived: u64,
) -> Res<Verdict> {
    // (a request that says it came later than now, or longer ago than a request can wait, came now)
    let arrived = if arrived > now || arrived + HELD_MS < now {
        now
    } else {
        arrived
    };
    let (a, s) = (key(account), key(source));
    // the source's own state: one check at a time, and its back-off
    let Own {
        on_record,
        wait: own,
        over,
    } = own_state(c, &a, &s, now)?;
    // A record made while the tables were full (only a source the account knows has one) stands outside them:
    // it is asked about room like a source without a record, and while there is none it is answered as a full
    // table answers, whatever its own state — nothing tells that the account knows this source.
    let full = (!on_record || over) && !room_for_source(c, &a, &s, now)?;
    if full && own.is_some() {
        return Ok(Verdict::Line {
            wait: 60,
            early: None,
        });
    }
    // the account's hour, and its line
    let held: Option<(u64, i64, u64)> = c
        .prepare_cached(
            "SELECT budget_start, budget_used, next_turn FROM login_accounts WHERE account = ?1",
        )?
        .query_row([&a[..]], |r| {
            Ok((
                r.get::<_, i64>(0)? as u64,
                r.get(1)?,
                r.get::<_, i64>(2)? as u64,
            ))
        })
        .optional()?;
    let (mut start, mut used, mut next_turn) = held.unwrap_or((now, 0, 0));
    if now >= start + HOUR_MS {
        (start, used) = (now, 0);
    }
    let save = |start: u64, used: i64, next_turn: u64| -> Res<()> {
        if held.is_none() {
            room_for_account(c)?;
        }
        let new = c
            .prepare_cached(
                "INSERT INTO login_accounts (account, budget_start, budget_used, next_turn) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT (account) DO UPDATE SET budget_start = excluded.budget_start, budget_used = excluded.budget_used, next_turn = excluded.next_turn",
            )?
            .execute(params![&a[..], start as i64, used, next_turn as i64])?;
        if held.is_none() {
            count(c, "accounts", new as i64)?;
        }
        Ok(())
    };
    // when to come back, if this is not the moment for a check on the line's account
    let wait: Option<u64> = if full {
        Some(60)
    } else if used < ACCOUNT_BUDGET_PER_HOUR {
        // (every check takes one of the hundred, a known source's too: nothing about the hour tells them apart)
        match own {
            Some(wait) => return Ok(Verdict::Own(wait)),
            None => {
                save(start, used + 1, next_turn)?;
                None
            }
        }
    } else {
        'line: {
            // The line. Turns are two seconds apart; a turn is the source's alone and good from its time for five
            // seconds. One that ran out is replaced by a new one at the end.
            // (a turn is cleared away only when no request that came in time can still be waiting inside the hub)
            c.prepare_cached(
                "DELETE FROM login_turns WHERE account = ?1 AND good_until + ?3 < ?2",
            )?
            .execute(params![&a[..], now as i64, HELD_MS as i64])?;
            let mine: Option<(i64, i64)> = c
                .prepare_cached(
                    "SELECT turn, good_until FROM login_turns WHERE account = ?1 AND source = ?2",
                )?
                .query_row(params![&a[..], &s[..]], |r| Ok((r.get(0)?, r.get(1)?)))
                .optional()?;
            // A request that came after its source's turn ran out has no turn. The old one stays where it is until
            // no request that came in time can still be waiting (it may be this source's own, a moment ahead):
            // then a new turn is given. Until then: come again.
            if let Some((_, good_until)) = mine {
                if arrived > good_until as u64 {
                    let again = secs(
                        good_until as u64 + HELD_MS + 1 - now.min(good_until as u64 + HELD_MS),
                    );
                    break 'line Some(again.max(own.unwrap_or(0)));
                }
            }
            let turn = match mine {
                Some((turn, _)) => Some(turn as u64),
                None if next_turn.max(now) > now + LANE_HORIZON_MS => None,
                None => {
                    let turn = next_turn.max(now);
                    next_turn = turn + SLOW_LANE_MS;
                    save(start, used, next_turn)?;
                    c.prepare_cached("INSERT INTO login_turns (account, source, turn, good_until) VALUES (?1, ?2, ?3, ?4)")?
                    .execute(params![&a[..], &s[..], turn as i64, (turn + TURN_GOOD_MS) as i64])?;
                    Some(turn)
                }
            };
            match turn {
                // the line is full: ask again
                None => Some(60.max(own.unwrap_or(0))),
                Some(turn) if now < turn => Some(secs(turn - now).max(own.unwrap_or(0))),
                // its turn has come
                Some(_) => match own {
                    // (still waiting out an early check that failed: the turn stays good for what is left of it)
                    Some(wait) => return Ok(Verdict::Own(wait)),
                    None => {
                        c.prepare_cached(
                            "DELETE FROM login_turns WHERE account = ?1 AND source = ?2",
                        )?
                        .execute(params![&a[..], &s[..]])?;
                        None
                    }
                },
            }
        }
    };
    let record = |attempt: i64| -> Res<()> {
        c.prepare_cached(
            "INSERT INTO login_sources (account, source, failures, next_at, checking, over) VALUES (?1, ?2, 0, 0, ?3, ?4)
             ON CONFLICT (account, source) DO UPDATE SET checking = excluded.checking, over = excluded.over",
        )?
        .execute(params![&a[..], &s[..], attempt, full])?;
        if !on_record {
            count(c, "sources", 1)?;
        }
        Ok(())
    };
    let attempt = i64::from_be_bytes(crate::util::random::<8>()) & i64::MAX;
    match wait {
        None => {
            record(attempt)?;
            Ok(Verdict::Check { attempt })
        }
        // A source the account knows is checked all the same, so that the owner's correct credential gets in:
        // a check on record like any, under the source's one back-off.
        Some(wait) if known && own.is_none() => {
            record(attempt)?;
            Ok(Verdict::Line {
                wait,
                early: Some(attempt),
            })
        }
        Some(wait) => Ok(Verdict::Line { wait, early: None }),
    }
}

pub fn failed(c: &Connection, account: &[u8], source: &[u8], attempt: i64, now: u64) -> Res<()> {
    let (a, s) = (key(account), key(source));
    let failures: Option<i64> = c
        .prepare_cached("SELECT failures FROM login_sources WHERE account = ?1 AND source = ?2 AND checking = ?3")?
        .query_row(params![&a[..], &s[..], attempt], |r| r.get(0))
        .optional()?;
    if let Some(failures) = failures {
        let failures = (failures + 1).min(1000);
        c.prepare_cached("UPDATE login_sources SET failures = ?1, next_at = ?2, checking = NULL WHERE account = ?3 AND source = ?4")?
            .execute(params![failures, (now + backoff_ms(failures as u32)) as i64, &a[..], &s[..]])?;
    }
    Ok(())
}

pub fn succeeded(c: &Connection, account: &[u8], source: &[u8], attempt: i64) -> Res<()> {
    let (a, s) = (key(account), key(source));
    let gone = c
        .prepare_cached(
            "DELETE FROM login_sources WHERE account = ?1 AND source = ?2 AND checking = ?3",
        )?
        .execute(params![&a[..], &s[..], attempt])?;
    count(c, "sources", -(gone as i64))?;
    // a place in line is done with
    c.prepare_cached("DELETE FROM login_turns WHERE account = ?1 AND source = ?2")?
        .execute(params![&a[..], &s[..]])?;
    Ok(())
}

/// The attempt was admitted but not checked (the request died): the failures so far and their wait stay.
pub fn not_checked(c: &Connection, account: &[u8], source: &[u8], attempt: i64) -> Res<()> {
    let (a, s) = (key(account), key(source));
    let gone = c
        .prepare_cached(
            "DELETE FROM login_sources WHERE account = ?1 AND source = ?2 AND checking = ?3 AND failures = 0",
        )?
        .execute(params![&a[..], &s[..], attempt])?;
    count(c, "sources", -(gone as i64))?;
    c.prepare_cached("UPDATE login_sources SET checking = NULL WHERE account = ?1 AND source = ?2 AND checking = ?3")?
        .execute(params![&a[..], &s[..], attempt])?;
    Ok(())
}

fn recount(c: &Connection) -> Res<()> {
    c.execute(
        "UPDATE login_counts SET sources = (SELECT count(*) FROM login_sources), accounts = (SELECT count(*) FROM login_accounts)",
        [],
    )?;
    Ok(())
}

/// At start: no check outlives its process.
pub fn recover(c: &Connection) -> Res<()> {
    c.execute(
        "DELETE FROM login_sources WHERE checking IS NOT NULL AND failures = 0",
        [],
    )?;
    c.execute(
        "UPDATE login_sources SET checking = NULL WHERE checking IS NOT NULL",
        [],
    )?;
    recount(c)
}

/// What has run out: records a day after their wait ended, turns, and an hour that is over with nobody in line.
pub fn sweep(c: &Connection, now: u64) -> Res<()> {
    c.execute(
        "DELETE FROM login_sources WHERE checking IS NULL AND next_at + ?1 <= ?2",
        params![DAY_MS as i64, now as i64],
    )?;
    c.execute(
        "DELETE FROM login_turns WHERE good_until + 11000 < ?1",
        [now as i64],
    )?;
    c.execute(
        "DELETE FROM login_accounts WHERE budget_start + ?1 <= ?2 AND next_turn + ?1 <= ?2",
        params![HOUR_MS as i64, now as i64],
    )?;
    recount(c)
}
