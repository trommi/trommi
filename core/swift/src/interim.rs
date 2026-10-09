//! A stand-in for the recovery construct (section 8), which the core's device does not carry yet.
//!
//! The core's device is built with something that makes the `SealedKey` posted beside every Commit and checks the
//! ones of others. Until the core brings the real construct, this stand-in fills that place so that everything
//! else can be built and tried: its "sealed key" is a readable tag that seals nothing, its public keys are
//! hashes of the code, and it authorises no join with the code. **A room founded with it cannot be recovered.**
//! [`crate::versions`] says so in `recovery`, and both apps show that line.

use trommi_core::crypto::{ref_hash, Entropy};
use trommi_core::device::{DeviceRecovery, SealRequest};
use trommi_core::mls::rules::{JoinClaim, RecoveryRules, SealedKeyClaim};
use trommi_core::Error;

/// What [`crate::versions`] reports while this stand-in is in place.
pub(crate) const RECOVERY: &str = "stand-in: rooms cannot be recovered";

/// The stand-in.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct InterimRecovery;

fn tag(group: &impl std::fmt::Display, epoch: u64, room_epoch: u64) -> Vec<u8> {
    format!("interim sealed key {group} {epoch} {room_epoch}").into_bytes()
}

impl RecoveryRules for InterimRecovery {
    fn verify_join(&self, _: &JoinClaim<'_>) -> Result<(), Error> {
        Err(Error::BadCommit)
    }

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
}

impl DeviceRecovery for InterimRecovery {
    fn seal_key(
        &mut self,
        _: &mut dyn Entropy,
        request: &SealRequest<'_>,
    ) -> Result<Vec<u8>, Error> {
        Ok(tag(request.group, request.epoch, request.room_epoch))
    }

    fn rules(&self) -> &dyn RecoveryRules {
        self
    }
}

/// The two "public keys" a room is founded with under the stand-in: hashes of the code.
pub(crate) fn public_keys(code: &[u8; 32]) -> Result<([u8; 32], [u8; 32]), Error> {
    Ok((
        *ref_hash("interim recovery sign", code)?.as_bytes(),
        *ref_hash("interim recovery hpke", code)?.as_bytes(),
    ))
}
