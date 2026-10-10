//! A device is let in by a confirmed invite alone (12.1.4 to 12.1.6), in a build as it ships: without a stored
//! invite it takes no Welcome into a room group and no state of a room that enrols it.
//!
//! No device builds such a Welcome or such a room: the other side here is a member that obeys MLS only,
//! OpenMLS used directly with a key of its own.

use openmls::group::{MlsGroup, MlsGroupCreateConfig};
use openmls::prelude::{
    BasicCredential, Capabilities, Ciphersuite, CredentialType, CredentialWithKey, Extension,
    ExtensionType, Extensions, KeyPackage, MlsMessageBodyIn, MlsMessageIn, ProtocolVersion,
    RequiredCapabilitiesExtension, SenderRatchetConfiguration, UnknownExtension,
    PURE_PLAINTEXT_WIRE_FORMAT_POLICY,
};
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;
use openmls_traits::types::SignatureScheme;
use openmls_traits::OpenMlsProvider as _;
use std::collections::BTreeMap;
use std::time::{SystemTime, UNIX_EPOCH};
use tls_codec::{Deserialize as _, Serialize as _};
use trommi_core::codec;
use trommi_core::crypto::SystemEntropy;
use trommi_core::device::{Device, WelcomeExpectation};
use trommi_core::ids::{DeviceId, GroupId, RoomId};
use trommi_core::mls::profile::{TrommiRoom, EXTENSION_ROOM, EXTENSION_SESSION};
use trommi_core::store::{Batch, Entry, Loaded, Storage, StorageError};
use trommi_core::Error;

const SUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_CHACHA20POLY1305_SHA256_Ed25519;

/// A store in memory.
#[derive(Default)]
struct Store {
    revision: u64,
    entries: BTreeMap<Vec<u8>, Vec<u8>>,
}

impl Storage for Store {
    fn load(&mut self) -> Result<Loaded, StorageError> {
        Ok(Loaded {
            revision: self.revision,
            entries: self
                .entries
                .iter()
                .map(|(key, value)| Entry::new(key.clone(), value.clone()))
                .collect(),
        })
    }

    fn apply(&mut self, expected_revision: u64, mut batch: Batch) -> Result<(), StorageError> {
        if self.revision != expected_revision {
            return Err(StorageError::Conflict);
        }
        for key in batch.delete.drain(..) {
            self.entries.remove(&key);
        }
        for entry in batch.put.iter_mut() {
            self.entries.insert(
                std::mem::take(&mut entry.key),
                std::mem::take(&mut entry.value),
            );
        }
        self.revision += 1;
        Ok(())
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_millis() as u64)
}

fn new_device() -> Device<Store> {
    Device::create(Store::default(), Box::new(SystemEntropy)).expect("a new device")
}

/// A member with a key of its own, whose leaves are the profile's.
struct Member {
    provider: OpenMlsRustCrypto,
    signer: SignatureKeyPair,
}

impl Member {
    fn new() -> Self {
        Self {
            provider: OpenMlsRustCrypto::default(),
            signer: SignatureKeyPair::new(SignatureScheme::ED25519).expect("a key pair"),
        }
    }

    fn id(&self) -> DeviceId {
        DeviceId::from_slice(self.signer.public()).expect("32 bytes")
    }

    /// Founds the room group of `room` with itself as the only leaf and `agents` as its enrolled agent
    /// devices.
    fn found_room(&self, room: RoomId, agents: Vec<DeviceId>) -> MlsGroup {
        let extension = codec::encode(&TrommiRoom {
            recovery_signature_key: [0xE1; 32],
            recovery_hpke_key: [0xE2; 32],
            agents,
        })
        .expect("the extension encodes");
        let kinds = [
            ExtensionType::Unknown(EXTENSION_ROOM),
            ExtensionType::Unknown(EXTENSION_SESSION),
        ];
        let extensions = Extensions::from_vec(vec![
            Extension::RequiredCapabilities(RequiredCapabilitiesExtension::new(
                &kinds,
                &[],
                &[CredentialType::Basic],
            )),
            Extension::Unknown(EXTENSION_ROOM, UnknownExtension(extension)),
        ])
        .expect("the extensions fit");
        let capabilities = Capabilities::new(
            Some(&[ProtocolVersion::Mls10]),
            Some(&[SUITE]),
            Some(&[kinds[0], kinds[1], ExtensionType::LastResort]),
            None,
            Some(&[CredentialType::Basic]),
        );
        let config = MlsGroupCreateConfig::builder()
            .ciphersuite(SUITE)
            .wire_format_policy(PURE_PLAINTEXT_WIRE_FORMAT_POLICY)
            .capabilities(capabilities)
            .with_group_context_extensions(extensions)
            .use_ratchet_tree_extension(true)
            .sender_ratchet_configuration(SenderRatchetConfiguration::new(50, 10_000))
            .max_past_epochs(0)
            .build();
        MlsGroup::new_with_group_id(
            &self.provider,
            &self.signer,
            &config,
            openmls::prelude::GroupId::from_slice(GroupId::room(room).as_bytes()),
            CredentialWithKey {
                credential: BasicCredential::new(self.signer.public().to_vec()).into(),
                signature_key: self.signer.public().to_vec().into(),
            },
        )
        .expect("the group is created")
    }

    /// The GroupInfo of the group's epoch, with the tree.
    fn group_info(&self, group: &MlsGroup) -> Vec<u8> {
        group
            .export_group_info(self.provider.crypto(), &self.signer, true)
            .expect("a GroupInfo")
            .tls_serialize_detached()
            .expect("it encodes")
    }

    /// Commits the Add of `key_package` and returns the Welcome.
    fn add(&self, group: &mut MlsGroup, key_package: &[u8]) -> Vec<u8> {
        let Ok(MlsMessageBodyIn::KeyPackage(package)) =
            MlsMessageIn::tls_deserialize_exact(key_package).map(MlsMessageIn::extract)
        else {
            panic!("a KeyPackage");
        };
        let package: KeyPackage = package
            .validate(self.provider.crypto(), ProtocolVersion::Mls10)
            .expect("it verifies");
        let bundle = group
            .commit_builder()
            .consume_proposal_store(false)
            .propose_adds(vec![package])
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
        let (_, welcome, _) = bundle.into_messages();
        group
            .merge_pending_commit(&self.provider)
            .expect("the Commit merges");
        welcome
            .expect("a Welcome")
            .tls_serialize_detached()
            .expect("it encodes")
    }
}

#[test]
fn a_device_without_an_invite_takes_no_welcome_into_a_room_group() {
    // Whether the device is told who would add it or not.
    for (at, told) in [false, true].into_iter().enumerate() {
        let room = RoomId::new([0x51 + at as u8; 32]);
        let member = Member::new();
        let mut held = member.found_room(room, Vec::new());
        // The Welcome is whole and for a KeyPackage of this device, for the room it expects, by a member
        // whose leaf is the profile's: all that is missing is the invite.
        let mut device = new_device();
        let package = device.key_package(now()).expect("a KeyPackage");
        let welcome = member.add(&mut held, &package);
        let expected = WelcomeExpectation {
            room,
            committer: told.then(|| member.id()),
        };
        assert_eq!(
            device.join_welcome(&welcome, &expected, now()),
            Err(Error::BadInvite)
        );
        assert!(device.room().is_none() && !device.is_human());
        assert!(device.groups().expect("the groups").is_empty());
        // The refusal used the single-use KeyPackage up (3.7), and there is no Request to join by.
        assert_eq!(
            device.join_welcome(&welcome, &expected, now()),
            Err(Error::NotMember)
        );
        assert_eq!(device.join_invited(&welcome, now()), Err(Error::NotFound));
    }
}

#[test]
fn a_device_without_an_invite_takes_no_enrolment_from_a_state_that_names_it() {
    let room = RoomId::new([0x52; 32]);
    let member = Member::new();
    // A device that nobody invited follows a room group, as a helper device does.
    let mut device = new_device();
    let plain = member.found_room(room, Vec::new());
    let mut follower = new_device();
    follower
        .observe_room(&member.group_info(&plain), None)
        .expect("the room is followed");
    assert!(!follower.is_human());
    // A state that holds the device in `agents` brings an enrolment whose Commit it never saw.
    let enrolling = member.found_room(RoomId::new([0x53; 32]), vec![device.id()]);
    assert_eq!(
        device.observe_room(&member.group_info(&enrolling), None),
        Err(Error::BadInvite)
    );
    assert!(device.room().is_none());
    assert!(device.room_history().is_none());
}
