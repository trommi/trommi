//! Accounts over HTTP (spec/v1.md §16, spec/v2.md 8.6, 8.8): the hub checks the login and hands out the sealed
//! copy of the recovery code; one answer for an unknown e-mail and a wrong secret; passkeys; the last way in.

mod common;

use common::passkey::{Authenticator, ORIGIN, RP, UP_UV};
use common::*;
use serde_json::{json, Value};
use trommi_hub::util::{b64, hex, random, unb64};
use trommi_hub::wire;

fn copy(mark: u8) -> String {
    let mut c = vec![mark; 61];
    c[0] = 2;
    b64(&c)
}

const KDF: &str = r#"{"alg":"argon2id","v":1,"m":65536,"t":3,"p":1}"#;

fn kdf() -> Value {
    serde_json::from_str(KDF).unwrap()
}

fn account_body(email: &str, auth: &[u8; 32], kit: &[u8; 32]) -> Value {
    json!({
        "email": email,
        "kit": { "auth_key": b64(kit), "sealed_copy": copy(9) },
        "password": { "auth_key": b64(auth), "sealed_copy": copy(7), "kdf": kdf() },
    })
}

/// An address no other call of this test binary has used: a source of its own for the login throttle.
fn fresh_source() -> String {
    static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("198.51.{}.{}", n / 250 % 250, n % 250 + 1)
}

fn sign_in_from(hub: &TestHub, source: &str, route: &str, email: &str, key: &[u8; 32]) -> Reply {
    request(
        hub.port,
        "POST",
        &format!("/v2/account/{route}"),
        &[("cf-connecting-ip", source.to_string())],
        json!({ "email": email, "auth_key": b64(key) })
            .to_string()
            .as_bytes(),
    )
}

fn login(hub: &TestHub, email: &str, auth: &[u8; 32]) -> Reply {
    sign_in_from(hub, &fresh_source(), "login", email, auth)
}

fn recover(hub: &TestHub, email: &str, kit: &[u8; 32]) -> Reply {
    sign_in_from(hub, &fresh_source(), "recover", email, kit)
}

#[test]
fn an_account_is_made_with_the_room_and_opens_it_again() {
    let hub = TestHub::start();
    let room: [u8; 32] = random();
    let recovery = Recovery::new();
    let mut ada = Dev::new();
    let info = ada.create_room(&room, &recovery);
    let sealed = ada.sealed_key(&room, 0, &info, 0, &recovery.hpke_public, true);
    let (auth, kit) = (random::<32>(), random::<32>());
    let founding = json!({ "group_info": b64(&info), "sealed_key": b64(&sealed), "account": account_body(" Ada@Example.org ", &auth, &kit) });
    // an account that cannot be made makes the whole founding fail
    let mut broken = founding.clone();
    broken["account"]["email"] = json!("not an address");
    hub.post("/v2/rooms", &broken).refused(400, "bad-email");
    let mut no_way_in = founding.clone();
    no_way_in["account"]["password"] = Value::Null;
    hub.post("/v2/rooms", &no_way_in).refused(400, "bad-format");
    sign_in_with(&hub, &room, &ada.signer, None).refused(403, "not-member");
    hub.post("/v2/rooms", &founding).ok();

    // the login: the account's rooms (one for now), each with the sealed copy and a sign-in challenge
    let answer = login(&hub, "ada@example.org", &auth).ok();
    assert_eq!(answer["rooms"].as_array().unwrap().len(), 1);
    assert_eq!(
        (
            answer["rooms"][0]["room_id"].as_str(),
            answer["rooms"][0]["sealed_copy"].as_str()
        ),
        (Some(b64(&room).as_str()), Some(copy(7).as_str()))
    );
    assert_eq!(answer["kdf"], kdf());
    // with the code the device derives the recovery key and signs that challenge
    let challenge: [u8; 32] = unb64(answer["rooms"][0]["challenge"].as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap();
    let hub_auth = wire::HubAuth {
        room_id: room,
        hub: hub.url.as_bytes().to_vec(),
        device: recovery.public(),
        challenge,
    }
    .bytes();
    let token = hub.post(&format!("/v2/rooms/{}/tokens", b64(&room)), &json!({ "auth": b64(&hub_auth), "signature": b64(&sign_with_label(&recovery.sign, "TrommiHubAuth", &hub_auth)) })).ok();
    assert_eq!(token["role"], "recovery");

    // one answer for an unknown e-mail and a wrong password
    let wrong = login(&hub, "ada@example.org", &random());
    let unknown = login(&hub, "nobody@example.org", &auth);
    wrong.refused(401, "wrong-login");
    assert_eq!((wrong.status, &wrong.body), (unknown.status, &unknown.body));
    // the Emergency Kit: its own login key, its own copy, its own code for a wrong one
    let recovered = recover(&hub, "ADA@example.org", &kit).ok();
    assert_eq!(recovered["rooms"][0]["sealed_copy"], copy(9));
    recover(&hub, "ada@example.org", &auth).refused(401, "wrong-recovery");
    login(&hub, "ada@example.org", &kit).refused(401, "wrong-login");

    // what a human device of the room sees of its account: no hash
    ada.sign_in(&hub, &room).ok();
    let view = ada.get(&hub, "/v2/account").ok();
    assert_eq!(
        (
            view["email"].as_str(),
            view["has_password"].as_bool(),
            view["revision"].as_i64()
        ),
        (Some("ada@example.org"), Some(true), Some(1))
    );
    assert!(!view.to_string().contains("hash") && !view.to_string().contains("salt"));
    // one account per e-mail and per room
    ada.post(
        &hub,
        "/v2/account",
        &account_body("other@example.org", &auth, &kit),
    )
    .refused(409, "account-exists");
    let (_, _, bob) = found_room(&hub);
    bob.post(
        &hub,
        "/v2/account",
        &account_body("ada@example.org", &auth, &kit),
    )
    .refused(409, "account-exists");
    bob.get(&hub, "/v2/account").refused(404, "not-found");
    bob.post(
        &hub,
        "/v2/account",
        &account_body("bob@example.org", &random(), &random()),
    )
    .ok();
    hub.get("/v2/account").refused(401, "unauthorised");
}

#[test]
fn password_and_kit_change_under_a_revision_and_only_by_a_human_device() {
    let mut w = World::new();
    let (auth, kit) = (random::<32>(), random::<32>());
    w.ada
        .post(
            &w.hub,
            "/v2/account",
            &account_body("ada@example.org", &auth, &kit),
        )
        .ok();
    let agent = w.enrol_agent();
    agent.get(&w.hub, "/v2/account").refused(403, "forbidden");
    agent.put(&w.hub, "/v2/account/password", &json!({ "auth_key": b64(&random::<32>()), "sealed_copy": copy(1), "kdf": kdf(), "revision": 1 })).refused(403, "forbidden");
    // a new password re-wraps the code and replaces the login key
    let new_auth: [u8; 32] = random();
    let change =
        json!({ "auth_key": b64(&new_auth), "sealed_copy": copy(5), "kdf": kdf(), "revision": 1 });
    assert_eq!(
        w.ada.put(&w.hub, "/v2/account/password", &change).ok()["revision"],
        2
    );
    w.ada
        .put(&w.hub, "/v2/account/password", &change)
        .refused(409, "account-changed");
    login(&w.hub, "ada@example.org", &auth).refused(401, "wrong-login");
    assert_eq!(
        login(&w.hub, "ada@example.org", &new_auth).ok()["rooms"][0]["sealed_copy"],
        copy(5)
    );
    // a record of other parameters, a copy of another format
    let mut weak = change.clone();
    weak["revision"] = json!(2);
    weak["kdf"]["m"] = json!(1024);
    w.ada
        .put(&w.hub, "/v2/account/password", &weak)
        .refused(400, "bad-format");
    let mut old_copy = vec![9u8; 61];
    old_copy[0] = 1;
    w.ada.put(&w.hub, "/v2/account/password", &json!({ "auth_key": b64(&new_auth), "sealed_copy": b64(&old_copy), "kdf": kdf(), "revision": 2 })).refused(400, "bad-format");
    // a new kit replaces the one before
    let new_kit: [u8; 32] = random();
    w.ada
        .put(
            &w.hub,
            "/v2/account/kit",
            &json!({ "auth_key": b64(&new_kit), "sealed_copy": copy(6), "revision": 2 }),
        )
        .ok();
    recover(&w.hub, "ada@example.org", &kit).refused(401, "wrong-recovery");
    assert_eq!(
        recover(&w.hub, "ada@example.org", &new_kit).ok()["rooms"][0]["sealed_copy"],
        copy(6)
    );
}

/// Advances the hub's clock past a `retry-after`.
fn wait_out(hub: &TestHub, refused: &Reply) {
    let seconds: i64 = refused
        .header("retry-after")
        .expect("a refusal says when to come back")
        .parse()
        .unwrap();
    hub.clock(seconds * 1000);
}

#[test]
fn failed_logins_slow_their_source_down_and_lock_nobody_out() {
    let hub = TestHub::start_with(&[("HUB_LIMIT_LOGINS_PER_IP_10MIN", "100000")]);
    let w = World::on(hub);
    let hub = &w.hub;
    let (auth, kit) = (random::<32>(), random::<32>());
    w.ada
        .post(
            hub,
            "/v2/account",
            &account_body("ada@example.org", &auth, &kit),
        )
        .ok();
    let (home, attacker) = (fresh_source(), fresh_source());
    // the owner signs in from home: the account knows that source from now on
    sign_in_from(hub, &home, "login", "ada@example.org", &auth).ok();

    // one source guessing: after each failure it waits longer, 1 s, 2 s, 4 s …; in between it is not even checked
    let mut waits = vec![];
    for _ in 0..6 {
        sign_in_from(hub, &attacker, "login", "ada@example.org", &random())
            .refused(401, "wrong-login");
        let early = sign_in_from(hub, &attacker, "login", "ada@example.org", &auth);
        early.refused(429, "rate-limited");
        waits.push(early.header("retry-after").unwrap().parse::<i64>().unwrap());
        wait_out(hub, &early);
    }
    // (what is told is the time left, in whole seconds: a slow machine eats a second or two of it)
    for (wait, full) in waits.iter().zip([1i64, 2, 4, 8, 16, 32]) {
        assert!((full - 2).max(1) <= *wait && *wait <= full, "{waits:?}");
    }
    // meanwhile the owner gets in at once, from home and from a place the account has never seen
    sign_in_from(hub, &home, "login", "ada@example.org", &auth).ok();
    sign_in_from(hub, &fresh_source(), "login", "ada@example.org", &auth).ok();
    // the Emergency Kit is throttled apart: the same attacking source is not slowed there yet
    sign_in_from(hub, &attacker, "recover", "ada@example.org", &random())
        .refused(401, "wrong-recovery");
    // an e-mail without an account behaves the same: nothing tells whether it exists
    let ghost = fresh_source();
    sign_in_from(hub, &ghost, "login", "ghost@example.org", &random()).refused(401, "wrong-login");
    let early = sign_in_from(hub, &ghost, "login", "ghost@example.org", &random());
    assert_eq!(
        (early.status, early.header("retry-after")),
        (429, Some("1"))
    );

    // many sources hammering the account: its budget for sources it does not know (100 an hour) is spent
    // (nine of them were used above: six by the guessing source, three by the owner)
    for _ in 0..91 {
        sign_in_from(hub, &fresh_source(), "login", "ada@example.org", &random())
            .refused(401, "wrong-login");
    }
    // the owner at home is not touched by it
    sign_in_from(hub, &home, "login", "ada@example.org", &auth).ok();
    // Sources now stand in line: one is checked every two seconds, in the order they came, and each is told its
    // turn. (How long the slow hashes of this test take decides who of these finds the line empty; the exact
    // turns are the throttle's own tests' matter.)
    let port = hub.port;
    let told: Vec<Reply> = (0..6)
        .map(|_| {
            let source = fresh_source();
            std::thread::spawn(move || {
                request(
                    port,
                    "POST",
                    "/v2/account/login",
                    &[("cf-connecting-ip", source)],
                    json!({ "email": "ada@example.org", "auth_key": b64(&random::<32>()) })
                        .to_string()
                        .as_bytes(),
                )
            })
        })
        .collect::<Vec<_>>()
        .into_iter()
        .map(|t| t.join().unwrap())
        .filter(|reply| reply.status == 429)
        .collect();
    assert!(!told.is_empty(), "six guesses at once are not all checked");
    for reply in &told {
        let seconds: i64 = reply.header("retry-after").unwrap().parse().unwrap();
        assert!((1..=14).contains(&seconds), "{seconds}");
    }
    // the owner on a new device somewhere else, with the right password: told a turn at most, and in at that turn
    let third = fresh_source();
    let mut waited = 0;
    loop {
        let reply = sign_in_from(hub, &third, "login", "ada@example.org", &auth);
        if reply.status == 200 {
            break;
        }
        reply.refused(429, "rate-limited");
        waited += reply.header("retry-after").unwrap().parse::<i64>().unwrap();
        assert!(waited <= 30, "in line behind a handful: {waited} s");
        wait_out(hub, &reply);
    }
    // a wrong password from home, while others stand in line, is answered like theirs: with a turn if there is
    // a line. The right one gets in.
    let _ = sign_in_from(hub, &fresh_source(), "login", "ada@example.org", &random());
    let wrong = sign_in_from(hub, &home, "login", "ada@example.org", &random());
    if wrong.status == 429 {
        wait_out(hub, &wrong);
    } else {
        wrong.refused(401, "wrong-login");
        hub.clock(1000);
    }
    sign_in_from(hub, &home, "login", "ada@example.org", &auth).ok();
    // and that place is known from now on: no turn needed next time, whatever the others do
    for _ in 0..5 {
        let _ = sign_in_from(hub, &fresh_source(), "login", "ada@example.org", &random());
    }
    sign_in_from(hub, &third, "login", "ada@example.org", &auth).ok();
    // the answer to a failure is the same for a wrong password and an unknown e-mail
    let wrong = login(hub, "ada@example.org", &random());
    let _ = wrong;

    // behind a proxy the source is the forwarded address only when the hub is told to trust the proxy:
    // without that, a client naming other addresses stays one source
    let plain = TestHub::start_with(&[("HUB_TRUST_CF", "0")]);
    sign_in_from(&plain, "203.0.113.5", "login", "x@example.org", &random())
        .refused(401, "wrong-login");
    sign_in_from(&plain, "203.0.113.6", "login", "x@example.org", &random())
        .refused(429, "rate-limited");
    // and the forwarded value must be an address: anything else is the peer
    let trusted = TestHub::start();
    sign_in_from(
        &trusted,
        "not an address",
        "login",
        "y@example.org",
        &random(),
    )
    .refused(401, "wrong-login");
    sign_in_from(
        &trusted,
        "another string",
        "login",
        "y@example.org",
        &random(),
    )
    .refused(429, "rate-limited");
    // one address: so many attempts in ten minutes, whatever the e-mail
    let limited = TestHub::start_with(&[("HUB_LIMIT_LOGINS_PER_IP_10MIN", "8")]);
    for i in 0..8 {
        let _ = sign_in_from(
            &limited,
            "203.0.113.9",
            "login",
            &format!("u{i}@example.org"),
            &random(),
        );
    }
    sign_in_from(
        &limited,
        "203.0.113.9",
        "login",
        "fresh@example.org",
        &random(),
    )
    .refused(429, "rate-limited");
}

#[test]
fn a_passkey_registers_signs_in_and_is_not_the_last_way_in_removed() {
    let hub = TestHub::start();
    let room: [u8; 32] = random();
    let recovery = Recovery::new();
    let mut ada = Dev::new();
    let info = ada.create_room(&room, &recovery);
    let sealed = ada.sealed_key(&room, 0, &info, 0, &recovery.hpke_public, true);
    // an account with a passkey as its only way in, made with the room
    let key = Authenticator::new();
    let start = hub.post("/v2/account/passkey/challenge", &json!({})).ok();
    let challenge = unb64(start["challenge"].as_str().unwrap()).unwrap();
    // the account's id, named with the challenge: the passkey's user handle
    let handle = unb64(start["user_handle"].as_str().unwrap()).unwrap();
    let passkey = |a: &Authenticator, challenge: &[u8], origin: &str, rp: &str| {
        json!({
            "attestation_object": b64(&a.attestation(rp, UP_UV)), "client_data_json": b64(&Authenticator::client_data("webauthn.create", challenge, origin)),
            "sealed_copy": copy(3), "transports": ["internal"],
        })
    };
    let account = json!({ "email": "ada@example.org", "kit": { "auth_key": b64(&random::<32>()), "sealed_copy": copy(9) }, "passkey": passkey(&key, &challenge, ORIGIN, RP) });
    hub.post(
        "/v2/rooms",
        &json!({ "group_info": b64(&info), "sealed_key": b64(&sealed), "account": account }),
    )
    .ok();
    // the challenge was used up
    let (_, _, other) = found_room(&hub);
    let mut again = account.clone();
    again["email"] = json!("other@example.org");
    other
        .post(&hub, "/v2/account", &again)
        .refused(400, "bad-passkey");

    let sign_in = |a: &Authenticator, origin: &str, rp: &str, flags: u8, fresh: bool| {
        let challenge = if fresh {
            unb64(
                hub.post("/v2/account/passkey/challenge", &json!({})).ok()["challenge"]
                    .as_str()
                    .unwrap(),
            )
            .unwrap()
        } else {
            vec![1; 32]
        };
        let client = Authenticator::client_data("webauthn.get", &challenge, origin);
        let (data, signature) = a.assertion(rp, flags, &client);
        hub.post("/v2/account/passkey/login", &json!({ "credential_id": b64(&a.credential_id), "authenticator_data": b64(&data), "client_data_json": b64(&client), "signature": b64(&signature) }))
    };
    let known = |hub: &TestHub| -> i64 {
        rusqlite::Connection::open(hub.dir.join("hub.db"))
            .unwrap()
            .query_row("SELECT count(*) FROM account_sources", [], |r| r.get(0))
            .unwrap()
    };
    assert_eq!(known(&hub), 0);
    let answer = sign_in(&key, ORIGIN, RP, UP_UV, true).ok();
    // the account knows the source of a passkey sign-in as it knows that of a password
    assert_eq!(known(&hub), 1);
    assert_eq!(
        (
            answer["rooms"][0]["room_id"].as_str(),
            answer["rooms"][0]["sealed_copy"].as_str()
        ),
        (Some(b64(&room).as_str()), Some(copy(3).as_str()))
    );
    // every failure is the one answer: an unknown credential, a challenge the hub did not issue, another origin,
    // another relying party, no user verification
    let failures = [
        sign_in(&Authenticator::new(), ORIGIN, RP, UP_UV, true),
        sign_in(&key, ORIGIN, RP, UP_UV, false),
        sign_in(&key, "https://evil.example", "evil.example", UP_UV, true),
        sign_in(&key, ORIGIN, "evil.example", UP_UV, true),
        sign_in(&key, ORIGIN, RP, 0x01, true),
    ];
    for f in &failures {
        f.refused(401, "wrong-login");
        assert_eq!(f.body, failures[0].body);
    }

    // every failure of this route is the one answer, also a request that lacks a field
    let incomplete = hub.post(
        "/v2/account/passkey/login",
        &json!({ "credential_id": b64(&key.credential_id) }),
    );
    incomplete.refused(401, "wrong-login");
    assert_eq!(incomplete.body, failures[0].body);
    // and a body that is no JSON object at all
    for body in [&b"not json"[..], b"[1, 2]", b"\"text\""] {
        let broken = request(hub.port, "POST", "/v2/account/passkey/login", &[], body);
        broken.refused(401, "wrong-login");
        assert_eq!(broken.body, failures[0].body);
    }
    // the handle the authenticator returns must be the account's, if one is sent at all
    let with_handle = |handle: &[u8]| {
        let challenge = unb64(
            hub.post("/v2/account/passkey/challenge", &json!({})).ok()["challenge"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        let client = Authenticator::client_data("webauthn.get", &challenge, ORIGIN);
        let (data, signature) = key.assertion(RP, UP_UV, &client);
        hub.post("/v2/account/passkey/login", &json!({ "credential_id": b64(&key.credential_id), "authenticator_data": b64(&data), "client_data_json": b64(&client), "signature": b64(&signature), "user_handle": b64(handle) }))
    };
    with_handle(&handle).ok();
    with_handle(&[7; 16]).refused(401, "wrong-login");
    with_handle(b"short").refused(401, "wrong-login");

    // a second passkey, added by a human device of the room with a challenge for that account
    ada.sign_in(&hub, &room).ok();
    let second = Authenticator::new();
    let anonymous = unb64(
        hub.post("/v2/account/passkey/challenge", &json!({})).ok()["challenge"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    ada.post(
        &hub,
        "/v2/account/passkeys",
        &passkey(&second, &anonymous, ORIGIN, RP),
    )
    .refused(400, "bad-passkey");
    let scoped = unb64(
        ada.post(&hub, "/v2/account/passkeys/challenge", &json!({}))
            .ok()["challenge"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    ada.post(
        &hub,
        "/v2/account/passkeys",
        &passkey(&second, &scoped, ORIGIN, RP),
    )
    .ok();
    // a passkey prepared before the account changed is not registered after
    let third = Authenticator::new();
    let stale = unb64(
        ada.post(&hub, "/v2/account/passkeys/challenge", &json!({}))
            .ok()["challenge"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    let revision = ada.get(&hub, "/v2/account").ok()["revision"]
        .as_i64()
        .unwrap();
    ada.put(
        &hub,
        "/v2/account/kit",
        &json!({ "auth_key": b64(&random::<32>()), "sealed_copy": copy(6), "revision": revision }),
    )
    .ok();
    ada.post(
        &hub,
        "/v2/account/passkeys",
        &passkey(&third, &stale, ORIGIN, RP),
    )
    .refused(400, "bad-passkey");
    // a credential id is registered once
    let scoped = unb64(
        ada.post(&hub, "/v2/account/passkeys/challenge", &json!({}))
            .ok()["challenge"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    ada.post(
        &hub,
        "/v2/account/passkeys",
        &passkey(&second, &scoped, ORIGIN, RP),
    )
    .refused(400, "bad-passkey");
    assert_eq!(
        ada.get(&hub, "/v2/account").ok()["passkeys"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    sign_in(&second, ORIGIN, RP, UP_UV, true).ok();
    // the last way in stays (the kit is the way back, not a way in)
    ada.call(
        &hub,
        "DELETE",
        &format!("/v2/account/passkeys/{}", b64(&key.credential_id)),
        &Value::Null,
    )
    .ok();
    ada.call(
        &hub,
        "DELETE",
        &format!("/v2/account/passkeys/{}", b64(&second.credential_id)),
        &Value::Null,
    )
    .refused(409, "last-way-in");
    ada.call(
        &hub,
        "DELETE",
        &format!("/v2/account/passkeys/{}", b64(&key.credential_id)),
        &Value::Null,
    )
    .refused(404, "not-found");
    sign_in(&key, ORIGIN, RP, UP_UV, true).refused(401, "wrong-login");
    // another room's device does not touch this account's passkey
    other
        .call(
            &hub,
            "DELETE",
            &format!("/v2/account/passkeys/{}", b64(&second.credential_id)),
            &Value::Null,
        )
        .refused(404, "not-found");
}

#[test]
fn replacing_the_code_replaces_the_accounts_copies_in_the_same_request() {
    let mut w = World::new();
    let room = w.room;
    let (auth, kit) = (random::<32>(), random::<32>());
    w.ada
        .post(
            &w.hub,
            "/v2/account",
            &account_body("ada@example.org", &auth, &kit),
        )
        .ok();
    let new = Recovery::new();
    let now = w.ada.room_now();
    let out = w.ada.commit(
        &room,
        &Change {
            room: Some(new.room_ext(&[])),
            ..Default::default()
        },
        now,
    );
    let key = w.ada.sealed_key(
        &room,
        out.epoch + 1,
        &out.group_info,
        out.epoch + 1,
        &new.hpke_public,
        true,
    );
    let mut body = commit_json(&out, &key, None);
    body["recovery_link"] = json!(b64(&wire::RecoveryLink {
        room_id: room,
        new_recovery_hpke_key: new.hpke_public.to_vec(),
        kem_output: vec![1; 32],
        ciphertext: vec![2; 80],
        mac: vec![3; 32]
    }
    .bytes()));
    let path = format!("/v2/rooms/{}/recovery-code", b64(&room));
    // without the account's new copies nothing is applied: not the Commit either
    w.ada
        .post(&w.hub, &path, &code_body(&body))
        .refused(400, "incomplete");
    assert_eq!(
        w.ada
            .get(&w.hub, &format!("/v2/groups/{}/info", b64(&room)))
            .ok()["epoch"],
        0
    );
    let new_kit: [u8; 32] = random();
    body["account"] = json!({ "kit": { "auth_key": b64(&new_kit), "sealed_copy": copy(4) }, "password": { "sealed_copy": copy(8) } });
    w.ada.post(&w.hub, &path, &code_body(&body)).ok();
    w.ada.merge(&room);
    // the password opens the new copy; the old kit is gone, the new one opens its copy
    assert_eq!(
        login(&w.hub, "ada@example.org", &auth).ok()["rooms"][0]["sealed_copy"],
        copy(8)
    );
    recover(&w.hub, "ada@example.org", &kit).refused(401, "wrong-recovery");
    assert_eq!(
        recover(&w.hub, "ada@example.org", &new_kit).ok()["rooms"][0]["sealed_copy"],
        copy(4)
    );

    // 8.6, after a recovery with the kit or the bare code: no way in was used just now, so the password is set
    // anew in the same request, with its key and derivation record. The old password opens nothing after.
    let replace = |w: &mut World, account: Value| -> Reply {
        let new = Recovery::new();
        let now = w.ada.room_now();
        let out = w.ada.commit(
            &room,
            &Change {
                room: Some(new.room_ext(&[])),
                ..Default::default()
            },
            now,
        );
        let key = w.ada.sealed_key(
            &room,
            out.epoch + 1,
            &out.group_info,
            out.epoch + 1,
            &new.hpke_public,
            true,
        );
        // (the Commit's fields under `commit`, as hub-api.md writes the body)
        let body = json!({
            "commit": commit_json(&out, &key, None),
            "recovery_link": b64(&wire::RecoveryLink { room_id: room, new_recovery_hpke_key: new.hpke_public.to_vec(), kem_output: vec![1; 32], ciphertext: vec![2; 80], mac: vec![3; 32] }.bytes()),
            "account": account,
        });
        let reply = w.ada.post(&w.hub, &path, &body);
        if reply.status == 200 {
            w.ada.merge(&room);
        } else {
            w.ada.clear(&room);
        }
        reply
    };
    let (next_auth, next_kit): ([u8; 32], [u8; 32]) = (random(), random());
    // a new password without its derivation record is no password
    replace(&mut w, json!({ "kit": { "auth_key": b64(&next_kit), "sealed_copy": copy(5) }, "password": { "auth_key": b64(&next_auth), "sealed_copy": copy(6) } }))
        .refused(400, "bad-format");
    login(&w.hub, "ada@example.org", &auth).ok();
    replace(&mut w, json!({ "kit": { "auth_key": b64(&next_kit), "sealed_copy": copy(5) }, "password": { "auth_key": b64(&next_auth), "sealed_copy": copy(6), "kdf": kdf() } })).ok();
    login(&w.hub, "ada@example.org", &auth).refused(401, "wrong-login");
    assert_eq!(
        login(&w.hub, "ada@example.org", &next_auth).ok()["rooms"][0]["sealed_copy"],
        copy(6)
    );
    assert_eq!(
        recover(&w.hub, "ada@example.org", &next_kit).ok()["rooms"][0]["sealed_copy"],
        copy(5)
    );

    // or a passkey made anew: registered in that request, on a challenge asked for without a token; the
    // password is gone with it
    let key = Authenticator::new();
    // (the account's own challenge, which names the id the passkey carries as its user handle)
    let asked = w
        .ada
        .post(&w.hub, "/v2/account/passkeys/challenge", &json!({}))
        .ok();
    assert_eq!(
        asked["account"],
        w.ada.get(&w.hub, "/v2/account").ok()["account"]
    );
    // with it what a new kit is salted with (8.8.2)
    assert_eq!(
        (&asked["email"], &asked["kit_form"]),
        (&json!("ada@example.org"), &json!("email"))
    );
    let challenge = unb64(asked["challenge"].as_str().unwrap()).unwrap();
    // one of the tokenless kind is for a new account, not for this one
    let loose = unb64(
        w.hub.post("/v2/account/passkey/challenge", &json!({})).ok()["challenge"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    let stray = Authenticator::new();
    replace(&mut w, json!({ "kit": { "auth_key": b64(&random::<32>()), "sealed_copy": copy(2) }, "passkey": {
        "attestation_object": b64(&stray.attestation(RP, UP_UV)), "client_data_json": b64(&Authenticator::client_data("webauthn.create", &loose, ORIGIN)),
        "sealed_copy": copy(3), "transports": ["internal"] } })).refused(400, "bad-passkey");
    let last_kit: [u8; 32] = random();
    let registration = json!({
        "attestation_object": b64(&key.attestation(RP, UP_UV)), "client_data_json": b64(&Authenticator::client_data("webauthn.create", &challenge, ORIGIN)),
        "sealed_copy": copy(3), "transports": ["internal"],
    });
    replace(&mut w, json!({ "kit": { "auth_key": b64(&last_kit), "sealed_copy": copy(2) }, "passkey": registration })).ok();
    login(&w.hub, "ada@example.org", &next_auth).refused(401, "wrong-login");
    let account = w.ada.get(&w.hub, "/v2/account").ok();
    assert_eq!(account["has_password"], false);
    assert_eq!(account["passkeys"].as_array().unwrap().len(), 1);
    assert_eq!(
        account["passkeys"][0]["credential_id"],
        b64(&key.credential_id)
    );
    assert_eq!(account["passkeys"][0]["sealed_copy"], copy(3));
}

#[test]
fn one_ipv6_network_is_one_source() {
    let hub = TestHub::start();
    // two addresses of one /64: the second is the same guessing source
    sign_in_from(
        &hub,
        "2001:db8:1:2::1",
        "login",
        "v6@example.org",
        &random(),
    )
    .refused(401, "wrong-login");
    sign_in_from(
        &hub,
        "2001:db8:1:2:aaaa:bbbb:cccc:dddd",
        "login",
        "v6@example.org",
        &random(),
    )
    .refused(429, "rate-limited");
    // another network is another source
    sign_in_from(
        &hub,
        "2001:db8:1:3::1",
        "login",
        "v6@example.org",
        &random(),
    )
    .refused(401, "wrong-login");
}

#[test]
fn an_account_with_a_passkey_needs_no_e_mail() {
    let mut w = World::new();
    let room = w.room;
    let challenge = |hub: &TestHub| {
        unb64(
            hub.post("/v2/account/passkey/challenge", &json!({})).ok()["challenge"]
                .as_str()
                .unwrap(),
        )
        .unwrap()
    };
    let registration = |a: &Authenticator, challenge: &[u8], mark: u8| {
        json!({
            "attestation_object": b64(&a.attestation(RP, UP_UV)),
            "client_data_json": b64(&Authenticator::client_data("webauthn.create", challenge, ORIGIN)),
            "sealed_copy": copy(mark), "transports": ["internal"],
        })
    };
    let sign_in = |hub: &TestHub, a: &Authenticator, handle: Option<&[u8]>| {
        let client = Authenticator::client_data("webauthn.get", &challenge(hub), ORIGIN);
        let (data, signature) = a.assertion(RP, UP_UV, &client);
        let mut body = json!({ "credential_id": b64(&a.credential_id), "authenticator_data": b64(&data), "client_data_json": b64(&client), "signature": b64(&signature) });
        if let Some(handle) = handle {
            body["user_handle"] = json!(b64(handle));
        }
        hub.post("/v2/account/passkey/login", &body)
    };
    let recover_by_id = |hub: &TestHub, id: &str, kit: &[u8; 32]| {
        request(
            hub.port,
            "POST",
            "/v2/account/recover",
            &[("cf-connecting-ip", fresh_source())],
            json!({ "account": id, "auth_key": b64(kit) })
                .to_string()
                .as_bytes(),
        )
    };

    // sign-up: a passkey, a kit, the account's random id (the passkey's user handle), and no e-mail
    let (key, kit): (Authenticator, [u8; 32]) = (Authenticator::new(), random());
    let hub = &w.hub;
    // the hub names the account's id with the challenge: the device needs it before the account exists (it is
    // the passkey's user handle and the salt of the kit)
    let start = hub.post("/v2/account/passkey/challenge", &json!({})).ok();
    let first = unb64(start["challenge"].as_str().unwrap()).unwrap();
    let handle = unb64(start["user_handle"].as_str().unwrap()).unwrap();
    let id = start["account"].as_str().unwrap().to_string();
    assert_eq!(handle.len(), 16);
    assert_eq!(id.len(), 36);
    assert_eq!(id.replace('-', ""), hex(&handle));
    assert_eq!(
        (&id[14..15], handle[8] & 0xc0),
        ("4", 0x80),
        "a UUID of version 4"
    );
    // (a password signs in under an e-mail: without one it is no way in)
    w.ada.post(hub, "/v2/account", &json!({ "kit": { "auth_key": b64(&kit), "sealed_copy": copy(9) }, "password": { "auth_key": b64(&random::<32>()), "sealed_copy": copy(7), "kdf": kdf() } }))
        .refused(400, "bad-email");
    let made = w
        .ada
        .post(
            hub,
            "/v2/account",
            &json!({
                "kit": { "auth_key": b64(&kit), "sealed_copy": copy(9) },
                "passkey": registration(&key, &first, 3),
            }),
        )
        .ok();
    assert_eq!(
        (&made["email"], &made["account"], &made["has_password"]),
        (&Value::Null, &json!(id), &json!(false))
    );
    assert_eq!(made["kit_form"], "id");
    assert_eq!(w.ada.get(hub, "/v2/account").ok()["email"], Value::Null);

    // log-in without a name: the hub finds the account by the credential; the handle, if sent, must be its id
    let answer = sign_in(hub, &key, None).ok();
    assert_eq!(answer["rooms"][0]["room_id"], b64(&room));
    assert_eq!(answer["rooms"][0]["sealed_copy"], copy(3));
    assert_eq!(
        (&answer["account"], &answer["email"]),
        (&json!(id), &Value::Null)
    );
    sign_in(hub, &key, Some(&handle)).ok();
    sign_in(hub, &key, Some(&random::<16>())).refused(401, "wrong-login");

    // another room, another account: with an e-mail beside its passkey; its kit is then under the e-mail's salt
    // unless it says otherwise
    let (_, _, other) = found_room(hub);
    let other_key = Authenticator::new();
    let made = other.post(hub, "/v2/account", &json!({ "kit": { "auth_key": b64(&random::<32>()), "sealed_copy": copy(9) }, "passkey": registration(&other_key, &challenge(hub), 3), "email": "other@example.org" })).ok();
    assert_eq!(made["kit_form"], "email");
    assert_ne!(made["account"], id);
    assert_eq!(
        sign_in(hub, &other_key, None).ok()["email"],
        "other@example.org"
    );

    // a second passkey; the last way in stays
    let second = Authenticator::new();
    let scoped = unb64(
        w.ada
            .post(hub, "/v2/account/passkeys/challenge", &json!({}))
            .ok()["challenge"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    w.ada
        .post(
            hub,
            "/v2/account/passkeys",
            &registration(&second, &scoped, 4),
        )
        .ok();
    assert_eq!(
        sign_in(hub, &second, None).ok()["rooms"][0]["sealed_copy"],
        copy(4)
    );
    w.ada
        .call(
            hub,
            "DELETE",
            &format!("/v2/account/passkeys/{}", b64(&key.credential_id)),
            &Value::Null,
        )
        .ok();
    w.ada
        .call(
            hub,
            "DELETE",
            &format!("/v2/account/passkeys/{}", b64(&second.credential_id)),
            &Value::Null,
        )
        .refused(409, "last-way-in");
    sign_in(hub, &key, None).refused(401, "wrong-login");

    // the Emergency Kit names the account by its id; an id nobody has and a wrong kit are one answer, and the
    // throttle counts under the id as it does under an e-mail
    assert_eq!(
        recover_by_id(hub, &id, &kit).ok()["rooms"][0]["sealed_copy"],
        copy(9)
    );
    let wrong = recover_by_id(hub, &id, &random());
    let nobody = recover_by_id(
        hub,
        &trommi_hub::accounts::id_text(&trommi_hub::accounts::new_id()),
        &kit,
    );
    wrong.refused(401, "wrong-recovery");
    nobody.refused(401, "wrong-recovery");
    assert_eq!(wrong.body, nobody.body);
    let guesser = fresh_source();
    let guess = |kit: &[u8; 32]| {
        request(
            hub.port,
            "POST",
            "/v2/account/recover",
            &[("cf-connecting-ip", guesser.clone())],
            json!({ "account": id, "auth_key": b64(kit) })
                .to_string()
                .as_bytes(),
        )
    };
    guess(&random()).refused(401, "wrong-recovery");
    guess(&kit).refused(429, "rate-limited");
    // by an e-mail it has none to be found under; the id opens no password login
    recover(hub, "ada@example.org", &kit).refused(401, "wrong-recovery");
    request(
        hub.port,
        "POST",
        "/v2/account/login",
        &[("cf-connecting-ip", fresh_source())],
        json!({ "account": id, "auth_key": b64(&kit) })
            .to_string()
            .as_bytes(),
    )
    .refused(401, "wrong-login");

    // 8.6 for such an account: new recovery keys bring a new kit and a new copy under the passkey used just now
    let new = Recovery::new();
    let now = w.ada.room_now();
    let out = w.ada.commit(
        &room,
        &Change {
            room: Some(new.room_ext(&[])),
            ..Default::default()
        },
        now,
    );
    let key_row = w.ada.sealed_key(
        &room,
        out.epoch + 1,
        &out.group_info,
        out.epoch + 1,
        &new.hpke_public,
        true,
    );
    let next_kit: [u8; 32] = random();
    w.ada.post(&w.hub, &format!("/v2/rooms/{}/recovery-code", b64(&room)), &json!({
        "commit": commit_json(&out, &key_row, None),
        "recovery_link": b64(&wire::RecoveryLink { room_id: room, new_recovery_hpke_key: new.hpke_public.to_vec(), kem_output: vec![1; 32], ciphertext: vec![2; 80], mac: vec![3; 32] }.bytes()),
        "account": { "kit": { "auth_key": b64(&next_kit), "sealed_copy": copy(5) }, "passkey": { "credential_id": b64(&second.credential_id), "sealed_copy": copy(6) } },
    })).ok();
    w.ada.merge(&room);
    let hub = &w.hub;
    assert_eq!(
        sign_in(hub, &second, None).ok()["rooms"][0]["sealed_copy"],
        copy(6)
    );
    assert_eq!(
        recover_by_id(hub, &id, &next_kit).ok()["rooms"][0]["sealed_copy"],
        copy(5)
    );
    recover_by_id(hub, &id, &kit).refused(401, "wrong-recovery");

    // an e-mail and a password later: the password needs the e-mail first; an address another account holds is
    // answered as signing up with it is; the e-mail is set once
    let revision = |w: &World| {
        w.ada.get(&w.hub, "/v2/account").ok()["revision"]
            .as_i64()
            .unwrap()
    };
    let (auth, mail_kit): ([u8; 32], [u8; 32]) = (random(), random());
    let password = |w: &World| json!({ "auth_key": b64(&auth), "sealed_copy": copy(8), "kdf": kdf(), "revision": revision(w) });
    w.ada
        .call(hub, "PUT", "/v2/account/password", &password(&w))
        .refused(400, "bad-email");
    w.ada
        .call(
            hub,
            "PUT",
            "/v2/account/email",
            &json!({ "email": "other@example.org", "kit": { "auth_key": b64(&mail_kit), "sealed_copy": copy(1) }, "revision": revision(&w) }),
        )
        .refused(409, "account-exists");
    w.ada
        .call(
            hub,
            "PUT",
            "/v2/account/email",
            &json!({ "email": "not an address", "kit": { "auth_key": b64(&mail_kit), "sealed_copy": copy(1) }, "revision": revision(&w) }),
        )
        .refused(400, "bad-email");
    w.ada
        .call(
            hub,
            "PUT",
            "/v2/account/email",
            &json!({ "email": "Ada@Example.org", "revision": revision(&w) }),
        )
        .refused(400, "incomplete");
    w.ada
        .call(
            hub,
            "PUT",
            "/v2/account/email",
            &json!({ "email": "Ada@Example.org", "kit": { "auth_key": b64(&mail_kit), "sealed_copy": copy(1) }, "revision": revision(&w) }),
        )
        .ok();
    w.ada
        .call(
            hub,
            "PUT",
            "/v2/account/email",
            &json!({ "email": "ada2@example.org", "kit": { "auth_key": b64(&mail_kit), "sealed_copy": copy(1) }, "revision": revision(&w) }),
        )
        .refused(403, "forbidden");
    w.ada
        .call(hub, "PUT", "/v2/account/password", &password(&w))
        .ok();
    assert_eq!(login(hub, "ada@example.org", &auth).ok()["account"], id);
    // with the e-mail came the kit made anew under it (8.8.2): the one from before opens nothing, and the
    // account says which form its kit has
    recover_by_id(hub, &id, &next_kit).refused(401, "wrong-recovery");
    assert_eq!(
        recover_by_id(hub, &id, &mail_kit).ok()["email"],
        "ada@example.org"
    );
    assert_eq!(w.ada.get(hub, "/v2/account").ok()["kit_form"], "email");
    // one field names the account, by e-mail or by id, for the password as for the kit; the id as a person
    // types it: case, spaces and dashes do not matter, anything else is no id
    let by = |route: &str, name: &str, key: &[u8; 32]| {
        request(
            hub.port,
            "POST",
            &format!("/v2/account/{route}"),
            &[("cf-connecting-ip", fresh_source())],
            json!({ "account": name, "auth_key": b64(key) })
                .to_string()
                .as_bytes(),
        )
    };
    let typed = format!(" {} ", id.to_uppercase().replace('-', " "));
    for name in [id.as_str(), typed.as_str(), "ada@example.org"] {
        assert_eq!(
            by("login", name, &auth).ok()["rooms"][0]["sealed_copy"],
            copy(8),
            "{name}"
        );
        assert_eq!(
            by("recover", name, &mail_kit).ok()["rooms"][0]["sealed_copy"],
            copy(1),
            "{name}"
        );
    }
    // an id nobody has, an e-mail nobody has, something that is neither, and a wrong key: one answer
    let unknown = trommi_hub::accounts::id_text(&trommi_hub::accounts::new_id());
    let answers: Vec<Reply> = vec![
        by("login", &id, &random()),
        by("login", &unknown, &auth),
        by("login", "nobody@example.org", &auth),
        by("login", &id[..35], &auth),
        by("login", &format!("{id}0"), &auth),
    ];
    for reply in &answers {
        reply.refused(401, "wrong-login");
        assert_eq!(reply.body, answers[0].body);
    }
    // guessing under the id is slowed like guessing under the e-mail: per source, 1 s after the first failure
    let guesser = fresh_source();
    let guess = |key: &[u8; 32]| {
        request(
            hub.port,
            "POST",
            "/v2/account/login",
            &[("cf-connecting-ip", guesser.clone())],
            json!({ "account": unknown, "auth_key": b64(key) })
                .to_string()
                .as_bytes(),
        )
    };
    guess(&random()).refused(401, "wrong-login");
    let slowed = guess(&random());
    assert_eq!(
        (slowed.status, slowed.header("retry-after")),
        (429, Some("1"))
    );
}

#[test]
fn the_account_id_has_the_text_of_the_cores_vectors() {
    let vectors: Value =
        serde_json::from_str(include_str!("../../spec/vectors/account.json")).unwrap();
    let id = trommi_hub::util::unhex(vectors["account_id"].as_str().unwrap()).unwrap();
    let text = vectors["account_id_text"].as_str().unwrap();
    assert_eq!(trommi_hub::accounts::id_text(&id), text);
    assert_eq!(
        trommi_hub::accounts::parse_id(text).map(|i| i.to_vec()),
        Some(id.clone())
    );
    // the hub also takes what a person types: case, spaces and dashes aside (clients hand the core the tidy form)
    assert_eq!(
        trommi_hub::accounts::parse_id(&text.to_uppercase().replace('-', " ")).map(|i| i.to_vec()),
        Some(id)
    );
    // what is no id for the core for another reason than those is none for the hub
    for refused in vectors["refused_id_texts"].as_array().unwrap() {
        let text = refused["text"].as_str().unwrap();
        let tidy: String = text
            .chars()
            .filter(|c| !c.is_whitespace() && *c != '-')
            .collect();
        if tidy.len() != 32 || !tidy.bytes().all(|b| b.is_ascii_hexdigit()) {
            assert!(trommi_hub::accounts::parse_id(text).is_none(), "{text}");
        }
    }
    // a minted id is a UUID in that text
    let minted = trommi_hub::accounts::id_text(&trommi_hub::accounts::new_id());
    assert_eq!(
        (minted.len(), &minted[8..9], &minted[23..24]),
        (36, "-", "-")
    );
}
