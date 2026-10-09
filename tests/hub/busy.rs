//! One room keeps the pool for expensive work busy; another room's writes are answered as on an idle hub. Alone
//! in its test binary, so that no other test's work is in the measurement.

mod common;

use common::*;
use serde_json::json;
use std::time::{Duration, Instant};
use trommi_hub::util::{b64, random};

#[test]
fn a_busy_room_does_not_hold_up_another_rooms_writes() {
    // Every piece of expensive work takes 300 ms longer here, as if Commits were costly to verify. Two workers.
    let hub = TestHub::start_with(&[
        ("HUB_TEST_HEAVY_MS", "300"),
        ("HUB_HEAVY_WORKERS", "2"),
        ("HUB_HEAVY_WAITING", "2"),
    ]);
    let (room_a, recovery_a, ada) = found_room(&hub);
    let (room_b, _, mut bob) = found_room(&hub);
    // room A: six requests at once that each need a Commit verified (they are refused in the end; the work is done)
    let path = format!("/v2/groups/{}/commits", b64(&room_a));
    let junk = json!({ "epoch": 0, "commit": b64(&[1u8; 600]), "group_info": b64(&[2u8; 600]), "sealed_key": b64(&[3u8; 100]) });
    let _ = recovery_a;
    let (statuses, slowest) = std::thread::scope(|s| {
        let heavy: Vec<_> = (0..6)
            .map(|_| s.spawn(|| ada.post(&hub, &path, &junk)))
            .collect();
        std::thread::sleep(Duration::from_millis(50));
        // room B writes meanwhile: each envelope is answered as fast as on an idle hub
        let mut slowest = Duration::ZERO;
        for _ in 0..20 {
            let t = Instant::now();
            bob.send(&hub, &room_b, &register(&random(), "x")).ok();
            slowest = slowest.max(t.elapsed());
        }
        let statuses: Vec<(u16, String, bool)> = heavy
            .into_iter()
            .map(|h| h.join().unwrap())
            .map(|r| (r.status, r.code(), r.header("retry-after").is_some()))
            .collect();
        (statuses, slowest)
    });
    assert!(
        slowest < Duration::from_millis(150),
        "a write of room B took {slowest:?} while room A kept the pool busy"
    );
    // the pool takes two at a time and lets two wait: the rest are told to come back, with `retry-after`
    let refused: Vec<_> = statuses
        .iter()
        .filter(|(status, _, _)| *status == 503)
        .collect();
    assert!(
        !refused.is_empty()
            && refused
                .iter()
                .all(|(_, code, retry)| code == "overloaded" && *retry),
        "{statuses:?}"
    );
    assert!(
        statuses
            .iter()
            .any(|(status, code, _)| *status == 400 && code == "bad-commit"),
        "{statuses:?}"
    );

    // the admission queue: a hub that works on no request at a time refuses each one before reading it
    let closed = TestHub::start_with(&[("HUB_ADMITTED", "0")]);
    let refused = closed.post("/v2/rooms", &json!({}));
    refused.refused(503, "overloaded");
    assert!(refused.header("retry-after").is_some());
    assert_eq!(closed.get("/healthz").status, 200);
}
