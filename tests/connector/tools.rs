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
