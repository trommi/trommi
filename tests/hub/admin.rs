//! The admin page: on its own listener, behind a password, read-only, and showing only what the hub can see.

mod common;

use common::*;
use serde_json::json;
use trommi_hub::util::{b64, random, short};

fn text(reply: &Reply) -> String {
    String::from_utf8_lossy(&reply.body).into_owned()
}

/// The page's own origin, as a browser names it on a POST from the page (the test client sends `host: 127.0.0.1`).
fn from_page() -> Vec<(&'static str, String)> {
    vec![
        ("origin", "http://127.0.0.1".to_string()),
        (
            "content-type",
            "application/x-www-form-urlencoded".to_string(),
        ),
    ]
}

/// The sign-in form sent as a browser sends it.
fn sign_in(port: u16, password: &str) -> Reply {
    let body = format!(
        "username=admin&password={}",
        password
            .bytes()
            .map(|b| match b {
                b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' => (b as char).to_string(),
                b' ' => "+".to_string(),
                b => format!("%{b:02X}"),
            })
            .collect::<String>()
    );
    request(port, "POST", "/login", &from_page(), body.as_bytes())
}

/// The cookie header a browser sends back after this answer.
fn session_of(reply: &Reply) -> Vec<(&'static str, String)> {
    let set = reply.header("set-cookie").expect("a cookie");
    vec![("cookie", set.split(';').next().unwrap().to_string())]
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
    assert_eq!(sign_in(port, "anything at all").status, 404);

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
    assert_eq!(sign_in(hub.port, "correct horse battery").status, 404);

    // without a session: a sign-in form a password manager fills, no Basic challenge, nothing of the hub
    let asked = get(admin, &[]);
    assert_eq!(asked.status, 200);
    assert_eq!(asked.header("www-authenticate"), None);
    assert_eq!(asked.header("set-cookie"), None);
    let form = text(&asked);
    assert!(form.contains("<form method=\"post\" action=\"/login\">"));
    assert!(form.contains("name=\"username\" value=\"admin\" autocomplete=\"username\""));
    assert!(form.contains("type=\"password\" name=\"password\" autocomplete=\"current-password\""));
    assert!(!form.contains("Rooms") && !form.contains("Sign out"));
    assert_eq!(asked.header("cache-control"), Some("no-store"));
    // (under `no-referrer` a browser would send its own sign-in with `Origin: null`)
    assert_eq!(asked.header("referrer-policy"), Some("same-origin"));
    let csp = asked.header("content-security-policy").unwrap();
    assert!(csp.contains("default-src 'none'") && csp.contains("form-action 'self'"));
    // a cookie the hub did not give, or one of no use, is no session
    for value in [b64(&[5u8; 32]), "x".into(), String::new()] {
        let forged = [("cookie", format!("{}={value}", trommi_hub::admin::COOKIE))];
        assert!(!text(&get(admin, &forged)).contains("Rooms"));
    }
    // a Basic credential is nothing to this page
    let basic = [(
        "authorization",
        format!("Basic {}", "YWRtaW46Y29ycmVjdCBob3JzZSBiYXR0ZXJ5"),
    )];
    assert!(!text(&get(admin, &basic)).contains("Rooms"));

    // a sign-in another site starts is refused before the password is looked at, and does not count as wrong
    let foreign = [
        vec![("origin", "https://evil.example".to_string())],
        vec![("origin", "http://127.0.0.1.evil.example".to_string())],
        vec![("origin", "null".to_string())],
        vec![],
        vec![
            ("origin", "http://127.0.0.1".to_string()),
            ("sec-fetch-site", "cross-site".to_string()),
        ],
    ];
    for headers in &foreign {
        let refused = request(
            admin,
            "POST",
            "/login",
            headers,
            b"username=admin&password=correct+horse+battery",
        );
        assert_eq!(refused.status, 403, "{headers:?}");
        assert_eq!(refused.header("set-cookie"), None);
    }
    // behind a TLS proxy that names the host it was asked for
    let proxied = request(
        admin,
        "POST",
        "/login",
        &[
            ("origin", "https://hub.example.ts.net:8443".to_string()),
            ("x-forwarded-host", "hub.example.ts.net:8443".to_string()),
            ("sec-fetch-site", "same-origin".to_string()),
        ],
        b"username=admin&password=wrong",
    );
    assert_eq!(proxied.status, 401, "taken, and the password is wrong");
    hub.clock(1000);

    // wrong passwords: each makes the page wait longer before it takes another, the right one included
    let wrong = sign_in(admin, "wrong");
    assert_eq!(wrong.status, 401);
    assert!(text(&wrong).contains("Wrong password.") && text(&wrong).contains("current-password"));
    assert_eq!(wrong.header("set-cookie"), None);
    let waits = slowed(hub, 8, || sign_in(admin, "wrong"));
    assert!(
        waits.windows(2).all(|w| w[0] <= w[1]) && *waits.last().unwrap() <= 8,
        "{waits:?}"
    );
    let early = sign_in(admin, "correct horse battery");
    assert_eq!(early.status, 429);
    assert!(text(&early).contains("Too many attempts"));
    hub.clock(early.header("retry-after").unwrap().parse::<i64>().unwrap() * 1000);

    // the right password: a session cookie, and back to the page
    let signed = sign_in(admin, "correct horse battery");
    assert_eq!(signed.status, 303);
    assert_eq!(signed.header("location"), Some("/"));
    let cookie = signed.header("set-cookie").unwrap();
    for part in [
        "HttpOnly",
        "Secure",
        "SameSite=Strict",
        "Path=/",
        "Max-Age=43200",
    ] {
        assert!(cookie.split("; ").any(|p| p == part), "{part}: {cookie}");
    }
    assert!(cookie.starts_with(&format!("{}=", trommi_hub::admin::COOKIE)));
    let value = cookie.split(';').next().unwrap().split_once('=').unwrap().1;
    assert_eq!(trommi_hub::util::unb64(value).unwrap().len(), 32);
    let session = session_of(&signed);
    // each sign-in is a session of its own
    hub.clock(1000);
    let other = session_of(&sign_in(admin, "correct horse battery"));
    assert_ne!(other, session);

    // the page: version and health, the room with its counts and its account, the tables classified
    let page = get(admin, &session);
    assert_eq!(page.status, 200);
    let html = text(&page);
    assert!(html.contains("version <code>dev</code>"));
    assert!(html.contains("<div class=\"k\">Rooms</div><div class=\"v\">1</div>"));
    assert!(html.contains("<div class=\"k\">Accounts</div><div class=\"v\">1</div>"));
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
    for table in [
        "accounts",
        "envelopes",
        "group_log",
        "sealed_keys",
        "files",
        "live_activities",
    ] {
        assert!(html.contains(&format!("<code>{table}</code>")), "{table}");
    }
    assert!(
        !html.contains("Not classified yet"),
        "every table of the schema is in the page's list"
    );
    // nothing of what was written, no key, no hash: the page has only counts and what the hub reads anyway
    assert!(!html.contains("nobody but the room"));
    assert!(!html.contains(&b64(&w.ada.id())) && !html.contains("argon2id$"));
    // the one form is the sign-out; nothing else is taken
    assert_eq!(html.matches("<form").count(), 1);
    assert!(html.contains("<form method=\"post\" action=\"/logout\">"));
    for (method, path) in [
        ("POST", "/"),
        ("DELETE", "/"),
        ("GET", "/login"),
        ("GET", "/rooms"),
        ("GET", "/logout"),
    ] {
        assert_eq!(
            request(admin, method, path, &session, b"").status,
            404,
            "{method} {path}"
        );
    }
    // a session is taken without the slow hash, also while wrong passwords hold the page back
    assert_eq!(sign_in(admin, "correct horse batterx").status, 401);
    assert_eq!(sign_in(admin, "correct horse battery").status, 429);
    assert!(text(&get(admin, &session)).contains("<h1>Overview</h1>"));
    // the longest password `admin-hash` takes fits into the form the page reads; a longer one is wrong unchecked
    let long = "p".repeat(trommi_hub::admin::MAX_PASSWORD);
    let roomy = TestHub::start_with(&[(
        "HUB_ADMIN_PASSWORD_HASH",
        &trommi_hub::admin::hash_password(&long),
    )]);
    let roomy_admin = roomy.admin();
    assert_eq!(sign_in(roomy_admin, &long).status, 303);
    assert_eq!(sign_in(roomy_admin, &format!("{long}p")).status, 401);
    // a body over the limit is no form
    let huge = format!(
        "password={}",
        "%41".repeat(trommi_hub::admin::MAX_PASSWORD * 2)
    );
    assert_eq!(
        request(roomy_admin, "POST", "/login", &from_page(), huge.as_bytes()).status,
        400
    );
    // the page is put together once for all who ask within a few seconds
    assert_eq!(text(&get(admin, &session)), html);
    // and no longer: five seconds on, the page is put together anew
    hub.clock(5001);
    let later = get(admin, &session);
    assert_eq!(later.status, 200);
    assert!(text(&later).contains("ada@example.org"));

    // signing out: only from the page itself; then the session is gone, the other stays
    let mut cross = session.clone();
    cross.push(("origin", "https://evil.example".to_string()));
    assert_eq!(request(admin, "POST", "/logout", &cross, b"").status, 403);
    assert!(text(&get(admin, &session)).contains("Sign out"));
    let mut out = session.clone();
    out.extend(from_page());
    let left = request(admin, "POST", "/logout", &out, b"");
    assert_eq!(left.status, 303);
    assert_eq!(left.header("location"), Some("/"));
    assert!(left.header("set-cookie").unwrap().contains("Max-Age=0"));
    let after = get(admin, &session);
    assert!(!text(&after).contains("Rooms") && text(&after).contains("current-password"));
    assert!(text(&get(admin, &other)).contains("Sign out"));
    // a session ends after twelve hours
    hub.clock(12 * 3_600_000 + 1000);
    assert!(text(&get(admin, &other)).contains("current-password"));

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
