//! The quota unit tests of hub/ops/test.mjs, on this hub's quota_plan (eviction order, what is never evicted, the
//! agents' quarter, status pins, foreign references).

use crate::db::Db;
use crate::ops::quota_plan;
use rusqlite::{params, Connection};

const HUMAN: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const AGENT: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
fn aid(i: u32) -> String { format!("{i:032x}") }
fn tmpdb(tag: &str) -> (Db, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("hubrs-quota-{tag}-{}", zcrypto::hex(&crate::util::random_bytes(6))));
    (Db::open(&dir, &|_| {}).unwrap(), dir)
}
struct Fake(i64);
impl Fake {
    fn envelope(&mut self, c: &Connection, room: &str, kind: i64, ids: &[String], object: Option<&str>, sender: &str, session: Option<&str>) {
        self.0 += 1;
        let mut header = vec![0u8; 60];
        if let Some(s) = session {
            header[38] = 1;
            header[39..55].copy_from_slice(&zcrypto::unhex(s).unwrap());
        }
        c.execute(
            "INSERT INTO envelopes (room_id, envelope_number, sender_device_id, sender_sequence, previous_envelope_hash, envelope_hash, key_epoch, object_id,
    envelope_kind, send_push, attachment_ids, padded_size, sent_at, received_at, envelope_header, envelope_nonce, encrypted_body_hash, envelope_signature)
    VALUES (?, ?, ?, ?, X'00', X'00', 1, ?, ?, 0, ?, 0, 0, 0, ?, ?, ?, ?)",
            params![room, self.0, zcrypto::unhex(sender).unwrap(), self.0, object, kind, ids.join(","), header, vec![0u8], vec![0u8], vec![0u8]],
        )
        .unwrap();
    }
}
fn attachment(c: &Connection, room: &str, id: &str, size: i64, at: i64, object: Option<&str>, uploader: &str) {
    c.execute("INSERT INTO attachments (room_id, attachment_id, object_id, uploader_device_id, total_size, chunk_count, stored_at) VALUES (?, ?, ?, ?, ?, 1, ?)", params![room, id, object, uploader, size, at]).unwrap();
}
fn object(c: &Connection, room: &str, id: &str, state: i64) {
    c.execute("INSERT INTO objects (room_id, object_id, object_state, urgency, answered_at, owner_device_id, first_envelope_number, latest_head_envelope_number) VALUES (?, ?, ?, 1, 0, 'x', 1, 1)", params![room, id, state]).unwrap();
}
fn device(c: &Connection, room: &str, id: &str, role: &str) {
    c.execute("INSERT INTO devices (room_id, device_id, device_role, key_signing_public, key_exchange_public, added_entry_number) VALUES (?, ?, ?, X'00', X'00', 1)", params![room, id, role]).unwrap();
}
/// quota.make: plan, then the rows of what has to go are deleted; returns the evicted ids, or the refusal's (status, body).
fn make(c: &Connection, quota: f64, room: &str, bytes: i64, uploader: Option<&str>) -> Result<Vec<String>, (u16, serde_json::Value)> {
    match quota_plan(c, quota, room, bytes, uploader) {
        Ok(gone) => {
            for a in &gone {
                c.execute("DELETE FROM attachments WHERE room_id = ? AND attachment_id = ?", params![room, a.attachment_id]).unwrap();
            }
            Ok(gone.into_iter().map(|a| a.attachment_id).collect())
        }
        Err(f) => match f.kind {
            crate::error::Kind::Reply(s, b) => Err((s, b)),
            _ => panic!("{f:?}"),
        },
    }
}

#[test]
fn eviction_order_oldest_first_and_what_is_never_evicted() {
    let (db, dir) = tmpdb("order");
    let c = db.w();
    let room = "b".repeat(64);
    let mut f = Fake(1000000);
    let (closed, answered, open) = (aid(100), aid(101), aid(102));
    object(&c, &room, &closed, 3);
    object(&c, &room, &answered, 2);
    object(&c, &room, &open, 1);
    attachment(&c, &room, &aid(1), 100, 10, Some(&open), HUMAN);
    f.envelope(&c, &room, 2, &[aid(1)], Some(&open), HUMAN, None);
    attachment(&c, &room, &aid(2), 100, 20, None, HUMAN);
    f.envelope(&c, &room, 6, &[aid(2)], None, HUMAN, None);
    attachment(&c, &room, &aid(3), 100, 30, None, HUMAN);
    attachment(&c, &room, &aid(4), 100, 40, None, HUMAN);
    f.envelope(&c, &room, 1, &[aid(4)], None, HUMAN, None);
    attachment(&c, &room, &aid(5), 100, 50, Some(&closed), HUMAN);
    f.envelope(&c, &room, 2, &[aid(5)], Some(&closed), HUMAN, None);
    attachment(&c, &room, &aid(6), 100, 60, Some(&answered), HUMAN);
    f.envelope(&c, &room, 1, &[aid(6)], None, HUMAN, None);
    attachment(&c, &room, &aid(7), 100, 70, None, HUMAN);
    f.envelope(&c, &room, 1, &[aid(7)], None, HUMAN, None);
    f.envelope(&c, &room, 6, &[aid(7)], None, HUMAN, None);
    attachment(&c, &room, &aid(8), 300, 5, Some(&closed), HUMAN);
    f.envelope(&c, &room, 1, &[aid(8)], None, HUMAN, None);
    assert_eq!(crate::ops::quota_used(&c, &room), 1000);
    assert_eq!(make(&c, 1000.0, &room, 0, None).unwrap(), Vec::<String>::new());
    assert_eq!(make(&c, 1000.0, &room, 350, None).unwrap(), vec![aid(8), aid(4)]);
    assert_eq!(crate::ops::quota_used(&c, &room), 600);
    assert_eq!(make(&c, 1000.0, &room, 600, None).unwrap(), vec![aid(5), aid(6)]);
    assert_eq!(crate::ops::quota_used(&c, &room), 400);
    let (s, body) = make(&c, 1000.0, &room, 601, None).unwrap_err();
    assert_eq!((s, body["error"].as_str().unwrap(), body["used"].as_i64().unwrap(), body["quota"].as_i64().unwrap()), (413, "quota-exceeded", 400, 1000));
    let left: Vec<String> = c.prepare("SELECT attachment_id FROM attachments ORDER BY attachment_id").unwrap().query_map([], |r| r.get(0)).unwrap().collect::<Result<_, _>>().unwrap();
    assert_eq!(left, vec![aid(1), aid(2), aid(3), aid(7)]);
    drop(c);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn agents_evict_only_their_own_hold_a_quarter_and_cannot_pin() {
    let (db, dir) = tmpdb("agents");
    let c = db.w();
    let room = "d".repeat(64);
    let sess = "ee".repeat(16);
    let mut f = Fake(2000000);
    device(&c, &room, HUMAN, "human");
    device(&c, &room, AGENT, "agent");
    attachment(&c, &room, &aid(1), 500, 10, None, HUMAN);
    f.envelope(&c, &room, 1, &[aid(1)], None, HUMAN, None);
    attachment(&c, &room, &aid(2), 100, 20, None, HUMAN);
    f.envelope(&c, &room, 1, &[aid(2)], None, AGENT, Some(&sess));
    assert_eq!(make(&c, 1000.0, &room, 450, Some(AGENT)).unwrap_err().0, 413, "an agent never evicts a human attachment");
    attachment(&c, &room, &aid(3), 200, 30, None, AGENT);
    f.envelope(&c, &room, 6, &[aid(3)], None, AGENT, Some(&sess));
    let (s, body) = make(&c, 1000.0, &room, 100, Some(AGENT)).unwrap_err();
    assert_eq!((s, body["quota"].as_i64().unwrap()), (413, 250), "agents hold at most 250");
    attachment(&c, &room, &aid(4), 10, 40, None, AGENT);
    f.envelope(&c, &room, 6, &[aid(4)], None, AGENT, Some(&sess));
    assert_eq!(make(&c, 1000.0, &room, 200, Some(AGENT)).unwrap(), vec![aid(3)], "only the agent's own, no longer current status attachment");
    assert_eq!(make(&c, 1000.0, &room, 500, Some(HUMAN)).unwrap(), vec![aid(1)]);
    drop(c);
    let _ = std::fs::remove_dir_all(dir);
}
