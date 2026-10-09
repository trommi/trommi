//! The trail of a terminal turn (connector/src/trail.rs): what a trail hook takes from its input at each level, what
//! is redacted, and how the connector coalesces the steps of a turn. Then the permission hooks' pure pieces
//! (connector/src/hooks.rs). Library calls only, no hub.
use serde_json::{json, Value};
use trommi_connector::mirror::Level;
use trommi_connector::trail::*;

fn pre(id: &str, tool: &str, input: Value) -> Value {
    json!({ "hook_event_name": "PreToolUse", "cwd": "/home/me/p", "tool_name": tool, "tool_input": input, "tool_use_id": id, "session_id": "s", "prompt_id": "p" })
}
fn line(input: &Value, level: Level) -> Value {
    hook_request(input, &[7], level).unwrap()
}
fn has(v: &Value, what: &str) -> bool {
    v.to_string().contains(what)
}

#[test]
fn the_hooks_read_claude_codes_inputs_at_the_level_steps() {
    // as Claude Code 2.1.286 sends them
    let bash = pre(
        "toolu_01",
        "Bash",
        json!({ "command": "curl -H 'Authorization: Bearer abcdefgh12345678' https://x.example/y", "description": "Fetch the\nstatus page" }),
    );
    let r = line(&bash, Level::Steps);
    assert_eq!(
        r,
        json!({ "op": "terminal", "kind": "trail", "ev": "pre", "ancestors": [7], "id": "toolu_01", "tool": "Bash", "title": "Fetch the status page", "prompt": "p" })
    );
    assert!(
        !has(&r, "curl") && !has(&r, "Bearer"),
        "no command line at the level steps"
    );
    let r = line(
        &pre(
            "t2",
            "Read",
            json!({ "file_path": "/home/me/p/src/main.rs", "limit": 20 }),
        ),
        Level::Steps,
    );
    assert_eq!(
        (r["tool"].as_str(), r["subject"].as_str(), r.get("title")),
        (Some("Read"), Some("src/main.rs"), None)
    );
    let r = line(
        &pre(
            "t3",
            "Edit",
            json!({ "file_path": "/etc/hosts", "old_string": "SECRET-OLD", "new_string": "SECRET-NEW" }),
        ),
        Level::Steps,
    );
    assert_eq!(r["subject"], json!("/etc/hosts"));
    assert!(!has(&r, "SECRET"), "no file content at the level steps");
    let r = line(
        &pre(
            "t4",
            "Write",
            json!({ "file_path": "/home/me/p/.env", "content": "TOKEN=abc" }),
        ),
        Level::Steps,
    );
    assert!(r["subject"] == json!(".env") && !has(&r, "abc"));
    assert_eq!(
        line(
            &pre(
                "t5",
                "Grep",
                json!({ "pattern": "fn main", "path": "/home/me/p/src" })
            ),
            Level::Steps
        )["subject"],
        json!("fn main in src")
    );
    assert_eq!(
        line(
            &pre(
                "t6",
                "WebSearch",
                json!({ "query": "rust regex lookahead" })
            ),
            Level::Steps
        )["subject"],
        json!("rust regex lookahead")
    );
    assert_eq!(
        line(
            &pre(
                "t7",
                "WebFetch",
                json!({ "url": "https://me:pw@api.example.com/v1/items?token=SECRET#x", "prompt": "what" })
            ),
            Level::Steps
        )["subject"],
        json!("https://api.example.com/v1/items")
    );
    let r = line(
        &pre(
            "t8",
            "Agent",
            json!({ "description": "Count files", "prompt": "SECRET prompt", "subagent_type": "Explore" }),
        ),
        Level::Steps,
    );
    assert_eq!(
        (r["title"].as_str(), r["subject"].as_str()),
        (Some("Count files"), Some("Explore"))
    );
    assert!(!has(&r, "SECRET"));
    let r = line(
        &pre(
            "t9",
            "mcp__github__create_issue",
            json!({ "title": "SECRET", "body": "SECRET" }),
        ),
        Level::Steps,
    );
    assert!(
        r["tool"] == json!("github: create_issue")
            && r.get("subject").is_none()
            && !has(&r, "SECRET"),
        "another tool's arguments never"
    );
    // the board's own tools are no steps; a helper's session name is read from them
    let r = line(
        &pre(
            "t10",
            "mcp__plugin_trommi_trommi__reply",
            json!({ "text": "SECRET", "session": "Design" }),
        ),
        Level::Steps,
    );
    assert!(r["board"] == json!(true) && r["session"] == json!("Design") && !has(&r, "SECRET"));
    // results: the state and the time, nothing of the output
    let post = json!({ "hook_event_name": "PostToolUse", "tool_name": "Bash", "tool_input": { "command": "ls", "description": "List" }, "tool_use_id": "toolu_01", "tool_response": { "stdout": "SECRET-OUT", "stderr": "", "interrupted": false }, "duration_ms": 6, "agent_id": "ad4d", "agent_type": "Explore" });
    let r = line(&post, Level::Steps);
    assert_eq!(
        r,
        json!({ "op": "terminal", "kind": "trail", "ev": "post", "ancestors": [7], "id": "toolu_01", "tool": "Bash", "title": "List", "ms": 6, "agent": "ad4d", "agent_type": "Explore" })
    );
    let fail = json!({ "hook_event_name": "PostToolUseFailure", "tool_name": "Bash", "tool_input": { "command": "ls /x" }, "tool_use_id": "t11", "error": "Exit code 2\nls: SECRET-ERR", "is_interrupt": true, "duration_ms": 29 });
    let r = line(&fail, Level::Steps);
    assert!(
        r["ev"] == json!("fail")
            && r["interrupt"] == json!(true)
            && r["ms"] == json!(29)
            && !has(&r, "SECRET")
    );
    // the agent's words between steps, a helper's start and end, the session's end, an API error
    let say = json!({ "hook_event_name": "MessageDisplay", "message_id": "m1", "turn_id": "u1", "index": 0, "final": true, "delta": "I will read the file." });
    assert_eq!(
        line(&say, Level::Steps),
        json!({ "op": "terminal", "kind": "trail", "ev": "say", "ancestors": [7], "msg": "m1", "text": "I will read the file.", "final": true })
    );
    let r = line(
        &json!({ "hook_event_name": "SubagentStart", "agent_id": "ad4d", "agent_type": "Explore", "task_description": "Count files" }),
        Level::Steps,
    );
    assert_eq!(
        (
            r["ev"].as_str(),
            r["agent"].as_str(),
            r["agent_type"].as_str(),
            r["title"].as_str()
        ),
        (
            Some("agent_start"),
            Some("ad4d"),
            Some("Explore"),
            Some("Count files")
        )
    );
    let stop = json!({ "hook_event_name": "SubagentStop", "agent_id": "ad4d", "agent_type": "Explore", "last_assistant_message": "SECRET report" });
    assert!(
        line(&stop, Level::Steps)["ev"] == json!("agent_stop")
            && !has(&line(&stop, Level::Steps), "SECRET")
    );
    assert_eq!(
        line(
            &json!({ "hook_event_name": "SessionEnd", "reason": "other" }),
            Level::Steps
        )["ev"],
        json!("end")
    );
    assert_eq!(
        line(
            &json!({ "hook_event_name": "StopFailure", "error_type": "rate_limit" }),
            Level::Steps
        )["ev"],
        json!("error")
    );
    // nothing below the level steps, and nothing from what is not understood
    for level in [Level::Off, Level::Answers] {
        assert!(hook_request(&bash, &[7], level).is_none());
    }
    assert!(
        hook_request(
            &json!({ "hook_event_name": "PreToolUse", "tool_name": "Bash" }),
            &[7],
            Level::Full
        )
        .is_none(),
        "no tool_use_id"
    );
    assert!(hook_request(
        &json!({ "hook_event_name": "PreCompact" }),
        &[7],
        Level::Full
    )
    .is_none());
    assert!(hook_request(
        &json!({ "hook_event_name": "SubagentStop" }),
        &[7],
        Level::Full
    )
    .is_none());
    assert!(hook_request(&Value::Null, &[7], Level::Full).is_none());
}

#[test]
fn the_level_full_adds_inputs_and_outputs_cut_and_redacted() {
    let r = line(
        &pre(
            "t1",
            "Bash",
            json!({ "command": "curl -H 'Authorization: Bearer abcdefgh12345678' https://x.example/y", "description": "Fetch" }),
        ),
        Level::Full,
    );
    assert_eq!(r["input"], json!("curl -H 'Authorization: …"));
    let r = line(
        &pre(
            "t2",
            "Edit",
            json!({ "file_path": "/home/me/p/a.rs", "old_string": "let a = 1;\nlet b = 2;", "new_string": "let a = 3;" }),
        ),
        Level::Full,
    );
    assert_eq!(
        r["input"],
        json!("/home/me/p/a.rs  −2 +1 lines\n- let a = 1;\n- let b = 2;\n+ let a = 3;")
    );
    let r = line(
        &pre(
            "t3",
            "Write",
            json!({ "file_path": "/home/me/p/.env", "content": "API_TOKEN=abc123\nNAME=web\n" }),
        ),
        Level::Full,
    );
    assert_eq!(
        r["input"],
        json!("/home/me/p/.env  2 lines\nAPI_TOKEN=…\nNAME=web")
    );
    assert_eq!(
        line(
            &pre(
                "t4",
                "Read",
                json!({ "file_path": "/a/b.rs", "offset": 10, "limit": 5 })
            ),
            Level::Full
        )["input"],
        json!("/a/b.rs  lines 10–15")
    );
    let long = (1..=2000)
        .map(|i| format!("line {i}"))
        .collect::<Vec<_>>()
        .join("\n");
    let post = json!({ "hook_event_name": "PostToolUse", "tool_name": "Bash", "tool_input": { "command": "seq" }, "tool_use_id": "t5", "tool_response": { "stdout": long, "stderr": "warn: password=hunter2", "interrupted": false } });
    let out = line(&post, Level::Full)["output"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(
        out.len() <= OUTPUT_MAX + 40
            && out.starts_with("line 1\nline 2\n")
            && out.ends_with("warn: password=…"),
        "{}",
        out.len()
    );
    // "\n… (N more lines) …\n" between the head and the tail
    let (_, after) = out
        .split_once("\n… (")
        .expect("a line that says what is left out");
    let (count, _) = after
        .split_once(" more lines) …\n")
        .expect("the count of the lines left out");
    assert!(
        !count.is_empty() && count.chars().all(|c| c.is_ascii_digit()),
        "{count}"
    );
    let read = json!({ "hook_event_name": "PostToolUse", "tool_name": "Read", "tool_input": { "file_path": "/a" }, "tool_use_id": "t6", "tool_response": { "type": "text", "file": { "filePath": "/a", "content": "hello file\n" } } });
    assert_eq!(line(&read, Level::Full)["output"], json!("hello file"));
    let fail = json!({ "hook_event_name": "PostToolUseFailure", "tool_name": "Bash", "tool_input": { "command": "ls /x" }, "tool_use_id": "t7", "error": "Exit code 2\nls: cannot access '/x'" });
    assert_eq!(
        line(&fail, Level::Full)["output"],
        json!("Exit code 2\nls: cannot access '/x'")
    );
    let stop = json!({ "hook_event_name": "SubagentStop", "agent_id": "ad4d", "last_assistant_message": "Found 5 files." });
    assert_eq!(line(&stop, Level::Full)["output"], json!("Found 5 files."));
    // a board tool's arguments are on the board already, never in the trail
    let r = line(
        &pre("t8", "mcp__trommi__reply", json!({ "text": "hello" })),
        Level::Full,
    );
    assert!(r.get("input").is_none() && r["board"] == json!(true));
    // one huge line
    let one = "x ".repeat(20_000);
    let e = excerpt(&one, 1000);
    assert!(
        e.len() < 1100 && e.contains("more characters) …"),
        "{}",
        e.len()
    );
    assert_eq!(excerpt("short\n", 1000), "short");
}

#[test]
fn what_looks_like_a_secret_is_taken_out() {
    for (text, want) in [
        ("export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwx", "export GITHUB_TOKEN=…"),
        ("AWS_SECRET_ACCESS_KEY=\"wJalr/XUtn+FEMI\" next", "AWS_SECRET_ACCESS_KEY=… next"),
        ("DB_PASSWORD='p w' PORT=8080", "DB_PASSWORD=… PORT=8080"),
        ("{\"api_key\": \"abc\", \"name\": \"web\"}", "{\"api_key\": …, \"name\": \"web\"}"),
        ("password: hunter2", "password: …"),
        ("mytool --token abc123 --verbose", "mytool --token … --verbose"),
        ("mytool --api-key=abc123 run", "mytool --api-key=… run"),
        ("Authorization: Bearer abc.def.ghi\nAccept: */*", "Authorization: …\nAccept: */*"),
        ("curl -H \"X-Api-Key: 12345\" -H 'Cookie: sid=1; x=2' https://a.example", "curl -H \"X-Api-Key: …"),
        ("git clone https://me:hunter2@github.com/a/b.git", "git clone https://…@github.com/a/b.git"),
        ("token sk-abcdefgh12345678 and AKIAABCDEFGHIJKLMNOP", "token … and …"),
        ("sha 0123456789abcdef0123456789abcdef01234567 ok", "sha … ok"),
        ("-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNz\nAAAA\n-----END OPENSSH PRIVATE KEY-----\nafter", "-----BEGIN PRIVATE KEY----- … -----END PRIVATE KEY-----\nafter"),
        ("-----BEGIN RSA PRIVATE KEY-----\nMIIE cut off", "-----BEGIN PRIVATE KEY----- … -----END PRIVATE KEY-----"),
    ] {
        assert_eq!(redact(text), want, "{text}");
    }
    // and what stays: paths, plain words, short values, ordinary assignments
    for text in [
        "/home/me/git/trommi/connector-rs/src/connector/trail.rs",
        "the key is under the mat",
        "PORT=8080 NODE_ENV=production",
        "let total = a + b;",
        "cargo test --release -- --nocapture",
    ] {
        assert_eq!(redact(text), text);
    }
}

fn ev(v: Value) -> Value {
    let mut o = v.as_object().cloned().unwrap();
    o.insert("op".into(), json!("terminal"));
    o.insert("kind".into(), json!("trail"));
    Value::Object(o)
}
/// A client's view: the envelopes of a turn folded, items by id in the order they first came.
fn folded_turns(envs: &[Envelope]) -> Vec<(Option<String>, Value)> {
    let mut out: Vec<(Option<String>, Value)> = vec![];
    for e in envs {
        let w = &e.work;
        let at = match out.iter().position(|(_, t)| t["turn"] == w["turn"]) {
            Some(i) => i,
            None => {
                out.push((
                    e.target.clone(),
                    json!({ "turn": w["turn"], "items": [], "seq": 0 }),
                ));
                out.len() - 1
            }
        };
        let t = &mut out[at].1;
        assert_eq!(
            w["seq"].as_u64().unwrap(),
            t["seq"].as_u64().unwrap() + 1,
            "the envelopes of a turn are numbered"
        );
        for k in ["seq", "state", "started_at", "ended_at", "more"] {
            if let Some(v) = w.get(k) {
                t[k] = v.clone();
            }
        }
        for item in w["items"].as_array().unwrap() {
            let items = t["items"].as_array_mut().unwrap();
            match items.iter().position(|x| x["id"] == item["id"]) {
                Some(i) => items[i] = item.clone(),
                None => items.push(item.clone()),
            }
        }
    }
    out
}
fn brief(t: &Value) -> Vec<String> {
    t["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| {
            format!(
                "{} {} {}",
                i["kind"].as_str().unwrap(),
                i.get("tool")
                    .or(i.get("text"))
                    .and_then(|v| v.as_str())
                    .unwrap_or(""),
                i.get("state").and_then(|v| v.as_str()).unwrap_or("")
            )
            .trim()
            .to_string()
        })
        .collect()
}

#[test]
fn a_turn_is_one_trail_in_few_envelopes() {
    let mut t = Trail::default();
    let mut sent: Vec<Envelope> = vec![];
    t.prompt("", 1_000);
    assert!(
        !t.dirty() && t.flush().is_empty(),
        "a prompt alone sends nothing"
    );
    t.event(
        &ev(json!({ "ev": "say", "msg": "m1", "text": "I will ", "final": false })),
        1_100,
    );
    t.event(
        &ev(json!({ "ev": "say", "msg": "m1", "text": "read the file.", "final": true })),
        1_200,
    );
    assert!(!t.dirty(), "the last words wait: they may be the answer");
    t.event(
        &ev(json!({ "ev": "pre", "id": "s1", "tool": "Read", "subject": "a.txt" })),
        1_300,
    );
    assert!(t.dirty());
    sent.extend(t.flush());
    assert_eq!(sent.len(), 1);
    assert_eq!(
        sent[0].work["items"],
        json!([{ "id": "say:1", "kind": "text", "text": "I will read the file.", "at": 1_300 }, { "id": "s1", "kind": "step", "state": "running", "at": 1_300, "tool": "Read", "subject": "a.txt" }])
    );
    assert_eq!(
        (
            sent[0].work["state"].as_str(),
            sent[0].work["started_at"].as_u64(),
            sent[0].work["seq"].as_u64(),
            sent[0].target.clone()
        ),
        (Some("running"), Some(1_000), Some(1), None)
    );
    // many steps between two flushes are one envelope
    t.event(
        &ev(json!({ "ev": "post", "id": "s1", "tool": "Read", "ms": 6 })),
        1_310,
    );
    for i in 0..40 {
        t.event(
            &ev(json!({ "ev": "pre", "id": format!("b{i}"), "tool": "Bash", "title": "Run" })),
            1_400 + i,
        );
        t.event(&ev(json!({ "ev": if i == 7 { "fail" } else { "post" }, "id": format!("b{i}"), "tool": "Bash", "ms": 20 })), 1_420 + i);
    }
    let more = t.flush();
    assert_eq!(more.len(), 1, "coalesced");
    assert_eq!(
        more[0].work["items"].as_array().unwrap().len(),
        41,
        "the changed step and the new ones, each once"
    );
    sent.extend(more);
    assert!(!t.dirty() && t.flush().is_empty());
    // the final answer is not a text of the trail
    t.event(
        &ev(json!({ "ev": "say", "msg": "m2", "text": "All  done.\n", "final": true })),
        2_000,
    );
    t.answer("", Some("All done."), 2_100);
    sent.extend(t.flush());
    let turns = folded_turns(&sent);
    assert_eq!(turns.len(), 1);
    let turn = &turns[0].1;
    assert_eq!(
        (
            turn["state"].as_str(),
            turn["ended_at"].as_u64(),
            turn["seq"].as_u64()
        ),
        (Some("done"), Some(2_100), Some(3))
    );
    let b = brief(turn);
    assert_eq!(b.len(), 42);
    assert_eq!(
        &b[..3],
        ["text I will read the file.", "step Read ok", "step Bash ok"]
    );
    assert_eq!(b[9], "step Bash failed");
    assert!(
        !sent.iter().any(|e| e.work.to_string().contains("All done")),
        "the answer goes as its own message"
    );
    // the answer's own words, brought late by their hook, open nothing
    t.event(
        &ev(json!({ "ev": "say", "msg": "m2b", "text": "All done.", "final": true })),
        2_150,
    );
    t.prompt("", 2_900);
    assert!(t.flush().is_empty());
    // a turn without a step sends nothing at all
    t.prompt("", 3_000);
    t.event(
        &ev(json!({ "ev": "say", "msg": "m3", "text": "Hello.", "final": true })),
        3_100,
    );
    t.answer("", Some("Hello."), 3_200);
    assert!(t.flush().is_empty());
    // words that are not the answer stand in the trail
    t.prompt("", 4_000);
    t.event(
        &ev(json!({ "ev": "say", "msg": "m4", "text": "Something else.", "final": true })),
        4_100,
    );
    t.answer("", Some("The answer."), 4_200);
    let last = t.flush();
    assert_eq!(brief(&folded_turns(&last)[0].1), ["text Something else."]);
}

#[test]
fn a_turn_that_breaks_off_is_closed_as_interrupted() {
    // Esc fires no hook (Claude Code 2.1.286): the next prompt, which has another prompt_id, closes the turn.
    // When it broke off nobody knows: no ended_at.
    let mut t = Trail::default();
    assert!(!t.prompt("p1", 1_000));
    t.event(
        &ev(json!({ "ev": "pre", "id": "s1", "tool": "Bash", "title": "Sleep", "prompt": "p1" })),
        1_100,
    );
    let mut sent = t.flush();
    t.event(&ev(json!({ "ev": "say", "msg": "m1", "text": "Half a thought", "final": true, "prompt": "p1" })), 1_200);
    assert!(!t.prompt("p2", 5_000), "a prompt of another turn");
    sent.extend(t.flush());
    let turn = &folded_turns(&sent)[0].1;
    assert_eq!(
        (turn["state"].as_str(), turn.get("ended_at")),
        (Some("interrupted"), None)
    );
    assert_eq!(
        brief(turn),
        ["step Bash interrupted", "text Half a thought"]
    );
    // a step that says it was interrupted (is_interrupt) closes the turn at once, with the time
    t.event(
        &ev(json!({ "ev": "pre", "id": "s2", "tool": "Bash", "prompt": "p2" })),
        5_100,
    );
    t.event(&ev(json!({ "ev": "fail", "id": "s2", "tool": "Bash", "interrupt": true, "ms": 900, "prompt": "p2" })), 6_000);
    let turn = &folded_turns(&t.flush())[0].1;
    assert_eq!(
        (
            turn["state"].as_str(),
            turn["started_at"].as_u64(),
            turn["ended_at"].as_u64(),
            brief(turn)
        ),
        (
            Some("interrupted"),
            Some(5_000),
            Some(6_000),
            vec!["step Bash interrupted".to_string()]
        )
    );
    // the session ends, an API error ends the turn
    t.prompt("p3", 7_000);
    t.event(
        &ev(json!({ "ev": "pre", "id": "s3", "tool": "Read", "prompt": "p3" })),
        7_100,
    );
    t.event(&ev(json!({ "ev": "end" })), 7_200);
    assert_eq!(folded_turns(&t.flush())[0].1["state"], json!("interrupted"));
    t.prompt("p4", 8_000);
    t.event(
        &ev(json!({ "ev": "pre", "id": "s4", "tool": "Read", "prompt": "p4" })),
        8_100,
    );
    t.event(
        &ev(json!({ "ev": "post", "id": "s4", "tool": "Read", "prompt": "p4" })),
        8_150,
    );
    t.event(&ev(json!({ "ev": "error", "prompt": "p4" })), 8_200);
    let turn = &folded_turns(&t.flush())[0].1;
    assert_eq!(
        (turn["state"].as_str(), brief(turn)),
        (Some("failed"), vec!["step Read ok".to_string()])
    );
    // a session's end with nothing open sends nothing
    t.event(&ev(json!({ "ev": "end" })), 9_000);
    assert!(t.flush().is_empty());
    // a turn broken off while a queued prompt's turn starts without a UserPromptSubmit of its own: the first
    // step with another prompt_id closes it
    t.prompt("p5", 10_000);
    t.event(
        &ev(json!({ "ev": "pre", "id": "s5", "tool": "Read", "prompt": "p5" })),
        10_100,
    );
    t.event(
        &ev(json!({ "ev": "pre", "id": "s6", "tool": "Read", "prompt": "p6" })),
        11_000,
    );
    let turns = folded_turns(&t.flush());
    assert_eq!(turns.len(), 2);
    assert_eq!(
        (
            turns[0].1["state"].as_str(),
            turns[1].1["state"].as_str(),
            turns[1].1["started_at"].as_u64()
        ),
        (Some("interrupted"), Some("running"), Some(11_000))
    );
}

#[test]
fn a_prompt_typed_while_a_turn_runs_does_not_end_its_trail() {
    // As Claude Code 2.1.286 fires them: the prompt typed during the first command comes at once, with the
    // running turn's prompt_id; the turn goes on to its Stop.
    let mut t = Trail::default();
    assert!(!t.prompt("p1", 1_000));
    t.event(
        &ev(json!({ "ev": "pre", "id": "s1", "tool": "Bash", "title": "First", "prompt": "p1" })),
        1_100,
    );
    let mut sent = t.flush();
    assert!(
        t.prompt("p1", 4_000),
        "the same prompt_id: it came into the running turn"
    );
    assert!(t.flush().is_empty(), "and changes nothing in the trail");
    t.event(
        &ev(json!({ "ev": "post", "id": "s1", "tool": "Bash", "ms": 7_000, "prompt": "p1" })),
        8_100,
    );
    t.event(
        &ev(json!({ "ev": "pre", "id": "s2", "tool": "Bash", "title": "Second", "prompt": "p1" })),
        8_200,
    );
    t.event(&ev(json!({ "ev": "fail", "id": "s2", "tool": "Bash", "ms": 17, "exit": 1, "prompt": "p1" })), 8_300);
    t.answer("p1", Some("Done."), 9_000);
    sent.extend(t.flush());
    let turns = folded_turns(&sent);
    assert_eq!(turns.len(), 1, "one turn, one trail");
    let turn = &turns[0].1;
    assert_eq!(
        (
            turn["state"].as_str(),
            turn["started_at"].as_u64(),
            turn["ended_at"].as_u64()
        ),
        (Some("done"), Some(1_000), Some(9_000))
    );
    assert_eq!(brief(turn), ["step Bash ok", "step Bash failed"]);
    assert_eq!(
        turn["items"][1]["exit"],
        json!(1),
        "a command's exit code stands on its step"
    );
    assert!(turn["items"][0].get("exit").is_none());
    // typed while the last words stream: the hook has the old turn's id, that turn stops, and the queued prompt
    // runs as a turn of its own with a new id and no UserPromptSubmit
    assert!(!t.prompt("p2", 10_000));
    t.event(
        &ev(json!({ "ev": "pre", "id": "s3", "tool": "Read", "prompt": "p2" })),
        10_100,
    );
    assert!(t.prompt("p2", 10_200));
    t.event(
        &ev(json!({ "ev": "post", "id": "s3", "tool": "Read", "prompt": "p2" })),
        10_300,
    );
    t.answer("p2", Some("An essay."), 11_000);
    t.event(&ev(json!({ "ev": "say", "msg": "m9", "text": "Late words of the turn that is over.", "final": true, "prompt": "p2" })), 11_050);
    t.event(
        &ev(json!({ "ev": "pre", "id": "s4", "tool": "Read", "prompt": "p3" })),
        11_100,
    );
    t.event(
        &ev(json!({ "ev": "post", "id": "s4", "tool": "Read", "prompt": "p3" })),
        11_200,
    );
    t.answer("p3", Some("Was that a typo?"), 12_000);
    let turns = folded_turns(&t.flush());
    assert_eq!(
        turns
            .iter()
            .map(|(_, w)| (
                w["state"].as_str().unwrap(),
                w["started_at"].as_u64().unwrap(),
                brief(w)
            ))
            .collect::<Vec<_>>(),
        vec![
            ("done", 10_000, vec!["step Read ok".to_string()]),
            ("done", 11_100, vec!["step Read ok".to_string()])
        ]
    );
    // a step's end that comes after Stop (its hook is async) still lands on its step
    assert!(!t.prompt("p4", 20_000));
    t.event(
        &ev(json!({ "ev": "pre", "id": "s5", "tool": "Read", "prompt": "p4" })),
        20_100,
    );
    t.answer("p4", Some("Read."), 20_200);
    let mut sent = t.flush();
    t.event(
        &ev(json!({ "ev": "post", "id": "s5", "tool": "Read", "ms": 5, "prompt": "p4" })),
        20_210,
    );
    sent.extend(t.flush());
    let turn = &folded_turns(&sent)[0].1;
    assert_eq!(
        (turn["state"].as_str(), brief(turn)),
        (Some("done"), vec!["step Read ok".to_string()])
    );
    // a Stop hook that sends the agent back to work: the turn runs on under its id, and ends again
    t.event(
        &ev(json!({ "ev": "pre", "id": "s6", "tool": "Bash", "prompt": "p4" })),
        21_000,
    );
    sent.extend(t.flush());
    assert_eq!(folded_turns(&sent)[0].1["state"], json!("running"));
    t.event(
        &ev(json!({ "ev": "post", "id": "s6", "tool": "Bash", "prompt": "p4" })),
        21_100,
    );
    t.answer("p4", Some("Now really."), 21_200);
    sent.extend(t.flush());
    let turns = folded_turns(&sent);
    assert_eq!(
        (
            turns.len(),
            turns[0].1["state"].as_str(),
            turns[0].1["ended_at"].as_u64(),
            brief(&turns[0].1).len()
        ),
        (1, Some("done"), Some(21_200), 2)
    );
}

#[test]
fn without_prompt_ids_no_turn_is_called_interrupted() {
    // hooks that carry no prompt_id: nothing tells a prompt into the running turn from one after Esc, so the
    // trail goes on and ends with the next Stop
    let mut t = Trail::default();
    assert!(!t.prompt("", 1_000));
    t.event(
        &ev(json!({ "ev": "pre", "id": "s1", "tool": "Bash" })),
        1_100,
    );
    t.event(
        &ev(json!({ "ev": "post", "id": "s1", "tool": "Bash" })),
        1_200,
    );
    assert!(t.prompt("", 2_000));
    t.event(
        &ev(json!({ "ev": "pre", "id": "s2", "tool": "Bash" })),
        2_100,
    );
    t.event(
        &ev(json!({ "ev": "post", "id": "s2", "tool": "Bash" })),
        2_200,
    );
    t.answer("", Some("Done."), 3_000);
    let turns = folded_turns(&t.flush());
    assert_eq!(
        (
            turns.len(),
            turns[0].1["state"].as_str(),
            brief(&turns[0].1).len()
        ),
        (1, Some("done"), 2)
    );
}

#[test]
fn a_commands_exit_code_is_read_from_claude_codes_error() {
    assert_eq!(exit_code("Bash", "Exit code 1"), Some(1));
    assert_eq!(
        exit_code("Bash", "Exit code 127\nsh: nope: command not found"),
        Some(127)
    );
    for (tool, error) in [
        ("Bash", "Command timed out after 2m 0s"),
        ("Bash", "Exit code 0"),
        ("Bash", "Exit code x"),
        ("Bash", ""),
        ("Read", "Exit code 1"),
        ("Bash", "the Exit code 1"),
    ] {
        assert_eq!(exit_code(tool, error), None, "{tool} {error}");
    }
    // as Claude Code 2.1.286 sends a shell loop whose last test was false
    let fail = json!({ "hook_event_name": "PostToolUseFailure", "prompt_id": "a089", "tool_name": "Bash", "tool_input": { "command": "for f in a b; do [ \"$f\" = c ] && echo hit; done", "description": "Run the loop" }, "tool_use_id": "t1", "error": "Exit code 1", "is_interrupt": false, "duration_ms": 17 });
    assert_eq!(
        line(&fail, Level::Steps),
        json!({ "op": "terminal", "kind": "trail", "ev": "fail", "ancestors": [7], "id": "t1", "tool": "Bash", "title": "Run the loop", "exit": 1, "ms": 17, "prompt": "a089" })
    );
}

#[test]
fn helpers_are_a_line_in_their_callers_trail_or_a_trail_of_their_own() {
    let mut t = Trail::default();
    t.prompt("", 1_000);
    t.event(&ev(json!({ "ev": "pre", "id": "s1", "tool": "Agent", "title": "Count files", "subject": "Explore" })), 1_100);
    t.event(
        &ev(json!({ "ev": "post", "id": "s1", "tool": "Agent", "ms": 3 })),
        1_110,
    );
    t.event(&ev(json!({ "ev": "agent_start", "agent": "a1", "agent_type": "Explore", "title": "Count files" })), 1_120);
    // a helper without a board session: counted
    for i in 0..3 {
        t.event(
            &ev(json!({ "ev": "pre", "id": format!("h{i}"), "tool": "Bash", "agent": "a1" })),
            1_200 + i,
        );
        t.event(
            &ev(json!({ "ev": "post", "id": format!("h{i}"), "tool": "Bash", "agent": "a1" })),
            1_210 + i,
        );
    }
    t.event(&ev(json!({ "ev": "say", "msg": "x", "text": "a helper's words", "final": true, "agent": "a1" })), 1_300);
    // a second helper names its board session: its steps are that session's trail
    t.event(&ev(json!({ "ev": "agent_start", "agent": "a2", "agent_type": "general-purpose", "title": "Design the page" })), 1_400);
    t.event(
        &ev(json!({ "ev": "pre", "id": "d0", "tool": "Read", "subject": "x.css", "agent": "a2" })),
        1_410,
    );
    t.event(&ev(json!({ "ev": "pre", "id": "d1", "tool": "plugin_trommi_trommi: set_status", "board": true, "session": "Design", "agent": "a2" })), 1_420);
    t.event(
        &ev(json!({ "ev": "pre", "id": "d2", "tool": "Edit", "subject": "x.css", "agent": "a2" })),
        1_430,
    );
    t.event(
        &ev(json!({ "ev": "post", "id": "d2", "tool": "Edit", "agent": "a2", "ms": 4 })),
        1_440,
    );
    // the turn ends while the helpers still run (in the background)
    t.answer("", Some("Started two helpers."), 1_500);
    let mut sent = t.flush();
    t.event(&ev(json!({ "ev": "agent_stop", "agent": "a1" })), 9_000);
    t.event(&ev(json!({ "ev": "agent_stop", "agent": "a2" })), 9_500);
    sent.extend(t.flush());
    let turns = folded_turns(&sent);
    assert_eq!(turns.len(), 2);
    let (main, child) = (&turns[0], &turns[1]);
    assert_eq!(
        (main.0.clone(), main.1["state"].as_str()),
        (None, Some("done"))
    );
    assert_eq!(
        brief(&main.1),
        [
            "step Agent ok",
            "helper Explore ok",
            "helper general-purpose ok"
        ]
    );
    assert_eq!(
        (
            main.1["items"][1]["steps"].as_u64(),
            main.1["items"][1]["ms"].as_u64(),
            main.1["items"][2]["steps"].as_u64()
        ),
        (Some(3), Some(7_880), Some(1))
    );
    assert_eq!(
        (
            child.0.as_deref(),
            child.1["state"].as_str(),
            child.1["ended_at"].as_u64()
        ),
        (Some("Design"), Some("done"), Some(9_500))
    );
    assert_eq!(brief(&child.1), ["step Edit ok"]);
    assert!(!sent
        .iter()
        .any(|e| e.work.to_string().contains("helper's words")
            || e.work.to_string().contains("set_status")));
}

#[test]
fn a_trail_has_its_limits() {
    let mut t = Trail::default();
    t.prompt("", 1_000);
    for i in 0..(ITEMS_MAX + 25) {
        t.event(&ev(json!({ "ev": "pre", "id": format!("s{i}"), "tool": "Bash", "input": "x".repeat(1_500) })), 1_100);
        t.event(&ev(json!({ "ev": "post", "id": format!("s{i}"), "tool": "Bash", "output": "y".repeat(3_000) })), 1_200);
    }
    t.answer("", None, 2_000);
    let sent = t.flush();
    assert!(sent.len() > 10, "split by weight: {}", sent.len());
    for e in &sent {
        assert!(
            e.work.to_string().len() <= ENVELOPE_MAX + 500,
            "{}",
            e.work.to_string().len()
        );
    }
    let turn = &folded_turns(&sent)[0].1;
    assert_eq!(
        (
            turn["items"].as_array().unwrap().len(),
            turn["more"].as_u64()
        ),
        (ITEMS_MAX, Some(25))
    );
    // old turns leave
    for i in 0..20u64 {
        t.prompt("", 10_000 + i * 10);
        t.event(
            &ev(json!({ "ev": "pre", "id": format!("z{i}"), "tool": "Read" })),
            10_001 + i * 10,
        );
        t.answer("", None, 10_002 + i * 10);
        t.flush();
    }
    assert!(t.turns.len() <= TURNS_KEPT);
}

// ---- the cases of the former Node suite's trail hooks, as library calls -------------------------------------------

const TOKEN: &str = "sk-live-MIRROR-0123456789abcdef";
/// What every hook input of one session carries (Claude Code 2.1.286).
fn with_base(prompt_id: &str, more: Value) -> Value {
    let mut o = obj_of(
        json!({ "session_id": "s1", "transcript_path": "/nowhere/s1.jsonl", "cwd": "/work/project", "prompt_id": prompt_id, "permission_mode": "default" }),
    );
    o.extend(obj_of(more));
    Value::Object(o)
}
fn obj_of(v: Value) -> serde_json::Map<String, Value> {
    v.as_object().cloned().unwrap()
}
fn without_ancestors(mut v: Value) -> Value {
    assert_eq!(
        v.as_object_mut().unwrap().remove("ancestors"),
        Some(json!([7])),
        "the hook names its Claude Code process"
    );
    v
}

#[test]
fn a_step_goes_with_its_tool_its_description_and_a_safe_subject_never_its_command_or_output() {
    let call = json!({ "command": "curl -H \"Authorization: Bearer sk-live-123456789\" https://x.example", "description": "Check the status page" });
    let pre = with_base(
        "c771",
        json!({ "hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": call, "tool_use_id": "toolu_01PJwkq4PfKKHm5aPUWQFv8d" }),
    );
    let post = with_base(
        "c771",
        json!({ "hook_event_name": "PostToolUse", "tool_name": "Bash", "tool_input": call, "tool_use_id": "toolu_01PJwkq4PfKKHm5aPUWQFv8d", "tool_response": { "stdout": "HTTP 200 SECRET-OUT", "stderr": "", "interrupted": false }, "duration_ms": 29 }),
    );
    let read = with_base(
        "c771",
        json!({ "hook_event_name": "PreToolUse", "tool_name": "Read", "tool_input": { "file_path": "/work/project/src/a.rs" }, "tool_use_id": "toolu_02" }),
    );
    let say = with_base(
        "c771",
        json!({ "hook_event_name": "MessageDisplay", "turn_id": "u1", "message_id": "m1", "index": 0, "final": true, "delta": "I will check the page." }),
    );
    let lines: Vec<Value> = [&say, &pre, &post, &read]
        .into_iter()
        .map(|i| without_ancestors(line(i, Level::Steps)))
        .collect();
    assert_eq!(
        lines,
        vec![
            json!({ "op": "terminal", "kind": "trail", "ev": "say", "msg": "m1", "text": "I will check the page.", "final": true, "prompt": "c771" }),
            json!({ "op": "terminal", "kind": "trail", "ev": "pre", "id": "toolu_01PJwkq4PfKKHm5aPUWQFv8d", "tool": "Bash", "title": "Check the status page", "prompt": "c771" }),
            json!({ "op": "terminal", "kind": "trail", "ev": "post", "id": "toolu_01PJwkq4PfKKHm5aPUWQFv8d", "tool": "Bash", "title": "Check the status page", "ms": 29, "prompt": "c771" }),
            json!({ "op": "terminal", "kind": "trail", "ev": "pre", "id": "toolu_02", "tool": "Read", "subject": "src/a.rs", "prompt": "c771" }),
        ]
    );
    // a command that ended with an exit code other than 0 (PostToolUseFailure, "Exit code 1"): the code, nothing
    // of the output
    let mut fail = pre.clone();
    fail["hook_event_name"] = json!("PostToolUseFailure");
    fail["error"] = json!("Exit code 1\nSECRET-ERR");
    fail["is_interrupt"] = json!(false);
    fail["duration_ms"] = json!(17);
    assert_eq!(
        without_ancestors(line(&fail, Level::Steps)),
        json!({ "op": "terminal", "kind": "trail", "ev": "fail", "id": "toolu_01PJwkq4PfKKHm5aPUWQFv8d", "tool": "Bash", "title": "Check the status page", "exit": 1, "ms": 17, "prompt": "c771" })
    );
}

#[test]
fn only_the_level_full_carries_the_command_line_and_the_output_and_no_secret_in_them() {
    let call = json!({ "command": "curl -H \"Authorization: Bearer sk-live-123456789\" https://x.example", "description": "Check the status page" });
    let pre = with_base(
        "c771",
        json!({ "hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": call, "tool_use_id": "toolu_01" }),
    );
    let mut post = pre.clone();
    post["hook_event_name"] = json!("PostToolUse");
    post["tool_response"] =
        json!({ "stdout": "HTTP 200 SECRET-OUT", "stderr": "", "interrupted": false });
    post["duration_ms"] = json!(29);
    let got = [line(&pre, Level::Full), line(&post, Level::Full)];
    assert_eq!(
        got.iter()
            .map(|r| (
                r["ev"].as_str().unwrap(),
                r.get("input").and_then(|v| v.as_str()),
                r.get("output").and_then(|v| v.as_str())
            ))
            .collect::<Vec<_>>(),
        vec![
            ("pre", Some("curl -H \"Authorization: …"), None),
            ("post", None, Some("HTTP 200 SECRET-OUT"))
        ]
    );
    assert!(
        !got.iter().any(|r| has(r, "sk-live")),
        "what looks like a secret is taken out"
    );
    // the same inputs one level below: no command line, no output
    for r in [line(&pre, Level::Steps), line(&post, Level::Steps)] {
        assert!(
            r.get("input").is_none() && r.get("output").is_none() && !has(&r, "curl"),
            "{r}"
        );
    }
}

#[test]
fn below_the_level_steps_and_for_what_is_not_understood_a_trail_hook_says_nothing() {
    let pre = with_base(
        "c771",
        json!({ "hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": { "command": "ls" }, "tool_use_id": "toolu_01" }),
    );
    for level in ["off", "0", "false", "no", "answers"] {
        assert!(
            hook_request(&pre, &[7], trommi_connector::mirror::level_of(level)).is_none(),
            "{level}"
        );
    }
    for level in ["", "steps", "full"] {
        assert!(
            hook_request(&pre, &[7], trommi_connector::mirror::level_of(level)).is_some(),
            "{level}"
        );
    }
    // (stdin that is not JSON never gets here; what is JSON but no object says nothing)
    for broken in [Value::Null, json!("not json"), json!([])] {
        assert!(hook_request(&broken, &[7], Level::Full).is_none());
    }
    assert!(hook_request(
        &with_base("c771", json!({ "hook_event_name": "PreCompact" })),
        &[7],
        Level::Full
    )
    .is_none());
}

#[test]
fn at_the_level_full_a_secret_in_a_command_an_error_and_a_helpers_report_is_taken_out() {
    let call = json!({ "command": format!("deploy --token {TOKEN}"), "description": "Roll out the build" });
    let step = |event: &str, more: Value| {
        let mut i = with_base(
            "p9",
            json!({ "hook_event_name": event, "tool_name": "Bash", "tool_input": call, "tool_use_id": "t2" }),
        );
        i.as_object_mut().unwrap().extend(obj_of(more));
        line(&i, Level::Full)
    };
    let pre = step("PreToolUse", json!({}));
    let post = step(
        "PostToolUse",
        json!({ "tool_response": { "stdout": format!("out {TOKEN}"), "stderr": "", "interrupted": false }, "duration_ms": 12 }),
    );
    let fail = step(
        "PostToolUseFailure",
        json!({ "error": format!("Exit code 1\n{TOKEN}"), "is_interrupt": false, "duration_ms": 340 }),
    );
    let report = line(
        &with_base(
            "p9",
            json!({ "hook_event_name": "SubagentStop", "agent_id": "ad4d", "agent_type": "Explore", "last_assistant_message": format!("The cause: {TOKEN}") }),
        ),
        Level::Full,
    );
    assert_eq!(pre["input"], json!("deploy --token …"));
    assert_eq!(post["output"], json!("out …"));
    assert_eq!(
        (&fail["output"], &fail["exit"]),
        (&json!("Exit code 1\n…"), &json!(1))
    );
    assert_eq!(report["output"], json!("The cause: …"));
    for r in [&pre, &post, &fail, &report] {
        assert!(!has(r, TOKEN) && !has(r, "sk-live"), "{r}");
    }
}

/// The connector's side of the hooks without a room: a hook's line goes where server.rs `mirror_request` sends it
/// (a prompt and a stop to the trail first, then into the mirror's queue; a trail line to the trail), and what the
/// trail has is queued behind what waits. `queue` is then the session's chat in the order it would be sent.
struct Terminal {
    trail: Trail,
    mirror: trommi_connector::mirror::Mirror,
    clock: u64,
}
impl Terminal {
    fn new() -> Terminal {
        Terminal {
            trail: Trail::default(),
            mirror: Default::default(),
            clock: 1_000,
        }
    }
    fn tick(&mut self) -> u64 {
        self.clock += 100;
        self.clock
    }
    /// What the trail has by now goes into the queue (the connector does it FLUSH_MS after a step, and at once
    /// before a prompt or an answer).
    fn flush(&mut self) {
        for e in self.trail.flush() {
            self.mirror.push_work(e);
        }
    }
    /// The hook `prompt` or `stop` with its input.
    fn said(&mut self, kind: &str, input: &Value) {
        let Some(req) = trommi_connector::mirror::hook_request(kind, input, &[7]) else {
            return;
        };
        let now = self.tick();
        let prompt = req["prompt_id"].as_str().unwrap_or("");
        let same_turn = if req["kind"] == json!("input") {
            self.trail.prompt(prompt, now)
        } else {
            self.trail.answer(prompt, req["text"].as_str(), now);
            false
        };
        self.flush();
        self.mirror.accept(&req, same_turn);
    }
    /// The hook `trail` with its input, at a level.
    fn step(&mut self, input: &Value, level: Level) {
        let Some(req) = hook_request(input, &[7], level) else {
            return;
        };
        let now = self.tick();
        self.trail.event(&req, now);
        if ["end", "error", "agent_stop"].contains(&req["ev"].as_str().unwrap()) {
            self.flush();
        }
    }
    /// The chat as it would be sent: ("input" | "answer", its text) and ("work", "") with the envelope.
    fn chat(&self) -> (Vec<(&'static str, String)>, Vec<Envelope>) {
        let (mut said, mut work) = (vec![], vec![]);
        while let Some(i) = self.mirror.next() {
            said.push((i.kind, i.text));
            work.extend(i.work);
        }
        (said, work)
    }
}
fn ups(prompt: &str, prompt_id: &str) -> Value {
    with_base(
        prompt_id,
        json!({ "hook_event_name": "UserPromptSubmit", "prompt": prompt }),
    )
}
fn stop(last_assistant_message: &str, prompt_id: &str) -> Value {
    with_base(
        prompt_id,
        json!({ "hook_event_name": "Stop", "stop_hook_active": false, "last_assistant_message": last_assistant_message, "background_tasks": [], "session_crons": [] }),
    )
}
fn kinds(said: &[(&'static str, String)]) -> Vec<&'static str> {
    said.iter().map(|(k, _)| *k).collect()
}

#[test]
fn a_turns_hooks_make_one_trail_between_the_prompt_and_the_answer_without_command_or_output() {
    let pre = |id: &str, tool: &str, input: Value, more: Value| {
        let mut i = with_base(
            "p9",
            json!({ "hook_event_name": "PreToolUse", "tool_name": tool, "tool_input": input, "tool_use_id": id }),
        );
        i.as_object_mut().unwrap().extend(obj_of(more));
        i
    };
    let post = |id: &str, tool: &str, input: Value, more: Value| {
        let mut i = with_base(
            "p9",
            json!({ "hook_event_name": "PostToolUse", "tool_name": tool, "tool_input": input, "tool_use_id": id, "tool_response": { "stdout": format!("out {TOKEN}"), "stderr": "", "interrupted": false }, "duration_ms": 12 }),
        );
        i.as_object_mut().unwrap().extend(obj_of(more));
        i
    };
    let say = |id: &str, delta: &str| {
        with_base(
            "p9",
            json!({ "hook_event_name": "MessageDisplay", "turn_id": "u9", "message_id": id, "index": 0, "final": true, "delta": delta }),
        )
    };
    let bash = json!({ "command": format!("deploy --token {TOKEN}"), "description": "Roll out the build" });
    let toml = json!({ "file_path": "/work/project/deploy.toml" });
    let helper = json!({ "agent_id": "ad4d", "agent_type": "Explore" });
    let mut t = Terminal::new();
    t.said("prompt", &ups("ship it", "p9"));
    let hooks = [
        say("m1", "I will look at the config first."),
        pre("t1", "Read", toml.clone(), json!({})),
        post("t1", "Read", toml, json!({})),
        pre("t2", "Bash", bash.clone(), json!({})),
        with_base(
            "p9",
            json!({ "hook_event_name": "PostToolUseFailure", "tool_name": "Bash", "tool_input": bash, "tool_use_id": "t2", "error": format!("Exit code 1\n{TOKEN}"), "is_interrupt": false, "duration_ms": 340 }),
        ),
        with_base(
            "p9",
            json!({ "hook_event_name": "SubagentStart", "agent_id": "ad4d", "agent_type": "Explore", "task_description": "Find the cause" }),
        ),
        pre("h1", "Grep", json!({ "pattern": "token" }), helper.clone()),
        post("h1", "Grep", json!({ "pattern": "token" }), helper),
        with_base(
            "p9",
            json!({ "hook_event_name": "SubagentStop", "agent_id": "ad4d", "agent_type": "Explore", "last_assistant_message": format!("The cause: {TOKEN}") }),
        ),
        pre(
            "t3",
            "mcp__plugin_trommi_trommi__set_status",
            json!({ "id": "x", "state": "working" }),
            json!({}),
        ),
        say("m2", "Rolled back."),
    ];
    for input in &hooks {
        t.step(input, Level::Steps);
    }
    t.said("stop", &stop("Rolled back.", "p9"));
    let (said, work) = t.chat();
    assert_eq!(
        (said.first().unwrap(), said.last().unwrap()),
        (
            &("input", "ship it".to_string()),
            &("answer", "Rolled back.".to_string())
        )
    );
    assert!(
        kinds(&said[1..said.len() - 1]).iter().all(|k| *k == "work")
            && (1..=4).contains(&work.len()),
        "coalesced: {} envelopes for {} hook lines",
        work.len(),
        hooks.len()
    );
    assert!(work.iter().all(|e| e.target.is_none()));
    let turns = folded_turns(&work);
    assert_eq!(turns.len(), 1, "one turn");
    let turn = &turns[0].1;
    assert_eq!(turn["state"], json!("done"));
    assert!(turn["started_at"].is_u64() && turn["ended_at"].is_u64());
    let text = |i: &Value, k: &str| i.get(k).and_then(|v| v.as_str()).map(String::from);
    let rows: Vec<[String; 4]> = turn["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| {
            [
                text(i, "kind").unwrap(),
                text(i, "tool").or(text(i, "text")).unwrap_or_default(),
                text(i, "title").or(text(i, "subject")).unwrap_or_default(),
                text(i, "state").unwrap_or_default(),
            ]
        })
        .collect();
    assert_eq!(
        rows,
        [
            ["text", "I will look at the config first.", "", ""],
            ["step", "Read", "deploy.toml", "ok"],
            ["step", "Bash", "Roll out the build", "failed"],
            ["helper", "Explore", "Find the cause", "ok"],
        ],
        "{turn}"
    );
    let item = |id: &str| {
        turn["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|i| i["id"] == json!(id))
            .unwrap()
    };
    assert_eq!(
        item("agent:ad4d")["steps"],
        json!(1),
        "a helper's steps are counted on its line"
    );
    assert_eq!(
        (&item("t2")["ms"], &item("t2")["exit"]),
        (&json!(340), &json!(1))
    );
    let all: String = work.iter().map(|e| e.work.to_string()).collect();
    assert!(
        !all.contains(TOKEN) && !all.contains("deploy --token") && !all.contains("The cause"),
        "no command line, no output, no helper's report at the level steps"
    );
    assert!(
        !all.contains("set_status") && !all.contains("Rolled back"),
        "a board call is no step, the answer is no text of the trail"
    );
}

#[test]
fn a_turn_without_stop_is_closed_as_interrupted_by_the_next_prompt_and_answers_sends_no_trail() {
    let wait = with_base(
        "p10",
        json!({ "hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": { "command": "sleep 900", "description": "Wait for the build" }, "tool_use_id": "w1" }),
    );
    let ls = with_base(
        "p10",
        json!({ "hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": { "command": "ls" }, "tool_use_id": "w2" }),
    );
    let mut t = Terminal::new();
    t.said("prompt", &ups("long job", "p10"));
    t.step(&wait, Level::Steps);
    t.flush();
    t.said("prompt", &ups("stop, something else", "p11"));
    t.step(&ls, Level::Answers);
    t.said("stop", &stop("Fine.", "p11"));
    let (said, work) = t.chat();
    assert_eq!(kinds(&said), ["input", "work", "work", "input", "answer"]);
    assert_eq!(work.len(), 2);
    assert_eq!(
        work[0].work["items"][0]["state"],
        json!("running"),
        "the running step is on the board while it runs"
    );
    assert_eq!(work[1].work["turn"], work[0].work["turn"]);
    assert_eq!(work[1].work["state"], json!("interrupted"));
    assert_eq!(
        work[1].work["items"],
        json!([{ "id": "w1", "kind": "step", "state": "interrupted", "at": work[0].work["items"][0]["at"], "tool": "Bash", "title": "Wait for the build" }])
    );
    assert!(
        work[1].work.get("ended_at").is_none(),
        "when it broke off nobody knows"
    );
}

#[test]
fn a_prompt_typed_while_a_turn_runs_is_his_message_and_the_turn_keeps_its_one_trail_to_its_stop() {
    // as Claude Code 2.1.286 fires them: the prompt typed during the first command has the running turn's prompt_id
    let first = json!({ "command": "sleep 8; echo one", "description": "Run the first command" });
    let second = json!({ "command": "for f in a b; do [ \"$f\" = c ] && echo hit; done", "description": "Run the loop" });
    let mut t = Terminal::new();
    t.said("prompt", &ups("two commands, please", "p12"));
    t.step(
        &with_base(
            "p12",
            json!({ "hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": first, "tool_use_id": "c1" }),
        ),
        Level::Steps,
    );
    t.flush();
    t.said("prompt", &ups("fif", "p12"));
    for input in [
        json!({ "hook_event_name": "PostToolUse", "tool_name": "Bash", "tool_input": first, "tool_use_id": "c1", "tool_response": { "stdout": "one", "stderr": "", "interrupted": false }, "duration_ms": 8037 }),
        json!({ "hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": second, "tool_use_id": "c2" }),
        json!({ "hook_event_name": "PostToolUseFailure", "tool_name": "Bash", "tool_input": second, "tool_use_id": "c2", "error": "Exit code 1", "is_interrupt": false, "duration_ms": 17 }),
    ] {
        t.step(&with_base("p12", input), Level::Steps);
    }
    t.said("stop", &stop("Both ran.", "p12"));
    let (said, work) = t.chat();
    // the order in the chat is the order the hooks came in: what the trail knew before his words stands before them
    assert_eq!(kinds(&said), ["input", "work", "input", "work", "answer"]);
    assert_eq!(
        said.iter()
            .filter(|(k, _)| *k == "input")
            .map(|(_, t)| t.as_str())
            .collect::<Vec<_>>(),
        ["two commands, please", "fif"]
    );
    assert!(
        work.iter().all(|e| e.work["state"] != json!("interrupted")),
        "nobody interrupted anything"
    );
    let turns = folded_turns(&work);
    assert_eq!(turns.len(), 1, "one turn, one trail");
    let turn = &turns[0].1;
    assert_eq!(
        (turn["state"].as_str(), turn["ended_at"].is_u64()),
        (Some("done"), true)
    );
    assert_eq!(
        turn["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| (
                i["id"].as_str().unwrap(),
                i["state"].as_str().unwrap(),
                i["ms"].as_u64(),
                i.get("exit").and_then(|e| e.as_u64())
            ))
            .collect::<Vec<_>>(),
        vec![
            ("c1", "ok", Some(8037), None),
            ("c2", "failed", Some(17), Some(1))
        ]
    );
}

// ---- the permission hooks' pure pieces (connector/src/hooks.rs), from the former Node suite ------------------------

use trommi_connector::hooks;

fn bash_prompt() -> Value {
    json!({ "hook_event_name": "PermissionRequest", "tool_name": "Bash", "tool_input": { "command": "rm -rf build", "description": "Remove the build folder" }, "tool_use_id": "toolu_1" })
}
/// A hook's request without the pids above this process, which are checked apart.
fn asked(kind: &str, input: &Value) -> Value {
    let mut r = hooks::hook_request(kind, input).unwrap();
    let above = r.as_object_mut().unwrap().remove("ancestors").unwrap();
    let parent = u64::from(std::os::unix::process::parent_id());
    assert!(
        above.as_array().unwrap().contains(&json!(parent)),
        "the hook names the processes above it, its Claude Code process among them: {above}"
    );
    r
}

#[test]
fn a_permission_prompt_asks_with_the_tool_its_description_and_the_call_in_short() {
    let r = asked("permission", &bash_prompt());
    assert_eq!(
        r,
        json!({ "op": "permission", "tool_name": "Bash", "description": "Remove the build folder", "input_preview": "rm -rf build", "wait_ms": hooks::wait_ms() })
    );
    if std::env::var_os("TROMMI_PERMISSION_MS").is_none() {
        assert_eq!(r["wait_ms"], json!(300_000), "five minutes unless told");
    }
    assert_eq!(
        hooks::preview_of(&bash_prompt()["tool_input"]),
        (
            "Remove the build folder".to_string(),
            "rm -rf build".to_string()
        )
    );
    // a tool without a command line: its arguments as JSON
    let mut write = bash_prompt();
    write["tool_name"] = json!("Write");
    write["tool_input"] = json!({ "file_path": "/etc/hosts", "content": "x" });
    let r = asked("permission", &write);
    assert_eq!(
        (&r["tool_name"], &r["description"]),
        (&json!("Write"), &json!(""))
    );
    // (compared as JSON: the order of the keys in the preview is serde_json's, not the caller's)
    assert_eq!(
        serde_json::from_str::<Value>(r["input_preview"].as_str().unwrap()).unwrap(),
        json!({ "file_path": "/etc/hosts", "content": "x" })
    );
    let mut notebook = bash_prompt();
    notebook["tool_name"] = json!("NotebookEdit");
    notebook["tool_input"] = json!({ "notebook_path": "a.ipynb" });
    assert_eq!(
        asked("permission", &notebook)["input_preview"],
        json!("{\"notebook_path\":\"a.ipynb\"}")
    );
}

#[test]
fn the_boards_verdict_is_printed_as_claude_codes_decision_and_anything_else_as_nothing() {
    let printed = |answer: Value| hooks::hook_output("permission", &answer);
    // (compared as JSON: Claude Code reads the decision, not the order of its keys)
    assert_eq!(
        serde_json::from_str::<Value>(&printed(json!({ "ok": true, "behavior": "allow" })))
            .unwrap(),
        json!({ "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": { "behavior": "allow" } } })
    );
    assert_eq!(
        serde_json::from_str::<Value>(&printed(json!({ "ok": true, "behavior": "deny" }))).unwrap(),
        json!({ "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": { "behavior": "deny", "message": "Denied by the human on the Trommi board." } } })
    );
    assert_eq!(
        printed(json!({ "ok": true, "behavior": "allow" }))
            .lines()
            .count(),
        1,
        "one line of JSON"
    );
    // no verdict in time, a channel session, another session, a connector that says no: the terminal decides
    for answer in [
        json!({ "ok": true, "timeout": true }),
        json!({ "ok": true, "silent": true }),
        json!({ "ok": false, "error": "another session" }),
        json!({ "ok": false, "behavior": "allow" }),
        json!({ "ok": true, "behavior": "ask" }),
        json!({ "ok": true, "withdrawn": true }),
        Value::Null,
    ] {
        assert_eq!(printed(answer.clone()), "", "{answer}");
    }
    // the other hooks never print a decision
    for kind in ["resolved", "notice", "denied"] {
        assert_eq!(
            hooks::hook_output(kind, &json!({ "ok": true, "behavior": "allow" })),
            "",
            "{kind}"
        );
    }
}

#[test]
fn a_question_dialog_and_broken_input_never_reach_the_connector() {
    for tool in ["AskUserQuestion", "ExitPlanMode"] {
        let mut dialog = bash_prompt();
        dialog["tool_name"] = json!(tool);
        assert!(
            hooks::hook_request("permission", &dialog).is_none(),
            "{tool}"
        );
        assert!(hooks::hook_request("resolved", &dialog).is_none(), "{tool}");
    }
    for kind in ["permission", "resolved", "notice", "denied"] {
        for broken in [Value::Null, json!("not json"), json!(""), json!({})] {
            assert!(
                hooks::hook_request(kind, &broken).is_none(),
                "{kind} {broken}"
            );
        }
    }
    assert!(hooks::hook_request("other", &bash_prompt()).is_none());
}

#[test]
fn a_call_answered_in_the_terminal_goes_as_resolved_with_what_its_prompt_was_asked_with() {
    let mut done = bash_prompt();
    done["hook_event_name"] = json!("PostToolUse");
    done["tool_response"] = json!({ "stdout": "" });
    let r = asked("resolved", &done);
    assert_eq!(
        r,
        json!({ "op": "resolved", "tool_name": "Bash", "description": "Remove the build folder", "input_preview": "rm -rf build" }),
        "no wait: nothing is asked"
    );
    // the same call's prompt carries the same three, by which the connector finds the open request; another call
    // does not
    let p = asked("permission", &bash_prompt());
    for k in ["tool_name", "description", "input_preview"] {
        assert_eq!(p[k], r[k], "{k}");
    }
    let mut other = done.clone();
    other["tool_input"] = json!({ "command": "ls" });
    assert_ne!(
        asked("resolved", &other)["input_preview"],
        r["input_preview"]
    );
}

#[test]
fn a_notice_hands_the_notification_on_and_other_notifications_ask_nothing() {
    let r = asked(
        "notice",
        &json!({ "hook_event_name": "Notification", "notification_type": "permission_prompt", "message": "Claude needs your permission to use Bash" }),
    );
    assert_eq!(
        r,
        json!({ "op": "notice", "notification_type": "permission_prompt", "message": "Claude needs your permission to use Bash" })
    );
    assert!(hooks::hook_request(
        "notice",
        &json!({ "hook_event_name": "Notification", "notification_type": "idle_prompt", "message": "x" })
    )
    .is_none());
}

#[test]
fn a_denial_goes_as_one_line_with_the_reason_or_the_call_and_secrets_taken_out() {
    let call = json!({ "command": "DB_PASS=hunter2 psql prod" });
    let r = asked(
        "denied",
        &json!({ "hook_event_name": "PermissionDenied", "permission_mode": "auto", "tool_name": "Bash", "tool_input": call, "reason": "Production Deploy" }),
    );
    assert_eq!(
        r,
        json!({ "op": "denied", "text": "Auto mode blocked: Bash — Production Deploy" })
    );
    // without a reason the call stands for it, without its secret
    let r = asked(
        "denied",
        &json!({ "tool_name": "Bash", "tool_input": call }),
    );
    assert_eq!(
        r["text"],
        json!("Auto mode blocked: Bash — DB_PASS=… psql prod")
    );
    assert_eq!(
        hooks::redact("DB_PASS=hunter2 psql prod"),
        "DB_PASS=… psql prod"
    );
    assert_eq!(
        hooks::denied_text("Bash", "too dangerous", &json!({ "command": "rm -rf /" })),
        "Auto mode blocked: Bash — too dangerous"
    );
    assert_eq!(
        hooks::denied_text("Bash", "x", &Value::Null),
        "Auto mode blocked: Bash — x"
    );
}
