//! Failed logins slow down whoever guesses wrong, and nobody else (owner's decision, 9 October 2026): no e-mail
//! address is ever locked.
//!
//! - **Per source and account**: after each failure the same source (the client's address) waits before its next
//!   attempt at that e-mail: 1 s, 2 s, 4 s … up to 15 minutes. That is at most 13 guesses in the first hour and 4
//!   an hour after, per source and account. A success ends it. A source has one attempt at an account being
//!   checked at a time. Other sources are not touched.
//! - **Per account**: an account takes 100 checks in an hour. Past that, sources stand in line: one is checked every two seconds, in the order
//!   they came. Each is told its turn and is checked when it comes back then; nobody who was told a later turn
//!   is checked before it while it keeps coming. That is at most 2 000 checks per account in any hour on
//!   record, however many sources there are (twice the 100 where two of its hours meet, 1 800 in line).
//! - **The rightful owner always gets in.** From a source the account knows, a correct credential is checked
//!   and answered at once, whatever others do. From a new source it is checked in its turn, at most ten minutes
//!   later. A wrong credential is answered the same from every source — the same words, the same wait, the same
//!   work — so a guess does not show whether the account knows its source: a known source in line is told to
//!   wait like any other, and its early checks have a back-off of their own, which nobody sees.
//!
//! The password and the Emergency Kit are counted apart (the account key names which). The state lies in the
//! database: a restart resets nothing. It is bounded: per account, and in all (see the constants). Every
//! function here runs inside a write transaction; an attempt is admitted at the moment its check starts.

use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};

use crate::error::Res;

pub const BACKOFF_MAX_MS: u64 = 900_000;
pub const ACCOUNT_BUDGET_PER_HOUR: i64 = 100;
pub const SLOW_LANE_MS: u64 = 2_000;
/// how far ahead turns are given out
pub const LANE_HORIZON_MS: u64 = 600_000;
/// how long after the time it was told a source's turn is kept ahead of later ones
pub const TURN_KEPT_MS: u64 = 3_000;
/// Sources an account keeps a record of. One more makes it forget the one whose wait ran out longest ago; if
/// none has run out, a source it has no record of waits. The sources an account knows always have theirs.
pub const SOURCES_PER_ACCOUNT: i64 = 5_000;
/// The same over all accounts, and e-mails that have none.
pub const SOURCES: i64 = 500_000;
/// Accounts (and e-mails that have none) whose hour is on record. One more makes the hub forget the oldest hour
/// of an e-mail that has no account; an account's own hour is never forgotten.
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
    /// one hash. `early`: the account knows the source, so that hash is the real check: a correct credential
    /// gets in (`early_succeeded`), a wrong one is told to wait like anyone.
    Line { wait: u64, early: bool },
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

/// A source's own state, read only (asked before the hub spends anything on the request; `admit` asks again).
pub fn own_wait(c: &Connection, account: &[u8], source: &[u8], now: u64) -> Res<Option<u64>> {
    let (a, s) = (key(account), key(source));
    let row: Option<(i64, Option<i64>)> = c
        .prepare_cached(
            "SELECT next_at, checking FROM login_sources WHERE account = ?1 AND source = ?2",
        )?
        .query_row(params![&a[..], &s[..]], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?;
    Ok(match row {
        Some((_, Some(_))) => Some(1),
        Some((next_at, None)) if now < next_at as u64 => Some(secs(next_at as u64 - now)),
        _ => None,
    })
}

/// Room for one more source on record, by forgetting one whose wait has run out. `false`: there is none.
fn room_for_source(c: &Connection, a: &Key, now: u64) -> Res<bool> {
    let forget = |of_account: bool| -> Res<bool> {
        let sql = if of_account {
            "DELETE FROM login_sources WHERE rowid = (SELECT rowid FROM login_sources
             WHERE account = ?1 AND checking IS NULL AND next_at <= ?2 AND early_next_at <= ?2 ORDER BY next_at LIMIT 1)"
        } else {
            "DELETE FROM login_sources WHERE rowid = (SELECT rowid FROM login_sources
             WHERE ?1 IS NOT NULL AND checking IS NULL AND next_at <= ?2 AND early_next_at <= ?2 ORDER BY next_at LIMIT 1)"
        };
        let gone = c
            .prepare_cached(sql)?
            .execute(params![&a[..], now as i64])?;
        count(c, "sources", -(gone as i64))?;
        Ok(gone > 0)
    };
    let held: i64 = c
        .prepare_cached("SELECT count(*) FROM login_sources WHERE account = ?1")?
        .query_row([&a[..]], |r| r.get(0))?;
    if held >= SOURCES_PER_ACCOUNT && !forget(true)? {
        return Ok(false);
    }
    let all: i64 = c
        .prepare_cached("SELECT sources FROM login_counts")?
        .query_row([], |r| r.get(0))?;
    Ok(all < SOURCES || forget(false)?)
}

/// Room for one more account's hour, by forgetting the oldest of an e-mail that has no account.
fn room_for_account(c: &Connection) -> Res<bool> {
    let all: i64 = c
        .prepare_cached("SELECT accounts FROM login_counts")?
        .query_row([], |r| r.get(0))?;
    if all < ACCOUNTS {
        return Ok(true);
    }
    let gone = c
        .prepare_cached(
            "DELETE FROM login_accounts WHERE account = (SELECT account FROM login_accounts WHERE real = 0 ORDER BY budget_start LIMIT 1)",
        )?
        .execute([])?;
    count(c, "accounts", -(gone as i64))?;
    Ok(gone > 0)
}

/// May this source's attempt at this account be checked now? `known`: the account has seen a successful sign-in
/// from this source before. `real`: the e-mail has an account. Called when the check is about to start.
pub fn admit(
    c: &Connection,
    account: &[u8],
    source: &[u8],
    known: bool,
    real: bool,
    now: u64,
) -> Res<Verdict> {
    let (a, s) = (key(account), key(source));
    let row: Option<(i64, Option<i64>, i64, i64)> = c
        .prepare_cached("SELECT next_at, checking, early_failures, early_next_at FROM login_sources WHERE account = ?1 AND source = ?2")?
        .query_row(params![&a[..], &s[..]], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .optional()?;
    // the source's own state: one check at a time, and its back-off
    if let Some((next_at, checking, _, _)) = row {
        if checking.is_some() {
            return Ok(Verdict::Own(1));
        }
        if now < next_at as u64 {
            return Ok(Verdict::Own(secs(next_at as u64 - now)));
        }
    }
    let line = |wait: u64| Verdict::Line { wait, early: false };
    // every check is on record: without room for the record there is no check (a source the account knows
    // always has room)
    if row.is_none() && !known && !room_for_source(c, &a, now)? {
        return Ok(line(60));
    }
    // the account's hour, and its line
    let held: Option<(u64, i64, u64, u64)> = c
        .prepare_cached("SELECT budget_start, budget_used, next_turn, last_served FROM login_accounts WHERE account = ?1")?
        .query_row([&a[..]], |r| Ok((r.get::<_, i64>(0)? as u64, r.get(1)?, r.get::<_, i64>(2)? as u64, r.get::<_, i64>(3)? as u64)))
        .optional()?;
    let (mut start, mut used, mut next_turn, mut last_served) = held.unwrap_or((now, 0, 0, 0));
    if now >= start + HOUR_MS {
        (start, used) = (now, 0);
    }
    let mut wait = None;
    let mut touched = false;
    if used < ACCOUNT_BUDGET_PER_HOUR {
        // (every check takes one of the hundred, a known source's too: nothing about the hour tells them apart)
        if held.is_some() || room_for_account(c)? {
            used += 1;
            touched = true;
        } else if !known {
            return Ok(line(60));
        }
    } else {
        // The line. A source is checked when its turn has come, two seconds have passed since the last check
        // in line, and nobody who was told an earlier turn is still expected.
        c.prepare_cached("DELETE FROM login_turns WHERE account = ?1 AND kept_until < ?2")?
            .execute(params![&a[..], now as i64])?;
        let mine: Option<i64> = c
            .prepare_cached("SELECT turn FROM login_turns WHERE account = ?1 AND source = ?2")?
            .query_row(params![&a[..], &s[..]], |r| r.get(0))
            .optional()?;
        let turn = match mine {
            Some(turn) => Some(turn as u64),
            None if next_turn.max(now) > now + LANE_HORIZON_MS => None,
            None => {
                let turn = next_turn.max(now);
                next_turn = turn + SLOW_LANE_MS;
                touched = true;
                Some(turn)
            }
        };
        // when to come back, if not now
        let come_at = match turn {
            None => Some(now + 60_000),
            Some(turn) if now < turn => Some(turn),
            Some(_) if now < last_served + SLOW_LANE_MS => Some(last_served + SLOW_LANE_MS),
            Some(turn) => {
                // until the last of those before it has come or stayed away
                let expected: Option<i64> = c
                    .prepare_cached("SELECT max(kept_until) FROM login_turns WHERE account = ?1 AND turn < ?2 AND source != ?3")?
                    .query_row(params![&a[..], turn as i64, &s[..]], |r| r.get(0))?;
                expected.map(|kept| (kept as u64 + 1).min(now + SLOW_LANE_MS))
            }
        };
        match (turn, come_at) {
            (Some(turn), Some(come_at)) => {
                c.prepare_cached(
                    "INSERT INTO login_turns (account, source, turn, kept_until) VALUES (?1, ?2, ?3, ?4)
                     ON CONFLICT (account, source) DO UPDATE SET kept_until = excluded.kept_until",
                )?
                .execute(params![&a[..], &s[..], turn as i64, (come_at.max(turn) + TURN_KEPT_MS) as i64])?;
            }
            (Some(_), None) => {
                c.prepare_cached("DELETE FROM login_turns WHERE account = ?1 AND source = ?2")?
                    .execute(params![&a[..], &s[..]])?;
                last_served = now;
                next_turn = next_turn.max(now + SLOW_LANE_MS);
                touched = true;
            }
            (None, _) => {}
        }
        wait = come_at.map(|at| secs(at - now));
    }
    if touched {
        let new = c
            .prepare_cached(
                "INSERT INTO login_accounts (account, real, budget_start, budget_used, next_turn, last_served) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT (account) DO UPDATE SET real = excluded.real, budget_start = excluded.budget_start,
                   budget_used = excluded.budget_used, next_turn = excluded.next_turn, last_served = excluded.last_served",
            )?
            .execute(params![&a[..], real, start as i64, used, next_turn as i64, last_served as i64])?;
        if held.is_none() {
            count(c, "accounts", new as i64)?;
        }
    }
    let insert = |checking: Option<i64>, early_failures: i64, early_next_at: u64| -> Res<()> {
        c.prepare_cached(
            "INSERT INTO login_sources (account, source, failures, next_at, checking, early_failures, early_next_at) VALUES (?1, ?2, 0, 0, ?3, ?4, ?5)
             ON CONFLICT (account, source) DO UPDATE SET checking = excluded.checking, early_failures = excluded.early_failures, early_next_at = excluded.early_next_at",
        )?
        .execute(params![&a[..], &s[..], checking, early_failures, early_next_at as i64])?;
        if row.is_none() {
            count(c, "sources", 1)?;
        }
        Ok(())
    };
    let (early_failures, early_next_at) = row.map(|r| (r.2, r.3 as u64)).unwrap_or((0, 0));
    if let Some(wait) = wait {
        // A source the account knows is checked all the same, so that the owner's correct credential gets in.
        // The check is paid for when it is admitted, with a back-off of its own: a guesser at a known source
        // gets no more guesses than at any other.
        let early = known && now >= early_next_at;
        if early {
            let failures = (early_failures + 1).min(1000);
            insert(None, failures, now + backoff_ms(failures as u32))?;
        }
        return Ok(Verdict::Line { wait, early });
    }
    let attempt = i64::from_be_bytes(crate::util::random::<8>()) & i64::MAX;
    insert(Some(attempt), early_failures, early_next_at)?;
    Ok(Verdict::Check { attempt })
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
    count(c, "sources", -(gone as i64))
}

/// A correct credential from a known source that stood in line: its record and its turn are done with.
pub fn early_succeeded(c: &Connection, account: &[u8], source: &[u8]) -> Res<()> {
    let (a, s) = (key(account), key(source));
    let gone = c
        .prepare_cached(
            "DELETE FROM login_sources WHERE account = ?1 AND source = ?2 AND checking IS NULL",
        )?
        .execute(params![&a[..], &s[..]])?;
    count(c, "sources", -(gone as i64))?;
    c.prepare_cached("DELETE FROM login_turns WHERE account = ?1 AND source = ?2")?
        .execute(params![&a[..], &s[..]])?;
    Ok(())
}

/// The attempt was admitted but not checked (the request died): the failures so far and their wait stay.
pub fn not_checked(c: &Connection, account: &[u8], source: &[u8], attempt: i64) -> Res<()> {
    let (a, s) = (key(account), key(source));
    let gone = c
        .prepare_cached(
            "DELETE FROM login_sources WHERE account = ?1 AND source = ?2 AND checking = ?3 AND failures = 0 AND early_failures = 0",
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
    c.execute("DELETE FROM login_sources WHERE checking IS NOT NULL AND failures = 0 AND early_failures = 0", [])?;
    c.execute(
        "UPDATE login_sources SET checking = NULL WHERE checking IS NOT NULL",
        [],
    )?;
    recount(c)
}

/// What has run out: records a day after their wait ended, turns, and an hour that is over with nobody in line.
pub fn sweep(c: &Connection, now: u64) -> Res<()> {
    c.execute(
        "DELETE FROM login_sources WHERE checking IS NULL AND next_at + ?1 <= ?2 AND early_next_at + ?1 <= ?2",
        params![DAY_MS as i64, now as i64],
    )?;
    c.execute(
        "DELETE FROM login_turns WHERE kept_until < ?1",
        [now as i64],
    )?;
    c.execute(
        "DELETE FROM login_accounts WHERE budget_start + ?1 <= ?2 AND max(next_turn, last_served) + ?1 <= ?2",
        params![HOUR_MS as i64, now as i64],
    )?;
    recount(c)
}
