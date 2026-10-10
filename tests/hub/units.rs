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
            (1_572_864, 8790, 180, 30)
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

    /// A database the hub wrote before Welcomes had their own ids: the counter starts above every id SQLite can
    /// have given, also one whose row was deleted, so `?after=` never hides a new Welcome.
    #[test]
    fn the_welcome_counter_starts_above_every_id_given_before() {
        let dir = std::env::temp_dir().join(format!(
            "trommi-hub-upgrade-{}",
            trommi_hub::util::hex(&trommi_hub::util::random::<8>())
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("hub.db");
        {
            let c = rusqlite::Connection::open(&path).unwrap();
            // (only the rows this test needs, without the rooms and groups they would hang on)
            c.execute_batch("PRAGMA foreign_keys = OFF;").unwrap();
            c.execute_batch(&format!(
                "BEGIN; {SCHEMA} PRAGMA user_version = {SCHEMA_VERSION}; COMMIT;"
            ))
            .unwrap();
            let room = [1u8; 32];
            let group = [room.to_vec(), vec![2; 16]].concat();
            c.execute(
                "INSERT INTO group_log (group_id, n, room_id, epoch, kind, sender, at, change, digest, bytes)
                 VALUES (?1, 1, ?2, 0, 'commit', x'03', 0, 1, x'04', x'05')",
                rusqlite::params![&group, &room[..]],
            )
            .unwrap();
            for device in [[7u8; 32], [8u8; 32]] {
                c.execute(
                    "INSERT INTO welcomes (room_id, device, group_id, at, bytes) VALUES (?1, ?2, ?3, 0, x'06')",
                    rusqlite::params![&room[..], &device[..], &group],
                )
                .unwrap();
            }
            // the highest id given is gone before the upgrade
            c.execute("DELETE FROM welcomes WHERE id = 2", []).unwrap();
        }
        let db = Db::open(&path).unwrap();
        let last: i64 = db
            .read(|c| c.query_row("SELECT last FROM welcome_ids", [], |r| r.get(0)))
            .unwrap();
        assert!(last >= 1024, "{last}");
        // the old row reads as before, and opening again changes nothing
        let old: Vec<u8> = db
            .read(|c| c.query_row("SELECT bytes FROM welcomes WHERE id = 1", [], |r| r.get(0)))
            .unwrap();
        assert_eq!(old, vec![6]);
        drop(db);
        let db = Db::open(&path).unwrap();
        let again: i64 = db
            .read(|c| c.query_row("SELECT last FROM welcome_ids", [], |r| r.get(0)))
            .unwrap();
        assert_eq!(again, last);
        // a counter an earlier build seeded too low (from the rows left) is raised on the next open
        drop(db);
        rusqlite::Connection::open(&path)
            .unwrap()
            .execute("UPDATE welcome_ids SET last = 1", [])
            .unwrap();
        let db = Db::open(&path).unwrap();
        let raised: i64 = db
            .read(|c| c.query_row("SELECT last FROM welcome_ids", [], |r| r.get(0)))
            .unwrap();
        assert_eq!(raised, last);
        drop(db);
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
        let (h, mut hrx) = live
            .open(auth(1, Who::Human), true, 8, 1 << 20, u64::MAX, None)
            .unwrap();
        let (a, mut arx) = live
            .open(auth(2, Who::Agent), true, 8, 1 << 20, u64::MAX, None)
            .unwrap();
        let (r, mut rrx) = live
            .open(auth(3, Who::Recovery), true, 8, 1 << 20, u64::MAX, None)
            .unwrap();
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
    fn a_stream_whose_token_runs_out_is_cut_even_if_it_had_ended_before() {
        use trommi_hub::http::Conn;
        // a connection serving its first request: the stream
        let conn = Conn::new("127.0.0.1:1".parse().unwrap()).next_request();
        let live = Live::default();
        let (s, mut rx) = live
            .open(
                auth(1, Who::Human),
                true,
                8,
                1 << 20,
                u64::MAX,
                Some(conn.clone()),
            )
            .unwrap();
        s.go_live(0);
        live.publish(&event(Some(1), true, vec![], None), &json!({ "n": 1 }));
        // the stream ends in the ordinary way (its device was removed), with a reader that reads nothing
        s.end();
        assert!(
            !conn.is_cut(),
            "an ordinary end leaves the connection to the reader"
        );
        // its token runs out: the connection is cut all the same
        s.expire();
        assert!(conn.is_cut(), "cut at expiry");
        // and nothing is queued after that
        live.publish(&event(Some(2), true, vec![], None), &json!({ "n": 2 }));
        assert_eq!(drain(&mut rx).len(), 2, "the event from before and the end");

        // A stream that was read to its end leaves its connection to the next request. Its expiry, whenever
        // its timer gets to run, cuts nothing then: a cut is its own request's.
        let conn = Conn::new("127.0.0.1:1".parse().unwrap()).next_request();
        let (s, rx) = live
            .open(
                auth(2, Who::Human),
                true,
                8,
                1 << 20,
                u64::MAX,
                Some(conn.clone()),
            )
            .unwrap();
        s.end();
        let later = conn.next_request();
        s.expire();
        drop(rx);
        s.expire();
        assert!(
            !later.is_cut() && !conn.is_cut(),
            "the later request is not cut"
        );
        // the later request's own cut is obeyed
        later.destroy();
        assert!(later.is_cut());
    }

    #[test]
    fn what_arrives_during_the_catch_up_follows_it_once() {
        let live = Live::default();
        let (s, mut rx) = live
            .open(auth(1, Who::Human), true, 8, 1 << 20, u64::MAX, None)
            .unwrap();
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
    fn a_new_stream_ends_the_older_ones_of_its_device_and_a_slow_reader_is_cut() {
        let live = Live::default();
        let mut keep = vec![];
        for _ in 0..3 {
            keep.push(
                live.open(auth(1, Who::Human), true, 2, 64, u64::MAX, None)
                    .unwrap(),
            );
        }
        // each new one ended those before it, so the limit of two is never reached; another device's stay
        let other = live
            .open(auth(2, Who::Human), true, 2, 64, u64::MAX, None)
            .unwrap();
        assert!(keep[0].0.is_closed() && keep[1].0.is_closed() && !keep[2].0.is_closed());
        assert!(!other.0.is_closed());
        assert_eq!(drain(&mut keep[0].1), vec!["END"]);
        let (s, rx) = &mut keep[2];
        s.go_live(0);
        live.publish(
            &event(Some(1), true, vec![], None),
            &json!({ "pad": "x".repeat(100) }),
        );
        assert_eq!(drain(rx), vec!["END"]);
        // over for good: nothing more is queued for it, however much is published
        assert!(s.is_closed());
        for n in 0..50 {
            live.publish(
                &event(Some(2 + n), true, vec![], None),
                &json!({ "pad": "x".repeat(100) }),
            );
        }
        assert!(drain(rx).is_empty());
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
        // 15.2: one spelling, the fields in this order
        assert_eq!(
            String::from_utf8(browser_open(&secret, &sub.auth, &r.body)).unwrap(),
            format!(
                "{{\"room_id\":\"{}\",\"change\":42,\"urgency\":2}}",
                b64(&[3; 32])
            )
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
            // a backslash is a path character to one URL parser and a separator to another
            "https://attacker.example\\.fcm.googleapis.com/push",
            "https://fcm.googleapis.com:8443/x",
            "https://fcm.googleapis.com:/x",
            "https://FCM.googleapis.com/x",
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
        assert_eq!(
            String::from_utf8(
                open_on_phone(&reg.key, &unb64(payload["e"].as_str().unwrap()).unwrap()).unwrap()
            )
            .unwrap(),
            format!(
                "{{\"room_id\":\"{}\",\"change\":77,\"urgency\":3,\"ticket\":\"TICKET\"}}",
                b64(&[3; 32])
            )
        );
        // without an envelope to fetch the ticket is empty, not absent
        assert_eq!(
            payload_text(&[3; 32], 5, 2, Some("")),
            format!(
                "{{\"room_id\":\"{}\",\"change\":5,\"urgency\":2,\"ticket\":\"\"}}",
                b64(&[3; 32])
            )
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

mod throttle_tests {
    use sha2::{Digest, Sha256};
    use std::cell::Cell;
    use trommi_hub::db::Db;
    use trommi_hub::error::Refused;
    use trommi_hub::throttle::*;

    const HOUR: u64 = 3_600_000;
    const ACCOUNT: &[u8] = b"password:a@example.org";

    struct T {
        db: Db,
        path: std::path::PathBuf,
        /// every real check of a credential, at a turn or early
        checks: Cell<usize>,
    }

    fn fresh() -> T {
        let path = std::env::temp_dir().join(format!(
            "throttle-{}.db",
            trommi_hub::util::b64(&trommi_hub::util::random::<12>())
        ));
        T {
            db: Db::open(&path).unwrap(),
            path,
            checks: Cell::new(0),
        }
    }

    impl T {
        fn admit(&self, account: &[u8], source: &[u8], known: bool, now: u64) -> Verdict {
            self.db
                .write(|c| admit(c, account, source, known, now, now))
                .map_err(|e: Refused| e.message)
                .unwrap()
        }
        fn failed(&self, account: &[u8], source: &[u8], attempt: i64, now: u64) {
            self.db
                .write(|c| failed(c, account, source, attempt, now))
                .map_err(|e: Refused| e.message)
                .unwrap()
        }
        fn succeeded(&self, account: &[u8], source: &[u8], attempt: i64) {
            self.db
                .write(|c| succeeded(c, account, source, attempt))
                .map_err(|e: Refused| e.message)
                .unwrap()
        }
        /// A wrong guess, handled as the login route does: `Ok` if it was answered as wrong, else the wait it
        /// was told. Every real check counts, also the early one of a known source that is then told to wait.
        fn guess(&self, account: &[u8], source: &[u8], known: bool, now: u64) -> Result<(), u64> {
            match self.admit(account, source, known, now) {
                Verdict::Check { attempt } => {
                    self.checks.set(self.checks.get() + 1);
                    self.failed(account, source, attempt, now);
                    Ok(())
                }
                Verdict::Line {
                    wait,
                    early: Some(attempt),
                } => {
                    self.checks.set(self.checks.get() + 1);
                    self.failed(account, source, attempt, now);
                    Err(wait)
                }
                Verdict::Own(wait) | Verdict::Line { wait, early: None } => Err(wait),
            }
        }
        /// The right credential: whether it got in now.
        fn right(&self, account: &[u8], source: &[u8], known: bool, now: u64) -> Result<(), u64> {
            match self.admit(account, source, known, now) {
                Verdict::Check { attempt }
                | Verdict::Line {
                    early: Some(attempt),
                    ..
                } => {
                    self.succeeded(account, source, attempt);
                    Ok(())
                }
                Verdict::Own(wait) | Verdict::Line { wait, early: None } => Err(wait),
            }
        }
        fn count(&self, sql: &str) -> i64 {
            self.db
                .read(|c| Ok::<_, Refused>(c.query_row(sql, [], |r| r.get(0))?))
                .map_err(|e| e.message)
                .unwrap()
        }
        /// Spends the account's hour: 100 wrong guesses from 100 sources.
        fn spend_hour(&self, now: u64) {
            for n in 0..ACCOUNT_BUDGET_PER_HOUR as u32 {
                assert_eq!(
                    self.guess(
                        ACCOUNT,
                        &[b"spender".as_slice(), &n.to_be_bytes()].concat(),
                        false,
                        now
                    ),
                    Ok(())
                );
            }
        }
    }

    impl Drop for T {
        fn drop(&mut self) {
            for ext in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{ext}", self.path.display()));
            }
        }
    }

    /// One source guessing at one account as fast as it is let: how many real checks it gets in a stretch of
    /// time. `crowd`: before each of its attempts another source takes a place in line, so that there is one.
    fn guesses(
        t: &T,
        account: &[u8],
        source: &[u8],
        known: bool,
        crowd: bool,
        from: u64,
        until: u64,
    ) -> usize {
        let (mut now, before) = (from, t.checks.get());
        let mut others = 0usize;
        while now < until {
            if crowd {
                let other = [b"crowd".as_slice(), &now.to_be_bytes()].concat();
                let at = t.checks.get();
                let _ = t.guess(account, &other, false, now);
                others += t.checks.get() - at;
            }
            match t.guess(account, source, known, now) {
                Ok(()) => now += 1,
                Err(seconds) => now += seconds * 1000,
            }
        }
        t.checks.get() - before - others
    }

    #[test]
    fn one_source_gets_thirteen_guesses_in_the_first_hour_and_four_an_hour_after() {
        let t = fresh();
        let start = 1_000_000;
        assert_eq!(
            guesses(&t, ACCOUNT, b"s", false, false, start, start + HOUR),
            13
        );
        assert_eq!(
            guesses(
                &t,
                ACCOUNT,
                b"s",
                false,
                false,
                start + HOUR,
                start + 2 * HOUR
            ),
            4
        );
        assert_eq!(
            guesses(
                &t,
                ACCOUNT,
                b"s",
                false,
                false,
                start + 2 * HOUR,
                start + 3 * HOUR
            ),
            4
        );
        // the waits: 1 s, 2 s, 4 s … 15 minutes
        assert_eq!(
            (1..=12).map(backoff_ms).collect::<Vec<_>>(),
            vec![
                1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000, 512000, 900000, 900000
            ]
        );
        // the Emergency Kit is another account key: the same source starts afresh there
        assert!(matches!(
            t.admit(b"kit:a@example.org", b"s", false, start + 3 * HOUR),
            Verdict::Check { .. }
        ));
    }

    #[test]
    fn a_known_source_gets_no_more_guesses_than_any_other_early_checks_and_turns_together() {
        // the account's hour is spent and there is always a line: the known source's wrong guesses are checked
        // early and at its turns. All of them together are the thirteen and the four.
        for known in [true, false] {
            let t = fresh();
            let start = 2_000_000;
            t.spend_hour(start);
            let first = guesses(&t, ACCOUNT, b"nat", known, true, start, start + HOUR);
            assert!(first <= 13, "{first} in the first hour (known: {known})");
            let second = guesses(
                &t,
                ACCOUNT,
                b"nat",
                known,
                true,
                start + HOUR,
                start + 2 * HOUR,
            );
            assert!(second <= 4, "{second} in the second hour (known: {known})");
            let third = guesses(
                &t,
                ACCOUNT,
                b"nat",
                known,
                true,
                start + 2 * HOUR,
                start + 3 * HOUR,
            );
            assert!(third <= 4, "{third} in the third hour (known: {known})");
            if known {
                assert!(first >= 10, "the early checks are real: {first}");
            }
        }
    }

    #[test]
    fn however_many_sources_an_account_takes_2010_guesses_an_hour_and_the_owner_always_gets_in() {
        let t = fresh();
        let start = 5_000_000;
        // a botnet: a new source every 200 ms for two minutes and one every two seconds after that, for two
        // hours, each coming back exactly when it is told to, each wrong; the checks are counted per minute
        let mut waiting: Vec<(u64, Vec<u8>)> = vec![];
        let mut per_minute = vec![0usize; 120];
        let mut owner_refused = 0usize;
        let mut n = 0u32;
        let mut now = start;
        while now < start + 2 * HOUR {
            let (due, later): (Vec<_>, Vec<_>) = waiting.drain(..).partition(|(at, _)| *at <= now);
            waiting = later;
            n += 1;
            let fresh =
                (now < start + 120_000 || n.is_multiple_of(10)).then(|| n.to_be_bytes().to_vec());
            for source in due.into_iter().map(|(_, s)| s).chain(fresh) {
                match t.guess(ACCOUNT, &source, false, now) {
                    Ok(()) => per_minute[((now - start) / 60_000) as usize] += 1,
                    // told its turn, or (the line being full) to ask again in a minute: it does as told
                    Err(seconds) => waiting.push((now + seconds * 1000, source)),
                }
            }
            // the owner, from a place the account knows, with the right password, once a minute: in at once
            if (now - start).is_multiple_of(60_000) && t.right(ACCOUNT, b"home", true, now).is_err()
            {
                owner_refused += 1;
            }
            now += 200;
        }
        assert_eq!(
            owner_refused, 0,
            "the owner at a known place is never kept out by what others did"
        );
        // any sixty minutes on end: at most 2 010 checks (1 800 turns, those still good from before, 100 twice)
        let worst = per_minute
            .windows(60)
            .map(|w| w.iter().sum::<usize>())
            .max()
            .unwrap();
        assert!(worst <= 2010, "{worst} guesses were checked within an hour");
        let all: usize = per_minute.iter().sum();
        assert!(all >= 3500, "the line kept moving: {all} in two hours");
        // the owner at a new place: at the turn it is told, within the line's ten minutes and a little
        let (mut at, mut told) = (now, 0);
        while let Err(seconds) = t.right(ACCOUNT, b"new place", false, at) {
            told += seconds;
            assert!(
                told <= 720,
                "a turn within the line's ten minutes and a little, not {told} s"
            );
            at += seconds * 1000;
        }
        // what it all left behind is bounded
        assert!(t.count("SELECT count(*) FROM login_turns") <= 400);
        assert_eq!(t.count("SELECT count(*) FROM login_accounts"), 1);
        assert_eq!(
            t.count("SELECT sources FROM login_counts"),
            t.count("SELECT count(*) FROM login_sources")
        );
    }

    #[test]
    fn a_turn_is_its_sources_alone_and_good_for_five_seconds() {
        let t = fresh();
        let t0 = 10_000_000;
        t.spend_hour(t0);
        // the first in line is checked at once; three more are told their turns, two seconds apart
        assert_eq!(t.guess(ACCOUNT, b"first", false, t0), Ok(()));
        assert_eq!(t.guess(ACCOUNT, b"a", false, t0), Err(2));
        assert_eq!(t.guess(ACCOUNT, b"b", false, t0), Err(4));
        assert_eq!(t.guess(ACCOUNT, b"c", false, t0), Err(6));
        // asking early changes nothing
        assert_eq!(t.guess(ACCOUNT, b"b", false, t0 + 1000), Err(3));
        // a is late; b comes on time and is checked: nobody waits for anybody
        assert_eq!(t.guess(ACCOUNT, b"b", false, t0 + 4000), Ok(()));
        // a comes late, within the five seconds its turn is good: checked. Nobody could take its turn.
        assert_eq!(t.guess(ACCOUNT, b"a", false, t0 + 6999), Ok(()));
        // c comes a second after the time it was told (the answer says whole seconds): checked
        assert_eq!(t.guess(ACCOUNT, b"c", false, t0 + 7000), Ok(()));
        // one who comes after its turn ran out has none: it is told to come again once the old one is cleared
        // away (eleven seconds past its end), and is then given a new one
        assert_eq!(t.guess(ACCOUNT, b"d", false, t0 + 7000), Err(1));
        assert_eq!(t.guess(ACCOUNT, b"e", false, t0 + 7000), Err(3));
        assert_eq!(
            t.guess(ACCOUNT, b"d", false, t0 + 13_001),
            Err(11),
            "its turn was good till 13"
        );
        assert_eq!(
            t.guess(ACCOUNT, b"e", false, t0 + 13_001),
            Ok(()),
            "e, at 10, is in time"
        );
        assert_eq!(
            t.guess(ACCOUNT, b"d", false, t0 + 24_002),
            Ok(()),
            "a new turn, and nobody before it"
        );
        // the line is ten minutes long: who finds it full is told to ask again, and holds no place
        let t1 = t0 + 30_000;
        let mut placed = 0;
        for n in 0..400u32 {
            match t.guess(
                ACCOUNT,
                &[b"crowd".as_slice(), &n.to_be_bytes()].concat(),
                false,
                t1,
            ) {
                Err(60) if placed >= 300 => {}
                Err(wait) => {
                    placed += 1;
                    assert!(wait <= 600, "{wait}");
                }
                Ok(()) => placed += 1,
            }
        }
        assert_eq!(placed, 301);
        // a turn is used once: each of the 300 is checked at its turn and at no other time
        let mut checked = 0;
        for n in 1..=300u32 {
            let source = [b"crowd".as_slice(), &n.to_be_bytes()].concat();
            let turn = t1 + n as u64 * 2000;
            assert!(t.guess(ACCOUNT, &source, false, turn - 1).is_err());
            if t.guess(ACCOUNT, &source, false, turn).is_ok() {
                checked += 1;
            }
        }
        assert_eq!(checked, 300);
        // A turn is kept by coming in time: a request that reached the hub within the turn's five seconds and
        // then waited for the hub's pool is checked. One that came later has no turn; and a request the pool
        // sent away leaves nothing behind that another could build on.
        let end = t1 + 700_000;
        let admit_at = |source: &[u8], now: u64, arrived: u64| {
            t.db.write(|c| admit(c, ACCOUNT, source, false, now, arrived))
                .map_err(|e: Refused| e.message)
                .unwrap()
        };
        assert_eq!(t.guess(ACCOUNT, b"before", false, end), Ok(()));
        assert_eq!(t.guess(ACCOUNT, b"slow", false, end), Err(2));
        assert_eq!(t.guess(ACCOUNT, b"late", false, end), Err(4));
        // meanwhile others come and go: nobody clears away a turn whose request may still be waiting
        assert_eq!(t.guess(ACCOUNT, b"other", false, end + 11_000), Ok(()));
        assert!(
            matches!(
                admit_at(b"slow", end + 12_500, end + 3000),
                Verdict::Check { .. }
            ),
            "came at 3, checked at 12.5"
        );
        // Who came after its turn ran out has none, and is told to come again shortly: its old turn stays until
        // no request that came in time can still be waiting, so that a late request takes nothing from one of
        // its own source that came in time. Then it is given a new one.
        assert_eq!(
            admit_at(b"late", end + 12_500, end + 9001),
            Verdict::Line {
                wait: 8,
                early: None
            },
            "the turn of second 4 was good till 9 and is kept till 20"
        );
        assert!(
            matches!(
                admit_at(b"late", end + 12_600, end + 8999),
                Verdict::Check { .. }
            ),
            "its request that came in time is still checked"
        );
        // a time of arrival that cannot be (longer ago than any request waits) counts for nothing
        assert_eq!(t.guess(ACCOUNT, b"liar", false, end + 12_500), Err(1));
        assert!(matches!(
            admit_at(b"liar", end + 28_000, end + 15_000),
            Verdict::Line { early: None, .. }
        ));
    }

    #[test]
    fn a_wrong_guess_is_answered_alike_from_a_source_the_account_knows_and_one_it_does_not() {
        let t = fresh();
        let t0 = 20_000_000;
        t.spend_hour(t0);
        assert_eq!(t.guess(ACCOUNT, b"first", false, t0), Ok(()));
        // in line, a known source is told to wait like the unknown one beside it; its credential is checked all
        // the same, on record, and what it is told when it asks again is its turn like the other's
        assert_eq!(
            t.admit(ACCOUNT, b"unknown", false, t0),
            Verdict::Line {
                wait: 2,
                early: None
            }
        );
        let Verdict::Line {
            wait: 4,
            early: Some(early),
        } = t.admit(ACCOUNT, b"known", true, t0)
        else {
            panic!()
        };
        // while that check runs, and after it failed, the answer is the turn's
        assert_eq!(
            t.admit(ACCOUNT, b"known", true, t0 + 100),
            Verdict::Line {
                wait: 4,
                early: None
            }
        );
        t.failed(ACCOUNT, b"known", early, t0 + 200);
        assert_eq!(
            t.admit(ACCOUNT, b"unknown", false, t0 + 500),
            Verdict::Line {
                wait: 2,
                early: None
            }
        );
        assert_eq!(
            t.admit(ACCOUNT, b"known", true, t0 + 500),
            Verdict::Line {
                wait: 4,
                early: None
            }
        );
        // both are checked on record when their turns come
        assert_eq!(t.guess(ACCOUNT, b"unknown", false, t0 + 2000), Ok(()));
        assert_eq!(t.guess(ACCOUNT, b"known", true, t0 + 4000), Ok(()));
        // and both stand in line again, the known one too: its failures (two by now) wait like anyone's, so it
        // gets no early check
        assert!(matches!(
            t.admit(ACCOUNT, b"unknown", false, t0 + 2500),
            Verdict::Line { early: None, .. }
        ));
        assert!(matches!(
            t.admit(ACCOUNT, b"known", true, t0 + 4500),
            Verdict::Line { early: None, .. }
        ));
        // the right credential from the known source gets in at once, line or no line
        assert!(t.guess(ACCOUNT, b"someone", false, t0 + 6000).is_err());
        assert_eq!(t.right(ACCOUNT, b"home", true, t0 + 6000), Ok(()));
    }

    #[test]
    fn a_source_has_one_check_at_a_time_however_long_it_takes_and_an_unchecked_one_changes_nothing()
    {
        let t = fresh();
        let source = b"s";
        let Verdict::Check { attempt: first } = t.admit(ACCOUNT, source, true, 1000) else {
            panic!()
        };
        // while that check runs — a second, a minute, an hour — the source starts no other
        for later in [1500, 9000, 61_000, HOUR] {
            assert_eq!(t.admit(ACCOUNT, source, true, later), Verdict::Own(1));
        }
        assert_eq!(
            t.db.read(|c| own_wait(c, ACCOUNT, source, 9000))
                .map_err(|e: Refused| e.message)
                .unwrap(),
            Some(1)
        );
        t.failed(ACCOUNT, source, first, 9000);
        assert_eq!(t.admit(ACCOUNT, source, true, 9500), Verdict::Own(1));
        let Verdict::Check { attempt: second } = t.admit(ACCOUNT, source, true, 10_000) else {
            panic!()
        };
        // the request died before the check: the failure before it stays, the wait is not reset
        t.db.write(|c| not_checked(c, ACCOUNT, source, second))
            .map_err(|e: Refused| e.message)
            .unwrap();
        let Verdict::Check { attempt: third } = t.admit(ACCOUNT, source, true, 10_000) else {
            panic!()
        };
        // a result under another attempt's name changes nothing
        t.succeeded(ACCOUNT, source, third + 1);
        t.failed(ACCOUNT, source, third + 1, 10_000);
        assert_eq!(t.admit(ACCOUNT, source, true, 10_500), Verdict::Own(1));
        t.failed(ACCOUNT, source, third, 10_000);
        assert_eq!(
            t.admit(ACCOUNT, source, true, 10_500),
            Verdict::Own(2),
            "two failures: two seconds"
        );
        // a success ends it
        let Verdict::Check { attempt: fourth } = t.admit(ACCOUNT, source, true, 12_000) else {
            panic!()
        };
        t.succeeded(ACCOUNT, source, fourth);
        assert_eq!(t.count("SELECT count(*) FROM login_sources"), 0);
        assert_eq!(t.count("SELECT sources FROM login_counts"), 0);
    }

    #[test]
    fn a_restart_resets_nothing() {
        let t = fresh();
        let t0 = 30_000_000;
        t.spend_hour(t0);
        assert_eq!(t.guess(ACCOUNT, b"first in line", false, t0), Ok(()));
        let kit = b"kit:a@example.org";
        assert_eq!(
            guesses(&t, kit, b"guesser", false, false, t0, t0 + 8000),
            4,
            "at 0, 1, 3 and 7 seconds; the fifth waits till 15"
        );
        let Verdict::Check { .. } = t.admit(kit, b"cut off", true, t0 + 8000) else {
            panic!()
        };
        // the hub stops and starts again
        let again = Db::open(&t.path).unwrap();
        again
            .write(recover)
            .map_err(|e: Refused| e.message)
            .unwrap();
        let t = T {
            db: again,
            path: t.path.clone(),
            checks: Cell::new(0),
        };
        // the wait of the guesser stands, the hour is still spent and its line where it was, and the check that
        // was cut off is over
        assert_eq!(t.admit(kit, b"guesser", false, t0 + 8000), Verdict::Own(8));
        assert_eq!(
            t.admit(ACCOUNT, b"someone new", false, t0 + 1000),
            Verdict::Line {
                wait: 1,
                early: None
            }
        );
        assert!(matches!(
            t.admit(kit, b"cut off", true, t0 + 8000),
            Verdict::Check { .. }
        ));
    }

    #[test]
    fn full_tables_check_no_source_they_cannot_record_and_answer_everyone_alike() {
        let t = fresh();
        let now = 40_000_000u64;
        let account = &Sha256::digest(ACCOUNT)[..16];
        // the account has its 5 000 sources on record, each still waiting out a failure
        t.db.write(|c| {
            for n in 0..SOURCES_PER_ACCOUNT {
                c.execute(
                    "INSERT INTO login_sources (account, source, failures, next_at, checking) VALUES (?1, ?2, 5, ?3, NULL)",
                    rusqlite::params![account, &Sha256::digest(n.to_be_bytes())[..16], (now + 10_000 + n as u64) as i64],
                )?;
            }
            c.execute("UPDATE login_counts SET sources = (SELECT count(*) FROM login_sources)", [])?;
            Ok::<_, Refused>(())
        })
        .map_err(|e| e.message)
        .unwrap();
        // one more it does not know: not checked, nothing recorded, nothing forgotten
        assert_eq!(
            t.admit(ACCOUNT, b"one more", false, now),
            Verdict::Line {
                wait: 60,
                early: None
            }
        );
        assert_eq!(
            t.count("SELECT count(*) FROM login_sources"),
            SOURCES_PER_ACCOUNT
        );
        // a source it knows is checked all the same; a wrong credential from it is answered like the other's
        assert_eq!(t.guess(ACCOUNT, b"home", true, now), Err(60));
        assert_eq!(t.checks.get(), 1);
        // and so is its next probe, while its failure waits: the same minute and the same work as for the other,
        // also where the hub looks before it spends anything
        assert_eq!(
            t.admit(ACCOUNT, b"home", true, now + 100),
            Verdict::Line {
                wait: 60,
                early: None
            }
        );
        assert_eq!(
            t.db.read(|c| own_wait(c, ACCOUNT, b"home", now + 100))
                .map_err(|e: Refused| e.message)
                .unwrap(),
            None
        );
        // … and after it has waited it out: still no room, still the full table's answer, though it is checked
        assert_eq!(t.guess(ACCOUNT, b"home", true, now + 1100), Err(60));
        assert_eq!(t.checks.get(), 2);
        assert_eq!(
            t.admit(ACCOUNT, b"one more", false, now + 1100),
            Verdict::Line {
                wait: 60,
                early: None
            }
        );
        assert_eq!(t.right(ACCOUNT, b"home", true, now + 3200), Ok(()));
        // another account is not touched
        assert_eq!(
            t.guess(b"password:b@example.org", b"one more", false, now),
            Ok(())
        );
        // once a wait has run out, the record that ran out longest ago makes room; no record that still waits
        // is ever given up
        assert_eq!(t.guess(ACCOUNT, b"one more", false, now + 10_001), Ok(()));
        assert_eq!(
            t.count("SELECT count(*) FROM login_sources WHERE failures = 5"),
            SOURCES_PER_ACCOUNT - 1
        );
        assert_eq!(
            t.count("SELECT sources FROM login_counts"),
            t.count("SELECT count(*) FROM login_sources")
        );
        // the sweep forgets a record a day after its wait ran out, and an hour that is over
        t.db.write(|c| sweep(c, now + 2 * 86_400_000))
            .map_err(|e: Refused| e.message)
            .unwrap();
        assert_eq!(t.count("SELECT count(*) FROM login_sources"), 0);
        assert_eq!(t.count("SELECT count(*) FROM login_accounts"), 0);
        assert_eq!(t.count("SELECT accounts FROM login_counts"), 0);
    }
}

mod pem_tests {
    use trommi_hub::config::pem;

    #[test]
    fn a_key_stored_with_spaces_or_written_line_breaks_is_the_same_pem() {
        let body = "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgq7n1pZ0s1mE0Jm3uR8cJm9o1cYz1u8m0Q2l6l1bq0w+hRANCAAQ7";
        let proper = format!(
            "-----BEGIN PRIVATE KEY-----\n{}\n{}\n-----END PRIVATE KEY-----\n",
            &body[..64],
            &body[64..]
        );
        assert_eq!(pem(&proper), proper);
        assert_eq!(pem(&proper.trim().replace('\n', " ")), proper);
        assert_eq!(pem(&proper.replace('\n', "\\n")), proper);
        assert_eq!(pem(&proper.replace('\n', "\r\n")), proper);
        // the bare body, and another kind of key keeps its name
        assert_eq!(pem(body), proper);
        assert!(
            pem("-----BEGIN EC PRIVATE KEY----- AAAA -----END EC PRIVATE KEY-----")
                .starts_with("-----BEGIN EC PRIVATE KEY-----\nAAAA\n-----END EC PRIVATE KEY-----")
        );
    }
}

mod tree_size {
    use trommi_hub::observer::{MlsObserver, Observer, MAX_LEAVES};
    use trommi_hub::wire::Writer;

    /// A GroupInfo whose GroupInfo extensions hold a tree of each of `trees` blank nodes (one byte each), signed by
    /// nobody.
    fn group_infos(trees: &[usize]) -> Vec<u8> {
        let mut extensions = Writer::default();
        for nodes in trees {
            let mut tree = Writer::default();
            tree.vec(&vec![0u8; *nodes]);
            extensions.raw(&[0, 2]).vec(&tree.0);
        }
        let mut w = Writer::default();
        w.raw(&[0, 1, 0, 4])
            .raw(&[0, 1, 0, 3])
            .vec(&[1; 32])
            .u64(1)
            .vec(&[2; 32])
            .vec(&[3; 32])
            .vec(&[])
            .vec(&extensions.0)
            .vec(&[4; 32])
            .u32(0)
            .vec(&[5; 64]);
        w.0
    }

    fn group_info(nodes: usize) -> Vec<u8> {
        group_infos(&[nodes])
    }

    #[test]
    fn a_second_tree_is_refused_before_it_is_unpacked() {
        let refused = format!(
            "{:?}",
            MlsObserver::default()
                .open(&group_infos(&[1, 380_000]))
                .unwrap_err()
        );
        assert!(refused.contains("an extension named twice"), "{refused}");
    }

    #[test]
    fn a_tree_larger_than_any_group_of_the_profile_is_refused_before_it_is_unpacked() {
        let obs = MlsObserver::default();
        let refused = format!("{:?}", obs.open(&group_info(2 * MAX_LEAVES)).unwrap_err());
        assert!(refused.contains("more leaves than any group"), "{refused}");
        // the largest tree passes the count; this one then fails as what it is
        let refused = format!(
            "{:?}",
            obs.open(&group_info(2 * MAX_LEAVES - 1)).unwrap_err()
        );
        assert!(!refused.contains("more leaves than any group"), "{refused}");
    }
}
