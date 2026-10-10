//! Every limit at its exact value: the last one that is taken and the first one that is refused, with its code.
//! Limits of spec/v1.md section 16 and of spec/hub-api.md ("Decided for the first hub"); where a limit is large,
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

/// An agent device's processes overlap while one restarts: only the lease holder's stream replaces the others;
/// a stale holder is told `lease-lost` and cuts nothing; a stream without `Trommi-Lease` takes its place beside.
#[test]
fn only_the_lease_holder_replaces_an_agent_devices_stream() {
    let mut w = world(&[]);
    let mut agent = w.enrol_agent();
    let hub = &w.hub;
    let old_generation = agent.lease;
    let mut first = agent.events(hub, None);
    assert_eq!(first.status, 200);
    // a new process takes the lease and opens its stream: the old process's stream ends
    agent.link(hub).ok();
    let mut second = agent.events(hub, None);
    assert_eq!(second.status, 200);
    assert!(first.ended(), "the old process's stream was ended");
    // the old process, which no longer holds the lease, opens again: refused, and nothing is cut
    agent.lease = old_generation;
    assert_eq!(agent.events(hub, None).status, 409);
    // a client that sends no lease: taken beside the holder's stream
    agent.lease = None;
    assert_eq!(agent.events(hub, None).status, 200);
    assert!(!second.ended(), "the holder's stream stays open");
}

#[test]
fn counts_per_device() {
    let mut w = world(&[]);
    let hub = &w.hub;
    // 16: streams per device 8. A new stream ends the device's older ones, so a client that never closes its
    // old stream (a page reloaded under a service worker) is not locked out: ten in a row are all taken, the
    // newest alone stays open
    let mut streams = vec![];
    for i in 0..10 {
        let s = w.ada.events(hub, None);
        assert_eq!(s.status, 200, "stream {}", i + 1);
        streams.push(s);
    }
    w.ada.send(hub, &w.room, &register(&random(), "x")).ok();
    assert_eq!(streams[9].until("envelope").name, "envelope");
    assert!(streams[0].ended(), "the oldest stream was ended");
    assert!(streams[8].ended(), "the one before the newest was ended");
    drop(streams);
    // 16: KeyPackages per device 100 single-use (five are there from the start)
    let more: Vec<String> = (0..95).map(|_| b64(&w.ada.key_package(false))).collect();
    assert_eq!(
        w.ada
            .put(hub, "/v2/key-packages", &json!({ "single_use": more }))
            .ok()["unused"],
        100
    );
    // one more: the oldest goes, a hundred stay (a device that signs in again brings a fresh set)
    assert_eq!(
        w.ada
            .put(
                hub,
                "/v2/key-packages",
                &json!({ "single_use": [b64(&w.ada.key_package(false))] })
            )
            .ok()["unused"],
        100
    );
    // a refusal that names a wait names it in the header and in the body
    let slowed = TestHub::start_with(&[("HUB_LIMIT_OPEN_REQUESTS_PER_IP_MINUTE", "1")]);
    slowed
        .post("/v2/account/passkey/challenge", &json!({}))
        .ok();
    let told = slowed.post("/v2/account/passkey/challenge", &json!({}));
    told.refused(429, "rate-limited");
    assert_eq!(
        told.header("retry-after").map(str::to_string),
        told.json()["retry_after"].as_u64().map(|s| s.to_string())
    );
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
            w.ada.post(hub, "/v2/invites", &json!({ "offer": b64(&offer), "signature": b64(&w.ada.sign("TrommiInviteOffer", &offer)), "mac": b64(&[9u8; 32]) }))
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
    // 16: human devices in a room 1000, enrolled agent devices 256: here with 2 and 1
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
    // 16: a padded body is at most 64 KiB: 65 536 is taken, the next size is a `too-large` void (9.0.5)
    let board = |n: usize| Item {
        payload: vec![b'x'; n],
        ..board_item(&random())
    };
    w.ada.send(hub, &room, &board(65536 - 6)).ok();
    assert_eq!(
        w.ada
            .send(hub, &room, &board(65536 - 5))
            .refused(413, "too-large")["voided"],
        true
    );
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
    // HSTS with preload is prepared behind one switch, and off unless it is thrown
    let plain = TestHub::start();
    assert_eq!(
        plain.get("/healthz").header("strict-transport-security"),
        None
    );
    let strict = TestHub::start_with(&[("HUB_HSTS", "on")]);
    for path in ["/healthz", "/v2/desk"] {
        assert_eq!(
            strict.get(path).header("strict-transport-security"),
            Some("max-age=63072000; includeSubDomains; preload")
        );
    }
    // the health route names the running version
    assert_eq!(plain.get("/healthz").ok()["commit"], "dev");
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

/// The limits of spec/v1.md section 16 at their real values, where a test can reach them: 256 agent devices, 32
/// live helper sessions, 20 passkeys, a 48 KiB message, a 64 MiB file, a Share link of 180 days.
#[test]
fn the_defaults_at_their_exact_values() {
    let mut w = world(&[]);
    let room = w.room;
    // (1000 human devices: `a_room_of_a_thousand_human_devices`)

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

    // 11.1, 16: a file has at most 64 MiB of plaintext: stored (its head and one tag per chunk), 67 125 269
    // bytes. Exactly that is taken, one byte more is not.
    const STORED: usize = 67_125_269;
    let big = vec![0x5au8; STORED + 1];
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
                &big[..STORED]
            )
            .ok()["size"],
        STORED
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

/// 16: a room holds 1000 human devices (the default of `HUB_LIMIT_HUMANS`), added one by one as invites bring
/// them; a Commit of the room group at that size and the founding of a main session that adds all of them in one
/// request (a JSON body above 1 MiB, within 1.5 MiB) are taken; the 1001st human leaf is `too-many`. What it
/// weighs and what verifying a Commit at 1000 leaves costs is printed (`--nocapture`).
#[test]
fn a_room_of_a_thousand_human_devices() {
    use std::time::Instant;
    use trommi_hub::observer::{MlsObserver, Observer};
    let mut w = world(&[
        ("HUB_LIMIT_OPEN_INVITES", "1000"),
        ("HUB_LIMIT_OPEN_REQUESTS_PER_IP_MINUTE", "100000000"),
    ]);
    let room = w.room;
    let mut agent = w.enrol_agent();
    let started = Instant::now();
    let mut humans = vec![];
    let add = |w: &mut World| -> (Dev, Out, Reply) {
        let dev = Dev::new();
        let (key_package, _) = invite(&w.hub, &w.ada, &dev, 1, ZERO16);
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
        let reply = w.ada.post_commit(&w.hub, &out, &sealed);
        (dev, out, reply)
    };
    let mut last = None;
    for _ in 1..1000 {
        let (dev, out, reply) = add(&mut w);
        reply.ok();
        humans.push(dev);
        last = Some(out);
    }
    let last = last.unwrap();
    assert_eq!(w.ada.members(&room).len(), 1000);
    println!(
        "999 human devices added one by one in {:.1} s; the last Add: Commit {} B, GroupInfo {} B, Welcome {} B",
        started.elapsed().as_secs_f64(),
        last.commit.len(),
        last.group_info.len(),
        last.welcome.as_ref().map_or(0, Vec::len)
    );

    // the 1001st human leaf
    let (_, _, refused) = add(&mut w);
    refused.refused(429, "too-many");
    assert_eq!(w.ada.members(&room).len(), 1000);

    // an own-leaf update (a Commit with a path) at 1000 leaves: verified on the public state as the pool does it
    let now = w.ada.room_now();
    let update = w.ada.commit(&room, &Change::default(), now);
    let obs = MlsObserver::default();
    let t = Instant::now();
    let (state, before, _) = obs.open(&last.group_info).unwrap();
    let open = t.elapsed();
    assert_eq!(before.leaves.len(), 1000);
    let t = Instant::now();
    let (_, facts) = obs.commit(&state, &update.commit).unwrap();
    let verify = t.elapsed();
    let t = Instant::now();
    obs.check_group_info(&update.group_info, &facts.after, &w.ada.id())
        .unwrap();
    let check = t.elapsed();
    let sealed = w.ada.sealed_key(
        &room,
        update.epoch + 1,
        &update.group_info,
        update.epoch,
        &w.recovery.hpke_public,
        true,
    );
    let t = Instant::now();
    w.ada.post_commit(&w.hub, &update, &sealed).ok();
    let posted = t.elapsed();
    println!(
        "at 1000 leaves: public state {} B; opening a GroupInfo {} ms; an update Commit of {} B verified in {} ms, its \
         GroupInfo ({} B) checked in {} ms; the whole request {} ms",
        state.0.len(),
        open.as_millis(),
        update.commit.len(),
        verify.as_millis(),
        update.group_info.len(),
        check.as_millis(),
        posted.as_millis()
    );

    // the founding of a main session with every human device and the agent device: one claim, one request
    for dev in &mut humans {
        dev.sign_in(&w.hub, &room).ok();
        dev.upload_key_packages(&w.hub, 1).ok();
    }
    let mut named: Vec<[u8; 32]> = humans.iter().map(Dev::id).collect();
    named.push(agent.id());
    let t = Instant::now();
    let adds = w.claim(&w.ada, &named);
    let claimed = t.elapsed();
    let session: [u8; 16] = random();
    let (group, info0) = w.ada.create_session(&session, &ZERO16);
    let now = w.ada.room_now();
    let key0 = w
        .ada
        .sealed_key(&group, 0, &info0, now.0, &w.recovery.hpke_public, true);
    let out = w.ada.commit(
        &group,
        &Change {
            adds,
            ..Default::default()
        },
        now,
    );
    let key1 = w.ada.sealed_key(
        &group,
        1,
        &out.group_info,
        now.0,
        &w.recovery.hpke_public,
        true,
    );
    let body = founding_json(&info0, &key0, &out, &key1);
    let json_bytes = body.to_string().len();
    let parts = info0.len()
        + out.commit.len()
        + out.group_info.len()
        + out.welcome.as_ref().map_or(0, Vec::len);
    assert!(
        json_bytes > 1 << 20 && json_bytes <= 3 << 19,
        "{json_bytes}"
    );
    assert!(parts <= 1 << 20, "{parts}");
    let t = Instant::now();
    w.ada.post(&w.hub, "/v2/groups", &body).ok();
    println!(
        "founding at 1000 human devices + 1 agent device: claim of {} KeyPackages {} ms; Commit {} B, GroupInfo {} B, \
         Welcome {} B, {} B of the 1 MiB, {} B as JSON; taken in {} ms",
        named.len(),
        claimed.as_millis(),
        out.commit.len(),
        out.group_info.len(),
        out.welcome.as_ref().map_or(0, Vec::len),
        parts,
        json_bytes,
        t.elapsed().as_millis()
    );
    w.ada.merge(&group);
    // the Welcome is stored once, not once for each of the 1000 devices it adds
    let stored: i64 = {
        let db = rusqlite::Connection::open(w.hub.dir.join("hub.db")).unwrap();
        db.busy_timeout(std::time::Duration::from_secs(5)).unwrap();
        db.query_row(
            "SELECT (SELECT coalesce(sum(length(bytes)), 0) FROM welcomes WHERE group_id = ?1)
                  + (SELECT coalesce(sum(length(bytes)), 0) FROM welcome_bytes WHERE group_id = ?1)",
            [&group[..]],
            |r| r.get(0),
        )
        .unwrap()
    };
    println!("Welcome bytes stored for the founding: {stored}");
    assert_eq!(stored as usize, out.welcome.as_ref().unwrap().len());
    let listed = w
        .ada
        .get(&w.hub, &format!("/v2/rooms/{}/groups", b64(&room)))
        .ok();
    assert!(listed
        .as_array()
        .unwrap()
        .iter()
        .any(|g| g["group_id"] == b64(&group) && g["leaves"].as_array().unwrap().len() == 1001));
    let _ = &mut agent;
}

/// One claim names at most 1024 devices (every leaf a group can have): 1024 are read (here devices without
/// KeyPackages: `not-found`), 1025 are not (`bad-format`).
#[test]
fn a_claim_names_at_most_1024_devices() {
    let w = world(&[]);
    let ids = |n: usize| -> Vec<String> { (0..n).map(|_| b64(&random::<32>())).collect() };
    w.ada
        .post(
            &w.hub,
            "/v2/key-packages/claim",
            &json!({ "devices": ids(1024) }),
        )
        .refused(404, "not-found");
    w.ada
        .post(
            &w.hub,
            "/v2/key-packages/claim",
            &json!({ "devices": ids(1025) }),
        )
        .refused(400, "bad-format");
}

/// A page of the list of groups in a room of thousands of groups the asker may not see: read by the index of
/// founding, not by sorting the room again for every step.
#[test]
fn a_page_of_groups_among_thousands_hidden() {
    let mut w = world(&[]);
    let agent = w.enrol_agent();
    let room = w.room;
    {
        let db = rusqlite::Connection::open(w.hub.dir.join("hub.db")).unwrap();
        db.busy_timeout(std::time::Duration::from_secs(5)).unwrap();
        db.execute_batch("BEGIN").unwrap();
        for i in 0..5000u32 {
            let mut session = [0u8; 16];
            session[..4].copy_from_slice(&i.to_be_bytes());
            db.execute(
                "INSERT INTO groups (group_id, room_id, kind, session_id, founder, epoch, room_epoch, epoch_at, live, founded_change, state)
                 VALUES (?1, ?2, 'main', ?3, ?4, 1, 0, 0, 0, ?5, x'00')",
                rusqlite::params![[&room[..], &session[..]].concat(), &room[..], &session[..], &w.ada.id()[..], 1_000_000 + i as i64],
            )
            .unwrap();
        }
        db.execute_batch("COMMIT").unwrap();
    }
    let path = format!("/v2/rooms/{}/groups", b64(&room));
    let t = std::time::Instant::now();
    let first = agent.get(&w.hub, &format!("{path}?limit=1")).ok();
    assert_eq!(first["items"].as_array().unwrap().len(), 1);
    assert_eq!(first["items"][0]["kind"], "room");
    let after = first["after"].as_i64().unwrap();
    let rest = agent
        .get(&w.hub, &format!("{path}?after={after}&limit=1"))
        .ok();
    assert_eq!(rest["items"], json!([]));
    assert_eq!(rest["more"], false);
    let took = t.elapsed();
    assert!(took < std::time::Duration::from_secs(2), "{took:?}");
    // a human device sees them all, page by page
    let page = w.ada.get(&w.hub, &format!("{path}?limit=1000")).ok();
    assert_eq!(page["items"].as_array().unwrap().len(), 1000);
    assert_eq!(page["more"], true);
}
