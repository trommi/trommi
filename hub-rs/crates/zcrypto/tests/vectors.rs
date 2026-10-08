//! shared/crypto/vectors.json, checked byte for byte against this implementation (FORMAT.md section 18).
//! Where the JS side drew randomness, the vectors' generator (`rng`) is replayed, so sealed boxes are rebuilt exactly.

use serde_json::Value;
use zcrypto::bytes::{arr32, hex, unhex};
use zcrypto::envelope::*;
use zcrypto::invite::*;
use zcrypto::log::*;
use zcrypto::prim::*;
use zcrypto::*;

fn vectors() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../shared/crypto/vectors.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("vectors.json")).unwrap()
}
fn h(v: &Value) -> Vec<u8> { unhex(v.as_str().unwrap_or_else(|| panic!("not a hex string: {v}"))).unwrap() }
fn n(v: &Value) -> u64 { v.as_u64().unwrap() }
/// Call c of the vectors' generator with seed s: byte j = (s + 17c + j) mod 256.
fn rng(seed: u64, call: u64, len: usize) -> Vec<u8> { (0..len).map(|j| ((seed + 17 * call + j as u64) % 256) as u8).collect() }

fn device(v: &Value, name: &str) -> Device {
    let d = &v["devices"][name];
    Device::from_seeds(&arr32(&h(&d["signSeed"])), &arr32(&h(&d["kexSeed"])))
}
fn recovery_of(v: &Value) -> Device { recovery_device(&h(&v["recovery"]["raw"])) }
fn by_name(v: &Value, name: &str) -> Device {
    if name == "recovery key" { recovery_of(v) } else { device(v, name) }
}
fn log_state(v: &Value, upto: usize) -> LogState {
    let entries: Vec<Vec<u8>> = v["log"]["entries"].as_array().unwrap()[..upto].iter().map(|e| h(&e["bytes"])).collect();
    verify_log(&entries, Some(&h(&v["room"]["roomId"]))).unwrap()
}
struct NoChains;
impl ChainLookup for NoChains {
    fn head(&self, _: &[u8; 32]) -> Option<(u64, [u8; 32])> { None }
    fn hash_at(&self, _: &[u8; 32], _: u64) -> Option<[u8; 32]> { None }
}
struct Chains(Vec<([u8; 32], u64, [u8; 32])>);
impl ChainLookup for Chains {
    fn head(&self, s: &[u8; 32]) -> Option<(u64, [u8; 32])> { self.0.iter().filter(|x| &x.0 == s).max_by_key(|x| x.1).map(|x| (x.1, x.2)) }
    fn hash_at(&self, s: &[u8; 32], q: u64) -> Option<[u8; 32]> { self.0.iter().find(|x| &x.0 == s && x.1 == q).map(|x| x.2) }
}

#[test]
fn encoding_hash_hkdf() {
    let v = vectors();
    let e = &v["encoding"];
    assert_eq!(b64u(&h(&e["bytes"])), e["base64url"].as_str().unwrap());
    assert_eq!(unb64u(e["base64url"].as_str().unwrap()).unwrap(), h(&e["bytes"]));
    assert_eq!(hash(e["hash"]["label"].as_str().unwrap(), &[&h(&e["hash"]["data"])]).to_vec(), h(&e["hash"]["out"]));
    let k = &e["hkdf"];
    assert_eq!(hkdf(&h(&k["ikm"]), &h(&k["salt"]), k["label"].as_str().unwrap(), &h(&k["context"]), n(&k["length"]) as usize), h(&k["out"]));
    // strict base64url
    assert!(unb64u("APv_EA==").is_err());
    assert!(unb64u("APv_EB").is_err(), "non-canonical tail");
    assert!(unb64u("A").is_err());
}

#[test]
fn devices_signature_recovery() {
    let v = vectors();
    for (name, d) in v["devices"].as_object().unwrap() {
        let dev = device(&v, name);
        assert_eq!(dev.sign_pub.to_vec(), h(&d["signPub"]), "{name} signPub");
        assert_eq!(dev.kex_pub.to_vec(), h(&d["kexPub"]), "{name} kexPub");
        assert_eq!(dev.id.to_vec(), h(&d["id"]), "{name} id");
        if !d["secretFile"].is_null() {
            assert_eq!(dev.secret_file(), h(&d["secretFile"]));
        }
    }
    let s = &v["signature"];
    let phone = device(&v, "phone");
    let sig = phone.sign(s["label"].as_str().unwrap(), &h(&s["message"]));
    assert_eq!(sig.to_vec(), h(&s["signature"]));
    assert!(verify(&phone.sign_pub, s["label"].as_str().unwrap(), &h(&s["message"]), &sig));
    assert!(!verify(&phone.sign_pub, label::LOG_ENTRY, &h(&s["message"]), &sig));
    let r = &v["recovery"];
    assert_eq!(format_recovery_code(&h(&r["raw"])), r["code"].as_str().unwrap());
    assert_eq!(parse_recovery_code(r["code"].as_str().unwrap()).unwrap(), h(&r["raw"]));
    assert_eq!(parse_recovery_code(&r["code"].as_str().unwrap().to_lowercase().replace('-', " ")).unwrap(), h(&r["raw"]));
    let rec = recovery_of(&v);
    assert_eq!(rec.sign_pub.to_vec(), h(&r["signPub"]));
    assert_eq!(rec.kex_pub.to_vec(), h(&r["kexPub"]));
    assert_eq!(rec.id.to_vec(), h(&r["id"]));
}

#[test]
fn sealed_box() {
    let v = vectors();
    let s = &v["sealedBox"];
    let to = device(&v, s["recipient"].as_str().unwrap());
    let sealed = seal_with(&arr32(&h(&s["ephemeralSeed"])), &to.kex_pub, &h(&s["plaintext"]), &h(&s["aad"])).unwrap();
    assert_eq!(sealed, h(&s["sealed"]));
    assert_eq!(open_sealed(&to, &sealed, &h(&s["aad"])).unwrap(), h(&s["plaintext"]));
    assert_eq!(open_sealed(&to, &sealed, b"other").unwrap_err().code, "decrypt-failed");
}

#[test]
fn room_genesis_and_wraps() {
    let v = vectors();
    let r = &v["room"];
    let state = apply_entry(None, &h(&r["genesis"])).unwrap();
    assert_eq!(state.room_id.to_vec(), h(&r["roomId"]));
    let secret = EpochSecret { epoch: 1, key: h(&r["secret"]["key"]), hist: Some(h(&r["secret"]["hist"])) };
    let (k, hc) = epoch_commits(&secret);
    assert_eq!(k.to_vec(), h(&r["keyCommit"]));
    assert_eq!(hc.unwrap().to_vec(), h(&r["histCommit"]));
    let seed = n(&r["rngSeed"]);
    assert_eq!(rng(seed, 1, 32), secret.key);
    for (i, w) in r["wraps"].as_array().unwrap().iter().enumerate() {
        let who = by_name(&v, w["recipient"].as_str().unwrap());
        assert_eq!(who.id.to_vec(), h(&w["recipientId"]));
        let mut plain = vec![2u8];
        plain.extend(&secret.key);
        plain.extend(secret.hist.as_ref().unwrap());
        let sealed = seal_with(&arr32(&rng(seed, 3 + i as u64, 32)), &who.kex_pub, &plain, &epoch_wrap_aad(&state.room_id, 1, &who.id)).unwrap();
        assert_eq!(sealed, h(&w["sealed"]), "wrap {i} rebuilt byte for byte");
        assert_eq!(unwrap_epoch_key(&state, &who, &sealed, 1).unwrap(), secret);
    }
}

#[test]
fn invites() {
    let v = vectors();
    for (i, inv) in v["invites"].as_array().unwrap().iter().enumerate() {
        let before = n(&inv["logSeqBefore"]) as usize;
        let state = log_state(&v, before + 1);
        let now = n(&inv["now"]) as i64;
        let room_id = h(&v["room"]["roomId"]);
        let (invite_id, mac_key) = invite_keys(&h(&inv["secret"]), &room_id);
        assert_eq!(invite_id.to_vec(), h(&inv["inviteId"]));
        let o = verify_invite_offer(&state, &h(&inv["offer"]), now).unwrap();
        assert_eq!(o.invite_id.to_vec(), h(&inv["inviteId"]));
        assert_eq!(o.expires_at, n(&inv["expiresAt"]));
        assert_eq!(verify_invite_offer(&state, &h(&inv["offer"]), n(&inv["expiresAt"]) as i64 + 1).unwrap_err().code, "invite-expired");
        assert_eq!(invite_offer_hash(&h(&inv["offer"])).unwrap().to_vec(), h(&inv["offerHash"]));
        let q = verify_invite_request(&h(&inv["request"])).unwrap();
        assert!(check_request_mac(&mac_key, &q.body, &q.mac), "the request carries the link's MAC");
        assert_eq!(q.offer_hash.to_vec(), h(&inv["offerHash"]));
        assert_eq!(q.hub, inv["hub"].as_str().unwrap());
        assert_eq!(invite_request_hash(&h(&inv["request"])).to_vec(), h(&inv["requestHash"]));
        let inviter = device(&v, inv["inviter"].as_str().unwrap());
        let rv = verify_invite_reveal(&state, &h(&inv["reveal"]), &inviter.id).unwrap();
        assert_eq!(rv.request_hash.to_vec(), h(&inv["requestHash"]));
        assert_eq!(rv.nonce.to_vec(), h(&inv["nonce"]));
        assert_eq!(hash(label::INVITE_COMMIT, &[&rv.invite_id, &rv.nonce]), o.commit);
        assert_eq!(invite_code(&h(&inv["offer"]), &h(&inv["request"]), &rv.nonce).unwrap(), inv["checkCode"].as_str().unwrap());
        // the add entry applies and names the invite
        let after = apply_entry(Some(&state), &h(&inv["entry"])).unwrap();
        assert!(after.invite_ids.contains(&o.invite_id));
        assert!(after.member_at(&q.id, None).is_some(), "invite {i}: the newcomer is a member");
        if inv["wrap"].is_string() {
            let newcomer = device(&v, inv["name"].as_str().unwrap().to_lowercase().as_str());
            let s = unwrap_epoch_key(&after, &newcomer, &h(&inv["wrap"]), 1).unwrap();
            assert_eq!(s.key, h(&inv["roomKeyOpened"]["key"]));
        }
        // hash of the request covers body and MAC, not the signature: a tampered byte is refused
        let mut bad = h(&inv["request"]);
        let last = bad.len() - 1;
        bad[last] ^= 1;
        assert_eq!(verify_invite_request(&bad).unwrap_err().code, "bad-signature");
    }
    assert!(check_hub_address("https://hub.trommi.com"));
    assert!(check_hub_address("http://127.0.0.1:8790"));
    assert!(!check_hub_address("https://Hub.trommi.com"));
    assert!(!check_hub_address("https://hub.trommi.com/"));
    assert!(!check_hub_address("http://example.com"));
}

#[test]
fn log_and_epoch_changes() {
    let v = vectors();
    let entries = v["log"]["entries"].as_array().unwrap();
    let mut state: Option<LogState> = None;
    for e in entries {
        let d = decode_entry(&h(&e["bytes"])).unwrap();
        assert_eq!(d.body, h(&e["body"]));
        assert_eq!(d.signature.to_vec(), h(&e["signature"]));
        assert_eq!(d.ty as u64, n(&e["type"]));
        let next = apply_entry(state.as_ref(), &h(&e["bytes"])).unwrap();
        assert_eq!(next.head_hash.to_vec(), h(&e["hash"]));
        assert_eq!(next.epoch as u64, n(&e["epochAfter"]));
        state = Some(next);
    }
    let state = state.unwrap();
    assert_eq!(state.epoch as u64, n(&v["log"]["finalEpoch"]));
    let mut active: Vec<String> = state.active_members().map(|m| hex(&m.id)).collect();
    active.sort();
    let mut want: Vec<String> = v["log"]["activeMembers"].as_array().unwrap().iter().map(|x| hex(&device(&v, x.as_str().unwrap()).id)).collect();
    want.sort();
    assert_eq!(active, want);
    let at3 = log_state(&v, 4);
    for (name, bytes) in v["log"]["refused"].as_object().unwrap() {
        if name == "about" {
            continue;
        }
        let err = apply_entry(Some(&at3), &h(bytes)).unwrap_err();
        assert!(["bad-entry", "bad-format", "bad-signature"].contains(&err.code.as_str()), "{name}: {err:?}");
    }
    // removal: wraps, back link, rebuilt byte for byte with the generator
    let rm = &v["epochChanges"]["remove"];
    let after_rm = log_state(&v, 5);
    assert_eq!(after_rm.head_hash.to_vec(), h(&rm["entryHash"]));
    let s2 = EpochSecret { epoch: 2, key: h(&rm["secret"]["key"]), hist: Some(h(&rm["secret"]["hist"])) };
    let (k, hc) = epoch_commits(&s2);
    assert_eq!(k.to_vec(), h(&rm["keyCommit"]));
    assert_eq!(hc.unwrap().to_vec(), h(&rm["histCommit"]));
    let seed = n(&rm["rngSeed"]);
    for (i, w) in rm["wraps"].as_array().unwrap().iter().enumerate() {
        let who = by_name(&v, w["recipient"].as_str().unwrap());
        let mut plain = vec![2u8];
        plain.extend(&s2.key);
        plain.extend(s2.hist.as_ref().unwrap());
        let sealed = seal_with(&arr32(&rng(seed, 2 + i as u64, 32)), &who.kex_pub, &plain, &epoch_wrap_aad(&after_rm.room_id, 2, &who.id)).unwrap();
        assert_eq!(sealed, h(&w["sealed"]), "removal wrap {i}");
    }
    let s1 = open_back_link(&after_rm, &s2, &h(&rm["backLink"])).unwrap();
    assert_eq!(s1.key, h(&v["room"]["secret"]["key"]));
    // recovery
    let rc = &v["epochChanges"]["recover"];
    let rec = recovery_of(&v);
    let opened = unwrap_epoch_key(&after_rm, &rec, &h(&rc["recoveryWrapUsed"]), 2).unwrap();
    assert_eq!(opened, s2);
    let s3 = EpochSecret { epoch: 3, key: h(&rc["secret"]["key"]), hist: Some(h(&rc["secret"]["hist"])) };
    let back = open_back_link(&state, &s3, &h(&rc["backLink"])).unwrap();
    assert_eq!(back, s2);
    let new_rec = recovery_device(&parse_recovery_code(rc["newCode"].as_str().unwrap()).unwrap());
    assert_eq!(new_rec.id.to_vec(), h(&rc["newRecovery"]["id"]));
    assert_eq!(state.recovery.id.to_vec(), h(&rc["newRecovery"]["id"]));
    let tablet = device(&v, "tablet");
    let w = &rc["wraps"][0];
    assert_eq!(unwrap_epoch_key(&state, &tablet, &h(&w["sealed"]), 3).unwrap(), s3);
}

fn check_envelope(v: &Value, e: &Value, state: &LogState, chains: &dyn ChainLookup, scope_key: &[u8]) {
    let bytes = h(&e["bytes"]);
    let vf = verify_envelope(&bytes, state, chains, false, false, true).unwrap();
    assert_eq!(vf.hash.to_vec(), h(&e["hash"]));
    assert_eq!(vf.ciphertext_hash.to_vec(), h(&e["ciphertextHash"]));
    assert_eq!(vf.split.header_bytes, h(&e["header"]));
    assert_eq!(vf.split.nonce.to_vec(), h(&e["nonce"]));
    assert_eq!(vf.split.ct.clone().unwrap(), h(&e["ciphertext"]));
    assert_eq!(vf.split.signature.to_vec(), h(&e["signature"]));
    let hs = &e["hubSees"];
    let hd = &vf.header;
    assert_eq!(hd.push, hs["push"].as_bool().unwrap());
    assert_eq!(hd.is_head, hs["isHead"].as_bool().unwrap());
    assert_eq!(hd.kind as u64, n(&hs["kind"]));
    assert_eq!(hd.timeline_kind.map(|x| x as u64), hs["timelineKind"].as_u64());
    assert_eq!(hd.timeline_id.as_deref(), hs["timelineId"].as_str());
    match (&hd.card, hs["card"].is_null()) {
        (None, true) => {}
        (Some(c), false) => {
            assert_eq!(c.id.to_vec(), h(&hs["card"]["id"]));
            assert_eq!(c.state as u64, n(&hs["card"]["state"]));
            assert_eq!(c.urgency as u64, n(&hs["card"]["urgency"]));
            assert_eq!(c.answered_at, n(&hs["card"]["answeredAt"]));
        }
        _ => panic!("card block"),
    }
    let blobs: Vec<String> = hd.blobs.iter().map(|b| hex(b)).collect();
    let want: Vec<String> = hs["blobs"].as_array().unwrap().iter().map(|b| b.as_str().unwrap().to_string()).collect();
    assert_eq!(blobs, want);
    assert_eq!(hd.seq, n(&e["seq"]));
    assert_eq!(hd.prev.to_vec(), h(&e["prev"]));
    assert_eq!(hd.log_seq as u64, n(&e["logSeq"]));
    assert_eq!(hd.time, n(&e["time"]));
    let (_, body) = open_body(&bytes, &h(&v["room"]["roomId"]), scope_key).unwrap();
    assert_eq!(body.payload, h(&e["payload"]));
    if e["bind"].is_string() {
        assert_eq!(body.bind, h(&e["bind"]));
    }
    // the pruned form verifies alike and carries the same hash
    let pruned = prune_envelope(&bytes).unwrap();
    let pv = verify_envelope(&pruned, state, chains, false, false, true).unwrap();
    assert_eq!(pv.hash, vf.hash);
    assert!(pv.split.pruned);
    // one changed byte of the body breaks the signature
    let mut bad = bytes.clone();
    let i = bad.len() - 80;
    bad[i] ^= 1;
    assert_eq!(verify_envelope(&bad, state, chains, false, false, true).unwrap_err().code, "bad-signature");
}

#[test]
fn envelopes_binds_hub_auth() {
    let v = vectors();
    let env = &v["envelopes"];
    let state4 = log_state(&v, 4);
    let room_id = h(&v["room"]["roomId"]);
    let sid = h(&env["session"]["sessionId"]);
    let skey = h(&env["session"]["sessionKey"]["key"]);
    let room_key = h(&v["room"]["secret"]["key"]);
    let phone = device(&v, "phone");
    let agent = device(&v, "agent");
    assert_eq!(derive_sender_key(&room_id, &room_key, 1, &phone.id, None), h(&env["senderKeys"]["phoneRoom"]));
    assert_eq!(derive_sender_key(&room_id, &skey, 1, &phone.id, Some(&sid)), h(&env["senderKeys"]["phoneSession"]));
    assert_eq!(derive_sender_key(&room_id, &skey, 1, &agent.id, Some(&sid)), h(&env["senderKeys"]["agentSession"]));
    assert_eq!(object_id_of(&agent.id, 1).to_vec(), h(&env["card"]["cardId"]));

    let chat_hash = arr32(&h(&env["chat"]["hash"]));
    check_envelope(&v, &env["chat"], &state4, &NoChains, &skey);
    let card_hash = arr32(&h(&env["card"]["hash"]));
    let with_chat = Chains(vec![(phone.id, 1, chat_hash)]);
    check_envelope(&v, &env["card"], &state4, &with_chat, &skey);
    let with_card = Chains(vec![(phone.id, 1, chat_hash), (agent.id, 1, card_hash)]);
    check_envelope(&v, &env["answer"], &state4, &with_card, &skey);
    let answer_hash = arr32(&h(&env["answer"]["hash"]));
    let with_answer = Chains(vec![(phone.id, 1, chat_hash), (phone.id, 2, answer_hash), (agent.id, 1, card_hash)]);
    check_envelope(&v, &env["desk"], &state4, &with_answer, &room_key);
    assert_eq!(prune_envelope(&h(&env["chat"]["bytes"])).unwrap(), h(&env["pruned"]));
    assert_eq!(prune_envelope(&h(&env["answer"]["bytes"])).unwrap(), h(&env["prunedAnswer"]));

    // chain rules
    let chat = h(&env["chat"]["bytes"]);
    assert_eq!(verify_envelope(&chat, &state4, &Chains(vec![(phone.id, 1, chat_hash)]), false, false, true).unwrap_err().code, "replay");
    assert_eq!(verify_envelope(&chat, &state4, &Chains(vec![(phone.id, 1, [9; 32])]), false, false, true).unwrap_err().code, "equivocation");
    assert_eq!(verify_envelope(&h(&env["answer"]["bytes"]), &state4, &NoChains, false, false, true).unwrap_err().code, "gap");

    // after the recovery: the tablet's first envelope, session scope
    let full = log_state(&v, 6);
    let ar = &env["afterRecovery"];
    let vf = verify_envelope(&h(&ar["bytes"]), &full, &NoChains, false, false, true).unwrap();
    assert_eq!(vf.hash.to_vec(), h(&ar["hash"]));
    let tablet = device(&v, "tablet");
    assert_eq!(derive_sender_key(&room_id, &skey, 1, &tablet.id, Some(&sid)), h(&ar["senderKey"]));
    // a removed sender is refused, as history accepted up to its cut
    assert_eq!(verify_envelope(&chat, &full, &NoChains, false, false, true).unwrap_err().code, "removed-sender");

    let b = &v["binds"];
    match decode_bind(KIND_ANSWER, &h(&b["answer"])).unwrap() {
        Bind::Answer { object_id, .. } => assert_eq!(object_id.to_vec(), h(&env["card"]["cardId"])),
        x => panic!("{x:?}"),
    }
    assert!(matches!(decode_bind(KIND_VERDICT, &h(&b["verdict"])).unwrap(), Bind::Verdict { .. }));
    assert!(matches!(decode_bind(KIND_DECIDE_AGAIN, &h(&b["decideAgain"])).unwrap(), Bind::DecideAgain { .. }));
    assert!(matches!(decode_bind(KIND_PERMISSION_REQUEST, &h(&b["request"])).unwrap(), Bind::Request { .. }));

    let ha = &v["hubAuth"];
    let st = log_state(&v, n(&ha["logSeq"]) as usize + 1);
    let a = verify_hub_auth(&h(&ha["signed"]), &st, ha["hub"].as_str().unwrap()).unwrap();
    assert_eq!(a.id, agent.id);
    assert_eq!(a.challenge.to_vec(), h(&ha["challenge"]));
    assert_eq!(verify_hub_auth(&h(&ha["signed"]), &st, "https://other.example").unwrap_err().code, "wrong-hub");
}

#[test]
fn assets() {
    let v = vectors();
    let s = &v["assets"]["small"];
    let blob = h(&s["blob"]);
    assert_eq!(sha256(&[&blob]).to_vec(), h(&s["sha256"]));
    assert_eq!(decrypt_asset(&blob, &h(&s["key"])).unwrap(), h(&s["plaintext"]));
}
