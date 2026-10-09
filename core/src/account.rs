//! The account's sealed copies of the recovery code (section 8.8): under the password, the Emergency Kit words
//! and each passkey.
//!
//! An account (an e-mail with a password, passkeys or both, and an Emergency Kit) is a way to the room's recovery
//! code: each way opens one sealed copy of it, and a device that holds the code joins the room (section 8.4).
//! The hub never sees the password, the kit's words, a passkey's output or the code.
//!
//! This is v1 section 16 byte for byte, with v1's labels and v1's primitives (HKDF-SHA-256 with a salt,
//! AES-256-GCM, Argon2id), the one place where the protocol keeps them: the copies an account already holds
//! stay readable. `spec/account-vectors.json` holds the known answers.
//!
//! ```text
//! salt           = SHA-256("trommi/v1/account-salt" 0x00 ‖ email)
//! master         = Argon2id(password as NFC UTF-8, salt, m = 64 MiB, t = 3, p = 1, 32 bytes)
//! K(ikm, label)  = HKDF-SHA-256(ikm, salt, info = label 0x00, 32 bytes)
//! auth key       = K(master, "trommi/v1/account-auth")        wrap key     = K(master, "trommi/v1/account-wrap-key")
//! kit auth key   = K(r, "trommi/v1/recovery-auth")            kit wrap key = K(r, "trommi/v1/recovery-wrap-key")
//! passkey wrap key = HKDF-SHA-256(prf(32), salt = room_id, info = "trommi/v1/passkey-wrap-key" 0x00 ‖ credential id, 32)
//! sealed copy    = 0x02 ‖ nonce(12) ‖ AES-256-GCM(key, nonce, aad, code(32))                                61 bytes
//! aad            = "trommi/v1/account-wrap" 0x00 ‖ room_id ‖ "password" | "recovery" | "passkey" ‖ credential id
//! ```
//!
//! `r` is the UTF-8 of the kit's twelve lowercase words joined by one space. The two auth keys go to the hub,
//! which keeps a slow hash of each and hands out a sealed copy only to who presents one; the wrap keys never
//! leave the device.
//!
//! The codes of this module's own refusals are v1's and are not among section 16's: [`AccountError`] carries
//! them.

use crate::crypto::{self, Entropy, Secret, SecretBytes, NONCE_LEN, TAG_LEN};
use crate::error::Error;
use crate::ids::RoomId;
use argon2::{Algorithm, Argon2, Block, Params, Version};
use openmls_traits::crypto::OpenMlsCrypto;
use openmls_traits::types::{AeadType, HashType};
use std::fmt;
use std::sync::OnceLock;
use unicode_normalization::UnicodeNormalization;
use zeroize::{Zeroize, Zeroizing};

const LABEL_SALT: &str = "trommi/v1/account-salt";
const LABEL_AUTH: &str = "trommi/v1/account-auth";
const LABEL_WRAP_KEY: &str = "trommi/v1/account-wrap-key";
const LABEL_KIT_AUTH: &str = "trommi/v1/recovery-auth";
const LABEL_KIT_WRAP_KEY: &str = "trommi/v1/recovery-wrap-key";
const LABEL_WRAP_AAD: &str = "trommi/v1/account-wrap";
const LABEL_PASSKEY_WRAP_KEY: &str = "trommi/v1/passkey-wrap-key";

/// The fixed input every passkey of an account evaluates its prf over: a constant of the client, never chosen
/// by a hub.
pub const PASSKEY_PRF_INPUT: &[u8] = b"trommi/v1/passkey-prf";
/// The length of a passkey's prf output.
pub const PRF_LEN: usize = 32;
/// The longest credential id WebAuthn allows.
pub const MAX_CREDENTIAL_ID_LEN: usize = 1023;
/// The fewest code points of a password, counted in its NFC form.
pub const PASSWORD_MIN: usize = 12;
/// The words of an Emergency Kit.
pub const KIT_WORDS: usize = 12;
/// Room for twelve words of the list (none is longer than nine letters) and the spaces between, so that the
/// text never moves while it grows.
const KIT_TEXT_CAPACITY: usize = KIT_WORDS * 10;
/// The length of a sealed copy of the recovery code.
pub const SEALED_COPY_LEN: usize = 1 + NONCE_LEN + 32 + TAG_LEN;
/// The first byte of a sealed copy.
const SEALED_COPY_VERSION: u8 = 2;
/// The key derivation record of an account as this client writes it, and the only one it derives with.
pub const KDF_RECORD: &str = r#"{"alg":"argon2id","v":1,"m":65536,"t":3,"p":1}"#;
/// The longest key derivation record that is read, the longest text read as Emergency Kit words, and as a
/// recovery code: what a hub or a person gives is many times shorter.
pub const MAX_KDF_RECORD_LEN: usize = 1024;
pub const MAX_KIT_TEXT_LEN: usize = 1024;
pub const MAX_CODE_TEXT_LEN: usize = 1024;
const KDF_ALG: &str = "argon2id";
const KDF_RECORD_VERSION: f64 = 1.0;
const KDF_MEMORY_KIB: u32 = 65536;
const KDF_PASSES: u32 = 3;
const KDF_LANES: u32 = 1;

const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/// The characters of a recovery code: 256 bits, five to a character, the last one holding a single bit.
const CODE_CHARS: usize = 52;

/// What the account refuses. The first six codes are v1's own (section 16 of v1); everything else is an
/// [`Error`] of the protocol.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AccountError {
    /// `bad-email`: not an e-mail address as the account keeps one.
    BadEmail,
    /// `weak-password`: fewer than twelve code points.
    WeakPassword,
    /// `bad-kdf`: the account names key derivation parameters this client does not use.
    BadKdf,
    /// `bad-recovery-words`: not twelve words of the Emergency Kit's list.
    BadRecoveryWords,
    /// `bad-recovery-code`: not a recovery code.
    BadRecoveryCode,
    /// `no-prf`: the passkey gave no key.
    NoPrf,
    /// An error of the protocol: `bad-format` for a sealed copy of another form, `wrong-login` or
    /// `wrong-recovery` for one that does not open, `entropy`, `internal`.
    Core(Error),
}

impl AccountError {
    /// The stable code of this error.
    pub fn code(&self) -> &'static str {
        match self {
            AccountError::BadEmail => "bad-email",
            AccountError::WeakPassword => "weak-password",
            AccountError::BadKdf => "bad-kdf",
            AccountError::BadRecoveryWords => "bad-recovery-words",
            AccountError::BadRecoveryCode => "bad-recovery-code",
            AccountError::NoPrf => "no-prf",
            AccountError::Core(error) => error.code(),
        }
    }
}

impl From<Error> for AccountError {
    fn from(error: Error) -> Self {
        AccountError::Core(error)
    }
}

impl fmt::Display for AccountError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AccountError::Core(error) => error.fmt(f),
            other => f.write_str(other.code()),
        }
    }
}

impl std::error::Error for AccountError {}

fn provider_fault<T>(_: T) -> Error {
    Error::Internal("crypto provider")
}

/// `label 0x00 ‖ more`: how every label of v1 is used.
fn labelled(label: &str, more: &[&[u8]]) -> Vec<u8> {
    let mut bytes = [label.as_bytes(), &[0]].concat();
    for part in more {
        bytes.extend_from_slice(part);
    }
    bytes
}

/// HKDF-SHA-256 (RFC 5869), extract and expand, 32 bytes.
fn hkdf(ikm: &[u8], salt: &[u8], info: &[u8]) -> Result<Secret<32>, Error> {
    let provider = crypto::rust_crypto()?;
    let prk = provider
        .hkdf_extract(HashType::Sha2_256, salt, ikm)
        .map_err(provider_fault)?;
    let okm = provider
        .hkdf_expand(HashType::Sha2_256, prk.as_slice(), info, 32)
        .map_err(provider_fault)?;
    Secret::from_slice(okm.as_slice()).map_err(|_| Error::Internal("hkdf length"))
}

/// An e-mail address as the account keeps it; its bytes are the input of the account's salt. The rule is spelled
/// out over single characters and uses no Unicode table:
///
/// 1. Leading and trailing space, tab, line feed, vertical tab, form feed and carriage return are dropped.
/// 2. Every character left is printable ASCII, U+0021 to U+007E. Anything else is refused, never mapped.
/// 3. `A` to `Z` become `a` to `z`.
/// 4. At most 254 characters; exactly one `@`; 1 to 64 characters before it; after it a `.` with 1 to 190
///    characters before and 2 to 63 after.
///
/// Anything else is `bad-email`.
pub fn normalise_email(email: &str) -> Result<String, AccountError> {
    let blank = |c: char| c == ' ' || ('\t'..='\r').contains(&c);
    let trimmed = email.trim_matches(blank);
    if trimmed.len() > 254 || !trimmed.bytes().all(|b| (0x21..=0x7e).contains(&b)) {
        return Err(AccountError::BadEmail);
    }
    let normalised = trimmed.to_ascii_lowercase();
    let (local, domain) = normalised.split_once('@').ok_or(AccountError::BadEmail)?;
    if domain.contains('@') || !(1..=64).contains(&local.len()) {
        return Err(AccountError::BadEmail);
    }
    let dot_fits = |(before, _): (usize, char)| {
        let after = domain.len().saturating_sub(before).saturating_sub(1);
        (1..=190).contains(&before) && (2..=63).contains(&after)
    };
    if !domain
        .char_indices()
        .filter(|(_, c)| *c == '.')
        .any(dot_fits)
    {
        return Err(AccountError::BadEmail);
    }
    Ok(normalised)
}

/// The password in the form everything is derived from: NFC.
fn nfc(password: &str) -> Zeroizing<String> {
    Zeroizing::new(password.nfc().collect())
}

/// Whether a password may be set: its NFC form has at least twelve code points; else `weak-password`. A password
/// an account already has is not judged again when it is used.
pub fn check_password(password: &str) -> Result<(), AccountError> {
    if nfc(password).chars().count() >= PASSWORD_MIN {
        Ok(())
    } else {
        Err(AccountError::WeakPassword)
    }
}

/// Whether a key derivation record, as the JSON a hub hands out, may be derived with: only if `alg`, `v`, `m`,
/// `t` and `p` are exactly `"argon2id"`, 1, 65536, 3 and 1; other fields are ignored. No record, or `null`, is
/// that pinned set. Anything else, a record above [`MAX_KDF_RECORD_LEN`] bytes included, is `bad-kdf`, and
/// nothing is derived: a hub does not choose what a derivation of the password costs.
pub fn accept_kdf(record: Option<&str>) -> Result<(), AccountError> {
    let Some(record) = record else {
        return Ok(());
    };
    if record.len() > MAX_KDF_RECORD_LEN {
        return Err(AccountError::BadKdf);
    }
    let value: serde_json::Value =
        serde_json::from_str(record).map_err(|_| AccountError::BadKdf)?;
    if value.is_null() {
        return Ok(());
    }
    let number = |name: &str| value.get(name).and_then(serde_json::Value::as_f64);
    let pinned = value.is_object()
        && value.get("alg").and_then(serde_json::Value::as_str) == Some(KDF_ALG)
        && number("v") == Some(KDF_RECORD_VERSION)
        && number("m") == Some(f64::from(KDF_MEMORY_KIB))
        && number("t") == Some(f64::from(KDF_PASSES))
        && number("p") == Some(f64::from(KDF_LANES));
    if pinned {
        Ok(())
    } else {
        Err(AccountError::BadKdf)
    }
}

/// `SHA-256("trommi/v1/account-salt" 0x00 ‖ email)`, for an e-mail that is normalised already.
fn account_salt(normalised_email: &str) -> Result<[u8; 32], Error> {
    Ok(*crypto::sha256(&labelled(LABEL_SALT, &[normalised_email.as_bytes()]))?.as_bytes())
}

/// Argon2id version 1.3 with the pinned parameters. The 64 MiB it works in are wiped afterwards.
fn argon2id(password: &[u8], salt: &[u8; 32]) -> Result<Secret<32>, Error> {
    let fault = |_| Error::Internal("argon2");
    let params = Params::new(KDF_MEMORY_KIB, KDF_PASSES, KDF_LANES, Some(32)).map_err(fault)?;
    let mut memory: Vec<Block> = Vec::new();
    memory
        .try_reserve_exact(params.block_count())
        .map_err(|_| Error::Internal("argon2 memory"))?;
    memory.resize(params.block_count(), Block::default());
    let mut master = Zeroizing::new([0u8; 32]);
    let result = Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into_with_memory(password, salt, master.as_mut_slice(), &mut memory);
    memory.zeroize();
    result.map_err(fault)?;
    Ok(Secret::new(*master))
}

/// The master key of an account: the slow step, about a second. `kdf` is the hub's record for the account, if it
/// gave one: `bad-kdf` unless [`accept_kdf`] takes it, before anything is derived. `bad-email` for an address
/// that is none.
pub fn master_key(
    email: &str,
    password: &str,
    kdf: Option<&str>,
) -> Result<Secret<32>, AccountError> {
    accept_kdf(kdf)?;
    let salt = account_salt(&normalise_email(email)?)?;
    Ok(argon2id(nfc(password).as_bytes(), &salt)?)
}

/// What follows from e-mail and password.
#[derive(Debug, PartialEq, Eq)]
pub struct PasswordKeys {
    /// Sent to the hub at sign-in, which keeps only a slow hash of it.
    pub auth_key: Secret<32>,
    /// Opens the copy of the code sealed under the password. Never leaves the device.
    pub wrap_key: Secret<32>,
}

/// The two keys of a master key, for the account of `email`. `bad-email` for an address that is none.
pub fn keys_from_master(email: &str, master: &Secret<32>) -> Result<PasswordKeys, AccountError> {
    let salt = account_salt(&normalise_email(email)?)?;
    Ok(PasswordKeys {
        auth_key: hkdf(master.expose(), &salt, &labelled(LABEL_AUTH, &[]))?,
        wrap_key: hkdf(master.expose(), &salt, &labelled(LABEL_WRAP_KEY, &[]))?,
    })
}

/// The two keys of e-mail and password: [`master_key`], then [`keys_from_master`].
pub fn password_keys(
    email: &str,
    password: &str,
    kdf: Option<&str>,
) -> Result<PasswordKeys, AccountError> {
    keys_from_master(email, &master_key(email, password, kdf)?)
}

/// What follows from e-mail and the Emergency Kit's words.
#[derive(Debug, PartialEq, Eq)]
pub struct KitKeys {
    /// What the hub checks before it hands out the kit's copy; it keeps only a slow hash of it.
    pub auth_key: Secret<32>,
    /// Opens the copy of the code sealed under the kit. Never leaves the device.
    pub wrap_key: Secret<32>,
}

/// The two keys of the Emergency Kit's words, as typed, for the account of `email`. There is no slow step: twelve
/// random words hold about 155 bits. `bad-email`; `bad-recovery-words` unless the text is twelve words of the
/// list.
pub fn kit_keys(email: &str, words: &str) -> Result<KitKeys, AccountError> {
    let salt = account_salt(&normalise_email(email)?)?;
    let words = parse_kit_words(words)?;
    Ok(KitKeys {
        auth_key: hkdf(words.expose(), &salt, &labelled(LABEL_KIT_AUTH, &[]))?,
        wrap_key: hkdf(words.expose(), &salt, &labelled(LABEL_KIT_WRAP_KEY, &[]))?,
    })
}

/// The key that opens the copy of the code sealed under one passkey, from the passkey's prf output over
/// [`PASSKEY_PRF_INPUT`]. `no-prf` unless `prf` is 32 bytes; `bad-format` for a credential id that is empty or
/// longer than WebAuthn allows.
pub fn passkey_wrap_key(
    prf: &[u8],
    room_id: &RoomId,
    credential_id: &[u8],
) -> Result<Secret<32>, AccountError> {
    if prf.len() != PRF_LEN {
        return Err(AccountError::NoPrf);
    }
    check_credential_id(credential_id)?;
    let info = labelled(LABEL_PASSKEY_WRAP_KEY, &[credential_id]);
    Ok(hkdf(prf, room_id.as_bytes(), &info)?)
}

fn check_credential_id(credential_id: &[u8]) -> Result<(), Error> {
    if credential_id.is_empty() || credential_id.len() > MAX_CREDENTIAL_ID_LEN {
        return Err(Error::BadFormat);
    }
    Ok(())
}

/// Which way in a sealed copy belongs to: it is part of what the copy is sealed with, so a copy opens only as
/// what it was made for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Way<'a> {
    /// Under the password's wrap key.
    Password,
    /// Under the Emergency Kit's wrap key.
    Kit,
    /// Under the wrap key of the passkey with this credential id.
    Passkey {
        /// The passkey's credential id.
        credential_id: &'a [u8],
    },
}

/// `"trommi/v1/account-wrap" 0x00 ‖ room_id ‖ what ‖ credential id`.
fn sealing_aad(room_id: &RoomId, way: Way<'_>) -> Result<Vec<u8>, Error> {
    let (what, credential_id): (&[u8], &[u8]) = match way {
        Way::Password => (b"password", &[]),
        Way::Kit => (b"recovery", &[]),
        Way::Passkey { credential_id } => {
            check_credential_id(credential_id)?;
            (b"passkey", credential_id)
        }
    };
    Ok(labelled(
        LABEL_WRAP_AAD,
        &[room_id.as_bytes().as_slice(), what, credential_id],
    ))
}

/// Seals the recovery code under a wrap key, for one room and one way in: `0x02 ‖ nonce ‖ AES-256-GCM`, 61 bytes,
/// with a fresh random nonce.
pub fn seal_code(
    wrap_key: &Secret<32>,
    room_id: &RoomId,
    way: Way<'_>,
    code: &Secret<32>,
    entropy: &mut dyn Entropy,
) -> Result<Vec<u8>, AccountError> {
    let aad = sealing_aad(room_id, way)?;
    let nonce: [u8; NONCE_LEN] = crypto::random(entropy)?;
    let ciphertext = crypto::rust_crypto()?
        .aead_encrypt(
            AeadType::Aes256Gcm,
            wrap_key.expose(),
            code.expose(),
            &nonce,
            &aad,
        )
        .map_err(provider_fault)?;
    Ok([&[SEALED_COPY_VERSION], nonce.as_slice(), &ciphertext].concat())
}

/// Opens a sealed copy of the recovery code. `bad-format` for a copy of another length or first byte (a copy
/// that starts with 0x01 is refused, not converted); when it does not open under this key, room and way:
/// `wrong-recovery` for the kit's copy, `wrong-login` for the others.
pub fn open_code(
    wrap_key: &Secret<32>,
    room_id: &RoomId,
    way: Way<'_>,
    sealed: &[u8],
) -> Result<Secret<32>, AccountError> {
    let aad = sealing_aad(room_id, way)?;
    let ciphertext = match sealed.split_first() {
        Some((&SEALED_COPY_VERSION, rest)) if sealed.len() == SEALED_COPY_LEN => rest,
        _ => return Err(Error::BadFormat.into()),
    };
    let (nonce, ciphertext) = ciphertext
        .split_first_chunk::<NONCE_LEN>()
        .ok_or(Error::BadFormat)?;
    let does_not_open = match way {
        Way::Kit => Error::WrongRecovery,
        Way::Password | Way::Passkey { .. } => Error::WrongLogin,
    };
    let code = crypto::rust_crypto()?
        .aead_decrypt(
            AeadType::Aes256Gcm,
            wrap_key.expose(),
            ciphertext,
            nonce,
            &aad,
        )
        .map(Zeroizing::new)
        .map_err(|_| does_not_open.clone())?;
    Secret::from_slice(&code).map_err(|_| does_not_open.into())
}

/// The user handle a new passkey is made with: 32 random bytes.
pub fn generate_user_handle(entropy: &mut dyn Entropy) -> Result<[u8; 32], Error> {
    crypto::random(entropy)
}

/// The Emergency Kit's word list: the EFF large word list without its four hyphenated words, so that anything but
/// a letter separates words. 7772 words, in alphabetical order; the same list as `app/web/core/wordlist.ts`.
/// (EFF large wordlist, CC BY 3.0 US, Electronic Frontier Foundation.)
const WORD_LIST: &str = "\
    abacus abdomen abdominal abide abiding ability ablaze able abnormal abrasion abrasive abreast abridge \
    abroad abruptly absence absentee absently absinthe absolute absolve abstain abstract absurd accent acclaim \
    acclimate accompany account accuracy accurate accustom acetone achiness aching acid acorn acquaint acquire \
    acre acrobat acronym acting action activate activator active activism activist activity actress acts \
    acutely acuteness aeration aerobics aerosol aerospace afar affair affected affecting affection affidavit \
    affiliate affirm affix afflicted affluent afford affront aflame afloat aflutter afoot afraid afterglow \
    afterlife aftermath aftermost afternoon aged ageless agency agenda agent aggregate aghast agile agility \
    aging agnostic agonize agonizing agony agreeable agreeably agreed agreeing agreement aground ahead ahoy \
    aide aids aim ajar alabaster alarm albatross album alfalfa algebra algorithm alias alibi alienable alienate \
    aliens alike alive alkaline alkalize almanac almighty almost aloe aloft aloha alone alongside aloof \
    alphabet alright although altitude alto aluminum alumni always amaretto amaze amazingly amber ambiance \
    ambiguity ambiguous ambition ambitious ambulance ambush amendable amendment amends amenity amiable amicably \
    amid amigo amino amiss ammonia ammonium amnesty amniotic among amount amperage ample amplifier amplify \
    amply amuck amulet amusable amused amusement amuser amusing anaconda anaerobic anagram anatomist anatomy \
    anchor anchovy ancient android anemia anemic aneurism anew angelfish angelic anger angled angler angles \
    angling angrily angriness anguished angular animal animate animating animation animator anime animosity \
    ankle annex annotate announcer annoying annually annuity anointer another answering antacid antarctic \
    anteater antelope antennae anthem anthill anthology antibody antics antidote antihero antiquely antiques \
    antiquity antirust antitoxic antitrust antiviral antivirus antler antonym antsy anvil anybody anyhow \
    anymore anyone anyplace anything anytime anyway anywhere aorta apache apostle appealing appear appease \
    appeasing appendage appendix appetite appetizer applaud applause apple appliance applicant applied apply \
    appointee appraisal appraiser apprehend approach approval approve apricot april apron aptitude aptly aqua \
    aqueduct arbitrary arbitrate ardently area arena arguable arguably argue arise armadillo armband armchair \
    armed armful armhole arming armless armoire armored armory armrest army aroma arose around arousal arrange \
    array arrest arrival arrive arrogance arrogant arson art ascend ascension ascent ascertain ashamed ashen \
    ashes ashy aside askew asleep asparagus aspect aspirate aspire aspirin astonish astound astride astrology \
    astronaut astronomy astute atlantic atlas atom atonable atop atrium atrocious atrophy attach attain attempt \
    attendant attendee attention attentive attest attic attire attitude attractor attribute atypical auction \
    audacious audacity audible audibly audience audio audition augmented august authentic author autism \
    autistic autograph automaker automated automatic autopilot available avalanche avatar avenge avenging \
    avenue average aversion avert aviation aviator avid avoid await awaken award aware awhile awkward awning \
    awoke awry axis babble babbling babied baboon backache backboard backboned backdrop backed backer backfield \
    backfire backhand backing backlands backlash backless backlight backlit backlog backpack backpedal backrest \
    backroom backshift backside backslid backspace backspin backstab backstage backtalk backtrack backup \
    backward backwash backwater backyard bacon bacteria bacterium badass badge badland badly badness baffle \
    baffling bagel bagful baggage bagged baggie bagginess bagging baggy bagpipe baguette baked bakery bakeshop \
    baking balance balancing balcony balmy balsamic bamboo banana banish banister banjo bankable bankbook \
    banked banker banking banknote bankroll banner bannister banshee banter barbecue barbed barbell barber \
    barcode barge bargraph barista baritone barley barmaid barman barn barometer barrack barracuda barrel \
    barrette barricade barrier barstool bartender barterer bash basically basics basil basin basis basket \
    batboy batch bath baton bats battalion battered battering battery batting battle bauble bazooka blabber \
    bladder blade blah blame blaming blanching blandness blank blaspheme blasphemy blast blatancy blatantly \
    blazer blazing bleach bleak bleep blemish blend bless blighted blimp bling blinked blinker blinking blinks \
    blip blissful blitz blizzard bloated bloating blob blog bloomers blooming blooper blot blouse blubber bluff \
    bluish blunderer blunt blurb blurred blurry blurt blush blustery boaster boastful boasting boat bobbed \
    bobbing bobble bobcat bobsled bobtail bodacious body bogged boggle bogus boil bok bolster bolt bonanza \
    bonded bonding bondless boned bonehead boneless bonelike boney bonfire bonnet bonsai bonus bony boogeyman \
    boogieman book boondocks booted booth bootie booting bootlace bootleg boots boozy borax boring borough \
    borrower borrowing boss botanical botanist botany botch both bottle bottling bottom bounce bouncing bouncy \
    bounding boundless bountiful bovine boxcar boxer boxing boxlike boxy breach breath breeches breeching \
    breeder breeding breeze breezy brethren brewery brewing briar bribe brick bride bridged brigade bright \
    brilliant brim bring brink brisket briskly briskness bristle brittle broadband broadcast broaden broadly \
    broadness broadside broadways broiler broiling broken broker bronchial bronco bronze bronzing brook broom \
    brought browbeat brownnose browse browsing bruising brunch brunette brunt brush brussels brute brutishly \
    bubble bubbling bubbly buccaneer bucked bucket buckle buckshot buckskin bucktooth buckwheat buddhism \
    buddhist budding buddy budget buffalo buffed buffer buffing buffoon buggy bulb bulge bulginess bulgur bulk \
    bulldog bulldozer bullfight bullfrog bullhorn bullion bullish bullpen bullring bullseye bullwhip bully \
    bunch bundle bungee bunion bunkbed bunkhouse bunkmate bunny bunt busboy bush busily busload bust busybody \
    buzz cabana cabbage cabbie cabdriver cable caboose cache cackle cacti cactus caddie caddy cadet cadillac \
    cadmium cage cahoots cake calamari calamity calcium calculate calculus caliber calibrate calm caloric \
    calorie calzone camcorder cameo camera camisole camper campfire camping campsite campus canal canary cancel \
    candied candle candy cane canine canister cannabis canned canning cannon cannot canola canon canopener \
    canopy canteen canyon capable capably capacity cape capillary capital capitol capped capricorn capsize \
    capsule caption captivate captive captivity capture caramel carat caravan carbon cardboard carded cardiac \
    cardigan cardinal cardstock carefully caregiver careless caress caretaker cargo caring carless carload \
    carmaker carnage carnation carnival carnivore carol carpenter carpentry carpool carport carried carrot \
    carrousel carry cartel cartload carton cartoon cartridge cartwheel carve carving carwash cascade case cash \
    casing casino casket cassette casually casualty catacomb catalog catalyst catalyze catapult cataract \
    catatonic catcall catchable catcher catching catchy caterer catering catfight catfish cathedral cathouse \
    catlike catnap catnip catsup cattail cattishly cattle catty catwalk caucasian caucus causal causation cause \
    causing cauterize caution cautious cavalier cavalry caviar cavity cedar celery celestial celibacy celibate \
    celtic cement census ceramics ceremony certainly certainty certified certify cesarean cesspool chafe \
    chaffing chain chair chalice challenge chamber chamomile champion chance change channel chant chaos \
    chaperone chaplain chapped chaps chapter character charbroil charcoal charger charging chariot charity \
    charm charred charter charting chase chasing chaste chastise chastity chatroom chatter chatting chatty \
    cheating cheddar cheek cheer cheese cheesy chef chemicals chemist chemo cherisher cherub chess chest \
    chevron chevy chewable chewer chewing chewy chief chihuahua childcare childhood childish childless \
    childlike chili chill chimp chip chirping chirpy chitchat chivalry chive chloride chlorine choice chokehold \
    choking chomp chooser choosing choosy chop chosen chowder chowtime chrome chubby chuck chug chummy chump \
    chunk churn chute cider cilantro cinch cinema cinnamon circle circling circular circulate circus citable \
    citadel citation citizen citric citrus city civic civil clad claim clambake clammy clamor clamp clamshell \
    clang clanking clapped clapper clapping clarify clarinet clarity clash clasp class clatter clause clavicle \
    claw clay clean clear cleat cleaver cleft clench clergyman clerical clerk clever clicker client climate \
    climatic cling clinic clinking clip clique cloak clobber clock clone cloning closable closure clothes \
    clothing cloud clover clubbed clubbing clubhouse clump clumsily clumsy clunky clustered clutch clutter \
    coach coagulant coastal coaster coasting coastland coastline coat coauthor cobalt cobbler cobweb cocoa \
    coconut cod coeditor coerce coexist coffee cofounder cognition cognitive cogwheel coherence coherent \
    cohesive coil coke cola cold coleslaw coliseum collage collapse collar collected collector collide collie \
    collision colonial colonist colonize colony colossal colt coma come comfort comfy comic coming comma \
    commence commend comment commerce commode commodity commodore common commotion commute commuting compacted \
    compacter compactly compactor companion company compare compel compile comply component composed composer \
    composite compost composure compound compress comprised computer computing comrade concave conceal conceded \
    concept concerned concert conch concierge concise conclude concrete concur condense condiment condition \
    condone conducive conductor conduit cone confess confetti confidant confident confider confiding configure \
    confined confining confirm conflict conform confound confront confused confusing confusion congenial \
    congested congrats congress conical conjoined conjure conjuror connected connector consensus consent \
    console consoling consonant constable constant constrain constrict construct consult consumer consuming \
    contact container contempt contend contented contently contents contest context contort contour contrite \
    control contusion convene convent copartner cope copied copier copilot coping copious copper copy coral \
    cork cornball cornbread corncob cornea corned corner cornfield cornflake cornhusk cornmeal cornstalk corny \
    coronary coroner corporal corporate corral correct corridor corrode corroding corrosive corsage corset \
    cortex cosigner cosmetics cosmic cosmos cosponsor cost cottage cotton couch cough could countable countdown \
    counting countless country county courier covenant cover coveted coveting coyness cozily coziness cozy \
    crabbing crabgrass crablike crabmeat cradle cradling crafter craftily craftsman craftwork crafty cramp \
    cranberry crane cranial cranium crank crate crave craving crawfish crawlers crawling crayfish crayon crazed \
    crazily craziness crazy creamed creamer creamlike crease creasing creatable create creation creative \
    creature credible credibly credit creed creme creole crepe crept crescent crested cresting crestless \
    crevice crewless crewman crewmate crib cricket cried crier crimp crimson cringe cringing crinkle crinkly \
    crisped crisping crisply crispness crispy criteria critter croak crock crook croon crop cross crouch \
    crouton crowbar crowd crown crucial crudely crudeness cruelly cruelness cruelty crumb crummiest crummy \
    crumpet crumpled cruncher crunching crunchy crusader crushable crushed crusher crushing crust crux crying \
    cryptic crystal cubbyhole cube cubical cubicle cucumber cuddle cuddly cufflink culinary culminate culpable \
    culprit cultivate cultural culture cupbearer cupcake cupid cupped cupping curable curator curdle cure \
    curfew curing curled curler curliness curling curly curry curse cursive cursor curtain curtly curtsy \
    curvature curve curvy cushy cusp cussed custard custodian custody customary customer customize customs cut \
    cycle cyclic cycling cyclist cylinder cymbal cytoplasm cytoplast dab dad daffodil dagger daily daintily \
    dainty dairy daisy dallying dance dancing dandelion dander dandruff dandy danger dangle dangling daredevil \
    dares daringly darkened darkening darkish darkness darkroom darling darn dart darwinism dash dastardly data \
    datebook dating daughter daunting dawdler dawn daybed daybreak daycare daydream daylight daylong dayroom \
    daytime dazzler dazzling deacon deafening deafness dealer dealing dealmaker dealt dean debatable debate \
    debating debit debrief debtless debtor debug debunk decade decaf decal decathlon decay deceased deceit \
    deceiver deceiving december decency decent deception deceptive decibel decidable decimal decimeter decipher \
    deck declared decline decode decompose decorated decorator decoy decrease decree dedicate dedicator deduce \
    deduct deed deem deepen deeply deepness deface defacing defame default defeat defection defective defendant \
    defender defense defensive deferral deferred defiance defiant defile defiling define definite deflate \
    deflation deflator deflected deflector defog deforest defraud defrost deftly defuse defy degraded degrading \
    degrease degree dehydrate deity dejected delay delegate delegator delete deletion delicacy delicate \
    delicious delighted delirious delirium deliverer delivery delouse delta deluge delusion deluxe demanding \
    demeaning demeanor demise democracy democrat demote demotion demystify denatured deniable denial denim \
    denote dense density dental dentist denture deny deodorant deodorize departed departure depict deplete \
    depletion deplored deploy deport depose depraved depravity deprecate depress deprive depth deputize deputy \
    derail deranged derby derived desecrate deserve deserving designate designed designer designing deskbound \
    desktop deskwork desolate despair despise despite destiny destitute destruct detached detail detection \
    detective detector detention detergent detest detonate detonator detoxify detract deuce devalue deviancy \
    deviant deviate deviation deviator device devious devotedly devotee devotion devourer devouring devoutly \
    dexterity dexterous diabetes diabetic diabolic diagnoses diagnosis diagram dial diameter diaper diaphragm \
    diary dice dicing dictate dictation dictator difficult diffused diffuser diffusion diffusive dig dilation \
    diligence diligent dill dilute dime diminish dimly dimmed dimmer dimness dimple diner dingbat dinghy \
    dinginess dingo dingy dining dinner diocese dioxide diploma dipped dipper dipping directed direction \
    directive directly directory direness dirtiness disabled disagree disallow disarm disarray disaster disband \
    disbelief disburse discard discern discharge disclose discolor discount discourse discover discuss disdain \
    disengage disfigure disgrace dish disinfect disjoin disk dislike disliking dislocate dislodge disloyal \
    dismantle dismay dismiss dismount disobey disorder disown disparate disparity dispatch dispense dispersal \
    dispersed disperser displace display displease disposal dispose disprove dispute disregard disrupt dissuade \
    distance distant distaste distill distinct distort distract distress district distrust ditch ditto ditzy \
    dividable divided dividend dividers dividing divinely diving divinity divisible divisibly division divisive \
    divorcee dizziness dizzy doable docile dock doctrine document dodge dodgy doily doing dole dollar dollhouse \
    dollop dolly dolphin domain domelike domestic dominion dominoes donated donation donator donor donut doodle \
    doorbell doorframe doorknob doorman doormat doornail doorpost doorstep doorstop doorway doozy dork \
    dormitory dorsal dosage dose dotted doubling douche dove down dowry doze drab dragging dragonfly dragonish \
    dragster drainable drainage drained drainer drainpipe dramatic dramatize drank drapery drastic draw dreaded \
    dreadful dreadlock dreamboat dreamily dreamland dreamless dreamlike dreamt dreamy drearily dreary drench \
    dress drew dribble dried drier drift driller drilling drinkable drinking dripping drippy drivable driven \
    driver driveway driving drizzle drizzly drone drool droop dropbox dropkick droplet dropout dropper drove \
    drown drowsily drudge drum dry dubbed dubiously duchess duckbill ducking duckling ducktail ducky duct dude \
    duffel dugout duh duke duller dullness duly dumping dumpling dumpster duo dupe duplex duplicate duplicity \
    durable durably duration duress during dusk dust dutiful duty duvet dwarf dweeb dwelled dweller dwelling \
    dwindle dwindling dynamic dynamite dynasty dyslexia dyslexic each eagle earache eardrum earflap earful \
    earlobe early earmark earmuff earphone earpiece earplugs earring earshot earthen earthlike earthling \
    earthly earthworm earthy earwig easeful easel easiest easily easiness easing eastbound eastcoast easter \
    eastward eatable eaten eatery eating eats ebay ebony ebook ecard eccentric echo eclair eclipse ecologist \
    ecology economic economist economy ecosphere ecosystem edge edginess edging edgy edition editor educated \
    education educator eel effective effects efficient effort eggbeater egging eggnog eggplant eggshell \
    egomaniac egotism egotistic either eject elaborate elastic elated elbow eldercare elderly eldest electable \
    election elective elephant elevate elevating elevation elevator eleven elf eligible eligibly eliminate \
    elite elitism elixir elk ellipse elliptic elm elongated elope eloquence eloquent elsewhere elude elusive \
    elves email embargo embark embassy embattled embellish ember embezzle emblaze emblem embody embolism emboss \
    embroider emcee emerald emergency emission emit emote emoticon emotion empathic empathy emperor emphases \
    emphasis emphasize emphatic empirical employed employee employer emporium empower emptier emptiness empty \
    emu enable enactment enamel enchanted enchilada encircle enclose enclosure encode encore encounter \
    encourage encroach encrust encrypt endanger endeared endearing ended ending endless endnote endocrine \
    endorphin endorse endowment endpoint endurable endurance enduring energetic energize energy enforced \
    enforcer engaged engaging engine engorge engraved engraver engraving engross engulf enhance enigmatic \
    enjoyable enjoyably enjoyer enjoying enjoyment enlarged enlarging enlighten enlisted enquirer enrage enrich \
    enroll enslave ensnare ensure entail entangled entering entertain enticing entire entitle entity entomb \
    entourage entrap entree entrench entrust entryway entwine enunciate envelope enviable enviably envious \
    envision envoy envy enzyme epic epidemic epidermal epidermis epidural epilepsy epileptic epilogue epiphany \
    episode equal equate equation equator equinox equipment equity equivocal eradicate erasable erased eraser \
    erasure ergonomic errand errant erratic error erupt escalate escalator escapable escapade escapist escargot \
    eskimo esophagus espionage espresso esquire essay essence essential establish estate esteemed estimate \
    estimator estranged estrogen etching eternal eternity ethanol ether ethically ethics euphemism evacuate \
    evacuee evade evaluate evaluator evaporate evasion evasive even everglade evergreen everybody everyday \
    everyone evict evidence evident evil evoke evolution evolve exact exalted example excavate excavator \
    exceeding exception excess exchange excitable exciting exclaim exclude excluding exclusion exclusive \
    excretion excretory excursion excusable excusably excuse exemplary exemplify exemption exerciser exert exes \
    exfoliate exhale exhaust exhume exile existing exit exodus exonerate exorcism exorcist expand expanse \
    expansion expansive expectant expedited expediter expel expend expenses expensive expert expire expiring \
    explain expletive explicit explode exploit explore exploring exponent exporter exposable expose exposure \
    express expulsion exquisite extended extending extent extenuate exterior external extinct extortion \
    extradite extras extrovert extrude extruding exuberant fable fabric fabulous facebook facecloth facedown \
    faceless facelift faceplate faceted facial facility facing facsimile faction factoid factor factsheet \
    factual faculty fade fading failing falcon fall false falsify fame familiar family famine famished fanatic \
    fancied fanciness fancy fanfare fang fanning fantasize fantastic fantasy fascism fastball faster fasting \
    fastness faucet favorable favorably favored favoring favorite fax feast federal fedora feeble feed feel \
    feisty feline feminine feminism feminist feminize femur fence fencing fender ferment fernlike ferocious \
    ferocity ferret ferris ferry fervor fester festival festive festivity fetal fetch fever fiber fiction \
    fiddle fiddling fidelity fidgeting fidgety fifteen fifth fiftieth fifty figment figure figurine filing \
    filled filler filling film filter filth filtrate finale finalist finalize finally finance financial finch \
    fineness finer finicky finished finisher finishing finite finless finlike fiscally fit five flaccid flagman \
    flagpole flagship flagstick flagstone flail flakily flaky flame flammable flanked flanking flannels flap \
    flaring flashback flashbulb flashcard flashily flashing flashy flask flatbed flatfoot flatly flatness \
    flatten flattered flatterer flattery flattop flatware flatworm flavored flavorful flavoring flaxseed fled \
    fleshed fleshy flick flier flight flinch fling flint flip flirt float flock flogging flop floral florist \
    floss flounder flyable flyaway flyer flying flyover flypaper foam foe fog foil folic folk follicle follow \
    fondling fondly fondness fondue font food fool footage football footbath footboard footer footgear foothill \
    foothold footing footless footman footnote footpad footpath footprint footrest footsie footsore footwear \
    footwork fossil foster founder founding fountain fox foyer fraction fracture fragile fragility fragment \
    fragrance fragrant frail frame framing frantic fraternal frayed fraying frays freckled freckles freebase \
    freebee freebie freedom freefall freehand freeing freeload freely freemason freeness freestyle freeware \
    freeway freewill freezable freezing freight french frenzied frenzy frequency frequent fresh fretful fretted \
    friction friday fridge fried friend frighten frightful frigidity frigidly frill fringe frisbee frisk \
    fritter frivolous frolic from front frostbite frosted frostily frosting frostlike frosty froth frown frozen \
    fructose frugality frugally fruit frustrate frying gab gaffe gag gainfully gaining gains gala gallantly \
    galleria gallery galley gallon gallows gallstone galore galvanize gambling game gaming gamma gander gangly \
    gangrene gangway gap garage garbage garden gargle garland garlic garment garnet garnish garter gas gatherer \
    gathering gating gauging gauntlet gauze gave gawk gazing gear gecko geek geiger gem gender generic generous \
    genetics genre gentile gentleman gently gents geography geologic geologist geology geometric geometry \
    geranium gerbil geriatric germicide germinate germless germproof gestate gestation gesture getaway getting \
    getup giant gibberish giblet giddily giddiness giddy gift gigabyte gigahertz gigantic giggle giggling \
    giggly gigolo gilled gills gimmick girdle giveaway given giver giving gizmo gizzard glacial glacier glade \
    gladiator gladly glamorous glamour glance glancing glandular glare glaring glass glaucoma glazing gleaming \
    gleeful glider gliding glimmer glimpse glisten glitch glitter glitzy gloater gloating gloomily gloomy \
    glorified glorifier glorify glorious glory gloss glove glowing glowworm glucose glue gluten glutinous \
    glutton gnarly gnat goal goatskin goes goggles going goldfish goldmine goldsmith golf goliath gonad gondola \
    gone gong good gooey goofball goofiness goofy google goon gopher gore gorged gorgeous gory gosling gossip \
    gothic gotten gout gown grab graceful graceless gracious gradation graded grader gradient grading gradually \
    graduate graffiti grafted grafting grain granddad grandkid grandly grandma grandpa grandson granite granny \
    granola grant granular grape graph grapple grappling grasp grass gratified gratify grating gratitude \
    gratuity gravel graveness graves graveyard gravitate gravity gravy gray grazing greasily greedily greedless \
    greedy green greeter greeting grew greyhound grid grief grievance grieving grievous grill grimace grimacing \
    grime griminess grimy grinch grinning grip gristle grit groggily groggy groin groom groove grooving groovy \
    grope ground grouped grout grove grower growing growl grub grudge grudging grueling gruffly grumble \
    grumbling grumbly grumpily grunge grunt guacamole guidable guidance guide guiding guileless guise gulf \
    gullible gully gulp gumball gumdrop gumminess gumming gummy gurgle gurgling guru gush gusto gusty gutless \
    guts gutter guy guzzler gyration habitable habitant habitat habitual hacked hacker hacking hacksaw had \
    haggler haiku half halogen halt halved halves hamburger hamlet hammock hamper hamster hamstring handbag \
    handball handbook handbrake handcart handclap handclasp handcraft handcuff handed handful handgrip handgun \
    handheld handiness handiwork handlebar handled handler handling handmade handoff handpick handprint \
    handrail handsaw handset handsfree handshake handstand handwash handwork handwoven handwrite handyman \
    hangnail hangout hangover hangup hankering hankie hanky haphazard happening happier happiest happily \
    happiness happy harbor hardcopy hardcore hardcover harddisk hardened hardener hardening hardhat hardhead \
    hardiness hardly hardness hardship hardware hardwired hardwood hardy harmful harmless harmonica harmonics \
    harmonize harmony harness harpist harsh harvest hash hassle haste hastily hastiness hasty hatbox hatchback \
    hatchery hatchet hatching hatchling hate hatless hatred haunt haven hazard hazelnut hazily haziness hazing \
    hazy headache headband headboard headcount headdress headed header headfirst headgear heading headlamp \
    headless headlock headphone headpiece headrest headroom headscarf headset headsman headstand headstone \
    headway headwear heap heat heave heavily heaviness heaving hedge hedging heftiness hefty helium helmet \
    helper helpful helping helpless helpline hemlock hemstitch hence henchman henna herald herbal herbicide \
    herbs heritage hermit heroics heroism herring herself hertz hesitancy hesitant hesitate hexagon hexagram \
    hubcap huddle huddling huff hug hula hulk hull human humble humbling humbly humid humiliate humility \
    humming hummus humongous humorist humorless humorous humpback humped humvee hunchback hundredth hunger \
    hungrily hungry hunk hunter hunting huntress huntsman hurdle hurled hurler hurling hurray hurricane hurried \
    hurry hurt husband hush husked huskiness hut hybrid hydrant hydrated hydration hydrogen hydroxide hyperlink \
    hypertext hyphen hypnoses hypnosis hypnotic hypnotism hypnotist hypnotize hypocrisy hypocrite ibuprofen ice \
    iciness icing icky icon icy idealism idealist idealize ideally idealness identical identify identity \
    ideology idiocy idiom idly igloo ignition ignore iguana illicitly illusion illusive image imaginary \
    imagines imaging imbecile imitate imitation immature immerse immersion imminent immobile immodest immorally \
    immortal immovable immovably immunity immunize impaired impale impart impatient impeach impeding impending \
    imperfect imperial impish implant implement implicate implicit implode implosion implosive imply impolite \
    important importer impose imposing impotence impotency impotent impound imprecise imprint imprison \
    impromptu improper improve improving improvise imprudent impulse impulsive impure impurity iodine iodize \
    ion ipad iphone ipod irate irk iron irregular irrigate irritable irritably irritant irritate islamic \
    islamist isolated isolating isolation isotope issue issuing italicize italics item itinerary itunes ivory \
    ivy jab jackal jacket jackknife jackpot jailbird jailbreak jailer jailhouse jalapeno jam janitor january \
    jargon jarring jasmine jaundice jaunt java jawed jawless jawline jaws jaybird jaywalker jazz jeep jeeringly \
    jellied jelly jersey jester jet jiffy jigsaw jimmy jingle jingling jinx jitters jittery job jockey \
    jockstrap jogger jogging john joining jokester jokingly jolliness jolly jolt jot jovial joyfully joylessly \
    joyous joyride joystick jubilance jubilant judge judgingly judicial judiciary judo juggle juggling jugular \
    juice juiciness juicy jujitsu jukebox july jumble jumbo jump junction juncture june junior juniper junkie \
    junkman junkyard jurist juror jury justice justifier justify justly justness juvenile kabob kangaroo \
    karaoke karate karma kebab keenly keenness keep keg kelp kennel kept kerchief kerosene kettle kick kiln \
    kilobyte kilogram kilometer kilowatt kilt kimono kindle kindling kindly kindness kindred kinetic kinfolk \
    king kinship kinsman kinswoman kissable kisser kissing kitchen kite kitten kitty kiwi kleenex knapsack knee \
    knelt knickers knoll koala kooky kosher krypton kudos kung labored laborer laboring laborious labrador \
    ladder ladies ladle ladybug ladylike lagged lagging lagoon lair lake lance landed landfall landfill landing \
    landlady landless landline landlord landmark landmass landmine landowner landscape landside landslide \
    language lankiness lanky lantern lapdog lapel lapped lapping laptop lard large lark lash lasso last latch \
    late lather latitude latrine latter latticed launch launder laundry laurel lavender lavish laxative lazily \
    laziness lazy lecturer left legacy legal legend legged leggings legible legibly legislate lego legroom \
    legume legwarmer legwork lemon lend length lens lent leotard lesser letdown lethargic lethargy letter \
    lettuce level leverage levers levitate levitator liability liable liberty librarian library licking \
    licorice lid life lifter lifting liftoff ligament likely likeness likewise liking lilac lilly lily limb \
    limeade limelight limes limit limping limpness line lingo linguini linguist lining linked linoleum linseed \
    lint lion lip liquefy liqueur liquid lisp list litigate litigator litmus litter little livable lived lively \
    liver livestock lividly living lizard lubricant lubricate lucid luckily luckiness luckless lucrative \
    ludicrous lugged lukewarm lullaby lumber luminance luminous lumpiness lumping lumpish lunacy lunar lunchbox \
    luncheon lunchroom lunchtime lung lurch lure luridness lurk lushly lushness luster lustfully lustily \
    lustiness lustrous lusty luxurious luxury lying lyrically lyricism lyricist lyrics macarena macaroni macaw \
    mace machine machinist magazine magenta maggot magical magician magma magnesium magnetic magnetism \
    magnetize magnifier magnify magnitude magnolia mahogany maimed majestic majesty majorette majority makeover \
    maker makeshift making malformed malt mama mammal mammary mammogram manager managing manatee mandarin \
    mandate mandatory mandolin manger mangle mango mangy manhandle manhole manhood manhunt manicotti manicure \
    manifesto manila mankind manlike manliness manly manmade manned mannish manor manpower mantis mantra manual \
    many map marathon marauding marbled marbles marbling march mardi margarine margarita margin marigold marina \
    marine marital maritime marlin marmalade maroon married marrow marry marshland marshy marsupial marvelous \
    marxism mascot masculine mashed mashing massager masses massive mastiff matador matchbook matchbox matcher \
    matching matchless material maternal maternity math mating matriarch matrimony matrix matron matted matter \
    maturely maturing maturity mauve maverick maximize maximum maybe mayday mayflower moaner moaning mobile \
    mobility mobilize mobster mocha mocker mockup modified modify modular modulator module moisten moistness \
    moisture molar molasses mold molecular molecule molehill mollusk mom monastery monday monetary monetize \
    moneybags moneyless moneywise mongoose mongrel monitor monkhood monogamy monogram monologue monopoly \
    monorail monotone monotype monoxide monsieur monsoon monstrous monthly monument moocher moodiness moody \
    mooing moonbeam mooned moonlight moonlike moonlit moonrise moonscape moonshine moonstone moonwalk mop \
    morale morality morally morbidity morbidly morphine morphing morse mortality mortally mortician mortified \
    mortify mortuary mosaic mossy most mothball mothproof motion motivate motivator motive motocross motor \
    motto mountable mountain mounted mounting mourner mournful mouse mousiness moustache mousy mouth movable \
    move movie moving mower mowing much muck mud mug mulberry mulch mule mulled mullets multiple multiply \
    multitask multitude mumble mumbling mumbo mummified mummify mummy mumps munchkin mundane municipal muppet \
    mural murkiness murky murmuring muscular museum mushily mushiness mushroom mushy music musket muskiness \
    musky mustang mustard muster mustiness musty mutable mutate mutation mute mutilated mutilator mutiny mutt \
    mutual muzzle myself myspace mystified mystify myth nacho nag nail name naming nanny nanometer nape napkin \
    napped napping nappy narrow nastily nastiness national native nativity natural nature naturist nautical \
    navigate navigator navy nearby nearest nearly nearness neatly neatness nebula nebulizer nectar negate \
    negation negative neglector negligee negligent negotiate nemeses nemesis neon nephew nerd nervous nervy \
    nest net neurology neuron neurosis neurotic neuter neutron never next nibble nickname nicotine niece nifty \
    nimble nimbly nineteen ninetieth ninja nintendo ninth nuclear nuclei nucleus nugget nullify number numbing \
    numbly numbness numeral numerate numerator numeric numerous nuptials nursery nursing nurture nutcase \
    nutlike nutmeg nutrient nutshell nuttiness nutty nuzzle nylon oaf oak oasis oat obedience obedient obituary \
    object obligate obliged oblivion oblivious oblong obnoxious oboe obscure obscurity observant observer \
    observing obsessed obsession obsessive obsolete obstacle obstinate obstruct obtain obtrusive obtuse obvious \
    occultist occupancy occupant occupier occupy ocean ocelot octagon octane october octopus ogle oil oink \
    ointment okay old olive olympics omega omen ominous omission omit omnivore onboard oncoming ongoing onion \
    online onlooker only onscreen onset onshore onslaught onstage onto onward onyx oops ooze oozy opacity opal \
    open operable operate operating operation operative operator opium opossum opponent oppose opposing \
    opposite oppressed oppressor opt opulently osmosis other otter ouch ought ounce outage outback outbid \
    outboard outbound outbreak outburst outcast outclass outcome outdated outdoors outer outfield outfit \
    outflank outgoing outgrow outhouse outing outlast outlet outline outlook outlying outmatch outmost \
    outnumber outplayed outpost outpour output outrage outrank outreach outright outscore outsell outshine \
    outshoot outsider outskirts outsmart outsource outspoken outtakes outthink outward outweigh outwit oval \
    ovary oven overact overall overarch overbid overbill overbite overblown overboard overbook overbuilt \
    overcast overcoat overcome overcook overcrowd overdraft overdrawn overdress overdrive overdue overeager \
    overeater overexert overfed overfeed overfill overflow overfull overgrown overhand overhang overhaul \
    overhead overhear overheat overhung overjoyed overkill overlabor overlaid overlap overlay overload overlook \
    overlord overlying overnight overpass overpay overplant overplay overpower overprice overrate overreach \
    overreact override overripe overrule overrun overshoot overshot oversight oversized oversleep oversold \
    overspend overstate overstay overstep overstock overstuff oversweet overtake overthrow overtime overtly \
    overtone overture overturn overuse overvalue overview overwrite owl oxford oxidant oxidation oxidize \
    oxidizing oxygen oxymoron oyster ozone paced pacemaker pacific pacifier pacifism pacifist pacify padded \
    padding paddle paddling padlock pagan pager paging pajamas palace palatable palm palpable palpitate paltry \
    pampered pamperer pampers pamphlet panama pancake pancreas panda pandemic pang panhandle panic panning \
    panorama panoramic panther pantomime pantry pants pantyhose paparazzi papaya paper paprika papyrus parabola \
    parachute parade paradox paragraph parakeet paralegal paralyses paralysis paralyze paramedic parameter \
    paramount parasail parasite parasitic parcel parched parchment pardon parish parka parking parkway parlor \
    parmesan parole parrot parsley parsnip partake parted parting partition partly partner partridge party \
    passable passably passage passcode passenger passerby passing passion passive passivism passover passport \
    password pasta pasted pastel pastime pastor pastrami pasture pasty patchwork patchy paternal paternity path \
    patience patient patio patriarch patriot patrol patronage patronize pauper pavement paver pavestone \
    pavilion paving pawing payable payback paycheck payday payee payer paying payment payphone payroll pebble \
    pebbly pecan pectin peculiar peddling pediatric pedicure pedigree pedometer pegboard pelican pellet pelt \
    pelvis penalize penalty pencil pendant pending penholder penknife pennant penniless penny penpal pension \
    pentagon pentagram pep perceive percent perch percolate perennial perfected perfectly perfume periscope \
    perish perjurer perjury perkiness perky perm peroxide perpetual perplexed persecute persevere persuaded \
    persuader pesky peso pessimism pessimist pester pesticide petal petite petition petri petroleum petted \
    petticoat pettiness petty petunia phantom phobia phoenix phonebook phoney phonics phoniness phony phosphate \
    photo phrase phrasing placard placate placidly plank planner plant plasma plaster plastic plated platform \
    plating platinum platonic platter platypus plausible plausibly playable playback player playful playgroup \
    playhouse playing playlist playmaker playmate playoff playpen playroom playset plaything playtime plaza \
    pleading pleat pledge plentiful plenty plethora plexiglas pliable plod plop plot plow ploy pluck plug \
    plunder plunging plural plus plutonium plywood poach pod poem poet pogo pointed pointer pointing pointless \
    pointy poise poison poker poking polar police policy polio polish politely polka polo polyester polygon \
    polygraph polymer poncho pond pony popcorn pope poplar popper poppy popsicle populace popular populate \
    porcupine pork porous porridge portable portal portfolio porthole portion portly portside poser posh posing \
    possible possibly possum postage postal postbox postcard posted poster posting postnasal posture postwar \
    pouch pounce pouncing pound pouring pout powdered powdering powdery power powwow pox praising prance \
    prancing pranker prankish prankster prayer praying preacher preaching preachy preamble precinct precise \
    precision precook precut predator predefine predict preface prefix preflight preformed pregame pregnancy \
    pregnant preheated prelaunch prelaw prelude premiere premises premium prenatal preoccupy preorder prepaid \
    prepay preplan preppy preschool prescribe preseason preset preshow president presoak press presume \
    presuming preteen pretended pretender pretense pretext pretty pretzel prevail prevalent prevent preview \
    previous prewar prewashed prideful pried primal primarily primary primate primer primp princess print prior \
    prism prison prissy pristine privacy private privatize prize proactive probable probably probation probe \
    probing probiotic problem procedure process proclaim procreate procurer prodigal prodigy produce product \
    profane profanity professed professor profile profound profusely progeny prognosis program progress \
    projector prologue prolonged promenade prominent promoter promotion prompter promptly prone prong pronounce \
    pronto proofing proofread proofs propeller properly property proponent proposal propose props prorate \
    protector protegee proton prototype protozoan protract protrude proud provable proved proven provided \
    provider providing province proving provoke provoking provolone prowess prowler prowling proximity proxy \
    prozac prude prudishly prune pruning pry psychic public publisher pucker pueblo pug pull pulmonary pulp \
    pulsate pulse pulverize puma pumice pummel punch punctual punctuate punctured pungent punisher punk pupil \
    puppet puppy purchase pureblood purebred purely pureness purgatory purge purging purifier purify purist \
    puritan purity purple purplish purposely purr purse pursuable pursuant pursuit purveyor pushcart pushchair \
    pusher pushiness pushing pushover pushpin pushup pushy putdown putt puzzle puzzling pyramid pyromania \
    python quack quadrant quail quaintly quake quaking qualified qualifier qualify quality qualm quantum \
    quarrel quarry quartered quarterly quarters quartet quench query quicken quickly quickness quicksand \
    quickstep quiet quill quilt quintet quintuple quirk quit quiver quizzical quotable quotation quote rabid \
    race racing racism rack racoon radar radial radiance radiantly radiated radiation radiator radio radish \
    raffle raft rage ragged raging ragweed raider railcar railing railroad railway raisin rake raking rally \
    ramble rambling ramp ramrod ranch rancidity random ranged ranger ranging ranked ranking ransack ranting \
    rants rare rarity rascal rash rasping ravage raven ravine raving ravioli ravishing reabsorb reach reacquire \
    reaction reactive reactor reaffirm ream reanalyze reappear reapply reappoint reapprove rearrange rearview \
    reason reassign reassure reattach reawake rebalance rebate rebel rebirth reboot reborn rebound rebuff \
    rebuild rebuilt reburial rebuttal recall recant recapture recast recede recent recess recharger recipient \
    recital recite reckless reclaim recliner reclining recluse reclusive recognize recoil recollect recolor \
    reconcile reconfirm reconvene recopy record recount recoup recovery recreate rectal rectangle rectified \
    rectify recycled recycler recycling reemerge reenact reenter reentry reexamine referable referee reference \
    refill refinance refined refinery refining refinish reflected reflector reflex reflux refocus refold \
    reforest reformat reformed reformer reformist refract refrain refreeze refresh refried refueling refund \
    refurbish refurnish refusal refuse refusing refutable refute regain regalia regally reggae regime region \
    register registrar registry regress regretful regroup regular regulate regulator rehab reheat rehire \
    rehydrate reimburse reissue reiterate rejoice rejoicing rejoin rekindle relapse relapsing relatable related \
    relation relative relax relay relearn release relenting reliable reliably reliance reliant relic relieve \
    relieving relight relish relive reload relocate relock reluctant rely remake remark remarry rematch \
    remedial remedy remember reminder remindful remission remix remnant remodeler remold remorse remote \
    removable removal removed remover removing rename renderer rendering rendition renegade renewable renewably \
    renewal renewed renounce renovate renovator rentable rental rented renter reoccupy reoccur reopen reorder \
    repackage repacking repaint repair repave repaying repayment repeal repeated repeater repent rephrase \
    replace replay replica reply reporter repose repossess repost repressed reprimand reprint reprise reproach \
    reprocess reproduce reprogram reps reptile reptilian repugnant repulsion repulsive repurpose reputable \
    reputably request require requisite reroute rerun resale resample rescuer reseal research reselect reseller \
    resemble resend resent reset reshape reshoot reshuffle residence residency resident residual residue \
    resigned resilient resistant resisting resize resolute resolved resonant resonate resort resource respect \
    resubmit result resume resupply resurface resurrect retail retainer retaining retake retaliate retention \
    rethink retinal retired retiree retiring retold retool retorted retouch retrace retract retrain retread \
    retreat retrial retrieval retriever retry return retying retype reunion reunite reusable reuse reveal \
    reveler revenge revenue reverb revered reverence reverend reversal reverse reversing reversion revert \
    revisable revise revision revisit revivable revival reviver reviving revocable revoke revolt revolver \
    revolving reward rewash rewind rewire reword rework rewrap rewrite rhyme ribbon ribcage rice riches richly \
    richness rickety ricotta riddance ridden ride riding rifling rift rigging rigid rigor rimless rimmed rind \
    rink rinse rinsing riot ripcord ripeness ripening ripping ripple rippling riptide rise rising risk risotto \
    ritalin ritzy rival riverbank riverbed riverboat riverside riveter riveting roamer roaming roast robbing \
    robe robin robotics robust rockband rocker rocket rockfish rockiness rocking rocklike rockslide rockstar \
    rocky rogue roman romp rope roping roster rosy rotten rotting rotunda roulette rounding roundish roundness \
    roundup roundworm routine routing rover roving royal rubbed rubber rubbing rubble rubdown ruby ruckus \
    rudder rug ruined rule rumble rumbling rummage rumor runaround rundown runner running runny runt runway \
    rupture rural ruse rush rust rut sabbath sabotage sacrament sacred sacrifice sadden saddlebag saddled \
    saddling sadly sadness safari safeguard safehouse safely safeness saffron saga sage sagging saggy said \
    saint sake salad salami salaried salary saline salon saloon salsa salt salutary salute salvage salvaging \
    salvation same sample sampling sanction sanctity sanctuary sandal sandbag sandbank sandbar sandblast \
    sandbox sanded sandfish sanding sandlot sandpaper sandpit sandstone sandstorm sandworm sandy sanitary \
    sanitizer sank santa sapling sappiness sappy sarcasm sarcastic sardine sash sasquatch sassy satchel \
    satiable satin satirical satisfied satisfy saturate saturday sauciness saucy sauna savage savanna saved \
    savings savior savor saxophone say scabbed scabby scalded scalding scale scaling scallion scallop scalping \
    scam scandal scanner scanning scant scapegoat scarce scarcity scarecrow scared scarf scarily scariness \
    scarring scary scavenger scenic schedule schematic scheme scheming schilling schnapps scholar science \
    scientist scion scoff scolding scone scoop scooter scope scorch scorebook scorecard scored scoreless scorer \
    scoring scorn scorpion scotch scoundrel scoured scouring scouting scouts scowling scrabble scraggly \
    scrambled scrambler scrap scratch scrawny screen scribble scribe scribing scrimmage script scroll scrooge \
    scrounger scrubbed scrubber scruffy scrunch scrutiny scuba scuff sculptor sculpture scurvy scuttle secluded \
    secluding seclusion second secrecy secret sectional sector secular securely security sedan sedate sedation \
    sedative sediment seduce seducing segment seismic seizing seldom selected selection selective selector self \
    seltzer semantic semester semicolon semifinal seminar semisoft semisweet senate senator send senior \
    senorita sensation sensitive sensitize sensually sensuous sepia september septic septum sequel sequence \
    sequester series sermon serotonin serpent serrated serve service serving sesame sessions setback setting \
    settle settling setup sevenfold seventeen seventh seventy severity shabby shack shaded shadily shadiness \
    shading shadow shady shaft shakable shakily shakiness shaking shaky shale shallot shallow shame shampoo \
    shamrock shank shanty shape shaping share sharpener sharper sharpie sharply sharpness shawl sheath shed \
    sheep sheet shelf shell shelter shelve shelving sherry shield shifter shifting shiftless shifty shimmer \
    shimmy shindig shine shingle shininess shining shiny ship shirt shivering shock shone shoplift shopper \
    shopping shoptalk shore shortage shortcake shortcut shorten shorter shorthand shortlist shortly shortness \
    shorts shortwave shorty shout shove showbiz showcase showdown shower showgirl showing showman shown showoff \
    showpiece showplace showroom showy shrank shrapnel shredder shredding shrewdly shriek shrill shrimp shrine \
    shrink shrivel shrouded shrubbery shrubs shrug shrunk shucking shudder shuffle shuffling shun shush shut \
    shy siamese siberian sibling siding sierra siesta sift sighing silenced silencer silent silica silicon silk \
    silliness silly silo silt silver similarly simile simmering simple simplify simply sincere sincerity singer \
    singing single singular sinister sinless sinner sinuous sip siren sister sitcom sitter sitting situated \
    situation sixfold sixteen sixth sixties sixtieth sixtyfold sizable sizably size sizing sizzle sizzling \
    skater skating skedaddle skeletal skeleton skeptic sketch skewed skewer skid skied skier skies skiing \
    skilled skillet skillful skimmed skimmer skimming skimpily skincare skinhead skinless skinning skinny \
    skintight skipper skipping skirmish skirt skittle skydiver skylight skyline skype skyrocket skyward slab \
    slacked slacker slacking slackness slacks slain slam slander slang slapping slapstick slashed slashing \
    slate slather slaw sled sleek sleep sleet sleeve slept sliceable sliced slicer slicing slick slider \
    slideshow sliding slighted slighting slightly slimness slimy slinging slingshot slinky slip slit sliver \
    slobbery slogan sloped sloping sloppily sloppy slot slouching slouchy sludge slug slum slurp slush sly \
    small smartly smartness smasher smashing smashup smell smelting smile smilingly smirk smite smith smitten \
    smock smog smoked smokeless smokiness smoking smoky smolder smooth smother smudge smudgy smuggler smuggling \
    smugly smugness snack snagged snaking snap snare snarl snazzy sneak sneer sneeze sneezing snide sniff \
    snippet snipping snitch snooper snooze snore snoring snorkel snort snout snowbird snowboard snowbound \
    snowcap snowdrift snowdrop snowfall snowfield snowflake snowiness snowless snowman snowplow snowshoe \
    snowstorm snowsuit snowy snub snuff snuggle snugly snugness speak spearfish spearhead spearman spearmint \
    species specimen specked speckled specks spectacle spectator spectrum speculate speech speed spellbind \
    speller spelling spendable spender spending spent spew sphere spherical sphinx spider spied spiffy spill \
    spilt spinach spinal spindle spinner spinning spinout spinster spiny spiral spirited spiritism spirits \
    spiritual splashed splashing splashy splatter spleen splendid splendor splice splicing splinter splotchy \
    splurge spoilage spoiled spoiler spoiling spoils spoken spokesman sponge spongy sponsor spoof spookily \
    spooky spool spoon spore sporting sports sporty spotless spotlight spotted spotter spotting spotty spousal \
    spouse spout sprain sprang sprawl spray spree sprig spring sprinkled sprinkler sprint sprite sprout spruce \
    sprung spry spud spur sputter spyglass squabble squad squall squander squash squatted squatter squatting \
    squeak squealer squealing squeamish squeegee squeeze squeezing squid squiggle squiggly squint squire squirt \
    squishier squishy stability stabilize stable stack stadium staff stage staging stagnant stagnate stainable \
    stained staining stainless stalemate staleness stalling stallion stamina stammer stamp stand stank staple \
    stapling starboard starch stardom stardust starfish stargazer staring stark starless starlet starlight \
    starlit starring starry starship starter starting startle startling startup starved starving stash state \
    static statistic statue stature status statute statutory staunch stays steadfast steadier steadily \
    steadying steam steed steep steerable steering steersman stegosaur stellar stem stench stencil step stereo \
    sterile sterility sterilize sterling sternness sternum stew stick stiffen stiffly stiffness stifle stifling \
    stillness stilt stimulant stimulate stimuli stimulus stinger stingily stinging stingray stingy stinking \
    stinky stipend stipulate stir stitch stock stoic stoke stole stomp stonewall stoneware stonework stoning \
    stony stood stooge stool stoop stoplight stoppable stoppage stopped stopper stopping stopwatch storable \
    storage storeroom storewide storm stout stove stowaway stowing straddle straggler strained strainer \
    straining strangely stranger strangle strategic strategy stratus straw stray streak stream street strength \
    strenuous strep stress stretch strewn stricken strict stride strife strike striking strive striving strobe \
    strode stroller strongbox strongly strongman struck structure strudel struggle strum strung strut stubbed \
    stubble stubbly stubborn stucco stuck student studied studio study stuffed stuffing stuffy stumble \
    stumbling stump stung stunned stunner stunning stunt stupor sturdily sturdy styling stylishly stylist \
    stylized stylus suave subarctic subatomic subdivide subdued subduing subfloor subgroup subheader subject \
    sublease sublet sublevel sublime submarine submerge submersed submitter subpanel subpar subplot subprime \
    subscribe subscript subsector subside subsiding subsidize subsidy subsoil subsonic substance subsystem \
    subtext subtitle subtly subtotal subtract subtype suburb subway subwoofer subzero succulent such suction \
    sudden sudoku suds sufferer suffering suffice suffix suffocate suffrage sugar suggest suing suitable \
    suitably suitcase suitor sulfate sulfide sulfite sulfur sulk sullen sulphate sulphuric sultry superbowl \
    superglue superhero superior superjet superman supermom supernova supervise supper supplier supply support \
    supremacy supreme surcharge surely sureness surface surfacing surfboard surfer surgery surgical surging \
    surname surpass surplus surprise surreal surrender surrogate surround survey survival survive surviving \
    survivor sushi suspect suspend suspense sustained sustainer swab swaddling swagger swampland swan swapping \
    swarm sway swear sweat sweep swell swept swerve swifter swiftly swiftness swimmable swimmer swimming \
    swimsuit swimwear swinger swinging swipe swirl switch swivel swizzle swooned swoop swoosh swore sworn swung \
    sycamore sympathy symphonic symphony symptom synapse syndrome synergy synopses synopsis synthesis synthetic \
    syrup system tabasco tabby tableful tables tablet tableware tabloid tackiness tacking tackle tackling tacky \
    taco tactful tactical tactics tactile tactless tadpole taekwondo tag tainted take taking talcum talisman \
    tall talon tamale tameness tamer tamper tank tanned tannery tanning tantrum tapeless tapered tapering \
    tapestry tapioca tapping taps tarantula target tarmac tarnish tarot tartar tartly tartness task tassel \
    taste tastiness tasting tasty tattered tattle tattling tattoo taunt tavern thank that thaw theater \
    theatrics thee theft theme theology theorize thermal thermos thesaurus these thesis thespian thicken \
    thicket thickness thieving thievish thigh thimble thing think thinly thinner thinness thinning thirstily \
    thirsting thirsty thirteen thirty thong thorn those thousand thrash thread threaten threefold thrift thrill \
    thrive thriving throat throbbing throng throttle throwaway throwback thrower throwing thud thumb thumping \
    thursday thus thwarting thyself tiara tibia tidal tidbit tidiness tidings tidy tiger tighten tightly \
    tightness tightrope tightwad tigress tile tiling till tilt timid timing timothy tinderbox tinfoil tingle \
    tingling tingly tinker tinkling tinsel tinsmith tint tinwork tiny tipoff tipped tipper tipping tiptoeing \
    tiptop tiring tissue trace tracing track traction tractor trade trading tradition traffic tragedy trailing \
    trailside train traitor trance tranquil transfer transform translate transpire transport transpose trapdoor \
    trapeze trapezoid trapped trapper trapping traps trash travel traverse travesty tray treachery treading \
    treadmill treason treat treble tree trekker tremble trembling tremor trench trend trespass triage trial \
    triangle tribesman tribunal tribune tributary tribute triceps trickery trickily tricking trickle trickster \
    tricky tricolor tricycle trident tried trifle trifocals trillion trilogy trimester trimmer trimming \
    trimness trinity trio tripod tripping triumph trivial trodden trolling trombone trophy tropical tropics \
    trouble troubling trough trousers trout trowel truce truck truffle trump trunks trustable trustee trustful \
    trusting trustless truth try tubby tubeless tubular tucking tuesday tug tuition tulip tumble tumbling tummy \
    turban turbine turbofan turbojet turbulent turf turkey turmoil turret turtle tusk tutor tutu tux tweak \
    tweed tweet tweezers twelve twentieth twenty twerp twice twiddle twiddling twig twilight twine twins twirl \
    twistable twisted twister twisting twisty twitch twitter tycoon tying tyke udder ultimate ultimatum ultra \
    umbilical umbrella umpire unabashed unable unadorned unadvised unafraid unaired unaligned unaltered \
    unarmored unashamed unaudited unawake unaware unbaked unbalance unbeaten unbend unbent unbiased unbitten \
    unblended unblessed unblock unbolted unbounded unboxed unbraided unbridle unbroken unbuckled unbundle \
    unburned unbutton uncanny uncapped uncaring uncertain unchain unchanged uncharted uncheck uncivil unclad \
    unclaimed unclamped unclasp uncle unclip uncloak unclog unclothed uncoated uncoiled uncolored uncombed \
    uncommon uncooked uncork uncorrupt uncounted uncouple uncouth uncover uncross uncrown uncrushed uncured \
    uncurious uncurled uncut undamaged undated undaunted undead undecided undefined underage underarm undercoat \
    undercook undercut underdog underdone underfed underfeed underfoot undergo undergrad underhand underline \
    underling undermine undermost underpaid underpass underpay underrate undertake undertone undertook undertow \
    underuse underwear underwent underwire undesired undiluted undivided undocked undoing undone undrafted \
    undress undrilled undusted undying unearned unearth unease uneasily uneasy uneatable uneaten unedited \
    unelected unending unengaged unenvied unequal unethical uneven unexpired unexposed unfailing unfair \
    unfasten unfazed unfeeling unfiled unfilled unfitted unfitting unfixable unfixed unflawed unfocused unfold \
    unfounded unframed unfreeze unfrosted unfrozen unfunded unglazed ungloved unglue ungodly ungraded ungreased \
    unguarded unguided unhappily unhappy unharmed unhealthy unheard unhearing unheated unhelpful unhidden \
    unhinge unhitched unholy unhook unicorn unicycle unified unifier uniformed uniformly unify unimpeded \
    uninjured uninstall uninsured uninvited union uniquely unisexual unison unissued unit universal universe \
    unjustly unkempt unkind unknotted unknowing unknown unlaced unlatch unlawful unleaded unlearned unleash \
    unless unleveled unlighted unlikable unlimited unlined unlinked unlisted unlit unlivable unloaded unloader \
    unlocked unlocking unlovable unloved unlovely unloving unluckily unlucky unmade unmanaged unmanned unmapped \
    unmarked unmasked unmasking unmatched unmindful unmixable unmixed unmolded unmoral unmovable unmoved \
    unmoving unnamable unnamed unnatural unneeded unnerve unnerving unnoticed unopened unopposed unpack \
    unpadded unpaid unpainted unpaired unpaved unpeeled unpicked unpiloted unpinned unplanned unplanted \
    unpleased unpledged unplowed unplug unpopular unproven unquote unranked unrated unraveled unreached unread \
    unreal unreeling unrefined unrelated unrented unrest unretired unrevised unrigged unripe unrivaled \
    unroasted unrobed unroll unruffled unruly unrushed unsaddle unsafe unsaid unsalted unsaved unsavory \
    unscathed unscented unscrew unsealed unseated unsecured unseeing unseemly unseen unselect unselfish unsent \
    unsettled unshackle unshaken unshaved unshaven unsheathe unshipped unsightly unsigned unskilled unsliced \
    unsmooth unsnap unsocial unsoiled unsold unsolved unsorted unspoiled unspoken unstable unstaffed unstamped \
    unsteady unsterile unstirred unstitch unstopped unstuck unstuffed unstylish unsubtle unsubtly unsuited \
    unsure unsworn untagged untainted untaken untamed untangled untapped untaxed unthawed unthread untidy untie \
    until untimed untimely untitled untoasted untold untouched untracked untrained untreated untried untrimmed \
    untrue untruth unturned untwist untying unusable unused unusual unvalued unvaried unvarying unveiled \
    unveiling unvented unviable unvisited unvocal unwanted unwarlike unwary unwashed unwatched unweave unwed \
    unwelcome unwell unwieldy unwilling unwind unwired unwitting unwomanly unworldly unworn unworried unworthy \
    unwound unwoven unwrapped unwritten unzip upbeat upchuck upcoming upcountry update upfront upgrade upheaval \
    upheld uphill uphold uplifted uplifting upload upon upper upright uprising upriver uproar uproot upscale \
    upside upstage upstairs upstart upstate upstream upstroke upswing uptake uptight uptown upturned upward \
    upwind uranium urban urchin urethane urgency urgent urging urologist urology usable usage useable used \
    uselessly user usher usual utensil utility utilize utmost utopia utter vacancy vacant vacate vacation \
    vagabond vagrancy vagrantly vaguely vagueness valiant valid valium valley valuables value vanilla vanish \
    vanity vanquish vantage vaporizer variable variably varied variety various varmint varnish varsity varying \
    vascular vaseline vastly vastness veal vegan veggie vehicular velcro velocity velvet vendetta vending \
    vendor veneering vengeful venomous ventricle venture venue venus verbalize verbally verbose verdict verify \
    verse version versus vertebrae vertical vertigo very vessel vest veteran veto vexingly viability viable \
    vibes vice vicinity victory video viewable viewer viewing viewless viewpoint vigorous village villain \
    vindicate vineyard vintage violate violation violator violet violin viper viral virtual virtuous virus visa \
    viscosity viscous viselike visible visibly vision visiting visitor visor vista vitality vitalize vitally \
    vitamins vivacious vividly vividness vixen vocalist vocalize vocally vocation voice voicing void volatile \
    volley voltage volumes voter voting voucher vowed vowel voyage wackiness wad wafer waffle waged wager wages \
    waggle wagon wake waking walk walmart walnut walrus waltz wand wannabe wanted wanting wasabi washable \
    washbasin washboard washbowl washcloth washday washed washer washhouse washing washout washroom washstand \
    washtub wasp wasting watch water waviness waving wavy whacking whacky wham wharf wheat whenever whiff \
    whimsical whinny whiny whisking whoever whole whomever whoopee whooping whoops why wick widely widen widget \
    widow width wieldable wielder wife wifi wikipedia wildcard wildcat wilder wildfire wildfowl wildland \
    wildlife wildly wildness willed willfully willing willow willpower wilt wimp wince wincing wind wing \
    winking winner winnings winter wipe wired wireless wiring wiry wisdom wise wish wisplike wispy wistful \
    wizard wobble wobbling wobbly wok wolf wolverine womanhood womankind womanless womanlike womanly womb woof \
    wooing wool woozy word work worried worrier worrisome worry worsening worshiper worst wound woven wow \
    wrangle wrath wreath wreckage wrecker wrecking wrench wriggle wriggly wrinkle wrinkly wrist writing written \
    wrongdoer wronged wrongful wrongly wrongness wrought xbox xerox yahoo yam yanking yapping yard yarn yeah \
    yearbook yearling yearly yearning yeast yelling yelp yen yesterday yiddish yield yin yippee yodel yoga \
    yogurt yonder yoyo yummy zap zealous zebra zen zeppelin zero zestfully zesty zigzagged zipfile zipping \
    zippy zips zit zodiac zombie zone zoning zookeeper zoologist zoology zoom";

fn word_list() -> &'static [&'static str] {
    static WORDS: OnceLock<Vec<&'static str>> = OnceLock::new();
    WORDS.get_or_init(|| WORD_LIST.split(' ').collect())
}

/// Fresh words for an Emergency Kit: twelve of the list, each chosen uniformly, lowercase with one space
/// between. They are shown to the person once.
pub fn generate_kit_words(entropy: &mut dyn Entropy) -> Result<SecretBytes, Error> {
    let list = word_list();
    let count = u16::try_from(list.len()).map_err(|_| Error::Internal("word list"))?;
    // Sixteen random bits are taken as they are only below the largest multiple of the list's length: every word
    // is then as likely as every other.
    let limit = (u16::MAX / count).saturating_mul(count);
    let mut text = Zeroizing::new(String::with_capacity(KIT_TEXT_CAPACITY));
    let mut chosen = 0;
    while chosen < KIT_WORDS {
        let draw = Zeroizing::new(crypto::random::<2>(entropy)?);
        let value = u16::from_be_bytes(*draw);
        if value >= limit {
            continue;
        }
        let word = list
            .get(usize::from(value % count))
            .ok_or(Error::Internal("word list"))?;
        if chosen > 0 {
            text.push(' ');
        }
        text.push_str(word);
        chosen += 1;
    }
    Ok(SecretBytes::new(text.as_bytes().to_vec()))
}

/// The Emergency Kit's words as everything is derived from them: the text is lowercased and split at anything
/// but `a` to `z`, and must then be twelve words of the list, which are joined by one space. Anything else is
/// `bad-recovery-words`.
pub fn parse_kit_words(text: &str) -> Result<SecretBytes, AccountError> {
    if text.len() > MAX_KIT_TEXT_LEN {
        return Err(AccountError::BadRecoveryWords);
    }
    let lowercase = Zeroizing::new(text.to_lowercase());
    let list = word_list();
    let mut normalised = Zeroizing::new(String::with_capacity(KIT_TEXT_CAPACITY));
    let mut count = 0usize;
    for word in lowercase
        .split(|c: char| !c.is_ascii_lowercase())
        .filter(|word| !word.is_empty())
    {
        if count == KIT_WORDS || list.binary_search(&word).is_err() {
            return Err(AccountError::BadRecoveryWords);
        }
        if count > 0 {
            normalised.push(' ');
        }
        normalised.push_str(word);
        count = count.saturating_add(1);
    }
    if count != KIT_WORDS {
        return Err(AccountError::BadRecoveryWords);
    }
    Ok(SecretBytes::new(normalised.as_bytes().to_vec()))
}

/// The recovery code as it is shown: 52 characters of `0123456789ABCDEFGHJKMNPQRSTVWXYZ` in thirteen groups of
/// four joined by `-`; bits most significant first, the last character holding one bit of the code and four
/// zero bits.
pub fn format_recovery_code(code: &Secret<32>) -> SecretBytes {
    let mut text = Zeroizing::new(Vec::with_capacity(CODE_CHARS + CODE_CHARS / 4));
    let mut acc = 0u32;
    let mut bits = 0u32;
    fn push(text: &mut Vec<u8>, value: u32) {
        if text.len() % 5 == 4 {
            text.push(b'-');
        }
        let symbol = usize::try_from(value & 31)
            .ok()
            .and_then(|index| CROCKFORD.get(index));
        text.extend(symbol);
    }
    for byte in code.expose() {
        acc = (acc << 8 | u32::from(*byte)) & 0x1fff;
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            push(&mut text, acc >> bits);
        }
    }
    // 256 = 51 × 5 + 1: one bit is left, written with four zero bits behind it.
    push(&mut text, acc << (5 - bits));
    SecretBytes::new(text.to_vec())
}

/// White space as the reference client's reading of a recovery code drops it.
fn is_dropped_space(c: char) -> bool {
    matches!(
        c,
        '\t'..='\r'
            | ' '
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

/// Reads a recovery code as a person types it: in any case, with spaces or hyphens anywhere, `O` read as `0`,
/// `I` and `L` as `1`. Anything else, another length, or a last character with one of its four padding bits set
/// is `bad-recovery-code`. There is no checksum: a mistyped code is the code of no room.
pub fn parse_recovery_code(text: &str) -> Result<Secret<32>, AccountError> {
    if text.len() > MAX_CODE_TEXT_LEN {
        return Err(AccountError::BadRecoveryCode);
    }
    let upper = Zeroizing::new(text.to_uppercase());
    let mut code = Zeroizing::new([0u8; 32]);
    let mut out = code.iter_mut();
    let mut acc = 0u32;
    let mut bits = 0u32;
    let mut count = 0usize;
    for c in upper.chars().filter(|c| !is_dropped_space(*c) && *c != '-') {
        let symbol = match c {
            'O' => b'0',
            'I' | 'L' => b'1',
            other => u8::try_from(other).map_err(|_| AccountError::BadRecoveryCode)?,
        };
        let value = CROCKFORD
            .iter()
            .position(|known| *known == symbol)
            .and_then(|value| u32::try_from(value).ok())
            .ok_or(AccountError::BadRecoveryCode)?;
        count = count.saturating_add(1);
        if count > CODE_CHARS {
            return Err(AccountError::BadRecoveryCode);
        }
        acc = acc << 5 | value;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            if let Some(byte) = out.next() {
                *byte = (acc >> bits & 0xff) as u8;
            }
            acc &= (1 << bits) - 1;
        }
    }
    if count != CODE_CHARS || acc != 0 {
        return Err(AccountError::BadRecoveryCode);
    }
    Ok(Secret::new(*code))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::SystemEntropy;
    use crate::ids::{base64url_decode, base64url_encode};
    use serde_json::Value;

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
    fn vectors_labels() {
        let v = vectors();
        for (name, label) in [
            ("salt", LABEL_SALT),
            ("auth", LABEL_AUTH),
            ("wrapKey", LABEL_WRAP_KEY),
            ("recoveryAuth", LABEL_KIT_AUTH),
            ("recoveryWrapKey", LABEL_KIT_WRAP_KEY),
            ("wrapAad", LABEL_WRAP_AAD),
            ("passkeyWrapKey", LABEL_PASSKEY_WRAP_KEY),
        ] {
            assert_eq!(text(&v, &["labels", name]), label);
        }
        // Every label of the file is one of these seven.
        let known = v["labels"].as_object().expect("labels").len();
        assert_eq!(known, 7 + 1, "the rule and seven labels");
        assert_eq!(
            text(&v, &["passkey", "prfInput"]).as_bytes(),
            PASSKEY_PRF_INPUT
        );
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
        assert_eq!(nfc(password).as_bytes(), hex(text(p, &["passwordNfcUtf8"])));
        assert_eq!(
            account_salt(text(p, &["normalisedEmail"]))
                .expect("hashes")
                .as_slice(),
            hex(text(p, &["salt"]))
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
        assert_eq!(
            sealing_aad(&room, Way::Password).expect("aad"),
            hex(text(p, &["aad"]))
        );
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
        assert_eq!(
            sealing_aad(&room, Way::Kit).expect("aad"),
            hex(text(r, &["aad"]))
        );
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
        let wrap_key = passkey_wrap_key(&hex(text(p, &["prfOutput"])), &room, &credential_id)
            .expect("derives");
        assert_eq!(wrap_key.expose().as_slice(), hex(text(p, &["wrapKey"])));
        assert_eq!(
            sealing_aad(&room, way).expect("aad"),
            hex(text(p, &["aad"]))
        );
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
        let sealed =
            seal_code(&key, &room, Way::Password, &code, &mut SystemEntropy).expect("seals");
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
    fn the_word_list_is_the_web_apps() {
        let source = include_str!("../../app/web/core/wordlist.ts");
        let listed = source
            .split('`')
            .nth(1)
            .expect("the list between its backticks");
        assert_eq!(WORD_LIST, listed);
        let list = word_list();
        assert_eq!(list.len(), 7772);
        assert!(list.windows(2).all(|pair| pair[0] < pair[1]), "sorted");
        assert!(list
            .iter()
            .all(|word| !word.is_empty() && word.bytes().all(|b| b.is_ascii_lowercase())));
        assert_eq!(list.iter().map(|word| word.len()).max(), Some(9));
    }

    #[test]
    fn kit_words_are_read_as_typed() {
        let words =
            "acorn velvet tidy hamper oxford banjo cradle dolphin eagle fabric gallery harbor";
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
            .iter()
            .find(|word| word.starts_with('k'))
            .expect("a word with k");
        let kelvin = words.replace("banjo", &with_k.replacen('k', "\u{212a}", 1));
        assert_eq!(read(&kelvin), Ok(words.replace("banjo", with_k)));
        assert_eq!(
            read(&"acorn ".repeat(400)),
            Err(AccountError::BadRecoveryWords)
        );
        assert_eq!(
            parse_recovery_code(&"0".repeat(MAX_CODE_TEXT_LEN + 1)),
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
}
