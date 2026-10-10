//! A load smoke test: many envelopes in one room, then the main queries timed over HTTP, with their query plans.
//! Run it optimised and read its numbers: `cargo test --release -p trommi-tests --test hub_load -- --nocapture`.
//! In a debug build it runs small, as a check that it works. `HUB_LOAD_ENVELOPES` sets the size.

mod common;

use common::*;
use std::time::{Duration, Instant};
use trommi_hub::content::{post_envelope, Posted};
use trommi_hub::delivery::Ctx;
use trommi_hub::store::{Auth, Effects, Who};
use trommi_hub::util::{b64, hex, random};
use trommi_hub::wire::{self, ZERO32};

fn timed(what: &str, runs: usize, f: impl Fn() -> usize) -> Duration {
    let mut times = vec![];
    let mut size = 0;
    for _ in 0..runs {
        let t = Instant::now();
        size = f();
        times.push(t.elapsed());
    }
    times.sort();
    let (median, worst) = (times[times.len() / 2], times[times.len() - 1]);
    println!(
        "  {what:<58} median {:>7.2} ms   worst {:>7.2} ms   {:>8} bytes",
        median.as_secs_f64() * 1000.0,
        worst.as_secs_f64() * 1000.0,
        size
    );
    median
}

#[test]
fn many_envelopes_and_the_main_queries_stay_fast() {
    let total: usize = std::env::var("HUB_LOAD_ENVELOPES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(if cfg!(debug_assertions) {
            3_000
        } else {
            100_000
        });
    let sessions = 20;
    let hub = TestHub::start_with(&[
        ("HUB_LIMIT_ENVELOPES_PER_SECOND", "1000000"),
        ("HUB_LIMIT_ENVELOPE_BURST", "1000000"),
    ]);
    let mut w = World::on(hub);
    let room = w.room;
    let mut agents = vec![];
    let mut groups = vec![];
    for _ in 0..sessions {
        let mut agent = w.enrol_agent();
        let (session, group) = w.found_main(&mut [], Some(&mut agent));
        agents.push(agent);
        groups.push((session, group));
    }
    let app = w.hub.app.clone();
    let boards: Vec<[u8; 16]> = (0..3).map(|_| random()).collect();
    let registers: Vec<[u8; 16]> = (0..50).map(|_| random()).collect();

    // ---- write: straight into the hub's one write route, 500 envelopes to a transaction
    let started = Instant::now();
    let mut written = 0usize;
    let mut cards: Vec<(usize, [u8; 16], [u8; 32])> = vec![];
    let mut build = Duration::ZERO;
    while written < total {
        let mut batch: Vec<(Auth, Vec<u8>)> = vec![];
        let t = Instant::now();
        for i in 0..500.min(total - written) {
            let n = written + i;
            let k = n % sessions;
            let (session, group) = &groups[k];
            let human = Auth {
                room,
                device: w.ada.id(),
                who: Who::Human,
            };
            let agent = Auth {
                room,
                device: agents[k].id(),
                who: Who::Agent,
            };
            match n % 20 {
                // board items and room registers by the human device
                0..=2 => batch.push((human, w.ada.envelope(&room, &board_item(&boards[n % 3])).0)),
                3 | 4 => batch.push((
                    human,
                    w.ada
                        .envelope(&room, &register(&registers[n % 50], "value"))
                        .0,
                )),
                // a card; every third one is answered later, every fifth closed
                5 => {
                    let id = enc::object_id(group, &agents[k].id(), agents[k].chain(group).0 + 1);
                    let (bytes, hash) = agents[k].envelope(
                        group,
                        &object(
                            wire::KIND_VERSION,
                            id,
                            wire::TYPE_CARD,
                            wire::STATE_OPEN,
                            (n % 4) as u8,
                            ZERO32,
                            ZERO32,
                        ),
                    );
                    cards.push((k, id, hash));
                    batch.push((agent, bytes));
                }
                6 if cards.len() > 40 => {
                    let (ck, id, hash) = cards.remove(0);
                    let recipient = agents[ck].id();
                    let item = object(
                        wire::KIND_ANSWER,
                        id,
                        wire::TYPE_CARD,
                        wire::STATE_ANSWERED,
                        1,
                        hash,
                        recipient,
                    );
                    batch.push((human, w.ada.envelope(&groups[ck].1, &item).0));
                }
                7 => batch.push((
                    human,
                    w.ada
                        .envelope(
                            group,
                            &chat(session, agents[k].id(), "a question to the agent"),
                        )
                        .0,
                )),
                _ => batch.push((
                    agent,
                    agents[k]
                        .envelope(
                            group,
                            &chat(
                                session,
                                ZERO32,
                                "an answer from the agent, a little longer than the question",
                            ),
                        )
                        .0,
                )),
            }
        }
        build += t.elapsed();
        let n = batch.len();
        let stored = app
            .db
            .write(|c| {
                let x = Ctx {
                    c,
                    obs: &app.obs,
                    cfg: &app.cfg,
                    now: trommi_hub::util::now(),
                };
                let mut fx = Effects::default();
                let mut stored = 0;
                for (auth, bytes) in &batch {
                    if let Posted::Stored { .. } = post_envelope(&x, auth, bytes, &mut fx)? {
                        stored += 1;
                    }
                }
                Ok::<_, trommi_hub::error::Refused>(stored)
            })
            .unwrap();
        assert_eq!(stored, n, "every envelope of the batch was taken");
        written += n;
    }
    let elapsed = started.elapsed();
    let hub_time = elapsed - build;
    let db = w.hub.dir.join("hub.db");
    println!("\n{written} envelopes in {sessions} sessions and the room group");
    println!("  built and signed by the test clients in {:.1} s; checked and stored by the hub in {:.1} s = {:.0} envelopes/s (signature check, chain, rules, indexes)", build.as_secs_f64(), hub_time.as_secs_f64(), written as f64 / hub_time.as_secs_f64());
    println!(
        "  database {:.1} MiB",
        std::fs::metadata(&db).map(|m| m.len()).unwrap_or(0) as f64 / 1048576.0
    );

    // ---- one envelope per request over HTTP, as a device posts
    let hub = &w.hub;
    let t = Instant::now();
    let over_http = 300;
    for _ in 0..over_http {
        w.ada.send(hub, &room, &board_item(&boards[0])).ok();
    }
    println!(
        "  over HTTP, one connection and one transaction each: {:.0} envelopes/s",
        over_http as f64 / t.elapsed().as_secs_f64()
    );

    // ---- read: the main queries, 30 runs each, a new connection every time
    println!("the main queries:");
    let ada = &w.ada;
    let (session, group) = &groups[7];
    let size = |r: Reply| {
        assert_eq!(r.status, 200, "{}", String::from_utf8_lossy(&r.body));
        r.body.len()
    };
    let head = ada.get(hub, "/v1/desk").ok()["change"].as_i64().unwrap();
    let mut slowest = Duration::ZERO;
    let mut check = |d: Duration| slowest = slowest.max(d);
    check(timed(
        "load the Desk (open objects, registers, groups)",
        30,
        || size(ada.get(hub, "/v1/desk")),
    ));
    check(timed("page a Chat: the newest 50", 30, || {
        size(ada.get(
            hub,
            &format!("/v1/chats/session/{}/items?limit=50", hex(session)),
        ))
    }));
    check(timed("page a Chat: 50 before the middle", 30, || {
        size(ada.get(
            hub,
            &format!(
                "/v1/chats/session/{}/items?limit=50&before={}",
                hex(session),
                head / 2
            ),
        ))
    }));
    check(timed(
        "load a board: the tail after a snapshot (1 000 changes)",
        30,
        || {
            size(ada.get(
                hub,
                &format!(
                    "/v1/boards/{}?after_change={}",
                    hex(&boards[1]),
                    head - 1000
                ),
            ))
        },
    ));
    check(timed(
        "catch up: 200 changes after a cursor in the middle",
        30,
        || size(ada.get(hub, &format!("/v1/changes?after={}&limit=200", head / 2))),
    ));
    check(timed("catch up: the last 200 changes", 30, || {
        size(ada.get(hub, &format!("/v1/changes?after={}&limit=200", head - 200)))
    }));
    check(timed(
        "catch up as an agent device (one session of twenty)",
        30,
        || {
            size(agents[7].get(
                hub,
                &format!("/v1/changes?after={}&limit=200", (head - 4000).max(0)),
            ))
        },
    ));
    check(timed(
        "a sender's chain in pruned form, 500 after a frontier",
        30,
        || {
            size(ada.get(
                hub,
                &format!(
                    "/v1/groups/{}/chains/{}?after=10&limit=500",
                    b64(group),
                    b64(&agents[7].id())
                ),
            ))
        },
    ));
    check(timed("a group's log", 30, || {
        size(ada.get(hub, &format!("/v1/groups/{}/log", b64(group))))
    }));
    if let Some((_, id, _)) = cards.last() {
        check(timed("every envelope of a card", 30, || {
            size(ada.get(hub, &format!("/v1/cards/{}", hex(id))))
        }));
    }
    check(timed("the list of groups", 30, || {
        size(ada.get(hub, &format!("/v1/rooms/{}/groups", b64(&room))))
    }));

    // ---- the plans of the main queries: each must use its index, none may scan the envelopes
    println!("query plans:");
    let c = rusqlite::Connection::open_with_flags(&db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .unwrap();
    let plans = [
        ("the Desk: open cards by urgency", "SELECT object_id FROM cards WHERE room_id = x'00' AND state = 1 ORDER BY urgency DESC, first_change", "cards_desk"),
        ("the Desk: a card's current version", "SELECT header FROM envelopes WHERE room_id = x'00' AND change = 5", "envelopes_by_change"),
        ("the Desk: registers' newest values", "SELECT e.header FROM registers r JOIN envelopes e ON e.room_id = r.room_id AND e.change = r.head_change WHERE r.room_id = x'00' ORDER BY r.head_change", "registers_by_room"),
        ("page a Chat", "SELECT header FROM envelopes WHERE room_id = x'00' AND timeline = x'01' AND change < 9 AND cut = 0 ORDER BY change DESC LIMIT 51", "envelopes_by_timeline"),
        ("load a board", "SELECT header FROM envelopes WHERE room_id = x'00' AND timeline = x'02' AND change > 9 AND cut = 0 ORDER BY change LIMIT 501", "envelopes_by_timeline"),
        ("catch up: envelopes", "SELECT change, length(header) FROM envelopes WHERE room_id = x'00' AND change > 9 AND change <= 20009 AND cut = 0 AND (0 = 1 OR hex(group_id) IN (SELECT value FROM json_each('[]'))) ORDER BY change LIMIT 201", "envelopes_by_change"),
        ("catch up: the log", "SELECT change, length(bytes) FROM group_log WHERE room_id = x'00' AND change > 9 AND change <= 20009 AND (0 = 1 OR hex(group_id) IN (SELECT value FROM json_each('[]')) OR kind = 'commit') ORDER BY change LIMIT 201", "group_log_by_change"),
        ("a group's log", "SELECT bytes FROM group_log WHERE group_id = x'00' AND n > 0 ORDER BY n LIMIT 201", "PRIMARY KEY"),
        ("a sender's chain", "SELECT header FROM envelopes WHERE group_id = x'00' AND sender = x'01' AND seq > 3 ORDER BY seq LIMIT 501", "envelopes_chain"),
        ("the chain's head (every post)", "SELECT seq, hash FROM envelopes WHERE group_id = x'00' AND sender = x'01' ORDER BY seq DESC LIMIT 1", "envelopes_chain"),
        ("every envelope of an object", "SELECT header FROM envelopes WHERE room_id = x'00' AND object_id = x'01' AND cut = 0 ORDER BY change", "envelopes_by_object"),
        ("claim a KeyPackage", "SELECT id FROM key_packages WHERE room_id = x'00' AND device = x'01' AND expires_at > 5 AND (last_resort = 1 OR ref NOT IN (SELECT ref FROM spent_key_packages)) ORDER BY last_resort, id LIMIT 1", "key_packages_claim"),
        ("a page of the list of groups", "SELECT group_id FROM groups WHERE room_id = x'00' AND founded_change > 3 ORDER BY founded_change LIMIT 201", "groups_by_founding"),
        ("retention: what is due", "SELECT object_id FROM cards WHERE settled_at IS NOT NULL AND pruned_at IS NULL AND settled_at <= 5 ORDER BY settled_at LIMIT 200", "cards_due"),
    ];
    for (what, sql, index) in plans {
        let plan: Vec<String> = c
            .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
            .unwrap()
            .query_map([], |r| r.get::<_, String>(3))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        let plan = plan.join(" | ");
        println!("  {what:<38} {plan}");
        assert!(plan.contains(index), "{what}: expected {index} in: {plan}");
        assert!(
            !plan.contains("SCAN envelopes") && !plan.contains("USE TEMP B-TREE"),
            "{what}: {plan}"
        );
    }
    // the bound of this smoke test: no main query slower than a quarter of a second, in any build
    assert!(
        slowest < Duration::from_millis(250),
        "the slowest main query took {slowest:?}"
    );
}
