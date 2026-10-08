//! session-grants.mjs in Rust: per-session keys (README R6), FORMAT.md section 19.
use super::*;

pub const OBJ_GRANT: u8 = 0x0e;
pub const OBJ_SESSION_BACK_LINK: u8 = 0x0f;
pub mod glabel {
    pub const COMMIT_KEY: &str = "trommi/v1/session-commit/key";
    pub const COMMIT_HIST: &str = "trommi/v1/session-commit/hist";
    pub const GRANT_SIG: &str = "trommi/v1/session-grant-sig";
    pub const GRANT: &str = "trommi/v1/session-grant";
    pub const WRAP: &str = "trommi/v1/session-wrap";
    pub const MANIFEST: &str = "trommi/v1/session-manifest";
    pub const BACK_LINK: &str = "trommi/v1/session-back-link";
}
const FLAG_HISTORY: u8 = 1;

pub fn session_commits(session_id: &[u8; 16], s: &Secret) -> ([u8; 32], Option<[u8; 32]>) {
    let ctx = concat(&[session_id, &s.epoch.to_be_bytes()]);
    let k = hkdf(&s.key, &[], glabel::COMMIT_KEY, &ctx, 32).try_into().unwrap();
    let h = s.hist.map(|h| hkdf(&h, &[], glabel::COMMIT_HIST, &ctx, 32).try_into().unwrap());
    (k, h)
}
fn wrap_aad(room_id: &[u8], session_id: &[u8], epoch: u32, recipient: &[u8]) -> Vec<u8> {
    concat(&[&label_bytes(glabel::WRAP), room_id, session_id, &epoch.to_be_bytes(), recipient])
}
pub struct Recipient {
    pub id: [u8; 32],
    pub kex_pub: [u8; 32],
    pub with_hist: bool,
}
/// recipients -> [(id, sealed)] sorted by id.
pub fn wrap_session_key(room_id: &[u8], session_id: &[u8; 16], secret: &Secret, recipients: &mut [Recipient], rng: &mut Rng) -> Result<Vec<([u8; 32], Vec<u8>)>> {
    recipients.sort_by(|a, b| a.id.cmp(&b.id));
    let mut out = vec![];
    for r in recipients.iter() {
        let plain = if r.with_hist { concat(&[&[2u8], &secret.key, &secret.hist.unwrap()]) } else { concat(&[&[1u8], &secret.key]) };
        out.push((r.id, seal(&r.kex_pub, &plain, &wrap_aad(room_id, session_id, secret.epoch, &r.id), rng)?));
    }
    Ok(out)
}
pub fn grant_manifest_hash(wraps: &[([u8; 32], Vec<u8>)]) -> [u8; 32] {
    let mut w = wraps.to_vec();
    w.sort_by(|a, b| a.0.cmp(&b.0));
    let mut parts: Vec<Vec<u8>> = vec![];
    for (id, sealed) in &w {
        parts.push(id.to_vec());
        parts.push(sha256(&[sealed]).to_vec());
    }
    let refs: Vec<&[u8]> = parts.iter().map(|p| p.as_slice()).collect();
    hash(glabel::MANIFEST, &refs)
}

#[derive(Clone, Debug)]
pub struct SessionEpoch {
    pub key_commit: [u8; 32],
    pub hist_commit: [u8; 32],
    pub with_history: bool,
}
/// The state of one session's grant chain.
#[derive(Clone, Debug)]
pub struct SessionState {
    pub session_id: String,
    pub grant_number: u32,
    pub grant_hash: [u8; 32],
    pub epoch: u32,
    pub agent_ids: Vec<String>,
    pub with_history: bool,
    pub key_commit: [u8; 32],
    pub hist_commit: [u8; 32],
    pub manifest_hash: [u8; 32],
    pub log_seq: u32,
    pub signer_id: String,
    pub time: u64,
    pub epochs: BTreeMap<u32, SessionEpoch>,
    pub creator_id: String,
    pub created_by_agent: bool,
    pub stale: bool,
}
impl SessionState {
    pub fn session_id_bytes(&self) -> [u8; 16] {
        unhex(&self.session_id).unwrap().try_into().unwrap()
    }
}

pub fn unwrap_session_key(room_id: &[u8], ss: &SessionState, device: &Device, sealed: &[u8], epoch: u32) -> Result<Secret> {
    let plain = open_sealed(device, sealed, &wrap_aad(room_id, &ss.session_id_bytes(), epoch, &device.id))?;
    let s = if plain.len() == 33 && plain[0] == 1 {
        Secret { epoch, key: plain[1..].try_into().unwrap(), hist: None }
    } else if plain.len() == 65 && plain[0] == 2 {
        Secret { epoch, key: plain[1..33].try_into().unwrap(), hist: Some(plain[33..].try_into().unwrap()) }
    } else {
        return fail("bad-format", "wrapped session key");
    };
    check_session_commits(ss, &s)?;
    Ok(s)
}
fn check_session_commits(ss: &SessionState, s: &Secret) -> Result<()> {
    let Some(info) = ss.epochs.get(&s.epoch) else { return fail("wrong-epoch", format!("the grants know no session key epoch {}", s.epoch)) };
    let (k, h) = session_commits(&ss.session_id_bytes(), s);
    if !bytes_equal(&k, &info.key_commit) {
        return fail("key-mismatch", "session key does not match the grant");
    }
    if let Some(h) = h {
        if !bytes_equal(&h, &info.hist_commit) {
            return fail("key-mismatch", "session history key does not match the grant");
        }
    }
    Ok(())
}
fn back_link_key(room_id: &[u8], session_id: &[u8], s: &Secret) -> Result<(Vec<u8>, Vec<u8>)> {
    let Some(hist) = s.hist else { return fail("no-key", "no history key for this session") };
    let okm = hkdf(&hist, &concat(&[room_id, session_id]), glabel::BACK_LINK, &s.epoch.to_be_bytes(), 44);
    Ok((okm[..32].to_vec(), okm[32..].to_vec()))
}
fn back_link_aad(room_id: &[u8], session_id: &[u8], epoch: u32) -> Vec<u8> {
    concat(&[&[VERSION, OBJ_SESSION_BACK_LINK], room_id, session_id, &epoch.to_be_bytes()])
}
pub fn make_session_back_link(room_id: &[u8], session_id: &[u8; 16], s: &Secret, previous: &Secret) -> Result<Vec<u8>> {
    if previous.epoch + 1 != s.epoch || previous.hist.is_none() {
        return fail("bad-argument", "a back link needs the full previous session secret");
    }
    let (k, n) = back_link_key(room_id, session_id, s)?;
    let ct = gcm_seal(&k, &n, &back_link_aad(room_id, session_id, s.epoch), &concat(&[&previous.key, &previous.hist.unwrap()]));
    Ok(concat(&[&[VERSION, OBJ_SESSION_BACK_LINK], session_id, &s.epoch.to_be_bytes(), &ct]))
}
pub fn open_session_back_link(room_id: &[u8], ss: &SessionState, s: &Secret, link: &[u8]) -> Result<Secret> {
    let mut r = R::new(link);
    if r.u8()? != VERSION || r.u8()? != OBJ_SESSION_BACK_LINK {
        return fail("bad-format", "not a session back link");
    }
    let sid = r.take(16)?;
    if hex(&sid) != ss.session_id {
        return fail("bad-format", "back link of another session");
    }
    if r.u32()? != s.epoch {
        return fail("wrong-epoch", "back link of another epoch");
    }
    let (k, n) = back_link_key(room_id, &sid, s)?;
    let plain = gcm_open(&k, &n, &back_link_aad(room_id, &sid, s.epoch), &r.rest()).map_err(|_| ZError::new("decrypt-failed", "session back link"))?;
    if plain.len() != 64 {
        return fail("bad-format", "session back link");
    }
    let prev = Secret { epoch: s.epoch - 1, key: plain[..32].try_into().unwrap(), hist: Some(plain[32..].try_into().unwrap()) };
    check_session_commits(ss, &prev)?;
    Ok(prev)
}

pub struct Grant {
    pub room_id: [u8; 32],
    pub session_id: [u8; 16],
    pub grant_number: u32,
    pub previous_grant_hash: [u8; 32],
    pub epoch: u32,
    pub with_history: bool,
    pub agent_ids: Vec<[u8; 32]>,
    pub key_commit: [u8; 32],
    pub hist_commit: [u8; 32],
    pub manifest_hash: [u8; 32],
    pub log_seq: u32,
    pub log_hash: [u8; 32],
    pub time: u64,
    pub signer_id: [u8; 32],
    pub body: Vec<u8>,
    pub signature: Vec<u8>,
}
pub fn decode_grant(b: &[u8]) -> Result<Grant> {
    if b.len() < 64 {
        return fail("bad-format", "grant too short");
    }
    let body = b[..b.len() - 64].to_vec();
    let signature = b[b.len() - 64..].to_vec();
    let mut r = R::new(&body);
    let trunc = |e: ZError| if e.message == "truncated" { ZError::new("bad-format", "truncated grant") } else { e };
    if r.u8().map_err(trunc)? != VERSION {
        return fail("bad-version", "grant version");
    }
    if r.u8().map_err(trunc)? != OBJ_GRANT {
        return fail("bad-format", "not a session grant");
    }
    let room_id = r.take_arr().map_err(trunc)?;
    let session_id = r.take_arr().map_err(trunc)?;
    let grant_number = r.u32().map_err(trunc)?;
    let previous_grant_hash = r.take_arr().map_err(trunc)?;
    let epoch = r.u32().map_err(trunc)?;
    let flags = r.u8().map_err(trunc)?;
    if flags & !FLAG_HISTORY != 0 {
        return fail("bad-format", "unknown grant flags");
    }
    let n = r.u16().map_err(trunc)?;
    let mut agent_ids: Vec<[u8; 32]> = vec![];
    for i in 0..n as usize {
        let id = r.take_arr().map_err(trunc)?;
        if i > 0 && agent_ids[i - 1] >= id {
            return fail("bad-format", "agent ids not strictly ascending");
        }
        agent_ids.push(id);
    }
    let g = Grant {
        room_id, session_id, grant_number, previous_grant_hash, epoch, with_history: flags & FLAG_HISTORY != 0, agent_ids,
        key_commit: r.take_arr().map_err(trunc)?, hist_commit: r.take_arr().map_err(trunc)?, manifest_hash: r.take_arr().map_err(trunc)?,
        log_seq: r.u32().map_err(trunc)?, log_hash: r.take_arr().map_err(trunc)?, time: r.u64().map_err(trunc)?, signer_id: r.take_arr().map_err(trunc)?,
        body: vec![], signature,
    };
    r.end()?;
    Ok(Grant { body, ..g })
}

fn member_changes(rs: &LogState) -> Vec<u32> {
    rs.entries.iter().filter(|e| e.type_ == ENTRY_REMOVE || e.type_ == ENTRY_RECOVER).map(|e| e.seq).collect()
}
fn change_between(rs: &LogState, a: u32, b: u32) -> bool {
    member_changes(rs).iter().any(|s| *s > a && *s <= b)
}
pub fn last_member_change(rs: &LogState) -> i64 {
    member_changes(rs).last().map(|x| *x as i64).unwrap_or(-1)
}
pub fn grant_is_stale(ss: &SessionState, rs: &LogState) -> bool {
    change_between(rs, ss.log_seq, rs.head_seq)
}
fn recovery_id_at(rs: &LogState, log_seq: u32) -> Option<([u8; 32], [u8; 32])> {
    let mut rec = None;
    for e in &rs.entries {
        if e.seq > log_seq {
            break;
        }
        if e.type_ == ENTRY_GENESIS || e.type_ == ENTRY_RECOVER {
            rec = e.recovery;
        }
    }
    rec.map(|k| (device_id(&k.sign_pub, &k.kex_pub), k.sign_pub))
}

/// Verify one grant against the session's state before it (None for the first) and the verified member list.
pub fn apply_grant(prev: Option<&SessionState>, grant_bytes: &[u8], rs: &LogState) -> Result<SessionState> {
    let g = decode_grant(grant_bytes)?;
    let bad = |why: &str| ZError::new("bad-grant", format!("grant {}: {}", g.grant_number, why));
    if !bytes_equal(&g.room_id, &rs.room_id) {
        return fail("wrong-room", "grant of another room");
    }
    if g.log_seq > rs.head_seq {
        return Err(ZError::new("log-behind", format!("the grant names member list entry {}", g.log_seq)).with("logSeq", g.log_seq));
    }
    if !bytes_equal(&rs.hashes[g.log_seq as usize], &g.log_hash) {
        return fail("log-fork", format!("the grant names another member list entry {}", g.log_seq));
    }
    let rec = recovery_id_at(rs, g.log_seq);
    let is_recovery = rec.is_some_and(|(id, _)| id == g.signer_id);
    let signer = if is_recovery { None } else { rs.member_at(&g.signer_id, g.log_seq) };
    let agent_own = !is_recovery && signer.map(|s| s.role) == Some(ROLE_AGENT) && prev.is_none() && g.agent_ids.len() == 1 && g.agent_ids[0] == g.signer_id && !g.with_history;
    if !is_recovery && !agent_own && signer.map(|s| s.role) != Some(ROLE_HUMAN) {
        return Err(bad(if signer.map(|s| s.role) == Some(ROLE_AGENT) { "an agent signs only the first grant of a session of its own, assigned to itself alone" } else { "the signer is not an active human device" }));
    }
    let pubk = if is_recovery { rec.unwrap().1 } else { signer.unwrap().sign_pub };
    if !verify(&pubk, glabel::GRANT_SIG, &g.body, &g.signature) {
        return fail("bad-signature", "session grant");
    }
    match prev {
        None => {
            if g.grant_number != 0 || !is_zero(&g.previous_grant_hash) || g.epoch != 1 {
                return Err(bad("the first grant has number 0, no predecessor and epoch 1"));
            }
        }
        Some(p) => {
            if hex(&g.session_id) != p.session_id {
                return Err(bad("another session"));
            }
            if g.grant_number != p.grant_number + 1 {
                return Err(bad(&format!("number {} does not follow {}", g.grant_number, p.grant_number)));
            }
            if !bytes_equal(&g.previous_grant_hash, &p.grant_hash) {
                return Err(bad("predecessor hash does not match"));
            }
            if g.epoch != p.epoch && g.epoch != p.epoch + 1 {
                return Err(bad(&format!("epoch {} after {}", g.epoch, p.epoch)));
            }
            if g.epoch == p.epoch && (!bytes_equal(&g.key_commit, &p.key_commit) || !bytes_equal(&g.hist_commit, &p.hist_commit)) {
                return Err(bad("same epoch, different key"));
            }
            let (lo, hi) = (g.log_seq.min(p.log_seq), g.log_seq.max(p.log_seq));
            if change_between(rs, lo, hi) {
                if g.log_seq < p.log_seq {
                    return Err(bad("names a member list entry before a removal its predecessor already saw"));
                }
                if g.epoch == p.epoch {
                    return Err(bad("after a removal or recovery the session key must change"));
                }
            }
            if g.epoch == p.epoch && !p.agent_ids.iter().all(|a| g.agent_ids.iter().any(|b| hex(b) == *a)) {
                return Err(bad("an agent loses the session: the key must change"));
            }
        }
    }
    for id in &g.agent_ids {
        if rs.member_at(id, g.log_seq).map(|m| m.role) != Some(ROLE_AGENT) {
            return Err(bad("an assigned device is not an active agent"));
        }
    }
    let mut epochs = prev.map(|p| p.epochs.clone()).unwrap_or_default();
    let prev_info_hist = epochs.get(&g.epoch).map(|e| e.with_history).unwrap_or(false);
    epochs.insert(g.epoch, SessionEpoch { key_commit: g.key_commit, hist_commit: g.hist_commit, with_history: g.with_history || prev_info_hist });
    Ok(SessionState {
        session_id: hex(&g.session_id), grant_number: g.grant_number, grant_hash: hash(glabel::GRANT, &[&g.body]), epoch: g.epoch,
        agent_ids: g.agent_ids.iter().map(|a| hex(a)).collect(), with_history: g.with_history, key_commit: g.key_commit, hist_commit: g.hist_commit,
        manifest_hash: g.manifest_hash, log_seq: g.log_seq, signer_id: hex(&g.signer_id), time: g.time, epochs,
        creator_id: prev.map(|p| p.creator_id.clone()).unwrap_or_else(|| hex(&g.signer_id)),
        created_by_agent: prev.map(|p| p.created_by_agent).unwrap_or(agent_own),
        stale: change_between(rs, g.log_seq, rs.head_seq),
    })
}
pub fn verify_grants(grants: &[Vec<u8>], rs: &LogState) -> Result<Option<SessionState>> {
    let mut s: Option<SessionState> = None;
    for g in grants {
        s = Some(apply_grant(s.as_ref(), g, rs)?);
    }
    Ok(s)
}

#[derive(Debug)]
pub struct NewGrant {
    pub grant: Vec<u8>,
    pub secret: Secret,
    pub wraps: Vec<([u8; 32], Vec<u8>)>,
    pub back_link: Option<Vec<u8>>,
    pub session_state: SessionState,
}
/// Make the next grant of a session (or its first). An agent makes only the first grant of a child session of its own.
#[allow(clippy::too_many_arguments)]
pub fn create_session_grant(rs: &LogState, signer: &Device, prev: Option<&SessionState>, session_id: Option<[u8; 16]>, current: Option<&Secret>, agent_ids: &[[u8; 32]], history_agent_ids: Option<&[[u8; 32]]>, mut with_history: bool, rotate: bool, time: u64, rng: &mut Rng) -> Result<NewGrant> {
    let signer_m = rs.member_now(&signer.id);
    let is_recovery = bytes_equal(&signer.id, &rs.recovery.id);
    let agent_own = prev.is_none() && signer_m.map(|m| m.role) == Some(ROLE_AGENT) && agent_ids.len() == 1 && agent_ids[0] == signer.id && !with_history && history_agent_ids.is_none();
    if !is_recovery && !agent_own && signer_m.map(|m| m.role) != Some(ROLE_HUMAN) {
        return fail("not-human", "only a human device (or the recovery key) grants session keys; an agent only creates a session of its own");
    }
    let sid: [u8; 16] = match prev {
        Some(p) => p.session_id_bytes(),
        None => session_id.unwrap_or_else(|| rng.bytes(16).try_into().unwrap()),
    };
    let secret = match prev {
        None => Secret { epoch: 1, key: rng.arr32(), hist: Some(rng.arr32()) },
        Some(p) if rotate => Secret { epoch: p.epoch + 1, key: rng.arr32(), hist: Some(rng.arr32()) },
        Some(p) => {
            let Some(c) = current.filter(|c| c.epoch == p.epoch && c.hist.is_some()) else { return fail("bad-argument", "pass the full current session secret to re-seal it") };
            c.clone()
        }
    };
    let mut ids = agent_ids.to_vec();
    ids.sort();
    for id in &ids {
        if rs.member_now(id).map(|m| m.role) != Some(ROLE_AGENT) {
            return fail("bad-argument", "only active agents can be assigned to a session");
        }
    }
    let given = with_history;
    let hist_for = |id: &[u8; 32]| match history_agent_ids { Some(h) => h.contains(id), None => given };
    if history_agent_ids.is_some() {
        with_history = ids.iter().any(hist_for);
    }
    let mut recipients: Vec<Recipient> = rs.active_members().into_iter().filter(|m| m.role == ROLE_HUMAN).map(|m| Recipient { id: m.id, kex_pub: m.kex_pub, with_hist: true }).collect();
    recipients.push(Recipient { id: rs.recovery.id, kex_pub: rs.recovery.kex_pub, with_hist: true });
    for id in &ids {
        recipients.push(Recipient { id: *id, kex_pub: rs.member_now(id).unwrap().kex_pub, with_hist: hist_for(id) });
    }
    let wraps = wrap_session_key(&rs.room_id, &sid, &secret, &mut recipients, rng)?;
    let (kc, hc) = session_commits(&sid, &secret);
    let mut w = W::new().u8(VERSION).u8(OBJ_GRANT).raw(&rs.room_id).raw(&sid).u32(prev.map(|p| p.grant_number + 1).unwrap_or(0))
        .raw(&prev.map(|p| p.grant_hash).unwrap_or(ZERO32)).u32(secret.epoch).u8(if with_history { FLAG_HISTORY } else { 0 }).u16(ids.len() as u16);
    for id in &ids {
        w = w.raw(id);
    }
    let body = w.raw(&kc).raw(&hc.unwrap()).raw(&grant_manifest_hash(&wraps)).u32(rs.head_seq).raw(&rs.head_hash).u64(time).raw(&signer.id).done();
    let grant = concat(&[&body, &signer.sign(glabel::GRANT_SIG, &body)]);
    let back_link = match (prev, rotate, current) { (Some(_), true, Some(c)) if c.hist.is_some() => Some(make_session_back_link(&rs.room_id, &sid, &secret, c)?), _ => None };
    let session_state = apply_grant(prev, &grant, rs)?;
    Ok(NewGrant { grant, secret, wraps, back_link, session_state })
}
