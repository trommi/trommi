//! Accounts (spec/v1.md 8.8, spec/v1.md §16): an e-mail with a password, passkeys or both, and an Emergency Kit.
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

/// The slow hashes of the login keys a request brings, made before its transaction (the hash is slow on
/// purpose; the database's write lock is not held meanwhile).
#[derive(Default)]
pub struct Prehashed(Vec<(Vec<u8>, [u8; 16], [u8; 32])>);

impl Prehashed {
    /// Hashes the `auth_key` of each given object that has a well-formed one.
    pub fn of(objects: &[&Value]) -> Prehashed {
        let mut out = Vec::new();
        for v in objects {
            if let Ok(key) = bytes(v, "auth_key", 32) {
                let salt = random::<16>();
                let hash = slow_hash(&key, &salt);
                out.push((key, salt, hash));
            }
        }
        Prehashed(out)
    }

    fn take(&self, key: &[u8]) -> Res<([u8; 16], [u8; 32])> {
        self.0
            .iter()
            .find(|(k, _, _)| same(k, key))
            .map(|(_, salt, hash)| (*salt, *hash))
            .ok_or_else(|| refuse("overloaded", "try again").retry(1))
    }
}

/// v1 §16.3: a sealed copy is 61 bytes and begins with 0x02; anything else is refused, not converted.
pub fn sealed_copy(v: &Value, key: &str) -> Res<Vec<u8>> {
    let copy = bytes(v, key, SEALED_COPY_LEN)?;
    if copy[0] != 0x02 {
        return Err(refuse("bad-format", "a sealed copy of another format"));
    }
    Ok(copy)
}

/// v1 §16.6: the key derivation record is pinned; the hub stores and returns exactly it.
pub fn kdf_record(v: &Value) -> Res<String> {
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

pub struct LoginRow {
    auth: Vec<u8>,
    held: Option<(i64, Vec<u8>, Vec<u8>, Vec<u8>)>,
    revision: i64,
}

impl LoginRow {
    pub fn account(&self) -> Option<i64> {
        self.held.as_ref().map(|h| h.0)
    }
    /// The account's revision when its row was read: the answer is given only if it still is that.
    pub fn revision(&self) -> i64 {
        self.revision
    }
}

/// Whether an account was signed in to from this source before.
pub fn knows_source(c: &Connection, account: Option<i64>, source: &[u8]) -> Res<bool> {
    // the same query for an e-mail without an account: -1 is no account's id
    Ok(
        c.prepare_cached("SELECT 1 FROM account_sources WHERE account_id = ?1 AND source = ?2")?
            .exists(params![account.unwrap_or(-1), source])?,
    )
}

/// After a successful sign-in: the account knows this source; the 16 newest are kept.
pub fn remember_source(c: &Connection, account: i64, source: &[u8], now: u64) -> Res<()> {
    c.prepare_cached(
        "INSERT INTO account_sources (account_id, source, last_at) VALUES (?1, ?2, ?3)
         ON CONFLICT (account_id, source) DO UPDATE SET last_at = excluded.last_at",
    )?
    .execute(params![account, source, now as i64])?;
    c.prepare_cached(
        "DELETE FROM account_sources WHERE account_id = ?1 AND source NOT IN
         (SELECT source FROM account_sources WHERE account_id = ?1 ORDER BY last_at DESC LIMIT 16)",
    )?
    .execute([account])?;
    Ok(())
}

/// In-memory state of the account routes: passkey challenges, the dummies that make an unknown e-mail cost and
/// answer like a known one.
pub struct Accounts {
    challenges: Mutex<(
        HashMap<[u8; 32], (u64, Option<(i64, i64)>)>,
        VecDeque<[u8; 32]>,
    )>,
    dummy_salt: [u8; 16],
    dummy_key: Vec<u8>,
    pub origins: Vec<String>,
    pub max_passkeys: i64,
}

impl Accounts {
    pub fn new(origins: Vec<String>, max_passkeys: i64) -> Self {
        Accounts {
            challenges: Mutex::new((HashMap::new(), VecDeque::new())),
            dummy_salt: random(),
            dummy_key: webauthn::dummy_key(),
            origins,
            max_passkeys,
        }
    }

    /// A passkey challenge: 32 random bytes, two minutes, one use. `account`: the account a new passkey is for
    /// and its revision (a passkey prepared before the account changed, e.g. before the code was replaced, is
    /// not registered after); `None` for a sign-in or the passkey of a new account.
    pub fn challenge(&self, account: Option<(i64, i64)>, now: u64) -> [u8; 32] {
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
    fn take_challenge(&self, challenge: &[u8], account: Option<(i64, i64)>, now: u64) -> bool {
        self.take_challenge_of(challenge, &[account], now)
    }

    /// As `take_challenge`, for a challenge that may have been asked for in more than one way.
    fn take_challenge_of(&self, challenge: &[u8], scopes: &[Option<(i64, i64)>], now: u64) -> bool {
        let Ok(c) = <[u8; 32]>::try_from(challenge) else {
            return false;
        };
        let held = self
            .challenges
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .0
            .remove(&c);
        matches!(held, Some((expires, scope)) if expires > now && scopes.contains(&scope))
    }

    fn register_passkey(
        &self,
        v: &Value,
        account: Option<(i64, i64)>,
        now: u64,
    ) -> Res<(webauthn::Registered, Vec<u8>, String)> {
        self.register_passkey_of(v, &[account], now)
    }

    fn register_passkey_of(
        &self,
        v: &Value,
        scopes: &[Option<(i64, i64)>],
        now: u64,
    ) -> Res<(webauthn::Registered, Vec<u8>, String)> {
        let bad = |w: webauthn::Bad| refuse("bad-passkey", w.0);
        let attestation = var_bytes(v, "attestation_object", 8192)?;
        let client_data = var_bytes(v, "client_data_json", 4096)?;
        let copy = sealed_copy(v, "sealed_copy")?;
        let (challenge, origin) =
            webauthn::client_challenge(&client_data, "webauthn.create").map_err(bad)?;
        if !self.take_challenge_of(&challenge, scopes, now) {
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
    pub fn create(
        &self,
        c: &Connection,
        room: &Room,
        v: &Value,
        now: u64,
        pre: &Prehashed,
    ) -> Res<Value> {
        // an e-mail is what a password signs in under; an account whose way in is a passkey may have none
        let email = match &v["email"] {
            Value::Null => None,
            given => Some(normalise_email(given.as_str().unwrap_or(""))?),
        };
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
        // The account's id: a UUID the hub mints. With a passkey it is the one the hub named with the
        // registration's challenge (the device needed it before: it is the passkey's user handle, and for an
        // account without e-mail the salt of its kit).
        let user_handle = match &v["passkey"] {
            Value::Null => new_id(),
            p => {
                let client_data = var_bytes(p, "client_data_json", 4096)?;
                let (challenge, _) = webauthn::client_challenge(&client_data, "webauthn.create")
                    .map_err(|w| refuse("bad-passkey", w.0))?;
                id_of_challenge(&challenge)
            }
        };
        let kit_form = kit_form(kit, email.is_some())?;
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
        if password.is_some() && email.is_none() {
            return Err(refuse("bad-email", "a password signs in under an e-mail"));
        }
        // one answer for an e-mail and for an account id that is taken
        let taken = match &email {
            Some(email) => c
                .prepare_cached("SELECT 1 FROM accounts WHERE email = ?1")?
                .exists([email])?,
            None => false,
        } || c
            .prepare_cached("SELECT 1 FROM accounts WHERE user_handle = ?1")?
            .exists([&user_handle[..]])?;
        if taken {
            return Err(refuse(
                "account-exists",
                "an account with this e-mail or id exists",
            ));
        }
        let (kit_salt, kit_hash) = pre.take(&kit_auth)?;
        let (auth_salt, auth_hash, kdf, password_copy) = match &password {
            Some((auth, copy, kdf)) => {
                let (salt, hash) = pre.take(auth)?;
                (
                    Some(salt.to_vec()),
                    Some(hash.to_vec()),
                    Some(kdf.clone()),
                    Some(copy.clone()),
                )
            }
            None => (None, None, None, None),
        };
        c.prepare_cached(
            "INSERT INTO accounts (email, created_at, updated_at, auth_salt, auth_hash, kdf, password_copy, kit_salt, kit_hash, kit_copy, user_handle, kit_form)
             VALUES (?1, ?2, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        )?
        .execute(params![email, now as i64, auth_salt, auth_hash, kdf, password_copy, &kit_salt[..], &kit_hash[..], kit_copy, &user_handle[..], kit_form])?;
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
        if count >= self.max_passkeys {
            return Err(refuse("too-many", "an account has at most 20 passkeys"));
        }
        let (registered, copy, transports) =
            self.register_passkey(v, Some((account, revision_of(c, account)?)), now)?;
        insert_passkey(c, account, &registered, &copy, &transports, now)?;
        bump(c, account, now)?;
        Ok(json!({ "credential_id": b64(&registered.credential_id), "created_at": now }))
    }

    /// Sign-in with e-mail and the login key, first half: what the hub holds for that e-mail. The slow hash is
    /// made by the caller outside any database connection (`check_login`).
    pub fn login_row(&self, c: &Connection, v: &Value, kit: bool) -> Res<LoginRow> {
        let auth = bytes(v, "auth_key", 32)?;
        let (salt_col, hash_col, copy_col) = if kit {
            ("kit_salt", "kit_hash", "kit_copy")
        } else {
            ("auth_salt", "auth_hash", "password_copy")
        };
        // the account is named by its e-mail or by its id: the same query shape, the same answer either way
        let (column, name): (&str, Option<Vec<u8>>) = match name_of(v) {
            Name::Email(e) => ("email", Some(e.into_bytes())),
            Name::Id(id) => ("user_handle", Some(id.to_vec())),
            Name::None => ("email", None),
        };
        let row: Option<(i64, Option<Vec<u8>>, Option<Vec<u8>>, Option<Vec<u8>>, i64)> = match name
        {
            Some(name) => {
                let sql = format!("SELECT account_id, {salt_col}, {hash_col}, {copy_col}, revision FROM accounts WHERE {column} = ?1");
                let mut q = c.prepare_cached(&sql)?;
                let get =
                    |r: &rusqlite::Row| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?));
                if column == "email" {
                    q.query_row([String::from_utf8_lossy(&name).as_ref()], get)
                        .optional()?
                } else {
                    q.query_row([&name], get).optional()?
                }
            }
            None => None,
        };
        let revision = row.as_ref().map_or(0, |r| r.4);
        let row = row.map(|r| (r.0, r.1, r.2, r.3));
        Ok(LoginRow {
            revision,
            auth,
            held: match row {
                Some((account, Some(salt), Some(hash), Some(copy))) => {
                    Some((account, salt, hash, copy))
                }
                _ => None,
            },
        })
    }

    /// Second half: one answer for an unknown e-mail and a wrong password (v1 §16.9), at one cost: a hash is
    /// always computed.
    pub fn check_login(&self, row: LoginRow) -> Option<(i64, Vec<u8>)> {
        match row.held {
            Some((account, salt, hash, copy)) => {
                same(&slow_hash(&row.auth, &salt), &hash).then_some((account, copy))
            }
            None => {
                let _ = slow_hash(&row.auth, &self.dummy_salt);
                None
            }
        }
    }

    /// The work of a check, for an attempt that is told to wait: its answer costs what any answer costs.
    pub fn spend(&self, row: &LoginRow) {
        let _ = slow_hash(&row.auth, &self.dummy_salt);
    }

    /// Sign-in with a passkey. An unknown credential is checked against a key nobody holds.
    /// The check reads only; the caller records the use (`passkey_used`) in a short write of its own.
    pub fn passkey_login(
        &self,
        c: &Connection,
        v: &Value,
        now: u64,
    ) -> Res<Option<(i64, Vec<u8>, Vec<u8>, u32, i64)>> {
        let credential_id = var_bytes(v, "credential_id", 1023)?;
        let authenticator_data = var_bytes(v, "authenticator_data", 1024)?;
        let client_data = var_bytes(v, "client_data_json", 4096)?;
        let signature = var_bytes(v, "signature", 512)?;
        let row: Option<(i64, Vec<u8>, Vec<u8>, Vec<u8>, i64)> = c
            .prepare_cached("SELECT p.account_id, p.public_key, p.sealed_copy, a.user_handle, a.revision FROM passkeys p JOIN accounts a ON a.account_id = p.account_id WHERE p.credential_id = ?1")?
            .query_row([&credential_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))
            .optional()?;
        let revision = row.as_ref().map_or(0, |r| r.4);
        let row = row.map(|r| (r.0, r.1, r.2, r.3));
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
        // the handle an authenticator returns for a passkey it found by itself must be the account's
        let handle_fits = match (&row, &v["user_handle"]) {
            (_, Value::Null) => true,
            (Some((_, _, _, handle)), given) => given
                .as_str()
                .and_then(unb64)
                .is_some_and(|g| same(handle, &g)),
            (None, _) => true,
        };
        match (row, verified, fresh && handle_fits) {
            (Some((account, _, copy, _)), Ok(sign_count), true) => {
                Ok(Some((account, copy, credential_id, sign_count, revision)))
            }
            _ => Ok(None),
        }
    }
}

/// The counter never goes back; a passkey that is synced between devices reports none.
pub fn passkey_used(
    c: &Connection,
    account: i64,
    credential_id: &[u8],
    sign_count: u32,
    now: u64,
) -> Res<bool> {
    // false: the passkey is no longer that account's
    Ok(c.prepare_cached("UPDATE passkeys SET sign_count = max(sign_count, ?1), last_used_at = ?2 WHERE credential_id = ?3 AND account_id = ?4")?
        .execute(params![sign_count, now as i64, credential_id, account])? == 1)
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

pub fn revision_of(c: &Connection, account: i64) -> Res<i64> {
    Ok(
        c.prepare_cached("SELECT revision FROM accounts WHERE account_id = ?1")?
            .query_row([account], |r| r.get(0))?,
    )
}

pub fn account_of(c: &Connection, room: &Room) -> Res<i64> {
    c.prepare_cached("SELECT account_id FROM account_rooms WHERE room_id = ?1")?
        .query_row([&room[..]], |r| r.get(0))
        .optional()?
        .ok_or_else(|| refuse("not-found", "this room has no account"))
}

pub fn handle_of(c: &Connection, account: i64) -> Res<Vec<u8>> {
    Ok(
        c.prepare_cached("SELECT user_handle FROM accounts WHERE account_id = ?1")?
            .query_row([account], |r| r.get(0))?,
    )
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
    let (email, created, updated, revision, has_password, kdf, password_copy, kit_copy, handle, kit_form): (Option<String>, i64, i64, i64, bool, Option<String>, Option<Vec<u8>>, Vec<u8>, Vec<u8>, String) = c
        .prepare_cached(
            "SELECT email, created_at, updated_at, revision, auth_hash IS NOT NULL, kdf, password_copy, kit_copy, user_handle, kit_form FROM accounts WHERE account_id = ?1",
        )?
        .query_row([account], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?)))?;
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
        "kit_copy": b64(&kit_copy), "user_handle": b64(&handle), "account": id_text(&handle), "kit_form": kit_form, "passkeys": passkeys,
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
pub fn put_password(
    c: &Connection,
    room: &Room,
    v: &Value,
    now: u64,
    pre: &Prehashed,
) -> Res<Value> {
    let account = account_of(c, room)?;
    check_revision(c, account, v)?;
    needs_email(c, account)?;
    let (auth, copy, kdf) = (
        bytes(v, "auth_key", 32)?,
        sealed_copy(v, "sealed_copy")?,
        kdf_record(v)?,
    );
    let (salt, hash) = pre.take(&auth)?;
    c.prepare_cached("UPDATE accounts SET auth_salt = ?1, auth_hash = ?2, kdf = ?3, password_copy = ?4 WHERE account_id = ?5")?
        .execute(params![&salt[..], &hash[..], kdf, copy, account])?;
    bump(c, account, now)?;
    Ok(json!({ "revision": v["revision"].as_i64().unwrap_or(0) + 1 }))
}

/// Which salt a kit's keys are derived with follows from the account alone (v1.md 8.8.2): the e-mail's where it
/// has one, else the account id's. The hub cannot check a kit; it says which form the account's kit has.
fn kit_form(_kit: &Value, has_email: bool) -> Res<&'static str> {
    Ok(if has_email { "email" } else { "id" })
}

/// How a request names an account: by e-mail or by the account's id.
pub enum Name {
    Email(String),
    Id([u8; 16]),
    None,
}

impl Name {
    /// What the login throttle counts under: each name has its own bounds.
    pub fn key(&self) -> String {
        match self {
            Name::Email(e) => e.clone(),
            Name::Id(id) => format!("id:{}", crate::util::hex(id)),
            Name::None => String::new(),
        }
    }
}

/// The one field `account` (read as `email` too): an e-mail address, or the account's id as a UUID.
pub fn name_of(v: &Value) -> Name {
    let text = v["account"].as_str().or(v["email"].as_str()).unwrap_or("");
    if text.contains('@') {
        normalise_email(text).map_or(Name::None, Name::Email)
    } else {
        parse_id(text).map_or(Name::None, Name::Id)
    }
}

/// A new account id: a random UUID (version 4).
pub fn new_id() -> [u8; 16] {
    as_uuid(random::<16>())
}

fn as_uuid(mut id: [u8; 16]) -> [u8; 16] {
    id[6] = (id[6] & 0x0f) | 0x40;
    id[8] = (id[8] & 0x3f) | 0x80;
    id
}

/// The account id that goes with a passkey challenge: the hub names it when it hands the challenge out, and an
/// account made with a passkey registered on that challenge gets it.
pub fn id_of_challenge(challenge: &[u8]) -> [u8; 16] {
    let hash = crate::util::sha256(&[&b"trommi account id\0"[..], challenge].concat());
    as_uuid(hash[..16].try_into().expect("sixteen bytes"))
}

/// An account id as it is printed: the canonical UUID, lower case, with dashes.
pub fn id_text(id: &[u8]) -> String {
    let h = crate::util::hex(id);
    if h.len() != 32 {
        return h;
    }
    format!(
        "{}-{}-{}-{}-{}",
        &h[..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..]
    )
}

/// An account id as typed: case, spaces and dashes are ignored; what is left is 32 hex digits.
pub fn parse_id(text: &str) -> Option<[u8; 16]> {
    let digits: String = text
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .collect();
    if digits.len() != 32 || !digits.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let mut out = [0u8; 16];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&digits[2 * i..2 * i + 2], 16).ok()?;
    }
    Some(out)
}

/// A password signs in under an e-mail: an account without one sets it first (`PUT /v1/account/email`).
fn needs_email(c: &Connection, account: i64) -> Res<()> {
    let has: bool = c
        .prepare_cached("SELECT email IS NOT NULL FROM accounts WHERE account_id = ?1")?
        .query_row([account], |r| r.get(0))?;
    if has {
        Ok(())
    } else {
        Err(refuse(
            "bad-email",
            "a password signs in under an e-mail: this account has none",
        ))
    }
}

/// `PUT /v1/account/email`: an account that has no e-mail is given one. It is set once: the keys of a password,
/// and of the kit of an account that has one, are derived from it; the kit is made anew in the same request.
pub fn put_email(c: &Connection, room: &Room, v: &Value, now: u64, pre: &Prehashed) -> Res<Value> {
    let account = account_of(c, room)?;
    check_revision(c, account, v)?;
    let email = normalise_email(v["email"].as_str().unwrap_or(""))?;
    let held: Option<String> = c
        .prepare_cached("SELECT email FROM accounts WHERE account_id = ?1")?
        .query_row([account], |r| r.get(0))?;
    if held.is_some() {
        return Err(refuse("forbidden", "the e-mail of an account is set once"));
    }
    // (the answer signing up with that address gets)
    if c.prepare_cached("SELECT 1 FROM accounts WHERE email = ?1")?
        .exists([&email])?
    {
        return Err(refuse(
            "account-exists",
            "an account with this e-mail exists",
        ));
    }
    c.prepare_cached("UPDATE accounts SET email = ?1 WHERE account_id = ?2")?
        .execute(params![email, account])?;
    // 8.8.2: with an e-mail the kit's keys are under the e-mail's salt, so the kit comes anew in this request
    // (the same words may stay; the keys do not)
    set_kit(c, account, &v["kit"], pre).map_err(|_| {
        refuse(
            "incomplete",
            "an e-mail comes with the kit made anew under it",
        )
    })?;
    bump(c, account, now)?;
    Ok(json!({ "revision": v["revision"].as_i64().unwrap_or(0) + 1 }))
}

/// A new kit replaces the one before.
pub fn put_kit(c: &Connection, room: &Room, v: &Value, now: u64, pre: &Prehashed) -> Res<Value> {
    let account = account_of(c, room)?;
    check_revision(c, account, v)?;
    set_kit(c, account, v, pre)?;
    bump(c, account, now)?;
    Ok(json!({ "revision": v["revision"].as_i64().unwrap_or(0) + 1 }))
}

fn set_kit(c: &Connection, account: i64, v: &Value, pre: &Prehashed) -> Res<()> {
    let (auth, copy) = (bytes(v, "auth_key", 32)?, sealed_copy(v, "sealed_copy")?);
    let has_email: bool = c
        .prepare_cached("SELECT email IS NOT NULL FROM accounts WHERE account_id = ?1")?
        .query_row([account], |r| r.get(0))?;
    let form = kit_form(v, has_email)?;
    let (salt, hash) = pre.take(&auth)?;
    c.prepare_cached(
        "UPDATE accounts SET kit_salt = ?1, kit_hash = ?2, kit_copy = ?3, kit_form = ?4 WHERE account_id = ?5",
    )?
    .execute(params![&salt[..], &hash[..], copy, form, account])?;
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

impl Accounts {
    /// 8.6: with new recovery keys come the account's new sealed copies: one under the way in used just now
    /// (password or passkey) and one under a new Emergency Kit; every other way in is removed and set up again
    /// by the person. After a recovery with the Emergency Kit words or the bare code there was no way in used
    /// just now: then the password or passkey is set anew in the same request (`auth_key` and `kdf`, or a
    /// passkey's registration). A room without an account brings none.
    pub fn replace_copies(
        &self,
        c: &Connection,
        room: &Room,
        v: &Value,
        now: u64,
        pre: &Prehashed,
    ) -> Res<()> {
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
        set_kit(c, account, &v["kit"], pre)
            .map_err(|_| refuse("incomplete", "the account's new Emergency Kit copy"))?;
        let no_password = "UPDATE accounts SET auth_salt = NULL, auth_hash = NULL, kdf = NULL, password_copy = NULL WHERE account_id = ?1";
        match (&v["password"], &v["passkey"]) {
            // a password set anew: its key, its copy and its derivation record
            (p, Value::Null) if !p["auth_key"].is_null() => {
                needs_email(c, account)?;
                let (auth, copy, kdf) = (bytes(p, "auth_key", 32)?, sealed_copy(p, "sealed_copy")?, kdf_record(p)?);
                let (salt, hash) = pre.take(&auth)?;
                c.prepare_cached("UPDATE accounts SET auth_salt = ?1, auth_hash = ?2, kdf = ?3, password_copy = ?4 WHERE account_id = ?5")?
                    .execute(params![&salt[..], &hash[..], kdf, copy, account])?;
                c.prepare_cached("DELETE FROM passkeys WHERE account_id = ?1")?.execute([account])?;
            }
            // the password used just now: a new copy under it
            (p, Value::Null) if !p.is_null() => {
                let copy = sealed_copy(p, "sealed_copy")?;
                let n = c
                    .prepare_cached("UPDATE accounts SET password_copy = ?1 WHERE account_id = ?2 AND auth_hash IS NOT NULL")?
                    .execute(params![copy, account])?;
                if n == 0 {
                    return Err(refuse("incomplete", "the account has no password"));
                }
                c.prepare_cached("DELETE FROM passkeys WHERE account_id = ?1")?.execute([account])?;
            }
            // a passkey made anew: registered as any passkey of this account, on the account's challenge
            // (`POST /v1/account/passkeys/challenge`, which names the id the passkey carries)
            (Value::Null, p) if !p["attestation_object"].is_null() => {
                let scopes = [Some((account, revision_of(c, account)?))];
                let (registered, copy, transports) = self.register_passkey_of(p, &scopes, now)?;
                c.prepare_cached("DELETE FROM passkeys WHERE account_id = ?1")?.execute([account])?;
                insert_passkey(c, account, &registered, &copy, &transports, now)?;
                c.prepare_cached(no_password)?.execute([account])?;
            }
            // the passkey used just now: a new copy under it
            (Value::Null, p) if !p.is_null() => {
                let (id, copy) = (var_bytes(p, "credential_id", 1023)?, sealed_copy(p, "sealed_copy")?);
                let n = c
                    .prepare_cached("UPDATE passkeys SET sealed_copy = ?1 WHERE credential_id = ?2 AND account_id = ?3")?
                    .execute(params![copy, id, account])?;
                if n == 0 {
                    return Err(refuse("incomplete", "the account has no such passkey"));
                }
                c.prepare_cached("DELETE FROM passkeys WHERE account_id = ?1 AND credential_id != ?2")?
                    .execute(params![account, id])?;
                c.prepare_cached(no_password)?.execute([account])?;
            }
            _ => {
                return Err(refuse(
                    "incomplete",
                    "one sealed copy under one way in: the password or passkey used just now, or one set anew",
                ))
            }
        }
        bump(c, account, now)
    }
}

/// What deleting an account (`DELETE /v1/account`) is proved with, read in a reading transaction. A login key is
/// checked by `proven` on the pool, with no database connection held; a passkey's assertion is checked here.
pub enum Proof {
    Key {
        auth: Vec<u8>,
        held: Option<(Vec<u8>, Vec<u8>)>,
    },
    Passkey(bool),
}

impl Accounts {
    /// The way in once more, fresh: `password: { auth_key }`, `kit: { auth_key }` (the login key the device
    /// derives, as for a login) or `passkey: { credential_id, authenticator_data, client_data_json, signature }`,
    /// an assertion of a passkey of this account on a challenge of `POST /v1/account/passkeys/challenge` (two
    /// minutes, one use, for this account at its revision).
    pub fn proof(&self, c: &Connection, account: i64, v: &Value, now: u64) -> Res<Proof> {
        let key = |p: &Value, salt: &str, hash: &str| -> Res<Proof> {
            let auth = bytes(p, "auth_key", 32)?;
            let held: (Option<Vec<u8>>, Option<Vec<u8>>) = c
                .prepare_cached(&format!(
                    "SELECT {salt}, {hash} FROM accounts WHERE account_id = ?1"
                ))?
                .query_row([account], |r| Ok((r.get(0)?, r.get(1)?)))?;
            Ok(Proof::Key {
                auth,
                held: held.0.zip(held.1),
            })
        };
        match (&v["password"], &v["kit"], &v["passkey"]) {
            (p, Value::Null, Value::Null) if !p.is_null() => key(p, "auth_salt", "auth_hash"),
            (Value::Null, k, Value::Null) if !k.is_null() => key(k, "kit_salt", "kit_hash"),
            (Value::Null, Value::Null, p) if !p.is_null() => {
                let credential_id = var_bytes(p, "credential_id", 1023)?;
                let authenticator_data = var_bytes(p, "authenticator_data", 1024)?;
                let client_data = var_bytes(p, "client_data_json", 4096)?;
                let signature = var_bytes(p, "signature", 512)?;
                let Ok((challenge, origin)) =
                    webauthn::client_challenge(&client_data, "webauthn.get")
                else {
                    return Ok(Proof::Passkey(false));
                };
                let fresh =
                    self.take_challenge(&challenge, Some((account, revision_of(c, account)?)), now);
                let public_key: Option<Vec<u8>> = c
                    .prepare_cached("SELECT public_key FROM passkeys WHERE credential_id = ?1 AND account_id = ?2")?
                    .query_row(params![credential_id, account], |r| r.get(0))
                    .optional()?;
                let verified = public_key.is_some_and(|key| {
                    webauthn::assert(
                        &key,
                        &authenticator_data,
                        &client_data,
                        &signature,
                        &origin,
                        &self.origins,
                    )
                    .is_ok()
                });
                Ok(Proof::Passkey(fresh && verified))
            }
            _ => Err(refuse("bad-format", "one of password, kit or passkey")),
        }
    }

    /// Whether the proof holds. A login key costs one slow hash, also against an account without that way in.
    pub fn proven(&self, proof: Proof) -> bool {
        match proof {
            Proof::Key {
                auth,
                held: Some((salt, hash)),
            } => same(&slow_hash(&auth, &salt), &hash),
            Proof::Key { auth, held: None } => {
                let _ = slow_hash(&auth, &self.dummy_salt);
                false
            }
            Proof::Passkey(ok) => ok,
        }
    }
}

/// Deletes an account and its rooms with everything stored for them, in the caller's transaction: every row of
/// every table that names the account, a room of it, a group of such a room, a recovery or an invite of it.
/// Returns the rooms, whose files the caller removes from disk once the transaction is committed.
///
/// Kept, since they name no account, room or device: `spent_key_packages` (32-byte references of KeyPackages
/// handed out, kept for ever so that none is handed out twice), the login throttle's tables (keyed by hashes of
/// what was typed at a login, which exist alike for e-mails that never had an account, and swept within a day)
/// and the counters `welcome_ids` and `login_counts`.
pub fn delete_account(c: &Connection, account: i64) -> Res<Vec<Room>> {
    let rooms = rooms_of(c, account)?;
    for room in &rooms {
        delete_room(c, room)?;
    }
    for table in ["passkeys", "account_sources", "account_rooms", "accounts"] {
        c.execute(
            &format!("DELETE FROM {table} WHERE account_id = ?1"),
            [account],
        )?;
    }
    Ok(rooms)
}

/// Every row of one room, children before the rows they refer to.
fn delete_room(c: &Connection, room: &Room) -> Res<()> {
    const GROUPS: &str = "(SELECT group_id FROM groups WHERE room_id = ?1)";
    let by_group = [
        "group_members",
        "group_log",
        "group_infos",
        "welcome_bytes",
        "epoch_counts",
    ];
    for table in by_group {
        c.execute(
            &format!("DELETE FROM {table} WHERE group_id IN {GROUPS}"),
            [&room[..]],
        )?;
    }
    c.execute(
        "DELETE FROM recovery_parts WHERE recovery_id IN (SELECT recovery_id FROM recoveries WHERE room_id = ?1)",
        [&room[..]],
    )?;
    c.execute(
        "DELETE FROM recovery_memo WHERE recovery_id IN (SELECT recovery_id FROM recoveries WHERE room_id = ?1)",
        [&room[..]],
    )?;
    c.execute(
        "DELETE FROM invite_requests WHERE invite_id IN (SELECT invite_id FROM invites WHERE room_id = ?1)",
        [&room[..]],
    )?;
    let by_room = [
        "welcomes",
        "sealed_keys",
        "recovery_links",
        "recovery_keys_held",
        "recoveries",
        "envelopes",
        "cards",
        "permission_requests",
        "artifacts",
        "notes",
        "chats",
        "boards",
        "registers",
        "shares",
        "files",
        "invites",
        "requests",
        "push_subscriptions",
        "live_activities",
        "agent_leases",
        "key_packages",
        "account_rooms",
        "devices",
        "groups",
        "rooms",
    ];
    for table in by_room {
        c.execute(
            &format!("DELETE FROM {table} WHERE room_id = ?1"),
            [&room[..]],
        )?;
    }
    Ok(())
}
