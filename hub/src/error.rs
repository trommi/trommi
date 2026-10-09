//! Refusals: the stable codes of spec/v2.md section 16 and their statuses.

use serde_json::{json, Value};

#[derive(Debug, Clone, PartialEq)]
pub struct Refused {
    pub code: &'static str,
    pub message: String,
    /// further members of the answer, e.g. `voided: true` or `current` epoch
    pub extra: Option<Value>,
    pub retry_after: Option<u64>,
}

pub type Res<T> = Result<T, Refused>;

pub fn refuse(code: &'static str, message: impl Into<String>) -> Refused {
    Refused {
        code,
        message: message.into(),
        extra: None,
        retry_after: None,
    }
}

pub fn status_of(code: &str) -> u16 {
    match code {
        "bad-format" | "newer-version" | "bad-commit" | "bad-signature" | "bad-invite"
        | "bad-key-package" | "wrong-room" | "incomplete" | "chain-break" | "bad-email"
        | "bad-passkey" => 400,
        "unauthorised" | "bad-challenge" | "wrong-login" | "wrong-recovery" => 401,
        "forbidden" | "not-member" | "removed-sender" | "wrong-sender" => 403,
        "not-found" | "no-room" => 404,
        "method-not-allowed" => 405,
        "gone" | "invite-expired" | "invite-burned" => 410,
        "epoch-taken" | "wrong-epoch" | "room-behind" | "group-behind" | "stale-session"
        | "epoch-full" | "replay" | "gap" | "equivocation" | "room-exists" | "invite-used"
        | "lease-lost" | "account-exists" | "last-way-in" | "account-changed" => 409,
        "too-large" | "quota-exceeded" => 413,
        "range" => 416,
        "client-too-old" => 426,
        "too-many" | "rate-limited" => 429,
        "overloaded" => 503,
        _ => 500,
    }
}

impl Refused {
    pub fn with(mut self, extra: Value) -> Self {
        self.extra = Some(extra);
        self
    }
    pub fn retry(mut self, seconds: u64) -> Self {
        self.retry_after = Some(seconds.max(1));
        self
    }
    pub fn status(&self) -> u16 {
        status_of(self.code)
    }
    pub fn body(&self) -> Value {
        let mut v = json!({ "error": self.code, "message": self.message });
        if let (Some(Value::Object(extra)), Value::Object(out)) = (&self.extra, &mut v) {
            for (k, x) in extra {
                out.insert(k.clone(), x.clone());
            }
        }
        v
    }
}

impl From<rusqlite::Error> for Refused {
    fn from(e: rusqlite::Error) -> Self {
        // The text of a database error never reaches a client: it is logged here, the answer is generic.
        crate::log::warn(
            "database_error",
            serde_json::json!({ "error": e.to_string() }),
        );
        Refused {
            code: "internal",
            message: "internal error".into(),
            extra: None,
            retry_after: None,
        }
    }
}

impl From<crate::observer::Refusal> for Refused {
    fn from(r: crate::observer::Refusal) -> Self {
        use crate::observer::Refusal::*;
        match r {
            BadCommit(m) => refuse("bad-commit", m),
            BadKeyPackage(m) => refuse("bad-key-package", m),
            BadFormat(m) => refuse("bad-format", m),
            Busy => refuse(
                "overloaded",
                "the state changed under this request: try again",
            )
            .retry(1),
        }
    }
}

impl From<crate::wire::Malformed> for Refused {
    fn from(m: crate::wire::Malformed) -> Self {
        refuse("bad-format", m.0)
    }
}
