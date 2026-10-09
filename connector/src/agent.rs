//! What an agent writes: Chat messages, cards and their versions, registers (profile, status lines, `heard`),
//! permission requests, Artifacts with their files and Share links, the work trail, and helper sessions, which
//! it founds and keeps itself (spec/v2.md 5.2.5, 5.3.5). Every write is an envelope sealed by the vault, or a
//! request of the core's device; this file only says what goes into it.
use crate::client::{Client, Core, SentInfo, Spec};
use crate::error::{Fault, Result};
use crate::hub::{b64, unb64};
use crate::model::{urgency_of, URGENCIES};
use crate::util::{hex, now_ms, unhex};
use crate::vault::{ContentDevice, Vault};
use serde_json::{json, Map, Value};
use trommi_core::crypto::SystemEntropy;
use trommi_core::envelope::{Draft, ObjectType, Urgency, SCHEMA_VERSION};
use trommi_core::files::{self, FileRef, ShareLink};
use trommi_core::ids::{DeviceId, FileId, GroupId, Hash32, ObjectId, SessionId, TurnId};
use trommi_core::mls::profile::Cut;

/// A spec with everything its envelope needs: the final payload, and for a later version its predecessor.
pub(crate) struct Resolved {
    spec: Spec,
    payload: Vec<u8>,
    previous: Option<Hash32>,
}

fn object_id_of(hex_id: &str) -> Result<ObjectId> {
    unhex(hex_id)
        .and_then(|bytes| ObjectId::from_slice(&bytes).ok())
        .ok_or_else(|| Fault::plain(format!("not an object id: {hex_id}")))
}

fn session_id_of(hex_id: &str) -> Result<SessionId> {
    unhex(hex_id)
        .and_then(|bytes| SessionId::from_slice(&bytes).ok())
        .ok_or_else(|| Fault::plain("not a session id"))
}

fn with_schema(payload: &str, more: &[(&str, Value)]) -> Result<Vec<u8>> {
    let mut object: Map<String, Value> = serde_json::from_str(payload)?;
    object.insert("schema_version".into(), json!(SCHEMA_VERSION));
    for (key, value) in more {
        object.insert((*key).into(), value.clone());
    }
    Ok(serde_json::to_vec(&object)?)
}

/// Fills in what only the model knows: for a later version, the version it follows and its number.
pub(crate) fn resolve(core: &Core, _session: &str, spec: &Spec) -> Result<Resolved> {
    let (payload, previous) = match spec {
        Spec::SessionChat { payload }
        | Spec::CardChat { payload, .. }
        | Spec::Request { payload, .. } => (with_schema(payload, &[])?, None),
        Spec::Register { .. } => (Vec::new(), None),
        Spec::First { payload, .. } => (
            with_schema(
                payload,
                &[
                    ("object_version", json!(1)),
                    ("previous_version_hash", json!(Hash32::ZERO.to_base64url())),
                ],
            )?,
            None,
        ),
        Spec::Later {
            object,
            object_type,
            payload,
            ..
        } => {
            let current = if *object_type == ObjectType::Artifact.byte() {
                core.model
                    .published
                    .get(object)
                    .map(|p| (p.version_hash.clone(), p.object_version))
            } else {
                core.model
                    .cards
                    .get(object)
                    .and_then(|c| Some((c.version_hash.clone()?, c.object_version)))
            };
            let (hash, version) = current.ok_or_else(|| {
                Fault::plain(format!(
                    "{object} is not on the board yet: the hub has not confirmed it"
                ))
            })?;
            let previous = Hash32::from_base64url(&hash)?;
            (
                with_schema(
                    payload,
                    &[
                        ("object_version", json!(version + 1)),
                        ("previous_version_hash", json!(hash)),
                    ],
                )?,
                Some(previous),
            )
        }
    };
    Ok(Resolved {
        spec: spec.clone(),
        payload,
        previous,
    })
}

/// The core's draft for a resolved spec.
pub(crate) fn draft(
    vault: &mut Vault,
    group: &GroupId,
    resolved: &Resolved,
    _seat: Option<&str>,
    files: &[String],
) -> Result<Draft> {
    let session = group
        .session_id()
        .ok_or_else(|| Fault::new("forbidden", "not a session group"))?;
    let urgency = |byte: u8| Urgency::from_byte(byte).unwrap_or(Urgency::Normal);
    let object_type = |byte: u8| ObjectType::from_byte(byte);
    let draft = match &resolved.spec {
        Spec::SessionChat { .. } => Draft::session_chat(session, DeviceId::ZERO, &resolved.payload),
        Spec::CardChat { card, .. } => {
            Draft::card_chat(object_id_of(card)?, DeviceId::ZERO, &resolved.payload)
        }
        Spec::Register { name, value } => vault.register_draft(group, name, value.as_deref())?,
        Spec::First {
            object_type: kind,
            urgency: level,
            push,
            ..
        } => {
            let draft =
                Draft::first_version(object_type(*kind)?, urgency(*level), &resolved.payload)?;
            if *push {
                draft.with_push()
            } else {
                draft
            }
        }
        Spec::Later {
            object,
            object_type: kind,
            closed,
            urgency: level,
            push,
            ..
        } => {
            let previous = resolved
                .previous
                .ok_or_else(|| Fault::new("internal", "a later version without its predecessor"))?;
            let draft = Draft::later_version(
                object_id_of(object)?,
                object_type(*kind)?,
                *closed,
                urgency(*level),
                previous,
                &resolved.payload,
            )?;
            if *push {
                draft.with_push()
            } else {
                draft
            }
        }
        Spec::Request {
            urgency: level,
            expires_at,
            ..
        } => Draft::request(urgency(*level), *expires_at, &resolved.payload).with_push(),
    };
    let ids: Vec<FileId> = files
        .iter()
        .filter_map(|id| FileId::from_base64url(id).ok())
        .collect();
    Ok(if ids.is_empty() {
        draft
    } else {
        draft.with_files(ids)
    })
}

/// The file ids an item's attachments name: what its header lists (11.2).
fn file_ids_of(fields: &Map<String, Value>) -> Vec<String> {
    let mut ids = Vec::new();
    for attachment in fields
        .get("attachments")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        for key in ["file_id", "poster_file_id"] {
            if let Some(id) = attachment.get(key).and_then(Value::as_str) {
                if FileId::from_base64url(id).is_ok() && !ids.iter().any(|known| known == id) {
                    ids.push(id.to_string());
                }
            }
        }
    }
    ids
}

fn urgency_byte(name: &str) -> u8 {
    urgency_of(name).byte()
}

impl Client {
    /// A Chat message: in the Chat of the card `object_id`, or of the session (the main one for none).
    pub async fn send_message(
        &self,
        mut fields: Map<String, Value>,
        object_id: Option<String>,
        session_id: Option<String>,
    ) -> Result<SentInfo> {
        fields.insert("content_type".into(), json!("message"));
        // A file belongs to the first object that names it (11.3): a message that shows an Artifact names the
        // Artifact, not its files.
        let files = if fields.contains_key("artifact_object_id") {
            Vec::new()
        } else {
            file_ids_of(&fields)
        };
        let payload = Value::Object(fields).to_string();
        match object_id {
            Some(card) => {
                let session = {
                    let core = self.core.lock().await;
                    core.model
                        .cards
                        .get(&card)
                        .and_then(|c| c.session_id.clone())
                };
                self.send(session.as_deref(), Spec::CardChat { card, payload }, files)
                    .await
            }
            None => {
                self.send(session_id.as_deref(), Spec::SessionChat { payload }, files)
                    .await
            }
        }
    }

    /// A new card. `fields` is its content with `urgency`; returns the card's id.
    pub async fn send_card(
        &self,
        mut fields: Map<String, Value>,
        session_id: Option<String>,
    ) -> Result<String> {
        let urgency = fields
            .remove("urgency")
            .and_then(|v| v.as_str().map(urgency_byte))
            .unwrap_or(Urgency::Normal.byte());
        let files = file_ids_of(&fields);
        let spec = Spec::First {
            object_type: ObjectType::Card.byte(),
            urgency,
            push: true,
            payload: Value::Object(fields).to_string(),
        };
        let sent = self.send(session_id.as_deref(), spec, files).await?;
        sent.object_id
            .ok_or_else(|| Fault::new("internal", "a card without an id"))
    }

    /// A new version of a card of this agent: its content with `changes` laid over it.
    async fn version(
        &self,
        object_id: &str,
        changes: Map<String, Value>,
        closed: bool,
        urgency: Option<String>,
        push: bool,
    ) -> Result<()> {
        let (mut content, session, level) = {
            let core = self.core.lock().await;
            let card = core
                .model
                .cards
                .get(object_id)
                .ok_or_else(|| Fault::plain(format!("no card {object_id}")))?;
            (
                card.content.clone(),
                card.session_id.clone(),
                urgency.unwrap_or_else(|| card.urgency.clone()),
            )
        };
        for (key, value) in changes {
            content.insert(key, value);
        }
        for key in [
            "schema_version",
            "object_version",
            "previous_version_hash",
            "urgency",
        ] {
            content.remove(key);
        }
        if !URGENCIES.contains(&level.as_str()) {
            return Err(Fault::plain(format!("not an urgency: {level}")));
        }
        let files = file_ids_of(&content);
        let spec = Spec::Later {
            object: object_id.to_string(),
            object_type: ObjectType::Card.byte(),
            closed,
            urgency: urgency_byte(&level),
            push,
            payload: Value::Object(content).to_string(),
        };
        self.send(session.as_deref(), spec, files).await.map(|_| ())
    }

    /// Reworks an open card.
    pub async fn revise(
        &self,
        object_id: &str,
        changes: Map<String, Value>,
        urgency: Option<String>,
    ) -> Result<()> {
        self.version(object_id, changes, false, urgency, true).await
    }

    /// Changes an open card's urgency.
    pub async fn set_urgency(
        &self,
        object_id: &str,
        urgency: &str,
        reason: Option<Value>,
    ) -> Result<()> {
        let mut changes = Map::new();
        changes.insert("urgency_reason".into(), reason.unwrap_or(Value::Null));
        self.version(object_id, changes, false, Some(urgency.into()), false)
            .await
    }

    /// Takes an open card away.
    pub async fn withdraw(&self, object_id: &str, reason: &str) -> Result<()> {
        let mut changes = Map::new();
        changes.insert("withdraw_reason".into(), json!(reason));
        self.version(object_id, changes, true, None, false).await
    }

    /// Closes a card with a summary of what was done.
    pub async fn close(&self, object_id: &str, summary: &str) -> Result<()> {
        let mut changes = Map::new();
        changes.insert("close_summary".into(), json!(summary));
        self.version(object_id, changes, true, None, false).await
    }

    /// One new card in place of several open ones, which are closed as merged into it.
    pub async fn merge(
        &self,
        object_ids: &[String],
        mut fields: Map<String, Value>,
        session_id: Option<String>,
    ) -> Result<String> {
        fields.insert("merged_from_object_ids".into(), json!(object_ids));
        let id = self.send_card(fields, session_id).await?;
        for old in object_ids {
            let mut changes = Map::new();
            changes.insert("merged_into_object_id".into(), json!(id));
            self.version(old, changes, true, None, false).await?;
        }
        Ok(id)
    }

    /// Publishes an Artifact: a Page (HTML) or Media, with its file. Returns its id.
    pub async fn publish(
        &self,
        attachments: Value,
        title: Value,
        note: Option<Value>,
        session_id: Option<String>,
    ) -> Result<String> {
        let page = attachments
            .get(0)
            .and_then(|a| a.get("media_type"))
            .and_then(Value::as_str)
            == Some("text/html");
        let mut fields = Map::new();
        fields.insert(
            "artifact_type".into(),
            json!(if page { "page" } else { "media" }),
        );
        fields.insert("title".into(), title);
        fields.insert("note".into(), note.unwrap_or(Value::Null));
        fields.insert("attachments".into(), attachments);
        let files = file_ids_of(&fields);
        let spec = Spec::First {
            object_type: ObjectType::Artifact.byte(),
            urgency: Urgency::Normal.byte(),
            push: false,
            payload: Value::Object(fields).to_string(),
        };
        let sent = self.send(session_id.as_deref(), spec, files).await?;
        sent.object_id
            .ok_or_else(|| Fault::new("internal", "an Artifact without an id"))
    }

    /// Revokes an Artifact: a closed version; the hub deletes its files and ends its Share links (11.4).
    pub async fn unpublish(&self, object_id: &str) -> Result<()> {
        let (session, content) = {
            let core = self.core.lock().await;
            let p = core
                .model
                .published
                .get(object_id)
                .ok_or_else(|| Fault::plain(format!("no asset {object_id}")))?;
            let content = json!({
                "artifact_type": p.artifact_type, "title": p.title, "note": p.note,
                "attachments": p.attachments,
            });
            (p.session_id.clone(), content)
        };
        let files = content.as_object().map(file_ids_of).unwrap_or_default();
        let spec = Spec::Later {
            object: object_id.to_string(),
            object_type: ObjectType::Artifact.byte(),
            closed: true,
            urgency: Urgency::Normal.byte(),
            push: false,
            payload: content.to_string(),
        };
        self.send(session.as_deref(), spec, files).await.map(|_| ())
    }

    /// Sets registers of this agent in a session: `profile`, `status_line/<id>`, `device/<id>`, `heard`. A
    /// null value deletes the name.
    pub async fn set_status(
        &self,
        values: Map<String, Value>,
        session_id: Option<String>,
    ) -> Result<SentInfo> {
        let mut last = SentInfo::default();
        for (name, value) in values {
            let value = (!value.is_null()).then(|| value.to_string());
            let spec = Spec::Register { name, value };
            last = self.send(session_id.as_deref(), spec, Vec::new()).await?;
        }
        Ok(last)
    }

    /// Writes this device's label (`device/<id>`: name, platform, folder, host) into its main session, unless
    /// it stands there already.
    pub async fn ensure_device_register(&self, info: &Value) -> Result<()> {
        let name = format!("device/{}", self.me());
        let group = self.core.lock().await.group_of(None)?;
        let me = self.device_id();
        let lookup = name.clone();
        let held = self
            .vault
            .call(move |v: &mut Vault| v.register_of(&group, &lookup, &me))
            .await?;
        if held.as_deref() == Some(info.to_string().as_str()) {
            return Ok(());
        }
        let mut values = Map::new();
        values.insert(name, info.clone());
        self.set_status(values, None).await.map(|_| ())
    }

    /// Notes up to which change of a human's messages this agent has been handed them.
    pub async fn mark_heard(&self, up_to: u64, session_id: Option<String>) -> Result<bool> {
        let sid = {
            let core = self.core.lock().await;
            session_id.clone().or_else(|| core.session_id())
        };
        let known = {
            let core = self.core.lock().await;
            sid.as_ref()
                .and_then(|sid| core.model.sessions.get(sid))
                .and_then(|s| s.heard_up_to)
        };
        if known.is_some_and(|known| known >= up_to) {
            return Ok(false);
        }
        let mut values = Map::new();
        values.insert("heard".into(), json!({ "up_to": up_to }));
        self.set_status(values, session_id).await?;
        Ok(true)
    }

    /// Asks the human to allow a tool call: a permission request that expires. Returns its id.
    pub async fn request_permission(
        &self,
        tool_name: &str,
        description: &str,
        input_preview: &str,
        expires_in_ms: u64,
        session_id: Option<String>,
    ) -> Result<String> {
        let payload = json!({
            "tool_name": tool_name, "description": description, "input_preview": input_preview,
        });
        let spec = Spec::Request {
            urgency: Urgency::High.byte(),
            expires_at: now_ms() + expires_in_ms,
            payload: payload.to_string(),
        };
        let sent = self.send(session_id.as_deref(), spec, Vec::new()).await?;
        sent.object_id
            .ok_or_else(|| Fault::new("internal", "a request without an id"))
    }

    /// A permission request has no later version in protocol v2: one that was answered in the terminal stays
    /// on the board until it expires, and a verdict that still comes for it is dropped by the connector.
    pub async fn withdraw_permission(&self, _object_id: &str, _reason: &str) -> Result<bool> {
        Ok(false)
    }

    /// Opens a helper session under this agent's main session (5.2.5): the agent founds its group itself, with
    /// every human device of the room, and writes the helper's profile into it. Returns the session id.
    pub async fn open_child_session(&self, profile: Map<String, Value>) -> Result<String> {
        let session = {
            let mut core = self.core.lock().await;
            let main = core
                .session_id()
                .ok_or_else(|| Fault::new("no-session", "this agent has no session yet"))?;
            let parent = session_id_of(&main)?;
            let humans: Vec<DeviceId> = self
                .vault
                .call(|v: &mut Vault| {
                    v.device
                        .room_history()
                        .map(|h| h.newest().humans.iter().copied().collect())
                        .unwrap_or_default()
                })
                .await?;
            if humans.is_empty() {
                return Err(Fault::new(
                    "room-behind",
                    "the room's devices are not known yet",
                ));
            }
            // A claim is all or nothing; a founding that fails is tried again with fresh KeyPackages.
            let claimed = self
                .hub
                .post(
                    "/v2/key-packages/claim",
                    &json!({ "devices": humans.iter().map(DeviceId::to_base64url).collect::<Vec<_>>() }),
                )
                .await?;
            let mut packages = Vec::new();
            for human in &humans {
                let by_device = claimed.get("key_packages").unwrap_or(&Value::Null);
                packages.push(unb64(by_device, &human.to_base64url())?);
            }
            let now = now_ms();
            let (session, outbox_id) = self
                .vault
                .call(move |v: &mut Vault| -> Result<(SessionId, u64)> {
                    let session = v.device.found_helper(&parent, &packages, now)?;
                    let id = v.device.outbox().last().map_or(0, |entry| entry.id);
                    Ok((session, id))
                })
                .await??;
            core.commit()?;
            self.pump(&mut core).await?;
            if let Some(fault) = Self::take_refusal(&mut core, outbox_id) {
                return Err(fault);
            }
            let sid = hex(session.as_bytes());
            if !core.groups.contains_key(&sid) {
                return Err(Fault::new(
                    "offline",
                    "the helper session waits for the hub; try again when the hub is back",
                ));
            }
            sid
        };
        let mut values = Map::new();
        values.insert("profile".into(), Value::Object(profile));
        self.set_status(values, Some(session.clone())).await?;
        Ok(session)
    }

    /// Adds a helper device to a helper session this agent opened (5.2.4), with the KeyPackage the device
    /// handed over outside the hub: a subagent that runs a connector of its own.
    pub async fn admit_helper(
        &self,
        session_id: &str,
        device: DeviceId,
        key_package: Vec<u8>,
    ) -> Result<()> {
        let mut core = self.core.lock().await;
        let group = core.group_of(Some(session_id))?;
        let now = now_ms();
        let outbox_id = self
            .vault
            .call(move |v: &mut Vault| v.device.add_to_session(&group, &device, &key_package, now))
            .await??;
        core.commit()?;
        self.pump(&mut core).await?;
        match Self::take_refusal(&mut core, outbox_id) {
            Some(fault) => Err(fault),
            None => Ok(()),
        }
    }

    /// Lets a helper device that lost its state back into a helper session (5.3.5): the opener removes the
    /// old leaf with its Cut, adds the new device with the KeyPackage it handed over outside the hub, and
    /// hands it the session's keys.
    pub async fn readmit_helper(
        &self,
        session_id: &str,
        old: DeviceId,
        device: DeviceId,
        key_package: Vec<u8>,
    ) -> Result<()> {
        let mut core = self.core.lock().await;
        let group = core.group_of(Some(session_id))?;
        let now = now_ms();
        let (outbox_id, cut) = self
            .vault
            .call(move |v: &mut Vault| -> Result<(u64, Cut)> {
                let head = v.head_of(&group, &old);
                let cut = Cut {
                    device: old,
                    seq: head.seq,
                    hash: head.hash,
                };
                let id = v
                    .device
                    .readmit_helper(&group, cut, &device, &key_package, now)?;
                Ok((id, cut))
            })
            .await??;
        Self::remember_cuts(&core, outbox_id, &[cut]);
        core.commit()?;
        self.pump(&mut core).await?;
        if let Some(fault) = Self::take_refusal(&mut core, outbox_id) {
            return Err(fault);
        }
        self.vault
            .call(move |v: &mut Vault| v.device.send_handover(&group, &device))
            .await??;
        core.commit()?;
        self.pump(&mut core).await
    }

    /// One step of the running turn's work trail (7.3): an MLS message in the session's group, numbered from 1
    /// within `turn`. `step` is JSON `{ text, tool? }`.
    pub async fn work_step(
        &self,
        session_id: Option<&str>,
        turn: [u8; 16],
        number: u32,
        step: &Value,
    ) -> Result<()> {
        let mut core = self.core.lock().await;
        let group = core.group_of(session_id)?;
        // The step's body as the core writes and checks it (`{ text, tool? }`, with its limits).
        let step = trommi_core::trail::WorkStep {
            text: step
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            tool: step.get("tool").and_then(Value::as_str).map(str::to_owned),
        }
        .encode()?;
        let now = now_ms();
        self.vault
            .call(move |v: &mut Vault| {
                v.device
                    .send_work_trail(&group, &TurnId::new(turn), number, &step, now)
            })
            .await??;
        core.commit()?;
        self.pump(&mut core).await
    }

    /// Encrypts a file under a fresh key (section 11), stores it at the hub and returns the attachment
    /// reference for a body: `file_id`, `file_key`, `sha256`, `total_size` and what `meta` says of it.
    pub async fn upload_attachment(
        &self,
        bytes: Vec<u8>,
        meta: Map<String, Value>,
    ) -> Result<Map<String, Value>> {
        let (stored, sealed) = files::encrypt_file(&bytes, &mut SystemEntropy)?;
        let file_id = sealed.file.file_id.to_base64url();
        self.hub.put_file(&file_id, stored).await?;
        let mut reference = meta;
        reference.insert("file_id".into(), json!(file_id));
        reference.insert(
            "file_key".into(),
            json!(String::from_utf8_lossy(
                sealed.file.file_key_base64url().expose()
            )),
        );
        reference.insert("sha256".into(), json!(sealed.file.sha256.to_base64url()));
        reference.insert("total_size".into(), json!(sealed.plain_len));
        let mut core = self.core.lock().await;
        core.files.push((file_id, bytes));
        if core.files.len() > 16 {
            core.files.remove(0);
        }
        Ok(reference)
    }

    /// Fetches the file an attachment reference names and opens it: the stored bytes are compared with the
    /// reference's SHA-256 before anything is decrypted (11.2).
    pub async fn fetch_attachment(&self, reference: &Value) -> Result<Vec<u8>> {
        let text = |key: &str| reference.get(key).and_then(Value::as_str).unwrap_or("");
        let file = FileRef::from_base64url(text("file_id"), text("file_key"), text("sha256"))?;
        let file_id = file.file_id.to_base64url();
        if let Some((_, bytes)) = self
            .core
            .lock()
            .await
            .files
            .iter()
            .find(|(id, _)| *id == file_id)
        {
            return Ok(bytes.clone());
        }
        let stored = self
            .hub
            .get_file(&file_id, files::MAX_STORED_LEN as usize)
            .await?;
        Ok(files::decrypt_file(&file, &stored)?)
    }

    /// A Share link for one file of an open Artifact (11.5): `(share_id, link, expires_at)`. The link holds
    /// the secret and the key; the hub gets the secret's hash.
    pub async fn share_attachment(
        &self,
        reference: &Value,
        expires_at: u64,
    ) -> Result<(String, String, u64)> {
        let text = |key: &str| reference.get(key).and_then(Value::as_str).unwrap_or("");
        let file = FileRef::from_base64url(text("file_id"), text("file_key"), text("sha256"))?;
        let app = self.core.lock().await.room.app.clone();
        let link = ShareLink::create(&app, &file, &mut SystemEntropy)?;
        let share_id = link.share_id.to_base64url();
        let body = json!({
            "share_id": share_id,
            "secret_hash": b64(&crate::util::sha256(link.secret.expose())),
            "file_id": file.file_id.to_base64url(),
            "expires_at": expires_at,
        });
        let answer = self.hub.post("/v2/shares", &body).await?;
        let until = answer
            .get("expires_at")
            .and_then(Value::as_u64)
            .unwrap_or(expires_at);
        let text = String::from_utf8_lossy(link.to_text().expose()).into_owned();
        Ok((share_id, text, until))
    }

    /// Ends a Share link.
    pub async fn revoke_share(&self, share_id: &str) -> Result<()> {
        if trommi_core::ids::ShareId::from_base64url(share_id).is_err() {
            return Err(Fault::plain("not a share id"));
        }
        self.hub
            .delete(&format!("/v2/shares/{share_id}"))
            .await
            .map(|_| ())
    }
}
