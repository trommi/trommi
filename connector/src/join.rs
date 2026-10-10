//! Joining a room by an agent invite link (spec/v1.md 12.1): the link names the hub, the room and a secret; this
//! device answers the inviter's Offer with a KeyPackage of its own, shows the six emoji of the check code, and is
//! in once the human confirmed them in the app and the inviter enrolled it.
//!
//! The link is used once and never stored. What is stored is what the device must hold the room to afterwards:
//! which device invited it, and the room epoch and state it starts following the room group at.
use crate::client::{hub_for, put_room_record, sleep, RoomRecord};
use crate::error::{Fault, Result};
use crate::hub::{b64, unb64, Hub};
use crate::keeper::Keeper;
use crate::store::Journal;
use crate::util::{hex, now_ms};
use crate::vault::Vault;
use serde_json::json;
use std::sync::Arc;
use trommi_core::invite::{CheckCode, InviteLink, Offer, Role, SignedOffer, SignedReveal};

/// The room and hub an invite link names, without using it: `(room id as base64url, hub address)`.
pub fn room_of_link(link: &str) -> Result<(String, String)> {
    let link = InviteLink::parse(link.trim())?;
    Ok((link.room_id.to_base64url(), link.hub.as_str().to_string()))
}

/// Checks a pasted link before anything is asked of a hub or written: its form, and its deadline by this
/// machine's clock (with the protocol's two minutes of tolerance). An expired link is `invite-expired`, a
/// deadline further ahead than any invite lives is `bad-invite`.
pub fn check_link(link: &str, now_ms: u64) -> Result<()> {
    let link = InviteLink::parse(link.trim())?;
    link.check_deadline(now_ms).map_err(|error| {
        let fault = Fault::from(error);
        let message = match fault.code.as_str() {
            "invite-expired" => format!(
                "this invite link expired {} ago; make a new invite in the Trommi app",
                ago(now_ms.saturating_sub(link.expires_at))
            ),
            "bad-invite" => {
                "this invite link's deadline is further ahead than an invite lives (is this machine's clock right?)"
                    .to_string()
            }
            _ => return fault,
        };
        Fault::new(fault.code, message)
    })
}

fn ago(ms: u64) -> String {
    let minutes = ms / 60_000;
    match minutes {
        0 => "just now".to_string(),
        1..=119 => format!("{minutes} min"),
        _ => format!("{} h", minutes / 60),
    }
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
    let link_text = link.trim().to_string();
    let link = InviteLink::parse(&link_text)?;
    let until = now_ms() + timeout_ms;
    let open = Hub::new(link.hub.as_str(), None, None)?;
    // The new device: its key, its KeyPackage and its Request are written before the Request leaves (13.2).
    let for_vault = journal.clone();
    let vault = Arc::new(Keeper::spawn(move || Vault::create(for_vault))?);
    let outcome = async {
        // The link as the device reads it, before the Offer is fetched: its deadline, and that this device
        // holds no room yet.
        let for_link = link_text.clone();
        let joining = vault
            .call(move |v: &mut Vault| v.device.join_link(&for_link, now_ms()))
            .await??;
        let invite_id = joining.invite_id.to_base64url();
        let offer = open
            .open_call(
                reqwest::Method::GET,
                &format!("/v2/invites/{invite_id}"),
                None,
            )
            .await?;
        // The MAC binds the Offer to this link; a hub that serves none leaves it empty and the device
        // refuses the Offer (bad-invite).
        let offer = SignedOffer {
            offer: unb64(&offer, "offer")?,
            signature: unb64(&offer, "signature")?,
            mac: unb64(&offer, "mac").unwrap_or_default(),
        };
        // What the Offer says is checked by the device below; it is read here only for what this side stores.
        let told = Offer::decode(&offer.offer)?;
        let now = now_ms();
        let request = vault
            .call(move |v: &mut Vault| -> Result<_> {
                let request = v.device.join_request(&link_text, &offer, now)?;
                Ok(request)
            })
            .await??;
        if request.role != Role::Agent {
            return Err(Fault::new(
                "bad-invite",
                "this link invites a human device; the connector needs an agent invite",
            ));
        }
        let record = RoomRecord {
            hub: link.hub.as_str().to_string(),
            app: link.app().to_string(),
            room: link.room_id.to_base64url(),
            invited_session: if told.session_id.is_zero() {
                String::new()
            } else {
                hex(told.session_id.as_bytes())
            },
            room_epoch: told.room_epoch,
            enrolled: false,
        };
        put_room_record(journal, &record);
        journal.commit()?;

        let signed = &request.signed_request;
        open.open_call(
            reqwest::Method::POST,
            &format!("/v2/invites/{invite_id}/request"),
            Some(&json!({
                "request": b64(&signed.request), "mac": b64(&signed.mac),
                "signature": b64(&signed.signature),
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
        let reveal = SignedReveal {
            reveal: unb64(&reveal, "reveal")?,
            signature: unb64(&reveal, "signature")?,
        };
        let code = vault
            .call(move |v: &mut Vault| -> Result<CheckCode> {
                let code = v.device.join_reveal(&reveal)?;
                v.commit()?;
                Ok(code)
            })
            .await??;
        on_code(&code);

        // The hub lets the device sign in once the inviter's Commit names its key (12.3.2): until then it
        // answers `not-member`. That the inviter made that Commit is the device's check when the room
        // group's log brings it (12.1.6).
        let hub = hub_for(&vault, link.hub.as_str(), link.room_id)?;
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
    .await;
    // The device object goes before the client opens the same state.
    match Arc::try_unwrap(vault) {
        Ok(keeper) => keeper.close(),
        Err(_) => return Err(Fault::new("internal", "the joining device is still in use")),
    }
    outcome
}
