//! Errors. Every refusal and finding of the protocol has one stable code (section 16); the same code names it at
//! the hub, in every client and in the vectors. An error never carries a secret: it names what was refused, not
//! the bytes involved.

use std::fmt;

/// What went wrong. [`Error::code`] gives the stable code; the three variants at the end are local to a device and
/// never travel.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// `bad-format`: an encoding, a flag or a value is not what the format allows.
    BadFormat,
    /// `newer-version`: the item names a version above 2: it needs a newer Trommi.
    NewerVersion,
    /// `bad-commit`: a Commit, or a proposal in it, breaks the rules of the groups.
    BadCommit,
    /// `bad-signature`: a signature does not verify.
    BadSignature,
    /// `bad-invite`: an Add or an enrolment is not the outcome of the invite it claims.
    BadInvite,
    /// `bad-key-package`: a KeyPackage does not verify, or is not the named device's with the profile's capabilities.
    BadKeyPackage,
    /// `wrong-room`: the item belongs to another room.
    WrongRoom,
    /// `incomplete`: a request lacks a part it must come with.
    Incomplete,
    /// `chain-break`: an envelope's `prev` is not the hash of its sender's previous envelope.
    ChainBreak,
    /// `unauthorised`: no valid token.
    Unauthorised,
    /// `bad-challenge`: the sign-in challenge is unknown, used or expired.
    BadChallenge,
    /// `wrong-login`: the account's login is wrong.
    WrongLogin,
    /// `wrong-recovery`: the room is not the one the recovery code belongs to.
    WrongRecovery,
    /// `forbidden`: the sender may not write this item.
    Forbidden,
    /// `not-member`: the device is not a leaf of the group in that epoch, nor otherwise of the room.
    NotMember,
    /// `removed-sender`: the envelope lies beyond its removed sender's Cut.
    RemovedSender,
    /// `wrong-sender`: the envelope was not posted by the device that signed it.
    WrongSender,
    /// `not-found`: nothing under that name.
    NotFound,
    /// `no-room`: the room does not exist.
    NoRoom,
    /// `gone`: the hub no longer holds what was asked for.
    Gone,
    /// `invite-expired`: the invite is older than its life.
    InviteExpired,
    /// `invite-burned`: the invite was burned: the codes did not match.
    InviteBurned,
    /// `epoch-taken`: another Commit took this epoch: process the log and build again.
    EpochTaken,
    /// `wrong-epoch`: the item names an epoch that is no longer, or not yet, the one in force.
    WrongEpoch,
    /// `room-behind`: the room epoch named is not known here, or older than the one in force.
    RoomBehind,
    /// `group-behind`: the receiver has not processed the group up to the item's epoch.
    GroupBehind,
    /// `stale-session`: the session group holds a leaf the room no longer allows.
    StaleSession,
    /// `epoch-full`: the epoch holds its maximum of envelopes: commit an update.
    EpochFull,
    /// `replay`: an envelope number at or below the last accepted, with the same hash; or other bytes under a used id.
    Replay,
    /// `gap`: an envelope number above the next expected one.
    Gap,
    /// `equivocation`: two different envelopes under one number of one sender.
    Equivocation,
    /// `room-exists`: a room with this id exists.
    RoomExists,
    /// `invite-used`: the invite was already used.
    InviteUsed,
    /// `lease-lost`: a later process holds the agent device's lease.
    LeaseLost,
    /// `account-exists`: an account with this e-mail exists.
    AccountExists,
    /// `last-way-in`: the account's last way in cannot be removed.
    LastWayIn,
    /// `too-large`: something is larger than its limit.
    TooLarge,
    /// `quota-exceeded`: the room's storage is full.
    QuotaExceeded,
    /// `client-too-old`: the hub asks for a newer client.
    ClientTooOld,
    /// `too-many`: more of something than the limits allow.
    TooMany,
    /// `rate-limited`: too many requests in too short a time.
    RateLimited,
    /// `overloaded`: the hub cannot answer now.
    Overloaded,
    /// `withheld`: a head names an envelope the hub does not serve.
    Withheld,
    /// `hub-voided-other`: a void record of another sender whose reason cannot be checked again.
    HubVoidedOther,
    /// `bad-group`: an entry from the hub does not verify or process; the last good state stays.
    BadGroup,
    /// `no-key`: the content key of that group and epoch is not held.
    NoKey,
    /// `pruned`: the envelope's body was removed; its header still verifies and chains.
    Pruned,
    /// `decrypt-failed`: a ciphertext does not open, or a file is not the one its hash names.
    DecryptFailed,
    /// `code-not-confirmed`: the check code or request given is not the confirmed one.
    CodeNotConfirmed,
    /// `hash-mismatch`: a provisional envelope is not the one its chain reached under that number.
    HashMismatch,
    /// `cut`: the envelope lies beyond a Cut: kept as evidence, never applied.
    Cut,
    /// `internal`: a fault of the hub, or of this library, that no input explains. The text names the place.
    Internal(&'static str),
    /// The device's store failed, or what it holds does not decode. The text is the store's own.
    Storage(String),
    /// The system gave no randomness.
    Entropy,
}

/// Variant and code of every error that carries no data, in the order of the enum.
const CODES: &[(Error, &str)] = &[
    (Error::BadFormat, "bad-format"),
    (Error::NewerVersion, "newer-version"),
    (Error::BadCommit, "bad-commit"),
    (Error::BadSignature, "bad-signature"),
    (Error::BadInvite, "bad-invite"),
    (Error::BadKeyPackage, "bad-key-package"),
    (Error::WrongRoom, "wrong-room"),
    (Error::Incomplete, "incomplete"),
    (Error::ChainBreak, "chain-break"),
    (Error::Unauthorised, "unauthorised"),
    (Error::BadChallenge, "bad-challenge"),
    (Error::WrongLogin, "wrong-login"),
    (Error::WrongRecovery, "wrong-recovery"),
    (Error::Forbidden, "forbidden"),
    (Error::NotMember, "not-member"),
    (Error::RemovedSender, "removed-sender"),
    (Error::WrongSender, "wrong-sender"),
    (Error::NotFound, "not-found"),
    (Error::NoRoom, "no-room"),
    (Error::Gone, "gone"),
    (Error::InviteExpired, "invite-expired"),
    (Error::InviteBurned, "invite-burned"),
    (Error::EpochTaken, "epoch-taken"),
    (Error::WrongEpoch, "wrong-epoch"),
    (Error::RoomBehind, "room-behind"),
    (Error::GroupBehind, "group-behind"),
    (Error::StaleSession, "stale-session"),
    (Error::EpochFull, "epoch-full"),
    (Error::Replay, "replay"),
    (Error::Gap, "gap"),
    (Error::Equivocation, "equivocation"),
    (Error::RoomExists, "room-exists"),
    (Error::InviteUsed, "invite-used"),
    (Error::LeaseLost, "lease-lost"),
    (Error::AccountExists, "account-exists"),
    (Error::LastWayIn, "last-way-in"),
    (Error::TooLarge, "too-large"),
    (Error::QuotaExceeded, "quota-exceeded"),
    (Error::ClientTooOld, "client-too-old"),
    (Error::TooMany, "too-many"),
    (Error::RateLimited, "rate-limited"),
    (Error::Overloaded, "overloaded"),
    (Error::Withheld, "withheld"),
    (Error::HubVoidedOther, "hub-voided-other"),
    (Error::BadGroup, "bad-group"),
    (Error::NoKey, "no-key"),
    (Error::Pruned, "pruned"),
    (Error::DecryptFailed, "decrypt-failed"),
    (Error::CodeNotConfirmed, "code-not-confirmed"),
    (Error::HashMismatch, "hash-mismatch"),
    (Error::Cut, "cut"),
];

impl Error {
    /// The stable code of this error.
    pub fn code(&self) -> &'static str {
        match self {
            Error::Internal(_) => "internal",
            Error::Storage(_) => "storage",
            Error::Entropy => "entropy",
            other => CODES
                .iter()
                .find(|(error, _)| error == other)
                .map_or("internal", |(_, code)| code),
        }
    }

    /// The error a code from the hub stands for; `None` for a code this version does not know.
    pub fn from_code(code: &str) -> Option<Error> {
        if code == "internal" {
            return Some(Error::Internal("reported by the hub"));
        }
        CODES
            .iter()
            .find(|(_, known)| *known == code)
            .map(|(error, _)| error.clone())
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Internal(place) => write!(f, "internal: {place}"),
            Error::Storage(text) => write!(f, "storage: {text}"),
            other => f.write_str(other.code()),
        }
    }
}

impl std::error::Error for Error {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    /// The backticked words of a piece of the specification.
    fn backticked(text: &str) -> BTreeSet<&str> {
        text.split('`').skip(1).step_by(2).collect()
    }

    #[test]
    fn codes_are_those_of_section_16() {
        let spec = include_str!("../../spec/v2.md");
        let section = spec
            .split("\n## 16. ")
            .nth(1)
            .and_then(|rest| rest.split("\n## 17. ").next())
            .expect("section 16");
        let tables = section
            .split("| Status | Codes |")
            .nth(1)
            .expect("the code tables");
        let mut in_spec: BTreeSet<&str> = backticked(tables);
        // The marker of the chain route (9.0.10) is a code too, though no request is refused with it.
        assert!(spec.contains("marked `cut`"));
        in_spec.insert("cut");

        let mut ours: BTreeSet<&str> = CODES.iter().map(|(_, code)| *code).collect();
        assert_eq!(ours.len(), CODES.len(), "a code is listed twice");
        assert!(ours.insert("internal"));
        assert_eq!(ours, in_spec);
    }

    #[test]
    fn every_variant_has_its_own_code() {
        let mut seen = BTreeSet::new();
        for (error, code) in CODES {
            assert_eq!(error.code(), *code);
            assert_eq!(Error::from_code(code).as_ref(), Some(error));
            assert_eq!(error.to_string(), *code);
            assert!(seen.insert(*code));
        }
        for local in [
            Error::Internal("x"),
            Error::Storage("x".into()),
            Error::Entropy,
        ] {
            assert!(seen.insert(local.code()), "{} is used twice", local.code());
        }
        assert_eq!(
            Error::from_code("internal"),
            Some(Error::Internal("reported by the hub"))
        );
        assert_eq!(Error::from_code("storage"), None);
        assert_eq!(Error::from_code("no-such-code"), None);
    }

    #[test]
    fn display_names_the_place_not_the_data() {
        assert_eq!(Error::Internal("crypto").to_string(), "internal: crypto");
        assert_eq!(
            Error::Storage("disk full".into()).to_string(),
            "storage: disk full"
        );
        assert_eq!(Error::Entropy.to_string(), "entropy");
    }
}
