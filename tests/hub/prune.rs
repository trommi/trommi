//! What the hub prunes as content arrives (spec/v1.md 9.4.2, 9.4.3, 10.9): a writer's older register values,
//! and their files; the bodies go, header, hash and signature stay, and every chain still links.

mod common;

use common::*;
use serde_json::Value;
use trommi_hub::util::{b64, random, unb64};
use trommi_hub::wire::Envelope;

/// Every envelope the asker may see, by its hash: whether it is served with its body.
fn bodies(hub: &TestHub, dev: &Dev) -> Vec<([u8; 32], bool)> {
    let mut out = Vec::new();
    let mut after = 0;
    loop {
        let page = dev
            .get(hub, &format!("/v2/changes?after={after}&limit=1000"))
            .ok();
        for item in page["items"].as_array().unwrap() {
            if item["kind"] == "envelope" {
                let e =
                    Envelope::parse(&unb64(item["envelope"].as_str().unwrap()).unwrap()).unwrap();
                out.push((e.hash(), e.body.is_some()));
            }
        }
        after = page["change"].as_i64().unwrap();
        if page["more"] != Value::Bool(true) {
            break;
        }
    }
    out
}

fn has_body(all: &[([u8; 32], bool)], hash: &[u8; 32]) -> bool {
    all.iter()
        .find(|(h, _)| h == hash)
        .map(|(_, b)| *b)
        .expect("served")
}

/// A sender's chain in pruned form links from number 1 to its head.
fn chain_links(hub: &TestHub, dev: &Dev, group: &[u8], sender: &[u8; 32]) {
    let page = dev
        .get(
            hub,
            &format!(
                "/v2/groups/{}/chains/{}?after=0&limit=1000",
                b64(group),
                b64(sender)
            ),
        )
        .ok();
    let mut prev = [0u8; 32];
    for item in page["items"].as_array().unwrap() {
        let e = Envelope::parse(&unb64(item["envelope"].as_str().unwrap()).unwrap()).unwrap();
        assert_eq!(e.header.prev, prev, "the chain links");
        prev = e.hash();
    }
}

fn upload(hub: &TestHub, dev: &Dev, file: &[u8; 16]) {
    dev.raw(
        hub,
        "PUT",
        &format!("/v2/files/{}", b64(file)),
        &[],
        b"snapshot bytes",
    )
    .ok();
}

fn fetch(hub: &TestHub, dev: &Dev, file: &[u8; 16]) -> Reply {
    dev.raw(hub, "GET", &format!("/v2/files/{}", b64(file)), &[], &[])
}

#[test]
fn a_register_value_prunes_the_same_writers_earlier_values_and_their_files() {
    let mut w = World::new();
    let mut bea = w.add_human();
    let room = w.room;
    w.catch_up(&mut bea, &room);
    let hub = &w.hub;
    let reg: [u8; 16] = random();
    let other: [u8; 16] = random();

    // ada: three values of one register, the first two name a snapshot file each, the third names the second's
    let (f1, f2): ([u8; 16], [u8; 16]) = (random(), random());
    upload(hub, &w.ada, &f1);
    upload(hub, &w.ada, &f2);
    let mut v = register(&reg, "first");
    v.file_ids = vec![f1];
    w.ada.send(hub, &room, &v).ok();
    let first = w.ada.chain(&room).1;
    w.ada
        .send(hub, &room, &register(&other, "another register"))
        .ok();
    let another = w.ada.chain(&room).1;
    let mut v = register(&reg, "second");
    v.file_ids = vec![f2];
    w.ada.send(hub, &room, &v).ok();
    let second = w.ada.chain(&room).1;
    // bea writes the same name under her own id: the hub cannot tell, it keeps hers
    bea.send(hub, &room, &register(&random(), "bea's")).ok();
    let beas = bea.chain(&room).1;

    let all = bodies(hub, &bea);
    assert!(!has_body(&all, &first), "the first value lost its body");
    assert!(has_body(&all, &second) && has_body(&all, &another) && has_body(&all, &beas));
    fetch(hub, &bea, &f1).refused(404, "not-found");
    fetch(hub, &bea, &f2).ok();

    // a third value that names the second's file again keeps that file
    let mut v = register(&reg, "third");
    v.file_ids = vec![f2];
    w.ada.send(hub, &room, &v).ok();
    let third = w.ada.chain(&room).1;
    let all = bodies(hub, &bea);
    assert!(!has_body(&all, &second) && has_body(&all, &third));
    fetch(hub, &bea, &f2).ok();
    // the Desk serves the newest value in full, and the chain still links
    let desk = bea.get(hub, "/v2/desk").ok();
    assert!(desk["registers"].as_array().unwrap().iter().any(|e| {
        let e = Envelope::parse(&unb64(e["envelope"].as_str().unwrap()).unwrap()).unwrap();
        e.hash() == third && e.body.is_some()
    }));
    chain_links(hub, &bea, &room, &w.ada.id());
}

#[test]
fn a_note_version_prunes_the_same_writers_earlier_versions_of_that_note() {
    use trommi_hub::wire::{self, ZERO32};
    let mut w = World::new();
    let mut bea = w.add_human();
    let room = w.room;
    w.catch_up(&mut bea, &room);
    let hub = &w.hub;
    let version = |state: u8, id: [u8; 16], before: [u8; 32]| {
        object(
            wire::KIND_VERSION,
            id,
            wire::TYPE_NOTE,
            state,
            0,
            before,
            ZERO32,
        )
    };
    let note = enc::object_id(&room, &w.ada.id(), w.ada.chain(&room).0 + 1);
    let other = enc::object_id(&room, &w.ada.id(), w.ada.chain(&room).0 + 2);
    w.ada
        .send(hub, &room, &version(wire::STATE_OPEN, note, ZERO32))
        .ok();
    let a1 = w.ada.chain(&room).1;
    w.ada
        .send(hub, &room, &version(wire::STATE_OPEN, other, ZERO32))
        .ok();
    let o1 = w.ada.chain(&room).1;
    bea.send(hub, &room, &version(wire::STATE_OPEN, note, a1))
        .ok();
    let b1 = bea.chain(&room).1;
    w.ada
        .send(hub, &room, &version(wire::STATE_OPEN, note, b1))
        .ok();
    let a2 = w.ada.chain(&room).1;

    let all = bodies(hub, &bea);
    assert!(
        !has_body(&all, &a1),
        "ada's first version of the Note lost its body"
    );
    assert!(has_body(&all, &a2), "ada's newest version is kept");
    assert!(has_body(&all, &b1), "bea's version is hers: kept");
    assert!(has_body(&all, &o1), "another Note is untouched");
    // the Note's state replays from headers: it is open, its current version ada's newest
    let n = bea
        .get(hub, &format!("/v2/notes/{}", trommi_hub::util::hex(&note)))
        .ok();
    assert_eq!(n["items"].as_array().unwrap().len(), 3);
    assert_eq!(n["state"], 1);
    chain_links(hub, &bea, &room, &w.ada.id());
}

/// `{ frontier: { writer: [seq, hash] }, files }` for `POST /v2/boards/{board}/frontier`.
/// A writer and its head (number, hash).
type Head<'a> = (&'a [u8; 32], (u64, [u8; 32]));

fn frontier_post(heads: &[Head], files: &[[u8; 16]]) -> Value {
    let mut f = serde_json::Map::new();
    for (writer, (seq, hash)) in heads {
        f.insert(b64(&writer[..]), serde_json::json!([seq, b64(hash)]));
    }
    serde_json::json!({ "frontier": f, "files": files.iter().map(|x| b64(x)).collect::<Vec<_>>() })
}

#[test]
fn a_board_is_pruned_behind_the_smallest_frontier_of_the_human_devices() {
    let mut w = World::new();
    let mut bea = w.add_human();
    let mut agent = w.enrol_agent();
    let room = w.room;
    w.catch_up(&mut bea, &room);
    let hub = &w.hub;
    agent.lease = agent
        .post(hub, "/v2/link", &serde_json::json!({ "process": b64(&random::<16>()), "hears": true, "working": false, "last_call_at": 0 }))
        .ok()["generation"]
        .as_u64();
    let board: [u8; 16] = random();
    let path = format!("/v2/boards/{}/frontier", trommi_hub::util::hex(&board));
    let (kept_pic, erased_pic): ([u8; 16], [u8; 16]) = (random(), random());
    upload(hub, &w.ada, &kept_pic);
    upload(hub, &w.ada, &erased_pic);
    let ada = w.ada.id();
    let bea_id = bea.id();

    // ada: a1 (a picture that is erased later), a2 (a picture that stays), a3; bea: b1, b2
    let mut item = board_item(&board);
    item.file_ids = vec![erased_pic];
    w.ada.send(hub, &room, &item).ok();
    let a1 = w.ada.chain(&room);
    let mut item = board_item(&board);
    item.file_ids = vec![kept_pic];
    w.ada.send(hub, &room, &item).ok();
    let a2 = w.ada.chain(&room);
    bea.send(hub, &room, &board_item(&board)).ok();
    let b1 = bea.chain(&room);
    w.ada.send(hub, &room, &board_item(&board)).ok();
    let a3 = w.ada.chain(&room);
    bea.send(hub, &room, &board_item(&board)).ok();
    let b2 = bea.chain(&room);

    // refused: a frontier beyond what the hub holds, a wrong hash, a writer of no room, an agent device
    w.ada
        .post(hub, &path, &frontier_post(&[(&ada, (a3.0 + 5, a3.1))], &[]))
        .refused(400, "bad-format");
    w.ada
        .post(hub, &path, &frontier_post(&[(&ada, (a2.0, a1.1))], &[]))
        .refused(400, "bad-format");
    w.ada
        .post(hub, &path, &frontier_post(&[(&random(), (1, a1.1))], &[]))
        .refused(400, "bad-format");
    agent
        .post(hub, &path, &frontier_post(&[(&ada, a1)], &[]))
        .refused(403, "forbidden");

    // ada's snapshot covers a2 and b1 and keeps one picture: what only she posted counts
    let r = w
        .ada
        .post(
            hub,
            &path,
            &frontier_post(&[(&ada, a2), (&bea_id, b1)], &[kept_pic]),
        )
        .ok();
    assert_eq!(r["pruned"], 3);
    let all = bodies(hub, &bea);
    assert!(!has_body(&all, &a1.1) && !has_body(&all, &a2.1) && !has_body(&all, &b1.1));
    assert!(has_body(&all, &a3.1) && has_body(&all, &b2.1));
    fetch(hub, &bea, &erased_pic).refused(404, "not-found");
    fetch(hub, &bea, &kept_pic).ok();

    // bea's snapshot covers a1 and b2: per writer the smaller counts, nothing more goes
    let r = bea
        .post(
            hub,
            &path,
            &frontier_post(&[(&ada, a1), (&bea_id, b2)], &[kept_pic]),
        )
        .ok();
    assert_eq!(r["pruned"], 0);
    // ada's next snapshot covers everything: bea's b2 goes (both cover it), ada's a3 stays (bea's covers a1 only)
    let r = w
        .ada
        .post(
            hub,
            &path,
            &frontier_post(&[(&ada, a3), (&bea_id, b2)], &[]),
        )
        .ok();
    assert_eq!(r["pruned"], 1);
    let all = bodies(hub, &bea);
    assert!(!has_body(&all, &b2.1) && has_body(&all, &a3.1));
    // the picture stays while bea's post keeps it, though ada's newest no longer names it
    fetch(hub, &bea, &kept_pic).ok();
    // the chains still link, and the board's items come in pruned form
    chain_links(hub, &bea, &room, &ada);
    chain_links(hub, &bea, &room, &bea_id);
    let items = bea
        .get(
            hub,
            &format!(
                "/v2/boards/{}?after_change=0",
                trommi_hub::util::hex(&board)
            ),
        )
        .ok();
    assert_eq!(items["items"].as_array().unwrap().len(), 5);
}
