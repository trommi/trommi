// build.rs: connector/prompt.md and connector/tools.json are compiled in (include_str! in src/prompt.rs). Here they
// are checked, so a binary with a broken text cannot be built: every tool has a
// section "## <name>" and no section lacks a tool, every description has at most 2048 characters, the instructions at
// most 1900 (with either paragraph for <mirror>).
use std::collections::BTreeMap;

fn parse(md: &str) -> BTreeMap<String, String> {
    let mut out: BTreeMap<String, String> = BTreeMap::new();
    let mut at: Option<String> = None;
    for line in md.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let h = if let Some(r) = line.strip_prefix("## ") {
            Some(("##", r))
        } else {
            line.strip_prefix("# ").map(|r| ("#", r))
        };
        match h {
            Some((lvl, rest)) if !rest.trim().is_empty() => {
                let k = format!("{lvl} {}", rest.trim_start_matches(' ').trim_end());
                out.insert(k.clone(), String::new());
                at = Some(k);
            }
            _ => {
                if let Some(k) = &at {
                    let v = out.get_mut(k).unwrap();
                    v.push(' ');
                    v.push_str(line);
                }
            }
        }
    }
    for v in out.values_mut() {
        *v = v.split_whitespace().collect::<Vec<_>>().join(" ");
    }
    out
}

/// Standard base64, as a PEM body is written.
fn base64(text: &str) -> Vec<u8> {
    let mut out = Vec::new();
    let (mut bits, mut count) = (0u32, 0u8);
    for c in text.bytes() {
        let value = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => continue,
        };
        bits = (bits << 6) | u32::from(value);
        count += 6;
        if count >= 8 {
            count -= 8;
            out.push((bits >> count) as u8);
            bits &= (1 << count) - 1;
        }
    }
    out
}

/// What `src/update.rs` holds a release against, written to OUT_DIR/release.rs: the release public key from
/// release/public-key.pem (the last 32 bytes of its SubjectPublicKeyInfo are the Ed25519 key), the target this
/// binary is built for, and the release number CI builds it as (TROMMI_RELEASE_VERSION; 0 for any other build).
fn release_constants(dir: &std::path::Path) {
    let pem_file = dir.join("../release/public-key.pem");
    println!("cargo:rerun-if-changed={}", pem_file.display());
    println!("cargo:rerun-if-env-changed=TROMMI_RELEASE_VERSION");
    let pem = std::fs::read_to_string(&pem_file).expect("release/public-key.pem");
    let body: String = pem
        .lines()
        .filter(|line| !line.starts_with("-----"))
        .collect();
    let der = base64(&body);
    // SubjectPublicKeyInfo of an Ed25519 key: 12 bytes of header, then the key.
    assert!(
        der.len() == 44
            && der[..12]
                == [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00],
        "release/public-key.pem is not an Ed25519 public key"
    );
    let version: u64 = match std::env::var("TROMMI_RELEASE_VERSION") {
        Ok(text) if !text.is_empty() => text
            .parse()
            .expect("TROMMI_RELEASE_VERSION is a whole number"),
        _ => 0,
    };
    let code = format!(
        "/// The release public key: `release/public-key.pem` of this repository, as it was when this was built.\npub const RELEASE_KEY: [u8; 32] = {:?};\n/// The target this binary was built for.\npub const TARGET: &str = {:?};\n/// The release number this binary was built as; 0 for a build that is no release.\npub const RELEASE_VERSION: u64 = {};\n",
        &der[12..],
        std::env::var("TARGET").expect("TARGET"),
        version
    );
    let out = std::path::PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR"));
    std::fs::write(out.join("release.rs"), code).expect("OUT_DIR/release.rs");
}

fn main() {
    release_constants(&std::path::PathBuf::from(
        std::env::var("CARGO_MANIFEST_DIR").unwrap(),
    ));
    let dir = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let prompt = dir.join("prompt.md");
    let tools = dir.join("tools.json");
    println!("cargo:rerun-if-changed={}", prompt.display());
    println!("cargo:rerun-if-changed={}", tools.display());
    let md = std::fs::read_to_string(&prompt).expect("connector/prompt.md");
    let p = parse(&md);
    let t: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&tools).expect("connector/tools.json"))
            .expect("tools.json");
    let mut names: Vec<String> = t["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x["name"].as_str().unwrap().to_string())
        .collect();
    names.push("reload_connector".into());
    names.push("inbox".into());
    names.push("connect".into());
    for n in &names {
        let Some(d) = p.get(&format!("## {n}")) else {
            panic!("connector/prompt.md has no section \"## {n}\"")
        };
        assert!(
            d.chars().count() <= 2048,
            "the description of {n} has {} characters, at most 2048",
            d.chars().count()
        );
    }
    for k in p.keys().filter(|k| k.starts_with("## ")) {
        assert!(
            names.iter().any(|n| format!("## {n}") == *k),
            "connector/prompt.md has a section {k} without a tool"
        );
    }
    let ins = p.get("# Instructions").expect("# Instructions");
    assert!(
        ins.contains("<mirror>"),
        "the instructions have no <mirror>"
    );
    for how in [
        "# With the terminal mirror",
        "# Without the terminal mirror",
    ] {
        let n = ins
            .replacen(
                "<mirror>",
                p.get(how)
                    .unwrap_or_else(|| panic!("connector/prompt.md has no section \"{how}\"")),
                1,
            )
            .chars()
            .count();
        assert!(
            n <= 1900,
            "the instructions ({how}) have {n} characters, at most 1900"
        );
    }
}
