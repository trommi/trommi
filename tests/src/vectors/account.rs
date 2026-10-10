//! `spec/vectors/account.json`: the Emergency Kit of an account without an e-mail (section 8.8).

use serde_json::{json, Value};
use trommi_core::account::{
    generate_kit_words, kit_keys_for, open_code, seal_code, AccountError, AccountId, AccountName,
    KitKeys, Way,
};
use trommi_core::crypto::{self, Secret};
use trommi_core::ids::RoomId;
use trommi_core::Error;

use super::{entropy, hex};

/// The name of the file.
pub const NAME: &str = "account";
/// The label of the salt of an account without an e-mail.
pub const LABEL_ID_SALT: &str = "trommi/v1/account-salt/id";
/// An e-mail the same words are tried under.
pub const EMAIL: &str = "owner@example.com";

/// Texts that are no account id, each with what is wrong with it.
pub const REFUSED_ID_TEXTS: &[(&str, &str)] = &[
    ("", "empty"),
    ("0F8FAD5B-D9CB-469F-A165-70867728950E", "upper-case digits"),
    (
        "0f8fad5b-d9cb-469f-a165-70867728950E",
        "one upper-case digit",
    ),
    ("{0f8fad5b-d9cb-469f-a165-70867728950e}", "in braces"),
    ("0f8fad5bd9cb469fa16570867728950e", "no hyphens"),
    ("0f8fad5b-d9cb-469f-a165-70867728950", "one digit short"),
    ("0f8fad5b-d9cb-469f-a165-70867728950e0", "one digit long"),
    (
        "0f8fad5bd-9cb-469f-a165-70867728950e",
        "a hyphen one place late",
    ),
    (
        "0f8fad5b-d9cb-469f-a16570867728-950e",
        "the last hyphen elsewhere",
    ),
    (
        "0f8fad5b-d9cb-469f-a165-7086-728950e",
        "a fifth hyphen in place of a digit",
    ),
    ("0f8fad5b d9cb 469f a165 70867728950e", "spaces for hyphens"),
    (
        " f8fad5b-d9cb-469f-a165-70867728950e",
        "a leading space in place of a digit",
    ),
    (
        "0f8fad5b-d9cb-469f-a165-70867728950g",
        "a letter that is no hex digit",
    ),
    ("urn:uuid:0f8fad5b-d9cb-469f-a165-70867728950e", "as a URN"),
];

fn account_error(error: AccountError) -> Error {
    match error {
        AccountError::Core(error) => error,
        _ => Error::Internal("account vectors"),
    }
}

/// What opening the kit's sealed copy under these keys gives: the code, or the refusal's code.
fn opening(keys: &KitKeys, room: &RoomId, sealed: &[u8]) -> String {
    match open_code(&keys.wrap_key, room, Way::Kit, sealed) {
        Ok(code) => format!("opens: {}", hex(code.expose())),
        Err(error) => error.code().to_owned(),
    }
}

/// Makes the file.
pub fn generate() -> Result<Value, Error> {
    let mut entropy = entropy(NAME)?;
    let id = AccountId::new(crypto::random(&mut entropy)?);
    let other_id = AccountId::new(crypto::random(&mut entropy)?);
    let room = RoomId::new(crypto::random(&mut entropy)?);
    let code: Secret<32> = Secret::random(&mut entropy)?;
    let words = generate_kit_words(&mut entropy)?;
    let words = std::str::from_utf8(words.expose())
        .map_err(|_| Error::Internal("kit words"))?
        .to_owned();

    // The salt is made here from its definition, apart from the core's own derivation of the keys.
    let salt_input = [LABEL_ID_SALT.as_bytes(), &[0], id.as_bytes().as_slice()].concat();
    let salt = crypto::sha256(&salt_input)?;

    let keys = kit_keys_for(AccountName::Id(&id), &words).map_err(account_error)?;
    let sealed =
        seal_code(&keys.wrap_key, &room, Way::Kit, &code, &mut entropy).map_err(account_error)?;

    let case = |why: &str, name: AccountName<'_>, shown: Value| -> Result<Value, Error> {
        let keys = kit_keys_for(name, &words).map_err(account_error)?;
        Ok(json!({
            "why": why,
            "account": shown,
            "auth_key": hex(keys.auth_key.expose()),
            "wrap_key": hex(keys.wrap_key.expose()),
            "result": opening(&keys, &room, &sealed),
        }))
    };
    let cases = vec![
        case(
            "the account itself",
            AccountName::Id(&id),
            json!({ "id": id.to_string() }),
        )?,
        case(
            "the same words under another account id",
            AccountName::Id(&other_id),
            json!({ "id": other_id.to_string() }),
        )?,
        case(
            "the same words under the e-mail form",
            AccountName::Email(EMAIL),
            json!({ "email": EMAIL }),
        )?,
    ];

    Ok(json!({
        "about": "The Emergency Kit of an account without an e-mail (spec/v2.md section 8.8). salt = SHA-256(label_salt 0x00 account_id), over the id's 16 bytes; everything behind the salt as for an account with an e-mail (spec/account-vectors.json): r = the words joined by one space, auth_key = HKDF-SHA-256(r, salt, info = \"trommi/v1/recovery-auth\" 0x00, 32), wrap_key the same with \"trommi/v1/recovery-wrap-key\", sealed = 0x02, nonce(12), AES-256-GCM(wrap_key, nonce, aad, code) with aad = \"trommi/v1/account-wrap\" 0x00 room_id \"recovery\". account_id_text is the id as every kit prints it. cases: the keys the same words give for the account named, and what opening sealed under that wrap key gives: 'opens: <code>' or the code of the refusal. refused_id_texts: texts that are no account id (bad-format). Hex throughout.",
        "label_salt": LABEL_ID_SALT,
        "account_id": hex(id.as_bytes()),
        "account_id_text": id.to_string(),
        "words": words,
        "salt_input": hex(&salt_input),
        "salt": hex(salt.as_bytes()),
        "auth_key": hex(keys.auth_key.expose()),
        "wrap_key": hex(keys.wrap_key.expose()),
        "room_id": hex(room.as_bytes()),
        "code": hex(code.expose()),
        "nonce": hex(sealed.get(1..13).unwrap_or_default()),
        "aad": hex(&[b"trommi/v1/account-wrap\0".as_slice(), room.as_bytes(), b"recovery"].concat()),
        "sealed": hex(&sealed),
        "cases": cases,
        "refused_id_texts": REFUSED_ID_TEXTS.iter().map(|(text, why)| json!({
            "text": text,
            "why": why,
        })).collect::<Vec<_>>(),
    }))
}
