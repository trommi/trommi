//! Joining by link (section 12.1) at the edge: what the inviter and the new device hand each other through the
//! hub, as plain records. Every signed part travels as its bytes with the signature beside it.

use crate::records::Cut;
use crate::CoreError;
use trommi_core::device as core;
use trommi_core::invite::{self, Role};

choice! {
    /// What a new device is invited as.
    pub enum InviteRole {
        /// A human device: it becomes a leaf of the room group.
        Human = "human",
        /// An agent device: its key is enrolled among the room's agent devices.
        Agent = "agent",
    }
}

impl From<Role> for InviteRole {
    fn from(role: Role) -> Self {
        match role {
            Role::Human => InviteRole::Human,
            Role::Agent => InviteRole::Agent,
        }
    }
}

impl From<InviteRole> for Role {
    fn from(role: InviteRole) -> Self {
        match role {
            InviteRole::Human => Role::Human,
            InviteRole::Agent => Role::Agent,
        }
    }
}

record! {
    /// An invite as its inviter opened it. The link holds the invite's secret: it is handed to the new device
    /// and to nobody else, and never logged.
    secret pub struct InviteOpened {
        /// The invite, as the hub knows it: 16 bytes.
        pub invite_id: Vec<u8>,
        /// The link to hand to the new device.
        pub link: String,
        /// The last moment a Request is accepted, in milliseconds.
        pub expires_at: u64,
        /// The Offer to publish.
        pub offer: Vec<u8>,
        /// The inviter's signature over the Offer.
        pub offer_signature: Vec<u8>,
    }
}

record! {
    /// The check code both sides show: six of 64 emoji. The person compares them.
    pub struct CheckCode {
        /// The six numbers, 0 to 63 each: what `invite_confirm` takes.
        pub numbers: Vec<u8>,
        /// The six emoji.
        pub emoji: Vec<String>,
        /// The six emoji as words, for a screen reader and for reading aloud.
        pub words: Vec<String>,
    }
}

impl From<&invite::CheckCode> for CheckCode {
    fn from(code: &invite::CheckCode) -> Self {
        let texts =
            |texts: [&'static str; 6]| texts.iter().map(|text| (*text).to_owned()).collect();
        Self {
            numbers: code.numbers().to_vec(),
            emoji: texts(code.emoji()),
            words: texts(code.words()),
        }
    }
}

/// The check code six numbers stand for; `bad-format` for anything but six numbers from 0 to 63.
pub(crate) fn check_code(numbers: &[u8]) -> Result<invite::CheckCode, CoreError> {
    let numbers: [u8; 6] = numbers
        .try_into()
        .map_err(|_| CoreError::bad_format("a check code is six numbers"))?;
    Ok(invite::CheckCode::from_numbers(numbers)?)
}

record! {
    /// What the inviter publishes and shows once it accepted a Request.
    pub struct InviteAccepted {
        /// The new device, 32 bytes.
        pub new_device: Vec<u8>,
        /// The code to show.
        pub code: CheckCode,
        /// The Reveal to publish.
        pub reveal: Vec<u8>,
        /// The inviter's signature over the Reveal.
        pub reveal_signature: Vec<u8>,
        /// The hash of the accepted Request, 32 bytes: with the code, what the person's confirmation names.
        pub request_hash: Vec<u8>,
    }
}

impl From<core::InviteAccepted> for InviteAccepted {
    fn from(accepted: core::InviteAccepted) -> Self {
        Self {
            new_device: accepted.new_device.as_bytes().to_vec(),
            code: CheckCode::from(&accepted.code),
            reveal: accepted.signed_reveal.reveal,
            reveal_signature: accepted.signed_reveal.signature,
            request_hash: accepted.request_hash.as_bytes().to_vec(),
        }
    }
}

record! {
    /// A confirmed invite whose Commit is in the outbox.
    pub struct InviteConfirmed {
        /// The new device, 32 bytes.
        pub new_device: Vec<u8>,
        /// What it was invited as.
        pub role: InviteRole,
        /// For an agent device, the session it takes over: 16 bytes.
        pub session_id: Option<Vec<u8>>,
        /// The outbox entry of the Commit.
        pub outbox_id: u64,
    }
}

impl From<core::InviteConfirmed> for InviteConfirmed {
    fn from(confirmed: core::InviteConfirmed) -> Self {
        Self {
            new_device: confirmed.new_device.as_bytes().to_vec(),
            role: confirmed.role.into(),
            session_id: confirmed
                .session_id
                .map(|session| session.as_bytes().to_vec()),
            outbox_id: confirmed.outbox_id,
        }
    }
}

choice! {
    /// What is to do next for a device that was committed by link.
    pub enum InviteStepKind {
        /// Nothing yet: a Commit of this device waits for the hub or the log.
        Wait = "wait",
        /// The Commit that lets the device in was dropped for another: build it again with `invite_recommit`.
        Commit = "commit",
        /// Send the key handover with `invite_handover` (`group`, `device`); or, for a takeover without
        /// history, drop the step with `invite_forget`.
        Handover = "handover",
        /// Add the human device `device` to the live session group `group`: claim one KeyPackage of it at
        /// the hub and call `add_to_session`.
        AddToSession = "addToSession",
        /// Found the agent device's main session with `found_session`: `device`, its `key_package`, and one
        /// KeyPackage of every other human device.
        FoundSession = "foundSession",
        /// Take the session `group` over with `clean_session`: `cuts`, and `device` with `key_package` as the
        /// replacement.
        TakeOver = "takeOver",
    }
}

record! {
    /// One thing to do next for an invite, until all of it is done.
    pub struct InviteStep {
        /// The invite, 16 bytes.
        pub invite_id: Vec<u8>,
        /// What is to do. The fields below are filled as that kind says.
        pub kind: InviteStepKind,
        /// The group concerned.
        pub group: Option<Vec<u8>>,
        /// The device concerned, 32 bytes.
        pub device: Option<Vec<u8>>,
        /// The KeyPackage of an agent device to found a session for, or to hand a session to.
        pub key_package: Option<Vec<u8>>,
        /// For a takeover, the leaves to remove, each with its Cut.
        pub cuts: Vec<Cut>,
    }
}

impl InviteStep {
    pub(crate) fn of(invite_id: &trommi_core::ids::InviteId, step: core::InviteStep) -> Self {
        let empty = |kind| Self {
            invite_id: invite_id.as_bytes().to_vec(),
            kind,
            group: None,
            device: None,
            key_package: None,
            cuts: Vec::new(),
        };
        match step {
            core::InviteStep::Wait => empty(InviteStepKind::Wait),
            core::InviteStep::Commit => empty(InviteStepKind::Commit),
            core::InviteStep::Handover { group, device } => Self {
                group: Some(group.as_bytes().to_vec()),
                device: Some(device.as_bytes().to_vec()),
                ..empty(InviteStepKind::Handover)
            },
            core::InviteStep::AddToSession { group, device } => Self {
                group: Some(group.as_bytes().to_vec()),
                device: Some(device.as_bytes().to_vec()),
                ..empty(InviteStepKind::AddToSession)
            },
            core::InviteStep::FoundSession { agent, key_package } => Self {
                device: Some(agent.as_bytes().to_vec()),
                key_package: Some(key_package),
                ..empty(InviteStepKind::FoundSession)
            },
            core::InviteStep::TakeOver {
                group,
                cuts,
                agent,
                key_package,
            } => Self {
                group: Some(group.as_bytes().to_vec()),
                device: Some(agent.as_bytes().to_vec()),
                key_package: Some(key_package),
                cuts: cuts.iter().map(Cut::from).collect(),
                ..empty(InviteStepKind::TakeOver)
            },
        }
    }
}

record! {
    /// A Request as the new device made it.
    pub struct JoinRequest {
        /// The invite, by which the hub takes the Request: 16 bytes.
        pub invite_id: Vec<u8>,
        /// The Request to send.
        pub request: Vec<u8>,
        /// Its MAC under the link's secret.
        pub mac: Vec<u8>,
        /// The new device's signature over both.
        pub signature: Vec<u8>,
        /// What this device is invited as.
        pub role: InviteRole,
        /// The inviting device, 32 bytes.
        pub inviter: Vec<u8>,
        /// The last moment the Request is accepted, in milliseconds.
        pub expires_at: u64,
    }
}

impl From<core::JoinRequest> for JoinRequest {
    fn from(request: core::JoinRequest) -> Self {
        Self {
            invite_id: request.invite_id.as_bytes().to_vec(),
            request: request.signed_request.request,
            mac: request.signed_request.mac,
            signature: request.signed_request.signature,
            role: request.role.into(),
            inviter: request.inviter.as_bytes().to_vec(),
            expires_at: request.expires_at,
        }
    }
}
