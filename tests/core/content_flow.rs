//! Stored content through the public interface only: an agent's card goes to the hub and to a human device, the
//! human's answer comes back through the hub, the agent's command gate lets it through once. Group facts are
//! written by hand: one main session with two human devices and one agent device, in epoch 0.

use std::collections::BTreeMap;
use trommi_core::chain::{
    hub_take, receive, seal_next, ChainRecords, Chains, EpochEnd, GroupFacts, Head, Mode, Outcome,
    OwnChain, Receipt, Role, Served,
};
use trommi_core::crypto::{Secret, SigningKey, SystemEntropy};
use trommi_core::envelope::{AnswerBind, Bind, Draft, ObjectState, ObjectType, Urgency};
use trommi_core::ids::{DeviceId, GroupId, Hash32, RoomId, SessionId};
use trommi_core::objects::{
    command_gate, AnswerAction, Command, Decision, GateLog, Objects, OwnRecord,
};
use trommi_core::registers::{self, OwnIds, Registers};
use trommi_core::Error;

const ROOM: RoomId = RoomId::new([1; 32]);
const NOW: u64 = 1_800_000_000_000;

/// One party's view: the session's leaves, whether it holds the content key, what it accepted.
struct View {
    leaves: BTreeMap<DeviceId, Role>,
    holds_key: bool,
    accepted: BTreeMap<(DeviceId, u64), Hash32>,
    chains: Chains,
    objects: Objects,
}

impl View {
    fn new(leaves: &BTreeMap<DeviceId, Role>, holds_key: bool) -> Self {
        Self {
            leaves: leaves.clone(),
            holds_key,
            accepted: BTreeMap::new(),
            chains: Chains::new(),
            objects: Objects::new(),
        }
    }

    /// Stores what a receipt changes, as one write.
    fn store(&mut self, receipt: &Receipt) {
        self.chains.apply(receipt.advance()).unwrap();
        if let Outcome::Taken {
            transition: Some(transition),
            ..
        } = receipt.outcome()
        {
            self.objects.apply(transition).unwrap();
        }
        self.accepted.insert(
            (receipt.advance().sender, receipt.advance().head.seq),
            receipt.hash(),
        );
    }
}

impl GroupFacts for View {
    fn room(&self) -> RoomId {
        ROOM
    }

    fn processed_epoch(&self, group: &GroupId) -> Result<Option<u64>, Error> {
        Ok((*group == session()).then_some(0))
    }

    fn leaf_role(&self, _: &GroupId, epoch: u64, device: &DeviceId) -> Result<Option<Role>, Error> {
        Ok(self.leaves.get(device).copied().filter(|_| epoch == 0))
    }

    fn seat(&self, _: &GroupId, _: u64) -> Result<Option<DeviceId>, Error> {
        Ok(self
            .leaves
            .iter()
            .find(|(_, role)| **role == Role::Agent)
            .map(|(device, _)| *device))
    }

    fn cut(&self, _: &GroupId, _: &DeviceId) -> Result<Option<Head>, Error> {
        Ok(None)
    }

    fn epoch_end(&self, _: &GroupId, _: u64) -> Result<Option<EpochEnd>, Error> {
        Ok(None)
    }

    fn is_stale(&self, _: &GroupId) -> Result<bool, Error> {
        Ok(false)
    }

    fn is_human_now(&self, device: &DeviceId) -> Result<bool, Error> {
        Ok(self.leaves.get(device) == Some(&Role::Human))
    }

    fn content_key(&self, _: &GroupId, _: u64) -> Result<Option<Secret<32>>, Error> {
        Ok(self.holds_key.then(|| Secret::new([7; 32])))
    }
}

impl ChainRecords for View {
    fn accepted_hash(
        &self,
        _: &GroupId,
        sender: &DeviceId,
        seq: u64,
    ) -> Result<Option<Hash32>, Error> {
        Ok(self.accepted.get(&(*sender, seq)).copied())
    }
}

fn session() -> GroupId {
    GroupId::session(ROOM, SessionId::new([2; 16]))
}

#[test]
fn a_card_is_answered_through_the_hub_and_the_gate() {
    let mut entropy = SystemEntropy;
    let human = SigningKey::generate(&mut entropy).unwrap();
    let agent = SigningKey::generate(&mut entropy).unwrap();
    let (human_id, agent_id) = (DeviceId::new(human.public()), DeviceId::new(agent.public()));
    let leaves: BTreeMap<DeviceId, Role> =
        [(human_id, Role::Human), (agent_id, Role::Agent)].into();
    let mut hub = View::new(&leaves, false);
    let mut at_human = View::new(&leaves, true);
    let mut at_agent = View::new(&leaves, true);

    // The agent makes a card.
    let card_payload = format!(
        r#"{{"card_type":"decision","title":"Ship?","options":[{{"key":"yes","label":"Yes"}},{{"key":"no","label":"No"}}],"object_version":1,"previous_version_hash":"{}"}}"#,
        Hash32::ZERO.to_base64url()
    );
    let draft =
        Draft::first_version(ObjectType::Card, Urgency::High, card_payload.as_bytes()).unwrap();
    let mut agent_chain = OwnChain::new();
    let card = seal_next(
        &at_agent,
        &at_agent.chains,
        &at_agent.objects,
        &mut agent_chain,
        &draft.with_push(),
        session(),
        &agent,
        NOW,
        &mut entropy,
    )
    .unwrap();
    let bytes = card.envelope.encode().unwrap();

    // The hub takes it without reading it, and files it by its header.
    let receipt = hub_take(
        &hub,
        &hub,
        &hub.chains,
        &hub.objects,
        &agent_id,
        &bytes,
        NOW,
    )
    .unwrap();
    assert!(matches!(
        receipt.outcome(),
        Outcome::Taken {
            body: Err(Error::NoKey),
            ..
        }
    ));
    assert!(trommi_core::objects::push_honoured(&hub, &receipt.envelope().header).unwrap());
    hub.store(&receipt);
    let object_id = *hub.objects.iter().next().unwrap().0;
    assert_eq!(
        hub.objects.get(&object_id).unwrap().state,
        ObjectState::Open
    );
    // A second device may not post it.
    assert_eq!(
        hub_take(
            &hub,
            &hub,
            &Chains::new(),
            &Objects::new(),
            &human_id,
            &bytes,
            NOW
        )
        .err(),
        Some(Error::WrongSender)
    );

    // Both devices receive it in the hub's order.
    for (view, me) in [(&mut at_human, human_id), (&mut at_agent, agent_id)] {
        let receipt = receive(
            view,
            view,
            &view.chains,
            &view.objects,
            &me,
            &bytes,
            &Served::Stored,
            Mode::InOrder,
            NOW,
        )
        .unwrap();
        assert_eq!(receipt.hash(), card.hash);
        view.store(&receipt);
    }

    // The human answers "yes".
    let bind = AnswerBind {
        object_id,
        version_hash: card.hash,
        choices: vec![b"yes".to_vec()],
    };
    let draft = Draft::answer(
        bind,
        false,
        Urgency::High,
        agent_id,
        br#"{"answer_action":"answer","choices":["yes"]}"#,
    );
    let answer = seal_next(
        &at_human,
        &at_human.chains,
        &at_human.objects,
        &mut OwnChain::new(),
        &draft,
        session(),
        &human,
        NOW + 1000,
        &mut entropy,
    )
    .unwrap();
    let bytes = answer.envelope.encode().unwrap();
    let receipt = hub_take(
        &hub,
        &hub,
        &hub.chains,
        &hub.objects,
        &human_id,
        &bytes,
        NOW + 1000,
    )
    .unwrap();
    hub.store(&receipt);
    assert_eq!(
        hub.objects.get(&object_id).unwrap().state,
        ObjectState::Answered
    );

    // The agent receives it, stores the transition and the gate's record, then acts.
    let receipt = receive(
        &at_agent,
        &at_agent,
        &at_agent.chains,
        &at_agent.objects,
        &agent_id,
        &bytes,
        &Served::Stored,
        Mode::InOrder,
        NOW + 2000,
    )
    .unwrap();
    let opened = receipt.opened().unwrap();
    assert!(matches!(opened.body().bind(), Bind::Answer(_)));
    let own = OwnRecord::CardVersion {
        hash: card.hash,
        payload: card_payload.as_bytes(),
    };
    let mut log = GateLog::new();
    let decision = command_gate(&at_agent, &mut log, &agent_id, &opened, &own, NOW + 2000).unwrap();
    assert_eq!(
        decision,
        Decision::Act(Command::Answer {
            action: AnswerAction::Answer,
            choices: vec!["yes".into()]
        })
    );
    at_agent.store(&receipt);
    let again = command_gate(&at_agent, &mut log, &agent_id, &opened, &own, NOW + 2000).unwrap();
    assert_eq!(again, Decision::Uncertain);
    log.finish(&receipt.hash()).unwrap();
    let again = command_gate(&at_agent, &mut log, &agent_id, &opened, &own, NOW + 2000).unwrap();
    assert_eq!(again, Decision::Done);

    // The agent's next envelope continues its chain: a status line register.
    let mut ids = OwnIds::new();
    let registers_state = Registers::new();
    let draft = registers::write(
        &registers_state,
        &mut ids,
        "status_line/main",
        Some(r#"{"label":"Build","state":"done"}"#),
        &mut entropy,
    )
    .unwrap();
    let status = seal_next(
        &at_agent,
        &at_agent.chains,
        &at_agent.objects,
        &mut agent_chain,
        &draft,
        session(),
        &agent,
        NOW + 3000,
        &mut entropy,
    )
    .unwrap();
    assert_eq!(status.envelope.header.seq, 2);
    assert_eq!(status.envelope.header.prev, card.hash);
    let receipt = receive(
        &at_human,
        &at_human,
        &at_human.chains,
        &at_human.objects,
        &human_id,
        &status.envelope.encode().unwrap(),
        &Served::Stored,
        Mode::InOrder,
        NOW + 3000,
    )
    .unwrap();
    let opened = receipt.opened().unwrap();
    let mut registers_at_human = Registers::new();
    let update = registers_at_human
        .judge(&at_human, opened.header(), opened.body().payload())
        .unwrap();
    registers_at_human.apply(&update).unwrap();
    assert_eq!(
        registers_at_human.get("status_line/main"),
        Some(r#"{"label":"Build","state":"done"}"#)
    );
}
