//! Refusals, as hub/server.mjs answers them: `{ error, message }` (+ `voided`, `envelope_number`,
//! `signed_entries` where the refusal carries them), the status from the README's table.

use serde_json::{json, Value};
use zcrypto::ZError;

#[derive(Debug, Clone)]
pub enum Kind {
    /// A ZError of the crypto layer: a code the table does not list is still a 400.
    Z,
    /// A refusal of the hub itself (server.mjs fail()): a code the table does not list is an internal error.
    Hub,
    /// An ops refusal with its own status and body (ops/http.mjs refuse()).
    Reply(u16, Value),
    /// Not a refusal: something broke.
    Internal,
    /// The connection is cut without an answer (a body that did not arrive in time).
    Destroy,
}

#[derive(Debug, Clone)]
pub struct Fail {
    pub kind: Kind,
    pub code: String,
    pub message: String,
    pub retry_after: Option<u64>,
    pub voided: Option<i64>,
    pub void_bytes: Option<Vec<u8>>,
    pub signed_entries: Option<Vec<Vec<u8>>>,
}

pub type HResult<T> = Result<T, Fail>;

impl Fail {
    pub fn hub(code: &str, message: &str) -> Fail {
        Fail { kind: Kind::Hub, code: code.into(), message: message.into(), retry_after: None, voided: None, void_bytes: None, signed_entries: None }
    }
    pub fn retry(mut self, s: u64) -> Fail {
        self.retry_after = Some(s);
        self
    }
    pub fn reply(status: u16, code: &str, message: &str, details: Value) -> Fail {
        let mut body = json!({ "error": code, "message": message });
        if let (Some(b), Some(d)) = (body.as_object_mut(), details.as_object()) {
            for (k, v) in d {
                b.insert(k.clone(), v.clone());
            }
        }
        Fail { kind: Kind::Reply(status, body), code: code.into(), message: message.into(), retry_after: None, voided: None, void_bytes: None, signed_entries: None }
    }
    pub fn internal(message: impl Into<String>) -> Fail {
        Fail { kind: Kind::Internal, code: "internal".into(), message: message.into(), retry_after: None, voided: None, void_bytes: None, signed_entries: None }
    }
    pub fn destroy() -> Fail {
        Fail { kind: Kind::Destroy, code: "destroy".into(), message: String::new(), retry_after: None, voided: None, void_bytes: None, signed_entries: None }
    }
}

impl From<ZError> for Fail {
    fn from(e: ZError) -> Fail {
        Fail { kind: Kind::Z, code: e.code, message: e.message, retry_after: None, voided: None, void_bytes: None, signed_entries: None }
    }
}
impl From<rusqlite::Error> for Fail {
    fn from(e: rusqlite::Error) -> Fail { Fail::internal(format!("sqlite: {e}")) }
}
impl From<std::io::Error> for Fail {
    fn from(e: std::io::Error) -> Fail { Fail::internal(format!("io: {e}")) }
}

pub fn status_of(code: &str) -> Option<u16> {
    Some(match code {
        "bad-format" | "bad-argument" | "bad-version" | "newer-version" | "bad-entry" | "bad-signature" | "bad-invite" | "wrong-room" | "incomplete" | "bad-grant"
        | "chain-break" | "log-behind" | "log-fork" => 400,
        "unauthorised" | "bad-challenge" => 401,
        "forbidden" | "not-member" | "removed-sender" | "wrong-sender" => 403,
        "not-found" | "no-room" => 404,
        "replay" | "gap" | "equivocation" | "room-exists" | "invite-used" | "instance-conflict" | "wrong-epoch" | "lease-lost" | "stale-grant" | "stale-session-key" => 409,
        "invite-burned" | "invite-expired" => 410,
        "too-large" => 413,
        "too-many" | "rate-limited" => 429,
        "internal" => 500,
        _ => return None,
    })
}

/// (status, body, retry-after) for a refusal; None: cut the connection.
pub fn answer(f: &Fail, log: &dyn Fn(&str), what: &str) -> Option<(u16, Value, Option<u64>)> {
    match &f.kind {
        Kind::Destroy => None,
        Kind::Reply(s, body) => Some((*s, body.clone(), f.retry_after)),
        Kind::Z | Kind::Hub => match status_of(&f.code) {
            Some(s) => {
                let mut b = json!({ "error": f.code, "message": f.message });
                let o = b.as_object_mut().unwrap();
                if let Some(n) = f.voided {
                    o.insert("voided".into(), json!(true));
                    o.insert("envelope_number".into(), json!(n));
                }
                if let Some(es) = &f.signed_entries {
                    o.insert("signed_entries".into(), json!(es.iter().map(|e| zcrypto::b64u(e)).collect::<Vec<_>>()));
                }
                Some((s, b, f.retry_after))
            }
            None if matches!(f.kind, Kind::Z) => Some((400, json!({ "error": f.code, "message": f.message }), None)),
            None => {
                log(&format!("internal error on {what}: {}: {}", f.code, f.message));
                Some((500, json!({ "error": "internal", "message": "internal error" }), None))
            }
        },
        Kind::Internal => {
            log(&format!("internal error on {what}: {}", f.message));
            Some((500, json!({ "error": "internal", "message": "internal error" }), None))
        }
    }
}

/// fail('code', 'message') as in server.mjs.
pub fn fail<T>(code: &str, message: &str) -> HResult<T> { Err(Fail::hub(code, message)) }
