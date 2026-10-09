//! Push and Live Activity (spec/v2.md section 15, D5): how the hub wakes a device. A push carries no content: a
//! room, a change number and an urgency; for an iPhone sealed under the key the phone registered, with a ticket
//! for the one envelope its notification extension may fetch.
//!
//! This module builds the requests (Web Push per RFC 8291 and 8292, APNs provider API). Sending them is behind
//! `Transport`, so tests record requests instead of calling Apple or a browser vendor.

use std::future::Future;
use std::pin::Pin;
use std::sync::Mutex;

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::Aes128Gcm;
use chacha20poly1305::ChaCha20Poly1305;
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use p256::ecdsa::signature::Signer;
use p256::ecdsa::{Signature, SigningKey};
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::PublicKey;
use serde_json::{json, Value};
use sha2::Sha256;

use crate::error::{refuse, Res};
use crate::observer::Device;
use crate::store::Room;
use crate::util::{b64, random, same, unb64};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushRequest {
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

/// The outcome of a send: the status and, for APNs, the reason text of a refusal.
pub type Sent = Result<(u16, String), String>;

pub trait Transport: Send + Sync {
    fn send(&self, request: PushRequest) -> Pin<Box<dyn Future<Output = Sent> + Send>>;
}

/// Records every request and answers 201: for tests, and for a hub without push credentials.
#[derive(Default)]
pub struct Recorder {
    pub sent: Mutex<Vec<PushRequest>>,
    /// the status to answer with, by a part of the URL; 201 otherwise
    pub answers: Mutex<Vec<(String, u16, String)>>,
}

impl Transport for Recorder {
    fn send(&self, request: PushRequest) -> Pin<Box<dyn Future<Output = Sent> + Send>> {
        let answer = self
            .answers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .find(|(part, _, _)| request.url.contains(part.as_str()))
            .map(|(_, status, reason)| (*status, reason.clone()))
            .unwrap_or((201, String::new()));
        self.sent
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(request);
        Box::pin(async move { Ok(answer) })
    }
}

/// The real network: HTTPS with the web's certificate roots; HTTP/2 for Apple.
pub struct Network {
    client: reqwest::Client,
}

impl Network {
    pub fn new() -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Network { client })
    }
}

impl Transport for Network {
    fn send(&self, request: PushRequest) -> Pin<Box<dyn Future<Output = Sent> + Send>> {
        let mut call = self.client.post(&request.url).body(request.body);
        for (k, v) in &request.headers {
            call = call.header(k, v);
        }
        Box::pin(async move {
            let answer = call.send().await.map_err(|e| e.without_url().to_string())?;
            let status = answer.status().as_u16();
            let text = answer.text().await.unwrap_or_default();
            let reason = serde_json::from_str::<Value>(&text)
                .ok()
                .and_then(|v| v["reason"].as_str().map(str::to_string))
                .unwrap_or_default();
            Ok((status, reason))
        })
    }
}

fn hkdf(salt: &[u8], ikm: &[u8], info: &[u8], len: usize) -> Vec<u8> {
    let mut out = vec![0u8; len];
    Hkdf::<Sha256>::new(Some(salt), ikm)
        .expand(info, &mut out)
        .expect("a short output");
    out
}

fn jwt(key: &SigningKey, header: Value, claims: Value) -> String {
    let signed = format!(
        "{}.{}",
        b64(header.to_string().as_bytes()),
        b64(claims.to_string().as_bytes())
    );
    let signature: Signature = key.sign(signed.as_bytes());
    format!("{signed}.{}", b64(&signature.to_bytes()))
}

// ---- Web Push

/// The hub's VAPID key (RFC 8292): P-256, made on first start, kept beside the database.
pub struct Vapid {
    key: SigningKey,
    pub public: Vec<u8>,
    subject: String,
}

impl Vapid {
    pub fn from_secret(secret: &[u8; 32], subject: &str) -> Option<Self> {
        let key = SigningKey::from_slice(secret).ok()?;
        let public = key
            .verifying_key()
            .to_encoded_point(false)
            .as_bytes()
            .to_vec();
        Some(Vapid {
            key,
            public,
            subject: subject.to_string(),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebSubscription {
    pub endpoint: String,
    pub p256dh: Vec<u8>,
    pub auth: Vec<u8>,
}

/// The push services a subscription may name: the hub posts to no other host (it would be a way to make the hub
/// call any address).
const PUSH_HOSTS: [&str; 5] = [
    "web.push.apple.com",
    "fcm.googleapis.com",
    "jmt17.google.com",
    "push.services.mozilla.com",
    "notify.windows.com",
];

/// `https://host[:port]` of an endpoint if it is a known push service, or one of `extra` (exact `host[:port]`,
/// for tests, where `http://` is allowed too).
pub fn endpoint_origin(endpoint: &str, extra: &[String]) -> Option<String> {
    if endpoint.len() > 1024
        || !endpoint.is_ascii()
        || endpoint.bytes().any(|b| b.is_ascii_control() || b == b' ')
    {
        return None;
    }
    let (scheme, rest) = endpoint.split_once("://")?;
    let authority = rest.split(['/', '?', '#']).next()?;
    if authority.contains('@') || authority.is_empty() {
        return None;
    }
    if extra.iter().any(|h| h == authority) {
        return matches!(scheme, "https" | "http").then(|| format!("{scheme}://{authority}"));
    }
    let host = authority.split(':').next()?;
    let known = PUSH_HOSTS
        .iter()
        .any(|h| host == *h || host.ends_with(&format!(".{h}")));
    (scheme == "https" && known).then(|| format!("https://{authority}"))
}

/// RFC 8291: `plain` encrypted for one subscription (aes128gcm, one record).
pub fn web_push_encrypt(sub: &WebSubscription, plain: &[u8]) -> Option<Vec<u8>> {
    let browser = PublicKey::from_sec1_bytes(&sub.p256dh).ok()?;
    let mine = p256::ecdh::EphemeralSecret::random(&mut p256::elliptic_curve::rand_core::OsRng);
    let sender = mine
        .public_key()
        .to_encoded_point(false)
        .as_bytes()
        .to_vec();
    let shared = mine.diffie_hellman(&browser);
    let mut info = b"WebPush: info\0".to_vec();
    info.extend_from_slice(&sub.p256dh);
    info.extend_from_slice(&sender);
    let ikm = hkdf(&sub.auth, shared.raw_secret_bytes(), &info, 32);
    let salt = random::<16>();
    let cek = hkdf(&salt, &ikm, b"Content-Encoding: aes128gcm\0", 16);
    let nonce = hkdf(&salt, &ikm, b"Content-Encoding: nonce\0", 12);
    // one record: the content, the delimiter of the last record, padding so that every push has one size
    let mut record = plain.to_vec();
    record.push(0x02);
    record.resize(record.len().max(128), 0);
    let sealed = Aes128Gcm::new_from_slice(&cek)
        .ok()?
        .encrypt(nonce.as_slice().into(), record.as_slice())
        .ok()?;
    let mut out = salt.to_vec();
    out.extend_from_slice(&4096u32.to_be_bytes());
    out.push(sender.len() as u8);
    out.extend_from_slice(&sender);
    out.extend_from_slice(&sealed);
    Some(out)
}

/// 15.2: a Web Push carries `{ room_id, change, urgency }` and nothing else.
pub fn web_push_request(
    vapid: &Vapid,
    sub: &WebSubscription,
    extra_hosts: &[String],
    room: &Room,
    change: i64,
    urgency: u8,
    now: u64,
) -> Option<PushRequest> {
    let origin = endpoint_origin(&sub.endpoint, extra_hosts)?;
    let payload = json!({ "room_id": b64(room), "change": change, "urgency": urgency });
    let body = web_push_encrypt(sub, payload.to_string().as_bytes())?;
    let token = jwt(
        &vapid.key,
        json!({ "typ": "JWT", "alg": "ES256" }),
        json!({ "aud": origin, "exp": now / 1000 + 12 * 3600, "sub": vapid.subject }),
    );
    Some(PushRequest {
        url: sub.endpoint.clone(),
        headers: vec![
            (
                "authorization".into(),
                format!("vapid t={token}, k={}", b64(&vapid.public)),
            ),
            ("content-encoding".into(), "aes128gcm".into()),
            ("content-type".into(), "application/octet-stream".into()),
            ("ttl".into(), "86400".into()),
            (
                "urgency".into(),
                if urgency >= 2 { "high" } else { "normal" }.into(),
            ),
            // one notification per room waits at the push service; a newer one replaces it
            ("topic".into(), b64(&room[..12])),
        ],
        body,
    })
}

// ---- APNs

pub struct Apns {
    key: SigningKey,
    key_id: String,
    team_id: String,
    pub topics: Vec<String>,
    hosts: std::collections::HashMap<String, String>,
    token: Mutex<Option<(u64, String)>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApnsRegistration {
    pub token: String,
    pub key: [u8; 32],
    pub environment: String,
    pub topic: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Text {
    Question,
    Urgent,
    AgentLost,
}

impl Text {
    pub fn text(self) -> &'static str {
        match self {
            Text::Question => "A new question.",
            Text::Urgent => "Urgent: a new question.",
            Text::AgentLost => "An agent lost its connection.",
        }
    }
}

impl Apns {
    pub fn new(
        pem: &str,
        key_id: &str,
        team_id: &str,
        topics: Vec<String>,
        hosts: std::collections::HashMap<String, String>,
    ) -> Option<Self> {
        use p256::pkcs8::DecodePrivateKey;
        let key = SigningKey::from_pkcs8_pem(pem).ok()?;
        if topics.is_empty() {
            return None;
        }
        Some(Apns {
            key,
            key_id: key_id.to_string(),
            team_id: team_id.to_string(),
            topics,
            hosts,
            token: Mutex::new(None),
        })
    }

    /// A device token is 64 to 200 hex digits; the environment and the topic are ones this hub serves.
    pub fn accepts(&self, token: &str, environment: &str, topic: &str) -> bool {
        (64..=200).contains(&token.len())
            && token
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            && self.hosts.contains_key(environment)
            && (self.topics.iter().any(|t| t == topic)
                || self
                    .topics
                    .iter()
                    .any(|t| topic == format!("{t}.push-type.liveactivity")))
    }

    /// The provider token, reused for 40 minutes (Apple refuses one older than an hour and one renewed too often).
    fn provider_token(&self, now: u64, fresh: bool) -> String {
        let mut held = self.token.lock().unwrap_or_else(|e| e.into_inner());
        if let (Some((at, token)), false) = (&*held, fresh) {
            if now.saturating_sub(*at) < 40 * 60_000 {
                return token.clone();
            }
        }
        let token = jwt(
            &self.key,
            json!({ "alg": "ES256", "kid": self.key_id }),
            json!({ "iss": self.team_id, "iat": now / 1000 }),
        );
        *held = Some((now, token.clone()));
        token
    }

    pub fn forget_token(&self) {
        *self.token.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }

    fn request(
        &self,
        environment: &str,
        token: &str,
        topic: &str,
        push_type: &str,
        priority: &str,
        collapse: Option<&str>,
        payload: &Value,
        now: u64,
    ) -> Option<PushRequest> {
        let host = self.hosts.get(environment)?;
        let mut headers = vec![
            ("content-type".to_string(), "application/json".to_string()),
            (
                "authorization".to_string(),
                format!("bearer {}", self.provider_token(now, false)),
            ),
            ("apns-topic".to_string(), topic.to_string()),
            ("apns-push-type".to_string(), push_type.to_string()),
            ("apns-priority".to_string(), priority.to_string()),
            (
                "apns-expiration".to_string(),
                (now / 1000 + 86_400).to_string(),
            ),
        ];
        if let Some(id) = collapse {
            headers.push(("apns-collapse-id".to_string(), id.to_string()));
        }
        Some(PushRequest {
            url: format!("{host}/3/device/{token}"),
            headers,
            body: payload.to_string().into_bytes(),
        })
    }

    /// 15.2: a fixed text, and `nonce(12) ‖ AEAD.Seal(key, nonce, "trommi apns v2", { room_id, change, urgency,
    /// ticket })` under the 32 random bytes the app registered.
    pub fn alert(
        &self,
        reg: &ApnsRegistration,
        text: Text,
        room: &Room,
        change: i64,
        urgency: u8,
        ticket: Option<&str>,
        now: u64,
    ) -> Option<PushRequest> {
        let message =
            json!({ "room_id": b64(room), "change": change, "urgency": urgency, "ticket": ticket });
        let sealed = seal_for_phone(&reg.key, message.to_string().as_bytes())?;
        let payload = json!({
            "aps": { "alert": { "title": "Trommi", "body": text.text() }, "sound": "default", "mutable-content": 1 },
            "e": b64(&sealed),
        });
        self.request(
            &reg.environment,
            &reg.token,
            &reg.topic,
            "alert",
            "10",
            None,
            &payload,
            now,
        )
    }

    /// 15.3: `{ aps: { timestamp, event, content-state: { working, waiting }, stale-date, relevance-score } }`.
    /// Apple sees two counts and a random tag.
    #[allow(clippy::too_many_arguments)]
    pub fn live_activity(
        &self,
        environment: &str,
        token: &str,
        topic: &str,
        tag: &str,
        event: &str,
        working: u64,
        waiting: u64,
        beat_ms: u64,
        now: u64,
    ) -> Option<PushRequest> {
        let t = now / 1000;
        let mut aps = json!({ "timestamp": t, "event": event, "content-state": { "working": working, "waiting": waiting } });
        match event {
            "end" => aps["dismissal-date"] = json!(t + 900),
            _ => {
                aps["stale-date"] = json!(t + (3 * beat_ms / 1000).max(60));
                aps["relevance-score"] = json!(if waiting > 0 { 100 } else { 50 });
            }
        }
        if event == "start" {
            aps["attributes-type"] = json!("TrommiActivityAttributes");
            aps["attributes"] = json!({ "tag": tag });
            aps["input-push-token"] = json!(1);
            aps["alert"] = json!({ "title": "Trommi", "body": "Agents are working." });
        }
        let base = topic
            .strip_suffix(".push-type.liveactivity")
            .unwrap_or(topic);
        let priority = if event == "update" && waiting == 0 {
            "5"
        } else {
            "10"
        };
        self.request(
            environment,
            token,
            &format!("{base}.push-type.liveactivity"),
            "liveactivity",
            priority,
            None,
            &json!({ "aps": aps }),
            now,
        )
    }
}

const APNS_AAD: &[u8] = b"trommi apns v2";

pub fn seal_for_phone(key: &[u8; 32], plain: &[u8]) -> Option<Vec<u8>> {
    let nonce = random::<12>();
    let sealed = ChaCha20Poly1305::new(key.into())
        .encrypt(
            (&nonce).into(),
            Payload {
                msg: plain,
                aad: APNS_AAD,
            },
        )
        .ok()?;
    Some([&nonce[..], &sealed].concat())
}

/// What the phone does with it; here for the tests.
pub fn open_on_phone(key: &[u8; 32], sealed: &[u8]) -> Option<Vec<u8>> {
    if sealed.len() < 12 {
        return None;
    }
    ChaCha20Poly1305::new(key.into())
        .decrypt(
            sealed[..12].into(),
            Payload {
                msg: &sealed[12..],
                aad: APNS_AAD,
            },
        )
        .ok()
}

/// A dead registration: the service says the subscription or token is gone.
pub fn gone(status: u16, reason: &str) -> bool {
    status == 404
        || status == 410
        || (status == 400 && matches!(reason, "BadDeviceToken" | "DeviceTokenNotForTopic"))
}

// ---- the ticket for the notification extension (15.2)

pub const TICKET_MS: u64 = 86_400_000;

/// The hub's own MAC over room, device, envelope (by its change number) and a 24-hour expiry. With it the
/// notification extension fetches that one envelope, without a token.
pub fn ticket(key: &[u8; 32], room: &Room, device: &Device, change: i64, now: u64) -> String {
    let expires = now + TICKET_MS;
    let mut t = Vec::with_capacity(112);
    t.extend_from_slice(room);
    t.extend_from_slice(device);
    t.extend_from_slice(&(change as u64).to_be_bytes());
    t.extend_from_slice(&expires.to_be_bytes());
    let mac = ticket_mac(key, &t);
    t.extend_from_slice(&mac);
    b64(&t)
}

fn ticket_mac(key: &[u8; 32], fields: &[u8]) -> [u8; 32] {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key).expect("any key length");
    mac.update(b"trommi push ticket v2\0");
    mac.update(fields);
    mac.finalize().into_bytes().into()
}

/// Room, device and change of a valid ticket. One answer for every way a ticket can be wrong.
pub fn check_ticket(key: &[u8; 32], text: &str, now: u64) -> Res<(Room, Device, i64)> {
    let wrong = || refuse("unauthorised", "the ticket is wrong or ran out");
    let t = unb64(text).filter(|t| t.len() == 112).ok_or_else(wrong)?;
    if !same(&ticket_mac(key, &t[..80]), &t[80..]) {
        return Err(wrong());
    }
    let expires = u64::from_be_bytes(t[72..80].try_into().expect("eight"));
    if expires <= now {
        return Err(wrong());
    }
    let change = u64::from_be_bytes(t[64..72].try_into().expect("eight")) as i64;
    Ok((
        t[..32].try_into().expect("32"),
        t[32..64].try_into().expect("32"),
        change,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::signature::Verifier;
    use p256::ecdsa::VerifyingKey;

    fn verify_jwt(token: &str, public: &[u8]) -> Value {
        let parts: Vec<&str> = token.split('.').collect();
        assert_eq!(parts.len(), 3);
        let key = VerifyingKey::from_sec1_bytes(public).unwrap();
        let signature = Signature::from_slice(&unb64(parts[2]).unwrap()).unwrap();
        key.verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &signature)
            .unwrap();
        serde_json::from_slice(&unb64(parts[1]).unwrap()).unwrap()
    }

    /// The browser's side of RFC 8291.
    fn browser_open(secret: &p256::SecretKey, auth: &[u8], body: &[u8]) -> Vec<u8> {
        let (salt, rest) = body.split_at(16);
        assert_eq!(&rest[..4], &4096u32.to_be_bytes());
        let key_len = rest[4] as usize;
        let sender = &rest[5..5 + key_len];
        let sealed = &rest[5 + key_len..];
        let shared = p256::ecdh::diffie_hellman(
            secret.to_nonzero_scalar(),
            PublicKey::from_sec1_bytes(sender).unwrap().as_affine(),
        );
        let mine = secret.public_key().to_encoded_point(false);
        let mut info = b"WebPush: info\0".to_vec();
        info.extend_from_slice(mine.as_bytes());
        info.extend_from_slice(sender);
        let ikm = hkdf(auth, shared.raw_secret_bytes(), &info, 32);
        let cek = hkdf(salt, &ikm, b"Content-Encoding: aes128gcm\0", 16);
        let nonce = hkdf(salt, &ikm, b"Content-Encoding: nonce\0", 12);
        let mut plain = Aes128Gcm::new_from_slice(&cek)
            .unwrap()
            .decrypt(nonce.as_slice().into(), sealed)
            .unwrap();
        while plain.last() == Some(&0) {
            plain.pop();
        }
        assert_eq!(plain.pop(), Some(2));
        plain
    }

    #[test]
    fn a_web_push_opens_in_the_browser_and_carries_no_content() {
        let vapid = Vapid::from_secret(&[7; 32], "https://trommi.com").unwrap();
        let secret = p256::SecretKey::random(&mut p256::elliptic_curve::rand_core::OsRng);
        let sub = WebSubscription {
            endpoint: "https://fcm.googleapis.com/fcm/send/abc".into(),
            p256dh: secret
                .public_key()
                .to_encoded_point(false)
                .as_bytes()
                .to_vec(),
            auth: vec![9; 16],
        };
        let r = web_push_request(&vapid, &sub, &[], &[3; 32], 42, 2, 1_700_000_000_000).unwrap();
        assert_eq!(r.url, sub.endpoint);
        let plain: Value =
            serde_json::from_slice(&browser_open(&secret, &sub.auth, &r.body)).unwrap();
        assert_eq!(
            plain,
            json!({ "room_id": b64(&[3; 32]), "change": 42, "urgency": 2 })
        );
        let header = |name: &str| r.headers.iter().find(|(k, _)| k == name).unwrap().1.clone();
        assert_eq!(
            (
                header("urgency").as_str(),
                header("ttl").as_str(),
                header("content-encoding").as_str()
            ),
            ("high", "86400", "aes128gcm")
        );
        let auth = header("authorization");
        let token = auth
            .strip_prefix("vapid t=")
            .unwrap()
            .split(", k=")
            .next()
            .unwrap();
        let claims = verify_jwt(token, &vapid.public);
        assert_eq!(claims["aud"], "https://fcm.googleapis.com");
        assert_eq!(claims["exp"], 1_700_000_000u64 + 12 * 3600);
    }

    #[test]
    fn only_known_push_services_are_called() {
        let extra = vec!["127.0.0.1:9999".to_string()];
        assert_eq!(
            endpoint_origin("https://updates.push.services.mozilla.com/wpush/v2/x", &[]).as_deref(),
            Some("https://updates.push.services.mozilla.com")
        );
        assert_eq!(
            endpoint_origin("http://127.0.0.1:9999/p", &extra).as_deref(),
            Some("http://127.0.0.1:9999")
        );
        for bad in [
            "http://fcm.googleapis.com/x",
            "https://fcm.googleapis.com.evil.example/x",
            "https://evil.example/fcm.googleapis.com",
            "https://user@fcm.googleapis.com/x",
            "https://169.254.169.254/latest",
            "http://127.0.0.1:9998/p",
            "https://notfcm.googleapis.com.example",
            "file:///etc/passwd",
        ] {
            assert_eq!(endpoint_origin(bad, &extra), None, "{bad}");
        }
    }

    fn apns() -> Apns {
        use p256::pkcs8::EncodePrivateKey;
        let secret = p256::SecretKey::random(&mut p256::elliptic_curve::rand_core::OsRng);
        let pem = secret.to_pkcs8_pem(Default::default()).unwrap();
        let hosts = std::collections::HashMap::from([(
            "production".to_string(),
            "https://api.push.apple.com".to_string(),
        )]);
        Apns::new(
            &pem,
            "KEYID12345",
            "TEAMID1234",
            vec!["com.trommi.app".into()],
            hosts,
        )
        .unwrap()
    }

    #[test]
    fn an_apns_alert_has_a_fixed_text_and_a_sealed_number() {
        let a = apns();
        let reg = ApnsRegistration {
            token: "ab".repeat(32),
            key: [5; 32],
            environment: "production".into(),
            topic: "com.trommi.app".into(),
        };
        assert!(a.accepts(&reg.token, "production", "com.trommi.app"));
        assert!(
            !a.accepts(&reg.token, "sandbox", "com.trommi.app")
                && !a.accepts("xyz", "production", "com.trommi.app")
                && !a.accepts(&reg.token, "production", "com.other")
        );
        let r = a
            .alert(
                &reg,
                Text::Urgent,
                &[3; 32],
                77,
                3,
                Some("TICKET"),
                1_700_000_000_000,
            )
            .unwrap();
        assert_eq!(
            r.url,
            format!("https://api.push.apple.com/3/device/{}", reg.token)
        );
        let payload: Value = serde_json::from_slice(&r.body).unwrap();
        assert_eq!(payload["aps"]["alert"]["body"], "Urgent: a new question.");
        assert_eq!(payload["aps"]["mutable-content"], 1);
        let opened: Value = serde_json::from_slice(
            &open_on_phone(&reg.key, &unb64(payload["e"].as_str().unwrap()).unwrap()).unwrap(),
        )
        .unwrap();
        assert_eq!(
            opened,
            json!({ "room_id": b64(&[3; 32]), "change": 77, "urgency": 3, "ticket": "TICKET" })
        );
        assert!(open_on_phone(&[6; 32], &unb64(payload["e"].as_str().unwrap()).unwrap()).is_none());
        let header = |name: &str| r.headers.iter().find(|(k, _)| k == name).unwrap().1.clone();
        assert_eq!(
            (
                header("apns-push-type").as_str(),
                header("apns-priority").as_str(),
                header("apns-topic").as_str()
            ),
            ("alert", "10", "com.trommi.app")
        );
        // the provider token is reused within 40 minutes
        let again = a
            .alert(
                &reg,
                Text::Question,
                &[3; 32],
                78,
                1,
                None,
                1_700_000_060_000,
            )
            .unwrap();
        assert_eq!(again.headers[1], r.headers[1]);
        let later = a
            .alert(
                &reg,
                Text::Question,
                &[3; 32],
                79,
                1,
                None,
                1_700_003_000_000,
            )
            .unwrap();
        assert_ne!(later.headers[1], r.headers[1]);
    }

    #[test]
    fn a_live_activity_push_carries_two_counts() {
        let a = apns();
        let start = a
            .live_activity(
                "production",
                &"cd".repeat(32),
                "com.trommi.app",
                "tag-1",
                "start",
                2,
                1,
                600_000,
                1_700_000_000_000,
            )
            .unwrap();
        let payload: Value = serde_json::from_slice(&start.body).unwrap();
        assert_eq!(
            payload["aps"]["content-state"],
            json!({ "working": 2, "waiting": 1 })
        );
        assert_eq!(payload["aps"]["attributes"], json!({ "tag": "tag-1" }));
        assert_eq!(payload["aps"]["relevance-score"], 100);
        assert!(start
            .headers
            .iter()
            .any(|(k, v)| k == "apns-topic" && v == "com.trommi.app.push-type.liveactivity"));
        let end = a
            .live_activity(
                "production",
                &"cd".repeat(32),
                "com.trommi.app",
                "tag-1",
                "end",
                0,
                0,
                600_000,
                1_700_000_000_000,
            )
            .unwrap();
        let payload: Value = serde_json::from_slice(&end.body).unwrap();
        assert_eq!(payload["aps"]["dismissal-date"], 1_700_000_000u64 + 900);
        assert!(payload["aps"].get("stale-date").is_none());
    }

    #[test]
    fn a_ticket_names_one_envelope_for_a_day() {
        let key = [4; 32];
        let t = ticket(&key, &[1; 32], &[2; 32], 99, 1_000);
        assert_eq!(
            check_ticket(&key, &t, 2_000).unwrap(),
            ([1; 32], [2; 32], 99)
        );
        assert!(check_ticket(&key, &t, 1_000 + TICKET_MS).is_err());
        assert!(check_ticket(&[5; 32], &t, 2_000).is_err());
        let mut forged = unb64(&t).unwrap();
        forged[70] ^= 1;
        assert!(check_ticket(&key, &b64(&forged), 2_000).is_err());
        assert!(check_ticket(&key, "short", 2_000).is_err());
        assert!(
            gone(410, "")
                && gone(400, "BadDeviceToken")
                && !gone(400, "PayloadTooLarge")
                && !gone(201, "")
        );
    }
}
