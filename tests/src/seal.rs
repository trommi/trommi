//! Envelopes sealed by hand. A device seals only through `chain::seal_next`, which follows the rules and uses
//! each number once; the tests also need what no device writes: a second envelope under one number, an item its
//! sender may not write, a body that is no body. This is section 9's formulas written a second time, from the
//! specification's text and on the core's primitives, so the tests also hold the core's sealing against it.

use trommi_core::codec::{self, Writer};
use trommi_core::crypto::{self, Entropy, Secret, SigningKey};
use trommi_core::envelope::{Bind, Content, Draft, Envelope, Header, Sealed, Slot};
use trommi_core::ids::Hash32;
use trommi_core::Error;

/// The sizes a padded body has.
pub const BUCKETS: [usize; 9] = [256, 512, 1024, 2048, 4096, 8192, 16_384, 32_768, 65_536];

/// A bind as the body carries it.
pub fn bind_bytes(bind: &Bind) -> Result<Vec<u8>, Error> {
    let mut writer = Writer::new();
    match bind {
        Bind::None => {}
        Bind::Answer(bind) => {
            writer.fixed(bind.object_id.as_bytes());
            writer.fixed(bind.version_hash.as_bytes());
            let choices: Vec<codec::Opaque> =
                bind.choices.iter().cloned().map(codec::Opaque).collect();
            writer.vector(&choices)?;
        }
        Bind::Request(bind) => {
            writer.fixed(bind.request_id.as_bytes());
            writer.u64(bind.expires_at);
        }
        Bind::Verdict(bind) => {
            writer.fixed(bind.request_id.as_bytes());
            writer.fixed(bind.request_hash.as_bytes());
            writer.u64(bind.expires_at);
            writer.u8(bind.verdict.byte());
        }
        Bind::TakeBack(bind) => {
            writer.fixed(bind.object_id.as_bytes());
            writer.fixed(bind.previous_hash.as_bytes());
            writer.fixed(bind.version_hash.as_bytes());
        }
    }
    Ok(writer.into_bytes())
}

/// `Body`: a version byte, the bind and the payload, each of the two as `opaque<V>`.
pub fn body_bytes(version: u8, bind: &[u8], payload: &[u8]) -> Result<Vec<u8>, Error> {
    let mut writer = Writer::new();
    writer.u8(version);
    writer.opaque(bind)?;
    writer.opaque(payload)?;
    Ok(writer.into_bytes())
}

/// `body` with zero bytes up to `len`.
pub fn padded_to(body: &[u8], len: usize) -> Vec<u8> {
    let mut padded = body.to_vec();
    padded.resize(len.max(body.len()), 0);
    padded
}

/// `body` with zero bytes up to the next padded size; as it is beyond the largest.
pub fn padded(body: &[u8]) -> Vec<u8> {
    let len = BUCKETS
        .into_iter()
        .find(|bucket| *bucket >= body.len())
        .unwrap_or(body.len());
    padded_to(body, len)
}

/// The padded body of `draft` at `slot`.
pub fn padded_body(draft: &Draft, slot: &Slot) -> Result<Vec<u8>, Error> {
    let body = draft.body(slot)?;
    Ok(padded(&body_bytes(
        2,
        &bind_bytes(body.bind())?,
        body.payload(),
    )?))
}

/// Signs `envelope` as it stands with `signer`, whoever its header names. Returns its hash.
pub fn sign(envelope: &mut Envelope, signer: &SigningKey) -> Result<Hash32, Error> {
    let hash = envelope.hash()?;
    envelope.signature = crypto::sign_with_label(signer, "TrommiEnvelope", hash.as_bytes())?
        .try_into()
        .map_err(|_| Error::Internal("signature length"))?;
    Ok(hash)
}

/// An envelope with this header whose sealed body is `plaintext` under `key` and `nonce`, signed by `signer`.
/// Nothing is checked: any header, any plaintext of any length.
pub fn seal_plaintext(
    header: Header,
    plaintext: &[u8],
    key: &Secret<32>,
    nonce: [u8; 12],
    signer: &SigningKey,
) -> Result<Sealed, Error> {
    let aad = codec::encode(&header)?;
    let ciphertext = crypto::aead_seal(key, &nonce, &aad, plaintext)?;
    let mut envelope = Envelope {
        header,
        nonce,
        content: Content::Full(ciphertext),
        signature: [0; 64],
    };
    let hash = sign(&mut envelope, signer)?;
    Ok(Sealed { envelope, hash })
}

/// `draft` sealed at `slot` under `key` by `signer`, whatever the rules of 9.2 and the sender's chain say.
pub fn seal_at(
    draft: &Draft,
    slot: &Slot,
    key: &Secret<32>,
    signer: &SigningKey,
    entropy: &mut dyn Entropy,
) -> Result<Sealed, Error> {
    seal_plaintext(
        draft.header(slot)?,
        &padded_body(draft, slot)?,
        key,
        crypto::random(entropy)?,
        signer,
    )
}
