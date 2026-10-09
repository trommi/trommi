//! The place of the recovery construct (section 8), which the core's device does not carry yet.
//!
//! The core's device is built with something that makes the `SealedKey` posted beside every Commit and checks the
//! ones of others. Until the core brings the real construct, a build has one of two things in that place:
//!
//! - **Nothing** (the default): no room is founded and no Commit is made or taken (`internal`). Everything that
//!   needs no room works: files, the account, push, the hub's sign-in.
//! - **A stand-in** (the cargo feature `stand-in-recovery`, for development): its "sealed key" is a readable tag
//!   that seals nothing, its public keys are hashes of the code, and it authorises no join with the code. **A
//!   room founded with it cannot be recovered, and a build with it is not for release.**
//!
//! [`crate::versions`] says which one a build has in `recovery`, and both apps show that line.

use trommi_core::crypto::{Entropy, Secret};
use trommi_core::device::{DeviceRecovery, SealRequest};
use trommi_core::mls::rules::{JoinClaim, RecoveryRules, SealedKeyClaim};
use trommi_core::Error;

/// What [`crate::versions`] reports as the state of recovery in this build.
#[cfg(feature = "stand-in-recovery")]
pub(crate) const STATE: &str = "stand-in: rooms cannot be recovered, not for release";
/// What [`crate::versions`] reports as the state of recovery in this build.
#[cfg(not(feature = "stand-in-recovery"))]
pub(crate) const STATE: &str = "not built: no room can be founded";

/// What the device is built with in the place of the recovery construct.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct Recovery;

/// The tag the stand-in posts where a `SealedKey` belongs.
#[cfg(feature = "stand-in-recovery")]
fn tag(group: &impl std::fmt::Display, epoch: u64, room_epoch: u64) -> Vec<u8> {
    format!("stand-in sealed key {group} {epoch} {room_epoch}").into_bytes()
}

impl RecoveryRules for Recovery {
    fn verify_join(&self, _: &JoinClaim<'_>) -> Result<(), Error> {
        Err(Error::BadCommit)
    }

    #[cfg(feature = "stand-in-recovery")]
    fn verify_sealed_key(
        &self,
        claim: &SealedKeyClaim<'_>,
        sealed_key: &[u8],
    ) -> Result<(), Error> {
        if sealed_key == tag(claim.group, claim.epoch, claim.room_epoch) {
            Ok(())
        } else {
            Err(Error::Incomplete)
        }
    }

    #[cfg(not(feature = "stand-in-recovery"))]
    fn verify_sealed_key(&self, _: &SealedKeyClaim<'_>, _: &[u8]) -> Result<(), Error> {
        Err(Error::Incomplete)
    }
}

impl DeviceRecovery for Recovery {
    #[cfg(feature = "stand-in-recovery")]
    fn seal_key(
        &mut self,
        _: &mut dyn Entropy,
        request: &SealRequest<'_>,
    ) -> Result<Vec<u8>, Error> {
        Ok(tag(request.group, request.epoch, request.room_epoch))
    }

    #[cfg(not(feature = "stand-in-recovery"))]
    fn seal_key(&mut self, _: &mut dyn Entropy, _: &SealRequest<'_>) -> Result<Vec<u8>, Error> {
        Err(Error::Internal("the recovery construct is not built"))
    }

    fn rules(&self) -> &dyn RecoveryRules {
        self
    }
}

/// The two public keys a room is founded with. Under the stand-in they are hashes of the code.
#[cfg(feature = "stand-in-recovery")]
pub(crate) fn public_keys(code: &Secret<32>) -> Result<([u8; 32], [u8; 32]), Error> {
    use trommi_core::crypto::ref_hash;
    Ok((
        *ref_hash("stand-in recovery sign", code.expose())?.as_bytes(),
        *ref_hash("stand-in recovery hpke", code.expose())?.as_bytes(),
    ))
}

/// The two public keys a room is founded with: none without the recovery construct.
#[cfg(not(feature = "stand-in-recovery"))]
pub(crate) fn public_keys(_: &Secret<32>) -> Result<([u8; 32], [u8; 32]), Error> {
    Err(Error::Internal("the recovery construct is not built"))
}
