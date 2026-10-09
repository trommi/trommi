//! A member's operations on one group, as section 3 maps them to OpenMLS: create, commit, join, export. Each
//! works on the provider's storage only; the device stores what changed and decides what is sent.

use crate::codec;
use crate::crypto::{Secret, SigningKey};
use crate::error::Error;
use crate::ids::{DeviceId, GroupId};
use crate::mls::observer::parse_group_info;
use crate::mls::profile::{self, CommitNote, GroupKind, CONTENT_KEY_LABEL, CONTENT_KEY_LEN};
use crate::mls::provider::{self, DeviceSigner, Provider};
use crate::mls::rules;
use openmls::group::{JoinBuilder, ProcessedWelcome};
use openmls::group::{MlsGroup, StagedCommit, StagedWelcome};
use openmls::prelude::{
    KeyPackage, LeafNodeIndex, LeafNodeParameters, MlsMessageBodyIn, MlsMessageIn, MlsMessageOut,
};
use openmls_traits::OpenMlsProvider as _;
use tls_codec::{Deserialize as _, Serialize as _};
use zeroize::Zeroizing;

/// What a Commit leaves to send, and the key of the epoch it leads to.
pub(crate) struct Built {
    /// The epoch the Commit builds on.
    pub(crate) epoch: u64,
    pub(crate) commit: Vec<u8>,
    pub(crate) group_info: Vec<u8>,
    pub(crate) welcome: Option<Vec<u8>>,
    /// `content_key` of the next epoch.
    pub(crate) next_key: Secret<32>,
}

/// What a Commit changes.
#[derive(Default)]
pub(crate) struct Change<'a> {
    pub(crate) adds: Vec<KeyPackage>,
    pub(crate) removes: &'a [DeviceId],
    pub(crate) context: Option<&'a GroupKind>,
}

fn mls_fault<E>(_: E) -> Error {
    Error::Storage("the MLS storage failed".into())
}

fn encoded(message: &MlsMessageOut) -> Result<Vec<u8>, Error> {
    message
        .tls_serialize_detached()
        .map_err(|_| Error::Internal("message encoding"))
}

fn key_from(exported: Vec<u8>) -> Result<Secret<32>, Error> {
    let exported = Zeroizing::new(exported);
    Secret::from_slice(&exported).map_err(|_| Error::Internal("exported key length"))
}

/// The group `group` from the provider's storage; `not-found` when the device is no leaf of it.
pub(crate) fn load(provider: &Provider, group: &GroupId) -> Result<MlsGroup, Error> {
    let id = openmls::prelude::GroupId::from_slice(group.as_bytes());
    MlsGroup::load(provider.storage(), &id)
        .map_err(mls_fault)?
        .ok_or(Error::NotFound)
}

/// `content_key` of the group's current epoch (section 6).
pub(crate) fn content_key(provider: &Provider, group: &MlsGroup) -> Result<Secret<32>, Error> {
    group
        .export_secret(provider.crypto(), CONTENT_KEY_LABEL, &[], CONTENT_KEY_LEN)
        .map_err(|_| Error::Internal("exporter"))
        .and_then(key_from)
}

fn staged_key(provider: &Provider, staged: &StagedCommit) -> Result<Secret<32>, Error> {
    staged
        .export_secret(provider.crypto(), CONTENT_KEY_LABEL, &[], CONTENT_KEY_LEN)
        .map_err(|_| Error::Internal("exporter"))
        .and_then(key_from)
}

/// The GroupInfo of the group's current epoch, with the tree, signed by this device.
pub(crate) fn group_info(
    provider: &Provider,
    key: &SigningKey,
    group: &MlsGroup,
) -> Result<Vec<u8>, Error> {
    let info = group
        .export_group_info(provider.crypto(), &DeviceSigner(key), true)
        .map_err(|_| Error::Internal("group info"))?;
    encoded(&info)
}

/// Creates a group of `kind` with this device as its only leaf.
pub(crate) fn create(
    provider: &Provider,
    key: &SigningKey,
    group: &GroupId,
    kind: &GroupKind,
    now_ms: u64,
) -> Result<MlsGroup, Error> {
    if load(provider, group).is_ok() {
        return Err(Error::RoomExists);
    }
    let device = DeviceId::new(key.public());
    MlsGroup::new_with_group_id(
        provider,
        &DeviceSigner(key),
        &profile::create_config(kind, now_ms)?,
        openmls::prelude::GroupId::from_slice(group.as_bytes()),
        provider::credential(&device),
    )
    .map_err(|_| Error::Entropy)
}

/// Builds a Commit with `note` as its authenticated data and leaves it pending in the group. A Commit that only
/// adds has no path; every other has one.
pub(crate) fn commit(
    provider: &Provider,
    key: &SigningKey,
    group: &mut MlsGroup,
    note: &CommitNote,
    change: Change<'_>,
) -> Result<Built, Error> {
    if group.pending_commit().is_some() || !group.is_active() {
        return Err(Error::Busy);
    }
    let leaves = rules::leaves_of(group.members())?;
    let mut indexes: Vec<LeafNodeIndex> = Vec::new();
    for gone in change.removes {
        let (index, _) = leaves
            .iter()
            .find(|(_, device)| device == gone)
            .ok_or(Error::NotMember)?;
        indexes.push(*index);
    }
    let epoch = group.epoch().as_u64();
    group.set_aad(codec::encode(note)?);
    let mut builder = group
        .commit_builder()
        .consume_proposal_store(false)
        .propose_adds(change.adds)
        .propose_removals(indexes);
    if let Some(kind) = change.context {
        builder = builder
            .propose_group_context_extensions(profile::context_extensions(kind)?)
            .map_err(|_| Error::BadCommit)?;
    }
    let bundle = builder
        .load_psks(provider.storage())
        .map_err(|_| Error::BadCommit)?
        .create_group_info(true)
        .use_ratchet_tree_extension(true)
        .build(
            provider.rand(),
            provider.crypto(),
            &DeviceSigner(key),
            |_| true,
        )
        .map_err(|_| Error::BadCommit)?
        .stage_commit(provider)
        .map_err(mls_fault)?;
    let next_key = staged_key(
        provider,
        group.pending_commit().ok_or(Error::Internal("pending"))?,
    )?;
    let (commit, welcome, info) = bundle.into_messages();
    Ok(Built {
        epoch,
        commit: encoded(&commit)?,
        group_info: encoded(&info.ok_or(Error::Internal("group info"))?)?,
        welcome: welcome.as_ref().map(encoded).transpose()?,
        next_key,
    })
}

/// Joins a group from outside (3.4): the group the provider's storage then holds stands in the new epoch.
/// OpenMLS writes it over any group of that id, so the device runs this on a copy of its state.
pub(crate) fn external_commit(
    provider: &Provider,
    key: &SigningKey,
    group_info: &[u8],
    note: &CommitNote,
) -> Result<(MlsGroup, Built), Error> {
    let verifiable = parse_group_info(group_info)?;
    let device = DeviceId::new(key.public());
    let (group, bundle) = MlsGroup::external_commit_builder()
        .with_config(profile::join_config())
        .with_aad(codec::encode(note)?)
        .skip_lifetime_validation()
        .build_group(provider, verifiable, provider::credential(&device))
        .map_err(|_| Error::BadGroup)?
        .leaf_node_parameters(
            LeafNodeParameters::builder()
                .with_capabilities(profile::capabilities())
                .build(),
        )
        .load_psks(provider.storage())
        .map_err(|_| Error::BadCommit)?
        .create_group_info(true)
        .use_ratchet_tree_extension(true)
        .build(
            provider.rand(),
            provider.crypto(),
            &DeviceSigner(key),
            |_| true,
        )
        .map_err(|_| Error::BadCommit)?
        .finalize(provider)
        .map_err(mls_fault)?;
    let next_key = content_key(provider, &group)?;
    let epoch = group
        .epoch()
        .as_u64()
        .checked_sub(1)
        .ok_or(Error::Internal("epoch"))?;
    let (commit, _, info) = bundle.into_messages();
    let built = Built {
        epoch,
        commit: encoded(&commit)?,
        group_info: encoded(&info.ok_or(Error::Internal("group info"))?)?,
        welcome: None,
        next_key,
    };
    Ok((group, built))
}

/// Opens a Welcome without joining yet, so that the group can be checked first. The single-use KeyPackage it
/// was for is used up whether or not this succeeds (3.7); `bad-group` when it does not open or verify, `replay`
/// when the device holds the group already.
pub(crate) fn stage_welcome(provider: &Provider, welcome: &[u8]) -> Result<StagedWelcome, Error> {
    let welcome = match MlsMessageIn::tls_deserialize_exact(welcome).map(MlsMessageIn::extract) {
        Ok(MlsMessageBodyIn::Welcome(welcome)) => welcome,
        _ => return Err(Error::BadFormat),
    };
    let processed = ProcessedWelcome::new_from_welcome(provider, &profile::join_config(), welcome)
        .map_err(|_| Error::BadGroup)?;
    // A Welcome for a group the device holds is one met again (`replay`), not a group that does not verify.
    let held = processed.unverified_group_info().group_context().group_id();
    if MlsGroup::load(provider.storage(), held)
        .map_err(mls_fault)?
        .is_some()
    {
        return Err(Error::Replay);
    }
    JoinBuilder::new(provider, processed)
        .skip_lifetime_validation()
        .build()
        .map_err(|_| Error::BadGroup)
}

/// The references of the KeyPackages a Welcome is for, without opening it.
pub(crate) fn welcome_recipients(welcome: &[u8]) -> Result<Vec<Vec<u8>>, Error> {
    match MlsMessageIn::tls_deserialize_exact(welcome).map(MlsMessageIn::extract) {
        Ok(MlsMessageBodyIn::Welcome(welcome)) => Ok(welcome
            .secrets()
            .iter()
            .map(|secrets| secrets.new_member().as_slice().to_vec())
            .collect()),
        _ => Err(Error::BadFormat),
    }
}
