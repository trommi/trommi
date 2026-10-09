//! The write order (13.2) for stored content under failing writes and crashes (section 19, conformance 5):
//! an envelope is written with its number before it leaves, a retry sends the same bytes, no number is signed
//! twice for an envelope that left, and no command is acted on twice.

use trommi_core::chain::Head;
use trommi_core::device::{Draft, EnvelopeOutcome};
use trommi_core::envelope::Envelope;
use trommi_core::ids::{GroupId, SessionId};
use trommi_core::objects::{Command, Decision};
use trommi_core::store::OutboxEntry;
use trommi_core::Error;
use trommi_tests::hub::Hub;
use trommi_tests::{
    enrol, found_main, found_room, json, new_device, new_device_on, now, post_ok, publish_some,
    reopen, sync_all, MemoryStorage, TestDevice,
};

/// What a device shows of its content state: enough to tell two states apart.
#[derive(Debug, PartialEq)]
struct Shown {
    cursor: u64,
    outbox: Vec<OutboxEntry>,
    heads: Vec<Head>,
    pending: Vec<trommi_core::ids::Hash32>,
}

/// A room with a human device and an agent in its main session; `on_store` is the one under test.
struct Run {
    hub: Hub,
    human: TestDevice,
    agent: TestDevice,
    handle: MemoryStorage,
    tested_is_agent: bool,
    group: GroupId,
    session: SessionId,
    crash_after: Option<usize>,
    fail_at: Option<usize>,
}

impl Run {
    fn start(tested_is_agent: bool, crash_after: Option<usize>, fail_at: Option<usize>) -> Self {
        let store = MemoryStorage::new();
        let handle = store.handle();
        let (mut human, mut agent) = if tested_is_agent {
            (new_device(), new_device_on(store))
        } else {
            (new_device_on(store), new_device())
        };
        let (mut hub, _) = found_room(&mut human);
        publish_some(&mut hub, &mut agent, 2);
        enrol(&mut hub, &mut human, &mut agent);
        let group = found_main(&mut hub, &mut human, &agent.id());
        sync_all(&hub, &mut human);
        sync_all(&hub, &mut agent);
        Self {
            hub,
            human,
            agent,
            handle,
            tested_is_agent,
            group,
            session: group.session_id().unwrap(),
            crash_after,
            fail_at,
        }
    }

    fn tested(&mut self) -> &mut TestDevice {
        if self.tested_is_agent {
            &mut self.agent
        } else {
            &mut self.human
        }
    }

    fn shown(&self, device: &TestDevice) -> Shown {
        Shown {
            cursor: device.cursor(),
            outbox: device.outbox(),
            heads: [self.human.id(), self.agent.id()]
                .iter()
                .map(|sender| device.chain_head(&self.group, sender).unwrap())
                .collect(),
            pending: device.commands_pending().unwrap(),
        }
    }

    fn shown_now(&self) -> Shown {
        let device = if self.tested_is_agent {
            &self.agent
        } else {
            &self.human
        };
        self.shown(device)
    }

    /// Runs one step of the device under test. With a failing write planned for it, the step fails as a
    /// storage error and changes nothing; it is then run again. With a crash planned after it, the device is
    /// opened again on what its store holds.
    fn step<T>(
        &mut self,
        number: usize,
        mut step: impl FnMut(&mut Hub, &mut TestDevice) -> Result<T, Error>,
    ) -> T {
        if self.fail_at == Some(number) {
            let before = self.shown_now();
            self.handle.fail_apply(1);
            let (hub, device) = if self.tested_is_agent {
                (&mut self.hub, &mut self.agent)
            } else {
                (&mut self.hub, &mut self.human)
            };
            let error = step(hub, device).err().expect("the write fails");
            assert_eq!(error, Error::Storage("planned failure".into()));
            assert_eq!(self.shown_now(), before, "step {number}");
        }
        let (hub, device) = if self.tested_is_agent {
            (&mut self.hub, &mut self.agent)
        } else {
            (&mut self.hub, &mut self.human)
        };
        let done = step(hub, device).expect("the step");
        let twin = reopen(self.handle.reopened()).unwrap();
        assert_eq!(
            self.shown(&twin),
            self.shown_now(),
            "memory is what is stored"
        );
        if self.crash_after == Some(number) {
            let before = self.shown_now();
            let store = self.handle.reopened();
            self.handle = store.handle();
            *self.tested() = reopen(store).unwrap();
            assert_eq!(
                self.shown_now(),
                before,
                "after a crash behind step {number}"
            );
        }
        done
    }
}

/// Every way to interrupt a run of `steps` steps: nowhere, a crash after one, a failing write in one, or both.
fn interruptions(steps: usize, writes: &[usize]) -> Vec<(Option<usize>, Option<usize>)> {
    let places: Vec<Option<usize>> = std::iter::once(None).chain((1..=steps).map(Some)).collect();
    let mut all = Vec::new();
    for crash_after in &places {
        for fail_at in places
            .iter()
            .filter(|step| step.is_none_or(|step| writes.contains(&step)))
        {
            all.push((*crash_after, *fail_at));
        }
    }
    all
}

fn chat(session: SessionId, text: &str) -> Draft {
    Draft::SessionChat {
        session,
        payload: json(&format!(r#"{{"text":"{text}"}}"#)),
    }
}

#[test]
fn an_envelope_survives_a_crash_or_a_failed_write_at_every_step() {
    // Sealed, posted, answer reported, read back from the hub. Posting writes nothing.
    for (crash_after, fail_at) in interruptions(4, &[1, 3, 4]) {
        let mut run = Run::start(false, crash_after, fail_at);
        let (session, group) = (run.session, run.group);
        let me = run.human.id();
        let mut posted: Vec<Vec<Vec<u8>>> = Vec::new();

        // 1: the envelope is signed and written with the chain it leaves. A write that fails leaves the
        // number unused, for an envelope that never left.
        let sealed = run.step(1, |_, device| {
            device.seal(&chat(session, "one"), None, &[], now())
        });
        assert_eq!(sealed.seq, 1);
        let entry = run.tested().outbox().remove(0);
        assert_eq!(
            Envelope::decode(&entry.parts[0]).unwrap().hash().unwrap(),
            sealed.envelope_hash
        );
        // 2: posted. 3: posted again, answered alike, and the answer reported.
        let answer = run.step(2, |hub, device| {
            let entry = device.outbox().remove(0);
            posted.push(entry.parts.clone());
            hub.post(&device.id(), &entry)
        });
        run.step(3, |hub, device| {
            let entry = device.outbox().remove(0);
            posted.push(entry.parts.clone());
            assert_eq!(hub.post(&device.id(), &entry), Ok(answer));
            device.outbox_accepted(entry.id, answer)
        });
        assert!(posted.iter().all(|parts| *parts == entry.parts));
        assert_eq!(run.hub.chain_of(&group, &me, 0).len(), 1);
        // 4: it comes back at its place and takes effect on the writer's own view.
        let got = run.step(4, |hub, device| {
            let mut got = Vec::new();
            for change in hub.changes_after(device.cursor()) {
                if let trommi_tests::hub::content::Change::Envelope(stored) = change {
                    got.push(device.receive_envelope(
                        &stored.bytes,
                        stored.change,
                        true,
                        None,
                        now(),
                    )?);
                }
            }
            Ok(got)
        });
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].outcome, EnvelopeOutcome::Applied);
        assert_eq!(run.human.chain_head(&group, &me).unwrap().seq, 1);
        assert!(run.human.outbox().is_empty());

        // The next envelope has the next number, whatever happened on the way, and the hub takes it.
        let next = run
            .human
            .seal(&chat(session, "two"), None, &[], now())
            .unwrap();
        assert_eq!(next.seq, 2, "{crash_after:?} {fail_at:?}");
        post_ok(&mut run.hub, &mut run.human);
        assert_eq!(run.hub.chain_of(&group, &me, 0).len(), 2);
        let at_agent = sync_all(&run.hub, &mut run.agent);
        assert!(at_agent
            .iter()
            .all(|got| got.outcome == EnvelopeOutcome::Applied));
    }
}

#[test]
fn a_command_survives_a_crash_or_a_failed_write_and_never_acts_twice() {
    // Received, decided, finished.
    for (crash_after, fail_at) in interruptions(3, &[1, 2, 3]) {
        let mut run = Run::start(true, crash_after, fail_at);
        let said = run
            .human
            .seal(&chat(run.session, "go"), None, &[], now())
            .unwrap();
        post_ok(&mut run.hub, &mut run.human);
        let hash = said.envelope_hash;

        // 1: the envelope is taken, with the state its object had and the cursor, in one write.
        let got = run.step(1, |hub, device| {
            let mut got = Vec::new();
            for change in hub.changes_after(device.cursor()) {
                if let trommi_tests::hub::content::Change::Envelope(stored) = change {
                    got.push(device.receive_envelope(
                        &stored.bytes,
                        stored.change,
                        true,
                        None,
                        now(),
                    )?);
                }
            }
            Ok(got)
        });
        assert!(got[0].command);
        // Nothing is lost: what arrived and was not yet decided is still there after a restart.
        assert_eq!(run.agent.commands_pending().unwrap(), vec![hash]);
        // Handed again, it is not taken twice.
        let stored = run.hub.chain_of(&run.group, &run.human.id(), 0).remove(0);
        let again = run
            .agent
            .receive_envelope(&stored.bytes, stored.change, true, None, now())
            .unwrap_or_else(|error| panic!("{error:?}"));
        assert_eq!(again.code, Some(Error::Replay));

        // 2: the gate. The command is recorded as started in the write that lets it through: a failed write
        // lets nothing through, and after it the answer is still to act, once.
        let mut acts = 0;
        let decision = run.step(2, |_, device| {
            let decision = device.command(&hash, now())?;
            if decision == Decision::Act(Command::Chat) {
                acts += 1;
            }
            Ok(decision)
        });
        assert_eq!(decision, Decision::Act(Command::Chat));
        assert_eq!(acts, 1);
        // Whether the device crashed behind the gate or not: asked again, it is told the effect is uncertain,
        // and never to act again.
        assert_eq!(
            run.agent.command(&hash, now()).unwrap(),
            Decision::Uncertain
        );
        // 3: the effect is complete.
        run.step(3, |_, device| device.command_finished(&hash));
        assert_eq!(run.agent.command(&hash, now()).unwrap(), Decision::Done);
        assert!(run.agent.commands_pending().unwrap().is_empty());
    }
}

#[test]
fn a_refused_envelope_keeps_its_number_and_a_voided_one_too() {
    let mut run = Run::start(false, None, None);
    let (session, group) = (run.session, run.group);
    let me = run.human.id();
    // The hub is unreachable in a way that takes no number: the entry stays, byte for byte, across a restart.
    run.human
        .seal(&chat(session, "one"), None, &[], now())
        .unwrap();
    let entry = run.human.outbox().remove(0);
    run.human
        .outbox_refused(entry.id, &Error::Overloaded)
        .unwrap();
    let store = run.handle.reopened();
    run.human = reopen(store).unwrap();
    assert_eq!(run.human.outbox(), vec![entry.clone()]);
    // The next envelope chains on it; the hub takes them in order.
    let second = run
        .human
        .seal(&chat(session, "two"), None, &[], now())
        .unwrap();
    assert_eq!(second.seq, 2);
    post_ok(&mut run.hub, &mut run.human);
    assert_eq!(run.hub.chain_of(&group, &me, 0).len(), 2);

    // A device that gives up on an envelope keeps its number used: what it writes next names it as `prev`,
    // and the hub, which never got it, finds a gap.
    run.human
        .seal(&chat(session, "three"), None, &[], now())
        .unwrap();
    let dropped = run.human.outbox().remove(0);
    run.human.envelope_abandon(dropped.id).unwrap();
    let fourth = run
        .human
        .seal(&chat(session, "four"), None, &[], now())
        .unwrap();
    assert_eq!(fourth.seq, 4);
    let entry = run.human.outbox().remove(0);
    assert_eq!(run.hub.post(&me, &entry), Err(Error::Gap));
    assert!(!run.hub.voided(&entry));
    // Only an envelope entry is given up or voided this way.
    assert_eq!(run.human.outbox_voided(99), Err(Error::NotFound));
}
