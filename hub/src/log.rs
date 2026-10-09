//! Structured log lines: one JSON object per line on stdout. Callers pass ids cut short (`util::short`) and
//! counts; never a token, a body, an e-mail address, a push endpoint or a full id.

use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::{json, Value};

static QUIET: AtomicBool = AtomicBool::new(false);

pub fn set_quiet(quiet: bool) {
    QUIET.store(quiet, Ordering::Relaxed);
}

pub fn line(level: &str, event: &str, fields: Value) {
    if QUIET.load(Ordering::Relaxed) {
        return;
    }
    let mut out = json!({ "at": crate::util::now(), "level": level, "event": event });
    if let (Value::Object(f), Value::Object(o)) = (fields, &mut out) {
        for (k, v) in f {
            o.insert(k, v);
        }
    }
    println!("{out}");
}

pub fn info(event: &str, fields: Value) {
    line("info", event, fields);
}

pub fn warn(event: &str, fields: Value) {
    line("warn", event, fields);
}
