//! The part of the recovery construct (spec/v2.md section 8) an agent device needs: the `SealedKey` that goes with
//! every Commit and founding it makes (a helper session's, as its opener), and the public checks on what others
//! post. An agent never holds the recovery code or `recovery_mac`, so its rows carry no `mac` (8.3).
//!
//! **Stand-in.** `trommi-core` names its `recovery` module "planned"; the device asks its caller for these calls
//! through [`DeviceRecovery`]. This file implements them from the specification with the core's primitives and
//! goes when the core's own module is merged: the connector then hands the device that one.
use trommi_core::codec::{Reader, Writer};
use trommi_core::crypto::{self, Entropy};
use trommi_core::device::{DeviceRecovery, SealRequest};
use trommi_core::ids::{DeviceId, GroupId, Hash32};
use trommi_core::mls::rules::{JoinClaim, RecoveryRules, SealedKeyClaim};
use trommi_core::Error;

const LABEL_SEAL: &str = "TrommiSealedKey";
const LABEL_GROUP_INFO: &str = "Trommi Group Info";
const LABEL_COMMIT: &str = "Trommi Commit";
const LABEL_JOIN: &str = "TrommiRecoveryJoin";

/// `struct { opaque group_id<V>; uint64 epoch; opaque group_info[32]; } KeyContext`.
fn key_context(group: &GroupId, epoch: u64, group_info: &[u8]) -> Result<Vec<u8>, Error> {
    let mut writer = Writer::new();
    writer.opaque(group.as_bytes())?;
    writer.u64(epoch);
    writer.fixed(crypto::ref_hash(LABEL_GROUP_INFO, group_info)?.as_bytes());
    Ok(writer.into_bytes())
}

/// The recovery construct as an agent device holds it: nothing secret.
#[derive(Debug, Clone, Copy, Default)]
pub struct AgentRecovery;

impl RecoveryRules for AgentRecovery {
    /// 8.4: the `RecoveryAuth` names this join (group, epoch, room epoch and state, joiner), the Commit as
    /// posted, and is signed by the room's recovery signature key. That its `base` names the GroupInfo posted
    /// for the epoch is the hub's check: a member holds no GroupInfo of a past epoch.
    fn verify_join(&self, claim: &JoinClaim<'_>) -> Result<(), Error> {
        let auth = claim.recovery_auth.ok_or(Error::BadCommit)?;
        let mut reader = Reader::new(auth);
        let read = |reader: &mut Reader<'_>| -> Result<(usize, Vec<u8>), Error> {
            let group = GroupId::from_bytes(reader.opaque()?)?;
            let epoch = reader.u64()?;
            let _base_info: [u8; 32] = reader.fixed()?;
            let room_epoch = reader.u64()?;
            let room_state: Hash32 = reader.value()?;
            let joiner: DeviceId = reader.value()?;
            let commit: Hash32 = reader.value()?;
            if group != *claim.group
                || epoch != claim.epoch
                || room_epoch != claim.note.room_epoch
                || room_state != claim.note.room_state
                || joiner != *claim.joiner
                || commit != crypto::ref_hash(LABEL_COMMIT, claim.commit)?
            {
                return Err(Error::BadCommit);
            }
            Ok((auth.len() - reader_left(reader), reader.opaque()?.to_vec()))
        };
        let (signed_len, signature) = read(&mut reader).map_err(|error| match error {
            Error::BadCommit => Error::BadCommit,
            _ => Error::BadFormat,
        })?;
        reader.finish().map_err(|_| Error::BadFormat)?;
        crypto::verify_with_label(
            claim.recovery_signature_key,
            LABEL_JOIN,
            auth.get(..signed_len).ok_or(Error::BadFormat)?,
            &signature,
        )
    }

    /// 8.2: the row is for this group, epoch, GroupInfo, room epoch, recovery key and writer, and carries a
    /// `mac` exactly when its writer is a human device. What is sealed cannot be checked by anyone but the
    /// holder of the code.
    fn verify_sealed_key(
        &self,
        claim: &SealedKeyClaim<'_>,
        sealed_key: &[u8],
    ) -> Result<(), Error> {
        let check = || -> Result<bool, Error> {
            let mut reader = Reader::new(sealed_key);
            let context_len = key_context(claim.group, claim.epoch, claim.group_info)?;
            let group = reader.opaque()?;
            let epoch = reader.u64()?;
            let info: [u8; 32] = reader.fixed()?;
            let room_epoch = reader.u64()?;
            let hpke_key = reader.opaque()?;
            let _kem_output = reader.opaque()?;
            let _ciphertext = reader.opaque()?;
            let writer: DeviceId = reader.value()?;
            let mac = reader.opaque()?;
            let mac_fits = if claim.writer_is_human {
                mac.len() == 32
            } else {
                mac.is_empty()
            };
            reader.finish()?;
            let mut named = Writer::new();
            named.opaque(group)?;
            named.u64(epoch);
            named.fixed(&info);
            Ok(named.into_bytes() == context_len
                && room_epoch == claim.room_epoch
                && hpke_key == claim.recovery_hpke_key
                && writer == *claim.writer
                && mac_fits)
        };
        match check() {
            Ok(true) => Ok(()),
            _ => Err(Error::Incomplete),
        }
    }
}

/// How many bytes a reader has not read yet.
fn reader_left(reader: &Reader<'_>) -> usize {
    reader.remaining()
}

impl DeviceRecovery for AgentRecovery {
    /// `SealedKey` with `sealed = EncryptWithLabel(recovery_hpke_key, "TrommiSealedKey", KeyContext,
    /// content_key)` and an empty `mac`. A human device's row needs `recovery_mac`, which this device never
    /// holds: asked for one, it fails, and so commits nothing as a human device.
    fn seal_key(
        &mut self,
        entropy: &mut dyn Entropy,
        request: &SealRequest<'_>,
    ) -> Result<Vec<u8>, Error> {
        if request.writer_is_human {
            return Err(Error::NoKey);
        }
        let context = key_context(request.group, request.epoch, request.group_info)?;
        let sealed = crypto::encrypt_with_label(
            entropy,
            request.recovery_hpke_key,
            LABEL_SEAL,
            &context,
            request.content_key.expose(),
        )?;
        let mut writer = Writer::new();
        writer.fixed(&context);
        writer.u64(request.room_epoch);
        writer.opaque(request.recovery_hpke_key)?;
        writer.opaque(&sealed.kem_output)?;
        writer.opaque(&sealed.ciphertext)?;
        writer.fixed(request.writer.as_bytes());
        writer.opaque(&[])?;
        Ok(writer.into_bytes())
    }

    fn rules(&self) -> &dyn RecoveryRules {
        self
    }
}
