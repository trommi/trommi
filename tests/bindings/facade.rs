//! The facade both bindings share (`core/swift/src`), called from Rust as a host would call it: what holds at
//! the edge whatever the binding, and what a scenario through a binding cannot provoke (a panicking store, a
//! store that calls back, a second owner).

use std::sync::{Arc, Mutex};
use trommi_core::hub_auth::{self, HubAddress, IssuedChallenge};
use trommi_core::ids::RoomId;
use trommi_core::store::{Batch, Loaded, Storage, StorageError};
use trommi_core_ffi::{
    account_id_parse, base64url_decode, check_emoji, envelope_header, error_code_from_text,
    error_code_text, format_recovery_code, generate_kit_words, generate_recovery_code, hub_address,
    invite_link_parse, kit_keys, kit_keys_for, log_finding, open_recovery_code,
    parse_recovery_code, recovery_anchor, recovery_sign_in, seal_recovery_code, self_test,
    versions, AccountName, AccountWay, CoreDevice, CoreError, Draft, DraftKind, ErrorCode,
    FileDecryptor, FileEncryptor, LogFinding, OutboxKind, ServedGroup, ServedRoom,
};
use trommi_tests::{now, MemoryStorage};

fn code_of<T>(result: Result<T, CoreError>) -> ErrorCode {
    match result {
        Ok(_) => panic!("the call was not refused"),
        Err(error) => error.code(),
    }
}

/// A device that founded a room, on `store`.
fn founder(store: MemoryStorage) -> (CoreDevice, Vec<u8>) {
    let device = CoreDevice::create_on(Box::new(store)).expect("a new device");
    let code = generate_recovery_code().expect("a code");
    let room = device.found_room(code, now()).expect("the room is founded");
    (device, room)
}

#[test]
fn the_self_test_passes_and_names_its_steps() {
    let report = self_test(now());
    for step in &report.steps {
        assert!(step.ok, "{}: {}", step.name, step.detail);
    }
    assert!(report.ok);
    assert_eq!(report.steps.len(), 12);
    assert_eq!(report.versions, versions());
}

#[test]
fn the_versions_are_the_workspace_pins() {
    let manifest = include_str!("../../Cargo.toml");
    let reported = versions();
    assert!(manifest.contains(&format!("openmls = {{ version = \"={}\"", reported.openmls)));
    let (provider, version) = reported.provider.split_once(' ').expect("name and version");
    assert!(manifest.contains(&format!("{provider} = \"={version}\"")));
    assert_eq!(reported.core, trommi_core::VERSION);
    let swift = include_str!("../../core/swift/Cargo.toml");
    assert!(swift.contains("uniffi = { version = \"=0.32.2\""));
    assert!(reported.binding.contains("UniFFI 0.32.2"));
    assert!(include_str!("../../core/wasm/Cargo.toml").contains("wasm-bindgen = \"=0.2.129\""));
}

#[test]
fn every_code_of_section_16_is_a_case_with_its_spelling() {
    let spec = include_str!("../../spec/v1.md");
    let section = spec
        .split("\n## 16. ")
        .nth(1)
        .and_then(|rest| rest.split("\n## 17. ").next())
        .expect("section 16");
    let tables = section
        .split("| Status | Codes |")
        .nth(1)
        .expect("the code tables");
    let mut seen = 0;
    // Every name in backticks there is a code, but for the library's own name.
    for text in tables
        .split('`')
        .skip(1)
        .step_by(2)
        .filter(|text| *text != "trommi-core")
    {
        let code = error_code_from_text(text.to_owned()).unwrap_or_else(|| panic!("{text}"));
        assert_eq!(error_code_text(code), text);
        seen += 1;
    }
    assert!(seen > 50);
    // Every case has a spelling of its own, and the core's errors arrive under their own code.
    for code in ErrorCode::ALL {
        assert_eq!(ErrorCode::from_text(code.text()), Some(*code));
        if let Some(error) = trommi_core::Error::from_code(code.text()) {
            assert_eq!(CoreError::from(error).code(), *code);
        }
    }
    assert_eq!(error_code_from_text("no-such-code".to_owned()), None);
    assert_eq!(log_finding(ErrorCode::GroupBehind), LogFinding::Early);
    assert_eq!(log_finding(ErrorCode::WrongEpoch), LogFinding::Duplicate);
    assert_eq!(log_finding(ErrorCode::BadSignature), LogFinding::BadGroup);
    assert_eq!(log_finding(ErrorCode::Storage), LogFinding::Local);
}

#[test]
fn arguments_of_the_wrong_shape_are_bad_format() {
    let (device, _) = founder(MemoryStorage::new());
    assert_eq!(code_of(device.group(vec![1; 31])), ErrorCode::BadFormat);
    assert_eq!(
        code_of(device.found_room(vec![1; 31], now())),
        ErrorCode::BadFormat
    );
    assert_eq!(
        code_of(device.hub_sign_in("https://hub.example".into(), vec![0; 31])),
        ErrorCode::BadFormat
    );
    assert_eq!(
        code_of(device.hub_sign_in("HTTPS://Hub.Example/".into(), vec![0; 32])),
        ErrorCode::BadFormat
    );
    assert_eq!(
        code_of(base64url_decode("a=".to_owned())),
        ErrorCode::BadFormat
    );
}

#[test]
fn a_draft_that_lacks_what_its_kind_needs_is_bad_format_and_uses_no_number() {
    let (device, room) = founder(MemoryStorage::new());
    let empty = Draft {
        kind: DraftKind::SessionChat,
        session: None,
        card: None,
        board: None,
        group: None,
        name: None,
        value: None,
        object_id: None,
        request_id: None,
        choices: None,
        closes: None,
        closed: None,
        allow: None,
        urgency: None,
        push: None,
        expires_at: None,
        payload: Some(b"{}".to_vec()),
    };
    assert_eq!(
        code_of(device.seal(empty.clone(), None, Vec::new(), now())),
        ErrorCode::BadFormat
    );
    // Nothing is filled in for a field a kind names: a version says whether it closes.
    let version = Draft {
        kind: DraftKind::NoteVersion,
        object_id: Some(vec![1; 16]),
        ..empty.clone()
    };
    assert_eq!(
        code_of(device.seal(version, None, Vec::new(), now())),
        ErrorCode::BadFormat
    );
    assert_eq!(format!("{empty:?}"), "Draft(<redacted>)");
    let id = device.id().expect("an id");
    assert_eq!(
        device
            .chain_head(room.clone(), id.clone())
            .expect("a head")
            .seq,
        0
    );
    assert_eq!(device.cut_of(room.clone(), id).expect("a Cut").seq, 0);
    assert!(device.objects(room.clone()).expect("objects").is_empty());
    assert!(device.findings().expect("findings").is_empty());
    assert!(device.commands_pending().expect("commands").is_empty());
    // Bytes that are no envelope at all are refused, and the cursor stays.
    assert_eq!(
        code_of(device.receive_envelope(vec![1, 2, 3], 5, true, None, now())),
        ErrorCode::BadFormat
    );
    assert_eq!(device.cursor().expect("a cursor"), 0);
    assert_eq!(check_emoji().len(), 64);
    assert_eq!(
        code_of(hub_address("HTTPS://Hub.Example/".into())),
        ErrorCode::BadFormat
    );
    assert_eq!(
        code_of(invite_link_parse("https://app.example/join#v2.x".into())),
        ErrorCode::BadFormat
    );
}

#[test]
fn the_account_vectors_hold_through_the_facade() {
    let vectors: serde_json::Value =
        serde_json::from_str(include_str!("../../spec/vectors/account.json")).expect("the vectors");
    let text = |key: &str| vectors[key].as_str().expect("text").to_owned();
    let hex = |bytes: &[u8]| bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
    let unhex = |text: &str| -> Vec<u8> {
        (0..text.len() / 2)
            .map(|at| u8::from_str_radix(&text[at * 2..at * 2 + 2], 16).expect("hex"))
            .collect()
    };
    let id = text("account_id_text");
    assert_eq!(account_id_parse(id.clone()).expect("an id"), id);
    let typed = format!(" {} ", id.to_uppercase().replace('-', " "));
    assert_eq!(account_id_parse(typed).expect("tidied"), id);
    assert_eq!(
        code_of(account_id_parse(format!("{id}0"))),
        ErrorCode::BadFormat
    );
    for refused in vectors["refused_id_texts"].as_array().expect("texts") {
        let name = AccountName {
            email: None,
            id: Some(refused["text"].as_str().expect("text").to_owned()),
        };
        assert_eq!(
            code_of(kit_keys_for(name, text("words"))),
            ErrorCode::BadFormat,
            "{}",
            refused["why"]
        );
    }
    for case in vectors["cases"].as_array().expect("cases") {
        let name = AccountName {
            email: case["account"]["email"].as_str().map(str::to_owned),
            id: case["account"]["id"].as_str().map(str::to_owned),
        };
        let keys = kit_keys_for(name, text("words")).expect("keys");
        assert_eq!(
            hex(&keys.auth_key),
            case["auth_key"].as_str().expect("a key")
        );
        assert_eq!(
            hex(&keys.wrap_key),
            case["wrap_key"].as_str().expect("a key")
        );
        let opened = open_recovery_code(
            keys.wrap_key.clone(),
            unhex(&text("room_id")),
            AccountWay::Kit,
            None,
            unhex(&text("sealed")),
        );
        let result = match opened {
            Ok(code) => format!("opens: {}", hex(&code)),
            Err(error) => error.code().text().to_owned(),
        };
        assert_eq!(
            result,
            case["result"].as_str().expect("a result"),
            "{}",
            case["why"]
        );
    }
    assert_eq!(
        code_of(envelope_header(vec![1, 2, 3])),
        ErrorCode::BadFormat
    );
}

#[test]
fn the_sign_in_is_this_devices_and_verifies() {
    let (device, room) = founder(MemoryStorage::new());
    let signed = device
        .hub_sign_in("https://hub.example".into(), vec![5; 32])
        .expect("signed");
    let verified = hub_auth::verify(
        &hub_auth::SignedHubAuth {
            auth: signed.auth,
            signature: signed.signature,
        },
        &RoomId::from_slice(&room).expect("a room id"),
        &HubAddress::parse("https://hub.example").expect("an address"),
        &IssuedChallenge {
            challenge: [5; 32],
            expires_at: now() + 1000,
        },
        now(),
    )
    .expect("the sign-in verifies");
    assert_eq!(verified.as_bytes().to_vec(), device.id().expect("an id"));
}

#[test]
fn a_refusal_that_judges_the_request_undoes_its_outbox_entry() {
    let (device, _) = founder(MemoryStorage::new());
    let entry = device.outbox().expect("the outbox").remove(0);
    // No hub answers with these: nothing is changed.
    for code in [
        ErrorCode::Storage,
        ErrorCode::Busy,
        ErrorCode::WeakPassword,
        ErrorCode::NoKey,
        ErrorCode::DecryptFailed,
        ErrorCode::Withheld,
    ] {
        assert_eq!(
            code_of(device.outbox_refused(entry.id, code)),
            ErrorCode::BadFormat
        );
    }
    // These say nothing about the request: the entry stays and is sent again.
    for code in [
        ErrorCode::Internal,
        ErrorCode::Overloaded,
        ErrorCode::RateLimited,
        ErrorCode::Unauthorised,
        ErrorCode::ClientTooOld,
    ] {
        device.outbox_refused(entry.id, code).expect("taken");
        assert_eq!(device.outbox().expect("the outbox"), vec![entry.clone()]);
    }
    device
        .outbox_refused(entry.id, ErrorCode::RoomExists)
        .expect("a refusal for good");
    assert!(device.outbox().expect("the outbox").is_empty());
    assert_eq!(device.room().expect("the room"), None);
}

#[test]
fn a_failed_write_changes_nothing_and_the_device_goes_on() {
    let store = MemoryStorage::new();
    let (device, _) = founder(store.handle());
    let before = device.outbox().expect("the outbox");
    store.fail_apply(1);
    assert_eq!(code_of(device.key_package(now())), ErrorCode::Storage);
    assert_eq!(device.outbox().expect("the outbox"), before);
    assert!(device.is_owner().expect("still the owner"));
    device.key_package(now()).expect("the next write is taken");
}

#[test]
fn a_second_owner_is_found_out_and_the_first_signs_nothing_more() {
    let store = MemoryStorage::new();
    let (first, _) = founder(store.handle());
    let second = CoreDevice::open_on(Box::new(store.handle())).expect("the same state once more");
    second.key_package(now()).expect("the second writes");
    assert_eq!(code_of(first.key_package(now())), ErrorCode::Storage);
    assert!(!first.is_owner().expect("asked"));
    // What it is asked about keys is refused too, not answered with "none held".
    assert_eq!(code_of(first.holds_key(vec![7; 32], 0)), ErrorCode::Storage);
    assert_eq!(
        code_of(first.hub_sign_in("https://hub.example".into(), vec![1; 32])),
        ErrorCode::Storage
    );
    assert!(first.outbox().expect("the outbox").is_empty());
}

#[test]
fn a_recovery_is_prepared_and_built_on_a_new_device() {
    // The room, as its one device leaves it at the hub: the founding GroupInfo and its SealedKey.
    let lost = CoreDevice::create_on(Box::new(MemoryStorage::new())).expect("a new device");
    let code = generate_recovery_code().expect("a code");
    let room = lost.found_room(code.clone(), now()).expect("the room");
    let founding = lost.outbox().expect("the outbox").remove(0);
    lost.outbox_accepted(founding.id, Some(1))
        .expect("accepted");
    let lost_id = lost.id().expect("an id");
    lost.close();
    let group = ServedGroup {
        founding: founding.parts[0].clone(),
        commits: Vec::new(),
        current: founding.parts[0].clone(),
    };
    let served = ServedRoom {
        room: room.clone(),
        group,
        anchor: founding.parts[0].clone(),
        rows: vec![founding.parts[1].clone()],
        links: Vec::new(),
        sessions: Vec::new(),
    };
    let anchor =
        recovery_anchor(code.clone(), room.clone(), served.rows.clone()).expect("an anchor");
    assert_eq!((anchor.group, anchor.epoch), (room.clone(), 0));
    assert_eq!(
        code_of(recovery_anchor(
            vec![9; 32],
            room.clone(),
            served.rows.clone()
        )),
        ErrorCode::WrongRecovery
    );

    let device = CoreDevice::create_on(Box::new(MemoryStorage::new())).expect("a new device");
    // Nothing was prepared: nothing is built.
    assert_eq!(
        code_of(device.recover(code.clone(), served.clone(), Vec::new(), Vec::new(), now())),
        ErrorCode::Incomplete
    );
    let plan = device
        .prepare_recovery(code.clone(), served.clone())
        .expect("the recovery is prepared");
    assert_eq!(plan.new_code.len(), 32);
    assert_ne!(plan.new_code, code);
    assert_eq!(plan.removals.len(), 1);
    assert_eq!(plan.removals[0].devices, vec![lost_id.clone()]);
    assert_eq!(format!("{plan:?}"), "RecoveryPlan(<redacted>)");
    let built = device
        .recover(
            code.clone(),
            served,
            Vec::new(),
            b"sealed copies".to_vec(),
            now(),
        )
        .expect("the recovery is built");
    assert!(built.unverified.is_empty());
    let outbox = device.outbox().expect("the outbox");
    assert_eq!(
        outbox.iter().map(|entry| entry.id).collect::<Vec<_>>(),
        built.outbox
    );
    assert_eq!(
        outbox.last().expect("a finish").kind,
        OutboxKind::RecoveryFinish
    );
    // The device's state changes only when the hub accepted the finish.
    assert_eq!(device.room().expect("asked"), None);
    let mut change = 1;
    for entry in &outbox {
        let given = (entry.kind == OutboxKind::RecoveryCommit).then(|| {
            change += 1;
            change
        });
        device.outbox_accepted(entry.id, given).expect("accepted");
    }
    assert_eq!(device.room().expect("asked"), Some(room));
    assert!(device.is_human().expect("asked"));
    assert!(device.holds_recovery_mac().expect("asked"));
    let roles = device
        .room_roles()
        .expect("asked")
        .expect("the room's roles");
    assert_eq!(roles.humans, vec![device.id().expect("an id")]);
    // The sign-in under the code is the code's, not a device's.
    let signed = recovery_sign_in(
        code,
        roles.state.clone(),
        "https://hub.example".into(),
        vec![2; 32],
    );
    assert_eq!(signed.expect("signed").signature.len(), 64);
}

/// A store that does what a test plans for its next write.
#[derive(Clone, Default)]
struct Planned {
    inner: Arc<Mutex<MemoryStorage>>,
    panic_next: Arc<Mutex<bool>>,
    /// The device to call from inside the next write, and what that call answered.
    call_back: Arc<Mutex<Option<Arc<CoreDevice>>>>,
    answered: Arc<Mutex<Option<ErrorCode>>>,
}

impl Storage for Planned {
    fn load(&mut self) -> Result<Loaded, StorageError> {
        self.inner.lock().expect("the store").load()
    }

    fn apply(&mut self, expected_revision: u64, batch: Batch) -> Result<(), StorageError> {
        if std::mem::take(&mut *self.panic_next.lock().expect("the plan")) {
            panic!("the store fails with a private key in its words: 0123456789abcdef");
        }
        if let Some(device) = self.call_back.lock().expect("the plan").take() {
            *self.answered.lock().expect("the answer") = device.id().err().map(|e| e.code());
        }
        self.inner
            .lock()
            .expect("the store")
            .apply(expected_revision, batch)
    }
}

#[test]
fn a_panic_inside_a_call_closes_the_device_and_leaves_no_words() {
    let store = Planned::default();
    let device = CoreDevice::create_on(Box::new(store.clone())).expect("a new device");
    *store.panic_next.lock().expect("the plan") = true;
    let refused = device.key_package(now()).expect_err("the call fails");
    assert_eq!(refused.code(), ErrorCode::Internal);
    assert!(!refused.message().contains("0123456789abcdef"));
    // Closed for good: nothing is answered, not even what needs no write.
    assert_eq!(code_of(device.id()), ErrorCode::Internal);
    assert_eq!(code_of(device.key_package(now())), ErrorCode::Internal);
    device.close();
    assert_eq!(code_of(device.id()), ErrorCode::Internal);
    // The stored state is as it was, and opens again.
    let again = CoreDevice::open_on(Box::new(store)).expect("the stored state opens");
    again.key_package(now()).expect("the device works");
}

#[test]
fn a_store_that_calls_its_device_back_is_refused_not_waited_for() {
    let store = Planned::default();
    let device = Arc::new(CoreDevice::create_on(Box::new(store.clone())).expect("a new device"));
    *store.call_back.lock().expect("the plan") = Some(Arc::clone(&device));
    device
        .key_package(now())
        .expect("the write itself is taken");
    assert_eq!(
        *store.answered.lock().expect("the answer"),
        Some(ErrorCode::Internal)
    );
    device.id().expect("the device goes on");
}

#[test]
fn a_closed_device_answers_nothing() {
    let (device, _) = founder(MemoryStorage::new());
    device.close();
    assert_eq!(code_of(device.id()), ErrorCode::Internal);
    assert_eq!(code_of(device.outbox()), ErrorCode::Internal);
    assert_eq!(
        code_of(device.hub_sign_in("https://hub.example".into(), vec![1; 32])),
        ErrorCode::Internal
    );
    device.close();
}

#[test]
fn a_file_object_is_used_up_by_its_end() {
    let encryptor = FileEncryptor::new().expect("an encryptor");
    let mut stored = encryptor.update(vec![7; 100_000]).expect("taken");
    let end = encryptor.finish().expect("ended");
    stored.extend(end.stored.clone());
    assert_eq!(code_of(encryptor.update(vec![1])), ErrorCode::Internal);
    assert_eq!(code_of(encryptor.finish()), ErrorCode::Internal);
    assert_eq!(end.plain_len, 100_000);
    assert_eq!(end.stored_len as usize, stored.len());

    let decryptor = FileDecryptor::new(end.file.clone()).expect("a decryptor");
    let mut plain = decryptor.update(stored).expect("opened");
    plain.extend(decryptor.finish().expect("ended"));
    assert_eq!(plain, vec![7; 100_000]);
    assert_eq!(code_of(decryptor.finish()), ErrorCode::Internal);
    // What names a file prints nothing of its key.
    assert_eq!(format!("{:?}", end.file), "FileRef(<redacted>)");
    assert!(!format!("{end:?}").contains(&format!("{:?}", end.file.file_key)));
}

#[test]
fn the_account_seals_and_opens_the_code_under_its_ways() {
    let room = vec![3; 32];
    let code = generate_recovery_code().expect("a code");
    let shown = format_recovery_code(code.clone()).expect("the code as text");
    assert_eq!(parse_recovery_code(shown).expect("read back"), code);
    let words = generate_kit_words().expect("words");
    let keys = kit_keys("someone@example.org".into(), words).expect("keys");
    let sealed = seal_recovery_code(
        keys.wrap_key.clone(),
        room.clone(),
        AccountWay::Kit,
        None,
        code.clone(),
    )
    .expect("sealed");
    let opened = open_recovery_code(
        keys.wrap_key.clone(),
        room.clone(),
        AccountWay::Kit,
        None,
        sealed.clone(),
    );
    assert_eq!(opened.expect("opened"), code);
    assert_eq!(
        code_of(open_recovery_code(
            keys.wrap_key.clone(),
            room.clone(),
            AccountWay::Password,
            None,
            sealed.clone()
        )),
        ErrorCode::WrongLogin
    );
    // A credential id goes with a passkey, and only with one.
    assert_eq!(
        code_of(open_recovery_code(
            keys.wrap_key,
            room,
            AccountWay::Kit,
            Some(vec![1]),
            sealed
        )),
        ErrorCode::BadFormat
    );
}

#[test]
fn a_founded_room_is_whole_and_takes_no_readmission() {
    let (device, room) = founder(MemoryStorage::new());
    let summary = device.group(room.clone()).expect("the room group");
    assert!(!summary.stale && summary.missing_opener.is_none() && summary.disallowed.is_empty());
    assert!(summary.past_learned && summary.own_from == 0);
    let past = device
        .group_past(room.clone())
        .expect("asked")
        .expect("its own group");
    assert!(past.learned && past.from_epoch == 0);
    assert!(device.group_past(vec![7; 32]).expect("asked").is_none());
    // A device that cannot join the room group comes back as a new device: no readmission there.
    let key_package = device.key_package(now()).expect("a KeyPackage");
    let other = CoreDevice::create_on(Box::new(MemoryStorage::new())).expect("a new device");
    let id = other.id().expect("its id");
    assert_eq!(
        code_of(device.readmit_human(room, id, key_package, now())),
        ErrorCode::Forbidden
    );
}
