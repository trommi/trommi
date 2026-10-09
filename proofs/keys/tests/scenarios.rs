//! The ten scenarios of the proof. Each test says what it proves.
//! Variant markers: [vanilla] = plain RFC 9420 through OpenMLS; [custom] = Trommi's
//! own construct on top (always keyed by the standard exporter).

mod common;
use common::*;

use trommi_proof_keys::device::{Change, Device};
use trommi_proof_keys::hub::{Reject, Rows};
use trommi_proof_keys::{hex, rules, seal, LABEL_ARCHIVE};

/// 1. Founding. [vanilla: group, key package, Welcome, exporter] [custom: envelope]
/// The first human device founds the room group; the second joins by key package and
/// Welcome through the hub; both export the same room key and archive key; an
/// envelope sealed by one opens on the other, any number of times. (That the hub
/// holds no key is structural, not asserted: its struct keeps a `PublicGroup` and
/// ciphertext only.)
#[test]
fn s01_founding() {
    let mut a = Device::new("human/laptop");
    let mut b = Device::new("human/phone");
    let mut w = World::found(&mut a, "code-1");
    let room = w.room.clone();

    w.add_human(&mut a, &mut b);
    assert_eq!(a.epoch(&room), 1);
    assert_eq!(b.epoch(&room), 1);
    assert_eq!(w.hub.epoch(&room), 1);

    // the same keys on both devices, through the standard exporter
    assert_eq!(a.archive[&1], b.archive[&1]);
    assert_eq!(a.key(&room, 1), b.key(&room, 1));
    assert_ne!(a.archive[&0], a.archive[&1], "a new epoch, a new key");
    // b derived its keys from the Welcome alone: it never saw epoch 0
    assert!(b.key(&room, 0).is_none());

    // content: sealed by one, stored by the hub with a clear header, opened by the other
    let env = a.seal(&room, "note", b"buy milk");
    w.hub.post(env);
    let stored = &w.hub.items_of(&room)[0];
    assert_eq!((stored.epoch, stored.kind.as_str()), (1, "note"), "the hub can index it");
    assert_eq!(b.open(stored).unwrap(), b"buy milk");
    // and it opens again and again: sealing is stateless
    assert_eq!(b.open(stored).unwrap(), b"buy milk");
    assert_eq!(a.open(stored).unwrap(), b"buy milk", "the sender reads its own item");

    // the key package was handed out once
    assert_eq!(w.hub.unused_key_packages(&b.sig()), 0);
    // the hub knows who is in the room, from public messages
    let names: Vec<String> = w.hub.members(&room).into_iter().map(|m| m.0).collect();
    assert_eq!(names, vec!["human/laptop", "human/phone"]);
}

/// 2. A session. [vanilla: a second group; who reads what is plain membership]
/// A human device founds a session group with the other human device and one agent;
/// all three export the same session key. The agent is not in the room group: it
/// holds no room key and no archive key, was sent no room Welcome, and neither its
/// session key nor its session group's exporter yields a room key. (Shown by absence
/// and by two failed attempts; not a proof of key-schedule independence, which is
/// RFC 9420's.)
#[test]
fn s02_session() {
    let mut a = Device::new("human/laptop");
    let mut b = Device::new("human/phone");
    let mut agent = Device::new("agent/claude-1");
    let mut w = World::found(&mut a, "code-1");
    let room = w.room.clone();
    w.add_human(&mut a, &mut b);
    w.publish(&b, 2);
    w.publish(&agent, 2);
    w.enrol_agent(&mut a, &agent);
    w.sync(&mut b, &room).unwrap();
    assert_eq!(w.hub.role(&agent.sig()), "agent");
    assert_eq!(w.hub.role(&b.sig()), "human");

    let s = w.new_session(&mut a, "session-1", &[&b, &agent]);
    w.welcome(&mut b);
    w.welcome(&mut agent);
    assert_eq!(a.key(&s, 1), b.key(&s, 1));
    assert_eq!(a.key(&s, 1), agent.key(&s, 1));

    let env = agent.seal(&s, "chat", b"done");
    assert_eq!(a.open(&env).unwrap(), b"done");
    assert_eq!(b.open(&env).unwrap(), b"done");

    // the agent and the room
    assert!(agent.room.is_none() && !agent.groups.contains_key(&room));
    assert!(agent.archive.is_empty());
    let room_env = a.seal(&room, "note", b"private note");
    assert!(agent.open(&room_env).is_err());
    // the session key does not lead to the room's keys: they come from different
    // groups' key schedules. The only thing sealed "towards" the room is the session
    // key under the archive key, and that row points the other way.
    let row = &w.hub.epoch_keys[&(s.clone(), 1)];
    assert!(seal::open_epoch_key_row(agent.crypto(), row, agent.key(&s, 1).unwrap()).is_err());
    // the hub relayed exactly one Welcome to the agent: the session's
    assert_eq!(w.hub.welcome_log.iter().filter(|(to, _)| *to == agent.sig()).count(), 1);
    // an agent cannot export the room's archive key from the session group either:
    // the exporter is bound to the group's own secret
    let from_session = agent.group(&s).export_secret(agent.crypto(), LABEL_ARCHIVE, &room, 32).unwrap();
    assert!(a.archive.values().all(|k| *k != from_session));
}

/// 3. Epoch changes and history for a new human device. [custom: archive rows]
/// Several room epochs (add, update, add, remove) and several session epochs, with
/// content sealed in each. A third human device joins at the end and reads the
/// content of every earlier epoch through the hub's rows alone: no other device
/// sends it anything but the Welcome. The hub holds one archive row per room epoch
/// and one row per session epoch (here with 2 to 4 devices; a row is made per commit,
/// never per device). One changed row stops the walk. The hand-over variant at the
/// end is shown for the room's history only.
#[test]
fn s03_history_for_a_new_device() {
    let mut a = Device::new("human/laptop");
    let mut b = Device::new("human/phone");
    let mut tmp = Device::new("human/old-tablet");
    let mut agent = Device::new("agent/claude-1");
    let mut w = World::found(&mut a, "code-1");
    let room = w.room.clone();
    let mut sealed = vec![]; // (group, epoch, plaintext)
    let mut post = |w: &mut World, d: &Device, g: &[u8], text: String| {
        w.hub.post(d.seal(g, "item", text.as_bytes()));
        sealed.push((g.to_vec(), d.epoch(g), text));
    };

    post(&mut w, &a, &room, "room epoch 0".into());
    w.add_human(&mut a, &mut b); // epoch 1
    let h = a.handover(&room, 1); // used by the hand-over variant at the end only
    b.take_handover(&h).unwrap();
    post(&mut w, &a, &room, "room epoch 1".into());
    w.room_commit(&mut b, Change::default()).unwrap(); // epoch 2: b refreshes its keys
    w.sync(&mut a, &room).unwrap();
    post(&mut w, &b, &room, "room epoch 2".into());
    w.publish(&agent, 3);
    w.enrol_agent(&mut a, &agent); // epoch 3
    w.sync(&mut b, &room).unwrap();
    post(&mut w, &a, &room, "room epoch 3".into());

    // a session with three epochs of its own
    w.publish(&b, 3);
    let s = w.new_session(&mut a, "session-1", &[&b, &agent]); // session epoch 1
    w.welcome(&mut b);
    w.welcome(&mut agent);
    post(&mut w, &agent, &s, "session epoch 1".into());
    w.session_commit(&mut b, &s, Change::default()).unwrap(); // session epoch 2
    w.sync(&mut a, &s).unwrap();
    w.sync(&mut agent, &s).unwrap();
    post(&mut w, &agent, &s, "session epoch 2".into());

    w.add_human(&mut a, &mut tmp); // room epoch 4
    w.sync(&mut b, &room).unwrap();
    post(&mut w, &tmp, &room, "room epoch 4".into());
    w.room_commit(&mut a, Change { removes: vec![tmp.sig()], ..Default::default() }).unwrap(); // epoch 5
    w.sync(&mut b, &room).unwrap();
    post(&mut w, &b, &room, "room epoch 5".into());
    w.session_commit(&mut a, &s, Change::default()).unwrap(); // session epoch 3
    w.sync(&mut b, &s).unwrap();
    w.sync(&mut agent, &s).unwrap();
    post(&mut w, &agent, &s, "session epoch 3".into());

    // the third device joins the room at the end (room epoch 6)
    let mut c = Device::new("human/new-laptop");
    w.add_human(&mut b, &mut c);
    assert_eq!(c.epoch(&room), 6);
    assert_eq!(c.archive.len(), 1, "from the Welcome: the current archive key, nothing else");

    // it reads back through the rows only
    assert_eq!(c.walk_archive(&w.hub.archive), 6);
    let rows: Vec<_> = w.hub.epoch_keys.values().cloned().collect();
    assert_eq!(c.learn_epoch_keys(rows.iter()), 3);
    for (i, env) in w.hub.items.iter().enumerate() {
        assert_eq!(c.open(env).unwrap(), sealed[i].2.as_bytes(), "item {i}");
    }
    assert_eq!(w.hub.items.len(), 9);

    // what the hub holds: one row per room epoch (0..=6), one per session epoch (1..=3)
    assert_eq!(w.hub.archive.len(), 7);
    assert_eq!(w.hub.epoch_keys.len(), 3);
    let (archive_bytes, key_bytes) = w.hub.archive_bytes();
    println!("s03: archive rows {} = {} bytes ({} each); session key rows {} = {} bytes",
        w.hub.archive.len(), archive_bytes, w.hub.archive[&3].bytes(), w.hub.epoch_keys.len(), key_bytes);
    assert_eq!(w.hub.archive[&3].bytes(), 8 + 8 + 60 + 80);

    // a wrong row forges nothing and opens nothing
    let mut bad = w.hub.archive.clone();
    bad.get_mut(&6).unwrap().link.as_mut().unwrap()[20] ^= 1;
    let mut c2 = Device::new("x");
    c2.room = Some(room.clone());
    c2.archive.insert(6, c.archive[&6].clone());
    assert_eq!(c2.walk_archive(&bad), 0);

    // [variant, standard transport, custom payload] the same history without any hub
    // row: the adding device hands over the old epoch keys in one envelope per group.
    // It can only hand over what it holds itself: b got epoch 0 from a's hand-over.
    let mut d = Device::new("human/second-phone");
    w.add_human(&mut b, &mut d); // room epoch 7
    w.sync(&mut a, &room).unwrap();
    let h = b.handover(&room, 7);
    println!("s03: room hand-over for 7 epochs = {} bytes", h.body.len());
    assert_eq!(d.take_handover(&h).unwrap(), 7);
    for (i, env) in w.hub.items.iter().enumerate().filter(|(_, e)| e.group == room) {
        assert_eq!(d.open(env).unwrap(), sealed[i].2.as_bytes());
    }
}

/// 4. Recovery. [custom: rows sealed to the recovery key] [vanilla: external commit
/// from GroupInfo; custom: its authorisation by the recovery key's signature in the
/// commit's authenticated data]
/// (a) With the recovery private key (derived from the code) and the hub's rows alone,
///     everything is read: no device, no MLS state.
/// (b) A fresh device gets into the room group although no member device exists: an
///     external commit from the GroupInfo the hub stores, carrying the recovery key's
///     signature over (group, epoch, the device's signature key). Hub and devices
///     refuse an external commit without it.
/// (c) An external commit cannot remove other leaves (RFC 9420 12.2): removing the
///     lost devices and setting a new code is a second, ordinary commit. The link to
///     the old history is published only with that second commit, from an epoch whose
///     only member is the fresh device.
/// (d) Why: if the link is published in the epoch right after the external commit, a
///     leaf that a careless or hostile hub let into the tree reads the whole history.
/// (e) The fresh device joins each live session group by external commit too.
/// The vanilla alternative (recovery as an offline member) is `v02` in vanilla.rs.
#[test]
fn s04_recovery() {
    let mut a = Device::new("human/laptop");
    let mut b = Device::new("human/phone");
    let mut agent = Device::new("agent/claude-1");
    let mut w = World::found(&mut a, "code-1");
    let room = w.room.clone();
    let mut texts = vec![];
    w.hub.post(a.seal(&room, "note", b"r0"));
    texts.push("r0");
    w.add_human(&mut a, &mut b);
    w.publish(&b, 2);
    w.publish(&agent, 2);
    w.enrol_agent(&mut a, &agent);
    w.sync(&mut b, &room).unwrap();
    w.hub.post(b.seal(&room, "note", b"r2"));
    texts.push("r2");
    let s = w.new_session(&mut a, "session-1", &[&b, &agent]);
    w.welcome(&mut b);
    w.welcome(&mut agent);
    w.hub.post(agent.seal(&s, "chat", b"s1"));
    texts.push("s1");
    w.session_commit(&mut b, &s, Change::default()).unwrap();
    w.sync(&mut agent, &s).unwrap();
    w.hub.post(agent.seal(&s, "chat", b"s2"));
    texts.push("s2");
    let last = w.hub.epoch(&room);
    drop((a, b)); // every human device is gone

    // (a) the code and the rows
    let crypto = agent.crypto(); // any crypto provider: no state
    let rec = seal::Recovery::from_code(crypto, "code-1");
    let mut n = Device::new("human/new-laptop");
    let newest = &w.hub.archive[&last];
    let key = seal::open_recovery_copy(n.crypto(), &room, newest, &rec.hpke_private).unwrap();
    n.archive.insert(last, key.clone());
    n.keys.insert((room.clone(), last), seal::kdf(n.crypto(), &key, trommi_proof_keys::LABEL_CONTENT));
    assert_eq!(n.walk_archive_of(&room, &w.hub.archive) as u64, last);
    let rows: Vec<_> = w.hub.epoch_keys.values().cloned().collect();
    assert_eq!(n.learn_epoch_keys(rows.iter()), rows.len());
    for (i, env) in w.hub.items.iter().enumerate() {
        assert_eq!(n.open(env).unwrap(), texts[i].as_bytes());
    }
    // the wrong code opens nothing
    let wrong = seal::Recovery::from_code(n.crypto(), "code-2");
    assert!(seal::open_recovery_copy(n.crypto(), &room, newest, &wrong.hpke_private).is_err());

    // (b) an external commit without the recovery key's signature: refused by the hub
    let mut thief = Device::new("human/thief");
    let out = thief.external_join(&w.hub.group_info(&room), b"no signature".to_vec()).unwrap();
    let r = w.hub.submit(&out, Rows::default()).unwrap_err();
    assert!(matches!(r, Reject::Rule(_)), "{r:?}");
    thief.forget(&room);

    // ... and with it: accepted. The row of this epoch carries NO link yet.
    let aad = rules::recovery_authorisation(&rec.signer, &room, last, &n.sig());
    let out = n.external_join(&w.hub.group_info(&room), aad).unwrap();
    n.room = Some(room.clone());
    let (_, staged_archive) = n.staged_keys(&room);
    let row = seal::make_archive_row(n.crypto(), &room, last + 1, &staged_archive.unwrap(), None, &rec.hpke_public);
    w.hub.submit(&out, Rows { archive: Some(row), epoch_key: None }).unwrap();
    n.confirm(&room);
    assert_eq!(w.hub.members(&room).len(), 3, "the lost devices are still leaves");

    // (c) second commit: the lost devices out, a new code in; now the link, skipping
    // the in-between epoch
    let lost: Vec<_> = n.members(&room).into_iter().filter(|k| *k != n.sig()).collect();
    let rec2 = seal::Recovery::from_code(n.crypto(), "code-NEW");
    let mut meta = n.meta(&room);
    meta.recovery_sign = Some(hex(rec2.signer.public()));
    meta.recovery_hpke = Some(hex(&rec2.hpke_public));
    let out = n.commit(&room, Change { removes: lost.clone(), meta: Some(meta), ..Default::default() }).unwrap();
    let (_, staged_archive) = n.staged_keys(&room);
    let row = seal::make_archive_row(n.crypto(), &room, last + 2, &staged_archive.unwrap(), Some((last, &n.archive[&last])), &rec2.hpke_public);
    w.hub.submit(&out, Rows { archive: Some(row), epoch_key: None }).unwrap();
    n.confirm(&room);
    assert_eq!(w.hub.members(&room).len(), 1);
    // the new code reads the whole history through the links; the old code reads
    // nothing sealed from now on
    let newest = &w.hub.archive[&(last + 2)];
    let k2 = seal::open_recovery_copy(n.crypto(), &room, newest, &rec2.hpke_private).unwrap();
    let mut reader = Device::new("reader");
    reader.archive.insert(last + 2, k2);
    assert_eq!(reader.walk_archive_of(&room, &w.hub.archive) as u64, last + 1, "one link over the gap, then the old chain to epoch 0");
    assert!(reader.archive.contains_key(&0) && !reader.archive.contains_key(&(last + 1)));
    assert!(seal::open_recovery_copy(n.crypto(), &room, newest, &rec.hpke_private).is_err());

    // (e) the session: the fresh device joins by external commit (it is a room leaf now),
    // then removes the lost devices there too; the agent follows and they talk
    w.external_session(&mut n, &s).unwrap();
    w.session_commit(&mut n, &s, Change { removes: lost, ..Default::default() }).unwrap();
    w.sync(&mut agent, &s).unwrap();
    let env = agent.seal(&s, "chat", b"welcome back");
    assert_eq!(n.open(&env).unwrap(), b"welcome back");
    assert_eq!(w.hub.members(&s).len(), 2);
}

/// 4d. The attack that fixes the order in scenario 4. [finding]
/// A hub that does not enforce the rule lets a stranger into the room group by an
/// unauthorised external commit while no human device is online to refuse it. If the
/// recovering device then publishes the link to the old history in the epoch right
/// after its own external commit, the stranger (a member of that epoch) opens the
/// link and with it every earlier epoch.
#[test]
fn s04d_link_published_too_early_leaks_history() {
    let mut a = Device::new("human/laptop");
    let mut w = World::found(&mut a, "code-1");
    let room = w.room.clone();
    w.room_commit(&mut a, Change::default()).unwrap();
    w.hub.post(a.seal(&room, "note", b"old secret"));
    let last = w.hub.epoch(&room);

    // an honest device refuses the stranger's commit
    let mut x = Device::new("stranger");
    let out = x.external_join(&w.hub.group_info(&room), vec![]).unwrap();
    assert!(a.process(&room, &out.commit, None).unwrap_err().contains("recovery key"));
    drop(a);
    // a hub without the rule takes it
    w.hub.enforce_rules = false;
    w.hub.submit(&out, Rows::default()).unwrap();
    x.confirm(&room);

    // the owner recovers and, wrongly, links in the first epoch
    let rec = seal::Recovery::from_code(x.crypto(), "code-1");
    let mut n = Device::new("human/new-laptop");
    let old = seal::open_recovery_copy(n.crypto(), &room, &w.hub.archive[&last], &rec.hpke_private).unwrap();
    let aad = rules::recovery_authorisation(&rec.signer, &room, last + 1, &n.sig());
    let out = n.external_join(&w.hub.group_info(&room), aad).unwrap();
    n.room = Some(room.clone());
    let (_, staged) = n.staged_keys(&room);
    let row = seal::make_archive_row(n.crypto(), &room, last + 2, &staged.unwrap(), Some((last, &old)), &rec.hpke_public);
    w.hub.submit(&out, Rows { archive: Some(row), epoch_key: None }).unwrap();
    n.confirm(&room);

    // the stranger follows the commit, derives that epoch's archive key, opens the link
    x.room = Some(room.clone());
    x.process(&room, &out.commit, None).unwrap();
    assert!(x.walk_archive(&w.hub.archive) >= 1);
    assert_eq!(x.open(&w.hub.items[0]).unwrap(), b"old secret", "history leaked");
}

/// 5. Removal heals. [vanilla: Remove commit] [custom: nothing new]
/// After a human device is removed from the room group it cannot derive the next
/// epoch's keys, cannot open the new archive row, and cannot open session keys sealed
/// under the new archive key. It keeps everything up to its removal: its own keys and,
/// through the rows, all earlier history. A gap is asserted too: until it is also
/// removed from each session group (one commit per session) it still reads that
/// session; the hub and the other members refuse its commits there meanwhile.
#[test]
fn s05_removal_heals() {
    let mut a = Device::new("human/laptop");
    let mut b = Device::new("human/phone");
    let mut c = Device::new("human/stolen-tablet");
    let mut agent = Device::new("agent/claude-1");
    let mut w = World::found(&mut a, "code-1");
    let room = w.room.clone();
    w.hub.post(a.seal(&room, "note", b"before anyone joined"));
    w.add_human(&mut a, &mut b);
    w.add_human(&mut a, &mut c);
    w.sync(&mut b, &room).unwrap();
    for d in [&b, &c, &agent] {
        w.publish(d, 2);
    }
    w.enrol_agent(&mut a, &agent);
    w.sync(&mut b, &room).unwrap();
    w.sync(&mut c, &room).unwrap();
    let s = w.new_session(&mut a, "session-1", &[&b, &c, &agent]);
    for d in [&mut b, &mut c, &mut agent] {
        w.welcome(d);
    }
    w.hub.post(agent.seal(&s, "chat", b"while the tablet was a member"));

    // removal from the room group
    let removed_at = w.room_commit(&mut a, Change { removes: vec![c.sig()], ..Default::default() }).unwrap();
    // The phone has not seen the removal yet. A session commit from it would seal the
    // new session key under an archive key the tablet still holds: the hub refuses it.
    let stale = w.session_commit(&mut b, &s, Change::default()).unwrap_err();
    assert!(matches!(&stale, Reject::Rule(m) if m.contains("stale room epoch")), "{stale:?}");
    w.sync(&mut b, &room).unwrap();
    w.sync(&mut c, &room).unwrap(); // the tablet even sees the commit that removes it
    assert!(!c.group(&room).is_active());
    assert!(c.key(&room, removed_at).is_none() && !c.archive.contains_key(&removed_at));
    let after = b.seal(&room, "note", b"after the removal");
    assert!(c.open(&after).is_err());
    // the new archive row does not open with any key the tablet holds
    let row = &w.hub.archive[&removed_at];
    assert!(c.archive.values().all(|k| seal::open_link(c.crypto(), &room, row, k).is_err()));
    assert_eq!(w.hub.role(&c.sig()), "unknown");

    // the gap: still a leaf of the session group
    let gap = agent.seal(&s, "chat", b"said before the session was re-keyed");
    assert_eq!(c.open(&gap).unwrap(), b"said before the session was re-keyed");
    // but it can no longer act there: the hub refuses, and so does every device
    let out = c.commit(&s, Change::default()).unwrap();
    assert!(matches!(w.hub.submit(&out, Rows::default()).unwrap_err(), Reject::Rule(_)));
    assert!(a.process(&s, &out.commit, None).is_err());
    c.abort(&s);

    // removal from the session group: one more commit
    let s_epoch = w.session_commit(&mut a, &s, Change { removes: vec![c.sig()], ..Default::default() }).unwrap();
    w.sync(&mut b, &s).unwrap();
    w.sync(&mut agent, &s).unwrap();
    let view = w.hub.room_view();
    for cm in w.hub.commits_since(&s, c.epoch(&s)) {
        c.process(&s, &cm, view.as_ref()).unwrap();
    }
    let healed = agent.seal(&s, "chat", b"after the session was re-keyed");
    assert!(c.open(&healed).is_err());
    // the session's new key is sealed under the NEW archive key: closed to the tablet
    let ek = &w.hub.epoch_keys[&(s.clone(), s_epoch)];
    assert_eq!(ek.room_epoch, removed_at);
    assert!(c.archive.values().all(|k| seal::open_epoch_key_row(c.crypto(), ek, k).is_err()));

    // what it keeps: everything up to its removal, the time before its own join included
    c.room = Some(room.clone());
    let walked = c.walk_archive(&w.hub.archive);
    assert_eq!(walked as u64, removed_at - 1, "back from its last epoch to epoch 0");
    assert_eq!(c.open(&w.hub.items[0]).unwrap(), b"before anyone joined");
    assert_eq!(c.open(&w.hub.items[1]).unwrap(), b"while the tablet was a member");
}

/// 6. Agent takeover. [vanilla: one commit with Remove + Add] [custom: the hand-over's
/// payload; its transport can be the envelope or a standard MLS application message]
/// One commit by a human device removes the crashed agent and adds the new one. With
/// history (the default): one small message hands the new agent this session's old
/// epoch keys, and it reads the session from its start. Without: it reads from its
/// joining. The removed agent cannot open what is sealed in the new epoch. The new
/// agent holds no key of another session or of the room. An agent in an ordinary
/// session cannot add a device (so it cannot hand the session on by itself). An agent
/// that lost its state comes back by external commit under its own signature key.
#[test]
fn s06_agent_takeover() {
    let mut a = Device::new("human/laptop");
    let mut b = Device::new("human/phone");
    let mut agent1 = Device::new("agent/claude-1");
    let seed2 = b"agent-2 device seed (stands for a kept signature key)".to_vec();
    let mut agent2 = Device::from_seed("agent/claude-2", &seed2);
    let mut agent3 = Device::new("agent/claude-3");
    let mut w = World::found(&mut a, "code-1");
    let room = w.room.clone();
    w.add_human(&mut a, &mut b);
    w.publish(&b, 4);
    for ag in [&agent1, &agent2, &agent3] {
        w.publish(ag, 3);
        w.enrol_agent(&mut a, ag);
    }
    w.sync(&mut b, &room).unwrap();
    let room_note = a.seal(&room, "note", b"room only");

    let s = w.new_session(&mut a, "session-1", &[&b, &agent1]);
    let other = w.new_session(&mut a, "session-2", &[&b, &agent1]);
    w.welcome(&mut b);
    w.welcome(&mut agent1);
    let other_item = agent1.seal(&other, "chat", b"other session");
    w.hub.post(agent1.seal(&s, "chat", b"first message"));
    w.session_commit(&mut b, &s, Change::default()).unwrap();
    w.sync(&mut a, &s).unwrap();
    w.sync(&mut agent1, &s).unwrap();
    w.hub.post(agent1.seal(&s, "chat", b"second message"));
    let old_items = w.hub.items_of(&s);

    // --- the takeover: ONE commit ---
    let commits_before = w.hub.groups[&s].commits.len();
    let kp = w.hub.take_key_package(&agent2.sig()).unwrap();
    let e = w.session_commit(&mut a, &s, Change { adds: vec![kp], removes: vec![agent1.sig()], ..Default::default() }).unwrap();
    assert_eq!(w.hub.groups[&s].commits.len(), commits_before + 1);
    // ... plus ONE small message from the same human device
    let h = a.handover(&s, e);
    println!("s06: hand-over for {} epochs = {} bytes sealed ({} bytes of keys)", e, h.body.len(), e * 40);
    w.hub.post(h.clone());
    w.sync(&mut b, &s).unwrap();
    w.welcome(&mut agent2);
    assert!(agent2.open(&old_items[0]).is_err(), "before the hand-over: from its joining only");
    assert_eq!(agent2.take_handover(&h).unwrap() as u64, e);
    assert_eq!(agent2.open(&old_items[0]).unwrap(), b"first message");
    assert_eq!(agent2.open(&old_items[1]).unwrap(), b"second message");

    // the removed agent
    w.sync(&mut agent1, &s).unwrap();
    assert!(!agent1.group(&s).is_active());
    let later = agent2.seal(&s, "chat", b"after the takeover");
    assert!(agent1.open(&later).is_err());
    assert!(agent1.open(&h).is_err(), "the hand-over is sealed in the new epoch");
    assert_eq!(a.open(&later).unwrap(), b"after the takeover");

    // the new agent holds keys of this one session only
    assert!(agent2.keys.keys().all(|(g, _)| *g == s));
    assert!(agent2.open(&other_item).is_err() && agent2.open(&room_note).is_err());
    assert!(agent2.archive.is_empty() && agent2.room.is_none());

    // an agent cannot perform a takeover
    let kp = w.hub.take_key_package(&agent3.sig()).unwrap();
    let out = agent2.commit(&s, Change { adds: vec![kp], removes: vec![], ..Default::default() }).unwrap();
    assert!(matches!(w.hub.submit(&out, Rows::default()).unwrap_err(), Reject::Rule(_)));
    assert!(a.process(&s, &out.commit, None).unwrap_err().contains("an agent adds and removes nobody"));
    agent2.abort(&s);

    // the same agent, state lost: back by external commit under its own signature key;
    // the human device sends the hand-over again
    drop(agent2);
    let mut agent2 = Device::from_seed("agent/claude-2", &seed2);
    let e = w.external_session(&mut agent2, &s).unwrap();
    w.sync(&mut a, &s).unwrap();
    w.sync(&mut b, &s).unwrap();
    assert_eq!(w.hub.members(&s).len(), 3, "its old leaf was replaced, not doubled");
    // an agent's external commit comes without the epoch's key row: a human device files it
    assert!(!w.hub.epoch_keys.contains_key(&(s.clone(), e)));
    w.hub.put_epoch_key(a.epoch_key_row(&s, e, a.key(&s, e).unwrap()));
    agent2.take_handover(&a.handover(&s, e)).unwrap();
    assert_eq!(agent2.open(&old_items[0]).unwrap(), b"first message");
    assert_eq!(agent2.open(&later).unwrap(), b"after the takeover");

    // --- a takeover WITHOUT history ---
    let kp = w.hub.take_key_package(&agent3.sig()).unwrap();
    w.session_commit(&mut a, &s, Change { adds: vec![kp], removes: vec![agent2.sig()], ..Default::default() }).unwrap();
    w.welcome(&mut agent3);
    assert!(agent3.open(&old_items[1]).is_err() && agent3.open(&later).is_err());
    let now = a.seal(&s, "chat", b"from here on");
    assert_eq!(agent3.open(&now).unwrap(), b"from here on");

    // [vanilla transport] the same hand-over as a standard MLS application message:
    // it opens once, which is all a hand-over needs
    let keys: Vec<(u64, Vec<u8>)> = a.keys.range((s.clone(), 0)..(s.clone(), u64::MAX)).map(|((_, e), k)| (*e, k.clone())).collect();
    let msg = app_send(&mut a, &s, &seal::handover_body(&keys));
    let body = app_open(&mut agent3, &s, &msg).unwrap();
    for (e, k) in seal::parse_handover(&body).unwrap() {
        agent3.keys.insert((s.clone(), e), k);
    }
    assert_eq!(agent3.open(&old_items[0]).unwrap(), b"first message");
    assert!(app_open(&mut agent3, &s, &msg).is_err());
}

/// 7. Helper sessions, founded by an agent. [vanilla: group creation, Add from key
/// packages, last-resort key packages] [custom: the rule, checked by the hub on the
/// public state and by every human device on its Welcome]
/// The rule as agreed: an agent may start a helper by itself and add its helper's agent
/// devices to that group; it must add every human device of the room in the founding
/// commit; human devices verify on first contact.
#[test]
fn s07_helper_founded_by_an_agent() {
    let mut a = Device::new("human/laptop");
    let mut b = Device::new("human/phone");
    let mut f = Device::new("agent/main");
    let mut x = Device::new("agent/elsewhere");
    let mut h2 = Device::new("agent/helper-device");
    let h3 = Device::new("agent/helper-device-2");
    let mut w = World::found(&mut a, "code-1");
    let room = w.room.clone();
    w.add_human(&mut a, &mut b);
    w.publish(&a, 8);
    w.publish(&b, 1); // ONE unused key package, and the last-resort one
    for ag in [&f, &x, &h2, &h3] {
        w.publish(ag, 4);
    }
    w.enrol_agent(&mut a, &f);
    w.enrol_agent(&mut a, &x);
    w.sync(&mut b, &room).unwrap();
    let p = w.new_session(&mut a, "main", &[&b, &f]); // takes b's one unused key package
    let q = w.new_session(&mut a, "other", &[&b, &x]); // takes b's last-resort key package
    w.welcome(&mut b);
    w.welcome(&mut f);
    w.welcome(&mut x);
    assert_eq!(w.hub.unused_key_packages(&b.sig()), 0);

    // --- the agent founds a helper group under its own session ---
    let g = b"helper-1".to_vec();
    let gi = f.found(&g, &session_meta(&room, &f, Some(&p)));
    w.hub.found_group(&gi).unwrap();
    let adds: Vec<_> = [&a, &b, &h2].iter().map(|d| w.hub.take_key_package(&d.sig()).unwrap()).collect();
    let out = f.commit(&g, Change { adds, ..Default::default() }).unwrap();
    w.hub.submit(&out, Rows::default()).unwrap();
    f.confirm(&g);
    // human devices verify on first contact (Device::join runs check_welcome)
    assert_eq!(w.welcome(&mut a), vec![g.clone()]);
    assert_eq!(w.welcome(&mut b), vec![g.clone()], "b joined with its last-resort key package, used a second time");
    w.welcome(&mut h2);
    assert!(w.hub.last_resort_handed_out >= 2);
    let env = h2.seal(&g, "chat", b"helper at work");
    assert_eq!(a.open(&env).unwrap(), b"helper at work");
    assert_eq!(b.open(&env).unwrap(), b"helper at work");
    assert_eq!(f.open(&env).unwrap(), b"helper at work");

    // the epoch's key row: the agent has no archive key, so it cannot file it; the
    // first human device that sees the group does
    assert!(!w.hub.epoch_keys.contains_key(&(g.clone(), 1)));
    w.hub.put_epoch_key(a.epoch_key_row(&g, 1, a.key(&g, 1).unwrap()));
    // [variant] what the agent CAN do by itself: seal the key to the recovery PUBLIC key,
    // which it reads from the room group's public state
    let rec_pk = trommi_proof_keys::unhex(w.hub.meta(&room).recovery_hpke.as_ref().unwrap());
    let backup = seal::hpke_seal(f.crypto(), &rec_pk, b"trommi/v2/backup/helper-1/1", f.key(&g, 1).unwrap());
    let opened = seal::hpke_open(f.crypto(), &w.rec.hpke_private, b"trommi/v2/backup/helper-1/1", &backup).unwrap();
    assert_eq!(&opened, a.key(&g, 1).unwrap());

    // later the founder adds another agent device to ITS helper group: allowed
    let kp = w.hub.take_key_package(&h3.sig()).unwrap();
    let out = f.commit(&g, Change { adds: vec![kp.clone()], ..Default::default() }).unwrap();
    w.hub.submit(&out, Rows::default()).unwrap();
    f.confirm(&g);
    w.sync(&mut a, &g).unwrap();
    w.sync(&mut b, &g).unwrap();
    // ... but it cannot remove a human device from it
    let out = f.commit(&g, Change { removes: vec![b.sig()], ..Default::default() }).unwrap();
    assert!(matches!(w.hub.submit(&out, Rows::default()).unwrap_err(), Reject::Rule(_)));
    assert!(a.process(&g, &out.commit, None).unwrap_err().contains("only a human device"));
    f.abort(&g);
    // ... and another agent of that helper group, not its founder, adds nobody
    let kp2 = w.hub.take_key_package(&x.sig()).unwrap();
    w.sync(&mut h2, &g).unwrap();
    let out = h2.commit(&g, Change { adds: vec![kp2], ..Default::default() }).unwrap();
    assert!(matches!(w.hub.submit(&out, Rows::default()).unwrap_err(), Reject::Rule(_)));
    h2.abort(&g);

    // --- an agent device is added by an agent ONLY there ---
    // its own main session: refused by the hub and by a human device
    let out = f.commit(&p, Change { adds: vec![kp.clone()], ..Default::default() }).unwrap();
    assert!(matches!(w.hub.submit(&out, Rows::default()).unwrap_err(), Reject::Rule(_)));
    assert!(a.process(&p, &out.commit, None).is_err());
    f.abort(&p);
    // a foreign session: it is not a member, so it cannot even build a commit; its
    // external commit is refused
    assert!(f.commit(&q, Change::default()).is_err());
    let out = f.external_join(&w.hub.group_info(&q), vec![]).unwrap();
    assert!(matches!(w.hub.submit(&out, Rows::default()).unwrap_err(), Reject::Rule(_)));
    assert!(b.process(&q, &out.commit, None).is_err());
    f.forget(&q);
    // the room group: the same
    let out = f.external_join(&w.hub.group_info(&room), vec![]).unwrap();
    assert!(matches!(w.hub.submit(&out, Rows::default()).unwrap_err(), Reject::Rule(_)));
    assert!(a.process(&room, &out.commit, None).is_err());
    f.forget(&room);

    // --- a founding commit that leaves one human device out ---
    let g2 = b"helper-2".to_vec();
    let gi = f.found(&g2, &session_meta(&room, &f, Some(&p)));
    w.hub.found_group(&gi).unwrap();
    let adds = vec![w.hub.take_key_package(&a.sig()).unwrap()];
    let out = f.commit(&g2, Change { adds, ..Default::default() }).unwrap();
    let r = w.hub.submit(&out, Rows::default()).unwrap_err();
    assert!(matches!(&r, Reject::Rule(m) if m.contains("leaves out human device")), "{r:?}");
    // a hub that does not check lets it through; the human device that WAS added refuses.
    // (The device left out gets no Welcome: it cannot notice by itself.)
    w.hub.enforce_rules = false;
    w.hub.submit(&out, Rows::default()).unwrap();
    f.confirm(&g2);
    let wl = w.hub.welcomes_for(&a.sig());
    assert!(a.join(&wl[0]).unwrap_err().contains("leaves out human device"));
    w.hub.enforce_rules = true;

    // --- a helper founded by an agent that is not in the parent session ---
    let g3 = b"helper-3".to_vec();
    let gi = x.found(&g3, &session_meta(&room, &x, Some(&p)));
    let r = w.hub.found_group(&gi).unwrap_err();
    assert!(matches!(&r, Reject::Rule(m) if m.contains("not a member of the parent session")), "{r:?}");
    w.hub.enforce_rules = false;
    w.hub.found_group(&gi).unwrap();
    let adds: Vec<_> = [&a, &b].iter().map(|d| w.hub.take_key_package(&d.sig()).unwrap()).collect();
    let out = x.commit(&g3, Change { adds, ..Default::default() }).unwrap();
    w.hub.submit(&out, Rows::default()).unwrap();
    x.confirm(&g3);
    let wl = w.hub.welcomes_for(&a.sig());
    assert!(a.join(&wl[0]).unwrap_err().contains("not a member of the parent session"));
    let wl = w.hub.welcomes_for(&b.sig());
    assert!(b.join(&wl[0]).unwrap_err().contains("not a member of the parent session"));
    w.hub.enforce_rules = true;

    // --- key packages ---
    // a one-time key package used for two groups: the second Welcome cannot be opened
    // (OpenMLS deletes the private key after the first join)
    let once = a.key_package(false);
    for name in ["t1", "t2"] {
        let gi = b.found(name.as_bytes(), &session_meta(&room, &b, None));
        w.hub.found_group(&gi).unwrap();
        w.session_commit(&mut b, name.as_bytes(), Change { adds: vec![once.clone()], ..Default::default() }).unwrap();
    }
    let wl = w.hub.welcomes_for(&a.sig());
    assert!(a.join(&wl[0]).is_ok());
    let second = a.join(&wl[1]).unwrap_err();
    println!("s07: one-time key package used twice, second Welcome: {second}");
    assert!(second.contains("NoMatchingKeyPackage"));
    // a human device with NO key package left at the hub (and no last-resort one)
    // blocks every helper founding until it publishes again
    let mut c = Device::new("human/sleeping-tablet");
    w.hub.publish_key_package(&c.sig(), c.key_package(false), false);
    w.add_human(&mut a, &mut c); // uses its only key package
    w.sync(&mut b, &room).unwrap();
    assert!(w.hub.take_key_package(&c.sig()).is_none());
    let g4 = b"helper-4".to_vec();
    let gi = f.found(&g4, &session_meta(&room, &f, Some(&p)));
    w.hub.found_group(&gi).unwrap();
    let adds: Vec<_> = [&a, &b].iter().map(|d| w.hub.take_key_package(&d.sig()).unwrap()).collect();
    let out = f.commit(&g4, Change { adds, ..Default::default() }).unwrap();
    let r = w.hub.submit(&out, Rows::default()).unwrap_err();
    assert!(matches!(&r, Reject::Rule(m) if m.contains("leaves out human device")), "{r:?}");

    // the hub hands out a key package of its own choosing: the adder notices, because
    // it compares the package's signature key with the device it means to add
    let impostor = Device::new("human/impostor");
    let handed = impostor.key_package(false);
    assert_ne!(trommi_proof_keys::device::key_package_owner(&handed, a.crypto()).unwrap(), c.sig());
}

/// 7b. A new human device and N existing session groups. [vanilla, two ways]
/// (i) a human device adds it to each of 50 session groups: 50 commits, 50 Welcomes,
///     and 50 key packages of the new device (here 10 unused ones, then its last-resort
///     one 40 times). (ii) the new device joins each group itself by external commit:
///     50 commits, no key package, no other device involved.
#[test]
fn s07b_new_device_into_50_sessions() {
    use std::time::Instant;
    const N: usize = 50;
    let mut a = Device::new("human/laptop");
    let mut b = Device::new("human/phone");
    let agent = Device::new("agent/claude-1");
    let mut w = World::found(&mut a, "code-1");
    let room = w.room.clone();
    w.add_human(&mut a, &mut b);
    w.publish(&b, N);
    w.publish(&agent, N);
    w.enrol_agent(&mut a, &agent);
    let sessions: Vec<_> = (0..N).map(|i| w.new_session(&mut a, &format!("session-{i}"), &[&b, &agent])).collect();

    // (i) added by a human device
    let mut d = Device::new("human/new-1");
    w.publish(&d, 11);
    w.add_human(&mut a, &mut d);
    let t = Instant::now();
    let mut bytes = 0;
    for s in &sessions {
        let kp = w.hub.take_key_package(&d.sig()).unwrap();
        let before = w.hub.groups[s].commits.len();
        w.session_commit(&mut a, s, Change { adds: vec![kp], ..Default::default() }).unwrap();
        bytes += w.hub.groups[s].commits[before].len();
    }
    let t_commit = t.elapsed();
    let welcomes = w.hub.welcomes_for(&d.sig());
    let wbytes: usize = welcomes.iter().map(|x| x.len()).sum();
    let t = Instant::now();
    for wl in &welcomes {
        d.join(wl).unwrap();
    }
    println!("s07b (i) added by a human device: {N} commits in {t_commit:?} ({} bytes), {N} Welcomes ({} bytes) joined in {:?}; last-resort key package handed out {} times",
        bytes, wbytes, t.elapsed(), w.hub.last_resort_handed_out);
    assert_eq!(d.groups.len(), N + 1);
    assert_eq!(w.hub.last_resort_handed_out, N - 10);

    // (ii) the new device joins by external commit
    let mut e = Device::new("human/new-2");
    w.add_human(&mut a, &mut e);
    let t = Instant::now();
    let mut bytes = 0;
    for s in &sessions {
        let before = w.hub.groups[s].commits.len();
        w.external_session(&mut e, s).unwrap();
        bytes += w.hub.groups[s].commits[before].len();
    }
    println!("s07b (ii) joins by external commit: {N} commits in {:?} ({} bytes), no key package, no Welcome; GroupInfo fetched: {} bytes each",
        t.elapsed(), bytes, w.hub.group_info(&sessions[0]).len());
    assert_eq!(e.groups.len(), N + 1);
    let _ = room;
}

/// 8. Concurrency and offline. [vanilla: MLS epochs; the hub's one rule "a commit
/// builds on the current epoch"]
/// Two devices commit in the same epoch: the hub takes one; the other drops its
/// pending commit, processes the winner's, builds its commit again. Duplicate, replayed
/// and reordered deliveries are refused and change nothing. A device that was offline
/// for 200 epochs catches up by processing the commits in order, and has every
/// epoch's key afterwards. A device whose state is gone can come back by external
/// commit under its signature key, but it cannot make the archive row (no previous
/// archive key): another human device has to supply the link.
#[test]
fn s08_concurrency_and_offline() {
    use std::time::Instant;
    let mut a = Device::new("human/laptop");
    let mut b = Device::new("human/phone");
    let seed_c = b"tablet signature key".to_vec();
    let mut c = Device::from_seed("human/tablet", &seed_c);
    let mut w = World::found(&mut a, "code-1");
    let room = w.room.clone();
    w.add_human(&mut a, &mut b);
    w.add_human(&mut a, &mut c);
    w.sync(&mut b, &room).unwrap();
    let e0 = w.hub.epoch(&room);

    // --- two commits in the same epoch ---
    let out_a = a.commit(&room, Change::default()).unwrap();
    let row_a = a.archive_row_for_pending(None).unwrap();
    let out_b = b.commit(&room, Change::default()).unwrap();
    let row_b = b.archive_row_for_pending(None).unwrap();
    assert_eq!(out_a.epoch, out_b.epoch);
    w.hub.submit(&out_a, Rows { archive: Some(row_a), epoch_key: None }).unwrap();
    a.confirm(&room);
    let lost = w.hub.submit(&out_b, Rows { archive: Some(row_b), epoch_key: None }).unwrap_err();
    assert_eq!(lost, Reject::Stale { current: e0 + 1 });
    // the loser's flow: drop, fetch, process, build again
    b.abort(&room);
    assert_eq!(w.sync(&mut b, &room).unwrap(), 1);
    assert_eq!(w.room_commit(&mut b, Change::default()).unwrap(), e0 + 2);
    w.sync(&mut a, &room).unwrap();
    assert_eq!(a.archive[&(e0 + 2)], b.archive[&(e0 + 2)]);
    // OpenMLS 0.9.1 also processes the winner's commit while the own one is still
    // pending (the pending one is dropped by the merge): the explicit abort is tidy,
    // not required
    let _unsent = b.commit(&room, Change::default()).unwrap();
    w.room_commit(&mut a, Change::default()).unwrap();
    b.process(&room, w.hub.commits_since(&room, e0 + 2).last().unwrap(), None).unwrap();
    assert!(b.group(&room).pending_commit().is_none());
    assert_eq!(b.archive[&(e0 + 3)], a.archive[&(e0 + 3)]);

    // --- duplicate, replayed, reordered ---
    let commits = w.hub.commits_since(&room, c.epoch(&room)); // c is 3 epochs behind
    assert_eq!(commits.len(), 3);
    assert!(c.process(&room, &commits[1], None).is_err(), "a commit for a later epoch first: refused");
    assert_eq!(c.epoch(&room), e0);
    c.process(&room, &commits[0], None).unwrap();
    let keys_then = c.keys.clone();
    assert!(c.process(&room, &commits[0], None).is_err(), "the same commit again: refused");
    assert_eq!((c.epoch(&room), &c.keys), (e0 + 1, &keys_then), "and nothing changed");
    c.process(&room, &commits[1], None).unwrap();
    c.process(&room, &commits[2], None).unwrap();
    assert_eq!(w.hub.submit(&out_a, Rows::default()).unwrap_err(), Reject::Stale { current: e0 + 3 }, "replay to the hub");

    // --- offline for 200 epochs ---
    for i in 0..200 {
        let (x, y) = if i % 2 == 0 { (&mut a, &mut b) } else { (&mut b, &mut a) };
        w.room_commit(x, Change::default()).unwrap();
        w.sync(y, &room).unwrap();
    }
    let t = Instant::now();
    assert_eq!(w.sync(&mut c, &room).unwrap(), 200);
    let dt = t.elapsed();
    let bytes: usize = w.hub.commits_since(&room, e0 + 3).iter().map(|x| x.len()).sum();
    println!("s08: 200 commits ({bytes} bytes) processed in {dt:?} = {:?} each", dt / 200);
    assert_eq!(c.archive[&(e0 + 203)], a.archive[&(e0 + 203)]);
    assert_eq!(c.archive.len() as u64, 200 + 3 + 1, "every epoch's key on the way, from its own join on");

    // --- state lost: back by external commit, but without the link ---
    drop(c);
    let mut c = Device::from_seed("human/tablet", &seed_c);
    let out = c.external_join(&w.hub.group_info(&room), vec![]).unwrap();
    c.room = Some(room.clone());
    assert!(c.archive_row_for_pending(None).unwrap_err().contains("previous archive key is missing"));
    let now = out.epoch + 1;
    let (_, arch) = c.staged_keys(&room);
    let row = seal::make_archive_row(c.crypto(), &room, now, &arch.unwrap(), None, &w.recovery_hpke());
    w.hub.submit(&out, Rows { archive: Some(row), epoch_key: None }).unwrap(); // rule (a): same signature key, own old leaf out
    c.confirm(&room);
    assert_eq!(w.hub.members(&room).len(), 3);
    assert_eq!(c.walk_archive(&w.hub.archive), 0, "the chain is broken at this epoch: the device reads no history");
    // another human device follows the commit and supplies the missing link
    w.sync(&mut a, &room).unwrap();
    let repaired = seal::make_archive_row(a.crypto(), &room, now, &a.archive[&now], Some((now - 1, &a.archive[&(now - 1)])), &w.recovery_hpke());
    w.hub.archive.insert(now, repaired);
    assert_eq!(c.walk_archive(&w.hub.archive) as u64, now);
}

/// 9. The hub as observer. [vanilla: PublicMessage commits, `PublicGroup`; roles in
/// the room group's public state: leaves and a group context extension]
/// From public messages alone the hub lists the members of every group and their
/// roles, and enforces "only a human device adds a device to the room group". The
/// role is not a claim a device makes about itself: a human device is a leaf of the
/// room group, an agent device is a key in the roster inside the room group's context,
/// and only a commit by a room member changes either. An agent cannot forge it.
#[test]
fn s09_hub_as_observer() {
    use openmls_rust_crypto::{MemoryStorage, RustCrypto};
    let mut a = Device::new("human/laptop");
    let mut b = Device::new("human/phone");
    // an agent that calls itself a human device
    let mut liar = Device::new("human/definitely-a-phone");
    let mut w = World::found(&mut a, "code-1");
    let room = w.room.clone();
    w.add_human(&mut a, &mut b);
    w.publish(&b, 2);
    w.publish(&liar, 2);
    w.enrol_agent(&mut a, &liar);
    w.sync(&mut b, &room).unwrap();
    let s = w.new_session(&mut a, "session-1", &[&b, &liar]);
    w.welcome(&mut b);
    w.welcome(&mut liar);

    // what the hub reads without any key
    let listing: Vec<(String, &str)> = w.hub.members(&s).iter().map(|(name, key)| (name.clone(), w.hub.role(key))).collect();
    assert_eq!(listing, vec![
        ("human/laptop".to_string(), "human"),
        ("human/phone".to_string(), "human"),
        ("human/definitely-a-phone".to_string(), "agent"), // the name is a label; the role is not
    ]);
    assert_eq!(w.hub.meta(&room).agents, vec![hex(&liar.sig())]);
    assert_eq!(w.hub.epoch(&room), a.epoch(&room));

    // the agent and the room group
    // (1) it is not a member: no commit can be built
    assert!(liar.commit(&room, Change::default()).is_err());
    // (2) an external commit: valid MLS, refused by the rule (hub and device)
    let out = liar.external_join(&w.hub.group_info(&room), vec![]).unwrap();
    assert!(matches!(w.hub.submit(&out, Rows::default()).unwrap_err(), Reject::Rule(_)));
    assert!(a.process(&room, &out.commit, None).is_err());
    liar.forget(&room);
    // (3) a recovery authorisation signed with its own key instead of the recovery key
    let forged = rules::recovery_authorisation(&liar.signer, &room, w.hub.epoch(&room), &liar.sig());
    let out = liar.external_join(&w.hub.group_info(&room), forged).unwrap();
    assert!(matches!(w.hub.submit(&out, Rows::default()).unwrap_err(), Reject::Rule(_)));
    liar.forget(&room);
    // (4) a real room commit with one byte changed: MLS's signature check refuses it
    let mut out = a.commit(&room, Change::default()).unwrap();
    let n = out.commit.len();
    out.commit[n / 2] ^= 1;
    let r = w.hub.submit(&out, Rows { archive: Some(a.archive_row_for_pending(None).unwrap()), epoch_key: None }).unwrap_err();
    assert!(matches!(r, Reject::Mls(_)), "{r:?}");
    a.abort(&room);

    // the agent and its own session group
    // (5) adding a device: refused
    let extra = Device::new("agent/extra");
    let out = liar.commit(&s, Change { adds: vec![extra.key_package(false)], ..Default::default() }).unwrap();
    assert!(matches!(w.hub.submit(&out, Rows::default()).unwrap_err(), Reject::Rule(_)));
    liar.abort(&s);
    // (6) rewriting the session statement (naming itself founder of a helper): refused
    let mut meta = liar.meta(&s);
    meta.founder = hex(&liar.sig());
    meta.parent = Some(hex(&s));
    let out = liar.commit(&s, Change { meta: Some(meta), ..Default::default() }).unwrap();
    assert!(matches!(w.hub.submit(&out, Rows::default()).unwrap_err(), Reject::Rule(_)));
    assert!(a.process(&s, &out.commit, None).is_err());
    liar.abort(&s);

    // an agent follows the room group the same way the hub does: as an observer that
    // starts from a GroupInfo (signature checked against the tree) and processes commits
    let (crypto, storage) = (RustCrypto::default(), MemoryStorage::default());
    let mut watch = trommi_proof_keys::hub::observe(&crypto, &storage, &w.hub.group_info(&room)).unwrap();
    let mut c = Device::new("human/third");
    w.add_human(&mut a, &mut c);
    let commit = w.hub.commits_since(&room, w.hub.epoch(&room) - 1).pop().unwrap();
    let pm = trommi_proof_keys::device::parse_msg(&commit).unwrap().try_into_protocol_message().unwrap();
    let processed = watch.process_message(&crypto, pm).unwrap();
    let openmls::prelude::ProcessedMessageContent::StagedCommitMessage(staged) = processed.into_content() else { panic!() };
    watch.merge_commit(&storage, *staged).unwrap();
    assert!(watch.members().any(|m| m.signature_key == c.sig()));
    assert_eq!(watch.members().count(), 3);
}

/// 9b. A finding: the signature key alone is the identity. [vanilla behaviour]
/// A device refreshes its leaf (an update commit): MLS heals the group's secrets
/// against a copy of its OLD state. But the old state still holds the device's
/// signature key, and with that key alone the holder of the copy joins any session
/// group by external commit ("a room leaf may join a session by itself"), replacing
/// the real device's leaf, and reads from then on. The update did not heal that.
#[test]
fn s09b_a_stolen_signature_key_defeats_the_update() {
    let seed = b"phone signature key".to_vec();
    let mut a = Device::new("human/laptop");
    let mut b = Device::from_seed("human/phone", &seed);
    let agent = Device::new("agent/claude-1");
    let mut w = World::found(&mut a, "code-1");
    let room = w.room.clone();
    w.add_human(&mut a, &mut b);
    w.publish(&b, 2);
    w.publish(&agent, 2);
    w.enrol_agent(&mut a, &agent);
    w.sync(&mut b, &room).unwrap();
    let s = w.new_session(&mut a, "session-1", &[&b, &agent]);
    w.welcome(&mut b);
    // the phone's state is copied here; then the phone refreshes its keys everywhere
    w.room_commit(&mut b, Change::default()).unwrap();
    w.session_commit(&mut b, &s, Change::default()).unwrap();
    w.sync(&mut a, &room).unwrap();
    w.sync(&mut a, &s).unwrap();

    // the thief has the signature key from the copy, nothing current
    let mut thief = Device::from_seed("human/phone", &seed);
    let out = thief.external_join(&w.hub.group_info(&s), vec![]).unwrap();
    w.hub.submit(&out, Rows::default()).expect("the hub's rule lets a room leaf's key in");
    thief.confirm(&s);
    a.process(&s, &out.commit, None).expect("and so does every device");
    let secret = a.seal(&s, "chat", b"said after the phone's update");
    assert_eq!(thief.open(&secret).unwrap(), b"said after the phone's update");
    // the real phone was thrown out by the same commit
    w.sync(&mut b, &s).unwrap();
    assert!(!b.group(&s).is_active());
}

/// 10. Cost. Sizes and native times for groups of 3, 10 and 30 members in steady
/// state (every member has committed once, so the tree has no blank nodes). Built
/// with the test profile of this crate (opt-level 2).
#[test]
fn s10_cost() {
    use std::time::Instant;
    let ms = |t: Instant, n: u32| format!("{:.1} us", t.elapsed().as_secs_f64() * 1e6 / n as f64);
    let probe = Device::new("human/probe");
    let t = Instant::now();
    for _ in 0..50 {
        probe.key_package(false);
    }
    println!("s10: key package {} bytes (last-resort {} bytes), made in {}", probe.key_package(false).len(), probe.key_package(true).len(), ms(t, 50));

    for n in [3usize, 10, 30] {
        let mut devs: Vec<Device> = (0..n).map(|i| Device::new(&format!("human/device-{i:02}"))).collect();
        let (first, rest) = devs.split_first_mut().unwrap();
        let mut w = World::found(first, "code-1");
        let room = w.room.clone();
        for d in rest.iter_mut() {
            w.add_human(first, d);
        }
        // steady state: everybody catches up, then everybody commits once
        for i in 0..n {
            w.sync(&mut devs[i], &room).unwrap();
        }
        for i in 0..n {
            w.room_commit(&mut devs[i], Change::default()).unwrap();
            for j in 0..n {
                if j != i {
                    w.sync(&mut devs[j], &room).unwrap();
                }
            }
        }
        let state = devs[1].state_bytes();
        let commits_before = w.hub.groups[&room].commits.len();

        // an update commit: build, then every other member processes it
        let t = Instant::now();
        let out = devs[0].commit(&room, Change::default()).unwrap();
        let t_build = ms(t, 1);
        let row = devs[0].archive_row_for_pending(None).unwrap();
        w.hub.submit(&out, Rows { archive: Some(row), epoch_key: None }).unwrap();
        devs[0].confirm(&room);
        let update = out.commit.len();
        let t = Instant::now();
        for j in 1..n {
            w.sync(&mut devs[j], &room).unwrap();
        }
        let t_process = ms(t, n as u32 - 1);

        // an add commit, its Welcome (with the tree), the join
        let mut new = Device::new("human/new");
        let kp = new.key_package(false);
        let out = devs[0].commit(&room, Change { adds: vec![kp], ..Default::default() }).unwrap();
        let row = devs[0].archive_row_for_pending(None).unwrap();
        w.hub.submit(&out, Rows { archive: Some(row), epoch_key: None }).unwrap();
        devs[0].confirm(&room);
        let (add, welcome, group_info) = (out.commit.len(), out.welcome.as_ref().unwrap().len(), out.group_info.len());
        let wl = w.hub.welcomes_for(&new.sig()).pop().unwrap();
        let t = Instant::now();
        new.join(&wl).unwrap();
        let t_join = ms(t, 1);
        for j in 1..n {
            w.sync(&mut devs[j], &room).unwrap();
        }

        // a remove commit
        let out = devs[0].commit(&room, Change { removes: vec![new.sig()], ..Default::default() }).unwrap();
        let row = devs[0].archive_row_for_pending(None).unwrap();
        w.hub.submit(&out, Rows { archive: Some(row), epoch_key: None }).unwrap();
        devs[0].confirm(&room);
        let remove = out.commit.len();

        // an external commit
        let mut ext = Device::new("human/ext");
        let gi = w.hub.group_info(&room);
        let t = Instant::now();
        let out = ext.external_join(&gi, vec![]).unwrap();
        let t_ext = ms(t, 1);
        let external = out.commit.len();

        // export, seal, open
        let t = Instant::now();
        for _ in 0..1000 {
            devs[0].group(&room).export_secret(devs[0].crypto(), LABEL_ARCHIVE, &room, 32).unwrap();
        }
        let t_export = ms(t, 1000);
        let body = vec![7u8; 1024];
        let t = Instant::now();
        let mut env = devs[0].seal(&room, "item", &body);
        for _ in 0..999 {
            env = devs[0].seal(&room, "item", &body);
        }
        let t_seal = ms(t, 1000);
        let t = Instant::now();
        for _ in 0..1000 {
            devs[0].open(&env).unwrap();
        }
        let t_open = ms(t, 1000);

        println!("s10: {n:>2} members | commit: update {update} B, add {add} B, remove {remove} B, external {external} B | Welcome {welcome} B | GroupInfo with tree {group_info} B | state per device {state} B (after {commits_before} commits)");
        println!("s10: {n:>2} members | build commit {t_build}, process commit {t_process}, join by Welcome {t_join}, external commit {t_ext}, export {t_export}, seal 1 kB {t_seal}, open 1 kB {t_open}");
    }
}
