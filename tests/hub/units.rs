//! Unit tests of the hub's parts through their public functions: encodings, rules, the object state rule, limits,
//! streams, push request building, passkey checks, account fields, ranges.

mod common;

mod wire_tests {
    use sha2::{Digest, Sha256};
    use trommi_hub::wire::*;

    fn header(kind: u8, subject: Subject) -> Header {
        Header {
            kind,
            flags: 1,
            group_id: vec![7; 48],
            epoch: 3,
            sender: [1; 32],
            seq: 9,
            prev: [2; 32],
            recipient: ZERO32,
            time: 1_700_000_000_000,
            subject,
            file_ids: vec![[5; 16], [6; 16]],
        }
    }

    #[test]
    fn vectors_of_every_length_class_round_trip() {
        for n in [0usize, 1, 63, 64, 65, 16383, 16384, 70000] {
            let mut w = Writer::default();
            w.vec(&vec![0xab; n]);
            let mut r = Reader::new(&w.0);
            assert_eq!(r.vec().unwrap().len(), n);
            r.end().unwrap();
        }
    }

    #[test]
    fn a_length_prefix_longer_than_needed_is_refused() {
        // 5 encoded in two bytes
        assert!(Reader::new(&[0x40, 0x05, 1, 2, 3, 4, 5]).vec().is_err());
        // 5 encoded in four bytes
        assert!(Reader::new(&[0x80, 0, 0, 5, 1, 2, 3, 4, 5]).vec().is_err());
        assert!(Reader::new(&[0xc0, 0, 0, 0, 0, 0, 0, 5]).vec().is_err());
    }

    #[test]
    fn headers_of_every_shape_round_trip() {
        let shapes = [
            header(
                KIND_ITEM,
                Subject::Item {
                    timeline_kind: 1,
                    timeline_scope: 2,
                    timeline_ref: [3; 16],
                },
            ),
            header(
                KIND_REGISTER,
                Subject::Register {
                    register_id: [4; 16],
                },
            ),
            header(
                KIND_ANSWER,
                Subject::Object {
                    object_id: [8; 16],
                    object_type: 1,
                    object_state: 2,
                    urgency: 3,
                    answered_at: 5,
                    object_ref: [9; 32],
                },
            ),
        ];
        for h in shapes {
            assert_eq!(Header::parse(&h.encode()).unwrap(), h);
        }
    }

    #[test]
    fn header_values_out_of_range_are_refused() {
        let good = header(
            KIND_ITEM,
            Subject::Item {
                timeline_kind: 1,
                timeline_scope: 2,
                timeline_ref: [3; 16],
            },
        );
        let mut reserved_kind = good.encode();
        reserved_kind[1] = 8;
        assert_eq!(
            Header::parse(&reserved_kind),
            Err(HeaderError::Malformed("kind"))
        );
        let mut flags = good.encode();
        flags[2] = 3;
        assert_eq!(Header::parse(&flags), Err(HeaderError::Malformed("flags")));
        let mut newer = good.encode();
        newer[0] = 3;
        assert_eq!(Header::parse(&newer), Err(HeaderError::NewerVersion));
        let board_in_a_session = header(
            KIND_ITEM,
            Subject::Item {
                timeline_kind: 2,
                timeline_scope: 2,
                timeline_ref: [3; 16],
            },
        );
        assert_eq!(
            Header::parse(&board_in_a_session.encode()),
            Err(HeaderError::Malformed("timeline"))
        );
        let mut trailing = good.encode();
        trailing.push(0);
        assert!(Header::parse(&trailing).is_err());
    }

    #[test]
    fn a_pruned_envelope_has_the_hash_of_the_full_one() {
        let h = header(
            KIND_REGISTER,
            Subject::Register {
                register_id: [4; 16],
            },
        )
        .encode();
        let body = vec![0x55; 272];
        let body_hash: [u8; 32] = Sha256::digest(&body).into();
        let full = Envelope::parse(&encode_envelope(
            &h,
            &[1; 12],
            Some(&body),
            &body_hash,
            &[9; 64],
        ))
        .unwrap();
        let pruned =
            Envelope::parse(&encode_envelope(&h, &[1; 12], None, &body_hash, &[9; 64])).unwrap();
        assert!(full.body.is_some() && pruned.body.is_none());
        assert_eq!(full.hash(), pruned.hash());
    }

    #[test]
    fn notes_and_room_statements_round_trip_and_keep_their_order_rules() {
        let note = CommitNote {
            room_epoch: 4,
            room_state: [1; 32],
            time: 77,
            cuts: vec![
                Cut {
                    device: [1; 32],
                    seq: 3,
                    hash: [2; 32],
                },
                Cut {
                    device: [2; 32],
                    seq: 0,
                    hash: ZERO32,
                },
            ],
            join: true,
        };
        assert_eq!(CommitNote::parse(&note.encode()).unwrap(), note);
        let mut unordered = note.clone();
        unordered.cuts.reverse();
        assert!(CommitNote::parse(&unordered.encode()).is_err());

        let room = TrommiRoom {
            recovery_signature_key: vec![1; 32],
            recovery_hpke_key: vec![2; 32],
            agents: vec![[1; 32], [2; 32]],
        };
        assert_eq!(TrommiRoom::parse(&room.encode()).unwrap(), room);
        let twice = TrommiRoom {
            agents: vec![[1; 32], [1; 32]],
            ..room.clone()
        };
        assert!(TrommiRoom::parse(&twice.encode()).is_err());
    }
}

mod config_tests {
    use std::collections::HashMap;
    use trommi_hub::config::*;

    #[test]
    fn only_canonical_hub_addresses_pass() {
        for good in [
            "https://hub.trommi.com",
            "https://hub.example.org:8443",
            "http://localhost:8790",
            "http://127.0.0.1",
        ] {
            assert!(canonical_address(good), "{good}");
        }
        for bad in [
            "https://Hub.trommi.com",
            "https://hub.trommi.com/",
            "http://hub.trommi.com",
            "https://hub.trommi.com:0443",
            "https://hub..com",
            "https://-a.com",
            "ftp://x",
            "https://",
            "https://hub.trommi.com:",
        ] {
            assert!(!canonical_address(bad), "{bad}");
        }
    }

    #[test]
    fn empty_or_broken_numbers_mean_the_default() {
        let env = HashMap::from([
            ("HUB_LIMIT_JSON".to_string(), "".to_string()),
            ("HUB_PORT".to_string(), "x".to_string()),
        ]);
        let c = Config::from_map(&env);
        assert_eq!(
            (c.json_limit, c.port, c.share_days, c.retention_days),
            (1 << 20, 8790, 180, 30)
        );
    }
}

mod db_tests {
    use trommi_hub::db::*;

    #[test]
    fn the_schema_loads_and_names_no_key_column() {
        let dir = std::env::temp_dir().join(format!(
            "trommi-hub-schema-{}",
            trommi_hub::util::hex(&trommi_hub::util::random::<8>())
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(&dir.join("hub.db")).unwrap();
        let tables: Vec<String> = db
            .read(|c| {
                let mut s =
                    c.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")?;
                let rows = s
                    .query_map([], |r| r.get(0))?
                    .collect::<rusqlite::Result<Vec<String>>>()?;
                Ok::<_, rusqlite::Error>(rows)
            })
            .unwrap();
        for wanted in [
            "accounts",
            "passkeys",
            "account_rooms",
            "rooms",
            "devices",
            "key_packages",
            "groups",
            "group_log",
            "group_infos",
            "welcomes",
            "sealed_keys",
            "recovery_links",
            "envelopes",
            "cards",
            "notes",
            "permission_requests",
            "artifacts",
            "chats",
            "boards",
            "registers",
            "files",
            "shares",
            "invites",
            "invite_requests",
            "requests",
            "push_subscriptions",
            "live_activities",
            "agent_leases",
        ] {
            assert!(tables.iter().any(|t| t == wanted), "table {wanted}");
        }
        // opening it again keeps it
        drop(db);
        Db::open(&dir.join("hub.db")).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }
}

mod rules_tests {
    use trommi_hub::error::Res;
    use trommi_hub::observer::{Added, Snapshot};
    use trommi_hub::observer::{By, CommitFacts, Device};
    use trommi_hub::rules::*;
    use trommi_hub::wire::{CommitNote, TrommiRoom};

    fn d(n: u8) -> Device {
        [n; 32]
    }

    fn room(humans: &[u8], agents: &[u8], revoked: &[u8]) -> RoomView {
        RoomView {
            epoch: 5,
            state: [9; 32],
            humans: humans.iter().map(|n| d(*n)).collect(),
            agents: agents.iter().map(|n| d(*n)).collect(),
            revoked: revoked.iter().map(|n| d(*n)).collect(),
        }
    }

    fn snap(leaves: &[u8], agents: Option<&[u8]>) -> Snapshot {
        Snapshot {
            group_id: vec![0; 32],
            epoch: 0,
            leaves: leaves.iter().map(|n| d(*n)).collect(),
            room: agents.map(|a| TrommiRoom {
                recovery_signature_key: vec![200; 32],
                recovery_hpke_key: vec![201; 32],
                agents: a.iter().map(|n| d(*n)).collect(),
            }),
            session: None,
            context: vec![],
            confirmation_tag: vec![],
        }
    }

    fn facts(by: By, before: &[u8], adds: &[u8], removes: &[u8]) -> CommitFacts {
        let mut after: Vec<u8> = before
            .iter()
            .copied()
            .filter(|n| !removes.contains(n))
            .collect();
        after.extend(adds);
        if let By::External(j) = &by {
            after.push(j[0]);
        }
        CommitFacts {
            by,
            adds: adds
                .iter()
                .map(|n| Added {
                    device: d(*n),
                    key_package_ref: vec![*n],
                })
                .collect(),
            removes: removes.iter().map(|n| d(*n)).collect(),
            changes_extensions: false,
            has_path: true,
            aad: vec![],
            before: snap(before, None),
            after: snap(&after, None),
        }
    }

    fn code<T: std::fmt::Debug>(r: Res<T>) -> &'static str {
        r.unwrap_err().code
    }

    const MAIN: SessionKind = SessionKind::Main;

    #[test]
    fn a_human_device_founds_a_main_session_with_every_human_and_one_agent() {
        let r = room(&[1, 2, 3], &[10, 11], &[]);
        check_session_commit(
            MAIN,
            &r,
            &facts(By::Member(d(1)), &[1], &[2, 3, 10], &[]),
            true,
            false,
            false,
        )
        .unwrap();
        // a human device is never left out
        assert_eq!(
            code(check_session_commit(
                MAIN,
                &r,
                &facts(By::Member(d(1)), &[1], &[2, 10], &[]),
                true,
                false,
                false
            )),
            "bad-commit"
        );
        // two agent leaves
        assert_eq!(
            code(check_session_commit(
                MAIN,
                &r,
                &facts(By::Member(d(1)), &[1], &[2, 3, 10, 11], &[]),
                true,
                false,
                false
            )),
            "bad-commit"
        );
        // a key the room does not know
        assert_eq!(
            code(check_session_commit(
                MAIN,
                &r,
                &facts(By::Member(d(1)), &[1], &[2, 3, 77], &[]),
                true,
                false,
                false
            )),
            "bad-commit"
        );
    }

    #[test]
    fn an_agent_commits_nothing_in_a_main_session_and_a_helper_device_nowhere() {
        let r = room(&[1], &[10], &[]);
        assert_eq!(
            code(check_session_commit(
                MAIN,
                &r,
                &facts(By::Member(d(10)), &[1, 10], &[], &[]),
                false,
                false,
                false
            )),
            "bad-commit"
        );
        let helper = SessionKind::Helper {
            opener: Some(d(10)),
        };
        assert_eq!(
            code(check_session_commit(
                helper,
                &r,
                &facts(By::Member(d(50)), &[1, 10, 50], &[], &[]),
                false,
                false,
                false
            )),
            "bad-commit"
        );
    }

    #[test]
    fn the_opener_adds_and_removes_helper_devices_only() {
        let r = room(&[1, 2], &[10, 11], &[]);
        let helper = SessionKind::Helper {
            opener: Some(d(10)),
        };
        // founding: every human, and helper devices
        check_session_commit(
            helper,
            &r,
            &facts(By::Member(d(10)), &[10], &[1, 2, 50], &[]),
            true,
            false,
            false,
        )
        .unwrap();
        assert_eq!(
            code(check_session_commit(
                helper,
                &r,
                &facts(By::Member(d(10)), &[10], &[1, 50], &[]),
                true,
                false,
                false
            )),
            "bad-commit"
        );
        // later: helper devices in and out
        check_session_commit(
            helper,
            &r,
            &facts(By::Member(d(10)), &[1, 2, 10, 50], &[51], &[50]),
            false,
            false,
            false,
        )
        .unwrap();
        // not a human device, in or out
        assert_eq!(
            code(check_session_commit(
                helper,
                &r,
                &facts(By::Member(d(10)), &[1, 10], &[2], &[]),
                false,
                false,
                false
            )),
            "bad-commit"
        );
        assert_eq!(
            code(check_session_commit(
                helper,
                &r,
                &facts(By::Member(d(10)), &[1, 2, 10], &[], &[2]),
                false,
                false,
                false
            )),
            "bad-commit"
        );
        // not another agent device
        assert_eq!(
            code(check_session_commit(
                helper,
                &r,
                &facts(By::Member(d(10)), &[1, 2, 10], &[11], &[]),
                false,
                false,
                false
            )),
            "bad-commit"
        );
        // an agent that is not the opener commits nothing
        assert_eq!(
            code(check_session_commit(
                helper,
                &r,
                &facts(By::Member(d(11)), &[1, 2, 11], &[50], &[]),
                false,
                false,
                false
            )),
            "bad-commit"
        );
        // at most seven helper devices
        let many = facts(
            By::Member(d(10)),
            &[1, 2, 10, 50, 51, 52, 53, 54, 55, 56],
            &[57],
            &[],
        );
        assert_eq!(
            code(check_session_commit(helper, &r, &many, false, false, false)),
            "bad-commit"
        );
    }

    #[test]
    fn a_stale_group_takes_only_the_commit_that_repairs_it() {
        // 9 was a human device and is revoked
        let r = room(&[1, 2], &[10], &[9]);
        assert_eq!(offending_leaves(MAIN, &r, &[d(1), d(9), d(10)]), vec![d(9)]);
        // an own-leaf update that leaves the revoked leaf in
        assert_eq!(
            code(check_session_commit(
                MAIN,
                &r,
                &facts(By::Member(d(1)), &[1, 9, 10], &[], &[]),
                false,
                true,
                false
            )),
            "stale-session"
        );
        // the Remove
        check_session_commit(
            MAIN,
            &r,
            &facts(By::Member(d(1)), &[1, 9, 10], &[], &[9]),
            false,
            true,
            false,
        )
        .unwrap();
        // a helper session whose opener leaf is no longer the main session's agent leaf
        let helper = SessionKind::Helper {
            opener: Some(d(11)),
        };
        let r = room(&[1], &[10, 11], &[]);
        assert_eq!(
            offending_leaves(helper, &r, &[d(1), d(10), d(50)]),
            vec![d(10)]
        );
        // the takeover's step in the helper session: old opener out, new one in
        check_session_commit(
            helper,
            &r,
            &facts(By::Member(d(1)), &[1, 10, 50], &[11], &[10]),
            false,
            true,
            false,
        )
        .unwrap();
        // the old opener cannot repair it by itself, nor go on
        assert_eq!(
            code(check_session_commit(
                helper,
                &r,
                &facts(By::Member(d(10)), &[1, 10, 50], &[51], &[]),
                false,
                true,
                false
            )),
            "bad-commit"
        );
        // while the main session has no agent leaf: no opener, only human devices commit
        let waiting = SessionKind::Helper { opener: None };
        assert_eq!(
            offending_leaves(waiting, &r, &[d(1), d(10), d(50)]),
            vec![d(10)]
        );
        check_session_commit(
            waiting,
            &r,
            &facts(By::Member(d(1)), &[1, 10, 50], &[], &[10]),
            false,
            true,
            false,
        )
        .unwrap();
    }

    #[test]
    fn only_a_human_device_joins_a_session_from_outside_and_may_enter_a_stale_group() {
        let r = room(&[1, 2], &[10], &[9]);
        check_session_commit(
            MAIN,
            &r,
            &facts(By::External(d(2)), &[1, 9, 10], &[], &[]),
            false,
            true,
            false,
        )
        .unwrap();
        assert_eq!(
            code(check_session_commit(
                MAIN,
                &r,
                &facts(By::External(d(10)), &[1], &[], &[]),
                false,
                false,
                false
            )),
            "bad-commit"
        );
        assert_eq!(
            code(check_session_commit(
                MAIN,
                &r,
                &facts(By::External(d(77)), &[1], &[], &[]),
                false,
                false,
                false
            )),
            "bad-commit"
        );
        assert_eq!(
            code(check_session_commit(
                MAIN,
                &r,
                &facts(By::External(d(9)), &[1], &[], &[]),
                false,
                false,
                false
            )),
            "bad-commit"
        );
    }

    fn room_facts(
        by: By,
        before: &[u8],
        adds: &[u8],
        removes: &[u8],
        agents_before: &[u8],
        agents_after: &[u8],
    ) -> CommitFacts {
        let mut f = facts(by, before, adds, removes);
        f.before.room = snap(&[], Some(agents_before)).room;
        f.after.room = snap(&[], Some(agents_after)).room;
        f.changes_extensions = agents_before != agents_after;
        f
    }

    #[test]
    fn the_room_group_takes_one_new_human_device_removals_and_agent_changes() {
        let r = room(&[1, 2], &[10], &[9]);
        let c = check_room_commit(
            &r,
            &room_facts(By::Member(d(1)), &[1, 2], &[3], &[], &[10], &[10]),
            32,
            256,
        )
        .unwrap();
        assert_eq!(c.humans_added, vec![d(3)]);
        let c = check_room_commit(
            &r,
            &room_facts(By::Member(d(1)), &[1, 2], &[], &[2], &[10], &[11]),
            32,
            256,
        )
        .unwrap();
        assert_eq!(
            (c.humans_removed, c.agents_added, c.agents_removed),
            (vec![d(2)], vec![d(11)], vec![d(10)])
        );
        // two Adds
        assert_eq!(
            code(check_room_commit(
                &r,
                &room_facts(By::Member(d(1)), &[1, 2], &[3, 4], &[], &[10], &[10]),
                32,
                256
            )),
            "bad-commit"
        );
        // a returning key, as human device and as agent device
        assert_eq!(
            code(check_room_commit(
                &r,
                &room_facts(By::Member(d(1)), &[1, 2], &[9], &[], &[10], &[10]),
                32,
                256
            )),
            "bad-commit"
        );
        assert_eq!(
            code(check_room_commit(
                &r,
                &room_facts(By::Member(d(1)), &[1, 2], &[], &[], &[10], &[9, 10]),
                32,
                256
            )),
            "bad-commit"
        );
        // an agent device as human device; a human device as agent device
        assert_eq!(
            code(check_room_commit(
                &r,
                &room_facts(By::Member(d(1)), &[1, 2], &[10], &[], &[10], &[10]),
                32,
                256
            )),
            "bad-commit"
        );
        assert_eq!(
            code(check_room_commit(
                &r,
                &room_facts(By::Member(d(1)), &[1, 2], &[], &[], &[10], &[2, 10]),
                32,
                256
            )),
            "bad-commit"
        );
        // the limit of human devices
        assert_eq!(
            code(check_room_commit(
                &r,
                &room_facts(By::Member(d(1)), &[1, 2], &[3], &[], &[10], &[10]),
                2,
                256
            )),
            "too-many"
        );
    }

    #[test]
    fn the_note_names_the_current_room_state_and_one_cut_per_removed_device() {
        use trommi_hub::wire::{Cut, ZERO32};
        let f = facts(By::Member(d(1)), &[1, 2, 3], &[], &[3, 2]);
        let cut = |n: u8| Cut {
            device: d(n),
            seq: 0,
            hash: ZERO32,
        };
        let note = CommitNote {
            room_epoch: 5,
            room_state: [9; 32],
            time: 1,
            cuts: vec![cut(2), cut(3)],
            join: false,
        };
        check_note(&note, 5, &[9; 32], &f).unwrap();
        assert_eq!(code(check_note(&note, 6, &[9; 32], &f)), "room-behind");
        assert_eq!(code(check_note(&note, 4, &[9; 32], &f)), "bad-commit");
        assert_eq!(code(check_note(&note, 5, &[8; 32], &f)), "bad-commit");
        let missing = CommitNote {
            cuts: vec![cut(2)],
            ..note.clone()
        };
        assert_eq!(code(check_note(&missing, 5, &[9; 32], &f)), "bad-commit");
        let join = CommitNote { join: true, ..note };
        assert_eq!(code(check_note(&join, 5, &[9; 32], &f)), "bad-commit");
    }
}

mod content_tests {
    use trommi_hub::content::*;
    use trommi_hub::wire::*;

    fn header(
        kind: u8,
        sender: u8,
        seq: u64,
        object_id: [u8; 16],
        object_type: u8,
        object_state: u8,
        object_ref: [u8; 32],
    ) -> Header {
        Header {
            kind,
            flags: 0,
            group_id: vec![7; 48],
            epoch: 1,
            sender: [sender; 32],
            seq,
            prev: ZERO32,
            recipient: ZERO32,
            time: 0,
            subject: Subject::Object {
                object_id,
                object_type,
                object_state,
                urgency: 2,
                answered_at: 9,
                object_ref,
            },
            file_ids: vec![],
        }
    }

    #[test]
    fn a_card_is_opened_answered_taken_back_closed_and_reopened() {
        let id = object_id(&[7; 48], &[1; 32], 1);
        let v1 = step(
            None,
            &header(KIND_VERSION, 1, 1, id, TYPE_CARD, STATE_OPEN, ZERO32),
            &[11; 32],
            1,
            100,
        )
        .unwrap();
        assert_eq!(
            (v1.state, v1.owner, v1.version_hash, v1.settled_at),
            (STATE_OPEN, [1; 32], [11; 32], None)
        );
        // an answer must name the current version
        assert!(step(
            Some(&v1),
            &header(KIND_ANSWER, 2, 1, id, TYPE_CARD, STATE_ANSWERED, [99; 32]),
            &[12; 32],
            2,
            200
        )
        .is_err());
        let answered = step(
            Some(&v1),
            &header(KIND_ANSWER, 2, 1, id, TYPE_CARD, STATE_ANSWERED, [11; 32]),
            &[12; 32],
            2,
            200,
        )
        .unwrap();
        assert_eq!(
            (answered.state, answered.settled_at, answered.version_hash),
            (STATE_ANSWERED, Some(200), [11; 32])
        );
        // a second answer: the card is not open
        assert!(step(
            Some(&answered),
            &header(KIND_ANSWER, 2, 2, id, TYPE_CARD, STATE_ANSWERED, [11; 32]),
            &[13; 32],
            3,
            300
        )
        .is_err());
        let open = step(
            Some(&answered),
            &header(KIND_TAKE_BACK, 2, 2, id, TYPE_CARD, STATE_OPEN, [11; 32]),
            &[13; 32],
            3,
            300,
        )
        .unwrap();
        assert_eq!((open.state, open.settled_at), (STATE_OPEN, None));
        // a take back of an open card
        assert!(step(
            Some(&open),
            &header(KIND_TAKE_BACK, 2, 3, id, TYPE_CARD, STATE_OPEN, [11; 32]),
            &[14; 32],
            4,
            400
        )
        .is_err());
        let closed = step(
            Some(&open),
            &header(KIND_VERSION, 1, 2, id, TYPE_CARD, STATE_CLOSED, [11; 32]),
            &[15; 32],
            5,
            500,
        )
        .unwrap();
        assert_eq!(
            (closed.state, closed.closed_at, closed.version_hash),
            (STATE_CLOSED, Some(500), [15; 32])
        );
        // a later version of an old version
        assert!(step(
            Some(&closed),
            &header(KIND_VERSION, 1, 3, id, TYPE_CARD, STATE_OPEN, [11; 32]),
            &[16; 32],
            6,
            600
        )
        .is_err());
        let again = step(
            Some(&closed),
            &header(KIND_VERSION, 1, 3, id, TYPE_CARD, STATE_OPEN, [15; 32]),
            &[16; 32],
            6,
            600,
        )
        .unwrap();
        assert_eq!(
            (again.state, again.settled_at, again.closed_at),
            (STATE_OPEN, None, None)
        );
    }

    #[test]
    fn a_first_version_carries_its_derived_id_and_begins_open() {
        let id = object_id(&[7; 48], &[1; 32], 4);
        assert!(step(
            None,
            &header(KIND_VERSION, 1, 4, id, TYPE_CARD, STATE_OPEN, ZERO32),
            &[1; 32],
            1,
            1
        )
        .is_ok());
        assert!(step(
            None,
            &header(KIND_VERSION, 1, 5, id, TYPE_CARD, STATE_OPEN, ZERO32),
            &[1; 32],
            1,
            1
        )
        .is_err());
        assert!(step(
            None,
            &header(KIND_VERSION, 2, 4, id, TYPE_CARD, STATE_OPEN, ZERO32),
            &[1; 32],
            1,
            1
        )
        .is_err());
        assert!(step(
            None,
            &header(KIND_VERSION, 1, 4, id, TYPE_CARD, STATE_CLOSED, ZERO32),
            &[1; 32],
            1,
            1
        )
        .is_err());
        // a permission request is kind request, a card is not
        assert!(step(
            None,
            &header(KIND_VERSION, 1, 4, id, TYPE_REQUEST, STATE_OPEN, ZERO32),
            &[1; 32],
            1,
            1
        )
        .is_err());
        assert!(step(
            None,
            &header(KIND_REQUEST, 1, 4, id, TYPE_CARD, STATE_OPEN, ZERO32),
            &[1; 32],
            1,
            1
        )
        .is_err());
        // an answer to nothing
        assert!(step(
            None,
            &header(KIND_ANSWER, 2, 1, id, TYPE_CARD, STATE_ANSWERED, [1; 32]),
            &[2; 32],
            2,
            2
        )
        .is_err());
    }

    #[test]
    fn a_verdict_closes_an_open_permission_request_once() {
        let id = object_id(&[7; 48], &[1; 32], 1);
        let request = step(
            None,
            &header(KIND_REQUEST, 1, 1, id, TYPE_REQUEST, STATE_OPEN, ZERO32),
            &[21; 32],
            1,
            10,
        )
        .unwrap();
        assert!(step(
            Some(&request),
            &header(
                KIND_ANSWER,
                2,
                1,
                id,
                TYPE_REQUEST,
                STATE_ANSWERED,
                [21; 32]
            ),
            &[22; 32],
            2,
            20
        )
        .is_err());
        assert!(step(
            Some(&request),
            &header(KIND_VERSION, 1, 2, id, TYPE_REQUEST, STATE_OPEN, [21; 32]),
            &[22; 32],
            2,
            20
        )
        .is_err());
        let closed = step(
            Some(&request),
            &header(KIND_VERDICT, 2, 1, id, TYPE_REQUEST, STATE_CLOSED, [21; 32]),
            &[22; 32],
            2,
            20,
        )
        .unwrap();
        assert_eq!((closed.state, closed.settled_at), (STATE_CLOSED, Some(20)));
        assert!(step(
            Some(&closed),
            &header(KIND_VERDICT, 2, 2, id, TYPE_REQUEST, STATE_CLOSED, [21; 32]),
            &[23; 32],
            3,
            30
        )
        .is_err());
    }

    #[test]
    fn a_note_takes_any_version_and_is_never_due_for_pruning() {
        let id = object_id(&[7; 48], &[1; 32], 1);
        let mut h = header(KIND_VERSION, 1, 1, id, TYPE_NOTE, STATE_OPEN, ZERO32);
        let note = step(None, &h, &[31; 32], 1, 10).unwrap();
        // another human device writes on an older version: taken, newest by arrival
        h = header(KIND_VERSION, 2, 1, id, TYPE_NOTE, STATE_CLOSED, [77; 32]);
        let next = step(Some(&note), &h, &[32; 32], 2, 20).unwrap();
        assert_eq!(
            (next.version_hash, next.state, next.settled_at),
            ([32; 32], STATE_CLOSED, None)
        );
    }
}

mod limits_tests {
    use trommi_hub::limits::*;

    #[test]
    fn a_bucket_gives_its_burst_then_its_rate() {
        let b = Buckets::new(50.0, 200.0);
        for _ in 0..200 {
            b.take(b"d", 1.0, 1_000).unwrap();
        }
        assert_eq!(b.take(b"d", 1.0, 1_000), Err(1));
        // 100 ms later: five more
        for _ in 0..5 {
            b.take(b"d", 1.0, 1_100).unwrap();
        }
        assert!(b.take(b"d", 1.0, 1_100).is_err());
        // another key is not touched
        b.take(b"e", 1.0, 1_100).unwrap();
    }

    #[test]
    fn a_window_counts_hits_within_its_span() {
        let w = Window::new(3, 60_000);
        for t in [0, 1_000, 2_000] {
            w.check(b"ip", t, true).unwrap();
        }
        assert_eq!(w.check(b"ip", 3_000, true), Err(57));
        w.check(b"ip", 60_000, true).unwrap();
        w.clear(b"ip");
        w.check(b"ip", 60_001, true).unwrap();
    }
}

mod live_tests {
    use serde_json::json;
    use tokio::sync::mpsc;
    use trommi_hub::live::*;
    use trommi_hub::observer::Device;
    use trommi_hub::store::{Audience, Auth, Event, Who};

    fn auth(device: u8, who: Who) -> Auth {
        Auth {
            room: [1; 32],
            device: [device; 32],
            who,
        }
    }

    fn drain(rx: &mut mpsc::UnboundedReceiver<Msg>) -> Vec<String> {
        let mut out = vec![];
        while let Ok(m) = rx.try_recv() {
            match m {
                Msg::Chunk(b) => out.push(String::from_utf8(b.to_vec()).unwrap()),
                Msg::End => out.push("END".into()),
            }
        }
        out
    }

    fn event(
        change: Option<i64>,
        humans: bool,
        others: Vec<Device>,
        except: Option<Device>,
    ) -> Event {
        Event {
            room: [1; 32],
            audience: Audience {
                humans,
                others,
                except,
            },
            name: "envelope",
            change,
            data: json!({}),
        }
    }

    #[test]
    fn events_reach_only_their_audience() {
        let live = Live::default();
        let (h, mut hrx) = live.open(auth(1, Who::Human), 8, 1 << 20).unwrap();
        let (a, mut arx) = live.open(auth(2, Who::Agent), 8, 1 << 20).unwrap();
        let (r, mut rrx) = live.open(auth(3, Who::Recovery), 8, 1 << 20).unwrap();
        for s in [&h, &a, &r] {
            s.go_live(0);
        }
        let e1 = event(Some(5), true, vec![], None);
        live.publish(&e1, &json!({ "n": 1 }));
        let e2 = event(Some(6), true, vec![[2; 32]], Some([1; 32]));
        live.publish(&e2, &json!({ "n": 2 }));
        assert_eq!(
            drain(&mut hrx),
            vec!["id: 5\nevent: envelope\ndata: {\"n\":1}\n\n"]
        );
        assert_eq!(
            drain(&mut arx),
            vec!["id: 6\nevent: envelope\ndata: {\"n\":2}\n\n"]
        );
        assert!(drain(&mut rrx).is_empty());
        // another room hears nothing
        let other = Event {
            room: [9; 32],
            ..e1
        };
        assert!(!live.has_audience(&other));
    }

    #[test]
    fn what_arrives_during_the_catch_up_follows_it_once() {
        let live = Live::default();
        let (s, mut rx) = live.open(auth(1, Who::Human), 8, 1 << 20).unwrap();
        live.publish(&event(Some(7), true, vec![], None), &json!({ "n": 7 }));
        live.publish(&event(Some(9), true, vec![], None), &json!({ "n": 9 }));
        live.publish(&event(None, true, vec![], None), &json!({ "relay": true }));
        assert!(drain(&mut rx).is_empty());
        // the catch-up itself sent everything up to 8
        s.go_live(8);
        let got = drain(&mut rx);
        assert_eq!(got.len(), 2);
        assert!(got[0].contains("\"n\":9") && got[1].contains("relay"));
    }

    #[test]
    fn a_device_has_a_limit_of_streams_and_a_slow_reader_is_cut() {
        let live = Live::default();
        let mut keep = vec![];
        for _ in 0..2 {
            keep.push(live.open(auth(1, Who::Human), 2, 64).unwrap());
        }
        assert!(live.open(auth(1, Who::Human), 2, 64).is_none());
        assert!(live.open(auth(2, Who::Human), 2, 64).is_some());
        let (s, rx) = &mut keep[0];
        s.go_live(0);
        live.publish(
            &event(Some(1), true, vec![], None),
            &json!({ "pad": "x".repeat(100) }),
        );
        assert_eq!(drain(rx), vec!["END"]);
        live.end_where(&[1; 32], |a| a.device == [1; 32]);
        // the second stream was still catching up: it overflowed its waiting room, and is ended again by name
        assert!(drain(&mut keep[1].1).iter().all(|m| m == "END"));
    }
}

mod http_tests {
    use trommi_hub::http::*;

    #[test]
    fn ranges_are_single_and_within_the_file() {
        assert_eq!(range(None, 100), Ok(None));
        assert_eq!(range(Some("bytes=0-9"), 100), Ok(Some((0, 9))));
        assert_eq!(range(Some("bytes=90-"), 100), Ok(Some((90, 99))));
        assert_eq!(range(Some("bytes=-10"), 100), Ok(Some((90, 99))));
        assert_eq!(range(Some("bytes=50-500"), 100), Ok(Some((50, 99))));
        for bad in [
            "bytes=100-",
            "bytes=9-1",
            "bytes=0-1,5-6",
            "bytes=-",
            "bytes=-0",
            "items=0-1",
            "bytes=a-b",
            "bytes=99999999999999999999-",
        ] {
            assert_eq!(range(Some(bad), 100), Err(()), "{bad}");
        }
        assert_eq!(range(Some("bytes=0-"), 0), Err(()));
    }

    #[test]
    fn query_strings_split_into_pairs() {
        assert_eq!(
            query(Some("after=5&limit=10&x")),
            vec![
                ("after".into(), "5".into()),
                ("limit".into(), "10".into()),
                ("x".into(), "".into())
            ]
        );
        assert!(query(None).is_empty());
    }
}

mod push_tests {
    use aes_gcm::aead::{Aead, KeyInit};
    use aes_gcm::Aes128Gcm;
    use p256::ecdsa::signature::Verifier;
    use p256::ecdsa::Signature;
    use p256::ecdsa::VerifyingKey;
    use p256::elliptic_curve::sec1::ToEncodedPoint;
    use p256::PublicKey;
    use serde_json::{json, Value};
    use trommi_hub::push::*;
    use trommi_hub::util::{b64, unb64};

    fn verify_jwt(token: &str, public: &[u8]) -> Value {
        let parts: Vec<&str> = token.split('.').collect();
        assert_eq!(parts.len(), 3);
        let key = VerifyingKey::from_sec1_bytes(public).unwrap();
        let signature = Signature::from_slice(&unb64(parts[2]).unwrap()).unwrap();
        key.verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &signature)
            .unwrap();
        serde_json::from_slice(&unb64(parts[1]).unwrap()).unwrap()
    }

    /// The browser's side of RFC 8291.
    fn browser_open(secret: &p256::SecretKey, auth: &[u8], body: &[u8]) -> Vec<u8> {
        let (salt, rest) = body.split_at(16);
        assert_eq!(&rest[..4], &4096u32.to_be_bytes());
        let key_len = rest[4] as usize;
        let sender = &rest[5..5 + key_len];
        let sealed = &rest[5 + key_len..];
        let shared = p256::ecdh::diffie_hellman(
            secret.to_nonzero_scalar(),
            PublicKey::from_sec1_bytes(sender).unwrap().as_affine(),
        );
        let mine = secret.public_key().to_encoded_point(false);
        let mut info = b"WebPush: info\0".to_vec();
        info.extend_from_slice(mine.as_bytes());
        info.extend_from_slice(sender);
        let ikm = hkdf(auth, shared.raw_secret_bytes(), &info, 32);
        let cek = hkdf(salt, &ikm, b"Content-Encoding: aes128gcm\0", 16);
        let nonce = hkdf(salt, &ikm, b"Content-Encoding: nonce\0", 12);
        let mut plain = Aes128Gcm::new_from_slice(&cek)
            .unwrap()
            .decrypt(nonce.as_slice().into(), sealed)
            .unwrap();
        while plain.last() == Some(&0) {
            plain.pop();
        }
        assert_eq!(plain.pop(), Some(2));
        plain
    }

    #[test]
    fn a_web_push_opens_in_the_browser_and_carries_no_content() {
        let vapid = Vapid::from_secret(&[7; 32], "https://trommi.com").unwrap();
        let secret = p256::SecretKey::random(&mut p256::elliptic_curve::rand_core::OsRng);
        let sub = WebSubscription {
            endpoint: "https://fcm.googleapis.com/fcm/send/abc".into(),
            p256dh: secret
                .public_key()
                .to_encoded_point(false)
                .as_bytes()
                .to_vec(),
            auth: vec![9; 16],
        };
        let r = web_push_request(&vapid, &sub, &[], &[3; 32], 42, 2, 1_700_000_000_000).unwrap();
        assert_eq!(r.url, sub.endpoint);
        let plain: Value =
            serde_json::from_slice(&browser_open(&secret, &sub.auth, &r.body)).unwrap();
        assert_eq!(
            plain,
            json!({ "room_id": b64(&[3; 32]), "change": 42, "urgency": 2 })
        );
        let header = |name: &str| r.headers.iter().find(|(k, _)| k == name).unwrap().1.clone();
        assert_eq!(
            (
                header("urgency").as_str(),
                header("ttl").as_str(),
                header("content-encoding").as_str()
            ),
            ("high", "86400", "aes128gcm")
        );
        let auth = header("authorization");
        let token = auth
            .strip_prefix("vapid t=")
            .unwrap()
            .split(", k=")
            .next()
            .unwrap();
        let claims = verify_jwt(token, &vapid.public);
        assert_eq!(claims["aud"], "https://fcm.googleapis.com");
        assert_eq!(claims["exp"], 1_700_000_000u64 + 12 * 3600);
    }

    #[test]
    fn only_known_push_services_are_called() {
        let extra = vec!["127.0.0.1:9999".to_string()];
        assert_eq!(
            endpoint_origin("https://updates.push.services.mozilla.com/wpush/v2/x", &[]).as_deref(),
            Some("https://updates.push.services.mozilla.com")
        );
        assert_eq!(
            endpoint_origin("http://127.0.0.1:9999/p", &extra).as_deref(),
            Some("http://127.0.0.1:9999")
        );
        for bad in [
            "http://fcm.googleapis.com/x",
            "https://fcm.googleapis.com.evil.example/x",
            "https://evil.example/fcm.googleapis.com",
            "https://user@fcm.googleapis.com/x",
            "https://169.254.169.254/latest",
            "http://127.0.0.1:9998/p",
            "https://notfcm.googleapis.com.example",
            "file:///etc/passwd",
        ] {
            assert_eq!(endpoint_origin(bad, &extra), None, "{bad}");
        }
    }

    fn apns() -> Apns {
        use p256::pkcs8::EncodePrivateKey;
        let secret = p256::SecretKey::random(&mut p256::elliptic_curve::rand_core::OsRng);
        let pem = secret.to_pkcs8_pem(Default::default()).unwrap();
        let hosts = std::collections::HashMap::from([(
            "production".to_string(),
            "https://api.push.apple.com".to_string(),
        )]);
        Apns::new(
            &pem,
            "KEYID12345",
            "TEAMID1234",
            vec!["com.trommi.app".into()],
            hosts,
        )
        .unwrap()
    }

    #[test]
    fn an_apns_alert_has_a_fixed_text_and_a_sealed_number() {
        let a = apns();
        let reg = ApnsRegistration {
            token: "ab".repeat(32),
            key: [5; 32],
            environment: "production".into(),
            topic: "com.trommi.app".into(),
        };
        assert!(a.accepts(&reg.token, "production", "com.trommi.app"));
        assert!(
            !a.accepts(&reg.token, "sandbox", "com.trommi.app")
                && !a.accepts("xyz", "production", "com.trommi.app")
                && !a.accepts(&reg.token, "production", "com.other")
        );
        let r = a
            .alert(
                &reg,
                Text::Urgent,
                &[3; 32],
                77,
                3,
                Some("TICKET"),
                1_700_000_000_000,
            )
            .unwrap();
        assert_eq!(
            r.url,
            format!("https://api.push.apple.com/3/device/{}", reg.token)
        );
        let payload: Value = serde_json::from_slice(&r.body).unwrap();
        assert_eq!(payload["aps"]["alert"]["body"], "Urgent: a new question.");
        assert_eq!(payload["aps"]["mutable-content"], 1);
        let opened: Value = serde_json::from_slice(
            &open_on_phone(&reg.key, &unb64(payload["e"].as_str().unwrap()).unwrap()).unwrap(),
        )
        .unwrap();
        assert_eq!(
            opened,
            json!({ "room_id": b64(&[3; 32]), "change": 77, "urgency": 3, "ticket": "TICKET" })
        );
        assert!(open_on_phone(&[6; 32], &unb64(payload["e"].as_str().unwrap()).unwrap()).is_none());
        let header = |name: &str| r.headers.iter().find(|(k, _)| k == name).unwrap().1.clone();
        assert_eq!(
            (
                header("apns-push-type").as_str(),
                header("apns-priority").as_str(),
                header("apns-topic").as_str()
            ),
            ("alert", "10", "com.trommi.app")
        );
        // the provider token is reused within 40 minutes
        let again = a
            .alert(
                &reg,
                Text::Question,
                &[3; 32],
                78,
                1,
                None,
                1_700_000_060_000,
            )
            .unwrap();
        assert_eq!(again.headers[1], r.headers[1]);
        let later = a
            .alert(
                &reg,
                Text::Question,
                &[3; 32],
                79,
                1,
                None,
                1_700_003_000_000,
            )
            .unwrap();
        assert_ne!(later.headers[1], r.headers[1]);
    }

    #[test]
    fn a_live_activity_push_carries_two_counts() {
        let a = apns();
        let start = a
            .live_activity(
                "production",
                &"cd".repeat(32),
                "com.trommi.app",
                "tag-1",
                "start",
                2,
                1,
                600_000,
                1_700_000_000_000,
            )
            .unwrap();
        let payload: Value = serde_json::from_slice(&start.body).unwrap();
        assert_eq!(
            payload["aps"]["content-state"],
            json!({ "working": 2, "waiting": 1 })
        );
        assert_eq!(payload["aps"]["attributes"], json!({ "tag": "tag-1" }));
        assert_eq!(payload["aps"]["relevance-score"], 100);
        assert!(start
            .headers
            .iter()
            .any(|(k, v)| k == "apns-topic" && v == "com.trommi.app.push-type.liveactivity"));
        let end = a
            .live_activity(
                "production",
                &"cd".repeat(32),
                "com.trommi.app",
                "tag-1",
                "end",
                0,
                0,
                600_000,
                1_700_000_000_000,
            )
            .unwrap();
        let payload: Value = serde_json::from_slice(&end.body).unwrap();
        assert_eq!(payload["aps"]["dismissal-date"], 1_700_000_000u64 + 900);
        assert!(payload["aps"].get("stale-date").is_none());
    }

    #[test]
    fn a_ticket_names_one_envelope_for_a_day() {
        let key = [4; 32];
        let t = ticket(&key, &[1; 32], &[2; 32], 99, 1_000);
        assert_eq!(
            check_ticket(&key, &t, 2_000).unwrap(),
            ([1; 32], [2; 32], 99)
        );
        assert!(check_ticket(&key, &t, 1_000 + TICKET_MS).is_err());
        assert!(check_ticket(&[5; 32], &t, 2_000).is_err());
        let mut forged = unb64(&t).unwrap();
        forged[70] ^= 1;
        assert!(check_ticket(&key, &b64(&forged), 2_000).is_err());
        assert!(check_ticket(&key, "short", 2_000).is_err());
        assert!(
            gone(410, "")
                && gone(400, "BadDeviceToken")
                && !gone(400, "PayloadTooLarge")
                && !gone(201, "")
        );
    }
}

mod webauthn_tests {
    use crate::common::passkey::Authenticator;
    use trommi_hub::webauthn::*;

    const ORIGIN: &str = "https://app.trommi.com";

    #[test]
    fn a_passkey_registers_and_signs_in() {
        let allowed = vec![ORIGIN.to_string()];
        let a = Authenticator::new();
        let client = Authenticator::client_data("webauthn.create", &[1; 32], ORIGIN);
        let (challenge, origin) = client_challenge(&client, "webauthn.create").unwrap();
        assert_eq!(challenge, vec![1; 32]);
        let r = register(&a.attestation("app.trommi.com", 0x05), &origin, &allowed).unwrap();
        assert_eq!(
            (r.credential_id.clone(), r.algorithm, r.sign_count),
            (a.credential_id.clone(), ES256, 7)
        );

        let client = Authenticator::client_data("webauthn.get", &[2; 32], ORIGIN);
        let (data, signature) = a.assertion("app.trommi.com", 0x05, &client);
        assert_eq!(
            assert(&r.public_key, &data, &client, &signature, ORIGIN, &allowed),
            Ok(7)
        );
        // another key, another client data, another signature
        assert_eq!(
            assert(&dummy_key(), &data, &client, &signature, ORIGIN, &allowed),
            Err(Bad("signature"))
        );
        let other = Authenticator::client_data("webauthn.get", &[3; 32], ORIGIN);
        assert_eq!(
            assert(&r.public_key, &data, &other, &signature, ORIGIN, &allowed),
            Err(Bad("signature"))
        );
    }

    #[test]
    fn each_webauthn_check_refuses_with_its_reason() {
        let allowed = vec![ORIGIN.to_string()];
        let a = Authenticator::new();
        let client = Authenticator::client_data("webauthn.get", &[2; 32], ORIGIN);
        assert_eq!(
            client_challenge(&client, "webauthn.create"),
            Err(Bad("type"))
        );
        let crossed = serde_json::json!({ "type": "webauthn.get", "challenge": "AA", "origin": ORIGIN, "crossOrigin": true }).to_string();
        assert_eq!(
            client_challenge(crossed.as_bytes(), "webauthn.get"),
            Err(Bad("cross-origin"))
        );
        assert_eq!(
            client_challenge(b"not json", "webauthn.get"),
            Err(Bad("client-data"))
        );
        // another origin, another relying party, no presence, no verification
        assert_eq!(
            register(
                &a.attestation("app.trommi.com", 0x05),
                "https://evil.example",
                &allowed
            ),
            Err(Bad("origin"))
        );
        assert_eq!(
            register(&a.attestation("evil.example", 0x05), ORIGIN, &allowed),
            Err(Bad("rp-id"))
        );
        assert_eq!(
            register(&a.attestation("app.trommi.com", 0x04), ORIGIN, &allowed),
            Err(Bad("user-present"))
        );
        assert_eq!(
            register(&a.attestation("app.trommi.com", 0x01), ORIGIN, &allowed),
            Err(Bad("user-verified"))
        );
        let mut trailing = a.attestation("app.trommi.com", 0x05);
        trailing.push(0);
        assert_eq!(
            register(&trailing, ORIGIN, &allowed),
            Err(Bad("attestation"))
        );
        // an assertion that carries attested credential data is not an assertion
        let (_, signature) = a.assertion("app.trommi.com", 0x05, &client);
        assert_eq!(
            assert(
                &a.cose(),
                &a.data("app.trommi.com", 0x05, true),
                &client,
                &signature,
                ORIGIN,
                &allowed
            ),
            Err(Bad("authenticator-data"))
        );
    }

    #[test]
    fn the_cbor_reader_refuses_what_it_does_not_need() {
        // indefinite length, nesting too deep, a duplicate key, a huge array
        assert!(cbor(&[0x9f, 0x01, 0xff]).is_err());
        assert!(cbor(&[0x81; 12]).is_err());
        assert!(cbor(&[0xa2, 0x01, 0x02, 0x01, 0x03]).is_err());
        assert!(cbor(&[0x9a, 0xff, 0xff, 0xff, 0xff]).is_err());
        assert_eq!(cbor(&[0x38, 0x18]).unwrap().0, Cbor::Int(-25));
        assert!(
            cose_algorithm(&cose_es256(&[1; 32], &[2; 32])).is_err(),
            "not a point on the curve"
        );
    }
}

mod accounts_tests {
    use serde_json::json;
    use trommi_hub::accounts::*;
    use trommi_hub::util::b64;

    #[test]
    fn e_mail_addresses_are_normalised_or_refused_never_mapped() {
        assert_eq!(
            normalise_email("  Ada@Example.ORG\t").unwrap(),
            "ada@example.org"
        );
        for bad in [
            "",
            "a@b",
            "a@@b.co",
            "a b@c.de",
            "ädä@example.org",
            "a@b.c",
            "@example.org",
            &format!("{}@example.org", "x".repeat(65)),
            "a@.org",
        ] {
            assert_eq!(normalise_email(bad).unwrap_err().code, "bad-email", "{bad}");
        }
    }

    #[test]
    fn the_slow_hash_depends_on_key_and_salt() {
        let a = slow_hash(&[1; 32], &[2; 16]);
        assert_eq!(a, slow_hash(&[1; 32], &[2; 16]));
        assert_ne!(a, slow_hash(&[1; 32], &[3; 16]));
        assert_ne!(a, slow_hash(&[9; 32], &[2; 16]));
    }

    #[test]
    fn a_sealed_copy_of_another_length_or_version_is_refused() {
        let mut copy = vec![2u8; 61];
        assert!(sealed_copy(&json!({ "c": b64(&copy) }), "c").is_ok());
        copy[0] = 1;
        assert!(sealed_copy(&json!({ "c": b64(&copy) }), "c").is_err());
        assert!(sealed_copy(&json!({ "c": b64(&[2u8; 60]) }), "c").is_err());
        assert!(kdf_record(
            &json!({ "kdf": { "alg": "argon2id", "v": 1, "m": 65536, "t": 3, "p": 1, "x": 1 } })
        )
        .is_ok());
        assert!(kdf_record(
            &json!({ "kdf": { "alg": "argon2id", "v": 1, "m": 1024, "t": 3, "p": 1 } })
        )
        .is_err());
    }
}
