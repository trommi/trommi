//! One error type for the connector: a stable machine-readable `code` (the protocol's codes of spec/v2.md section
//! 16 where the core or the hub refused, a few of the connector's own otherwise), a message for humans, and for a
//! refusal of the hub its HTTP status and retry-after. A plain error has an empty code and shows only its message.
//! A message never holds a key or content.
use serde_json::Value;
use std::fmt;

/// What went wrong.
#[derive(Clone, Debug, Default)]
pub struct Fault {
    /// The stable code; empty for a plain error.
    pub code: String,
    /// The text for a human.
    pub message: String,
    /// The HTTP status of a refusal of the hub.
    pub status: Option<u16>,
    /// How long the hub asked to wait, in seconds.
    pub retry_after: Option<u64>,
    /// Extra fields a caller reads (`replaced`, `voided`).
    pub extra: serde_json::Map<String, Value>,
}

impl Fault {
    /// An error with a code.
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Fault {
            code: code.into(),
            message: message.into(),
            ..Default::default()
        }
    }

    /// An error without a code: the message is all there is.
    pub fn plain(message: impl Into<String>) -> Self {
        Fault {
            message: message.into(),
            ..Default::default()
        }
    }

    /// The same error with one extra field.
    pub fn with(mut self, key: &str, value: impl Into<Value>) -> Self {
        self.extra.insert(key.to_string(), value.into());
        self
    }

    /// The same error with the HTTP status it came with.
    pub fn status(mut self, status: u16) -> Self {
        self.status = Some(status);
        self
    }

    /// Whether it carries this code.
    pub fn is(&self, code: &str) -> bool {
        self.code == code
    }

    /// `code: message`, or the code alone, or the message of a plain error.
    pub fn text(&self) -> String {
        if self.code.is_empty() {
            self.message.clone()
        } else if self.message.is_empty() {
            self.code.clone()
        } else {
            format!("{}: {}", self.code, self.message)
        }
    }

    /// The core's error this fault stands for, if its code is one of the protocol's.
    pub fn as_core(&self) -> Option<trommi_core::Error> {
        trommi_core::Error::from_code(&self.code)
    }
}

impl fmt::Display for Fault {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.text())
    }
}

impl std::error::Error for Fault {}

/// The connector's result.
pub type Result<T> = std::result::Result<T, Fault>;

impl From<std::io::Error> for Fault {
    fn from(error: std::io::Error) -> Self {
        let code = match error.kind() {
            std::io::ErrorKind::NotFound => "ENOENT",
            std::io::ErrorKind::PermissionDenied => "EACCES",
            _ => "io",
        };
        Fault::new(code, error.to_string())
    }
}

impl From<serde_json::Error> for Fault {
    fn from(error: serde_json::Error) -> Self {
        Fault::new("bad-format", error.to_string())
    }
}

impl From<trommi_core::Error> for Fault {
    /// A refusal of the core, under its stable code. The core's texts hold no key and no content.
    fn from(error: trommi_core::Error) -> Self {
        let detail = match &error {
            trommi_core::Error::Internal(place) => (*place).to_string(),
            trommi_core::Error::Storage(text) => text.clone(),
            _ => String::new(),
        };
        Fault::new(error.code(), detail)
    }
}
