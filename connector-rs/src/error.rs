//! One error type for everything, shaped like zcrypto.mjs's ZError: a stable machine-readable `code`, a message for
//! humans, and (for refusals of the hub) the HTTP status, the body and retry-after. A plain error (the bridge's
//! `new Error(text)`) has an empty code and shows only its message.
use serde_json::Value;
use std::fmt;

#[derive(Clone, Debug, Default)]
pub struct ZError {
    pub code: String,
    pub message: String,
    pub status: Option<u16>,
    pub retry_after: Option<u64>,
    pub body: Option<Value>,
    /// Extra fields of the JS error (`{ logSeq }`, `{ keyScope, sessionId, epoch }`, `{ replaced }`, ...).
    pub extra: serde_json::Map<String, Value>,
}

impl ZError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        ZError { code: code.into(), message: message.into(), ..Default::default() }
    }
    /// An error without a code: the message is all there is (JS `new Error(text)`).
    pub fn plain(message: impl Into<String>) -> Self {
        ZError { code: String::new(), message: message.into(), ..Default::default() }
    }
    pub fn with(mut self, key: &str, v: impl Into<Value>) -> Self {
        self.extra.insert(key.to_string(), v.into());
        self
    }
    pub fn status(mut self, s: u16) -> Self {
        self.status = Some(s);
        self
    }
    pub fn is(&self, code: &str) -> bool {
        self.code == code
    }
    /// The text JS shows as `err.message`: `code: message`, or the code alone, or the message of a plain error.
    pub fn text(&self) -> String {
        if self.code.is_empty() {
            self.message.clone()
        } else if self.message.is_empty() {
            self.code.clone()
        } else {
            format!("{}: {}", self.code, self.message)
        }
    }
    pub fn extra_u64(&self, k: &str) -> Option<u64> {
        self.extra.get(k).and_then(|v| v.as_u64())
    }
}

impl fmt::Display for ZError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.text())
    }
}
impl std::error::Error for ZError {}

pub type Result<T> = std::result::Result<T, ZError>;

/// `fail(code, message)` as in zcrypto.mjs.
pub fn fail<T>(code: &str, message: impl Into<String>) -> Result<T> {
    Err(ZError::new(code, message))
}

impl From<std::io::Error> for ZError {
    fn from(e: std::io::Error) -> Self {
        let code = match e.kind() {
            std::io::ErrorKind::NotFound => "ENOENT",
            std::io::ErrorKind::PermissionDenied => "EACCES",
            _ => "io",
        };
        ZError::new(code, e.to_string())
    }
}
impl From<serde_json::Error> for ZError {
    fn from(e: serde_json::Error) -> Self {
        ZError::new("bad-format", e.to_string())
    }
}
