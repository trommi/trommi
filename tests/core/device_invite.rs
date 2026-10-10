//! Joining by link through the device (12.1), both sides, and signing in to the hub (12.3).

use trommi_core::crypto::SystemEntropy;
use trommi_core::device::{
    Draft, EnvelopeOutcome, InviteAccepted, InviteOpened, InviteStep, JoinRequest, MAX_OPEN_INVITES,
};
use trommi_core::envelope::Urgency;
use trommi_core::hub_auth::{self, HubAddress, IssuedChallenge};
use trommi_core::ids::{GroupId, InviteId};
use trommi_core::invite::{
    CheckCode, InviteLink, Request, Role, CHECK_EMOJI, CONFIRM_MS, INVITE_LIFE_MS,
};
use trommi_core::Error;
use trommi_tests::hub::Hub;
use trommi_tests::{
    enrol, found_main, found_room, json, new_device, now, post_ok, publish_some, sync_all, write,
    TestDevice,
};

const APP: &str = "https://app.example";

fn hub_address() -> HubAddress {
    HubAddress::parse("https://hub.example").unwrap()
}

fn link_text(opened: &InviteOpened) -> String {
    String::from_utf8(opened.link.expose().to_vec()).unwrap()
}

/// The three messages of an invite, passed by hand: the Offer, the Request, the Reveal.
fn exchange(
    inviter: &mut TestDevice,
    joiner: &mut TestDevice,
    role: Role,
    session: Option<&trommi_core::ids::SessionId>,
) -> (InviteOpened, JoinRequest, InviteAccepted) {
    let opened = inviter
        .invite_open(role, session, APP, &hub_address(), now())
        .unwrap();
    let request = joiner
        .join_request(&link_text(&opened), &opened.signed_offer, now())
        .unwrap();
    assert_eq!((request.role, request.inviter), (role, inviter.id()));
    let accepted = inviter
        .invite_accept(&opened.invite_id, &request.signed_request, now())
        .unwrap();
    assert_eq!(accepted.new_device, joiner.id());
    (opened, request, accepted)
}

/// A room with a founder, an agent in its main session, and a card in it.
fn room() -> (Hub, GroupId, GroupId, TestDevice, TestDevice) {
    room_of(new_device())
}

/// The same room, founded by `a`.
fn room_of(mut a: TestDevice) -> (Hub, GroupId, GroupId, TestDevice, TestDevice) {
    let mut agent = new_device();
    let (mut hub, room) = found_room(&mut a);
    publish_some(&mut hub, &mut a, 4);
    publish_some(&mut hub, &mut agent, 4);
    enrol(&mut hub, &mut a, &mut agent);
    let main = found_main(&mut hub, &mut a, &agent.id());
    sync_all(&hub, &mut a);
    sync_all(&hub, &mut agent);
    (hub, room, main, a, agent)
}

fn card(session: &GroupId) -> Draft {
    Draft::CardFirst {
        session: session.session_id().unwrap(),
        urgency: Urgency::Normal,
        push: false,
        payload: json(
            r#"{"card_type":"info","title":"t","previous_version_hash":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}"#,
        ),
    }
}

#[test]
fn a_human_device_joins_by_link_and_is_taken_into_every_live_session() {
    let (mut hub, room, main, mut a, mut agent) = room();
    let old_card = write(&mut hub, &mut agent, &card(&main));
    sync_all(&hub, &mut a);
    let mut b = new_device();

    let (opened, _, accepted) = exchange(&mut a, &mut b, Role::Human, None);
    // Both sides compute the same six emoji, and the person compares them.
    let code = b.join_reveal(&accepted.signed_reveal).unwrap();
    assert_eq!(code, accepted.code);
    assert_eq!(code.emoji().len(), 6);
    assert_eq!(CHECK_EMOJI.len(), 64);
    // Nothing commits the device before the confirmation.
    assert!(a.invite_steps().unwrap().is_empty());
    assert!(a.outbox().is_empty());
    let confirmed = a
        .invite_confirm(
            &opened.invite_id,
            &code,
            &accepted.request_hash,
            true,
            now(),
        )
        .unwrap()
        .unwrap();
    assert_eq!(
        (confirmed.new_device, confirmed.role),
        (b.id(), Role::Human)
    );
    assert_eq!(a.outbox()[0].id, confirmed.outbox_id);
    // A confirmation is acted on once.
    assert_eq!(
        a.invite_confirm(
            &opened.invite_id,
            &code,
            &accepted.request_hash,
            true,
            now()
        ),
        Err(Error::InviteUsed)
    );
    // The Commit is lost (refused for good, or dropped for another one that took its epoch): the same
    // confirmation builds it again.
    let lost = a.outbox().remove(0);
    a.outbox_refused(lost.id, &Error::BadCommit).unwrap();
    assert_eq!(
        a.invite_steps().unwrap(),
        vec![(opened.invite_id, InviteStep::Commit)]
    );
    let again = a
        .invite_confirm(
            &opened.invite_id,
            &code,
            &accepted.request_hash,
            true,
            now(),
        )
        .unwrap()
        .unwrap();
    assert_eq!(again.new_device, b.id());
    post_ok(&mut hub, &mut a);

    // The new device takes the Welcome as the invite said, and with it the recovery_mac the inviter owed.
    let welcome = hub.welcomes.last().unwrap().clone();
    let joined = b.join_invited(&welcome.bytes, now()).unwrap();
    assert_eq!((joined.group, joined.added_by), (room, a.id()));
    assert!(b.is_human());
    for item in hub.log_after(welcome.change) {
        trommi_tests::process(&mut b, &item).unwrap();
    }
    assert!(b.holds_recovery_mac());
    publish_some(&mut hub, &mut b, 4);

    // The inviter hands the history over, then adds the device to every live session.
    sync_all(&hub, &mut a);
    let add = InviteStep::AddToSession {
        group: main,
        device: b.id(),
    };
    assert_eq!(
        a.invite_steps().unwrap(),
        vec![
            (
                opened.invite_id,
                InviteStep::Handover {
                    group: room,
                    device: b.id()
                }
            ),
            (opened.invite_id, add.clone())
        ]
    );
    a.invite_handover(&opened.invite_id).unwrap();
    post_ok(&mut hub, &mut a);
    let steps = a.invite_steps().unwrap();
    assert_eq!(
        steps,
        vec![(
            opened.invite_id,
            InviteStep::AddToSession {
                group: main,
                device: b.id()
            }
        )]
    );
    let package = hub.claim(&[b.id()]).unwrap().remove(0);
    a.add_to_session(&main, &b.id(), &package, now()).unwrap();
    assert_eq!(
        a.invite_steps().unwrap(),
        vec![(opened.invite_id, InviteStep::Wait)]
    );
    post_ok(&mut hub, &mut a);
    sync_all(&hub, &mut a);
    assert!(a.invite_steps().unwrap().is_empty());

    // The new device reads on from here: it holds the keys of the epochs before it, and writes.
    sync_all(&hub, &mut b);
    assert!(b.group(&main).is_ok());
    assert_eq!(
        b.content_key(&main, 1).unwrap(),
        a.content_key(&main, 1).unwrap()
    );
    let _ = old_card;
    let said = write(
        &mut hub,
        &mut b,
        &Draft::SessionChat {
            session: main.session_id().unwrap(),
            payload: json(r#"{"text":"hello from the new device"}"#),
        },
    );
    let at_agent = sync_all(&hub, &mut agent);
    let got = at_agent
        .iter()
        .find(|got| got.envelope_hash == said.envelope_hash)
        .unwrap();
    assert_eq!(got.outcome, EnvelopeOutcome::Applied);
    assert!(got.command);
    // And it can commit: it holds the recovery_mac.
    b.update(&room, true, now()).unwrap().unwrap();
    post_ok(&mut hub, &mut b);
}

#[test]
fn an_agent_device_joins_by_link_into_a_new_main_session() {
    let (mut hub, room, _, mut a, _) = room();
    let mut agent = new_device();
    publish_some(&mut hub, &mut agent, 2);
    let (opened, _, accepted) = exchange(&mut a, &mut agent, Role::Agent, None);
    let code = agent.join_reveal(&accepted.signed_reveal).unwrap();
    let confirmed = a
        .invite_confirm(
            &opened.invite_id,
            &code,
            &accepted.request_hash,
            true,
            now(),
        )
        .unwrap()
        .unwrap();
    assert_eq!(confirmed.role, Role::Agent);
    assert_eq!(confirmed.session_id, None);
    // The new device follows the room group from the state the Offer named.
    let offered = hub.group_info(&room).unwrap().clone();
    post_ok(&mut hub, &mut a);
    assert_eq!(
        agent.join_observe(hub.group_info(&room).unwrap()),
        Err(Error::BadFormat),
        "another state than the Offer's"
    );
    agent.join_observe(&offered).unwrap();
    sync_all(&hub, &mut agent);
    assert!(agent.room_history().unwrap().newest().is_agent(&agent.id()));

    // Its main session is founded with the KeyPackage of its Request.
    sync_all(&hub, &mut a);
    let steps = a.invite_steps().unwrap();
    let (
        _,
        InviteStep::FoundSession {
            agent: named,
            key_package,
        },
    ) = &steps[0]
    else {
        panic!("the session is to be founded: {steps:?}");
    };
    assert_eq!(*named, agent.id());
    let session = a
        .found_session(named, std::slice::from_ref(key_package), now())
        .unwrap();
    assert_eq!(
        a.invite_steps().unwrap(),
        vec![(opened.invite_id, InviteStep::Wait)]
    );
    post_ok(&mut hub, &mut a);
    sync_all(&hub, &mut a);
    assert!(a.invite_steps().unwrap().is_empty());
    sync_all(&hub, &mut agent);
    let group = GroupId::session(room.room_id(), session);
    let made = write(&mut hub, &mut agent, &card(&group));
    let at_human = sync_all(&hub, &mut a);
    assert_eq!(at_human.last().unwrap().envelope_hash, made.envelope_hash);
    assert_eq!(at_human.last().unwrap().outcome, EnvelopeOutcome::Applied);
}

#[test]
fn an_agent_device_joins_by_link_and_takes_a_session_over() {
    let (mut hub, room, main, mut a, mut old) = room();
    let made = write(&mut hub, &mut old, &card(&main));
    let card_id = made.object_id.unwrap();
    sync_all(&hub, &mut a);
    assert_eq!(a.object_owner(&main, &card_id).unwrap(), Some(old.id()));

    let mut new = new_device();
    let session = main.session_id().unwrap();
    let (opened, _, accepted) = exchange(&mut a, &mut new, Role::Agent, Some(&session));
    let code = new.join_reveal(&accepted.signed_reveal).unwrap();
    let offered = hub.group_info(&room).unwrap().clone();
    let confirmed = a
        .invite_confirm(
            &opened.invite_id,
            &code,
            &accepted.request_hash,
            true,
            now(),
        )
        .unwrap()
        .unwrap();
    assert_eq!(confirmed.session_id, Some(session));
    post_ok(&mut hub, &mut a);
    sync_all(&hub, &mut a);
    // One room Commit enrolled the new device and took the old one out: its session is stale.
    let roles = a.room_history().unwrap().newest().clone();
    assert!(roles.is_agent(&new.id()) && !roles.is_agent(&old.id()));
    assert_eq!(a.group(&main).unwrap().disallowed, vec![old.id()]);
    let steps = a.invite_steps().unwrap();
    let (
        _,
        InviteStep::TakeOver {
            group,
            cuts,
            agent,
            key_package,
        },
    ) = &steps[0]
    else {
        panic!("the session is to be taken over: {steps:?}");
    };
    assert_eq!((*group, *agent), (main, new.id()));
    // The Cut is the old device's last envelope the inviter accepted: its card.
    assert_eq!(
        (cuts[0].device, cuts[0].seq, cuts[0].hash),
        (old.id(), 1, made.envelope_hash)
    );
    a.clean_session(
        group,
        cuts,
        Some((agent, key_package.as_ref().unwrap())),
        now(),
    )
    .unwrap();
    post_ok(&mut hub, &mut a);
    sync_all(&hub, &mut a);
    // With history: the handover in the session group.
    assert_eq!(
        a.invite_steps().unwrap(),
        vec![(
            opened.invite_id,
            InviteStep::Handover {
                group: main,
                device: new.id()
            }
        )]
    );
    a.invite_handover(&opened.invite_id).unwrap();
    post_ok(&mut hub, &mut a);
    // The hub lists no helper session under it: the takeover is complete.
    assert_eq!(
        a.invite_steps().unwrap(),
        vec![(opened.invite_id, InviteStep::CheckHelpers { session })]
    );
    a.invite_checked(&opened.invite_id, &[]).unwrap();
    assert!(a.invite_steps().unwrap().is_empty());

    new.join_observe(&offered).unwrap();
    sync_all(&hub, &mut new);
    assert!(new.group(&main).is_ok());
    assert_eq!(
        new.content_key(&main, 1).unwrap(),
        a.content_key(&main, 1).unwrap()
    );
    // The card passed to the session's new agent device.
    assert_eq!(a.object_owner(&main, &card_id).unwrap(), Some(new.id()));
    // The device that was taken out learns it from the Commit and writes nothing more.
    sync_all(&hub, &mut old);
    assert!(old.seal(&card(&main), None, &[], now()).is_err());
}

#[test]
fn only_the_confirmed_code_commits_and_a_burned_invite_commits_nothing() {
    let (_, _, _, mut a, _) = room();
    let mut b = new_device();
    let (opened, request, accepted) = exchange(&mut a, &mut b, Role::Human, None);
    let id = opened.invite_id;
    // The Request is accepted once; asked again with the same one, the answer is the same.
    assert_eq!(
        a.invite_accept(&id, &request.signed_request, now())
            .unwrap(),
        accepted
    );
    let mut late = new_device();
    let other = late
        .join_request(&link_text(&opened), &opened.signed_offer, now())
        .unwrap();
    assert_eq!(
        a.invite_accept(&id, &other.signed_request, now()),
        Err(Error::InviteUsed)
    );
    // Another code, or another Request, is not what the person confirmed.
    let mut numbers = accepted.code.numbers();
    numbers[0] = (numbers[0] + 1) % 64;
    let wrong = CheckCode::from_numbers(numbers).unwrap();
    assert_eq!(
        a.invite_confirm(&id, &wrong, &accepted.request_hash, true, now()),
        Err(Error::CodeNotConfirmed)
    );
    assert_eq!(
        a.invite_confirm(
            &id,
            &accepted.code,
            &trommi_core::ids::Hash32::new([1; 32]),
            true,
            now()
        ),
        Err(Error::CodeNotConfirmed)
    );
    assert!(a.outbox().is_empty());
    // Five minutes to confirm.
    assert_eq!(
        a.invite_confirm(
            &id,
            &accepted.code,
            &accepted.request_hash,
            true,
            now() + CONFIRM_MS + 1_000
        ),
        Err(Error::InviteExpired)
    );
    // "They don't match" burns the invite for good.
    assert_eq!(
        a.invite_confirm(&id, &accepted.code, &accepted.request_hash, false, now()),
        Ok(None)
    );
    assert_eq!(
        a.invite_confirm(&id, &accepted.code, &accepted.request_hash, true, now()),
        Err(Error::InviteBurned)
    );
    assert_eq!(
        a.invite_accept(&id, &other.signed_request, now()),
        Err(Error::InviteBurned)
    );
    assert!(a.outbox().is_empty() && a.invite_steps().unwrap().is_empty());
    assert_eq!(
        a.invite_accept(&InviteId::new([9; 16]), &other.signed_request, now()),
        Err(Error::NotFound)
    );
}

#[test]
fn an_invite_expires_and_sixteen_are_open_at_most() {
    let (_, _, main, mut a, mut agent) = room();
    let mut b = new_device();
    let start = now();
    let opened = a
        .invite_open(Role::Human, None, APP, &hub_address(), start)
        .unwrap();
    assert_eq!(opened.expires_at, start + INVITE_LIFE_MS);
    let request = b
        .join_request(&link_text(&opened), &opened.signed_offer, start)
        .unwrap();
    assert_eq!(
        a.invite_accept(
            &opened.invite_id,
            &request.signed_request,
            start + INVITE_LIFE_MS + 1
        ),
        Err(Error::InviteExpired)
    );
    // The new device does not answer an Offer that ran out either.
    let mut c = new_device();
    assert_eq!(
        c.join_request(
            &link_text(&opened),
            &opened.signed_offer,
            start + INVITE_LIFE_MS + 1
        ),
        Err(Error::InviteExpired)
    );
    for _ in 1..MAX_OPEN_INVITES {
        a.invite_open(Role::Human, None, APP, &hub_address(), start)
            .unwrap();
    }
    assert_eq!(
        a.invite_open(Role::Human, None, APP, &hub_address(), start)
            .map(|_| ()),
        Err(Error::TooMany)
    );
    // Once they ran out there is room again.
    a.invite_open(
        Role::Human,
        None,
        APP,
        &hub_address(),
        start + INVITE_LIFE_MS + 1,
    )
    .unwrap();
    // Only a human device invites; a human device is not invited into a session; a session to take over
    // is a live main session.
    assert_eq!(
        agent
            .invite_open(Role::Agent, None, APP, &hub_address(), start)
            .map(|_| ()),
        Err(Error::Forbidden)
    );
    let later = start + 3 * INVITE_LIFE_MS;
    let session = main.session_id().unwrap();
    assert_eq!(
        a.invite_open(Role::Human, Some(&session), APP, &hub_address(), later)
            .map(|_| ()),
        Err(Error::BadFormat)
    );
    assert_eq!(
        a.invite_open(
            Role::Agent,
            Some(&trommi_core::ids::SessionId::new([4; 16])),
            APP,
            &hub_address(),
            later
        )
        .map(|_| ()),
        Err(Error::NotFound)
    );
    assert_eq!(
        a.invite_open(Role::Agent, None, "app.example", &hub_address(), later)
            .map(|_| ()),
        Err(Error::BadFormat)
    );
    // The link is read strictly.
    let link = InviteLink::parse(&link_text(&opened)).unwrap();
    assert_eq!(link.invite_id().unwrap(), opened.invite_id);
    assert_eq!(link.app(), APP);
    assert_eq!(link.hub, hub_address());
}

#[test]
fn a_substituted_key_package_does_not_get_in() {
    let (mut hub, room, _, mut a, _) = room();
    let (mut b, mut thief) = (new_device(), new_device());
    let opened = a
        .invite_open(Role::Human, None, APP, &hub_address(), now())
        .unwrap();
    let request = b
        .join_request(&link_text(&opened), &opened.signed_offer, now())
        .unwrap();
    // A hub that puts another KeyPackage into the Request cannot make its MAC.
    let mut swapped = request.signed_request.clone();
    let mut inner = Request::decode(&swapped.request).unwrap();
    inner.key_package = thief.key_package(now()).unwrap();
    swapped.request = trommi_core::codec::encode(&inner).unwrap();
    assert_eq!(
        a.invite_accept(&opened.invite_id, &swapped, now()),
        Err(Error::BadInvite)
    );
    // Whoever got hold of the link can answer first; then the two devices do not show the same code: the
    // one the person holds shows none.
    let stolen = thief
        .join_request(&link_text(&opened), &opened.signed_offer, now())
        .unwrap();
    let accepted = a
        .invite_accept(&opened.invite_id, &stolen.signed_request, now())
        .unwrap();
    assert_eq!(accepted.new_device, thief.id());
    assert_eq!(
        b.join_reveal(&accepted.signed_reveal),
        Err(Error::BadInvite)
    );
    assert_eq!(
        a.invite_confirm(
            &opened.invite_id,
            &accepted.code,
            &accepted.request_hash,
            false,
            now()
        ),
        Ok(None)
    );

    // A Welcome from anyone but the inviter is not taken, also for the right KeyPackage.
    let mut c = new_device();
    trommi_tests::add_human(&mut hub, &mut a, &mut c);
    sync_all(&hub, &mut a);
    let mut d = new_device();
    let (_, request, accepted) = exchange(&mut a, &mut d, Role::Human, None);
    d.join_reveal(&accepted.signed_reveal).unwrap();
    let package = Request::decode(&request.signed_request.request)
        .unwrap()
        .key_package;
    c.add_human_device(&d.id(), &package, now()).unwrap();
    post_ok(&mut hub, &mut c);
    let welcome = hub.welcomes.last().unwrap().bytes.clone();
    assert_eq!(d.join_invited(&welcome, now()), Err(Error::BadInvite));
    assert!(d.room().is_none());
    let _ = room;
}

#[test]
fn an_agent_device_is_enrolled_by_its_inviter_alone() {
    let (mut hub, room, _, mut a, _) = room();
    let mut c = new_device();
    trommi_tests::add_human(&mut hub, &mut a, &mut c);
    sync_all(&hub, &mut a);
    let mut agent = new_device();
    let (_, _, accepted) = exchange(&mut a, &mut agent, Role::Agent, None);
    // Before the Reveal was checked the device follows nothing.
    let offered = hub.group_info(&room).unwrap().clone();
    assert_eq!(agent.join_observe(&offered), Err(Error::NotFound));
    agent.join_reveal(&accepted.signed_reveal).unwrap();
    // Nor from any state but the one the Offer names.
    assert_eq!(agent.observe_room(&offered, None), Err(Error::BadInvite));
    agent.join_observe(&offered).unwrap();
    // Another human device enrols it, not its inviter: the new device does not take that.
    c.change_agents(&[agent.id()], &[], now()).unwrap();
    post_ok(&mut hub, &mut c);
    let item = hub.log.last().unwrap().clone();
    assert_eq!(
        trommi_tests::process(&mut agent, &item),
        Err(Error::BadInvite)
    );
    assert!(!agent.room_history().unwrap().newest().is_agent(&agent.id()));
}

#[test]
fn a_device_signs_in_to_the_hub_with_its_own_key() {
    let (_, room, _, a, _) = room();
    let hub = hub_address();
    let issued = IssuedChallenge::issue(&mut SystemEntropy, now()).unwrap();
    let signed = a.hub_sign_in(&hub, issued.challenge).unwrap();
    assert_eq!(
        hub_auth::verify(&signed, &room.room_id(), &hub, &issued, now()),
        Ok(a.id())
    );
    // For another hub it is not a sign-in here.
    let other = HubAddress::parse("https://other.example").unwrap();
    assert_eq!(
        hub_auth::verify(&signed, &room.room_id(), &other, &issued, now()),
        Err(Error::Unauthorised)
    );
    assert_eq!(
        new_device().hub_sign_in(&hub, issued.challenge),
        Err(Error::NoRoom)
    );
}

#[test]
fn a_joining_device_signs_in_for_the_room_of_its_checked_invite() {
    let (_, room, _, mut a, _) = room();
    let mut b = new_device();
    let hub = hub_address();
    let issued = IssuedChallenge::issue(&mut SystemEntropy, now()).unwrap();
    let (_, _, accepted) = exchange(&mut a, &mut b, Role::Human, None);
    // A stored Offer alone is nothing to sign in with.
    assert_eq!(b.hub_sign_in(&hub, issued.challenge), Err(Error::NoRoom));
    b.join_reveal(&accepted.signed_reveal).unwrap();
    let signed = b.hub_sign_in(&hub, issued.challenge).unwrap();
    assert_eq!(
        hub_auth::verify(&signed, &room.room_id(), &hub, &issued, now()),
        Ok(b.id())
    );
    // Only at the hub the invite named.
    let other = HubAddress::parse("https://other.example").unwrap();
    assert_eq!(
        b.hub_sign_in(&other, issued.challenge),
        Err(Error::BadInvite)
    );
    // Nothing else follows from the stored Offer: the device has no room and holds no group.
    assert!(b.room().is_none() && b.groups().unwrap().is_empty() && !b.is_human());
}

#[test]
fn a_takeover_reaches_every_helper_session_and_survives_a_restart() {
    use trommi_tests::{found_helper, new_device_on, observe, reopen, MemoryStorage};
    let store = MemoryStorage::new();
    let handle = store.handle();
    let (mut hub, room, main, mut a, mut old) = room_of(new_device_on(store));
    let mut worker = new_device();
    observe(&hub, &mut worker);
    let helper = found_helper(&mut hub, &mut old, &main, &mut [&mut worker]);
    sync_all(&hub, &mut a);

    let mut new = new_device();
    let session = main.session_id().unwrap();
    let (opened, _, accepted) = exchange(&mut a, &mut new, Role::Agent, Some(&session));
    let code = new.join_reveal(&accepted.signed_reveal).unwrap();
    let offered = hub.group_info(&room).unwrap().clone();
    a.invite_confirm(
        &opened.invite_id,
        &code,
        &accepted.request_hash,
        true,
        now(),
    )
    .unwrap()
    .unwrap();
    post_ok(&mut hub, &mut a);
    sync_all(&hub, &mut a);
    let id = opened.invite_id;
    // (a) is done: both groups are stale. (b) comes first; the helper session waits for it.
    assert_eq!(a.group(&helper).unwrap().disallowed, vec![old.id()]);
    let steps = a.invite_steps().unwrap();
    assert_eq!(steps.len(), 1);
    let (
        _,
        InviteStep::TakeOver {
            group,
            cuts,
            agent,
            key_package,
        },
    ) = &steps[0]
    else {
        panic!("the main session first: {steps:?}");
    };
    assert_eq!(*group, main);
    a.clean_session(
        group,
        cuts,
        Some((agent, key_package.as_ref().unwrap())),
        now(),
    )
    .unwrap();
    post_ok(&mut hub, &mut a);
    sync_all(&hub, &mut a);

    // (c): the helper session, with a KeyPackage of the new device that the step does not carry.
    let expect_helper = |steps: &[(trommi_core::ids::InviteId, InviteStep)], cut: usize| {
        assert!(steps.contains(&(
            id,
            InviteStep::Handover {
                group: main,
                device: new.id()
            }
        )));
        let found = steps.iter().find_map(|(_, step)| match step {
            InviteStep::TakeOver {
                group,
                cuts,
                agent,
                key_package: None,
            } if *group == helper && *agent == new.id() => Some(cuts.clone()),
            _ => None,
        });
        assert_eq!(found.expect("the helper session's takeover").len(), cut);
    };
    expect_helper(&a.invite_steps().unwrap(), 1);
    // The inviter restarts: the steps are read from the groups again.
    drop(a);
    let mut a = reopen(handle.reopened()).unwrap();
    expect_helper(&a.invite_steps().unwrap(), 1);
    // Without history: only the handovers go, the takeover stays.
    a.invite_forget(&id).unwrap();
    let steps = a.invite_steps().unwrap();
    assert_eq!(steps.len(), 1);
    assert!(matches!(&steps[0].1, InviteStep::TakeOver { group, .. } if *group == helper));

    // The main session has its new agent leaf, so the helper session is stale for its outdated opener
    // leaf and for the opener it lacks (5.2.8): the Remove alone is not taken, the step's one Commit removes
    // and adds.
    let (_, InviteStep::TakeOver { cuts, .. }) = &steps[0] else {
        unreachable!()
    };
    let summary = a.group(&helper).unwrap();
    assert_eq!(
        (summary.disallowed, summary.missing_opener),
        (vec![old.id()], Some(new.id()))
    );
    assert_eq!(
        a.clean_session(&helper, cuts, None, now()),
        Err(Error::StaleSession)
    );
    publish_some(&mut hub, &mut new, 2);
    let package = hub.claim(&[new.id()]).unwrap().remove(0);
    a.clean_session(&helper, cuts, Some((&new.id(), &package)), now())
        .unwrap();
    assert_eq!(a.invite_steps().unwrap(), vec![(id, InviteStep::Wait)]);
    post_ok(&mut hub, &mut a);
    sync_all(&hub, &mut a);
    // What the hub lists under the session is held against this device's groups: one it does not hold
    // keeps the invite open (5.3.1 c).
    assert_eq!(
        a.invite_steps().unwrap(),
        vec![(id, InviteStep::CheckHelpers { session })]
    );
    let unseen = GroupId::session(room.room_id(), trommi_core::ids::SessionId::new([8; 16]));
    assert_eq!(
        a.invite_checked(&id, &[helper, unseen]),
        Err(Error::GroupBehind)
    );
    a.invite_checked(&id, &[helper]).unwrap();
    // Finished: nothing is listed, and the invite's record is gone.
    assert!(a.invite_steps().unwrap().is_empty());
    assert_eq!(a.invite_forget(&id), Err(Error::NotFound));
    assert!(hub.stale_leaves(&helper).unwrap().is_empty());

    // The new device is in both groups, and is the helper session's opener: it adds a helper device.
    new.join_observe(&offered).unwrap();
    sync_all(&hub, &mut new);
    assert!(new.group(&main).is_ok() && new.group(&helper).is_ok());
    let mut second = new_device();
    observe(&hub, &mut second);
    let package = second.key_package(now()).unwrap();
    new.add_to_session(&helper, &second.id(), &package, now())
        .unwrap();
    post_ok(&mut hub, &mut new);
}

#[test]
fn the_recovery_mac_follows_the_add_by_link_without_a_call_also_across_a_restart() {
    use trommi_tests::{new_device_on, reopen, MemoryStorage};
    // The inviter crashes at one of three places: nowhere, before it posted the Commit, or after the hub
    // took the Commit and before it heard the answer.
    for crash in [0, 1, 2] {
        let store = MemoryStorage::new();
        let handle = store.handle();
        let (mut hub, room, main, mut a, _) = room_of(new_device_on(store));
        let mut b = new_device();
        let (opened, _, accepted) = exchange(&mut a, &mut b, Role::Human, None);
        let code = b.join_reveal(&accepted.signed_reveal).unwrap();
        a.invite_confirm(
            &opened.invite_id,
            &code,
            &accepted.request_hash,
            true,
            now(),
        )
        .unwrap()
        .unwrap();
        if crash == 1 {
            drop(a);
            a = reopen(handle.reopened()).unwrap();
        }
        if crash == 2 {
            let entry = a.outbox().remove(0);
            hub.post(&a.id(), &entry).unwrap();
            drop(a);
            a = reopen(handle.reopened()).unwrap();
        }
        // The host only posts what is in the outbox and feeds the log: the Add, and behind it the message
        // the inviter owes with that Commit (7.4).
        post_ok(&mut hub, &mut a);
        sync_all(&hub, &mut a);
        post_ok(&mut hub, &mut a);
        let welcome = hub.welcomes.last().unwrap().clone();
        b.join_invited(&welcome.bytes, now()).unwrap();
        for item in hub.log_after(welcome.change) {
            trommi_tests::process(&mut b, &item).unwrap();
        }
        assert!(b.holds_recovery_mac(), "crash {crash}");
        // It commits: an update of its own leaf.
        b.update(&room, true, now()).unwrap().unwrap();
        post_ok(&mut hub, &mut b);

        // A later session Welcome is taken from any human device of the room, not only the inviter (5.2.7).
        let mut c = new_device();
        sync_all(&hub, &mut a);
        trommi_tests::add_human(&mut hub, &mut a, &mut c);
        sync_all(&hub, &mut a);
        publish_some(&mut hub, &mut c, 2);
        let package = hub.claim(&[c.id()]).unwrap().remove(0);
        a.add_to_session(&main, &c.id(), &package, now()).unwrap();
        post_ok(&mut hub, &mut a);
        sync_all(&hub, &mut c);
        sync_all(&hub, &mut b);
        let package = b.key_package(now()).unwrap();
        c.add_to_session(&main, &b.id(), &package, now()).unwrap();
        post_ok(&mut hub, &mut c);
        let joined = trommi_tests::take_welcomes(&hub, &mut b, hub.change());
        assert_eq!(joined.len(), 1);
        assert_eq!((joined[0].group, joined[0].added_by), (main, c.id()));
        assert!(joined[0].offending.is_empty());
        // The invite is over for the new device: the stored Offer names no later Welcome.
        assert_eq!(b.join_invited(&welcome.bytes, now()), Err(Error::NotFound));
    }
}
