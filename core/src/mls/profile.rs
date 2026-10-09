//! The MLS profile (section 3): the one suite, what every leaf states, the two group extensions, the note in
//! every Commit, and the OpenMLS configurations that follow from them. Nothing here is negotiated.

use crate::codec::{self, Decode, Encode, Reader, Writer};
use crate::crypto::{self, CIPHERSUITE};
use crate::error::Error;
use crate::ids::{DeviceId, GroupId, Hash32, RoomId, SessionId};
use openmls::prelude::{
    Capabilities, CredentialType, Extension, ExtensionType, Extensions, GroupContext, Lifetime,
    MlsGroupCreateConfig, MlsGroupJoinConfig, ProtocolVersion, RequiredCapabilitiesExtension,
    SenderRatchetConfiguration, UnknownExtension, PURE_PLAINTEXT_WIRE_FORMAT_POLICY,
};
use tls_codec::Serialize as _;

/// The extension type of [`TrommiRoom`] in a room group's context.
pub const EXTENSION_ROOM: u16 = 0xF001;
/// The extension type of [`TrommiSession`] in a session group's context.
pub const EXTENSION_SESSION: u16 = 0xF002;
/// The label of the only key derived from a group (section 6).
pub const CONTENT_KEY_LABEL: &str = "trommi content";
/// The length of a content key.
pub const CONTENT_KEY_LEN: usize = 32;
/// The label of the hash of a room group's context that Commits and invites name.
pub const ROOM_STATE_LABEL: &str = "Trommi Room State";
/// The version every [`CommitNote`] names.
pub const NOTE_VERSION: u8 = 2;

/// How far a sender ratchet may be read out of order (3.5).
pub const OUT_OF_ORDER_TOLERANCE: u32 = 50;
/// How far ahead a sender ratchet may jump (3.5).
pub const MAXIMUM_FORWARD_DISTANCE: u32 = 10_000;

/// A lifetime starts this long before the clock of the device that made it.
pub const LIFETIME_MARGIN_MS: u64 = 60 * 60 * 1000;
/// A lifetime ends this long after it: ten years of 365 days.
pub const LIFETIME_MS: u64 = 10 * 365 * 24 * 60 * 60 * 1000;

/// The most human devices of a room, outside a recovery (section 16).
pub const MAX_HUMAN_DEVICES: usize = 32;
/// The most human devices of a room while a recovery runs.
pub const MAX_HUMAN_DEVICES_IN_RECOVERY: usize = 33;
/// The most enrolled agent devices of a room.
pub const MAX_AGENT_DEVICES: usize = 256;
/// The most helper devices in one helper session.
pub const MAX_HELPER_DEVICES: usize = 7;
/// The most live helper sessions of one main session.
pub const MAX_LIVE_HELPERS: usize = 32;
/// The most bytes of a Commit with its GroupInfo and Welcome.
pub const MAX_COMMIT_REQUEST_LEN: usize = 1 << 20;
/// The most bytes of a KeyPackage accepted from outside.
pub const MAX_KEY_PACKAGE_LEN: usize = 4096;
/// The length of a recovery public key, signature or HPKE.
pub const RECOVERY_KEY_LEN: usize = 32;

/// The content of extension 0xF001: the recovery public keys and the enrolled agent devices of a room.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrommiRoom {
    /// The Ed25519 public key that authorises a join with the code.
    pub recovery_signature_key: [u8; RECOVERY_KEY_LEN],
    /// The X25519 public key every content key is sealed to.
    pub recovery_hpke_key: [u8; RECOVERY_KEY_LEN],
    /// The enrolled agent devices, ascending, each once.
    pub agents: Vec<DeviceId>,
}

fn key_field(reader: &mut Reader<'_>) -> Result<[u8; RECOVERY_KEY_LEN], Error> {
    reader.opaque()?.try_into().map_err(|_| Error::BadFormat)
}

/// Whether `items` ascend strictly by `key`: sorted, each once.
fn strictly_ascending<T, K: Ord>(items: &[T], key: impl Fn(&T) -> K) -> bool {
    items
        .iter()
        .zip(items.iter().skip(1))
        .all(|(a, b)| key(a) < key(b))
}

impl Encode for TrommiRoom {
    fn write(&self, writer: &mut Writer) -> Result<(), Error> {
        if !strictly_ascending(&self.agents, |agent| *agent) {
            return Err(Error::BadFormat);
        }
        writer.opaque(&self.recovery_signature_key)?;
        writer.opaque(&self.recovery_hpke_key)?;
        writer.vector(&self.agents)
    }
}

impl Decode for TrommiRoom {
    fn read(reader: &mut Reader<'_>) -> Result<Self, Error> {
        let recovery_signature_key = key_field(reader)?;
        let recovery_hpke_key = key_field(reader)?;
        let agents: Vec<DeviceId> = reader.vector()?;
        if !strictly_ascending(&agents, |agent| *agent) {
            return Err(Error::BadFormat);
        }
        Ok(Self {
            recovery_signature_key,
            recovery_hpke_key,
            agents,
        })
    }
}

/// The content of extension 0xF002: which session of which room a session group is. It never changes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TrommiSession {
    /// The room.
    pub room_id: RoomId,
    /// The session.
    pub session_id: SessionId,
    /// The main session a helper session hangs under; zero for a main session.
    pub parent: SessionId,
}

impl TrommiSession {
    /// The group this extension belongs in.
    pub fn group_id(&self) -> GroupId {
        GroupId::session(self.room_id, self.session_id)
    }
}

impl Encode for TrommiSession {
    fn write(&self, writer: &mut Writer) -> Result<(), Error> {
        writer.value(&self.room_id)?;
        writer.value(&self.session_id)?;
        writer.value(&self.parent)
    }
}

impl Decode for TrommiSession {
    fn read(reader: &mut Reader<'_>) -> Result<Self, Error> {
        Ok(Self {
            room_id: reader.value()?,
            session_id: reader.value()?,
            parent: reader.value()?,
        })
    }
}

/// A device's last envelope in a group that the remover accepted (9.0.10): where its chain ends for everyone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cut {
    /// The removed device.
    pub device: DeviceId,
    /// The number of its last accepted envelope; 0 if none.
    pub seq: u64,
    /// That envelope's hash; zeros if none.
    pub hash: Hash32,
}

impl Cut {
    /// The Cut of a device none of whose envelopes was accepted.
    pub fn none(device: DeviceId) -> Self {
        Self {
            device,
            seq: 0,
            hash: Hash32::ZERO,
        }
    }
}

impl Encode for Cut {
    fn write(&self, writer: &mut Writer) -> Result<(), Error> {
        writer.value(&self.device)?;
        writer.u64(self.seq);
        writer.value(&self.hash)
    }
}

impl Decode for Cut {
    fn read(reader: &mut Reader<'_>) -> Result<Self, Error> {
        Ok(Self {
            device: reader.value()?,
            seq: reader.u64()?,
            hash: reader.value()?,
        })
    }
}

/// The `authenticated_data` of every Commit (3.3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitNote {
    /// In the room group the epoch the Commit builds on; in a session group the room epoch whose state the
    /// committer applied.
    pub room_epoch: u64,
    /// The hash of the room group's context at `room_epoch`.
    pub room_state: Hash32,
    /// The committer's clock, in milliseconds.
    pub time: u64,
    /// One Cut per device the Commit removes, ascending by device.
    pub cuts: Vec<Cut>,
    /// Whether the Commit is a join from outside.
    pub join: bool,
}

impl Encode for CommitNote {
    fn write(&self, writer: &mut Writer) -> Result<(), Error> {
        if !strictly_ascending(&self.cuts, |cut| cut.device) {
            return Err(Error::BadFormat);
        }
        writer.u8(NOTE_VERSION);
        writer.u64(self.room_epoch);
        writer.value(&self.room_state)?;
        writer.u64(self.time);
        writer.vector(&self.cuts)?;
        writer.u8(u8::from(self.join));
        Ok(())
    }
}

impl Decode for CommitNote {
    fn read(reader: &mut Reader<'_>) -> Result<Self, Error> {
        match reader.u8()? {
            NOTE_VERSION => {}
            version if version > NOTE_VERSION => return Err(Error::NewerVersion),
            _ => return Err(Error::BadFormat),
        }
        let room_epoch = reader.u64()?;
        let room_state = reader.value()?;
        let time = reader.u64()?;
        let cuts: Vec<Cut> = reader.vector()?;
        if !strictly_ascending(&cuts, |cut| cut.device) {
            return Err(Error::BadFormat);
        }
        let join = match reader.u8()? {
            0 => false,
            1 => true,
            _ => return Err(Error::BadFormat),
        };
        Ok(Self {
            room_epoch,
            room_state,
            time,
            cuts,
            join,
        })
    }
}

/// The most bytes a [`CommitNote`] may have: one Cut for every leaf a group can hold, and the fixed fields.
pub const MAX_NOTE_LEN: usize = 64 + 72 * (MAX_HUMAN_DEVICES_IN_RECOVERY + MAX_HELPER_DEVICES + 1);

/// What kind of group a group context describes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GroupKind {
    /// The room group, with its extension.
    Room(TrommiRoom),
    /// A session group, with its extension.
    Session(TrommiSession),
}

/// The lifetime of a KeyPackage or of a founder's leaf made at `now_ms`: from one hour before to ten years after.
pub(crate) fn lifetime(now_ms: u64) -> Lifetime {
    let not_before = now_ms.saturating_sub(LIFETIME_MARGIN_MS) / 1000;
    let not_after = now_ms.saturating_add(LIFETIME_MS) / 1000;
    Lifetime::init(not_before, not_after)
}

fn extension_types() -> [ExtensionType; 3] {
    [
        ExtensionType::Unknown(EXTENSION_ROOM),
        ExtensionType::Unknown(EXTENSION_SESSION),
        ExtensionType::LastResort,
    ]
}

/// What every leaf and every KeyPackage states: `mls10`, the suite, basic credentials, the two extensions and
/// `last_resort`, default proposals.
pub(crate) fn capabilities() -> Capabilities {
    Capabilities::new(
        Some(&[ProtocolVersion::Mls10]),
        Some(&[CIPHERSUITE]),
        Some(&extension_types()),
        None,
        Some(&[CredentialType::Basic]),
    )
}

/// The `required_capabilities` of every group context: both extensions, basic credentials.
fn required_capabilities() -> Extension {
    Extension::RequiredCapabilities(RequiredCapabilitiesExtension::new(
        &[
            ExtensionType::Unknown(EXTENSION_ROOM),
            ExtensionType::Unknown(EXTENSION_SESSION),
        ],
        &[],
        &[CredentialType::Basic],
    ))
}

/// The whole extension list of a group context of `kind`. A GroupContextExtensions proposal replaces the whole
/// list, so a change of [`TrommiRoom`] is made with this too.
pub(crate) fn context_extensions(kind: &GroupKind) -> Result<Extensions<GroupContext>, Error> {
    let (extension_type, content) = match kind {
        GroupKind::Room(room) => (EXTENSION_ROOM, codec::encode(room)?),
        GroupKind::Session(session) => (EXTENSION_SESSION, codec::encode(session)?),
    };
    Extensions::from_vec(vec![
        required_capabilities(),
        Extension::Unknown(extension_type, UnknownExtension(content)),
    ])
    .map_err(|_| Error::Internal("context extensions"))
}

/// Reads the kind of group from a context's extension list, strictly: exactly `required_capabilities` as the
/// profile has it and one of the two extensions, well formed, in the group whose id it fits.
pub(crate) fn group_kind(
    group: &GroupId,
    extensions: &Extensions<GroupContext>,
) -> Result<GroupKind, Error> {
    let mut required = false;
    let mut kind = None;
    for extension in extensions.iter() {
        match extension {
            Extension::RequiredCapabilities(_) if !required => {
                if *extension != required_capabilities() {
                    return Err(Error::BadFormat);
                }
                required = true;
            }
            Extension::Unknown(EXTENSION_ROOM, UnknownExtension(content)) if kind.is_none() => {
                kind = Some(GroupKind::Room(codec::decode(content, content.len())?));
            }
            Extension::Unknown(EXTENSION_SESSION, UnknownExtension(content)) if kind.is_none() => {
                kind = Some(GroupKind::Session(codec::decode(content, content.len())?));
            }
            _ => return Err(Error::BadFormat),
        }
    }
    let kind = kind.filter(|_| required).ok_or(Error::BadFormat)?;
    let fits = match &kind {
        GroupKind::Room(_) => group.is_room(),
        GroupKind::Session(session) => {
            session.group_id() == *group && session.parent != session.session_id
        }
    };
    if fits {
        Ok(kind)
    } else {
        Err(Error::BadFormat)
    }
}

/// The kind of the group that `context` describes; also checks version and suite.
pub(crate) fn kind_of_context(context: &GroupContext) -> Result<(GroupId, GroupKind), Error> {
    if context.protocol_version() != ProtocolVersion::Mls10 || context.ciphersuite() != CIPHERSUITE
    {
        return Err(Error::BadFormat);
    }
    let group = GroupId::from_bytes(context.group_id().as_slice())?;
    let kind = group_kind(&group, context.extensions())?;
    Ok((group, kind))
}

/// `RefHash("Trommi Room State", GroupContext)`: what a Commit's note and an invite name a room state by.
pub(crate) fn room_state_hash(context: &GroupContext) -> Result<Hash32, Error> {
    let encoded = context
        .tls_serialize_detached()
        .map_err(|_| Error::Internal("group context encoding"))?;
    crypto::ref_hash(ROOM_STATE_LABEL, &encoded)
}

fn sender_ratchet() -> SenderRatchetConfiguration {
    SenderRatchetConfiguration::new(OUT_OF_ORDER_TOLERANCE, MAXIMUM_FORWARD_DISTANCE)
}

/// The configuration a group of `kind` is created with by a founder whose clock shows `now_ms`.
pub(crate) fn create_config(kind: &GroupKind, now_ms: u64) -> Result<MlsGroupCreateConfig, Error> {
    Ok(MlsGroupCreateConfig::builder()
        .ciphersuite(CIPHERSUITE)
        .wire_format_policy(PURE_PLAINTEXT_WIRE_FORMAT_POLICY)
        .capabilities(capabilities())
        .with_group_context_extensions(context_extensions(kind)?)
        .use_ratchet_tree_extension(true)
        .sender_ratchet_configuration(sender_ratchet())
        .max_past_epochs(0)
        .lifetime(lifetime(now_ms))
        .build())
}

/// The configuration a group is joined with, by Welcome or from outside.
pub(crate) fn join_config() -> MlsGroupJoinConfig {
    MlsGroupJoinConfig::builder()
        .wire_format_policy(PURE_PLAINTEXT_WIRE_FORMAT_POLICY)
        .use_ratchet_tree_extension(true)
        .sender_ratchet_configuration(sender_ratchet())
        .max_past_epochs(0)
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn device(byte: u8) -> DeviceId {
        DeviceId::new([byte; 32])
    }

    fn room() -> TrommiRoom {
        TrommiRoom {
            recovery_signature_key: [1; 32],
            recovery_hpke_key: [2; 32],
            agents: vec![device(3), device(4)],
        }
    }

    #[test]
    fn group_kind_is_read_strictly() {
        let room_id = RoomId::new([7; 32]);
        let room_group = GroupId::room(room_id);
        let session = TrommiSession {
            room_id,
            session_id: SessionId::new([8; 16]),
            parent: SessionId::ZERO,
        };
        let room_extensions = context_extensions(&GroupKind::Room(room())).unwrap();
        let session_extensions = context_extensions(&GroupKind::Session(session)).unwrap();
        assert_eq!(
            group_kind(&room_group, &room_extensions).unwrap(),
            GroupKind::Room(room())
        );
        assert_eq!(
            group_kind(&session.group_id(), &session_extensions).unwrap(),
            GroupKind::Session(session)
        );
        // A room extension in a session group, a session extension of another group, a helper of itself.
        assert_eq!(
            group_kind(&session.group_id(), &room_extensions),
            Err(Error::BadFormat)
        );
        assert_eq!(
            group_kind(&room_group, &session_extensions),
            Err(Error::BadFormat)
        );
        let own_parent = TrommiSession {
            parent: session.session_id,
            ..session
        };
        assert_eq!(
            group_kind(
                &session.group_id(),
                &context_extensions(&GroupKind::Session(own_parent)).unwrap()
            ),
            Err(Error::BadFormat)
        );
        // No extension of the profile, and one without required capabilities.
        assert_eq!(
            group_kind(&room_group, &Extensions::empty()),
            Err(Error::BadFormat)
        );
        let bare = Extensions::from_vec(vec![Extension::Unknown(
            EXTENSION_ROOM,
            UnknownExtension(codec::encode(&room()).unwrap()),
        )])
        .unwrap();
        assert_eq!(group_kind(&room_group, &bare), Err(Error::BadFormat));
    }

    #[test]
    fn lifetimes_span_ten_years_from_an_hour_ago() {
        let now_ms = 1_800_000_000_000;
        let made = lifetime(now_ms);
        assert_eq!(made.not_before(), now_ms / 1000 - 3600);
        assert_eq!(made.not_after(), now_ms / 1000 + 315_360_000);
    }
}
