//! What the hub prunes as content arrives (spec/v1.md 9.4.2, 9.4.3, 10.9): a writer's older register values,
//! and their files; the bodies go, header, hash and signature stay, and every chain still links.

mod common;

use common::*;
use serde_json::Value;
use trommi_hub::util::{b64, random, unb64};
use trommi_hub::wire::{Cut, Envelope};

/// Every envelope the asker may see, by its hash: whether it is served with its body.
fn bodies(hub: &TestHub, dev: &Dev) -> Vec<([u8; 32], bool)> {
    let mut out = Vec::new();
    let mut after = 0;
    loop {
        let page = dev
            .get(hub, &format!("/v1/changes?after={after}&limit=1000"))
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
                "/v1/groups/{}/chains/{}?after=0&limit=1000",
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
        &format!("/v1/files/{}", b64(file)),
        &[],
        b"snapshot bytes",
    )
    .ok();
}

fn fetch(hub: &TestHub, dev: &Dev, file: &[u8; 16]) -> Reply {
    dev.raw(hub, "GET", &format!("/v1/files/{}", b64(file)), &[], &[])
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
    let desk = bea.get(hub, "/v1/desk").ok();
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
        .get(hub, &format!("/v1/notes/{}", trommi_hub::util::hex(&note)))
        .ok();
    assert_eq!(n["items"].as_array().unwrap().len(), 3);
    assert_eq!(n["state"], 1);
    chain_links(hub, &bea, &room, &w.ada.id());
}

type Head<'a> = FrontierHead<'a>;

fn frontier_post(heads: &[Head], files: &[[u8; 16]]) -> Value {
    frontier_body(heads, files, None)
}

fn board_path(board: &[u8; 16]) -> String {
    format!("/v1/boards/{}/frontier", trommi_hub::util::hex(board))
}

/// Removes `dev` from the room group with a Cut at `cut` (its last envelope the remover accepted).
fn remove(w: &mut World, dev: &Dev, cut: (u64, [u8; 32])) {
    let room = w.room;
    let now = w.ada.room_now();
    let out = w.ada.commit(
        &room,
        &Change {
            removes: vec![dev.id()],
            cuts: vec![Cut {
                device: dev.id(),
                seq: cut.0,
                hash: cut.1,
            }],
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
    w.ada.post_commit(&w.hub, &out, &sealed).ok();
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
        .post(hub, "/v1/link", &serde_json::json!({ "process": b64(&random::<16>()), "hears": true, "working": false, "last_call_at": 0 }))
        .ok()["generation"]
        .as_u64();
    let board: [u8; 16] = random();
    let path = board_path(&board);
    let (ada_reg, bea_reg): ([u8; 16], [u8; 16]) = (random(), random());
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
    // a declaration alone prunes nothing: no snapshot is written yet
    assert_eq!(
        w.ada
            .post(
                hub,
                &path,
                &frontier_post(&[(&ada, a3), (&bea_id, b2)], &[])
            )
            .ok()["pruned"],
        0
    );
    let all = bodies(hub, &bea);
    assert!(has_body(&all, &a1.1) && has_body(&all, &b2.1));

    // ada's snapshot covers a2 and b1 and keeps one picture: what only she posted counts
    let r = write_snapshot(
        hub,
        &mut w.ada,
        &room,
        &board,
        &ada_reg,
        &[(&ada, a2), (&bea_id, b1)],
        &[kept_pic],
    );
    assert_eq!(r["pruned"], 3);
    let all = bodies(hub, &bea);
    assert!(!has_body(&all, &a1.1) && !has_body(&all, &a2.1) && !has_body(&all, &b1.1));
    assert!(has_body(&all, &a3.1) && has_body(&all, &b2.1));
    fetch(hub, &bea, &erased_pic).refused(404, "not-found");
    fetch(hub, &bea, &kept_pic).ok();

    // bea's snapshot covers a1 and b2: per writer the smaller counts, nothing more goes
    let r = write_snapshot(
        hub,
        &mut bea,
        &room,
        &board,
        &bea_reg,
        &[(&ada, a1), (&bea_id, b2)],
        &[kept_pic],
    );
    assert_eq!(r["pruned"], 0);
    // ada's next snapshot covers everything: bea's b2 goes (both cover it), ada's a3 stays (bea's covers a1 only)
    let r = write_snapshot(
        hub,
        &mut w.ada,
        &room,
        &board,
        &ada_reg,
        &[(&ada, a3), (&bea_id, b2)],
        &[],
    );
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
                "/v1/boards/{}?after_change=0",
                trommi_hub::util::hex(&board)
            ),
        )
        .ok();
    assert_eq!(items["items"].as_array().unwrap().len(), 5);
}

/// 10.9: a snapshot that is written while another device's is bound holds pruning back from its declaration on,
/// before its own post is bound (two devices snapshotting at once).
#[test]
fn a_snapshot_holds_pruning_back_from_its_declaration_on() {
    let mut w = World::new();
    let mut bea = w.add_human();
    let room = w.room;
    w.catch_up(&mut bea, &room);
    let hub = &w.hub;
    let board: [u8; 16] = random();
    let path = board_path(&board);
    let ada = w.ada.id();
    w.ada.send(hub, &room, &board_item(&board)).ok();
    let a1 = w.ada.chain(&room);
    w.ada.send(hub, &room, &board_item(&board)).ok();
    let a2 = w.ada.chain(&room);

    // bea declares a snapshot that covers a1; her register value is taken, her bound post has not come yet
    bea.post(hub, &path, &frontier_post(&[(&ada, a1)], &[]))
        .ok();
    let bea_reg: [u8; 16] = random();
    bea.send(hub, &room, &register(&bea_reg, "snapshot")).ok();
    let bea_value = bea.chain(&room);
    // ada's snapshot covers a2: only a1 goes
    let r = write_snapshot(
        hub,
        &mut w.ada,
        &room,
        &board,
        &random(),
        &[(&ada, a2)],
        &[],
    );
    assert_eq!(r["pruned"], 1);
    let all = bodies(hub, &bea);
    assert!(!has_body(&all, &a1.1) && has_body(&all, &a2.1));
    // bea's post bound late changes nothing
    assert_eq!(
        bea.post(
            hub,
            &path,
            &frontier_body(&[(&ada, a1)], &[], Some(bea_value))
        )
        .ok()["pruned"],
        0
    );
    assert!(has_body(&bodies(hub, &bea), &a2.1));
}

/// 10.9: two snapshots of one device on their way at once: binding the later one does not answer the earlier
/// one's declaration, which holds pruning back until its own post is bound; a device has at most 8 open
/// declarations of a board.
#[test]
fn a_declaration_holds_back_until_its_own_snapshot_is_bound() {
    let mut w = World::new();
    let room = w.room;
    let hub = &w.hub;
    let board: [u8; 16] = random();
    let path = board_path(&board);
    let ada = w.ada.id();
    w.ada.send(hub, &room, &board_item(&board)).ok();
    let a1 = w.ada.chain(&room);
    w.ada.send(hub, &room, &board_item(&board)).ok();
    let a2 = w.ada.chain(&room);
    let reg: [u8; 16] = random();

    // S1 (covers a1) is declared, then S2 (covers a2) is declared, written and bound: a2 stays for S1
    w.ada
        .post(hub, &path, &frontier_post(&[(&ada, a1)], &[]))
        .ok();
    let r = write_snapshot(hub, &mut w.ada, &room, &board, &reg, &[(&ada, a2)], &[]);
    assert_eq!(r["pruned"], 1);
    let all = bodies(hub, &w.ada);
    assert!(!has_body(&all, &a1.1) && has_body(&all, &a2.1));
    // S1's value comes after S2's and is bound: still nothing beyond a1 goes
    w.ada.send(hub, &room, &register(&reg, "S1")).ok();
    let s1 = w.ada.chain(&room);
    assert_eq!(
        w.ada
            .post(hub, &path, &frontier_body(&[(&ada, a1)], &[], Some(s1)))
            .ok()["pruned"],
        0
    );
    assert!(has_body(&bodies(hub, &w.ada), &a2.1));

    // at most 8 open declarations; the same one again is no new one
    for n in 0..8u64 {
        w.ada.send(hub, &room, &board_item(&board)).ok();
        let head = w.ada.chain(&room);
        w.ada
            .post(hub, &path, &frontier_post(&[(&ada, head)], &[]))
            .ok();
        if n == 7 {
            w.ada
                .post(hub, &path, &frontier_post(&[(&ada, head)], &[]))
                .ok();
        }
    }
    w.ada
        .post(hub, &path, &frontier_post(&[(&ada, a2)], &[]))
        .refused(429, "too-many");
}

/// 10.9: a bound post names the device's own newest snapshot value; an older one is `replay`; posting the same
/// value again changes nothing.
#[test]
fn a_bound_post_names_the_devices_newest_snapshot_value() {
    let mut w = World::new();
    let mut bea = w.add_human();
    let room = w.room;
    w.catch_up(&mut bea, &room);
    let hub = &w.hub;
    let board: [u8; 16] = random();
    let path = board_path(&board);
    let ada = w.ada.id();
    w.ada.send(hub, &room, &board_item(&board)).ok();
    let a1 = w.ada.chain(&room);
    w.ada.send(hub, &room, &board_item(&board)).ok();
    let a2 = w.ada.chain(&room);
    let item = a2;
    let heads = [(&ada, a1)];

    // not a register value, not this device's, a wrong hash
    w.ada
        .post(hub, &path, &frontier_body(&heads, &[], Some(item)))
        .refused(400, "bad-format");
    bea.post(hub, &path, &frontier_body(&heads, &[], Some(a1)))
        .refused(400, "bad-format");
    let reg: [u8; 16] = random();
    w.ada.send(hub, &room, &register(&reg, "first")).ok();
    let s1 = w.ada.chain(&room);
    w.ada
        .post(hub, &path, &frontier_body(&heads, &[], Some((s1.0, a1.1))))
        .refused(400, "bad-format");
    w.ada.send(hub, &room, &register(&reg, "second")).ok();
    let s2 = w.ada.chain(&room);
    // the first value is no longer its register's newest
    w.ada
        .post(hub, &path, &frontier_body(&heads, &[], Some(s1)))
        .refused(409, "replay");
    assert_eq!(
        w.ada
            .post(hub, &path, &frontier_body(&heads, &[], Some(s2)))
            .ok()["pruned"],
        1
    );
    // posting the same value again changes nothing (its time stays: tests/hub/time.rs)
    assert_eq!(
        w.ada
            .post(hub, &path, &frontier_body(&[(&ada, a2)], &[], Some(s2)))
            .ok()["pruned"],
        0
    );
    assert!(has_body(&bodies(hub, &bea), &a2.1));
}

/// 10.9: a removed device's snapshot value within its Cut can still be current: its post keeps counting. A
/// frontier beyond a removed writer's Cut is refused (`removed-sender`).
#[test]
fn a_removed_devices_snapshot_still_counts_and_a_frontier_beyond_a_cut_is_refused() {
    let mut w = World::new();
    let mut bea = w.add_human();
    let room = w.room;
    w.catch_up(&mut bea, &room);
    let mut cara = w.add_human();
    w.catch_up(&mut cara, &room);
    w.catch_up(&mut bea, &room);
    let board: [u8; 16] = random();
    let path = board_path(&board);
    let ada = w.ada.id();
    let hub = &w.hub;
    w.ada.send(hub, &room, &board_item(&board)).ok();
    let a1 = w.ada.chain(&room);
    w.ada.send(hub, &room, &board_item(&board)).ok();
    let a2 = w.ada.chain(&room);
    cara.send(hub, &room, &board_item(&board)).ok();
    let c1 = cara.chain(&room);
    cara.send(hub, &room, &board_item(&board)).ok();
    let c2 = cara.chain(&room);
    let cara_id = cara.id();

    // bea's snapshot covers a1; then bea is removed with a Cut that keeps it
    assert_eq!(
        write_snapshot(hub, &mut bea, &room, &board, &random(), &[(&ada, a1)], &[])["pruned"],
        1
    );
    let bea_head = bea.chain(&room);
    remove(&mut w, &bea, bea_head);
    // cara is removed with a Cut at c1: c2 lies beyond it
    remove(&mut w, &cara, c1);
    let hub = &w.hub;
    w.ada
        .post(
            hub,
            &path,
            &frontier_post(&[(&ada, a2), (&cara_id, c2)], &[]),
        )
        .refused(403, "removed-sender");
    // ada's snapshot covers a2 and c1: bea's post still holds a2 back
    let r = write_snapshot(
        hub,
        &mut w.ada,
        &room,
        &board,
        &random(),
        &[(&ada, a2), (&cara_id, c1)],
        &[],
    );
    assert_eq!(
        r["pruned"], 0,
        "bea's post names no c, ada's a2 is beyond bea's a1"
    );
    assert!(has_body(&bodies(hub, &w.ada), &a2.1));
}
