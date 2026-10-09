//! Accounts (spec/v2.md 8.8, spec/v1.md §16): an e-mail with a password, passkeys or both, and an Emergency Kit.
//! An account is a way into its rooms: each way in opens a sealed copy of a room's recovery code. The hub checks
//! the login and hands out the sealed copy; it never sees the password, the kit's words, a prf output or the
//! code. An account has a list of rooms (one for now).

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

use argon2::{Algorithm, Argon2, Params, Version};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

use crate::error::{refuse, Res};
use crate::store::Room;
use crate::util::{b64, random, same, unb64};
use crate::webauthn;

pub const SEALED_COPY_LEN: usize = 61;
const MAX_PASSKEYS: i64 = 20;
const PASSKEY_CHALLENGE_MS: u64 = 120_000;

/// v1 §16.1: trim, only U+0021–U+007E, lowercase, one `@`, the lengths. Refused otherwise, never mapped.
pub fn normalise_email(input: &str) -> Res<String> {
    let bad = || refuse("bad-email", "not an e-mail address this hub takes");
    let trimmed = input.trim_matches(|c: char| c == ' ' || ('\u{9}'..='\u{d}').contains(&c));
    if !trimmed.chars().all(|c| ('\u{21}'..='\u{7e}').contains(&c)) {
        return Err(bad());
    }
    let email = trimmed.to_ascii_lowercase();
    let mut parts = email.split('@');
    let (Some(local), Some(domain), None) = (parts.next(), parts.next(), parts.next()) else {
        return Err(bad());
    };
    let Some((before, after)) = domain.rsplit_once('.') else {
        return Err(bad());
    };
    let fits = email.len() <= 254
        && (1..=64).contains(&local.len())
        && (1..=190).contains(&before.len())
        && (2..=63).contains(&after.len());
    if !fits {
        return Err(bad());
    }
    Ok(email)
}

/// A slow hash of a login key the device derived. The key is 32 bytes out of the device's own Argon2id over the
/// password, so this hash only has to make a stolen table useless as a login; its cost is small on purpose.
pub fn slow_hash(key: &[u8], salt: &[u8]) -> [u8; 32] {
    let params = Params::new(19_456, 2, 1, Some(32)).expect("fixed parameters");
    let mut out = [0u8; 32];
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(key, salt, &mut out)
        .expect("fixed lengths");
    out
}

fn bytes(v: &Value, key: &str, len: usize) -> Res<Vec<u8>> {
    v[key]
        .as_str()
        .and_then(unb64)
        .filter(|b| b.len() == len)
        .ok_or_else(|| refuse("bad-format", format!("{key}: {len} bytes, base64url")))
}

fn var_bytes(v: &Value, key: &str, max: usize) -> Res<Vec<u8>> {
    v[key]
        .as_str()
        .and_then(unb64)
        .filter(|b| !b.is_empty() && b.len() <= max)
        .ok_or_else(|| refuse("bad-format", format!("{key}: base64url")))
}

/// v1 §16.3: a sealed copy is 61 bytes and begins with 0x02; anything else is refused, not converted.
fn sealed_copy(v: &Value, key: &str) -> Res<Vec<u8>> {
    let copy = bytes(v, key, SEALED_COPY_LEN)?;
    if copy[0] != 0x02 {
        return Err(refuse("bad-format", "a sealed copy of another format"));
    }
    Ok(copy)
}

/// v1 §16.6: the key derivation record is pinned; the hub stores and returns exactly it.
fn kdf_record(v: &Value) -> Res<String> {
    let k = &v["kdf"];
    let pinned =
        k["alg"] == "argon2id" && k["v"] == 1 && k["m"] == 65536 && k["t"] == 3 && k["p"] == 1;
    if !pinned {
        return Err(refuse(
            "bad-format",
            "the key derivation record is pinned to argon2id v1, m 65536, t 3, p 1",
        ));
    }
    Ok(json!({ "alg": "argon2id", "v": 1, "m": 65536, "t": 3, "p": 1 }).to_string())
}

/// In-memory state of the account routes: passkey challenges, the dummies that make an unknown e-mail cost and
/// answer like a known one.
pub struct Accounts {
    challenges: Mutex<(HashMap<[u8; 32], (u64, Option<i64>)>, VecDeque<[u8; 32]>)>,
    dummy_salt: [u8; 16],
    dummy_key: Vec<u8>,
    pub origins: Vec<String>,
}

impl Accounts {
    pub fn new(origins: Vec<String>) -> Self {
        Accounts {
            challenges: Mutex::new((HashMap::new(), VecDeque::new())),
            dummy_salt: random(),
            dummy_key: webauthn::dummy_key(),
            origins,
        }
    }

    /// A passkey challenge: 32 random bytes, two minutes, one use. `account`: the account a new passkey is for;
    /// `None` for a sign-in or the passkey of a new account.
    pub fn challenge(&self, account: Option<i64>, now: u64) -> [u8; 32] {
        let c = random::<32>();
        let mut held = self.challenges.lock().unwrap_or_else(|e| e.into_inner());
        while held.1.len() >= 10_000 {
            if let Some(old) = held.1.pop_front() {
                held.0.remove(&old);
            }
        }
        held.0.insert(c, (now + PASSKEY_CHALLENGE_MS, account));
        held.1.push_back(c);
        c
    }

    /// Uses a challenge up, whatever the outcome.
    fn take_challenge(&self, challenge: &[u8], account: Option<i64>, now: u64) -> bool {
        let Ok(c) = <[u8; 32]>::try_from(challenge) else {
            return false;
        };
        let held = self
            .challenges
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .0
            .remove(&c);
        matches!(held, Some((expires, scope)) if expires > now && scope == account)
    }

    fn register_passkey(
        &self,
        v: &Value,
        account: Option<i64>,
        now: u64,
    ) -> Res<(webauthn::Registered, Vec<u8>, String)> {
        let bad = |w: webauthn::Bad| refuse("bad-passkey", w.0);
        let attestation = var_bytes(v, "attestation_object", 8192)?;
        let client_data = var_bytes(v, "client_data_json", 4096)?;
        let copy = sealed_copy(v, "sealed_copy")?;
        let (challenge, origin) =
            webauthn::client_challenge(&client_data, "webauthn.create").map_err(bad)?;
        if !self.take_challenge(&challenge, account, now) {
            return Err(refuse("bad-passkey", "challenge"));
        }
        let registered = webauthn::register(&attestation, &origin, &self.origins).map_err(bad)?;
        let transports: Vec<&str> = v["transports"]
            .as_array()
            .map(|a| a.iter().filter_map(|t| t.as_str()).collect())
            .unwrap_or_default();
        let plain = transports.len() <= 8
            && transports
                .iter()
                .all(|t| t.len() <= 16 && t.bytes().all(|b| b.is_ascii_lowercase() || b == b'-'));
        if !plain {
            return Err(refuse("bad-passkey", "transports"));
        }
        Ok((registered, copy, json!(transports).to_string()))
    }

    /// v1 §16.8: an account is made with its kit in one request: none exists without one. A way in comes with
    /// it: a password, a passkey or both.
    pub fn create(&self, c: &Connection, room: &Room, v: &Value, now: u64) -> Res<Value> {
        let email = normalise_email(v["email"].as_str().unwrap_or(""))?;
        let kit = &v["kit"];
        let kit_auth = bytes(kit, "auth_key", 32)?;
        let kit_copy = sealed_copy(kit, "sealed_copy")?;
        let password = match &v["password"] {
            Value::Null => None,
            p => Some((
                bytes(p, "auth_key", 32)?,
                sealed_copy(p, "sealed_copy")?,
                kdf_record(p)?,
            )),
        };
        let passkey = match &v["passkey"] {
            Value::Null => None,
            p => Some(self.register_passkey(p, None, now)?),
        };
        if password.is_none() && passkey.is_none() {
            return Err(refuse(
                "bad-format",
                "an account needs a way in: a password or a passkey",
            ));
        }
        if c.prepare_cached("SELECT 1 FROM account_rooms WHERE room_id = ?1")?
            .exists([&room[..]])?
        {
            return Err(refuse("account-exists", "this room has an account"));
        }
        if c.prepare_cached("SELECT 1 FROM accounts WHERE email = ?1")?
            .exists([&email])?
        {
            return Err(refuse(
                "account-exists",
                "an account with this e-mail exists",
            ));
        }
        let kit_salt = random::<16>();
        let (auth_salt, auth_hash, kdf, password_copy) = match &password {
            Some((auth, copy, kdf)) => {
                let salt = random::<16>();
                (
                    Some(salt.to_vec()),
                    Some(slow_hash(auth, &salt).to_vec()),
                    Some(kdf.clone()),
                    Some(copy.clone()),
                )
            }
            None => (None, None, None, None),
        };
        c.prepare_cached(
            "INSERT INTO accounts (email, created_at, updated_at, auth_salt, auth_hash, kdf, password_copy, kit_salt, kit_hash, kit_copy, user_handle)
             VALUES (?1, ?2, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        )?
        .execute(params![email, now as i64, auth_salt, auth_hash, kdf, password_copy, &kit_salt[..], &slow_hash(&kit_auth, &kit_salt)[..], kit_copy, &random::<32>()[..]])?;
        let account = c.last_insert_rowid();
        c.prepare_cached(
            "INSERT INTO account_rooms (account_id, room_id, position) VALUES (?1, ?2, 0)",
        )?
        .execute(params![account, &room[..]])?;
        if let Some((registered, copy, transports)) = passkey {
            insert_passkey(c, account, &registered, &copy, &transports, now)?;
        }
        crate::log::info(
            "account_created",
            json!({ "room": crate::util::short(room) }),
        );
        account_view(c, account)
    }

    pub fn add_passkey(&self, c: &Connection, room: &Room, v: &Value, now: u64) -> Res<Value> {
        let account = account_of(c, room)?;
        let count: i64 = c
            .prepare_cached("SELECT count(*) FROM passkeys WHERE account_id = ?1")?
            .query_row([account], |r| r.get(0))?;
        if count >= MAX_PASSKEYS {
            return Err(refuse("too-many", "an account has at most 20 passkeys"));
        }
        let (registered, copy, transports) = self.register_passkey(v, Some(account), now)?;
        insert_passkey(c, account, &registered, &copy, &transports, now)?;
        bump(c, account, now)?;
        Ok(json!({ "credential_id": b64(&registered.credential_id), "created_at": now }))
    }

    /// Sign-in with e-mail and the login key. One answer for an unknown e-mail and a wrong password (v1 §16.9),
    /// at one cost: a hash is always computed.
    pub fn login(&self, c: &Connection, v: &Value, kit: bool) -> Res<Option<(i64, Vec<u8>)>> {
        let email = normalise_email(v["email"].as_str().unwrap_or("")).ok();
        let auth = bytes(v, "auth_key", 32)?;
        let (salt_col, hash_col, copy_col) = if kit {
            ("kit_salt", "kit_hash", "kit_copy")
        } else {
            ("auth_salt", "auth_hash", "password_copy")
        };
        let row: Option<(i64, Option<Vec<u8>>, Option<Vec<u8>>, Option<Vec<u8>>)> = match &email {
            Some(e) => c
                .prepare_cached(&format!("SELECT account_id, {salt_col}, {hash_col}, {copy_col} FROM accounts WHERE email = ?1"))?
                .query_row([e], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
                .optional()?,
            None => None,
        };
        match row {
            Some((account, Some(salt), Some(hash), Some(copy))) => {
                Ok(same(&slow_hash(&auth, &salt), &hash).then_some((account, copy)))
            }
            _ => {
                let _ = slow_hash(&auth, &self.dummy_salt);
                Ok(None)
            }
        }
    }

    /// Sign-in with a passkey. An unknown credential is checked against a key nobody holds.
    pub fn passkey_login(
        &self,
        c: &Connection,
        v: &Value,
        now: u64,
    ) -> Res<Option<(i64, Vec<u8>)>> {
        let credential_id = var_bytes(v, "credential_id", 1023)?;
        let authenticator_data = var_bytes(v, "authenticator_data", 1024)?;
        let client_data = var_bytes(v, "client_data_json", 4096)?;
        let signature = var_bytes(v, "signature", 512)?;
        let row: Option<(i64, Vec<u8>, Vec<u8>, Vec<u8>)> = c
            .prepare_cached("SELECT p.account_id, p.public_key, p.sealed_copy, a.user_handle FROM passkeys p JOIN accounts a ON a.account_id = p.account_id WHERE p.credential_id = ?1")?
            .query_row([&credential_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .optional()?;
        let Ok((challenge, origin)) = webauthn::client_challenge(&client_data, "webauthn.get")
        else {
            return Ok(None);
        };
        let fresh = self.take_challenge(&challenge, None, now);
        let key = row.as_ref().map_or(&self.dummy_key, |r| &r.1);
        let verified = webauthn::assert(
            key,
            &authenticator_data,
            &client_data,
            &signature,
            &origin,
            &self.origins,
        );
        let handle_fits = match (&row, v["user_handle"].as_str().and_then(unb64)) {
            (Some((_, _, _, handle)), Some(given)) => same(handle, &given),
            _ => true,
        };
        match (row, verified, fresh && handle_fits) {
            (Some((account, _, copy, _)), Ok(sign_count), true) => {
                c.prepare_cached("UPDATE passkeys SET sign_count = ?1, last_used_at = ?2 WHERE credential_id = ?3")?
                    .execute(params![sign_count, now as i64, credential_id])?;
                Ok(Some((account, copy)))
            }
            _ => Ok(None),
        }
    }
}

fn insert_passkey(
    c: &Connection,
    account: i64,
    r: &webauthn::Registered,
    copy: &[u8],
    transports: &str,
    now: u64,
) -> Res<()> {
    let n = c
        .prepare_cached(
            "INSERT OR IGNORE INTO passkeys (credential_id, account_id, public_key, algorithm, sign_count, transports, sealed_copy, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        )?
        .execute(params![r.credential_id, account, r.public_key, r.algorithm, r.sign_count, transports, copy, now as i64])?;
    if n == 0 {
        // a credential id is registered once, with whichever account; it is never moved or replaced
        return Err(refuse("bad-passkey", "this passkey is registered"));
    }
    Ok(())
}

fn bump(c: &Connection, account: i64, now: u64) -> Res<()> {
    c.prepare_cached(
        "UPDATE accounts SET revision = revision + 1, updated_at = ?1 WHERE account_id = ?2",
    )?
    .execute(params![now as i64, account])?;
    Ok(())
}

pub fn account_of(c: &Connection, room: &Room) -> Res<i64> {
    c.prepare_cached("SELECT account_id FROM account_rooms WHERE room_id = ?1")?
        .query_row([&room[..]], |r| r.get(0))
        .optional()?
        .ok_or_else(|| refuse("not-found", "this room has no account"))
}

/// The rooms of an account, in their order.
pub fn rooms_of(c: &Connection, account: i64) -> Res<Vec<Room>> {
    let mut s = c.prepare_cached(
        "SELECT room_id FROM account_rooms WHERE account_id = ?1 ORDER BY position",
    )?;
    let rows = s
        .query_map([account], |r| crate::store::fixed::<32>(r.get(0)?))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// What a human device of the room sees of its account. The e-mail is the person's own; no hash leaves the hub.
pub fn account_view(c: &Connection, account: i64) -> Res<Value> {
    let (email, created, updated, revision, has_password, kdf, password_copy, kit_copy, handle): (String, i64, i64, i64, bool, Option<String>, Option<Vec<u8>>, Vec<u8>, Vec<u8>) = c
        .prepare_cached(
            "SELECT email, created_at, updated_at, revision, auth_hash IS NOT NULL, kdf, password_copy, kit_copy, user_handle FROM accounts WHERE account_id = ?1",
        )?
        .query_row([account], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?)))?;
    let mut s = c.prepare_cached("SELECT credential_id, algorithm, transports, sign_count, created_at, last_used_at, sealed_copy FROM passkeys WHERE account_id = ?1 ORDER BY created_at")?;
    let passkeys = s
        .query_map([account], |r| {
            Ok(json!({
                "credential_id": b64(&r.get::<_, Vec<u8>>(0)?),
                "algorithm": r.get::<_, i64>(1)?,
                "transports": serde_json::from_str::<Value>(&r.get::<_, String>(2)?).unwrap_or(Value::Null),
                "sign_count": r.get::<_, i64>(3)?,
                "created_at": r.get::<_, i64>(4)?,
                "last_used_at": r.get::<_, Option<i64>>(5)?,
                "sealed_copy": b64(&r.get::<_, Vec<u8>>(6)?),
            }))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(json!({
        "email": email, "created_at": created, "updated_at": updated, "revision": revision, "has_password": has_password,
        "kdf": kdf.and_then(|k| serde_json::from_str::<Value>(&k).ok()), "password_copy": password_copy.map(|c| b64(&c)),
        "kit_copy": b64(&kit_copy), "user_handle": b64(&handle), "passkeys": passkeys,
        "rooms": rooms_of(c, account)?.iter().map(|r| b64(r)).collect::<Vec<_>>(),
    }))
}

fn check_revision(c: &Connection, account: i64, v: &Value) -> Res<()> {
    let revision: i64 = c
        .prepare_cached("SELECT revision FROM accounts WHERE account_id = ?1")?
        .query_row([account], |r| r.get(0))?;
    if v["revision"].as_i64() != Some(revision) {
        return Err(refuse(
            "account-changed",
            "the account changed meanwhile: read it again",
        ));
    }
    Ok(())
}

/// Changing the password re-wraps the code and replaces the login key; nothing else is re-encrypted.
pub fn put_password(c: &Connection, room: &Room, v: &Value, now: u64) -> Res<Value> {
    let account = account_of(c, room)?;
    check_revision(c, account, v)?;
    let (auth, copy, kdf) = (
        bytes(v, "auth_key", 32)?,
        sealed_copy(v, "sealed_copy")?,
        kdf_record(v)?,
    );
    let salt = random::<16>();
    c.prepare_cached("UPDATE accounts SET auth_salt = ?1, auth_hash = ?2, kdf = ?3, password_copy = ?4 WHERE account_id = ?5")?
        .execute(params![&salt[..], &slow_hash(&auth, &salt)[..], kdf, copy, account])?;
    bump(c, account, now)?;
    Ok(json!({ "revision": v["revision"].as_i64().unwrap_or(0) + 1 }))
}

/// A new kit replaces the one before.
pub fn put_kit(c: &Connection, room: &Room, v: &Value, now: u64) -> Res<Value> {
    let account = account_of(c, room)?;
    check_revision(c, account, v)?;
    set_kit(c, account, v)?;
    bump(c, account, now)?;
    Ok(json!({ "revision": v["revision"].as_i64().unwrap_or(0) + 1 }))
}

fn set_kit(c: &Connection, account: i64, v: &Value) -> Res<()> {
    let (auth, copy) = (bytes(v, "auth_key", 32)?, sealed_copy(v, "sealed_copy")?);
    let salt = random::<16>();
    c.prepare_cached(
        "UPDATE accounts SET kit_salt = ?1, kit_hash = ?2, kit_copy = ?3 WHERE account_id = ?4",
    )?
    .execute(params![
        &salt[..],
        &slow_hash(&auth, &salt)[..],
        copy,
        account
    ])?;
    Ok(())
}

/// v1 §16.9: the hub refuses to remove the last way in. The kit is the way back, not a way in.
pub fn delete_passkey(c: &Connection, room: &Room, credential_id: &[u8], now: u64) -> Res<Value> {
    let account = account_of(c, room)?;
    let (has_password, passkeys): (bool, i64) = c
        .prepare_cached("SELECT auth_hash IS NOT NULL, (SELECT count(*) FROM passkeys WHERE account_id = ?1) FROM accounts WHERE account_id = ?1")?
        .query_row([account], |r| Ok((r.get(0)?, r.get(1)?)))?;
    if !c
        .prepare_cached("SELECT 1 FROM passkeys WHERE credential_id = ?1 AND account_id = ?2")?
        .exists(params![credential_id, account])?
    {
        return Err(refuse("not-found", "no such passkey"));
    }
    if !has_password && passkeys <= 1 {
        return Err(refuse(
            "last-way-in",
            "this is the last way into the account",
        ));
    }
    c.prepare_cached("DELETE FROM passkeys WHERE credential_id = ?1 AND account_id = ?2")?
        .execute(params![credential_id, account])?;
    bump(c, account, now)?;
    Ok(json!({ "deleted": true }))
}

/// 8.6: with new recovery keys come the account's new sealed copies: one under the way in used just now
/// (password or passkey) and one under a new Emergency Kit; every other way in is removed and set up again by
/// the person. A room without an account brings none.
pub fn replace_copies(c: &Connection, room: &Room, v: &Value, now: u64) -> Res<()> {
    let account: Option<i64> = c
        .prepare_cached("SELECT account_id FROM account_rooms WHERE room_id = ?1")?
        .query_row([&room[..]], |r| r.get(0))
        .optional()?;
    let Some(account) = account else {
        return if v.is_null() {
            Ok(())
        } else {
            Err(refuse("not-found", "this room has no account"))
        };
    };
    if v.is_null() {
        return Err(refuse(
            "incomplete",
            "new recovery keys come with the account's new sealed copies",
        ));
    }
    set_kit(c, account, &v["kit"])
        .map_err(|_| refuse("incomplete", "the account's new Emergency Kit copy"))?;
    match (&v["password"], &v["passkey"]) {
        (p, Value::Null) if !p.is_null() => {
            let copy = sealed_copy(p, "sealed_copy")?;
            let n = c
                .prepare_cached("UPDATE accounts SET password_copy = ?1 WHERE account_id = ?2 AND auth_hash IS NOT NULL")?
                .execute(params![copy, account])?;
            if n == 0 {
                return Err(refuse("incomplete", "the account has no password"));
            }
            c.prepare_cached("DELETE FROM passkeys WHERE account_id = ?1")?
                .execute([account])?;
        }
        (Value::Null, p) if !p.is_null() => {
            let (id, copy) = (
                var_bytes(p, "credential_id", 1023)?,
                sealed_copy(p, "sealed_copy")?,
            );
            let n = c
                .prepare_cached("UPDATE passkeys SET sealed_copy = ?1 WHERE credential_id = ?2 AND account_id = ?3")?
                .execute(params![copy, id, account])?;
            if n == 0 {
                return Err(refuse("incomplete", "the account has no such passkey"));
            }
            c.prepare_cached("DELETE FROM passkeys WHERE account_id = ?1 AND credential_id != ?2")?
                .execute(params![account, id])?;
            c.prepare_cached("UPDATE accounts SET auth_salt = NULL, auth_hash = NULL, kdf = NULL, password_copy = NULL WHERE account_id = ?1")?.execute([account])?;
        }
        _ => {
            return Err(refuse(
                "incomplete",
                "one sealed copy under the way in used just now: password or passkey",
            ))
        }
    }
    bump(c, account, now)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn e_mail_addresses_are_normalised_or_refused_never_mapped() {
        assert_eq!(
            normalise_email("  Ada@Example.ORG\t").unwrap(),
            "ada@example.org"
        );
        for bad in [
            "",
            "a@b",
            "a@@b.co",
            "a b@c.de",
            "ädä@example.org",
            "a@b.c",
            "@example.org",
            &format!("{}@example.org", "x".repeat(65)),
            "a@.org",
        ] {
            assert_eq!(normalise_email(bad).unwrap_err().code, "bad-email", "{bad}");
        }
    }

    #[test]
    fn the_slow_hash_depends_on_key_and_salt() {
        let a = slow_hash(&[1; 32], &[2; 16]);
        assert_eq!(a, slow_hash(&[1; 32], &[2; 16]));
        assert_ne!(a, slow_hash(&[1; 32], &[3; 16]));
        assert_ne!(a, slow_hash(&[9; 32], &[2; 16]));
    }

    #[test]
    fn a_sealed_copy_of_another_length_or_version_is_refused() {
        let mut copy = vec![2u8; 61];
        assert!(sealed_copy(&json!({ "c": b64(&copy) }), "c").is_ok());
        copy[0] = 1;
        assert!(sealed_copy(&json!({ "c": b64(&copy) }), "c").is_err());
        assert!(sealed_copy(&json!({ "c": b64(&[2u8; 60]) }), "c").is_err());
        assert!(kdf_record(
            &json!({ "kdf": { "alg": "argon2id", "v": 1, "m": 65536, "t": 3, "p": 1, "x": 1 } })
        )
        .is_ok());
        assert!(kdf_record(
            &json!({ "kdf": { "alg": "argon2id", "v": 1, "m": 1024, "t": 3, "p": 1 } })
        )
        .is_err());
    }
}
