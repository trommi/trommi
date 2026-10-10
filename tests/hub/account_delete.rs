//! Deleting an account (`DELETE /v1/account`, spec/hub-api.md "The account"): by a human device with the way in
//! proved once more; the account, its room and every row and file of that room go; another room is not touched.
//! The check walks every table of the schema (from `sqlite_master`), so a table added later is checked as well.

mod common;

use std::collections::{BTreeMap, BTreeSet};

use common::passkey::{Authenticator, ORIGIN, RP, UP_UV};
use common::*;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use trommi_hub::util::{b64, hex, random, unb64};
use trommi_hub::wire::{self, ZERO32};

/// Tables that name no account, room or device and are kept: the references of KeyPackages handed out (kept for
/// ever, 14.2), the login throttle (keyed by hashes of what was typed at a login) and two counters.
const KEPT: [&str; 6] = [
    "spent_key_packages",
    "welcome_ids",
    "login_sources",
    "login_accounts",
    "login_turns",
    "login_counts",
];

fn copy(mark: u8) -> String {
    let mut c = vec![mark; 61];
    c[0] = 2;
    b64(&c)
}

fn account_body(email: &str, auth: &[u8; 32], kit: &[u8; 32]) -> Value {
    json!({
        "email": email,
        "kit": { "auth_key": b64(kit), "sealed_copy": copy(9) },
        "password": { "auth_key": b64(auth), "sealed_copy": copy(7), "kdf": { "alg": "argon2id", "v": 1, "m": 65536, "t": 3, "p": 1 } },
    })
}

fn login(hub: &TestHub, email: &str, auth: &[u8; 32]) -> Reply {
    static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    request(
        hub.port,
        "POST",
        "/v1/account/login",
        &[("cf-connecting-ip", format!("198.51.100.{}", n % 250 + 1))],
        json!({ "email": email, "auth_key": b64(auth) }).to_string().as_bytes(),
    )
}

/// The test's own source forgets its waits (a wrong proof makes it wait a second, then two …), so the next refusal
/// is checked at once.
fn forget_waits(hub: &TestHub) {
    db(hub).execute_batch("DELETE FROM login_sources; DELETE FROM login_turns;").unwrap();
}

fn db(hub: &TestHub) -> rusqlite::Connection {
    rusqlite::Connection::open(hub.dir.join("hub.db")).unwrap()
}

fn tables(c: &rusqlite::Connection) -> Vec<String> {
    let mut s = c
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .unwrap();
    let names = s.query_map([], |r| r.get(0)).unwrap();
    names.collect::<Result<Vec<String>, _>>().unwrap()
}

fn columns(c: &rusqlite::Connection, table: &str) -> Vec<String> {
    let mut s = c.prepare("SELECT name FROM pragma_table_info(?1)").unwrap();
    let names = s.query_map([table], |r| r.get(0)).unwrap();
    names.collect::<Result<Vec<String>, _>>().unwrap()
}

/// Every row of every table, as text: the whole state of the database.
fn snapshot(c: &rusqlite::Connection) -> BTreeMap<String, BTreeSet<String>> {
    tables(c)
        .into_iter()
        .map(|t| {
            let row = columns(c, &t)
                .iter()
                .map(|col| format!("quote(\"{col}\")"))
                .collect::<Vec<_>>()
                .join(" || '|' || ");
            let mut s = c.prepare(&format!("SELECT {row} FROM \"{t}\"")).unwrap();
            let rows = s
                .query_map([], |r| r.get::<_, String>(0))
                .unwrap()
                .collect::<Result<BTreeSet<_>, _>>()
                .unwrap();
            (t, rows)
        })
        .collect()
}

/// The state once the hub's own follow-ups (a Live Activity's counts, pushes) have settled.
fn settled(hub: &TestHub) -> BTreeMap<String, BTreeSet<String>> {
    let mut last = snapshot(&db(hub));
    for _ in 0..50 {
        std::thread::sleep(std::time::Duration::from_millis(200));
        let now = snapshot(&db(hub));
        if now == last {
            return now;
        }
        last = now;
    }
    panic!("the database did not settle");
}

/// Rows anywhere that hold one of `marks` (a room id, a device key, the account's handle, the e-mail), in any
/// column of any table, also inside a longer value (a group id begins with its room id).
fn rows_naming(c: &rusqlite::Connection, marks: &[Vec<u8>]) -> Vec<String> {
    let mut found = Vec::new();
    for t in tables(c) {
        for col in columns(c, &t) {
            for mark in marks {
                let n: i64 = c
                    .query_row(
                        &format!("SELECT count(*) FROM \"{t}\" WHERE instr(CAST(\"{col}\" AS BLOB), ?1) > 0"),
                        [mark],
                        |r| r.get(0),
                    )
                    .unwrap();
                if n > 0 {
                    found.push(format!("{t}.{col}: {n} rows name {}", hex(mark)));
                }
            }
        }
    }
    found
}

#[test]
fn deleting_the_account_removes_every_row_and_file_of_its_room_and_nothing_else() {
    let apns_key = {
        use p256::pkcs8::EncodePrivateKey;
        p256::SecretKey::random(&mut p256::elliptic_curve::rand_core::OsRng).to_pkcs8_pem(Default::default()).unwrap().to_string()
    };
    let hub = TestHub::start_with(&[
        ("APPLE_APNS_KEY", &apns_key),
        ("APPLE_APNS_KEY_ID", "KEYID12345"),
        ("APPLE_TEAM_ID", "TEAMID1234"),
        ("APPLE_APNS_TOPIC", "com.trommi.app"),
    ]);
    // another person's room with its account: before and after, every row of it is the same
    let (other_room, _, other) = found_room(&hub);
    let (other_auth, other_kit) = (random::<32>(), random::<32>());
    other
        .post(&hub, "/v1/account", &account_body("bea@example.org", &other_auth, &other_kit))
        .ok();
    let before = snapshot(&db(&hub));

    // ---- a room that holds something of everything
    let mut w = World::on(hub);
    let (auth, kit) = (random::<32>(), random::<32>());
    w.ada
        .post(&w.hub, "/v1/account", &account_body("ada@example.org", &auth, &kit))
        .ok();
    // a passkey beside the password
    let key = Authenticator::new();
    let challenge = w.ada.post(&w.hub, "/v1/account/passkeys/challenge", &json!({})).ok();
    let handle = unb64(challenge["user_handle"].as_str().unwrap()).unwrap();
    let challenge = unb64(challenge["challenge"].as_str().unwrap()).unwrap();
    w.ada
        .post(&w.hub, "/v1/account/passkeys", &json!({
            "attestation_object": b64(&key.attestation(RP, UP_UV)),
            "client_data_json": b64(&Authenticator::client_data("webauthn.create", &challenge, ORIGIN)),
            "sealed_copy": copy(3), "transports": ["internal"],
        }))
        .ok();
    login(&w.hub, "ada@example.org", &auth).ok();
    let mut bea = w.add_human();
    let mut agent = w.enrol_agent();
    w.catch_up(&mut bea, &w.room.clone());
    let (session, group) = w.found_main(&mut [&mut bea], Some(&mut agent));
    agent.link(&w.hub).ok();
    agent.upload_key_packages(&w.hub, 2).ok();
    agent.send(&w.hub, &group, &chat(&session, agent.id(), "at work")).ok();
    // a file, named by an Artifact, with a Share link
    let file: [u8; 16] = random();
    agent
        .raw(&w.hub, "PUT", &format!("/v1/files/{}", b64(&file)), &[], b"some bytes")
        .ok();
    let object_id = enc::object_id(&group, &agent.id(), agent.chain(&group).0 + 1);
    let mut artifact = object(wire::KIND_VERSION, object_id, wire::TYPE_ARTIFACT, wire::STATE_OPEN, 1, ZERO32, ZERO32);
    artifact.file_ids = vec![file];
    agent.send(&w.hub, &group, &artifact).ok();
    let share: [u8; 16] = random();
    agent
        .post(&w.hub, "/v1/shares", &json!({ "share_id": b64(&share), "secret_hash": b64(&Sha256::digest([7u8; 32])), "file_id": b64(&file), "expires_at": trommi_hub::util::now() + 86_400_000 }))
        .ok();
    let card_id = enc::object_id(&group, &agent.id(), agent.chain(&group).0 + 1);
    agent
        .send(&w.hub, &group, &object(wire::KIND_VERSION, card_id, wire::TYPE_CARD, wire::STATE_OPEN, 2, ZERO32, ZERO32))
        .ok();
    // a note: in the room group, by a human device
    let room_group = w.room.to_vec();
    let note_id = enc::object_id(&room_group, &bea.id(), bea.chain(&room_group).0 + 1);
    bea.send(&w.hub, &room_group, &object(wire::KIND_VERSION, note_id, wire::TYPE_NOTE, wire::STATE_OPEN, 0, ZERO32, ZERO32))
        .ok();
    bea.send(&w.hub, &group, &register(&random(), "v")).ok();
    let board: [u8; 16] = random();
    bea.send(&w.hub, &room_group, &board_item(&board)).ok();
    // a board snapshot's frontier posts (10.9): a declaration and the post bound to its register value
    let head = bea.chain(&room_group);
    let bea_id = bea.id();
    write_snapshot(&w.hub, &mut bea, &room_group, &board, &random(), &[(&bea_id, head)], &[]);
    let (epoch, message) = (bea.epoch(&group), bea.application_message(&group, b"a step"));
    bea.post(&w.hub, &format!("/v1/groups/{}/messages", b64(&group)), &json!({ "epoch": epoch, "message": b64(&message) }))
        .ok();
    agent
        .post(&w.hub, "/v1/requests", &json!({ "kind": "readmit", "group": b64(&group), "key_package": b64(&agent.key_package(false)) }))
        .ok();
    // an invite still open, push and the Live Activity
    let newcomer = Dev::new();
    invite(&w.hub, &w.ada, &newcomer, 1, [0; 16]);
    w.ada
        .post(&w.hub, "/v1/push", &json!({ "apns": { "token": "ab".repeat(32), "key": b64(&[5u8; 32]), "environment": "production", "topic": "com.trommi.app" }, "level": "knocking" }))
        .ok();
    w.ada
        .post(&w.hub, "/v1/live-activity", &json!({ "kind": "start", "token": "cd".repeat(32), "tag": "tag-1", "environment": "production", "topic": "com.trommi.app" }))
        .ok();
    let files = w.hub.dir.join("files").join(hex(&w.room));
    assert!(files.join(hex(&file)).is_file());
    let room = w.room;
    let marks: Vec<Vec<u8>> = vec![
        room.to_vec(),
        w.ada.id().to_vec(),
        bea.id().to_vec(),
        agent.id().to_vec(),
        w.recovery.public().to_vec(),
        handle.clone(),
        key.credential_id.clone(),
        b"ada@example.org".to_vec(),
    ];
    let filled = settled(&w.hub);
    let empty: Vec<&String> = filled
        .iter()
        .filter(|(t, rows)| !KEPT.contains(&t.as_str()) && rows == &&before[t.as_str()])
        .map(|(t, _)| t)
        .collect();
    // (what the scene leaves untouched: a recovery, welcomes once joined, a Cut; the walk below covers them all
    // the same)
    eprintln!("tables this scene leaves as they were: {empty:?}");

    // ---- refused: not a human device; no proof, a wrong one, a passkey on no fresh challenge
    let hub = &w.hub;
    agent.call(hub, "DELETE", "/v1/account", &json!({ "password": { "auth_key": b64(&auth) } }))
        .refused(403, "forbidden");
    w.ada.call(hub, "DELETE", "/v1/account", &json!({})).refused(400, "bad-format");
    w.ada.call(hub, "DELETE", "/v1/account", &json!({ "password": { "auth_key": b64(&random::<32>()) } }))
        .refused(401, "wrong-login");
    // a wrong proof makes the source wait like a wrong login (throttle.rs), in the database, so a restart keeps it
    w.ada.call(hub, "DELETE", "/v1/account", &json!({ "password": { "auth_key": b64(&random::<32>()) } }))
        .refused(429, "rate-limited");
    let waits: i64 = db(hub)
        .query_row("SELECT count(*) FROM login_sources WHERE failures > 0", [], |r| r.get(0))
        .unwrap();
    assert_eq!(waits, 1, "the failure is on record");
    forget_waits(hub);
    w.ada.call(hub, "DELETE", "/v1/account", &json!({ "kit": { "auth_key": b64(&auth) } }))
        .refused(401, "wrong-login");
    forget_waits(hub);
    let assertion = |challenge: &[u8]| {
        let client = Authenticator::client_data("webauthn.get", challenge, ORIGIN);
        let (data, signature) = key.assertion(RP, UP_UV, &client);
        json!({ "passkey": { "credential_id": b64(&key.credential_id), "authenticator_data": b64(&data), "client_data_json": b64(&client), "signature": b64(&signature) } })
    };
    w.ada.call(hub, "DELETE", "/v1/account", &assertion(&[1; 32])).refused(401, "wrong-login");
    forget_waits(hub);
    // a sign-in challenge is not this account's
    let sign_in = unb64(hub.post("/v1/account/passkey/challenge", &json!({})).ok()["challenge"].as_str().unwrap()).unwrap();
    w.ada.call(hub, "DELETE", "/v1/account", &assertion(&sign_in)).refused(401, "wrong-login");
    forget_waits(hub);
    let unkept = |state: BTreeMap<String, BTreeSet<String>>| {
        state.into_iter().filter(|(t, _)| !KEPT.contains(&t.as_str())).collect::<BTreeMap<_, _>>()
    };
    assert_eq!(unkept(settled(hub)), unkept(filled.clone()), "a refused deletion changes nothing but the throttle");

    // ---- deleted, with a passkey on the account's challenge
    let mut events = bea.events(hub, None);
    let fresh = unb64(w.ada.post(hub, "/v1/account/passkeys/challenge", &json!({})).ok()["challenge"].as_str().unwrap()).unwrap();
    assert_eq!(w.ada.call(hub, "DELETE", "/v1/account", &assertion(&fresh)).ok(), json!({ "deleted": true }));

    // no row of any table names the account, the room, its groups or its devices
    let c = db(hub);
    assert_eq!(rows_naming(&c, &marks), Vec::<String>::new());
    // and every table is as it was before the room came, but for the kept ones
    let after = snapshot(&c);
    for (table, rows) in &after {
        if !KEPT.contains(&table.as_str()) {
            assert_eq!(rows, &before[table.as_str()], "{table} holds rows of the deleted room");
        }
    }
    // the files are gone from the disk; a folder of the deleted room that comes back (an upload admitted before
    // the deletion, a crash before its removal) goes with the next sweep, and a living room's folder stays
    assert!(!files.exists());
    std::fs::create_dir_all(&files).unwrap();
    std::fs::write(files.join("left"), b"x").unwrap();
    let living = w.hub.dir.join("files").join(hex(&other_room));
    std::fs::create_dir_all(&living).unwrap();
    hub.post("/v1/__test/sweep", &json!({})).ok();
    assert!(!files.exists(), "the sweep removes the folder of a deleted room");
    assert!(living.exists(), "the sweep leaves a living room's folder");
    // the old e-mail is an e-mail nobody has; the tokens and streams of the room ended
    login(hub, "ada@example.org", &auth).refused(401, "wrong-login");
    w.ada.get(hub, "/v1/account").refused(401, "unauthorised");
    bea.get(hub, "/v1/desk").refused(401, "unauthorised");
    agent.get(hub, "/v1/welcomes").refused(401, "unauthorised");
    assert!(events.ended());
    sign_in_with(hub, &room, &w.ada.signer, None).refused(403, "not-member");
    // the other room is untouched and its account signs in
    login(hub, "bea@example.org", &other_auth).ok();
    other.get(hub, "/v1/account").ok();
    let _ = other_room;
}

#[test]
fn the_password_or_kit_deletes_an_account_and_a_room_without_one_has_nothing_to_delete() {
    let w = World::new();
    let hub = &w.hub;
    // a room without an account
    w.ada.call(hub, "DELETE", "/v1/account", &json!({ "password": { "auth_key": b64(&[1u8; 32]) } }))
        .refused(404, "not-found");
    let (auth, kit) = (random::<32>(), random::<32>());
    w.ada.post(hub, "/v1/account", &account_body("cleo@example.org", &auth, &kit)).ok();
    // the kit is a proof as well
    assert_eq!(
        w.ada.call(hub, "DELETE", "/v1/account", &json!({ "kit": { "auth_key": b64(&kit) } })).ok(),
        json!({ "deleted": true })
    );
    login(hub, "cleo@example.org", &auth).refused(401, "wrong-login");
    let c = db(hub);
    for table in tables(&c) {
        if KEPT.contains(&table.as_str()) {
            continue;
        }
        let n: i64 = c.query_row(&format!("SELECT count(*) FROM \"{table}\""), [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0, "{table} keeps rows of the only room");
    }
    // the e-mail is free again
    let (_, _, again) = found_room(hub);
    again.post(hub, "/v1/account", &account_body("cleo@example.org", &auth, &kit)).ok();
}
