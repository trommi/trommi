//! The OpenMLS provider of a device or an observer: OpenMLS's RustCrypto for every primitive, randomness from
//! the owner's [`Entropy`], and OpenMLS's memory storage, whose entries the owner copies to its store after each
//! operation and puts back when one fails.
//!
//! **Randomness.** OpenMLS draws key material through `OpenMlsRand`, which here asks the [`Entropy`] and passes
//! its failure on as an error. HPKE sealing inside OpenMLS (path secrets, Welcomes, the init secret of a join
//! from outside) goes through the crypto provider, whose own generator cannot be given a source: a shipped build
//! uses it unchanged. Under the cargo feature `vectors` the crypto provider is [`deterministic::Crypto`], which
//! derives each ephemeral key from a seed and the call's inputs, so that a played-through room repeats byte for
//! byte.
//!
//! **Stored entries are untrusted.** OpenMLS's memory storage panics when one of a few entry kinds does not
//! decode. [`validate_entries`] decodes those kinds before OpenMLS reads them and refuses unknown kinds.

use crate::crypto::{self, Entropy, SigningKey, CIPHERSUITE};
use crate::error::Error;
use crate::ids::DeviceId;
use openmls::prelude::{BasicCredential, CredentialWithKey, GroupContext, LeafNode};
use openmls_memory_storage::MemoryStorage;
use openmls_traits::random::OpenMlsRand;
use openmls_traits::signatures::{Signer, SignerError};
use openmls_traits::types::SignatureScheme;
use openmls_traits::OpenMlsProvider;
use std::collections::HashMap;
use std::fmt;
use std::sync::{Mutex, PoisonError};

/// The crypto provider OpenMLS works with: RustCrypto itself in a shipped build.
#[cfg(not(feature = "vectors"))]
pub(crate) type Crypto = openmls_rust_crypto::RustCrypto;
#[cfg(feature = "vectors")]
pub(crate) use deterministic::Crypto;

/// The entries of OpenMLS's storage, as they are kept in memory.
pub(crate) type MlsEntries = HashMap<Vec<u8>, Vec<u8>>;

/// Entries to write and keys to remove.
pub(crate) type MlsChanges = (Vec<(Vec<u8>, Vec<u8>)>, Vec<Vec<u8>>);

/// The entropy failed: OpenMLS turns this into the failure of the operation that asked.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct NoEntropy;

impl fmt::Display for NoEntropy {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("the system gave no randomness")
    }
}

impl std::error::Error for NoEntropy {}

/// OpenMLS's source of random bytes: the owner's [`Entropy`].
pub(crate) struct Rand(Mutex<Box<dyn Entropy + Send>>);

impl Rand {
    fn fill(&self, out: &mut [u8]) -> Result<(), Error> {
        // A panic while the lock was held leaves the source usable.
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .fill(out)
    }
}

impl OpenMlsRand for Rand {
    type Error = NoEntropy;

    fn random_array<const N: usize>(&self) -> Result<[u8; N], NoEntropy> {
        let mut out = [0u8; N];
        self.fill(&mut out).map_err(|_| NoEntropy)?;
        Ok(out)
    }

    fn random_vec(&self, len: usize) -> Result<Vec<u8>, NoEntropy> {
        let mut out = vec![0u8; len];
        self.fill(&mut out).map_err(|_| NoEntropy)?;
        Ok(out)
    }
}

/// What OpenMLS is handed in every call.
pub(crate) struct Provider {
    #[cfg(not(feature = "vectors"))]
    crypto: &'static Crypto,
    #[cfg(feature = "vectors")]
    crypto: Crypto,
    rand: Rand,
    storage: MemoryStorage,
}

impl OpenMlsProvider for Provider {
    type CryptoProvider = Crypto;
    type RandProvider = Rand;
    type StorageProvider = MemoryStorage;

    fn storage(&self) -> &MemoryStorage {
        &self.storage
    }

    fn crypto(&self) -> &Crypto {
        #[cfg(not(feature = "vectors"))]
        return self.crypto;
        #[cfg(feature = "vectors")]
        return &self.crypto;
    }

    fn rand(&self) -> &Rand {
        &self.rand
    }
}

impl Provider {
    /// A provider over `entries`, which must have passed [`validate_entries`]. `Error::Entropy` when the source
    /// gives nothing.
    pub(crate) fn new(
        mut entropy: Box<dyn Entropy + Send>,
        entries: MlsEntries,
    ) -> Result<Self, Error> {
        // The first draw shows a dead source before anything is built on it.
        let mut probe = [0u8; 32];
        entropy.fill(&mut probe)?;
        let rust_crypto = crypto::rust_crypto()?;
        #[cfg(not(feature = "vectors"))]
        let crypto = rust_crypto;
        #[cfg(feature = "vectors")]
        let crypto = Crypto::new(rust_crypto, probe);
        let storage = MemoryStorage::default();
        *storage
            .values
            .write()
            .unwrap_or_else(PoisonError::into_inner) = entries;
        Ok(Self {
            crypto,
            rand: Rand(Mutex::new(entropy)),
            storage,
        })
    }

    /// A provider for an owner that draws no randomness: an observer. Whatever asks it for some fails.
    pub(crate) fn without_entropy(entries: MlsEntries) -> Result<Self, Error> {
        struct Dry;
        impl Entropy for Dry {
            fn fill(&mut self, _: &mut [u8]) -> Result<(), Error> {
                Err(Error::Entropy)
            }
        }
        let rust_crypto = crypto::rust_crypto()?;
        #[cfg(not(feature = "vectors"))]
        let crypto = rust_crypto;
        #[cfg(feature = "vectors")]
        let crypto = Crypto::new(rust_crypto, [0; 32]);
        let storage = MemoryStorage::default();
        *storage
            .values
            .write()
            .unwrap_or_else(PoisonError::into_inner) = entries;
        Ok(Self {
            crypto,
            rand: Rand(Mutex::new(Box::new(Dry))),
            storage,
        })
    }

    /// Random bytes for the owner's own needs, from the same source.
    pub(crate) fn fill(&self, out: &mut [u8]) -> Result<(), Error> {
        self.rand.fill(out)
    }

    /// Runs `seal` with the owner's entropy.
    pub(crate) fn with_entropy<T>(&self, seal: impl FnOnce(&mut dyn Entropy) -> T) -> T {
        let mut entropy = self.rand.0.lock().unwrap_or_else(PoisonError::into_inner);
        seal(entropy.as_mut())
    }

    /// A copy of every entry OpenMLS holds now.
    pub(crate) fn entries(&self) -> MlsEntries {
        self.storage
            .values
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// Replaces what OpenMLS holds by `entries`.
    pub(crate) fn restore(&self, entries: MlsEntries) {
        *self
            .storage
            .values
            .write()
            .unwrap_or_else(PoisonError::into_inner) = entries;
    }

    /// What changed against `stored`: the entries to write and the keys to remove, both ascending by key.
    pub(crate) fn changes(&self, stored: &MlsEntries) -> MlsChanges {
        let now = self
            .storage
            .values
            .read()
            .unwrap_or_else(PoisonError::into_inner);
        let mut put: Vec<(Vec<u8>, Vec<u8>)> = now
            .iter()
            .filter(|(key, value)| stored.get(*key) != Some(*value))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect();
        let mut delete: Vec<Vec<u8>> = stored
            .keys()
            .filter(|key| !now.contains_key(*key))
            .cloned()
            .collect();
        put.sort_unstable();
        delete.sort_unstable();
        (put, delete)
    }
}

/// A device's signature key as OpenMLS signs with it.
pub(crate) struct DeviceSigner<'a>(pub(crate) &'a SigningKey);

impl Signer for DeviceSigner<'_> {
    fn sign(&self, payload: &[u8]) -> Result<Vec<u8>, SignerError> {
        use openmls_traits::crypto::OpenMlsCrypto as _;
        crypto::rust_crypto()
            .map_err(|_| SignerError::SigningError)?
            .sign(
                CIPHERSUITE.signature_algorithm(),
                payload,
                self.0.seed().expose(),
            )
            .map_err(SignerError::CryptoError)
    }

    fn signature_scheme(&self) -> SignatureScheme {
        SignatureScheme::ED25519
    }
}

/// The credential of the profile: a basic credential whose identity is the signature key.
pub(crate) fn credential(device: &DeviceId) -> CredentialWithKey {
    CredentialWithKey {
        credential: BasicCredential::new(device.as_bytes().to_vec()).into(),
        signature_key: device.as_bytes().to_vec().into(),
    }
}

fn damaged() -> Error {
    Error::Storage("an MLS entry does not decode".into())
}

fn decodes<T: serde::de::DeserializeOwned>(value: &[u8]) -> Result<T, Error> {
    serde_json::from_slice(value).map_err(|_| damaged())
}

/// The kinds of entry OpenMLS's storage holds, by the label its keys start with. `true`: the storage panics
/// on a value of this kind that does not decode, so it is decoded here first.
const LABELS: &[(&[u8], Kind)] = &[
    (b"KeyPackage", Kind::Checked),
    (b"Psk", Kind::Refused),
    (b"EncryptionKeyPair", Kind::Checked),
    (b"SignatureKeyPair", Kind::Refused),
    (b"EpochKeyPairs", Kind::EpochKeyPairs),
    (b"Tree", Kind::Tree),
    (b"GroupContext", Kind::Context),
    (b"InterimTranscriptHash", Kind::Interim),
    (b"ConfirmationTag", Kind::Tag),
    (b"MlsGroupJoinConfig", Kind::Checked),
    (b"GroupState", Kind::Checked),
    (b"OwnLeafNodeIndex", Kind::Checked),
    (b"EpochSecrets", Kind::Checked),
    (b"ResumptionPsk", Kind::Checked),
    (b"MessageSecrets", Kind::Checked),
    (b"QueuedProposal", Kind::Refused),
    (b"ProposalQueueRefs", Kind::EmptyList),
    (b"OwnLeafNodes", Kind::LeafNodes),
];

/// The labels of the entries that make a group's public state, which is what an observer of the group holds.
const PUBLIC_LABELS: [&[u8]; 4] = [
    b"Tree",
    b"GroupContext",
    b"InterimTranscriptHash",
    b"ConfirmationTag",
];

/// The version OpenMLS's storage ends its keys with.
const STORAGE_VERSION: u16 = 1;

/// The entries of `group`'s public state among `entries`: its tree, group context, interim transcript hash and
/// confirmation tag, under the keys OpenMLS's memory storage gives them (label, the group id as JSON, the
/// version). A member's storage holds them beside its secrets; an observer started from them stands where the
/// member stands, with what the member verified. `Error::Storage` when one is missing.
pub(crate) fn public_entries(
    entries: &MlsEntries,
    group: &openmls::prelude::GroupId,
) -> Result<MlsEntries, Error> {
    let id = serde_json::to_vec(group).map_err(|_| damaged())?;
    PUBLIC_LABELS
        .iter()
        .map(|label| {
            let key = [label, id.as_slice(), &STORAGE_VERSION.to_be_bytes()].concat();
            let value = entries.get(&key).ok_or_else(damaged)?.clone();
            Ok((key, value))
        })
        .collect()
}

/// The serialised form of OpenMLS's own key pair of a leaf or path node, which it does not export: the same
/// fields with the same types, so that a value that decodes here decodes there.
#[derive(serde::Deserialize)]
struct KeyPairShape {
    #[serde(rename = "public_key")]
    _public_key: openmls::treesync::EncryptionKey,
    #[serde(rename = "private_key")]
    _private_key: PrivateKeyShape,
}

#[derive(serde::Deserialize)]
struct PrivateKeyShape {
    #[serde(rename = "key")]
    _key: openmls_traits::types::HpkePrivateKey,
}

#[derive(Clone, Copy)]
enum Kind {
    /// OpenMLS itself returns an error for a damaged value.
    Checked,
    /// The profile never stores this kind: a PSK, a stored signature key, a queued proposal.
    Refused,
    EpochKeyPairs,
    Tree,
    Context,
    Interim,
    Tag,
    /// A list that the profile leaves empty: no proposal is ever queued.
    EmptyList,
    LeafNodes,
}

/// Checks entries read from a store before OpenMLS sees them: every key is of a known kind, and every value
/// of a kind that OpenMLS's memory storage would panic on decodes. `Error::Storage` otherwise.
pub(crate) fn validate_entries(entries: &MlsEntries) -> Result<(), Error> {
    for (key, value) in entries {
        let kind = LABELS
            .iter()
            .filter(|(label, _)| key.starts_with(label))
            .max_by_key(|(label, _)| label.len())
            .map(|(_, kind)| *kind)
            .ok_or_else(damaged)?;
        match kind {
            Kind::Checked => {
                decodes::<serde_json::Value>(value)?;
            }
            Kind::Refused => return Err(damaged()),
            Kind::EpochKeyPairs => {
                decodes::<Vec<KeyPairShape>>(value)?;
            }
            Kind::Tree => {
                decodes::<openmls::treesync::TreeSync>(value)?;
            }
            Kind::Context => {
                decodes::<GroupContext>(value)?;
            }
            Kind::Interim => {
                decodes::<openmls::group::InterimTranscriptHash>(value)?;
            }
            Kind::Tag => {
                decodes::<openmls::prelude::ConfirmationTag>(value)?;
            }
            Kind::EmptyList => {
                if !decodes::<Vec<Vec<u8>>>(value)?.is_empty() {
                    return Err(damaged());
                }
            }
            Kind::LeafNodes => {
                for leaf in decodes::<Vec<Vec<u8>>>(value)? {
                    decodes::<LeafNode>(&leaf)?;
                }
            }
        }
    }
    Ok(())
}

/// The reproducible crypto provider of the vector generator. Not part of a shipped build.
#[cfg(feature = "vectors")]
pub(crate) mod deterministic {
    use crate::crypto::{self, Secret, CIPHERSUITE};
    use openmls_rust_crypto::RustCrypto;
    use openmls_traits::crypto::OpenMlsCrypto;
    use openmls_traits::types::{
        AeadType, Ciphersuite, CryptoError, ExporterSecret, HashType, HpkeCiphertext, HpkeConfig,
        HpkeKeyPair, KemOutput, SignatureScheme,
    };
    use tls_codec::SecretVLBytes;

    /// RustCrypto for everything but the two HPKE operations that draw an ephemeral key: those derive it from
    /// the seed and the call's own inputs. The derivation keeps no state, because OpenMLS seals to the nodes of
    /// a path on several threads in no fixed order.
    pub(crate) struct Crypto {
        inner: &'static RustCrypto,
        seed: [u8; 32],
    }

    impl Crypto {
        pub(crate) fn new(inner: &'static RustCrypto, seed: [u8; 32]) -> Self {
            Self { inner, seed }
        }

        /// The ephemeral key material of one call: SHA-256 over the seed and the inputs, each behind its length.
        fn ikm(&self, parts: &[&[u8]]) -> Result<Secret<32>, CryptoError> {
            let mut input = self.seed.to_vec();
            for part in parts {
                input.extend_from_slice(&(part.len() as u64).to_be_bytes());
                input.extend_from_slice(part);
            }
            let digest = self.inner.hash(HashType::Sha2_256, &input)?;
            Secret::from_slice(&digest).map_err(|_| CryptoError::CryptoLibraryError)
        }
    }

    fn suite_only(config: HpkeConfig) -> Result<(), CryptoError> {
        let ours = CIPHERSUITE.hpke_config();
        if config.0 == ours.0 && config.1 == ours.1 && config.2 == ours.2 {
            Ok(())
        } else {
            Err(CryptoError::UnsupportedCiphersuite)
        }
    }

    impl OpenMlsCrypto for Crypto {
        fn supports(&self, ciphersuite: Ciphersuite) -> Result<(), CryptoError> {
            self.inner.supports(ciphersuite)
        }

        fn supported_ciphersuites(&self) -> Vec<Ciphersuite> {
            self.inner.supported_ciphersuites()
        }

        fn hkdf_extract(
            &self,
            hash_type: HashType,
            salt: &[u8],
            ikm: &[u8],
        ) -> Result<SecretVLBytes, CryptoError> {
            self.inner.hkdf_extract(hash_type, salt, ikm)
        }

        fn hmac(
            &self,
            hash_type: HashType,
            key: &[u8],
            message: &[u8],
        ) -> Result<SecretVLBytes, CryptoError> {
            self.inner.hmac(hash_type, key, message)
        }

        fn hkdf_expand(
            &self,
            hash_type: HashType,
            prk: &[u8],
            info: &[u8],
            okm_len: usize,
        ) -> Result<SecretVLBytes, CryptoError> {
            self.inner.hkdf_expand(hash_type, prk, info, okm_len)
        }

        fn hash(&self, hash_type: HashType, data: &[u8]) -> Result<Vec<u8>, CryptoError> {
            self.inner.hash(hash_type, data)
        }

        fn aead_encrypt(
            &self,
            alg: AeadType,
            key: &[u8],
            data: &[u8],
            nonce: &[u8],
            aad: &[u8],
        ) -> Result<Vec<u8>, CryptoError> {
            self.inner.aead_encrypt(alg, key, data, nonce, aad)
        }

        fn aead_decrypt(
            &self,
            alg: AeadType,
            key: &[u8],
            ct_tag: &[u8],
            nonce: &[u8],
            aad: &[u8],
        ) -> Result<Vec<u8>, CryptoError> {
            self.inner.aead_decrypt(alg, key, ct_tag, nonce, aad)
        }

        fn signature_key_gen(&self, _: SignatureScheme) -> Result<(Vec<u8>, Vec<u8>), CryptoError> {
            // A device's key comes from its entropy, never from the provider's hidden generator.
            Err(CryptoError::CryptoLibraryError)
        }

        fn verify_signature(
            &self,
            alg: SignatureScheme,
            data: &[u8],
            pk: &[u8],
            signature: &[u8],
        ) -> Result<(), CryptoError> {
            self.inner.verify_signature(alg, data, pk, signature)
        }

        fn sign(
            &self,
            alg: SignatureScheme,
            data: &[u8],
            key: &[u8],
        ) -> Result<Vec<u8>, CryptoError> {
            self.inner.sign(alg, data, key)
        }

        fn hpke_seal(
            &self,
            config: HpkeConfig,
            pk_r: &[u8],
            info: &[u8],
            aad: &[u8],
            ptxt: &[u8],
        ) -> Result<HpkeCiphertext, CryptoError> {
            suite_only(config)?;
            let ikm = self.ikm(&[b"seal", pk_r, info, aad, ptxt])?;
            let sealed = crypto::hpke_seal_with(&ikm, pk_r, info, aad, ptxt)
                .map_err(|_| CryptoError::HpkeEncryptionError)?;
            Ok(HpkeCiphertext {
                kem_output: sealed.kem_output.into(),
                ciphertext: sealed.ciphertext.into(),
            })
        }

        fn hpke_open(
            &self,
            config: HpkeConfig,
            input: &HpkeCiphertext,
            sk_r: &[u8],
            info: &[u8],
            aad: &[u8],
        ) -> Result<Vec<u8>, CryptoError> {
            self.inner.hpke_open(config, input, sk_r, info, aad)
        }

        fn hpke_setup_sender_and_export(
            &self,
            config: HpkeConfig,
            pk_r: &[u8],
            info: &[u8],
            exporter_context: &[u8],
            exporter_length: usize,
        ) -> Result<(KemOutput, ExporterSecret), CryptoError> {
            suite_only(config)?;
            let length = (exporter_length as u64).to_be_bytes();
            let ikm = self.ikm(&[b"export", pk_r, info, exporter_context, &length])?;
            let (kem_output, exported) =
                crypto::hpke_export_with(&ikm, pk_r, info, exporter_context, exporter_length)
                    .map_err(|_| CryptoError::SenderSetupError)?;
            Ok((kem_output, exported.to_vec().into()))
        }

        fn hpke_setup_receiver_and_export(
            &self,
            config: HpkeConfig,
            enc: &[u8],
            sk_r: &[u8],
            info: &[u8],
            exporter_context: &[u8],
            exporter_length: usize,
        ) -> Result<ExporterSecret, CryptoError> {
            self.inner.hpke_setup_receiver_and_export(
                config,
                enc,
                sk_r,
                info,
                exporter_context,
                exporter_length,
            )
        }

        fn derive_hpke_keypair(
            &self,
            config: HpkeConfig,
            ikm: &[u8],
        ) -> Result<HpkeKeyPair, CryptoError> {
            self.inner.derive_hpke_keypair(config, ikm)
        }
    }
}
