//! Stored content over HTTP: the one envelope route with the hub's checks 1 to 8, void records, the object
//! state rule, the Desk, paging a chat, loading a board, chains and Cuts, live delivery.

mod common;

use common::*;
use serde_json::{json, Value};
use std::time::Duration;
use trommi_hub::util::{b64, hex, random, unb64};
use trommi_hub::wire::{self, Cut, Envelope, Subject, ZERO16, ZERO32};

struct Scene {
    w: World,
    bea: Dev,
    agent: Dev,
    session: [u8; 16],
    group: Vec<u8>,
}

/// A room with two human devices, an agent device and its main session; the agent holds its lease.
fn scene() -> Scene {
    scene_on(TestHub::start())
}

fn scene_on(hub: TestHub) -> Scene {
    let mut w = World::on(hub);
    let mut bea = w.add_human();
    let mut agent = w.enrol_agent();
    w.catch_up(&mut bea, &w.room.clone());
    let (session, group) = w.found_main(&mut [&mut bea], Some(&mut agent));
    agent.lease = agent.post(&w.hub, "/v2/link", &json!({ "process": b64(&random::<16>()), "hears": true, "working": false, "last_call_at": 0 })).ok()["generation"].as_u64();
    Scene { w, bea, agent, session, group }
}

/// A card's first version by the agent; returns its object id and envelope hash.
fn card(s: &mut Scene, urgency: u8, flags: u8) -> ([u8; 16], [u8; 32]) {
    let seq = s.agent.chain(&s.group).0 + 1;
    let id = wire::object_id(&s.group, &s.agent.id(), seq);
    let mut item = object(wire::KIND_VERSION, id, wire::TYPE_CARD, wire::STATE_OPEN, urgency, ZERO32, ZERO32);
    item.flags = flags;
    s.agent.send(&s.w.hub, &s.group, &item).ok();
    (id, s.agent.chain(&s.group).1)
}

fn envelope_of(item: &Value) -> Envelope {
    Envelope::parse(&unb64(item["envelope"].as_str().unwrap()).unwrap()).unwrap()
}

#[test]
fn the_hub_runs_its_checks_in_order_and_takes_no_number_before_the_chain() {
    let s = scene();
    let hub = &s.w.hub;
    let key = s.w.ada.content_key(&s.group);
    let item = chat(&s.session, s.agent.id(), "hello");
    let good = |dev: &Dev, seq: u64, prev: [u8; 32]| dev.build_envelope(&s.group, 1, seq, prev, &item, &key);

    // (1) encoding, flags, values; the room
    let (bytes, _) = good(&s.w.ada, 1, ZERO32);
    let mut newer = bytes.clone();
    newer[1] = 3;
    s.w.ada.post_envelope(hub, &newer).refused(400, "newer-version");
    let mut flags = bytes.clone();
    flags[3] = 2;
    s.w.ada.post_envelope(hub, &flags).refused(400, "bad-format");
    let mut reserved_kind = bytes.clone();
    reserved_kind[2] = 9;
    s.w.ada.post_envelope(hub, &reserved_kind).refused(400, "bad-format");
    s.w.ada.post_envelope(hub, &bytes[..bytes.len() - 3]).refused(400, "bad-format");
    // a pruned envelope is not posted
    let parsed = Envelope::parse(&bytes).unwrap();
    let pruned = wire::encode_envelope(&parsed.header_bytes, &parsed.nonce, None, &parsed.body_hash, &parsed.signature);
    s.w.ada.post_envelope(hub, &pruned).refused(400, "bad-format");
    // a group of another room
    let (other_room, _, mallory) = found_room(hub);
    let foreign = mallory.build_envelope(&other_room, 0, 1, ZERO32, &register(&random(), "x"), &key).0;
    s.w.ada.post_envelope(hub, &foreign).refused(400, "wrong-room");
    mallory.post_envelope(hub, &bytes).refused(400, "wrong-room");
    // only from the signed-in device that signed it
    s.bea.post_envelope(hub, &bytes).refused(403, "wrong-sender");
    // (2) an epoch the group has not reached
    let ahead = s.w.ada.build_envelope(&s.group, 5, 1, ZERO32, &item, &key).0;
    s.w.ada.post_envelope(hub, &ahead).refused(409, "group-behind");
    // (5) the signature
    let mut forged = bytes.clone();
    let n = forged.len();
    forged[n - 1] ^= 1;
    s.w.ada.post_envelope(hub, &forged).refused(400, "bad-signature");
    // (6) the chain: a gap, a wrong prev
    s.w.ada.post_envelope(hub, &good(&s.w.ada, 2, ZERO32).0).refused(409, "gap");
    s.w.ada.post_envelope(hub, &good(&s.w.ada, 1, [1; 32]).0).refused(400, "chain-break");
    // none of these took a number: the first envelope is still number 1
    let first = s.w.ada.post_envelope(hub, &bytes).ok();
    // a repeated post of the same bytes gets the first answer again
    assert_eq!(s.w.ada.post_envelope(hub, &bytes).ok(), first);
    // another envelope under the same number
    s.w.ada.post_envelope(hub, &good(&s.w.ada, 1, ZERO32).0).refused(409, "equivocation");
    let chain = s.w.ada.get(hub, &format!("/v2/groups/{}/chains/{}", b64(&s.group), b64(&s.w.ada.id()))).ok();
    assert_eq!(chain["items"].as_array().unwrap().len(), 1);
    assert_eq!(envelope_of(&chain["items"][0]).body, None, "the chain route serves the pruned form");
    assert_eq!(envelope_of(&chain["items"][0]).hash(), parsed.hash());
}

#[test]
fn a_refusal_after_the_chain_check_is_stored_as_a_void_record() {
    let mut s = scene();
    let hub = &s.w.hub;
    // (7) a human device writes a card: forbidden, and the number is used
    let id = wire::object_id(&s.group, &s.w.ada.id(), 1);
    let reply = s.w.ada.send(hub, &s.group, &object(wire::KIND_VERSION, id, wire::TYPE_CARD, wire::STATE_OPEN, 1, ZERO32, ZERO32));
    assert_eq!(reply.refused(403, "forbidden")["voided"], true);
    assert_eq!(s.w.ada.chain(&s.group).0, 1);
    // the same bytes again: the same refusal, no second record
    // a human device not addressing the agent device
    assert_eq!(s.w.ada.send(hub, &s.group, &chat(&s.session, ZERO32, "to nobody")).refused(403, "forbidden")["voided"], true);
    // a register larger than a register may be
    let mut big = register(&random(), "x");
    big.payload = vec![b'a'; 9000];
    assert_eq!(s.w.ada.send(hub, &s.group, &big).refused(413, "too-large")["voided"], true);
    // the next good envelope continues the chain after the three void records
    s.w.ada.send(hub, &s.group, &chat(&s.session, s.agent.id(), "fine")).ok();
    assert_eq!(s.w.ada.chain(&s.group).0, 4);
    // every read route serves a void record with its void_code, pruned
    let chain = s.bea.get(hub, &format!("/v2/groups/{}/chains/{}", b64(&s.group), b64(&s.w.ada.id()))).ok();
    let codes: Vec<&str> = chain["items"].as_array().unwrap().iter().map(|i| i["void_code"].as_str().unwrap_or("")).collect();
    assert_eq!(codes, vec!["forbidden", "forbidden", "too-large", ""]);
    let changes = s.bea.get(hub, "/v2/changes?after=0&limit=1000").ok();
    let voids: Vec<&Value> = changes["items"].as_array().unwrap().iter().filter(|i| i["void_code"].is_string()).collect();
    assert_eq!(voids.len(), 3);
    assert!(voids.iter().all(|v| envelope_of(v).body.is_none()));
    // a void record changed nothing: no card, one chat item
    let desk = s.bea.get(hub, "/v2/desk").ok();
    assert_eq!(desk["cards"], json!([]));
    let items = s.bea.get(hub, &format!("/v2/chats/session/{}/items", hex(&s.session))).ok();
    assert_eq!(items["items"].as_array().unwrap().iter().filter(|i| i["void_code"].is_null()).count(), 1);

    // (8) an envelope of an epoch that ended more than two minutes ago is void; within two minutes it is taken
    let old_key = s.bea.content_key(&s.group);
    let now = s.w.ada.room_now();
    let out = s.w.ada.commit(&s.group, &Change::default(), now);
    let sealed = s.w.ada.sealed_key(&s.group, 2, &out.group_info, now.0, &s.w.recovery.hpke_public, true);
    s.w.ada.post_commit(hub, &out, &sealed).ok();
    let (seq, prev) = s.bea.chain(&s.group);
    let (late, hash) = s.bea.build_envelope(&s.group, 1, seq + 1, prev, &chat(&s.session, s.agent.id(), "just before the Commit"), &old_key);
    s.bea.post_envelope(hub, &late).ok();
    s.bea.chains.insert(s.group.clone(), (seq + 1, hash));
}

#[test]
fn only_the_allowed_sender_writes_each_item() {
    let mut s = scene();
    let room = s.w.room;
    let hub = &s.w.hub;
    let forbidden = |reply: Reply| assert_eq!(reply.refused(403, "forbidden")["voided"], true);
    // Notes, board items and room registers: human devices, in the room group
    let note_id = wire::object_id(&room, &s.w.ada.id(), 1);
    s.w.ada.send(hub, &room, &object(wire::KIND_VERSION, note_id, wire::TYPE_NOTE, wire::STATE_OPEN, 0, ZERO32, ZERO32)).ok();
    let board: [u8; 16] = random();
    s.w.ada.send(hub, &room, &board_item(&board)).ok();
    s.w.ada.send(hub, &room, &register(&random(), "desk")).ok();
    // any human device writes a version on any other's Note, also on an older version
    s.bea.send(hub, &room, &object(wire::KIND_VERSION, note_id, wire::TYPE_NOTE, wire::STATE_OPEN, 0, [7; 32], ZERO32)).ok();
    // a Chat does not belong in the room group; a card neither
    forbidden(s.w.ada.send(hub, &room, &chat(&s.session, ZERO32, "x")));
    // a board item or a Note in a session group
    forbidden(s.w.ada.send(hub, &s.group, &board_item(&board)));
    let id = wire::object_id(&s.group, &s.w.ada.id(), s.w.ada.chain(&s.group).0 + 1);
    forbidden(s.w.ada.send(hub, &s.group, &object(wire::KIND_VERSION, id, wire::TYPE_NOTE, wire::STATE_OPEN, 0, ZERO32, ZERO32)));
    // an agent device is no leaf of the room group
    let key = [0u8; 32];
    let (bytes, _) = s.agent.build_envelope(&room, 2, 1, ZERO32, &register(&random(), "x"), &key);
    s.agent.post_envelope(hub, &bytes).refused(403, "not-member");

    // a card by the agent; a second first version under the same id; a first version with a made-up id
    let (card_id, v1) = card(&mut s, 2, 0);
    let hub = &s.w.hub;
    forbidden(s.agent.send(hub, &s.group, &object(wire::KIND_VERSION, card_id, wire::TYPE_CARD, wire::STATE_OPEN, 2, ZERO32, ZERO32)));
    forbidden(s.agent.send(hub, &s.group, &object(wire::KIND_VERSION, random(), wire::TYPE_CARD, wire::STATE_OPEN, 2, ZERO32, ZERO32)));
    // a Chat on the card, by the agent and by a human device to the agent; on a card that does not exist
    let card_chat = |id: [u8; 16], recipient| Item { subject: Subject::Item { timeline_kind: 1, timeline_scope: 1, timeline_ref: id }, ..chat(&ZERO16, recipient, "about the card") };
    s.agent.send(hub, &s.group, &card_chat(card_id, ZERO32)).ok();
    s.bea.send(hub, &s.group, &card_chat(card_id, s.agent.id())).ok();
    forbidden(s.bea.send(hub, &s.group, &card_chat(random(), s.agent.id())));
    // a Chat on another session's id
    forbidden(s.agent.send(hub, &s.group, &chat(&random(), ZERO32, "elsewhere")));
    // an answer: by a human device, to the card's owner, naming the current version
    forbidden(s.bea.send(hub, &s.group, &object(wire::KIND_ANSWER, card_id, wire::TYPE_CARD, wire::STATE_ANSWERED, 2, v1, ZERO32)));
    forbidden(s.bea.send(hub, &s.group, &object(wire::KIND_ANSWER, card_id, wire::TYPE_CARD, wire::STATE_ANSWERED, 2, [5; 32], s.agent.id())));
    forbidden(s.agent.send(hub, &s.group, &object(wire::KIND_ANSWER, card_id, wire::TYPE_CARD, wire::STATE_ANSWERED, 2, v1, s.agent.id())));
    s.bea.send(hub, &s.group, &object(wire::KIND_ANSWER, card_id, wire::TYPE_CARD, wire::STATE_ANSWERED, 2, v1, s.agent.id())).ok();
    // answered: a second answer is forbidden; a take back opens it; then it is answered again and closed by its owner
    forbidden(s.w.ada.send(hub, &s.group, &object(wire::KIND_ANSWER, card_id, wire::TYPE_CARD, wire::STATE_ANSWERED, 2, v1, s.agent.id())));
    s.bea.send(hub, &s.group, &object(wire::KIND_TAKE_BACK, card_id, wire::TYPE_CARD, wire::STATE_OPEN, 2, v1, s.agent.id())).ok();
    forbidden(s.bea.send(hub, &s.group, &object(wire::KIND_TAKE_BACK, card_id, wire::TYPE_CARD, wire::STATE_OPEN, 2, v1, s.agent.id())));
    // a later version: only by the owner, on the current version
    forbidden(s.agent.send(hub, &s.group, &object(wire::KIND_VERSION, card_id, wire::TYPE_CARD, wire::STATE_CLOSED, 2, [5; 32], ZERO32)));
    s.agent.send(hub, &s.group, &object(wire::KIND_VERSION, card_id, wire::TYPE_CARD, wire::STATE_CLOSED, 2, v1, ZERO32)).ok();
    // a permission request and its verdict
    let request_id = wire::object_id(&s.group, &s.agent.id(), s.agent.chain(&s.group).0 + 1);
    s.agent.send(hub, &s.group, &object(wire::KIND_REQUEST, request_id, wire::TYPE_REQUEST, wire::STATE_OPEN, 3, ZERO32, ZERO32)).ok();
    let request_hash = s.agent.chain(&s.group).1;
    forbidden(s.agent.send(hub, &s.group, &object(wire::KIND_VERDICT, request_id, wire::TYPE_REQUEST, wire::STATE_CLOSED, 3, request_hash, s.agent.id())));
    s.w.ada.send(hub, &s.group, &object(wire::KIND_VERDICT, request_id, wire::TYPE_REQUEST, wire::STATE_CLOSED, 3, request_hash, s.agent.id())).ok();
    forbidden(s.bea.send(hub, &s.group, &object(wire::KIND_VERDICT, request_id, wire::TYPE_REQUEST, wire::STATE_CLOSED, 3, request_hash, s.agent.id())));

    // every envelope of the card, in order, void ones with their code
    let all = s.bea.get(hub, &format!("/v2/cards/{}", hex(&card_id))).ok();
    assert_eq!((all["state"].as_u64(), all["owner"].as_str()), (Some(3), Some(b64(&s.agent.id()).as_str())));
    let kinds: Vec<(u8, bool)> = all["items"].as_array().unwrap().iter().map(|i| (envelope_of(i).header.kind, i["void_code"].is_string())).collect();
    assert_eq!(kinds.iter().filter(|(_, void)| !void).map(|(k, _)| *k).collect::<Vec<_>>(), vec![2, 3, 7, 2]);
    assert!(kinds.iter().any(|(_, void)| *void));
    // the same id under another object's route does not exist; the agent of another session sees nothing
    s.bea.get(hub, &format!("/v2/notes/{}", hex(&card_id))).refused(404, "not-found");
    s.bea.get(hub, &format!("/v2/permission-requests/{}", b64(&request_id))).ok();
    s.bea.get(hub, &format!("/v2/notes/{}", hex(&note_id))).ok();
    s.agent.get(hub, &format!("/v2/notes/{}", hex(&note_id))).refused(404, "not-found");
}

#[test]
fn the_desk_lists_open_objects_by_urgency_and_every_writers_newest_register_value() {
    let mut s = scene();
    let (low, _) = card(&mut s, 0, 0);
    let (critical, _) = card(&mut s, 3, 0);
    let (normal, v) = card(&mut s, 1, 0);
    let (high, _) = card(&mut s, 2, 0);
    let (second_normal, _) = card(&mut s, 1, 0);
    let hub = &s.w.hub;
    // one is answered: it leaves the Desk
    s.bea.send(hub, &s.group, &object(wire::KIND_ANSWER, normal, wire::TYPE_CARD, wire::STATE_ANSWERED, 1, v, s.agent.id())).ok();
    // a permission request, an Artifact, a Note
    let request = wire::object_id(&s.group, &s.agent.id(), s.agent.chain(&s.group).0 + 1);
    s.agent.send(hub, &s.group, &object(wire::KIND_REQUEST, request, wire::TYPE_REQUEST, wire::STATE_OPEN, 2, ZERO32, ZERO32)).ok();
    let artifact = wire::object_id(&s.group, &s.agent.id(), s.agent.chain(&s.group).0 + 1);
    s.agent.send(hub, &s.group, &object(wire::KIND_VERSION, artifact, wire::TYPE_ARTIFACT, wire::STATE_OPEN, 1, ZERO32, ZERO32)).ok();
    let room = s.w.room;
    let note = wire::object_id(&room, &s.w.ada.id(), s.w.ada.chain(&room).0 + 1);
    s.w.ada.send(hub, &room, &object(wire::KIND_VERSION, note, wire::TYPE_NOTE, wire::STATE_OPEN, 0, ZERO32, ZERO32)).ok();
    // registers: two values under one id by one writer, one by another writer, one in the session
    let reg: [u8; 16] = random();
    s.w.ada.send(hub, &room, &register(&reg, "first")).ok();
    s.w.ada.send(hub, &room, &register(&reg, "second")).ok();
    let newest = s.w.ada.chain(&room).1;
    s.bea.send(hub, &room, &register(&reg, "bea's")).ok();
    s.agent.send(hub, &s.group, &register(&random(), "status line")).ok();

    let desk = s.bea.get(hub, "/v2/desk").ok();
    let order: Vec<String> = desk["cards"].as_array().unwrap().iter().map(|c| c["object_id"].as_str().unwrap().to_string()).collect();
    assert_eq!(order, vec![b64(&critical), b64(&high), b64(&second_normal), b64(&low)]);
    // each open object comes with its current version, in full
    assert!(desk["cards"].as_array().unwrap().iter().all(|c| envelope_of(&c["version"]).body.is_some()));
    assert_eq!(desk["permission_requests"][0]["object_id"], b64(&request));
    assert_eq!(desk["artifacts"][0]["object_id"], b64(&artifact));
    assert_eq!(desk["notes"][0]["object_id"], b64(&note));
    let registers: Vec<Envelope> = desk["registers"].as_array().unwrap().iter().map(envelope_of).collect();
    assert_eq!(registers.len(), 3);
    assert!(registers.iter().any(|e| e.hash() == newest) && registers.iter().all(|e| e.body.is_some()));
    assert_eq!(desk["groups"].as_array().unwrap().len(), 2);
    assert!(desk["change"].as_i64().unwrap() > 10);
    // the agent device: its session's objects and registers only
    let desk = s.agent.get(hub, "/v2/desk").ok();
    assert_eq!((desk["cards"].as_array().unwrap().len(), desk["notes"].as_array().unwrap().len(), desk["registers"].as_array().unwrap().len()), (4, 0, 1));
}

#[test]
fn a_chat_is_paged_newest_first_and_a_board_loads_from_a_change_number() {
    let mut s = scene();
    let hub = &s.w.hub;
    for i in 0..25 {
        s.agent.send(hub, &s.group, &chat(&s.session, ZERO32, &format!("message {i}"))).ok();
    }
    let path = format!("/v2/chats/session/{}/items", hex(&s.session));
    let mut seen: Vec<i64> = vec![];
    let mut before: Option<i64> = None;
    loop {
        let page = s.bea.get(hub, &match before {
            Some(b) => format!("{path}?before={b}&limit=10"),
            None => format!("{path}?limit=10"),
        }).ok();
        let items = page["items"].as_array().unwrap();
        seen.extend(items.iter().map(|i| i["change"].as_i64().unwrap()));
        before = seen.last().copied();
        if page["more"] != true {
            break;
        }
        assert_eq!(items.len(), 10);
    }
    assert_eq!(seen.len(), 25);
    assert!(seen.windows(2).all(|w| w[0] > w[1]), "newest first, no repeat");
    // a Chat of a session the asker is no leaf of, or that does not exist: nothing
    assert_eq!(s.agent.get(hub, &format!("/v2/chats/session/{}/items", hex(&random::<16>()))).ok()["items"], json!([]));
    s.bea.get(hub, "/v2/chats/desk/00/items").refused(400, "bad-format");

    // a board: items from a change number on, oldest first
    let room = s.w.room;
    let board: [u8; 16] = random();
    let other: [u8; 16] = random();
    for _ in 0..6 {
        s.w.ada.send(hub, &room, &board_item(&board)).ok();
        s.bea.send(hub, &room, &board_item(&other)).ok();
    }
    let all = s.bea.get(hub, &format!("/v2/boards/{}", hex(&board))).ok();
    let changes: Vec<i64> = all["items"].as_array().unwrap().iter().map(|i| i["change"].as_i64().unwrap()).collect();
    assert_eq!(changes.len(), 6);
    assert!(changes.windows(2).all(|w| w[0] < w[1]));
    let tail = s.bea.get(hub, &format!("/v2/boards/{}?after_change={}", hex(&board), changes[3])).ok();
    assert_eq!(tail["items"].as_array().unwrap().len(), 2);
    let paged = s.bea.get(hub, &format!("/v2/boards/{}?limit=4", b64(&board))).ok();
    assert_eq!((paged["items"].as_array().unwrap().len(), paged["more"].as_bool()), (4, Some(true)));
    // an agent device reads no board
    assert_eq!(s.agent.get(hub, &format!("/v2/boards/{}", hex(&board))).ok()["items"], json!([]));
    // a writer's chain after a frontier, in pruned form (10.3)
    let chain = s.bea.get(hub, &format!("/v2/groups/{}/chains/{}?after=4", b64(&room), b64(&s.w.ada.id()))).ok();
    let seqs: Vec<u64> = chain["items"].as_array().unwrap().iter().map(|i| envelope_of(i).header.seq).collect();
    assert_eq!(seqs, vec![5, 6]);
}

#[test]
fn what_lies_beyond_a_cut_leaves_every_index_as_if_it_had_never_come() {
    let mut s = scene();
    let room = s.w.room;
    // bea: a chat message the remover accepted (the Cut), then a message, an answer and a register the remover never saw
    let (card_id, v1) = card(&mut s, 1, 0);
    let hub2 = &s.w.hub;
    s.bea.send(hub2, &s.group, &chat(&s.session, s.agent.id(), "accepted")).ok();
    let cut = Cut { device: s.bea.id(), seq: s.bea.chain(&s.group).0, hash: s.bea.chain(&s.group).1 };
    s.bea.send(hub2, &s.group, &chat(&s.session, s.agent.id(), "beyond")).ok();
    s.bea.send(hub2, &s.group, &object(wire::KIND_ANSWER, card_id, wire::TYPE_CARD, wire::STATE_ANSWERED, 1, v1, s.agent.id())).ok();
    let reg: [u8; 16] = random();
    s.bea.send(hub2, &s.group, &register(&reg, "beyond")).ok();
    let before = s.w.ada.get(hub2, "/v2/desk").ok();
    assert_eq!(before["cards"], json!([]), "the card is answered");

    // removal from the room, then the Remove with the Cut in the session
    let now = s.w.ada.room_now();
    let room_cut = Cut { device: s.bea.id(), seq: s.bea.chain(&room).0, hash: s.bea.chain(&room).1 };
    let out = s.w.ada.commit(&room, &Change { removes: vec![s.bea.id()], cuts: vec![room_cut], ..Default::default() }, now);
    let sealed = s.w.ada.sealed_key(&room, out.epoch + 1, &out.group_info, out.epoch, &s.w.recovery.hpke_public, true);
    s.w.ada.post_commit(hub2, &out, &sealed).ok();
    let now = s.w.ada.room_now();
    // a Cut with another hash under that number is refused
    let wrong = Cut { hash: [9; 32], ..cut.clone() };
    let out = s.w.ada.commit(&s.group, &Change { removes: vec![s.bea.id()], cuts: vec![wrong], ..Default::default() }, now);
    let sealed = s.w.ada.sealed_key(&s.group, out.epoch + 1, &out.group_info, now.0, &s.w.recovery.hpke_public, true);
    s.w.ada.post_commit(hub2, &out, &sealed).refused(400, "bad-commit");
    let out = s.w.ada.commit(&s.group, &Change { removes: vec![s.bea.id()], cuts: vec![cut.clone()], ..Default::default() }, now);
    let sealed = s.w.ada.sealed_key(&s.group, out.epoch + 1, &out.group_info, now.0, &s.w.recovery.hpke_public, true);
    s.w.ada.post_commit(hub2, &out, &sealed).ok();

    // the answer never came: the card is open again; the Chat holds one message of bea; her register is gone
    let desk = s.w.ada.get(hub2, "/v2/desk").ok();
    assert_eq!(desk["cards"][0]["object_id"], b64(&card_id));
    assert_eq!(desk["cards"][0]["state"], 1);
    let chat_items = s.w.ada.get(hub2, &format!("/v2/chats/session/{}/items", hex(&s.session))).ok();
    assert_eq!(chat_items["items"].as_array().unwrap().len(), 1);
    assert!(!desk["registers"].as_array().unwrap().iter().any(|r| envelope_of(r).header.sender == s.bea.id() && envelope_of(r).header.group_id == s.group));
    let card_items = s.w.ada.get(hub2, &format!("/v2/cards/{}", hex(&card_id))).ok();
    assert_eq!(card_items["items"].as_array().unwrap().len(), 1);
    // catch-up no longer serves them; the chain route does, as evidence, marked cut
    let changes = s.w.ada.get(hub2, "/v2/changes?after=0&limit=1000").ok();
    assert!(!changes["items"].as_array().unwrap().iter().any(|i| i["cut"] == true));
    let chain = s.w.ada.get(hub2, &format!("/v2/groups/{}/chains/{}", b64(&s.group), b64(&s.bea.id()))).ok();
    let marks: Vec<bool> = chain["items"].as_array().unwrap().iter().map(|i| i["cut"] == true).collect();
    assert_eq!(marks, vec![false, true, true, true]);
}

#[test]
fn accepted_content_arrives_live_and_a_stream_resumes_by_change_number() {
    let mut s = scene();
    let hub = &s.w.hub;
    let mut human = s.bea.events(hub, None);
    let mut agent = s.agent.events(hub, None);
    s.w.ada.send(hub, &s.group, &chat(&s.session, s.agent.id(), "to the agent")).ok();
    let hash = s.w.ada.chain(&s.group).1;
    let e = human.until("envelope");
    assert_eq!(envelope_of(&e.data).hash(), hash);
    assert_eq!(e.id, e.data["change"].as_i64());
    assert_eq!(envelope_of(&agent.until("envelope").data).hash(), hash);
    // room content does not reach the agent device; a Commit of the room group does (it observes the room)
    let room = s.w.room;
    s.w.ada.send(hub, &room, &register(&random(), "desk")).ok();
    let now = s.w.ada.room_now();
    let out = s.w.ada.commit(&room, &Change::default(), now);
    let sealed = s.w.ada.sealed_key(&room, out.epoch + 1, &out.group_info, out.epoch, &s.w.recovery.hpke_public, true);
    s.w.ada.post_commit(hub, &out, &sealed).ok();
    let next = agent.until("log");
    assert_eq!((next.data["kind"].as_str(), next.data["group_id"].as_str()), (Some("commit"), Some(b64(&room).as_str())));
    assert_eq!(unb64(next.data["bytes"].as_str().unwrap()).unwrap(), out.commit);
    assert_eq!(human.until("envelope").data["change"].as_i64().unwrap() + 1, human.until("log").data["change"].as_i64().unwrap() - 0);
    // a stroke piece is relayed to the other human devices, never stored, not in the log
    let log_before = s.bea.get(hub, &format!("/v2/groups/{}/log", b64(&room))).ok()["items"].as_array().unwrap().len();
    catch_up(hub, &mut s.bea, &room);
    s.bea.post_message(hub, &room, b"piece", true).ok();
    let mut ada_events = s.w.ada.events(hub, None);
    s.bea.post_message(hub, &room, b"piece 2", true).ok();
    let relay = ada_events.until("relay");
    assert_eq!(relay.data["sender"], b64(&s.bea.id()));
    assert_eq!(s.bea.get(hub, &format!("/v2/groups/{}/log", b64(&room))).ok()["items"].as_array().unwrap().len(), log_before);
    // only the room group relays, and the agent device hears none of it
    s.agent.post_message(hub, &s.group, b"piece", true).refused(403, "forbidden");
    // a work trail step is stored in the session's log and reaches its leaves
    s.agent.post_message(hub, &s.group, b"step 1", false).ok();
    let e = human.until("log");
    assert_eq!((e.data["kind"].as_str(), e.data["group_id"].as_str()), (Some("message"), Some(b64(&s.group).as_str())));

    // resuming: everything above the given change number, in order, then live
    let all = s.bea.get(hub, "/v2/changes?after=0&limit=1000").ok();
    let all = all["items"].as_array().unwrap();
    let from = all[all.len() - 4]["change"].as_i64().unwrap();
    let mut resumed = s.bea.events(hub, Some(from));
    let mut got = vec![];
    for _ in 0..3 {
        got.push(resumed.next(Duration::from_secs(5)).unwrap().id.unwrap());
    }
    assert_eq!(got, all[all.len() - 3..].iter().map(|i| i["change"].as_i64().unwrap()).collect::<Vec<_>>());
    s.w.ada.send(hub, &s.group, &chat(&s.session, s.agent.id(), "after the catch-up")).ok();
    assert_eq!(envelope_of(&resumed.until("envelope").data).hash(), s.w.ada.chain(&s.group).1);
    // a device has a limit of streams
    let mut held = vec![];
    for _ in 0..8 {
        held.push(s.w.ada.events(hub, None));
    }
    assert!(held.iter().filter(|e| e.status == 429).count() >= 1);
}

#[test]
fn the_envelope_rate_limit_answers_with_retry_after() {
    let hub = TestHub::start_with(&[("HUB_LIMIT_ENVELOPES_PER_SECOND", "1"), ("HUB_LIMIT_ENVELOPE_BURST", "3")]);
    let mut w = World::on(hub);
    let room = w.room;
    for _ in 0..3 {
        w.ada.send(&w.hub, &room, &register(&random(), "x")).ok();
    }
    let limited = w.ada.send(&w.hub, &room, &register(&random(), "x"));
    limited.refused(429, "rate-limited");
    assert!(limited.header("retry-after").is_some());
    assert_eq!(w.ada.chain(&room).0, 3, "a rate-limited envelope took no number");
}
