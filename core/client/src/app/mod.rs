//! The App: one object per room on a device, and the whole of the app's logic. Sans-I/O: [`App::handle`] takes one
//! [`Event`] and the shell's clock and answers with [`Effect`]s. It does no I/O, reads no clock, starts no thread
//! and holds no callback. Every shell (web worker, iOS, Linux, a test) drives it the same way:
//!
//! ```text
//! shell                                 App
//!   Event::Start{config}         ──▶   handle(now, event) ──▶ [Render, Store{DeviceLoad}, …]
//!   runs the effects, in order
//!   Event::Store{id, result}     ──▶   handle(now, event) ──▶ [Render, Http{…}, OpenStream{…}, Timer{…}]
//!   Event::Http / Stream / Wake  ──▶   …
//!   Event::Action{action}        ──▶   …  (the person did something)
//! ```
//!
//! core/client/README.md, "The app core", is the contract in words: the order of effects, errors and retries,
//! threads per platform, the stored format, and what a shell may and may not do.
//!
//! This is W0's skeleton: it starts, reads the device state, and shows `SignedOut` or `Opening`. W1 (engine), W3
//! (actions, account) and W4 (views) fill it in behind this same surface.

pub mod bytes;
pub mod edge;
pub mod effect;
pub mod event;
pub mod io;
mod invites;
mod account_steps;
mod departures;
mod account_change;
mod teams;
mod outside;
mod past;
pub mod push;
mod selfjoin;
mod kit;
mod shared;
mod import;
mod start;
mod seen;
mod ways;
pub use shared::SHARED_FILE;
pub mod script;
pub mod sim;

pub use bytes::Bytes;
pub use effect::{Effect, LogLevel, Notice, NotifyContext, NotifyKey, WaitingCard, WaitingOption, WidgetSnapshot};
pub use outside::WAITING_MAX;
pub use event::{Abilities, Config, Event};
pub use io::{
    DeviceEntry, Entry, Header, HttpClass, HttpRequest, HttpResponse, IoError, IoErrorKind, IoId,
    IoResult, PlatformAnswer, PlatformOp, SecretOp, StoreAnswer, StoreOp, StreamItem,
};

use crate::actions::run::{Doing, NotDone};
use crate::actions::sent::{NoteNext, Sent};
use crate::actions::{self, Action};
use crate::engine::{self, Connection, Engine, Jitter, OpenError, Report};
use crate::model::change::Change;
use crate::views::{Lens, Phase, Screen, ViewModel};
use std::collections::BTreeMap;

/// The hub of a shell that names none.
pub const DEFAULT_HUB: &str = "https://hub.trommi.com";
/// At most so many of the engine's alerts are kept for the views.
const ALERTS_MAX: usize = 200;

/// A device that closed itself is opened again in place at most so many times in a row (the count starts anew once
/// it is live again, or the app comes to the front).
pub const REOPEN_TRIES: u32 = 3;
/// At most so many invites with a Request wait for the invite flow.
const INVITE_REQUESTS_MAX: usize = 64;

/// What a piece of I/O in flight was for.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Pending {
    DeviceLoad,
    DepartureLoad,
    DepartureSave(String),
    DepartureHttp(String, crate::hub::Expect),
    DepartureDelete(String),
    /// A cache entry deleted (a file the hub evicted): nothing waits for it.
    CacheDelete,
    /// The stored room's hub, read at the start when `Config.hub` names none ([`ROOM_KEY`]).
    RoomKey,
    /// The login of a sign-in (`account::signin`).
    Login,
    /// The stored room's hub written by a join with the code.
    RoomKeyWrite,
    /// The device state read for a join with the code ([`App::join_room`]).
    JoinLoad,
    /// The device state read for a founding (`AccountAction::Found`).
    FoundLoad,
    /// The cache space read to wipe it (a sign-out).
    Wipe,
    /// Names of private cache entries to erase, after public notices are validated.
    WipeKeys,
    /// The durable deletion of the slot: failure must remain visible after its engine was forgotten.
    ForgetWrite,
    /// The device state read for a join by an invite link (`AccountAction::Join`).
    LinkLoad,
    /// The challenge of a founding with a passkey: the hub, the e-mail given.
    FoundChallenge(String, Option<String>),
    /// The platform's new passkey for a founding: the hub, the e-mail, the account id the challenge named.
    FoundPasskey(String, Option<String>, String),
    /// The challenge of a sign-in with a passkey, at this hub.
    PasskeyChallenge(String),
    /// The platform's passkey for a sign-in at this hub.
    PasskeyGet(String),
    /// I/O of an engine that was dropped (a join of the room that failed): its answer is only logged.
    Dropped,
    /// A Share link's file (`app::shared`).
    Shared,
    /// A file of the demo room, by its address.
    DemoFile(crate::files::DemoOpen),
    /// The Chat list's read marks, read from the cache and written to it (`app::seen`).
    SeenRead,
    SeenWrite,
}

/// The app store's key that names the room of this slot and its hub: written by a join with the code before the
/// device's first write, read at the start when `Config.hub` is empty.
pub const ROOM_KEY: &str = "room";

#[derive(serde::Serialize, serde::Deserialize)]
struct RoomKey {
    v: u32,
    hub: String,
    room: String,
}

pub struct App {
    config: Option<Config>,
    next_id: u64,
    pending: BTreeMap<IoId, Pending>,
    /// The view model as the core decides it now.
    next_view: ViewModel,
    /// The view model as the shell has it (what was rendered so far).
    view: ViewModel,
    rendered_once: bool,
    /// The App's own draws (the waits before a closed device is opened again); the engine draws its own.
    jitter: Jitter,
    /// The sync engine, once the stored device opened.
    engine: Option<Engine>,
    departures: departures::Departures,
    logout_requested: bool,
    /// The timer the shell holds.
    timer: Option<u64>,
    /// What the engine reported for the person (until the views show them: W4).
    alerts: Vec<engine::Alert>,
    sessions_not_joined: Option<Vec<(trommi_core::ids::GroupId, &'static str)>>,
    /// How the last join of the room with the code stands; none before one.
    room_join: Option<engine::room_join::RoomJoinStatus>,
    /// A join of the room asked for, waiting for the device state it is made on.
    room_join_wait: Option<(IoId, engine::room_join::RoomJoin)>,
    /// A founding waiting for the device state, then for the hub (`account::found`); its kit's words are shown once
    /// the hub took it.
    founding: Option<(Option<IoId>, crate::account::found::Founding)>,
    /// A join by an invite link waiting for the slot's device state (the link holds the invite's secret).
    linking: Option<crate::account::Secret>,
    /// A sign-in waiting for its login answer.
    signing_in: Option<(IoId, crate::account::signin::Waiting)>,
    /// The Share link being opened (`app::shared`).
    shared_ask: Option<(trommi_core::files::ShareLink, crate::hub::Expect)>,
    /// A sign-in's join of the room runs: its end is shown on the account's screen.
    signed_in_join: bool,
    /// The actions' requests answered since they were last taken.
    answers: Vec<engine::requests::Answered>,
    /// Files attached, opened, saved and shared (`crate::files`).
    files: crate::files::Files,
    imports: BTreeMap<String, import::Import>,
    /// Invites this device opened (`app::invites`).
    invites: invites::Invites,
    /// The account's steps in flight (`app::account_steps`).
    steps: account_steps::Steps,
    changes: account_change::Changes,
    teams: teams::TeamDeletes,
    push: push::Push,
    /// Widgets, local notifications, the notification extension (`app::outside`).
    outside: outside::Outside,
    /// The demo room runs (`Config.demo`): no hub, no store.
    demo: bool,
    /// Notes this run delivered (their closing version is on its way).
    notes_went: std::collections::BTreeSet<String>,
    /// A recovery (`AccountAction::Recover`) waiting for its login: the new kit's words and the sealer of the
    /// account's new copies; then the words, shown once the room is recovered.
    recover_with: Option<(Vec<String>, engine::recover::Copies)>,
    recovered_kit: Option<Vec<String>>,
    /// Agents' asks to let in a new session of their machine (`app::selfjoin`).
    selfjoin: selfjoin::SelfJoin,
    /// The Emergency Kit's flag and sheet (`app::kit`).
    kit: kit::Kit,
    /// Actions that write the room's registers, held while the device catches up: a register written before the
    /// device read the newest value would lose to an older one read later (its write counter is too low).
    held_actions: Vec<Action>,
    /// The hub the stored room names ([`ROOM_KEY`]).
    stored_hub: Option<String>,
    /// The device state loaded, while the stored room's hub is read.
    opening: Option<(u64, Vec<DeviceEntry>)>,
    /// The board model, fed from the engine's reports.
    board: engine::feed::Board,
    /// What this device alone chooses: the team and the pages in view, the zone (`Event::Focus`, `Event::Zone`).
    lens: Lens,
    /// The board's units are to be made again: the model, the lens or the clock moved.
    stale_views: bool,
    /// When the board's units change by the clock alone.
    view_wake: Option<u64>,
    /// The device's source of randomness when it is not the system's (a seeded test).
    entropy: Option<Box<dyn trommi_core::crypto::Entropy + Send>>,
    /// Invites of this room a newcomer sent its Request for, oldest first (the invite flow reads them: W3).
    invite_requests: Vec<trommi_core::ids::InviteId>,
    /// The device closed itself (a failed write, a failure of its own): when the stored state is read again, and
    /// how often it was in a row.
    reopen_at: Option<u64>,
    reopen_tries: u32,
    /// The actions in flight: their outbox entries and echoes (`actions::sent`).
    sent: Sent,
    /// The room's cache: read before the engine starts, written behind the board (`cache::keeper`).
    cache: Option<crate::cache::Keeper>,
    /// The model moved: the sessions' goals and knowledge are compared with their teams' once live (`Doing::sync_goals`,
    /// `Doing::sync_knowledge`).
    goals_check: bool,
    /// The Scribble Boards read on this device (`crate::scribble`).
    scribble: crate::scribble::Scribble,
    /// The past read on demand: a session's or a card's history, the starred cards (`app::past`).
    past: past::Past,
    /// The note `KeepNote` made last on this device (`app::ways`).
    made_note: Option<String>,
    /// What the Chat list counts as read, kept in the cache (`app::seen`).
    seen: seen::Seen,
}

impl Default for App {
    fn default() -> Self {
        Self::new()
    }
}

impl App {
    pub fn new() -> Self {
        App {
            config: None,
            next_id: 1,
            pending: BTreeMap::new(),
            next_view: ViewModel::default(),
            view: ViewModel::default(),
            rendered_once: false,
            jitter: Jitter::new(0),
            engine: None,
            departures: Default::default(),
            logout_requested: false,
            timer: None,
            alerts: Vec::new(),
            sessions_not_joined: None,
            room_join: None,
            room_join_wait: None,
            signing_in: None,
            shared_ask: None,
            founding: None,
            linking: None,
            signed_in_join: false,
            stored_hub: None,
            answers: Vec::new(),
            files: crate::files::Files::default(),
            imports: BTreeMap::new(),
            invites: invites::Invites::default(),
            steps: account_steps::Steps::default(),
            changes: account_change::Changes::default(),
            teams: teams::TeamDeletes::default(),
            push: push::Push::default(),
            outside: outside::Outside::default(),
            demo: false,
            notes_went: Default::default(),
            recover_with: None,
            recovered_kit: None,
            selfjoin: selfjoin::SelfJoin::default(),
            kit: kit::Kit::default(),
            held_actions: Vec::new(),
            opening: None,
            board: engine::feed::Board::default(),
            lens: Lens::default(),
            stale_views: false,
            view_wake: None,
            entropy: None,
            invite_requests: Vec::new(),
            reopen_at: None,
            reopen_tries: 0,
            sent: Sent::default(),
            cache: None,
            goals_check: false,
            scribble: crate::scribble::Scribble::default(),
            past: past::Past::default(),
            made_note: None,
            seen: seen::Seen::default(),
        }
    }

    /// An App whose device draws its randomness from `entropy` and not from the system: for a test that must
    /// repeat exactly. A shipped app uses [`App::new`].
    pub fn with_entropy(entropy: Box<dyn trommi_core::crypto::Entropy + Send>) -> Self {
        App {
            entropy: Some(entropy),
            ..Self::new()
        }
    }

    /// The board model as the engine's reports left it (the views are made from it: W4).
    pub fn board(&self) -> &engine::feed::Board {
        &self.board
    }

    /// The sync engine, once the stored device opened.
    pub fn engine(&self) -> Option<&Engine> {
        self.engine.as_ref()
    }

    /// An action on the device (seal, commit, answer) at the shell's clock: what it wrote is stored before anything
    /// it implies is sent, and the outbox is pumped. The actions (W3) go through this; `None` without a device.
    pub fn act<T>(
        &mut self,
        now_ms: u64,
        action: impl FnOnce(&mut engine::Device, u64) -> Result<T, trommi_core::Error>,
    ) -> (Option<Result<T, trommi_core::Error>>, Vec<Effect>) {
        let mut out = Vec::new();
        let result = self.with_engine(now_ms, &mut out, |engine, ctx| engine.act(ctx, action));
        self.after_engine(now_ms, &mut out);
        self.render(&mut out);
        (result, out)
    }

    /// Joins the live session groups of a sign-in with the code (`engine::sync::joins`): read and posted together.
    /// The sign-in's flow calls this once the device is in the room; nothing happens without a device.
    pub fn join_sessions(&mut self, now_ms: u64, joins: engine::sync::joins::SessionJoins) -> Vec<Effect> {
        let mut out = Vec::new();
        self.with_engine(now_ms, &mut out, |engine, ctx| engine.join_sessions(ctx, joins));
        self.after_engine(now_ms, &mut out);
        self.render(&mut out);
        out
    }

    /// Joins the room with the recovery code (`engine::room_join`), on a slot without a device in a room: the
    /// device is made (or a join posted earlier goes on), the room read and checked, the join posted, and then the
    /// session groups joined with the same keys ([`App::sessions_not_joined`]). How it stands: [`App::room_join`].
    /// The keys stay in the core and are dropped when the sessions are through.
    pub fn join_room(&mut self, now_ms: u64, join: engine::room_join::RoomJoin) -> Vec<Effect> {
        use engine::room_join::{RoomJoinError, RoomJoinStatus, RoomJoinStep};
        let mut out = Vec::new();
        if self.config.is_none() {
            out.push(log(LogLevel::Warn, "join_room: before start"));
            return out;
        }
        if self.can_resume_sign_in() && join.recover.is_none() {
            let matches = self.engine.as_ref().is_some_and(|e| e.room() == join.room && e.hub() == join.hub);
            if matches {
                self.signed_in_join = true;
                let result = self.with_engine(now_ms, &mut out, |engine, ctx| engine.resume_room(ctx, join.keys));
                if let Some(Err(error)) = result { self.room_join = Some(RoomJoinStatus::Failed(error)); }
                self.after_engine(now_ms, &mut out);
                self.render(&mut out);
                return out;
            }
        }
        let canonical = trommi_core::hub_auth::HubAddress::parse(&join.hub).is_ok_and(|a| a.as_str() == join.hub);
        self.room_join = Some(if self.engine.is_some() {
            RoomJoinStatus::Failed(RoomJoinError::RoomExists)
        } else if !canonical {
            RoomJoinStatus::Failed(RoomJoinError::Refused("bad-hub"))
        } else {
            // the room's hub first: a device that exists is always found with its hub
            let key = RoomKey { v: 1, hub: join.hub.clone(), room: join.room.to_base64url() };
            let id = self.io(Pending::RoomKeyWrite);
            let value = serde_json::to_vec(&key).unwrap_or_default();
            out.push(Effect::Store { id, op: StoreOp::Put { put: vec![Entry { key: ROOM_KEY.into(), value: value.into() }], delete: Vec::new() } });
            let id = self.io(Pending::JoinLoad);
            out.push(Effect::Store { id, op: StoreOp::DeviceLoad });
            if let Some((old, _)) = self.room_join_wait.replace((id, join)) {
                self.pending.insert(old, Pending::Dropped);
            }
            RoomJoinStatus::Step(RoomJoinStep::Reading)
        });
        self.after_engine(now_ms, &mut out);
        self.render(&mut out);
        out
    }

    fn can_resume_sign_in(&self) -> bool {
        self.engine.as_ref().is_some_and(|engine| engine.stopped().is_none()) && self.sessions_not_joined.as_ref().is_some_and(|groups|
            groups.iter().any(|(_, code)| *code == "interrupted"))
    }

    /// An account action (`account`): the sign-ins here; the other flows are W3's.
    fn account(&mut self, now_ms: u64, action: crate::account::AccountAction, out: &mut Vec<Effect>) {
        use crate::account::signin::{self, By};
        use crate::account::AccountAction;
        if self.invite_action(now_ms, &action, out)
            || self.account_step(now_ms, &action, out)
            || self.selfjoin_action(now_ms, &action, out)
            || self.change_action(now_ms, &action, out)
        {
            return;
        }
        match action {
            AccountAction::KitKept => return self.kit_kept(now_ms, out),
            AccountAction::Found { email, password, hub } => return self.found(&email, &password, hub.as_deref(), out),
            AccountAction::SignInWithPasskey { hub } => return self.passkey_sign_in(hub.as_deref(), out),
            AccountAction::FoundWithPasskey { email, hub } => return self.found_with_passkey(email, hub.as_deref(), out),
            AccountAction::Join { link } => {
                if self.engine.is_some() || self.founding.is_some() || self.signing_in.is_some() || self.linking.is_some() {
                    out.push(log(LogLevel::Warn, "account: a join by link on a slot that has a device or is busy"));
                    return;
                }
                let id = self.io(Pending::LinkLoad);
                out.push(Effect::Store { id, op: StoreOp::DeviceLoad });
                self.linking = Some(link);
                self.next_view.account = crate::views::AccountView { step: "join".into(), ..Default::default() };
                return;
            }
            _ => {}
        }
        let (by, account, secret, hub) = match action {
            AccountAction::Recover { email, words, password, hub } => {
                match crate::account::found::recovery_copies(&email, &password, &mut trommi_core::crypto::SystemEntropy) {
                    Ok(made) => self.recover_with = Some(made),
                    Err(text) => {
                        self.next_view.account = crate::views::AccountView { step: "recover".into(), problem: Some(text), ..Default::default() };
                        return;
                    }
                }
                (By::Kit, email, words, hub)
            }
            AccountAction::SignIn { email, password, hub } => (By::Password, email, password, hub),
            AccountAction::SignInWithKit { email, words, hub } => (By::Kit, email, words, hub),
            other => {
                out.push(log(LogLevel::Debug, &format!("account: {other:?} is not handled here")));
                return;
            }
        };
        let Some(config) = self.config.as_ref() else { return };
        if (self.engine.is_some() && !self.can_resume_sign_in()) || self.room_join_wait.is_some() || self.signing_in.is_some() {
            out.push(log(LogLevel::Warn, "account: a sign-in on a slot that has a device or signs in already"));
            return;
        }
        let client = format!("{}/{}", config.platform, config.version);
        let begun = signin::hub_of(hub.as_deref(), &config.hub).and_then(|hub| signin::begin(hub, by, &account, &secret, &client));
        drop(secret);
        match begun {
            Ok((waiting, request)) => {
                let id = self.io(Pending::Login);
                self.signing_in = Some((id, waiting));
                self.next_view.account = crate::views::AccountView { step: "working".into(), ..Default::default() };
                out.push(Effect::Http { id, request });
            }
            Err(problem) => self.sign_in_failed(problem),
        }
    }

    /// `SignInWithPasskey`: the hub's challenge, then the platform's passkey, then the login (`login_answered`).
    fn passkey_sign_in(&mut self, hub: Option<&str>, out: &mut Vec<Effect>) {
        use crate::account::signin;
        let Some(config) = self.config.as_ref() else { return };
        if (self.engine.is_some() && !self.can_resume_sign_in()) || self.room_join_wait.is_some() || self.signing_in.is_some() {
            out.push(log(LogLevel::Warn, "account: a sign-in on a slot that has a device or signs in already"));
            return;
        }
        let client = format!("{}/{}", config.platform, config.version);
        match signin::hub_of(hub, &config.hub).and_then(|hub| signin::passkey_challenge(&hub, &client).map(|asked| (hub, asked))) {
            Ok((hub, (request, _))) => {
                let id = self.io(Pending::PasskeyChallenge(hub));
                self.next_view.account = crate::views::AccountView { step: "working".into(), ..Default::default() };
                out.push(Effect::Http { id, request });
            }
            Err(problem) => self.sign_in_failed(problem),
        }
    }

    fn passkey_challenged(&mut self, hub: String, result: IoResult<HttpResponse>, out: &mut Vec<Effect>) {
        use crate::account::signin::{self, Problem};
        let Some(config) = self.config.as_ref() else { return };
        let client = format!("{}/{}", config.platform, config.version);
        let Ok((_, expect)) = signin::passkey_challenge(&hub, &client) else { return };
        let answer = match result {
            IoResult::Ok(response) => crate::hub::Codec.answer(&expect, &response),
            IoResult::Err(error) => Err(crate::hub::classify_io(&error).unwrap_or(crate::hub::Failure::Offline)),
        };
        match answer {
            Ok(crate::hub::Answer::PasskeyChallenge(challenge)) => {
                let id = self.io(Pending::PasskeyGet(hub));
                out.push(Effect::Platform {
                    id,
                    op: PlatformOp::PasskeyGet {
                        rp_id: String::new(),
                        challenge: challenge.challenge.to_vec().into(),
                        credential_ids: Vec::new(),
                        prf_input: trommi_core::account::PASSKEY_PRF_INPUT.to_vec().into(),
                    },
                });
            }
            Err(crate::hub::Failure::NotNow { status: 429, .. }) => self.sign_in_failed(Problem::Throttled),
            Err(crate::hub::Failure::NotNow { .. } | crate::hub::Failure::Offline) => self.sign_in_failed(Problem::Offline),
            _ => self.sign_in_failed(Problem::Other("bad-format")),
        }
    }

    fn passkey_asserted(&mut self, hub: String, result: IoResult<PlatformAnswer>, out: &mut Vec<Effect>) {
        use crate::account::signin;
        let Some(config) = self.config.as_ref() else { return };
        let client = format!("{}/{}", config.platform, config.version);
        let IoResult::Ok(PlatformAnswer::PasskeyAsserted { credential_id, authenticator_data, client_data_json, signature, user_handle, prf }) = result else {
            self.next_view.account = crate::views::AccountView { step: "sign_in".into(), ..Default::default() };
            return;
        };
        let assertion = crate::hub::PasskeyAssertion {
            credential_id: credential_id.0,
            authenticator_data: authenticator_data.0,
            client_data_json: client_data_json.0,
            signature: signature.0,
            user_handle: user_handle.map(|h| h.0),
        };
        match signin::passkey_begin(hub, assertion, &prf.0, &client) {
            Ok((waiting, request)) => {
                let id = self.io(Pending::Login);
                self.signing_in = Some((id, waiting));
                out.push(Effect::Http { id, request });
            }
            Err(problem) => self.sign_in_failed(problem),
        }
    }

    /// `FoundWithPasskey`: the hub's challenge (it names the new account's id), the platform's passkey, then the
    /// founding as with a password (`found_loaded`).
    fn found_with_passkey(&mut self, email: Option<String>, hub: Option<&str>, out: &mut Vec<Effect>) {
        use crate::account::signin;
        let Some(config) = self.config.as_ref() else { return };
        if self.engine.is_some() || self.room_join_wait.is_some() || self.signing_in.is_some() || self.founding.is_some() {
            out.push(log(LogLevel::Warn, "account: a founding on a slot that has a device or is busy"));
            return;
        }
        let client = format!("{}/{}", config.platform, config.version);
        match signin::hub_of(hub, &config.hub).and_then(|hub| signin::passkey_challenge(&hub, &client).map(|asked| (hub, asked))) {
            Ok((hub, (request, _))) => {
                let id = self.io(Pending::FoundChallenge(hub, email));
                self.next_view.account = crate::views::AccountView { step: "working".into(), ..Default::default() };
                out.push(Effect::Http { id, request });
            }
            Err(problem) => self.found_failed(problem.text()),
        }
    }

    fn found_challenged(&mut self, hub: String, email: Option<String>, result: IoResult<HttpResponse>, out: &mut Vec<Effect>) {
        use crate::account::signin::{self, Problem};
        let Some(config) = self.config.as_ref() else { return };
        let client = format!("{}/{}", config.platform, config.version);
        let Ok((_, expect)) = signin::passkey_challenge(&hub, &client) else { return };
        let answer = match result {
            IoResult::Ok(response) => crate::hub::Codec.answer(&expect, &response),
            IoResult::Err(error) => Err(crate::hub::classify_io(&error).unwrap_or(crate::hub::Failure::Offline)),
        };
        match answer {
            Ok(crate::hub::Answer::PasskeyChallenge(challenge)) => {
                let user_name = email.clone().filter(|e| !e.trim().is_empty()).unwrap_or_else(|| challenge.account.clone());
                let id = self.io(Pending::FoundPasskey(hub, email, challenge.account.clone()));
                out.push(Effect::Platform {
                    id,
                    op: PlatformOp::PasskeyCreate {
                        rp_id: String::new(),
                        challenge: challenge.challenge.to_vec().into(),
                        user_handle: challenge.user_handle.to_vec().into(),
                        user_name,
                        prf_input: trommi_core::account::PASSKEY_PRF_INPUT.to_vec().into(),
                    },
                });
            }
            Err(crate::hub::Failure::NotNow { status: 429, .. }) => self.found_failed(Problem::Throttled.text()),
            Err(crate::hub::Failure::NotNow { .. } | crate::hub::Failure::Offline) => self.found_failed(Problem::Offline.text()),
            _ => self.found_failed(Problem::Other("bad-format").text()),
        }
    }

    fn found_passkey_made(&mut self, hub: String, email: Option<String>, account: String, result: IoResult<PlatformAnswer>, out: &mut Vec<Effect>) {
        let IoResult::Ok(PlatformAnswer::PasskeyCreated { credential_id, attestation_object, client_data_json, prf }) = result else {
            self.next_view.account = crate::views::AccountView { step: "found".into(), ..Default::default() };
            return;
        };
        let begun = crate::account::found::begin_with_passkey(hub, email.as_deref(), &account, credential_id.0, attestation_object.0, client_data_json.0, &prf.0, &mut trommi_core::crypto::SystemEntropy);
        match begun {
            Ok(founding) => {
                let id = self.io(Pending::FoundLoad);
                out.push(Effect::Store { id, op: StoreOp::DeviceLoad });
                self.founding = Some((None, founding));
            }
            Err(text) => self.found_failed(text),
        }
    }

    /// `Found`: keys derived and the code made here; the room is founded once the slot's device state is read.
    fn found(&mut self, email: &str, password: &crate::account::Secret, hub: Option<&str>, out: &mut Vec<Effect>) {
        let Some(config) = self.config.as_ref() else { return };
        if self.engine.is_some() || self.room_join_wait.is_some() || self.signing_in.is_some() || self.founding.is_some() {
            out.push(log(LogLevel::Warn, "account: a founding on a slot that has a device or is busy"));
            return;
        }
        let hub = match crate::account::signin::hub_of(hub, &config.hub) {
            Ok(hub) => hub,
            Err(problem) => return self.found_failed(problem.text()),
        };
        match crate::account::found::begin(hub, email, password, &mut trommi_core::crypto::SystemEntropy) {
            Ok(founding) => {
                let id = self.io(Pending::FoundLoad);
                out.push(Effect::Store { id, op: StoreOp::DeviceLoad });
                self.founding = Some((None, founding));
                self.next_view.account = crate::views::AccountView { step: "working".into(), ..Default::default() };
            }
            Err(text) => self.found_failed(text),
        }
    }

    fn found_failed(&mut self, text: crate::views::Text) {
        self.founding = None;
        self.next_view.account = crate::views::AccountView { step: "found".into(), problem: Some(text), ..Default::default() };
    }

    /// The slot's device state for a founding: the device and its room are made, and the founding goes out.
    fn found_loaded(&mut self, now_ms: u64, revision: u64, entries: Vec<DeviceEntry>, out: &mut Vec<Effect>) {
        let Some(config) = self.config.as_ref() else { return };
        let Some((_, founding)) = self.founding.as_ref() else { return };
        let client = format!("{}/{}", config.platform, config.version);
        let entropy = self.entropy.take().unwrap_or_else(|| Box::new(trommi_core::crypto::SystemEntropy));
        let engine = Engine::found_room(&client, config.seed, revision, entries, &founding.hub, &founding.keys, now_ms, entropy);
        let mut engine = match engine {
            Ok(engine) => engine,
            Err(code) => {
                let text = crate::views::Text::new("account.found_failed", &format!("The room was not made ({code})."));
                return self.found_failed(text);
            }
        };
        let body = match founding.account_body(&engine.room(), &mut trommi_core::crypto::SystemEntropy) {
            Ok(body) => body,
            Err(code) => {
                let text = crate::views::Text::new("account.found_failed", &format!("The room was not made ({code})."));
                return self.found_failed(text);
            }
        };
        engine.set_founding(crate::hub::OutboxExtra { account: Some(body), ..Default::default() });
        // the room's hub first, as a join with the code writes it
        let key = RoomKey { v: 1, hub: founding.hub.clone(), room: engine.room().to_base64url() };
        let id = self.io(Pending::RoomKeyWrite);
        out.push(Effect::Store { id, op: StoreOp::Put { put: vec![Entry { key: ROOM_KEY.into(), value: serde_json::to_vec(&key).unwrap_or_default().into() }], delete: Vec::new() } });
        self.board = engine::feed::Board::new(engine.device());
        self.past = Default::default();
        self.stored_hub = Some(engine.hub().to_string());
        self.engine = Some(engine);
        self.next_view.phase = Phase::Opening;
        self.with_engine(now_ms, out, |engine, ctx| engine.start(ctx));
    }

    /// The slot's device state for a join by link: the device is made and the join begins.
    fn link_loaded(&mut self, now_ms: u64, revision: u64, entries: Vec<DeviceEntry>, out: &mut Vec<Effect>) {
        let Some(config) = self.config.as_ref() else { return };
        let Some(link) = self.linking.take() else { return };
        let client = format!("{}/{}", config.platform, config.version);
        let entropy = self.entropy.take().unwrap_or_else(|| Box::new(trommi_core::crypto::SystemEntropy));
        match Engine::join_by_link(&client, config.seed, revision, entries, &link.0, now_ms, entropy) {
            Ok(engine) => {
                let key = RoomKey { v: 1, hub: engine.hub().to_string(), room: engine.room().to_base64url() };
                let id = self.io(Pending::RoomKeyWrite);
                out.push(Effect::Store { id, op: StoreOp::Put { put: vec![Entry { key: ROOM_KEY.into(), value: serde_json::to_vec(&key).unwrap_or_default().into() }], delete: Vec::new() } });
                self.board = engine::feed::Board::new(engine.device());
                self.past = Default::default();
                self.stored_hub = Some(engine.hub().to_string());
                self.engine = Some(engine);
                self.with_engine(now_ms, out, |engine, ctx| engine.start(ctx));
            }
            Err(code) => self.next_view.account = crate::views::AccountView { step: "join".into(), problem: Some(link_problem(code)), ..Default::default() },
        }
    }

    fn sign_in_failed(&mut self, problem: crate::account::signin::Problem) {
        self.next_view.account = crate::views::AccountView { step: "sign_in".into(), problem: Some(problem.text()), ..Default::default() };
    }

    /// The hub answered a sign-in's login: the code is opened and the room joined with it.
    fn login_answered(&mut self, now_ms: u64, id: IoId, result: IoResult<HttpResponse>, out: &mut Vec<Effect>) {
        use crate::account::signin;
        let Some((_, waiting)) = self.signing_in.take_if(|(asked, _)| *asked == id) else { return };
        let answer = match result {
            IoResult::Ok(response) => crate::hub::Codec.answer(&waiting.expect, &response),
            IoResult::Err(error) => Err(crate::hub::classify_io(&error).unwrap_or(crate::hub::Failure::Offline)),
        };
        match signin::answered(&waiting, answer) {
            Ok((room, keys)) => {
                self.signed_in_join = true;
                let hub = waiting.hub.clone();
                drop(waiting);
                let recover = self.recover_with.take().map(|(words, copies)| {
                    self.recovered_kit = Some(words);
                    copies
                });
                let effects = self.join_room(now_ms, engine::room_join::RoomJoin { hub, room, keys, recover });
                // (its render too: each render moves the view's revision on, and a shell folds every one in order)
                out.extend(effects);
            }
            Err(problem) => self.sign_in_failed(problem),
        }
    }

    /// A sign-in's join of the room, as the account's screen shows it.
    fn follow_sign_in(&mut self) {
        use engine::room_join::{RoomJoinError, RoomJoinStatus};
        if !self.signed_in_join {
            return;
        }
        match self.room_join {
            Some(RoomJoinStatus::Joined) => {
                self.signed_in_join = false;
                self.next_view.account = match self.recovered_kit.take() {
                    Some(kit) => crate::views::AccountView { step: "keep_kit".into(), kit, ..Default::default() },
                    None => crate::views::AccountView { step: "none".into(), ..Default::default() },
                };
            }
            Some(RoomJoinStatus::Failed(error)) => {
                self.signed_in_join = false;
                self.recovered_kit = None;
                use crate::views::words::say;
                let problem = match error {
                    RoomJoinError::TooMany => say("account.too_many", "This room has as many devices as it may. Remove one first.", &[]),
                    RoomJoinError::Interrupted => say("account.interrupted", "Signing in was cut off. Sign in again to finish it.", &[]),
                    other => say("account.join_failed", format!("Joining the room did not work ({}).", other.code()), &[("code", other.code())]),
                };
                self.next_view.account = crate::views::AccountView { step: "sign_in".into(), problem: Some(problem), ..Default::default() };
            }
            _ => {}
        }
    }

    /// Sends a request an action built with the codec's builder for its route, through the engine, which adds the
    /// token, renews it and retries (`engine::requests`). `keep`: a name for a request with side effects at the hub,
    /// sent again after a restart (the route must be idempotent). The answer comes in [`App::take_answers`] under
    /// the id returned. `None` without a device.
    pub fn request(
        &mut self,
        now_ms: u64,
        build: impl FnOnce(&crate::hub::Site<'_>) -> Result<crate::app::io::HttpRequest, crate::hub::Failure>,
        keep: Option<String>,
    ) -> (Option<Result<IoId, &'static str>>, Vec<Effect>) {
        let mut out = Vec::new();
        let result = self.with_engine(now_ms, &mut out, |engine, ctx| engine.request(ctx, build, keep));
        self.after_engine(now_ms, &mut out);
        self.render(&mut out);
        (result, out)
    }

    /// Archives a session group and retires the agent devices vouched into it (`engine::requests`,
    /// `Engine::archive_session`): kept across a restart. The hub's answer comes in [`App::take_answers`] too.
    pub fn archive_session(
        &mut self,
        now_ms: u64,
        group: trommi_core::ids::GroupId,
        retire: Vec<trommi_core::ids::DeviceId>,
    ) -> (Option<Result<IoId, &'static str>>, Vec<Effect>) {
        let mut out = Vec::new();
        let result = self.with_engine(now_ms, &mut out, |engine, ctx| engine.archive_session(ctx, group, retire));
        self.after_engine(now_ms, &mut out);
        self.render(&mut out);
        (result, out)
    }

    /// The actions' requests answered (or given up) since the last call, in the order they ended.
    pub fn take_answers(&mut self) -> Vec<engine::requests::Answered> {
        std::mem::take(&mut self.answers)
    }

    /// How the last join of the room with the code stands; none before one.
    pub fn room_join(&self) -> Option<engine::room_join::RoomJoinStatus> {
        self.room_join
    }

    /// The device state for a join with the code is read: the engine is made on it.
    fn join_loaded(&mut self, now_ms: u64, id: IoId, revision: u64, entries: Vec<DeviceEntry>, out: &mut Vec<Effect>) {
        use engine::room_join::RoomJoinStatus;
        let Some((_, join)) = self.room_join_wait.take_if(|(waiting, _)| *waiting == id) else { return };
        let Some(config) = self.config.as_ref() else { return };
        if self.engine.is_some() {
            self.room_join = Some(RoomJoinStatus::Failed(engine::room_join::RoomJoinError::RoomExists));
            return;
        }
        let client = format!("{}/{}", config.platform, config.version);
        let entropy = self.entropy.take().unwrap_or_else(|| Box::new(trommi_core::crypto::SystemEntropy));
        match Engine::join_room(&client, config.seed, revision, entries, join, entropy) {
            Ok(engine) => {
                self.board = engine::feed::Board::new(engine.device());
                self.past = Default::default();
                self.stored_hub = Some(engine.hub().to_string());
                self.engine = Some(engine);
                self.sessions_not_joined = None;
                self.with_engine(now_ms, out, |engine, ctx| engine.start_room_join(ctx));
            }
            Err(error) => self.room_join = Some(RoomJoinStatus::Failed(error)),
        }
    }

    /// Once a sign-in's sessions are through: the ones this device is not in, each with the reason. None before.
    pub fn sessions_not_joined(&self) -> Option<&[(trommi_core::ids::GroupId, &'static str)]> {
        self.sessions_not_joined.as_deref()
    }

    /// The invites a newcomer sent its Request for since they were last taken, oldest first, each once.
    pub fn take_invite_requests(&mut self) -> Vec<trommi_core::ids::InviteId> {
        std::mem::take(&mut self.invite_requests)
    }

    /// The engine's alerts so far, oldest first.
    pub fn alerts(&self) -> &[engine::Alert] {
        &self.alerts
    }

    /// The view model as last rendered: what a shell shows after folding every `Render` it was given.
    pub fn view(&self) -> &ViewModel {
        &self.view
    }

    /// One event in, the effects out. `now_ms` is the shell's clock (ms since 1970).
    pub fn handle(&mut self, now_ms: u64, event: Event) -> Vec<Effect> {
        let mut out = Vec::new();
        if !self.departure_event(now_ms, &event) {
        match event {
            Event::Start { config } => {
                if self.config.is_some() {
                    out.push(log(LogLevel::Warn, "start: already started"));
                } else {
                    self.jitter = Jitter::new(config.seed);
                    self.sent.seed = config.seed;
                    self.lens.utc_offset_min = config.utc_offset_min;
                    // (the Desk's greeting: one for the whole run)
                    self.lens.dice = (config.seed ^ (config.seed >> 32)) as u32;
                    let demo = config.demo.clone();
                    self.config = Some(config);
                    if let Some(fixture) = demo {
                        match crate::views::demo::model_of(&fixture, now_ms) {
                            Ok(model) => {
                                self.board = engine::feed::Board::default();
                                self.past = Default::default();
                                self.board.model = model;
                                self.demo = true;
                                self.seen_demo();
                                self.next_view.account = crate::views::AccountView { step: "none".into(), ..Default::default() };
                                self.next_view.phase = Phase::Live;
                                self.stale_views = true;
                                self.after_demo(now_ms, &mut out);
                            }
                            Err(why) => out.push(log(LogLevel::Error, &format!("demo: {why}"))),
                        }
                        self.render(&mut out);
                        return out;
                    }
                    self.start_departures(&mut out);
                    self.next_view.phase = Phase::Starting;
                    let id = self.io(Pending::DeviceLoad);
                    out.push(Effect::Store {
                        id,
                        op: StoreOp::DeviceLoad,
                    });
                }
            }
            _ if self.config.is_none() => out.push(log(LogLevel::Warn, "an event before start")),
            Event::Store { id, result } => match self.pending.remove(&id) {
                Some(Pending::ForgetWrite) => {
                    if matches!(result, IoResult::Err(_)) { self.next_view.phase = Phase::Stopped; self.next_view.status = Some(crate::views::Text::new("account.wipe_failed", "The stored device could not be erased. Close the app and try again.")); }
                },
                Some(Pending::Wipe) => {
                    if let IoResult::Ok(StoreAnswer::Entries { entries }) = result {
                        self.departure_entries(&entries, now_ms);
                        self.wipe_cache(entries.into_iter().map(|e| e.key).collect(), &mut out);
                    }
                }
                Some(Pending::WipeKeys) => {
                    if let IoResult::Ok(StoreAnswer::Keys { keys }) = result { self.wipe_cache(keys, &mut out); }
                }
                Some(Pending::LinkLoad) => match result {
                    IoResult::Ok(StoreAnswer::Device { revision, entries }) => self.link_loaded(now_ms, revision, entries, &mut out),
                    _ => {
                        self.linking = None;
                        self.next_view.account = crate::views::AccountView { step: "join".into(), problem: Some(crate::views::Text::new("join.failed", "Joining did not work (storage).")), ..Default::default() };
                    }
                },
                Some(Pending::FoundLoad) => match result {
                    IoResult::Ok(StoreAnswer::Device { revision, entries }) => self.found_loaded(now_ms, revision, entries, &mut out),
                    _ => self.found_failed(crate::views::Text::new("account.found_failed", "The room was not made (storage).")),
                },
                Some(Pending::JoinLoad) => match result {
                    IoResult::Ok(StoreAnswer::Device { revision, entries }) => self.join_loaded(now_ms, id, revision, entries, &mut out),
                    _ => {
                        out.push(log(LogLevel::Error, "join: the device state was not read"));
                        self.room_join_wait = None;
                        self.room_join = Some(engine::room_join::RoomJoinStatus::Failed(engine::room_join::RoomJoinError::Device("storage")));
                    }
                },
                Some(Pending::Login) | Some(Pending::Dropped) if false => {}
                Some(Pending::RoomKey) => {
                    if let IoResult::Ok(StoreAnswer::Values { values }) = &result {
                        let key: Option<RoomKey> = values.first().and_then(Option::as_ref).and_then(|v| serde_json::from_slice(&v.0).ok());
                        self.stored_hub = key.filter(|k| k.v == 1).map(|k| k.hub);
                    }
                    if let Some((revision, entries)) = self.opening.take() {
                        self.open(now_ms, revision, entries, &mut out);
                    }
                }
                Some(Pending::RoomKeyWrite) | Some(Pending::Dropped) | Some(Pending::Login) | Some(Pending::PasskeyChallenge(_)) | Some(Pending::PasskeyGet(_)) | Some(Pending::FoundChallenge(..)) | Some(Pending::FoundPasskey(..)) | Some(Pending::Shared) | Some(Pending::DemoFile(_)) => {
                    if let IoResult::Err(e) = &result {
                        out.push(log(LogLevel::Warn, &format!("store: {:?}", e.kind)));
                    }
                }
                Some(Pending::DeviceLoad) => match result {
                    IoResult::Ok(StoreAnswer::Device { revision, entries })
                        if revision != 0
                            && !entries.is_empty()
                            && self.engine.is_none()
                            && self.stored_hub.is_none()
                            && self.config.as_ref().is_some_and(|c| c.hub.is_empty()) =>
                    {
                        // (no hub named: the stored room names its hub, read before the device is opened)
                        self.opening = Some((revision, entries));
                        let id = self.io(Pending::RoomKey);
                        out.push(Effect::Store { id, op: StoreOp::Get { keys: vec![ROOM_KEY.into()] } });
                    }
                    IoResult::Ok(StoreAnswer::Device { revision, entries }) => {
                        self.open(now_ms, revision, entries, &mut out)
                    }
                    IoResult::Ok(_) => {
                        out.push(log(LogLevel::Error, "device load: not a device answer"))
                    }
                    IoResult::Err(e) => {
                        out.push(log(LogLevel::Error, &format!("device load: {:?}", e.kind)));
                        self.closed(now_ms, &mut out);
                    }
                },
                // (a cache entry that stays is only a cache entry: the hub no longer serves the file)
                Some(Pending::CacheDelete) => {}
                Some(Pending::SeenRead) => self.seen_read(&result),
                Some(Pending::SeenWrite) => self.seen_written(id, &result, &mut out),
                Some(Pending::DepartureLoad | Pending::DepartureSave(_) | Pending::DepartureHttp(_, _) | Pending::DepartureDelete(_)) => {}
                None if self.cache.is_some() && self.cached(now_ms, id, &result, &mut out) => {}
                None => {
                    let mine = self.with_engine(now_ms, &mut out, |engine, ctx| {
                        engine.on_store(ctx, id, &result)
                    });
                    if mine != Some(true) {
                        out.push(log(LogLevel::Warn, "store: an answer to nothing asked"));
                    }
                }
            },
            Event::Http { id, result } if matches!(self.pending.get(&id), Some(Pending::FoundChallenge(..))) => {
                if let Some(Pending::FoundChallenge(hub, email)) = self.pending.remove(&id) {
                    self.found_challenged(hub, email, result, &mut out);
                }
            }
            Event::Platform { id, result } if matches!(self.pending.get(&id), Some(Pending::FoundPasskey(..))) => {
                if let Some(Pending::FoundPasskey(hub, email, account)) = self.pending.remove(&id) {
                    self.found_passkey_made(hub, email, account, result, &mut out);
                }
            }
            Event::Http { id, result } if matches!(self.pending.get(&id), Some(Pending::PasskeyChallenge(_))) => {
                if let Some(Pending::PasskeyChallenge(hub)) = self.pending.remove(&id) {
                    self.passkey_challenged(hub, result, &mut out);
                }
            }
            Event::Platform { id, result } if matches!(self.pending.get(&id), Some(Pending::PasskeyGet(_))) => {
                if let Some(Pending::PasskeyGet(hub)) = self.pending.remove(&id) {
                    self.passkey_asserted(hub, result, &mut out);
                }
            }
            Event::Http { id, result } if matches!(self.pending.get(&id), Some(Pending::DemoFile(_))) => {
                if let (Some(Pending::DemoFile(open)), IoResult::Ok(response)) = (self.pending.remove(&id), result) {
                    if response.status == 200 {
                        self.files.demo_opened(open, response.body, &mut out);
                        self.stale_views = true;
                    }
                }
            }
            Event::Http { id, result } if self.pending.get(&id) == Some(&Pending::Shared) => {
                self.pending.remove(&id);
                if let Some((link, expect)) = self.shared_ask.take() {
                    self.shared_answered(link, expect, result, &mut out);
                }
            }
            Event::Http { id, result } if self.pending.get(&id) == Some(&Pending::Login) => {
                self.pending.remove(&id);
                self.login_answered(now_ms, id, result, &mut out);
            }
            Event::Http { id, result } => {
                let mine = self.with_engine(now_ms, &mut out, |engine, ctx| {
                    engine.on_http(ctx, id, result)
                });
                if mine != Some(true) && self.pending.remove(&id).is_none() {
                    out.push(log(LogLevel::Warn, "an answer to nothing asked"));
                }
            }
            Event::Platform { id, result } if self.changes.owns_platform(id) => self.change_platform(now_ms, id, result, &mut out),
            Event::Platform { id, result } if self.push.owns_platform(id) => self.push_platform_answered(now_ms, id, result, &mut out),
            Event::Secret { id, result } if self.outside.key_read == Some(id) => {
                self.outside_key(match result {
                    IoResult::Ok(value) => value.map(|v| v.0),
                    IoResult::Err(_) => None,
                });
            }
            Event::Secret { id, .. } | Event::Platform { id, .. } => {
                if self.pending.remove(&id).is_none() {
                    out.push(log(LogLevel::Warn, "an answer to nothing asked"));
                }
            }
            Event::Stream { id, item } => {
                // (an item of a stream the engine closed is dropped: the id is forgotten)
                self.with_engine(now_ms, &mut out, |engine, ctx| engine.on_stream(ctx, id, item));
            }
            Event::Progress { id, done, total } => {
                self.files.progress(id, done, total.unwrap_or(0));
                self.stale_views = true;
            }
            Event::Finished { .. } => {}
            Event::PushToken { kind, token } => {
                if self.engine.is_some() {
                    self.push_token(now_ms, kind, token.map(|t| t.0), &mut out);
                }
            }
            Event::Zone { utc_offset_min } => {
                self.lens.utc_offset_min = utc_offset_min;
                self.stale_views = true;
            }
            Event::Action { action: crate::actions::Action::Account { action } } => self.account(now_ms, action, &mut out),
            Event::Action { action } => self.action(now_ms, action, &mut out),
            Event::Focus { focus } => {
                let board = match &focus.screen {
                    Screen::Scribble { board_id } => Some(board_id.as_str()),
                    _ => focus.board.as_deref(),
                };
                self.scribble.focus(board.and_then(crate::scribble::board_in_view));
                // (every team's board small: Settings; the team's own on its Desk, for the board tile)
                let desk = matches!(focus.screen, Screen::Desk) && !focus.desk_all;
                self.lens.thumbs = matches!(focus.screen, Screen::Settings { .. }) || desk;
                self.lens.thumbs_desk = desk;
                self.scribble.thumbs = self.lens.thumbs;
                if self.lens.thumbs && !self.demo {
                    let only = desk.then(|| self.team_in_view(focus.team.as_deref())).flatten();
                    for (team, _) in crate::sessions::teams_in_order(&self.board.model) {
                        if only.as_ref().is_some_and(|t| *t != team) {
                            continue;
                        }
                        if let Some(b) = crate::scribble::board_of(&crate::scribble::team_board(&team)) {
                            self.scribble.read(b);
                        }
                    }
                }
                self.lens.team = focus.team;
                self.lens.desk_all = focus.desk_all;
                self.lens.calm = focus.calm;
                self.lens.open_teams = focus.open_teams;
                self.lens.chats_query = focus.chats_query.map(|q| q.trim().to_string()).filter(|q| !q.is_empty());
                // (the gallery, and the Desk's foot shows its newest)
                self.lens.artifacts = matches!(focus.screen, Screen::Artifacts { .. } | Screen::Desk);
                self.lens.gallery = match &focus.screen {
                    Screen::Artifacts { kind } => Some(kind.clone()),
                    _ => None,
                };
                self.lens.knowledge = match &focus.screen {
                    Screen::Knowledge { query, filter } => Some(crate::views::knowledge::Ask { query: query.clone(), filter: filter.clone() }),
                    _ => None,
                };
                let (session, card, off) = match focus.screen {
                    Screen::Session { session_id } => (Some(session_id), None, None),
                    Screen::Card { card_id } => (None, Some(card_id), None),
                    Screen::Off { query } => (None, None, Some(query)),
                    _ => (None, None, None),
                };
                // (a card or a session opened is where old history is read: after a sign-in only the open cards
                //  and what is new are loaded; `app::past` asks for it behind this event, in `after_engine`)
                self.lens.session = session;
                self.lens.card = card;
                self.lens.off = off;
                self.stale_views = true;
                self.seen.looking = focus.visible;
                self.outside_front(Some(focus.visible), false);
            }
            Event::Wake => {
                self.timer = None;
                self.invites_look(now_ms, None, &mut out);
                self.with_engine(now_ms, &mut out, |engine, ctx| engine.on_wake(ctx));
                if self.reopen_at.is_some_and(|at| now_ms >= at) {
                    self.reopen(&mut out);
                }
            }
            Event::Foreground => {
                self.seen.looking = true;
                self.stale_views = true;
                self.departures.hurry();
                self.outside_front(Some(true), false);
                self.with_engine(now_ms, &mut out, |engine, ctx| engine.on_foreground(ctx));
                // (one that gave up on its stored state tries again when the person comes back)
                if self.next_view.phase == Phase::Stopped && self.reopen_tries > REOPEN_TRIES {
                    self.reopen_tries = 0;
                    self.reopen(&mut out);
                }
            }
            Event::Background => {
                self.seen.looking = false;
                self.outside_front(Some(false), false);
                self.with_engine(now_ms, &mut out, |engine, ctx| engine.on_background(ctx));
            }
            Event::Net { online } => {
                if online { self.departures.hurry(); }
                self.with_engine(now_ms, &mut out, |engine, ctx| engine.on_net(ctx, online));
            }
            // (a push that reached the app: what it rang for is read, as when the app comes to the front)
            Event::Push { .. } => {
                self.outside_front(None, true);
                self.with_engine(now_ms, &mut out, |engine, ctx| engine.on_foreground(ctx));
            }
        }
        }
        self.resume_departure(now_ms, &mut out);
        self.drive_departures(now_ms, &mut out);
        if self.demo {
            if self.view_wake.is_some_and(|at| now_ms >= at) {
                self.stale_views = true;
            }
            self.after_demo(now_ms, &mut out);
            if self.view_wake != self.timer {
                self.timer = self.view_wake;
                out.push(Effect::Timer { at_ms: self.view_wake });
            }
        } else {
            self.after_engine(now_ms, &mut out);
        }
        self.render(&mut out);
        out
    }

    /// The person did something: the actions of `actions::run`, the toasts, a retry.
    fn action(&mut self, now_ms: u64, action: Action, out: &mut Vec<Effect>) {
        // a note sent without a session goes where the corner's note says it goes (the crown of the team in view)
        let action = match action {
            Action::SendNote { note_id, to: None } => Action::SendNote { note_id, to: self.next_view.notes.to.as_ref().map(|t| t.session_id.clone()) },
            other => other,
        };
        if self.queue_import(&action, out) { return; }
        match &action {
            Action::OpenShared { link } => {
                self.open_shared(link, out);
                return;
            }
            Action::Dismiss { toast_id } => {
                self.next_view.toasts.retain(|t| &t.id != toast_id);
                return;
            }
            Action::Retry => {
                self.with_engine(now_ms, out, |engine, ctx| engine.on_net(ctx, true));
                return;
            }
            Action::ShowMore { of } => {
                self.lens.show_more(of.clone());
                self.stale_views = true;
                // (what this device does not hold yet is read from the hub: the page before the oldest one read)
                if let Some(engine) = self.engine.as_mut() {
                    let mut ctx = engine::Ctx { now: now_ms, next_id: &mut self.next_id, out };
                    match of {
                        crate::views::MoreOf::Talk { session } => self.past.earlier(session, &self.board.model, engine, &mut ctx),
                        crate::views::MoreOf::Comments { card } => self.past.earlier_comments(card, &self.board.model, engine, &mut ctx),
                        crate::views::MoreOf::Off { .. } => self.past.more_settled(engine, &mut ctx),
                    }
                }
                return;
            }
            Action::FoldGoals { team_id, folded } => {
                self.lens.goals_folded.retain(|d| d != team_id);
                if *folded {
                    self.lens.goals_folded.push(team_id.clone());
                }
                self.stale_views = true;
                return;
            }
            Action::Batch { way, card_ids } => {
                return self.batch(now_ms, way, card_ids, out);
            }
            Action::KeepNote { note_id, text, attachments, send, to } => {
                let keep = self.keep_note(note_id.as_deref(), text, attachments);
                let mut kept = match &keep {
                    Some(Action::WriteNoteFiles { note_id: Some(id), .. }) => Some(id.clone()),
                    None => note_id.clone().or_else(|| self.made_note.clone()),
                    _ => None,
                };
                if let Some(keep) = keep {
                    let fresh = matches!(keep, Action::WriteNoteFiles { note_id: None, .. });
                    let before: std::collections::BTreeSet<String> = self.sent.notes.keys().cloned().collect();
                    self.action(now_ms, keep, out);
                    if fresh {
                        // (the note it made: the next keep writes into it, also before the page has its id)
                        self.made_note = self.sent.notes.keys().find(|k| !before.contains(*k)).cloned().or(self.made_note.take());
                        kept = self.made_note.clone();
                    }
                }
                if let (true, Some(note_id)) = (*send, kept) {
                    self.action(now_ms, Action::SendNote { note_id, to: to.clone() }, out);
                }
                return;
            }
            _ => {}
        }
        if self.demo {
            return self.demo_action(now_ms, action, out);
        }
        if self.engine.is_none() {
            let text = crate::views::Text::new("action.no_room", "Sign in first.");
            self.sent.toast(&mut self.next_view.toasts, text, None);
            return;
        }
        if self.file_action(now_ms, &action, out) || self.piece_action(now_ms, &action, out) {
            return;
        }
        if writes_room_registers(&action) && self.next_view.phase != Phase::Live {
            if self.held_actions.len() < 64 {
                self.held_actions.push(action);
            }
            return;
        }
        if let Action::DeleteSession { session_id } = &action {
            return self.delete_session(now_ms, session_id, out);
        }
        if let Action::RemoveTeam { team_id } = &action {
            return self.delete_team(now_ms, team_id, out);
        }
        if let Action::Push { level } = &action {
            return self.push_action(now_ms, *level, out);
        }
        self.run_action(now_ms, action, out);
    }

    /// An action in the demo room: done on the model as on a real one (the echo), and taken as done at once.
    fn demo_action(&mut self, now_ms: u64, action: Action, out: &mut Vec<Effect>) {
        // (files: the demo keeps what is attached in memory, and opens its own files from their addresses)
        match &action {
            Action::Attach { local_id, name, media_type, bytes } => {
                self.files.demo_attach(local_id, name, media_type, bytes);
                self.stale_views = true;
                return;
            }
            Action::OpenFile { attachment_id, save } => {
                if let Some((url, open)) = self.files.demo_open(attachment_id, *save, out) {
                    let id = self.io(Pending::DemoFile(open));
                    out.push(Effect::Http { id, request: crate::app::io::HttpRequest { method: "GET".into(), url, headers: Vec::new(), body: None, timeout_ms: 30_000, max_answer: 64 << 20, class: Default::default(), key: None } });
                }
                self.stale_views = true;
                return;
            }
            _ => {}
        }
        let utc_offset_min = self.lens.utc_offset_min;
        let room = trommi_core::ids::RoomId::new([7; 32]);
        let mut n = 0u64;
        let mut seal = |_: &trommi_core::device::Draft, _: Option<&trommi_core::ids::DeviceId>, _: &[trommi_core::ids::FileId]| {
            n += 1;
            let mut hash = [0u8; 32];
            hash[..8].copy_from_slice(&(now_ms ^ (n << 48)).to_be_bytes());
            Ok(trommi_core::device::Sealed {
                outbox_id: n,
                envelope_hash: trommi_core::ids::Hash32::new(hash),
                seq: n,
                group: trommi_core::ids::GroupId::room(room),
                object_id: None,
                time: now_ms,
            })
        };
        let files = &self.files;
        let file = |id: &str| files.reference(id).cloned();
        let mut doing = Doing {
            file: &file,
            model: &mut self.board.model,
            sent: &mut self.sent,
            toasts: &mut self.next_view.toasts,
            room,
            now: now_ms,
            utc_offset_min,
            seal: &mut seal,
            change: Change::default(),
        };
        match doing.run(&action) {
            Err(NotDone { text, .. }) => doing.sent.toast(doing.toasts, text, None),
            Ok(()) => {
                if let Action::SendNote { note_id, .. } = &action {
                    let text = crate::views::Text::new("notes.sent", "Note sent.");
                    doing.sent.undo_toast(doing.toasts, text, None, Action::UnsendNote { note_id: note_id.clone() });
                }
            }
        }
        let mut change = std::mem::take(&mut doing.change);
        self.board.model.settle_echoes();
        self.board.model.project(&mut change, now_ms);
        self.stale_views = true;
        self.after_demo(now_ms, out);
    }

    /// The demo's views, made again when they went stale. Its boards are in the model alone.
    fn after_demo(&mut self, now_ms: u64, out: &mut Vec<Effect>) {
        self.seen_tend(out);
        if self.stale_views {
            self.outside.due = true;
            self.stale_views = false;
            let (wake, mut shown) = crate::views::render_with_files(&self.board.model, &self.lens, now_ms, &mut self.next_view);
            self.next_view.board = self.scribble.focused().map(|b| {
                let (view, refs) = crate::scribble::model_board(&self.board.model, &b);
                shown.extend(refs);
                view
            });
            self.next_view.thumbs = self.thumbs();
            crate::views::desk::board_tile(&mut self.next_view.desk, self.next_view.thumbs.as_deref());
            self.view_wake = wake;
            self.files.shown(shown, &mut self.next_view.files);
        }
        self.outside(now_ms, out);
    }

    /// The team in view as the views take it: the one chosen when it is there, else the first (`Board::team`).
    fn team_in_view(&self, chosen: Option<&str>) -> Option<String> {
        let teams = crate::sessions::teams_in_order(&self.board.model);
        teams.iter().find(|(t, _)| Some(t.as_str()) == chosen).or(teams.first()).map(|(t, _)| t.clone())
    }

    /// Every team's board small while a page shows them (`Lens::thumbs`): each is read on this device (the demo's
    /// are in the model).
    fn thumbs(&mut self) -> Option<Vec<crate::views::ThumbView>> {
        if !self.lens.thumbs {
            return None;
        }
        let only = if self.lens.thumbs_desk { self.team_in_view(self.lens.team.clone().as_deref()) } else { None };
        let teams = crate::sessions::teams_in_order(&self.board.model);
        let mut out = Vec::with_capacity(teams.len());
        for (team, _) in teams {
            if only.as_ref().is_some_and(|t| *t != team) {
                continue;
            }
            let id = crate::scribble::team_board(&team);
            let Some(board) = crate::scribble::board_of(&id) else { continue };
            let (state, shapes) = if self.demo {
                ("ready", crate::scribble::thumb_shapes(crate::scribble::model_board(&self.board.model, &board).0.shapes))
            } else {
                self.scribble.read(board);
                self.scribble.thumb(&self.board.model, &board).unwrap_or(("loading", Vec::new()))
            };
            out.push(crate::views::ThumbView { team_id: team, board_id: id, state: state.into(), count: shapes.len() as u64, shapes });
        }
        Some(out)
    }

    /// The notes this device sent whose hold (the toast's Undo) ran out: delivered, once each.
    fn deliver_notes(&mut self, now_ms: u64, out: &mut Vec<Effect>) {
        let me = self.board.model.my_device_id.clone();
        let due: Vec<String> = self
            .board
            .model
            .notes
            .iter()
            .filter(|(id, n)| {
                let held = n.get("held").and_then(|h| h.get("until")).and_then(serde_json::Value::as_u64);
                held.is_some_and(|u| u <= now_ms)
                    && n.get("by_device_id").and_then(serde_json::Value::as_str) == me.as_deref()
                    && n.get("object_state").and_then(serde_json::Value::as_str) != Some("closed")
                    && !n.get("pending").is_some_and(crate::model::apply::truthy)
                    && !self.notes_went.contains(*id)
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in due {
            self.notes_went.insert(id.clone());
            self.doing(now_ms, out, |doing| {
                if let Err(NotDone { text, .. }) = doing.deliver_note(&id) {
                    doing.sent.toast(doing.toasts, text, None);
                }
            });
        }
    }

    /// When the next held note is due.
    fn notes_wake(&self) -> Option<u64> {
        let me = self.board.model.my_device_id.as_deref();
        self.board
            .model
            .notes
            .iter()
            .filter(|(id, n)| !self.notes_went.contains(*id) && n.get("by_device_id").and_then(serde_json::Value::as_str) == me)
            .filter_map(|(_, n)| n.get("held").and_then(|h| h.get("until")).and_then(serde_json::Value::as_u64))
            .min()
    }

    /// Deletes a session (the web's `deletionOf`): its open cards and those of its helper sessions of before are
    /// shredded, they are archived, and the agent devices that carry no other session (not archived, or connected)
    /// leave the room.
    fn delete_session(&mut self, now_ms: u64, session_id: &str, out: &mut Vec<Effect>) {
        let model = &self.board.model;
        let (rows, legacy) = crate::sessions::session_list_and_helpers(model, true);
        let Some(main) = rows.iter().find(|r| r.key == session_id) else {
            let text = crate::views::Text::new("action.not_found", "That session is no longer there.");
            self.sent.toast(&mut self.next_view.toasts, text, None);
            return;
        };
        let device_of = |key: &str| model.sessions.get(key).and_then(|s| s.agent_device_id.clone());
        let mut all = vec![main.key.clone()];
        all.extend(legacy.into_iter().filter(|h| h.main == main.key).map(|h| h.key));
        let me = model.my_device_id.clone();
        let humans: Vec<String> = self.engine.as_ref().map(|e| e.roles().0.iter().map(|d| crate::engine::feed::hex(d.as_bytes())).collect()).unwrap_or_default();
        let stays = |dev: &str| rows.iter().any(|r| !all.contains(&r.key) && (!r.archived || r.online) && device_of(&r.key).as_deref() == Some(dev));
        let mut devices: Vec<String> = all.iter().filter_map(|k| device_of(k)).collect();
        devices.sort();
        devices.dedup();
        devices.retain(|d| Some(d) != me.as_ref() && !humans.contains(d) && !stays(d));
        let cards: Vec<String> = model
            .cards
            .iter()
            .filter(|(_, c)| c.object_state == "open" && c.session_id.as_ref().is_some_and(|s| all.contains(s)))
            .map(|(id, _)| id.clone())
            .collect();
        for card_id in cards {
            self.run_action(now_ms, Action::Shred { card_id, note: None, attachments: Vec::new(), marks: Vec::new() }, out);
        }
        for key in &all {
            self.run_action(now_ms, Action::ArchiveSession { session_id: key.clone(), on: true }, out);
        }
        if !devices.is_empty() {
            self.account(now_ms, crate::account::AccountAction::RemoveDevices { device_ids: devices }, out);
        }
    }

    /// An action of `actions::run`, done; an archived session's group is archived at the hub too.
    fn run_action(&mut self, now_ms: u64, action: Action, out: &mut Vec<Effect>) {
        let mut done = false;
        self.doing(now_ms, out, |doing| match doing.run(&action) {
            Ok(()) => done = true,
            Err(NotDone { text, again }) => doing.sent.toast(doing.toasts, text, again.then_some(action.clone())),
        });
        // an archived session is over for good (5.2.10): the hub takes nothing more for its group, and the agent
        // device a self-joined session brought along goes with it
        // a sent note's toast offers Undo while it is held
        if let (true, Action::SendNote { note_id, .. }) = (done, &action) {
            let text = crate::views::Text::new("notes.sent", "Note sent.");
            self.sent.undo_toast(&mut self.next_view.toasts, text, None, Action::UnsendNote { note_id: note_id.clone() });
        }
        if let (true, Action::ArchiveSession { session_id, on: true }) = (done, &action) {
            self.archive_group(now_ms, session_id, out);
        }
    }

    fn archive_group(&mut self, now_ms: u64, session_id: &str, out: &mut Vec<Effect>) {
        let Some(s) = self.board.model.sessions.get(session_id) else { return };
        let unhex = |h: &str| (0..h.len() / 2).map(|i| u8::from_str_radix(h.get(i * 2..i * 2 + 2).unwrap_or(""), 16).ok()).collect::<Option<Vec<u8>>>();
        let Some(group) = s.group_id.as_deref().and_then(unhex).and_then(|b| trommi_core::ids::GroupId::from_bytes(&b).ok()) else { return };
        let vouched = s.settings.as_ref().and_then(|v| v.get("vouched")).is_some_and(|v| v.is_object());
        let retire: Vec<trommi_core::ids::DeviceId> = if vouched {
            s.agent_device_id.as_deref().and_then(unhex).and_then(|b| <[u8; 32]>::try_from(b).ok()).map(trommi_core::ids::DeviceId::new).into_iter().collect()
        } else {
            Vec::new()
        };
        if let Some(Err(why)) = self.with_engine(now_ms, out, |engine, ctx| engine.archive_session(ctx, group, retire)) {
            out.push(log(LogLevel::Warn, &format!("archive: {why}")));
        }
    }

    /// The file actions (`crate::files`): true when `action` was one.
    fn file_action(&mut self, now_ms: u64, action: &Action, out: &mut Vec<Effect>) -> bool {
        let Some(engine) = self.engine.as_mut() else { return false };
        let send = match action {
            Action::Attach { local_id, name, media_type, bytes } => {
                engine.with_entropy(|entropy| self.files.attach(local_id, name, media_type, bytes, entropy)).map(Some)
            }
            Action::OpenFile { attachment_id, save } => self.files.open(attachment_id, *save, out),
            Action::Share { attachment_id, expires_ms } => {
                engine.with_entropy(|entropy| self.files.share(attachment_id, *expires_ms, now_ms, entropy)).map(Some)
            }
            Action::RevokeShare { share_id } => self.files.unshare(share_id).map(Some),
            Action::CancelFile { file_id } => {
                for id in self.files.cancel(file_id) {
                    if let Some(flying) = engine.forget_request(id) {
                        out.push(Effect::Cancel { id: flying });
                    }
                }
                Ok(None)
            }
            _ => return false,
        };
        self.stale_views = true;
        match send {
            Ok(Some(send)) => {
                let (build, keep, pending, expect) = send.split();
                let sent = self.with_engine(now_ms, out, |engine, ctx| engine.request(ctx, build, keep));
                let expect = expect.borrow_mut().take();
                match (sent, expect) {
                    (Some(Ok(id)), Some(expect)) => self.files.sent(id, pending, expect),
                    _ => {
                        self.files.not_sent(pending);
                        let text = crate::views::Text::new("file.not_sent", "That could not be sent. Try again.");
                        self.sent.toast(&mut self.next_view.toasts, text, None);
                    }
                }
            }
            Ok(None) => {}
            Err(text) => self.sent.toast(&mut self.next_view.toasts, text, None),
        }
        true
    }

    /// `StrokePiece`: the points of a stroke still being drawn, relayed (7.2); true when `action` was one. A piece
    /// that does not go is not sent again: the finished stroke carries every point (`epoch-full` is said nowhere).
    fn piece_action(&mut self, now_ms: u64, action: &Action, out: &mut Vec<Effect>) -> bool {
        let Action::StrokePiece { board_id, piece } = action else { return false };
        let (Some(board), Ok(text)) = (crate::scribble::board_of(board_id), crate::codec::encode_piece(piece)) else {
            out.push(log(LogLevel::Debug, "stroke piece: not one this core sends"));
            return true;
        };
        let sent = self.with_engine(now_ms, out, |engine, ctx| engine.act(ctx, |device, _| device.send_stroke_piece(&board, text.as_bytes())));
        if let Some(Err(e)) = sent.filter(|r| !matches!(r, Err(trommi_core::Error::EpochFull))) {
            out.push(log(LogLevel::Debug, &format!("stroke piece: {}", e.code())));
        }
        true
    }

    /// Erases these shapes on a board (`desk/<32 hex>`; a team's delete, `team_delete::Step::EraseBoard`): erase
    /// items of at most `scribble::ERASE_CHUNK` shapes each, shown at once as any `BoardItem`.
    pub fn erase_board(&mut self, now_ms: u64, board_id: &str, shape_ids: &[String]) -> Vec<Effect> {
        let mut out = Vec::new();
        for chunk in shape_ids.chunks(crate::scribble::ERASE_CHUNK) {
            let content = serde_json::json!({ "content_type": "erase", "stroke_ids": chunk });
            self.action(now_ms, Action::BoardItem { board_id: board_id.into(), local_id: String::new(), content }, &mut out);
        }
        self.after_engine(now_ms, &mut out);
        self.render(&mut out);
        out
    }

    /// Reads a board that is not in view (a team's delete, `team_delete::Step::LoadBoard`) and, with `snapshot`,
    /// writes its snapshot as soon as nothing of it is in flight however few items it has
    /// (`team_delete::Step::WriteSnapshot`: the empty board).
    pub fn board_work(&mut self, now_ms: u64, board_id: &str, snapshot: bool) -> Vec<Effect> {
        let mut out = Vec::new();
        if let Some(board) = crate::scribble::board_in_view(board_id) {
            self.scribble.read(board);
            if snapshot {
                self.scribble.snapshot_now(board);
            }
        }
        self.after_engine(now_ms, &mut out);
        self.render(&mut out);
        out
    }

    /// What this device knows of a board once it was read (`team_delete::Known::board`): its shapes, the files of
    /// its pictures, whether its newest snapshot is of the empty board.
    pub fn board_known(&self, board_id: &str) -> Option<crate::team_delete::BoardKnown> {
        self.scribble.known(&crate::scribble::board_in_view(board_id)?)
    }

    /// Runs `step` with what an action needs (the model, the bookkeeping, the device's seal), then shows what it
    /// changed. Nothing without a device.
    fn doing(&mut self, now_ms: u64, out: &mut Vec<Effect>, step: impl FnOnce(&mut Doing<'_>)) {
        let utc_offset_min = self.lens.utc_offset_min;
        let Some(engine) = self.engine.as_mut() else {
            return;
        };
        let room = engine.room();
        let mut ctx = engine::Ctx {
            now: now_ms,
            next_id: &mut self.next_id,
            out,
        };
        let mut seal = |draft: &trommi_core::device::Draft,
                        to: Option<&trommi_core::ids::DeviceId>,
                        files: &[trommi_core::ids::FileId]| {
            engine.act(&mut ctx, |device, now| device.seal(draft, to, files, now))
        };
        let files = &self.files;
        let file = |id: &str| files.reference(id).cloned();
        let mut doing = Doing {
            file: &file,
            model: &mut self.board.model,
            sent: &mut self.sent,
            toasts: &mut self.next_view.toasts,
            room,
            now: now_ms,
            utc_offset_min,
            seal: &mut seal,
            change: Change::default(),
        };
        step(&mut doing);
        let mut change = std::mem::take(&mut doing.change);
        self.board.model.project(&mut change, now_ms);
        self.stale_views = true;
        self.goals_check = true;
    }

    /// A Note's version is back, refused or lost: the edit that waited behind it is sealed on what stands now.
    fn notes_free(&mut self, now_ms: u64, free: Vec<(String, Option<NoteNext>)>, out: &mut Vec<Effect>) {
        for (id, next) in free {
            let Some(next) = next else { continue };
            self.doing(now_ms, out, |doing| {
                if let Err(NotDone { text, again }) = doing.seal_note(&next.action, Some(&id), &next.own, next.closed, &next.local_id) {
                    doing.sent.toast(doing.toasts, text, again.then_some(next.action.clone()));
                }
            });
        }
    }

    /// What the hub said of the actions in flight, and the ones whose entry is gone without a word: each echo of
    /// a refused or lost entry is rolled back, with a toast that offers the action again.
    fn settle_actions(&mut self, now_ms: u64, refused: Vec<(u64, &'static str)>, out: &mut Vec<Effect>) {
        // (goals refused are written again at the next look)
        self.sent.goals.retain(|_, (_, entry)| !refused.iter().any(|(id, _)| id == entry));
        for written in self.sent.knowledge.values_mut() {
            written.retain(|_, (_, entry)| !refused.iter().any(|(id, _)| id == entry));
        }
        let mut gone: Vec<(u64, crate::views::Text)> =
            refused.into_iter().map(|(id, code)| (id, actions::run::refused(code))).collect();
        if !self.sent.is_empty() {
            if let Some(engine) = self.engine.as_ref() {
                let held = engine.device().outbox().iter().map(|e| e.id).collect();
                gone.extend(self.sent.gone(&held).into_iter().map(|id| (id, actions::run::lost())));
            }
        }
        if gone.is_empty() {
            return;
        }
        let mut change = Change::default();
        let mut offered: Vec<Action> = Vec::new();
        let mut free = Vec::new();
        for (id, text) in gone {
            free.extend(self.sent.note_back(None, Some(id)));
            for out in self.sent.take(id) {
                if let Some(local_id) = &out.local_id {
                    self.board.model.rollback_echo(local_id, &mut change);
                }
                // (one toast per action, however many entries it made)
                if !offered.contains(&out.action) {
                    offered.push(out.action.clone());
                    self.sent.toast(&mut self.next_view.toasts, text.clone(), Some(out.action));
                }
            }
        }
        self.board.model.project(&mut change, now_ms);
        self.stale_views = true;
        self.notes_free(now_ms, free, out);
    }

    /// The stored device as the shell loaded it: an engine over it, or the sign-in screens.
    fn open(&mut self, now_ms: u64, revision: u64, entries: Vec<DeviceEntry>, out: &mut Vec<Effect>) {
        let Some(config) = self.config.as_ref() else {
            return;
        };
        let hub = if !config.hub.is_empty() {
            config.hub.as_str()
        } else {
            self.stored_hub.as_deref().unwrap_or(DEFAULT_HUB)
        };
        let client = format!("{}/{}", config.platform, config.version);
        let entropy = self
            .entropy
            .take()
            .unwrap_or_else(|| Box::new(trommi_core::crypto::SystemEntropy));
        // (opened again in place: the board stays as it was shown, the new engine brings what is new)
        let again = self.engine.is_some();
        match Engine::open_with(hub, &client, config.seed, revision, entries, entropy) {
            Ok(engine) if again && engine.device().id() != self.board_device() => {
                out.push(log(LogLevel::Error, "device open: another device is stored now"));
                self.next_view.phase = Phase::Stopped;
            }
            Ok(engine) => {
                if !again {
                    self.board = engine::feed::Board::new(engine.device());
                    self.past = Default::default();
                }
                self.stale_views = true;
                // the cache first: the board it holds is drawn before the engine asks the hub anything
                let room = engine::feed::hex(engine.room().as_bytes());
                let device = engine::feed::hex(engine.device().id().as_bytes());
                self.cache = Some(crate::cache::Keeper::open(&room, &device, revision, &mut self.next_id, out));
                if !again {
                    self.seen_open(&room, out);
                }
                self.engine = Some(engine);
                self.next_view.phase = Phase::Opening;
                self.outside_opened(out);
            }
            Err(OpenError::NoRoom) if !again => { self.next_view.phase = Phase::SignedOut; self.outside_signed_out(out); },
            Err(OpenError::Interrupted) if !again => {
                self.next_view.phase = Phase::SignedOut;
                self.room_join = Some(engine::room_join::RoomJoinStatus::Failed(engine::room_join::RoomJoinError::Interrupted));
            }
            Err(OpenError::Interrupted) => {
                out.push(log(LogLevel::Error, "device open: the stored state holds no room now"));
                self.next_view.phase = Phase::Stopped;
            }
            Err(OpenError::NoRoom) => {
                out.push(log(LogLevel::Error, "device open: the stored state holds no room now"));
                self.next_view.phase = Phase::Stopped;
            }
            Err(OpenError::Device(code)) => {
                out.push(log(LogLevel::Error, &format!("device open: {code}")));
                self.closed(now_ms, out);
            }
            Err(OpenError::Hub) => {
                out.push(log(LogLevel::Error, "start: the hub's address is not canonical"));
                self.next_view.phase = Phase::Stopped;
            }
        }
    }

    /// The id of the device the board is of (the one opened first).
    fn board_device(&self) -> trommi_core::ids::DeviceId {
        self.engine.as_ref().map_or(trommi_core::ids::DeviceId::new([0; 32]), |e| e.device().id())
    }

    /// The device closed itself, or its stored state did not open again: read again after a wait, at most
    /// [`REOPEN_TRIES`] times in a row; then the App stops. Only a device that ran here is opened again in place.
    fn closed(&mut self, now_ms: u64, out: &mut Vec<Effect>) {
        if self.engine.is_none() {
            self.next_view.phase = Phase::Stopped;
            return;
        }
        self.reopen_tries += 1;
        if self.reopen_tries > REOPEN_TRIES {
            out.push(log(LogLevel::Error, "the device does not open again: stopped"));
            self.reopen_at = None;
            self.next_view.phase = Phase::Stopped;
            return;
        }
        let wait = engine::Backoff::HUB.delay_ms(self.reopen_tries, None, self.jitter.draw());
        self.reopen_at = Some(now_ms + wait);
        self.next_view.phase = Phase::Opening;
    }

    /// Reads the stored state again, to open it in place of the closed device.
    fn reopen(&mut self, out: &mut Vec<Effect>) {
        self.reopen_at = None;
        let id = self.io(Pending::DeviceLoad);
        out.push(Effect::Store { id, op: StoreOp::DeviceLoad });
    }

    /// An answer to one of the cache's store ops; false when it was none. Once the start's read is through, the board
    /// holds what it gave and the engine starts.
    fn cached(&mut self, now_ms: u64, id: IoId, result: &IoResult<StoreAnswer>, out: &mut Vec<Effect>) -> bool {
        let Some(cache) = self.cache.as_mut() else {
            return false;
        };
        let read = match cache.on_store(id, result, &mut self.board.model, now_ms, &mut self.next_id, out) {
            crate::cache::Took::No => return false,
            crate::cache::Took::Mine => return true,
            crate::cache::Took::Read(read) => read,
        };
        match read {
            crate::cache::Read::Loaded { listing, .. } => {
                // the Desk the hub listed last stands until it lists anew
                if let Some(listing) = listing {
                    self.board.model.set_desk_listing(Some((listing.at, listing.open)));
                    self.board.model.set_desk_hold(false);
                }
                let change = self.board.finish(now_ms);
                cache.note(&change);
            }
            crate::cache::Read::Dropped => {
                if let Some(engine) = self.engine.as_ref() {
                    self.board = engine::feed::Board::new(engine.device());
                    self.past = Default::default();
                }
                out.push(log(LogLevel::Warn, "the cache was not whole or not this device's: dropped"));
            }
            crate::cache::Read::Empty => {}
        }
        self.stale_views = true;
        self.with_engine(now_ms, out, |engine, ctx| engine.start(ctx));
        true
    }

    fn with_engine<T>(
        &mut self,
        now_ms: u64,
        out: &mut Vec<Effect>,
        step: impl FnOnce(&mut Engine, &mut engine::Ctx<'_>) -> T,
    ) -> Option<T> {
        let engine = self.engine.as_mut()?;
        let mut ctx = engine::Ctx {
            now: now_ms,
            next_id: &mut self.next_id,
            out,
        };
        Some(step(engine, &mut ctx))
    }

    /// What the engine reported since the last event: the phase, the alerts, the timer.
    fn after_engine(&mut self, now_ms: u64, out: &mut Vec<Effect>) {
        let Some(engine) = self.engine.as_mut() else {
            let wake = self.config.as_ref().and_then(|_| self.departures.wake());
            if wake != self.timer { self.timer = wake; out.push(Effect::Timer { at_ms:wake }); }
            return;
        };
        let mut fed = false;
        let mut evicted = Vec::new();
        let mut stopped = false;
        let mut removed = false;
        let mut refused = Vec::new();
        let mut dropped = false;
        let joining_room = engine.joining_room();
        let mut notes_back = Vec::new();
        let mut invite_news = Vec::new();
        let mut invite_answers = Vec::new();
        let mut step_answers = Vec::new();
        let mut replaced: Option<Option<&'static str>> = None;
        while let Some(report) = engine.next_report() {
            self.board.take(&report, engine.device(), now_ms);
            fed = true;
            match &report {
                Report::Envelope { received, .. } => self.scribble.envelope(received, now_ms),
                Report::Relay(received) => {
                    if let trommi_core::device::Received::StrokePiece { from, board, piece } = &**received {
                        self.scribble.piece(from, board, piece, now_ms);
                    }
                }
                _ => {}
            }
            match report {
                Report::Desk { at, open, truncated: false } => {
                    if let Some(cache) = self.cache.as_mut() {
                        let open = open.iter().map(|(id, version)| (engine::feed::hex(id.as_bytes()), *version)).collect();
                        cache.listed(crate::cache::Listing { at, open });
                    }
                }
                // an own Note's version back from the hub: the edit that waited behind it can follow
                Report::Envelope { received, .. } if !self.sent.notes.is_empty() => {
                    let hash = crate::engine::feed::hex(received.envelope_hash.as_bytes());
                    notes_back.extend(self.sent.note_back(Some(&hash), None));
                }
                Report::Connection(Connection::Live) => {
                    self.next_view.phase = Phase::Live;
                    self.reopen_tries = 0;
                }
                Report::Connection(Connection::Offline) => self.next_view.phase = Phase::Offline,
                Report::Connection(Connection::CatchingUp) => {
                    if self.next_view.phase != Phase::Live {
                        self.next_view.phase = Phase::Opening
                    }
                }
                Report::Stopped(_) if joining_room => {
                    // (a device that is joining the room is not opened again: the join is asked for again)
                    dropped = true;
                    self.room_join = Some(engine::room_join::RoomJoinStatus::Failed(engine::room_join::RoomJoinError::Device("storage")));
                }
                Report::Stopped(engine::Stopped::Removed) => { removed = true; },
                Report::Stopped(why) if why.reopens() => stopped = true,
                Report::Stopped(_) => {
                    self.next_view.phase = Phase::Stopped;
                    if let Some(cache) = self.cache.as_mut() {
                        cache.stop();
                    }
                }
                Report::LinkJoin(status) => {
                    use crate::engine::sync::link_join::LinkJoinStatus;
                    match status {
                        LinkJoinStatus::Asking => {}
                        LinkJoinStatus::Code(code) => {
                            self.next_view.account = crate::views::AccountView { step: "compare_emoji".into(), emoji: invites::emoji_of(code), ..Default::default() };
                        }
                        LinkJoinStatus::Joined => {
                            self.next_view.account = crate::views::AccountView { step: "none".into(), ..Default::default() };
                            self.next_view.phase = Phase::Opening;
                        }
                        LinkJoinStatus::Failed(code) => {
                            dropped = true;
                            self.next_view.account = crate::views::AccountView { step: "join".into(), problem: Some(link_problem(code)), ..Default::default() };
                        }
                    }
                }
                Report::Founded(None) => {
                    if let Some((_, founding)) = self.founding.take() {
                        self.kit.mark = true;
                        self.next_view.account = crate::views::AccountView { step: "keep_kit".into(), kit: founding.kit_words(), ..Default::default() };
                    }
                }
                Report::Founded(Some(code)) => {
                    dropped = true;
                    self.founding = None;
                    let text = match code {
                        "account-exists" => crate::views::Text::new("account.exists", "An account with this e-mail exists. Sign in instead."),
                        "rate-limited" | "throttled" => crate::views::Text::new("account.throttled", "Too many tries. Wait a moment, then try again."),
                        code => crate::views::Text::new("account.found_failed", &format!("The room was not made ({code}).")),
                    };
                    self.next_view.account = crate::views::AccountView { step: "found".into(), problem: Some(text), ..Default::default() };
                }
                Report::SessionsJoined { not_joined, .. } => self.sessions_not_joined = Some(not_joined),
                Report::Answer(answered) if self.invites.owns(answered.id) => invite_answers.push(*answered),
                Report::Answer(answered) if self.steps.asked.contains_key(&answered.id) => step_answers.push(*answered),
                Report::Answer(answered) if self.scribble.owns(answered.id) => {
                    let mut ctx = engine::Ctx { now: now_ms, next_id: &mut self.next_id, out };
                    self.scribble.answered(answered.id, &answered.result, engine, &mut ctx);
                }
                Report::Answer(answered) if self.past.owns(answered.id) => {
                    let mut ctx = engine::Ctx { now: now_ms, next_id: &mut self.next_id, out };
                    self.past.answered(answered.id, &answered.result, engine, &mut ctx);
                }
                Report::Answer(answered) if self.files.owns(answered.id) => {
                    if let Some(text) = self.files.answered(answered.id, &answered.result, out) {
                        self.sent.toast(&mut self.next_view.toasts, text, None);
                    }
                    self.stale_views = true;
                }
                Report::Answer(answered) => {
                    if let Some(keep) = answered.keep.as_deref().filter(|k| k.starts_with("unshare/")) {
                        self.files.kept_answered(keep);
                        self.stale_views = true;
                    } else {
                        self.answers.push(*answered);
                    }
                }
                Report::RoomJoin(status) => {
                    use engine::room_join::RoomJoinStatus;
                    match status {
                        RoomJoinStatus::Failed(_) => dropped = engine.device().room().is_none(),
                        RoomJoinStatus::Joined => { self.sessions_not_joined = None; self.next_view.phase = Phase::Opening; },
                        _ => {}
                    }
                    self.room_join = Some(status);
                }
                Report::InviteRequest { invite } => {
                    invite_news.push(invite);
                    if !self.invite_requests.contains(&invite) {
                        if self.invite_requests.len() >= INVITE_REQUESTS_MAX {
                            self.invite_requests.remove(0);
                        }
                        self.invite_requests.push(invite);
                    }
                }
                Report::FileEvicted { file } => evicted.push(file),
                Report::Groups | Report::Log { .. } => self.outside.keys_due = true,
                Report::Accepted { id, .. } if self.changes.replacing() == Some(id) => replaced = Some(None),
                Report::Refused { id, code, .. } if self.changes.replacing() == Some(id) => replaced = Some(Some(code)),
                Report::Accepted { id, .. } => {
                    self.sent.take(id);
                    let mut ctx = engine::Ctx { now: now_ms, next_id: &mut self.next_id, out };
                    self.scribble.accepted(id, engine, &mut ctx);
                }
                Report::Refused { id, code, .. } => {
                    self.scribble.refused(id);
                    refused.push((id, code));
                }
                Report::Alert(alert) => {
                    if self.alerts.len() >= ALERTS_MAX {
                        self.alerts.remove(0);
                    }
                    self.alerts.push(alert);
                }
                _ => {}
            }
        }
        if removed {
            self.forget_local_device(now_ms, out);
            self.next_view.account.notice = Some(account_steps::removed());
            out.insert(0, Effect::ForgetShared);
            return;
        }
        // the windows the past's pages left (their envelopes came as reports above), and what the pages in view
        // and the starred stack still need of it
        for w in self.past.take_windows() {
            self.board.window(&w.key, w.down_to, w.more);
            fed = true;
        }
        if !dropped {
            let mut ctx = engine::Ctx { now: now_ms, next_id: &mut self.next_id, out };
            self.past.tend(&self.lens, &self.board.model, engine, &mut ctx);
            let (off_reading, off_hub_more) = self.past.settled_state();
            if (off_reading, off_hub_more) != (self.lens.off_reading, self.lens.off_hub_more) {
                (self.lens.off_reading, self.lens.off_hub_more) = (off_reading, off_hub_more);
                self.stale_views = true;
            }
            let waits = self.past.talk_waits(&self.lens, &self.board.model);
            if waits != self.lens.talk_waits {
                self.lens.talk_waits = waits;
                self.stale_views = true;
            }
        }
        if !evicted.is_empty() {
            // the cached bytes of a file the hub deleted (11.3) go
            let room = crate::engine::feed::hex(engine.room().as_bytes());
            let delete = evicted.iter().map(|file| crate::cache::key(&room, crate::cache::part::FILE, Some(&crate::engine::feed::hex(file.as_bytes())))).collect();
            let id = IoId(self.next_id);
            self.next_id += 1;
            self.pending.insert(id, Pending::CacheDelete);
            out.push(Effect::Store { id, op: StoreOp::Put { put: Vec::new(), delete } });
        }
        if !dropped {
            let live = self.next_view.phase == Phase::Live;
            let mut ctx = engine::Ctx { now: now_ms, next_id: &mut self.next_id, out };
            self.scribble.tend(now_ms, live, &self.board.model, engine, &mut ctx);
            for note in self.scribble.notes.drain(..) {
                out.push(log(LogLevel::Warn, &note));
            }
            if self.scribble.take_dirty() {
                self.stale_views = true;
            }
        }
        let engine_wake = if dropped {
            // a join of the room that failed: the engine goes (what it wrote last is the wipe, still stored)
            for id in engine.forget() {
                self.pending.insert(id, Pending::Dropped);
            }
            self.engine = None;
            self.board = engine::feed::Board::default();
            self.past = Default::default();
            self.scribble = crate::scribble::Scribble::default();
            self.stale_views = true;
            self.next_view.phase = Phase::SignedOut;
            None
        } else {
            engine.next_wake()
        };
        // (a view's moment by the clock, a link that falls asleep: the model's statuses are worked out at its clock,
        //  so the board is brought to now first)
        let view_due = self.view_wake.is_some_and(|at| now_ms >= at);
        if fed || view_due || (self.board.model.desk_wake != 0 && now_ms >= self.board.model.desk_wake) {
            let change = self.board.finish(now_ms);
            if let Some(cache) = self.cache.as_mut() {
                cache.note(&change);
            }
            self.stale_views = true;
        }
        // (the cache's writes go behind every device write handed out so far: the shell holds them at its barrier)
        let mut cache_wake = None;
        if let Some(cache) = self.cache.as_mut() {
            cache.saw(out);
            cache.step(now_ms, &mut self.next_id, out);
            cache_wake = cache.next_wake();
        }
        self.settle_actions(now_ms, refused, out);
        for answered in invite_answers {
            self.invite_answered(now_ms, answered.id, &answered.result, out);
        }
        for answered in step_answers {
            self.step_answered(now_ms, answered.id, &answered.result, out);
        }
        if let Some(refused) = replaced {
            self.change_replaced(now_ms, refused, out);
        }
        for invite in invite_news {
            self.invites_look(now_ms, Some(invite), out);
        }
        self.invites_settle(now_ms, out);
        if fed {
            self.selfjoin_tend(now_ms, out);
        }
        self.kit_tend(now_ms, out);
        self.notes_free(now_ms, notes_back, out);
        self.goals_check |= fed;
        if !self.held_actions.is_empty() && self.next_view.phase == Phase::Live {
            for action in std::mem::take(&mut self.held_actions) {
                self.run_action(now_ms, action, out);
            }
        }
        if self.goals_check && self.next_view.phase == Phase::Live {
            self.doing(now_ms, out, |doing| {
                doing.sync_goals();
                doing.sync_knowledge();
            });
            self.goals_check = false;
        }
        // this device's push, as the hub has it; its notes whose hold ran out go to their session
        if self.next_view.phase == Phase::Live {
            self.push_look(now_ms, out);
            self.deliver_notes(now_ms, out);
            self.drive_imports(now_ms, out);
        }
        // a team's delete: its next step once the last one shows
        if fed || !self.teams.running.is_empty() {
            self.drive_team_deletes(now_ms, out);
        }
        // The board's units: made again when the model, the lens or the clock moved (every unit whole; a unit that
        // did not change is not sent, `ViewModel::diff`).
        if self.stale_views || view_due {
            self.seen_tend(out);
        }
        if self.stale_views || view_due {
            self.stale_views = false;
            self.lens.reading = self.board.model.reading;
            let (wake, mut shown) = crate::views::render_with_files(&self.board.model, &self.lens, now_ms, &mut self.next_view);
            self.next_view.board = self.scribble.view(&self.board.model);
            shown.extend(self.scribble.pictures(&self.board.model));
            self.next_view.thumbs = self.thumbs();
            crate::views::desk::board_tile(&mut self.next_view.desk, self.next_view.thumbs.as_deref());
            if let Some(engine) = self.engine.as_ref() {
                self.next_view.settings.room = Some(engine::feed::hex(engine.room().as_bytes()));
                self.next_view.settings.hub = Some(engine.hub().to_string());
            }
            self.next_view.settings.team_counts = self.team_counts();
            self.show_team_deletes();
            self.view_wake = wake;
            self.files.shown(shown, &mut self.next_view.files);
        }
        if stopped {
            self.closed(now_ms, out);
        }
        let model_wake = Some(self.board.model.desk_wake).filter(|at| *at != 0);
        let wake = [self.past.wake(), engine_wake, model_wake, self.view_wake, cache_wake, self.reopen_at, self.invites.wake(), self.scribble.wake(now_ms), self.teams.wake(now_ms), self.notes_wake().map(|at| at.max(now_ms + 1)), self.departures.wake()].into_iter().flatten().min();
        if wake != self.timer {
            self.timer = wake;
            out.push(Effect::Timer { at_ms: wake });
        }
        self.outside.due |= fed;
        self.outside(now_ms, out);
    }

    fn io(&mut self, what: Pending) -> IoId {
        let id = IoId(self.next_id);
        self.next_id += 1;
        self.pending.insert(id, what);
        id
    }

    /// Puts a `Render` first when the view changed: the shell draws before it starts the I/O.
    fn render(&mut self, out: &mut Vec<Effect>) {
        self.follow_sign_in();
        // A sign-in cut off before its sessions were joined (a reload, the app closed): the device is in its room,
        // so the app opens as it would (a reload or a link lands on its page), and asks for the way in again on
        // the side; giving it finishes the joins (`join_room`). It never signs the device out.
        self.next_view.account.resume = (self.can_resume_sign_in() && !self.signed_in_join)
            .then(|| crate::views::Text::new("account.interrupted", "Signing in was cut off. Sign in again to finish it."));
        self.account_extras();
        self.start_status();
        let delta = if !self.rendered_once {
            self.rendered_once = true;
            let mut whole = self.next_view.clone();
            whole.rev = 0;
            Some(crate::views::ViewDelta {
                base: 0,
                parts: vec![crate::views::ViewPart::Whole {
                    model: Box::new(whole),
                }],
            })
        } else {
            self.view.diff(&self.next_view)
        };
        if let Some(delta) = delta {
            // the core's own fold, so `view` is exactly what a shell holds
            if self.view.apply(&delta).is_ok() {
                self.next_view.rev = self.view.rev;
                out.insert(0, Effect::Render { delta });
            }
        }
    }
}

/// The words of a join by link that did not work.
fn link_problem(code: &str) -> crate::views::Text {
    use crate::views::Text;
    match code {
        "invite-expired" => Text::new("join.expired", "The link has ended. Ask for a new one."),
        "invite-used" => Text::new("join.used", "The link was used already. Ask for a new one."),
        "code-mismatch" => Text::new("join.mismatch", "The other device said the emoji do not match. Nothing was joined."),
        "bad-invite" | "bad-format" => Text::new("join.bad_link", "That is not an invite link."),
        "room-exists" => Text::new("join.room_exists", "This device is in a room already."),
        code => Text::new("join.failed", &format!("Joining did not work ({code}).")),
    }
}

/// Whether an action writes a register of the room group (stars, snoozes, drafts, sessions' settings, teams).
fn writes_room_registers(action: &Action) -> bool {
    matches!(
        action,
        Action::Star { .. }
            | Action::Snooze { .. }
            | Action::Unsnooze { .. }
            | Action::Draft { .. }
            | Action::RenameSession { .. }
            | Action::ArchiveSession { .. }
            | Action::MoveSession { .. }
            | Action::AddTeam { .. }
            | Action::RenameTeam { .. }
            | Action::RemoveTeam { .. }
            | Action::SetGoal { .. }
            | Action::KnowledgeSave { .. }
            | Action::KnowledgePin { .. }
            | Action::KnowledgeDelete { .. }
            | Action::SessionIcon { .. }
            | Action::SessionGroup { .. }
            | Action::PlaceSession { .. }
            | Action::CrownSession { .. }
            | Action::OrderTeams { .. }
            | Action::RenameDevice { .. }
            | Action::DeleteSession { .. }
    )
}

fn log(level: LogLevel, text: &str) -> Effect {
    Effect::Log {
        level,
        text: text.to_string(),
    }
}

#[cfg(test)]
mod tests;
