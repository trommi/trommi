//! The admin page: on its own listener, behind a password, read-only, and showing only what the hub can see.

mod common;

use common::*;
use serde_json::json;
use trommi_hub::util::{b64, random, short};

fn text(reply: &Reply) -> String {
    String::from_utf8_lossy(&reply.body).into_owned()
}

/// Standard base64 with padding, as a browser writes a Basic credential.
fn base64(bytes: &[u8]) -> String {
    let mut out: String = b64(bytes).replace('-', "+").replace('_', "/");
    while !out.len().is_multiple_of(4) {
        out.push('=');
    }
    out
}

fn basic(password: &str) -> Vec<(&'static str, String)> {
    vec![(
        "authorization",
        format!("Basic {}", base64(format!("admin:{password}").as_bytes())),
    )]
}

fn get(port: u16, headers: &[(&str, String)]) -> Reply {
    request(port, "GET", "/", headers, b"")
}

#[test]
fn the_admin_page_is_behind_its_password_and_shows_only_what_the_hub_sees() {
    // without a configured hash there is no page, whatever is asked
    let bare = TestHub::start();
    let port = bare.admin();
    assert_eq!(get(port, &[]).status, 404);
    assert_eq!(get(port, &basic("anything at all")).status, 404);

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
    assert_eq!(get(hub.port, &basic("correct horse battery")).status, 404);

    // without the password: the browser is asked for it, and nothing of the hub is shown
    let asked = get(admin, &[]);
    assert_eq!(asked.status, 401);
    assert!(asked
        .header("www-authenticate")
        .unwrap()
        .starts_with("Basic "));
    assert!(!text(&asked).contains("Rooms"));
    assert_eq!(asked.header("cache-control"), Some("no-store"));
    assert!(asked
        .header("content-security-policy")
        .unwrap()
        .contains("default-src 'none'"));
    // no cookie is set or taken: a credential of this kind goes to this origin and port only
    assert_eq!(asked.header("set-cookie"), None);
    let cookie = [("cookie", format!("trommi_admin={}", b64(&[5u8; 32])))];
    assert_eq!(get(admin, &cookie).status, 401);
    // something that is no Basic credential
    for odd in ["Bearer abc", "Basic", "Basic !!!", "Basic YWRtaW4="] {
        assert_eq!(
            get(admin, &[("authorization", odd.to_string())]).status,
            401,
            "{odd}"
        );
    }

    // wrong passwords: each makes the page wait longer before it takes another, the right one included
    assert_eq!(get(admin, &basic("wrong")).status, 401);
    let early = get(admin, &basic("correct horse battery"));
    assert_eq!(
        (early.status, early.header("retry-after")),
        (429, Some("1"))
    );
    hub.clock(1000);
    assert_eq!(get(admin, &basic("wrong again")).status, 401);
    hub.clock(1000);
    let early = get(admin, &basic("correct horse battery"));
    assert_eq!(
        (early.status, early.header("retry-after")),
        (429, Some("1"))
    );
    hub.clock(1000);
    let session = basic("correct horse battery");

    // the page: version and health, the room with its counts and its account, the tables classified
    let page = get(admin, &session);
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
    // read-only: no form, and nothing but GET / is taken, password or not
    assert_eq!(html.matches("<form").count(), 0);
    for (method, path) in [
        ("POST", "/"),
        ("DELETE", "/"),
        ("POST", "/login"),
        ("GET", "/rooms"),
    ] {
        assert_eq!(request(admin, method, path, &session, b"").status, 404);
    }
    // a credential that was checked is taken again without the slow hash, and a wrong one after it is still wrong
    assert_eq!(get(admin, &session).status, 200);
    assert_eq!(get(admin, &basic("correct horse batterx")).status, 401);
    // the scheme's name in any case; the longest password `admin-hash` takes fits into the header the page reads
    hub.clock(1000);
    let shouted = [("authorization", session[0].1.replacen("Basic", "BASIC", 1))];
    assert_eq!(get(admin, &shouted).status, 200);
    let long = "p".repeat(trommi_hub::admin::MAX_PASSWORD);
    let roomy = TestHub::start_with(&[(
        "HUB_ADMIN_PASSWORD_HASH",
        &trommi_hub::admin::hash_password(&long),
    )]);
    assert_eq!(get(roomy.admin(), &basic(&long)).status, 200);
    // the page is put together once for all who ask within a few seconds
    assert_eq!(text(&get(admin, &session)), html);
    // and no longer: five seconds on, the page is put together anew
    hub.clock(5001);
    let later = get(admin, &session);
    assert_eq!(later.status, 200);
    assert!(text(&later).contains("1 rooms"));

    // few connections, none for long: the seventeenth is closed at once, and the hub's own port is not touched
    let held: Vec<std::net::TcpStream> = (0..trommi_hub::admin::MAX_CONNECTIONS + 4)
        .map(|_| std::net::TcpStream::connect(("127.0.0.1", admin)).unwrap())
        .collect();
    std::thread::sleep(std::time::Duration::from_millis(200));
    let closed = held
        .iter()
        .filter(|socket| {
            use std::io::Read;
            socket
                .set_read_timeout(Some(std::time::Duration::from_millis(50)))
                .unwrap();
            matches!((&**socket).read(&mut [0u8; 1]), Ok(0))
        })
        .count();
    assert!(
        closed >= 4,
        "{closed} of the connections over the limit were closed"
    );
    assert_eq!(hub.get("/healthz").status, 200);
}
