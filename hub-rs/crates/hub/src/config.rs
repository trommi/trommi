//! The hub's configuration: the same environment variables as hub/server.mjs and hub/ops (README), plus a few
//! knobs the Node tests pass to startHub() as options, here as HUB_* variables (README of hub-rs).

use std::collections::HashMap;

#[derive(Clone, Debug)]
pub struct Limits {
    pub json: f64,
    pub ciphertext: f64,
    pub attachment: f64,
    pub found_per_ip_hour: f64,
    pub envelopes_per_second: f64,
    pub envelope_burst: f64,
    pub streams_per_device: f64,
    pub open_requests_per_ip_minute: f64,
    pub push_subscriptions_per_device: f64,
    pub retention_days: f64,
}

#[derive(Clone, Debug)]
pub struct Config {
    pub env: HashMap<String, String>,
    pub port: u16,
    pub host: String,
    pub data_dir: String,
    pub hub_url: Option<String>,
    pub commit: String,
    pub origins: Vec<String>,
    pub dev_origins: bool,
    pub found_token: String,
    pub max_rooms: i64,
    pub trust_cf: bool,
    pub app_url: String,
    pub loss_ms: u64,
    pub live_ms: u64,
    pub ping_ms: u64,
    pub retention_every_ms: u64,
    pub stream_cap_every_ms: u64,
    pub body_timeout_ms: u64,
    pub limits: Limits,
    pub write_queue: f64,
    pub write_queue_membership: f64,
    pub write_per_ip: f64,
    pub stream_buffer_bytes: f64,
    pub stream_buffer_total_bytes: f64,
    pub wal_truncate_bytes: f64,
    pub quota_bytes: f64,
    pub test_control: bool,
    pub quiet: bool,
}

/// envNumber: a non-negative finite number from env[name], else the fallback.
pub fn env_number(env: &HashMap<String, String>, name: &str, fallback: f64) -> f64 {
    match env.get(name) {
        None => fallback,
        Some(v) if v.is_empty() => fallback,
        Some(v) => match crate::util::js_number_int(v) {
            Some(n) if n.is_finite() && n >= 0.0 => n,
            _ => fallback,
        },
    }
}

impl Config {
    pub fn from_env() -> Config { Config::from_map(std::env::vars().collect()) }
    pub fn from_map(env: HashMap<String, String>) -> Config {
        let get = |k: &str| env.get(k).cloned().unwrap_or_default();
        let lim = |k: &str, d: f64| env_number(&env, &format!("HUB_LIMIT_{k}"), d);
        let origins = format!("{},{}", get("HUB_ORIGINS"), get("HUB_PREVIEW_ORIGINS")).split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
        let num = |k: &str, d: f64| -> f64 { env.get(k).filter(|v| !v.is_empty()).and_then(|v| v.trim().parse::<f64>().ok()).unwrap_or(d) };
        Config {
            port: num("HUB_PORT", 8790.0) as u16,
            host: env.get("HUB_HOST").filter(|v| !v.is_empty()).cloned().unwrap_or_else(|| "0.0.0.0".into()),
            data_dir: env.get("HUB_DATA").filter(|v| !v.is_empty()).cloned().unwrap_or_else(|| "/data".into()),
            hub_url: env.get("HUB_URL").filter(|v| !v.is_empty()).cloned(),
            commit: env.get("COMMIT").filter(|v| !v.is_empty()).cloned().unwrap_or_else(|| "dev".into()),
            origins,
            dev_origins: get("NODE_ENV") != "production",
            found_token: get("HUB_FOUND_TOKEN"),
            max_rooms: num("HUB_MAX_ROOMS", 1000.0) as i64,
            trust_cf: get("HUB_TRUST_CF") == "1",
            app_url: env.get("HUB_APP_URL").filter(|v| !v.is_empty()).cloned().unwrap_or_else(|| "https://app.trommi.com".into()),
            loss_ms: num("HUB_LOSS_MS", 60000.0) as u64,
            live_ms: num("HUB_LIVE_MS", 2000.0) as u64,
            ping_ms: num("HUB_PING_MS", 25000.0) as u64,
            retention_every_ms: num("HUB_RETENTION_EVERY_MS", 86400000.0) as u64,
            stream_cap_every_ms: num("HUB_STREAM_CAP_EVERY_MS", 1000.0) as u64,
            body_timeout_ms: num("HUB_BODY_TIMEOUT_MS", 15000.0) as u64,
            limits: Limits {
                json: lim("JSON", (1 << 20) as f64),
                ciphertext: lim("CIPHERTEXT", 65536.0 + 16.0),
                attachment: lim("ATTACHMENT", (64u64 << 20) as f64),
                found_per_ip_hour: lim("FOUND_PER_IP_HOUR", 10.0),
                envelopes_per_second: lim("ENVELOPES_PER_SECOND", 50.0),
                envelope_burst: lim("ENVELOPE_BURST", 200.0),
                streams_per_device: lim("STREAMS_PER_DEVICE", 8.0),
                open_requests_per_ip_minute: lim("OPEN_REQUESTS_PER_IP_MINUTE", 600.0),
                push_subscriptions_per_device: lim("PUSH_SUBSCRIPTIONS_PER_DEVICE", 10.0),
                retention_days: lim("RETENTION_DAYS", 30.0),
            },
            write_queue: env_number(&env, "HUB_WRITE_QUEUE", 512.0),
            write_queue_membership: env_number(&env, "HUB_WRITE_QUEUE_MEMBERSHIP", 32.0),
            write_per_ip: env_number(&env, "HUB_WRITE_PER_IP", 16.0),
            stream_buffer_bytes: env_number(&env, "HUB_STREAM_BUFFER_BYTES", (4u64 << 20) as f64),
            stream_buffer_total_bytes: num("HUB_STREAM_BUFFER_TOTAL_BYTES", (256u64 << 20) as f64),
            wal_truncate_bytes: env_number(&env, "HUB_WAL_TRUNCATE_BYTES", (64u64 << 20) as f64),
            quota_bytes: env_number(&env, "ROOM_ATTACHMENT_QUOTA_BYTES", (1u64 << 30) as f64),
            test_control: get("HUB_TEST_CONTROL") == "1",
            quiet: get("HUB_QUIET") == "1",
            env,
        }
    }
    pub fn get(&self, k: &str) -> Option<&str> { self.env.get(k).map(|s| s.as_str()).filter(|s| !s.is_empty()) }
}
