//! Joining a room by an agent invite link (spec/v2.md 12.1): the link names the hub, the room and a secret; this
//! device answers the inviter's Offer with a KeyPackage of its own, shows the six emoji of the check code, and is
//! in once the human confirmed them in the app and the inviter enrolled it.
//!
//! The link is used once and never stored. What is stored is what the device must hold the room to afterwards:
//! which device invited it, and the room epoch and state it starts following the room group at.
use crate::client::{put_room_record, sleep, RoomRecord};
use crate::error::{Fault, Result};
use crate::hub::{b64, unb64, Hub};
use crate::keeper::Keeper;
use crate::store::Journal;
use crate::util::{hex, now_ms};
use crate::vault::Vault;
use serde_json::json;
use std::sync::Arc;
use trommi_core::invite::{CheckCode, InviteLink, Joiner, Role, SignedOffer, SignedReveal};

/// The room and hub an invite link names, without using it: `(room id as base64url, hub address)`.
pub fn room_of_link(link: &str) -> Result<(String, String)> {
    let link = InviteLink::parse(link.trim())?;
    Ok((link.room_id.to_base64url(), link.hub.as_str().to_string()))
}

/// Answers the invite `link` with a new device in the empty `journal` and waits until the inviter enrolled it.
/// `on_code` is handed the check code as soon as the inviter revealed it; the human compares it in the app.
/// `poll_ms` is the pause between questions to the hub, `timeout_ms` how long the whole join may take.
///
/// On success the journal holds the device and the room record, and [`crate::client::Client::open`] takes over.
/// On any failure the journal is wiped: a half-made device is of no use.
pub async fn join_room(
    link: &str,
    journal: Journal,
    on_code: impl Fn(&CheckCode) + Send,
    poll_ms: u64,
    timeout_ms: u64,
) -> Result<()> {
    let outcome = answer_invite(link, &journal, on_code, poll_ms, timeout_ms).await;
    if outcome.is_err() {
        let _ = journal.wipe();
    }
    outcome
}

async fn answer_invite(
    link: &str,
    journal: &Journal,
    on_code: impl Fn(&CheckCode) + Send,
    poll_ms: u64,
    timeout_ms: u64,
) -> Result<()> {
    let link = InviteLink::parse(link.trim())?;
    let invite_id = link.invite_id()?.to_base64url();
    let until = now_ms() + timeout_ms;
    let open = Hub::new(link.hub.as_str(), None, None)?;

    let offer = open
        .open_call(
            reqwest::Method::GET,
            &format!("/v2/invites/{invite_id}"),
            None,
        )
        .await?;
    let offer = SignedOffer {
        offer: unb64(&offer, "offer")?,
        signature: unb64(&offer, "signature")?,
    };

    // The new device: its key and one KeyPackage are written before the Request leaves (13.2).
    let for_vault = journal.clone();
    let vault = Keeper::spawn(move || Vault::create(for_vault))?;
    let now = now_ms();
    let made = vault
        .call(move |v: &mut Vault| -> Result<_> {
            let key_package = v.device.key_package(now)?;
            v.commit()?;
            let key =
                trommi_core::crypto::SigningKey::from_seed(v.signing_key().seed().duplicate());
            Ok((key, key_package))
        })
        .await?;
    vault.close();
    let (key, key_package) = made?;

    let (joiner, request) = Joiner::request(&link, &offer, &key, &key_package, now_ms())?;
    let told = joiner.offer().clone();
    if told.role != Role::Agent {
        return Err(Fault::new(
            "bad-invite",
            "this link invites a human device; the connector needs an agent invite",
        ));
    }
    let record = RoomRecord {
        hub: link.hub.as_str().to_string(),
        app: link.app().to_string(),
        room: link.room_id.to_base64url(),
        inviter: told.inviter.to_base64url(),
        invited_session: if told.session_id.is_zero() {
            String::new()
        } else {
            hex(told.session_id.as_bytes())
        },
        room_epoch: told.room_epoch,
        room_state: told.room_state.to_base64url(),
        observing: false,
        enrolled: false,
    };
    put_room_record(journal, &record);
    journal.commit()?;

    open.open_call(
        reqwest::Method::POST,
        &format!("/v2/invites/{invite_id}/request"),
        Some(&json!({
            "request": b64(&request.request), "mac": b64(&request.mac),
            "signature": b64(&request.signature),
        })),
    )
    .await?;

    // The inviter's Reveal: the code both sides show.
    let reveal = loop {
        match open
            .open_call(
                reqwest::Method::GET,
                &format!("/v2/invites/{invite_id}/reveal"),
                None,
            )
            .await
        {
            Ok(reveal) => break reveal,
            Err(fault) if fault.code == "not-found" || crate::hub::is_transient(&fault) => {}
            Err(fault) => return Err(fault),
        }
        if now_ms() > until {
            return Err(Fault::new(
                "invite-expired",
                "the app did not answer this invite in time",
            ));
        }
        sleep(poll_ms).await;
    };
    let code = joiner.reveal(&SignedReveal {
        reveal: unb64(&reveal, "reveal")?,
        signature: unb64(&reveal, "signature")?,
    })?;
    on_code(&code);

    // Enrolled is who the hub lets sign in: a key in the room's `agents` (12.3.2). That the inviter put it
    // there is checked when the room group's Commit is processed (client.rs).
    let room_id = link.room_id;
    let address = link.hub.clone();
    let signer: crate::hub::Signer = Arc::new(move |challenge| {
        Ok(trommi_core::hub_auth::sign(
            &key, room_id, &address, challenge,
        )?)
    });
    let hub = Hub::new(link.hub.as_str(), Some(room_id), Some(signer))?;
    loop {
        match hub.get("/v2/welcomes").await {
            Ok(_) => return Ok(()),
            Err(fault) if fault.code == "not-member" || crate::hub::is_transient(&fault) => {}
            Err(fault) => return Err(fault),
        }
        if now_ms() > until {
            return Err(Fault::new(
                "invite-expired",
                "the human did not confirm the six emoji in time; make a new invite in the Trommi app",
            ));
        }
        sleep(poll_ms).await;
    }
}
