//! Recovery and signing in with the code (spec/v1.md section 8) against the real hub: the join from outside with
//! its RecoveryAuth, a recovery as a transaction of its own, replacing the code.

mod common;

use common::*;
use serde_json::{json, Value};
use trommi_hub::util::{b64, random, unb64};
use trommi_hub::wire::{self, Cut, ZERO32};

fn recovery_token(hub: &TestHub, room: &[u8; 32], recovery: &Recovery) -> Dev {
    let mut asker = Dev::new();
    asker.room = *room;
    asker.token = sign_in_with(hub, room, &recovery.sign, None).ok()["token"]
        .as_str()
        .map(str::to_string);
    asker
}

fn group_info(hub: &TestHub, asker: &Dev, group: &[u8]) -> Vec<u8> {
    unb64(
        asker
            .get(hub, &format!("/v1/groups/{}/info", b64(group)))
            .ok()["group_info"]
            .as_str()
            .unwrap(),
    )
    .unwrap()
}

fn link(room: &[u8; 32], new: &Recovery) -> Vec<u8> {
    wire::RecoveryLink {
        room_id: *room,
        new_recovery_hpke_key: new.hpke_public.to_vec(),
        kem_output: vec![1; 32],
        ciphertext: vec![2; 80],
        mac: vec![3; 32],
    }
    .bytes()
}

fn epochs(hub: &TestHub, asker: &Dev, room: &[u8; 32]) -> Vec<(String, u64, usize)> {
    asker
        .get(hub, &format!("/v1/rooms/{}/groups", b64(room)))
        .ok()
        .as_array()
        .unwrap()
        .iter()
        .map(|g| {
            (
                g["kind"].as_str().unwrap().to_string(),
                g["epoch"].as_u64().unwrap(),
                g["leaves"].as_array().unwrap().len(),
            )
        })
        .collect()
}

#[test]
fn a_device_with_the_code_joins_from_outside_and_nobody_else_does() {
    let mut w = World::new();
    let mut agent = w.enrol_agent();
    let (_, group) = w.found_main(&mut [], Some(&mut agent));
    let room = w.room;
    let rec = recovery_token(&w.hub, &room, &w.recovery);
    let base = group_info(&w.hub, &rec, &room);
    let now = w.ada.room_now();
    let path = format!("/v1/groups/{}/commits", b64(&room));

    // a stolen device key alone opens no group: an external commit without the recovery authorisation
    let mut thief = Dev::new();
    thief.room = room;
    let out = thief.external_join(&base, now);
    let sealed = thief.sealed_key(
        &room,
        out.epoch + 1,
        &out.group_info,
        out.epoch,
        &w.recovery.hpke_public,
        true,
    );
    rec.post(&w.hub, &path, &commit_json(&out, &sealed, None))
        .refused(400, "bad-commit");
    // an authorisation signed by another key than the room's recovery key
    let forged = recovery_auth(&Recovery::new().sign, &out, &base, now, &thief.id());
    rec.post(&w.hub, &path, &commit_json(&out, &sealed, Some(&forged)))
        .refused(400, "bad-signature");
    // a real authorisation, moved to another Commit, another joiner, another base
    let mut dana = Dev::new();
    dana.room = room;
    let real = dana.external_join(&base, now);
    let auth = recovery_auth(&w.recovery.sign, &real, &base, now, &dana.id());
    rec.post(&w.hub, &path, &commit_json(&out, &sealed, Some(&auth)))
        .refused(400, "bad-commit");
    let other_joiner = recovery_auth(&w.recovery.sign, &real, &base, now, &thief.id());
    let dana_key = dana.sealed_key(
        &room,
        real.epoch + 1,
        &real.group_info,
        real.epoch,
        &w.recovery.hpke_public,
        true,
    );
    rec.post(
        &w.hub,
        &path,
        &commit_json(&real, &dana_key, Some(&other_joiner)),
    )
    .refused(400, "bad-commit");
    let other_base = recovery_auth(
        &w.recovery.sign,
        &real,
        b"another group info",
        now,
        &dana.id(),
    );
    rec.post(
        &w.hub,
        &path,
        &commit_json(&real, &dana_key, Some(&other_base)),
    )
    .refused(400, "bad-commit");
    // posted by a device that is neither the joiner nor under the recovery key
    w.ada
        .post(&w.hub, &path, &commit_json(&real, &dana_key, Some(&auth)))
        .refused(403, "wrong-sender");
    // the note must say it is a join
    thief.forget(&room);

    // as it must be: under the recovery key's token, with the authorisation
    assert_eq!(
        rec.post(&w.hub, &path, &commit_json(&real, &dana_key, Some(&auth)))
            .ok()["epoch"],
        real.epoch + 1
    );
    assert_eq!(dana.sign_in(&w.hub, &room).ok()["role"], "human");
    // every reader of the log gets the join together with its RecoveryAuth
    let log = w
        .ada
        .get(&w.hub, &format!("/v1/groups/{}/log", b64(&room)))
        .ok();
    let join = log["items"].as_array().unwrap().last().unwrap();
    assert_eq!(join["recovery_auth"], b64(&auth));
    catch_up(&w.hub, &mut w.ada, &room);
    assert_eq!(w.ada.members(&room).len(), 2);

    // it then joins every live session group the same way, as itself
    let now = dana.room_now();
    let base = group_info(&w.hub, &dana, &group);
    let out = dana.external_join(&base, now);
    let auth = recovery_auth(&w.recovery.sign, &out, &base, now, &dana.id());
    let key = dana.sealed_key(
        &group,
        out.epoch + 1,
        &out.group_info,
        now.0,
        &w.recovery.hpke_public,
        true,
    );
    let session_path = format!("/v1/groups/{}/commits", b64(&group));
    // an agent device (in the room's state, but no human device) does not join a session from outside
    let mut second = w.enrol_agent();
    second.lease = second.post(&w.hub, "/v1/link", &json!({ "process": b64(&random::<16>()), "hears": true, "working": false, "last_call_at": 0 })).ok()["generation"].as_u64();
    let now2 = w.ada.room_now();
    let _ = now2;
    dana.post(&w.hub, &session_path, &commit_json(&out, &key, Some(&auth)))
        .refused(409, "room-behind");
    dana.forget(&group);
    catch_up(&w.hub, &mut dana, &room);
    let now = dana.room_now();
    let agent_out = second.external_join(&base, now);
    let agent_auth = recovery_auth(&w.recovery.sign, &agent_out, &base, now, &second.id());
    let agent_key = second.sealed_key(
        &group,
        agent_out.epoch + 1,
        &agent_out.group_info,
        now.0,
        &w.recovery.hpke_public,
        false,
    );
    second
        .post(
            &w.hub,
            &session_path,
            &commit_json(&agent_out, &agent_key, Some(&agent_auth)),
        )
        .refused(400, "bad-commit");
    let out = dana.external_join(&base, now);
    let auth = recovery_auth(&w.recovery.sign, &out, &base, now, &dana.id());
    let key = dana.sealed_key(
        &group,
        out.epoch + 1,
        &out.group_info,
        now.0,
        &w.recovery.hpke_public,
        true,
    );
    dana.post(&w.hub, &session_path, &commit_json(&out, &key, Some(&auth)))
        .ok();
    assert_eq!(
        epochs(&w.hub, &dana, &room)
            .iter()
            .find(|g| g.0 == "main")
            .unwrap()
            .2,
        3
    );
    // the same join again: the first answer; the same authorisation on a later epoch: refused
    dana.post(&w.hub, &session_path, &commit_json(&out, &key, Some(&auth)))
        .ok();
}

#[test]
fn a_recovery_is_published_whole_at_finish_and_nothing_of_it_shows_before() {
    let mut w = World::new();
    let mut bea = w.add_human();
    let mut agent = w.enrol_agent();
    w.catch_up(&mut bea, &w.room.clone());
    let (session, group) = w.found_main(&mut [&mut bea], Some(&mut agent));
    bea.send(
        &w.hub,
        &group,
        &chat(&session, agent.id(), "before the loss"),
    )
    .ok();
    let room = w.room;
    let before = epochs(&w.hub, &w.ada, &room);
    let rec = recovery_token(&w.hub, &room, &w.recovery);

    // only under the recovery key; one at a time
    w.ada
        .post(
            &w.hub,
            &format!("/v1/rooms/{}/recovery", b64(&room)),
            &json!({}),
        )
        .refused(403, "forbidden");
    let opened = rec
        .post(
            &w.hub,
            &format!("/v1/rooms/{}/recovery", b64(&room)),
            &json!({}),
        )
        .ok();
    rec.post(
        &w.hub,
        &format!("/v1/rooms/{}/recovery", b64(&room)),
        &json!({}),
    )
    .refused(429, "too-many");
    let base_path = format!(
        "/v1/rooms/{}/recovery/{}",
        b64(&room),
        opened["recovery_id"].as_str().unwrap()
    );
    // the recovery key may ask for the account's passkey challenge (a passkey made anew, 8.6): this room has no
    // account; an agent device may not ask at all
    rec.post(&w.hub, "/v1/account/passkeys/challenge", &json!({}))
        .refused(404, "not-found");
    agent
        .post(&w.hub, "/v1/account/passkeys/challenge", &json!({}))
        .refused(403, "forbidden");
    // the room takes nothing else while it runs
    let locked = w.ada.send(&w.hub, &room, &register(&random(), "x"));
    locked.refused(503, "overloaded");
    assert!(locked.header("retry-after").is_some());
    let part = |rec: &Dev, group: &[u8], out: &Out, key: &[u8], auth: Option<&[u8]>| {
        let mut body = commit_json(out, key, auth);
        body["group_id"] = json!(b64(group));
        rec.post(&w.hub, &format!("{base_path}/commits"), &body)
    };

    // the new device joins the room group …
    let mut neo = Dev::new();
    neo.room = room;
    let now = w.ada.room_now();
    let base = group_info(&w.hub, &rec, &room);
    let join = neo.external_join(&base, now);
    let auth = recovery_auth(&w.recovery.sign, &join, &base, now, &neo.id());
    let key = neo.sealed_key(
        &room,
        join.epoch + 1,
        &join.group_info,
        join.epoch,
        &w.recovery.hpke_public,
        true,
    );
    // a session part before the room was joined is checked against the state so far: the joiner is no human device yet
    let session_base = group_info(&w.hub, &rec, &group);
    part(&rec, &room, &join, &key, Some(&auth)).ok();
    // a repeated part is kept once
    part(&rec, &room, &join, &key, Some(&auth)).ok();
    // a recovery has at most eight parts for one group (here: seven more are put beside the one, by hand, and
    // taken away again): the ninth is not even checked
    {
        let db = rusqlite::Connection::open(w.hub.dir.join("hub.db")).unwrap();
        db.busy_timeout(std::time::Duration::from_secs(5)).unwrap();
        let id = unb64(opened["recovery_id"].as_str().unwrap()).unwrap();
        for n in 100..107 {
            db.execute(
                "INSERT INTO recovery_parts (recovery_id, n, group_id, body, body_hash) VALUES (?1, ?2, ?3, 'x', ?4)",
                rusqlite::params![id, n, &room[..], &random::<32>()[..]],
            )
            .unwrap();
        }
        let mut other_key = key.clone();
        *other_key.last_mut().unwrap() ^= 1;
        part(&rec, &room, &join, &other_key, Some(&auth)).refused(429, "too-many");
        db.execute("DELETE FROM recovery_parts WHERE body = 'x'", [])
            .unwrap();
    }
    // … and the session group, checked against the copy the parts before it left
    let now = neo.room_now();
    let session_join = neo.external_join(&session_base, now);
    let session_auth = recovery_auth(
        &w.recovery.sign,
        &session_join,
        &session_base,
        now,
        &neo.id(),
    );
    let session_key = neo.sealed_key(
        &group,
        session_join.epoch + 1,
        &session_join.group_info,
        now.0,
        &w.recovery.hpke_public,
        true,
    );
    part(
        &rec,
        &group,
        &session_join,
        &session_key,
        Some(&session_auth),
    )
    .ok();
    // nothing is visible to anyone else
    assert_eq!(epochs(&w.hub, &rec, &room), before);
    // finishing now: nothing was cleaned, no new code
    let new_recovery = Recovery::new();
    let finish = json!({ "recovery_link": b64(&link(&room, &new_recovery)), "account": null });
    rec.post(&w.hub, &format!("{base_path}/finish"), &finish)
        .refused(400, "incomplete");

    // it removes every other human device, with Cuts, in the session …
    let cut = |dev: &Dev, g: &[u8]| Cut {
        device: dev.id(),
        seq: dev.chain(g).0,
        hash: dev.chain(g).1,
    };
    // 8.7: in the room group, the removal of every other human device together with 8.6 (new recovery keys) …
    let last = neo.commit(
        &room,
        &Change {
            removes: vec![w.ada.id(), bea.id()],
            cuts: sorted(vec![cut(&w.ada, &room), cut(&bea, &room)]),
            room: Some(new_recovery.room_ext(&[agent.id()])),
            ..Default::default()
        },
        now,
    );
    let last_key = neo.sealed_key(
        &room,
        last.epoch + 1,
        &last.group_info,
        last.epoch + 1,
        &new_recovery.hpke_public,
        true,
    );
    part(&rec, &room, &last, &last_key, None).ok();
    neo.merge(&room);
    // (a recovery that stops here left the session group with devices the room no longer holds)
    rec.post(&w.hub, &format!("{base_path}/finish"), &finish)
        .refused(409, "stale-session");
    // … and after that, against the new room epoch, the Removes in every live session group
    let now = neo.room_now();
    let clean = neo.commit(
        &group,
        &Change {
            removes: vec![w.ada.id(), bea.id()],
            cuts: sorted(vec![cut(&w.ada, &group), cut(&bea, &group)]),
            ..Default::default()
        },
        now,
    );
    let clean_key = neo.sealed_key(
        &group,
        clean.epoch + 1,
        &clean.group_info,
        now.0,
        &new_recovery.hpke_public,
        true,
    );
    part(&rec, &group, &clean, &clean_key, None).ok();
    neo.merge(&group);
    assert_eq!(epochs(&w.hub, &rec, &room), before);
    // a link for another key than the new one
    rec.post(
        &w.hub,
        &format!("{base_path}/finish"),
        &json!({ "recovery_link": b64(&link(&room, &Recovery::new())), "account": null }),
    )
    .refused(400, "incomplete");
    assert_eq!(epochs(&w.hub, &rec, &room), before);

    let published = rec
        .post(&w.hub, &format!("{base_path}/finish"), &finish)
        .ok();
    assert_eq!(published["published"], true);
    // repeated, it gives the same answer: although the key it was signed in with is replaced
    assert_eq!(
        rec.post(&w.hub, &format!("{base_path}/finish"), &finish)
            .ok(),
        published
    );
    // that key does nothing else any more
    rec.get(&w.hub, "/v1/sealed-keys")
        .refused(403, "not-member");
    sign_in_with(&w.hub, &room, &w.recovery.sign, None).refused(403, "not-member");
    // the lost devices are out; the agent device stayed; the new device is the room's human device
    w.ada.get(&w.hub, "/v1/desk").refused(403, "not-member");
    bea.get(&w.hub, "/v1/desk").refused(403, "not-member");
    neo.sign_in(&w.hub, &room).ok();
    // 8.7: after publication the new device asks for that answer under its own token too; no other device does
    assert_eq!(
        neo.post(&w.hub, &format!("{base_path}/finish"), &finish)
            .ok(),
        published
    );
    agent
        .post(&w.hub, &format!("{base_path}/finish"), &finish)
        .refused(404, "not-found");
    let after = epochs(&w.hub, &neo, &room);
    assert_eq!(
        after,
        vec![
            ("room".to_string(), before[0].1 + 2, 1),
            ("main".to_string(), before[1].1 + 2, 2)
        ]
    );
    assert!(neo
        .get(&w.hub, &format!("/v1/rooms/{}/groups", b64(&room)))
        .ok()
        .as_array()
        .unwrap()
        .iter()
        .all(|g| g["stale"] == false));
    // the parts were published under consecutive change numbers, in their order
    let changes = neo
        .get(
            &w.hub,
            &format!(
                "/v1/changes?after={}&limit=100",
                published["first_change"].as_i64().unwrap() - 1
            ),
        )
        .ok();
    let commits: Vec<&Value> = changes["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|i| i["kind"] == "commit")
        .collect();
    assert_eq!(commits.len(), 4);
    assert_eq!(commits[0]["recovery_auth"], b64(&auth));
    // the history is there for the new device; the room works again; the new recovery key signs in
    assert_eq!(
        neo.get(
            &w.hub,
            &format!(
                "/v1/chats/session/{}/items",
                trommi_hub::util::hex(&session)
            )
        )
        .ok()["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    neo.send(&w.hub, &room, &register(&random(), "back")).ok();
    let links = recovery_token(&w.hub, &room, &new_recovery)
        .get(&w.hub, "/v1/sealed-keys")
        .ok();
    assert_eq!(links["links"].as_array().unwrap().len(), 1);
    assert!(links["rows"].as_array().unwrap().len() >= 6);
    let _ = ZERO32;
}

fn sorted(mut cuts: Vec<Cut>) -> Vec<Cut> {
    cuts.sort_by_key(|c| c.device);
    cuts
}

#[test]
fn a_dropped_recovery_leaves_the_room_as_it_was() {
    let w = World::new();
    let room = w.room;
    let rec = recovery_token(&w.hub, &room, &w.recovery);
    let opened = rec
        .post(
            &w.hub,
            &format!("/v1/rooms/{}/recovery", b64(&room)),
            &json!({}),
        )
        .ok();
    let base_path = format!(
        "/v1/rooms/{}/recovery/{}",
        b64(&room),
        opened["recovery_id"].as_str().unwrap()
    );
    let mut neo = Dev::new();
    neo.room = room;
    let now = w.ada.room_now();
    let base = group_info(&w.hub, &rec, &room);
    let join = neo.external_join(&base, now);
    let auth = recovery_auth(&w.recovery.sign, &join, &base, now, &neo.id());
    let key = neo.sealed_key(
        &room,
        join.epoch + 1,
        &join.group_info,
        join.epoch,
        &w.recovery.hpke_public,
        true,
    );
    let mut body = commit_json(&join, &key, Some(&auth));
    body["group_id"] = json!(b64(&room));
    rec.post(&w.hub, &format!("{base_path}/commits"), &body)
        .ok();
    // another room's recovery key, a made-up id
    let (other_room, other_recovery, _) = found_room(&w.hub);
    let other = recovery_token(&w.hub, &other_room, &other_recovery);
    other
        .post(&w.hub, &format!("{base_path}/commits"), &body)
        .refused(400, "wrong-room");
    rec.post(
        &w.hub,
        &format!(
            "/v1/rooms/{}/recovery/{}/commits",
            b64(&room),
            b64(&random::<16>())
        ),
        &body,
    )
    .refused(404, "not-found");
    rec.call(&w.hub, "DELETE", &base_path, &Value::Null).ok();
    // the room is free again and stands where it stood
    w.ada.get(&w.hub, "/v1/desk").ok();
    assert_eq!(
        epochs(&w.hub, &w.ada, &room),
        vec![("room".to_string(), 0, 1)]
    );
    rec.post(&w.hub, &format!("{base_path}/commits"), &body)
        .refused(404, "not-found");
    let mut me = Dev::new();
    me.token = w.ada.token.clone();
    w.ada
        .put(&w.hub, "/v1/key-packages", &json!({ "single_use": [] }))
        .ok();
}

#[test]
fn the_code_is_replaced_in_one_request_or_not_at_all() {
    let mut w = World::new();
    let room = w.room;
    let new = Recovery::new();
    let now = w.ada.room_now();
    let change = Change {
        room: Some(new.room_ext(&[])),
        ..Default::default()
    };
    // new recovery keys on the ordinary route: without their RecoveryLink
    let out = w.ada.commit(&room, &change, now);
    let key = w.ada.sealed_key(
        &room,
        out.epoch + 1,
        &out.group_info,
        out.epoch + 1,
        &new.hpke_public,
        true,
    );
    w.ada
        .post_commit(&w.hub, &out, &key)
        .refused(400, "incomplete");
    // on its route: a link for another key; the sealed key to the old key
    let path = format!("/v1/rooms/{}/recovery-code", b64(&room));
    let out = w.ada.commit(&room, &change, now);
    let key = w.ada.sealed_key(
        &room,
        out.epoch + 1,
        &out.group_info,
        out.epoch + 1,
        &new.hpke_public,
        true,
    );
    let mut body = commit_json(&out, &key, None);
    body["recovery_link"] = json!(b64(&link(&room, &Recovery::new())));
    w.ada
        .post(&w.hub, &path, &code_body(&body))
        .refused(400, "incomplete");
    body["recovery_link"] = json!(b64(&link(&room, &new)));
    let old_key = w.ada.sealed_key(
        &room,
        out.epoch + 1,
        &out.group_info,
        out.epoch + 1,
        &w.recovery.hpke_public,
        true,
    );
    let mut wrong = body.clone();
    wrong["sealed_key"] = json!(b64(&old_key));
    w.ada
        .post(&w.hub, &path, &code_body(&wrong))
        .refused(400, "incomplete");
    // 8.2: the row of the Commit that replaces the recovery keys names the new room epoch, whose state holds
    // the new keys; the epoch the Commit builds on is another row's
    let behind = w.ada.sealed_key(
        &room,
        out.epoch + 1,
        &out.group_info,
        out.epoch,
        &new.hpke_public,
        true,
    );
    wrong["sealed_key"] = json!(b64(&behind));
    w.ada
        .post(&w.hub, &path, &code_body(&wrong))
        .refused(400, "incomplete");
    // a Commit that replaces nothing is not this route's
    let old_token = recovery_token(&w.hub, &room, &w.recovery);
    let accepted = w.ada.post(&w.hub, &path, &code_body(&body)).ok();
    w.ada.merge(&room);
    // a lost answer is retried with the same bytes
    assert_eq!(w.ada.post(&w.hub, &path, &code_body(&body)).ok(), accepted);
    // the replaced recovery key's token ended at once; the new key signs in and finds the link
    old_token
        .get(&w.hub, "/v1/sealed-keys")
        .refused(403, "not-member");
    let reader = recovery_token(&w.hub, &room, &new);
    let keys = reader.get(&w.hub, "/v1/sealed-keys").ok();
    assert_eq!(keys["links"][0]["room_epoch"], 1);
    assert_eq!(keys["rows"].as_array().unwrap().len(), 2);
    // from here on keys are sealed to the new recovery key
    let now = w.ada.room_now();
    let out = w.ada.commit(&room, &Change::default(), now);
    let to_old = w.ada.sealed_key(
        &room,
        out.epoch + 1,
        &out.group_info,
        out.epoch,
        &w.recovery.hpke_public,
        true,
    );
    w.ada
        .post_commit(&w.hub, &out, &to_old)
        .refused(400, "incomplete");
    w.ada.clear(&room);
    // 8.6: a recovery key the room held before does not come back, as either of the two: the first code's
    // signature key beside a fresh HPKE key, and the other way round
    for old_signature in [true, false] {
        let fresh = Recovery::new();
        let (mut ext, old) = (fresh.room_ext(&[]), w.recovery.room_ext(&[]));
        if old_signature {
            ext.recovery_signature_key = old.recovery_signature_key;
        } else {
            ext.recovery_hpke_key = old.recovery_hpke_key;
        }
        let sealed_to = ext.recovery_hpke_key.clone();
        let now = w.ada.room_now();
        let out = w.ada.commit(
            &room,
            &Change {
                room: Some(ext),
                ..Default::default()
            },
            now,
        );
        let key = w.ada.sealed_key(
            &room,
            out.epoch + 1,
            &out.group_info,
            out.epoch + 1,
            &sealed_to,
            true,
        );
        let mut body = commit_json(&out, &key, None);
        body["recovery_link"] = json!(b64(&wire::RecoveryLink {
            room_id: room,
            new_recovery_hpke_key: sealed_to,
            kem_output: vec![1; 32],
            ciphertext: vec![2; 80],
            mac: vec![3; 32],
        }
        .bytes()));
        w.ada
            .post(&w.hub, &path, &code_body(&body))
            .refused(400, "bad-commit");
        w.ada.clear(&room);
    }
}

/// 16, 8.7: while a recovery runs the room holds one human device more than its limit (1001 of 1000); outside a
/// recovery the joiner is one too many. Here with a limit of one: the founder alone.
#[test]
fn a_recovery_may_hold_one_human_device_over_the_limit() {
    let w = World::on(TestHub::start_with(&[("HUB_LIMIT_HUMANS", "1")]));
    let room = w.room;
    let rec = recovery_token(&w.hub, &room, &w.recovery);
    let now = w.ada.room_now();
    let base = group_info(&w.hub, &rec, &room);
    let mut neo = Dev::new();
    neo.room = room;
    let join = neo.external_join(&base, now);
    let auth = recovery_auth(&w.recovery.sign, &join, &base, now, &neo.id());
    let key = neo.sealed_key(
        &room,
        join.epoch + 1,
        &join.group_info,
        join.epoch,
        &w.recovery.hpke_public,
        true,
    );
    // outside a recovery: the second human device is refused
    rec.post(
        &w.hub,
        &format!("/v1/groups/{}/commits", b64(&room)),
        &commit_json(&join, &key, Some(&auth)),
    )
    .refused(429, "too-many");
    // inside one it is taken
    let opened = rec
        .post(
            &w.hub,
            &format!("/v1/rooms/{}/recovery", b64(&room)),
            &json!({}),
        )
        .ok();
    let mut body = commit_json(&join, &key, Some(&auth));
    body["group_id"] = json!(b64(&room));
    rec.post(
        &w.hub,
        &format!(
            "/v1/rooms/{}/recovery/{}/commits",
            b64(&room),
            opened["recovery_id"].as_str().unwrap()
        ),
        &body,
    )
    .ok();
}
