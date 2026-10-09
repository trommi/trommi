//! The terminal mirror (connector/src/mirror.rs): what the hooks UserPromptSubmit and Stop take from their input,
//! what is never mirrored, the levels, pasted pictures, and the connector's queue. Library calls only, no hub.
use serde_json::{json, Value};
use trommi_connector::mirror::*;
use trommi_connector::util::now_ms;

#[test]
fn a_typed_prompt_is_mirrored_as_it_is() {
    assert_eq!(
        terminal_input("  wie läufts?\n").as_deref(),
        Some("wie läufts?")
    );
    assert_eq!(
        terminal_input("/home/me/x.rs is broken").as_deref(),
        Some("/home/me/x.rs is broken")
    );
    assert_eq!(
        terminal_input("<div> is not closed in index.html").as_deref(),
        Some("<div> is not closed in index.html")
    );
    assert_eq!(
        terminal_input("# Plan\n\n- **one**\n- two").as_deref(),
        Some("# Plan\n\n- **one**\n- two")
    );
}

#[test]
fn pasted_text_stays_and_its_marker_lines_go() {
    let p = "<pasted_content id=\"92bd\">\nline one\nline two\n</pasted_content id=\"92bd\">\n\n what about this?";
    assert_eq!(
        terminal_input(p).as_deref(),
        Some("line one\nline two\n\n what about this?")
    );
}

#[test]
fn what_claude_code_submits_by_itself_is_not_his_input() {
    let monitor = "<task-notification>\n<task-id>bfx52ap4v</task-id>\n<summary>Monitor event: \"Trommi board events\"</summary>\n<event>Trommi · The human wrote on the board: \"Oh shit\" · call inbox</event>\n</task-notification>";
    for p in [
        monitor,
        "<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n<summary>Agent \"Design\" finished</summary>\n</task-notification>",
        "<channel source=\"trommi\" kind=\"chat\">\nPlease check the logs first.\n</channel>",
        "<channel source=\"board\" kind=\"decision\" card_id=\"ab\" choice=\"live\">\nDecision on \"x\": live\n</channel>",
        "Another Claude session sent a message:\n<agent-message from=\"afdd\">\n[Subagent hand-back] The text below …\n</agent-message>",
        "<system-reminder>\nsomething\n</system-reminder>",
        "<local-command-stdout>Reconnected to trommi.</local-command-stdout>",
        "<command-name>/mcp</command-name>\n<command-message>mcp</command-message>",
        "<bash-input> git status</bash-input>",
        "Trommi · The human answered \"Jetzt live?\": \"Ja, live\" · call inbox",
        "Trommi · Design · The human wrote on the board: \"so\" [2 pictures] · call inbox\n",
        "Your claude.ai usage limit has reset. Continue the task you were working on when the limit was reached.",
        "/clear",
        "/mcp",
        "/trommi:clip card 12",
        "   ",
        "",
    ] {
        assert_eq!(terminal_input(p), None, "{p}");
    }
}

#[test]
fn a_pasted_picture_goes_along_or_leaves_a_neutral_mark() {
    let dir = std::env::temp_dir().join(format!(
        "trommi-pictures-{}-{}",
        std::process::id(),
        now_ms()
    ));
    let images = dir.join("images");
    std::fs::create_dir_all(&images).unwrap();
    let png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";
    std::fs::write(images.join("1.png"), png).unwrap();
    std::fs::write(images.join("2.jpg"), [0xff, 0xd8, 0xff, 0xe0, 0, 0]).unwrap();
    std::fs::write(images.join("3.png"), b"not a picture at all").unwrap();
    std::fs::write(images.join("5.png"), b"").unwrap();
    std::os::unix::fs::symlink(images.join("1.png"), images.join("6.png")).unwrap();
    let d = images.to_str().unwrap();
    let file = |n: &str| images.join(n).to_str().unwrap().to_string();
    // as Claude Code 2.1.286 submits a pasted picture: the mark in the text, the session's scratchpad beside
    let ups = json!({ "hook_event_name": "UserPromptSubmit", "prompt_id": "cf77", "scratchpad_dir": dir.join("scratchpad").to_str().unwrap(), "prompt": "[Image #1] what is in this picture?" });
    assert_eq!(pictures_dir(&ups).as_deref(), Some(d));
    assert_eq!(
        hook_request("prompt", &ups, &[7]).unwrap()["pictures_dir"],
        json!(d)
    );
    assert!(hook_request(
        "prompt",
        &json!({ "prompt": "no picture", "scratchpad_dir": "/tmp/x/scratchpad" }),
        &[7]
    )
    .unwrap()
    .get("pictures_dir")
    .is_none());
    assert_eq!(
        pictures_dir(&json!({ "prompt": "[Image #1]" })),
        None,
        "no scratchpad_dir: no place to look"
    );
    assert_eq!(
        pictures_dir(&json!({ "prompt": "[Image #1]", "scratchpad_dir": "relative/scratchpad" })),
        None
    );
    // found: the mark goes, the file comes
    assert_eq!(
        pictures("[Image #1] what is in this picture?", Some(d), 0),
        ("what is in this picture?".to_string(), vec![file("1.png")])
    );
    assert_eq!(
        pictures("[Image #1]", Some(d), 0),
        (String::new(), vec![file("1.png")])
    );
    assert_eq!(
        pictures(
            "compare [Image #1] with [Image #2]\nand [Image #1] again",
            Some(d),
            0
        ),
        (
            "compare with\nand again".to_string(),
            vec![file("1.png"), file("2.jpg")]
        )
    );
    // not found: no raw mark, a neutral one (no folder, no file, not a picture, empty, a link, an older file)
    assert_eq!(
        pictures("[Image #1]", None, 0),
        (PICTURE_MARK.to_string(), vec![])
    );
    assert_eq!(
        pictures("[Image #1] look", Some("relative/images"), 0),
        (format!("{PICTURE_MARK} look"), vec![])
    );
    for n in [3, 4, 5, 6] {
        assert_eq!(
            pictures(&format!("see [Image #{n}]"), Some(d), 0),
            (format!("see {PICTURE_MARK}"), vec![]),
            "{n}"
        );
    }
    assert_eq!(
        pictures("[Image #1]", Some(d), now_ms() + 60_000),
        (PICTURE_MARK.to_string(), vec![]),
        "a file from before this connector started is another picture"
    );
    assert_eq!(
        pictures("[Image #1] and [Image #4]", Some(d), 0),
        (format!("and {PICTURE_MARK}"), vec![file("1.png")])
    );
    assert_eq!(
        pictures("plain words  with two spaces", Some(d), 0),
        ("plain words  with two spaces".to_string(), vec![]),
        "a text without a mark stays as it is"
    );
    // the queue: the picture rides with his message, also when he typed nothing beside it
    let m = Mirror::default();
    {
        // (this connector started before the files were written)
        let since = m.since;
        assert!(since + 5_000 > now_ms());
    }
    let mut m = Mirror::default();
    m.since = 0;
    let a = m.accept(&json!({ "op": "terminal", "kind": "input", "text": "[Image #1]", "prompt_id": "p1", "pictures_dir": d }), false);
    assert_eq!(
        (a["queued"].clone(), a["pictures"].clone()),
        (json!(true), json!(1))
    );
    let i = m.next().unwrap();
    assert_eq!(
        (i.kind, i.text.as_str(), i.pictures),
        ("input", "", vec![file("1.png")])
    );
    assert_eq!(m.accept(&json!({ "op": "terminal", "kind": "input", "text": "[Image #9] hm", "prompt_id": "p2", "pictures_dir": d }), false)["pictures"], json!(0));
    assert_eq!(m.next().unwrap().text, format!("{PICTURE_MARK} hm"));
    assert_eq!(m.accept(&json!({ "op": "terminal", "kind": "answer", "text": "I see [Image #1].", "prompt_id": "p2", "pictures_dir": d }), false)["queued"], json!(true));
    let i = m.next().unwrap();
    assert_eq!(
        (i.text.as_str(), i.pictures.len()),
        ("I see [Image #1].", 0),
        "only his prompt has pictures"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_levels() {
    for (v, l) in [
        ("", Level::Steps),
        ("steps", Level::Steps),
        ("on", Level::Steps),
        ("1", Level::Steps),
        ("off", Level::Off),
        (" OFF ", Level::Off),
        ("0", Level::Off),
        ("false", Level::Off),
        ("no", Level::Off),
        ("answers", Level::Answers),
        ("Full", Level::Full),
    ] {
        assert_eq!(level_of(v), l, "{v}");
    }
    assert!(
        Level::Off < Level::Answers && Level::Answers < Level::Steps && Level::Steps < Level::Full
    );
}

#[test]
fn a_long_text_is_cut_at_a_character() {
    let long = "ä".repeat(20_000);
    let c = capped(&long);
    assert!(c.len() <= MAX_BYTES && c.ends_with(CUT_NOTE) && c.starts_with("ää"));
    assert_eq!(capped("short"), "short");
}

#[test]
fn the_hook_reads_claude_codes_input() {
    // as Claude Code 2.1.286 sends them
    let ups = json!({ "session_id": "a3f1", "transcript_path": "/home/me/.claude/projects/p/a3f1.jsonl", "cwd": "/home/me/p", "prompt_id": "c771", "permission_mode": "default", "hook_event_name": "UserPromptSubmit", "prompt": "Reply with exactly: **ok** done" });
    let r = hook_request("prompt", &ups, &[7, 8]).unwrap();
    assert_eq!(
        r,
        json!({ "op": "terminal", "kind": "input", "text": "Reply with exactly: **ok** done", "prompt_id": "c771", "ancestors": [7, 8] })
    );
    let stop = json!({ "session_id": "a3f1", "transcript_path": "/nowhere.jsonl", "cwd": "/home/me/p", "prompt_id": "c771", "permission_mode": "default", "hook_event_name": "Stop", "stop_hook_active": false, "last_assistant_message": "**ok** done\n", "background_tasks": [], "session_crons": [] });
    let r = hook_request("stop", &stop, &[7]).unwrap();
    assert_eq!(
        (r["kind"].as_str(), r["text"].as_str()),
        (Some("answer"), Some("**ok** done"))
    );
    // a prompt that is not his typing still starts a turn, without a text
    let r = hook_request(
        "prompt",
        &json!({ "prompt": "/clear", "prompt_id": "p2" }),
        &[7],
    )
    .unwrap();
    assert_eq!(
        (r["kind"].as_str(), r["text"].is_null()),
        (Some("input"), true)
    );
    // inside a subagent, and broken input: nothing
    assert!(hook_request("stop", &json!({ "agent_id": "def456", "agent_type": "Explore", "last_assistant_message": "Found 3 issues" }), &[7]).is_none());
    assert!(hook_request(
        "prompt",
        &json!({ "agent_id": "def456", "prompt": "hello" }),
        &[7]
    )
    .is_none());
    assert!(hook_request("prompt", &Value::Null, &[7]).is_none());
    assert!(hook_request("other", &ups, &[7]).is_none());
}

#[test]
fn a_line_for_the_bell_stays_under_its_limit() {
    let ups = json!({ "prompt": "\u{1}".repeat(MAX_BYTES), "prompt_id": "p" });
    let r = hook_request("prompt", &ups, &[1]).unwrap();
    assert!(r.to_string().len() <= 60_000 && r["text"].as_str().unwrap().ends_with(CUT_NOTE));
}

#[test]
fn the_final_answer_comes_from_the_transcript_when_the_input_has_none() {
    let lines = [
        json!({ "type": "user", "message": { "role": "user", "content": "first question" } }),
        json!({ "type": "assistant", "message": { "id": "m1", "content": [{ "type": "text", "text": "an old answer" }] } }),
        json!({ "type": "user", "message": { "role": "user", "content": [{ "type": "text", "text": "second question" }] } }),
        json!({ "type": "assistant", "message": { "id": "m2", "content": [{ "type": "thinking", "thinking": "secret thoughts" }] } }),
        json!({ "type": "assistant", "message": { "id": "m2", "content": [{ "type": "text", "text": "Let me look." }] } }),
        json!({ "type": "assistant", "message": { "id": "m2", "content": [{ "type": "tool_use", "id": "t1", "name": "Bash", "input": { "command": "ls" } }] } }),
        json!({ "type": "user", "message": { "role": "user", "content": [{ "type": "tool_result", "tool_use_id": "t1", "content": "a b" }] } }),
        json!({ "type": "assistant", "isSidechain": true, "message": { "id": "s1", "content": [{ "type": "text", "text": "a subagent's line" }] } }),
        json!({ "type": "assistant", "message": { "id": "m3", "content": [{ "type": "thinking", "thinking": "more thoughts" }] } }),
        json!({ "type": "assistant", "message": { "id": "m3", "content": [{ "type": "text", "text": "Two files: **a** and b." }] } }),
        json!({ "type": "assistant", "message": { "id": "m3", "content": [{ "type": "text", "text": "Nothing else." }] } }),
        json!({ "type": "system", "subtype": "stop_hook_summary" }),
    ];
    let jsonl = lines
        .iter()
        .map(|l| l.to_string())
        .collect::<Vec<_>>()
        .join("\n")
        + "\nnot json\n";
    assert_eq!(
        transcript_answer(&jsonl).as_deref(),
        Some("Two files: **a** and b.\n\nNothing else.")
    );
    assert_eq!(
        transcript_answer(
            &lines[..3]
                .iter()
                .map(|l| l.to_string())
                .collect::<Vec<_>>()
                .join("\n")
        ),
        None,
        "the turn has no answer yet"
    );
    let dir = std::env::temp_dir().join(format!("trommi-mirror-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let f = dir.join("t.jsonl");
    std::fs::write(&f, &jsonl).unwrap();
    let got = final_answer(
        &json!({ "hook_event_name": "Stop", "transcript_path": f.display().to_string() }),
    );
    let _ = std::fs::remove_dir_all(&dir);
    assert_eq!(
        got.as_deref(),
        Some("Two files: **a** and b.\n\nNothing else.")
    );
    assert_eq!(
        final_answer(&json!({ "last_assistant_message": "  " })),
        None
    );
    assert_eq!(
        final_answer(&json!({ "transcript_path": "/nowhere/at/all.jsonl" })),
        None
    );
}

#[test]
fn an_answer_already_sent_with_reply_is_not_said_twice() {
    let long = "The deploy is through: three services restarted, the migration ran in 41 seconds and the smoke tests are green. ".repeat(3);
    let replies = vec![folded(&long)];
    assert!(
        !already_said(&long, &[]),
        "no reply in the turn: always mirrored"
    );
    assert!(!already_said("ok", &[]));
    assert!(
        already_said(&format!("  {}\n", long.replace(". ", ".\n")), &replies),
        "the same text, white space aside"
    );
    assert!(already_said(&long[..230], &replies), "part of the reply");
    assert!(
        already_said(&format!("{long}\n\nAnything else?"), &replies),
        "the reply and a line more"
    );
    assert!(
        already_said("Sent to the board.", &replies),
        "short chatter after a reply"
    );
    let other = "Something entirely different that the board has not seen yet, long enough to count as a real answer of its own. ".repeat(3);
    assert!(
        !already_said(&other, &replies),
        "a different, long answer is mirrored"
    );
}

#[test]
fn the_queue_keeps_the_order_and_knows_a_turn() {
    let m = Mirror::default();
    let input = |t: &str, id: &str| json!({ "op": "terminal", "kind": "input", "text": t, "prompt_id": id });
    let answer = |t: &str, id: &str| json!({ "op": "terminal", "kind": "answer", "text": t, "prompt_id": id });
    assert_eq!(
        m.accept(&input("how is it going?", "p1"), false)["queued"],
        json!(true)
    );
    assert_eq!(
        m.accept(&answer("All green.", "p1"), false)["queued"],
        json!(true)
    );
    assert_eq!(
        m.accept(&answer("All green.", "p1"), false)["why"],
        json!("said before"),
        "a hook that runs twice"
    );
    assert_eq!(
        m.accept(&input("how is it going?", "p1"), false)["why"],
        json!("said before")
    );
    assert_eq!(
        m.accept(&input("how is it going?", "p2"), false)["queued"],
        json!(true),
        "the same words in a new prompt are a new message"
    );
    let got: Vec<(&str, String)> = std::iter::from_fn(|| m.next())
        .map(|i| (i.kind, i.text))
        .collect();
    assert_eq!(
        got,
        vec![
            ("input", "how is it going?".to_string()),
            ("answer", "All green.".to_string()),
            ("input", "how is it going?".to_string())
        ]
    );
    // a reply in the turn: short chatter after it is left out; the next turn starts clean
    m.replied("Deployed, all green.");
    assert_eq!(
        m.accept(&answer("Sent.", "p2"), false)["why"],
        json!("already said with reply")
    );
    assert_eq!(
        m.accept(&answer("Sent!", "p3"), false)["queued"],
        json!(true),
        "the replies of the turn before are forgotten"
    );
    m.replied("Deployed, all green.");
    assert_eq!(
        m.accept(
            &json!({ "op": "terminal", "kind": "input", "text": null, "prompt_id": "p4" }),
            false
        )["why"],
        json!("nothing to mirror")
    );
    assert_eq!(
        m.accept(&answer("Done.", "p4"), false)["queued"],
        json!(true),
        "a prompt starts a turn, also one that is not mirrored"
    );
    assert_eq!(
        m.accept(
            &json!({ "op": "terminal", "kind": "tool", "text": "x" }),
            false
        )["ok"],
        json!(false)
    );
    // a prompt typed into the running turn (the same prompt_id) is his message too, and the turn keeps its replies
    m.replied("Deployed, all green.");
    assert_eq!(
        m.accept(&input("and the tests?", "p5"), true)["queued"],
        json!(true)
    );
    assert_eq!(
        m.accept(&answer("Sent.", "p5"), false)["why"],
        json!("already said with reply")
    );
    // the same words typed again into one turn, later, are said again; a hook run twice is not
    // (the queue's memory of what was said is its own: the test waits the window out instead of turning it back)
    std::thread::sleep(std::time::Duration::from_millis(TWICE_MS + 50));
    assert_eq!(
        m.accept(&input("and the tests?", "p5"), true)["queued"],
        json!(true)
    );
    assert_eq!(
        m.accept(&input("and the tests?", "p5"), true)["why"],
        json!("said before")
    );
    assert_eq!(
        m.accept(&answer("All green.", "p1"), false)["why"],
        json!("said before"),
        "an answer once per turn, whenever"
    );
    assert_eq!(m.next().map(|i| i.text).as_deref(), Some("Sent!"));
    assert_eq!(m.next().map(|i| i.text).as_deref(), Some("Done."));
    assert_eq!(m.drop_all(), 2);
    assert_eq!(m.waiting(), 0);
}

// ---- the cases of the former Node suite's mirror hooks, as library calls ------------------------------------------
// What a hook process hands its connector (`hook_request`) and what the connector's queue makes of it (`accept`).

const TOKEN: &str = "sk-live-MIRROR-0123456789abcdef";
/// UserPromptSubmit and Stop as Claude Code 2.1.286 sends them.
fn ups(prompt: &str, prompt_id: &str) -> Value {
    json!({ "session_id": "s1", "transcript_path": "/nowhere/s1.jsonl", "cwd": "/work/project", "prompt_id": prompt_id, "permission_mode": "default", "hook_event_name": "UserPromptSubmit", "prompt": prompt })
}
fn stop(last_assistant_message: &str, prompt_id: &str) -> Value {
    json!({ "session_id": "s1", "transcript_path": "/nowhere/s1.jsonl", "cwd": "/work/project", "prompt_id": prompt_id, "permission_mode": "default", "hook_event_name": "Stop", "stop_hook_active": false, "last_assistant_message": last_assistant_message, "background_tasks": [], "session_crons": [] })
}
/// A hook's input through the hook and into the queue: the queue's answer, or None when the hook said nothing.
fn hooked(m: &Mirror, kind: &str, input: &Value) -> Option<Value> {
    hook_request(kind, input, &[7]).map(|r| m.accept(&r, false))
}
/// What waits in the queue, taken out: (kind, text) in order.
fn drained(m: &Mirror) -> Vec<(&'static str, String)> {
    std::iter::from_fn(|| m.next())
        .map(|i| (i.kind, i.text))
        .collect()
}

#[test]
fn the_typed_prompt_and_the_final_answer_go_as_they_are_under_the_turns_prompt_id() {
    let prompt = "Is the deploy through?\n\nMy token is sk-live-123456789";
    let answer = "Yes: **three** services restarted.\n\n- api\n- web";
    let a = hook_request("prompt", &ups(prompt, "c771"), &[41, 7]).unwrap();
    let b = hook_request("stop", &stop(answer, "c771"), &[41, 7]).unwrap();
    assert_eq!(
        a,
        json!({ "op": "terminal", "kind": "input", "text": prompt, "prompt_id": "c771", "ancestors": [41, 7] }),
        "his words as he typed them: nothing is taken out of a prompt"
    );
    assert_eq!(
        b,
        json!({ "op": "terminal", "kind": "answer", "text": answer, "prompt_id": "c771", "ancestors": [41, 7] }),
        "markdown kept"
    );
    // a hook without a prompt_id (an older Claude Code) still speaks, the turn just has no name
    let mut old = ups("hello", "x");
    old.as_object_mut().unwrap().remove("prompt_id");
    assert_eq!(
        hook_request("prompt", &old, &[7]).unwrap()["prompt_id"],
        json!("")
    );
}

#[test]
fn what_claude_code_submits_by_itself_and_a_slash_command_start_a_turn_without_a_text() {
    for prompt in [
        "<task-notification>\n<task-id>b1</task-id>\n<summary>Monitor event: \"Trommi board events\"</summary>\n<event>Trommi · The human wrote on the board: \"Oh shit\" · call inbox</event>\n</task-notification>",
        "<channel source=\"trommi\" kind=\"chat\">\nPlease check the logs first.\n</channel>",
        "<channel source=\"trommi\" kind=\"chat\">\nfrom the board: and the database?\n</channel>",
        "<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n<summary>Agent \"Design\" finished</summary>\n</task-notification>",
        "/clear",
        "/mcp",
    ] {
        let r = hook_request("prompt", &ups(prompt, "c771"), &[7]).unwrap();
        assert_eq!(
            (r["kind"].as_str(), &r["text"], r["prompt_id"].as_str()),
            (Some("input"), &Value::Null, Some("c771")),
            "{prompt}"
        );
        assert!(!r.to_string().contains("Oh shit") && !r.to_string().contains("database"));
    }
}

#[test]
fn the_hook_names_the_pictures_folder_only_for_a_prompt_with_a_pasted_picture() {
    let with = |prompt: &str| {
        let mut i = ups(prompt, "c771");
        i["scratchpad_dir"] = json!("/work/cc/s1/scratchpad");
        hook_request("prompt", &i, &[7]).unwrap()
    };
    let r = with("[Image #1] what is this?");
    assert_eq!(
        (
            r["kind"].as_str(),
            r["text"].as_str(),
            r["pictures_dir"].as_str()
        ),
        (
            Some("input"),
            Some("[Image #1] what is this?"),
            Some("/work/cc/s1/images")
        ),
        "the mark stays in the hook's line: the connector takes it out when it has looked for the file"
    );
    let r = with("Is the deploy through?");
    assert_eq!(
        (r["text"].as_str(), r.get("pictures_dir")),
        (Some("Is the deploy through?"), None)
    );
    // what is not his typing names no folder either
    assert!(with("/clear [Image #1]").get("pictures_dir").is_none());
}

#[test]
fn a_subagents_turn_broken_input_and_a_mirror_switched_off_never_reach_the_connector() {
    let mut sub = stop("A helper found 3 issues.", "p6");
    sub["hook_event_name"] = json!("SubagentStop");
    sub["agent_id"] = json!("def456");
    sub["agent_type"] = json!("Explore");
    assert!(hook_request("stop", &sub, &[7]).is_none());
    let mut sub = ups("hello", "p6");
    sub["agent_id"] = json!("def456");
    assert!(hook_request("prompt", &sub, &[7]).is_none());
    // (stdin that is not JSON never gets here; what is JSON but no object says nothing)
    for broken in [Value::Null, json!("not json"), json!([]), json!(7)] {
        assert!(hook_request("prompt", &broken, &[7]).is_none(), "{broken}");
        assert!(hook_request("stop", &broken, &[7]).is_none(), "{broken}");
    }
    for off in ["off", "0", "false", "no"] {
        assert_eq!(level_of(off), Level::Off, "{off}");
    }
}

#[test]
fn a_turn_without_words_ends_without_a_text_and_a_long_answer_is_cut_with_a_note() {
    let r = hook_request("stop", &stop("", "c771"), &[7]).unwrap();
    assert_eq!(
        (r["kind"].as_str(), &r["text"], r["prompt_id"].as_str()),
        (Some("answer"), &Value::Null, Some("c771")),
        "the end of the turn is still told"
    );
    let r = hook_request("stop", &stop(&"ä".repeat(40_000), "c771"), &[7]).unwrap();
    let text = r["text"].as_str().unwrap();
    assert!(
        text.len() <= 24_000 && text.ends_with("(cut here: the terminal has the rest)"),
        "cut to 24 kB with a note: {}",
        text.len()
    );
    // and the queue takes a stop without words as the turn's end: nothing is queued
    let m = Mirror::default();
    assert_eq!(
        hooked(&m, "stop", &stop("", "c771")).unwrap()["why"],
        json!("nothing to mirror")
    );
    assert_eq!(m.waiting(), 0);
}

#[test]
fn a_turn_is_his_prompt_then_the_answer_and_a_board_message_in_the_terminal_is_not_mirrored_back() {
    let m = Mirror::default();
    let prompt = format!("Is the deploy through?\n\nMy token is {TOKEN}");
    let answer = "Yes: **three** services restarted.\n\n- api\n- web";
    assert_eq!(
        hooked(&m, "prompt", &ups(&prompt, "p1")).unwrap()["queued"],
        json!(true)
    );
    assert_eq!(
        hooked(&m, "stop", &stop(answer, "p1")).unwrap()["queued"],
        json!(true)
    );
    assert_eq!(
        drained(&m),
        vec![("input", prompt), ("answer", answer.to_string())]
    );
    // as Claude Code submits them to the session (and runs UserPromptSubmit on): the monitor's line, a channel
    // event, a slash command; then the agent's answer to the board message
    for p in [
        "<task-notification>\n<task-id>b1</task-id>\n<summary>Monitor event: \"Trommi board events\"</summary>\n<event>Trommi · The human wrote on the board: \"Oh shit\" · call inbox</event>\n</task-notification>",
        "<channel source=\"trommi\" kind=\"chat\">\nfrom the board: and the database?\n</channel>",
        "/mcp",
    ] {
        let a = hooked(&m, "prompt", &ups(p, "p2")).unwrap();
        assert_eq!(
            (&a["queued"], &a["why"]),
            (&json!(false), &json!("nothing to mirror")),
            "{p}"
        );
    }
    assert_eq!(
        hooked(&m, "stop", &stop("The database migrated in 41 s.", "p2")).unwrap()["queued"],
        json!(true)
    );
    assert_eq!(
        drained(&m),
        vec![("answer", "The database migrated in 41 s.".to_string())],
        "one new line: the answer"
    );
}

#[test]
fn after_a_reply_the_same_answer_and_short_chatter_are_left_out_and_the_next_turn_is_mirrored() {
    let m = Mirror::default();
    let long = "The rollout is finished: three services restarted one after another, the migration ran in 41 seconds, the smoke tests are green and the old pods are gone. Nothing is left for you to do, the dashboards look calm and the error rate is where it was before.";
    hooked(&m, "prompt", &ups("roll it out", "p3")).unwrap();
    m.replied(long);
    assert_eq!(
        hooked(&m, "stop", &stop(&format!("{long}\n"), "p3")).unwrap()["why"],
        json!("already said with reply")
    );
    hooked(&m, "prompt", &ups("thanks", "p4")).unwrap();
    m.replied("You are welcome.");
    assert_eq!(
        hooked(&m, "stop", &stop("Sent to the board.", "p4")).unwrap()["why"],
        json!("already said with reply")
    );
    hooked(&m, "prompt", &ups("and now?", "p5")).unwrap();
    assert_eq!(
        hooked(&m, "stop", &stop("Done.", "p5")).unwrap()["queued"],
        json!(true)
    );
    assert_eq!(
        drained(&m),
        vec![
            ("input", "roll it out".to_string()),
            ("input", "thanks".to_string()),
            ("input", "and now?".to_string()),
            ("answer", "Done.".to_string())
        ]
    );
}

#[test]
fn a_subagents_stop_and_a_hook_that_runs_twice_add_nothing() {
    let m = Mirror::default();
    let mut sub = stop("A helper found 3 issues.", "p6");
    sub["hook_event_name"] = json!("SubagentStop");
    sub["agent_id"] = json!("def456");
    sub["agent_type"] = json!("Explore");
    assert!(hooked(&m, "stop", &sub).is_none());
    assert_eq!(
        hooked(&m, "prompt", &ups("twice?", "p7")).unwrap()["queued"],
        json!(true)
    );
    assert_eq!(
        hooked(&m, "prompt", &ups("twice?", "p7")).unwrap()["why"],
        json!("said before")
    );
    assert_eq!(
        hooked(&m, "stop", &stop("Once.", "p7")).unwrap()["queued"],
        json!(true)
    );
    assert_eq!(
        hooked(&m, "stop", &stop("Once.", "p7")).unwrap()["why"],
        json!("said before")
    );
    assert_eq!(
        drained(&m),
        vec![
            ("input", "twice?".to_string()),
            ("answer", "Once.".to_string())
        ]
    );
}

/// A real picture: a PNG of one pixel.
const DOT_PNG: [u8; 70] = [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0xda, 0x63, 0x64, 0x60, 0xf8, 0x5f,
    0x0f, 0x00, 0x02, 0x87, 0x01, 0x80, 0xeb, 0x47, 0xba, 0x92, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
    0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
];

#[test]
fn a_picture_pasted_into_the_terminal_rides_with_his_message_and_a_lost_one_leaves_a_neutral_mark()
{
    // Claude Code 2.1.286 keeps a pasted picture as images/<n>.png beside the session's scratchpad and puts
    // "[Image #n]" into the prompt. The connector runs before the picture is pasted.
    let m = Mirror::default();
    let cc =
        std::env::temp_dir().join(format!("trommi-pasted-{}-{}", std::process::id(), now_ms()));
    std::fs::create_dir_all(cc.join("images")).unwrap();
    let png = cc.join("images").join("1.png");
    std::fs::write(&png, DOT_PNG).unwrap();
    let pasted = |prompt: &str, id: &str| {
        let mut i = ups(prompt, id);
        i["scratchpad_dir"] = json!(cc.join("scratchpad").to_str().unwrap());
        i
    };
    let a = hooked(
        &m,
        "prompt",
        &pasted("[Image #1] what is in this picture?", "p13"),
    )
    .unwrap();
    assert_eq!((&a["queued"], &a["pictures"]), (&json!(true), &json!(1)));
    hooked(&m, "stop", &stop("A dot.", "p13")).unwrap();
    hooked(&m, "prompt", &pasted("[Image #1]", "p14")).unwrap();
    hooked(&m, "prompt", &pasted("and [Image #7] here", "p15")).unwrap();
    hooked(&m, "prompt", &ups("[Image #1] without a folder", "p16")).unwrap();
    hooked(&m, "stop", &stop("Fine.", "p16")).unwrap();
    let items: Vec<Item> = std::iter::from_fn(|| m.next()).collect();
    let _ = std::fs::remove_dir_all(&cc);
    let file = png.to_str().unwrap().to_string();
    assert_eq!(
        items
            .iter()
            .filter(|i| i.kind == "input")
            .map(|i| (i.text.as_str(), i.pictures.clone()))
            .collect::<Vec<_>>(),
        vec![
            ("what is in this picture?", vec![file.clone()]),
            ("", vec![file]),
            ("and (picture, only in the terminal) here", vec![]),
            ("(picture, only in the terminal) without a folder", vec![]),
        ]
    );
    assert_eq!(
        items.iter().map(|i| i.kind).collect::<Vec<_>>(),
        ["input", "answer", "input", "input", "input", "answer"]
    );
    assert!(
        !items.iter().any(|i| i.text.contains("[Image #")),
        "the raw mark never goes to the chat"
    );
}
