//! The periodic jobs as production wires them (`server::spawn_jobs`), on short intervals, with the hub's clock
//! moved instead of waiting: nothing here calls a job by hand. One test: the clock belongs to the whole process.

mod common;

use common::*;
use serde_json::{json, Value};
use trommi_hub::util::{b64, hex, random, unb64};
use trommi_hub::wire::{self, Envelope, ZERO32};

const MINUTE: i64 = 60_000;
const DAY: i64 = 86_400_000;

fn apns_key() -> String {
    use p256::pkcs8::EncodePrivateKey;
    p256::SecretKey::random(&mut p256::elliptic_curve::rand_core::OsRng)
        .to_pkcs8_pem(Default::default())
        .unwrap()
        .to_string()
}

#[test]
fn the_timers_do_their_work() {
    let key = apns_key();
    let hub = TestHub::start_with(&[
        ("TEST_JOBS", "1"),
        ("HUB_SWEEP_EVERY_MS", "60"),
        ("HUB_RETENTION_EVERY_MS", "60"),
        ("HUB_LEASE_WATCH_MS", "40"),
        ("HUB_PING_MS", "50"),
        ("HUB_LIVE_MS", "20"),
        ("HUB_LIVE_BEAT_MS", "600000"),
        ("APPLE_APNS_KEY", &key),
        ("APPLE_APNS_KEY_ID", "KEYID12345"),
        ("APPLE_TEAM_ID", "TEAMID1234"),
        ("APPLE_APNS_TOPIC", "com.trommi.app"),
    ]);
    let mut w = World::on(hub);
    let room = w.room;
    let mut agent = w.enrol_agent();
    let (session, group) = w.found_main(&mut [], Some(&mut agent));
    let hub = &w.hub;
    let again = |devs: &mut [&mut Dev]| {
        for d in devs.iter_mut() {
            d.sign_in(hub, &room).ok();
        }
    };
    let live = |token: &str| -> Vec<Value> {
        hub.pushes()
            .iter()
            .filter(|p| p.url.ends_with(token))
            .map(|p| serde_json::from_slice::<Value>(&p.body).unwrap()["aps"].clone())
            .collect()
    };
    let alerts = || -> Vec<String> {
        hub.pushes()
            .iter()
            .filter_map(|p| serde_json::from_slice::<Value>(&p.body).ok())
            .filter_map(|v| v["aps"]["alert"]["body"].as_str().map(str::to_string))
            .filter(|text| text.contains("lost"))
            .collect()
    };

    // the phone: a push registration and the two Live Activity tokens
    let (phone, start, activity) = ("ab".repeat(32), "cd".repeat(32), "ef".repeat(32));
    w.ada.post(hub, "/v1/push", &json!({ "apns": { "token": phone, "key": b64(&[5u8; 32]), "environment": "production", "topic": "com.trommi.app" }, "level": "knocking" })).ok();
    for (kind, token) in [("start", &start), ("activity", &activity)] {
        w.ada.post(hub, "/v1/live-activity", &json!({ "kind": kind, "token": token, "tag": "tag-1", "environment": "production", "topic": "com.trommi.app" })).ok();
    }

    // ---- the lease: the agent works; the Live Activity starts
    agent.post(hub, "/v1/link", &json!({ "process": b64(&random::<16>()), "hears": true, "working": true, "last_call_at": 1 })).ok();
    hub.eventually("the Live Activity starts", || {
        live(&start)
            .iter()
            .any(|a| a["event"] == "start" && a["content-state"]["working"] == 1)
    });
    // an open stream of the human device: it will see the agent's loss
    let mut events = w.ada.events(hub, None);
    // the agent's process dies: no renewal, no closed stream to tell. A minute later the lease has run out and
    // the timer ends the Live Activity
    hub.clock(MINUTE + 1000);
    hub.eventually("the Live Activity ends when the lease ran out", || {
        live(&activity)
            .iter()
            .any(|a| a["event"] == "end" && a["content-state"]["working"] == 0)
    });
    assert!(
        alerts().is_empty(),
        "not lost yet: the agent may come back within a minute"
    );
    // another minute without it: the human devices are told, once
    hub.clock(MINUTE);
    hub.eventually("the agent is reported lost", || alerts().len() == 1);
    assert_eq!(alerts()[0], "An agent lost its connection.");
    let lost = loop {
        let e = events.until("presence");
        if e.data["lost"] == true {
            break e;
        }
    };
    assert_eq!(lost.data["device"], b64(&agent.id()));
    std::thread::sleep(std::time::Duration::from_millis(200));
    assert_eq!(alerts().len(), 1, "told once, however often the timer runs");
    // it comes back, and is lost again later: told again
    again(&mut [&mut agent]);
    agent.link(hub).ok();
    hub.clock(2 * MINUTE + 2000);
    hub.eventually("lost a second time", || alerts().len() == 2);

    // ---- a stream ends when the token it was opened with runs out (the ping timer sees to it)
    again(&mut [&mut w.ada, &mut agent]);
    agent.link(hub).ok();
    let mut stream = w.ada.events(hub, None);
    assert_eq!(stream.status, 200);
    hub.clock(10 * MINUTE + 1000);
    assert!(stream.ended());

    // ---- sweep: an upload no envelope names within an hour is deleted
    again(&mut [&mut w.ada, &mut agent]);
    agent.link(hub).ok();
    let loose: [u8; 16] = random();
    agent
        .raw(
            hub,
            "PUT",
            &format!("/v1/files/{}", b64(&loose)),
            &[],
            b"nobody names me",
        )
        .ok();
    let on_disk = hub.dir.join("files").join(hex(&room)).join(hex(&loose));
    assert!(on_disk.is_file());
    hub.clock(61 * MINUTE);
    hub.eventually("the unnamed upload is swept", || !on_disk.exists());

    // ---- retention: a closed card's bodies go 30 days after closing
    again(&mut [&mut w.ada, &mut agent]);
    agent.link(hub).ok();
    let id = enc::object_id(&group, &agent.id(), agent.chain(&group).0 + 1);
    agent
        .send(
            hub,
            &group,
            &object(
                wire::KIND_VERSION,
                id,
                wire::TYPE_CARD,
                wire::STATE_OPEN,
                1,
                ZERO32,
                ZERO32,
            ),
        )
        .ok();
    let v1 = agent.chain(&group).1;
    agent
        .send(
            hub,
            &group,
            &object(
                wire::KIND_VERSION,
                id,
                wire::TYPE_CARD,
                wire::STATE_CLOSED,
                1,
                v1,
                ZERO32,
            ),
        )
        .ok();
    agent
        .post_message(hub, &group, b"a step of the work trail", false)
        .ok();
    let bodies = |dev: &Dev| -> Vec<bool> {
        dev.get(hub, &format!("/v1/cards/{}", hex(&id))).ok()["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| {
                Envelope::parse(&unb64(i["envelope"].as_str().unwrap()).unwrap())
                    .unwrap()
                    .body
                    .is_some()
            })
            .collect()
    };
    hub.clock(29 * DAY);
    again(&mut [&mut w.ada, &mut agent]);
    std::thread::sleep(std::time::Duration::from_millis(200));
    assert_eq!(
        bodies(&w.ada),
        vec![true, true],
        "29 days: nothing is pruned"
    );
    hub.clock(2 * DAY);
    again(&mut [&mut w.ada, &mut agent]);
    hub.eventually("the closed card is pruned by the timer", || {
        bodies(&w.ada) == vec![false, false]
    });
    // the work trail went with it (30 days), the Commit stayed
    hub.eventually("the work trail is deleted", || {
        w.ada
            .get(hub, &format!("/v1/groups/{}/log", b64(&group)))
            .ok()["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|i| i["kind"] == "commit")
    });
    let _ = session;
}
