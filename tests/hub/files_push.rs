//! Files, Share links, push, Live Activity and the agent's lease over HTTP.

mod common;

use common::*;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{BufReader, Read, Write};
use trommi_hub::util::{b64, hex, random, unb64};
use trommi_hub::wire::{self, ZERO32};

struct Scene {
    w: World,
    bea: Dev,
    agent: Dev,
    session: [u8; 16],
    group: Vec<u8>,
}

fn scene_on(hub: TestHub) -> Scene {
    let mut w = World::on(hub);
    let mut bea = w.add_human();
    let mut agent = w.enrol_agent();
    w.catch_up(&mut bea, &w.room.clone());
    let (session, group) = w.found_main(&mut [&mut bea], Some(&mut agent));
    Scene {
        w,
        bea,
        agent,
        session,
        group,
    }
}

fn upload(hub: &TestHub, dev: &Dev, file: &[u8; 16], bytes: &[u8]) -> Reply {
    dev.raw(hub, "PUT", &format!("/v2/files/{}", b64(file)), &[], bytes)
}

fn fetch(hub: &TestHub, dev: &Dev, file: &[u8; 16], range: Option<&str>) -> Reply {
    let extra: Vec<(&'static str, String)> = range
        .map(|r| ("range", r.to_string()))
        .into_iter()
        .collect();
    dev.raw(hub, "GET", &format!("/v2/files/{}", b64(file)), &extra, &[])
}

/// An Artifact's version by the agent that names files; returns its object id and hash.
fn artifact(
    s: &mut Scene,
    files: &[[u8; 16]],
    id: Option<([u8; 16], [u8; 32])>,
    state: u8,
) -> ([u8; 16], [u8; 32]) {
    let (object_id, previous) = id.unwrap_or((
        enc::object_id(&s.group, &s.agent.id(), s.agent.chain(&s.group).0 + 1),
        ZERO32,
    ));
    let mut item = object(
        wire::KIND_VERSION,
        object_id,
        wire::TYPE_ARTIFACT,
        state,
        1,
        previous,
        ZERO32,
    );
    item.file_ids = files.to_vec();
    s.agent.send(&s.w.hub, &s.group, &item).ok();
    (object_id, s.agent.chain(&s.group).1)
}

#[test]
fn a_file_is_written_once_and_read_by_those_who_may() {
    let mut s = scene_on(TestHub::start());
    let file: [u8; 16] = random();
    let bytes: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
    let stored = upload(&s.w.hub, &s.agent, &file, &bytes).ok();
    assert_eq!(
        (stored["size"].as_u64(), stored["sha256"].as_str()),
        (Some(200_000), Some(b64(&Sha256::digest(&bytes)).as_str()))
    );
    // the same bytes again are answered like the first time; other bytes under a used id are refused
    assert_eq!(upload(&s.w.hub, &s.agent, &file, &bytes).ok(), stored);
    upload(&s.w.hub, &s.agent, &file, b"other bytes").refused(409, "replay");
    upload(&s.w.hub, &s.bea, &file, &bytes).refused(409, "replay");
    // no envelope names it yet: only its uploader reads it
    assert_eq!(fetch(&s.w.hub, &s.agent, &file, None).body, bytes);
    fetch(&s.w.hub, &s.bea, &file, None).refused(404, "not-found");
    // an envelope of another device does not claim it
    let mut by_bea = chat(&s.session, s.agent.id(), "look");
    by_bea.file_ids = vec![file];
    assert_eq!(
        s.bea
            .send(&s.w.hub, &s.group, &by_bea)
            .refused(403, "forbidden")["voided"],
        true
    );

    // named by its uploader's Artifact: it belongs to that group and object
    let (object_id, v1) = artifact(&mut s, &[file], None, wire::STATE_OPEN);
    let hub = &s.w.hub;
    let whole = fetch(hub, &s.bea, &file, None);
    assert_eq!(
        (
            whole.status,
            whole.body.len(),
            whole.header("accept-ranges")
        ),
        (200, 200_000, Some("bytes"))
    );
    assert_eq!(whole.body, bytes);
    // a part of it
    let part = fetch(hub, &s.bea, &file, Some("bytes=65536-65545"));
    assert_eq!(
        (part.status, part.header("content-range"), &part.body[..]),
        (206, Some("bytes 65536-65545/200000"), &bytes[65536..65546])
    );
    assert_eq!(
        fetch(hub, &s.bea, &file, Some("bytes=-5")).body,
        &bytes[199_995..]
    );
    let bad = fetch(hub, &s.bea, &file, Some("bytes=200000-"));
    assert_eq!(
        (bad.status, bad.header("content-range")),
        (416, Some("bytes */200000"))
    );
    // an envelope of another object or group that names it is refused
    let mut elsewhere = chat(&s.session, wire::ZERO32, "mine too");
    elsewhere.file_ids = vec![file];
    assert_eq!(
        s.agent
            .send(hub, &s.group, &elsewhere)
            .refused(403, "forbidden")["voided"],
        true
    );
    // another session's agent device, a device of another room, nobody: it does not exist for them
    let mut other_agent = s.w.enrol_agent();
    let room = s.w.room;
    s.w.catch_up(&mut s.bea, &room);
    let _ = s.w.found_main(&mut [&mut s.bea], Some(&mut other_agent));
    let hub = &s.w.hub;
    fetch(hub, &other_agent, &file, None).refused(404, "not-found");
    let (_, _, mallory) = found_room(hub);
    fetch(hub, &mallory, &file, None).refused(404, "not-found");
    request(
        hub.port,
        "GET",
        &format!("/v2/files/{}", b64(&file)),
        &[],
        &[],
    )
    .refused(401, "unauthorised");
    // an id in the path is 16 bytes and nothing else
    for path in [
        "/v2/files/..%2F..%2Fhub.db",
        "/v2/files/../../hub.db",
        "/v2/files/AAAA",
        &format!("/v2/files/{}", "a".repeat(40)),
    ] {
        assert_eq!(
            s.bea.raw(hub, "GET", path, &[], &[]).status / 100,
            4,
            "{path}"
        );
    }
    // on disk: one file per id under the room's folder, named by hex
    assert!(hub
        .dir
        .join("files")
        .join(hex(&s.w.room))
        .join(hex(&file))
        .is_file());

    // a Share link for a file of an open Artifact: by the agent, for at most 180 days
    let share: [u8; 16] = random();
    let secret: [u8; 32] = random();
    let day = 86_400_000u64;
    let now = trommi_hub::util::now();
    let body = |expires: u64| json!({ "share_id": b64(&share), "secret_hash": b64(&Sha256::digest(secret)), "file_id": b64(&file), "expires_at": expires });
    s.agent
        .post(hub, "/v2/shares", &body(now + 181 * day))
        .refused(400, "bad-format");
    s.agent
        .post(hub, "/v2/shares", &body(now - 1))
        .refused(400, "bad-format");
    other_agent
        .post(hub, "/v2/shares", &body(now + day))
        .refused(404, "not-found");
    s.agent.post(hub, "/v2/shares", &body(now + 179 * day)).ok();
    // a used share id is never replaced
    let mut squat = body(now + day);
    squat["secret_hash"] = json!(b64(&[1u8; 32]));
    s.bea.post(hub, "/v2/shares", &squat).refused(409, "replay");
    // whoever presents the secret gets the bytes, without a token; a part too
    let open = |secret: Option<&[u8]>, range: Option<&str>, id: &[u8; 16]| {
        let mut headers: Vec<(&str, String)> = secret
            .map(|x| ("x-share-secret", b64(x)))
            .into_iter()
            .collect();
        if let Some(r) = range {
            headers.push(("range", r.to_string()));
        }
        request(
            hub.port,
            "GET",
            &format!("/v2/shares/{}", b64(id)),
            &headers,
            &[],
        )
    };
    let got = open(Some(&secret), None, &share);
    assert_eq!(
        (got.status, got.header("cache-control"), got.body.len()),
        (200, Some("private, no-store"), 200_000)
    );
    assert_eq!(
        open(Some(&secret), Some("bytes=0-9"), &share).body,
        &bytes[..10]
    );
    // every refusal is the same answer
    let refusals = [
        open(None, None, &share),
        open(Some(&[0u8; 32]), None, &share),
        open(Some(&secret[..31]), None, &share),
        open(Some(&secret), None, &random()),
    ];
    for r in &refusals {
        r.refused(404, "not-found");
        assert_eq!(r.body, refusals[0].body);
    }
    // revoked by a human device; registered again; closing the Artifact ends it and deletes the files at once
    other_agent
        .call(
            hub,
            "DELETE",
            &format!("/v2/shares/{}", b64(&share)),
            &Value::Null,
        )
        .refused(404, "not-found");
    s.bea
        .call(
            hub,
            "DELETE",
            &format!("/v2/shares/{}", b64(&share)),
            &Value::Null,
        )
        .ok();
    open(Some(&secret), None, &share).refused(404, "not-found");
    s.agent.post(hub, "/v2/shares", &body(now + day)).ok();
    artifact(&mut s, &[], Some((object_id, v1)), wire::STATE_CLOSED);
    let hub = &s.w.hub;
    request(
        hub.port,
        "GET",
        &format!("/v2/shares/{}", b64(&share)),
        &[("x-share-secret", b64(&secret))],
        &[],
    )
    .refused(404, "not-found");
    fetch(hub, &s.bea, &file, None).refused(404, "not-found");
    assert!(!hub
        .dir
        .join("files")
        .join(hex(&s.w.room))
        .join(hex(&file))
        .exists());
    // the id is not used again, for any bytes
    upload(hub, &s.agent, &file, &bytes).refused(410, "gone");
    // a share of a file that belongs to no open Artifact
    let loose: [u8; 16] = random();
    upload(hub, &s.agent, &loose, b"loose").ok();
    let mut loose_share = body(now + day);
    loose_share["file_id"] = json!(b64(&loose));
    loose_share["share_id"] = json!(b64(&random::<16>()));
    s.agent
        .post(hub, "/v2/shares", &loose_share)
        .refused(403, "forbidden");
    // its uploader or a human device deletes a file
    s.agent
        .call(
            hub,
            "DELETE",
            &format!("/v2/files/{}", b64(&loose)),
            &Value::Null,
        )
        .ok();
    fetch(hub, &s.agent, &loose, None).refused(404, "not-found");
}

#[test]
fn a_file_too_large_is_refused_and_the_connection_survives_the_refusal() {
    let hub = TestHub::start_with(&[("HUB_LIMIT_FILE", "1000"), ("HUB_ROOM_QUOTA", "1500")]);
    let w = World::on(hub);
    let hub = &w.hub;
    // announced too large: refused before the body is read. The client keeps sending; on the same connection it
    // must read the refusal and then the answer to its next request (the unread body is drained, not reset).
    let token = w.ada.token.clone().unwrap();
    let mut socket = std::net::TcpStream::connect(("127.0.0.1", hub.port)).unwrap();
    socket
        .set_read_timeout(Some(std::time::Duration::from_secs(10)))
        .unwrap();
    let big = vec![7u8; 300_000];
    let head = format!(
        "PUT /v2/files/{} HTTP/1.1\r\nhost: x\r\ntrommi-client: test/1.0.0\r\nauthorization: Bearer {token}\r\ncontent-length: {}\r\n\r\n",
        b64(&random::<16>()),
        big.len()
    );
    socket.write_all(head.as_bytes()).unwrap();
    socket.write_all(&big).unwrap();
    socket
        .write_all(b"GET /healthz HTTP/1.1\r\nhost: x\r\nconnection: close\r\n\r\n")
        .unwrap();
    let mut reader = BufReader::new(socket);
    let (status, headers) = read_head(&mut reader);
    assert_eq!(status, 413);
    let n: usize = headers
        .iter()
        .find(|(k, _)| k == "content-length")
        .unwrap()
        .1
        .parse()
        .unwrap();
    let mut body = vec![0; n];
    reader.read_exact(&mut body).unwrap();
    assert!(String::from_utf8_lossy(&body).contains("too-large"));
    let (status, _) = read_head(&mut reader);
    assert_eq!(
        status, 200,
        "the next request on the same connection is answered"
    );

    // the room's quota: what fits is taken, the next one is refused with the numbers
    upload(hub, &w.ada, &random(), &[1u8; 900]).ok();
    let over = upload(hub, &w.ada, &random(), &[1u8; 900]).refused(413, "quota-exceeded");
    assert_eq!(
        (over["used"].as_u64(), over["quota"].as_u64()),
        (Some(900), Some(1500))
    );
    // a JSON body over its limit, on any route
    let huge = json!({ "envelope": "A".repeat(1_100_000) });
    w.ada
        .post(hub, "/v2/envelopes", &huge)
        .refused(413, "too-large");
    hub.post("/v2/rooms", &json!([1, 2]))
        .refused(400, "bad-format");
    assert_eq!(hub.get("/v1/rooms").status, 404);
    assert_eq!(hub.get("/healthz").ok()["protocol_version"], 2);
}

fn web_subscription(n: u8) -> Value {
    let key = p256::SecretKey::random(&mut p256::elliptic_curve::rand_core::OsRng);
    let point =
        p256::elliptic_curve::sec1::ToEncodedPoint::to_encoded_point(&key.public_key(), false);
    json!({ "endpoint": format!("http://127.0.0.1:9/push/{n}"), "keys": { "p256dh": b64(point.as_bytes()), "auth": b64(&[n; 16]) } })
}

fn card(s: &mut Scene, urgency: u8, flags: u8) -> [u8; 32] {
    let id = enc::object_id(&s.group, &s.agent.id(), s.agent.chain(&s.group).0 + 1);
    let mut item = object(
        wire::KIND_VERSION,
        id,
        wire::TYPE_CARD,
        wire::STATE_OPEN,
        urgency,
        ZERO32,
        ZERO32,
    );
    item.flags = flags;
    s.agent.send(&s.w.hub, &s.group, &item).ok();
    s.agent.chain(&s.group).1
}

#[test]
fn the_push_flag_makes_one_content_free_push_per_human_device_that_wants_it() {
    let mut s = scene_on(TestHub::start());
    let hub = &s.w.hub;
    // only known push services are called; only human devices register
    s.w.ada.post(hub, "/v2/push", &json!({ "web_push": { "endpoint": "https://evil.example/x", "keys": web_subscription(1)["keys"] }, "level": "all" })).refused(400, "bad-format");
    s.agent
        .post(
            hub,
            "/v2/push",
            &json!({ "web_push": web_subscription(9), "level": "all" }),
        )
        .refused(403, "forbidden");
    s.w.ada
        .post(
            hub,
            "/v2/push",
            &json!({ "web_push": web_subscription(1), "level": "all" }),
        )
        .ok();
    s.bea
        .post(
            hub,
            "/v2/push",
            &json!({ "web_push": web_subscription(2), "level": "knocking" }),
        )
        .ok();
    let listed = s.w.ada.get(hub, "/v2/push").ok();
    assert_eq!(listed["subscriptions"].as_array().unwrap().len(), 1);
    assert_eq!(
        unb64(listed["vapid_public_key"].as_str().unwrap())
            .unwrap()
            .len(),
        65
    );

    // without the flag: nothing. With it, urgency normal: the device that takes all, not the one that takes knocking
    card(&mut s, 1, 0);
    card(&mut s, 1, wire::FLAG_PUSH);
    let hub = &s.w.hub;
    hub.eventually("the push to ada", || hub.pushes().len() == 1);
    let push = &hub.pushes()[0];
    assert_eq!(push.url, "http://127.0.0.1:9/push/1");
    let header = |name: &str| {
        push.headers
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.clone())
            .unwrap()
    };
    assert_eq!(
        (
            header("content-encoding").as_str(),
            header("urgency").as_str()
        ),
        ("aes128gcm", "normal")
    );
    assert!(header("authorization").starts_with("vapid t="));
    // the body is ciphertext for the browser: neither room nor anything else in clear
    assert!(!String::from_utf8_lossy(&push.body).contains("room_id"));
    // urgency high: both
    card(&mut s, 2, wire::FLAG_PUSH);
    let hub = &s.w.hub;
    hub.eventually("the pushes for the urgent card", || hub.pushes().len() == 3);
    // the flag is honoured on card versions and permission requests of the agent only: not on a Chat message,
    // not on a human device's envelope
    let mut message = chat(&s.session, ZERO32, "pushy");
    message.flags = wire::FLAG_PUSH;
    s.agent.send(hub, &s.group, &message).ok();
    let mut from_human = chat(&s.session, s.agent.id(), "pushy");
    from_human.flags = wire::FLAG_PUSH;
    s.w.ada.send(hub, &s.group, &from_human).ok();
    let request_id = enc::object_id(&s.group, &s.agent.id(), s.agent.chain(&s.group).0 + 1);
    let mut permission = object(
        wire::KIND_REQUEST,
        request_id,
        wire::TYPE_REQUEST,
        wire::STATE_OPEN,
        3,
        ZERO32,
        ZERO32,
    );
    permission.flags = wire::FLAG_PUSH;
    s.agent.send(hub, &s.group, &permission).ok();
    hub.eventually("the pushes for the permission request", || {
        hub.pushes().len() == 5
    });
    std::thread::sleep(std::time::Duration::from_millis(150));
    assert_eq!(hub.pushes().len(), 5);

    // a push service that says the subscription is gone: the registration is deleted
    hub.recorder
        .answers
        .lock()
        .unwrap()
        .push(("/push/2".to_string(), 410, String::new()));
    card(&mut s, 3, wire::FLAG_PUSH);
    let hub = &s.w.hub;
    hub.eventually("bea's registration is gone", || {
        s.bea.get(hub, "/v2/push").ok()["subscriptions"] == json!([])
    });
    // a device removes its own registrations
    assert_eq!(
        s.w.ada.call(hub, "DELETE", "/v2/push", &json!({})).ok()["deleted"],
        1
    );
}

fn apns_env() -> Vec<(&'static str, String)> {
    use p256::pkcs8::EncodePrivateKey;
    let key = p256::SecretKey::random(&mut p256::elliptic_curve::rand_core::OsRng);
    vec![
        (
            "APNS_KEY",
            key.to_pkcs8_pem(Default::default()).unwrap().to_string(),
        ),
        ("APNS_KEY_ID", "KEYID12345".to_string()),
        ("APNS_TEAM_ID", "TEAMID1234".to_string()),
        ("APNS_TOPIC", "com.trommi.app".to_string()),
        ("HUB_LIVE_MS", "30".to_string()),
    ]
}

#[test]
fn an_iphone_gets_a_sealed_number_and_a_ticket_for_that_one_envelope() {
    let env = apns_env();
    let env: Vec<(&str, &str)> = env.iter().map(|(k, v)| (*k, v.as_str())).collect();
    let mut s = scene_on(TestHub::start_with(&env));
    let hub = &s.w.hub;
    let phone_key: [u8; 32] = random();
    let token = "ab".repeat(32);
    let registration = |token: &str, topic: &str| json!({ "apns": { "token": token, "key": b64(&phone_key), "environment": "production", "topic": topic }, "level": "all" });
    s.w.ada
        .post(hub, "/v2/push", &registration(&token, "com.other.app"))
        .refused(400, "bad-format");
    s.w.ada
        .post(hub, "/v2/push", &registration("not hex", "com.trommi.app"))
        .refused(400, "bad-format");
    s.w.ada
        .post(hub, "/v2/push", &registration(&token, "com.trommi.app"))
        .ok();
    let hash = card(&mut s, 2, wire::FLAG_PUSH);
    let hub = &s.w.hub;
    hub.eventually("the push to the phone", || {
        hub.pushes().iter().any(|p| p.url.contains("/3/device/"))
    });
    let push = hub
        .pushes()
        .into_iter()
        .find(|p| p.url.contains("/3/device/"))
        .unwrap();
    assert_eq!(
        push.url,
        format!("https://api.push.apple.com/3/device/{token}")
    );
    let payload: Value = serde_json::from_slice(&push.body).unwrap();
    // Apple sees a fixed text; the number is sealed under the key the phone registered
    assert_eq!(payload["aps"]["alert"]["body"], "Urgent: a new question.");
    let opened: Value = serde_json::from_slice(
        &trommi_hub::push::open_on_phone(
            &phone_key,
            &unb64(payload["e"].as_str().unwrap()).unwrap(),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        (opened["room_id"].as_str(), opened["urgency"].as_u64()),
        (Some(b64(&s.w.room).as_str()), Some(2))
    );
    // with the ticket the notification extension fetches that one envelope, without a token
    let ticket = opened["ticket"].as_str().unwrap();
    let fetched = hub.get(&format!("/v2/push-envelope?ticket={ticket}")).ok();
    assert_eq!(fetched["change"], opened["change"]);
    assert_eq!(
        wire::Envelope::parse(&unb64(fetched["envelope"].as_str().unwrap()).unwrap())
            .unwrap()
            .hash(),
        hash
    );
    // a ticket that was changed, or none
    let mut forged = unb64(ticket).unwrap();
    forged[70] ^= 1;
    hub.get(&format!("/v2/push-envelope?ticket={}", b64(&forged)))
        .refused(401, "unauthorised");
    hub.get("/v2/push-envelope").refused(401, "unauthorised");

    // Live Activity: two counts and a tag. Work begins: start; a count changes: update
    let start_token = "cd".repeat(32);
    s.w.ada.post(hub, "/v2/live-activity", &json!({ "kind": "start", "token": start_token, "tag": "tag-1", "environment": "production", "topic": "com.trommi.app" })).ok();
    s.w.ada.post(hub, "/v2/live-activity", &json!({ "kind": "activity", "token": "ef".repeat(32), "tag": "tag-1", "environment": "production", "topic": "com.trommi.app" })).ok();
    s.agent.post(hub, "/v2/link", &json!({ "process": b64(&random::<16>()), "generation": s.agent.lease, "hears": true, "working": true, "last_call_at": 1 })).refused(409, "lease-lost");
    let live = |hub: &TestHub, token: &str| -> Vec<Value> {
        hub.pushes()
            .iter()
            .filter(|p| p.url.ends_with(token))
            .map(|p| serde_json::from_slice::<Value>(&p.body).unwrap()["aps"].clone())
            .collect()
    };
    // the agent reports that it works (a new process takes the lease)
    let lease = s.agent.post(hub, "/v2/link", &json!({ "process": b64(&random::<16>()), "hears": true, "working": true, "last_call_at": 1 })).ok();
    s.agent.lease = lease["generation"].as_u64();
    hub.eventually("the start of the Live Activity", || {
        !live(hub, &start_token).is_empty()
    });
    let started = &live(hub, &start_token)[0];
    assert_eq!(
        (
            started["event"].as_str(),
            started["content-state"]["working"].as_u64(),
            started["content-state"]["waiting"].as_u64()
        ),
        (Some("start"), Some(1), Some(1))
    );
    assert_eq!(started["attributes"], json!({ "tag": "tag-1" }));
    card(&mut s, 1, 0);
    let hub = &s.w.hub;
    hub.eventually("the update of the Live Activity", || {
        live(hub, &"ef".repeat(32))
            .iter()
            .any(|a| a["event"] == "update" && a["content-state"]["waiting"] == 2)
    });
}

#[test]
fn of_two_processes_on_one_agent_device_the_later_wins() {
    let mut s = scene_on(TestHub::start());
    let hub = &s.w.hub;
    let first = s.agent.lease.unwrap();
    // a human device holds no lease
    s.w.ada
        .post(hub, "/v2/link", &json!({ "process": b64(&random::<16>()) }))
        .refused(403, "forbidden");
    s.agent
        .send(
            hub,
            &s.group,
            &chat(&s.session, ZERO32, "from the first process"),
        )
        .ok();
    // the human devices hear the agent's link report
    let mut events = s.w.ada.events(hub, None);
    // a second process on the same state acquires the lease: one generation above
    let second = s.agent.post(hub, "/v2/link", &json!({ "process": b64(&random::<16>()), "hears": true, "working": true, "last_call_at": 5 })).ok();
    assert_eq!(second["generation"].as_u64(), Some(first + 1));
    let report = loop {
        let e = events.until("presence");
        if e.data["device"] == b64(&s.agent.id()) && e.data["working"].is_boolean() {
            break e;
        }
    };
    assert_eq!(report.data["working"], true);
    // the first process: its writes and its renewal are refused, and it took no number
    s.agent
        .send(
            hub,
            &s.group,
            &chat(&s.session, ZERO32, "from the first process"),
        )
        .refused(409, "lease-lost");
    assert_eq!(s.agent.chain(&s.group).0, 1);
    s.agent
        .post(
            hub,
            "/v2/link",
            &json!({ "process": b64(&random::<16>()), "generation": first }),
        )
        .refused(409, "lease-lost");
    s.agent
        .post_message(hub, &s.group, b"step", false)
        .refused(409, "lease-lost");
    upload(hub, &s.agent, &random(), b"x").refused(409, "lease-lost");
    // without the header at all
    s.agent.lease = None;
    s.agent
        .send(hub, &s.group, &chat(&s.session, ZERO32, "no lease"))
        .refused(409, "lease-lost");
    // the second process goes on, and renews under its own generation, which stays
    s.agent.lease = Some(first + 1);
    s.agent
        .send(
            hub,
            &s.group,
            &chat(&s.session, ZERO32, "from the second process"),
        )
        .ok();
}
