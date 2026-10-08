//! shared/crypto/vectors.json in Rust: every vector is rebuilt from its seeds byte for byte (as crypto-test.mjs
//! --write-vectors builds them), and opened from its bytes alone (as a second implementation would).
use serde_json::Value;
use std::collections::HashMap;
use trommi::crypto::grants::*;
use trommi::crypto::*;

const T0: u64 = 1790000000000;

fn vectors() -> Value {
    let p = concat!(env!("CARGO_MANIFEST_DIR"), "/../shared/crypto/vectors.json");
    serde_json::from_str(&std::fs::read_to_string(p).expect("vectors.json")).unwrap()
}
fn h(v: &Value) -> Vec<u8> {
    unhex(v.as_str().unwrap()).unwrap()
}
fn s(v: &Value) -> &str {
    v.as_str().unwrap()
}
fn fill<const N: usize>(b: u8) -> [u8; N] {
    [b; N]
}
fn dev(a: u8, b: u8) -> Device {
    Device::from_seeds(fill(a), fill(b))
}

#[test]
fn encoding_hash_hkdf_signature() {
    let v = vectors();
    assert_eq!(b64u(&h(&v["encoding"]["bytes"])), s(&v["encoding"]["base64url"]));
    assert_eq!(hex(&hash(label::LOG_ENTRY, &[b"abc"])), s(&v["encoding"]["hash"]["out"]));
    assert_eq!(hex(&hkdf(&[1u8; 32], &[2u8; 32], label::SENDER_KEY, &unhex("00000001").unwrap(), 32)), s(&v["encoding"]["hkdf"]["out"]));
    let phone = dev(0x11, 0x12);
    assert_eq!(hex(&phone.sign(label::LOG_SIG, b"message")), s(&v["signature"]["signature"]));
    assert!(verify(&phone.sign_pub, label::LOG_SIG, b"message", &h(&v["signature"]["signature"])));
    assert!(!verify(&phone.sign_pub, label::LOG_SIG, b"messagf", &h(&v["signature"]["signature"])));
}

#[test]
fn devices_and_key_files() {
    let v = vectors();
    for (name, a, b) in [("phone", 0x11, 0x12), ("laptop", 0x21, 0x22), ("agent", 0x31, 0x32), ("tablet", 0x41, 0x42), ("helper", 0x51, 0x52)] {
        let d = dev(a, b);
        let e = &v["devices"][name];
        assert_eq!(hex(&d.sign_pub), s(&e["signPub"]), "{name}");
        assert_eq!(hex(&d.kex_pub), s(&e["kexPub"]), "{name}");
        assert_eq!(hex(&d.id), s(&e["id"]), "{name}");
        if let Some(f) = e.get("secretFile") {
            assert_eq!(hex(&export_device_secret(&d)), s(f));
            assert_eq!(import_device_secret(&h(f)).unwrap().id, d.id);
        }
    }
}

#[test]
fn recovery_code_and_sealed_box() {
    let v = vectors();
    let raw: [u8; 32] = Rng::test(0x40).bytes(32).try_into().unwrap();
    let code = format_recovery_code(&raw);
    assert_eq!(code, s(&v["recovery"]["code"]));
    assert_eq!(hex(&parse_recovery_code(&code).unwrap()), s(&v["recovery"]["raw"]));
    assert_eq!(hex(&parse_recovery_code(&code.to_lowercase().replace('-', " ")).unwrap()), s(&v["recovery"]["raw"]));
    let rec = recovery_device(&code).unwrap();
    assert_eq!(hex(&rec.id), s(&v["recovery"]["id"]));
    let laptop = dev(0x21, 0x22);
    let sealed = seal(&laptop.kex_pub, b"sealed box", b"associated", &mut Rng::test(0x50)).unwrap();
    assert_eq!(hex(&sealed), s(&v["sealedBox"]["sealed"]));
    assert_eq!(open_sealed(&laptop, &sealed, b"associated").unwrap(), b"sealed box");
    assert_eq!(open_sealed(&laptop, &sealed, b"other").unwrap_err().code, "decrypt-failed");
}

fn sec_json(s: &Secret) -> Value {
    serde_json::json!({ "epoch": s.epoch, "key": hex(&s.key), "hist": s.hist.map(|h| hex(&h)) })
}

/// The whole room of buildVectors(), rebuilt from the seeds: every byte string compared with vectors.json.
#[test]
fn the_room_rebuilds_byte_for_byte() {
    let v = vectors();
    let (phone, laptop, agent, tablet, helper) = (dev(0x11, 0x12), dev(0x21, 0x22), dev(0x31, 0x32), dev(0x41, 0x42), dev(0x51, 0x52));
    let code = format_recovery_code(&Rng::test(0x40).bytes(32).try_into().unwrap());
    let rec = recovery_device(&code).unwrap();
    let room = create_room(&phone, KeyPair { sign_pub: rec.sign_pub, kex_pub: rec.kex_pub }, T0, &mut Rng::test(0x60)).unwrap();
    assert_eq!(hex(&room.entry), s(&v["room"]["genesis"]));
    assert_eq!(hex(&room.state.room_id), s(&v["room"]["roomId"]));
    assert_eq!(sec_json(&room.secret), v["room"]["secret"]);
    let (kc, hc) = epoch_commits(&room.secret);
    assert_eq!(hex(&kc), s(&v["room"]["keyCommit"]));
    assert_eq!(hex(&hc.unwrap()), s(&v["room"]["histCommit"]));
    for (i, w) in room.wraps.iter().enumerate() {
        assert_eq!(hex(&w.1), s(&v["room"]["wraps"][i]["sealed"]));
    }

    let mut log = vec![room.entry.clone()];
    let mut state = room.state.clone();
    let mut members: HashMap<&str, Option<Secret>> = HashMap::new();
    for (i, (name, device, role, seed, inviter_is_phone, checked)) in [("Laptop", &laptop, ROLE_HUMAN, 0x70u32, true, true), ("Agent", &agent, ROLE_AGENT, 0x78, true, false), ("Helper", &helper, ROLE_AGENT, 0x88, false, false)].into_iter().enumerate() {
        let inviter = if inviter_is_phone { &phone } else { &laptop };
        let iv = &v["invites"][i];
        let (link, offer, mut invite) = create_invite(&state, inviter, "https://hub.example", role, "https://app.example/join", INVITE_TTL_MS, T0, &mut Rng::test(seed)).unwrap();
        assert_eq!(link, s(&iv["link"]));
        assert_eq!(hex(&offer), s(&iv["offer"]));
        assert_eq!(hex(&invite_offer_hash(&offer).unwrap()), s(&iv["offerHash"]));
        let (request, join) = create_join_request(&link, &offer, &log, device, T0).unwrap();
        assert_eq!(hex(&request), s(&iv["request"]));
        assert_eq!(hex(&invite_request_hash(&request)), s(&iv["requestHash"]));
        let (reveal, check_code, _member, _rh) = accept_join_request(&mut invite, &request, inviter, T0).unwrap();
        assert_eq!(hex(&reveal), s(&iv["reveal"]));
        assert_eq!(check_code, s(&iv["checkCode"]));
        assert_eq!(check_reveal(&join, &reveal, &log).unwrap(), check_code);
        let (entry, next, wrap) = finalize_invite(&invite, &state, inviter, Some(&room.secret), checked, T0, &mut Rng::test(seed + 1)).unwrap();
        assert_eq!(hex(&entry), s(&iv["entry"]));
        assert_eq!(wrap.as_ref().map(|w| hex(w)), iv["wrap"].as_str().map(String::from));
        log.push(entry);
        state = next;
        let (_, secret) = complete_join(&join, device, &log, wrap.as_deref()).unwrap();
        members.insert(name, secret);
    }
    let state3 = state.clone();
    assert_eq!(members["Laptop"].as_ref().unwrap().key, room.secret.key);

    // Envelopes under the session key.
    let session_id: [u8; 16] = fill(0x5e);
    let ssec = Secret { epoch: 1, key: fill(0x61), hist: Some(fill(0x62)) };
    let secrets = |hd: &Header| if hd.key_scope == 1 { Some(ssec.clone()) } else { None };
    let mut phone_chains = Chains::new();
    let mut agent_chains = Chains::new();
    let card_id = object_id_of(&agent.id, 1);
    let tl = format!("session/{}", hex(&session_id));
    fn base<'a>(device: &'a Device, state: &'a LogState, secret: &'a Secret, session_id: [u8; 16], kind: u8, payload: &[u8], time: u64) -> SealArgs<'a> {
        SealArgs {
            device, state, secret, key_scope: 1, session_id: Some(session_id), kind, bind: vec![], payload: payload.to_vec(),
            recipient: None, time, card: None, timeline_kind: None, timeline_id: None, blobs: vec![], push: false, seen: None,
        }
    }
    let mut a1 = base(&phone, &state3, &ssec, session_id, kind::TIMELINE_ITEM, b"hello", T0 + 1);
    a1.timeline_kind = Some(1);
    a1.timeline_id = Some(tl.clone());
    a1.recipient = Some(agent.id);
    let e1 = seal_envelope(a1, &mut phone_chains, &mut Rng::test(0x80)).unwrap();
    assert_eq!(hex(&e1.bytes), s(&v["envelopes"]["chat"]["bytes"]));
    assert_eq!(hex(&e1.hash), s(&v["envelopes"]["chat"]["hash"]));
    open_envelope(&e1.bytes, &state3, &mut agent_chains, &secrets, None, &VerifyOpts::default(), true).unwrap();
    let mut a2 = base(&agent, &state3, &ssec, session_id, kind::OBJECT_VERSION, br#"{"title":"Deploy?","options":["yes","no"]}"#, T0 + 2);
    a2.card = Some(CardBlock { id: card_id, state: 1, urgency: 2, answered_at: 0 });
    a2.blobs = vec![fill(0xb1)];
    a2.push = true;
    let e2 = seal_envelope(a2, &mut agent_chains, &mut Rng::test(0x81)).unwrap();
    assert_eq!(hex(&e2.bytes), s(&v["envelopes"]["card"]["bytes"]));
    assert_eq!(hex(&card_id), s(&v["envelopes"]["card"]["cardId"]));
    open_envelope(&e2.bytes, &state3, &mut phone_chains, &secrets, None, &VerifyOpts::default(), true).unwrap();
    let answer_bind = encode_answer_bind(&card_id, &e2.hash, &["yes".to_string()]).unwrap();
    assert_eq!(hex(&answer_bind), s(&v["binds"]["answer"]));
    let mut a3 = base(&phone, &state3, &ssec, session_id, kind::ANSWER, br#"{"note":"go"}"#, T0 + 3);
    a3.bind = answer_bind;
    a3.recipient = Some(agent.id);
    a3.card = Some(CardBlock { id: card_id, state: 2, urgency: 2, answered_at: T0 + 3 });
    let e3 = seal_envelope(a3, &mut phone_chains, &mut Rng::test(0x82)).unwrap();
    assert_eq!(hex(&e3.bytes), s(&v["envelopes"]["answer"]["bytes"]));
    let opened = open_envelope(&e3.bytes, &state3, &mut agent_chains, &secrets, Some(&agent.id), &VerifyOpts::default(), true).unwrap();
    assert!(opened.for_me);
    let desk_room = room.secret.clone();
    let e5 = seal_envelope(SealArgs {
        device: &phone, state: &state3, secret: &desk_room, key_scope: 0, session_id: None, kind: kind::TIMELINE_ITEM, bind: vec![], payload: br#"{"content_type":"strokes"}"#.to_vec(),
        recipient: None, time: T0 + 4, card: None, timeline_kind: Some(2), timeline_id: Some(format!("desk/{}", hex(&[0xd5u8; 16]))), blobs: vec![], push: false, seen: None,
    }, &mut phone_chains, &mut Rng::test(0x83)).unwrap();
    assert_eq!(hex(&e5.bytes), s(&v["envelopes"]["desk"]["bytes"]));
    assert_eq!(hex(&prune_envelope(&e1.bytes).unwrap()), s(&v["envelopes"]["pruned"]));
    assert_eq!(hex(&prune_envelope(&e3.bytes).unwrap()), s(&v["envelopes"]["prunedAnswer"]));
    assert_eq!(hex(&derive_sender_key(&room.state.room_id, &room.secret, &phone.id, 0, None)), s(&v["envelopes"]["senderKeys"]["phoneRoom"]));
    assert_eq!(hex(&derive_sender_key(&room.state.room_id, &ssec, &agent.id, 1, Some(&session_id))), s(&v["envelopes"]["senderKeys"]["agentSession"]));
    // binds
    assert_eq!(hex(&encode_verdict_bind(&fill(0x71), &fill(0x72), T0 + 300000, true)), s(&v["binds"]["verdict"]));
    assert_eq!(hex(&encode_decide_again_bind(&card_id, &e3.hash, &e2.hash)), s(&v["binds"]["decideAgain"]));
    assert_eq!(hex(&encode_request_bind(&fill(0x71), T0 + 300000)), s(&v["binds"]["request"]));
    assert_eq!(hex(&sign_hub_auth(&agent, &room.state.room_id, "https://hub.example", &[0x5c; 32]).unwrap()), s(&v["hubAuth"]["signed"]));

    // Removal and recovery.
    let rem = remove_members(&state, &laptop, &[helper.id], &HashMap::new(), members["Laptop"].as_ref(), T0 + 10, &mut Rng::test(0x90)).unwrap();
    let vr = &v["epochChanges"]["remove"];
    assert_eq!(hex(&rem.entry), s(&vr["entry"]));
    assert_eq!(sec_json(&rem.secret), vr["secret"]);
    assert_eq!(hex(rem.back_link.as_ref().unwrap()), s(&vr["backLink"]));
    for (i, w) in rem.wraps.iter().enumerate() {
        assert_eq!(hex(&w.1), s(&vr["wraps"][i]["sealed"]));
    }
    log.push(rem.entry.clone());
    state = rem.state.clone();
    let new_code = format_recovery_code(&Rng::test(0xa0).bytes(32).try_into().unwrap());
    let vc = &v["epochChanges"]["recover"];
    assert_eq!(new_code, s(&vc["newCode"]));
    let recovered = recover_room(&state, &code, &new_code, &tablet.public(), &[], &HashMap::new(), &rem.wraps.last().unwrap().1, T0 + 30, &mut Rng::test(0xa8)).unwrap();
    assert_eq!(hex(&recovered.entry), s(&vc["entry"]));
    assert_eq!(sec_json(&recovered.secret), vc["secret"]);
    assert_eq!(hex(recovered.back_link.as_ref().unwrap()), s(&vc["backLink"]));
    log.push(recovered.entry.clone());
    let full = recovered.state.clone();
    let mut tablet_chains = Chains::new();
    let e4 = seal_envelope(SealArgs {
        device: &tablet, state: &full, secret: &ssec, key_scope: 1, session_id: Some(session_id), kind: 1, bind: vec![], payload: b"back again".to_vec(),
        recipient: Some(agent.id), time: T0 + 40, card: None, timeline_kind: Some(1), timeline_id: Some(tl.clone()), blobs: vec![], push: false, seen: None,
    }, &mut tablet_chains, &mut Rng::test(0xb4)).unwrap();
    assert_eq!(hex(&e4.bytes), s(&v["envelopes"]["afterRecovery"]["bytes"]));
    for (i, e) in v["log"]["entries"].as_array().unwrap().iter().enumerate() {
        assert_eq!(hex(&log[i]), s(&e["bytes"]), "entry {i}");
    }
    // assets
    let small = encrypt_asset(b"asset", &mut Rng::test(0xb0));
    assert_eq!(hex(&small.blob), s(&v["assets"]["small"]["blob"]));
    assert_eq!(hex(&small.sha256), s(&v["assets"]["small"]["sha256"]));
    let big: Vec<u8> = (0..70000u32).map(|i| ((i * 7) & 0xff) as u8).collect();
    let b = encrypt_asset(&big, &mut Rng::test(0xb8));
    assert_eq!(b.blob.len() as u64, v["assets"]["twoChunks"]["blobLength"].as_u64().unwrap());
    assert_eq!(hex(&b.sha256), s(&v["assets"]["twoChunks"]["sha256"]));
    assert_eq!(decrypt_asset(&b.blob, &b.key, Some(&b.sha256)).unwrap(), big);
}

/// The stored vectors open from their bytes alone.
#[test]
fn the_stored_vectors_open_from_their_bytes() {
    let v = vectors();
    let d = |n: &str| Device::from_seeds(h(&v["devices"][n]["signSeed"]).try_into().unwrap(), h(&v["devices"][n]["kexSeed"]).try_into().unwrap());
    let (phone, laptop, agent, tablet) = (d("phone"), d("laptop"), d("agent"), d("tablet"));
    let room_id = h(&v["room"]["roomId"]);
    let entries: Vec<Vec<u8>> = v["log"]["entries"].as_array().unwrap().iter().map(|e| h(&e["bytes"])).collect();
    let state3 = verify_log(&entries[..4], Some(&room_id)).unwrap();
    let full = verify_log(&entries, Some(&room_id)).unwrap();
    assert_eq!(full.epoch, 3);
    let active: Vec<String> = full.active_members().iter().map(|m| hex(&m.id)).collect();
    assert_eq!(active, vec![hex(&agent.id), hex(&tablet.id)]);
    for k in ["retiredType4", "signedByAgent", "replayOfEntry3"] {
        let e = apply_entry(Some(&state3), &h(&v["log"]["refused"][k])).unwrap_err();
        assert!(e.code == "bad-entry" || e.code == "bad-format", "{k}: {}", e.code);
    }
    // invites as the joining side
    let joiners = [laptop.clone(), agent.clone(), d("helper")];
    for (i, inv) in v["invites"].as_array().unwrap().iter().enumerate() {
        let log = &entries[..inv["logSeqBefore"].as_u64().unwrap() as usize + 1];
        let (request, join) = create_join_request(s(&inv["link"]), &h(&inv["offer"]), log, &joiners[i], inv["now"].as_u64().unwrap()).unwrap();
        assert_eq!(hex(&request), s(&inv["request"]));
        assert_eq!(check_reveal(&join, &h(&inv["reveal"]), log).unwrap(), s(&inv["checkCode"]));
        let mut l2 = log.to_vec();
        l2.push(h(&inv["entry"]));
        let wrap = inv["wrap"].as_str().map(|w| unhex(w).unwrap());
        let (_, secret) = complete_join(&join, &joiners[i], &l2, wrap.as_deref()).unwrap();
        if inv["role"] == 1 {
            assert_eq!(hex(&secret.unwrap().key), s(&v["room"]["secret"]["key"]));
        } else {
            assert!(secret.is_none());
        }
    }
    let s1 = unwrap_epoch_key(&state3, &phone, &h(&v["room"]["wraps"][0]["sealed"]), 1).unwrap();
    assert_eq!(hex(&s1.key), s(&v["room"]["secret"]["key"]));
    // back links down from epoch 3
    let rc = &v["epochChanges"]["recover"];
    let rm = &v["epochChanges"]["remove"];
    let tw = rc["wraps"].as_array().unwrap().iter().find(|w| w["recipient"] == "tablet").unwrap();
    let s3 = unwrap_epoch_key(&full, &tablet, &h(&tw["sealed"]), 3).unwrap();
    let s2 = open_back_link(&full, &s3, &h(&rc["backLink"])).unwrap();
    let s1b = open_back_link(&full, &s2, &h(&rm["backLink"])).unwrap();
    assert_eq!(hex(&s1b.key), s(&v["room"]["secret"]["key"]));
    // envelopes in the agent's order, and the gate
    let ssec = Secret { epoch: 1, key: h(&v["envelopes"]["session"]["sessionKey"]["key"]).try_into().unwrap(), hist: None };
    let secrets = |hd: &Header| if hd.key_scope == 1 { Some(ssec.clone()) } else { None };
    let mut chains = Chains::new();
    let chat = open_envelope(&h(&v["envelopes"]["chat"]["bytes"]), &state3, &mut chains, &secrets, None, &VerifyOpts::default(), true).unwrap();
    assert_eq!(chat.payload.unwrap(), b"hello");
    let mut phone_chains = Chains::new();
    let pruned = verify_envelope(&h(&v["envelopes"]["pruned"]), &state3, &mut phone_chains, &VerifyOpts::default()).unwrap();
    assert_eq!(hex(&pruned.hash), s(&v["envelopes"]["chat"]["hash"]));
    let card = open_envelope(&h(&v["envelopes"]["card"]["bytes"]), &state3, &mut phone_chains, &secrets, None, &VerifyOpts::default(), true).unwrap();
    assert_eq!(card.v.header.kind, 2);
    assert_eq!(card.v.header.card.unwrap().urgency, 2);
    chains.insert(b64u(&agent.id), Chain { seq: 1, hash: card.v.hash, hashes: [(1, card.v.hash)].into_iter().collect(), told: None });
    let answer = open_envelope(&h(&v["envelopes"]["answer"]["bytes"]), &state3, &mut chains, &secrets, Some(&agent.id), &VerifyOpts::default(), true).unwrap();
    assert_eq!(answer.v.header.seq, 2);
    let ctx = AuthCtx {
        state: &state3, agent_id: agent.id, now: T0 + 3, epoch_changed_at: None, own_seq: 1, max_age_ms: None, seen_of_me: 0, session_epoch: Some(1),
        card: Some(CardCtx { id: h(&v["envelopes"]["card"]["cardId"]).try_into().unwrap(), hash: h(&v["envelopes"]["card"]["hash"]).try_into().unwrap(), open: true, options: Some(vec!["yes".into(), "no".into()]) }),
        decision: None, request: None,
    };
    assert!(!authorise_command(&answer.v.header, false, answer.bind.as_deref(), &ctx).unwrap());
    let bad_ctx = AuthCtx { card: Some(CardCtx { id: h(&v["envelopes"]["card"]["cardId"]).try_into().unwrap(), hash: [0; 32], open: true, options: None }), ..ctx };
    assert_eq!(authorise_command(&answer.v.header, false, answer.bind.as_deref(), &bad_ctx).unwrap_err().code, "card-changed");
    let back = open_envelope(&h(&v["envelopes"]["afterRecovery"]["bytes"]), &full, &mut chains, &secrets, Some(&agent.id), &VerifyOpts::default(), true).unwrap();
    assert_eq!(back.payload.unwrap(), b"back again");
    let e = verify_envelope(&h(&v["envelopes"]["answer"]["bytes"]), &full, &mut Chains::new(), &VerifyOpts { allow_chain_start: true, ..Default::default() }).unwrap_err();
    assert_eq!(e.code, "removed-sender");
    // a replay and a gap
    let e = open_envelope(&h(&v["envelopes"]["chat"]["bytes"]), &state3, &mut chains, &secrets, None, &VerifyOpts::default(), true).unwrap_err();
    assert_eq!(e.code, "replay");
    let e = verify_envelope(&h(&v["envelopes"]["answer"]["bytes"]), &state3, &mut Chains::new(), &VerifyOpts::default()).unwrap_err();
    assert_eq!(e.code, "gap");
    // a flipped byte in the signature
    let mut forged = h(&v["envelopes"]["chat"]["bytes"]);
    let n = forged.len();
    forged[n - 1] ^= 1;
    assert_eq!(verify_envelope(&forged, &state3, &mut Chains::new(), &VerifyOpts::default()).unwrap_err().code, "bad-signature");
    // assets
    assert_eq!(decrypt_asset(&h(&v["assets"]["small"]["blob"]), &h(&v["assets"]["small"]["key"]), Some(&h(&v["assets"]["small"]["sha256"]))).unwrap(), b"asset");
    assert_eq!(parse_invite_link(s(&v["invites"][0]["link"])).unwrap().hub, "https://hub.example");
}

/// session-grants: the agent's view of a grant chain (first grant, handover with and without history, child session).
#[test]
fn session_grants() {
    let phone = dev(0x11, 0x12);
    let code = format_recovery_code(&[7u8; 32]);
    let rec = recovery_device(&code).unwrap();
    let room = create_room(&phone, KeyPair { sign_pub: rec.sign_pub, kex_pub: rec.kex_pub }, T0, &mut Rng::Os).unwrap();
    let (a1, a2) = (Device::generate(), Device::generate());
    let (_, st) = add_member(&room.state, &phone, MemberKeys { role: ROLE_AGENT, sign_pub: a1.sign_pub, kex_pub: a1.kex_pub }, ZERO16, T0).unwrap();
    let (_, st) = add_member(&st, &phone, MemberKeys { role: ROLE_AGENT, sign_pub: a2.sign_pub, kex_pub: a2.kex_pub }, ZERO16, T0).unwrap();
    let wrap_for = |wraps: &[([u8; 32], Vec<u8>)], d: &Device| wraps.iter().find(|w| w.0 == d.id).map(|w| w.1.clone());
    let g1 = create_session_grant(&st, &phone, None, None, None, &[a1.id], None, false, false, T0, &mut Rng::Os).unwrap();
    assert_eq!(g1.wraps.len(), 3);
    assert_eq!(grant_manifest_hash(&g1.wraps), g1.session_state.manifest_hash);
    let k = unwrap_session_key(&st.room_id, &g1.session_state, &a1, &wrap_for(&g1.wraps, &a1).unwrap(), 1).unwrap();
    assert_eq!(k.key, g1.secret.key);
    assert!(k.hist.is_none());
    assert!(wrap_for(&g1.wraps, &a2).is_none());
    // handover without history
    let g2 = create_session_grant(&st, &phone, Some(&g1.session_state), None, Some(&g1.secret), &[a2.id], None, false, true, T0, &mut Rng::Os).unwrap();
    assert_eq!(g2.session_state.epoch, 2);
    let k2 = unwrap_session_key(&st.room_id, &g2.session_state, &a2, &wrap_for(&g2.wraps, &a2).unwrap(), 2).unwrap();
    assert!(k2.hist.is_none());
    // a human walks back through the back link
    let kp = unwrap_session_key(&st.room_id, &g2.session_state, &phone, &wrap_for(&g2.wraps, &phone).unwrap(), 2).unwrap();
    let prev = open_session_back_link(&st.room_id, &g2.session_state, &kp, g2.back_link.as_ref().unwrap()).unwrap();
    assert_eq!(prev.key, g1.secret.key);
    // verify the chain from the bytes
    let s = verify_grants(&[g1.grant.clone(), g2.grant.clone()], &st).unwrap().unwrap();
    assert_eq!(s.agent_ids, vec![hex(&a2.id)]);
    // a re-seal in the same epoch that drops an agent is refused
    let g3 = create_session_grant(&st, &phone, Some(&g2.session_state), None, Some(&g2.secret), &[a1.id, a2.id], None, false, false, T0, &mut Rng::Os).unwrap();
    assert_eq!(g3.session_state.agent_ids.len(), 2);
    let e = create_session_grant(&st, &phone, Some(&g3.session_state), None, Some(&g2.secret), &[a1.id], None, false, false, T0, &mut Rng::Os).unwrap_err();
    assert_eq!(e.code, "bad-grant");
    // an agent's own child session: first grant only, itself alone
    let c = create_session_grant(&st, &a1, None, None, None, &[a1.id], None, false, false, T0, &mut Rng::Os).unwrap();
    assert!(c.session_state.created_by_agent);
    assert_eq!(c.wraps.len(), 3);
    let e = create_session_grant(&st, &a1, Some(&c.session_state), None, Some(&c.secret), &[a1.id], None, false, true, T0, &mut Rng::Os).unwrap_err();
    assert_eq!(e.code, "not-human");
    // after a removal the session is stale and the next grant must rotate
    let rm = remove_members(&st, &phone, &[a2.id], &HashMap::new(), Some(&room.secret), T0, &mut Rng::Os).unwrap();
    assert!(grant_is_stale(&g3.session_state, &rm.state));
}
