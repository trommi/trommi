//! Writing while an own Commit waits for its place in the log (13.2, 9.0.5): the hub accepted the Commit, the
//! device merges it where the log shows it, and what it seals meanwhile is sealed under the epoch it still
//! stands in.

use trommi_core::device::{Draft, EnvelopeOutcome, Processed};
use trommi_core::ids::GroupId;
use trommi_core::store::OutboxKind;
use trommi_core::Error;
use trommi_tests::{
    add_human, enrol, found_main, found_room, json, new_device, now, post_ok, process,
    publish_some, sync_all, take_envelope,
};

fn chat(group: &GroupId, text: &str) -> Draft {
    Draft::SessionChat {
        session: group.session_id().unwrap(),
        payload: json(&format!(r#"{{"text":"{text}"}}"#)),
    }
}

#[test]
fn an_envelope_sealed_while_an_accepted_commit_waits_is_of_the_old_epoch_and_is_taken() {
    let (mut a, mut b, mut agent) = (new_device(), new_device(), new_device());
    let (mut hub, _) = found_room(&mut a);
    add_human(&mut hub, &mut a, &mut b);
    for device in [&mut a, &mut b, &mut agent] {
        publish_some(&mut hub, device, 4);
    }
    enrol(&mut hub, &mut a, &mut agent);
    let main = found_main(&mut hub, &mut a, &agent.id());
    for device in [&mut a, &mut b, &mut agent] {
        sync_all(&hub, device);
    }
    let old = a.group(&main).unwrap().epoch;

    // The Commit is built: until the hub answers the device seals nothing in the group.
    a.update(&main, true, now()).unwrap().unwrap();
    assert_eq!(
        a.seal(&chat(&main, "too early"), None, &[], now()).err(),
        Some(Error::Busy)
    );
    let entry = a.outbox().remove(0);
    assert_eq!(entry.kind, OutboxKind::Commit);
    let accepted = hub.post(&a.id(), &entry).unwrap();
    a.outbox_accepted(entry.id, accepted).unwrap();
    let waiting = a.group(&main).unwrap();
    assert_eq!((waiting.epoch, waiting.pending), (old, true));

    // Accepted and not yet merged: the device writes on, under the epoch it stands in.
    let sealed = a.seal(&chat(&main, "hello"), None, &[], now()).unwrap();
    let envelope = a.outbox().remove(0);
    assert_eq!((envelope.kind, envelope.epoch), (OutboxKind::Envelope, old));
    assert_eq!(a.group(&main).unwrap().epoch, old);
    // The hub takes it, behind the Commit that ended that epoch.
    post_ok(&mut hub, &mut a);
    assert_eq!(hub.epoch(&main), Some(old + 1));

    // The readers process the Commit, then the envelope of the epoch it ended, within the two minutes.
    for reader in [&mut b, &mut agent] {
        let received = sync_all(&hub, reader);
        assert_eq!(reader.group(&main).unwrap().epoch, old + 1);
        let [got] = &received[..] else {
            panic!("one envelope: {received:?}");
        };
        assert_eq!(got.envelope_hash, sealed.envelope_hash);
        assert_eq!(got.header.epoch, old);
        assert_eq!((got.outcome, &got.code), (EnvelopeOutcome::Applied, &None));
    }
    // The writer merges its Commit where the log shows it, with the epoch's record written there, and its
    // own envelope comes back applied.
    let commit = hub
        .log
        .iter()
        .find(|item| item.change == accepted.change.unwrap())
        .unwrap()
        .clone();
    assert_eq!(process(&mut a, &commit), Ok(Processed::OwnCommit));
    let merged = a.group(&main).unwrap();
    assert_eq!((merged.epoch, merged.pending), (old + 1, false));
    let own = hub.content.envelopes.last().unwrap().clone();
    let got = take_envelope(&mut a, &own);
    assert_eq!((got.outcome, &got.code), (EnvelopeOutcome::Applied, &None));
    // In the new epoch it writes under the new key.
    a.seal(&chat(&main, "again"), None, &[], now()).unwrap();
    assert_eq!(a.outbox()[0].epoch, old + 1);
}
