//! room.mjs for an agent: opening a stored room and joining one with an invite link.
use crate::client::{secret_from_json, Client, ClientEvent};
use crate::crypto::{self, hex, unb64u, unhex, Device};
use crate::error::{Result, ZError};
use crate::model::now_ms;
use crate::storage::FileStorage;
use crate::transport::{normalise_hub_url, Hub};
use serde_json::{json, Map, Value};
use std::sync::Arc;
use tokio::sync::mpsc;

pub type Opened = (Arc<Client>, mpsc::UnboundedReceiver<ClientEvent>);

async fn make_client(storage: Arc<FileStorage>, device: Device, state: crypto::LogState, secrets: Vec<crypto::Secret>, room_record: Map<String, Value>, client_name: Option<String>, save: bool) -> Result<Opened> {
    let (client, rx) = Client::new(storage, device, state, secrets, room_record, client_name)?;
    if save {
        let mut c = client.core.lock().await;
        client.save_room(&mut c)?;
    }
    client.load_persisted().await?;
    Ok((client, rx))
}

/// Open the room in this storage (warm start): verify the stored member list against the stored room id.
pub async fn open_room(storage: Arc<FileStorage>, client_name: Option<String>) -> Result<Option<Opened>> {
    let Some(Value::Object(room_record)) = storage.get("room") else { return Ok(None) };
    let Some(device) = storage.load_device()? else { return Err(ZError::new("no-device", "the room is stored but the device key is missing")) };
    let entries: Vec<Vec<u8>> = room_record["entries"].as_array().cloned().unwrap_or_default().iter().map(|e| unb64u(e.as_str().unwrap_or(""))).collect::<Result<_>>()?;
    let room_id = unhex(room_record["room_id"].as_str().unwrap_or(""))?;
    let state = crypto::verify_log(&entries, Some(&room_id))?;
    let secrets: Vec<crypto::Secret> = room_record["secrets"].as_array().cloned().unwrap_or_default().iter().filter_map(|s| secret_from_json(s).ok()).collect();
    Ok(Some(make_client(storage, device, state, secrets, room_record, client_name, false).await?))
}

/// Join with an invite link: `on_code` gets the check code once the inviter revealed; resolves once the inviter added
/// this device.
pub async fn join_room(link: &str, storage: Arc<FileStorage>, device_info: Value, client_name: Option<String>, keychain: bool, poll_ms: u64, timeout_ms: u64, mut on_code: impl FnMut(String) + Send) -> Result<Opened> {
    if storage.get("room").is_some() {
        return Err(ZError::new("room-exists", "this storage already holds a room"));
    }
    let p = crypto::parse_invite_link(link)?;
    let room_id = hex(&p.room_id);
    let hub = Hub::new(&p.hub, Some(room_id.clone()), client_name.clone(), None)?;
    let invite_id = hex(&crypto::invite_id_of(&p.secret, &p.room_id));
    let inv = hub.get_invite(&invite_id).await?;
    let device = Device::generate();
    let log: Vec<Vec<u8>> = inv["signed_entries"].as_array().cloned().unwrap_or_default().iter().map(|e| unb64u(e.as_str().unwrap_or(""))).collect::<Result<_>>()?;
    let (request, join) = crypto::create_join_request(link, &unb64u(inv["signed_offer"].as_str().unwrap_or(""))?, &log, &device, now_ms())?;
    let r = hub.post_request(&invite_id, &crypto::b64u(&request)).await?;
    let request_hash = r["request_hash"].as_str().unwrap_or("").to_string();
    let until = now_ms() + timeout_ms;
    let mut revealed = false;
    while now_ms() < until {
        let s = hub.join_status(&invite_id, &request_hash).await?;
        let st = s["join_status"].as_str().unwrap_or("");
        if st == "taken" {
            return Err(ZError::new("invite-used", "this invite was answered for another device"));
        }
        if (st == "revealed" || st == "joined") && !revealed {
            if let Some(rv) = s["signed_reveal"].as_str() {
                revealed = true;
                let l: Vec<Vec<u8>> = match s["signed_entries"].as_array() {
                    Some(a) => a.iter().map(|e| unb64u(e.as_str().unwrap_or(""))).collect::<Result<_>>()?,
                    None => log.clone(),
                };
                on_code(crypto::check_reveal(&join, &unb64u(rv)?, &l)?);
            }
        }
        if st == "joined" {
            let entries: Vec<Vec<u8>> = s["signed_entries"].as_array().cloned().unwrap_or_default().iter().map(|e| unb64u(e.as_str().unwrap_or(""))).collect::<Result<_>>()?;
            let wrap = match s["key_sealed"].as_str() {
                Some(k) => Some(unb64u(k)?),
                None => None,
            };
            let (state, secret) = crypto::complete_join(&join, &device, &entries, wrap.as_deref())?;
            storage.save_device(&device, Some(&room_id), keychain)?;
            let role = if join.role == crypto::ROLE_HUMAN { "human" } else { "agent" };
            let mut rr = Map::new();
            rr.insert("hub_url".into(), json!(normalise_hub_url(&p.hub)?));
            rr.insert("room_id".into(), json!(room_id));
            rr.insert("my_device_id".into(), json!(hex(&device.id)));
            rr.insert("my_role".into(), json!(role));
            rr.insert("device_info".into(), device_info);
            rr.insert("device_register_sent".into(), json!(false));
            return make_client(storage, device, state, secret.into_iter().collect(), rr, client_name, true).await;
        }
        tokio::time::sleep(std::time::Duration::from_millis(poll_ms)).await;
    }
    Err(ZError::new("invite-expired", "the invite ran out before it was confirmed"))
}
