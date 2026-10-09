//! A member that obeys MLS and not Trommi: OpenMLS used directly, with a signature key of its own. A device
//! builds only what the rules allow; this builds what a faulty or hostile member could, so that a test sees what
//! the devices and the observers refuse: a leaf that is not the profile's, a message or a note of another
//! version, keys nobody may hand over, a GroupInfo that names another signer.

use crate::hub::Hub;
use openmls::group::{MlsGroup, MlsGroupCreateConfig, MlsGroupJoinConfig, StagedWelcome};
use openmls::prelude::{
    BasicCredential, Capabilities, Ciphersuite, CredentialType, CredentialWithKey, Extension,
    ExtensionType, Extensions, KeyPackage, LeafNodeParameters, MlsMessageBodyIn, MlsMessageIn,
    MlsMessageOut, ProcessedMessageContent, ProtocolVersion, RequiredCapabilitiesExtension,
    SenderRatchetConfiguration, UnknownExtension, PURE_PLAINTEXT_WIRE_FORMAT_POLICY,
};
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;
use openmls_traits::types::SignatureScheme;
use openmls_traits::OpenMlsProvider as _;
use tls_codec::{Deserialize as _, Serialize as _};
use trommi_core::codec;
use trommi_core::crypto::{SigningKey, SystemEntropy};
use trommi_core::device::Accepted;
use trommi_core::ids::{DeviceId, GroupId};
use trommi_core::mls::profile::{TrommiRoom, TrommiSession, EXTENSION_ROOM, EXTENSION_SESSION};
use trommi_core::store::{OutboxEntry, OutboxKind};
use trommi_core::Error;

const SUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_CHACHA20POLY1305_SHA256_Ed25519;

/// What a Commit of the forger leaves to post.
pub struct Forged {
    /// The epoch it builds on.
    pub epoch: u64,
    pub commit: Vec<u8>,
    pub group_info: Vec<u8>,
    pub welcome: Option<Vec<u8>>,
}

/// A member with a key of its own.
pub struct Forger {
    provider: OpenMlsRustCrypto,
    signer: SignatureKeyPair,
    /// The same key as the core holds one, for a test that signs something by hand.
    pub key: SigningKey,
    /// The identity its credential states: the signature key, as the profile says, unless a test changes it.
    pub identity: Vec<u8>,
    /// An extension type its leaves state beside the profile's, if a test sets one.
    pub extra_extension: Option<u16>,
    /// How many seconds its KeyPackages are valid for from now, if a test sets it; else OpenMLS's own span.
    pub lifetime_s: Option<u64>,
}

impl Default for Forger {
    fn default() -> Self {
        Self::new()
    }
}

impl Forger {
    /// A forger whose leaves are the profile's.
    pub fn new() -> Self {
        Self::with_key(SigningKey::generate(&mut SystemEntropy).expect("a key pair"))
    }

    /// A forger that holds this signature key.
    pub fn with_key(key: SigningKey) -> Self {
        let signer = SignatureKeyPair::from_raw(
            SignatureScheme::ED25519,
            key.seed().expose().to_vec(),
            key.public().to_vec(),
        );
        Self {
            provider: OpenMlsRustCrypto::default(),
            identity: signer.public().to_vec(),
            signer,
            key,
            extra_extension: None,
            lifetime_s: None,
        }
    }

    /// Its device id: the signature key.
    pub fn id(&self) -> DeviceId {
        DeviceId::from_slice(self.signer.public()).expect("32 bytes")
    }

    fn credential(&self) -> CredentialWithKey {
        CredentialWithKey {
            credential: BasicCredential::new(self.identity.clone()).into(),
            signature_key: self.signer.public().to_vec().into(),
        }
    }

    fn capabilities(&self) -> Capabilities {
        let mut extensions = vec![
            ExtensionType::Unknown(EXTENSION_ROOM),
            ExtensionType::Unknown(EXTENSION_SESSION),
            ExtensionType::LastResort,
        ];
        extensions.extend(self.extra_extension.map(ExtensionType::Unknown));
        Capabilities::new(
            Some(&[ProtocolVersion::Mls10]),
            Some(&[SUITE]),
            Some(&extensions),
            None,
            Some(&[CredentialType::Basic]),
        )
    }

    fn join_config() -> MlsGroupJoinConfig {
        MlsGroupJoinConfig::builder()
            .wire_format_policy(PURE_PLAINTEXT_WIRE_FORMAT_POLICY)
            .use_ratchet_tree_extension(true)
            .sender_ratchet_configuration(SenderRatchetConfiguration::new(50, 10_000))
            .max_past_epochs(0)
            .build()
    }

    /// One KeyPackage of it, as it travels.
    pub fn key_package(&self) -> Vec<u8> {
        let mut builder = KeyPackage::builder().leaf_node_capabilities(self.capabilities());
        if let Some(seconds) = self.lifetime_s {
            builder = builder.key_package_lifetime(openmls::prelude::Lifetime::new(seconds));
        }
        let bundle = builder
            .build(SUITE, &self.provider, &self.signer, self.credential())
            .expect("a key package");
        MlsMessageOut::from(bundle.key_package().clone())
            .tls_serialize_detached()
            .expect("it encodes")
    }

    /// Founds a room group with itself as the only leaf.
    pub fn found_room(&self, group: &GroupId, room: &TrommiRoom) -> MlsGroup {
        let content = codec::encode(room).expect("the extension encodes");
        self.found(group, EXTENSION_ROOM, content)
    }

    /// Founds a session group with itself as the only leaf.
    pub fn found_session(&self, session: &TrommiSession) -> MlsGroup {
        let content = codec::encode(session).expect("the extension encodes");
        self.found(&session.group_id(), EXTENSION_SESSION, content)
    }

    fn found(&self, group: &GroupId, extension: u16, content: Vec<u8>) -> MlsGroup {
        let required = Extension::RequiredCapabilities(RequiredCapabilitiesExtension::new(
            &[
                ExtensionType::Unknown(EXTENSION_ROOM),
                ExtensionType::Unknown(EXTENSION_SESSION),
            ],
            &[],
            &[CredentialType::Basic],
        ));
        let extensions = Extensions::from_vec(vec![
            required,
            Extension::Unknown(extension, UnknownExtension(content)),
        ])
        .expect("the extensions fit");
        let config = MlsGroupCreateConfig::builder()
            .ciphersuite(SUITE)
            .wire_format_policy(PURE_PLAINTEXT_WIRE_FORMAT_POLICY)
            .capabilities(self.capabilities())
            .with_group_context_extensions(extensions)
            .use_ratchet_tree_extension(true)
            .sender_ratchet_configuration(SenderRatchetConfiguration::new(50, 10_000))
            .max_past_epochs(0)
            .build();
        MlsGroup::new_with_group_id(
            &self.provider,
            &self.signer,
            &config,
            openmls::prelude::GroupId::from_slice(group.as_bytes()),
            self.credential(),
        )
        .expect("the group is created")
    }

    /// Joins the group a Welcome is for.
    pub fn join(&self, welcome: &[u8]) -> MlsGroup {
        let Ok(MlsMessageBodyIn::Welcome(welcome)) =
            MlsMessageIn::tls_deserialize_exact(welcome).map(MlsMessageIn::extract)
        else {
            panic!("a Welcome");
        };
        StagedWelcome::new_from_welcome(&self.provider, &Self::join_config(), welcome, None)
            .expect("the Welcome opens")
            .into_group(&self.provider)
            .expect("the group is joined")
    }

    /// Follows a Commit of another member.
    pub fn follow(&self, group: &mut MlsGroup, commit: &[u8]) {
        let message = MlsMessageIn::tls_deserialize_exact(commit)
            .expect("a message")
            .try_into_protocol_message()
            .expect("a protocol message");
        let processed = group
            .process_message(&self.provider, message)
            .expect("the Commit processes");
        let ProcessedMessageContent::StagedCommitMessage(staged) = processed.into_content() else {
            panic!("a Commit");
        };
        group
            .merge_staged_commit(&self.provider, *staged)
            .expect("the Commit merges");
    }

    /// The GroupInfo of the group's epoch, with the tree, signed by it.
    pub fn group_info(&self, group: &MlsGroup) -> Vec<u8> {
        group
            .export_group_info(self.provider.crypto(), &self.signer, true)
            .expect("a GroupInfo")
            .tls_serialize_detached()
            .expect("it encodes")
    }

    /// Commits in `group` with `aad` as the authenticated data, adding the given KeyPackages, and merges it.
    pub fn commit(&self, group: &mut MlsGroup, aad: &[u8], adds: &[Vec<u8>]) -> Forged {
        let adds: Vec<KeyPackage> = adds
            .iter()
            .map(|bytes| {
                let Ok(MlsMessageBodyIn::KeyPackage(package)) =
                    MlsMessageIn::tls_deserialize_exact(bytes).map(MlsMessageIn::extract)
                else {
                    panic!("a KeyPackage");
                };
                package
                    .validate(self.provider.crypto(), ProtocolVersion::Mls10)
                    .expect("it verifies")
            })
            .collect();
        let epoch = group.epoch().as_u64();
        group.set_aad(aad.to_vec());
        let bundle = group
            .commit_builder()
            .consume_proposal_store(false)
            .propose_adds(adds)
            .load_psks(self.provider.storage())
            .expect("no PSK")
            .create_group_info(true)
            .use_ratchet_tree_extension(true)
            .build(
                self.provider.rand(),
                self.provider.crypto(),
                &self.signer,
                |_| true,
            )
            .expect("the Commit is built")
            .stage_commit(&self.provider)
            .expect("the Commit is staged");
        let (commit, welcome, info) = bundle.into_messages();
        group
            .merge_pending_commit(&self.provider)
            .expect("the Commit merges");
        let encoded =
            |message: &MlsMessageOut| message.tls_serialize_detached().expect("it encodes");
        Forged {
            epoch,
            commit: encoded(&commit),
            group_info: encoded(&info.expect("a GroupInfo")),
            welcome: welcome.as_ref().map(encoded),
        }
    }

    /// Joins the group of `group_info` from outside with `aad` as the authenticated data, as the holder of a
    /// signature key alone can: an external Commit that MLS takes.
    pub fn join_from_outside(&self, group_info: &[u8], aad: &[u8]) -> (MlsGroup, Forged) {
        let Ok(MlsMessageBodyIn::GroupInfo(group_info)) =
            MlsMessageIn::tls_deserialize_exact(group_info).map(MlsMessageIn::extract)
        else {
            panic!("a GroupInfo");
        };
        let (group, bundle) = MlsGroup::external_commit_builder()
            .with_config(Self::join_config())
            .with_aad(aad.to_vec())
            .skip_lifetime_validation()
            .build_group(&self.provider, group_info, self.credential())
            .expect("the join is built")
            .leaf_node_parameters(
                LeafNodeParameters::builder()
                    .with_capabilities(self.capabilities())
                    .build(),
            )
            .load_psks(self.provider.storage())
            .expect("no PSK")
            .create_group_info(true)
            .use_ratchet_tree_extension(true)
            .build(
                self.provider.rand(),
                self.provider.crypto(),
                &self.signer,
                |_| true,
            )
            .expect("the Commit is built")
            .finalize(&self.provider)
            .expect("the join is finalised");
        let (commit, _, info) = bundle.into_messages();
        let encoded =
            |message: &MlsMessageOut| message.tls_serialize_detached().expect("it encodes");
        let forged = Forged {
            epoch: group.epoch().as_u64() - 1,
            commit: encoded(&commit),
            group_info: encoded(&info.expect("a GroupInfo")),
            welcome: None,
        };
        (group, forged)
    }

    /// An application message of `group` holding `plaintext`, as it travels.
    pub fn message(&self, group: &mut MlsGroup, plaintext: &[u8]) -> Vec<u8> {
        group
            .create_message(&self.provider, &self.signer, plaintext)
            .expect("the message is made")
            .tls_serialize_detached()
            .expect("it encodes")
    }

    /// Posts an application message to a hub that checks nothing.
    pub fn post_message(&self, hub: &mut Hub, group: &mut MlsGroup, plaintext: &[u8]) -> Accepted {
        let entry = OutboxEntry {
            id: 0,
            kind: OutboxKind::Message,
            group: Some(group_id(group)),
            epoch: group.epoch().as_u64(),
            parts: vec![self.message(group, plaintext)],
        };
        hub.post(&self.id(), &entry).expect("the hub stores it")
    }

    /// Posts the founding of a session group of this forger to a hub that checks nothing: the GroupInfo of
    /// epoch 0 and the first Commit.
    pub fn post_founding(
        &self,
        hub: &mut Hub,
        group: &GroupId,
        group_info_0: &[u8],
        first: &Forged,
    ) -> Result<Accepted, Error> {
        let entry = OutboxEntry {
            id: 0,
            kind: OutboxKind::GroupFounding,
            group: Some(*group),
            epoch: 0,
            parts: vec![
                group_info_0.to_vec(),
                b"no sealed key".to_vec(),
                first.commit.clone(),
                first.group_info.clone(),
                first.welcome.clone().unwrap_or_default(),
                b"no sealed key".to_vec(),
            ],
        };
        hub.post(&self.id(), &entry)
    }

    /// Posts a Commit of this forger to a hub that checks nothing.
    pub fn post_commit(
        &self,
        hub: &mut Hub,
        group: &GroupId,
        forged: &Forged,
    ) -> Result<Accepted, Error> {
        let entry = OutboxEntry {
            id: 0,
            kind: OutboxKind::Commit,
            group: Some(*group),
            epoch: forged.epoch,
            parts: vec![
                forged.commit.clone(),
                forged.group_info.clone(),
                forged.welcome.clone().unwrap_or_default(),
                b"no sealed key".to_vec(),
            ],
        };
        hub.post(&self.id(), &entry)
    }
}

/// The group an OpenMLS group is, as the core names it.
pub fn group_id(group: &MlsGroup) -> GroupId {
    GroupId::from_bytes(group.group_id().as_slice()).expect("a group id of the profile")
}
