//! trommi-core for the browser: every call of the shared facade (`core/swift/src`) as a wasm-bindgen export.
//!
//! This layer is mechanical. Each export takes JavaScript values, turns them into the facade's plain data
//! (`trommi_core_ffi::js`: a `Uint8Array` for bytes, a plain object for a record, a `number` for a count), calls
//! the facade's function of the same name, and turns the answer back: a pair, `[null, value]` or, for a refusal,
//! `[code, message]` with the stable code of the specification's section 16.
//!
//! The exports keep the facade's names. The hand-written module `js/trommi-core.js` is what an app imports: it
//! gives them their JavaScript spelling, stores what a device's call wrote before the call's result reaches
//! anyone, and closes everything when the module stops.
//!
//! A panic stops the module (WebAssembly has no unwinding here): the export throws a `RuntimeError`, and the
//! JavaScript layer refuses every later call.
//!
//! Built for another target than the browser's, this crate is empty.

#![cfg(target_arch = "wasm32")]

use js_sys::Array;
use trommi_core_ffi as facade;
use trommi_core_ffi::js::{FromJs, ToJs};
use trommi_core_ffi::{CoreDevice, CoreError, FileDecryptor, FileEncryptor};
use wasm_bindgen::prelude::*;

/// What every export returns: a pair. `[null, value]` when the call went through, `[code, message]` when the
/// core refused it. Nothing is thrown on purpose, so whatever an export does throw is a fault (a panic, a misuse
/// of the glue), and the JavaScript layer treats it as one: a refusal cannot be forged by an exception.
type Answer = Array;

fn pair(first: &JsValue, second: &JsValue) -> Answer {
    Array::of2(first, second)
}

fn refusal(error: &CoreError) -> Answer {
    pair(
        &JsValue::from_str(error.code().text()),
        &JsValue::from_str(error.message()),
    )
}

/// An argument as the facade takes it.
fn arg<T: FromJs>(value: &JsValue) -> Result<T, CoreError> {
    T::from_js(value)
}

/// Runs a call whose arguments may themselves be refused.
fn attempt<T>(call: impl FnOnce() -> Result<T, CoreError>) -> Result<T, CoreError> {
    call()
}

/// An answer as JavaScript takes it.
fn answer<T: ToJs>(result: Result<T, CoreError>) -> Answer {
    match result.and_then(|value| value.to_js()) {
        Ok(value) => pair(&JsValue::NULL, &value),
        Err(error) => refusal(&error),
    }
}

/// The facade's free functions, by name and arguments. `fallible` ones return a `Result`, `plain` ones cannot
/// fail.
macro_rules! functions {
    ($($kind:ident $name:ident($($argument:ident),*);)*) => {
        $(functions!(@one $kind $name($($argument),*));)*
    };
    (@one fallible $name:ident($($argument:ident),*)) => {
        #[wasm_bindgen]
        pub fn $name($($argument: &JsValue),*) -> Answer {
            answer(attempt(|| facade::$name($(arg($argument)?),*)))
        }
    };
    (@one plain $name:ident($($argument:ident),*)) => {
        #[wasm_bindgen]
        pub fn $name($($argument: &JsValue),*) -> Answer {
            answer(attempt(|| Ok(facade::$name($(arg($argument)?),*))))
        }
    };
}

functions! {
    plain versions();
    plain self_test(now_ms);
    plain log_finding(code);
    plain error_code_text(code);
    plain error_code_from_text(text);
    fallible key_package_info(key_package);
    fallible room_group_id(room);
    fallible session_group_id(room, session);
    plain base64url_encode(bytes);
    fallible base64url_decode(text);
    fallible file_layout(stored_len);
    fallible file_chunk(stored_len, index);
    fallible open_file_chunk(file_key, file_id, index, last, sealed);
    fallible share_link_create(app, file);
    fallible share_link_parse(text);
    fallible check_share_expiry(expires_at, now_ms);
    fallible normalise_email(email);
    fallible check_password(password);
    plain kdf_record();
    fallible password_keys(email, password, kdf);
    fallible kit_keys(email, words);
    fallible passkey_wrap_key(prf, room_id, credential_id);
    plain passkey_prf_input();
    fallible seal_recovery_code(wrap_key, room_id, way_in, credential_id, recovery_code);
    fallible open_recovery_code(wrap_key, room_id, way_in, credential_id, sealed);
    fallible generate_recovery_code();
    fallible format_recovery_code(recovery_code);
    fallible parse_recovery_code(text);
    fallible generate_kit_words();
    fallible parse_kit_words(text);
    fallible generate_user_handle();
    fallible generate_push_key();
    fallible open_apns_push(key, sealed);
    fallible read_web_push(payload);
    fallible recovery_anchor(recovery_code, room, rows);
    fallible recovery_sign_in(recovery_code, room, hub, challenge);
    fallible board_reduce(snapshot, snapshot_frontier, items, frontier);
    fallible invite_link_parse(text);
    plain check_emoji();
    fallible hub_address(text);
    fallible kit_keys_for(name, words);
    fallible account_id_parse(text);
    fallible envelope_header(envelope);
}

/// The methods of a facade object that return a `Result`, by name and arguments.
macro_rules! methods {
    ($object:ident { $($name:ident($($argument:ident),*);)* }) => {
        #[wasm_bindgen]
        impl $object {
            $(
                pub fn $name(&self, $($argument: &JsValue),*) -> Answer {
                    answer(attempt(|| self.0.$name($(arg($argument)?),*)))
                }
            )*
        }
    };
}

/// A new object of the facade as an answer.
fn made<T: Into<JsValue>>(result: Result<T, CoreError>) -> Answer {
    match result {
        Ok(object) => pair(&JsValue::NULL, &object.into()),
        Err(error) => refusal(&error),
    }
}

/// The facade's device.
#[wasm_bindgen]
pub struct RawDevice(CoreDevice);

#[wasm_bindgen]
impl RawDevice {
    /// A new device over what the page loaded from its store, which must be empty.
    pub fn create(loaded: &JsValue) -> Answer {
        made(
            arg(loaded)
                .and_then(CoreDevice::create_loaded)
                .map(RawDevice),
        )
    }

    /// The device that what the page loaded from its store holds.
    pub fn open(loaded: &JsValue) -> Answer {
        made(arg(loaded).and_then(CoreDevice::open_loaded).map(RawDevice))
    }

    /// The writes the calls since the last `take_writes` made, oldest first.
    pub fn take_writes(&self) -> Answer {
        answer(Ok(self.0.take_writes()))
    }

    /// Closes the device and wipes what it holds.
    pub fn close(&self) {
        self.0.close();
    }
}

methods!(RawDevice {
    id();
    room();
    cursor();
    is_human();
    is_owner();
    room_roles();
    groups();
    group(group);
    holds_key(group, epoch);
    outbox();
    outbox_accepted(id, change);
    outbox_refused(id, code);
    key_packages_to_upload(unused_at_hub, now_ms);
    key_package(now_ms);
    found_room(recovery_code, now_ms);
    found_session(agent, key_packages, now_ms);
    found_helper(parent, key_packages, now_ms);
    add_to_session(group, device, key_package, now_ms);
    remove_agents(remove, now_ms);
    remove_human_devices(cuts, now_ms);
    clean_session(group, cuts, replacement, now_ms);
    readmit_helper(group, old, device, key_package, now_ms);
    update(group, forced, now_ms);
    archive(group);
    join_welcome(welcome, room, committer, now_ms);
    observe_room(group_info, expected_state);
    observe_session(group_info);
    process_log_entry(entry, now_ms);
    feed(items, now_ms);
    send_handover(group, recipient);
    handovers_sent();
    handover_read(group, recipient);
    send_stroke_piece(board, piece);
    send_work_trail(group, turn, number, step, now_ms);
    holds_recovery_mac();
    key_is_confirmed(group, epoch);
    send_recovery_auth(recipient);
    post_sealed_key(group, group_info, listed);
    verify_founding(group, served);
    join_room_with_code(recovery_code, served, now_ms);
    join_session_with_code(recovery_code, served, now_ms);
    new_recovery_code(recovery_code);
    replace_code(recovery_code, account, now_ms);
    prepare_recovery(recovery_code, served);
    recover(recovery_code, served, chains, account, now_ms);
    learn_history(group, founding, commits);
    group_past(group);
    invite_open(role, session_id, app, hub, now_ms);
    invite_accept(invite_id, request, now_ms);
    invite_confirm(invite_id, code, request_hash, matches, now_ms);
    invite_recommit(invite_id, now_ms);
    invite_steps();
    invite_handover(invite_id);
    invite_checked(invite_id, helpers);
    invite_forget(invite_id);
    join_request(link, offer, now_ms);
    join_reveal(reveal);
    join_observe(group_info);
    join_invited(welcome, now_ms);
    hub_sign_in(hub, challenge);
    seal(draft, recipient, file_ids, now_ms);
    outbox_voided(id);
    envelope_abandon(id);
    receive_envelope(envelope, change, ordered, void_code, now_ms);
    receive_relay(group, message, now_ms);
    heads_due(group, now_ms);
    compare_heads(group, writer);
    cut_of(group, device);
    chain_head(group, sender);
    chain_cut(group, device);
    object(group, object_id);
    objects(group);
    object_owner(group, object_id);
    register(group, name);
    register_of(group, name, sender);
    board_load(board, served);
    command(envelope_hash, now_ms);
    command_finished(envelope_hash);
    commands_pending();
    commands_uncertain();
    findings();
    findings_read();
});

/// The facade's file encryptor.
#[wasm_bindgen]
pub struct RawFileEncryptor(FileEncryptor);

#[wasm_bindgen]
impl RawFileEncryptor {
    /// Starts a new file.
    pub fn create() -> Answer {
        made(FileEncryptor::new().map(RawFileEncryptor))
    }
}

methods!(RawFileEncryptor {
    file_id();
    update(plaintext);
    finish();
});

/// The facade's file decryptor.
#[wasm_bindgen]
pub struct RawFileDecryptor(FileDecryptor);

#[wasm_bindgen]
impl RawFileDecryptor {
    /// Starts reading the file `file` names.
    pub fn create(file: &JsValue) -> Answer {
        made(arg(file).and_then(FileDecryptor::new).map(RawFileDecryptor))
    }
}

methods!(RawFileDecryptor {
    update(stored);
    finish();
});
