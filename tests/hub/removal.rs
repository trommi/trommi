//! 13.5: a removed device can verify its own removal: for thirty days it may fetch the Commits that removed it,
//! and nothing else. One test: it moves the clock, which belongs to the whole process.

mod common;

use common::*;
use serde_json::json;
use trommi_hub::util::{b64, random, unb64};
use trommi_hub::wire::Cut;

const DAY: i64 = 86_400_000;

#[test]
fn a_removed_device_fetches_the_commits_that_removed_it_and_nothing_else() {
    let mut w = World::new();
    let mut bea = w.add_human();
    let mut agent = w.enrol_agent();
    w.catch_up(&mut bea, &w.room.clone());
    let (session, group) = w.found_main(&mut [&mut bea], Some(&mut agent));
    let room = w.room;
    agent.lease = agent.post(&w.hub, "/v1/link", &json!({ "process": b64(&random::<16>()), "hears": true, "working": false, "last_call_at": 0 })).ok()["generation"].as_u64();
    agent
        .send(&w.hub, &group, &chat(&session, agent.id(), "at work"))
        .ok();
    let (step_epoch, step) = (
        bea.epoch(&group),
        bea.application_message(&group, b"a step"),
    );
    bea.post(
        &w.hub,
        &format!("/v1/groups/{}/messages", b64(&group)),
        &json!({ "epoch": step_epoch, "message": b64(&step) }),
    )
    .ok();
    // (a message lies in the session's log between its Commits: the proof holds Commits only, from any cursor)
    let mixed = bea
        .get(&w.hub, &format!("/v1/groups/{}/log", b64(&group)))
        .ok();
    let message_n = mixed["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["kind"] == "message")
        .map(|i| i["n"].as_i64().unwrap())
        .expect("a message in the log");
    let removal = |dev: &Dev, hub: &TestHub, g: &[u8], after: i64| {
        dev.get(hub, &format!("/v1/groups/{}/removal?after={after}", b64(g)))
    };
    // a member has no removal to be shown
    removal(&agent, &w.hub, &room, 0).refused(404, "not-found");
    removal(&agent, &w.hub, &group, 0).refused(404, "not-found");

    // the agent device is removed: from `agents` in the room group, then its leaf from its session, with its Cut
    let now = w.ada.room_now();
    let out = w.ada.commit(
        &room,
        &Change {
            room: Some(w.recovery.room_ext(&[])),
            ..Default::default()
        },
        now,
    );
    let key = w.ada.sealed_key(
        &room,
        out.epoch + 1,
        &out.group_info,
        out.epoch,
        &w.recovery.hpke_public,
        true,
    );
    let room_commit = out.commit.clone();
    w.ada.post_commit(&w.hub, &out, &key).ok();
    let now = w.ada.room_now();
    let (seq, hash) = agent.chain(&group);
    let out = w.ada.commit(
        &group,
        &Change {
            removes: vec![agent.id()],
            cuts: vec![Cut {
                device: agent.id(),
                seq,
                hash,
            }],
            ..Default::default()
        },
        now,
    );
    let key = w.ada.sealed_key(
        &group,
        out.epoch + 1,
        &out.group_info,
        now.0,
        &w.recovery.hpke_public,
        true,
    );
    let session_commit = out.commit.clone();
    w.ada.post_commit(&w.hub, &out, &key).ok();
    // the room goes on after that: nothing of it is the removed device's to see
    let now = w.ada.room_now();
    let later = w.ada.commit(&room, &Change::default(), now);
    let key = w.ada.sealed_key(
        &room,
        later.epoch + 1,
        &later.group_info,
        later.epoch,
        &w.recovery.hpke_public,
        true,
    );
    w.ada.post_commit(&w.hub, &later, &key).ok();
    let hub = &w.hub;

    // with the token it still holds, and with one it signs in for now: no standing, every route says so
    let nothing_else = |agent: &Dev| {
        for path in [
            "/v1/desk",
            "/v1/welcomes",
            "/v1/changes",
            "/v1/account",
            &format!("/v1/groups/{}/log", b64(&group)),
            &format!("/v1/groups/{}/info", b64(&room)),
            &format!("/v1/rooms/{}/groups", b64(&room)),
        ] {
            agent.get(hub, path).refused(403, "not-member");
        }
        agent
            .put(hub, "/v1/key-packages", &json!({ "single_use": [] }))
            .refused(403, "not-member");
        agent.post(hub, "/v1/link", &json!({ "process": b64(&random::<16>()), "hears": true, "working": false, "last_call_at": 0 })).refused(403, "not-member");
        assert_eq!(agent.events(hub, None).status, 403);
    };
    nothing_else(&agent);
    let shown = |agent: &Dev| {
        // the room group: its Commits up to and including the one that took the device out of `agents`
        let answer = removal(agent, hub, &room, 0).ok();
        let items = answer["items"].as_array().unwrap();
        let last = items.last().unwrap();
        assert_eq!(unb64(last["bytes"].as_str().unwrap()).unwrap(), room_commit);
        assert_eq!(
            (&answer["removed_at"], &answer["more"]),
            (&last["n"], &json!(false))
        );
        assert!(items.iter().all(|item| item["kind"] == "commit"));
        // from a cursor: only what follows it; at the end: nothing
        let from = items[items.len() - 2]["n"].as_i64().unwrap();
        assert_eq!(
            removal(agent, hub, &room, from).ok()["items"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            removal(agent, hub, &room, last["n"].as_i64().unwrap()).ok()["items"],
            json!([])
        );
        // its session group: up to the Commit that removed its leaf; no message, no envelope
        let answer = removal(agent, hub, &group, 0).ok();
        let items = answer["items"].as_array().unwrap();
        assert_eq!(
            unb64(items.last().unwrap()["bytes"].as_str().unwrap()).unwrap(),
            session_commit
        );
        let rest = removal(agent, hub, &group, message_n).ok();
        let rest_items = rest["items"].as_array().unwrap();
        assert!(!rest_items.is_empty() && rest_items.iter().all(|item| item["kind"] == "commit" && item["n"].as_i64().unwrap() > message_n));
        assert_eq!(rest_items.last().unwrap()["n"], answer["removed_at"]);
        assert!(items.iter().all(|item| item["kind"] == "commit"));
    };
    shown(&agent);
    let signed = agent.sign_in(hub, &room);
    assert_eq!(signed.ok()["role"], "removed");
    nothing_else(&agent);
    shown(&agent);

    // a key that was never in the room gets no token; one of another room is shown nothing of this one
    Dev::new().sign_in(hub, &room).refused(403, "not-member");
    let (_, _, mallory) = found_room(hub);
    removal(&mallory, hub, &room, 0).refused(404, "not-found");
    removal(&mallory, hub, &group, 0).refused(404, "not-found");
    // a member that was not removed: nothing; without a token: nothing
    removal(&bea, hub, &group, 0).refused(404, "not-found");
    hub.get(&format!("/v1/groups/{}/removal", b64(&room)))
        .refused(401, "unauthorised");

    // thirty days on it is over: no proof, no token
    hub.clock(29 * DAY);
    agent.sign_in(hub, &room).ok();
    shown(&agent);
    hub.clock(DAY + 60_000);
    removal(&agent, hub, &room, 0).refused(401, "unauthorised");
    agent.sign_in(hub, &room).refused(403, "not-member");
}
