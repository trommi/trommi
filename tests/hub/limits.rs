//! Every limit at its exact value: the last one that is taken and the first one that is refused, with its code.
//! Limits of spec/v2.md section 16 and of spec/hub-api.md ("Decided for the first hub"); where a limit is large,
//! the hub is started with a small one (its setting is named), so that the boundary itself is what is tested.
//! Also here: the admission queue, the pool for expensive work, and the policies set by configuration.

mod common;

use common::passkey::{Authenticator, ORIGIN, RP, UP_UV};
use common::*;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use trommi_hub::util::{b64, random, unb64};
use trommi_hub::wire::{self, ZERO16, ZERO32};

/// `allowed` attempts are taken, the next one is refused with `status` and `code`.
fn boundary(
    what: &str,
    allowed: usize,
    mut attempt: impl FnMut(usize) -> Reply,
    status: u16,
    code: &str,
) -> Reply {
    for i in 0..allowed {
        let reply = attempt(i);
        assert_eq!(
            reply.status,
            200,
            "{what}: attempt {} of {allowed} allowed: {}",
            i + 1,
            String::from_utf8_lossy(&reply.body)
        );
    }
    let refused = attempt(allowed);
    assert_eq!(
        (refused.status, refused.code().as_str()),
        (status, code),
        "{what}: attempt {} must be refused: {}",
        allowed + 1,
        String::from_utf8_lossy(&refused.body)
    );
    refused
}

fn world(env: &[(&str, &str)]) -> World {
    World::on(TestHub::start_with(env))
}

#[test]
fn counts_per_device() {
    let w = world(&[]);
    let hub = &w.hub;
    // 16: streams per device 8
    let mut streams = vec![];
    for i in 0..9 {
        let s = w.ada.events(hub, None);
        assert_eq!(s.status, if i < 8 { 200 } else { 429 }, "stream {}", i + 1);
        streams.push(s);
    }
    drop(streams);
    // 16: KeyPackages per device 100 single-use (five are there from the start)
    let more: Vec<String> = (0..95).map(|_| b64(&w.ada.key_package(false))).collect();
    assert_eq!(
        w.ada
            .put(hub, "/v2/key-packages", &json!({ "single_use": more }))
            .ok()["unused"],
        100
    );
    w.ada
        .put(
            hub,
            "/v2/key-packages",
            &json!({ "single_use": [b64(&w.ada.key_package(false))] }),
        )
        .refused(429, "too-many");
    // a device has ten push registrations
    boundary(
        "push registrations per device",
        10,
        |i| {
            let key = p256::SecretKey::random(&mut p256::elliptic_curve::rand_core::OsRng);
            let point = p256::elliptic_curve::sec1::ToEncodedPoint::to_encoded_point(
                &key.public_key(),
                false,
            );
            w.ada.post(hub, "/v2/push", &json!({ "web_push": { "endpoint": format!("http://127.0.0.1:9/p/{i}"), "keys": { "p256dh": b64(point.as_bytes()), "auth": b64(&[1u8; 16]) } }, "level": "all" }))
        },
        429,
        "too-many",
    );
    // 16: open invites 16
    let (room_epoch, room_state) = w.ada.room_now();
    boundary(
        "open invites",
        16,
        |_| {
            let offer = wire::Offer {
                room_id: w.room,
                invite_id: random(),
                role: 1,
                session_id: ZERO16,
                expires_at: trommi_hub::util::now() + 600_000,
                commitment: [1; 32],
                inviter: w.ada.id(),
                room_epoch,
                room_state,
            }
            .bytes();
            w.ada.post(hub, "/v2/invites", &json!({ "offer": b64(&offer), "signature": b64(&w.ada.sign("TrommiInviteOffer", &offer)) }))
        },
        429,
        "too-many",
    );
    // a device's wishes: ten at once, then one every five seconds
    boundary(
        "requests",
        10,
        |_| {
            w.ada
                .post(hub, "/v2/requests", &json!({ "kind": "handover" }))
        },
        429,
        "rate-limited",
    );
    // 16: stroke pieces 20 per second per device
    let mut ada = w.ada;
    let room = w.room;
    boundary(
        "stroke pieces in a second",
        20,
        |_| ada.post_message(hub, &room, b"piece", true),
        429,
        "rate-limited",
    );
}

#[test]
fn devices_and_sessions_of_a_room() {
    // 16: human devices in a room 32, enrolled agent devices 256: here with 2 and 1
    let mut w = world(&[
        ("HUB_LIMIT_HUMANS", "2"),
        ("HUB_LIMIT_AGENTS", "1"),
        ("HUB_LIMIT_HELPERS_PER_MAIN", "2"),
    ]);
    let room = w.room;
    let mut bea = w.add_human();
    let third = Dev::new();
    let (key_package, _) = invite(&w.hub, &w.ada, &third, 1, ZERO16);
    let now = w.ada.room_now();
    let out = w.ada.commit(
        &room,
        &Change {
            adds: vec![key_package],
            ..Default::default()
        },
        now,
    );
    let sealed = w.ada.sealed_key(
        &room,
        out.epoch + 1,
        &out.group_info,
        out.epoch,
        &w.recovery.hpke_public,
        true,
    );
    w.ada
        .post_commit(&w.hub, &out, &sealed)
        .refused(429, "too-many");
    let mut agent = w.enrol_agent();
    let second = Dev::new();
    invite(&w.hub, &w.ada, &second, 2, ZERO16);
    w.set_agents(&[agent.id(), second.id()])
        .refused(429, "too-many");

    // 16: live helper sessions per main session 32: here 2
    w.catch_up(&mut bea, &room);
    let (session, _main) = w.found_main(&mut [&mut bea], Some(&mut agent));
    let humans = [w.ada.id(), bea.id()];
    let mut helper_groups = vec![];
    for i in 0..3 {
        let (group, reply, _) = w.found_helper(&mut agent, &session, &humans, &[]);
        if i < 2 {
            reply.ok();
            helper_groups.push(group);
        } else {
            reply.refused(429, "too-many");
        }
    }
    // an archived one no longer counts
    w.ada
        .post(
            &w.hub,
            &format!("/v2/groups/{}/archive", b64(&helper_groups[0])),
            &json!({}),
        )
        .ok();
    w.found_helper(&mut agent, &session, &humans, &[]).1.ok();

    // 16: devices added by an opener 7
    let group = helper_groups[1].clone();
    let now = w.ada.room_now();
    for i in 0..8 {
        let out = agent.commit(
            &group,
            &Change {
                adds: vec![Dev::new().key_package(false)],
                ..Default::default()
            },
            now,
        );
        let key = agent.sealed_key(
            &group,
            out.epoch + 1,
            &out.group_info,
            now.0,
            &w.recovery.hpke_public,
            false,
        );
        let reply = agent.post_commit(&w.hub, &out, &key);
        if i < 7 {
            reply.ok();
        } else {
            reply.refused(400, "bad-commit");
        }
    }
}

#[test]
fn what_a_room_may_hold() {
    // quota.rs: every count that could grow without end, here with small numbers
    let mut w = world(&[
        ("HUB_QUOTA_FILES", "3"),
        ("HUB_QUOTA_REGISTERS", "2"),
        ("HUB_QUOTA_VOIDS", "1"),
        ("HUB_QUOTA_GROUPS", "3"),
        ("HUB_QUOTA_HELPER_DEVICES", "1"),
        ("HUB_LIMIT_FILE", "1000"),
        ("HUB_ROOM_QUOTA", "1500"),
        ("HUB_LIMIT_SHARES_PER_ROOM", "2"),
        ("HUB_LIMIT_EPOCH_ENVELOPES", "6"),
    ]);
    let room = w.room;
    let put = |hub: &TestHub, dev: &Dev, bytes: &[u8]| {
        dev.raw(
            hub,
            "PUT",
            &format!("/v2/files/{}", b64(&random::<16>())),
            &[],
            bytes,
        )
    };

    // 16: a file is at most 64 MiB (here 1 000 bytes), a room's files 1 GiB (here 1 500)
    put(&w.hub, &w.ada, &[1u8; 1001]).refused(413, "too-large");
    put(&w.hub, &w.ada, &[1u8; 1000]).ok();
    put(&w.hub, &w.ada, &[1u8; 501]).refused(413, "quota-exceeded");
    let exact = w.ada.raw(
        &w.hub,
        "PUT",
        &format!("/v2/files/{}", b64(&[7u8; 16])),
        &[],
        &[1u8; 500],
    );
    exact.ok();
    // file ids a room has used: 3, zero-byte files and deleted ones count
    put(&w.hub, &w.ada, &[]).ok();
    put(&w.hub, &w.ada, &[]).refused(413, "quota-exceeded");
    w.ada
        .call(
            &w.hub,
            "DELETE",
            &format!("/v2/files/{}", b64(&[7u8; 16])),
            &Value::Null,
        )
        .ok();
    put(&w.hub, &w.ada, &[]).refused(413, "quota-exceeded");

    // register ids of a room: 2. A third id is refused and takes no number; the two it has stay writable
    let (r1, r2) = (random::<16>(), random::<16>());
    w.ada.send(&w.hub, &room, &register(&r1, "a")).ok();
    w.ada.send(&w.hub, &room, &register(&r2, "b")).ok();
    w.ada
        .send(&w.hub, &room, &register(&random(), "c"))
        .refused(429, "too-many");
    assert_eq!(w.ada.chain(&room).0, 2);
    w.ada.send(&w.hub, &room, &register(&r1, "again")).ok();

    // void records of a room: 1. The second refusal comes without one and its number is not used
    let forbidden = chat(
        &random(),
        ZERO32,
        "a Chat does not belong in the room group",
    );
    assert_eq!(
        w.ada
            .send(&w.hub, &room, &forbidden)
            .refused(403, "forbidden")["voided"],
        true
    );
    assert_eq!(w.ada.chain(&room).0, 4);
    let second = w
        .ada
        .send(&w.hub, &room, &forbidden)
        .refused(403, "forbidden");
    assert!(second.get("voided").is_none());
    assert_eq!(w.ada.chain(&room).0, 4);

    // 16: 2^24 accepted envelopes per group and epoch (here 6: three are in, a void record is none): three
    // more, then `epoch-full` until an update
    w.ada.send(&w.hub, &room, &register(&r1, "4")).ok();
    w.ada.send(&w.hub, &room, &register(&r1, "5")).ok();
    w.ada.send(&w.hub, &room, &register(&r1, "6")).ok();
    let full = w.ada.send(&w.hub, &room, &register(&r1, "7"));
    assert_eq!(full.code(), "epoch-full");
    let now = w.ada.room_now();
    let out = w.ada.commit(&room, &Change::default(), now);
    let sealed = w.ada.sealed_key(
        &room,
        out.epoch + 1,
        &out.group_info,
        out.epoch,
        &w.recovery.hpke_public,
        true,
    );
    w.ada.post_commit(&w.hub, &out, &sealed).ok();
    w.ada
        .send(&w.hub, &room, &register(&r1, "after the update"))
        .ok();

    // groups of a room, archived ones too: 3 (the room group, a main session, one helper session)
    let mut agent = w.enrol_agent();
    let (session, main) = w.found_main(&mut [], Some(&mut agent));
    let helper = Dev::new();
    let (group, reply, _) = w.found_helper(&mut agent, &session, &[w.ada.id()], &[&helper]);
    reply.ok();
    w.found_helper(&mut agent, &session, &[w.ada.id()], &[])
        .1
        .refused(429, "too-many");
    // helper devices a room has ever seen: 1
    let now = w.ada.room_now();
    let out = agent.commit(
        &group,
        &Change {
            adds: vec![Dev::new().key_package(false)],
            ..Default::default()
        },
        now,
    );
    let key = agent.sealed_key(
        &group,
        out.epoch + 1,
        &out.group_info,
        now.0,
        &w.recovery.hpke_public,
        false,
    );
    agent
        .post_commit(&w.hub, &out, &key)
        .refused(429, "too-many");

    let _ = main;
}

#[test]
fn sizes() {
    let mut w = world(&[("HUB_LIMIT_JSON", "200000")]);
    let hub = &w.hub;
    let room = w.room;
    let with_payload = |n: usize| Item {
        payload: vec![b'x'; n],
        ..register(&random(), "")
    };
    // 9.3.5: a register pads to 8 KiB at most: 8 192 is taken, 16 384 is a `too-large` void
    // (a Body is its version, an empty bind, and the payload with a two-byte length: four bytes around it)
    w.ada.send(hub, &room, &with_payload(8192 - 4)).ok();
    assert_eq!(
        w.ada
            .send(hub, &room, &with_payload(8192 - 3))
            .refused(413, "too-large")["voided"],
        true
    );
    // 16: a padded body is at most 64 KiB: 65 536 is taken, the next size is no envelope (`bad-format`, no number)
    let board = |n: usize| Item {
        payload: vec![b'x'; n],
        ..board_item(&random())
    };
    w.ada.send(hub, &room, &board(65536 - 6)).ok();
    let before = w.ada.chain(&room).0;
    w.ada
        .send(hub, &room, &board(65536 - 5))
        .refused(400, "bad-format");
    assert_eq!(w.ada.chain(&room).0, before);
    // 9: at most 255 file ids
    let files = |n: usize| Item {
        file_ids: vec![[9; 16]; n],
        ..board_item(&random())
    };
    w.ada.send(hub, &room, &files(255)).ok();
    w.ada
        .send(hub, &room, &files(256))
        .refused(400, "bad-format");
    // 16: a JSON request is at most 1 MiB (here 200 000 bytes): exactly that is read, one byte more is not
    let exactly = |n: usize| {
        let frame = r#"{"kind":"handover","pad":""}"#.len();
        w.ada.raw(
            hub,
            "POST",
            "/v2/requests",
            &[],
            format!(r#"{{"kind":"handover","pad":"{}"}}"#, "x".repeat(n - frame)).as_bytes(),
        )
    };
    exactly(200_000).ok();
    exactly(200_001).refused(413, "too-large");
}

#[test]
fn policies_set_by_configuration() {
    let founding = |hub: &TestHub, headers: &[(&'static str, String)]| {
        let mut dev = Dev::new();
        let recovery = Recovery::new();
        let room: [u8; 32] = random();
        let info = dev.create_room(&room, &recovery);
        let sealed = dev.sealed_key(&room, 0, &info, 0, &recovery.hpke_public, true);
        request(
            hub.port,
            "POST",
            "/v2/rooms",
            headers,
            json!({ "group_info": b64(&info), "sealed_key": b64(&sealed) })
                .to_string()
                .as_bytes(),
        )
    };
    // founding is open by default, limited per address (16: here 2 an hour) and by the hub's number of rooms
    let hub = TestHub::start_with(&[("HUB_LIMIT_FOUND_PER_IP_HOUR", "2")]);
    boundary(
        "foundings from one address in an hour",
        2,
        |_| founding(&hub, &[("cf-connecting-ip", "203.0.113.1".to_string())]),
        429,
        "rate-limited",
    );
    founding(&hub, &[("cf-connecting-ip", "203.0.113.2".to_string())]).ok();
    let hub = TestHub::start_with(&[("HUB_MAX_ROOMS", "2")]);
    boundary(
        "rooms of a hub",
        2,
        |_| founding(&hub, &[]),
        429,
        "too-many",
    );
    // with a word set, only who brings it founds; closed, nobody
    let hub = TestHub::start_with(&[("HUB_FOUND_TOKEN", "sesame")]);
    founding(&hub, &[]).refused(403, "forbidden");
    founding(&hub, &[("x-found-token", "open".to_string())]).refused(403, "forbidden");
    founding(&hub, &[("x-found-token", "sesame".to_string())]).ok();
    let hub = TestHub::start_with(&[("HUB_FOUNDING", "closed"), ("HUB_FOUND_TOKEN", "sesame")]);
    founding(&hub, &[("x-found-token", "sesame".to_string())]).refused(403, "forbidden");
    // a client older than the hub asks for
    let hub = TestHub::start_with(&[("HUB_MIN_CLIENT", "1.0.1")]);
    hub.get("/v2/desk").refused(426, "client-too-old");
    assert_eq!(hub.get("/healthz").status, 200);
    // the login throttle can be switched off: then only the per-address limit holds
    let hub = TestHub::start_with(&[("HUB_LOGIN_THROTTLE", "off")]);
    for _ in 0..3 {
        hub.post(
            "/v2/account/login",
            &json!({ "email": "a@example.org", "auth_key": b64(&[1u8; 32]) }),
        )
        .refused(401, "wrong-login");
    }
    // passkeys of an account: 20 (here 2)
    let w = world(&[("HUB_LIMIT_PASSKEYS", "2")]);
    w.ada.post(&w.hub, "/v2/account", &json!({ "email": "ada@example.org", "kit": { "auth_key": b64(&[2u8; 32]), "sealed_copy": b64(&[2u8; 61]) }, "password": { "auth_key": b64(&[3u8; 32]), "sealed_copy": b64(&[2u8; 61]), "kdf": { "alg": "argon2id", "v": 1, "m": 65536, "t": 3, "p": 1 } } })).ok();
    boundary(
        "passkeys of an account",
        2,
        |_| {
            let key = Authenticator::new();
            let challenge = unb64(
                w.ada
                    .post(&w.hub, "/v2/account/passkeys/challenge", &json!({}))
                    .ok()["challenge"]
                    .as_str()
                    .unwrap(),
            )
            .unwrap();
            w.ada.post(&w.hub, "/v2/account/passkeys", &json!({
                "attestation_object": b64(&key.attestation(RP, UP_UV)), "client_data_json": b64(&Authenticator::client_data("webauthn.create", &challenge, ORIGIN)),
                "sealed_copy": b64(&[2u8; 61]),
            }))
        },
        429,
        "too-many",
    );
}

#[test]
fn share_links_of_a_room() {
    let mut w = world(&[("HUB_LIMIT_SHARES_PER_ROOM", "2")]);
    let mut agent = w.enrol_agent();
    let (_, group) = w.found_main(&mut [], Some(&mut agent));
    let file: [u8; 16] = random();
    agent
        .raw(
            &w.hub,
            "PUT",
            &format!("/v2/files/{}", b64(&file)),
            &[],
            b"a page",
        )
        .ok();
    let id = enc::object_id(&group, &agent.id(), 1);
    let mut artifact = object(
        wire::KIND_VERSION,
        id,
        wire::TYPE_ARTIFACT,
        wire::STATE_OPEN,
        1,
        ZERO32,
        ZERO32,
    );
    artifact.file_ids = vec![file];
    agent.send(&w.hub, &group, &artifact).ok();
    let day = 86_400_000u64;
    let share = |expires: u64| {
        agent.post(&w.hub, "/v2/shares", &json!({ "share_id": b64(&random::<16>()), "secret_hash": b64(&Sha256::digest([1u8; 32])), "file_id": b64(&file), "expires_at": expires }))
    };
    // 11.5: a Share link expires within 180 days: exactly 180 days ahead is taken, a minute more is not
    let now = trommi_hub::util::now();
    // (the hub's clock reads a moment after this test's: "exactly 180 days from now" lies within, three seconds
    // more lies beyond)
    share(now + 180 * day + 3_000).refused(400, "bad-format");
    share(now + 180 * day).ok();
    share(now + day).ok();
    share(now + day).refused(429, "too-many");
}

/// The limits of spec/v2.md section 16 at their real values, where a test can reach them: 32 human devices, 256
/// agent devices, 32 live helper sessions, 20 passkeys, a 48 KiB message, a 64 MiB file, a Share link of 180 days.
#[test]
fn the_defaults_at_their_exact_values() {
    let mut w = world(&[]);
    let room = w.room;
    // 32 human devices: the founder and 31 more; the 33rd is refused
    for _ in 0..31 {
        w.add_human();
    }
    let one_more = Dev::new();
    let (key_package, _) = invite(&w.hub, &w.ada, &one_more, 1, ZERO16);
    let now = w.ada.room_now();
    let out = w.ada.commit(
        &room,
        &Change {
            adds: vec![key_package],
            ..Default::default()
        },
        now,
    );
    let sealed = w.ada.sealed_key(
        &room,
        out.epoch + 1,
        &out.group_info,
        out.epoch,
        &w.recovery.hpke_public,
        true,
    );
    w.ada
        .post_commit(&w.hub, &out, &sealed)
        .refused(429, "too-many");
    assert_eq!(w.ada.members(&room).len(), 32);

    // 20 passkeys of an account
    w.ada.post(&w.hub, "/v2/account", &json!({ "email": "ada@example.org", "kit": { "auth_key": b64(&[2u8; 32]), "sealed_copy": b64(&[2u8; 61]) }, "password": { "auth_key": b64(&[3u8; 32]), "sealed_copy": b64(&[2u8; 61]), "kdf": { "alg": "argon2id", "v": 1, "m": 65536, "t": 3, "p": 1 } } })).ok();
    boundary(
        "passkeys of an account",
        20,
        |_| {
            let key = Authenticator::new();
            let challenge = unb64(
                w.ada
                    .post(&w.hub, "/v2/account/passkeys/challenge", &json!({}))
                    .ok()["challenge"]
                    .as_str()
                    .unwrap(),
            )
            .unwrap();
            w.ada.post(&w.hub, "/v2/account/passkeys", &json!({
                "attestation_object": b64(&key.attestation(RP, UP_UV)), "client_data_json": b64(&Authenticator::client_data("webauthn.create", &challenge, ORIGIN)),
                "sealed_copy": b64(&[2u8; 61]),
            }))
        },
        429,
        "too-many",
    );

    // 14.3: an application message of exactly 48 KiB is taken, one byte more is not
    let limit = 48 * 1024;
    let overhead = w.ada.application_message(&room, &vec![0u8; 40_000]).len() - 40_000;
    let exact = w
        .ada
        .application_message(&room, &vec![0u8; limit - overhead]);
    let over = w
        .ada
        .application_message(&room, &vec![0u8; limit - overhead + 1]);
    assert_eq!(
        (exact.len(), over.len()),
        (limit, limit + 1),
        "the test's own messages have the sizes it means"
    );
    let post = |message: &[u8]| {
        w.ada.post(
            &w.hub,
            &format!("/v2/groups/{}/messages", b64(&room)),
            &json!({ "epoch": w.ada.epoch(&room), "message": b64(message) }),
        )
    };
    post(&exact).ok();
    post(&over).refused(413, "too-large");

    // 16: a file of exactly 64 MiB is taken, one byte more is not
    let big = vec![0x5au8; (64 << 20) + 1];
    w.ada
        .raw(
            &w.hub,
            "PUT",
            &format!("/v2/files/{}", b64(&random::<16>())),
            &[],
            &big,
        )
        .refused(413, "too-large");
    assert_eq!(
        w.ada
            .raw(
                &w.hub,
                "PUT",
                &format!("/v2/files/{}", b64(&random::<16>())),
                &[],
                &big[..64 << 20]
            )
            .ok()["size"],
        64 << 20
    );
}

#[test]
fn agent_devices_and_helper_sessions_at_their_exact_values() {
    // (the rates are lifted: this test makes in seconds what a room makes in years)
    let mut w = world(&[
        ("HUB_LIMIT_OPEN_REQUESTS_PER_IP_MINUTE", "100000"),
        ("HUB_LIMIT_HEAVY_PER_SECOND", "100000"),
        ("HUB_LIMIT_HEAVY_BURST", "100000"),
    ]);
    // 256 enrolled agent devices: the 257th is refused
    let mut agents: Vec<[u8; 32]> = vec![];
    let mut first = None;
    for i in 0..257 {
        let dev = Dev::new();
        invite(&w.hub, &w.ada, &dev, 2, ZERO16);
        let mut next = agents.clone();
        next.push(dev.id());
        let reply = w.set_agents(&next);
        if i < 256 {
            reply.ok();
            agents = next;
            if i == 0 {
                first = Some(dev);
            }
        } else {
            reply.refused(429, "too-many");
        }
    }
    // 32 live helper sessions under one main session: the 33rd is refused
    let mut agent = first.unwrap();
    agent.sign_in(&w.hub, &w.room).ok();
    agent.link(&w.hub).ok();
    agent.upload_key_packages(&w.hub, 1).ok();
    let (session, _) = w.found_main(&mut [], Some(&mut agent));
    let humans = [w.ada.id()];
    boundary(
        "live helper sessions of a main session",
        32,
        |_| w.found_helper(&mut agent, &session, &humans, &[]).1,
        429,
        "too-many",
    );
}

#[test]
fn expensive_requests_of_one_device() {
    // decision 30: ten a second, bursts of sixty (here: bursts of five)
    let w = world(&[
        ("HUB_LIMIT_HEAVY_BURST", "5"),
        ("HUB_LIMIT_HEAVY_PER_SECOND", "0.001"),
    ]);
    let room = w.room;
    let junk = json!({ "epoch": 0, "commit": b64(&[1u8; 64]), "group_info": b64(&[2u8; 64]), "sealed_key": b64(&[3u8; 64]) });
    // (founding the room and uploading KeyPackages were not this device's token's requests: the burst is whole)
    let mut taken = 0;
    loop {
        let reply = w
            .ada
            .post(&w.hub, &format!("/v2/groups/{}/commits", b64(&room)), &junk);
        if reply.status == 429 {
            assert_eq!(reply.code(), "rate-limited");
            assert!(reply.header("retry-after").is_some());
            break;
        }
        assert_eq!(reply.code(), "bad-commit");
        taken += 1;
        assert!(taken <= 5);
    }
    assert_eq!(
        taken, 4,
        "five at once, one of them was the upload of KeyPackages at the start"
    );
}
