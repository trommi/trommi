//! `spec/vectors/recovery.json`: the keys that follow from a recovery code, a `SealedKey` and its opening, a
//! join with the code, a join with a wrong signature, and a recovery with Cuts and a new code with its
//! `RecoveryLink` (section 8; item 5 of section 19). A small room is played through on devices whose randomness
//! is seeded: human devices only, no session.
//!
//! The recovery removes one device. OpenMLS orders several Remove proposals of one Commit differently from run
//! to run, so a Commit that removes more than one leaf does not come out the same twice.

use serde_json::{json, Value};
use trommi_core::crypto::{
    derive_hpke_keypair, expand_with_label, sha256, sign_with_label, Secret, SigningKey,
};
use trommi_core::device::Device;
use trommi_core::ids::{DeviceId, GroupId};
use trommi_core::mls::profile::Cut;
use trommi_core::recovery::{
    check_room, removals, RecoveryAuth, RecoveryKeys, RecoveryLink, SealedKey, HPKE_LABEL,
    JOIN_LABEL, MAC_LABEL, SIGN_LABEL,
};
use trommi_core::store::OutboxEntry;
use trommi_core::{codec, Error};

use super::{entropy, hex};
use crate::hub::Hub;
use crate::{fetch, Fetched, MemoryStorage, TestDevice};

/// The name of the file.
pub const NAME: &str = "recovery";

/// The clock of every device in the file, in milliseconds: 21 September 2026.
pub const NOW: u64 = 1_790_000_000_000;

/// The account's sealed copies are opaque to the core: any bytes stand for them.
const ACCOUNT: &[u8] = b"the account's sealed copies of the new code";

fn device(label: &str) -> Result<TestDevice, Error> {
    let seeded = entropy(&format!("{NAME} device {label}"))?;
    Device::create(MemoryStorage::new(), Box::new(seeded))
}

/// Posts every outbox entry of `device` and reports the answers, until nothing is left. Returns the entries.
fn post(hub: &mut Hub, device: &mut TestDevice) -> Result<Vec<OutboxEntry>, Error> {
    let mut posted = Vec::new();
    loop {
        let outbox = device.outbox();
        if outbox.is_empty() {
            return Ok(posted);
        }
        for entry in outbox {
            let answer = hub.post(&device.id(), &entry)?;
            device.outbox_accepted(entry.id, answer)?;
            posted.push(entry);
        }
    }
}

fn served(fetched: &Fetched) -> Value {
    let commits: Vec<Value> = fetched
        .room
        .commits
        .iter()
        .map(|(commit, recovery_auth)| {
            json!({ "commit": hex(commit), "recovery_auth": recovery_auth.as_deref().map(hex) })
        })
        .collect();
    json!({
        "room_id": fetched.room.group.room_id().to_string(),
        "founding_group_info": hex(&fetched.room.founding),
        "commits": commits,
        "current_group_info": hex(&fetched.room.current),
        "anchor_group_info": hex(&fetched.anchor),
        "rows": fetched.rows.iter().map(|row| hex(row)).collect::<Vec<_>>(),
        "links": fetched.links.iter().map(|link| hex(link)).collect::<Vec<_>>(),
    })
}

fn keys_of(code: &Secret<32>) -> Result<Value, Error> {
    let sign_seed: Secret<32> = expand_with_label(code, SIGN_LABEL, &[])?;
    let hpke_secret: Secret<32> = expand_with_label(code, HPKE_LABEL, &[])?;
    let mac: Secret<32> = expand_with_label(code, MAC_LABEL, &[])?;
    let hpke = derive_hpke_keypair(&hpke_secret)?;
    Ok(json!({
        "code": hex(code.expose()),
        "recovery_sign_seed": hex(sign_seed.expose()),
        "recovery_signature_key": hex(&SigningKey::from_seed(sign_seed).public()),
        "recovery_hpke_secret": hex(hpke_secret.expose()),
        "recovery_hpke_private_key": hex(hpke.private.expose()),
        "recovery_hpke_key": hex(&hpke.public),
        "recovery_mac": hex(mac.expose()),
    }))
}

fn row_of(row: &[u8], content_key: &Secret<32>, group_info: &[u8]) -> Result<Value, Error> {
    let decoded = SealedKey::from_bytes(row)?;
    Ok(json!({
        "group_id": decoded.context.group.to_string(),
        "epoch": decoded.context.epoch,
        "group_info": hex(group_info),
        "group_info_hash": decoded.context.group_info.to_string(),
        "room_epoch": decoded.room_epoch,
        "recovery_hpke_key": hex(&decoded.recovery_hpke_key),
        "kem_output": hex(&decoded.sealed.kem_output),
        "ciphertext": hex(&decoded.sealed.ciphertext),
        "writer": decoded.writer.to_string(),
        "mac": decoded.mac.map(|mac| hex(&mac)),
        "sealed_key": hex(row),
        "content_key": hex(content_key.expose()),
    }))
}

fn request(entry: &OutboxEntry, names: &[&str]) -> Value {
    let mut value = json!({
        "group_id": entry.group.map(|group| group.to_string()),
        "epoch": entry.epoch,
    });
    for (name, part) in names.iter().zip(&entry.parts) {
        value[*name] = json!(hex(part));
    }
    value
}

/// A Cut that names an envelope: the caller of a recovery verified that chain; the core carries it.
fn cut(device: DeviceId, seq: u64) -> Result<Cut, Error> {
    Ok(Cut {
        device,
        seq,
        hash: sha256(&[device.as_bytes().as_slice(), &seq.to_be_bytes()].concat())?,
    })
}

/// Makes the file.
pub fn generate() -> Result<Value, Error> {
    let code = Secret::<32>::random(&mut entropy(&format!("{NAME} code"))?)?;
    let keys = RecoveryKeys::from_code(code.duplicate())?;
    let mut hub = Hub::new(true);

    // A room of one human device, two epochs.
    let mut a = device("a")?;
    let room = a.found_room(&keys, NOW)?;
    let group = GroupId::room(room);
    let founding = post(&mut hub, &mut a)?;
    a.update(&group, true, NOW)?;
    post(&mut hub, &mut a)?;

    // The row of the founding, and its opening.
    let part = |entry: &OutboxEntry, at: usize| entry.parts.get(at).cloned().unwrap_or_default();
    let first = founding.first().ok_or(Error::Internal("vector founding"))?;
    let sealed_key = row_of(&part(first, 1), &a.content_key(&group, 0)?, &part(first, 0))?;

    // A third device signs in with the code.
    let mut c = device("c")?;
    let before = fetch(&hub, &keys);
    before.served(|served| c.join_room_with_code(&keys, served, NOW))?;
    let joined = post(&mut hub, &mut c)?;
    let join = joined.first().ok_or(Error::Internal("vector join"))?;
    let auth = RecoveryAuth::from_bytes(&part(join, 3))?;
    let join_value = json!({
        "served": served(&before),
        "joiner": c.id().to_string(),
        "request": request(join, &["commit", "group_info", "sealed_key", "recovery_auth"]),
        "recovery_auth": {
            "base_group_id": auth.join.base.group.to_string(),
            "base_epoch": auth.join.base.epoch,
            "base_group_info_hash": auth.join.base.group_info.to_string(),
            "room_epoch": auth.join.room_epoch,
            "room_state": auth.join.room_state.to_string(),
            "joiner": auth.join.joiner.to_string(),
            "commit_hash": auth.commit.to_string(),
            "signature": hex(&auth.signature),
        },
        "content_key": hex(c.content_key(&group, join.epoch.saturating_add(1))?.expose()),
    });

    // A fourth device builds its join; the RecoveryAuth beside it is signed with the key of another code.
    let mut d = device("d")?;
    let served_d = fetch(&hub, &keys);
    served_d.served(|served| d.join_room_with_code(&keys, served, NOW))?;
    let refused = d
        .outbox()
        .into_iter()
        .next()
        .ok_or(Error::Internal("vector join"))?;
    let other = RecoveryKeys::from_code(Secret::random(&mut entropy(&format!(
        "{NAME} other code"
    ))?)?)?;
    let mut wrong = RecoveryAuth::from_bytes(&part(&refused, 3))?;
    let signed = [
        codec::encode(&wrong.join)?,
        wrong.commit.as_bytes().to_vec(),
    ]
    .concat();
    wrong.signature = sign_with_label(other.signing_key(), JOIN_LABEL, &signed)?
        .try_into()
        .map_err(|_| Error::Internal("signature length"))?;
    let mut wrong_request = refused.clone();
    if let Some(auth) = wrong_request.parts.get_mut(3) {
        *auth = wrong.to_bytes()?;
    }
    let wrong_value = json!({
        "served": served(&served_d),
        "request": request(&wrong_request, &["commit", "group_info", "sealed_key", "recovery_auth"]),
        "signed_with": hex(&other.public().signature_key),
        "error": hub.post(&d.id(), &wrong_request).err().map(|error| error.code()),
    });
    d.outbox_refused(refused.id, &Error::BadSignature)?;

    // The first device removes the one that signed in. Then it is lost; another recovers, removes it with its
    // Cut, and replaces the code.
    for item in hub.log_after(a.cursor()) {
        crate::process(&mut a, &item)?;
    }
    a.remove_human_devices(&[cut(c.id(), 2)?], NOW)?;
    post(&mut hub, &mut a)?;
    let mut e = device("e")?;
    hub.open_recovery(&e.id())?;
    let lost = fetch(&hub, &keys);
    let (replacement, cuts) = lost.served(|served| {
        let checked = check_room(&keys, served)?;
        let history = checked
            .observer
            .history()
            .ok_or(Error::Internal("vector room"))?;
        let replacement =
            keys.replace(&mut entropy(&format!("{NAME} new code"))?, &room, history)?;
        let mut cuts = Vec::new();
        for (group, gone) in removals(&checked)? {
            for (seq, device) in (3u64..).zip(gone) {
                cuts.push((group, cut(device, seq)?));
            }
        }
        Ok::<_, Error>((replacement, cuts))
    })?;
    lost.served(|served| e.recover(&keys, served, &replacement, &cuts, ACCOUNT, NOW))?;
    let requests = post(&mut hub, &mut e)?;
    let (finish, commits) = requests
        .split_last()
        .ok_or(Error::Internal("vector recovery"))?;
    let link = RecoveryLink::from_bytes(&replacement.link)?;
    let epoch = hub.epoch(&group).ok_or(Error::Internal("vector room"))?;
    let recovery_value = json!({
        "served": served(&lost),
        "device": e.id().to_string(),
        "cuts": cuts.iter().map(|(group, cut)| json!({
            "group_id": group.to_string(),
            "device": cut.device.to_string(),
            "seq": cut.seq,
            "hash": cut.hash.to_string(),
        })).collect::<Vec<_>>(),
        "new_code": keys_of(&replacement.code)?,
        "recovery_link": {
            "room_id": link.room_id.to_string(),
            "new_recovery_hpke_key": hex(&link.new_recovery_hpke_key),
            "kem_output": hex(&link.sealed.kem_output),
            "ciphertext": hex(&link.sealed.ciphertext),
            "mac": hex(&link.mac),
            "link": hex(&replacement.link),
        },
        "commits": commits.iter().map(|entry| request(
            entry,
            &["commit", "group_info", "welcome", "sealed_key", "recovery_auth"],
        )).collect::<Vec<_>>(),
        "finish": request(finish, &["recovery_link", "account"]),
        "room_epoch": epoch,
        "content_key": hex(e.content_key(&group, epoch)?.expose()),
    });

    Ok(json!({
        "now": NOW,
        "keys": keys_of(&code)?,
        "sealed_key": sealed_key,
        "join": join_value,
        "wrong_signature": wrong_value,
        "recovery": recovery_value,
    }))
}
