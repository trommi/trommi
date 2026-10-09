//! The primitives of the one suite, `MLS_128_DHKEMX25519_CHACHA20POLY1305_SHA256_Ed25519`, and the labelled
//! functions of RFC 9420 on top of them. Trommi's own constructs call these, and these call the OpenMLS provider
//! (`openmls_rust_crypto`), so that a Trommi hash, signature or sealed key is computed by the very code that
//! computes MLS's.
//!
//! | Here | RFC 9420 | Provider |
//! | --- | --- | --- |
//! | [`sha256`], [`ref_hash`] | 5.2 `RefHash` | `hash` |
//! | [`expand_with_label`] | 8 `ExpandWithLabel` | `hkdf_expand` |
//! | [`sign_with_label`], [`verify_with_label`] | 5.1.2 | `sign`, `verify_signature` (Ed25519, strict) |
//! | [`encrypt_with_label`], [`decrypt_with_label`] | 5.1.3 | see below; `hpke_open` |
//! | [`derive_hpke_keypair`] | RFC 9180 7.1.3 | `derive_hpke_keypair` |
//! | [`aead_seal`], [`aead_open`] | the suite's AEAD | `aead_encrypt`, `aead_decrypt` |
//! | [`hmac_sha256`], [`hmac_verify`] | | `hmac` |
//!
//! `MLS-Exporter` is not here: OpenMLS computes it from a group.
//!
//! # Randomness
//!
//! Every random byte of Trommi's own code comes from an [`Entropy`] the caller passes: [`SystemEntropy`] in a
//! shipped build, the seeded source of the cargo feature `vectors` in the generator of the specification's vectors.
//! Two places in the libraries below draw from the system on their own, and neither can be given a source:
//!
//! - `RustCrypto::default()`, the only constructor of the provider, seeds a generator of its own from the system
//!   and panics when the system gives nothing. [`rust_crypto`] therefore asks the system first and returns
//!   `Error::Entropy` instead of constructing; it keeps one provider for the process. That generator serves only
//!   the provider's `signature_key_gen` and its `OpenMlsRand`, which this crate does not use.
//! - `hpke-rs` seeds a generator from the system whenever an HPKE configuration is built, which the provider does
//!   in every `hpke_seal`, `hpke_open` and `derive_hpke_keypair`, and it panics when that fails. Nothing is drawn
//!   from it except by `hpke_seal`. The check in [`rust_crypto`] comes first; a source that answered once and
//!   fails later still ends in that panic.
//!
//! `OpenMlsCrypto::hpke_seal` takes its ephemeral key from that hidden generator. A shipped build seals through it
//! and through nothing else: [`hpke_seal`] first asks its [`Entropy`] for 32 bytes, so that a failing source is an
//! error and not a panic, and then calls the provider. The provider's output cannot be reproduced, which the
//! generator of the vectors needs. Only under the cargo feature `vectors` (and in this module's tests) a second
//! path is compiled, [`hpke_seal_with`]: RFC 9180's `Encap` for DHKEM(X25519, HKDF-SHA256) written out with the
//! randomness given (`DeriveKeyPair` and HKDF by the provider, X25519 by the provider's own HPKE back end), then
//! `hpke-rs`'s key schedule and sealing. The tests hold it against RFC 9180's vector A.2.1 and open its output
//! with the provider's `hpke_open`. With that feature [`hpke_seal`] takes this path. It is never part of a
//! shipped build.
//!
//! # Lengths
//!
//! The provider's AEAD panics on a nonce that is not 12 bytes and its X25519 refuses keys that are not 32: the
//! functions here take arrays, or check the length first.

use crate::codec::{Decode, Encode, Reader, Writer};
use crate::error::Error;
use crate::ids::Hash32;
use openmls_rust_crypto::RustCrypto;
use openmls_traits::crypto::OpenMlsCrypto;
use openmls_traits::types::{Ciphersuite, CryptoError, HpkeCiphertext as ProviderCiphertext};
use std::fmt;
use std::sync::OnceLock;
use subtle::ConstantTimeEq;
use zeroize::Zeroize;

/// The suite of every group and of every construct here. Nothing is negotiated.
pub(crate) const CIPHERSUITE: Ciphersuite =
    Ciphersuite::MLS_128_DHKEMX25519_CHACHA20POLY1305_SHA256_Ed25519;

/// What RFC 9420's labelled functions put before a label.
const LABEL_PREFIX: &str = "MLS 1.0 ";
/// The length of an AEAD nonce.
pub const NONCE_LEN: usize = 12;
/// How much longer an AEAD ciphertext is than its plaintext.
pub const TAG_LEN: usize = 16;

fn provider_fault(_: CryptoError) -> Error {
    Error::Internal("crypto provider")
}

/// The OpenMLS crypto provider of this process, built on first use; `Error::Entropy` while the system gives no
/// randomness (the module documentation says why this is checked here).
pub(crate) fn rust_crypto() -> Result<&'static RustCrypto, Error> {
    static PROVIDER: OnceLock<RustCrypto> = OnceLock::new();
    if let Some(provider) = PROVIDER.get() {
        return Ok(provider);
    }
    SystemEntropy.fill(&mut [0u8; 32])?;
    Ok(PROVIDER.get_or_init(RustCrypto::default))
}

/// A source of random bytes.
pub trait Entropy {
    /// Fills `out` with random bytes, or fails with `Error::Entropy` and leaves no promise about `out`.
    fn fill(&mut self, out: &mut [u8]) -> Result<(), Error>;
}

/// The operating system's source (in a browser: `crypto.getRandomValues`).
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemEntropy;

impl Entropy for SystemEntropy {
    fn fill(&mut self, out: &mut [u8]) -> Result<(), Error> {
        getrandom::getrandom(out).map_err(|_| Error::Entropy)
    }
}

/// ChaCha20 from a seed: the same bytes on every run. For the generator of the vectors only.
#[cfg(feature = "vectors")]
pub struct SeededEntropy(rand_chacha::ChaCha20Rng);

#[cfg(feature = "vectors")]
impl SeededEntropy {
    /// The stream of `seed`.
    pub fn new(seed: [u8; 32]) -> Self {
        Self(rand_core::SeedableRng::from_seed(seed))
    }
}

#[cfg(feature = "vectors")]
impl Entropy for SeededEntropy {
    fn fill(&mut self, out: &mut [u8]) -> Result<(), Error> {
        rand_core::RngCore::try_fill_bytes(&mut self.0, out).map_err(|_| Error::Entropy)
    }
}

/// `N` random bytes that are not secret: an id, a nonce.
pub fn random<const N: usize>(entropy: &mut dyn Entropy) -> Result<[u8; N], Error> {
    let mut bytes = [0u8; N];
    entropy.fill(&mut bytes)?;
    Ok(bytes)
}

/// `N` secret bytes: wiped when dropped, never printed, compared in constant time. There is no `Clone`: a second
/// copy is made on purpose with [`Secret::duplicate`].
pub struct Secret<const N: usize>([u8; N]);

impl<const N: usize> Secret<N> {
    /// Takes these bytes as a secret.
    pub fn new(bytes: [u8; N]) -> Self {
        Self(bytes)
    }

    /// Takes these bytes as a secret; `bad-format` for another length.
    pub fn from_slice(bytes: &[u8]) -> Result<Self, Error> {
        bytes.try_into().map(Self).map_err(|_| Error::BadFormat)
    }

    /// `N` fresh random bytes.
    pub fn random(entropy: &mut dyn Entropy) -> Result<Self, Error> {
        let mut secret = Self([0u8; N]);
        entropy.fill(&mut secret.0)?;
        Ok(secret)
    }

    /// The bytes, for the primitive or the store that needs them.
    pub fn expose(&self) -> &[u8; N] {
        &self.0
    }

    /// A second copy.
    pub fn duplicate(&self) -> Self {
        Self(self.0)
    }
}

impl<const N: usize> Drop for Secret<N> {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

impl<const N: usize> fmt::Debug for Secret<N> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("<redacted>")
    }
}

impl<const N: usize> PartialEq for Secret<N> {
    fn eq(&self, other: &Self) -> bool {
        ct_eq(&self.0, &other.0)
    }
}

impl<const N: usize> Eq for Secret<N> {}

/// Secret bytes of any length (an opened sealed value): wiped when dropped, never printed, compared in constant
/// time.
pub struct SecretBytes(Vec<u8>);

impl SecretBytes {
    /// Takes these bytes as a secret.
    pub fn new(bytes: Vec<u8>) -> Self {
        Self(bytes)
    }

    /// The bytes.
    pub fn expose(&self) -> &[u8] {
        &self.0
    }
}

impl Drop for SecretBytes {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

impl fmt::Debug for SecretBytes {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("<redacted>")
    }
}

impl PartialEq for SecretBytes {
    fn eq(&self, other: &Self) -> bool {
        ct_eq(&self.0, &other.0)
    }
}

impl Eq for SecretBytes {}

/// Whether two byte strings are equal, in time that depends only on their lengths.
pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.ct_eq(b).into()
}

/// SHA-256.
pub fn sha256(data: &[u8]) -> Result<Hash32, Error> {
    let digest = rust_crypto()?
        .hash(CIPHERSUITE.hash_algorithm(), data)
        .map_err(provider_fault)?;
    Hash32::from_slice(&digest).map_err(|_| Error::Internal("hash length"))
}

/// `struct { opaque label<V>; opaque value<V>; }`: the input of `RefHash`, and with the prefixed label that of
/// the labelled signature (`SignContent`) and the labelled sealing (`EncryptContext`).
fn labelled(label: &[u8], value: &[u8]) -> Result<Vec<u8>, Error> {
    let mut writer = Writer::new();
    writer.opaque(label)?;
    writer.opaque(value)?;
    Ok(writer.into_bytes())
}

fn prefixed(label: &str) -> Vec<u8> {
    [LABEL_PREFIX.as_bytes(), label.as_bytes()].concat()
}

/// `RefHash(label, value)` of RFC 9420 section 5.2. The label is hashed as given, without a prefix.
pub fn ref_hash(label: &str, value: &[u8]) -> Result<Hash32, Error> {
    sha256(&labelled(label.as_bytes(), value)?)
}

/// `ExpandWithLabel(secret, label, context, N)` of RFC 9420 section 8, with
/// `KDFLabel = struct { uint16 length; opaque label<V> = "MLS 1.0 " + label; opaque context<V>; }`.
pub fn expand_with_label<const N: usize>(
    secret: &Secret<32>,
    label: &str,
    context: &[u8],
) -> Result<Secret<N>, Error> {
    let mut info = Writer::new();
    info.u16(u16::try_from(N).map_err(|_| Error::Internal("expand length"))?);
    info.opaque(&prefixed(label))?;
    info.opaque(context)?;
    let output = rust_crypto()?
        .hkdf_expand(
            CIPHERSUITE.hash_algorithm(),
            secret.expose(),
            &info.into_bytes(),
            N,
        )
        .map_err(provider_fault)?;
    Secret::from_slice(output.as_slice()).map_err(|_| Error::Internal("expand length"))
}

/// An Ed25519 signature key: the 32-byte seed and the public key that follows from it. The public key of a
/// device's signature key is its device id.
pub struct SigningKey {
    seed: Secret<32>,
    public: [u8; 32],
}

impl SigningKey {
    /// The key of this seed.
    pub fn from_seed(seed: Secret<32>) -> Self {
        let public = ed25519_dalek::SigningKey::from_bytes(seed.expose())
            .verifying_key()
            .to_bytes();
        Self { seed, public }
    }

    /// A fresh key.
    pub fn generate(entropy: &mut dyn Entropy) -> Result<Self, Error> {
        Ok(Self::from_seed(Secret::random(entropy)?))
    }

    /// The public key.
    pub fn public(&self) -> [u8; 32] {
        self.public
    }

    /// The seed: what a device stores, and the private key as the OpenMLS provider takes it.
    pub fn seed(&self) -> &Secret<32> {
        &self.seed
    }
}

impl fmt::Debug for SigningKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SigningKey(<redacted>)")
    }
}

/// `SignWithLabel(key, label, content)` of RFC 9420 section 5.1.2: the Ed25519 signature (64 bytes) over
/// `SignContent = struct { opaque label<V> = "MLS 1.0 " + label; opaque content<V>; }`.
pub fn sign_with_label(key: &SigningKey, label: &str, content: &[u8]) -> Result<Vec<u8>, Error> {
    let sign_content = labelled(&prefixed(label), content)?;
    rust_crypto()?
        .sign(
            CIPHERSUITE.signature_algorithm(),
            &sign_content,
            key.seed.expose(),
        )
        .map_err(provider_fault)
}

/// `VerifyWithLabel`: `bad-signature` unless `signature` is `public_key`'s over this label and content.
pub fn verify_with_label(
    public_key: &[u8; 32],
    label: &str,
    content: &[u8],
    signature: &[u8],
) -> Result<(), Error> {
    let sign_content = labelled(&prefixed(label), content)?;
    rust_crypto()?
        .verify_signature(
            CIPHERSUITE.signature_algorithm(),
            &sign_content,
            public_key,
            signature,
        )
        .map_err(|_| Error::BadSignature)
}

/// An X25519 key pair for HPKE.
pub struct HpkeKeyPair {
    /// The private key.
    pub private: Secret<32>,
    /// The public key.
    pub public: [u8; 32],
}

impl fmt::Debug for HpkeKeyPair {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("HpkeKeyPair(<redacted>)")
    }
}

/// `DeriveKeyPair(ikm)` of RFC 9180 section 7.1.3.
pub fn derive_hpke_keypair(ikm: &Secret<32>) -> Result<HpkeKeyPair, Error> {
    let pair = rust_crypto()?
        .derive_hpke_keypair(CIPHERSUITE.hpke_config(), ikm.expose())
        .map_err(provider_fault)?;
    Ok(HpkeKeyPair {
        private: Secret::from_slice(&pair.private).map_err(|_| Error::Internal("key length"))?,
        public: pair
            .public
            .as_slice()
            .try_into()
            .map_err(|_| Error::Internal("key length"))?,
    })
}

/// RFC 9420's `struct { opaque kem_output<V>; opaque ciphertext<V>; } HPKECiphertext`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HpkeCiphertext {
    /// The encapsulated key.
    pub kem_output: Vec<u8>,
    /// The sealed plaintext.
    pub ciphertext: Vec<u8>,
}

impl Encode for HpkeCiphertext {
    fn write(&self, writer: &mut Writer) -> Result<(), Error> {
        writer.opaque(&self.kem_output)?;
        writer.opaque(&self.ciphertext)
    }
}

impl Decode for HpkeCiphertext {
    fn read(reader: &mut Reader<'_>) -> Result<Self, Error> {
        Ok(Self {
            kem_output: reader.opaque()?.to_vec(),
            ciphertext: reader.opaque()?.to_vec(),
        })
    }
}

/// The sealing with the randomness given, for the vectors and the tests only: see the module documentation.
#[cfg(any(test, feature = "vectors"))]
mod given {
    use super::{
        derive_hpke_keypair, provider_fault, rust_crypto, Error, HpkeCiphertext, Secret,
        CIPHERSUITE,
    };
    use hpke_rs::{Hpke, Mode};
    use hpke_rs_crypto::types::{AeadAlgorithm, KdfAlgorithm, KemAlgorithm};
    use hpke_rs_crypto::HpkeCrypto;
    use hpke_rs_rust_crypto::HpkeRustCrypto;
    use openmls_traits::crypto::OpenMlsCrypto;
    use zeroize::Zeroizing;

    /// RFC 9180: the version in every labelled HKDF input, and the suite id of DHKEM(X25519, HKDF-SHA256).
    const HPKE_VERSION: &[u8] = b"HPKE-v1";
    const KEM_SUITE_ID: &[u8] = b"KEM\x00\x20";

    /// RFC 9180's `LabeledExtract` and `LabeledExpand` for the KEM, on the provider's HKDF.
    fn kem_extract_and_expand(dh: &[u8], kem_context: &[u8]) -> Result<Zeroizing<Vec<u8>>, Error> {
        let provider = rust_crypto()?;
        let hash = CIPHERSUITE.hash_algorithm();
        let labelled_ikm = Zeroizing::new([HPKE_VERSION, KEM_SUITE_ID, b"eae_prk", dh].concat());
        let prk = provider
            .hkdf_extract(hash, &[], &labelled_ikm)
            .map_err(provider_fault)?;
        let length = [0x00, 0x20];
        let labelled_info = [
            &length,
            HPKE_VERSION,
            KEM_SUITE_ID,
            b"shared_secret",
            kem_context,
        ]
        .concat();
        let shared = provider
            .hkdf_expand(hash, prk.as_slice(), &labelled_info, 32)
            .map_err(provider_fault)?;
        Ok(Zeroizing::new(shared.as_slice().to_vec()))
    }

    fn hpke() -> Hpke<HpkeRustCrypto> {
        Hpke::new(
            Mode::Base,
            KemAlgorithm::DhKem25519,
            KdfAlgorithm::HkdfSha256,
            AeadAlgorithm::ChaCha20Poly1305,
        )
    }

    /// `Encap(pkR)` with `skE, pkE = DeriveKeyPair(ikm)`: `dh = DH(skE, pkR)`, `enc = pkE`,
    /// `shared_secret = ExtractAndExpand(dh, enc ‖ pkR)`. Returns `enc` and the shared secret.
    fn encap(ikm: &Secret<32>, public_key: &[u8]) -> Result<([u8; 32], Zeroizing<Vec<u8>>), Error> {
        let ephemeral = derive_hpke_keypair(ikm)?;
        let dh = HpkeRustCrypto::dh(
            KemAlgorithm::DhKem25519,
            public_key,
            ephemeral.private.expose(),
        )
        .map(Zeroizing::new)
        .map_err(|_| Error::BadFormat)?;
        let kem_context = [ephemeral.public.as_slice(), public_key].concat();
        Ok((ephemeral.public, kem_extract_and_expand(&dh, &kem_context)?))
    }

    /// HPKE single-shot sealing in base mode (RFC 9180 section 6.1) to `public_key`, the ephemeral key derived
    /// from `ikm`: the bytes the provider's `hpke_seal` gives when its generator yields `ikm`.
    pub(crate) fn hpke_seal_with(
        ikm: &Secret<32>,
        public_key: &[u8],
        info: &[u8],
        aad: &[u8],
        plaintext: &[u8],
    ) -> Result<HpkeCiphertext, Error> {
        let (kem_output, shared_secret) = encap(ikm, public_key)?;
        let ciphertext = hpke()
            .key_schedule(&shared_secret, info, &[], &[])
            .and_then(|mut context| context.seal(aad, plaintext))
            .map_err(|_| Error::Internal("hpke seal"))?;
        Ok(HpkeCiphertext {
            kem_output: kem_output.to_vec(),
            ciphertext,
        })
    }

    /// HPKE's secret export in base mode (RFC 9180 section 6.2) to `public_key` with the ephemeral key derived
    /// from `ikm`: the encapsulated key and the exported secret, as the provider's
    /// `hpke_setup_sender_and_export` gives them when its generator yields `ikm`.
    #[cfg(feature = "vectors")]
    pub(crate) fn hpke_export_with(
        ikm: &Secret<32>,
        public_key: &[u8],
        info: &[u8],
        exporter_context: &[u8],
        length: usize,
    ) -> Result<(Vec<u8>, Zeroizing<Vec<u8>>), Error> {
        let (kem_output, shared_secret) = encap(ikm, public_key)?;
        let exported = hpke()
            .key_schedule(&shared_secret, info, &[], &[])
            .and_then(|context| context.export(exporter_context, length))
            .map_err(|_| Error::Internal("hpke export"))?;
        Ok((kem_output.to_vec(), Zeroizing::new(exported)))
    }
}
#[cfg(feature = "vectors")]
pub(crate) use given::hpke_export_with;
#[cfg(any(test, feature = "vectors"))]
pub(crate) use given::hpke_seal_with;

/// HPKE single-shot sealing in base mode (RFC 9180 section 6.1) to `public_key`, by the provider. `bad-format`
/// for a public key that is not 32 bytes or is a point of small order.
///
/// `entropy` is asked for 32 bytes first and those bytes are thrown away: a source that fails at that moment
/// is `Error::Entropy` here. That is a check before the call and no more. The provider takes no source: for
/// every sealing it seeds a generator of its own from the system and panics if the system source fails at
/// that moment. A failure between the check and the provider's own draw is therefore a panic, and so is a
/// failure when `entropy` is not the system source. Only a provider whose HPKE takes its randomness from the
/// caller closes this.
#[cfg(not(feature = "vectors"))]
pub(crate) fn hpke_seal(
    entropy: &mut dyn Entropy,
    public_key: &[u8],
    info: &[u8],
    aad: &[u8],
    plaintext: &[u8],
) -> Result<HpkeCiphertext, Error> {
    Secret::<32>::random(entropy)?;
    if public_key.len() != 32 {
        return Err(Error::BadFormat);
    }
    let sealed = rust_crypto()?
        .hpke_seal(CIPHERSUITE.hpke_config(), public_key, info, aad, plaintext)
        .map_err(|_| Error::BadFormat)?;
    Ok(HpkeCiphertext {
        kem_output: sealed.kem_output.as_slice().to_vec(),
        ciphertext: sealed.ciphertext.as_slice().to_vec(),
    })
}

/// The sealing of the vector generator: the ephemeral key is derived from 32 bytes of `entropy`, so a seeded
/// source repeats it. Not part of a shipped build.
#[cfg(feature = "vectors")]
pub(crate) fn hpke_seal(
    entropy: &mut dyn Entropy,
    public_key: &[u8],
    info: &[u8],
    aad: &[u8],
    plaintext: &[u8],
) -> Result<HpkeCiphertext, Error> {
    hpke_seal_with(&Secret::random(entropy)?, public_key, info, aad, plaintext)
}

/// HPKE single-shot opening in base mode with `private_key`; `decrypt-failed` when it does not open.
pub(crate) fn hpke_open(
    private_key: &Secret<32>,
    info: &[u8],
    aad: &[u8],
    sealed: &HpkeCiphertext,
) -> Result<SecretBytes, Error> {
    let input = ProviderCiphertext {
        kem_output: sealed.kem_output.clone().into(),
        ciphertext: sealed.ciphertext.clone().into(),
    };
    rust_crypto()?
        .hpke_open(
            CIPHERSUITE.hpke_config(),
            &input,
            private_key.expose(),
            info,
            aad,
        )
        .map(SecretBytes::new)
        .map_err(|_| Error::DecryptFailed)
}

/// `EncryptWithLabel(public_key, label, context, plaintext)` of RFC 9420 section 5.1.3: HPKE with
/// `EncryptContext = struct { opaque label<V> = "MLS 1.0 " + label; opaque context<V>; }` as info and empty aad.
pub fn encrypt_with_label(
    entropy: &mut dyn Entropy,
    public_key: &[u8],
    label: &str,
    context: &[u8],
    plaintext: &[u8],
) -> Result<HpkeCiphertext, Error> {
    let info = labelled(&prefixed(label), context)?;
    hpke_seal(entropy, public_key, &info, &[], plaintext)
}

/// `DecryptWithLabel`: the plaintext, or `decrypt-failed`.
pub fn decrypt_with_label(
    private_key: &Secret<32>,
    label: &str,
    context: &[u8],
    sealed: &HpkeCiphertext,
) -> Result<SecretBytes, Error> {
    let info = labelled(&prefixed(label), context)?;
    hpke_open(private_key, &info, &[], sealed)
}

/// ChaCha20-Poly1305: the ciphertext with its tag, [`TAG_LEN`] bytes longer than `plaintext`.
pub fn aead_seal(
    key: &Secret<32>,
    nonce: &[u8; NONCE_LEN],
    aad: &[u8],
    plaintext: &[u8],
) -> Result<Vec<u8>, Error> {
    rust_crypto()?
        .aead_encrypt(
            CIPHERSUITE.aead_algorithm(),
            key.expose(),
            plaintext,
            nonce,
            aad,
        )
        .map_err(provider_fault)
}

/// ChaCha20-Poly1305: the plaintext, or `decrypt-failed`.
pub fn aead_open(
    key: &Secret<32>,
    nonce: &[u8; NONCE_LEN],
    aad: &[u8],
    ciphertext: &[u8],
) -> Result<Vec<u8>, Error> {
    rust_crypto()?
        .aead_decrypt(
            CIPHERSUITE.aead_algorithm(),
            key.expose(),
            ciphertext,
            nonce,
            aad,
        )
        .map_err(|_| Error::DecryptFailed)
}

/// HMAC-SHA-256.
pub fn hmac_sha256(key: &Secret<32>, data: &[u8]) -> Result<[u8; 32], Error> {
    let tag = rust_crypto()?
        .hmac(CIPHERSUITE.hash_algorithm(), key.expose(), data)
        .map_err(provider_fault)?;
    tag.as_slice()
        .try_into()
        .map_err(|_| Error::Internal("mac length"))
}

/// Whether `tag` is the HMAC-SHA-256 of `data` under `key`, compared in constant time.
pub fn hmac_verify(key: &Secret<32>, data: &[u8], tag: &[u8]) -> Result<bool, Error> {
    Ok(ct_eq(&hmac_sha256(key, data)?, tag))
}

#[cfg(test)]
mod tests {
    use super::*;
    use openmls::prelude::tls_codec::Serialize as _;
    use openmls::prelude::{
        hash_ref::HashReference,
        signable::{Signable, SignedStruct},
        Signature,
    };
    use openmls_basic_credential::SignatureKeyPair;

    fn hex(text: &str) -> Vec<u8> {
        text.as_bytes()
            .chunks(2)
            .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
            .collect()
    }

    fn secret(text: &str) -> Secret<32> {
        Secret::from_slice(&hex(text)).unwrap()
    }

    /// Hands out the bytes it was given, then fails.
    struct Fixed(Vec<u8>);
    impl Entropy for Fixed {
        fn fill(&mut self, out: &mut [u8]) -> Result<(), Error> {
            if out.len() > self.0.len() {
                return Err(Error::Entropy);
            }
            let rest = self.0.split_off(out.len());
            out.copy_from_slice(&self.0);
            self.0 = rest;
            Ok(())
        }
    }

    // RFC 9420's test vectors (mls-implementations, test-vectors/crypto-basics.json), the case of suite 3.

    #[test]
    fn ref_hash_is_the_vectors() {
        let value = hex("4f0c86f9c82fba0a896bd7eecf79a29856e98a7e4f13b9f841ae285d70ed8b68");
        let out = ref_hash("RefHash", &value).unwrap();
        assert_eq!(
            out.to_string(),
            "f11019703c8b630060839b12a475fd39c6a30f8a866790ff46a35f9c65e1df3c"
        );
    }

    #[test]
    fn expand_with_label_is_the_vectors() {
        let out: Secret<32> = expand_with_label(
            &secret("55aa3ae5242564782567ce097beafe19510230660008b2cc064a78387fa16f36"),
            "ExpandWithLabel",
            &hex("2e07148f4340c62a55e7608c20d73fddf1f3b8dafb2c7ef24eceb70e136c0d8c"),
        )
        .unwrap();
        assert_eq!(
            out,
            secret("1df5ba7996a34f75d717916a094a14083c03a75e80f0330a8095f5f11cfe1e1f")
        );

        // DeriveSecret(secret, label) = ExpandWithLabel(secret, label, "", Nh).
        let out: Secret<32> = expand_with_label(
            &secret("cae460c779ebaa3e81c061a371486dff1ed1ff273bea369cc0fc46550b83c407"),
            "DeriveSecret",
            &[],
        )
        .unwrap();
        assert_eq!(
            out,
            secret("aad859818ca5f2a9896d4d3ee2dccc0cefcd69b666bdb16b52f1de15fb1a5567")
        );

        // DeriveTreeSecret(secret, label, generation, length) = ExpandWithLabel(secret, label, uint32 generation, length).
        let out: Secret<32> = expand_with_label(
            &secret("c994e257b53f726087ddd7121876f558f1fbd6f807e5ff010830d618d7bab6f2"),
            "DeriveTreeSecret",
            &2694881440u32.to_be_bytes(),
        )
        .unwrap();
        assert_eq!(
            out,
            secret("2095d6a81ab87095d1df26f6bdf012ec06f197e418381c1795a7b758603c936d")
        );
    }

    #[test]
    fn expand_with_label_gives_the_length_asked_for() {
        let key = Secret::new([7; 32]);
        let short: Secret<16> = expand_with_label(&key, "trommi invite id", &[1; 32]).unwrap();
        let long: Secret<32> = expand_with_label(&key, "trommi invite id", &[1; 32]).unwrap();
        // The length is part of the label, so the short output is not the start of the long one.
        assert_ne!(short.expose(), &long.expose()[..16]);
    }

    #[test]
    fn sign_with_label_is_the_vectors() {
        let key = SigningKey::from_seed(secret(
            "4e312160ee4981358db479aa877412847abc7f7054b5605511256c395404d054",
        ));
        let public = key.public();
        assert_eq!(
            public.to_vec(),
            hex("18275f892ee0ca6f4687ff26c990776387502646ff658c3f572b324faecb05c5")
        );
        let content = hex("df308cf2dbf471edf2c29d30e3daf161b5b87d350ee3b2c715c298ec3d10d432");
        let theirs = hex("4f56851c2c47f5115a61ff0ab6121b4a4732d4e94805fc7135a5132f87d5ca5f1dc7408816c1ea4f25887725cf5914b48c427a52cabcfeb746a2b8a12e821f08");
        verify_with_label(&public, "SignWithLabel", &content, &theirs).unwrap();
        // Ed25519 is deterministic: the same key and content give the vector's signature.
        assert_eq!(
            sign_with_label(&key, "SignWithLabel", &content).unwrap(),
            theirs
        );
    }

    #[test]
    fn verify_refuses_whatever_was_not_signed() {
        let key = SigningKey::generate(&mut SystemEntropy).unwrap();
        let other = SigningKey::generate(&mut SystemEntropy).unwrap();
        let signature = sign_with_label(&key, "TrommiEnvelope", b"content").unwrap();
        assert_eq!(signature.len(), 64);
        verify_with_label(&key.public(), "TrommiEnvelope", b"content", &signature).unwrap();
        let refused = |public: [u8; 32], label, content: &[u8], signature: &[u8]| {
            assert_eq!(
                verify_with_label(&public, label, content, signature),
                Err(Error::BadSignature)
            );
        };
        refused(other.public(), "TrommiEnvelope", b"content", &signature);
        refused(key.public(), "TrommiHubAuth", b"content", &signature);
        refused(key.public(), "TrommiEnvelope", b"contenu", &signature);
        refused(key.public(), "TrommiEnvelope", b"content", &signature[..63]);
        refused(key.public(), "TrommiEnvelope", b"content", &[]);
        let mut flipped = signature.clone();
        flipped[10] ^= 1;
        refused(key.public(), "TrommiEnvelope", b"content", &flipped);
        // A public key that is no point on the curve.
        refused([0xFF; 32], "TrommiEnvelope", b"content", &signature);
    }

    #[test]
    fn decrypt_with_label_opens_the_vectors() {
        let private = secret("9d122ad4638fcb301b6eb5f4073414afb44bb34d37b4ddee9975b2941d700edb");
        let public = hex("7a5544b59f5940bf093c921469a00a170a7c92ba56c173d74db32713608d8a40");
        let context = hex("0d6a5cf9ee88b1f8c79d8512477d9bfc5496c207c8173f8dcac0368b4dba7407");
        let plaintext = hex("1dd4c1904996ce7d42cee7de68881459fa7a345da59a02040ade37103505baf6");
        let sealed = HpkeCiphertext {
            kem_output: hex("f26e9e5a94396a90f85a5f72eedf3dacfb1b7f4164e0573edeb9c6c912e1cb49"),
            ciphertext: hex("40dd09ad4c5dc29d373f814bf054c9359cb75a468bc4d2c8bbcffb072a73105c4d9416ebd4fafeb62e59a9dea55da3cd"),
        };
        let opened = decrypt_with_label(&private, "EncryptWithLabel", &context, &sealed).unwrap();
        assert_eq!(opened.expose(), plaintext);

        // And the other direction, to the vector's key.
        let ours = encrypt_with_label(
            &mut SystemEntropy,
            &public,
            "EncryptWithLabel",
            &context,
            &plaintext,
        )
        .unwrap();
        assert_ne!(ours, sealed);
        let opened = decrypt_with_label(&private, "EncryptWithLabel", &context, &ours).unwrap();
        assert_eq!(opened.expose(), plaintext);
    }

    // RFC 9180, appendix A.2.1: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, ChaCha20Poly1305, base mode.

    #[test]
    fn hpke_seal_is_rfc_9180s_with_its_randomness() {
        let ikm_e = hex("909a9b35d3dc4713a5e72a4da274b55d3d3821a37e5d099e74a647db583a904b");
        let pk_r = hex("4310ee97d88cc1f088a5576c77ab0cf5c3ac797f3d95139c6c84b5429c59662a");
        let sk_r = secret("8057991eef8f1f1af18f4a9491d16a1ce333f695d4db8e38da75975c4478e0fb");
        let info = hex("4f6465206f6e2061204772656369616e2055726e");
        let aad = hex("436f756e742d30");
        let plaintext = hex("4265617574792069732074727574682c20747275746820626561757479");
        let ikm_e = Secret::from_slice(&ikm_e).unwrap();
        let sealed = hpke_seal_with(&ikm_e, &pk_r, &info, &aad, &plaintext).unwrap();
        assert_eq!(
            sealed.kem_output,
            hex("1afa08d3dec047a643885163f1180476fa7ddb54c6a8029ea33f95796bf2ac4a")
        );
        assert_eq!(
            sealed.ciphertext,
            hex("1c5250d8034ec2b784ba2cfd69dbdb8af406cfe3ff938e131f0def8c8b60b4db21993c62ce81883d2dd1b51a28")
        );
        assert_eq!(
            hpke_open(&sk_r, &info, &aad, &sealed).unwrap().expose(),
            plaintext
        );
    }

    #[test]
    fn derive_hpke_keypair_is_rfc_9180s() {
        let pair = derive_hpke_keypair(&secret(
            "1ac01f181fdf9f352797655161c58b75c656a6cc2716dcb66372da835542e1df",
        ))
        .unwrap();
        assert_eq!(
            pair.public.to_vec(),
            hex("4310ee97d88cc1f088a5576c77ab0cf5c3ac797f3d95139c6c84b5429c59662a")
        );
        assert_eq!(
            pair.private,
            secret("8057991eef8f1f1af18f4a9491d16a1ce333f695d4db8e38da75975c4478e0fb")
        );
    }

    #[test]
    fn sealing_meets_the_providers_own() {
        let provider = rust_crypto().unwrap();
        let pair = derive_hpke_keypair(&Secret::new([3; 32])).unwrap();
        let info = labelled(&prefixed("TrommiSealedKey"), b"context").unwrap();

        // What the provider seals, this module opens.
        let theirs = provider
            .hpke_seal(
                CIPHERSUITE.hpke_config(),
                &pair.public,
                &info,
                &[],
                b"content key",
            )
            .unwrap();
        let theirs = HpkeCiphertext {
            kem_output: theirs.kem_output.as_slice().to_vec(),
            ciphertext: theirs.ciphertext.as_slice().to_vec(),
        };
        let opened =
            decrypt_with_label(&pair.private, "TrommiSealedKey", b"context", &theirs).unwrap();
        assert_eq!(opened.expose(), b"content key");

        // What this module seals opens only with the same key, label and context, and whole.
        let ours = encrypt_with_label(
            &mut SystemEntropy,
            &pair.public,
            "TrommiSealedKey",
            b"context",
            b"content key",
        )
        .unwrap();
        assert_eq!(ours.kem_output.len(), 32);
        assert_eq!(ours.ciphertext.len(), b"content key".len() + TAG_LEN);
        let open = |key: &Secret<32>, label, context: &[u8], sealed: &HpkeCiphertext| {
            decrypt_with_label(key, label, context, sealed)
        };
        assert_eq!(
            open(&pair.private, "TrommiSealedKey", b"context", &ours)
                .unwrap()
                .expose(),
            b"content key"
        );
        assert_eq!(
            open(&Secret::new([4; 32]), "TrommiSealedKey", b"context", &ours),
            Err(Error::DecryptFailed)
        );
        assert_eq!(
            open(&pair.private, "TrommiRecoveryLink", b"context", &ours),
            Err(Error::DecryptFailed)
        );
        assert_eq!(
            open(&pair.private, "TrommiSealedKey", b"other", &ours),
            Err(Error::DecryptFailed)
        );
        let mut cut = ours.clone();
        cut.ciphertext.pop();
        assert_eq!(
            open(&pair.private, "TrommiSealedKey", b"context", &cut),
            Err(Error::DecryptFailed)
        );
        let mut short = ours.clone();
        short.kem_output.pop();
        assert_eq!(
            open(&pair.private, "TrommiSealedKey", b"context", &short),
            Err(Error::DecryptFailed)
        );
    }

    #[test]
    fn sealing_refuses_a_key_that_is_none() {
        let seal =
            |key: &[u8]| encrypt_with_label(&mut SystemEntropy, key, "TrommiSealedKey", &[], b"x");
        assert_eq!(seal(&[1; 31]), Err(Error::BadFormat));
        assert_eq!(seal(&[1; 33]), Err(Error::BadFormat));
        assert_eq!(seal(&[]), Err(Error::BadFormat));
        // The point of order one: every shared secret with it is zero.
        assert_eq!(seal(&[0; 32]), Err(Error::BadFormat));
    }

    #[test]
    fn sealing_passes_failing_entropy_on() {
        let pair = derive_hpke_keypair(&Secret::new([3; 32])).unwrap();
        let sealed = encrypt_with_label(
            &mut Fixed(vec![0; 31]),
            &pair.public,
            "TrommiSealedKey",
            &[],
            b"x",
        );
        assert_eq!(sealed, Err(Error::Entropy));
        assert_eq!(
            Secret::<32>::random(&mut Fixed(vec![])),
            Err(Error::Entropy)
        );
        assert_eq!(random::<12>(&mut Fixed(vec![1; 12])), Ok([1; 12]));
    }

    #[test]
    fn hpke_ciphertext_encodes_as_the_providers() {
        let ours = HpkeCiphertext {
            kem_output: vec![1; 32],
            ciphertext: vec![2; 48],
        };
        let theirs = ProviderCiphertext {
            kem_output: vec![1; 32].into(),
            ciphertext: vec![2; 48].into(),
        };
        let bytes = crate::codec::encode(&ours).unwrap();
        assert_eq!(bytes, theirs.tls_serialize_detached().unwrap());
        assert_eq!(
            crate::codec::decode::<HpkeCiphertext>(&bytes, 128).unwrap(),
            ours
        );
    }

    // OpenMLS's own labelled hash and signature.

    #[test]
    fn ref_hash_is_openmls_hash_reference() {
        let provider = rust_crypto().unwrap();
        for (label, value) in [
            ("Trommi Envelope", vec![9u8; 100]),
            ("Trommi Room State", vec![]),
            ("x", vec![1; 70_000]),
        ] {
            let theirs =
                HashReference::new(&value, CIPHERSUITE, provider, label.as_bytes()).unwrap();
            assert_eq!(
                ref_hash(label, &value).unwrap().as_bytes(),
                theirs.as_slice()
            );
        }
    }

    struct Payload(Vec<u8>);
    struct Signed(Signature);
    impl Signable for Payload {
        type SignedOutput = Signed;
        fn unsigned_payload(&self) -> Result<Vec<u8>, openmls::prelude::tls_codec::Error> {
            Ok(self.0.clone())
        }
        fn label(&self) -> &str {
            "TrommiEnvelope"
        }
    }
    impl SignedStruct<Payload> for Signed {
        fn from_payload(_: Payload, signature: Signature, _: Vec<u8>) -> Self {
            Self(signature)
        }
    }

    #[test]
    fn sign_with_label_is_openmls_signable() {
        let key = SigningKey::generate(&mut SystemEntropy).unwrap();
        let signer = SignatureKeyPair::from_raw(
            CIPHERSUITE.signature_algorithm(),
            key.seed().expose().to_vec(),
            key.public().to_vec(),
        );
        for content in [vec![], vec![5u8; 32], vec![6; 20_000]] {
            let theirs = Payload(content.clone()).sign(&signer).unwrap().0;
            let ours = sign_with_label(&key, "TrommiEnvelope", &content).unwrap();
            // A `Signature` shows its bytes only encoded, as `opaque<V>`.
            let mut encoded = Writer::new();
            encoded.opaque(&ours).unwrap();
            assert_eq!(
                encoded.into_bytes(),
                theirs.tls_serialize_detached().unwrap()
            );
        }
    }

    #[test]
    fn aead_is_chacha20_poly1305() {
        // RFC 8439 section 2.8.2.
        let key = secret("808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f");
        let nonce: [u8; 12] = hex("070000004041424344454647").try_into().unwrap();
        let aad = hex("50515253c0c1c2c3c4c5c6c7");
        let plaintext = b"Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.";
        let sealed = aead_seal(&key, &nonce, &aad, plaintext).unwrap();
        assert_eq!(sealed.len(), plaintext.len() + TAG_LEN);
        assert_eq!(sealed[..16], hex("d31a8d34648e60db7b86afbc53ef7ec2"));
        assert_eq!(
            sealed[plaintext.len()..],
            hex("1ae10b594f09e26a7e902ecbd0600691")
        );
        assert_eq!(aead_open(&key, &nonce, &aad, &sealed).unwrap(), plaintext);

        assert_eq!(
            aead_open(&Secret::new([0; 32]), &nonce, &aad, &sealed),
            Err(Error::DecryptFailed)
        );
        assert_eq!(
            aead_open(&key, &[0; 12], &aad, &sealed),
            Err(Error::DecryptFailed)
        );
        assert_eq!(
            aead_open(&key, &nonce, b"", &sealed),
            Err(Error::DecryptFailed)
        );
        assert_eq!(
            aead_open(&key, &nonce, &aad, &sealed[..sealed.len() - 1]),
            Err(Error::DecryptFailed)
        );
        assert_eq!(
            aead_open(&key, &nonce, &aad, &[]),
            Err(Error::DecryptFailed)
        );
    }

    #[test]
    fn hmac_is_rfc_4231s_and_verifies_in_full() {
        // RFC 4231, test case 2 has a short key; HMAC pads a key with zeros, so the padded key gives the same tag.
        let mut key = [0u8; 32];
        key[..4].copy_from_slice(b"Jefe");
        let key = Secret::new(key);
        let tag = hmac_sha256(&key, b"what do ya want for nothing?").unwrap();
        assert_eq!(
            tag.to_vec(),
            hex("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843")
        );
        assert_eq!(
            hmac_verify(&key, b"what do ya want for nothing?", &tag),
            Ok(true)
        );
        assert_eq!(
            hmac_verify(&key, b"what do ya want for nothing!", &tag),
            Ok(false)
        );
        assert_eq!(
            hmac_verify(&key, b"what do ya want for nothing?", &tag[..31]),
            Ok(false)
        );
        assert_eq!(
            hmac_verify(&key, b"what do ya want for nothing?", &[]),
            Ok(false)
        );
        assert_eq!(
            hmac_verify(&Secret::new([1; 32]), b"what do ya want for nothing?", &tag),
            Ok(false)
        );
    }

    #[test]
    fn sha256_is_sha256() {
        assert_eq!(
            sha256(b"abc").unwrap().to_string(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn secrets_do_not_print_and_compare_whole() {
        let a = Secret::new([1u8; 32]);
        assert_eq!(format!("{a:?}"), "<redacted>");
        assert_eq!(
            format!("{:?}", SecretBytes::new(vec![1, 2, 3])),
            "<redacted>"
        );
        assert_eq!(
            format!("{:?}", SigningKey::from_seed(a.duplicate())),
            "SigningKey(<redacted>)"
        );
        let pair = derive_hpke_keypair(&a).unwrap();
        assert_eq!(format!("{pair:?}"), "HpkeKeyPair(<redacted>)");
        assert_eq!(a, a.duplicate());
        assert_ne!(a, Secret::new([2u8; 32]));
        assert_eq!(Secret::<32>::from_slice(&[0; 31]), Err(Error::BadFormat));
        assert_ne!(
            SecretBytes::new(vec![1, 2]),
            SecretBytes::new(vec![1, 2, 3])
        );
        assert!(ct_eq(b"same", b"same") && !ct_eq(b"same", b"sama") && !ct_eq(b"same", b"sam"));
    }

    #[cfg(feature = "vectors")]
    #[test]
    fn seeded_entropy_repeats_and_makes_sealing_repeat() {
        let draw = |seed| random::<64>(&mut SeededEntropy::new([seed; 32])).unwrap();
        assert_eq!(draw(1), draw(1));
        assert_ne!(draw(1), draw(2));
        let pair = derive_hpke_keypair(&Secret::new([3; 32])).unwrap();
        let seal = |seed| {
            encrypt_with_label(
                &mut SeededEntropy::new([seed; 32]),
                &pair.public,
                "TrommiSealedKey",
                b"c",
                b"key",
            )
            .unwrap()
        };
        assert_eq!(seal(1), seal(1));
        assert_ne!(seal(1), seal(2));
        assert_eq!(
            SigningKey::generate(&mut SeededEntropy::new([5; 32]))
                .unwrap()
                .public(),
            SigningKey::generate(&mut SeededEntropy::new([5; 32]))
                .unwrap()
                .public()
        );
    }
}
