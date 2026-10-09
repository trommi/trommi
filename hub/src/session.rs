//! Signing in to the hub (spec/v2.md 12.3, D5): a device signs a challenge of the hub with its device key and
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
    ) -> Res<(String, u64, Who)> {
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
        let Some(who) = store::standing(c, room, &parsed.device)? else {
            return Err(refuse("not-member", "this key has no standing in the room"));
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
        let unauthorised = || refuse("unauthorised", "sign in");
        let token = bearer
            .and_then(|h| h.strip_prefix("Bearer "))
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
        let (room, device) = {
            let s = self.lock();
            let t = s
                .tokens
                .get(&key)
                .filter(|t| t.expires_at > now)
                .ok_or_else(unauthorised)?;
            (t.room, t.device)
        };
        match store::standing(c, &room, &device)? {
            Some(who) => Ok(Auth { room, device, who }),
            None => {
                // A recovery that was just finished replaced the key this token was signed in with. Its device may
                // still ask for the answer of that finish, and for nothing else (`Auth::spent`).
                let finished = c
                    .prepare_cached("SELECT 1 FROM recoveries WHERE room_id = ?1 AND recovery_key = ?2 AND finished_at IS NOT NULL AND expires_at > ?3")?
                    .exists(rusqlite::params![&room[..], &device[..], now as i64])?;
                if finished {
                    return Ok(Auth {
                        room,
                        device,
                        who: Who::Spent,
                    });
                }
                // the token is of no use any more; it is told why until it runs out
                Err(refuse("not-member", "this device is no longer in the room"))
            }
        }
    }
}
