//! What depends on the passing of time, with the hub's clock moved instead of waiting: lifetimes of challenges,
//! tokens, invites, leases, the two minutes of an ended epoch, the recovery's ten minutes, unreferenced uploads,
//! share links, retention after 30 days, KeyPackages after 90. One test: the clock belongs to the whole process.

mod common;

use common::*;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use trommi_hub::util::{b64, hex, random, unb64};
use trommi_hub::wire::{self, Envelope, Subject, ZERO16, ZERO32};

const MINUTE: i64 = 60_000;
const DAY: i64 = 86_400_000;

fn envelope_of(item: &Value) -> Envelope {
    Envelope::parse(&unb64(item["envelope"].as_str().unwrap()).unwrap()).unwrap()
}

#[test]
fn lifetimes_and_retention() {
    let mut w = World::new();
    let mut bea = w.add_human();
    let mut agent = w.enrol_agent();
    w.catch_up(&mut bea, &w.room.clone());
    let (session, group) = w.found_main(&mut [&mut bea], Some(&mut agent));
    let room = w.room;
    let hub = &w.hub;
    let again = |devs: &mut [&mut Dev]| {
        for d in devs.iter_mut() {
            d.sign_in(hub, &room).ok();
        }
    };

    // ---- a challenge lasts two minutes
    let challenge: [u8; 32] = unb64(
        hub.get(&format!("/v2/rooms/{}/challenge", b64(&room))).ok()["challenge"]
            .as_str()
            .unwrap(),
    )
    .unwrap()
    .try_into()
    .unwrap();
    hub.clock(2 * MINUTE + 1000);
    let auth = wire::HubAuth {
        room_id: room,
        hub: hub.url.as_bytes().to_vec(),
        device: w.ada.id(),
        challenge,
    }
    .encode();
    hub.post(
        &format!("/v2/rooms/{}/tokens", b64(&room)),
        &json!({ "auth": b64(&auth), "signature": b64(&w.ada.sign("TrommiHubAuth", &auth)) }),
    )
    .refused(401, "bad-challenge");

    // ---- a token lasts ten minutes
    w.ada.get(hub, "/v2/desk").ok();
    hub.clock(8 * MINUTE);
    w.ada.get(hub, "/v2/desk").refused(401, "unauthorised");
    again(&mut [&mut w.ada, &mut bea, &mut agent]);

    // ---- an agent's lease lasts 60 seconds unless renewed
    agent.link(hub).ok();
    agent
        .send(hub, &group, &chat(&session, ZERO32, "under the lease"))
        .ok();
    hub.clock(MINUTE + 1000);
    agent
        .send(hub, &group, &chat(&session, ZERO32, "after it ran out"))
        .refused(409, "lease-lost");
    agent.link(hub).ok();

    // ---- an envelope of the epoch before is taken for two minutes after the Commit, then it is a void record
    let old_key = bea.content_key(&group);
    let now = w.ada.room_now();
    let out = w.ada.commit(&group, &Change::default(), now);
    let sealed = w.ada.sealed_key(
        &group,
        2,
        &out.group_info,
        now.0,
        &w.recovery.hpke_public,
        true,
    );
    w.ada.post_commit(hub, &out, &sealed).ok();
    let late = |bea: &mut Dev, text: &str| {
        let (seq, prev) = bea.chain(&group);
        let (bytes, hash) = bea.build_envelope(
            &group,
            1,
            seq + 1,
            prev,
            &chat(&session, agent.id(), text),
            &old_key,
        );
        bea.chains.insert(group.clone(), (seq + 1, hash));
        bea.post_envelope(hub, &bytes)
    };
    late(&mut bea, "within two minutes").ok();
    hub.clock(2 * MINUTE + 1000);
    assert_eq!(
        late(&mut bea, "too late").refused(409, "wrong-epoch")["voided"],
        true
    );
    catch_up(hub, &mut bea, &group);
    catch_up(hub, &mut agent, &group);
    agent.link(hub).ok();

    // ---- an invite lives ten minutes
    let (room_epoch, room_state) = w.ada.room_now();
    let invite_id: [u8; 16] = random();
    let offer = wire::Offer {
        room_id: room,
        invite_id,
        role: 1,
        session_id: ZERO16,
        expires_at: trommi_hub::util::now() + 10 * MINUTE as u64,
        commitment: [1; 32],
        inviter: w.ada.id(),
        room_epoch,
        room_state,
    }
    .encode();
    w.ada.post(hub, "/v2/invites", &json!({ "offer": b64(&offer), "signature": b64(&w.ada.sign("TrommiInviteOffer", &offer)) })).ok();
    hub.get(&format!("/v2/invites/{}", b64(&invite_id))).ok();

    // ---- a recovery locks the room for ten minutes, then it is over by itself
    let mut rec = Dev::new();
    rec.token = sign_in_with(hub, &room, &w.recovery.sign, None).ok()["token"]
        .as_str()
        .map(str::to_string);
    let opened = rec
        .post(
            hub,
            &format!("/v2/rooms/{}/recovery", b64(&room)),
            &json!({}),
        )
        .ok();
    w.ada
        .send(hub, &room, &register(&random(), "x"))
        .refused(503, "overloaded");
    hub.clock(10 * MINUTE + 1000);
    hub.get(&format!("/v2/invites/{}", b64(&invite_id)))
        .refused(410, "invite-expired");
    again(&mut [&mut w.ada, &mut bea, &mut agent]);
    agent.link(hub).ok();
    w.ada.send(hub, &room, &register(&random(), "x")).ok();
    rec.token = sign_in_with(hub, &room, &w.recovery.sign, None).ok()["token"]
        .as_str()
        .map(str::to_string);
    rec.post(
        hub,
        &format!(
            "/v2/rooms/{}/recovery/{}/finish",
            b64(&room),
            opened["recovery_id"].as_str().unwrap()
        ),
        &json!({ "recovery_link": b64(&[0u8; 8]) }),
    )
    .refused(410, "gone");
    rec.post(
        hub,
        &format!("/v2/rooms/{}/recovery", b64(&room)),
        &json!({}),
    )
    .ok();
    hub.clock(10 * MINUTE + 1000);
    again(&mut [&mut w.ada, &mut bea, &mut agent]);
    agent.link(hub).ok();

    // ---- an upload that no envelope names within an hour is deleted; a named one stays
    let (loose, named): ([u8; 16], [u8; 16]) = (random(), random());
    agent
        .raw(
            hub,
            "PUT",
            &format!("/v2/files/{}", b64(&loose)),
            &[],
            b"nobody names me",
        )
        .ok();
    agent
        .raw(
            hub,
            "PUT",
            &format!("/v2/files/{}", b64(&named)),
            &[],
            b"an attachment of the card",
        )
        .ok();

    // ---- content for the retention: cards open, answered, closed, closed and reopened; a permission request;
    // an Artifact with a share; a Note; a card Chat with the file; a work trail
    let first_version = |agent: &mut Dev, object_type: u8, files: Vec<[u8; 16]>| {
        let id = wire::object_id(&group, &agent.id(), agent.chain(&group).0 + 1);
        let kind = if object_type == wire::TYPE_REQUEST {
            wire::KIND_REQUEST
        } else {
            wire::KIND_VERSION
        };
        let mut item = object(kind, id, object_type, wire::STATE_OPEN, 1, ZERO32, ZERO32);
        item.file_ids = files;
        agent.send(hub, &group, &item).ok();
        (id, agent.chain(&group).1)
    };
    let (open_card, _) = first_version(&mut agent, wire::TYPE_CARD, vec![]);
    let (answered_card, answered_v) = first_version(&mut agent, wire::TYPE_CARD, vec![]);
    let (closed_card, closed_v) = first_version(&mut agent, wire::TYPE_CARD, vec![named]);
    let (reopened_card, reopened_v) = first_version(&mut agent, wire::TYPE_CARD, vec![]);
    let (permission, permission_v) = first_version(&mut agent, wire::TYPE_REQUEST, vec![]);
    let share_file: [u8; 16] = random();
    agent
        .raw(
            hub,
            "PUT",
            &format!("/v2/files/{}", b64(&share_file)),
            &[],
            b"a published page",
        )
        .ok();
    let (artifact_id, _) = first_version(&mut agent, wire::TYPE_ARTIFACT, vec![share_file]);
    let (share, secret): ([u8; 16], [u8; 32]) = (random(), random());
    agent.post(hub, "/v2/shares", &json!({ "share_id": b64(&share), "secret_hash": b64(&Sha256::digest(secret)), "file_id": b64(&share_file), "expires_at": trommi_hub::util::now() + 40 * DAY as u64 })).ok();
    let note = wire::object_id(&room, &w.ada.id(), w.ada.chain(&room).0 + 1);
    w.ada
        .send(
            hub,
            &room,
            &object(
                wire::KIND_VERSION,
                note,
                wire::TYPE_NOTE,
                wire::STATE_OPEN,
                0,
                ZERO32,
                ZERO32,
            ),
        )
        .ok();
    bea.send(
        hub,
        &group,
        &object(
            wire::KIND_ANSWER,
            answered_card,
            wire::TYPE_CARD,
            wire::STATE_ANSWERED,
            1,
            answered_v,
            agent.id(),
        ),
    )
    .ok();
    let card_chat = Item {
        subject: Subject::Item {
            timeline_kind: 1,
            timeline_scope: 1,
            timeline_ref: closed_card,
        },
        ..chat(&ZERO16, agent.id(), "about the closed card")
    };
    bea.send(hub, &group, &card_chat).ok();
    agent
        .send(
            hub,
            &group,
            &object(
                wire::KIND_VERSION,
                closed_card,
                wire::TYPE_CARD,
                wire::STATE_CLOSED,
                1,
                closed_v,
                ZERO32,
            ),
        )
        .ok();
    agent
        .send(
            hub,
            &group,
            &object(
                wire::KIND_VERSION,
                reopened_card,
                wire::TYPE_CARD,
                wire::STATE_CLOSED,
                1,
                reopened_v,
                ZERO32,
            ),
        )
        .ok();
    let reopened_v2 = agent.chain(&group).1;
    w.ada
        .send(
            hub,
            &group,
            &object(
                wire::KIND_VERDICT,
                permission,
                wire::TYPE_REQUEST,
                wire::STATE_CLOSED,
                1,
                permission_v,
                agent.id(),
            ),
        )
        .ok();
    agent
        .post_message(hub, &group, b"a step of the work trail", false)
        .ok();
    let log_before = w
        .ada
        .get(hub, &format!("/v2/groups/{}/log", b64(&group)))
        .ok()["items"]
        .as_array()
        .unwrap()
        .len();
    let closed_before = w
        .ada
        .get(hub, &format!("/v2/cards/{}", hex(&closed_card)))
        .ok();
    assert!(closed_before["items"]
        .as_array()
        .unwrap()
        .iter()
        .all(|i| envelope_of(i).body.is_some()));

    // one hour later: the unnamed upload is gone, the named ones are there
    hub.clock(61 * MINUTE);
    again(&mut [&mut w.ada, &mut bea, &mut agent]);
    agent.link(hub).ok();
    hub.post("/v2/__test/sweep", &json!({})).ok();
    agent
        .raw(hub, "GET", &format!("/v2/files/{}", b64(&loose)), &[], &[])
        .refused(404, "not-found");
    assert_eq!(
        w.ada
            .raw(hub, "GET", &format!("/v2/files/{}", b64(&named)), &[], &[])
            .body,
        b"an attachment of the card"
    );
    assert!(!hub
        .dir
        .join("files")
        .join(hex(&room))
        .join(hex(&loose))
        .exists());

    // 29 days after closing: nothing is pruned yet. The reopened card is opened again.
    hub.clock(29 * DAY);
    again(&mut [&mut w.ada, &mut bea, &mut agent]);
    agent.link(hub).ok();
    assert_eq!(
        hub.post("/v2/__test/retention", &json!({})).ok()["pruned"],
        0
    );
    agent
        .send(
            hub,
            &group,
            &object(
                wire::KIND_VERSION,
                reopened_card,
                wire::TYPE_CARD,
                wire::STATE_OPEN,
                1,
                reopened_v2,
                ZERO32,
            ),
        )
        .ok();

    // 30 days and more: the bodies of what is answered or closed go; header, hash and signature stay
    hub.clock(2 * DAY);
    again(&mut [&mut w.ada, &mut bea, &mut agent]);
    agent.link(hub).ok();
    assert_eq!(
        hub.post("/v2/__test/retention", &json!({})).ok()["pruned"],
        3,
        "the answered card, the closed card, the permission request"
    );
    assert_eq!(
        hub.post("/v2/__test/retention", &json!({})).ok()["pruned"],
        0
    );
    let closed_after = w
        .ada
        .get(hub, &format!("/v2/cards/{}", hex(&closed_card)))
        .ok();
    assert_eq!(
        closed_before["items"].as_array().unwrap().len(),
        closed_after["items"].as_array().unwrap().len()
    );
    for (before, after) in closed_before["items"]
        .as_array()
        .unwrap()
        .iter()
        .zip(closed_after["items"].as_array().unwrap())
    {
        let (b, a) = (envelope_of(before), envelope_of(after));
        assert!(a.body.is_none(), "served in pruned form");
        assert_eq!(
            (a.hash(), &a.signature, &a.header),
            (b.hash(), &b.signature, &b.header)
        );
    }
    for (kind, id) in [
        ("cards", answered_card),
        ("permission-requests", permission),
    ] {
        let items = w.ada.get(hub, &format!("/v2/{kind}/{}", hex(&id))).ok();
        assert!(items["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|i| envelope_of(i).body.is_none()));
    }
    // its card Chat too, and its files
    let chat_items = w
        .ada
        .get(hub, &format!("/v2/chats/card/{}/items", hex(&closed_card)))
        .ok();
    assert_eq!(chat_items["items"].as_array().unwrap().len(), 1);
    assert!(envelope_of(&chat_items["items"][0]).body.is_none());
    w.ada
        .raw(hub, "GET", &format!("/v2/files/{}", b64(&named)), &[], &[])
        .refused(404, "not-found");
    // what arrives later for a card whose bodies were pruned is pruned with the next run
    let late_chat = Item {
        subject: Subject::Item {
            timeline_kind: 1,
            timeline_scope: 1,
            timeline_ref: closed_card,
        },
        ..chat(&ZERO16, agent.id(), "long after")
    };
    bea.send(hub, &group, &late_chat).ok();
    assert_eq!(
        hub.post("/v2/__test/retention", &json!({})).ok()["pruned"],
        1
    );
    let chat_items = w
        .ada
        .get(hub, &format!("/v2/chats/card/{}/items", hex(&closed_card)))
        .ok();
    assert_eq!(chat_items["items"].as_array().unwrap().len(), 2);
    assert!(chat_items["items"]
        .as_array()
        .unwrap()
        .iter()
        .all(|i| envelope_of(i).body.is_none()));
    // untouched: the open card, the reopened card, the Note (never pruned), the session's Chat, the open Artifact
    for (kind, id) in [
        ("cards", open_card),
        ("cards", reopened_card),
        ("notes", note),
        ("artifacts", artifact_id),
    ] {
        let items = w.ada.get(hub, &format!("/v2/{kind}/{}", hex(&id))).ok();
        assert!(
            items["items"]
                .as_array()
                .unwrap()
                .iter()
                .all(|i| envelope_of(i).body.is_some()),
            "{kind}"
        );
    }
    let session_chat = w
        .ada
        .get(hub, &format!("/v2/chats/session/{}/items", hex(&session)))
        .ok();
    assert!(session_chat["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|i| i["void_code"].is_null())
        .all(|i| envelope_of(i).body.is_some()));
    // a chain still verifies through the pruned envelopes: every hash links to the one before
    let chain = w
        .ada
        .get(
            hub,
            &format!("/v2/groups/{}/chains/{}", b64(&group), b64(&agent.id())),
        )
        .ok();
    let mut prev = ZERO32;
    for item in chain["items"].as_array().unwrap() {
        let e = envelope_of(item);
        assert_eq!(e.header.prev, prev);
        prev = e.hash();
    }
    // the work trail is gone after 30 days; every Commit stays
    let log = w
        .ada
        .get(hub, &format!("/v2/groups/{}/log", b64(&group)))
        .ok();
    let log = log["items"].as_array().unwrap();
    assert_eq!(log.len(), log_before - 1);
    assert!(log.iter().all(|i| i["kind"] == "commit"));
    // the Desk shows what is open, as before
    let desk = w.ada.get(hub, "/v2/desk").ok();
    assert_eq!(desk["cards"].as_array().unwrap().len(), 2);

    // ---- a Share link ends at its expiry
    let open_share = || {
        request(
            hub.port,
            "GET",
            &format!("/v2/shares/{}", b64(&share)),
            &[("x-share-secret", b64(&secret))],
            &[],
        )
    };
    assert_eq!(open_share().body, b"a published page");
    hub.clock(10 * DAY);
    open_share().refused(404, "not-found");

    // ---- no KeyPackage uploaded more than 90 days ago is handed out
    again(&mut [&mut w.ada, &mut bea, &mut agent]);
    assert!(
        w.ada
            .post(
                hub,
                "/v2/key-packages/claim",
                &json!({ "devices": [b64(&bea.id())] })
            )
            .status
            == 200
    );
    hub.clock(50 * DAY);
    again(&mut [&mut w.ada, &mut bea, &mut agent]);
    w.ada
        .post(
            hub,
            "/v2/key-packages/claim",
            &json!({ "devices": [b64(&bea.id())] }),
        )
        .refused(404, "not-found");
    bea.upload_key_packages(hub, 1).ok();
    w.ada
        .post(
            hub,
            "/v2/key-packages/claim",
            &json!({ "devices": [b64(&bea.id())] }),
        )
        .ok();

    // ---- a restart keeps everything but tokens: the same data directory under a new hub
    let room_before = w
        .ada
        .get(hub, &format!("/v2/rooms/{}/groups", b64(&room)))
        .ok();
    let World { hub, mut ada, .. } = w;
    let dir = hub.stop_keep();
    let hub = TestHub::start_in(dir, &[]);
    ada.get(&hub, "/v2/desk").refused(401, "unauthorised");
    ada.sign_in(&hub, &room).ok();
    assert_eq!(
        ada.get(&hub, &format!("/v2/rooms/{}/groups", b64(&room)))
            .ok(),
        room_before
    );
    assert_eq!(
        ada.get(&hub, "/v2/desk").ok()["cards"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}
