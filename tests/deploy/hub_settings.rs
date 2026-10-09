//! The hub's settings that the deploy path relies on: the push credentials under their names in the 1Password
//! Environment, a key whose line breaks were lost on the way, the switch for HSTS.

use std::collections::HashMap;

use trommi_hub::config::{pem, Config};

fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

// not a real key: only its shape matters here
const KEY: &str = "-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgAAAAAAAAAAAAAAAA\nAAAAAAAAAAAAAAAAAAAAAAAAAAAGhRANCAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAA\nAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n-----END PRIVATE KEY-----\n";

#[test]
fn push_settings_are_read_under_their_1password_names() {
    let cfg = Config::from_map(&env(&[
        ("APPLE_APNS_KEY", KEY),
        ("APPLE_APNS_KEY_ID", "KEYID12345"),
        ("APPLE_TEAM_ID", "TEAMID1234"),
        ("APPLE_APNS_TOPIC", "com.example.app, com.example.app.dev"),
    ]));
    assert_eq!(cfg.apns_key_pem.as_deref(), Some(KEY));
    assert_eq!(cfg.apns_key_id.as_deref(), Some("KEYID12345"));
    assert_eq!(cfg.apns_team_id.as_deref(), Some("TEAMID1234"));
    assert_eq!(cfg.apns_topics, ["com.example.app", "com.example.app.dev"]);
}

#[test]
fn a_key_that_lost_its_line_breaks_is_put_back_together() {
    let one_line = KEY.trim_end().replace('\n', " ");
    assert_eq!(pem(&one_line), KEY);
    assert_eq!(pem(&KEY.replace('\n', "\\n")), KEY);
    assert_eq!(pem(KEY), KEY);
    let cfg = Config::from_map(&env(&[("APPLE_APNS_KEY", &one_line)]));
    assert_eq!(cfg.apns_key_pem.as_deref(), Some(KEY));

    // from a file, as the server keeps it
    let path = std::env::temp_dir().join(format!("trommi-apns-key-{}.p8", std::process::id()));
    std::fs::write(&path, &one_line).unwrap();
    let cfg = Config::from_map(&env(&[("APPLE_APNS_KEY_FILE", path.to_str().unwrap())]));
    assert_eq!(cfg.apns_key_pem.as_deref(), Some(KEY));
    let _ = std::fs::remove_file(path);
}

#[test]
fn hsts_is_off_until_switched_on() {
    assert!(!Config::from_map(&env(&[])).hsts);
    assert!(!Config::from_map(&env(&[("HUB_HSTS", "off")])).hsts);
    assert!(!Config::from_map(&env(&[("HUB_HSTS", "1")])).hsts);
    assert!(Config::from_map(&env(&[("HUB_HSTS", "on")])).hsts);
}
