//! Founding a room and a session, adding a second human device, and the keys they share.

use trommi_core::device::Processed;
use trommi_core::ids::GroupId;
use trommi_core::invite::Role;
use trommi_tests::hub::Hub;
use trommi_tests::{
    enrol, join_invited, new_device, now, post_ok, publish_key_packages, sync_ok, test_keys,
    try_invite,
};

#[test]
fn a_room_and_a_session_are_founded_and_shared() {
    let mut hub = Hub::new(true);
    let mut a = new_device();
    let room = a.found_room(&test_keys(), now()).unwrap();
    let room_group = GroupId::room(room);
    post_ok(&mut hub, &mut a);
    assert_eq!(hub.epoch(&room_group), Some(0));
    assert!(a.is_human());

    // A second human device, invited and added with the KeyPackage of its Request.
    let mut b = new_device();
    try_invite(&mut a, &mut b, Role::Human, None).unwrap();
    post_ok(&mut hub, &mut a);
    assert_eq!(hub.epoch(&room_group), Some(1));
    let joined = join_invited(&hub, &mut b);
    assert_eq!(joined.added_by, a.id());
    assert_eq!(
        a.content_key(&room_group, 1).unwrap(),
        b.content_key(&room_group, 1).unwrap()
    );

    // An agent device is enrolled and gets its main session.
    let mut agent = new_device();
    publish_key_packages(&mut hub, &mut agent);
    publish_key_packages(&mut hub, &mut b);
    enrol(&mut hub, &mut a, &mut agent);
    let packages = hub.claim(&[b.id(), agent.id()]).unwrap();
    let session = a.found_session(&agent.id(), &packages, now()).unwrap();
    post_ok(&mut hub, &mut a);
    let group = GroupId::session(room, session);
    assert_eq!(hub.epoch(&group), Some(1));

    let processed = sync_ok(&hub, &mut b);
    assert!(processed
        .iter()
        .any(|done| matches!(done, Processed::Commit { .. })));
    assert_eq!(
        a.content_key(&group, 1).unwrap(),
        b.content_key(&group, 1).unwrap()
    );
    assert_eq!(b.group(&group).unwrap().leaves.len(), 3);
}
