//! Scenario clients for the integration tests: real MLS devices (OpenMLS, the profile of spec/v2.md section 3)
//! that talk to a real hub over HTTP, one request per connection, one attempt, no retry.
//!
//! Seam for the merge with `trommi-core`: `Dev` is what the core's device will be. It builds the structs of the
//! spec with the hub's own `wire` module; what the hub cannot check (HPKE sealing of content keys, the recovery
//! MAC) is filled with bytes of the right shape.

#![allow(dead_code)]

pub mod enc;

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::ChaCha20Poly1305;
pub use enc::Bytes;
use openmls::group::{
    MlsGroup, MlsGroupCreateConfig, MlsGroupJoinConfig, StagedWelcome,
    PURE_PLAINTEXT_WIRE_FORMAT_POLICY,
};
use openmls::prelude::tls_codec::{Deserialize as _, Serialize as _};
use openmls::prelude::*;
use openmls::treesync::LeafNodeParameters;
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;
use openmls_traits::signatures::Signer;
use openmls_traits::OpenMlsProvider;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use trommi_hub::app::App;
use trommi_hub::config::Config;
use trommi_hub::observer::SUITE;
use trommi_hub::push::Recorder;
use trommi_hub::util::{b64, hex, random, unb64};
use trommi_hub::wire::{
    self, CommitNote, Cut, Header, Subject, TrommiRoom, TrommiSession, EXT_ROOM, EXT_SESSION,
    ZERO16, ZERO32,
};

// ---- the hub under test

pub struct TestHub {
    pub app: Arc<App>,
    pub port: u16,
    pub url: String,
    pub recorder: Arc<Recorder>,
    pub dir: PathBuf,
    runtime: Option<tokio::runtime::Runtime>,
    stop: Arc<tokio::sync::Notify>,
}

impl TestHub {
    pub fn start() -> TestHub {
        Self::start_with(&[])
    }

    /// A hub of its own: a fresh data directory, a free port, push requests recorded instead of sent.
    pub fn start_with(env: &[(&str, &str)]) -> TestHub {
        let dir = std::env::temp_dir().join(format!("trommi-hub-test-{}", hex(&random::<8>())));
        Self::start_in(dir, env)
    }

    pub fn start_in(dir: PathBuf, env: &[(&str, &str)]) -> TestHub {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(4)
            .enable_all()
            .build()
            .unwrap();
        let listener = runtime.block_on(async {
            tokio::net::TcpListener::bind(("127.0.0.1", 0))
                .await
                .unwrap()
        });
        let port = listener.local_addr().unwrap().port();
        let url = format!("http://127.0.0.1:{port}");
        let mut map: HashMap<String, String> = HashMap::from([
            ("HUB_DATA".to_string(), dir.to_string_lossy().to_string()),
            ("HUB_URL".to_string(), url.clone()),
            ("HUB_PORT".to_string(), port.to_string()),
            ("HUB_QUIET".to_string(), "1".to_string()),
            ("HUB_TEST_CONTROL".to_string(), "1".to_string()),
            ("HUB_TRUST_CF".to_string(), "1".to_string()),
            (
                "HUB_ORIGINS".to_string(),
                "https://app.trommi.com".to_string(),
            ),
            ("HUB_PUSH_HOSTS".to_string(), "127.0.0.1:9".to_string()),
            (
                "HUB_LIMIT_FOUND_PER_IP_HOUR".to_string(),
                "100000".to_string(),
            ),
            // the scenarios run faster than a device is let: the limits of expensive requests have tests of
            // their own, which set them
            (
                "HUB_LIMIT_HEAVY_PER_SECOND".to_string(),
                "100000".to_string(),
            ),
            ("HUB_LIMIT_HEAVY_BURST".to_string(), "100000".to_string()),
        ]);
        for (k, v) in env {
            map.insert(k.to_string(), v.to_string());
        }
        let recorder = Arc::new(Recorder::default());
        let app = App::new(Config::from_map(&map), recorder.clone()).unwrap();
        let stop = Arc::new(tokio::sync::Notify::new());
        let (a, s) = (app.clone(), stop.clone());
        // with TEST_JOBS the periodic jobs run as in production (`spawn_jobs`), on the intervals the test set
        if env.iter().any(|(k, v)| *k == "TEST_JOBS" && *v == "1") {
            let jobs = app.clone();
            runtime.block_on(async move { trommi_hub::server::spawn_jobs(&jobs) });
        }
        runtime.spawn(async move { trommi_hub::server::serve(a, listener, s).await });
        TestHub {
            app,
            port,
            url,
            recorder,
            dir,
            runtime: Some(runtime),
            stop,
        }
    }

    /// Starts the admin page's listener as `main` does, on 127.0.0.1 and a free port; returns the port.
    pub fn admin(&self) -> u16 {
        let runtime = self.runtime.as_ref().unwrap();
        let listener = runtime.block_on(async {
            tokio::net::TcpListener::bind(("127.0.0.1", 0))
                .await
                .unwrap()
        });
        let port = listener.local_addr().unwrap().port();
        runtime.spawn(trommi_hub::server::serve_admin(
            self.app.clone(),
            listener,
            self.stop.clone(),
        ));
        port
    }

    /// Stops the hub and keeps its data directory, to start another on it.
    pub fn stop_keep(mut self) -> PathBuf {
        self.stop.notify_one();
        if let Some(rt) = self.runtime.take() {
            rt.shutdown_timeout(Duration::from_secs(5));
        }
        std::mem::take(&mut self.dir)
    }

    pub fn get(&self, path: &str) -> Reply {
        request(self.port, "GET", path, &[], &[])
    }

    pub fn post(&self, path: &str, body: &Value) -> Reply {
        request(self.port, "POST", path, &[], body.to_string().as_bytes())
    }

    pub fn clock(&self, advance_ms: i64) {
        assert_eq!(
            self.post("/v2/__test/clock", &json!({ "advance_ms": advance_ms }))
                .status,
            200
        );
    }

    pub fn pushes(&self) -> Vec<trommi_hub::push::PushRequest> {
        self.recorder.sent.lock().unwrap().clone()
    }

    /// Waits until `f` holds, at most three seconds: for what the hub does after it answered.
    pub fn eventually(&self, what: &str, f: impl Fn() -> bool) {
        for _ in 0..300 {
            if f() {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!("did not happen: {what}");
    }
}

impl Drop for TestHub {
    fn drop(&mut self) {
        self.stop.notify_one();
        if let Some(rt) = self.runtime.take() {
            rt.shutdown_background();
        }
        if !self.dir.as_os_str().is_empty() {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }
}

// ---- HTTP, as plain as it gets

#[derive(Debug, Clone)]
pub struct Reply {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Reply {
    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }
    /// The error code of a refusal, or "" for an answer.
    pub fn code(&self) -> String {
        self.json()["error"].as_str().unwrap_or("").to_string()
    }
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }
    pub fn ok(&self) -> Value {
        assert_eq!(self.status, 200, "{}", String::from_utf8_lossy(&self.body));
        self.json()
    }
    /// Asserts a refusal with this status and code.
    pub fn refused(&self, status: u16, code: &str) -> Value {
        assert_eq!(
            (self.status, self.code().as_str()),
            (status, code),
            "{}",
            String::from_utf8_lossy(&self.body)
        );
        self.json()
    }
}

pub fn send_request(
    port: u16,
    method: &str,
    path: &str,
    headers: &[(&str, String)],
    body: &[u8],
) -> TcpStream {
    let mut socket = TcpStream::connect(("127.0.0.1", port)).unwrap();
    socket
        .set_read_timeout(Some(Duration::from_secs(30)))
        .unwrap();
    let mut head = format!("{method} {path} HTTP/1.1\r\nhost: 127.0.0.1\r\nconnection: close\r\ntrommi-client: test/1.0.0\r\ncontent-length: {}\r\n", body.len());
    for (k, v) in headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str("\r\n");
    socket.write_all(head.as_bytes()).unwrap();
    socket.write_all(body).unwrap();
    socket
}

pub fn read_head(reader: &mut BufReader<TcpStream>) -> (u16, Vec<(String, String)>) {
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    let status: u16 = line
        .split(' ')
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or_else(|| panic!("no status line: {line:?}"));
    let mut headers = vec![];
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            headers.push((k.trim().to_ascii_lowercase(), v.trim().to_string()));
        }
    }
    (status, headers)
}

pub fn request(
    port: u16,
    method: &str,
    path: &str,
    headers: &[(&str, String)],
    body: &[u8],
) -> Reply {
    let socket = send_request(port, method, path, headers, body);
    let mut reader = BufReader::new(socket);
    let (status, headers) = read_head(&mut reader);
    let mut body = Vec::new();
    match headers
        .iter()
        .find(|(k, _)| k == "content-length")
        .and_then(|(_, v)| v.parse::<usize>().ok())
    {
        Some(n) => {
            body.resize(n, 0);
            reader.read_exact(&mut body).unwrap();
        }
        None => {
            let _ = reader.read_to_end(&mut body);
        }
    }
    Reply {
        status,
        headers,
        body,
    }
}

/// An open stream of server-sent events.
pub struct Events {
    reader: BufReader<TcpStream>,
    pub status: u16,
}

#[derive(Debug, Clone, PartialEq)]
pub struct EventMsg {
    pub id: Option<i64>,
    pub name: String,
    pub data: Value,
}

impl Events {
    /// The next event that is not a ping; `None` when the stream ended or nothing came within `wait`.
    pub fn next(&mut self, wait: Duration) -> Option<EventMsg> {
        self.reader.get_ref().set_read_timeout(Some(wait)).unwrap();
        let (mut id, mut name, mut data) = (None, String::new(), Value::Null);
        loop {
            let mut line = String::new();
            match self.reader.read_line(&mut line) {
                Ok(0) | Err(_) => return None,
                Ok(_) => {}
            }
            let line = line.trim_end_matches(['\r', '\n']);
            // a chunked body: the size lines between events are hex digits only
            if !line.is_empty() && line.len() <= 8 && line.bytes().all(|b| b.is_ascii_hexdigit()) {
                continue;
            }
            if line.is_empty() {
                if name.is_empty() {
                    continue;
                }
                if name == "ping" {
                    (id, name, data) = (None, String::new(), Value::Null);
                    continue;
                }
                return Some(EventMsg { id, name, data });
            }
            if let Some(v) = line.strip_prefix("id: ") {
                id = v.parse().ok();
            } else if let Some(v) = line.strip_prefix("event: ") {
                name = v.to_string();
            } else if let Some(v) = line.strip_prefix("data: ") {
                data = serde_json::from_str(v).unwrap_or(Value::Null);
            }
        }
    }

    /// Reads until an event of this name comes.
    pub fn until(&mut self, name: &str) -> EventMsg {
        for _ in 0..200 {
            match self.next(Duration::from_secs(5)) {
                Some(e) if e.name == name => return e,
                Some(_) => {}
                None => break,
            }
        }
        panic!("no {name} event came");
    }

    pub fn ended(&mut self) -> bool {
        while self.next(Duration::from_secs(3)).is_some() {}
        let mut probe = [0u8; 1];
        // closed by the hub: the end of the stream, or a connection that was cut
        match self.reader.read(&mut probe) {
            Ok(0) => true,
            Ok(_) => false,
            Err(e) => !matches!(
                e.kind(),
                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
            ),
        }
    }
}

// ---- the recovery key of a room, as far as the hub sees it

pub struct Recovery {
    pub sign: SignatureKeyPair,
    pub hpke_public: [u8; 32],
}

impl Recovery {
    pub fn new() -> Self {
        Recovery {
            sign: SignatureKeyPair::new(SignatureScheme::ED25519).unwrap(),
            hpke_public: random(),
        }
    }
    pub fn public(&self) -> [u8; 32] {
        self.sign.to_public_vec().try_into().unwrap()
    }
    pub fn room_ext(&self, agents: &[[u8; 32]]) -> TrommiRoom {
        let mut agents = agents.to_vec();
        agents.sort();
        TrommiRoom {
            recovery_signature_key: self.public().to_vec(),
            recovery_hpke_key: self.hpke_public.to_vec(),
            agents,
        }
    }
}

pub fn sign_with_label(signer: &SignatureKeyPair, label: &str, content: &[u8]) -> Vec<u8> {
    signer.sign(&enc::sign_content(label, content)).unwrap()
}

// ---- a device

pub fn caps() -> Capabilities {
    Capabilities::new(
        Some(&[ProtocolVersion::Mls10]),
        Some(&[SUITE]),
        Some(&[
            ExtensionType::Unknown(EXT_ROOM),
            ExtensionType::Unknown(EXT_SESSION),
            ExtensionType::LastResort,
        ]),
        Some(&[]),
        Some(&[CredentialType::Basic]),
    )
}

fn context_extensions(ext: Extension) -> Extensions<GroupContext> {
    Extensions::from_vec(vec![
        Extension::RequiredCapabilities(RequiredCapabilitiesExtension::new(
            &[
                ExtensionType::Unknown(EXT_ROOM),
                ExtensionType::Unknown(EXT_SESSION),
            ],
            &[],
            &[CredentialType::Basic],
        )),
        ext,
    ])
    .unwrap()
}

pub fn room_extensions(room: &TrommiRoom) -> Extensions<GroupContext> {
    context_extensions(Extension::Unknown(EXT_ROOM, UnknownExtension(room.bytes())))
}

fn ten_years() -> Lifetime {
    Lifetime::new(10 * 365 * 86_400)
}

/// A Commit as a device built it, with what travels beside it.
#[derive(Debug, Clone)]
pub struct Out {
    pub group_id: Vec<u8>,
    pub epoch: u64,
    pub commit: Vec<u8>,
    pub group_info: Vec<u8>,
    pub welcome: Option<Vec<u8>>,
}

#[derive(Default, Clone)]
pub struct Change {
    pub adds: Vec<Vec<u8>>,
    pub removes: Vec<[u8; 32]>,
    pub room: Option<TrommiRoom>,
    pub cuts: Vec<Cut>,
    /// the note's fields, when a test wants them wrong
    pub note: Option<CommitNote>,
}

/// What an envelope shall be: the test's side of `Header`.
#[derive(Clone)]
pub struct Item {
    pub kind: u8,
    pub flags: u8,
    pub recipient: [u8; 32],
    pub subject: Subject,
    pub file_ids: Vec<[u8; 16]>,
    pub payload: Vec<u8>,
}

pub struct Dev {
    pub provider: OpenMlsRustCrypto,
    pub signer: SignatureKeyPair,
    pub credential: CredentialWithKey,
    pub groups: HashMap<Vec<u8>, MlsGroup>,
    /// per group: number and hash of this device's last envelope
    pub chains: HashMap<Vec<u8>, (u64, [u8; 32])>,
    pub token: Option<String>,
    pub lease: Option<u64>,
    pub room: [u8; 32],
    /// a header the test adds to every request (the address the request seems to come from)
    pub ip: Option<String>,
}

impl Dev {
    pub fn new() -> Dev {
        let signer = SignatureKeyPair::new(SignatureScheme::ED25519).unwrap();
        let credential = CredentialWithKey {
            credential: BasicCredential::new(signer.to_public_vec()).into(),
            signature_key: signer.to_public_vec().into(),
        };
        Dev {
            provider: OpenMlsRustCrypto::default(),
            signer,
            credential,
            groups: HashMap::new(),
            chains: HashMap::new(),
            token: None,
            lease: None,
            room: [0; 32],
            ip: None,
        }
    }

    pub fn id(&self) -> [u8; 32] {
        self.signer.to_public_vec().try_into().unwrap()
    }

    pub fn sign(&self, label: &str, content: &[u8]) -> Vec<u8> {
        sign_with_label(&self.signer, label, content)
    }

    // -- MLS

    pub fn key_package(&self, last_resort: bool) -> Vec<u8> {
        let mut b = KeyPackage::builder()
            .leaf_node_capabilities(caps())
            .key_package_lifetime(ten_years());
        if last_resort {
            b = b.mark_as_last_resort();
        }
        let bundle = b
            .build(SUITE, &self.provider, &self.signer, self.credential.clone())
            .unwrap();
        MlsMessageOut::from(bundle.key_package().clone())
            .to_bytes()
            .unwrap()
    }

    fn join_config(&self) -> MlsGroupJoinConfig {
        MlsGroupJoinConfig::builder()
            .wire_format_policy(PURE_PLAINTEXT_WIRE_FORMAT_POLICY)
            .use_ratchet_tree_extension(true)
            .max_past_epochs(0)
            .build()
    }

    fn found(&mut self, group_id: &[u8], extensions: Extensions<GroupContext>) -> Vec<u8> {
        let config = MlsGroupCreateConfig::builder()
            .wire_format_policy(PURE_PLAINTEXT_WIRE_FORMAT_POLICY)
            .use_ratchet_tree_extension(true)
            .max_past_epochs(0)
            .ciphersuite(SUITE)
            .capabilities(caps())
            .lifetime(ten_years())
            .with_group_context_extensions(extensions)
            .build();
        let group = MlsGroup::new_with_group_id(
            &self.provider,
            &self.signer,
            &config,
            GroupId::from_slice(group_id),
            self.credential.clone(),
        )
        .unwrap();
        let info = group
            .export_group_info(self.provider.crypto(), &self.signer, true)
            .unwrap()
            .to_bytes()
            .unwrap();
        self.groups.insert(group_id.to_vec(), group);
        info
    }

    /// Creates the room group; returns its GroupInfo of epoch 0.
    pub fn create_room(&mut self, room_id: &[u8; 32], recovery: &Recovery) -> Vec<u8> {
        self.room = *room_id;
        self.found(room_id, room_extensions(&recovery.room_ext(&[])))
    }

    /// Creates a session group; returns its id and its GroupInfo of epoch 0.
    pub fn create_session(
        &mut self,
        session_id: &[u8; 16],
        parent: &[u8; 16],
    ) -> (Vec<u8>, Vec<u8>) {
        let session = TrommiSession {
            room_id: self.room,
            session_id: *session_id,
            parent: *parent,
        };
        let group_id = [&self.room[..], &session_id[..]].concat();
        let info = self.found(
            &group_id,
            context_extensions(Extension::Unknown(
                EXT_SESSION,
                UnknownExtension(session.bytes()),
            )),
        );
        (group_id, info)
    }

    pub fn group(&self, group_id: &[u8]) -> &MlsGroup {
        self.groups
            .get(group_id)
            .expect("this device is not in that group")
    }

    pub fn epoch(&self, group_id: &[u8]) -> u64 {
        self.group(group_id).epoch().as_u64()
    }

    pub fn members(&self, group_id: &[u8]) -> Vec<[u8; 32]> {
        self.group(group_id)
            .members()
            .map(|m| m.signature_key.try_into().unwrap())
            .collect()
    }

    /// (room epoch, room state) as this human device's room group stands: what a Commit's note names.
    pub fn room_now(&self) -> (u64, [u8; 32]) {
        let group = self.group(&self.room);
        let context = group
            .public_group()
            .group_context()
            .tls_serialize_detached()
            .unwrap();
        (
            group.epoch().as_u64(),
            enc::ref_hash("Trommi Room State", &context),
        )
    }

    /// Builds a Commit and leaves it pending: `merge` once the hub accepted it, `clear` if not. `room`: the room
    /// epoch and state the note names.
    pub fn commit(&mut self, group_id: &[u8], change: &Change, room: (u64, [u8; 32])) -> Out {
        let key_packages: Vec<KeyPackage> = change
            .adds
            .iter()
            .map(|bytes| {
                let MlsMessageBodyIn::KeyPackage(kp) =
                    MlsMessageIn::tls_deserialize(&mut &bytes[..])
                        .unwrap()
                        .extract()
                else {
                    panic!("not a KeyPackage")
                };
                kp.validate(self.provider.crypto(), ProtocolVersion::Mls10)
                    .unwrap()
            })
            .collect();
        let note = change.note.clone().unwrap_or(CommitNote {
            room_epoch: room.0,
            room_state: room.1,
            time: trommi_hub::util::now(),
            cuts: change.cuts.clone(),
            join: false,
        });
        let group = self
            .groups
            .get_mut(group_id)
            .expect("this device is not in that group");
        let epoch = group.epoch().as_u64();
        let leaves: Vec<LeafNodeIndex> = group
            .members()
            .filter(|m| change.removes.iter().any(|r| r[..] == m.signature_key[..]))
            .map(|m| m.index)
            .collect();
        assert_eq!(
            leaves.len(),
            change.removes.len(),
            "a device to remove is not a leaf"
        );
        group.set_aad(note.bytes());
        let only_adds = !key_packages.is_empty() && leaves.is_empty() && change.room.is_none();
        let mut builder = group
            .commit_builder()
            .consume_proposal_store(false)
            .propose_adds(key_packages)
            .propose_removals(leaves)
            .force_self_update(!only_adds);
        if let Some(room) = &change.room {
            builder = builder
                .propose_group_context_extensions(room_extensions(room))
                .unwrap();
        }
        let bundle = builder
            .load_psks(self.provider.storage())
            .unwrap()
            .create_group_info(true)
            .use_ratchet_tree_extension(true)
            .build(
                self.provider.rand(),
                self.provider.crypto(),
                &self.signer,
                |_| true,
            )
            .unwrap()
            .stage_commit(&self.provider)
            .unwrap();
        let (commit, welcome, info) = bundle.into_contents();
        Out {
            group_id: group_id.to_vec(),
            epoch,
            commit: commit.to_bytes().unwrap(),
            group_info: MlsMessageOut::from(info.unwrap()).to_bytes().unwrap(),
            welcome: welcome.map(|w| {
                MlsMessageOut::from_welcome(w, ProtocolVersion::Mls10)
                    .to_bytes()
                    .unwrap()
            }),
        }
    }

    pub fn merge(&mut self, group_id: &[u8]) {
        let group = self.groups.get_mut(group_id).unwrap();
        if group.pending_commit().is_some() {
            group.merge_pending_commit(&self.provider).unwrap();
        }
    }

    pub fn clear(&mut self, group_id: &[u8]) {
        self.groups
            .get_mut(group_id)
            .unwrap()
            .clear_pending_commit(self.provider.storage())
            .unwrap();
    }

    /// Processes another device's Commit from the log.
    pub fn process(&mut self, group_id: &[u8], commit: &[u8]) -> Result<(), String> {
        let group = self.groups.get_mut(group_id).ok_or("not in that group")?;
        let message = MlsMessageIn::tls_deserialize(&mut &commit[..])
            .map_err(|e| format!("{e:?}"))?
            .try_into_protocol_message()
            .map_err(|e| format!("{e:?}"))?;
        let processed = group
            .process_message(&self.provider, message)
            .map_err(|e| format!("{e:?}"))?;
        match processed.into_content() {
            ProcessedMessageContent::StagedCommitMessage(staged) => group
                .merge_staged_commit(&self.provider, *staged)
                .map_err(|e| format!("{e:?}")),
            _ => Err("not a Commit".into()),
        }
    }

    pub fn join(&mut self, welcome: &[u8]) -> Vec<u8> {
        let MlsMessageBodyIn::Welcome(w) = MlsMessageIn::tls_deserialize(&mut &welcome[..])
            .unwrap()
            .extract()
        else {
            panic!("not a Welcome")
        };
        let group = StagedWelcome::new_from_welcome(&self.provider, &self.join_config(), w, None)
            .unwrap()
            .into_group(&self.provider)
            .unwrap();
        let id = group.group_id().as_slice().to_vec();
        self.groups.insert(id.clone(), group);
        id
    }

    /// A join from outside (8.4): the external Commit on a GroupInfo. The group stands in the new epoch at once;
    /// `forget` it if the hub refuses.
    pub fn external_join(&mut self, group_info: &[u8], room: (u64, [u8; 32])) -> Out {
        let MlsMessageBodyIn::GroupInfo(info) = MlsMessageIn::tls_deserialize(&mut &group_info[..])
            .unwrap()
            .extract()
        else {
            panic!("not a GroupInfo")
        };
        let note = CommitNote {
            room_epoch: room.0,
            room_state: room.1,
            time: trommi_hub::util::now(),
            cuts: vec![],
            join: true,
        };
        let (group, bundle) = MlsGroup::external_commit_builder()
            .with_config(self.join_config())
            .with_aad(note.bytes())
            .build_group(&self.provider, info, self.credential.clone())
            .unwrap()
            .leaf_node_parameters(
                LeafNodeParameters::builder()
                    .with_capabilities(caps())
                    .build(),
            )
            .load_psks(self.provider.storage())
            .unwrap()
            .create_group_info(true)
            .use_ratchet_tree_extension(true)
            .build(
                self.provider.rand(),
                self.provider.crypto(),
                &self.signer,
                |_| true,
            )
            .unwrap()
            .finalize(&self.provider)
            .unwrap();
        let group_id = group.group_id().as_slice().to_vec();
        let epoch = group.epoch().as_u64() - 1;
        let (commit, _, info) = bundle.into_contents();
        self.groups.insert(group_id.clone(), group);
        Out {
            group_id,
            epoch,
            commit: commit.to_bytes().unwrap(),
            group_info: MlsMessageOut::from(info.unwrap()).to_bytes().unwrap(),
            welcome: None,
        }
    }

    pub fn forget(&mut self, group_id: &[u8]) {
        self.groups.remove(group_id);
    }

    pub fn application_message(&mut self, group_id: &[u8], plain: &[u8]) -> Vec<u8> {
        let group = self.groups.get_mut(group_id).unwrap();
        group
            .create_message(&self.provider, &self.signer, plain)
            .unwrap()
            .to_bytes()
            .unwrap()
    }

    pub fn content_key(&self, group_id: &[u8]) -> [u8; 32] {
        self.group(group_id)
            .export_secret(self.provider.crypto(), "trommi content", &[], 32)
            .unwrap()
            .try_into()
            .unwrap()
    }

    // -- the structs beside a Commit

    /// A SealedKey of the right shape. The hub cannot open the sealing or check the tag; neither is real here.
    pub fn sealed_key(
        &self,
        group_id: &[u8],
        epoch: u64,
        group_info: &[u8],
        room_epoch: u64,
        hpke_public: &[u8],
        tag: bool,
    ) -> Vec<u8> {
        wire::SealedKey {
            context: wire::KeyContext {
                group_id: group_id.to_vec(),
                epoch,
                group_info: enc::ref_hash("Trommi Group Info", group_info),
            },
            room_epoch,
            recovery_hpke_key: hpke_public.to_vec(),
            kem_output: random::<32>().to_vec(),
            ciphertext: random::<48>().to_vec(),
            writer: self.id(),
            mac: if tag { random::<32>().to_vec() } else { vec![] },
        }
        .bytes()
    }

    // -- envelopes (section 9)

    pub fn chain(&self, group_id: &[u8]) -> (u64, [u8; 32]) {
        self.chains.get(group_id).copied().unwrap_or((0, ZERO32))
    }

    /// An envelope with every field given: for the tests that get a field wrong.
    pub fn build_envelope(
        &self,
        group_id: &[u8],
        epoch: u64,
        seq: u64,
        prev: [u8; 32],
        item: &Item,
        key: &[u8; 32],
    ) -> (Vec<u8>, [u8; 32]) {
        let header = Header {
            kind: item.kind,
            flags: item.flags,
            group_id: group_id.to_vec(),
            epoch,
            sender: self.id(),
            seq,
            prev,
            recipient: item.recipient,
            time: trommi_hub::util::now(),
            subject: item.subject.clone(),
            file_ids: item.file_ids.clone(),
        }
        .bytes();
        // Body: version, bind, payload; zero bytes up to the next of 256, 512 … 65536
        let mut padded = enc::body(&[], &item.payload);
        padded.resize(padded.len().next_power_of_two().max(256), 0);
        let nonce = random::<12>();
        let ciphertext = ChaCha20Poly1305::new(key.into())
            .encrypt(
                (&nonce).into(),
                Payload {
                    msg: &padded,
                    aad: &header,
                },
            )
            .unwrap();
        let body_hash: [u8; 32] = Sha256::digest(&ciphertext).into();
        let hash = enc::envelope_hash(&header, &nonce, &body_hash);
        let signature = self.sign("TrommiEnvelope", &hash);
        (
            enc::envelope(&header, &nonce, &ciphertext, &signature),
            hash,
        )
    }

    /// The next envelope of this device's chain in a group, in the group's current epoch. The chain advances.
    pub fn envelope(&mut self, group_id: &[u8], item: &Item) -> (Vec<u8>, [u8; 32]) {
        let (seq, prev) = self.chain(group_id);
        let key = self.content_key(group_id);
        let built = self.build_envelope(group_id, self.epoch(group_id), seq + 1, prev, item, &key);
        self.chains.insert(group_id.to_vec(), (seq + 1, built.1));
        built
    }

    // -- the hub

    pub fn headers(&self) -> Vec<(&'static str, String)> {
        let mut h = vec![];
        if let Some(t) = &self.token {
            h.push(("authorization", format!("Bearer {t}")));
        }
        if let Some(l) = self.lease {
            h.push(("trommi-lease", l.to_string()));
        }
        if let Some(ip) = &self.ip {
            h.push(("cf-connecting-ip", ip.clone()));
        }
        h
    }

    pub fn call(&self, hub: &TestHub, method: &str, path: &str, body: &Value) -> Reply {
        let bytes = if body.is_null() {
            vec![]
        } else {
            body.to_string().into_bytes()
        };
        request(hub.port, method, path, &self.headers(), &bytes)
    }

    pub fn get(&self, hub: &TestHub, path: &str) -> Reply {
        self.call(hub, "GET", path, &Value::Null)
    }

    pub fn post(&self, hub: &TestHub, path: &str, body: &Value) -> Reply {
        self.call(hub, "POST", path, body)
    }

    pub fn put(&self, hub: &TestHub, path: &str, body: &Value) -> Reply {
        self.call(hub, "PUT", path, body)
    }

    pub fn raw(
        &self,
        hub: &TestHub,
        method: &str,
        path: &str,
        extra: &[(&'static str, String)],
        body: &[u8],
    ) -> Reply {
        let mut headers = self.headers();
        headers.extend_from_slice(extra);
        request(hub.port, method, path, &headers, body)
    }

    /// Signs in to the hub with a signed challenge (12.3) under this device's key.
    pub fn sign_in(&mut self, hub: &TestHub, room: &[u8; 32]) -> Reply {
        self.room = *room;
        let reply = sign_in_with(hub, room, &self.signer, None);
        if reply.status == 200 {
            self.token = reply.json()["token"].as_str().map(str::to_string);
        }
        reply
    }

    pub fn events(&self, hub: &TestHub, after: Option<i64>) -> Events {
        let path = match after {
            Some(n) => format!("/v2/stream?after={n}"),
            None => "/v2/stream".to_string(),
        };
        let socket = send_request(hub.port, "GET", &path, &self.headers(), &[]);
        let mut reader = BufReader::new(socket);
        let (status, _) = read_head(&mut reader);
        Events { reader, status }
    }

    /// Posts a Commit with its GroupInfo, Welcome and SealedKey; merges it if the hub took it, clears it if not.
    pub fn post_commit(&mut self, hub: &TestHub, out: &Out, sealed_key: &[u8]) -> Reply {
        let reply = self.post(
            hub,
            &format!("/v2/groups/{}/commits", b64(&out.group_id)),
            &commit_json(out, sealed_key, None),
        );
        if reply.status == 200 {
            self.merge(&out.group_id);
        } else {
            self.clear(&out.group_id);
        }
        reply
    }

    pub fn post_envelope(&self, hub: &TestHub, envelope: &[u8]) -> Reply {
        self.post(hub, "/v2/envelopes", &json!({ "envelope": b64(envelope) }))
    }

    /// Builds the next envelope and posts it; the chain keeps the number only if the hub stored it (also as a
    /// void record).
    pub fn send(&mut self, hub: &TestHub, group_id: &[u8], item: &Item) -> Reply {
        let before = self.chain(group_id);
        let (envelope, _) = self.envelope(group_id, item);
        let reply = self.post_envelope(hub, &envelope);
        let stored = reply.status == 200 || reply.json()["voided"] == true;
        if !stored {
            self.chains.insert(group_id.to_vec(), before);
        }
        reply
    }

    /// Encrypts and posts an application message in the group's current epoch.
    pub fn post_message(
        &mut self,
        hub: &TestHub,
        group_id: &[u8],
        plain: &[u8],
        relay: bool,
    ) -> Reply {
        let epoch = self.epoch(group_id);
        let message = self.application_message(group_id, plain);
        self.post(
            hub,
            &format!("/v2/groups/{}/messages", b64(group_id)),
            &json!({ "epoch": epoch, "message": b64(&message), "relay": relay }),
        )
    }

    /// Acquires this agent device's lease as a new process (13.7).
    pub fn link(&mut self, hub: &TestHub) -> Reply {
        self.lease = None;
        let reply = self.post(hub, "/v2/link", &json!({ "process": b64(&random::<16>()), "hears": true, "working": false, "last_call_at": 0 }));
        self.lease = reply.json()["generation"].as_u64();
        reply
    }

    pub fn upload_key_packages(&self, hub: &TestHub, single_use: usize) -> Reply {
        let packages: Vec<String> = (0..single_use)
            .map(|_| b64(&self.key_package(false)))
            .collect();
        self.put(
            hub,
            "/v2/key-packages",
            &json!({ "single_use": packages, "last_resort": b64(&self.key_package(true)) }),
        )
    }
}

/// The body of `POST …/recovery-code` from a flat one: the Commit's fields go under `commit`.
pub fn code_body(flat: &Value) -> Value {
    let mut out = flat.clone();
    let mut commit = json!({});
    for field in [
        "epoch",
        "commit",
        "group_info",
        "welcome",
        "sealed_key",
        "recovery_auth",
    ] {
        if let Some(v) = out.as_object_mut().and_then(|o| o.remove(field)) {
            commit[field] = v;
        }
    }
    out["commit"] = commit;
    out
}

/// Guesses wrong until the guesser is told to wait at least `at_least` seconds, moving the hub's clock over each
/// shorter wait; returns the waits it was told. Afterwards that wait is still running: the next request of the
/// same source is refused however slow the machine is (a test must not lean on a one-second back-off still
/// holding after a slow hash).
pub fn slowed(hub: &TestHub, at_least: i64, mut guess: impl FnMut() -> Reply) -> Vec<i64> {
    let mut waits = vec![];
    for _ in 0..40 {
        let reply = guess();
        if reply.status != 429 {
            assert_eq!(
                reply.status,
                401,
                "{}",
                String::from_utf8_lossy(&reply.body)
            );
            continue;
        }
        let wait: i64 = reply
            .header("retry-after")
            .expect("a wait")
            .parse()
            .unwrap();
        waits.push(wait);
        if wait >= at_least {
            return waits;
        }
        hub.clock(wait * 1000);
    }
    panic!("never slowed down to {at_least} s: {waits:?}");
}

pub fn commit_json(out: &Out, sealed_key: &[u8], recovery_auth: Option<&[u8]>) -> Value {
    json!({
        "epoch": out.epoch, "commit": b64(&out.commit), "group_info": b64(&out.group_info), "welcome": out.welcome.as_deref().map(b64),
        "sealed_key": b64(sealed_key), "recovery_auth": recovery_auth.map(b64),
    })
}

/// Signs in with any key: a device's, or the room's recovery signature key. `hub_address`: what the signed
/// `HubAuth` names; the hub's own when `None`.
pub fn sign_in_with(
    hub: &TestHub,
    room: &[u8; 32],
    key: &SignatureKeyPair,
    hub_address: Option<&str>,
) -> Reply {
    let challenge = hub.get(&format!("/v2/rooms/{}/challenge", b64(room))).ok();
    let challenge: [u8; 32] = unb64(challenge["challenge"].as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap();
    let auth = wire::HubAuth {
        room_id: *room,
        hub: hub_address.unwrap_or(&hub.url).as_bytes().to_vec(),
        device: key.to_public_vec().try_into().unwrap(),
        challenge,
    }
    .bytes();
    let signature = sign_with_label(key, "TrommiHubAuth", &auth);
    hub.post(
        &format!("/v2/rooms/{}/tokens", b64(room)),
        &json!({ "auth": b64(&auth), "signature": b64(&signature) }),
    )
}

/// The RecoveryAuth of a join from outside (8.4): the recovery key's signature over the join and its Commit.
pub fn recovery_auth(
    recovery: &SignatureKeyPair,
    out: &Out,
    base_group_info: &[u8],
    room: (u64, [u8; 32]),
    joiner: &[u8; 32],
) -> Vec<u8> {
    let mut auth = wire::RecoveryAuth {
        base: wire::KeyContext {
            group_id: out.group_id.clone(),
            epoch: out.epoch,
            group_info: enc::ref_hash("Trommi Group Info", base_group_info),
        },
        room_epoch: room.0,
        room_state: room.1,
        joiner: *joiner,
        commit: enc::ref_hash("Trommi Commit", &out.commit),
        signature: vec![0; 64],
    };
    auth.signature = sign_with_label(
        recovery,
        "TrommiRecoveryJoin",
        &enc::recovery_join_and_commit(&auth),
    );
    auth.bytes()
}

// ---- items

pub fn chat(session_id: &[u8; 16], recipient: [u8; 32], text: &str) -> Item {
    Item {
        kind: wire::KIND_ITEM,
        flags: 0,
        recipient,
        subject: Subject::Item {
            timeline_kind: wire::TIMELINE_CHAT,
            timeline_scope: wire::SCOPE_SESSION,
            timeline_ref: *session_id,
        },
        file_ids: vec![],
        payload: json!({ "schema_version": 2, "content_type": "message", "text": text })
            .to_string()
            .into_bytes(),
    }
}

pub fn board_item(board: &[u8; 16]) -> Item {
    Item {
        kind: wire::KIND_ITEM,
        flags: 0,
        recipient: ZERO32,
        subject: Subject::Item {
            timeline_kind: wire::TIMELINE_BOARD,
            timeline_scope: wire::SCOPE_DESK,
            timeline_ref: *board,
        },
        file_ids: vec![],
        payload: br#"{"schema_version":2,"content_type":"strokes"}"#.to_vec(),
    }
}

pub fn register(register_id: &[u8; 16], value: &str) -> Item {
    Item {
        kind: wire::KIND_REGISTER,
        flags: 0,
        recipient: ZERO32,
        subject: Subject::Register {
            register_id: *register_id,
        },
        file_ids: vec![],
        payload: json!({ "name": "n", "value": value, "lamport": 1 })
            .to_string()
            .into_bytes(),
    }
}

/// An object's envelope. `object_ref`: zeros for a first version.
pub fn object(
    kind: u8,
    object_id: [u8; 16],
    object_type: u8,
    object_state: u8,
    urgency: u8,
    object_ref: [u8; 32],
    recipient: [u8; 32],
) -> Item {
    Item {
        kind,
        flags: 0,
        recipient,
        subject: Subject::Object {
            object_id,
            object_type,
            object_state,
            urgency,
            answered_at: 0,
            object_ref,
        },
        file_ids: vec![],
        payload: br#"{"schema_version":2,"title":"t"}"#.to_vec(),
    }
}

// ---- a small world: one room with its devices and sessions, built through the hub

pub struct World {
    pub hub: TestHub,
    pub room: [u8; 32],
    pub recovery: Recovery,
    /// the founder
    pub ada: Dev,
}

impl World {
    /// A hub and a room founded by one human device, signed in.
    pub fn new() -> World {
        Self::on(TestHub::start())
    }

    pub fn on(hub: TestHub) -> World {
        let (room, recovery, ada) = found_room(&hub);
        World {
            hub,
            room,
            recovery,
            ada,
        }
    }
}

pub fn found_room(hub: &TestHub) -> ([u8; 32], Recovery, Dev) {
    let room: [u8; 32] = random();
    let recovery = Recovery::new();
    let mut ada = Dev::new();
    let info = ada.create_room(&room, &recovery);
    let sealed = ada.sealed_key(&room, 0, &info, 0, &recovery.hpke_public, true);
    hub.post(
        "/v2/rooms",
        &json!({ "group_info": b64(&info), "sealed_key": b64(&sealed) }),
    )
    .ok();
    ada.sign_in(hub, &room).ok();
    ada.upload_key_packages(hub, 5).ok();
    (room, recovery, ada)
}

/// The invite ceremony's three messages at the hub (12.1), up to the Reveal: after it the room group takes the
/// new device's KeyPackage (role 1) or key (role 2) from this inviter. Returns the KeyPackage of the Request.
pub fn invite(
    hub: &TestHub,
    inviter: &Dev,
    newcomer: &Dev,
    role: u8,
    session_id: [u8; 16],
) -> (Vec<u8>, [u8; 16]) {
    let secret: [u8; 32] = random();
    let nonce: [u8; 32] = random();
    let invite_id: [u8; 16] = random();
    let (room_epoch, room_state) = inviter.room_now();
    let offer = wire::Offer {
        room_id: inviter.room,
        invite_id,
        role,
        session_id,
        expires_at: trommi_hub::util::now() + 600_000,
        commitment: enc::ref_hash(
            "Trommi Invite Commitment",
            &[&invite_id[..], &nonce[..]].concat(),
        ),
        inviter: inviter.id(),
        room_epoch,
        room_state,
    }
    .bytes();
    inviter.post(hub, "/v2/invites", &json!({ "offer": b64(&offer), "signature": b64(&inviter.sign("TrommiInviteOffer", &offer)), "mac": b64(&[9u8; 32]) })).ok();
    let key_package = newcomer.key_package(false);
    let request = wire::InviteRequest {
        room_id: inviter.room,
        invite_id,
        hub: hub.url.as_bytes().to_vec(),
        role,
        key_package: key_package.clone(),
        offer_hash: enc::ref_hash("Trommi Invite Offer", &offer),
    }
    .bytes();
    // the MAC under the link's secret: the hub cannot check it
    let mac = Sha256::digest([&secret[..], &request[..]].concat()).to_vec();
    let signed = [&request[..], &mac[..]].concat();
    hub.post(
        &format!("/v2/invites/{}/request", b64(&invite_id)),
        &json!({ "request": b64(&request), "mac": b64(&mac), "signature": b64(&newcomer.sign("TrommiInviteRequest", &signed)) }),
    )
    .ok();
    let reveal = wire::Reveal {
        invite_id,
        nonce,
        request_hash: enc::ref_hash("Trommi Invite Request", &signed),
    }
    .bytes();
    inviter.put(hub, &format!("/v2/invites/{}/reveal", b64(&invite_id)), &json!({ "reveal": b64(&reveal), "signature": b64(&inviter.sign("TrommiInviteReveal", &reveal)) })).ok();
    (key_package, invite_id)
}

impl World {
    /// Adds a human device by link: invite, the Add in the room group, the Welcome; then every live session
    /// group (5.2.7). Returns the device, signed in.
    /// Founds a helper session under `session` by its opener, with every human device named and the given
    /// helper devices; the opener merges. Returns the group id, the reply and the Commit.
    pub fn found_helper(
        &self,
        opener: &mut Dev,
        session: &[u8; 16],
        humans: &[[u8; 32]],
        helpers: &[&Dev],
    ) -> (Vec<u8>, Reply, Out) {
        let now = self.ada.room_now();
        let mut adds = self.claim(opener, humans);
        adds.extend(helpers.iter().map(|h| h.key_package(false)));
        let (group, info0) = opener.create_session(&random(), session);
        let key0 = opener.sealed_key(&group, 0, &info0, now.0, &self.recovery.hpke_public, false);
        let out = opener.commit(
            &group,
            &Change {
                adds,
                ..Default::default()
            },
            now,
        );
        let key1 = opener.sealed_key(
            &group,
            1,
            &out.group_info,
            now.0,
            &self.recovery.hpke_public,
            false,
        );
        let reply = opener.post(
            &self.hub,
            "/v2/groups",
            &founding_json(&info0, &key0, &out, &key1),
        );
        if reply.status == 200 {
            opener.merge(&group);
        } else {
            opener.forget(&group);
        }
        (group, reply, out)
    }

    pub fn add_human(&mut self) -> Dev {
        let mut dev = Dev::new();
        let (key_package, _) = invite(&self.hub, &self.ada, &dev, 1, ZERO16);
        let room = self.room;
        let now = self.ada.room_now();
        let out = self.ada.commit(
            &room,
            &Change {
                adds: vec![key_package],
                ..Default::default()
            },
            now,
        );
        let sealed = self.ada.sealed_key(
            &room,
            out.epoch + 1,
            &out.group_info,
            out.epoch,
            &self.recovery.hpke_public,
            true,
        );
        self.ada.post_commit(&self.hub, &out, &sealed).ok();
        dev.join(out.welcome.as_ref().unwrap());
        dev.sign_in(&self.hub, &room).ok();
        dev.upload_key_packages(&self.hub, 5).ok();
        dev
    }

    /// Enrols an agent device by link: its key goes into `agents`. Returns the device, signed in.
    pub fn enrol_agent(&mut self) -> Dev {
        let mut dev = Dev::new();
        invite(&self.hub, &self.ada, &dev, 2, ZERO16);
        let mut agents = self.agents();
        agents.push(dev.id());
        self.set_agents(&agents).ok();
        dev.sign_in(&self.hub, &self.room).ok();
        dev.link(&self.hub);
        dev.upload_key_packages(&self.hub, 5).ok();
        dev
    }

    /// The agent leaf of a session group, as the hub lists it.
    pub fn agent_of(&self, group: &[u8]) -> [u8; 32] {
        let agents = self.agents();
        let list = self
            .ada
            .get(&self.hub, &format!("/v2/rooms/{}/groups", b64(&self.room)))
            .ok();
        let row = list
            .as_array()
            .unwrap()
            .iter()
            .find(|g| g["group_id"] == b64(group))
            .unwrap()
            .clone();
        row["leaves"]
            .as_array()
            .unwrap()
            .iter()
            .map(|l| <[u8; 32]>::try_from(unb64(l.as_str().unwrap()).unwrap()).unwrap())
            .find(|l| agents.contains(l))
            .expect("the session has an agent leaf")
    }

    pub fn agents(&self) -> Vec<[u8; 32]> {
        let ext = self
            .ada
            .group(&self.room)
            .extensions()
            .unknown(EXT_ROOM)
            .unwrap()
            .0
            .clone();
        TrommiRoom::parse(&ext).unwrap().agents
    }

    /// A room Commit that sets `agents`.
    pub fn set_agents(&mut self, agents: &[[u8; 32]]) -> Reply {
        let room = self.room;
        let now = self.ada.room_now();
        let out = self.ada.commit(
            &room,
            &Change {
                room: Some(self.recovery.room_ext(agents)),
                ..Default::default()
            },
            now,
        );
        let sealed = self.ada.sealed_key(
            &room,
            out.epoch + 1,
            &out.group_info,
            out.epoch,
            &self.recovery.hpke_public,
            true,
        );
        self.ada.post_commit(&self.hub, &out, &sealed)
    }

    pub fn claim(&self, by: &Dev, devices: &[[u8; 32]]) -> Vec<Vec<u8>> {
        let ids: Vec<String> = devices.iter().map(|d| b64(d)).collect();
        let reply = by
            .post(
                &self.hub,
                "/v2/key-packages/claim",
                &json!({ "devices": ids }),
            )
            .ok();
        devices
            .iter()
            .map(|d| unb64(reply["key_packages"][b64(d)].as_str().unwrap()).unwrap())
            .collect()
    }

    /// Founds a main session by `ada` with every other human device in `humans` and, if given, its agent
    /// device. Everyone joins from the Welcome. Returns the session id and the group id.
    pub fn found_main(
        &mut self,
        humans: &mut [&mut Dev],
        agent: Option<&mut Dev>,
    ) -> ([u8; 16], Vec<u8>) {
        // 5.2.5: a main session is founded with its agent device; a test that names none gets one of its own
        let mut spare;
        let agent = match agent {
            Some(a) => Some(a),
            None => {
                spare = self.enrol_agent();
                for h in humans.iter_mut() {
                    catch_up(&self.hub, h, &self.room);
                }
                Some(&mut spare)
            }
        };
        let session: [u8; 16] = random();
        let mut to_add: Vec<[u8; 32]> = humans.iter().map(|h| h.id()).collect();
        if let Some(a) = &agent {
            to_add.push(a.id());
        }
        let adds = if to_add.is_empty() {
            vec![]
        } else {
            self.claim(&self.ada, &to_add)
        };
        let (group, info0) = self.ada.create_session(&session, &ZERO16);
        let now = self.ada.room_now();
        let key0 = self
            .ada
            .sealed_key(&group, 0, &info0, now.0, &self.recovery.hpke_public, true);
        let out = self.ada.commit(
            &group,
            &Change {
                adds,
                ..Default::default()
            },
            now,
        );
        let key1 = self.ada.sealed_key(
            &group,
            1,
            &out.group_info,
            now.0,
            &self.recovery.hpke_public,
            true,
        );
        let reply = self.ada.post(
            &self.hub,
            "/v2/groups",
            &founding_json(&info0, &key0, &out, &key1),
        );
        reply.ok();
        self.ada.merge(&group);
        if let Some(welcome) = &out.welcome {
            for h in humans.iter_mut() {
                h.join(welcome);
            }
            if let Some(a) = agent {
                a.join(welcome);
            }
        }
        (session, group)
    }

    /// Lets a device follow a group's log from where it stands: every Commit after its own epoch.
    pub fn catch_up(&self, dev: &mut Dev, group: &[u8]) {
        catch_up(&self.hub, dev, group)
    }
}

pub fn catch_up(hub: &TestHub, dev: &mut Dev, group: &[u8]) {
    let log = dev
        .get(
            hub,
            &format!("/v2/groups/{}/log?after=0&limit=1000", b64(group)),
        )
        .ok();
    for item in log["items"].as_array().unwrap() {
        if item["kind"] == "commit" && item["epoch"].as_u64().unwrap() == dev.epoch(group) {
            dev.process(group, &unb64(item["bytes"].as_str().unwrap()).unwrap())
                .unwrap();
        }
    }
}

pub fn founding_json(info0: &[u8], key0: &[u8], out: &Out, key1: &[u8]) -> Value {
    json!({
        "group_info_0": b64(info0), "sealed_key_0": b64(key0), "commit": b64(&out.commit), "group_info": b64(&out.group_info),
        "welcome": out.welcome.as_deref().map(b64), "sealed_key": b64(key1),
    })
}

// ---- a passkey authenticator, as a browser's would answer

pub mod passkey {
    use p256::ecdsa::signature::Signer;
    use p256::ecdsa::{Signature, SigningKey};
    use sha2::{Digest, Sha256};
    use trommi_hub::util::b64;

    pub const ORIGIN: &str = "https://app.trommi.com";
    pub const RP: &str = "app.trommi.com";
    /// user present and user verified
    pub const UP_UV: u8 = 0x05;

    pub struct Authenticator {
        pub key: SigningKey,
        pub credential_id: Vec<u8>,
    }

    impl Authenticator {
        #[allow(clippy::new_without_default)]
        pub fn new() -> Self {
            Authenticator {
                key: SigningKey::random(&mut p256::elliptic_curve::rand_core::OsRng),
                credential_id: trommi_hub::util::random::<20>().to_vec(),
            }
        }
        pub fn cose(&self) -> Vec<u8> {
            let p = self.key.verifying_key().to_encoded_point(false);
            trommi_hub::webauthn::cose_es256(p.x().unwrap(), p.y().unwrap())
        }
        pub fn data(&self, rp: &str, flags: u8, attested: bool) -> Vec<u8> {
            let mut d = Sha256::digest(rp.as_bytes()).to_vec();
            d.push(flags | if attested { 0x40 } else { 0 });
            d.extend_from_slice(&7u32.to_be_bytes());
            if attested {
                d.extend_from_slice(&[0; 16]);
                d.extend_from_slice(&(self.credential_id.len() as u16).to_be_bytes());
                d.extend_from_slice(&self.credential_id);
                d.extend_from_slice(&self.cose());
            }
            d
        }
        pub fn client_data(ceremony: &str, challenge: &[u8], origin: &str) -> Vec<u8> {
            serde_json::json!({ "type": ceremony, "challenge": b64(challenge), "origin": origin, "crossOrigin": false }).to_string().into_bytes()
        }
        /// `{ "fmt": "none", "attStmt": {}, "authData": bytes }`
        pub fn attestation(&self, rp: &str, flags: u8) -> Vec<u8> {
            let data = self.data(rp, flags, true);
            let mut a = vec![0xa3, 0x63];
            a.extend_from_slice(b"fmt");
            a.push(0x64);
            a.extend_from_slice(b"none");
            a.push(0x67);
            a.extend_from_slice(b"attStmt");
            a.push(0xa0);
            a.push(0x68);
            a.extend_from_slice(b"authData");
            a.push(0x59);
            a.extend_from_slice(&(data.len() as u16).to_be_bytes());
            a.extend_from_slice(&data);
            a
        }
        /// (authenticator data, signature) over the client data
        pub fn assertion(&self, rp: &str, flags: u8, client_data: &[u8]) -> (Vec<u8>, Vec<u8>) {
            let data = self.data(rp, flags, false);
            let mut message = data.clone();
            message.extend_from_slice(&Sha256::digest(client_data));
            let signature: Signature = self.key.sign(&message);
            (data, signature.to_der().as_bytes().to_vec())
        }
    }
}
