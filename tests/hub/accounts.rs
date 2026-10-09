//! Accounts over HTTP (spec/v1.md §16, spec/v2.md 8.6, 8.8): the hub checks the login and hands out the sealed
//! copy of the recovery code; one answer for an unknown e-mail and a wrong secret; passkeys; the last way in.

mod common;

use common::passkey::{Authenticator, ORIGIN, RP, UP_UV};
use common::*;
use serde_json::{json, Value};
use trommi_hub::util::{b64, random, unb64};
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

fn login(hub: &TestHub, email: &str, auth: &[u8; 32]) -> Reply {
    hub.post(
        "/v2/account/login",
        &json!({ "email": email, "auth_key": b64(auth) }),
    )
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
    .encode();
    let token = hub.post(&format!("/v2/rooms/{}/tokens", b64(&room)), &json!({ "auth": b64(&hub_auth), "signature": b64(&sign_with_label(&recovery.sign, "TrommiHubAuth", &hub_auth)) })).ok();
    assert_eq!(token["role"], "recovery");

    // one answer for an unknown e-mail and a wrong password
    let wrong = login(&hub, "ada@example.org", &random());
    let unknown = login(&hub, "nobody@example.org", &auth);
    wrong.refused(401, "wrong-login");
    assert_eq!((wrong.status, &wrong.body), (unknown.status, &unknown.body));
    // the Emergency Kit: its own login key, its own copy, its own code for a wrong one
    let recovered = hub
        .post(
            "/v2/account/recover",
            &json!({ "email": "ADA@example.org", "auth_key": b64(&kit) }),
        )
        .ok();
    assert_eq!(recovered["rooms"][0]["sealed_copy"], copy(9));
    hub.post(
        "/v2/account/recover",
        &json!({ "email": "ada@example.org", "auth_key": b64(&auth) }),
    )
    .refused(401, "wrong-recovery");
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
    w.hub
        .post(
            "/v2/account/recover",
            &json!({ "email": "ada@example.org", "auth_key": b64(&kit) }),
        )
        .refused(401, "wrong-recovery");
    assert_eq!(
        w.hub
            .post(
                "/v2/account/recover",
                &json!({ "email": "ada@example.org", "auth_key": b64(&new_kit) })
            )
            .ok()["rooms"][0]["sealed_copy"],
        copy(6)
    );
}

#[test]
fn repeated_failures_lock_an_e_mail_out_and_an_address_is_limited() {
    let hub = TestHub::start_with(&[
        ("HUB_LIMIT_LOGIN_FAILURES_PER_EMAIL_HOUR", "3"),
        ("HUB_LIMIT_LOGINS_PER_IP_10MIN", "8"),
    ]);
    let w = World::on(hub);
    let auth: [u8; 32] = random();
    w.ada
        .post(
            &w.hub,
            "/v2/account",
            &account_body("ada@example.org", &auth, &random()),
        )
        .ok();
    let from = |ip: &str, email: &str, key: &[u8; 32]| {
        request(
            w.hub.port,
            "POST",
            "/v2/account/login",
            &[("cf-connecting-ip", ip.to_string())],
            json!({ "email": email, "auth_key": b64(key) })
                .to_string()
                .as_bytes(),
        )
    };
    for _ in 0..3 {
        from("203.0.113.1", "ada@example.org", &random()).refused(401, "wrong-login");
    }
    // locked: also the right password waits, whoever asks; the answer says how long
    let locked = from("203.0.113.2", "ada@example.org", &auth);
    locked.refused(429, "rate-limited");
    assert!(locked.header("retry-after").is_some());
    // an unknown e-mail is locked the same way: the lock tells nothing about whether it exists
    for _ in 0..3 {
        from("203.0.113.3", "ghost@example.org", &random()).refused(401, "wrong-login");
    }
    from("203.0.113.3", "ghost@example.org", &random()).refused(429, "rate-limited");
    // one address: so many attempts in ten minutes, whatever the e-mail
    for i in 0..8 {
        let _ = from("203.0.113.9", &format!("u{i}@example.org"), &random());
    }
    from("203.0.113.9", "fresh@example.org", &random()).refused(429, "rate-limited");
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
    let challenge = unb64(
        hub.post("/v2/account/passkey/challenge", &json!({})).ok()["challenge"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
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
    let answer = sign_in(&key, ORIGIN, RP, UP_UV, true).ok();
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
        out.epoch,
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
    .encode()));
    let path = format!("/v2/rooms/{}/recovery-code", b64(&room));
    // without the account's new copies nothing is applied: not the Commit either
    w.ada.post(&w.hub, &path, &body).refused(400, "incomplete");
    assert_eq!(
        w.ada
            .get(&w.hub, &format!("/v2/groups/{}/info", b64(&room)))
            .ok()["epoch"],
        0
    );
    let new_kit: [u8; 32] = random();
    body["account"] = json!({ "kit": { "auth_key": b64(&new_kit), "sealed_copy": copy(4) }, "password": { "sealed_copy": copy(8) } });
    w.ada.post(&w.hub, &path, &body).ok();
    w.ada.merge(&room);
    // the password opens the new copy; the old kit is gone, the new one opens its copy
    assert_eq!(
        login(&w.hub, "ada@example.org", &auth).ok()["rooms"][0]["sealed_copy"],
        copy(8)
    );
    w.hub
        .post(
            "/v2/account/recover",
            &json!({ "email": "ada@example.org", "auth_key": b64(&kit) }),
        )
        .refused(401, "wrong-recovery");
    assert_eq!(
        w.hub
            .post(
                "/v2/account/recover",
                &json!({ "email": "ada@example.org", "auth_key": b64(&new_kit) })
            )
            .ok()["rooms"][0]["sealed_copy"],
        copy(4)
    );
}
