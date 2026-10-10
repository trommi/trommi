//! What a request computes before its transaction (see `memo`): each function reads the state its transaction
//! will find, on a reading connection, and runs the expensive calls into the memo. It decides nothing: the
//! transaction makes every check again and refuses if the state has moved.

use rusqlite::{params, Connection, OptionalExtension};

use crate::delivery::CommitBody;
use crate::memo::{commit_key, Entry, Key, Memo};
use crate::observer::{GroupState, Observer};
use crate::store::{self, Room};

/// A Commit on a state: the Commit itself, and the GroupInfo that came with it.
fn on_state(memo: &Memo, state: &GroupState, body: &CommitBody) {
    if let Ok((_, facts)) = memo.commit(state, &body.commit) {
        let _ = memo.check_group_info(&body.group_info, &facts.after, facts.by.device());
    }
}

/// `POST /v1/groups/{group}/commits` and the code's replacement: if the Commit builds on the group's epoch.
pub fn commit(c: &Connection, memo: &Memo, room: &Room, group_id: &[u8], body: &CommitBody) {
    let Ok(row) = store::group(c, room, group_id) else {
        return;
    };
    if !row.live || body.epoch != row.epoch {
        return;
    }
    if let Ok(state) = store::group_state(c, group_id) {
        on_state(memo, &state, body);
    }
}

/// `POST /v1/rooms`.
pub fn room(memo: &Memo, group_info: &[u8]) {
    let _ = memo.open(group_info);
}

/// `POST /v1/groups`: the founding GroupInfo and the first Commit on it.
pub fn founding(memo: &Memo, group_info_0: &[u8], first: &CommitBody) {
    if let Ok((state, _, _)) = memo.open(group_info_0) {
        on_state(memo, &state, first);
    }
}

pub fn key_packages(memo: &Memo, packages: &[&[u8]]) {
    for p in packages {
        let _ = memo.key_package(p);
    }
}

/// One part of a recovery: on the state the parts before it leave for its group (the last stored part's
/// outcome), else on the group as it stands. Returns the memo key of its Commit.
pub fn recovery_part(
    c: &Connection,
    memo: &Memo,
    room: &Room,
    recovery: &[u8],
    group_id: &[u8],
    body: &CommitBody,
) -> Option<Key> {
    let last: Option<Vec<u8>> = c
        .prepare_cached(
            "SELECT m.value FROM recovery_parts p JOIN recovery_memo m ON m.recovery_id = p.recovery_id AND m.key = p.commit_key
             WHERE p.recovery_id = ?1 AND p.group_id = ?2 ORDER BY p.n DESC LIMIT 1",
        )
        .ok()?
        .query_row(params![recovery, group_id], |r| r.get(0))
        .optional()
        .ok()?;
    let (state, epoch) = match last.as_deref().and_then(Entry::decode) {
        Some(Entry::Committed(state, facts)) => (state, facts.after.epoch),
        _ => {
            let row = store::group(c, room, group_id).ok()?;
            (store::group_state(c, group_id).ok()?, row.epoch)
        }
    };
    if body.epoch != epoch {
        return None;
    }
    on_state(memo, &state, body);
    Some(commit_key(&state, &body.commit))
}
