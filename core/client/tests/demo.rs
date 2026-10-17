//! The demo room through the App (`Config.demo`): no hub and no store; the views come at once, a page in focus
//! shows, and what the person does stays as done.

use serde_json::Value;
use trommi_client_core::actions::Action;
use trommi_client_core::app::sim::Sim;
use trommi_client_core::app::{Config, Effect, Event};
use trommi_client_core::views::{Focus, Phase, Screen};

fn fixture() -> Value {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../demo/data/fixture.json");
    serde_json::from_str(&std::fs::read_to_string(root).expect("demo/data/fixture.json")).unwrap()
}

#[test]
fn the_demo_room_runs_without_a_hub() {
    let f = fixture();
    let mut sim = Sim::new(f["made_at"].as_u64().unwrap());
    sim.send(Event::Start { config: Config { platform: "test".into(), version: "0".into(), seed: 7, demo: Some(f), ..Default::default() } });
    assert_eq!(sim.view.phase, Phase::Live);
    assert!(!sim.view.desk.rows.is_empty(), "the Desk of the demo");
    assert!(sim.log.iter().all(|e| !matches!(e, Effect::Http { .. } | Effect::Store { .. } | Effect::OpenStream { .. })), "no I/O");
    // a card opened, answered: off the Desk, nothing pending
    let row = sim.view.desk.rows[0].clone();
    sim.send(Event::Focus { focus: Focus { screen: Screen::Card { card_id: row.id.clone() }, ..Default::default() } });
    assert!(sim.view.cards.contains_key(&row.id));
    let card = sim.app.board().model.cards[&row.id].clone();
    let action = if card.fields.get("card_type").as_str() == Some("info") {
        Action::Read { card_id: row.id.clone() }
    } else {
        Action::Shred { card_id: row.id.clone(), note: None, attachments: vec![], marks: vec![] }
    };
    sim.send(Event::Action { action });
    assert!(sim.view.toasts.is_empty(), "{:?}", sim.view.toasts);
    assert!(!sim.view.desk.rows.iter().any(|r| r.id == row.id), "done with: off the Desk");
    assert!(sim.app.board().model.cards[&row.id].answer.as_ref().is_some_and(|a| !a.pending));
}

#[test]
fn the_demo_opens_its_files_by_their_address_and_keeps_what_is_attached() {
    let f = fixture();
    let mut sim = Sim::new(f["made_at"].as_u64().unwrap());
    sim.hub = Some(Box::new(|_, request| {
        assert!(request.url.starts_with("/demo/files/"), "{}", request.url);
        Ok(trommi_client_core::app::HttpResponse { status: 200, headers: vec![], body: b"picture bytes".to_vec().into() })
    }));
    sim.send(Event::Start { config: Config { platform: "test".into(), version: "0".into(), seed: 7, demo: Some(f), ..Default::default() } });
    let row = sim.view.desk.rows.iter().find(|r| !r.media.is_empty()).expect("a row with a picture").clone();
    let file = row.media[0].file_id.clone();
    sim.send(Event::Action { action: Action::OpenFile { attachment_id: file.clone(), save: false } });
    assert!(sim.log.iter().any(|e| matches!(e, Effect::FileReady { file_id, bytes, .. } if *file_id == file && bytes.0 == b"picture bytes")));
    assert!(sim.view.toasts.is_empty(), "{:?}", sim.view.toasts);
    // attached: ready at once, opened from memory
    sim.send(Event::Action { action: Action::Attach { local_id: "local-1".into(), name: "a.txt".into(), media_type: "text/plain".into(), bytes: b"mine".to_vec().into() } });
    assert_eq!(sim.view.files.get("local-1").map(|f| f.state.as_str()), Some("ready"));
    sim.log.clear();
    sim.send(Event::Action { action: Action::OpenFile { attachment_id: "local-1".into(), save: false } });
    assert!(sim.log.iter().any(|e| matches!(e, Effect::FileReady { bytes, .. } if bytes.0 == b"mine")));

    // a photo picked in a chat goes out with the line, as on a real room, and opens from the line
    let session = sim.view.sidebar.sessions[0].id.clone();
    sim.send(Event::Action { action: Action::Attach { local_id: "photo-1".into(), name: "photo-1.jpg".into(), media_type: "image/jpeg".into(), bytes: b"jpeg".to_vec().into() } });
    let attachment = sim.view.files["photo-1"].attachment_id.clone().expect("its id");
    assert_eq!(attachment.len(), 32, "an attachment id as a body names one: {attachment}");
    sim.send(Event::Action { action: Action::Write { session_id: session.clone(), card_id: None, text: String::new(), attachments: vec!["photo-1".into()], marks: vec![], copied_cards: vec![] } });
    assert!(sim.view.toasts.is_empty(), "{:?}", sim.view.toasts);
    sim.send(Event::Focus { focus: Focus { screen: Screen::Session { session_id: session.clone() }, ..Default::default() } });
    assert!(sim.view.sessions[&session].talk.iter().any(|r| r.files == [attachment.clone()]), "the line names the photo");
    sim.log.clear();
    sim.send(Event::Action { action: Action::OpenFile { attachment_id: attachment.clone(), save: false } });
    assert!(sim.log.iter().any(|e| matches!(e, Effect::FileReady { file_id, bytes, .. } if *file_id == attachment && bytes.0 == b"jpeg")));
}

#[test]
fn the_demo_shows_its_scribble_boards_folds_goals_and_adds_a_team_with_undo() {
    let f = fixture();
    let mut sim = Sim::new(f["made_at"].as_u64().unwrap());
    sim.send(Event::Start { config: Config { platform: "test".into(), version: "0".into(), seed: 7, demo: Some(f), ..Default::default() } });
    // the Desk's board beside it: the demo's shapes, its pictures openable
    sim.send(Event::Focus { focus: Focus { screen: Screen::Desk, team: Some("main".into()), board: Some("main".into()), ..Default::default() } });
    let board = sim.view.board.clone().expect("the board in view");
    assert_eq!((board.board_id.as_str(), board.state.as_str()), ("desk/6d61696e000000000000000000000004", "ready"));
    assert!(board.shapes.len() >= 5, "{}", board.shapes.len());
    let picture = board.shapes.iter().find_map(|s| s.attachment.clone()).expect("a picture on it");
    assert!(sim.view.files.contains_key(&picture), "its file is known to open");
    // what is erased goes
    let first = board.shapes[0].id.clone();
    let content = serde_json::json!({ "content_type": "erase", "stroke_ids": [first] });
    sim.send(Event::Action { action: Action::BoardItem { board_id: board.board_id.clone(), local_id: "e1".into(), content } });
    assert!(sim.view.toasts.is_empty(), "{:?}", sim.view.toasts);
    let now = sim.view.board.clone().unwrap();
    assert_eq!(now.shapes.len(), board.shapes.len() - 1);
    assert!(!now.shapes.iter().any(|s| s.id == first));
    // the Desk shows its own team's board small, for its board tile, counted
    let thumbs = sim.view.thumbs.clone().expect("the Desk's board small");
    assert_eq!(thumbs.iter().map(|t| (t.team_id.as_str(), t.count as usize)).collect::<Vec<_>>(), [("main", now.shapes.len())]);
    let tile = sim.view.desk.tiles.iter().find(|t| t.key == "board").expect("the board tile");
    assert_eq!((tile.count, tile.line.en.clone()), (Some(now.shapes.len() as u32), format!("{} elements", now.shapes.len())));

    // Settings: every team's board small, counted, without what only drawing it large needs
    sim.send(Event::Focus { focus: Focus { screen: Screen::Settings { page: String::new() }, team: Some("main".into()), ..Default::default() } });
    let thumbs = sim.view.thumbs.clone().expect("the boards small");
    assert_eq!(thumbs.iter().map(|t| t.team_id.as_str()).collect::<Vec<_>>(), ["main", "platform"]);
    assert_eq!(thumbs[0].count as usize, now.shapes.len());
    assert!(thumbs.iter().flat_map(|t| &t.shapes).all(|s| s.t.is_empty() && s.f.is_empty() && s.az.is_none()));

    // the goals fold on this device
    sim.send(Event::Focus { focus: Focus { screen: Screen::Desk, team: Some("main".into()), ..Default::default() } });
    let goals = |sim: &Sim| sim.view.desk.goals.clone().expect("the team's goals");
    assert!(goals(&sim).foldable && !goals(&sim).folded);
    sim.send(Event::Action { action: Action::FoldGoals { team_id: "main".into(), folded: true } });
    assert!(goals(&sim).folded);
    sim.send(Event::Action { action: Action::FoldGoals { team_id: "main".into(), folded: false } });
    assert!(!goals(&sim).folded);

    // a new team: its toast names it, and Undo takes it away
    let before = sim.view.sidebar.teams.len();
    sim.send(Event::Action { action: Action::AddTeam { name: "Garden".into() } });
    let toast = sim.view.toasts.last().cloned().expect("Team added");
    assert_eq!((toast.text.en.as_str(), toast.alert), ("Team added", false));
    let Some(Action::RemoveTeam { team_id }) = toast.action.clone() else { panic!("Undo: {:?}", toast.action) };
    assert!(sim.view.sidebar.teams.iter().any(|d| d.id == team_id), "the toast names the new team");
    assert_eq!(sim.view.sidebar.teams.len(), before + 1);
}

#[test]
fn demo_computer_approval_shows_the_real_permission_and_command_without_io() {
    let f = fixture();
    let mut sim = Sim::new(f["made_at"].as_u64().unwrap());
    sim.send(Event::Start { config:Config { demo:Some(f), ..Default::default() } });
    sim.send(Event::Action { action:Action::Account { action:trommi_client_core::account::AccountAction::ApproveComputer { label:String::new() } } });
    let shown = sim.view.account.invite.as_ref().expect("the approval screen");
    assert_eq!(shown.title.en, "Approve a computer");
    assert!(shown.notice.en.contains("without another tap"));
    assert!(sim.view.account.connect_command.as_deref().unwrap().contains("--computer"));
    assert!(sim.log.iter().all(|e| !matches!(e, Effect::Http { .. } | Effect::Store { .. } | Effect::OpenStream { .. })));
}
