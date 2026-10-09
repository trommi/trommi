//! Configuration by environment. Every limit of spec/v2.md section 16 has its default here; a variable that is
//! unset, empty or not a number means the default.

use std::collections::HashMap;
use std::path::PathBuf;

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
    pub test_control: bool,
    pub quiet: bool,

    pub json_limit: usize,
    pub commit_limit: usize,
    pub message_limit: usize,
    pub file_limit: u64,
    pub room_quota: u64,
    pub envelopes_per_second: f64,
    pub envelope_burst: f64,
    pub pieces_per_second: f64,
    pub epoch_envelopes: u64,
    pub streams_per_device: usize,
    pub open_requests_per_ip_minute: f64,
    pub foundings_per_ip_hour: usize,
    pub logins_per_ip_10min: usize,
    pub login_failures_per_email_hour: usize,
    pub max_rooms: u64,
    pub humans: usize,
    pub agents: usize,
    pub helpers_per_main: usize,
    pub helper_devices: usize,
    pub key_packages: usize,
    pub key_package_days: u64,
    pub open_invites: usize,
    pub share_days: u64,
    pub retention_days: u64,
    pub push_subscriptions_per_device: usize,

    pub body_timeout_ms: u64,
    pub ping_ms: u64,
    pub retention_every_ms: u64,
    pub sweep_every_ms: u64,
    pub live_ms: u64,
    pub live_beat_ms: u64,
    pub loss_ms: u64,
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
        let apns_key_pem = optional("APNS_KEY")
            .map(|k| k.replace("\\n", "\n"))
            .or_else(|| optional("APNS_KEY_FILE").and_then(|f| std::fs::read_to_string(f).ok()));
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
            test_control: env.get("HUB_TEST_CONTROL").is_some_and(|v| v == "1"),
            quiet: env.get("HUB_QUIET").is_some_and(|v| v == "1"),

            json_limit: number(env, "HUB_LIMIT_JSON", 1 << 20),
            commit_limit: number(env, "HUB_LIMIT_COMMIT", 1 << 20),
            message_limit: number(env, "HUB_LIMIT_MESSAGE", 48 << 10),
            file_limit: number(env, "HUB_LIMIT_FILE", 64 << 20),
            room_quota: number(env, "HUB_ROOM_QUOTA", 1 << 30),
            envelopes_per_second: number(env, "HUB_LIMIT_ENVELOPES_PER_SECOND", 50.0),
            envelope_burst: number(env, "HUB_LIMIT_ENVELOPE_BURST", 200.0),
            pieces_per_second: number(env, "HUB_LIMIT_PIECES_PER_SECOND", 20.0),
            epoch_envelopes: number(env, "HUB_LIMIT_EPOCH_ENVELOPES", 1 << 24),
            streams_per_device: number(env, "HUB_LIMIT_STREAMS_PER_DEVICE", 8),
            open_requests_per_ip_minute: number(
                env,
                "HUB_LIMIT_OPEN_REQUESTS_PER_IP_MINUTE",
                600.0,
            ),
            foundings_per_ip_hour: number(env, "HUB_LIMIT_FOUND_PER_IP_HOUR", 10),
            logins_per_ip_10min: number(env, "HUB_LIMIT_LOGINS_PER_IP_10MIN", 30),
            login_failures_per_email_hour: number(
                env,
                "HUB_LIMIT_LOGIN_FAILURES_PER_EMAIL_HOUR",
                10,
            ),
            max_rooms: number(env, "HUB_MAX_ROOMS", 1000),
            humans: 32,
            agents: 256,
            helpers_per_main: 32,
            helper_devices: 7,
            key_packages: 100,
            key_package_days: 90,
            open_invites: 16,
            share_days: number(env, "HUB_LIMIT_SHARE_DAYS", 180),
            retention_days: number(env, "HUB_LIMIT_RETENTION_DAYS", 30),
            push_subscriptions_per_device: 10,

            body_timeout_ms: number(env, "HUB_BODY_TIMEOUT_MS", 15_000),
            ping_ms: number(env, "HUB_PING_MS", 25_000),
            retention_every_ms: number(env, "HUB_RETENTION_EVERY_MS", 86_400_000),
            sweep_every_ms: number(env, "HUB_SWEEP_EVERY_MS", 600_000),
            live_ms: number(env, "HUB_LIVE_MS", 2_000),
            live_beat_ms: number(env, "HUB_LIVE_BEAT_MS", 600_000),
            loss_ms: number(env, "HUB_LOSS_MS", 60_000),
            stream_buffer_bytes: number(env, "HUB_STREAM_BUFFER_BYTES", 4 << 20),

            push_subject: text("HUB_PUSH_SUBJECT", "https://trommi.com"),
            push_hosts: list(env, "HUB_PUSH_HOSTS"),
            apns_key_pem,
            apns_key_id: optional("APNS_KEY_ID"),
            apns_team_id: optional("APNS_TEAM_ID"),
            apns_topics: list(env, "APNS_TOPIC"),
            apns_hosts,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_canonical_hub_addresses_pass() {
        for good in [
            "https://hub.trommi.com",
            "https://hub.example.org:8443",
            "http://localhost:8790",
            "http://127.0.0.1",
        ] {
            assert!(canonical_address(good), "{good}");
        }
        for bad in [
            "https://Hub.trommi.com",
            "https://hub.trommi.com/",
            "http://hub.trommi.com",
            "https://hub.trommi.com:0443",
            "https://hub..com",
            "https://-a.com",
            "ftp://x",
            "https://",
            "https://hub.trommi.com:",
        ] {
            assert!(!canonical_address(bad), "{bad}");
        }
    }

    #[test]
    fn empty_or_broken_numbers_mean_the_default() {
        let env = HashMap::from([
            ("HUB_LIMIT_JSON".to_string(), "".to_string()),
            ("HUB_PORT".to_string(), "x".to_string()),
        ]);
        let c = Config::from_map(&env);
        assert_eq!(
            (c.json_limit, c.port, c.share_days, c.retention_days),
            (1 << 20, 8790, 180, 30)
        );
    }
}
