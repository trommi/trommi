//! Signing in to the hub (spec/v1.md 12.3, D5): a device signs a challenge of the hub with its device key and
//! gets a token for ten minutes, bound to the device. Challenges and tokens live in memory: a restart ends them
//! and devices sign in again.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

use rusqlite::Connection;
use sha2::{Digest, Sha256};

use crate::error::{refuse, Res};
use crate::observer::{Device, Observer};
use crate::store::{self, Auth, Room, Who};
use crate::util::{b64, random};
use crate::wire::HubAuth;

pub const CHALLENGE_MS: u64 = 120_000;
pub const TOKEN_MS: u64 = 600_000;
const MAX_CHALLENGES: usize = 10_000;

struct Token {
    room: Room,
    device: Device,
    expires_at: u64,
}

#[derive(Default)]
struct State {
    challenges: HashMap<[u8; 32], (Room, u64)>,
    order: VecDeque<[u8; 32]>,
    /// by the SHA-256 of the token: the token itself is nowhere in memory after it was handed out
    tokens: HashMap<[u8; 32], Token>,
}

#[derive(Default)]
pub struct Sessions {
    state: Mutex<State>,
}

fn key_of(token: &str) -> [u8; 32] {
    Sha256::digest(token.as_bytes()).into()
}

impl Sessions {
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 32 random bytes, two minutes, one use.
    pub fn challenge(&self, room: &Room, now: u64) -> [u8; 32] {
        let challenge = random::<32>();
        let mut s = self.lock();
        while s.order.len() >= MAX_CHALLENGES {
            if let Some(old) = s.order.pop_front() {
                s.challenges.remove(&old);
            }
        }
        s.challenges.insert(challenge, (*room, now + CHALLENGE_MS));
        s.order.push_back(challenge);
        challenge
    }

    /// Checks `HubAuth` and its signature and issues a token. The challenge is used up whatever the outcome.
    #[allow(clippy::too_many_arguments)]
    pub fn sign_in(
        &self,
        c: &Connection,
        obs: &dyn Observer,
        hub: &str,
        room: &Room,
        auth: &[u8],
        signature: &[u8],
        now: u64,
    ) -> Res<(String, u64, Option<Who>)> {
        let parsed = HubAuth::parse(auth)?;
        let known = self.lock().challenges.remove(&parsed.challenge);
        match known {
            Some((for_room, expires)) if &for_room == room && expires > now => {}
            _ => {
                return Err(refuse(
                    "bad-challenge",
                    "the challenge is unknown, used or ran out",
                ))
            }
        }
        if &parsed.room_id != room {
            return Err(refuse("wrong-room", "signed for another room"));
        }
        // the hub's own canonical address, never normalised
        if parsed.hub != hub.as_bytes() {
            return Err(refuse("bad-format", "signed for another hub address"));
        }
        if !obs.verify(&parsed.device, "TrommiHubAuth", auth, signature) {
            return Err(refuse(
                "bad-signature",
                "the sign-in signature does not verify",
            ));
        }
        // A device that was removed lately gets a token all the same: it has no standing, so every route answers
        // it `not-member` as before, but the one that shows it its removal (13.5).
        let who = match store::standing(c, room, &parsed.device)? {
            Some(who) => Some(who),
            None if crate::delivery::removed_lately(c, room, &parsed.device, now)? => None,
            None => return Err(refuse("not-member", "this key has no standing in the room")),
        };
        let token = b64(&random::<32>());
        let expires_at = now + TOKEN_MS;
        let mut s = self.lock();
        s.tokens.retain(|_, t| t.expires_at > now);
        s.tokens.insert(
            key_of(&token),
            Token {
                room: *room,
                device: parsed.device,
                expires_at,
            },
        );
        Ok((token, expires_at, who))
    }

    /// The asker behind a token, checked against the device's present standing (12.3.1): a revoked device's and
    /// a replaced recovery key's tokens end at once.
    pub fn authorise(&self, c: &Connection, bearer: Option<&str>, now: u64) -> Res<Auth> {
        self.authorise_until(c, bearer, now).map(|(auth, _)| auth)
    }

    /// As `authorise`, with the time the token runs out.
    /// Whether a token is still one (it may have been signed out since it was checked).
    pub fn holds(&self, bearer: Option<&str>, now: u64) -> bool {
        bearer
            .and_then(|h| h.split_once(' '))
            .filter(|(_, token)| token.len() <= 200)
            .is_some_and(|(_, token)| {
                self.lock()
                    .tokens
                    .get(&key_of(token))
                    .is_some_and(|t| t.expires_at > now)
            })
    }

    /// Room and device of a token, whatever the device's standing: for the one route a removed device has.
    pub fn bearer(&self, bearer: Option<&str>, now: u64) -> Option<(Room, Device)> {
        let (scheme, token) = bearer?.split_once(' ')?;
        if !scheme.eq_ignore_ascii_case("Bearer") || token.len() > 200 {
            return None;
        }
        self.lock()
            .tokens
            .get(&key_of(token))
            .filter(|t| t.expires_at > now)
            .map(|t| (t.room, t.device))
    }

    /// A deleted room: its tokens and challenges are none any more.
    pub fn forget_room(&self, room: &Room) {
        let mut s = self.lock();
        s.tokens.retain(|_, t| &t.room != room);
        s.challenges.retain(|_, (r, _)| r != room);
    }

    /// Signing out: the token is no token any more. `false`: it was none.
    pub fn revoke(&self, bearer: Option<&str>) -> bool {
        let token = bearer
            .and_then(|h| h.split_once(' '))
            .filter(|(scheme, _)| scheme.eq_ignore_ascii_case("Bearer"))
            .map(|(_, token)| token);
        match token {
            Some(token) if token.len() <= 200 => {
                self.lock().tokens.remove(&key_of(token)).is_some()
            }
            _ => false,
        }
    }

    pub fn authorise_until(
        &self,
        c: &Connection,
        bearer: Option<&str>,
        now: u64,
    ) -> Res<(Auth, u64)> {
        let unauthorised = || refuse("unauthorised", "sign in");
        // (the scheme's name in any case, RFC 9110)
        let token = bearer
            .and_then(|h| h.split_once(' '))
            .filter(|(scheme, _)| scheme.eq_ignore_ascii_case("Bearer"))
            .map(|(_, token)| token)
            .ok_or_else(unauthorised)?;
        if token.len() < 16
            || token.len() > 200
            || !token
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err(unauthorised());
        }
        let key = key_of(token);
        let (room, device, until) = {
            let s = self.lock();
            let t = s
                .tokens
                .get(&key)
                .filter(|t| t.expires_at > now)
                .ok_or_else(unauthorised)?;
            (t.room, t.device, t.expires_at)
        };
        match store::standing(c, &room, &device)? {
            Some(who) => Ok((Auth { room, device, who }, until)),
            None => {
                // A recovery that was just finished replaced the key this token was signed in with. Its device may
                // still ask for the answer of that finish, and for nothing else (`Auth::spent`).
                let finished = c
                    .prepare_cached("SELECT 1 FROM recoveries WHERE room_id = ?1 AND recovery_key = ?2 AND finished_at IS NOT NULL AND expires_at > ?3")?
                    .exists(rusqlite::params![&room[..], &device[..], now as i64])?;
                if finished {
                    return Ok((
                        Auth {
                            room,
                            device,
                            who: Who::Spent,
                        },
                        until,
                    ));
                }
                // the token is of no use any more; it is told why until it runs out
                Err(refuse("not-member", "this device is no longer in the room"))
            }
        }
    }
}
