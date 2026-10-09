//! The rules for Commits (sections 3.3, 3.4, 4 and 5) on hand-built facts: every refusal with its code.

use trommi_core::ids::{DeviceId, GroupId, Hash32, RoomId, SessionId};
use trommi_core::mls::profile::{CommitNote, Cut, GroupKind, TrommiRoom, TrommiSession};
use trommi_core::mls::rules::*;
use trommi_core::Error;

fn device(byte: u8) -> DeviceId {
    DeviceId::new([byte; 32])
}

const ROOM: RoomId = RoomId::new([0xAA; 32]);
const MAIN: SessionId = SessionId::new([1; 16]);
const HELPER: SessionId = SessionId::new([2; 16]);
const H1: u8 = 0x11;
const H2: u8 = 0x12;
const AGENT: u8 = 0x21;
const OTHER_AGENT: u8 = 0x22;
const SUB: u8 = 0x31;

fn state(epoch: u64, humans: &[u8], agents: &[u8]) -> RoomState {
    RoomState {
        epoch,
        state: Hash32::new([epoch as u8; 32]),
        humans: humans.iter().map(|byte| device(*byte)).collect(),
        room: TrommiRoom {
            recovery_signature_key: [0xE1; 32],
            recovery_hpke_key: [0xE2; 32],
            agents: agents.iter().map(|byte| device(*byte)).collect(),
        },
    }
}

struct Sessions {
    seat: Parent,
    elsewhere: Option<SessionId>,
    helpers: usize,
}

impl SessionFacts for Sessions {
    fn main_session(&self, _: &SessionId, _: u64) -> Parent {
        self.seat
    }
    fn main_session_of(&self, _: &DeviceId) -> Option<SessionId> {
        self.elsewhere
    }
    fn live_helpers(&self, _: &SessionId) -> usize {
        self.helpers
    }
}

const SESSIONS: Sessions = Sessions {
    seat: Parent::Seat(Some(DeviceId::new([AGENT; 32]))),
    elsewhere: None,
    helpers: 0,
};

struct AnyJoin;
impl RecoveryRules for AnyJoin {
    fn verify_join(&self, claim: &JoinClaim<'_>) -> Result<(), Error> {
        if claim.recovery_auth == Some(b"signed") {
            Ok(())
        } else {
            Err(Error::BadSignature)
        }
    }
    fn verify_sealed_key(&self, _: &SealedKeyClaim<'_>, _: &[u8]) -> Result<(), Error> {
        Ok(())
    }
}

fn history() -> RoomHistory {
    let mut history = RoomHistory::new(state(0, &[H1], &[]));
    history.record(state(1, &[H1, H2], &[])).unwrap();
    history
        .record(state(2, &[H1, H2], &[AGENT, OTHER_AGENT]))
        .unwrap();
    history
}

fn facts(group: GroupId, epoch: u64, committer: u8, room_epoch: u64) -> CommitFacts {
    CommitFacts {
        group,
        epoch,
        committer: device(committer),
        external: false,
        adds: vec![],
        removes: vec![],
        context: ContextChange::None,
        has_path: true,
        external_inits: 0,
        forbidden: false,
        note: Some(CommitNote {
            room_epoch,
            room_state: Hash32::new([room_epoch as u8; 32]),
            time: 1,
            cuts: vec![],
            join: false,
        }),
        newer_version: false,
    }
}

fn removing(mut facts: CommitFacts, gone: &[u8]) -> CommitFacts {
    facts.removes = gone.iter().map(|byte| device(*byte)).collect();
    if let Some(note) = facts.note.as_mut() {
        note.cuts = gone.iter().map(|byte| Cut::none(device(*byte))).collect();
    }
    facts
}

fn adding(mut facts: CommitFacts, added: &[u8]) -> CommitFacts {
    facts.adds = added.iter().map(|byte| device(*byte)).collect();
    facts
}

fn room_verdict(history: &RoomHistory, facts: &CommitFacts) -> Result<(), Error> {
    room_verdict_with(history, facts, None)
}

fn room_verdict_with(
    history: &RoomHistory,
    facts: &CommitFacts,
    recovery_auth: Option<&[u8]>,
) -> Result<(), Error> {
    let verifier = Verifier {
        history,
        sessions: &SESSIONS,
        recovery: &AnyJoin,
        max_human_devices: 3,
        posting: true,
    };
    check_room_commit(
        &verifier,
        &Judged {
            facts,
            commit: b"commit",
            recovery_auth,
        },
    )
}

fn session(parent: SessionId, id: SessionId) -> TrommiSession {
    TrommiSession {
        room_id: ROOM,
        session_id: id,
        parent,
    }
}

fn session_verdict(
    history: &RoomHistory,
    sessions: &Sessions,
    before: &SessionBefore,
    facts: &CommitFacts,
) -> Result<(), Error> {
    let verifier = Verifier {
        history,
        sessions,
        recovery: &AnyJoin,
        max_human_devices: 32,
        posting: true,
    };
    check_session_commit(
        &verifier,
        before,
        &Judged {
            facts,
            commit: b"commit",
            recovery_auth: None,
        },
    )
}

fn before(session: TrommiSession, leaves: &[u8], previous_room_epoch: u64) -> SessionBefore {
    SessionBefore {
        session,
        leaves: leaves.iter().map(|byte| device(*byte)).collect(),
        previous_room_epoch,
    }
}

#[test]
fn history_records_revocations_per_epoch() {
    let mut history = history();
    history.record(state(3, &[H1], &[AGENT])).unwrap();
    assert!(!history.is_revoked(&device(H2), 2));
    assert!(history.is_revoked(&device(H2), 3));
    assert!(history.is_revoked(&device(OTHER_AGENT), 3));
    assert!(!history.is_revoked(&device(AGENT), 3));
    assert_eq!(history.newest().epoch, 3);
    assert!(history.at(4).is_none());
    assert_eq!(
        history.record(state(5, &[H1], &[])),
        Err(Error::Internal("room history out of order"))
    );
    assert!(history.held_recovery_key(&[0xE1; 32]));
}

#[test]
fn room_commits_follow_5_1() {
    let history = history();
    let group = GroupId::room(ROOM);
    let own_update = facts(group, 2, H1, 2);
    assert_eq!(room_verdict(&history, &own_update), Ok(()));
    assert_eq!(
        room_verdict(&history, &adding(own_update.clone(), &[0x13])),
        Ok(())
    );
    assert_eq!(
        room_verdict(&history, &removing(own_update.clone(), &[H2])),
        Ok(())
    );

    // An agent device commits nothing in the room group; neither does a stranger.
    let by_agent = facts(group, 2, AGENT, 2);
    assert_eq!(room_verdict(&history, &by_agent), Err(Error::BadCommit));
    // Two Adds; an Add of an enrolled agent; an Add above the limit of human devices.
    let two = adding(own_update.clone(), &[0x13, 0x14]);
    assert_eq!(room_verdict(&history, &two), Err(Error::BadCommit));
    let agent_as_human = adding(own_update.clone(), &[AGENT]);
    assert_eq!(
        room_verdict(&history, &agent_as_human),
        Err(Error::BadCommit)
    );
    let mut full = RoomHistory::new(state(0, &[H1, H2, 0x13], &[]));
    full.record(state(1, &[H1, H2, 0x13], &[])).unwrap();
    full.record(state(2, &[H1, H2, 0x13], &[])).unwrap();
    assert_eq!(
        room_verdict(&full, &adding(own_update.clone(), &[0x14])),
        Err(Error::TooMany)
    );
    // A Remove without its Cut; a note naming another epoch or state; no note; a forbidden proposal.
    let mut no_cut = removing(own_update.clone(), &[H2]);
    no_cut.note.as_mut().unwrap().cuts.clear();
    assert_eq!(room_verdict(&history, &no_cut), Err(Error::BadCommit));
    let mut other_state = own_update.clone();
    other_state.note.as_mut().unwrap().room_state = Hash32::ZERO;
    assert_eq!(room_verdict(&history, &other_state), Err(Error::BadCommit));
    let mut no_note = own_update.clone();
    no_note.note = None;
    assert_eq!(room_verdict(&history, &no_note), Err(Error::BadCommit));
    let mut forbidden = own_update.clone();
    forbidden.forbidden = true;
    assert_eq!(room_verdict(&history, &forbidden), Err(Error::BadCommit));
    // A Commit without a path that is not only Adds.
    let mut pathless = own_update.clone();
    pathless.has_path = false;
    assert_eq!(room_verdict(&history, &pathless), Err(Error::BadCommit));
}

#[test]
fn room_context_changes_follow_5_1_2_and_8() {
    let mut history = history();
    history.record(state(3, &[H1], &[AGENT])).unwrap();
    let group = GroupId::room(ROOM);
    let change = |room: TrommiRoom| {
        let mut facts = facts(group, 3, H1, 3);
        facts.context = ContextChange::To(GroupKind::Room(room));
        facts
    };
    let current = history.newest().room.clone();
    let mut enrolled = current.clone();
    enrolled.agents = vec![device(AGENT), device(0x23)];
    assert_eq!(room_verdict(&history, &change(enrolled)), Ok(()));

    // A revoked agent returns; a revoked human is enrolled; a human device is enrolled.
    for returning in [OTHER_AGENT, H2, H1] {
        let mut room = current.clone();
        room.agents = vec![device(returning), device(AGENT)];
        room.agents.sort_unstable();
        assert_eq!(
            room_verdict(&history, &change(room)),
            Err(Error::BadCommit),
            "{returning:#x}"
        );
    }
    // One recovery key alone; a key the room held before; a device's key; a session extension.
    let mut one = current.clone();
    one.recovery_hpke_key = [0xF2; 32];
    assert_eq!(room_verdict(&history, &change(one)), Err(Error::BadCommit));
    let mut swapped = current.clone();
    swapped.recovery_signature_key = [0xE2; 32];
    swapped.recovery_hpke_key = [0xE1; 32];
    assert_eq!(
        room_verdict(&history, &change(swapped)),
        Err(Error::BadCommit)
    );
    let mut device_key = current.clone();
    device_key.recovery_signature_key = [H1; 32];
    device_key.recovery_hpke_key = [0xF2; 32];
    assert_eq!(
        room_verdict(&history, &change(device_key)),
        Err(Error::BadCommit)
    );
    let mut replaced = current.clone();
    replaced.recovery_signature_key = [0xF1; 32];
    replaced.recovery_hpke_key = [0xF2; 32];
    assert_eq!(room_verdict(&history, &change(replaced)), Ok(()));
    let mut to_session = facts(group, 3, H1, 3);
    to_session.context = ContextChange::To(GroupKind::Session(session(SessionId::ZERO, MAIN)));
    assert_eq!(room_verdict(&history, &to_session), Err(Error::BadCommit));
    let mut malformed = facts(group, 3, H1, 3);
    malformed.context = ContextChange::Malformed;
    assert_eq!(room_verdict(&history, &malformed), Err(Error::BadCommit));
    // A revoked human device is added again.
    assert_eq!(
        room_verdict(&history, &adding(facts(group, 3, H1, 3), &[H2])),
        Err(Error::BadCommit)
    );
}

#[test]
fn a_join_from_outside_needs_the_recovery_signature() {
    let history = history();
    let group = GroupId::room(ROOM);
    let mut join = facts(group, 2, 0x13, 2);
    join.external = true;
    join.external_inits = 1;
    join.note.as_mut().unwrap().join = true;
    assert_eq!(room_verdict(&history, &join), Err(Error::BadSignature));
    assert_eq!(room_verdict_with(&history, &join, Some(b"signed")), Ok(()));
    // The flag must say what the Commit is; an external commit brings nobody else.
    let mut unflagged = join.clone();
    unflagged.note.as_mut().unwrap().join = false;
    assert_eq!(
        room_verdict_with(&history, &unflagged, Some(b"signed")),
        Err(Error::BadCommit)
    );
    let mut flagged = facts(group, 2, H1, 2);
    flagged.note.as_mut().unwrap().join = true;
    assert_eq!(room_verdict(&history, &flagged), Err(Error::BadCommit));
    let bringing = adding(join.clone(), &[0x14]);
    assert_eq!(
        room_verdict_with(&history, &bringing, Some(b"signed")),
        Err(Error::BadCommit)
    );
    let removing_another = removing(join.clone(), &[H2]);
    assert_eq!(
        room_verdict_with(&history, &removing_another, Some(b"signed")),
        Err(Error::BadCommit)
    );
    // An enrolled agent does not become a human device this way; nor does NoRecovery let anyone in.
    let mut agent = join.clone();
    agent.committer = device(AGENT);
    assert_eq!(
        room_verdict_with(&history, &agent, Some(b"signed")),
        Err(Error::BadCommit)
    );
    assert_eq!(
        NoRecovery.verify_join(&JoinClaim {
            group: &group,
            epoch: 2,
            joiner: &device(0x13),
            note: join.note.as_ref().unwrap(),
            commit: b"",
            recovery_signature_key: &[0; 32],
            recovery_auth: Some(b"signed"),
        }),
        Err(Error::BadCommit)
    );
    // Nor does it take a `SealedKey`, whatever its bytes: it cannot check one.
    for sealed_key in [&b""[..], &[1], b"test sealed key"] {
        assert_eq!(
            NoRecovery.verify_sealed_key(
                &SealedKeyClaim {
                    group: &group,
                    epoch: 3,
                    group_info: b"group info",
                    room_epoch: 2,
                    recovery_hpke_key: &[0xE2; 32],
                    writer: &device(H1),
                    writer_is_human: true,
                },
                sealed_key
            ),
            Err(Error::Incomplete)
        );
    }
}

#[test]
fn the_thirty_third_human_device_comes_by_a_join_from_outside_only() {
    let group = GroupId::room(ROOM);
    let verdict = |history: &RoomHistory, facts: &CommitFacts, most: usize| {
        let verifier = Verifier {
            history,
            sessions: &SESSIONS,
            recovery: &AnyJoin,
            max_human_devices: most,
            posting: false,
        };
        check_room_commit(
            &verifier,
            &Judged {
                facts,
                commit: b"commit",
                recovery_auth: facts.external.then_some(&b"signed"[..]),
            },
        )
    };
    let humans: Vec<u8> = (1..=33).collect();
    let full = RoomHistory::new(state(0, &humans[..32], &[]));
    let mut join = facts(group, 0, 33, 0);
    join.external = true;
    join.external_inits = 1;
    join.note.as_mut().unwrap().join = true;

    // A room of 32: a device that cannot know whether a recovery runs allows 33, and still takes no Add of
    // a 33rd, only a join from outside. A hub outside a recovery allows 32 and takes neither.
    let add = adding(facts(group, 0, 1, 0), &[33]);
    assert_eq!(verdict(&full, &add, 33), Err(Error::TooMany));
    assert_eq!(verdict(&full, &add, 32), Err(Error::TooMany));
    assert_eq!(verdict(&full, &join, 33), Ok(()));
    assert_eq!(verdict(&full, &join, 32), Err(Error::TooMany));

    // A room of 33, as a recovery leaves it for a moment: a Commit that adds nobody passes, so that the
    // other devices are removed and the room can go on; nobody is added, and nobody else joins.
    let over = RoomHistory::new(state(0, &humans, &[]));
    assert_eq!(verdict(&over, &facts(group, 0, 33, 0), 33), Ok(()));
    let removal = removing(facts(group, 0, 33, 0), &humans[..32]);
    assert_eq!(verdict(&over, &removal, 33), Ok(()));
    assert_eq!(verdict(&over, &removal, 32), Ok(()));
    let swap = adding(removing(facts(group, 0, 33, 0), &[1]), &[34]);
    assert_eq!(verdict(&over, &swap, 33), Err(Error::TooMany));
    join.committer = device(34);
    assert_eq!(verdict(&over, &join, 33), Err(Error::TooMany));
}

#[test]
fn a_note_of_a_newer_version_is_named_as_such() {
    let history = history();
    let sessions = SESSIONS;
    let main = session(SessionId::ZERO, MAIN);
    // The note of a newer version does not decode: the Commit is `newer-version`, in the room group and in a
    // session group, also when it holds what this build takes for forbidden.
    for forbidden in [false, true] {
        let mut newer = facts(GroupId::room(ROOM), 2, H1, 2);
        newer.note = None;
        newer.newer_version = true;
        newer.forbidden = forbidden;
        assert_eq!(room_verdict(&history, &newer), Err(Error::NewerVersion));
        newer.group = main.group_id();
        newer.epoch = 1;
        assert_eq!(
            session_verdict(
                &history,
                &sessions,
                &before(main, &[H1, H2, AGENT], 2),
                &newer
            ),
            Err(Error::NewerVersion)
        );
    }
    // A note that does not decode for another reason stays `bad-commit`.
    let mut broken = facts(GroupId::room(ROOM), 2, H1, 2);
    broken.note = None;
    assert_eq!(room_verdict(&history, &broken), Err(Error::BadCommit));
}

#[test]
fn main_session_commits_follow_5_2() {
    let history = history();
    let main = session(SessionId::ZERO, MAIN);
    let group = main.group_id();
    let founder = before(main, &[H1], 0);
    let founding = adding(facts(group, 0, H1, 2), &[H2, AGENT]);
    assert_eq!(
        session_verdict(&history, &SESSIONS, &founder, &founding),
        Ok(())
    );
    // A founding that leaves a human device out, has no agent device, or two.
    for adds in [&[AGENT][..], &[H2], &[H2, AGENT, OTHER_AGENT]] {
        assert_eq!(
            session_verdict(
                &history,
                &SESSIONS,
                &founder,
                &adding(facts(group, 0, H1, 2), adds)
            ),
            Err(Error::BadCommit),
            "{adds:x?}"
        );
    }
    // An agent whose seat is in another live main session.
    let taken = Sessions {
        elsewhere: Some(HELPER),
        ..SESSIONS
    };
    assert_eq!(
        session_verdict(&history, &taken, &founder, &founding),
        Err(Error::BadCommit)
    );

    let live = before(main, &[H1, H2, AGENT], 2);
    let update = facts(group, 3, H1, 2);
    assert_eq!(session_verdict(&history, &SESSIONS, &live, &update), Ok(()));
    // The agent commits nothing here; a stranger is not added; a second agent neither.
    assert_eq!(
        session_verdict(&history, &SESSIONS, &live, &facts(group, 3, AGENT, 2)),
        Err(Error::BadCommit)
    );
    for added in [SUB, OTHER_AGENT] {
        assert_eq!(
            session_verdict(
                &history,
                &SESSIONS,
                &live,
                &adding(update.clone(), &[added])
            ),
            Err(Error::BadCommit)
        );
    }
    // A takeover is Remove and Add in one Commit, and comes after the old agent device left `agents`
    // (5.3.1): while the room holds it, another device does not take its seat.
    let takeover = adding(removing(update.clone(), &[AGENT]), &[OTHER_AGENT]);
    assert_eq!(
        session_verdict(&history, &SESSIONS, &live, &takeover),
        Err(Error::BadCommit)
    );
    let mut after_removal = history.clone();
    after_removal
        .record(state(3, &[H1, H2], &[OTHER_AGENT]))
        .unwrap();
    let takeover = adding(removing(facts(group, 3, H1, 3), &[AGENT]), &[OTHER_AGENT]);
    assert_eq!(
        session_verdict(&after_removal, &SESSIONS, &live, &takeover),
        Ok(())
    );
    // Nor does its leaf go alone while the room holds the device (5.2.8): a Remove now and an Add later
    // would be the same takeover in two Commits. Once it left `agents`, the Remove alone leaves the seat
    // empty (5.2.2), and a later Commit seats another device.
    assert_eq!(
        session_verdict(
            &history,
            &SESSIONS,
            &live,
            &removing(update.clone(), &[AGENT])
        ),
        Err(Error::BadCommit)
    );
    assert_eq!(
        session_verdict(
            &after_removal,
            &SESSIONS,
            &live,
            &removing(facts(group, 3, H1, 3), &[AGENT])
        ),
        Ok(())
    );
    let empty = before(main, &[H1, H2], 3);
    assert_eq!(
        session_verdict(
            &after_removal,
            &SESSIONS,
            &empty,
            &adding(facts(group, 4, H1, 3), &[OTHER_AGENT])
        ),
        Ok(())
    );
    // A room epoch the verifier does not know, one below the previous Commit's, one that is not the
    // newest while posting; a state that is not that epoch's; a changed extension.
    assert_eq!(
        session_verdict(&history, &SESSIONS, &live, &facts(group, 3, H1, 3)),
        Err(Error::RoomBehind)
    );
    assert_eq!(
        session_verdict(&history, &SESSIONS, &live, &facts(group, 3, H1, 1)),
        Err(Error::RoomBehind)
    );
    let mut other_state = update.clone();
    other_state.note.as_mut().unwrap().room_state = Hash32::ZERO;
    assert_eq!(
        session_verdict(&history, &SESSIONS, &live, &other_state),
        Err(Error::BadCommit)
    );
    let mut changed = update.clone();
    changed.context = ContextChange::To(GroupKind::Session(session(HELPER, MAIN)));
    assert_eq!(
        session_verdict(&history, &SESSIONS, &live, &changed),
        Err(Error::BadCommit)
    );
}

#[test]
fn a_stale_session_takes_only_its_cleaning() {
    let mut history = history();
    history.record(state(3, &[H1], &[OTHER_AGENT])).unwrap();
    let main = session(SessionId::ZERO, MAIN);
    let group = main.group_id();
    let stale = before(main, &[H1, H2, AGENT], 2);
    assert_eq!(
        disallowed_leaves(
            &history,
            history.newest(),
            &main,
            Parent::NotAMainSession,
            &stale.leaves
        ),
        vec![device(H2), device(AGENT)]
    );
    let update = facts(group, 5, H1, 3);
    assert_eq!(
        session_verdict(&history, &SESSIONS, &stale, &update),
        Err(Error::StaleSession)
    );
    let half = removing(update.clone(), &[H2]);
    assert_eq!(
        session_verdict(&history, &SESSIONS, &stale, &half),
        Err(Error::StaleSession)
    );
    let cleaning = removing(update.clone(), &[H2, AGENT]);
    assert_eq!(
        session_verdict(&history, &SESSIONS, &stale, &cleaning),
        Ok(())
    );
    let with_takeover = adding(cleaning, &[OTHER_AGENT]);
    assert_eq!(
        session_verdict(&history, &SESSIONS, &stale, &with_takeover),
        Ok(())
    );
    // The removed human device commits nothing more, and a returning key is refused.
    assert_eq!(
        session_verdict(&history, &SESSIONS, &stale, &facts(group, 5, H2, 3)),
        Err(Error::BadCommit)
    );
    let clean = before(main, &[H1], 3);
    assert_eq!(
        session_verdict(&history, &SESSIONS, &clean, &adding(update, &[H2])),
        Err(Error::BadCommit)
    );
}

#[test]
fn helper_session_commits_follow_5_2_3_to_5_2_5() {
    let history = history();
    let helper = session(MAIN, HELPER);
    let group = helper.group_id();
    let founder = before(helper, &[AGENT], 0);
    let founding = adding(facts(group, 0, AGENT, 2), &[H1, H2, SUB]);
    assert_eq!(
        session_verdict(&history, &SESSIONS, &founder, &founding),
        Ok(())
    );
    // Not the opener; a human device left out; too many helper sessions; no such main session.
    let empty_seat = Sessions {
        seat: Parent::Seat(None),
        ..SESSIONS
    };
    assert_eq!(
        session_verdict(&history, &empty_seat, &founder, &founding),
        Err(Error::BadCommit)
    );
    let partial = adding(facts(group, 0, AGENT, 2), &[H1]);
    assert_eq!(
        session_verdict(&history, &SESSIONS, &founder, &partial),
        Err(Error::BadCommit)
    );
    let crowded = Sessions {
        helpers: 32,
        ..SESSIONS
    };
    assert_eq!(
        session_verdict(&history, &crowded, &founder, &founding),
        Err(Error::TooMany)
    );
    let orphan = Sessions {
        seat: Parent::NotAMainSession,
        ..SESSIONS
    };
    assert_eq!(
        session_verdict(&history, &orphan, &founder, &founding),
        Err(Error::BadCommit)
    );
    // A human device does not found a helper session.
    let by_human = adding(facts(group, 0, H1, 2), &[H2, AGENT]);
    assert_eq!(
        session_verdict(&history, &SESSIONS, &before(helper, &[H1], 0), &by_human),
        Err(Error::BadCommit)
    );

    let live = before(helper, &[H1, H2, AGENT, SUB], 2);
    let by_opener = facts(group, 1, AGENT, 2);
    assert_eq!(
        session_verdict(&history, &SESSIONS, &live, &by_opener),
        Ok(())
    );
    assert_eq!(
        session_verdict(
            &history,
            &SESSIONS,
            &live,
            &adding(removing(by_opener.clone(), &[SUB]), &[0x32])
        ),
        Ok(())
    );
    // The opener removes no human leaf, adds no agent device, and no eighth helper device.
    assert_eq!(
        session_verdict(
            &history,
            &SESSIONS,
            &live,
            &removing(by_opener.clone(), &[H2])
        ),
        Err(Error::BadCommit)
    );
    assert_eq!(
        session_verdict(
            &history,
            &SESSIONS,
            &live,
            &adding(by_opener.clone(), &[OTHER_AGENT])
        ),
        Err(Error::BadCommit)
    );
    let many = adding(
        by_opener.clone(),
        &[0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38],
    );
    assert_eq!(
        session_verdict(&history, &SESSIONS, &live, &many),
        Err(Error::TooMany)
    );
    // A helper device commits nothing; nor does another enrolled agent.
    for committer in [SUB, OTHER_AGENT] {
        assert_eq!(
            session_verdict(&history, &SESSIONS, &live, &facts(group, 1, committer, 2)),
            Err(Error::BadCommit)
        );
    }
    // A human device does not remove the opener while it is the main session's agent leaf (5.2.3); a
    // verifier that does not follow the main session does not judge this.
    let unseat = removing(facts(group, 1, H1, 2), &[AGENT]);
    assert_eq!(
        session_verdict(&history, &SESSIONS, &live, &unseat),
        Err(Error::BadCommit)
    );
    let unknown = Sessions {
        seat: Parent::Unknown,
        ..SESSIONS
    };
    assert_eq!(session_verdict(&history, &unknown, &live, &unseat), Ok(()));
    // After a takeover of the main session the old opener's leaf makes the group stale; a human device
    // replaces it with the new one. While the seat is empty the helper devices stay.
    let taken_over = Sessions {
        seat: Parent::Seat(Some(device(OTHER_AGENT))),
        ..SESSIONS
    };
    assert_eq!(
        session_verdict(&history, &taken_over, &live, &facts(group, 1, H1, 2)),
        Err(Error::StaleSession)
    );
    let replace = adding(removing(facts(group, 1, H1, 2), &[AGENT]), &[OTHER_AGENT]);
    assert_eq!(
        session_verdict(&history, &taken_over, &live, &replace),
        Ok(())
    );
    assert_eq!(
        session_verdict(
            &history,
            &empty_seat,
            &live,
            &removing(facts(group, 1, H1, 2), &[AGENT, SUB])
        ),
        Err(Error::BadCommit)
    );
    assert_eq!(
        session_verdict(
            &history,
            &empty_seat,
            &live,
            &removing(facts(group, 1, H1, 2), &[AGENT])
        ),
        Ok(())
    );
}

#[test]
fn room_founding_is_checked() {
    assert_eq!(check_room_founding(&state(0, &[H1], &[])), Ok(()));
    assert_eq!(
        check_room_founding(&state(0, &[H1, H2], &[])),
        Err(Error::BadCommit)
    );
    assert_eq!(
        check_room_founding(&state(1, &[H1], &[])),
        Err(Error::BadCommit)
    );
    assert_eq!(
        check_room_founding(&state(0, &[H1], &[H1])),
        Err(Error::BadCommit)
    );
    assert_eq!(
        check_room_founding(&state(0, &[0xE1], &[])),
        Err(Error::BadCommit)
    );
}

#[test]
fn a_removed_human_device_does_not_make_the_agent_leaf_unfit() {
    let mut history = history();
    history
        .record(state(3, &[H1], &[AGENT, OTHER_AGENT]))
        .unwrap();
    let main = session(SessionId::ZERO, MAIN);
    let stale = before(main, &[H1, H2, AGENT], 2);
    // Only the removed human device goes; the session's agent device stays its agent leaf.
    assert_eq!(
        disallowed_leaves(
            &history,
            history.newest(),
            &main,
            Parent::NotAMainSession,
            &stale.leaves
        ),
        vec![device(H2)]
    );
    let cleaning = removing(facts(main.group_id(), 5, H1, 3), &[H2]);
    assert_eq!(
        session_verdict(&history, &SESSIONS, &stale, &cleaning),
        Ok(())
    );
    // Two agent devices in one main session: neither is allowed until one is left.
    let doubled = before(main, &[H1, AGENT, OTHER_AGENT], 3);
    assert_eq!(
        disallowed_leaves(
            &history,
            history.newest(),
            &main,
            Parent::NotAMainSession,
            &doubled.leaves
        ),
        vec![device(AGENT), device(OTHER_AGENT)]
    );
}

#[test]
fn a_human_device_gives_a_helper_session_its_new_opener() {
    let history = history();
    let helper = session(MAIN, HELPER);
    let waiting = before(helper, &[H1, H2, SUB], 2);
    let takeover = adding(facts(helper.group_id(), 4, H1, 2), &[OTHER_AGENT]);
    let verdict = |seat: Parent| {
        let sessions = Sessions {
            seat,
            elsewhere: None,
            helpers: 1,
        };
        session_verdict(&history, &sessions, &waiting, &takeover)
    };
    // The device added is the main session's agent leaf.
    assert_eq!(verdict(Parent::Seat(Some(device(OTHER_AGENT)))), Ok(()));
    assert_eq!(
        verdict(Parent::Seat(Some(device(AGENT)))),
        Err(Error::BadCommit)
    );
    assert_eq!(verdict(Parent::Seat(None)), Err(Error::BadCommit));
    // A helper device that does not follow the main session cannot tell which agent device that is, and
    // takes an enrolled one.
    assert_eq!(verdict(Parent::Unknown), Ok(()));
}
