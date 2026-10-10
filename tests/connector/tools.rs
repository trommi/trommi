//! Every tool of the connector, called over MCP on the built binary, against the real v2 hub: what the agent's
//! call puts on the board, and what the human's answer brings back as a channel event.
mod common;

use common::process::Seat;
use common::{HubProc, Human};
use serde_json::{json, Value};
use trommi_core::ids::GroupId;

/// A hub, a human, and a connector joined by link with a main session, served over MCP.
async fn seated() -> (HubProc, Human, Seat, common::process::Mcp, GroupId) {
    let hub = HubProc::start().await;
    let mut human = Human::found(&hub.url).await;
    let seat = Seat::new(&hub.url);
    let mut invite = human.invite(None).await;
    let link = invite.link.clone();
    let join = seat.join(&link);
    let admit = async {
        let admitted = human.admit(&mut invite).await;
        human.found_session(&admitted).await
    };
    let ((joined, log), group) = tokio::join!(join, admit);
    assert!(joined, "the join failed:\n{log}");
    assert!(
        log.contains("check code"),
        "the six emoji were shown:\n{log}"
    );
    if std::env::var_os("TROMMI_TEST_LOG").is_some() {
        eprintln!("--- join ---\n{log}--- server ---");
    }
    let mut mcp = seat.serve().await;
    mcp.ready().await;
    (hub, human, seat, mcp, group)
}

fn payloads<'a>(human: &'a Human, key: &str) -> Vec<&'a Value> {
    human
        .items
        .iter()
        .map(|(_, _, payload)| payload)
        .filter(|payload| payload.get(key).is_some())
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn the_tools_write_to_the_board_and_answers_come_back() {
    let (_hub, mut human, _seat, mut mcp, group) = seated().await;

    // The list of tools is the one of tools.json, in its order, each with its description.
    let listed = mcp.request("tools/list", json!({})).await;
    let names: Vec<&str> = listed["tools"]
        .as_array()
        .expect("tools")
        .iter()
        .map(|tool| tool["name"].as_str().unwrap_or(""))
        .collect();
    assert_eq!(names[..3], ["reply", "create_decision", "create_info"]);
    assert!(names.contains(&"reload_connector"));

    // reply
    assert!(mcp
        .ok("reply", json!({ "text": "Build is green." }))
        .await
        .starts_with("sent"));
    // introduce, set_status
    mcp.ok(
        "introduce",
        json!({ "model": "test-model", "task": "trying every tool" }),
    )
    .await;
    mcp.ok(
        "set_status",
        json!({ "id": "tests", "label": "Tests", "state": "working", "detail": "running" }),
    )
    .await;

    // create_decision
    let made = mcp
        .ok(
            "create_decision",
            json!({
                "title": "Ship it?", "body": "Everything passes.",
                "options": [{ "key": "yes", "label": "Ship" }, { "key": "no", "label": "Wait" }],
                "recommended": "yes",
            }),
        )
        .await;
    let card = made
        .split_whitespace()
        .nth(1)
        .expect("the card's id")
        .to_string();
    assert_eq!(card.len(), 32, "{made}");

    // list_cards shows it open
    let listed: Value = serde_json::from_str(&mcp.ok("list_cards", json!({})).await).expect("JSON");
    assert_eq!(listed[0]["id"], card.as_str());
    assert_eq!(listed[0]["status"], "open");

    // revise_card, set_urgency
    let revised = mcp
        .ok(
            "revise_card",
            json!({ "card_id": card, "body": "Everything passes, twice." }),
        )
        .await;
    assert!(revised.contains("now version 2"), "{revised}");
    mcp.ok(
        "set_urgency",
        json!({ "card_id": card, "urgency": "high", "reason": "release window" }),
    )
    .await;

    human.sync().await;
    assert!(human.findings.is_empty(), "{:?}", human.findings);
    assert!(payloads(&human, "text")
        .iter()
        .any(|p| p["text"] == "Build is green."));
    assert!(payloads(&human, "card_type")
        .iter()
        .any(|p| p["title"] == "Ship it?" && p["body"] == "Everything passes, twice."));
    assert!(payloads(&human, "name")
        .iter()
        .any(|p| p["name"] == "status_line/tests"));
    assert!(payloads(&human, "name")
        .iter()
        .any(|p| p["name"] == "profile"));

    // The human answers; the agent gets the choice as a channel event and closes the card.
    human
        .answer(
            &card,
            json!({ "answer_action": "answer", "choices": ["yes"] }),
            &["yes"],
            false,
        )
        .await
        .expect("the hub takes the answer");
    let event = mcp.event("decision").await;
    assert_eq!(event["meta"]["card_id"], card.as_str(), "{event}");
    assert_eq!(event["meta"]["choice"], "yes", "{event}");
    assert_eq!(
        mcp.ok(
            "close_card",
            json!({ "card_id": card, "summary": "Live: shipped." })
        )
        .await,
        "closed"
    );

    // create_info, read by the human
    let made = mcp
        .ok(
            "create_info",
            json!({ "title": "Done", "body": "Shipped at noon." }),
        )
        .await;
    let info = made
        .split_whitespace()
        .nth(1)
        .expect("the info's id")
        .to_string();
    human.sync().await;
    human
        .answer(&info, json!({ "answer_action": "read" }), &[], true)
        .await
        .expect("the hub takes the reading");
    let event = mcp.event("info_read").await;
    assert_eq!(event["meta"]["card_id"], info.as_str(), "{event}");

    // withdraw_card, merge_cards
    let one = mcp.ok("create_decision", json!({ "title": "A?", "options": [{ "key": "a", "label": "A" }, { "key": "b", "label": "B" }] })).await;
    let two = mcp.ok("create_decision", json!({ "title": "B?", "options": [{ "key": "a", "label": "A" }, { "key": "b", "label": "B" }] })).await;
    let id = |text: &str| text.split_whitespace().nth(1).expect("an id").to_string();
    let merged = mcp
        .ok(
            "merge_cards",
            json!({ "card_ids": [id(&one), id(&two)], "title": "A or B?", "options": [{ "key": "a", "label": "A" }, { "key": "b", "label": "B" }] }),
        )
        .await;
    assert!(merged.contains("replacing"), "{merged}");
    assert_eq!(
        mcp.ok(
            "withdraw_card",
            json!({ "card_id": id(&merged), "reason": "no longer needed" })
        )
        .await,
        "withdrawn"
    );

    // A message of the human arrives with his words.
    human
        .say(
            &group,
            json!({ "content_type": "message", "text": "Thanks, well done." }),
        )
        .await
        .expect("the hub takes it");
    let event = mcp.event("chat").await;
    assert!(
        event["content"]
            .as_str()
            .unwrap_or("")
            .contains("Thanks, well done."),
        "{event}"
    );

    // The Desk's goals, which a human device keeps in the session for its agent, come with a tool's result.
    human
        .set_register(&group, "goals", Some(json!({ "desk_id": "d1", "desk_name": "Launch", "goals": "Ship v2\nNo regressions" })))
        .await
        .expect("the hub takes the register");
    let mut told = String::new();
    for _ in 0..600 {
        told = mcp.ok("reply", json!({ "text": "On it." })).await;
        if told.contains("Desk goals") {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert!(
        told.contains("Desk goals") && told.contains("Ship v2") && told.contains("No regressions"),
        "{told}"
    );

    mcp.ok("clear_status", json!({})).await;
    human.sync().await;
    assert!(human.findings.is_empty(), "{:?}", human.findings);
    mcp.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn helper_sessions_and_assets() {
    let (_hub, mut human, seat, mut mcp, _group) = seated().await;

    // open_session: the agent founds the helper's group itself, with every human device.
    let opened = mcp
        .ok(
            "open_session",
            json!({ "name": "Design", "task": "drawing the logo" }),
        )
        .await;
    assert!(opened.starts_with("child session opened"), "{opened}");
    assert!(mcp
        .ok(
            "reply",
            json!({ "session": "Design", "text": "Three drafts ready." })
        )
        .await
        .starts_with("sent"));
    mcp.ok(
        "set_status",
        json!({ "session": "Design", "id": "logo", "label": "Logo", "state": "working" }),
    )
    .await;
    let made = mcp
        .ok(
            "create_decision",
            json!({ "session": "Design", "title": "Which draft?", "options": [{ "key": "a", "label": "A" }, { "key": "b", "label": "B" }] }),
        )
        .await;
    let card = made
        .split_whitespace()
        .nth(1)
        .expect("the card's id")
        .to_string();

    human.sync().await;
    assert!(human.findings.is_empty(), "{:?}", human.findings);
    let groups = human.groups().await;
    let helper = groups
        .iter()
        .find(|g| g.session.is_some_and(|s| !s.parent.is_zero()))
        .expect("the human device is a leaf of the helper session");
    let helper_sid =
        trommi_connector::util::hex(helper.session.expect("a session").session_id.as_bytes());
    assert!(human
        .items
        .iter()
        .any(|(session, _, payload)| *session == helper_sid
            && payload["text"] == "Three drafts ready."));

    // The human's answer in the helper session arrives with its name.
    human
        .answer(
            &card,
            json!({ "answer_action": "answer", "choices": ["b"] }),
            &["b"],
            false,
        )
        .await
        .expect("taken");
    let event = mcp.event("decision").await;
    assert_eq!(event["meta"]["session"], "Design", "{event}");
    assert_eq!(event["meta"]["choice"], "b", "{event}");

    let again = mcp.ok("open_session", json!({ "name": "Design" })).await;
    assert!(again.starts_with("child session already open"), "{again}");
    let closed = mcp
        .ok(
            "close_session",
            json!({ "name": "Design", "summary": "Draft B it is." }),
        )
        .await;
    assert!(closed.contains("closed"), "{closed}");

    // publish_asset, list_assets, share_asset, revoke_asset
    let page = seat.folder.join("report.html");
    std::fs::write(&page, "<h1>Report</h1><p>All good.</p>").expect("a file");
    let published = mcp
        .ok(
            "publish_asset",
            json!({ "path": page.display().to_string(), "title": "Weekly report" }),
        )
        .await;
    let asset = published
        .strip_prefix("published as ")
        .and_then(|rest| rest.split(':').next())
        .expect("the asset's id")
        .to_string();
    let listed: Value =
        serde_json::from_str(&mcp.ok("list_assets", json!({})).await).expect("JSON");
    assert_eq!(listed[0]["id"], asset.as_str());
    assert_eq!(listed[0]["title"], "Weekly report");
    let shared = mcp
        .ok("share_asset", json!({ "id": asset, "expires_hours": 2 }))
        .await;
    let link = shared
        .lines()
        .find_map(|line| line.strip_prefix("Link for the recipient: "))
        .expect("a link");
    trommi_core::files::ShareLink::parse(link).expect("a Share link of the protocol");
    let too_long = mcp
        .call(
            "share_asset",
            json!({ "id": asset, "expires_hours": 181 * 24 }),
        )
        .await;
    assert!(
        too_long.1 && too_long.0.contains("180 days"),
        "{too_long:?}"
    );
    assert!(mcp
        .ok("share_asset", json!({ "id": asset, "release": false }))
        .await
        .contains("taken back"));
    assert!(mcp
        .ok("revoke_asset", json!({ "id": asset }))
        .await
        .starts_with("revoked"));
    let listed: Value =
        serde_json::from_str(&mcp.ok("list_assets", json!({})).await).expect("JSON");
    assert_eq!(listed, json!([]));

    human.sync().await;
    assert!(human.findings.is_empty(), "{:?}", human.findings);
    mcp.close().await;
}

/// A hub, a human, and a connector in its session, not yet served.
async fn joined() -> (HubProc, Human, Seat, GroupId) {
    let hub = HubProc::start().await;
    let mut human = Human::found(&hub.url).await;
    let seat = Seat::new(&hub.url);
    let mut invite = human.invite(None).await;
    let link = invite.link.clone();
    let join = seat.join(&link);
    let admit = async {
        let admitted = human.admit(&mut invite).await;
        human.found_session(&admitted).await
    };
    let ((joined, log), group) = tokio::join!(join, admit);
    assert!(joined, "the join failed:\n{log}");
    (hub, human, seat, group)
}

#[tokio::test(flavor = "multi_thread")]
async fn the_plugins_hooks_mirror_the_terminal_and_ask_for_permission() {
    let (_hub, mut human, seat, _group) = joined().await;
    let mut mcp = seat.serve_as_plugin().await;
    mcp.ready().await;
    let me = human.seat(&_group).await.expect("the agent");

    // The human types into the terminal; the agent works; its final answer ends the turn.
    let turn =
        json!({ "session_id": "s1", "prompt_id": "p1", "cwd": seat.folder.display().to_string() });
    let with = |more: Value| {
        let mut all = turn.as_object().cloned().expect("an object");
        all.extend(more.as_object().cloned().expect("an object"));
        Value::Object(all)
    };
    seat.hook(
        "prompt",
        &with(json!({ "hook_event_name": "UserPromptSubmit", "prompt": "Please run the tests." })),
    )
    .await;
    seat.hook("trail", &with(json!({ "hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_use_id": "t1", "tool_input": { "command": "cargo test", "description": "Run the tests" } }))).await;
    seat.hook("trail", &with(json!({ "hook_event_name": "PostToolUse", "tool_name": "Bash", "tool_use_id": "t1", "tool_input": { "command": "cargo test" }, "tool_response": { "stdout": "ok", "exit_code": 0 } }))).await;
    seat.hook(
        "stop",
        &with(json!({ "hook_event_name": "Stop", "last_assistant_message": "All tests pass." })),
    )
    .await;

    let mut seen = (false, false, false);
    for _ in 0..600 {
        human.sync().await;
        let terminal = |kind: &str, text: &str| {
            human.items.iter().any(|(_, sender, payload)| {
                *sender == me && payload["terminal"] == kind && payload["text"] == text
            })
        };
        seen = (
            terminal("input", "Please run the tests."),
            terminal("answer", "All tests pass."),
            human
                .trail
                .iter()
                .any(|(_, number, step)| *number >= 1 && step["tool"] == "Bash"),
        );
        if seen == (true, true, true) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert_eq!(
        seen,
        (true, true, true),
        "prompt, answer and trail reached the board: {:?} {:?}",
        human.trail,
        human.findings
    );
    assert!(human.findings.is_empty(), "{:?}", human.findings);

    // Claude Code asks for a permission: a request on the board, the human's verdict back to Claude Code.
    mcp.notify(
        "notifications/claude/channel/permission_request",
        json!({ "request_id": "abcde", "tool_name": "Bash", "description": "Push the branch", "input_preview": "git push" }),
    )
    .await;
    let request = loop {
        human.sync().await;
        if let Some(id) = human
            .object_ids()
            .into_iter()
            .find(|id| human.has_request(id))
        {
            break id;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    };
    assert!(human
        .items
        .iter()
        .any(|(_, _, payload)| payload["tool_name"] == "Bash"
            && payload["input_preview"] == "git push"));
    human
        .verdict(&request, true)
        .await
        .expect("the verdict is taken");
    let verdict = mcp
        .notification("notifications/claude/channel/permission")
        .await;
    assert_eq!(
        verdict,
        json!({ "request_id": "abcde", "behavior": "allow" })
    );
    mcp.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_connector_killed_at_work_is_the_same_member_when_it_starts_again() {
    let (_hub, mut human, seat, group) = joined().await;
    let me = human.seat(&group).await.expect("the agent");
    let mut said = Vec::new();
    for round in 0..3 {
        let mut mcp = seat.serve().await;
        mcp.ready().await;
        for n in 0..3 {
            let text = format!("round {round}, message {n}");
            mcp.ok("reply", json!({ "text": text })).await;
            said.push(text);
        }
        // One more is on its way when the process is killed: it may have reached the hub or not, but
        // whatever was signed is either sent as it was or never existed.
        let racing = format!("round {round}, the one that raced the kill");
        let call = mcp.call("reply", json!({ "text": racing }));
        let _ =
            tokio::time::timeout(std::time::Duration::from_millis(15 * (round + 1)), call).await;
        mcp.child.start_kill().expect("kill -9");
        let _ = mcp.child.wait().await;
    }
    let mut mcp = seat.serve().await;
    mcp.ready().await;
    mcp.ok("reply", json!({ "text": "still the same member" }))
        .await;
    said.push("still the same member".into());

    human.sync().await;
    assert!(
        human.findings.is_empty(),
        "no gap, no second envelope under one number: {:?}",
        human.findings
    );
    let texts: Vec<String> = human
        .items
        .iter()
        .filter(|(_, sender, _)| *sender == me)
        .filter_map(|(_, _, payload)| payload["text"].as_str().map(String::from))
        .filter(|text| !text.contains("raced the kill"))
        .collect();
    assert_eq!(texts, said);
    mcp.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn say_and_whoami_work_without_a_running_server() {
    let (_hub, mut human, seat, group) = joined().await;
    let me = human.seat(&group).await.expect("the agent");
    let run = |args: &'static [&'static str]| {
        let mut command = seat.command(args);
        async move {
            let output = command
                .stdin(std::process::Stdio::null())
                .output()
                .await
                .expect("the command runs");
            (
                output.status.success(),
                String::from_utf8_lossy(&output.stdout).into_owned(),
                String::from_utf8_lossy(&output.stderr).into_owned(),
            )
        }
    };
    let (ok, out, err) = run(&["say", "The build machine is out of disk."]).await;
    assert!(ok, "{out}\n{err}");
    human.sync().await;
    assert!(human.findings.is_empty(), "{:?}", human.findings);
    assert!(human.items.iter().any(|(_, sender, payload)| *sender == me
        && payload["text"] == "The build machine is out of disk."));

    let (ok, out, _) = run(&["whoami"]).await;
    assert!(ok);
    let who: Value = serde_json::from_str(&out).expect("JSON");
    assert_eq!(who["room_id"], human.room.to_base64url());
    assert_eq!(who["has_key"], true);

    // A second process cannot hold the same state: the server owns it, `say` goes through its door.
    let mut mcp = seat.serve().await;
    mcp.ready().await;
    let (ok, out, err) = run(&["say", "Said through the running connector."]).await;
    assert!(ok, "{out}\n{err}");
    human.sync().await;
    assert!(human
        .items
        .iter()
        .any(|(_, _, payload)| payload["text"] == "Said through the running connector."));
    assert!(human.findings.is_empty(), "{:?}", human.findings);
    mcp.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn after_a_takeover_the_first_connector_says_that_it_stopped() {
    let (_hub, mut human, first_seat, group) = joined().await;
    let mut first = first_seat.serve().await;
    first.ready().await;
    first
        .ok("reply", json!({ "text": "from the first machine" }))
        .await;
    let old = human.seat(&group).await.expect("the first agent device");

    // The human reconnects the session on "another machine".
    let second_seat = Seat::new(&first_seat.hub_url);
    let mut invite = human.invite(group.session_id()).await;
    let link = invite.link.clone();
    let join = second_seat.join(&link);
    let admit = async {
        let admitted = human.admit(&mut invite).await;
        human.take_over(&group, old, &admitted).await;
    };
    let ((joined, log), ()) = tokio::join!(join, admit);
    assert!(joined, "the second connector joins the session:\n{log}");
    let mut second = second_seat.serve().await;
    second.ready().await;
    second
        .ok("reply", json!({ "text": "from the second machine" }))
        .await;

    // The first one answers every call with a clear word instead of sending into the void.
    let mut said = String::new();
    for _ in 0..450 {
        let (text, failed) = first.call("reply", json!({ "text": "anyone?" })).await;
        if failed && (text.contains("retired") || text.contains("stopped")) {
            said = text;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
    assert!(
        said.contains("reconnect") || said.contains("invite"),
        "the first connector says what happened and what to do: {said}"
    );
    human.sync().await;
    assert!(human.findings.is_empty(), "{:?}", human.findings);
    assert!(!human
        .items
        .iter()
        .any(|(_, _, payload)| payload["text"] == "anyone?"));
    assert!(human
        .items
        .iter()
        .any(|(_, _, payload)| payload["text"] == "from the second machine"));
    // What becomes of the first machine's state depends on what it could verify. A hub that serves a removed
    // device the Commits that removed it (`/v2/groups/{group}/removal`): the device checks them itself, says
    // that it is retired, and its state is gone. A hub that only refuses it: it stopped, and its state stays.
    fn states(dir: &std::path::Path) -> usize {
        std::fs::read_dir(dir)
            .into_iter()
            .flatten()
            .flatten()
            .map(|entry| entry.path())
            .map(|path| {
                if path.extension().is_some_and(|ext| ext == "state") {
                    // (an empty journal is no state: a slot that is looked at gets one)
                    let holds = |name: &str| {
                        std::fs::metadata(path.join(name)).is_ok_and(|meta| meta.len() > 0)
                    };
                    usize::from(holds("state.log") || holds("state.snap"))
                } else if path.is_dir() {
                    states(&path)
                } else {
                    0
                }
            })
            .sum()
    }
    let kept = states(&first_seat.home.path().join("keys"));
    if said.contains("retired") {
        assert_eq!(
            kept, 0,
            "a removal the device verified wipes its state: {said}"
        );
        assert!(
            said.contains("another connector"),
            "it knows it was a takeover: {said}"
        );
    } else {
        assert_eq!(
            kept, 1,
            "a removal the hub only claims wipes nothing: {said}"
        );
        // Set where the hub under test serves the removal route: then nothing less than verified will do.
        assert!(
            std::env::var_os("TROMMI_HUB_SERVES_REMOVAL").is_none(),
            "the hub serves the removing Commits, and the connector did not verify its removal: {said}"
        );
    }
    first.close().await;
    second.close().await;
    if said.contains("retired") {
        // Nothing at all is left of the state, not even an empty directory.
        fn state_dirs(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
            std::fs::read_dir(dir)
                .into_iter()
                .flatten()
                .flatten()
                .map(|entry| entry.path())
                .flat_map(|path| {
                    if path.extension().is_some_and(|ext| ext == "state") {
                        vec![path]
                    } else if path.is_dir() {
                        state_dirs(&path)
                    } else {
                        vec![]
                    }
                })
                .collect()
        }
        let left = state_dirs(&first_seat.home.path().join("keys"));
        assert!(
            left.is_empty(),
            "a wiped slot leaves no state directory: {left:?}"
        );
    }
}

/// A host without channels and without the plugin's monitor (plain MCP: Codex, or `claude mcp add`): the tool
/// list has `inbox`, and what the human writes waits there until the agent asks.
#[tokio::test(flavor = "multi_thread")]
async fn without_channel_and_monitor_board_events_wait_for_the_inbox_tool() {
    let (_hub, mut human, seat, group) = joined().await;
    let mut mcp = seat.serve_plain().await;
    mcp.ready().await;
    let listed = mcp.request("tools/list", json!({})).await;
    assert!(
        listed["tools"]
            .as_array()
            .expect("tools")
            .iter()
            .any(|tool| tool["name"] == "inbox"),
        "a host that hears no channel is given the inbox tool"
    );
    mcp.ok("reply", json!({ "text": "I am here." })).await;
    human
        .say(
            &group,
            json!({ "content_type": "message", "text": "Please look at the plain path." }),
        )
        .await
        .expect("the human writes");
    let mut said = String::new();
    for _ in 0..450 {
        said = mcp.ok("inbox", json!({})).await;
        if said.contains("Please look at the plain path.") {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
    assert!(
        said.contains("Please look at the plain path."),
        "the human's words come out of the inbox: {said}"
    );
    // read once: the next call has nothing new
    let again = mcp.ok("inbox", json!({})).await;
    assert!(
        !again.contains("Please look at the plain path."),
        "an event is handed out once: {again}"
    );
    // (the channel notification still goes out as well: a host that does not show it drops it, and one that
    // was taken for deaf by mistake still hears it)
    mcp.close().await;
}

/// A link past its deadline is refused by the connector itself, at once and with a plain reason, before a slot
/// is made or the hub is asked.
#[tokio::test(flavor = "multi_thread")]
async fn an_expired_link_is_refused_before_anything_is_asked() {
    let hub = HubProc::start().await;
    let mut human = Human::found(&hub.url).await;
    let seat = Seat::new(&hub.url);
    // an agent invite lives 15 minutes, and two more are tolerated
    let link = human.expired_link(20 * 60 * 1000).await;
    // (the connector is built before the clock starts)
    common::process::connector_binary();
    let started = std::time::Instant::now();
    let (joined, log) = seat.join(&link).await;
    assert!(!joined, "{log}");
    assert!(log.contains("expired"), "{log}");
    assert_eq!(log.matches("make a new").count(), 1, "{log}");
    assert!(
        started.elapsed() < std::time::Duration::from_secs(10),
        "refused without waiting: {log}"
    );
    let keys = seat.home.path().join("keys");
    let left: Vec<_> = std::fs::read_dir(&keys)
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .collect();
    assert!(left.is_empty(), "nothing was written: {left:?}");
}
