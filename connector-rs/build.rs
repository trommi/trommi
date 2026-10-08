// build.rs: connector/prompt.md and connector-rs/tools.json are compiled in (include_str! in src/prompt.rs). Here they
// are checked the way connector/test.mjs checks them, so a binary with a broken text cannot be built: every tool has a
// section "## <name>" and no section lacks a tool, every description has at most 2048 characters, the instructions at
// most 1900.
use std::collections::BTreeMap;

fn parse(md: &str) -> BTreeMap<String, String> {
    let mut out: BTreeMap<String, String> = BTreeMap::new();
    let mut at: Option<String> = None;
    for line in md.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let h = if let Some(r) = line.strip_prefix("## ") { Some(("##", r)) } else { line.strip_prefix("# ").map(|r| ("#", r)) };
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

fn main() {
    let dir = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let prompt = dir.join("../connector/prompt.md");
    let tools = dir.join("tools.json");
    println!("cargo:rerun-if-changed={}", prompt.display());
    println!("cargo:rerun-if-changed={}", tools.display());
    let md = std::fs::read_to_string(&prompt).expect("connector/prompt.md");
    let p = parse(&md);
    let t: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&tools).expect("connector-rs/tools.json")).expect("tools.json");
    let mut names: Vec<String> = t["tools"].as_array().unwrap().iter().map(|x| x["name"].as_str().unwrap().to_string()).collect();
    names.push("reload_connector".into());
    names.push("inbox".into());
    for n in &names {
        let Some(d) = p.get(&format!("## {n}")) else { panic!("connector/prompt.md has no section \"## {n}\"") };
        assert!(d.chars().count() <= 2048, "the description of {n} has {} characters, at most 2048", d.chars().count());
    }
    for k in p.keys().filter(|k| k.starts_with("## ")) {
        assert!(names.iter().any(|n| format!("## {n}") == *k), "connector/prompt.md has a section {k} without a tool");
    }
    let ins = p.get("# Instructions").expect("# Instructions");
    assert!(ins.chars().count() <= 1900, "the instructions have {} characters, at most 1900", ins.chars().count());
}
