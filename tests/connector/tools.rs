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
    let groups = human.vault.device.groups().expect("groups");
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
