//! A room at its limit of human devices (section 16), by the real paths.

use trommi_core::mls::profile::MAX_HUMAN_DEVICES;
use trommi_core::Error;
use trommi_tests::{found_room, join_room, new_device, post_ok, sync, test_keys};

#[test]
fn signing_in_to_a_full_room_is_too_many_before_anything_is_built() {
    let mut a = new_device();
    let (mut hub, room) = found_room(&mut a);
    let keys = test_keys();
    // Devices sign in with the code one after another until the room is full.
    for _ in 1..MAX_HUMAN_DEVICES {
        let mut next = new_device();
        join_room(&hub, &mut next, &keys).expect("the join is built");
        post_ok(&mut hub, &mut next);
    }
    for result in sync(&hub, &mut a) {
        result.expect("the member follows every join");
    }
    assert_eq!(a.group(&room).unwrap().leaves.len(), MAX_HUMAN_DEVICES);

    // One more, and the next after it: the device builds no join into a full room, every time with the same
    // code. A join the hub was handed all the same is `too-many` there and for every member: the rules
    // (`rules.rs`: the join from outside past the limit) are the same code on each side.
    for _ in 0..2 {
        let mut over = new_device();
        assert_eq!(
            join_room(&hub, &mut over, &keys).err(),
            Some(Error::TooMany)
        );
        assert!(over.outbox().is_empty() && over.room().is_none());
    }
    assert_eq!(
        hub.history().unwrap().newest().humans.len(),
        MAX_HUMAN_DEVICES
    );
}
