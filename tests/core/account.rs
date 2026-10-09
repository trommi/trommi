//! The account's sealed copies of the recovery code (section 8.8): password, Emergency Kit words and passkey,
//! against `spec/account-vectors.json`.

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
