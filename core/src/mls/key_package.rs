//! KeyPackages (section 3, 4.5, 14.2): making a device's own, and checking another device's before it is added
//! or stored. A KeyPackage is the profile's when its signature verifies, its credential is a basic credential
//! holding the leaf's signature key, its capabilities are exactly the profile's, its lifetime is no longer than
//! the profile's, and it carries no extension but `last_resort`.

use crate::crypto::{self, SigningKey, CIPHERSUITE};
use crate::error::Error;
use crate::ids::{DeviceId, Hash32};
use crate::mls::profile::{self, MAX_KEY_PACKAGE_LEN};
use crate::mls::provider::{self, DeviceSigner, Provider};
use openmls::prelude::{
    BasicCredential, CredentialType, Extension, KeyPackage, LeafNode, MlsMessageBodyIn,
    ProtocolVersion,
};
use openmls_traits::OpenMlsProvider as _;
use tls_codec::{Deserialize as _, Serialize as _};

/// What a verified KeyPackage says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyPackageInfo {
    /// The device it speaks for.
    pub device: DeviceId,
    /// Whether it is marked `last_resort`: handed out when no single-use one is left, and more than once.
    pub last_resort: bool,
    /// Its `KeyPackageRef`, which a Welcome names its recipient by.
    pub reference: Hash32,
    /// The end of its lifetime, in milliseconds.
    pub not_after_ms: u64,
}

/// The device a leaf belongs to, if the leaf is the profile's: a basic credential whose identity is the leaf's
/// signature key, and the profile's capabilities.
pub(crate) fn leaf_device(leaf: &LeafNode) -> Option<DeviceId> {
    let device = DeviceId::from_slice(leaf.signature_key().as_slice()).ok()?;
    let credential = leaf.credential();
    if credential.credential_type() != CredentialType::Basic {
        return None;
    }
    let basic = BasicCredential::try_from(credential.clone()).ok()?;
    let fits = basic.identity() == device.as_bytes()
        && *leaf.capabilities() == profile::capabilities()
        && leaf.extensions().iter().next().is_none();
    fits.then_some(device)
}

/// What a KeyPackage that verified says, if it is the profile's.
pub(crate) fn info(key_package: &KeyPackage) -> Result<KeyPackageInfo, Error> {
    let device = leaf_device(key_package.leaf_node()).ok_or(Error::BadKeyPackage)?;
    let only_last_resort = key_package
        .extensions()
        .iter()
        .all(|extension| matches!(extension, Extension::LastResort(_)));
    // Section 3: a lifetime spans at most the profile's, from one hour ago to ten years ahead. OpenMLS
    // checks that it holds the present time, not how long it is.
    let lifetime = key_package.life_time();
    let span_ms = lifetime
        .not_after()
        .saturating_sub(lifetime.not_before())
        .saturating_mul(1000);
    let longest = profile::LIFETIME_MS.saturating_add(profile::LIFETIME_MARGIN_MS);
    if key_package.ciphersuite() != CIPHERSUITE || !only_last_resort || span_ms > longest {
        return Err(Error::BadKeyPackage);
    }
    let reference = key_package
        .hash_ref(crypto::rust_crypto()?)
        .map_err(|_| Error::Internal("key package reference"))?;
    Ok(KeyPackageInfo {
        device,
        last_resort: key_package.last_resort(),
        reference: Hash32::from_slice(reference.as_slice())
            .map_err(|_| Error::Internal("key package reference"))?,
        not_after_ms: key_package.life_time().not_after().saturating_mul(1000),
    })
}

/// Parses and verifies a KeyPackage from outside; `bad-key-package` unless it is the profile's. OpenMLS checks
/// its signature and its lifetime against the clock.
pub(crate) fn validated(bytes: &[u8]) -> Result<(KeyPackage, KeyPackageInfo), Error> {
    if bytes.len() > MAX_KEY_PACKAGE_LEN {
        return Err(Error::BadKeyPackage);
    }
    let message = openmls::prelude::MlsMessageIn::tls_deserialize_exact(bytes)
        .map_err(|_| Error::BadKeyPackage)?;
    let MlsMessageBodyIn::KeyPackage(key_package) = message.extract() else {
        return Err(Error::BadKeyPackage);
    };
    let key_package = key_package
        .validate(crypto::rust_crypto()?, ProtocolVersion::Mls10)
        .map_err(|_| Error::BadKeyPackage)?;
    let info = info(&key_package)?;
    Ok((key_package, info))
}

/// The `KeyPackageRef` of a KeyPackage as it travels, without verifying it. A device finds the private part of
/// one of its own by it, also when a hub refused that KeyPackage, for its lifetime or anything else.
pub(crate) fn reference(bytes: &[u8]) -> Result<Hash32, Error> {
    if bytes.len() > MAX_KEY_PACKAGE_LEN {
        return Err(Error::BadKeyPackage);
    }
    let message = openmls::prelude::MlsMessageIn::tls_deserialize_exact(bytes)
        .map_err(|_| Error::BadKeyPackage)?;
    let MlsMessageBodyIn::KeyPackage(key_package) = message.extract() else {
        return Err(Error::BadKeyPackage);
    };
    let encoded = key_package
        .tls_serialize_detached()
        .map_err(|_| Error::Internal("key package encoding"))?;
    crypto::ref_hash("MLS 1.0 KeyPackage Reference", &encoded)
}

/// Verifies a KeyPackage as the hub does before it stores one (14.2) and as anyone may before using one:
/// `bad-key-package` unless it verifies and is the profile's.
pub fn verify_key_package(bytes: &[u8]) -> Result<KeyPackageInfo, Error> {
    validated(bytes).map(|(_, info)| info)
}

/// Verifies a KeyPackage before its device is added (4.5): as [`verify_key_package`], and it must be
/// `device`'s. A hub cannot substitute a device.
pub fn verify_key_package_of(bytes: &[u8], device: &DeviceId) -> Result<KeyPackageInfo, Error> {
    let info = verify_key_package(bytes)?;
    if info.device == *device {
        Ok(info)
    } else {
        Err(Error::BadKeyPackage)
    }
}

/// Makes a KeyPackage of `key`'s device with the profile's capabilities and a lifetime from `now_ms`, and leaves
/// its private part in the provider's storage. Returns it as it travels, and what it says.
pub(crate) fn make(
    provider: &Provider,
    key: &SigningKey,
    now_ms: u64,
    last_resort: bool,
) -> Result<(Vec<u8>, KeyPackageInfo), Error> {
    let device = DeviceId::new(key.public());
    let mut builder = KeyPackage::builder()
        .leaf_node_capabilities(profile::capabilities())
        .key_package_lifetime(profile::lifetime(now_ms));
    if last_resort {
        builder = builder.mark_as_last_resort();
    }
    let bundle = builder
        .build(
            CIPHERSUITE,
            provider,
            &DeviceSigner(key),
            provider::credential(&device),
        )
        .map_err(|_| Error::Entropy)?;
    let info = info(bundle.key_package())?;
    let bytes = openmls::prelude::MlsMessageOut::from(bundle.key_package().clone())
        .tls_serialize_detached()
        .map_err(|_| Error::Internal("key package encoding"))?;
    Ok((bytes, info))
}

/// The device of the KeyPackage whose private part the provider's storage holds under this reference: the
/// signature key of its leaf. None when the storage holds none; `Error::Storage` when it does not load.
pub(crate) fn stored_device(
    provider: &Provider,
    reference: &Hash32,
) -> Result<Option<DeviceId>, Error> {
    use openmls_traits::storage::StorageProvider as _;
    let damaged = || Error::Storage("a key package does not load".into());
    let reference: openmls::prelude::KeyPackageRef =
        openmls::prelude::KeyPackageRef::tls_deserialize_exact(
            [&[32u8][..], reference.as_bytes()].concat(),
        )
        .map_err(|_| damaged())?;
    let bundle: Option<openmls::prelude::KeyPackageBundle> = provider
        .storage()
        .key_package(&reference)
        .map_err(|_| damaged())?;
    bundle
        .map(|bundle| {
            DeviceId::from_slice(bundle.key_package().leaf_node().signature_key().as_slice())
                .map_err(|_| damaged())
        })
        .transpose()
}

/// Removes the private part of the KeyPackage with this reference from the provider's storage.
pub(crate) fn forget(provider: &Provider, reference: &Hash32) -> Result<(), Error> {
    use openmls_traits::storage::StorageProvider as _;
    let reference: openmls::prelude::KeyPackageRef =
        openmls::prelude::KeyPackageRef::tls_deserialize_exact(
            [&[32u8][..], reference.as_bytes()].concat(),
        )
        .map_err(|_| Error::Internal("key package reference"))?;
    provider
        .storage()
        .delete_key_package(&reference)
        .map_err(|_| Error::Storage("the MLS storage failed".into()))
}
