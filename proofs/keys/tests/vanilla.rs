//! The honest vanilla variants: what plain RFC 9420 through OpenMLS gives the product
//! WITHOUT Trommi's own constructs, and where it stops.

mod common;
use common::*;

use openmls::prelude::*;
use sha2::{Digest, Sha256};
use std::time::Instant;
use trommi_proof_keys::device::{parse_msg, Change, Device};
use trommi_proof_keys::hub::Rows;

/// A commit with no Trommi row at all.
fn plain_commit(w: &mut World, d: &mut Device, gid: &[u8], change: Change) -> u64 {
    let out = d.commit(gid, change).unwrap();
    let e = w.hub.submit(&out, Rows::default()).unwrap();
    d.confirm(gid);
    e
}

/// V1. Content as standard MLS application messages (PrivateMessage), stored by the
/// hub as they are. [vanilla]
/// What works: a member that is online decrypts each message once.
/// What a user would call broken, each asserted below:
///  - a message opens ONCE per device: the hub's stored bytes are a transport, not an
///    archive; every device must keep its own plaintext store;
///  - the sender cannot open its own stored message;
///  - a device that comes back after more than `max_past_epochs` epochs cannot open
///    what was sent before (tested with 3; OpenMLS documents the default as 0);
///  - within an epoch a device that reads the newest of 8 messages first can still open
///    only the 4 before it (`out_of_order_tolerance`, default 5);
///  - a new device cannot open a message stored before its join (it follows that a
///    member can only re-encrypt plaintext it kept; that is not built here);
///  - the message is a PrivateMessage: its clear part is group, epoch, content type.
#[test]
fn v01_application_messages_as_the_store() {
    let mut a = Device::new("human/laptop");
    let mut b = Device::new("human/phone");
    a.max_past_epochs = 3;
    b.max_past_epochs = 3;
    let mut w = World::found(&mut a, "code-1");
    w.hub.require_archive_rows = false;
    let room = w.room.clone();
    w.publish(&b, 1);
    let kp = w.hub.take_key_package(&b.sig()).unwrap();
    plain_commit(&mut w, &mut a, &room, Change { adds: vec![kp], ..Default::default() });
    w.welcome(&mut b);

    // once
    let m1 = app_send(&mut a, &room, b"hello");
    assert_eq!(app_open(&mut b, &room, &m1).unwrap(), b"hello");
    let again = app_open(&mut b, &room, &m1).unwrap_err();
    println!("v01: second read of the same stored message: {again}");
    assert!(again.contains("SecretReuseError"));
    // not by its sender
    let own = app_open(&mut a, &room, &m1).unwrap_err();
    println!("v01: sender reading its own stored message: {own}");
    assert!(own.contains("OwnPrivateMessage"));
    // what the hub sees
    let pm = parse_msg(&m1).unwrap().try_into_protocol_message().unwrap();
    assert!(matches!(pm, ProtocolMessage::PrivateMessage(_)));
    assert_eq!((pm.epoch().as_u64(), pm.content_type()), (1, ContentType::Application));

    // late delivery across epochs
    let late_ok = app_send(&mut a, &room, b"sent in epoch 1, read in epoch 4");
    let late_lost = app_send(&mut a, &room, b"sent in epoch 1, read in epoch 5");
    for _ in 0..3 {
        plain_commit(&mut w, &mut a, &room, Change::default());
    }
    w.sync(&mut b, &room).unwrap();
    assert!(app_open(&mut b, &room, &late_ok).is_ok(), "within max_past_epochs = 3");
    plain_commit(&mut w, &mut a, &room, Change::default());
    w.sync(&mut b, &room).unwrap();
    let lost = app_open(&mut b, &room, &late_lost).unwrap_err();
    println!("v01: message 4 epochs old with max_past_epochs = 3: {lost}");
    assert!(lost.contains("TooDistantInThePast"));

    // out of order inside one epoch
    let batch: Vec<Vec<u8>> = (0..8).map(|i| app_send(&mut a, &room, format!("m{i}").as_bytes())).collect();
    assert!(app_open(&mut b, &room, &batch[7]).is_ok());
    let readable: Vec<usize> = (0..7).filter(|i| app_open(&mut b, &room, &batch[*i]).is_ok()).collect();
    println!("v01: after reading message 7 first, still readable of 0..=6: {readable:?}");
    assert_eq!(readable, vec![3, 4, 5, 6], "exactly the tolerance of 5 generations behind the newest read (2..=6), minus the ratchet's step: 0, 1 and 2 are lost");

    // a new device and the stored messages
    let stored = app_send(&mut a, &room, b"history");
    let mut c = Device::new("human/new");
    c.max_past_epochs = 3;
    w.publish(&c, 1);
    let kp = w.hub.take_key_package(&c.sig()).unwrap();
    plain_commit(&mut w, &mut a, &room, Change { adds: vec![kp], ..Default::default() });
    w.welcome(&mut c);
    let new_dev = app_open(&mut c, &room, &stored).unwrap_err();
    println!("v01: new device reading a message stored before its join: {new_dev}");
    assert!(new_dev.contains("TooDistantInThePast"));
}

/// V2. Recovery as a real MLS member that is offline. [vanilla, with one bend: the
/// member's randomness is derived from the code, so its key package can be re-made]
/// The recovery member is a leaf of the room group and of every session group, added
/// from one last-resort key package. It never comes online. Months later, with the
/// code alone and what the hub kept (every Welcome addressed to it, every commit of
/// every group), it joins at the epoch it was added, replays the commits, exports
/// each epoch's key on the way, and reads all content sealed since its join. Then it
/// adds a fresh device with an ordinary commit and removes the lost ones. This path
/// uses no archive row, no sealed copy, no external commit and no stored GroupInfo
/// (the shared test fixture still creates them; nothing here reads them).
/// Still custom in this variant: the content envelope under the exported key, and the
/// hand-over of old epoch keys to the fresh device.
/// NOT tested: real passing of time. See `v03` for what an expired leaf lifetime does.
#[test]
fn v02_recovery_as_an_offline_member() {
    let seed = Sha256::digest(b"trommi/v2/recovery/code-1").to_vec();
    const FAR: u64 = 4_102_444_800; // 2100-01-01
    let recovery_sig;
    let recovery_kp;
    {
        // on the device that shows the code to its owner
        let r = Device::from_seed("recovery", &seed);
        recovery_sig = r.sig();
        recovery_kp = r.key_package_for(true, Some(FAR));
    } // nothing of it is kept anywhere

    let mut a = Device::new("human/laptop");
    let mut b = Device::new("human/phone");
    let mut agent = Device::new("agent/claude-1");
    let mut w = World::found(&mut a, "unused");
    w.hub.require_archive_rows = false;
    let room = w.room.clone();
    w.hub.publish_key_package(&recovery_sig, recovery_kp, true);
    w.publish(&b, 3);
    w.publish(&agent, 2);

    // the recovery member is in the room from the first commit on
    let kp = w.hub.take_key_package(&recovery_sig).unwrap();
    plain_commit(&mut w, &mut a, &room, Change { adds: vec![kp], ..Default::default() });
    let kp = w.hub.take_key_package(&b.sig()).unwrap();
    plain_commit(&mut w, &mut a, &room, Change { adds: vec![kp], ..Default::default() });
    w.welcome(&mut b);
    let mut meta = a.meta(&room);
    meta.agents.push(trommi_proof_keys::hex(&agent.sig()));
    plain_commit(&mut w, &mut a, &room, Change { meta: Some(meta), ..Default::default() });
    w.sync(&mut b, &room).unwrap();

    // a session: human devices, the agent, and the recovery member (same key package again)
    let s = b"session-1".to_vec();
    let gi = a.found(&s, &session_meta(&room, &a, None));
    w.hub.found_group(&gi).unwrap();
    let adds = [&b.sig(), &agent.sig(), &recovery_sig].iter().map(|k| w.hub.take_key_package(k).unwrap()).collect();
    plain_commit(&mut w, &mut a, &s, Change { adds, ..Default::default() });
    w.welcome(&mut b);
    w.welcome(&mut agent);
    assert_eq!(w.hub.last_resort_handed_out, 2, "the recovery member's one key package, used twice");

    // 200 more room epochs and 20 session epochs, content in each
    let mut texts = vec![];
    for i in 0..200 {
        let (x, y) = if i % 2 == 0 { (&mut a, &mut b) } else { (&mut b, &mut a) };
        plain_commit(&mut w, x, &room, Change::default());
        w.sync(y, &room).unwrap();
        let t = format!("room item {i}");
        w.hub.post(x.seal(&room, "note", t.as_bytes()));
        texts.push(t);
        if i % 10 == 0 {
            plain_commit(&mut w, x, &s, Change::default());
            w.sync(y, &s).unwrap();
            w.sync(&mut agent, &s).unwrap();
            let t = format!("session item {i}");
            w.hub.post(agent.seal(&s, "chat", t.as_bytes()));
            texts.push(t);
        }
    }
    drop((a, b)); // every human device is lost

    // --- recovery: the code, the hub, nothing else ---
    let t0 = Instant::now();
    let mut r = Device::from_seed("recovery", &seed);
    let _ = r.key_package_for(true, Some(FAR)); // re-made: the same private keys again
    r.fresh_randomness(); // everything from here on is drawn fresh
    let welcomes: Vec<Vec<u8>> = w.hub.welcome_log.iter().filter(|(to, _)| *to == r.sig()).map(|(_, wl)| wl.clone()).collect();
    assert_eq!(welcomes.len(), 2);
    // Order matters, and this is a finding: Trommi's check of a session Welcome or
    // commit needs the room's roster AS OF THEN. Joining the session right after the
    // room Welcome (room epoch 1, agent not yet enrolled) is refused by the rule check.
    // Here the room is replayed to its end first, which only works because nobody was
    // removed in between; the real catch-up must interleave the groups in the hub's order.
    r.join(&welcomes[0]).expect("the recovery member joins the room from an old Welcome");
    assert_eq!(r.epoch(&room), 1);
    assert!(r.join(&welcomes[1]).unwrap_err().contains("neither a human device nor an enrolled agent"));
    let n_room = w.sync(&mut r, &room).unwrap();
    r.join(&welcomes[1]).expect("the recovery member joins the session from an old Welcome");
    let n_sess = w.sync(&mut r, &s).unwrap();
    let dt = t0.elapsed();
    println!("v02: recovery member replayed {n_room} room commits + {n_sess} session commits in {dt:?}");
    assert_eq!(r.epoch(&room), w.hub.epoch(&room));

    // it reads everything sealed since its join
    for (i, env) in w.hub.items.iter().enumerate() {
        assert_eq!(r.open(env).unwrap(), texts[i].as_bytes());
    }
    println!("v02: opened {} items from {} room epochs and {} session epochs", w.hub.items.len(), n_room, n_sess);

    // it enrols a fresh device with an ORDINARY commit and removes the lost ones
    let mut n = Device::new("human/new-laptop");
    w.publish(&n, 2);
    let lost: Vec<_> = r.members(&room).into_iter().filter(|k| *k != r.sig()).collect();
    let kp = w.hub.take_key_package(&n.sig()).unwrap();
    plain_commit(&mut w, &mut r, &room, Change { adds: vec![kp], removes: lost.clone(), ..Default::default() });
    w.welcome(&mut n);
    let kp = w.hub.take_key_package(&n.sig()).unwrap();
    plain_commit(&mut w, &mut r, &s, Change { adds: vec![kp], removes: lost, ..Default::default() });
    w.welcome(&mut n);
    assert_eq!(w.hub.members(&room).iter().map(|m| m.0.clone()).collect::<Vec<_>>(), vec!["human/new-laptop", "recovery"]);

    // history for the fresh device: the hand-over, one envelope per group
    let h1 = r.handover(&room, r.epoch(&room));
    let h2 = r.handover(&s, r.epoch(&s));
    println!("v02: hand-over to the fresh device: room {} bytes, session {} bytes", h1.body.len(), h2.body.len());
    n.take_handover(&h1).unwrap();
    n.take_handover(&h2).unwrap();
    for (i, env) in w.hub.items.iter().enumerate() {
        assert_eq!(n.open(env).unwrap(), texts[i].as_bytes());
    }

    // what the hub had to keep for this: every commit of every group, for ever
    let kept: usize = w.hub.groups.values().map(|g| g.commits.iter().map(|c| c.len()).sum::<usize>()).sum();
    println!("v02: the hub keeps {} commits = {} bytes for a room of 3 leaves", w.hub.groups.values().map(|g| g.commits.len()).sum::<usize>(), kept);
}

/// V3. Old Welcomes and leaf lifetimes. [vanilla; real time, 3 seconds]
/// A Welcome carries the tree as of then. OpenMLS checks the lifetime of every leaf
/// that still stems from a key package against today's clock when a device joins: a
/// Welcome whose tree holds an expired leaf is refused, unless the joiner uses
/// `JoinBuilder::skip_lifetime_validation()`. Whoever joins from a stored Welcome
/// long after (the offline recovery member of V2) needs that switch.
#[test]
fn v03_an_old_welcome_and_expired_leaves() {
    use std::time::{Duration, SystemTime, UNIX_EPOCH};
    let mut a = Device::new("human/laptop");
    let mut b = Device::new("human/phone");
    let mut late = Device::new("human/joins-late");
    let mut w = World::found(&mut a, "unused");
    w.hub.require_archive_rows = false;
    let room = w.room.clone();
    // the phone's key package is valid for two more seconds
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
    let short = b.key_package_for(false, Some(now + 2));
    plain_commit(&mut w, &mut a, &room, Change { adds: vec![short], ..Default::default() });
    w.welcome(&mut b);
    // the late device is added right away, but opens its Welcome only later
    // (a last-resort key package: a refused Welcome destroys a one-time package's
    // private key, see V4, and this test opens the same Welcome twice)
    let kp = late.key_package(true);
    plain_commit(&mut w, &mut a, &room, Change { adds: vec![kp], ..Default::default() });
    let wl = w.hub.welcomes_for(&late.sig()).pop().unwrap();
    std::thread::sleep(Duration::from_secs(3));
    let refused = late.stage_welcome(&wl).map(|_| ()).unwrap_err();
    println!("v03: Welcome whose tree holds an expired leaf: {refused}");
    assert!(refused.contains("Lifetime(Expired"));
    let staged = late.stage_old_welcome(&wl).expect("with skip_lifetime_validation");
    late.accept(staged);
    assert_eq!(late.epoch(&room), 2);
    // commits are processed regardless of the expired leaf
    plain_commit(&mut w, &mut a, &room, Change::default());
    w.sync(&mut late, &room).unwrap();
    w.sync(&mut b, &room).unwrap();
}

/// V4. Binding a group to another by a pre-shared key. [vanilla: PreSharedKey proposal]
/// (a) A helper group CAN be bound to its parent session: the founding commit injects
///     an external PSK whose value is exported from the parent session's epoch. A
///     human device opens the Welcome only if it derives the same value: proof that
///     the founder holds the parent session's secret. A device outside the parent (the
///     helper's own agent device) cannot open that Welcome, so it has to be added by a
///     second commit.
/// (b) A session group can NOT be bound to the room group this way: every joiner needs
///     the PSK, and the agent must not hold anything derived from the room.
/// (c) MLS's own "resumption PSK, usage branch" names the parent group and epoch, but
///     OpenMLS 0.9.1 looks a resumption PSK up by epoch in the PROCESSING group's own
///     store and ignores the group id in it (schedule/psk.rs `load_psks`): naming the
///     parent silently takes the helper group's own secret of that epoch number.
/// (d) On the way: a Welcome that is refused destroys a one-time key package.
#[test]
fn v04_psk_binding() {
    use openmls::prelude::{PreSharedKeyProposal, Proposal};
    use openmls::schedule::{psk::{ResumptionPsk, ResumptionPskUsage}, PreSharedKeyId, Psk};
    use trommi_proof_keys::{CS, LABEL_BIND};
    let mut a = Device::new("human/laptop");
    let mut f = Device::new("agent/main");
    let h2 = Device::new("agent/helper-device");
    let mut w = World::found(&mut a, "code-1");
    let room = w.room.clone();
    w.hub.publish_key_package(&a.sig(), a.key_package(true), true); // last-resort only
    w.publish(&f, 2);
    w.publish(&h2, 2);
    w.enrol_agent(&mut a, &f);
    let p = w.new_session(&mut a, "main", &[&f]);
    w.welcome(&mut f);

    // (a) both sides export the binding value from the parent session's current epoch
    let g = b"helper-1".to_vec();
    let psk_id = [b"trommi/v2/helper-bind/".as_slice(), &p, &f.epoch(&p).to_be_bytes()].concat();
    let value_f = f.group(&p).export_secret(f.crypto(), LABEL_BIND, &g, 32).unwrap();
    let value_a = a.group(&p).export_secret(a.crypto(), LABEL_BIND, &g, 32).unwrap();
    assert_eq!(value_f, value_a);
    let gi = f.found(&g, &session_meta(&room, &f, Some(&p)));
    w.hub.found_group(&gi).unwrap();
    let adds: Vec<_> = [&a, &h2].iter().map(|d| w.hub.take_key_package(&d.sig()).unwrap()).collect();
    let out = f.commit(&g, Change { adds, psk: Some((psk_id.clone(), value_f)), ..Default::default() }).unwrap();
    w.hub.submit(&out, Rows::default()).unwrap();
    f.confirm(&g);
    let wl = w.hub.welcomes_for(&a.sig()).pop().unwrap();
    let without = a.stage_welcome(&wl).map(|_| ()).unwrap_err();
    println!("v04: Welcome with a PSK the device has not stored: {without}");
    a.store_psk(&psk_id, &[0u8; 32]);
    let wrong = a.stage_welcome(&wl).map(|_| ()).unwrap_err();
    println!("v04: Welcome with the wrong PSK value: {wrong}");
    a.store_psk(&psk_id, &value_a);
    a.join(&wl).expect("with the value exported from the parent session");
    assert_eq!(a.key(&g, 1), f.key(&g, 1));
    // the helper's own agent device is not in the parent: it cannot open this Welcome
    let wl2 = w.hub.welcomes_for(&h2.sig()).pop().unwrap();
    assert!(h2.stage_welcome(&wl2).unwrap_err().contains("KeyNotFound"));
    // A finding on the way: that refused attempt destroyed the private key of the
    // ONE-TIME key package the Welcome was made for. Even with the right PSK the same
    // Welcome can never be opened again; the device has to be added afresh.
    h2.store_psk(&psk_id, &value_a);
    assert!(h2.stage_welcome(&wl2).unwrap_err().contains("NoMatchingKeyPackage"));

    // (c) the standard's branch PSK, naming the parent group
    let fg = f.groups.get_mut(&g).unwrap();
    let branch = PreSharedKeyId::new(CS, &f.prov.rand, Psk::Resumption(ResumptionPsk::new(
        ResumptionPskUsage::Branch, openmls::group::GroupId::from_slice(&p), 1u64.into()))).unwrap();
    let r = fg
        .commit_builder()
        .add_proposal(Proposal::PreSharedKey(Box::new(PreSharedKeyProposal::new(branch))))
        .load_psks(&f.prov.storage)
        .map(|_| ());
    println!("v04: resumption PSK (usage branch) of the parent group, loaded in the helper group: {r:?}");
    // It "loads": the helper group has an epoch 1 of its own, and that secret is taken.
    // The parent's group id in the PSK id is ignored: not a binding to the parent.
    assert!(r.is_ok());
}
