//! The account's sealed copies of the recovery code (section 8.8): password, Emergency Kit words and passkey,
//! against `spec/account-vectors.json`; the Emergency Kit of an account without an e-mail, against
//! `spec/vectors/account.json`.

use serde_json::Value;
use trommi_core::account::*;
use trommi_core::crypto::{Entropy, Secret, SystemEntropy};
use trommi_core::ids::{base64url_decode, base64url_encode, RoomId};
use trommi_core::Error;

fn vectors() -> Value {
    serde_json::from_str(include_str!("../../spec/account-vectors.json")).expect("the vectors")
}

fn text<'a>(value: &'a Value, path: &[&str]) -> &'a str {
    path.iter()
        .fold(value, |value, name| &value[*name])
        .as_str()
        .unwrap_or_else(|| panic!("no text at {path:?}"))
}

fn hex(text: &str) -> Vec<u8> {
    assert_eq!(text.len() % 2, 0);
    (0..text.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(&text[at..at + 2], 16).expect("hex"))
        .collect()
}

fn secret(bytes: &[u8]) -> Secret<32> {
    Secret::from_slice(bytes).expect("32 bytes")
}

fn room(v: &Value, section: &str) -> RoomId {
    RoomId::from_slice(&hex(text(v, &[section, "roomId"]))).expect("a room id")
}

/// The words of the Emergency Kit, as the web app lists them; the module's own list is held to the same text.
fn word_list() -> Vec<&'static str> {
    include_str!("../../app/web/core/wordlist.ts")
        .split('`')
        .nth(1)
        .expect("the list between its backticks")
        .split(' ')
        .collect()
}

/// The recovery code of the vectors.
fn code(v: &Value) -> Secret<32> {
    secret(&hex(text(v, &["password", "codeRaw"])))
}

/// An entropy source that hands out the bytes of a vector's nonce.
struct Fixed(Vec<u8>);
impl Entropy for Fixed {
    fn fill(&mut self, out: &mut [u8]) -> Result<(), Error> {
        out.copy_from_slice(&self.0[..out.len()]);
        Ok(())
    }
}

struct NoEntropy;
impl Entropy for NoEntropy {
    fn fill(&mut self, _: &mut [u8]) -> Result<(), Error> {
        Err(Error::Entropy)
    }
}

#[test]
fn vectors_password() {
    let v = vectors();
    let p = &v["password"];
    let email = text(p, &["email"]);
    let password = text(p, &["password"]);
    assert_eq!(
        normalise_email(email).expect("an address"),
        text(p, &["normalisedEmail"])
    );
    let record = serde_json::to_string(&p["kdf"]).expect("json");
    assert_eq!(accept_kdf(Some(&record)), Ok(()));

    // The slow step, once, through the whole path: e-mail as typed, password as typed, the hub's record.
    let master = master_key(email, password, Some(&record)).expect("derives");
    assert_eq!(master.expose().as_slice(), hex(text(p, &["master"])));
    let keys = keys_from_master(email, &master).expect("derives");
    assert_eq!(
        base64url_encode(keys.auth_key.expose()),
        text(p, &["authKeyB64u"])
    );
    assert_eq!(
        keys.wrap_key.expose().as_slice(),
        hex(text(p, &["wrapKey"]))
    );

    let room = room(&v, "password");
    let sealed = seal_code(
        &keys.wrap_key,
        &room,
        Way::Password,
        &code(&v),
        &mut Fixed(hex(text(p, &["nonce"]))),
    )
    .expect("seals");
    assert_eq!(base64url_encode(&sealed), text(p, &["keyWrappedB64u"]));
    assert_eq!(sealed.len(), SEALED_COPY_LEN);
    let opened = open_code(&keys.wrap_key, &room, Way::Password, &sealed).expect("opens");
    assert_eq!(opened, code(&v));

    // The code as it is shown and read.
    let shown = format_recovery_code(&opened);
    assert_eq!(shown.expose(), text(p, &["code"]).as_bytes());
    assert_eq!(parse_recovery_code(text(p, &["code"])), Ok(code(&v)));
}

#[test]
fn vectors_recovery() {
    let v = vectors();
    let r = &v["recovery"];
    let email = text(&v, &["password", "email"]);
    for typed in [text(r, &["words"]), text(r, &["wordsAsTyped"])] {
        assert_eq!(
            parse_kit_words(typed).expect("twelve words").expose(),
            text(r, &["words"]).as_bytes()
        );
        let keys = kit_keys(email, typed).expect("derives");
        assert_eq!(
            base64url_encode(keys.auth_key.expose()),
            text(r, &["recoveryAuthB64u"])
        );
        assert_eq!(
            keys.wrap_key.expose().as_slice(),
            hex(text(r, &["wrapKey"]))
        );
    }
    let keys = kit_keys(email, text(r, &["words"])).expect("derives");
    let room = room(&v, "password");
    let sealed = seal_code(
        &keys.wrap_key,
        &room,
        Way::Kit,
        &code(&v),
        &mut Fixed(hex(text(r, &["nonce"]))),
    )
    .expect("seals");
    assert_eq!(base64url_encode(&sealed), text(r, &["recoveryWrappedB64u"]));
    assert_eq!(
        open_code(&keys.wrap_key, &room, Way::Kit, &sealed),
        Ok(code(&v))
    );
}

#[test]
fn vectors_passkey() {
    let v = vectors();
    let p = &v["passkey"];
    let room = room(&v, "passkey");
    let credential_id = hex(text(p, &["credentialId"]));
    let way = Way::Passkey {
        credential_id: &credential_id,
    };
    let wrap_key =
        passkey_wrap_key(&hex(text(p, &["prfOutput"])), &room, &credential_id).expect("derives");
    assert_eq!(wrap_key.expose().as_slice(), hex(text(p, &["wrapKey"])));
    let sealed = seal_code(
        &wrap_key,
        &room,
        way,
        &code(&v),
        &mut Fixed(hex(text(p, &["nonce"]))),
    )
    .expect("seals");
    assert_eq!(base64url_encode(&sealed), text(p, &["keyWrappedB64u"]));
    assert_eq!(open_code(&wrap_key, &room, way, &sealed), Ok(code(&v)));
}

#[test]
fn vectors_email() {
    let v = vectors();
    let cases = v["email"]["cases"].as_array().expect("cases");
    assert!(cases.len() >= 39);
    for case in cases {
        let input = text(case, &["input"]);
        match case.get("normalised") {
            Some(normalised) => assert_eq!(
                normalise_email(input).as_deref(),
                Ok(normalised.as_str().expect("text")),
                "{input:?}"
            ),
            None => {
                assert_eq!(text(case, &["error"]), "bad-email");
                assert_eq!(
                    normalise_email(input),
                    Err(AccountError::BadEmail),
                    "{input:?}"
                );
            }
        }
    }
}

#[test]
fn vectors_password_rule() {
    let v = vectors();
    assert_eq!(v["passwordRule"]["min"], PASSWORD_MIN);
    let cases = v["passwordRule"]["cases"].as_array().expect("cases");
    assert!(cases.len() >= 7);
    for case in cases {
        let password = text(case, &["password"]);
        let ok = case["ok"].as_bool().expect("ok");
        assert_eq!(check_password(password).is_ok(), ok, "{password:?}");
        if !ok {
            assert_eq!(check_password(password), Err(AccountError::WeakPassword));
        }
    }
}

#[test]
fn vectors_kdf() {
    let v = vectors();
    let json = |value: &Value| serde_json::to_string(value).expect("json");
    assert_eq!(
        serde_json::from_str::<Value>(KDF_RECORD).expect("json"),
        v["kdf"]["pinned"]
    );
    let accepted = v["kdf"]["accepted"].as_array().expect("accepted");
    assert!(accepted.len() >= 3);
    for record in accepted {
        assert_eq!(accept_kdf(Some(&json(record))), Ok(()), "{record}");
    }
    assert_eq!(accept_kdf(None), Ok(()));
    let refused = v["kdf"]["refused"].as_array().expect("refused");
    assert!(refused.len() >= 29);
    for record in refused {
        assert_eq!(
            accept_kdf(Some(&json(record))),
            Err(AccountError::BadKdf),
            "{record}"
        );
        // Nothing is derived with it: the refusal comes before the slow step.
        assert_eq!(
            master_key("owner@example.com", "a password", Some(&json(record))).err(),
            Some(AccountError::BadKdf)
        );
    }
    let padded = KDF_RECORD.replace('}', &format!(r#","x":"{}"}}"#, "x".repeat(1024)));
    assert_eq!(accept_kdf(Some(&padded)), Err(AccountError::BadKdf));
    for not_json in ["", "{", "argon2id", "{\"alg\":\"argon2id\",}"] {
        assert_eq!(accept_kdf(Some(not_json)), Err(AccountError::BadKdf));
    }
    // A number is compared as a number, however it is written.
    assert_eq!(
        accept_kdf(Some(
            r#"{"alg":"argon2id","v":1.0,"m":6.5536e4,"t":3,"p":1}"#
        )),
        Ok(())
    );
}

#[test]
fn vectors_refused() {
    let v = vectors();
    let p = &v["password"];
    let r = &v["refused"];
    let room = room(&v, "password");
    let wrap_key = secret(&hex(text(p, &["wrapKey"])));
    let open = |name: &str| {
        let sealed = base64url_decode(text(r, &[name])).expect("base64url");
        open_code(&wrap_key, &room, Way::Password, &sealed)
    };
    // The auth key of the old labels is another key.
    assert_ne!(text(r, &["oldAuthKeyB64u"]), text(p, &["authKeyB64u"]));
    assert_eq!(
        open("keyWrappedOldFormatB64u"),
        Err(AccountError::Core(Error::BadFormat))
    );
    assert_eq!(
        open("keyWrappedVersion1B64u"),
        Err(AccountError::Core(Error::BadFormat))
    );
    assert_eq!(
        open("keyWrappedOldKeyB64u"),
        Err(AccountError::Core(Error::WrongLogin))
    );

    // A copy of another kind, of another room, under another key.
    let good = base64url_decode(text(p, &["keyWrappedB64u"])).expect("base64url");
    assert_eq!(
        open_code(&wrap_key, &room, Way::Password, &good),
        Ok(code(&v))
    );
    assert_eq!(
        open_code(&wrap_key, &room, Way::Kit, &good),
        Err(AccountError::Core(Error::WrongRecovery))
    );
    assert_eq!(
        open_code(
            &wrap_key,
            &room,
            Way::Passkey {
                credential_id: &[1]
            },
            &good
        ),
        Err(AccountError::Core(Error::WrongLogin))
    );
    assert_eq!(
        open_code(&wrap_key, &RoomId::new([1; 32]), Way::Password, &good),
        Err(AccountError::Core(Error::WrongLogin))
    );
    assert_eq!(
        open_code(&secret(&[1; 32]), &room, Way::Password, &good),
        Err(AccountError::Core(Error::WrongLogin))
    );
    let kit = base64url_decode(text(&v, &["recovery", "recoveryWrappedB64u"])).expect("b64");
    let kit_key = secret(&hex(text(&v, &["recovery", "wrapKey"])));
    assert_eq!(
        open_code(&kit_key, &room, Way::Password, &kit),
        Err(AccountError::Core(Error::WrongLogin))
    );
    assert_eq!(
        open_code(&secret(&[1; 32]), &room, Way::Kit, &kit),
        Err(AccountError::Core(Error::WrongRecovery))
    );
    // A passkey's copy does not open for another credential.
    let pk = &v["passkey"];
    let passkey_copy = base64url_decode(text(pk, &["keyWrappedB64u"])).expect("base64url");
    let passkey_key = secret(&hex(text(pk, &["wrapKey"])));
    let mut other_credential = hex(text(pk, &["credentialId"]));
    other_credential[0] ^= 1;
    assert_eq!(
        open_code(
            &passkey_key,
            &room,
            Way::Passkey {
                credential_id: &other_credential
            },
            &passkey_copy
        ),
        Err(AccountError::Core(Error::WrongLogin))
    );
}

#[test]
fn a_sealed_copy_of_another_form_is_refused_without_a_panic() {
    let key = secret(&[3; 32]);
    let room = RoomId::new([4; 32]);
    let code = secret(&[5; 32]);
    let sealed = seal_code(&key, &room, Way::Password, &code, &mut SystemEntropy).expect("seals");
    assert_eq!(open_code(&key, &room, Way::Password, &sealed), Ok(code));
    for len in 0..SEALED_COPY_LEN {
        assert_eq!(
            open_code(&key, &room, Way::Password, &sealed[..len]),
            Err(AccountError::Core(Error::BadFormat))
        );
    }
    let mut long = sealed.clone();
    long.push(0);
    assert_eq!(
        open_code(&key, &room, Way::Password, &long),
        Err(AccountError::Core(Error::BadFormat))
    );
    for version in [0u8, 1, 3, 255] {
        let mut other = sealed.clone();
        other[0] = version;
        assert_eq!(
            open_code(&key, &room, Way::Password, &other),
            Err(AccountError::Core(Error::BadFormat))
        );
    }
    for at in 1..SEALED_COPY_LEN {
        let mut changed = sealed.clone();
        changed[at] ^= 1;
        assert_eq!(
            open_code(&key, &room, Way::Password, &changed),
            Err(AccountError::Core(Error::WrongLogin)),
            "{at}"
        );
    }
    // A fresh nonce each time, and none without entropy.
    let again = seal_code(
        &key,
        &room,
        Way::Password,
        &secret(&[5; 32]),
        &mut SystemEntropy,
    )
    .expect("seals");
    assert_ne!(again, sealed);
    assert_eq!(
        seal_code(
            &key,
            &room,
            Way::Password,
            &secret(&[5; 32]),
            &mut NoEntropy
        ),
        Err(AccountError::Core(Error::Entropy))
    );
}

#[test]
fn a_passkey_needs_its_prf_output_and_a_credential_id() {
    let room = RoomId::new([4; 32]);
    for prf in [vec![], vec![0; 31], vec![0; 33], vec![0; 64]] {
        assert_eq!(
            passkey_wrap_key(&prf, &room, &[1]).err(),
            Some(AccountError::NoPrf)
        );
    }
    let longest = vec![7; MAX_CREDENTIAL_ID_LEN];
    assert!(passkey_wrap_key(&[0; 32], &room, &longest).is_ok());
    for credential_id in [vec![], vec![7; MAX_CREDENTIAL_ID_LEN + 1]] {
        assert_eq!(
            passkey_wrap_key(&[0; 32], &room, &credential_id).err(),
            Some(AccountError::Core(Error::BadFormat))
        );
        let way = Way::Passkey {
            credential_id: &credential_id,
        };
        assert_eq!(
            seal_code(
                &secret(&[1; 32]),
                &room,
                way,
                &secret(&[2; 32]),
                &mut SystemEntropy
            ),
            Err(AccountError::Core(Error::BadFormat))
        );
        assert_eq!(
            open_code(&secret(&[1; 32]), &room, way, &[2; SEALED_COPY_LEN]),
            Err(AccountError::Core(Error::BadFormat))
        );
    }
    // Another credential, another room, another output: another key.
    let key = passkey_wrap_key(&[0; 32], &room, &[1]).expect("derives");
    assert_ne!(
        key,
        passkey_wrap_key(&[0; 32], &room, &[2]).expect("derives")
    );
    assert_ne!(
        key,
        passkey_wrap_key(&[0; 32], &RoomId::new([5; 32]), &[1]).expect("derives")
    );
    assert_ne!(
        key,
        passkey_wrap_key(&[1; 32], &room, &[1]).expect("derives")
    );
}

#[test]
fn keys_depend_on_the_account() {
    let master = secret(&[9; 32]);
    let a = keys_from_master("owner@example.com", &master).expect("derives");
    let same = keys_from_master(" OWNER@example.COM\n", &master).expect("derives");
    let b = keys_from_master("other@example.com", &master).expect("derives");
    assert_eq!(a, same);
    assert_ne!(a.auth_key, b.auth_key);
    assert_ne!(a.wrap_key, b.wrap_key);
    assert_ne!(a.auth_key, a.wrap_key);
    assert_eq!(
        keys_from_master("owner", &master).err(),
        Some(AccountError::BadEmail)
    );
    assert_eq!(
        master_key("owner", "a long password", None).err(),
        Some(AccountError::BadEmail)
    );
    assert_eq!(kit_keys("owner", "x").err(), Some(AccountError::BadEmail));
    assert!(format!("{a:?}").contains("redacted"));
}

#[test]
fn kit_words_are_read_as_typed() {
    let words = "acorn velvet tidy hamper oxford banjo cradle dolphin eagle fabric gallery harbor";
    let read = |typed: &str| {
        parse_kit_words(typed).map(|w| String::from_utf8(w.expose().to_vec()).expect("utf-8"))
    };
    for typed in [
        words.to_string(),
        words.to_uppercase(),
        format!("  {words}\n"),
        words.replace(' ', "-"),
        words.replace(' ', ",  "),
        words.replace(' ', "\u{a0}"),
        words
            .replace("acorn", "1. acorn")
            .replace(" velvet", "\n2) velvet"),
    ] {
        assert_eq!(read(&typed).as_deref(), Ok(words), "{typed:?}");
    }
    // The Kelvin sign lowercases to k, as in the reference client.
    let with_k = word_list()
        .into_iter()
        .find(|word| word.starts_with('k'))
        .expect("a word with k");
    let kelvin = words.replace("banjo", &with_k.replacen('k', "\u{212a}", 1));
    assert_eq!(read(&kelvin), Ok(words.replace("banjo", with_k)));
    // Any amount of white space is dropped, as the reference client drops it; any amount of anything
    // else is refused without being kept.
    assert_eq!(
        read(&format!("{words}{}", " ".repeat(5000))).as_deref(),
        Ok(words)
    );
    assert_eq!(
        read(&"acorn ".repeat(4000)),
        Err(AccountError::BadRecoveryWords)
    );
    assert_eq!(
        read(&"a".repeat(100_000)),
        Err(AccountError::BadRecoveryWords)
    );
    let code = "0".repeat(52);
    assert!(parse_recovery_code(&format!("{code}{}", " ".repeat(5000))).is_ok());
    assert_eq!(
        parse_recovery_code(&"0".repeat(100_000)),
        Err(AccountError::BadRecoveryCode)
    );
    let eleven = words.rsplit_once(' ').expect("words").0;
    for typed in [
        String::new(),
        " ".into(),
        eleven.to_string(),
        format!("{words} acorn"),
        words.replace("acorn", "acorm"),
        words.replace("acorn", "ac orn"),
        words.replace("acorn", "acörn"),
        words.replace("velvet", "drop-down"),
        words.replace("velvet", "velvet7tidy"),
    ] {
        assert_eq!(
            read(&typed),
            Err(AccountError::BadRecoveryWords),
            "{typed:?}"
        );
    }
}

#[test]
fn fresh_kit_words_are_twelve_of_the_list() {
    let words = generate_kit_words(&mut SystemEntropy).expect("entropy");
    let text = String::from_utf8(words.expose().to_vec()).expect("utf-8");
    assert_eq!(text.split(' ').count(), KIT_WORDS);
    assert_eq!(
        parse_kit_words(&text).expect("of the list").expose(),
        text.as_bytes()
    );
    let again = generate_kit_words(&mut SystemEntropy).expect("entropy");
    assert_ne!(again.expose(), words.expose());
    assert!(format!("{words:?}").contains("redacted"));
    assert_eq!(
        generate_kit_words(&mut NoEntropy).err(),
        Some(Error::Entropy)
    );
}

#[test]
fn fresh_kit_words_are_chosen_without_a_bias() {
    // A source that counts upwards: every sixteen-bit value once. The values at and above the largest
    // multiple of 7772 are skipped, so the words come in the list's order, eight rounds of it.
    struct Counter(u16);
    impl Entropy for Counter {
        fn fill(&mut self, out: &mut [u8]) -> Result<(), Error> {
            out.copy_from_slice(&self.0.to_be_bytes());
            self.0 = self.0.wrapping_add(1);
            Ok(())
        }
    }
    let list = word_list();
    let first = generate_kit_words(&mut Counter(0)).expect("entropy");
    assert_eq!(first.expose(), list[..12].join(" ").as_bytes());
    // 62176 = 8 × 7772 is the limit: from 62170 on, six words are left, then the count wraps to 0.
    let around = generate_kit_words(&mut Counter(62_170)).expect("entropy");
    let expected = [&list[7766..], &list[..6]].concat().join(" ");
    assert_eq!(around.expose(), expected.as_bytes());
}

#[test]
fn a_recovery_code_is_shown_and_read() {
    let zeros = format_recovery_code(&secret(&[0; 32]));
    assert_eq!(
        zeros.expose(),
        b"0000-0000-0000-0000-0000-0000-0000-0000-0000-0000-0000-0000-0000"
    );
    let ones = format_recovery_code(&secret(&[0xff; 32]));
    assert_eq!(
        ones.expose(),
        b"ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZG"
    );
    assert!(format!("{ones:?}").contains("redacted"));
    for seed in 0..=255u8 {
        let bytes: Vec<u8> = (0..32u8)
            .map(|i| seed.wrapping_mul(31).wrapping_add(i.wrapping_mul(seed | 1)))
            .collect();
        let code = secret(&bytes);
        let shown =
            String::from_utf8(format_recovery_code(&code).expose().to_vec()).expect("utf-8");
        assert_eq!(shown.len(), 64);
        assert_eq!(parse_recovery_code(&shown), Ok(code));
    }
}

#[test]
fn a_recovery_code_is_read_as_typed() {
    let shown = "810M-4GT4-8N34-EJ29-995M-RKAE-9X85-2MJK-AHAN-CNTR-B5D5-PQ2X-BSFG";
    let code = parse_recovery_code(shown).expect("a code");
    for typed in [
        shown.to_lowercase(),
        shown.replace('-', ""),
        shown.replace('-', " "),
        format!("  {shown}\t\n"),
        shown.replace('-', " - "),
        shown.replace('0', "O").replace('1', "I"),
        shown.replace('0', "o").replace('1', "l"),
        shown.replace('1', "L"),
        shown.replace('-', "\u{a0}"),
        shown.replace('-', "\u{feff}"),
        // A dotless i is I in capitals, and I reads as 1.
        shown.replace('1', "\u{131}"),
    ] {
        assert_eq!(parse_recovery_code(&typed).as_ref(), Ok(&code), "{typed:?}");
    }
    for typed in [
        String::new(),
        "-".into(),
        shown[..shown.len() - 1].to_string(),
        format!("{shown}0"),
        format!("{shown}{shown}"),
        shown.replace('8', "U"),
        shown.replace('8', "!"),
        shown.replace('8', "é"),
        shown.replace('-', "_"),
        shown.replace('-', "\u{85}"),
        shown.replace('8', "😀"),
        // The last character holds one bit: G is 16, the only one besides 0 with four zero bits.
        format!("{}H", &shown[..shown.len() - 1]),
        format!("{}1", &shown[..shown.len() - 1]),
        format!("{}Z", &shown[..shown.len() - 1]),
    ] {
        assert_eq!(
            parse_recovery_code(&typed),
            Err(AccountError::BadRecoveryCode),
            "{typed:?}"
        );
    }
    assert!(parse_recovery_code(&format!("{}0", &shown[..shown.len() - 1])).is_ok());
}

#[test]
fn errors_carry_v1s_codes_and_the_protocols() {
    for (error, code) in [
        (AccountError::BadEmail, "bad-email"),
        (AccountError::WeakPassword, "weak-password"),
        (AccountError::BadKdf, "bad-kdf"),
        (AccountError::BadRecoveryWords, "bad-recovery-words"),
        (AccountError::BadRecoveryCode, "bad-recovery-code"),
        (AccountError::NoPrf, "no-prf"),
        (AccountError::Core(Error::WrongLogin), "wrong-login"),
        (AccountError::Core(Error::WrongRecovery), "wrong-recovery"),
        (AccountError::Core(Error::BadFormat), "bad-format"),
    ] {
        assert_eq!(error.code(), code);
        assert_eq!(error.to_string(), code);
    }
    assert_eq!(
        AccountError::from(Error::Entropy),
        AccountError::Core(Error::Entropy)
    );
}

#[test]
fn a_user_handle_is_fresh_random_bytes() {
    assert_ne!(
        generate_user_handle(&mut SystemEntropy).expect("entropy"),
        generate_user_handle(&mut SystemEntropy).expect("entropy")
    );
    assert_eq!(generate_user_handle(&mut NoEntropy), Err(Error::Entropy));
}

const KIT_WORDS_TEXT: &str =
    "acorn velvet tidy hamper oxford banjo cradle dolphin eagle fabric gallery harbor";
const ID_TEXT: &str = "0f8fad5b-d9cb-469f-a165-70867728950e";
const ID_BYTES: [u8; ACCOUNT_ID_LEN] = [
    0x0f, 0x8f, 0xad, 0x5b, 0xd9, 0xcb, 0x46, 0x9f, 0xa1, 0x65, 0x70, 0x86, 0x77, 0x28, 0x95, 0x0e,
];

#[test]
fn an_account_id_has_one_text() {
    let id = AccountId::parse(ID_TEXT).expect("an id");
    assert_eq!(id, AccountId::new(ID_BYTES));
    assert_eq!(id.as_bytes(), &ID_BYTES);
    assert_eq!(id.to_string(), ID_TEXT);
    assert_eq!(id.to_string().len(), ACCOUNT_ID_TEXT_LEN);
    assert_eq!(format!("{id:?}"), format!("AccountId({ID_TEXT})"));
    // No bit has a meaning: every value of the sixteen bytes is an id, and comes back from its text.
    for bytes in [[0u8; ACCOUNT_ID_LEN], [0xff; ACCOUNT_ID_LEN]] {
        let id = AccountId::new(bytes);
        assert_eq!(AccountId::parse(&id.to_string()), Ok(id));
    }
    assert_eq!(
        AccountId::new([0; ACCOUNT_ID_LEN]).to_string(),
        "00000000-0000-0000-0000-000000000000"
    );
    assert_eq!(
        AccountId::new([0xff; ACCOUNT_ID_LEN]).to_string(),
        "ffffffff-ffff-ffff-ffff-ffffffffffff"
    );
    for seed in 0..=255u8 {
        let mut bytes = [0u8; ACCOUNT_ID_LEN];
        for (at, byte) in bytes.iter_mut().enumerate() {
            *byte = seed
                .wrapping_mul(37)
                .wrapping_add((at as u8).wrapping_mul(seed | 1));
        }
        let id = AccountId::new(bytes);
        let text = id.to_string();
        assert_eq!(text.len(), ACCOUNT_ID_TEXT_LEN);
        assert_eq!(AccountId::parse(&text), Ok(id), "{text}");
    }
    assert_eq!(AccountId::from_slice(&ID_BYTES), Ok(id));
    for len in [0, 15, 17, 32] {
        assert_eq!(AccountId::from_slice(&vec![7; len]), Err(Error::BadFormat));
    }
}

#[test]
fn an_account_id_in_another_spelling_is_refused() {
    let refused = |text: &str| {
        assert_eq!(
            AccountId::parse(text),
            Err(AccountError::Core(Error::BadFormat)),
            "{text:?}"
        );
    };
    for (text, _) in trommi_tests::vectors::account::REFUSED_ID_TEXTS {
        refused(text);
    }
    // A capital in any place, and anything but the hyphen or a digit in any place.
    for at in 0..ACCOUNT_ID_TEXT_LEN {
        let with = |c: char| {
            let mut text: Vec<char> = ID_TEXT.chars().collect();
            text[at] = c;
            text.into_iter().collect::<String>()
        };
        let here = ID_TEXT.as_bytes()[at] as char;
        if here.is_ascii_lowercase() {
            refused(&with(here.to_ascii_uppercase()));
        }
        let swapped = if here == '-' { '0' } else { '-' };
        refused(&with(swapped));
        for c in [' ', '_', 'g', 'G', '\0', '\n', '{', '}', '/', ':', '`', '@'] {
            refused(&with(c));
        }
        // A character of several bytes, so that the text is longer in bytes and as long in characters.
        refused(&with('\u{ff10}'));
        // Every cut of the text.
        refused(&ID_TEXT[..at]);
    }
    for text in [
        format!("{ID_TEXT}\n"),
        format!(" {ID_TEXT}"),
        format!("{ID_TEXT} "),
        format!("{{{ID_TEXT}}}"),
        format!("{ID_TEXT}{ID_TEXT}"),
        ID_TEXT.replace('-', ""),
        ID_TEXT.replace('-', "\u{2010}"),
        // Thirty-six bytes whose characters are not: a two-byte digit in place of two digits.
        ID_TEXT.replacen("0f", "\u{660}", 1),
        "x".repeat(100_000),
    ] {
        refused(&text);
    }
}

#[test]
fn the_kit_of_an_account_without_an_email_derives_from_its_id() {
    let id = AccountId::new(ID_BYTES);
    let keys = kit_keys_for(AccountName::Id(&id), KIT_WORDS_TEXT).expect("derives");
    assert_ne!(keys.auth_key, keys.wrap_key);
    assert!(format!("{keys:?}").contains("redacted"));
    // The words are read as typed, as for every kit, and the id is the one its text names.
    let typed = KIT_WORDS_TEXT.to_uppercase().replace(' ', ",\n");
    let parsed = AccountId::parse(ID_TEXT).expect("an id");
    assert_eq!(
        kit_keys_for(AccountName::Id(&parsed), &typed).expect("derives"),
        keys
    );
    assert_eq!(
        kit_keys_for(AccountName::Id(&id), "acorn velvet").err(),
        Some(AccountError::BadRecoveryWords)
    );

    // Another id, in a single bit: other keys.
    for at in 0..ACCOUNT_ID_LEN {
        for bit in 0..8 {
            let mut bytes = ID_BYTES;
            bytes[at] ^= 1 << bit;
            let other = kit_keys_for(AccountName::Id(&AccountId::new(bytes)), KIT_WORDS_TEXT)
                .expect("derives");
            assert_ne!(other.auth_key, keys.auth_key);
            assert_ne!(other.wrap_key, keys.wrap_key);
        }
    }
    // Other words under the same id: other keys.
    let other_words = KIT_WORDS_TEXT.replace("acorn", "zebra");
    let other = kit_keys_for(AccountName::Id(&id), &other_words).expect("derives");
    assert_ne!(other.auth_key, keys.auth_key);
    assert_ne!(other.wrap_key, keys.wrap_key);
}

#[test]
fn an_email_account_keeps_its_keys_and_shares_none_with_an_id() {
    let v = vectors();
    let r = &v["recovery"];
    let email = text(&v, &["password", "email"]);
    let words = text(r, &["words"]);
    // The general entry gives an account with an e-mail the bytes it always had.
    let by_email = kit_keys_for(AccountName::Email(email), words).expect("derives");
    assert_eq!(by_email, kit_keys(email, words).expect("derives"));
    assert_eq!(
        base64url_encode(by_email.auth_key.expose()),
        text(r, &["recoveryAuthB64u"])
    );
    assert_eq!(
        by_email.wrap_key.expose().as_slice(),
        hex(text(r, &["wrapKey"]))
    );
    assert_eq!(
        kit_keys_for(AccountName::Email("owner"), words).err(),
        Some(AccountError::BadEmail)
    );

    // The same words under an id: other keys, whatever the id. An id whose bytes or text are the e-mail's
    // own would be the nearest to a collision; the bytes of an id are sixteen and enter under another label.
    let normalised = normalise_email(email).expect("an address");
    let mut from_email = [0u8; ACCOUNT_ID_LEN];
    from_email.copy_from_slice(&normalised.as_bytes()[..ACCOUNT_ID_LEN]);
    for id in [
        AccountId::new(ID_BYTES),
        AccountId::new([0; ACCOUNT_ID_LEN]),
        AccountId::new(from_email),
    ] {
        let by_id = kit_keys_for(AccountName::Id(&id), words).expect("derives");
        assert_ne!(by_id.auth_key, by_email.auth_key);
        assert_ne!(by_id.wrap_key, by_email.wrap_key);
    }
}

#[test]
fn a_kit_copy_opens_only_under_the_form_and_account_it_was_made_for() {
    let v = vectors();
    let email = text(&v, &["password", "email"]);
    let room = RoomId::new([4; 32]);
    let code = secret(&[5; 32]);
    let id = AccountId::new(ID_BYTES);
    let other_id = AccountId::new([7; ACCOUNT_ID_LEN]);
    let by_id = kit_keys_for(AccountName::Id(&id), KIT_WORDS_TEXT).expect("derives");
    let by_other_id = kit_keys_for(AccountName::Id(&other_id), KIT_WORDS_TEXT).expect("derives");
    let by_email = kit_keys_for(AccountName::Email(email), KIT_WORDS_TEXT).expect("derives");
    let wrong = Err(AccountError::Core(Error::WrongRecovery));

    let of_id =
        seal_code(&by_id.wrap_key, &room, Way::Kit, &code, &mut SystemEntropy).expect("seals");
    assert_eq!(of_id.len(), SEALED_COPY_LEN);
    assert_eq!(
        open_code(&by_id.wrap_key, &room, Way::Kit, &of_id).as_ref(),
        Ok(&code)
    );
    assert_eq!(
        open_code(&by_email.wrap_key, &room, Way::Kit, &of_id),
        wrong
    );
    assert_eq!(
        open_code(&by_other_id.wrap_key, &room, Way::Kit, &of_id),
        wrong
    );
    // Nor in another room, nor as the copy of another way in.
    assert_eq!(
        open_code(&by_id.wrap_key, &RoomId::new([6; 32]), Way::Kit, &of_id),
        wrong
    );
    assert_eq!(
        open_code(&by_id.wrap_key, &room, Way::Password, &of_id),
        Err(AccountError::Core(Error::WrongLogin))
    );

    let of_email = seal_code(
        &by_email.wrap_key,
        &room,
        Way::Kit,
        &code,
        &mut SystemEntropy,
    )
    .expect("seals");
    assert_eq!(
        open_code(&by_email.wrap_key, &room, Way::Kit, &of_email).as_ref(),
        Ok(&code)
    );
    assert_eq!(
        open_code(&by_id.wrap_key, &room, Way::Kit, &of_email),
        wrong
    );
}

#[test]
fn the_vectors_read_back() {
    use trommi_core::crypto::{hmac_sha256, sha256};
    use trommi_tests::vectors::account::{LABEL_ID_SALT, NAME, REFUSED_ID_TEXTS};
    use trommi_tests::vectors::{hex as to_hex, read, unhex};

    let file = read(NAME).expect("the file");
    let text = |value: &Value, key: &str| value[key].as_str().expect(key).to_owned();
    let bytes = |value: &Value, key: &str| unhex(&text(value, key)).expect("hex");

    // The id, in bytes and as every kit prints it.
    let id = AccountId::from_slice(&bytes(&file, "account_id")).expect("an id");
    assert_eq!(id.to_string(), text(&file, "account_id_text"));
    assert_eq!(AccountId::parse(&text(&file, "account_id_text")), Ok(id));

    // The salt by its definition, and the two keys by HKDF written out over HMAC: extract under the salt,
    // then one block of expand.
    assert_eq!(text(&file, "label_salt"), LABEL_ID_SALT);
    let salt_input = [LABEL_ID_SALT.as_bytes(), &[0], id.as_bytes().as_slice()].concat();
    assert_eq!(to_hex(&salt_input), text(&file, "salt_input"));
    let salt = sha256(&salt_input).expect("hashes");
    assert_eq!(to_hex(salt.as_bytes()), text(&file, "salt"));
    let words = text(&file, "words");
    assert_eq!(
        parse_kit_words(&words).expect("twelve words").expose(),
        words.as_bytes()
    );
    let prk = secret(&hmac_sha256(&secret(salt.as_bytes()), words.as_bytes()).expect("hmac"));
    let expand = |label: &str| {
        let info = [label.as_bytes(), &[0, 1]].concat();
        to_hex(&hmac_sha256(&prk, &info).expect("hmac"))
    };
    assert_eq!(expand("trommi/v1/recovery-auth"), text(&file, "auth_key"));
    assert_eq!(
        expand("trommi/v1/recovery-wrap-key"),
        text(&file, "wrap_key")
    );

    // The same through the interface.
    let keys = kit_keys_for(AccountName::Id(&id), &words).expect("derives");
    assert_eq!(to_hex(keys.auth_key.expose()), text(&file, "auth_key"));
    assert_eq!(to_hex(keys.wrap_key.expose()), text(&file, "wrap_key"));

    // The sealed copy is made again with its nonce, and opens.
    let room = RoomId::from_slice(&bytes(&file, "room_id")).expect("a room id");
    let code = secret(&bytes(&file, "code"));
    let sealed = bytes(&file, "sealed");
    assert_eq!(&sealed[1..13], bytes(&file, "nonce"));
    assert_eq!(
        seal_code(
            &keys.wrap_key,
            &room,
            Way::Kit,
            &code,
            &mut Fixed(bytes(&file, "nonce"))
        ),
        Ok(sealed.clone())
    );
    assert_eq!(
        open_code(&keys.wrap_key, &room, Way::Kit, &sealed).as_ref(),
        Ok(&code)
    );

    // Each case: the keys of the account named, and what the copy does under them.
    let cases = file["cases"].as_array().expect("cases");
    let mut results = std::collections::BTreeSet::new();
    let mut auth_keys = std::collections::BTreeSet::new();
    for case in cases {
        let why = text(case, "why");
        let account = &case["account"];
        let other;
        let name = match (account.get("id"), account.get("email")) {
            (Some(id), None) => {
                other = AccountId::parse(id.as_str().expect("text")).expect("an id");
                AccountName::Id(&other)
            }
            (None, Some(email)) => AccountName::Email(email.as_str().expect("text")),
            _ => panic!("{why}: an account has one name"),
        };
        let keys = kit_keys_for(name, &words).expect("derives");
        assert_eq!(
            to_hex(keys.auth_key.expose()),
            text(case, "auth_key"),
            "{why}"
        );
        assert_eq!(
            to_hex(keys.wrap_key.expose()),
            text(case, "wrap_key"),
            "{why}"
        );
        let result = match open_code(&keys.wrap_key, &room, Way::Kit, &sealed) {
            Ok(code) => format!("opens: {}", to_hex(code.expose())),
            Err(error) => error.code().to_owned(),
        };
        assert_eq!(result, text(case, "result"), "{why}");
        results.insert(result);
        auth_keys.insert(text(case, "auth_key"));
    }
    assert_eq!(cases.len(), 3);
    assert_eq!(auth_keys.len(), 3, "three accounts, three keys");
    assert_eq!(
        results.into_iter().collect::<Vec<_>>(),
        [
            format!("opens: {}", text(&file, "code")),
            "wrong-recovery".to_owned()
        ]
    );
    assert_eq!(text(&cases[0], "auth_key"), text(&file, "auth_key"));

    let refused = file["refused_id_texts"].as_array().expect("texts");
    assert_eq!(refused.len(), REFUSED_ID_TEXTS.len());
    for entry in refused {
        assert_eq!(
            AccountId::parse(&text(entry, "text")),
            Err(AccountError::Core(Error::BadFormat)),
            "{}",
            text(entry, "why")
        );
    }
}
