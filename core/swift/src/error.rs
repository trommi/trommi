//! Errors at the edge. Every refusal and finding keeps the stable code the specification gives it (section 16),
//! as a case of [`ErrorCode`]; the text beside it names what was refused and never holds key material.

use trommi_core::account::AccountError;
use trommi_core::Error;

choice! {
    /// The stable code of a refusal or finding. In JavaScript each case is the code itself, as the hub spells
    /// it; [`crate::error_code_text`] gives that spelling in Swift.
    pub enum ErrorCode {
        /// An encoding, a flag or a value is not what the format allows.
        BadFormat = "bad-format",
        /// The item needs a newer Trommi.
        NewerVersion = "newer-version",
        /// A Commit, or a proposal in it, breaks the rules of the groups.
        BadCommit = "bad-commit",
        /// A signature does not verify.
        BadSignature = "bad-signature",
        /// An Add or an enrolment is not the outcome of the invite it claims.
        BadInvite = "bad-invite",
        /// A KeyPackage does not verify, or is not the named device's.
        BadKeyPackage = "bad-key-package",
        /// The item belongs to another room.
        WrongRoom = "wrong-room",
        /// A request lacks a part it must come with.
        Incomplete = "incomplete",
        /// An envelope does not continue its sender's chain.
        ChainBreak = "chain-break",
        /// No valid token.
        Unauthorised = "unauthorised",
        /// The sign-in challenge is unknown, used or expired.
        BadChallenge = "bad-challenge",
        /// The account's login is wrong.
        WrongLogin = "wrong-login",
        /// The room is not the one the recovery code belongs to.
        WrongRecovery = "wrong-recovery",
        /// The sender may not write this item.
        Forbidden = "forbidden",
        /// The device is not a member.
        NotMember = "not-member",
        /// The envelope lies beyond its removed sender's Cut.
        RemovedSender = "removed-sender",
        /// The envelope was not posted by the device that signed it.
        WrongSender = "wrong-sender",
        /// Nothing under that name.
        NotFound = "not-found",
        /// The room does not exist.
        NoRoom = "no-room",
        /// The hub no longer holds what was asked for.
        Gone = "gone",
        /// The invite is older than its life.
        InviteExpired = "invite-expired",
        /// The invite was burned: the codes did not match.
        InviteBurned = "invite-burned",
        /// Another Commit took this epoch: process the log and build again.
        EpochTaken = "epoch-taken",
        /// The item names an epoch that is not the one in force.
        WrongEpoch = "wrong-epoch",
        /// The room epoch named is not known here, or older than the one in force.
        RoomBehind = "room-behind",
        /// The receiver has not processed the group up to the item's epoch.
        GroupBehind = "group-behind",
        /// The session group holds a leaf the room no longer allows.
        StaleSession = "stale-session",
        /// The epoch holds its maximum of envelopes: commit an update.
        EpochFull = "epoch-full",
        /// An item that was already taken.
        Replay = "replay",
        /// An envelope number above the next expected one.
        Gap = "gap",
        /// Two different items under one number of one sender.
        Equivocation = "equivocation",
        /// A room with this id exists.
        RoomExists = "room-exists",
        /// The invite was already used.
        InviteUsed = "invite-used",
        /// A later process holds the agent device's lease.
        LeaseLost = "lease-lost",
        /// An account with this e-mail exists.
        AccountExists = "account-exists",
        /// The account's last way in cannot be removed.
        LastWayIn = "last-way-in",
        /// Something is larger than its limit.
        TooLarge = "too-large",
        /// The room's storage is full.
        QuotaExceeded = "quota-exceeded",
        /// The hub asks for a newer client.
        ClientTooOld = "client-too-old",
        /// More of something than the limits allow.
        TooMany = "too-many",
        /// Too many requests in too short a time.
        RateLimited = "rate-limited",
        /// The hub cannot answer now.
        Overloaded = "overloaded",
        /// A head names an envelope the hub does not serve.
        Withheld = "withheld",
        /// A void record of another sender whose reason cannot be checked again.
        HubVoidedOther = "hub-voided-other",
        /// An entry from the hub does not verify or process; the last good state stays.
        BadGroup = "bad-group",
        /// The content key of that group and epoch is not held.
        NoKey = "no-key",
        /// The envelope's body was removed.
        Pruned = "pruned",
        /// A ciphertext does not open, or a file is not the one its hash names.
        DecryptFailed = "decrypt-failed",
        /// The check code or request given is not the confirmed one.
        CodeNotConfirmed = "code-not-confirmed",
        /// A provisional envelope is not the one its chain reached under that number.
        HashMismatch = "hash-mismatch",
        /// The envelope lies beyond a Cut.
        Cut = "cut",
        /// The account's e-mail address is not one.
        BadEmail = "bad-email",
        /// The password is too short.
        WeakPassword = "weak-password",
        /// The key derivation record is not the pinned one.
        BadKdf = "bad-kdf",
        /// The text is not twelve words of the Emergency Kit's list.
        BadRecoveryWords = "bad-recovery-words",
        /// The text is not a recovery code.
        BadRecoveryCode = "bad-recovery-code",
        /// The passkey gave no usable prf output.
        NoPrf = "no-prf",
        /// A fault of this library that no input explains, a device used after it failed, or a code of the hub
        /// this version does not know.
        Internal = "internal",
        /// The device's store failed, another owner wrote to it, or what it holds does not decode.
        Storage = "storage",
        /// The system gave no randomness.
        Entropy = "entropy",
        /// The device still waits for the hub's answer to an earlier request on this group.
        Busy = "busy",
    }
}

/// What every call of the facade fails with.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "uniffi", derive(uniffi::Error))]
pub enum CoreError {
    /// The call was refused. `message` is for a log or a developer: the code as text, and for the local codes
    /// (`internal`, `storage`) the place or the store's own words. It never holds key material.
    Refused {
        /// The stable code.
        code: ErrorCode,
        /// What a log may say.
        message: String,
    },
}

impl CoreError {
    /// A refusal with `code` and its code as the message.
    pub fn of(code: ErrorCode) -> Self {
        CoreError::Refused {
            code,
            message: code.text().to_owned(),
        }
    }

    /// `bad-format`, naming the argument that is not what the call takes.
    pub fn bad_format(what: &str) -> Self {
        CoreError::Refused {
            code: ErrorCode::BadFormat,
            message: format!("bad-format: {what}"),
        }
    }

    /// `internal`, naming the place.
    pub fn internal(place: &str) -> Self {
        CoreError::Refused {
            code: ErrorCode::Internal,
            message: format!("internal: {place}"),
        }
    }

    /// `storage`, with the store's own words.
    pub fn storage(text: &str) -> Self {
        CoreError::Refused {
            code: ErrorCode::Storage,
            message: format!("storage: {text}"),
        }
    }

    /// The stable code.
    pub fn code(&self) -> ErrorCode {
        match self {
            CoreError::Refused { code, .. } => *code,
        }
    }

    /// The text for a log.
    pub fn message(&self) -> &str {
        match self {
            CoreError::Refused { message, .. } => message,
        }
    }
}

impl std::fmt::Display for CoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message())
    }
}

impl std::error::Error for CoreError {}

impl From<Error> for CoreError {
    fn from(error: Error) -> Self {
        // Every code of the core is a case here: a code that is none would be a fault of this table, and the
        // test `every_code_of_the_core_is_a_case` fails for it.
        let code = ErrorCode::from_text(error.code()).unwrap_or(ErrorCode::Internal);
        CoreError::Refused {
            code,
            message: error.to_string(),
        }
    }
}

impl From<AccountError> for CoreError {
    fn from(error: AccountError) -> Self {
        match error {
            AccountError::Core(error) => error.into(),
            other => ErrorCode::from_text(other.code())
                .map_or_else(|| CoreError::internal("account code"), CoreError::of),
        }
    }
}

/// The core's error a code stands for, as the hub's answer or a caller names it. A local code has no text to
/// carry here; a code the core does not know is `internal`.
pub(crate) fn core_error(code: ErrorCode) -> Error {
    match code {
        ErrorCode::Storage => Error::Storage(String::new()),
        ErrorCode::Entropy => Error::Entropy,
        ErrorCode::Busy => Error::Busy,
        other => Error::from_code(other.text()).unwrap_or(Error::Internal("code")),
    }
}

/// Whether the core itself has an error for `code`: the account's own codes and the ones a device says only of
/// itself have none that a hub could mean.
pub(crate) fn is_core_code(code: ErrorCode) -> bool {
    !matches!(
        code,
        ErrorCode::Storage
            | ErrorCode::Entropy
            | ErrorCode::Busy
            | ErrorCode::BadEmail
            | ErrorCode::WeakPassword
            | ErrorCode::BadKdf
            | ErrorCode::BadRecoveryWords
            | ErrorCode::BadRecoveryCode
            | ErrorCode::NoPrf
    )
}

/// The spelling of `code` in the specification and on the wire.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn error_code_text(code: ErrorCode) -> String {
    code.text().to_owned()
}

/// The code a text from the hub names; none for a code this version does not know.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn error_code_from_text(text: String) -> Option<ErrorCode> {
    ErrorCode::from_text(&text)
}
