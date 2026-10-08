//! Web Push (hub/push.mjs: RFC 8291 aes128gcm, RFC 8292 VAPID) and APNs (hub/apns.mjs: HTTP/2, ES256 provider token).
//! The payload is { room_id, envelope_number, urgency } or the agent-lost word, and nothing else.

use crate::config::Config;
use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes128Gcm, Aes256Gcm, Nonce};
use p256::ecdsa::{signature::Signer, Signature, SigningKey};
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::pkcs8::{DecodePrivateKey, EncodePrivateKey, LineEnding};
use p256::{PublicKey, SecretKey};
use parking_lot::Mutex;
use serde_json::{json, Value};
use sha2::Sha256;
use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;
use zcrypto::b64u;

/// Node's Buffer.from(x, 'base64url'): lenient (both alphabets, padding and junk ignored).
pub fn b64_lenient(s: &str) -> Vec<u8> {
    let mut acc: u32 = 0;
    let mut bits = 0;
    let mut out = vec![];
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'-' | b'+' => 62,
            b'_' | b'/' => 63,
            b'=' => break,
            _ => continue,
        };
        acc = (acc << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
        acc &= (1 << bits) - 1;
    }
    out
}

fn hkdf(salt: &[u8], ikm: &[u8], info: &[u8], len: usize) -> Vec<u8> {
    let hk = hkdf::Hkdf::<Sha256>::new(Some(salt), ikm);
    let mut out = vec![0u8; len];
    hk.expand(info, &mut out).unwrap();
    out
}

/// RFC 8291: the message encrypted for one browser (one record, padded to 128 bytes).
pub fn encrypt(plain: &[u8], p256dh: &str, auth: &str) -> Option<Vec<u8>> {
    const PADDED: usize = 128;
    let browser = b64_lenient(p256dh);
    let secret = b64_lenient(auth);
    if browser.len() != 65 || browser[0] != 4 || secret.len() != 16 {
        return None;
    }
    let ua = PublicKey::from_sec1_bytes(&browser).ok()?;
    let mine = p256::ecdh::EphemeralSecret::random(&mut rand::rngs::OsRng);
    let sender = mine.public_key().to_encoded_point(false).as_bytes().to_vec();
    let shared = mine.diffie_hellman(&ua);
    let mut info = b"WebPush: info\0".to_vec();
    info.extend_from_slice(&browser);
    info.extend_from_slice(&sender);
    let ikm = hkdf(&secret, shared.raw_secret_bytes(), &info, 32);
    let salt = crate::util::random_bytes(16);
    let cek = hkdf(&salt, &ikm, b"Content-Encoding: aes128gcm\0", 16);
    let nonce = hkdf(&salt, &ikm, b"Content-Encoding: nonce\0", 12);
    let mut record = plain.to_vec();
    record.push(2);
    record.extend(std::iter::repeat_n(0u8, PADDED.saturating_sub(plain.len() + 1)));
    let ct = Aes128Gcm::new_from_slice(&cek).ok()?.encrypt(Nonce::from_slice(&nonce), record.as_slice()).ok()?;
    let mut out = salt;
    out.extend_from_slice(&4096u32.to_be_bytes());
    out.push(sender.len() as u8);
    out.extend_from_slice(&sender);
    out.extend_from_slice(&ct);
    Some(out)
}

fn jwt(key: &SigningKey, header: &Value, claims: &Value) -> String {
    let unsigned = format!("{}.{}", b64u(serde_json::to_string(header).unwrap().as_bytes()), b64u(serde_json::to_string(claims).unwrap().as_bytes()));
    let sig: Signature = key.sign(unsigned.as_bytes());
    format!("{unsigned}.{}", b64u(&sig.to_bytes()))
}

const HOSTS: [&str; 5] = ["web.push.apple.com", "fcm.googleapis.com", "jmt17.google.com", "push.services.mozilla.com", "notify.windows.com"];

pub struct Pusher {
    key: SigningKey,
    pub public_key: String,
    subject: String,
    hosts: Vec<String>,
    client: reqwest::Client,
}

impl Pusher {
    /// The VAPID key pair, made on first boot in HUB_DATA/vapid.pem (PKCS#8 PEM, as the Node hub writes it).
    pub fn new(dir: &Path, cfg: &Config) -> std::io::Result<Pusher> {
        let file = dir.join("vapid.pem");
        if !file.exists() {
            let k = SecretKey::random(&mut rand::rngs::OsRng);
            let pem = k.to_pkcs8_pem(LineEnding::LF).map_err(|e| std::io::Error::other(e.to_string()))?;
            let tmp = dir.join(format!("vapid.pem.{}", std::process::id()));
            write_private(&tmp, pem.as_bytes())?;
            let _ = std::fs::hard_link(&tmp, &file);
            let _ = std::fs::remove_file(&tmp);
        }
        let pem = std::fs::read_to_string(&file)?;
        let secret = SecretKey::from_pkcs8_pem(&pem).map_err(|e| std::io::Error::other(format!("vapid.pem: {e}")))?;
        let public_key = b64u(secret.public_key().to_encoded_point(false).as_bytes());
        Ok(Pusher {
            key: SigningKey::from(secret),
            public_key,
            subject: cfg.get("HUB_PUSH_SUBJECT").unwrap_or("https://trommi.com").to_string(),
            hosts: cfg.get("HUB_PUSH_HOSTS").unwrap_or("").split(',').map(|h| h.trim().to_string()).filter(|h| !h.is_empty()).collect(),
            client: reqwest::Client::builder().timeout(Duration::from_secs(10)).build().unwrap(),
        })
    }
    fn allowed(&self, endpoint: &str) -> bool {
        let Ok(url) = reqwest::Url::parse(endpoint) else { return false };
        let host = url.host_str().unwrap_or("").to_string();
        let host_port = match url.port() {
            Some(p) => format!("{host}:{p}"),
            None => host.clone(),
        };
        if self.hosts.contains(&host_port) {
            return true;
        }
        url.scheme() == "https" && HOSTS.iter().any(|h| host == *h || host.ends_with(&format!(".{h}")))
    }
    /// A browser's subscription object, normalised, or None.
    pub fn check(&self, sub: Option<&Value>) -> Option<Value> {
        let sub = sub?;
        let endpoint = sub.get("endpoint")?.as_str()?;
        if crate::util::js_len(endpoint) > 1024 || !self.allowed(endpoint) {
            return None;
        }
        let keys = sub.get("keys");
        let p = keys.and_then(|k| k.get("p256dh"));
        let a = keys.and_then(|k| k.get("auth"));
        let text = |v: Option<&Value>| v.and_then(|v| v.as_str()).map(String::from).unwrap_or_default();
        if b64_lenient(&text(p)).len() != 65 || b64_lenient(&text(a)).len() != 16 {
            return None;
        }
        Some(json!({ "endpoint": endpoint, "keys": { "p256dh": p.cloned().unwrap_or(Value::Null), "auth": a.cloned().unwrap_or(Value::Null) } }))
    }
    /// One message; the HTTP status (0 on a network error). 404/410 mean: forget it.
    pub async fn send(&self, sub: &Value, message: &Value, urgency: &str, log: &(dyn Fn(&str) + Sync)) -> u16 {
        let endpoint = sub["endpoint"].as_str().unwrap_or("");
        let Ok(url) = reqwest::Url::parse(endpoint) else { return 0 };
        let aud = url.origin().ascii_serialization();
        let token = jwt(&self.key, &json!({ "typ": "JWT", "alg": "ES256" }), &json!({ "aud": aud, "exp": crate::util::wall() / 1000 + 12 * 3600, "sub": self.subject }));
        let Some(body) = encrypt(serde_json::to_string(message).unwrap().as_bytes(), sub["keys"]["p256dh"].as_str().unwrap_or(""), sub["keys"]["auth"].as_str().unwrap_or("")) else {
            log("push failed: not the keys of a push subscription");
            return 0;
        };
        let r = self
            .client
            .post(url)
            .header("Authorization", format!("vapid t={token}, k={}", self.public_key))
            .header("Content-Encoding", "aes128gcm")
            .header("Content-Type", "application/octet-stream")
            .header("TTL", "86400")
            .header("Urgency", urgency)
            .body(body)
            .send()
            .await;
        match r {
            Ok(res) => {
                let s = res.status().as_u16();
                let _ = res.bytes().await;
                s
            }
            Err(e) => {
                log(&format!("push failed: {e}"));
                0
            }
        }
    }
}

pub fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    use std::io::Write;
    o.open(path)?.write_all(bytes)
}

// ---- APNs -------------------------------------------------------------------------------------------

pub struct ApnsConfig {
    key: String,
    key_id: String,
    team_id: String,
    pub topics: Vec<String>,
}
/// APNS_KEY_FILE or APNS_KEY, APNS_KEY_ID, APNS_TEAM_ID, APNS_TOPIC; any missing: no APNs.
pub fn apns_config(cfg: &Config) -> Option<ApnsConfig> {
    let pem = if let Some(k) = cfg.get("APNS_KEY") { k.replace("\\n", "\n") } else if let Some(f) = cfg.get("APNS_KEY_FILE") { std::fs::read_to_string(f).ok()? } else { String::new() };
    let topics: Vec<String> = cfg.get("APNS_TOPIC").unwrap_or("").split(',').map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).collect();
    if pem.is_empty() || cfg.get("APNS_KEY_ID").is_none() || cfg.get("APNS_TEAM_ID").is_none() || topics.is_empty() {
        return None;
    }
    Some(ApnsConfig { key: pem, key_id: cfg.get("APNS_KEY_ID").unwrap().into(), team_id: cfg.get("APNS_TEAM_ID").unwrap().into(), topics })
}

pub struct Apns {
    key: SigningKey,
    key_id: String,
    team_id: String,
    pub topics: Vec<String>,
    hosts: HashMap<String, String>,
    jwt: Mutex<Option<(String, i64)>>,
    h2c: reqwest::Client,
    tls: reqwest::Client,
}
pub fn alert_of(m: &Value) -> &'static str {
    if m.get("kind").and_then(|k| k.as_str()) == Some("agent-lost") {
        return if m.get("state").and_then(|s| s.as_str()) == Some("cut") { "Eine Sitzung ist abgeschnitten." } else { "Ein Agent hat die Verbindung verloren." };
    }
    if m.get("urgency").and_then(|u| u.as_f64()).is_some_and(|u| u >= 2.0) { "Dringend: eine neue Frage." } else { "Eine neue Frage." }
}
/// `e`: nonce(12) || ciphertext || tag(16), base64url, AAD trommi-apns-v1.
pub fn apns_seal(message: &Value, key: &[u8]) -> String {
    let nonce = crate::util::random_bytes(12);
    let ct = Aes256Gcm::new_from_slice(key).unwrap().encrypt(Nonce::from_slice(&nonce), Payload { msg: serde_json::to_string(message).unwrap().as_bytes(), aad: b"trommi-apns-v1" }).unwrap();
    let mut out = nonce;
    out.extend(ct);
    b64u(&out)
}

impl Apns {
    pub fn new(c: ApnsConfig, cfg: &Config) -> Result<Apns, String> {
        let secret = SecretKey::from_pkcs8_pem(&c.key).map_err(|e| format!("APNS key: {e}"))?;
        let mut hosts = HashMap::from([("production".to_string(), "https://api.push.apple.com".to_string()), ("sandbox".to_string(), "https://api.sandbox.push.apple.com".to_string())]);
        // HUB_APNS_HOSTS (tests): {"production":"http://127.0.0.1:x","sandbox":"…"}
        if let Some(v) = cfg.get("HUB_APNS_HOSTS").and_then(|v| serde_json::from_str::<HashMap<String, String>>(v).ok()) {
            hosts = v;
        }
        Ok(Apns {
            key: SigningKey::from(secret),
            key_id: c.key_id,
            team_id: c.team_id,
            topics: c.topics,
            hosts,
            jwt: Mutex::new(None),
            h2c: reqwest::Client::builder().http2_prior_knowledge().timeout(Duration::from_secs(10)).build().unwrap(),
            tls: reqwest::Client::builder().timeout(Duration::from_secs(10)).build().unwrap(),
        })
    }
    fn token(&self, fresh: bool) -> String {
        let mut j = self.jwt.lock();
        let t = crate::util::now();
        if fresh || j.as_ref().is_none_or(|(_, at)| t - at > 40 * 60000) {
            let tok = jwt(&self.key, &json!({ "alg": "ES256", "kid": self.key_id }), &json!({ "iss": self.team_id, "iat": t / 1000 }));
            *j = Some((tok, t));
        }
        j.as_ref().unwrap().0.clone()
    }
    /// What the app registers: { token (hex), environment, topic?, key (32 bytes) }; normalised or None.
    pub fn check(&self, a: &Value) -> Option<Value> {
        let o = a.as_object()?;
        let tok = o.get("token").and_then(|t| t.as_str()).map(|t| t.to_lowercase()).unwrap_or_default();
        let topic = match o.get("topic") {
            None | Some(Value::Null) => Value::String(self.topics[0].clone()),
            Some(t) => t.clone(),
        };
        let tok_ok = (64..=200).contains(&tok.len()) && tok.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'));
        let env = o.get("environment").and_then(|e| e.as_str()).unwrap_or("");
        let env_ok = o.get("environment").is_some_and(|e| e.is_string()) && self.hosts.contains_key(env);
        let topic_s = topic.as_str()?;
        let bundle_ok = !topic_s.is_empty() && topic_s.len() <= 155 && topic_s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'.' || c == b'-');
        if !tok_ok || !env_ok || !bundle_ok || !self.topics.iter().any(|t| t == topic_s) {
            return None;
        }
        let key = o.get("key").and_then(|k| k.as_str())?;
        if b64_lenient(key).len() != 32 {
            return None;
        }
        Some(json!({ "token": tok, "environment": env, "topic": topic_s, "key": key }))
    }
    async fn post(&self, origin: &str, path: &str, token: &str, a: &Value, body: &str) -> (u16, String) {
        let client = if origin.starts_with("http://") { &self.h2c } else { &self.tls };
        let r = client
            .post(format!("{origin}{path}"))
            .header("content-type", "application/json")
            .header("authorization", format!("bearer {token}"))
            .header("apns-topic", a["topic"].as_str().unwrap_or(""))
            .header("apns-push-type", "alert")
            .header("apns-priority", "10")
            .header("apns-expiration", (crate::util::now() / 1000 + 86400).to_string())
            .body(body.to_string())
            .send()
            .await;
        match r {
            Ok(res) => {
                let s = res.status().as_u16();
                let text = res.text().await.unwrap_or_default();
                let reason = serde_json::from_str::<Value>(if text.is_empty() { "{}" } else { &text }).ok().and_then(|v| v.get("reason").and_then(|r| r.as_str()).map(String::from)).unwrap_or_default();
                (s, reason)
            }
            Err(_) => (0, String::new()),
        }
    }
    /// One message; a token Apple no longer takes comes back as 410: forget it.
    pub async fn send(&self, a: &Value, message: &Value, log: &(dyn Fn(&str) + Sync)) -> u16 {
        let key = b64_lenient(a["key"].as_str().unwrap_or(""));
        let payload = serde_json::to_string(&json!({ "aps": { "alert": { "title": "Trommi", "body": alert_of(message) }, "sound": "default" }, "e": apns_seal(message, &key) })).unwrap();
        let Some(origin) = self.hosts.get(a["environment"].as_str().unwrap_or("")) else { return 0 };
        let path = format!("/3/device/{}", a["token"].as_str().unwrap_or(""));
        let mut r = self.post(origin, &path, &self.token(false), a, &payload).await;
        if r.0 == 403 && r.1 == "ExpiredProviderToken" {
            r = self.post(origin, &path, &self.token(true), a, &payload).await;
        }
        if r.0 != 200 && r.0 != 0 {
            log(&format!("apns {} {}", r.0, r.1));
        }
        if r.0 == 410 || (r.0 == 400 && (r.1 == "BadDeviceToken" || r.1 == "DeviceTokenNotForTopic")) {
            return 410;
        }
        r.0
    }
}
