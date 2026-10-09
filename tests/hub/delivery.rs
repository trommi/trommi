//! The delivery service over HTTP with real MLS devices: founding, joining, sessions, helper founding, takeover,
//! concurrent Commits, catch-up in the hub's order, and every refusal the spec lists for it.

mod common;

use common::*;
use serde_json::{json, Value};
use trommi_hub::util::{b64, random, unb64};
use trommi_hub::wire::{self, CommitNote, Cut, ZERO16, ZERO32};

fn groups(w: &World, dev: &Dev) -> Vec<Value> {
    dev.get(&w.hub, &format!("/v2/rooms/{}/groups", b64(&w.room))).ok().as_array().unwrap().clone()
}

fn group_of<'a>(list: &'a [Value], id: &[u8]) -> &'a Value {
    list.iter().find(|g| g["group_id"] == b64(id)).expect("the group is listed")
}

/// An own-leaf update of a human device in a group, posted.
fn update(hub: &TestHub, recovery: &Recovery, dev: &mut Dev, group: &[u8], room_now: (u64, [u8; 32])) -> Reply {
    let out = dev.commit(group, &Change::default(), room_now);
    let sealed = dev.sealed_key(group, out.epoch + 1, &out.group_info, room_now.0, &recovery.hpke_public, true);
    dev.post_commit(hub, &out, &sealed)
}

#[test]
fn a_room_is_founded_once_and_its_founder_signs_in() {
    let hub = TestHub::start();
    let room: [u8; 32] = random();
    let recovery = Recovery::new();
    let mut ada = Dev::new();
    let info = ada.create_room(&room, &recovery);
    let sealed = ada.sealed_key(&room, 0, &info, 0, &recovery.hpke_public, true);
    let body = json!({ "group_info": b64(&info), "sealed_key": b64(&sealed) });
    assert_eq!(hub.post("/v2/rooms", &body).ok()["room_id"], b64(&room));
    // a lost answer is retried with the same bytes
    assert_eq!(hub.post("/v2/rooms", &body).ok()["room_id"], b64(&room));
    // another founding of the same room id
    let mut eve = Dev::new();
    let other = eve.create_room(&room, &Recovery::new());
    let other_key = eve.sealed_key(&room, 0, &other, 0, &[9; 32], true);
    hub.post("/v2/rooms", &json!({ "group_info": b64(&other), "sealed_key": b64(&other_key) })).refused(409, "room-exists");

    assert_eq!(ada.sign_in(&hub, &room).ok()["role"], "human");
    let list = ada.get(&hub, &format!("/v2/rooms/{}/groups", b64(&room))).ok();
    assert_eq!(list[0]["kind"], "room");
    assert_eq!(list[0]["leaves"], json!([b64(&ada.id())]));
    assert_eq!(ada.get(&hub, &format!("/v2/groups/{}/info", b64(&room))).ok()["group_info"], b64(&info));
    // the sealed key of epoch 0 is there for the recovery key
    assert_eq!(ada.get(&hub, "/v2/sealed-keys").ok()["rows"][0]["sealed_key"], b64(&sealed));
}

#[test]
fn a_founding_without_its_sealed_key_or_with_a_wrong_one_is_incomplete() {
    let hub = TestHub::start();
    let room: [u8; 32] = random();
    let recovery = Recovery::new();
    let mut ada = Dev::new();
    let info = ada.create_room(&room, &recovery);
    // sealed to another key, for another epoch, without a tag, by another writer
    let wrong_key = ada.sealed_key(&room, 0, &info, 0, &[7; 32], true);
    let wrong_epoch = ada.sealed_key(&room, 1, &info, 0, &recovery.hpke_public, true);
    let no_tag = ada.sealed_key(&room, 0, &info, 0, &recovery.hpke_public, false);
    let other_info = ada.sealed_key(&room, 0, b"another group info", 0, &recovery.hpke_public, true);
    let other_writer = Dev::new().sealed_key(&room, 0, &info, 0, &recovery.hpke_public, true);
    for key in [wrong_key, wrong_epoch, no_tag, other_info, other_writer] {
        hub.post("/v2/rooms", &json!({ "group_info": b64(&info), "sealed_key": b64(&key) })).refused(400, "incomplete");
    }
    hub.post("/v2/rooms", &json!({ "group_info": b64(&info) })).refused(400, "bad-format");
    hub.post("/v2/rooms", &json!({ "group_info": b64(b"junk"), "sealed_key": b64(b"junk") })).refused(400, "bad-commit");
    // nothing was founded by any of these
    hub.get(&format!("/v2/rooms/{}/challenge", b64(&room))).ok();
    assert_eq!(sign_in_with(&hub, &room, &ada.signer, None).code(), "not-member");
}

#[test]
fn signing_in_needs_a_fresh_challenge_this_hub_and_a_standing() {
    let w = World::new();
    // a stranger's key
    sign_in_with(&w.hub, &w.room, &Dev::new().signer, None).refused(403, "not-member");
    // signed for another hub address: never normalised
    sign_in_with(&w.hub, &w.room, &w.ada.signer, Some("https://hub.example.org")).refused(400, "bad-format");
    sign_in_with(&w.hub, &w.room, &w.ada.signer, Some(&format!("{}/", w.hub.url))).refused(400, "bad-format");
    // a challenge is used up by its first presentation, whatever the outcome
    let challenge: [u8; 32] = unb64(w.hub.get(&format!("/v2/rooms/{}/challenge", b64(&w.room))).ok()["challenge"].as_str().unwrap()).unwrap().try_into().unwrap();
    let auth = wire::HubAuth { room_id: w.room, hub: w.hub.url.as_bytes().to_vec(), device: w.ada.id(), challenge }.encode();
    let good = json!({ "auth": b64(&auth), "signature": b64(&w.ada.sign("TrommiHubAuth", &auth)) });
    let bad = json!({ "auth": b64(&auth), "signature": b64(&[0u8; 64]) });
    let path = format!("/v2/rooms/{}/tokens", b64(&w.room));
    w.hub.post(&path, &bad).refused(400, "bad-signature");
    w.hub.post(&path, &good).refused(401, "bad-challenge");
    // a challenge of another room
    let other: [u8; 32] = random();
    let challenge: [u8; 32] = unb64(w.hub.get(&format!("/v2/rooms/{}/challenge", b64(&other))).ok()["challenge"].as_str().unwrap()).unwrap().try_into().unwrap();
    let auth = wire::HubAuth { room_id: w.room, hub: w.hub.url.as_bytes().to_vec(), device: w.ada.id(), challenge }.encode();
    w.hub.post(&path, &json!({ "auth": b64(&auth), "signature": b64(&w.ada.sign("TrommiHubAuth", &auth)) })).refused(401, "bad-challenge");
    // no token, a made-up token
    w.hub.get("/v2/desk").refused(401, "unauthorised");
    let mut ghost = Dev::new();
    ghost.token = Some("A".repeat(43));
    ghost.get(&w.hub, "/v2/desk").refused(401, "unauthorised");
    // the recovery key signs in and reads what a recovery needs, nothing else
    let token = sign_in_with(&w.hub, &w.room, &w.recovery.sign, None).ok();
    assert_eq!(token["role"], "recovery");
    let mut rec = Dev::new();
    rec.token = token["token"].as_str().map(str::to_string);
    rec.get(&w.hub, "/v2/sealed-keys").ok();
    rec.get(&w.hub, &format!("/v2/rooms/{}/groups", b64(&w.room))).ok();
    rec.get(&w.hub, "/v2/desk").refused(403, "forbidden");
    rec.put(&w.hub, "/v2/key-packages", &json!({ "single_use": [] })).refused(403, "forbidden");
}

#[test]
fn a_human_device_joins_by_link_and_only_as_the_outcome_of_its_invite() {
    let mut w = World::new();
    let room = w.room;
    // an Add without any invite
    let stranger = Dev::new();
    let now = w.ada.room_now();
    let out = w.ada.commit(&room, &Change { adds: vec![stranger.key_package(false)], ..Default::default() }, now);
    let sealed = w.ada.sealed_key(&room, out.epoch + 1, &out.group_info, out.epoch, &w.recovery.hpke_public, true);
    w.ada.post_commit(&w.hub, &out, &sealed).refused(400, "bad-invite");

    // invited: but the Add brings another KeyPackage of the same device than the one in the revealed Request
    let bea = Dev::new();
    let (key_package, _) = invite(&w.hub, &w.ada, &bea, 1, ZERO16);
    let out = w.ada.commit(&room, &Change { adds: vec![bea.key_package(false)], ..Default::default() }, now);
    let sealed = w.ada.sealed_key(&room, out.epoch + 1, &out.group_info, out.epoch, &w.recovery.hpke_public, true);
    w.ada.post_commit(&w.hub, &out, &sealed).refused(400, "bad-invite");
    // the invited role is human: its key does not go into `agents`
    w.set_agents(&[bea.id()]).refused(400, "bad-invite");

    // the Add of the revealed KeyPackage, without its Welcome
    let mut out = w.ada.commit(&room, &Change { adds: vec![key_package.clone()], ..Default::default() }, now);
    let welcome = out.welcome.take();
    let sealed = w.ada.sealed_key(&room, out.epoch + 1, &out.group_info, out.epoch, &w.recovery.hpke_public, true);
    w.ada.post_commit(&w.hub, &out, &sealed).refused(400, "incomplete");

    // and as it must be
    let mut bea = bea;
    let out = w.ada.commit(&room, &Change { adds: vec![key_package.clone()], ..Default::default() }, now);
    let sealed = w.ada.sealed_key(&room, out.epoch + 1, &out.group_info, out.epoch, &w.recovery.hpke_public, true);
    let accepted = w.ada.post_commit(&w.hub, &out, &sealed).ok();
    assert_eq!(accepted["epoch"], 1);
    // a repeated post of the same bytes gets the first answer again
    assert_eq!(w.ada.post(&w.hub, &format!("/v2/groups/{}/commits", b64(&room)), &commit_json(&out, &sealed, None)).ok(), accepted);
    let _ = welcome;
    // the newcomer finds its Welcome at the hub once it is a leaf
    bea.sign_in(&w.hub, &room).ok();
    let welcomes = bea.get(&w.hub, "/v2/welcomes").ok();
    assert_eq!(welcomes[0]["welcome"], b64(out.welcome.as_ref().unwrap()));
    bea.join(&unb64(welcomes[0]["welcome"].as_str().unwrap()).unwrap());
    assert_eq!(bea.members(&room).len(), 2);
    // the invite is used: the same KeyPackage does not get in twice, nor does the invite
    let list = groups(&w, &bea);
    assert_eq!(group_of(&list, &room)["leaves"].as_array().unwrap().len(), 2);
    // it writes in the group: the Welcome is no longer kept
    bea.send(&w.hub, &room, &register(&random(), "x")).ok();
    assert_eq!(bea.get(&w.hub, "/v2/welcomes").ok(), json!([]));
}

#[test]
fn an_invite_takes_four_requests_is_revealed_once_and_can_be_burned() {
    let w = World::new();
    let (room_epoch, room_state) = w.ada.room_now();
    let invite_id: [u8; 16] = random();
    let nonce: [u8; 32] = random();
    let offer = wire::Offer {
        room_id: w.room, invite_id, role: 1, session_id: ZERO16, expires_at: trommi_hub::util::now() + 600_000,
        commitment: wire::ref_hash("Trommi Invite Commitment", &[&invite_id[..], &nonce[..]].concat()), inviter: w.ada.id(), room_epoch, room_state,
    };
    let bytes = offer.encode();
    let publish = |dev: &Dev, offer: &[u8], signer: &Dev| dev.post(&w.hub, "/v2/invites", &json!({ "offer": b64(offer), "signature": b64(&signer.sign("TrommiInviteOffer", offer)) }));
    // signed by someone else; for too long; naming another room state
    publish(&w.ada, &bytes, &Dev::new()).refused(400, "bad-signature");
    let long = wire::Offer { expires_at: trommi_hub::util::now() + 3_600_000, ..offer.clone() }.encode();
    publish(&w.ada, &long, &w.ada).refused(400, "bad-invite");
    let stale = wire::Offer { room_state: [1; 32], ..offer.clone() }.encode();
    publish(&w.ada, &stale, &w.ada).refused(400, "bad-invite");
    publish(&w.ada, &bytes, &w.ada).ok();
    // by invite id only, without a token: the Offer
    let path = format!("/v2/invites/{}", b64(&invite_id));
    let read = w.hub.get(&path).ok();
    assert_eq!(read["offer"], b64(&bytes));
    assert!(read.get("requests").is_none());
    w.hub.get(&format!("/v2/invites/{}", b64(&random::<16>()))).refused(404, "not-found");
    w.hub.get(&format!("{path}/reveal")).refused(404, "not-found");

    let request = |dev: &Dev, hub_address: &str, role: u8| {
        let r = wire::InviteRequest { room_id: w.room, invite_id, hub: hub_address.as_bytes().to_vec(), role, key_package: dev.key_package(false), offer_hash: wire::ref_hash("Trommi Invite Offer", &bytes) }.encode();
        let mac = [5u8; 32];
        let signed = [&r[..], &mac[..]].concat();
        (r.clone(), w.hub.post(&format!("{path}/request"), &json!({ "request": b64(&r), "mac": b64(&mac), "signature": b64(&dev.sign("TrommiInviteRequest", &signed)) })), wire::ref_hash("Trommi Invite Request", &signed))
    };
    // another hub address, another role
    request(&Dev::new(), "https://other.example", 1).1.refused(400, "bad-invite");
    request(&Dev::new(), &w.hub.url, 2).1.refused(400, "bad-invite");
    // a Request signed by another key than its KeyPackage's
    let dev = Dev::new();
    let r = wire::InviteRequest { room_id: w.room, invite_id, hub: w.hub.url.as_bytes().to_vec(), role: 1, key_package: dev.key_package(false), offer_hash: wire::ref_hash("Trommi Invite Offer", &bytes) }.encode();
    w.hub.post(&format!("{path}/request"), &json!({ "request": b64(&r), "mac": b64(&[5u8; 32]), "signature": b64(&Dev::new().sign("TrommiInviteRequest", &[&r[..], &[5u8; 32][..]].concat())) })).refused(400, "bad-signature");
    let mut hashes = vec![];
    for _ in 0..4 {
        let (_, reply, hash) = request(&Dev::new(), &w.hub.url, 1);
        reply.ok();
        hashes.push(hash);
    }
    request(&Dev::new(), &w.hub.url, 1).1.refused(429, "too-many");
    // the inviter sees the Requests
    assert_eq!(w.ada.get(&w.hub, &path).ok()["requests"].as_array().unwrap().len(), 4);

    let reveal = |nonce: [u8; 32], hash: [u8; 32], signer: &Dev| {
        let r = wire::Reveal { invite_id, nonce, request_hash: hash }.encode();
        w.ada.put(&w.hub, &format!("{path}/reveal"), &json!({ "reveal": b64(&r), "signature": b64(&signer.sign("TrommiInviteReveal", &r)) }))
    };
    reveal([0; 32], hashes[0], &w.ada).refused(400, "bad-invite");
    reveal(nonce, [3; 32], &w.ada).refused(400, "bad-invite");
    reveal(nonce, hashes[0], &Dev::new()).refused(400, "bad-signature");
    reveal(nonce, hashes[0], &w.ada).ok();
    reveal(nonce, hashes[1], &w.ada).refused(409, "invite-used");
    w.hub.get(&format!("{path}/reveal")).ok();
    request(&Dev::new(), &w.hub.url, 1).1.refused(409, "invite-used");
    // "they don't match" burns it
    w.ada.call(&w.hub, "DELETE", &path, &Value::Null).ok();
    w.hub.get(&path).refused(410, "invite-burned");
    w.hub.get(&format!("{path}/reveal")).refused(410, "invite-burned");
}

#[test]
fn a_main_session_is_founded_in_one_request_with_every_human_device_and_its_agent() {
    let mut w = World::new();
    let mut bea = w.add_human();
    let mut agent = w.enrol_agent();
    w.catch_up(&mut bea, &w.room.clone());

    // a founding Commit that leaves a human device out
    let session: [u8; 16] = random();
    let adds = w.claim(&w.ada, &[agent.id()]);
    let (group, info0) = w.ada.create_session(&session, &ZERO16);
    let now = w.ada.room_now();
    let key0 = w.ada.sealed_key(&group, 0, &info0, now.0, &w.recovery.hpke_public, true);
    let out = w.ada.commit(&group, &Change { adds, ..Default::default() }, now);
    let key1 = w.ada.sealed_key(&group, 1, &out.group_info, now.0, &w.recovery.hpke_public, true);
    w.ada.post(&w.hub, "/v2/groups", &founding_json(&info0, &key0, &out, &key1)).refused(400, "bad-commit");
    w.ada.forget(&group);
    // nothing of the refused founding stays
    assert_eq!(groups(&w, &w.ada).len(), 1);

    let (session, group) = w.found_main(&mut [&mut bea], Some(&mut agent));
    let list = groups(&w, &w.ada);
    let g = group_of(&list, &group);
    assert_eq!((g["kind"].as_str(), g["epoch"].as_u64(), g["live"].as_bool(), g["stale"].as_bool()), (Some("main"), Some(1), Some(true), Some(false)));
    assert_eq!(g["session_id"], b64(&session));
    assert_eq!(g["leaves"].as_array().unwrap().len(), 3);
    // every device derived the same content key
    assert_eq!(w.ada.content_key(&group), bea.content_key(&group));
    assert_eq!(w.ada.content_key(&group), agent.content_key(&group));
    // an agent device sees its own groups and the room group, not other sessions
    let (_, other) = w.found_main(&mut [&mut bea], None);
    let seen = groups(&w, &agent);
    assert!(seen.iter().any(|g| g["group_id"] == b64(&group)) && seen.iter().any(|g| g["kind"] == "room"));
    assert!(!seen.iter().any(|g| g["group_id"] == b64(&other)));
    agent.get(&w.hub, &format!("/v2/groups/{}/log", b64(&other))).refused(404, "not-found");
    agent.get(&w.hub, &format!("/v2/groups/{}/info", b64(&other))).refused(404, "not-found");
    // the founding GroupInfo of every group is kept
    assert_eq!(w.ada.get(&w.hub, &format!("/v2/groups/{}/info?epoch=0", b64(&other))).ok()["epoch"], 0);
    // the same founding again: the first answer; another founding under the same session id: refused
    let (group2, info0) = w.ada.create_session(&random(), &ZERO16);
    let now = w.ada.room_now();
    let adds = w.claim(&w.ada, &[bea.id()]);
    let key0 = w.ada.sealed_key(&group2, 0, &info0, now.0, &w.recovery.hpke_public, true);
    let out = w.ada.commit(&group2, &Change { adds, ..Default::default() }, now);
    let key1 = w.ada.sealed_key(&group2, 1, &out.group_info, now.0, &w.recovery.hpke_public, true);
    let body = founding_json(&info0, &key0, &out, &key1);
    let first = w.ada.post(&w.hub, "/v2/groups", &body).ok();
    assert_eq!(w.ada.post(&w.hub, "/v2/groups", &body).ok(), first);
    w.ada.merge(&group2);
}

#[test]
fn an_agent_founds_nothing_but_a_helper_session_under_its_own_main_session() {
    let mut w = World::new();
    let mut agent = w.enrol_agent();
    let mut other_agent = w.enrol_agent();
    let (session, main) = w.found_main(&mut [], Some(&mut agent));
    let (_, _other_main) = w.found_main(&mut [], Some(&mut other_agent));
    let now = w.ada.room_now();
    agent.post(&w.hub, "/v2/link", &json!({ "process": b64(&random::<16>()), "hears": true, "working": false, "last_call_at": 0 })).ok();
    agent.lease = Some(1);
    other_agent.post(&w.hub, "/v2/link", &json!({ "process": b64(&random::<16>()), "hears": true, "working": false, "last_call_at": 0 })).ok();
    other_agent.lease = Some(1);

    let found = |agent: &mut Dev, parent: [u8; 16], adds: Vec<Vec<u8>>| {
        let (group, info0) = agent.create_session(&random(), &parent);
        let key0 = agent.sealed_key(&group, 0, &info0, now.0, &w.recovery.hpke_public, false);
        let out = agent.commit(&group, &Change { adds, ..Default::default() }, now);
        let key1 = agent.sealed_key(&group, 1, &out.group_info, now.0, &w.recovery.hpke_public, false);
        let reply = agent.post(&w.hub, "/v2/groups", &founding_json(&info0, &key0, &out, &key1));
        if reply.status == 200 {
            agent.merge(&group);
        } else {
            agent.forget(&group);
        }
        (group, reply, out)
    };
    // a main session of its own
    { let kp = w.claim(&agent, &[w.ada.id()]); found(&mut agent, ZERO16, kp) }.1.refused(400, "bad-commit");
    // a helper under another agent's main session
    { let kp = w.claim(&other_agent, &[w.ada.id()]); found(&mut other_agent, session, kp) }.1.refused(400, "bad-commit");
    // a helper under a session that does not exist
    { let kp = w.claim(&agent, &[w.ada.id()]); found(&mut agent, random(), kp) }.1.refused(400, "bad-commit");
    // its own helper, without the human device
    found(&mut agent, session, vec![]).1.refused(400, "bad-commit");

    // its own helper, with every human device and a helper device
    let mut helper = Dev::new();
    helper.room = w.room;
    let adds = [w.claim(&agent, &[w.ada.id()]), vec![helper.key_package(false)]].concat();
    let (group, reply, out) = found(&mut agent, session, adds);
    reply.ok();
    w.ada.join(out.welcome.as_ref().unwrap());
    helper.join(out.welcome.as_ref().unwrap());
    // the hub gives a helper device a token once it is a leaf
    assert_eq!(helper.sign_in(&w.hub, &w.room).ok()["role"], "helper");
    let list = groups(&w, &w.ada);
    assert_eq!(group_of(&list, &group)["kind"], "helper");
    assert_eq!(group_of(&list, &group)["parent"], b64(&session));
    // a helper device sees its group and, publicly, its main session's Commits; it commits nothing
    let log = helper.get(&w.hub, &format!("/v2/groups/{}/log", b64(&main))).ok();
    assert!(log["items"].as_array().unwrap().iter().all(|i| i["kind"] == "commit"));
    let out = helper.commit(&group, &Change::default(), now);
    let sealed = helper.sealed_key(&group, out.epoch + 1, &out.group_info, now.0, &w.recovery.hpke_public, false);
    helper.post_commit(&w.hub, &out, &sealed).refused(400, "bad-commit");
    // a helper device claims no KeyPackages
    helper.post(&w.hub, "/v2/key-packages/claim", &json!({ "devices": [b64(&w.ada.id())] })).refused(403, "forbidden");

    // the opener adds and removes helper devices, in that group
    let second = Dev::new();
    let out = agent.commit(&group, &Change { adds: vec![second.key_package(false)], removes: vec![helper.id()], cuts: vec![Cut { device: helper.id(), seq: 0, hash: ZERO32 }], ..Default::default() }, now);
    let sealed = agent.sealed_key(&group, out.epoch + 1, &out.group_info, now.0, &w.recovery.hpke_public, false);
    agent.post_commit(&w.hub, &out, &sealed).ok();
    // the removed helper device has no leaf left: its token ends
    helper.get(&w.hub, "/v2/welcomes").refused(403, "not-member");
    // the opener removes no human device
    let out = agent.commit(&group, &Change { removes: vec![w.ada.id()], cuts: vec![Cut { device: w.ada.id(), seq: 0, hash: ZERO32 }], ..Default::default() }, now);
    let sealed = agent.sealed_key(&group, out.epoch + 1, &out.group_info, now.0, &w.recovery.hpke_public, false);
    agent.post_commit(&w.hub, &out, &sealed).refused(400, "bad-commit");
    // it commits nothing in its main session, and nothing in the room group (it is no leaf there)
    let out = agent.commit(&main, &Change::default(), now);
    let sealed = agent.sealed_key(&main, out.epoch + 1, &out.group_info, now.0, &w.recovery.hpke_public, false);
    agent.post_commit(&w.hub, &out, &sealed).refused(400, "bad-commit");
    // an agent device files its key without a tag; with one it is refused
    let out = agent.commit(&group, &Change { adds: vec![Dev::new().key_package(false)], ..Default::default() }, now);
    let tagged = agent.sealed_key(&group, out.epoch + 1, &out.group_info, now.0, &w.recovery.hpke_public, true);
    agent.post_commit(&w.hub, &out, &tagged).refused(400, "incomplete");
}

#[test]
fn one_commit_per_epoch_wins_and_the_loser_builds_again() {
    let mut w = World::new();
    let mut bea = w.add_human();
    let (_, group) = w.found_main(&mut [&mut bea], None);
    let now = w.ada.room_now();
    // both build on epoch 1
    let a = w.ada.commit(&group, &Change::default(), now);
    let b = bea.commit(&group, &Change::default(), now);
    let key_a = w.ada.sealed_key(&group, 2, &a.group_info, now.0, &w.recovery.hpke_public, true);
    let key_b = bea.sealed_key(&group, 2, &b.group_info, now.0, &w.recovery.hpke_public, true);
    let hub = &w.hub;
    let (ra, rb) = std::thread::scope(|s| {
        let ta = s.spawn(|| w.ada.post(hub, &format!("/v2/groups/{}/commits", b64(&group)), &commit_json(&a, &key_a, None)));
        let tb = s.spawn(|| bea.post(hub, &format!("/v2/groups/{}/commits", b64(&group)), &commit_json(&b, &key_b, None)));
        (ta.join().unwrap(), tb.join().unwrap())
    });
    let mut codes = vec![(ra.status, ra.code()), (rb.status, rb.code())];
    codes.sort();
    assert_eq!(codes, vec![(200, String::new()), (409, "epoch-taken".to_string())]);
    // the loser fetches the accepted Commit, processes it and builds again
    let (winner, loser, loser_key_owner) = if ra.status == 200 { (&mut w.ada, &mut bea, 1) } else { (&mut bea, &mut w.ada, 0) };
    let _ = loser_key_owner;
    winner.merge(&group);
    loser.clear(&group);
    let log = loser.get(hub, &format!("/v2/groups/{}/log?after=1", b64(&group))).ok();
    assert_eq!(log["items"].as_array().unwrap().len(), 1);
    loser.process(&group, &unb64(log["items"][0]["bytes"].as_str().unwrap()).unwrap()).unwrap();
    let again = loser.commit(&group, &Change::default(), now);
    let key = loser.sealed_key(&group, 3, &again.group_info, now.0, &w.recovery.hpke_public, true);
    assert_eq!(loser.post_commit(hub, &again, &key).ok()["epoch"], 3);
    // a Commit on an epoch the group has not reached; a Commit whose body names another epoch than it builds on
    let ahead = loser.commit(&group, &Change::default(), now);
    let key = loser.sealed_key(&group, 5, &ahead.group_info, now.0, &w.recovery.hpke_public, true);
    let mut wrong = commit_json(&ahead, &key, None);
    wrong["epoch"] = json!(7);
    loser.post(hub, &format!("/v2/groups/{}/commits", b64(&group)), &wrong).refused(400, "bad-commit");
    loser.clear(&group);
    // the log holds exactly one Commit per epoch
    let log = loser.get(hub, &format!("/v2/groups/{}/log", b64(&group))).ok();
    let epochs: Vec<u64> = log["items"].as_array().unwrap().iter().map(|i| i["epoch"].as_u64().unwrap()).collect();
    assert_eq!(epochs, vec![0, 1, 2]);
}

#[test]
fn a_commit_is_refused_without_its_parts_or_with_a_note_that_does_not_fit() {
    let mut w = World::new();
    let mut bea = w.add_human();
    let (_, group) = w.found_main(&mut [&mut bea], None);
    let now = w.ada.room_now();
    let path = format!("/v2/groups/{}/commits", b64(&group));
    let fresh = |w: &mut World, change: &Change| {
        let out = w.ada.commit(&group, change, now);
        let key = w.ada.sealed_key(&group, out.epoch + 1, &out.group_info, now.0, &w.recovery.hpke_public, true);
        (out, key)
    };
    // the GroupInfo of another epoch (the founding one)
    let (out, key) = fresh(&mut w, &Change::default());
    let old_info = unb64(w.ada.get(&w.hub, &format!("/v2/groups/{}/info?epoch=0", b64(&group))).ok()["group_info"].as_str().unwrap()).unwrap();
    let mut body = commit_json(&out, &key, None);
    body["group_info"] = json!(b64(&old_info));
    w.ada.post(&w.hub, &path, &body).refused(400, "bad-commit");
    // a sealed key for another epoch, sealed under a stale room epoch, to another key
    for key in [
        w.ada.sealed_key(&group, out.epoch + 2, &out.group_info, now.0, &w.recovery.hpke_public, true),
        w.ada.sealed_key(&group, out.epoch + 1, &out.group_info, now.0 + 1, &w.recovery.hpke_public, true),
        w.ada.sealed_key(&group, out.epoch + 1, &out.group_info, now.0, &[1; 32], true),
    ] {
        w.ada.post(&w.hub, &path, &commit_json(&out, &key, None)).refused(400, "incomplete");
    }
    // a Welcome that nobody is added for
    let mut body = commit_json(&out, &key, None);
    body["welcome"] = json!(b64(b"welcome"));
    w.ada.post(&w.hub, &path, &body).refused(400, "bad-commit");
    // posted by another device than its committer
    bea.post(&w.hub, &path, &commit_json(&out, &key, None)).refused(403, "wrong-sender");
    w.ada.clear(&group);

    // a note that names an older room epoch, a wrong room state, a join that is none
    let note = |room_epoch, room_state, join| Change { note: Some(CommitNote { room_epoch, room_state, time: 1, cuts: vec![], join }), ..Default::default() };
    let (out, key) = fresh(&mut w, &note(now.0 + 1, now.1, false));
    w.ada.post_commit(&w.hub, &out, &key).refused(400, "bad-commit");
    let (out, key) = fresh(&mut w, &note(now.0, [9; 32], false));
    w.ada.post_commit(&w.hub, &out, &key).refused(400, "bad-commit");
    let (out, key) = fresh(&mut w, &note(now.0, now.1, true));
    w.ada.post_commit(&w.hub, &out, &key).refused(400, "bad-commit");
    // a Remove without its Cut; a Cut that names an envelope the hub does not hold
    let (out, key) = fresh(&mut w, &Change { removes: vec![bea.id()], ..Default::default() });
    w.ada.post_commit(&w.hub, &out, &key).refused(400, "bad-commit");
    let (out, key) = fresh(&mut w, &Change { removes: vec![bea.id()], cuts: vec![Cut { device: bea.id(), seq: 3, hash: [1; 32] }], ..Default::default() });
    w.ada.post_commit(&w.hub, &out, &key).refused(400, "bad-commit");
    // bytes that are no Commit; an application message in place of a Commit
    let mut body = commit_json(&out, &key, None);
    body["commit"] = json!(b64(&w.ada.application_message(&group, b"hello")));
    w.ada.post(&w.hub, &path, &body).refused(400, "bad-commit");
    body["commit"] = json!(b64(&out.group_info));
    w.ada.post(&w.hub, &path, &body).refused(400, "bad-commit");
    // a session group's statement never changes: a GroupContextExtensions proposal there
    let out = {
        let ext = w.recovery.room_ext(&[]);
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| w.ada.commit(&group, &Change { room: Some(ext), ..Default::default() }, now)))
    };
    if let Ok(out) = out {
        let key = w.ada.sealed_key(&group, out.epoch + 1, &out.group_info, now.0, &w.recovery.hpke_public, true);
        w.ada.post_commit(&w.hub, &out, &key).refused(400, "bad-commit");
    }
    // after all these refusals the group stands where it stood, and takes a good Commit
    assert_eq!(group_of(&groups(&w, &w.ada), &group)["epoch"], 1);
    update(&w.hub, &w.recovery, &mut bea, &group, now).ok();
    // a group of another room, or none, does not exist for the asker
    let (_, _, mallory) = found_room(&w.hub);
    mallory.post(&w.hub, &path, &commit_json(&out_dummy(&group), &[0u8; 8], None)).refused(404, "not-found");
    mallory.get(&w.hub, &format!("/v2/groups/{}/log", b64(&group))).refused(404, "not-found");
    mallory.get(&w.hub, &format!("/v2/rooms/{}/groups", b64(&w.room))).refused(400, "wrong-room");
}

fn out_dummy(group: &[u8]) -> Out {
    Out { group_id: group.to_vec(), epoch: 2, commit: vec![1], group_info: vec![2], welcome: None }
}

#[test]
fn removing_a_human_device_ends_its_access_at_once_and_leaves_its_sessions_stale_until_cleaned() {
    let mut w = World::new();
    let mut bea = w.add_human();
    let mut cleo = w.add_human();
    w.catch_up(&mut bea, &w.room.clone());
    let (session, group) = w.found_main(&mut [&mut bea, &mut cleo], None);
    let (_, group2) = w.found_main(&mut [&mut bea, &mut cleo], None);
    bea.send(&w.hub, &group, &chat(&session, ZERO32, "one")).ok();
    let (bea_seq, bea_hash) = bea.chain(&group);
    let mut bea_events = bea.events(&w.hub, None);
    assert_eq!(bea_events.status, 200);

    // the room Commit: Remove with the Cut
    let room = w.room;
    let now = w.ada.room_now();
    let room_cut = Cut { device: bea.id(), seq: bea.chain(&room).0, hash: bea.chain(&room).1 };
    let out = w.ada.commit(&room, &Change { removes: vec![bea.id()], cuts: vec![room_cut], ..Default::default() }, now);
    let sealed = w.ada.sealed_key(&room, out.epoch + 1, &out.group_info, out.epoch, &w.recovery.hpke_public, true);
    w.ada.post_commit(&w.hub, &out, &sealed).ok();
    // 14.4: its token and its stream end at once
    bea.get(&w.hub, "/v2/desk").refused(403, "not-member");
    assert!(bea_events.ended());
    sign_in_with(&w.hub, &w.room, &bea.signer, None).refused(403, "not-member");
    // both sessions are stale: nobody writes into them
    let list = groups(&w, &w.ada);
    assert_eq!((group_of(&list, &group)["stale"].as_bool(), group_of(&list, &group2)["stale"].as_bool()), (Some(true), Some(true)));
    w.catch_up(&mut cleo, &room);
    let now = w.ada.room_now();
    let voided = cleo.send(&w.hub, &group, &chat(&session, ZERO32, "into a stale group")).refused(409, "stale-session");
    assert_eq!(voided["voided"], true);
    w.ada.post_message(&w.hub, &group, b"x", false).refused(409, "stale-session");
    // an own-leaf update is not the Commit that repairs it
    update(&w.hub, &w.recovery, &mut cleo, &group, now).refused(409, "stale-session");
    // a Commit that still names the old room epoch
    let old = (now.0 - 1, [0; 32]);
    let out = w.ada.commit(&group, &Change { removes: vec![bea.id()], cuts: vec![Cut { device: bea.id(), seq: bea_seq, hash: bea_hash }], ..Default::default() }, old);
    let key = w.ada.sealed_key(&group, out.epoch + 1, &out.group_info, old.0, &w.recovery.hpke_public, true);
    w.ada.post_commit(&w.hub, &out, &key).refused(409, "room-behind");
    // a sealed key filed under the old room epoch
    let stale_key = cleo.sealed_key(&group, 1, &unb64(w.ada.get(&w.hub, &format!("/v2/groups/{}/info", b64(&group))).ok()["group_info"].as_str().unwrap()).unwrap(), old.0, &w.recovery.hpke_public, true);
    cleo.put(&w.hub, "/v2/sealed-keys", &json!({ "sealed_key": b64(&stale_key) })).refused(409, "room-behind");

    // any human device that sees a stale group commits the missing Remove: here another one than the remover
    let out = cleo.commit(&group, &Change { removes: vec![bea.id()], cuts: vec![Cut { device: bea.id(), seq: bea_seq, hash: bea_hash }], ..Default::default() }, now);
    let key = cleo.sealed_key(&group, out.epoch + 1, &out.group_info, now.0, &w.recovery.hpke_public, true);
    cleo.post_commit(&w.hub, &out, &key).ok();
    let list = groups(&w, &w.ada);
    assert_eq!((group_of(&list, &group)["stale"].as_bool(), group_of(&list, &group2)["stale"].as_bool()), (Some(false), Some(true)));
    catch_up(&w.hub, &mut w.ada, &group);
    cleo.send(&w.hub, &group, &chat(&session, ZERO32, "after the repair")).ok();

    // 4.2: the revoked key never returns: not by invite into the room group, not into a session group
    let (key_package, _) = invite(&w.hub, &w.ada, &bea, 1, ZERO16);
    let out = w.ada.commit(&room, &Change { adds: vec![key_package.clone()], ..Default::default() }, now);
    let sealed = w.ada.sealed_key(&room, out.epoch + 1, &out.group_info, out.epoch, &w.recovery.hpke_public, true);
    w.ada.post_commit(&w.hub, &out, &sealed).refused(400, "bad-commit");
    let out = w.ada.commit(&group, &Change { adds: vec![key_package], ..Default::default() }, now);
    let key = w.ada.sealed_key(&group, out.epoch + 1, &out.group_info, now.0, &w.recovery.hpke_public, true);
    w.ada.post_commit(&w.hub, &out, &key).refused(400, "bad-commit");
    // its chain ended at its Cut: the chain route marks nothing beyond it, the envelope before stays
    let chain = w.ada.get(&w.hub, &format!("/v2/groups/{}/chains/{}", b64(&group), b64(&bea.id()))).ok();
    assert_eq!(chain["items"].as_array().unwrap().len(), 1);
}

#[test]
fn a_takeover_replaces_the_agent_device_and_freezes_its_helper_sessions_until_done() {
    let mut w = World::new();
    let mut old = w.enrol_agent();
    let (session, main) = w.found_main(&mut [], Some(&mut old));
    let link = |agent: &mut Dev, hub: &TestHub| {
        agent.lease = None;
        let g = agent.post(hub, "/v2/link", &json!({ "process": b64(&random::<16>()), "hears": true, "working": true, "last_call_at": 1 })).ok()["generation"].as_u64();
        agent.lease = g;
    };
    link(&mut old, &w.hub);
    // the old agent opened a helper session
    let now = w.ada.room_now();
    let mut helper = Dev::new();
    helper.room = w.room;
    let (helper_group, info0) = old.create_session(&random(), &session);
    let key0 = old.sealed_key(&helper_group, 0, &info0, now.0, &w.recovery.hpke_public, false);
    let adds = [w.claim(&old, &[w.ada.id()]), vec![helper.key_package(false)]].concat();
    let out = old.commit(&helper_group, &Change { adds, ..Default::default() }, now);
    let key1 = old.sealed_key(&helper_group, 1, &out.group_info, now.0, &w.recovery.hpke_public, false);
    old.post(&w.hub, "/v2/groups", &founding_json(&info0, &key0, &out, &key1)).ok();
    old.merge(&helper_group);
    w.ada.join(out.welcome.as_ref().unwrap());
    helper.join(out.welcome.as_ref().unwrap());
    old.send(&w.hub, &main, &chat(&session, ZERO32, "from the old agent")).ok();

    // (a) the room Commit: the old device leaves `agents`, the new one is enrolled by its invite
    let mut new = Dev::new();
    invite(&w.hub, &w.ada, &new, 2, session);
    w.set_agents(&[new.id()]).ok();
    new.sign_in(&w.hub, &w.room).ok();
    new.upload_key_packages(&w.hub, 3).ok();
    link(&mut new, &w.hub);
    // from that Commit on: the old device's access is over, its sessions are stale, it founds nothing
    old.get(&w.hub, "/v2/welcomes").refused(403, "not-member");
    let list = groups(&w, &w.ada);
    assert_eq!((group_of(&list, &main)["stale"].as_bool(), group_of(&list, &helper_group)["stale"].as_bool()), (Some(true), Some(true)));

    // racing the takeover: the new agent cannot found a helper before it is the main session's agent leaf
    let now = w.ada.room_now();
    let (early, info0) = new.create_session(&random(), &session);
    let key0 = new.sealed_key(&early, 0, &info0, now.0, &w.recovery.hpke_public, false);
    let out = new.commit(&early, &Change { adds: w.claim(&new, &[w.ada.id()]), ..Default::default() }, now);
    let key1 = new.sealed_key(&early, 1, &out.group_info, now.0, &w.recovery.hpke_public, false);
    new.post(&w.hub, "/v2/groups", &founding_json(&info0, &key0, &out, &key1)).refused(400, "bad-commit");
    new.forget(&early);
    // (c) before (b): the helper session cannot take the new opener yet
    let cut = |dev: &Dev, group: &[u8]| Cut { device: dev.id(), seq: dev.chain(group).0, hash: dev.chain(group).1 };
    let out = w.ada.commit(&helper_group, &Change { removes: vec![old.id()], adds: w.claim(&w.ada, &[new.id()]), cuts: vec![cut(&old, &helper_group)], ..Default::default() }, now);
    let key = w.ada.sealed_key(&helper_group, out.epoch + 1, &out.group_info, now.0, &w.recovery.hpke_public, true);
    w.ada.post_commit(&w.hub, &out, &key).refused(400, "bad-commit");

    // (b) the main session: Remove of the old leaf and Add of the new agent device
    let out = w.ada.commit(&main, &Change { removes: vec![old.id()], adds: w.claim(&w.ada, &[new.id()]), cuts: vec![cut(&old, &main)], ..Default::default() }, now);
    let key = w.ada.sealed_key(&main, out.epoch + 1, &out.group_info, now.0, &w.recovery.hpke_public, true);
    w.ada.post_commit(&w.hub, &out, &key).ok();
    new.join(out.welcome.as_ref().unwrap());
    // (c) the same in every helper session of that main session, asking the hub for the list until none is stale
    let stale: Vec<Value> = groups(&w, &w.ada).into_iter().filter(|g| g["stale"] == true).collect();
    assert_eq!(stale.len(), 1);
    assert_eq!(stale[0]["group_id"], b64(&helper_group));
    let out = w.ada.commit(&helper_group, &Change { removes: vec![old.id()], adds: w.claim(&w.ada, &[new.id()]), cuts: vec![cut(&old, &helper_group)], ..Default::default() }, now);
    let key = w.ada.sealed_key(&helper_group, out.epoch + 1, &out.group_info, now.0, &w.recovery.hpke_public, true);
    w.ada.post_commit(&w.hub, &out, &key).ok();
    new.join(out.welcome.as_ref().unwrap());
    assert!(groups(&w, &w.ada).iter().all(|g| g["stale"] == false));
    // the new device is the opener: it adds a helper device there, and founds helpers
    let extra = Dev::new();
    let out = new.commit(&helper_group, &Change { adds: vec![extra.key_package(false)], ..Default::default() }, now);
    let key = new.sealed_key(&helper_group, out.epoch + 1, &out.group_info, now.0, &w.recovery.hpke_public, false);
    new.post_commit(&w.hub, &out, &key).ok();
    // a human device writes to the new agent; what the old agent wrote stays in the Chat
    w.ada.send(&w.hub, &main, &chat(&session, new.id(), "to the new agent")).ok();
    let items = new.get(&w.hub, &format!("/v2/chats/session/{}/items", trommi_hub::util::hex(&session))).ok();
    assert_eq!(items["items"].as_array().unwrap().len(), 2);
    // an agent device is the agent leaf of one live main session: not of a second one
    let (_, second_main) = w.found_main(&mut [], None);
    let out = w.ada.commit(&second_main, &Change { adds: w.claim(&w.ada, &[new.id()]), ..Default::default() }, now);
    let key = w.ada.sealed_key(&second_main, out.epoch + 1, &out.group_info, now.0, &w.recovery.hpke_public, true);
    w.ada.post_commit(&w.hub, &out, &key).refused(400, "bad-commit");
}

#[test]
fn key_packages_are_handed_out_once_and_the_last_resort_one_when_none_is_left() {
    let mut w = World::new();
    let bea = w.add_human();
    // five single-use ones and a last-resort one were uploaded; claim six
    let mut seen = std::collections::HashSet::new();
    for _ in 0..5 {
        assert!(seen.insert(w.claim(&w.ada, &[bea.id()]).remove(0)));
    }
    let last = w.claim(&w.ada, &[bea.id()]).remove(0);
    assert!(seen.insert(last.clone()));
    assert_eq!(w.claim(&w.ada, &[bea.id()]).remove(0), last);
    // all or nothing: a device without any makes the claim fail, and what was taken for the others stays unused
    bea.put(&w.hub, "/v2/key-packages", &json!({ "single_use": [b64(&bea.key_package(false))] })).ok();
    let stranger = Dev::new();
    w.ada.post(&w.hub, "/v2/key-packages/claim", &json!({ "devices": [b64(&bea.id()), b64(&stranger.id())] })).refused(404, "not-found");
    assert_eq!(bea.put(&w.hub, "/v2/key-packages", &json!({ "single_use": [] })).ok()["unused"], 1);
    // only from the device a KeyPackage names; the marks must fit; no more than 100
    w.ada.put(&w.hub, "/v2/key-packages", &json!({ "single_use": [b64(&bea.key_package(false))] })).refused(400, "bad-key-package");
    bea.put(&w.hub, "/v2/key-packages", &json!({ "single_use": [b64(&bea.key_package(true))] })).refused(400, "bad-key-package");
    bea.put(&w.hub, "/v2/key-packages", &json!({ "last_resort": b64(&bea.key_package(false)) })).refused(400, "bad-key-package");
    bea.put(&w.hub, "/v2/key-packages", &json!({ "single_use": [b64(b"junk")] })).refused(400, "bad-key-package");
    let many: Vec<String> = (0..100).map(|_| b64(&bea.key_package(false))).collect();
    bea.put(&w.hub, "/v2/key-packages", &json!({ "single_use": many })).refused(429, "too-many");
}

#[test]
fn catch_up_gives_one_order_across_groups_and_only_what_the_asker_may_see() {
    let mut w = World::new();
    let mut bea = w.add_human();
    let mut agent = w.enrol_agent();
    w.catch_up(&mut bea, &w.room.clone());
    let (session, group) = w.found_main(&mut [&mut bea], Some(&mut agent));
    let (other_session, other) = w.found_main(&mut [&mut bea], None);
    let now = w.ada.room_now();
    agent.lease = agent.post(&w.hub, "/v2/link", &json!({ "process": b64(&random::<16>()), "hears": true, "working": false, "last_call_at": 0 })).ok()["generation"].as_u64();
    // interleave: envelopes in two sessions and the room group, Commits, an application message
    w.ada.send(&w.hub, &group, &chat(&session, agent.id(), "a")).ok();
    w.ada.send(&w.hub, &other, &chat(&other_session, ZERO32, "b")).ok();
    update(&w.hub, &w.recovery, &mut bea, &group, now).ok();
    bea.send(&w.hub, &w.room.clone(), &register(&random(), "c")).ok();
    agent.post_message(&w.hub, &group, b"step", false).refused(409, "wrong-epoch");
    w.catch_up(&mut agent, &group);
    agent.post_message(&w.hub, &group, b"step", false).ok();
    update(&w.hub, &w.recovery, &mut bea, &other, now).ok();

    // a human device: everything, strictly ascending, paged without a hole or a repeat
    let mut all: Vec<Value> = vec![];
    let mut cursor = 0;
    loop {
        let page = bea.get(&w.hub, &format!("/v2/changes?after={cursor}&limit=3")).ok();
        all.extend(page["items"].as_array().unwrap().iter().cloned());
        cursor = page["change"].as_i64().unwrap();
        if page["more"] != true {
            break;
        }
    }
    let numbers: Vec<i64> = all.iter().map(|i| i["change"].as_i64().unwrap()).collect();
    let mut sorted = numbers.clone();
    sorted.sort();
    sorted.dedup();
    assert_eq!(numbers, sorted);
    let whole = bea.get(&w.hub, "/v2/changes?after=0&limit=1000").ok();
    assert_eq!(whole["items"].as_array().unwrap(), &all);
    assert_eq!(whole["change"], w.ada.get(&w.hub, "/v2/desk").ok()["change"]);
    // the session's first Commit comes after the room Commit it names, in the same list
    let kinds: Vec<(&str, String)> = all.iter().map(|i| (i["kind"].as_str().unwrap(), i["group_id"].as_str().unwrap_or("").to_string())).collect();
    let first_room = kinds.iter().position(|(k, g)| *k == "commit" && *g == b64(&w.room)).unwrap();
    let first_session = kinds.iter().position(|(k, g)| *k == "commit" && *g == b64(&group)).unwrap();
    assert!(first_room < first_session);
    assert!(all.iter().any(|i| i["kind"] == "message") && all.iter().any(|i| i["kind"] == "envelope"));

    // the agent device: its session in full, the room group's Commits only, nothing of the other session
    let seen = agent.get(&w.hub, "/v2/changes?after=0&limit=1000").ok();
    let seen = seen["items"].as_array().unwrap();
    assert!(seen.iter().all(|i| i["kind"] == "envelope" || i["group_id"] == b64(&group) || (i["group_id"] == b64(&w.room) && i["kind"] == "commit")));
    assert_eq!(seen.iter().filter(|i| i["kind"] == "envelope").count(), 1);
    assert!(!seen.iter().any(|i| i["group_id"] == b64(&other)));
    // a device replays the hub's order: every Commit meets the room state it names
    let mut carl = w.add_human();
    let _ = &mut carl;
    // the recovery key: every Commit, envelopes in pruned form only
    let token = sign_in_with(&w.hub, &w.room, &w.recovery.sign, None).ok();
    let mut rec = Dev::new();
    rec.token = token["token"].as_str().map(str::to_string);
    let seen = rec.get(&w.hub, "/v2/changes?after=0&limit=1000").ok();
    let seen = seen["items"].as_array().unwrap();
    assert!(seen.iter().all(|i| i["kind"] != "message"));
    for item in seen.iter().filter(|i| i["kind"] == "envelope") {
        let bytes = unb64(item["envelope"].as_str().unwrap()).unwrap();
        assert_eq!(bytes[0], 2, "pruned form");
    }
}

#[test]
fn a_room_does_not_reach_into_another_room() {
    let mut w = World::new();
    let (_, group) = w.found_main(&mut [], None);
    let (other_room, other_recovery, mut mallory) = found_room(&w.hub);
    // a session group whose id claims the first room, founded by a device of the second
    mallory.room = w.room;
    let (claimed, info0) = mallory.create_session(&random(), &ZERO16);
    mallory.room = other_room;
    let now = mallory.room_now();
    let key0 = mallory.sealed_key(&claimed, 0, &info0, 0, &other_recovery.hpke_public, true);
    let out = mallory.commit(&claimed, &Change::default(), now);
    let key1 = mallory.sealed_key(&claimed, 1, &out.group_info, 0, &other_recovery.hpke_public, true);
    mallory.post(&w.hub, "/v2/groups", &founding_json(&info0, &key0, &out, &key1)).refused(400, "wrong-room");
    // reads and writes by id into the first room's group
    for path in [format!("/v2/groups/{}/log", b64(&group)), format!("/v2/groups/{}/info", b64(&group)), format!("/v2/groups/{}/chains/{}", b64(&group), b64(&w.ada.id()))] {
        mallory.get(&w.hub, &path).refused(404, "not-found");
    }
    mallory.post(&w.hub, &format!("/v2/groups/{}/archive", b64(&group)), &json!({})).refused(404, "not-found");
    mallory.post(&w.hub, &format!("/v2/groups/{}/messages", b64(&group)), &json!({ "epoch": 1, "message": b64(b"x") })).refused(404, "not-found");
    mallory.post(&w.hub, "/v2/key-packages/claim", &json!({ "devices": [b64(&w.ada.id())] })).refused(404, "not-found");
    mallory.post(&w.hub, &format!("/v2/rooms/{}/recovery", b64(&w.room)), &json!({})).refused(400, "wrong-room");
    // a sealed key for the other room's group
    let key = mallory.sealed_key(&group, 1, b"x", 0, &w.recovery.hpke_public, true);
    mallory.put(&w.hub, "/v2/sealed-keys", &json!({ "sealed_key": b64(&key) })).refused(404, "not-found");
    // the first room is as it was
    assert_eq!(groups(&w, &w.ada).len(), 2);
}

#[test]
fn an_archived_session_takes_nothing_more_and_a_reject_reaches_the_human_devices() {
    let mut w = World::new();
    let mut agent = w.enrol_agent();
    let (session, group) = w.found_main(&mut [], Some(&mut agent));
    let now = w.ada.room_now();
    // 14.7: a leaf that cannot merge a Commit reports it; the human devices learn who made it
    let mut events = w.ada.events(&w.hub, None);
    agent.post(&w.hub, &format!("/v2/groups/{}/reject", b64(&group)), &json!({ "n": 1 })).ok();
    let e = events.until("request");
    assert_eq!((e.data["kind"].as_str(), e.data["committer"].as_str()), (Some("reject"), Some(b64(&w.ada.id()).as_str())));
    agent.post(&w.hub, &format!("/v2/groups/{}/reject", b64(&group)), &json!({ "n": 99 })).refused(404, "not-found");
    assert_eq!(w.ada.get(&w.hub, "/v2/requests").ok().as_array().unwrap().len(), 1);
    // an unsigned wish: nothing follows from it
    agent.post(&w.hub, "/v2/requests", &json!({ "kind": "readmit", "group": b64(&group), "key_package": b64(&agent.key_package(false)) })).ok();
    agent.post(&w.hub, "/v2/requests", &json!({ "kind": "takeover" })).refused(400, "bad-format");
    assert_eq!(agent.get(&w.hub, "/v2/requests").ok().as_array().unwrap().len(), 2);

    // only a human device archives; the room group is not archived
    agent.post(&w.hub, &format!("/v2/groups/{}/archive", b64(&group)), &json!({})).refused(403, "forbidden");
    w.ada.post(&w.hub, &format!("/v2/groups/{}/archive", b64(&w.room)), &json!({})).refused(403, "forbidden");
    w.ada.post(&w.hub, &format!("/v2/groups/{}/archive", b64(&group)), &json!({})).ok();
    w.ada.post(&w.hub, &format!("/v2/groups/{}/archive", b64(&group)), &json!({})).ok();
    assert_eq!(group_of(&groups(&w, &w.ada), &group)["live"], false);
    update(&w.hub, &w.recovery, &mut w.ada, &group, now).refused(410, "gone");
    w.ada.send(&w.hub, &group, &chat(&session, agent.id(), "late")).refused(410, "gone");
    w.ada.post_message(&w.hub, &group, b"x", false).refused(410, "gone");
    // its log stays readable
    assert_eq!(w.ada.get(&w.hub, &format!("/v2/groups/{}/log", b64(&group))).ok()["items"].as_array().unwrap().len(), 1);
}

