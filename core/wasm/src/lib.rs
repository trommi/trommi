//! trommi-core for the browser: every call of the shared facade (`core/swift/src`) as a wasm-bindgen export.
//!
//! This layer is mechanical. Each export takes JavaScript values, turns them into the facade's plain data
//! (`trommi_core_ffi::js`: a `Uint8Array` for bytes, a plain object for a record, a `number` for a count), calls
//! the facade's function of the same name, and turns the answer back. A refusal is thrown as an `Error` whose
//! `code` is the stable code of the specification's section 16.
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

use js_sys::{Error, Reflect};
use trommi_core_ffi as facade;
use trommi_core_ffi::js::{FromJs, ToJs};
use trommi_core_ffi::{CoreDevice, CoreError, FileDecryptor, FileEncryptor};
use wasm_bindgen::prelude::*;

/// A refusal as JavaScript throws it: an `Error` named `TrommiError` with the stable code in `code`.
fn refusal(error: CoreError) -> JsValue {
    let thrown = Error::new(error.message());
    thrown.set_name("TrommiError");
    // Setting a property of a fresh Error cannot fail.
    let _ = Reflect::set(
        &thrown,
        &JsValue::from_str("code"),
        &JsValue::from_str(error.code().text()),
    );
    thrown.into()
}

/// An argument as the facade takes it.
fn arg<T: FromJs>(value: &JsValue) -> Result<T, JsValue> {
    T::from_js(value).map_err(refusal)
}

/// An answer as JavaScript takes it.
fn answer<T: ToJs>(result: Result<T, CoreError>) -> Result<JsValue, JsValue> {
    result.and_then(|value| value.to_js()).map_err(refusal)
}

/// The facade's free functions, by name and arguments. `fallible` ones return a `Result`, `plain` ones cannot
/// fail.
macro_rules! functions {
    ($($kind:ident $name:ident($($argument:ident),*);)*) => {
        $(functions!(@one $kind $name($($argument),*));)*
    };
    (@one fallible $name:ident($($argument:ident),*)) => {
        #[wasm_bindgen]
        pub fn $name($($argument: &JsValue),*) -> Result<JsValue, JsValue> {
            answer(facade::$name($(arg($argument)?),*))
        }
    };
    (@one plain $name:ident($($argument:ident),*)) => {
        #[wasm_bindgen]
        pub fn $name($($argument: &JsValue),*) -> Result<JsValue, JsValue> {
            answer(Ok(facade::$name($(arg($argument)?),*)))
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
}

/// The methods of a facade object that return a `Result`, by name and arguments.
macro_rules! methods {
    ($object:ident { $($name:ident($($argument:ident),*);)* }) => {
        #[wasm_bindgen]
        impl $object {
            $(
                pub fn $name(&self, $($argument: &JsValue),*) -> Result<JsValue, JsValue> {
                    answer(self.0.$name($(arg($argument)?),*))
                }
            )*
        }
    };
}

/// The facade's device.
#[wasm_bindgen]
pub struct RawDevice(CoreDevice);

#[wasm_bindgen]
impl RawDevice {
    /// A new device over what the page loaded from its store, which must be empty.
    pub fn create(loaded: &JsValue) -> Result<RawDevice, JsValue> {
        CoreDevice::create_loaded(arg(loaded)?)
            .map(RawDevice)
            .map_err(refusal)
    }

    /// The device that what the page loaded from its store holds.
    pub fn open(loaded: &JsValue) -> Result<RawDevice, JsValue> {
        CoreDevice::open_loaded(arg(loaded)?)
            .map(RawDevice)
            .map_err(refusal)
    }

    /// The writes the calls since the last `take_writes` made, oldest first.
    pub fn take_writes(&self) -> Result<JsValue, JsValue> {
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
    content_key(group, epoch);
    outbox();
    outbox_accepted(id, change);
    outbox_refused(id, code);
    key_packages_to_upload(unused_at_hub, now_ms);
    key_package(now_ms);
    found_room(recovery_code, now_ms);
    found_session(agent, key_packages, now_ms);
    found_helper(parent, key_packages, now_ms);
    add_human_device(device, key_package, now_ms);
    add_to_session(group, device, key_package, now_ms);
    change_agents(enrol, remove, now_ms);
    remove_human_devices(cuts, now_ms);
    clean_session(group, cuts, replacement, now_ms);
    readmit_helper(group, old, device, key_package, now_ms);
    update(group, forced, now_ms);
    archive(group);
    join_welcome(welcome, room, committer, now_ms);
    observe_room(group_info, expected_state);
    observe_session(group_info);
    process_log_entry(entry);
    send_handover(group, recipient);
    handovers_sent();
    handover_read(group, recipient);
    send_stroke_piece(board, piece);
    send_work_trail(group, turn, number, step, now_ms);
    hub_sign_in(room, hub, challenge);
});

/// The facade's file encryptor.
#[wasm_bindgen]
pub struct RawFileEncryptor(FileEncryptor);

#[wasm_bindgen]
impl RawFileEncryptor {
    /// Starts a new file.
    pub fn create() -> Result<RawFileEncryptor, JsValue> {
        FileEncryptor::new().map(RawFileEncryptor).map_err(refusal)
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
    pub fn create(file: &JsValue) -> Result<RawFileDecryptor, JsValue> {
        FileDecryptor::new(arg(file)?)
            .map(RawFileDecryptor)
            .map_err(refusal)
    }
}

methods!(RawFileDecryptor {
    update(stored);
    finish();
});
