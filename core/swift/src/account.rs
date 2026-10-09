//! The account (section 8.8): the keys of its three ways in (password, Emergency Kit words, passkey), the sealed
//! copies of the recovery code under them, and the forms a person reads and types.

use crate::CoreError;
use trommi_core::account::{self, Way};
use trommi_core::crypto::{Secret, SystemEntropy};
use trommi_core::ids::RoomId;

record! {
    /// The two keys of one way in to the account. Both are secrets.
    secret pub struct AccountKeys {
        /// What the hub is shown to sign in, 32 bytes.
        pub auth_key: Vec<u8>,
        /// What seals the copy of the recovery code, 32 bytes. It never leaves the device.
        pub wrap_key: Vec<u8>,
    }
}

choice! {
    /// A way in to the account: which sealed copy of the recovery code is meant.
    pub enum AccountWay {
        /// The copy under the password.
        Password = "password",
        /// The copy under the Emergency Kit's words.
        Kit = "kit",
        /// The copy under one passkey, named by its credential id.
        Passkey = "passkey",
    }
}

fn text(bytes: &[u8]) -> Result<String, CoreError> {
    String::from_utf8(bytes.to_vec()).map_err(|_| CoreError::internal("text is not UTF-8"))
}

fn way<'a>(way: AccountWay, credential_id: Option<&'a [u8]>) -> Result<Way<'a>, CoreError> {
    match (way, credential_id) {
        (AccountWay::Password, None) => Ok(Way::Password),
        (AccountWay::Kit, None) => Ok(Way::Kit),
        (AccountWay::Passkey, Some(credential_id)) => Ok(Way::Passkey { credential_id }),
        _ => Err(CoreError::bad_format(
            "a credential id goes with a passkey, and only with one",
        )),
    }
}

/// The account's e-mail address as everything is derived from it; `bad-email` for anything that is none.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn normalise_email(email: String) -> Result<String, CoreError> {
    Ok(account::normalise_email(&email)?)
}

/// Whether a password may be chosen: `weak-password` below twelve characters.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn check_password(password: String) -> Result<(), CoreError> {
    Ok(account::check_password(&password)?)
}

/// The key derivation record a new account is made with, as JSON.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn kdf_record() -> String {
    account::KDF_RECORD.to_owned()
}

/// The two keys of the password, for the account of `email`. `kdf` is the record the hub hands out for the
/// account, or none for a new one; anything but the pinned record is `bad-kdf` and nothing is derived. This is
/// the slow step (Argon2id over 64 MiB): call it off the main thread.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn password_keys(
    email: String,
    password: String,
    kdf: Option<String>,
) -> Result<AccountKeys, CoreError> {
    let keys = account::password_keys(&email, &password, kdf.as_deref())?;
    Ok(AccountKeys {
        auth_key: keys.auth_key.expose().to_vec(),
        wrap_key: keys.wrap_key.expose().to_vec(),
    })
}

/// The two keys of the Emergency Kit's words, as typed, for the account of `email`. `bad-recovery-words` unless
/// the text is twelve words of the list.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn kit_keys(email: String, words: String) -> Result<AccountKeys, CoreError> {
    let keys = account::kit_keys(&email, &words)?;
    Ok(AccountKeys {
        auth_key: keys.auth_key.expose().to_vec(),
        wrap_key: keys.wrap_key.expose().to_vec(),
    })
}

/// The key that opens the copy of the code sealed under one passkey, from the passkey's prf output over
/// [`passkey_prf_input`]. `no-prf` unless `prf` is 32 bytes.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn passkey_wrap_key(
    prf: Vec<u8>,
    room_id: Vec<u8>,
    credential_id: Vec<u8>,
) -> Result<Vec<u8>, CoreError> {
    let key = account::passkey_wrap_key(&prf, &RoomId::from_slice(&room_id)?, &credential_id)?;
    Ok(key.expose().to_vec())
}

/// The input every passkey's prf is evaluated over.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn passkey_prf_input() -> Vec<u8> {
    account::PASSKEY_PRF_INPUT.to_vec()
}

/// Seals the recovery code (32 bytes) under a wrap key, for one room and one way in. `credential_id` goes with
/// a passkey and only with one.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn seal_recovery_code(
    wrap_key: Vec<u8>,
    room_id: Vec<u8>,
    way_in: AccountWay,
    credential_id: Option<Vec<u8>>,
    recovery_code: Vec<u8>,
) -> Result<Vec<u8>, CoreError> {
    Ok(account::seal_code(
        &Secret::<32>::from_slice(&wrap_key)?,
        &RoomId::from_slice(&room_id)?,
        way(way_in, credential_id.as_deref())?,
        &Secret::<32>::from_slice(&recovery_code)?,
        &mut SystemEntropy,
    )?)
}

/// Opens a sealed copy of the recovery code. When it does not open under this key, room and way:
/// `wrong-recovery` for the kit's copy, `wrong-login` for the others.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn open_recovery_code(
    wrap_key: Vec<u8>,
    room_id: Vec<u8>,
    way_in: AccountWay,
    credential_id: Option<Vec<u8>>,
    sealed: Vec<u8>,
) -> Result<Vec<u8>, CoreError> {
    let code = account::open_code(
        &Secret::<32>::from_slice(&wrap_key)?,
        &RoomId::from_slice(&room_id)?,
        way(way_in, credential_id.as_deref())?,
        &sealed,
    )?;
    Ok(code.expose().to_vec())
}

/// A fresh recovery code: 32 random bytes. It is shown to the person once, in the form
/// [`format_recovery_code`] gives, and kept nowhere but in the account's sealed copies.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn generate_recovery_code() -> Result<Vec<u8>, CoreError> {
    Ok(Secret::<32>::random(&mut SystemEntropy)?.expose().to_vec())
}

/// The recovery code as it is shown: 52 characters in thirteen groups of four.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn format_recovery_code(recovery_code: Vec<u8>) -> Result<String, CoreError> {
    let code = Secret::<32>::from_slice(&recovery_code)?;
    text(account::format_recovery_code(&code).expose())
}

/// The recovery code a person typed; `bad-recovery-code` for anything that is none.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn parse_recovery_code(text: String) -> Result<Vec<u8>, CoreError> {
    Ok(account::parse_recovery_code(&text)?.expose().to_vec())
}

/// Fresh words for an Emergency Kit: twelve of the list, lowercase with one space between. They are shown to
/// the person once.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn generate_kit_words() -> Result<String, CoreError> {
    text(account::generate_kit_words(&mut SystemEntropy)?.expose())
}

/// The Emergency Kit's words as everything is derived from them, from what a person typed;
/// `bad-recovery-words` unless it is twelve words of the list.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn parse_kit_words(text: String) -> Result<String, CoreError> {
    self::text(account::parse_kit_words(&text)?.expose())
}

/// A fresh user handle for a passkey: 32 random bytes.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn generate_user_handle() -> Result<Vec<u8>, CoreError> {
    Ok(account::generate_user_handle(&mut SystemEntropy)?.to_vec())
}
