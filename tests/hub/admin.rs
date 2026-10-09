//! The admin page: on its own listener, behind a password, read-only, and showing only what the hub can see.

mod common;

use common::*;
use serde_json::json;
use trommi_hub::util::{b64, random, short};

fn text(reply: &Reply) -> String {
    String::from_utf8_lossy(&reply.body).into_owned()
}

fn sign_in(port: u16, password: &str, headers: &[(&str, String)]) -> Reply {
    let mut all = vec![(
        "content-type",
        "application/x-www-form-urlencoded".to_string(),
    )];
    all.extend_from_slice(headers);
    request(
        port,
        "POST",
        "/login",
        &all,
        format!("password={password}").as_bytes(),
    )
}

#[test]
fn the_admin_page_is_behind_its_password_and_shows_only_what_the_hub_sees() {
    // without a configured hash there is no page, whatever is asked
    let bare = TestHub::start();
    let port = bare.admin();
    assert_eq!(request(port, "GET", "/", &[], b"").status, 404);
    assert_eq!(sign_in(port, "anything at all", &[]).status, 404);

    let hash = trommi_hub::admin::hash_password("correct horse battery");
    assert!(hash.starts_with("$argon2id$"));
    let mut w = World::on(TestHub::start_with(&[("HUB_ADMIN_PASSWORD_HASH", &hash)]));
    let hub = &w.hub;
    let admin = hub.admin();
    // a room with an account, an agent, a session and something written in it
    w.ada.post(hub, "/v2/account", &json!({
        "email": "ada@example.org",
        "kit": { "auth_key": b64(&random::<32>()), "sealed_copy": b64(&[&[2u8][..], &[7u8; 60]].concat()) },
        "password": { "auth_key": b64(&random::<32>()), "sealed_copy": b64(&[&[2u8][..], &[8u8; 60]].concat()), "kdf": { "alg": "argon2id", "v": 1, "m": 65536, "t": 3, "p": 1 } },
    })).ok();
    let mut bea = w.add_human();
    let mut agent = w.enrol_agent();
    w.catch_up(&mut bea, &w.room.clone());
    let (session, group) = w.found_main(&mut [&mut bea], Some(&mut agent));
    bea.send(
        &w.hub,
        &group,
        &chat(&session, agent.id(), "the words nobody but the room reads"),
    )
    .ok();
    let hub = &w.hub;

    // the public port knows nothing of it
    for path in ["/", "/login", "/admin"] {
        assert_eq!(request(hub.port, "GET", path, &[], b"").status, 404);
    }
    assert_eq!(sign_in(hub.port, "correct horse battery", &[]).status, 404);

    // not signed in: the form, and nothing of the hub
    let form = request(admin, "GET", "/", &[], b"");
    assert_eq!(form.status, 200);
    assert!(text(&form).contains("name=\"password\"") && !text(&form).contains("Rooms"));
    assert_eq!(form.header("cache-control"), Some("no-store"));
    assert!(form
        .header("content-security-policy")
        .unwrap()
        .contains("default-src 'none'"));
    // a cookie somebody made up signs nobody in
    let forged = [("cookie", format!("trommi_admin={}", b64(&[5u8; 32])))];
    assert!(!text(&request(admin, "GET", "/", &forged, b"")).contains("Rooms"));
    // a form posted from another site is not a sign-in, even with the right password
    let cross = sign_in(
        admin,
        "correct+horse+battery",
        &[("sec-fetch-site", "cross-site".to_string())],
    );
    assert_eq!((cross.status, cross.header("set-cookie")), (403, None));

    // wrong passwords: each makes the page wait longer before it takes another, the right one included
    assert_eq!(sign_in(admin, "wrong", &[]).status, 401);
    let early = sign_in(admin, "correct+horse+battery", &[]);
    assert_eq!(
        (early.status, early.header("retry-after")),
        (429, Some("1"))
    );
    hub.clock(1000);
    assert_eq!(sign_in(admin, "wrong+again", &[]).status, 401);
    hub.clock(1000);
    let early = sign_in(admin, "correct+horse+battery", &[]);
    assert_eq!(
        (early.status, early.header("retry-after")),
        (429, Some("1"))
    );
    hub.clock(1000);

    // the right one (as a browser sends it: a space as `+`, a letter as `%xx`)
    let signed = sign_in(admin, "correct+horse+b%61ttery", &[]);
    assert_eq!(signed.status, 303);
    let cookie = signed.header("set-cookie").unwrap();
    assert!(cookie.contains("HttpOnly") && cookie.contains("SameSite=Strict"));
    let session = [("cookie", cookie.split(';').next().unwrap().to_string())];

    // the page: version and health, the room with its counts and its account, the tables classified
    let page = request(admin, "GET", "/", &session, b"");
    assert_eq!(page.status, 200);
    let html = text(&page);
    assert!(html.contains("version <code>dev</code>") && html.contains("1 rooms"));
    assert!(html.contains(&short(&w.room)) && html.contains("ada@example.org"));
    // two human devices, one agent device, one live session, one envelope
    let row = html
        .split("<tr>")
        .find(|row| row.contains(&short(&w.room)))
        .unwrap();
    let numbers: Vec<&str> = row
        .split("<td class=\"n\">")
        .skip(1)
        .map(|cell| cell.split("</td>").next().unwrap())
        .collect();
    assert_eq!(&numbers[..5], ["2", "1", "0", "1", "0"], "{row}");
    assert_eq!(numbers[6], "1", "one envelope: {row}");
    for table in ["accounts", "envelopes", "group_log", "sealed_keys", "files"] {
        assert!(html.contains(&format!("<code>{table}</code>")), "{table}");
    }
    assert!(
        !html.contains("Not classified yet"),
        "every table of the schema is in the page's list"
    );
    // nothing of what was written, no key, no hash: the page has only counts and what the hub reads anyway
    assert!(!html.contains("nobody but the room"));
    assert!(!html.contains(&b64(&w.ada.id())) && !html.contains("argon2id$"));
    // read-only: there is nothing to post but the sign-out
    assert_eq!(html.matches("<form").count(), 1);
    assert_eq!(request(admin, "POST", "/", &session, b"").status, 404);
    assert_eq!(request(admin, "DELETE", "/", &session, b"").status, 404);

    // signed out, the cookie is worth nothing
    assert_eq!(request(admin, "POST", "/logout", &session, b"").status, 303);
    assert!(!text(&request(admin, "GET", "/", &session, b"")).contains("Rooms"));
}
