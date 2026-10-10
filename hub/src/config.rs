//! Configuration by environment. Every limit of spec/v2.md section 16 has its default here; a variable that is
//! unset, empty or not a number means the default.

use std::collections::HashMap;
use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Founding {
    Open,
    Token,
    Closed,
}

#[derive(Debug, Clone)]
pub struct Config {
    pub host: String,
    pub port: u16,
    pub data: PathBuf,
    /// the hub's canonical address (v1 §8.1); what a device signs in `HubAuth`
    pub url: String,
    pub commit: String,
    pub origins: Vec<String>,
    pub trust_proxy_header: bool,
    pub min_client: Option<String>,
    /// when set, `POST /v2/rooms` needs it in `x-found-token`
    pub found_token: Option<String>,
    /// who may found a room: `open` (anyone, within the limits), `token` (whoever brings `HUB_FOUND_TOKEN`),
    /// `closed` (nobody)
    pub founding: Founding,
    /// The admin page (`admin.rs`): served on 127.0.0.1 at `admin_port`, only if this hash is set
    /// (`HUB_ADMIN_PASSWORD_HASH`, Argon2id in PHC text form; `trommi-hub admin-hash` makes one).
    pub admin_password_hash: Option<String>,
    pub admin_port: u16,
    /// 127.0.0.1 unless said otherwise. In a container the loopback is the container's own: there it is set to
    /// 0.0.0.0 and the port is published to the host's loopback only (`-p 127.0.0.1:8791:8791`).
    pub admin_host: String,
    /// `strict-transport-security` on every answer, two years with subdomains and `preload` (`HUB_HSTS=on`).
    /// Off unless switched on: it binds the whole domain to HTTPS in every browser that saw it.
    pub hsts: bool,
    /// whether failed logins slow their source down (`throttle.rs`); `off` leaves the per-address limit only
    pub login_throttle: bool,
    pub test_control: bool,
    /// with test control: every piece of expensive work takes this much longer
    pub test_heavy_ms: u64,
    /// the pool for expensive work (verifying Commits, slow hashes): workers, and how many may wait
    pub heavy_workers: usize,
    pub heavy_waiting: usize,
    /// requests worked on at a time; more are told to come back
    pub admitted: usize,
    pub admitted_per_address: usize,
    pub quiet: bool,

    pub json_limit: usize,
    pub commit_limit: usize,
    pub message_limit: usize,
    pub file_limit: u64,
    pub room_quota: u64,
    pub envelopes_per_second: f64,
    pub envelope_burst: f64,
    pub pieces_per_second: f64,
    /// expensive requests of one device: a second, and at once
    pub heavy_per_second: f64,
    pub heavy_burst: f64,
    pub epoch_envelopes: u64,
    pub streams_per_device: usize,
    pub open_requests_per_ip_minute: f64,
    pub foundings_per_ip_hour: usize,
    pub logins_per_ip_10min: usize,
    pub max_rooms: u64,
    pub humans: usize,
    pub agents: usize,
    pub helpers_per_main: usize,
    pub key_packages: usize,
    pub key_package_days: u64,
    pub open_invites: usize,
    pub share_days: u64,
    pub retention_days: u64,
    pub push_subscriptions_per_device: usize,
    pub shares_per_room: i64,
    pub passkeys: i64,
    pub quotas: crate::quota::Quotas,

    pub body_timeout_ms: u64,
    pub ping_ms: u64,
    pub retention_every_ms: u64,
    pub sweep_every_ms: u64,
    pub live_ms: u64,
    pub live_beat_ms: u64,
    pub loss_ms: u64,
    pub lease_watch_ms: u64,
    pub stream_buffer_bytes: usize,

    pub push_subject: String,
    pub push_hosts: Vec<String>,
    pub apns_key_pem: Option<String>,
    pub apns_key_id: Option<String>,
    pub apns_team_id: Option<String>,
    pub apns_topics: Vec<String>,
    pub apns_hosts: HashMap<String, String>,
}

fn number<T: std::str::FromStr>(env: &HashMap<String, String>, name: &str, default: T) -> T {
    env.get(name)
        .filter(|v| !v.is_empty())
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

/// A PEM key as a secret store hands it over: with its line breaks, with `\n` written out, or with spaces where
/// the line breaks were. The PEM is built again from the base64 body between its two marker lines.
pub fn pem(given: &str) -> String {
    let text = given.replace("\\n", "\n");
    let mut label = "PRIVATE KEY".to_string();
    let mut body = String::new();
    // the markers go, whatever stands between their dashes; what is left is the body
    let mut rest = text.as_str();
    while let Some(start) = rest.find("-----") {
        body.push_str(&rest[..start]);
        let after = &rest[start + 5..];
        let Some(end) = after.find("-----") else {
            rest = after;
            break;
        };
        if let Some(name) = after[..end].strip_prefix("BEGIN ") {
            label = name.trim().to_string();
        }
        rest = &after[end + 5..];
    }
    body.push_str(rest);
    let body: String = body.chars().filter(|c| !c.is_whitespace()).collect();
    let lines: Vec<&str> = body
        .as_bytes()
        .chunks(64)
        .map(|l| std::str::from_utf8(l).unwrap_or(""))
        .collect();
    format!(
        "-----BEGIN {label}-----\n{}\n-----END {label}-----\n",
        lines.join("\n")
    )
}

fn list(env: &HashMap<String, String>, name: &str) -> Vec<String> {
    env.get(name)
        .map(|v| {
            v.split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// v1 §8.1: `https://` + lowercase host [+ `:port`]; `http://` only for localhost and 127.0.0.1. Anything else is
/// refused, never normalised.
pub fn canonical_address(url: &str) -> bool {
    let (rest, local_only) = match (url.strip_prefix("https://"), url.strip_prefix("http://")) {
        (Some(r), _) => (r, false),
        (_, Some(r)) => (r, true),
        _ => return false,
    };
    let (host, port) = match rest.rsplit_once(':') {
        Some((h, p)) => (h, Some(p)),
        None => (rest, None),
    };
    if let Some(p) = port {
        let ok = !p.is_empty()
            && p.len() <= 5
            && p.bytes().all(|b| b.is_ascii_digit())
            && !p.starts_with('0');
        if !ok {
            return false;
        }
    }
    if local_only {
        return host == "localhost" || host == "127.0.0.1";
    }
    !host.is_empty()
        && host.split('.').all(|label| {
            !label.is_empty()
                && label
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
                && !label.starts_with('-')
                && !label.ends_with('-')
        })
}

impl Config {
    pub fn from_env() -> Self {
        Self::from_map(&std::env::vars().collect())
    }

    pub fn from_map(env: &HashMap<String, String>) -> Self {
        let text = |name: &str, default: &str| {
            env.get(name)
                .filter(|v| !v.is_empty())
                .cloned()
                .unwrap_or_else(|| default.to_string())
        };
        let optional = |name: &str| env.get(name).filter(|v| !v.is_empty()).cloned();
        let apns_key_pem = optional("APPLE_APNS_KEY")
            .or_else(|| {
                optional("APPLE_APNS_KEY_FILE").and_then(|f| std::fs::read_to_string(f).ok())
            })
            .map(|k| pem(&k));
        let apns_hosts = optional("HUB_APNS_HOSTS")
            .and_then(|j| serde_json::from_str::<HashMap<String, String>>(&j).ok())
            .unwrap_or_else(|| {
                HashMap::from([
                    (
                        "production".to_string(),
                        "https://api.push.apple.com".to_string(),
                    ),
                    (
                        "sandbox".to_string(),
                        "https://api.sandbox.push.apple.com".to_string(),
                    ),
                ])
            });
        let port = number(env, "HUB_PORT", 8790u16);
        Config {
            host: text("HUB_HOST", "0.0.0.0"),
            port,
            data: PathBuf::from(text("HUB_DATA", "/data")),
            url: text("HUB_URL", &format!("http://127.0.0.1:{port}")),
            commit: text("COMMIT", "dev"),
            origins: list(env, "HUB_ORIGINS"),
            trust_proxy_header: env.get("HUB_TRUST_CF").is_some_and(|v| v == "1"),
            min_client: optional("HUB_MIN_CLIENT"),
            found_token: optional("HUB_FOUND_TOKEN"),
            founding: match (
                text("HUB_FOUNDING", "").as_str(),
                optional("HUB_FOUND_TOKEN").is_some(),
            ) {
                ("closed", _) => Founding::Closed,
                ("token", _) | ("", true) => Founding::Token,
                _ => Founding::Open,
            },
            login_throttle: text("HUB_LOGIN_THROTTLE", "on") != "off",
            hsts: text("HUB_HSTS", "off") == "on",
            admin_password_hash: optional("HUB_ADMIN_PASSWORD_HASH"),
            admin_port: number(env, "HUB_ADMIN_PORT", 8791u16),
            admin_host: text("HUB_ADMIN_HOST", "127.0.0.1"),
            test_control: env.get("HUB_TEST_CONTROL").is_some_and(|v| v == "1"),
            quiet: env.get("HUB_QUIET").is_some_and(|v| v == "1"),
            test_heavy_ms: number(env, "HUB_TEST_HEAVY_MS", 0),
            heavy_workers: number(
                env,
                "HUB_HEAVY_WORKERS",
                std::thread::available_parallelism().map_or(2, |n| n.get()),
            ),
            heavy_waiting: number(env, "HUB_HEAVY_WAITING", 64),
            admitted: number(env, "HUB_ADMITTED", 256),
            admitted_per_address: number(env, "HUB_ADMITTED_PER_ADDRESS", 32),

            json_limit: number(env, "HUB_LIMIT_JSON", 3 << 19),
            commit_limit: number(env, "HUB_LIMIT_COMMIT", 1 << 20),
            message_limit: number(env, "HUB_LIMIT_MESSAGE", 48 << 10),
            file_limit: number(env, "HUB_LIMIT_FILE", 67_125_269),
            room_quota: number(env, "HUB_ROOM_QUOTA", 1 << 30),
            envelopes_per_second: number(env, "HUB_LIMIT_ENVELOPES_PER_SECOND", 50.0),
            envelope_burst: number(env, "HUB_LIMIT_ENVELOPE_BURST", 200.0),
            pieces_per_second: number(env, "HUB_LIMIT_PIECES_PER_SECOND", 20.0),
            heavy_per_second: number(env, "HUB_LIMIT_HEAVY_PER_SECOND", 10.0),
            heavy_burst: number(env, "HUB_LIMIT_HEAVY_BURST", 60.0),
            epoch_envelopes: number(env, "HUB_LIMIT_EPOCH_ENVELOPES", 1 << 24),
            streams_per_device: number(env, "HUB_LIMIT_STREAMS_PER_DEVICE", 8),
            open_requests_per_ip_minute: number(
                env,
                "HUB_LIMIT_OPEN_REQUESTS_PER_IP_MINUTE",
                600.0,
            ),
            foundings_per_ip_hour: number(env, "HUB_LIMIT_FOUND_PER_IP_HOUR", 10),
            logins_per_ip_10min: number(env, "HUB_LIMIT_LOGINS_PER_IP_10MIN", 30),
            max_rooms: number(env, "HUB_MAX_ROOMS", 1000),
            humans: number(env, "HUB_LIMIT_HUMANS", 1000),
            agents: number(env, "HUB_LIMIT_AGENTS", 256),
            helpers_per_main: number(env, "HUB_LIMIT_HELPERS_PER_MAIN", 32),
            key_packages: number(env, "HUB_LIMIT_KEY_PACKAGES", 100),
            key_package_days: 90,
            open_invites: number(env, "HUB_LIMIT_OPEN_INVITES", 16),
            share_days: number(env, "HUB_LIMIT_SHARE_DAYS", 180),
            retention_days: number(env, "HUB_LIMIT_RETENTION_DAYS", 30),
            push_subscriptions_per_device: number(
                env,
                "HUB_LIMIT_PUSH_SUBSCRIPTIONS_PER_DEVICE",
                10,
            ),
            shares_per_room: number(env, "HUB_LIMIT_SHARES_PER_ROOM", 1000),
            passkeys: number(env, "HUB_LIMIT_PASSKEYS", 20),
            quotas: crate::quota::Quotas {
                files: number(env, "HUB_QUOTA_FILES", crate::quota::FILES),
                registers: number(env, "HUB_QUOTA_REGISTERS", crate::quota::REGISTERS),
                voids: number(env, "HUB_QUOTA_VOIDS", crate::quota::VOIDS),
                groups: number(env, "HUB_QUOTA_GROUPS", crate::quota::GROUPS),
                helper_devices: number(
                    env,
                    "HUB_QUOTA_HELPER_DEVICES",
                    crate::quota::HELPER_DEVICES,
                ),
                devices: number(env, "HUB_QUOTA_DEVICES", crate::quota::DEVICES),
            },

            body_timeout_ms: number(env, "HUB_BODY_TIMEOUT_MS", 15_000),
            ping_ms: number(env, "HUB_PING_MS", 25_000),
            retention_every_ms: number(env, "HUB_RETENTION_EVERY_MS", 86_400_000),
            sweep_every_ms: number(env, "HUB_SWEEP_EVERY_MS", 600_000),
            live_ms: number(env, "HUB_LIVE_MS", 2_000),
            live_beat_ms: number(env, "HUB_LIVE_BEAT_MS", 600_000),
            loss_ms: number(env, "HUB_LOSS_MS", 60_000),
            lease_watch_ms: number(env, "HUB_LEASE_WATCH_MS", 5_000),
            stream_buffer_bytes: number(env, "HUB_STREAM_BUFFER_BYTES", 4 << 20),

            push_subject: text("HUB_WEB_PUSH_SUBJECT", "https://trommi.com"),
            push_hosts: list(env, "HUB_PUSH_HOSTS"),
            apns_key_pem,
            apns_key_id: optional("APPLE_APNS_KEY_ID"),
            apns_team_id: optional("APPLE_TEAM_ID"),
            apns_topics: list(env, "APPLE_APNS_TOPIC"),
            apns_hosts,
        }
    }
}
