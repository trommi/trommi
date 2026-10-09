//! The bridge: what each tool does in the room, and a human's command (verified and authorised by
//! the core) as a <channel> event. Every word the agent reads is from connector/prompt.md.
use crate::client::{BoxFut, Client, Command};
use crate::error::{Fault, Result};
use crate::html::{clean_fences, fences_hide, fences_show, html_beside, stripped_hint};
use crate::model::{self, Card};
use crate::util::{now_ms, truthy};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub const MAX_ASSET: u64 = 64 * 1024 * 1024;
pub const ASSET_TYPES: [&str; 5] = ["html", "image", "video", "audio", "file"];
pub const RETENTION_DAYS: u64 = 30;
/// A Share link lasts at most 180 days (spec/v2.md 11.5).
pub const SHARE_MAX_DAYS: u64 = 180;
const SHARE_MAX_HOURS: f64 = (SHARE_MAX_DAYS * 24) as f64;
pub const URGENCIES: [&str; 4] = ["low", "normal", "high", "critical"];
pub const STATUSES: [&str; 3] = ["decision", "working", "done"];
pub const NEEDS_UPDATE: &str = "Tell the human that the Trommi connector needs an update to show it (Claude Code: update the trommi plugin, or run the connect script again, then /mcp → trommi → Reconnect). Do not guess what it said.";
pub const SESSION_ENDED: &str = "Closed with its session.";
pub const SHORT_MAX: usize = 18;
pub const TEASER_MAX: usize = 160;

fn err(s: impl Into<String>) -> Fault {
    Fault::plain(s)
}
/// String(v ?? '') as JS writes it.
fn s(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(v) => js_str(v),
    }
}
/// String(v) as JS writes it.
pub fn js_str(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.clone(),
        Value::Array(a) => a
            .iter()
            .map(|x| {
                if x.is_null() {
                    String::new()
                } else {
                    js_str(x)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}
fn trim(x: &str) -> String {
    crate::util::js_trim(x).to_string()
}
fn utf16_len(x: &str) -> usize {
    x.encode_utf16().count()
}
/// JS s.slice(0, n) on UTF-16 units.
fn utf16_slice(x: &str, n: usize) -> String {
    let u: Vec<u16> = x.encode_utf16().take(n).collect();
    String::from_utf16_lossy(&u)
}
fn present(v: Option<&Value>) -> bool {
    !matches!(v, None | Some(Value::Null))
}
/// An option in two or three words, for the answer tile on a Desk row. Longer is cut at a word.
pub fn short_of(v: Option<&Value>) -> String {
    let said = s(v).split_whitespace().collect::<Vec<_>>().join(" ");
    if utf16_len(&said) <= SHORT_MAX {
        return said;
    }
    let cut = utf16_slice(&said, SHORT_MAX + 1);
    let r = if let Some(i) = cut.rfind(' ') {
        cut[..i].to_string()
    } else {
        utf16_slice(&said, SHORT_MAX)
    };
    trim(&r)
}
fn with_short(m: &mut Map<String, Value>, v: Option<&Value>) {
    let s = short_of(v);
    if !s.is_empty() {
        m.insert("short".into(), json!(s));
    }
}
fn with_final(m: &mut Map<String, Value>, v: Option<&Value>) {
    if v == Some(&Value::Bool(true)) {
        m.insert("final".into(), json!(true));
    }
}
fn list_arg(v: Option<&Value>, what: &str) -> Result<Vec<Value>> {
    match v {
        None | Some(Value::Null) => Ok(vec![]),
        Some(Value::Array(a)) => Ok(a.clone()),
        Some(_) => Err(err(format!("{what} must be a list"))),
    }
}
fn urgency_arg(v: Option<&Value>, fallback: Option<&str>) -> Result<String> {
    let given = match v {
        None | Some(Value::Null) => None,
        Some(Value::String(x)) if x.is_empty() => None,
        Some(x) => Some(x.clone()),
    };
    match given {
        None => match fallback {
            Some(f) => Ok(f.into()),
            None => Err(err(format!(
                "urgency must be one of {}",
                URGENCIES.join(", ")
            ))),
        },
        Some(x) => {
            let u = x.as_str().unwrap_or("");
            if !URGENCIES.contains(&u) {
                return Err(err(format!(
                    "urgency must be one of {}; got \"{}\"",
                    URGENCIES.join(", "),
                    js_str(&x)
                )));
            }
            Ok(u.into())
        }
    }
}

// ---- a question as one structured text ------------------------------------------------------------------------

fn parse_sections(text: &str) -> Vec<Value> {
    let flagged = fancy_regex::Regex::new(r"^\[([\w.-]+)([*!]{0,2})\](?!\()[ \t]*").unwrap();
    let pic = regex::Regex::new(r"(?im)\n[ \t]*picture:[ \t]*(.+)$").unwrap();
    let shrt = regex::Regex::new(r"(?im)\n[ \t]*short:[ \t]*(.+)$").unwrap();
    let advice = regex::Regex::new(r"(?i)\s*(\*|\(recommended\))\s*$").unwrap();
    let norm = text.replace("\r\n", "\n").replace('\r', "\n");
    let hidden = fences_hide(&norm);
    let split = regex::Regex::new(r"\n[ \t]*\n").unwrap();
    split
        .split(&hidden)
        .map(|p| trim(&fences_show(p)))
        .filter(|p| !p.is_empty())
        .map(|par| {
            let Ok(Some(flag)) = flagged.captures(&par) else {
                return json!({ "text": par });
            };
            let whole = flag.get(0).unwrap().as_str().len();
            let key = flag.get(1).unwrap().as_str().to_string();
            let marks = flag.get(2).unwrap().as_str().to_string();
            let mut picture: Option<String> = None;
            let mut short: Option<String> = None;
            let rest = &par[whole..];
            // the first `picture:` line (from the end, as JS's $ with m and a single replace takes the first match)
            let rest = match pic.captures(rest) {
                Some(c) => {
                    picture = Some(trim(&c[1]));
                    let m = c.get(0).unwrap();
                    format!("{}{}", &rest[..m.start()], &rest[m.end()..])
                }
                None => rest.to_string(),
            };
            let rest = match shrt.captures(&rest) {
                Some(c) => {
                    short = Some(trim(&c[1]));
                    let m = c.get(0).unwrap();
                    format!("{}{}", &rest[..m.start()], &rest[m.end()..])
                }
                None => rest,
            };
            let mut lines = rest.split('\n');
            let first = lines.next().unwrap_or("").to_string();
            let others: Vec<&str> = lines.collect();
            let colon = regex::Regex::new(r":(\s|$)")
                .unwrap()
                .find(&first)
                .map(|m| m.start());
            let mut advised = marks.contains('*');
            let label_raw = match colon {
                Some(i) => first[..i].to_string(),
                None => first.clone(),
            };
            let label = if advice.is_match(&label_raw) {
                advised = true;
                advice.replace(&label_raw, "").to_string()
            } else {
                label_raw
            };
            let mut body_parts = vec![match colon {
                Some(i) => first[i + 1..].to_string(),
                None => String::new(),
            }];
            body_parts.extend(others.iter().map(|x| x.to_string()));
            let mut m = Map::new();
            m.insert("key".into(), json!(key));
            m.insert("label".into(), json!(trim(&label)));
            m.insert("text".into(), json!(trim(&body_parts.join("\n"))));
            if advised {
                m.insert("recommended".into(), json!(true));
            }
            if marks.contains('!') {
                m.insert("final".into(), json!(true));
            }
            if let Some(p) = picture {
                m.insert("picture".into(), json!(p));
            }
            if let Some(sh) = short {
                m.insert("short".into(), json!(sh));
            }
            Value::Object(m)
        })
        .collect()
}

fn basename(p: &str) -> String {
    Path::new(p)
        .file_name()
        .map(|x| x.to_string_lossy().to_string())
        .unwrap_or_else(|| p.to_string())
}

fn picture_of(r: &Value, names: &[String], key: &str) -> Result<usize> {
    let at: i64 = match r {
        Value::Number(n) if n.is_i64() => n.as_i64().unwrap(),
        Value::String(x) if !x.is_empty() && x.chars().all(|c| c.is_ascii_digit()) => {
            x.parse().unwrap_or(-1)
        }
        v => {
            let x = js_str(v);
            names
                .iter()
                .position(|n| *n == x || *n == basename(&x))
                .map(|i| i as i64)
                .unwrap_or(-1)
        }
    };
    if !(at >= 0 && (at as usize) < names.len()) {
        let list = if names.is_empty() {
            "it has none".to_string()
        } else {
            names
                .iter()
                .enumerate()
                .map(|(i, n)| format!("{i}: {n}"))
                .collect::<Vec<_>>()
                .join(", ")
        };
        return Err(err(format!("section \"{key}\" names the picture \"{}\", which is not among this card's attachments ({list}); give a file name or a position counted from 0", js_str(r))));
    }
    Ok(at as usize)
}

fn sections_of(args: &Map<String, Value>, names: &[String]) -> Result<Vec<Map<String, Value>>> {
    let has_sections = present(args.get("sections"));
    if has_sections && present(args.get("text")) {
        return Err(err(
            "give sections or text, not both: text is the same thing written as one block",
        ));
    }
    let what = if has_sections { "sections" } else { "text" };
    if present(args.get("options")) {
        return Err(err(format!("{what} and options cannot be combined: the flagged blocks are the options. Flag a block with key and label, or go back to body and options")));
    }
    if present(args.get("body")) {
        return Err(err(format!("{what} and body cannot be combined: the blocks are the body. Put the introduction in as a first block without a key")));
    }
    let blocks = if has_sections {
        list_arg(args.get("sections"), "sections")?
    } else {
        parse_sections(&s(args.get("text")))
    };
    let mut out = vec![];
    for (i, b) in blocks.iter().enumerate() {
        let b = if let Value::String(x) = b {
            json!({ "text": x })
        } else {
            b.clone()
        };
        let said = clean_fences(&trim(&s(b.get("text"))), &format!("section {}", i + 1))?;
        let key_shown = b
            .get("key")
            .filter(|k| truthy(k))
            .map(js_str)
            .unwrap_or_else(|| (i + 1).to_string());
        let rich = html_beside(
            b.get("html").unwrap_or(&Value::Null),
            &said,
            &format!("the html of section {key_shown}"),
            "text",
        )?;
        let key = b.get("key");
        let mut m = Map::new();
        if key.is_none_or(|k| k.is_null() || k.as_str() == Some("")) {
            if said.is_empty() {
                return Err(err(format!(
                    "section {} is empty: a block without a key needs text",
                    i + 1
                )));
            }
            m.insert("text".into(), json!(said));
            if !rich.is_empty() {
                m.insert("html".into(), json!(rich));
            }
            out.push(m);
            continue;
        }
        let key = js_str(key.unwrap());
        let label = trim(&s(b.get("label")));
        if label.is_empty() {
            return Err(err(format!("section \"{key}\" has a key, so it becomes an option and needs a label: the short name on its tile, at most about four words")));
        }
        m.insert("key".into(), json!(key));
        m.insert("label".into(), json!(label));
        m.insert("text".into(), json!(said));
        if !rich.is_empty() {
            m.insert("html".into(), json!(rich));
        }
        with_short(&mut m, b.get("short"));
        with_final(&mut m, b.get("final"));
        m.insert(
            "recommended".into(),
            json!(b.get("recommended") == Some(&Value::Bool(true))),
        );
        if let Some(p) = b
            .get("picture")
            .filter(|p| !p.is_null() && p.as_str() != Some(""))
        {
            m.insert("picture".into(), json!(picture_of(p, names, &key)?));
        }
        out.push(m);
    }
    Ok(out)
}
fn body_of(sections: &[Map<String, Value>]) -> String {
    sections
        .iter()
        .map(|x| {
            if x.get("key").is_none() {
                s(x.get("text"))
            } else {
                let t = s(x.get("text"));
                format!(
                    "**{}**{}",
                    s(x.get("label")),
                    if t.is_empty() {
                        String::new()
                    } else {
                        format!(": {t}")
                    }
                )
            }
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn teaser_arg(v: Option<&Value>) -> Result<Value> {
    let said = s(v).split_whitespace().collect::<Vec<_>>().join(" ");
    let n = said.chars().count();
    if n > TEASER_MAX {
        return Err(err(format!("teaser is {n} characters, at most {TEASER_MAX}: the Desk shows only two short lines. Keep the question in it and move the rest into the body or sections")));
    }
    Ok(if said.is_empty() {
        Value::Null
    } else {
        json!(said)
    })
}

/// The recommendation given to questionFields: absent (derive from the sections), none (NO_ADVICE), or given.
#[derive(Clone)]
enum Advice {
    Absent,
    None_,
    Given(Value),
}

/// The content of a decision card, checked as the board checks it.
fn question_fields(
    args: &Map<String, Value>,
    names: &[String],
    advice: Advice,
) -> Result<Map<String, Value>> {
    let sections = if present(args.get("sections")) || present(args.get("text")) {
        Some(sections_of(args, names)?)
    } else {
        None
    };
    if sections.is_some() && present(args.get("html")) && truthy(args.get("html").unwrap()) {
        return Err(err("html and sections (or text) cannot be combined: give the layout to the block it belongs to, as html on that section, or fenced as ```html inside the text"));
    }
    let body = match &sections {
        Some(x) => body_of(x),
        None => clean_fences(&s(args.get("body")), "body")?,
    };
    let html = if sections.is_some() {
        String::new()
    } else {
        html_beside(
            args.get("html").unwrap_or(&Value::Null),
            &body,
            "html",
            "body",
        )?
    };
    let flagged: Option<Vec<&Map<String, Value>>> = sections
        .as_ref()
        .map(|x| x.iter().filter(|b| b.contains_key("key")).collect());
    let options: Vec<Value> = match &flagged {
        Some(f) => f
            .iter()
            .map(|b| {
                let mut o = Map::new();
                o.insert("key".into(), b["key"].clone());
                o.insert("label".into(), b["label"].clone());
                o.insert("detail".into(), json!(""));
                with_short(&mut o, b.get("short"));
                with_final(&mut o, b.get("final"));
                Value::Object(o)
            })
            .collect(),
        None => list_arg(args.get("options"), "options")?
            .iter()
            .map(|o| {
                let mut m = Map::new();
                m.insert(
                    "key".into(),
                    json!(o
                        .get("key")
                        .map(js_str)
                        .unwrap_or_else(|| "undefined".into())),
                );
                m.insert(
                    "label".into(),
                    json!(o
                        .get("label")
                        .map(js_str)
                        .unwrap_or_else(|| "undefined".into())),
                );
                m.insert(
                    "detail".into(),
                    json!(if o.get("detail").is_some_and(truthy) {
                        js_str(&o["detail"])
                    } else {
                        String::new()
                    }),
                );
                with_short(&mut m, o.get("short"));
                with_final(&mut m, o.get("final"));
                Value::Object(m)
            })
            .collect(),
    };
    let keys: Vec<String> = options.iter().map(|o| s(o.get("key"))).collect();
    let unique: HashSet<&String> = keys.iter().collect();
    if options.len() < 2 || unique.len() != options.len() {
        return Err(err(if sections.is_some() {
            "a question needs at least two options with unique keys: flag at least two blocks with key and label (in text: paragraphs starting with [key] Label:)"
        } else {
            "options need at least two entries with unique keys"
        }));
    }
    if trim(&s(args.get("title"))).is_empty() {
        return Err(err("a question needs a title"));
    }
    let urgency = urgency_arg(args.get("urgency"), Some("normal"))?;
    let multiple = args.get("multiple") == Some(&Value::Bool(true));
    let marked: Vec<String> = flagged
        .as_ref()
        .map(|f| {
            f.iter()
                .filter(|b| b.get("recommended") == Some(&Value::Bool(true)))
                .map(|b| s(b.get("key")))
                .collect()
        })
        .unwrap_or_default();
    let given: Option<Value> = match advice {
        Advice::None_ => None,
        Advice::Given(v) => Some(v),
        Advice::Absent => match args.get("recommended") {
            Some(v) if !v.is_null() => Some(v.clone()),
            _ => {
                if marked.is_empty() {
                    None
                } else if multiple || marked.len() > 1 {
                    Some(json!(marked))
                } else {
                    Some(json!(marked[0]))
                }
            }
        },
    };
    let advised: Vec<String> = match &given {
        None => vec![],
        Some(Value::Array(a)) => a.iter().map(js_str).collect(),
        Some(v) => vec![js_str(v)],
    };
    if let Some(stray) = advised.iter().find(|k| !keys.contains(k)) {
        return Err(err(format!(
            "recommended must be the key of one of the options; got \"{stray}\""
        )));
    }
    if matches!(given, Some(Value::Array(_))) && !multiple {
        return Err(err("recommended as a list needs multiple: true; a card with one answer has one recommendation"));
    }
    let mut out = Map::new();
    out.insert("card_type".into(), json!("decision"));
    out.insert("title".into(), json!(s(args.get("title"))));
    out.insert("teaser".into(), teaser_arg(args.get("teaser"))?);
    out.insert("body".into(), json!(body));
    out.insert(
        "html".into(),
        if html.is_empty() {
            Value::Null
        } else {
            json!(html)
        },
    );
    out.insert("options".into(), Value::Array(options));
    out.insert(
        "sections".into(),
        match &sections {
            Some(x) => Value::Array(
                x.iter()
                    .map(|b| {
                        if b.contains_key("key") {
                            let mut m = b.clone();
                            m.insert(
                                "recommended".into(),
                                json!(advised.contains(&s(b.get("key")))),
                            );
                            Value::Object(m)
                        } else {
                            Value::Object(b.clone())
                        }
                    })
                    .collect(),
            ),
            None => Value::Null,
        },
    );
    out.insert("allows_multiple".into(), json!(multiple));
    out.insert(
        "recommended".into(),
        if matches!(given, Some(Value::Array(_))) {
            json!(advised)
        } else {
            advised.first().map(|x| json!(x)).unwrap_or(Value::Null)
        },
    );
    out.insert("urgency".into(), json!(urgency));
    out.insert(
        "urgency_reason".into(),
        json!(trim(&s(args.get("urgency_reason")))),
    );
    Ok(out)
}

/// The content of an info card.
fn info_fields(args: &Map<String, Value>, names: &[String]) -> Result<Map<String, Value>> {
    for key in ["options", "multiple", "recommended"] {
        if present(args.get(key)) {
            return Err(err(format!("an info has no {key}: it asks nothing, the human reads it and closes it. Something to choose is a question: create_decision")));
        }
    }
    let sections = if present(args.get("sections")) || present(args.get("text")) {
        Some(sections_of(args, names)?)
    } else {
        None
    };
    if let Some(f) = sections
        .as_ref()
        .and_then(|x| x.iter().find(|b| b.contains_key("key")))
    {
        return Err(err(format!("an info has no options, so no block may have a key (got \"{}\"). Something to choose is a question: create_decision", s(f.get("key")))));
    }
    if sections.is_some() && args.get("html").is_some_and(truthy) {
        return Err(err("html and sections (or text) cannot be combined: give the layout to the block it belongs to, as html on that section, or fenced as ```html inside the text"));
    }
    let body = match &sections {
        Some(x) => body_of(x),
        None => clean_fences(&s(args.get("body")), "body")?,
    };
    let html = if sections.is_some() {
        String::new()
    } else {
        html_beside(
            args.get("html").unwrap_or(&Value::Null),
            &body,
            "html",
            "body",
        )?
    };
    if trim(&s(args.get("title"))).is_empty() {
        return Err(err("an info needs a title"));
    }
    if trim(&body).is_empty() && html.is_empty() {
        return Err(err(
            "an info needs something to read: body, sections or text",
        ));
    }
    let mut out = Map::new();
    out.insert("card_type".into(), json!("info"));
    out.insert("title".into(), json!(s(args.get("title"))));
    out.insert("teaser".into(), teaser_arg(args.get("teaser"))?);
    out.insert("body".into(), json!(body));
    out.insert(
        "html".into(),
        if html.is_empty() {
            Value::Null
        } else {
            json!(html)
        },
    );
    out.insert("options".into(), json!([]));
    out.insert(
        "sections".into(),
        sections
            .map(|x| Value::Array(x.into_iter().map(Value::Object).collect()))
            .unwrap_or(Value::Null),
    );
    out.insert("allows_multiple".into(), json!(false));
    out.insert("recommended".into(), Value::Null);
    out.insert(
        "urgency".into(),
        json!(urgency_arg(args.get("urgency"), Some("normal"))?),
    );
    out.insert(
        "urgency_reason".into(),
        json!(trim(&s(args.get("urgency_reason")))),
    );
    Ok(out)
}

fn names_of(list: Option<&Value>) -> Result<Vec<String>> {
    Ok(list_arg(list, "attachments")?
        .iter()
        .map(|f| basename(&s(f.get("path").or(Some(f)))))
        .collect())
}

// ---- files ------------------------------------------------------------------------------------------------------

pub fn media_type_of(name: &str) -> &'static str {
    let ext = Path::new(name)
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy().to_lowercase()))
        .unwrap_or_default();
    match ext.as_str() {
        ".png" => "image/png",
        ".jpg" | ".jpeg" => "image/jpeg",
        ".gif" => "image/gif",
        ".webp" => "image/webp",
        ".svg" => "image/svg+xml",
        ".avif" => "image/avif",
        ".mp4" => "video/mp4",
        ".webm" => "video/webm",
        ".mov" => "video/quicktime",
        ".mp3" => "audio/mpeg",
        ".m4a" => "audio/mp4",
        ".ogg" => "audio/ogg",
        ".wav" => "audio/wav",
        ".html" | ".htm" => "text/html",
        ".txt" => "text/plain",
        ".md" => "text/markdown",
        ".json" => "application/json",
        ".pdf" => "application/pdf",
        ".csv" => "text/csv",
        ".diff" | ".patch" => "text/x-diff",
        ".zip" => "application/zip",
        _ => "application/octet-stream",
    }
}
/// A file name from someone else, as one harmless path component.
pub fn safe_name(name: &str) -> String {
    let b = basename(if name.is_empty() { "file" } else { name });
    let r = regex::Regex::new(r"[^A-Za-z0-9_.-]+")
        .unwrap()
        .replace_all(&b, "_")
        .to_string();
    let r = r.trim_start_matches('.').to_string();
    let r: String = r.chars().take(100).collect();
    if r.is_empty() {
        "file".into()
    } else {
        r
    }
}
fn asset_type_of(media: &str) -> String {
    if media == "text/html" {
        "html".into()
    } else if media.starts_with("image/")
        || media.starts_with("video/")
        || media.starts_with("audio/")
    {
        media.split('/').next().unwrap().into()
    } else {
        "file".into()
    }
}
/// Width and height of a PNG or JPEG (header read only).
fn picture_size(b: &[u8]) -> Option<(u32, u32)> {
    if b.len() > 24 && b[0] == 0x89 && b[1] == 0x50 {
        return Some((
            u32::from_be_bytes(b[16..20].try_into().unwrap()),
            u32::from_be_bytes(b[20..24].try_into().unwrap()),
        ));
    }
    if b.len() > 2 && b[0] == 0xff && b[1] == 0xd8 {
        let mut i = 2;
        while i + 9 < b.len() {
            if b[i] != 0xff {
                break;
            }
            let marker = b[i + 1];
            let len = ((b[i + 2] as usize) << 8) | b[i + 3] as usize;
            if (0xc0..=0xc3).contains(&marker) {
                return Some((
                    ((b[i + 7] as u32) << 8) | b[i + 8] as u32,
                    ((b[i + 5] as u32) << 8) | b[i + 6] as u32,
                ));
            }
            i += 2 + len;
        }
    }
    None
}
fn mark_of(m: &Value) -> Result<Option<Value>> {
    if !m.is_object() {
        return Ok(None);
    }
    let n = |k: &str| m.get(k).and_then(num);
    let w = n("w").filter(|x| *x != 0.0).or_else(|| n("width"));
    let h = n("h").filter(|x| *x != 0.0).or_else(|| n("height"));
    if n("x").is_none() || n("y").is_none() || w.is_none() || h.is_none() {
        return Err(err(
            "a mark needs x, y, w and h, fractions of the picture from 0 to 1",
        ));
    }
    let mut o = Map::new();
    o.insert(
        "x".into(),
        m["x"]
            .clone()
            .as_f64()
            .map(num_value)
            .unwrap_or(json!(n("x"))),
    );
    o.insert(
        "y".into(),
        m["y"]
            .clone()
            .as_f64()
            .map(num_value)
            .unwrap_or(json!(n("y"))),
    );
    o.insert(
        "width".into(),
        num_value(
            m.get("w")
                .filter(|v| !v.is_null())
                .or(m.get("width"))
                .and_then(num)
                .unwrap_or(f64::NAN),
        ),
    );
    o.insert(
        "height".into(),
        num_value(
            m.get("h")
                .filter(|v| !v.is_null())
                .or(m.get("height"))
                .and_then(num)
                .unwrap_or(f64::NAN),
        ),
    );
    if let Some(l) = m.get("label").filter(|l| truthy(l)) {
        o.insert("label".into(), json!(utf16_slice(&js_str(l), 24)));
    }
    Ok(Some(Value::Object(o)))
}
fn num(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(x) => {
            let t = x.trim();
            if t.is_empty() {
                Some(0.0)
            } else {
                t.parse::<f64>().ok()
            }
        }
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        Value::Null => Some(0.0),
        _ => None,
    }
    .filter(|x| x.is_finite())
}
fn num_value(x: f64) -> Value {
    if x.fract() == 0.0 && x.abs() < 9e15 {
        json!(x as i64)
    } else {
        json!(x)
    }
}

/// Which session a command, an event or a write is about (for the receipt).
#[derive(Clone, Debug, Default)]
pub struct About {
    pub session_id: Option<String>,
    pub envelope_number: Option<u64>,
}
pub type Notify = Arc<dyn Fn(String, Value, Option<About>) -> BoxFut<'static, ()> + Send + Sync>;
pub type SaveState = Arc<dyn Fn(Value) + Send + Sync>;

pub struct Bridge {
    pub client: Arc<Client>,
    notify: Notify,
    cache_dir: PathBuf,
    pub state: Mutex<Map<String, Value>>,
    save: SaveState,
    opening: tokio::sync::Mutex<()>,
    asking: Mutex<HashSet<String>>,
    dropped: Mutex<HashSet<String>>,
    /// Per turn of the trail: the next step number and the items already sent.
    trail_sent: Mutex<HashMap<String, (u32, HashSet<String>)>>,
}

impl Bridge {
    pub fn new(
        client: Arc<Client>,
        notify: Notify,
        cache_dir: PathBuf,
        state: Map<String, Value>,
        save: SaveState,
    ) -> Arc<Bridge> {
        let mut state = state;
        for k in ["permissions", "shares", "children"] {
            if !state.get(k).is_some_and(|v| v.is_object()) {
                state.insert(k.into(), json!({}));
            }
        }
        Arc::new(Bridge {
            client,
            notify,
            cache_dir,
            state: Mutex::new(state),
            save,
            opening: tokio::sync::Mutex::new(()),
            asking: Mutex::new(HashSet::new()),
            dropped: Mutex::new(HashSet::new()),
            trail_sent: Mutex::new(HashMap::new()),
        })
    }
    fn save_state(&self) {
        let v = Value::Object(self.state.lock().unwrap().clone());
        (self.save)(v);
    }
    fn me(&self) -> String {
        self.client.me()
    }

    // ---- child sessions ----------------------------------------------------------------------------------------
    async fn find_child(&self, name: &str) -> Option<String> {
        let key = name.to_lowercase();
        let known = self.state.lock().unwrap()["children"]
            .get(&key)
            .and_then(|c| c["session_id"].as_str().map(String::from));
        let c = self.client.core.lock().await;
        let ids = c.session_ids();
        if let Some(k) = known.filter(|k| ids.contains(k)) {
            return Some(k);
        }
        for sid in c.child_session_ids() {
            let an = c
                .model
                .sessions
                .get(&sid)
                .and_then(|s| s.profile.as_ref())
                .and_then(|p| p.get("agent_name"))
                .map(|v| {
                    if v.is_null() {
                        String::new()
                    } else {
                        js_str(v)
                    }
                })
                .unwrap_or_default();
            if an.to_lowercase() != key {
                continue;
            }
            drop(c);
            self.state.lock().unwrap()["children"]
                .as_object_mut()
                .unwrap()
                .insert(key, json!({ "session_id": sid, "name": name }));
            self.save_state();
            return Some(sid);
        }
        None
    }
    async fn child_name(&self, sid: Option<&str>) -> Option<String> {
        let sid = sid?;
        let c = self.client.core.lock().await;
        if Some(sid.to_string()) == c.session_id() {
            return None;
        }
        let hit = self.state.lock().unwrap()["children"]
            .as_object()
            .unwrap()
            .values()
            .find(|x| x["session_id"].as_str() == Some(sid))
            .and_then(|x| x["name"].as_str().map(String::from));
        hit.or_else(|| {
            c.model
                .sessions
                .get(sid)
                .and_then(|s| s.profile.as_ref())
                .and_then(|p| p.get("agent_name"))
                .filter(|v| !v.is_null())
                .map(js_str)
        })
        .or_else(|| Some(sid.chars().take(12).collect()))
    }
    /// The session a tool call writes into: None for the main session, else the named child (opened on first use).
    async fn session_of(
        &self,
        args: &Map<String, Value>,
        profile: Map<String, Value>,
    ) -> Result<Option<String>> {
        let name = if present(args.get("session")) {
            trim(&s(args.get("session")))
        } else {
            String::new()
        };
        if name.is_empty() {
            return Ok(None);
        }
        if utf16_len(&name) > 40 || name.contains('\n') || name.contains('\r') {
            return Err(err(
                "session is a helper's short name, at most 40 characters",
            ));
        }
        let _g = self.opening.lock().await;
        if let Some(found) = self.find_child(&name).await {
            self.reopen(&found).await?;
            return Ok(Some(found));
        }
        let key = name.to_lowercase();
        let model = self
            .my_session(None)
            .await
            .and_then(|s| s.profile)
            .and_then(|p| p.get("model").cloned())
            .filter(truthy);
        let mut p = Map::new();
        p.insert("agent_name".into(), json!(name));
        if let Some(m) = model {
            p.insert("model".into(), m);
        }
        for (k, v) in profile {
            p.insert(k, v);
        }
        let sid = self.client.open_child_session(p).await?;
        self.state.lock().unwrap()["children"]
            .as_object_mut()
            .unwrap()
            .insert(key, json!({ "session_id": sid, "name": name }));
        self.save_state();
        eprintln!("[trommi] child session \"{name}\" opened: {sid}");
        Ok(Some(sid))
    }
    /// A closed child (close_session) that is written to again is open again.
    async fn reopen(&self, sid: &str) -> Result<()> {
        let p = self.my_session(Some(sid)).await.and_then(|s| s.profile);
        let Some(Value::Object(mut p)) = p else {
            return Ok(());
        };
        if !p.get("closed_at").is_some_and(truthy) {
            return Ok(());
        }
        p.remove("closed_at");
        let mut v = Map::new();
        v.insert("profile".into(), Value::Object(p));
        self.client.set_status(v, Some(sid.into())).await?;
        Ok(())
    }
    async fn my_session(&self, sid: Option<&str>) -> Option<model::Session> {
        let c = self.client.core.lock().await;
        let id = sid
            .map(String::from)
            .or_else(|| c.session_id())
            .unwrap_or_else(|| self.me());
        c.model.sessions.get(&id).cloned()
    }
    async fn my_cards(&self) -> Vec<Card> {
        let c = self.client.core.lock().await;
        let me = self.me();
        let mut v: Vec<Card> = c
            .model
            .cards
            .values()
            .filter(|k| {
                c.model
                    .holder_of(&k.agent_device_id, k.session_id.as_deref())
                    == me
            })
            .cloned()
            .collect();
        v.sort_by_key(|k| k.first_envelope_number);
        v
    }
    async fn find_card(&self, r: Option<&Value>) -> Result<Card> {
        let id = trim(&s(r)).to_lowercase();
        if id.is_empty() {
            return Err(err("card_id is required"));
        }
        let mine = self.my_cards().await;
        let exact = mine.iter().find(|c| c.object_id == id).cloned();
        let pref: Vec<&Card> = if utf16_len(&id) >= 4 {
            mine.iter()
                .filter(|c| c.object_id.starts_with(&id))
                .collect()
        } else {
            vec![]
        };
        let hit = exact.or_else(|| pref.first().map(|c| (*c).clone()));
        match hit {
            Some(h) if h.object_id == id || pref.len() <= 1 => Ok(h),
            _ => Err(err(format!(
                "no card {} of yours; list_cards shows your cards",
                s(r)
            ))),
        }
    }
    async fn place_of(&self, object_id: &str) -> String {
        let c = self.client.core.lock().await;
        match c.model.stack.iter().position(|x| x == object_id) {
            None => "not in the stack yet".into(),
            Some(at) => format!(
                "position {} of {} in the stack",
                at + 1,
                c.model.stack.len()
            ),
        }
    }

    // ---- files -----------------------------------------------------------------------------------------------
    async fn upload(
        &self,
        entry: &Value,
        object_id: Option<&str>,
    ) -> Result<(Map<String, Value>, Option<Map<String, Value>>)> {
        let given = if entry.is_object() {
            entry.clone()
        } else {
            json!({ "path": entry })
        };
        let gp = s(given.get("path"));
        let file = abs(&gp);
        if gp.is_empty() || !file.is_file() {
            return Err(err(format!(
                "attachment not found: {}",
                js_str(given.get("path").unwrap_or(&Value::Null))
            )));
        }
        let size = std::fs::metadata(&file)?.len();
        let fname = basename(&file.display().to_string());
        if size > MAX_ASSET {
            return Err(err(format!(
                "{fname} is {} MB; at most {} MB",
                (size as f64 / 1048576.0).round(),
                MAX_ASSET / 1048576
            )));
        }
        let bytes = std::fs::read(&file)?;
        let media = media_type_of(&file.display().to_string());
        let mut marks = vec![];
        if let Some(m) = given.get("mark").filter(|m| truthy(m)) {
            marks.push(m.clone());
        }
        marks.extend(list_arg(given.get("marks"), "marks")?);
        let marks: Vec<Value> = marks
            .into_iter()
            .take(4)
            .map(|m| mark_of(&m))
            .collect::<Result<Vec<_>>>()?
            .into_iter()
            .flatten()
            .collect();
        let mut page: Option<String> = given.get("page").filter(|p| !p.is_null()).map(js_str);
        let mut page_ref = None;
        let sibling =
            if media.starts_with("image/") && given.get("page").is_none_or(|p| p.is_null()) {
                let fs_ = file.display().to_string();
                let stem = regex::Regex::new(r"\.[^./]+$").unwrap();
                [".html", ".htm"]
                    .iter()
                    .map(|ext| PathBuf::from(stem.replace(&fs_, *ext).to_string()))
                    .find(|f| *f != file && f.exists())
            } else {
                None
            };
        let page_file: Option<PathBuf> = match given.get("page") {
            Some(Value::String(p))
                if !regex::Regex::new(r"(?i)^(https?:)?/").unwrap().is_match(p) =>
            {
                Some(abs(p))
            }
            Some(Value::String(p)) if p.starts_with('/') && Path::new(p).exists() => {
                Some(PathBuf::from(p))
            }
            _ => sibling,
        };
        if let Some(pf) = page_file.filter(|p| p.is_file()) {
            let mut meta = Map::new();
            meta.insert(
                "file_name".into(),
                json!(basename(&pf.display().to_string())),
            );
            meta.insert(
                "media_type".into(),
                json!(media_type_of(&pf.display().to_string())),
            );
            if let Some(o) = object_id {
                meta.insert("object_id".into(), json!(o));
            }
            let r = self
                .client
                .upload_attachment(std::fs::read(&pf)?, meta)
                .await?;
            page = Some(format!("attachment:{}", s(r.get("file_id"))));
            page_ref = Some(r);
        }
        let mut meta = Map::new();
        meta.insert("file_name".into(), json!(fname));
        meta.insert("media_type".into(), json!(media));
        if media.starts_with("image/") {
            if let Some((w, h)) = picture_size(&bytes) {
                meta.insert("width".into(), json!(w));
                meta.insert("height".into(), json!(h));
            }
        }
        if let Some(t) = given.get("title").filter(|t| truthy(t)) {
            meta.insert("caption".into(), json!(js_str(t)));
        }
        if let Some(p) = page.filter(|p| !p.is_empty()) {
            meta.insert("page".into(), json!(p));
        }
        if let Some(o) = object_id {
            meta.insert("object_id".into(), json!(o));
        }
        let mut r = self.client.upload_attachment(bytes, meta).await?;
        if !marks.is_empty() {
            r.insert("marks".into(), Value::Array(marks));
        }
        Ok((r, page_ref))
    }
    async fn upload_all(&self, list: Option<&Value>) -> Result<Vec<Value>> {
        let mut refs = vec![];
        for e in list_arg(list, "attachments")? {
            let (r, page) = self.upload(&e, None).await?;
            refs.push(Value::Object(r));
            if let Some(mut p) = page {
                p.insert("role".into(), json!("page"));
                refs.push(Value::Object(p));
            }
        }
        Ok(refs)
    }
    /// Files the human sent: fetched, decrypted, written where Claude can read them.
    async fn download(&self, refs: Option<&Value>) -> (Vec<String>, Option<String>, Vec<String>) {
        let mut paths = vec![];
        let mut image = None;
        let list = list_arg(refs, "attachments").unwrap_or_default();
        for r in &list {
            let res: Result<String> = async {
                let id = s(r.get("file_id"));
                if trommi_core::ids::FileId::from_base64url(&id).is_err() {
                    return Err(err("not an attachment id"));
                }
                let file = self
                    .cache_dir
                    .join(format!("{id}-{}", safe_name(&s(r.get("file_name")))));
                if file.parent() != Some(self.cache_dir.as_path()) {
                    return Err(err("outside the cache"));
                }
                let bytes = self.client.fetch_attachment(r).await?;
                std::fs::create_dir_all(&self.cache_dir)?;
                let _ = std::fs::set_permissions(
                    &self.cache_dir,
                    std::os::unix::fs::PermissionsExt::from_mode(0o700),
                );
                write_0600(&file, &bytes)?;
                Ok(file.display().to_string())
            }
            .await;
            match res {
                Ok(p) => {
                    let media = r
                        .get("media_type")
                        .filter(|v| !v.is_null())
                        .map(js_str)
                        .unwrap_or_else(|| "application/octet-stream".into());
                    if image.is_none() && media.starts_with("image/") {
                        image = Some(p.clone());
                    }
                    paths.push(p);
                }
                Err(e) => eprintln!(
                    "[trommi] attachment {} not readable: {}",
                    s(r.get("file_id")),
                    e.text()
                ),
            }
        }
        let names = list
            .iter()
            .map(|r| {
                let n = s(r.get("file_name"));
                if n.is_empty() {
                    "file".to_string()
                } else {
                    n
                }
            })
            .collect();
        (paths, image, names)
    }

    async fn caught_up(&self) -> Result<()> {
        if let Err(e) = self.client.settle(10_000).await {
            if e.code == "chain-halted" {
                return Err(err("the hub refused one of this session's envelopes for good, so the channel stopped sending to keep its signed history intact. Nothing was sent. Tell the human in the terminal; the Trommi app shows the alert."));
            }
            eprintln!("[trommi] not settled: {}", e.text());
        }
        Ok(())
    }

    // ---- the tools ----------------------------------------------------------------------------------------------
    /// The terminal mirror: `kind` "input" (what the human typed into the terminal) or "answer" (the agent's final
    /// text of a turn), as a message in this agent's own session chat with `terminal: kind`.
    pub async fn mirror(&self, kind: &str, text: &str, pictures: &[String]) -> Result<()> {
        self.caught_up().await?;
        let mut f = Map::new();
        // his pasted pictures go with his words, sealed like every file; one that cannot be read any more leaves the
        // mark a picture has that never left the terminal
        let (mut files, mut lost) = (vec![], 0);
        for p in pictures {
            // (a file that is there and does not go up is tried again with the message)
            if !Path::new(p).is_file() {
                lost += 1;
                continue;
            }
            files.push(Value::Object(self.upload(&json!(p), None).await?.0));
        }
        let marks = vec![crate::mirror::PICTURE_MARK; lost].join(" ");
        let text = [marks.as_str(), text]
            .into_iter()
            .filter(|t| !t.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        let text = text.as_str();
        if !files.is_empty() {
            f.insert("attachments".into(), Value::Array(files));
        }
        // (an answer is rendered as the agent's words: a ```html block in it is cleaned like a reply's, or shown as text)
        let text = if kind == "answer" {
            clean_fences(text, "text").unwrap_or_else(|_| text.replace("```html", "```text"))
        } else {
            text.to_string()
        };
        f.insert("text".into(), json!(text));
        f.insert("terminal".into(), json!(kind));
        self.client.send_message(f, None, None).await?;
        Ok(())
    }

    /// A block of a turn's trail (`trail.rs`) as the work trail of protocol v2 (spec/v2.md 7.3): one MLS message
    /// per step, numbered from 1 within the turn, in this agent's session group or in the group of the child
    /// session `target` (one that exists; never opened here). An item is sent when it is first seen, and once
    /// more when it ended badly; a step that simply finished is not sent again.
    pub async fn work(&self, target: Option<&str>, work: &Value) -> Result<()> {
        let sid = match target {
            Some(name) => self.find_child(name).await,
            None => None,
        };
        let turn_name = s(work.get("turn"));
        let digest = crate::util::sha256(turn_name.as_bytes());
        let mut turn = [0u8; 16];
        turn.copy_from_slice(&digest[..16]);
        for item in work
            .get("items")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(step) = trail_step(item) else {
                continue;
            };
            let id = format!("{}|{}", s(item.get("id")), if step.1 { "bad" } else { "" });
            let number = {
                let mut sent = self.trail_sent.lock().unwrap();
                if sent.len() > 8 && !sent.contains_key(&turn_name) {
                    sent.clear();
                }
                let (next, ids) = sent
                    .entry(turn_name.clone())
                    .or_insert_with(|| (1, HashSet::new()));
                if !ids.insert(id) {
                    continue;
                }
                let number = *next;
                *next += 1;
                number
            };
            self.client
                .work_step(sid.as_deref(), turn, number, &step.0)
                .await?;
        }
        Ok(())
    }

    pub async fn call_tool(&self, name: &str, args: &Value) -> Result<String> {
        let empty = Map::new();
        let args: &Map<String, Value> = args.as_object().unwrap_or(&empty);
        self.caught_up().await?;
        match name {
            "reply" => {
                let card = if present(args.get("card_id")) {
                    Some(self.find_card(args.get("card_id")).await?)
                } else {
                    None
                };
                let text = clean_fences(&s(args.get("text")), "text")?;
                let html = html_beside(
                    args.get("html").unwrap_or(&Value::Null),
                    &text,
                    "html",
                    "text",
                )?;
                let turn = card.as_ref().and_then(|c| c.in_revision.clone());
                let present_ = turn.is_some()
                    && (args.get("present") == Some(&Value::Bool(true))
                        || (turn.as_ref().unwrap().by == "explain"
                            && args.get("present") != Some(&Value::Bool(false))));
                let sid = if card.is_some() {
                    None
                } else {
                    self.session_of(args, Map::new()).await?
                };
                let mut f = Map::new();
                f.insert("text".into(), json!(text));
                if !html.is_empty() {
                    f.insert("html".into(), json!(html));
                }
                if args.get("details").is_some_and(truthy) {
                    f.insert(
                        "details".into(),
                        json!(clean_fences(&js_str(&args["details"]), "details")?),
                    );
                }
                f.insert(
                    "attachments".into(),
                    Value::Array(self.upload_all(args.get("attachments")).await?),
                );
                if present_ {
                    f.insert("present_card".into(), json!(true));
                }
                self.client
                    .send_message(f, card.as_ref().map(|c| c.object_id.clone()), sid)
                    .await?;
                let tail = match (&turn, present_) {
                    (Some(_), false) => format!("; card {} stays with you (in revision): put it before the human again with revise_card, or with reply and present: true, when your work on it is done", card.as_ref().unwrap().object_id),
                    (_, true) => format!("; card {} is before the human again", card.as_ref().unwrap().object_id),
                    _ => String::new(),
                };
                Ok(format!("sent{tail}{}", stripped_hint()))
            }
            "create_decision" => {
                let mut fields =
                    question_fields(args, &names_of(args.get("attachments"))?, Advice::Absent)?;
                let sid = self.session_of(args, Map::new()).await?;
                fields.insert(
                    "attachments".into(),
                    Value::Array(self.upload_all(args.get("attachments")).await?),
                );
                let id = self.client.send_card(fields, sid).await?;
                self.caught_up().await?;
                Ok(format!(
                    "card {id} created, {}; the choice will arrive as a channel event{}",
                    self.place_of(&id).await,
                    stripped_hint()
                ))
            }
            "create_info" => {
                let mut fields = info_fields(args, &names_of(args.get("attachments"))?)?;
                let sid = self.session_of(args, Map::new()).await?;
                fields.insert(
                    "attachments".into(),
                    Value::Array(self.upload_all(args.get("attachments")).await?),
                );
                let id = self.client.send_card(fields, sid).await?;
                Ok(format!("info {id} put on the board; when the human has read and closed it, info_read arrives, which needs no answer{}", stripped_hint()))
            }
            "revise_card" => self.revise(args).await,
            "merge_cards" => {
                let mut ids: Vec<String> = vec![];
                for x in list_arg(args.get("card_ids"), "card_ids")? {
                    let v = js_str(&x);
                    if !ids.contains(&v) {
                        ids.push(v);
                    }
                }
                if ids.len() < 2 {
                    return Err(err("merge_cards replaces at least two cards; to change one card use revise_card"));
                }
                let mut old = vec![];
                for i in &ids {
                    old.push(self.find_card(Some(&json!(i))).await?);
                }
                for c in &old {
                    if c.card_type() == "info" {
                        return Err(err(format!("card {} is an info, not a question; infos are not merged. Rework it with revise_card or take it away with withdraw_card", c.object_id)));
                    }
                    if c.object_state == "answered" {
                        return Err(err(format!("card {} was already decided; the human spent an answer on it, so act on it and merge only the open ones", c.object_id)));
                    }
                    if c.object_state != "open" {
                        return Err(err(format!("card {} is already done", c.object_id)));
                    }
                }
                let rank = |u: &str| URGENCIES.iter().position(|x| *x == u).unwrap_or(0);
                let top = old.iter().fold(old[0].clone(), |a, b| {
                    if rank(&b.urgency) > rank(&a.urgency) {
                        b.clone()
                    } else {
                        a
                    }
                });
                let mut a2 = args.clone();
                if !present(args.get("urgency")) {
                    a2.insert("urgency".into(), json!(top.urgency));
                }
                if !present(args.get("urgency_reason")) {
                    a2.insert(
                        "urgency_reason".into(),
                        if present(args.get("urgency")) {
                            json!("")
                        } else {
                            top.f("urgency_reason").clone()
                        },
                    );
                }
                let mut fields =
                    question_fields(&a2, &names_of(args.get("attachments"))?, Advice::Absent)?;
                let sid = self.session_of(args, Map::new()).await?;
                fields.insert(
                    "attachments".into(),
                    Value::Array(self.upload_all(args.get("attachments")).await?),
                );
                let old_ids: Vec<String> = old.iter().map(|c| c.object_id.clone()).collect();
                let id = self.client.merge(&old_ids, fields, sid).await?;
                Ok(format!("card {id} created, replacing {}; answers to the replaced cards will no longer arrive, the choice on this one will arrive as a channel event{}", old_ids.join(", "), stripped_hint()))
            }
            "set_urgency" => {
                let card = self.find_card(args.get("card_id")).await?;
                let urgency = urgency_arg(args.get("urgency"), None)?;
                if card.object_state != "open" {
                    return Err(err(format!(
                        "card {} is {}; urgency only applies to open cards",
                        card.object_id, card.object_state
                    )));
                }
                let changed = card.urgency != urgency;
                let reason = trim(&s(args.get("reason")));
                self.client
                    .set_urgency(
                        &card.object_id,
                        &urgency,
                        Some(if reason.is_empty() {
                            Value::Null
                        } else {
                            json!(reason)
                        }),
                    )
                    .await?;
                Ok(format!(
                    "urgency {} {urgency}; the card keeps its place in the stack",
                    if changed { "set to" } else { "already" }
                ))
            }
            "withdraw_card" => {
                let card = self.find_card(args.get("card_id")).await?;
                if card.object_state == "answered" {
                    return Err(err(format!("card {} was already decided (choice: {}); the human spent an answer on it, so act on it or call close_card with a summary of why it no longer applies", card.object_id, card.answer.as_ref().and_then(|a| a.choices.first()).map(js_str).unwrap_or_default())));
                }
                if card.object_state != "open" {
                    return Err(err(format!("card {} is already done", card.object_id)));
                }
                self.client
                    .withdraw(&card.object_id, &trim(&s(args.get("reason"))))
                    .await?;
                Ok("withdrawn".into())
            }
            "close_card" => {
                let card = self.find_card(args.get("card_id")).await?;
                if card.object_state == "closed" && card.closed_how.as_deref() == Some("settled") {
                    return Ok("already closed: the human's answer settled it (a final option). Nothing to do; say what there is to say with reply".into());
                }
                self.client
                    .close(&card.object_id, &s(args.get("summary")))
                    .await?;
                Ok("closed".into())
            }
            "set_status" => {
                let id = trim(&s(args.get("id")));
                if id.is_empty() {
                    return Err(err("id is required"));
                }
                let state = args.get("state").and_then(|v| v.as_str()).unwrap_or("");
                if !STATUSES.contains(&state) {
                    return Err(err(format!(
                        "state must be one of {}; got \"{}\"",
                        STATUSES.join(", "),
                        args.get("state")
                            .map(js_str)
                            .unwrap_or_else(|| "undefined".into())
                    )));
                }
                let sid = self.session_of(args, Map::new()).await?;
                let before = self
                    .my_session(sid.as_deref())
                    .await
                    .and_then(|x| x.status_lines.into_iter().find(|l| l.id == id));
                if before.is_none() && !args.get("label").is_some_and(truthy) {
                    return Err(err(format!(
                        "label is required for the new status line \"{id}\""
                    )));
                }
                let card = if args.get("card_id").is_some_and(truthy) {
                    Some(self.find_card(args.get("card_id")).await?)
                } else {
                    None
                };
                let label = if present(args.get("label")) {
                    js_str(&args["label"])
                } else {
                    before
                        .as_ref()
                        .map(|b| js_str(&b.label))
                        .unwrap_or_default()
                };
                let detail = if present(args.get("detail")) {
                    json!(js_str(&args["detail"]))
                } else {
                    before
                        .as_ref()
                        .map(|b| {
                            if b.detail.is_null() {
                                json!("")
                            } else {
                                b.detail.clone()
                            }
                        })
                        .unwrap_or(json!(""))
                };
                let object_id = if state == "decision" {
                    card.map(|c| json!(c.object_id))
                        .or_else(|| {
                            before
                                .as_ref()
                                .map(|b| b.object_id.clone())
                                .filter(|v| !v.is_null())
                        })
                        .unwrap_or(Value::Null)
                } else {
                    Value::Null
                };
                let mut v = Map::new();
                v.insert(format!("status_line/{id}"), json!({ "label": label, "state": state, "detail": detail, "object_id": object_id }));
                self.client.set_status(v, sid).await?;
                Ok(format!("status \"{id}\" is {state}"))
            }
            "clear_status" => {
                let sid = self.session_of(args, Map::new()).await?;
                let lines = self
                    .my_session(sid.as_deref())
                    .await
                    .map(|x| x.status_lines)
                    .unwrap_or_default();
                let gone: Vec<String> = if args.get("id").is_some_and(truthy) {
                    vec![js_str(&args["id"])]
                } else {
                    lines.iter().map(|l| l.id.clone()).collect()
                };
                if !gone.is_empty() {
                    let v: Map<String, Value> = gone
                        .iter()
                        .map(|id| (format!("status_line/{id}"), Value::Null))
                        .collect();
                    self.client.set_status(v, sid).await?;
                }
                Ok("cleared".into())
            }
            "introduce" => {
                if !args.get("model").is_some_and(truthy) {
                    return Err(err("model is required"));
                }
                let sid = self.session_of(args, Map::new()).await?;
                let was = self
                    .my_session(sid.as_deref())
                    .await
                    .and_then(|x| x.profile)
                    .and_then(|p| p.as_object().cloned())
                    .unwrap_or_default();
                let mut p = was.clone();
                p.insert("model".into(), json!(js_str(&args["model"])));
                p.insert(
                    "task".into(),
                    if present(args.get("task")) {
                        json!(js_str(&args["task"]))
                    } else {
                        was.get("task")
                            .cloned()
                            .filter(|v| !v.is_null())
                            .unwrap_or(json!(""))
                    },
                );
                if present(args.get("icon")) {
                    p.insert("icon".into(), json!(js_str(&args["icon"])));
                }
                if args.contains_key("parent") {
                    p.insert(
                        "parent_session".into(),
                        if args["parent"].is_null() || !truthy(&args["parent"]) {
                            Value::Null
                        } else {
                            json!(js_str(&args["parent"]))
                        },
                    );
                }
                if args.contains_key("main") {
                    p.insert("is_main".into(), json!(args["main"] == Value::Bool(true)));
                }
                let mut v = Map::new();
                v.insert("profile".into(), Value::Object(p));
                self.client.set_status(v, sid).await?;
                Ok("noted".into())
            }
            "list_cards" => {
                let filter: Option<Option<String>> = if !present(args.get("session"))
                    || args.get("session").and_then(|v| v.as_str()) == Some("")
                {
                    None
                } else {
                    Some(self.find_child(&trim(&s(args.get("session")))).await)
                };
                if let Some(None) = filter {
                    return Err(err(format!(
                        "no child session \"{}\"; open_session opens one",
                        s(args.get("session"))
                    )));
                }
                let mine = self.my_cards().await;
                let mut out = vec![];
                for c in mine
                    .iter()
                    .filter(|c| filter.is_none() || c.session_id == filter.clone().flatten())
                {
                    let mut line = self.card_line(c).await;
                    if let Some(child) = self.child_name(c.session_id.as_deref()).await {
                        line.insert("session".into(), json!(child));
                    }
                    out.push(Value::Object(line));
                }
                Ok(serde_json::to_string_pretty(&Value::Array(out)).unwrap())
            }
            "open_session" => {
                let name = trim(&s(args.get("name")));
                if name.is_empty() {
                    return Err(err(
                        "name is required: the helper's short name, e.g. \"Design\"",
                    ));
                }
                let mut profile = Map::new();
                for k in ["task", "icon", "model"] {
                    if present(args.get(k)) {
                        profile.insert(k.into(), json!(js_str(&args[k])));
                    }
                }
                let existed = self.find_child(&name).await;
                let sid = match &existed {
                    Some(x) => x.clone(),
                    None => {
                        let mut a = Map::new();
                        a.insert("session".into(), json!(name));
                        self.session_of(&a, profile.clone()).await?.unwrap()
                    }
                };
                if let Some(e) = &existed {
                    self.reopen(e).await?;
                    if !profile.is_empty() {
                        let mut p = self
                            .my_session(Some(&sid))
                            .await
                            .and_then(|x| x.profile)
                            .and_then(|p| p.as_object().cloned())
                            .unwrap_or_default();
                        for (k, v) in profile {
                            p.insert(k, v);
                        }
                        let mut v = Map::new();
                        v.insert("profile".into(), Value::Object(p));
                        self.client.set_status(v, Some(sid.clone())).await?;
                    }
                }
                Ok(format!("{}: \"{name}\" ({sid}), under your session on the board. Pass session: \"{name}\" to reply, create_decision, create_info, merge_cards, set_status, clear_status, introduce, list_cards and publish_asset to write into it; the human's messages and answers there arrive with meta session=\"{name}\".", if existed.is_some() { "child session already open" } else { "child session opened" }))
            }
            "close_session" => {
                let name = trim(&s(args
                    .get("name")
                    .filter(|v| !v.is_null())
                    .or(args.get("session"))));
                if name.is_empty() {
                    return Err(err(
                        "name is required: the helper's short name, as given to open_session",
                    ));
                }
                let Some(sid) = self.find_child(&name).await else {
                    return Err(err(format!(
                        "no child session \"{name}\"; open_session opens one"
                    )));
                };
                if args
                    .get("summary")
                    .is_some_and(|v| !v.is_null() && !trim(&js_str(v)).is_empty())
                {
                    let mut f = Map::new();
                    f.insert(
                        "text".into(),
                        json!(clean_fences(&js_str(&args["summary"]), "summary")?),
                    );
                    f.insert("attachments".into(), json!([]));
                    self.client.send_message(f, None, Some(sid.clone())).await?;
                }
                let sess = self.my_session(Some(&sid)).await;
                let lines = sess
                    .as_ref()
                    .map(|x| x.status_lines.clone())
                    .unwrap_or_default();
                if !lines.is_empty() {
                    let v: Map<String, Value> = lines
                        .iter()
                        .map(|l| (format!("status_line/{}", l.id), Value::Null))
                        .collect();
                    self.client.set_status(v, Some(sid.clone())).await?;
                }
                let mut p = sess
                    .and_then(|x| x.profile)
                    .and_then(|p| p.as_object().cloned())
                    .unwrap_or_default();
                p.insert("closed_at".into(), json!(now_ms()));
                let mut v = Map::new();
                v.insert("profile".into(), Value::Object(p));
                self.client.set_status(v, Some(sid.clone())).await?;
                let left: Vec<Card> = self
                    .my_cards()
                    .await
                    .into_iter()
                    .filter(|c| {
                        c.session_id.as_deref() == Some(&sid) && c.object_state == "answered"
                    })
                    .collect();
                for c in &left {
                    self.client.close(&c.object_id, SESSION_ENDED).await?;
                }
                let open = self
                    .my_cards()
                    .await
                    .iter()
                    .filter(|c| c.session_id.as_deref() == Some(&sid) && c.object_state == "open")
                    .count();
                let l = left.len();
                Ok(format!("child session \"{name}\" closed: archived on the board, still readable there{}{}. open_session(\"{name}\") opens it again.",
                    if l > 0 { format!("; {l} answered card{} of it {} closed with it", if l == 1 { "" } else { "s" }, if l == 1 { "was" } else { "were" }) } else { String::new() },
                    if open > 0 { format!("; {open} open question{} of it stay{} on the human's stack, and the session stays in the active list until {} answered", if open == 1 { "" } else { "s" }, if open == 1 { "s" } else { "" }, if open == 1 { "it is" } else { "they are" }) } else { String::new() }))
            }
            "publish_asset" => {
                if !present(args.get("path")) && !present(args.get("content")) {
                    return Err(err("give path or content"));
                }
                if present(args.get("type"))
                    && !ASSET_TYPES.contains(&args["type"].as_str().unwrap_or(""))
                {
                    return Err(err(format!(
                        "type must be one of {}",
                        ASSET_TYPES.join(", ")
                    )));
                }
                let r = if present(args.get("path")) {
                    self.upload(&json!(js_str(&args["path"])), None).await?.0
                } else {
                    let bytes = js_str(&args["content"]).into_bytes();
                    if bytes.len() as u64 > MAX_ASSET {
                        return Err(err("content is too large"));
                    }
                    let media = if args.get("type").is_some_and(truthy)
                        && args["type"].as_str() != Some("html")
                    {
                        "application/octet-stream"
                    } else {
                        "text/html"
                    };
                    let t = if args.get("title").is_some_and(truthy) {
                        js_str(&args["title"])
                    } else {
                        "page".into()
                    };
                    let base: String = utf16_slice(
                        &regex::Regex::new(r"[^A-Za-z0-9_.-]+")
                            .unwrap()
                            .replace_all(&t, "-"),
                        60,
                    );
                    let mut meta = Map::new();
                    meta.insert("file_name".into(), json!(format!("{base}.html")));
                    meta.insert("media_type".into(), json!(media));
                    self.client.upload_attachment(bytes, meta).await?
                };
                let title = if args.get("title").is_some_and(truthy) {
                    js_str(&args["title"])
                } else {
                    s(r.get("file_name"))
                };
                let mut asset = r.clone();
                asset.insert(
                    "asset_type".into(),
                    json!(if present(args.get("type")) {
                        js_str(&args["type"])
                    } else {
                        asset_type_of(&s(r.get("media_type")))
                    }),
                );
                let note = if args.get("note").is_some_and(truthy) {
                    Some(js_str(&args["note"]))
                } else {
                    None
                };
                let sid = self.session_of(args, Map::new()).await?;
                let id = self
                    .client
                    .publish(
                        json!([asset]),
                        json!(title),
                        note.clone().map(|n| json!(n)),
                        sid.clone(),
                    )
                    .await?;
                let mut f = Map::new();
                let text: Vec<String> = [Some(format!("**{title}**")), note]
                    .into_iter()
                    .flatten()
                    .collect();
                f.insert("text".into(), json!(text.join("\n\n")));
                f.insert("attachments".into(), json!([asset]));
                f.insert("artifact_object_id".into(), json!(id));
                self.client.send_message(f, None, sid).await?;
                Ok(format!("published as {id}: \"{title}\" is shown in your conversation on the board, end-to-end encrypted; members open it in the Trommi app. For someone outside the board: share_asset."))
            }
            "list_assets" => {
                let c = self.client.core.lock().await;
                let me = self.me();
                let shares = self.state.lock().unwrap()["shares"].clone();
                let list: Vec<Value> = c.model.published.values().filter(|p| c.model.holder_of(&p.agent_device_id, p.session_id.as_deref()) == me && p.object_state != "closed").map(|p| {
                    let a0 = p.attachments.get(0).cloned().unwrap_or(Value::Null);
                    let released = shares.get(&p.object_id).and_then(|x| x.as_array()).map(|l| l.iter().filter_map(|x| x["expires_at"].as_u64()).max().unwrap_or(0)).unwrap_or(0);
                    json!({
                        "id": p.object_id, "title": p.title, "note": if p.note.is_null() { json!("") } else { p.note.clone() }, "state": p.object_state,
                        "type": a0.get("asset_type").filter(|v| !v.is_null()).cloned().unwrap_or_else(|| json!(asset_type_of(&a0.get("media_type").map(js_str).unwrap_or_default()))),
                        "size": a0.get("total_size").cloned().unwrap_or(Value::Null), "released_until": if released > 0 { json!(released) } else { Value::Null },
                    })
                }).collect();
                Ok(serde_json::to_string_pretty(&Value::Array(list)).unwrap())
            }
            "revoke_asset" => {
                let asset = self.own_asset(args.get("id")).await?;
                self.unshare(&asset.object_id).await?;
                self.client.unpublish(&asset.object_id).await?;
                Ok("revoked: the asset is taken off the board".into())
            }
            "share_asset" => {
                let asset = self.own_asset(args.get("id")).await?;
                if args.get("release") == Some(&Value::Bool(false)) {
                    let n = self.unshare(&asset.object_id).await?;
                    return Ok(if n > 0 {
                        "release taken back: the link for outsiders no longer opens anything. The asset itself is still there.".into()
                    } else {
                        "it was not released".into()
                    });
                }
                let given = args.get("expires_hours").and_then(num).unwrap_or(0.0);
                let hours = if given > 0.0 { given } else { SHARE_MAX_HOURS };
                if hours > SHARE_MAX_HOURS {
                    return Err(err(format!(
                        "a release lasts at most {} days; expires_hours {} is too long",
                        SHARE_MAX_HOURS / 24.0,
                        num_value(hours)
                    )));
                }
                let a0 = asset.attachments.get(0).cloned().unwrap_or(Value::Null);
                let (share_id, link, expires_at) = self
                    .client
                    .share_attachment(&a0, now_ms() + (hours * 3_600_000.0) as u64)
                    .await?;
                {
                    let mut st = self.state.lock().unwrap();
                    let shares = st["shares"].as_object_mut().unwrap();
                    let l = shares.entry(asset.object_id.clone()).or_insert(json!([]));
                    l.as_array_mut()
                        .unwrap()
                        .push(json!({ "share_id": share_id, "expires_at": expires_at }));
                }
                self.save_state();
                Ok([
                    format!("asset {} is released until {}.", asset.object_id, iso(expires_at)),
                    format!("Link for the recipient: {link}"),
                    "It opens a plain viewer without the board; the key is after the #, the hub never sees it. share_asset with release: false or revoke_asset ends it.".to_string(),
                ].join("\n"))
            }
            _ => Err(err(format!("unknown tool: {name}"))),
        }
    }

    async fn own_asset(&self, id: Option<&Value>) -> Result<model::Published> {
        let c = self.client.core.lock().await;
        let me = self.me();
        let want = s(id);
        c.model
            .published
            .values()
            .find(|p| {
                c.model
                    .holder_of(&p.agent_device_id, p.session_id.as_deref())
                    == me
                    && p.object_id == want
            })
            .cloned()
            .ok_or_else(|| {
                err(format!(
                    "no asset {}; list_assets shows yours",
                    id.map(js_str).unwrap_or_else(|| "undefined".into())
                ))
            })
    }
    /// Ends every outsider link of an asset; returns how many were open.
    async fn unshare(&self, object_id: &str) -> Result<usize> {
        let now = now_ms();
        let open: Vec<String> = self.state.lock().unwrap()["shares"]
            .get(object_id)
            .and_then(|x| x.as_array().cloned())
            .unwrap_or_default()
            .iter()
            .filter(|x| x["expires_at"].as_u64().unwrap_or(0) > now)
            .filter_map(|x| x["share_id"].as_str().map(String::from))
            .collect();
        for sid in &open {
            if let Err(e) = self.client.revoke_share(sid).await {
                if e.code != "not-found" {
                    return Err(e);
                }
            }
        }
        self.state.lock().unwrap()["shares"]
            .as_object_mut()
            .unwrap()
            .remove(object_id);
        self.save_state();
        Ok(open.len())
    }

    async fn card_line(&self, c: &Card) -> Map<String, Value> {
        let open = c.object_state == "open";
        let stack_pos = {
            let core = self.client.core.lock().await;
            core.model
                .stack
                .iter()
                .position(|x| *x == c.object_id)
                .map(|p| p + 1)
        };
        let mut m = Map::new();
        m.insert("id".into(), json!(c.object_id));
        m.insert("kind".into(), json!(c.card_type()));
        m.insert(
            "status".into(),
            json!(if open {
                "open"
            } else if c.closed_how.as_deref() == Some("answered") && c.object_state == "answered" {
                "decided"
            } else if c.closed_how.as_deref() == Some("shredded") {
                "shredded"
            } else {
                "done"
            }),
        );
        m.insert("urgency".into(), json!(c.urgency));
        m.insert(
            "urgency_reason".into(),
            if c.f("urgency_reason").is_null() {
                json!("")
            } else {
                c.f("urgency_reason").clone()
            },
        );
        m.insert(
            "queue_position".into(),
            stack_pos.map(|p| json!(p)).unwrap_or(Value::Null),
        );
        m.insert("title".into(), c.f("title").clone());
        if truthy(c.f("teaser")) {
            m.insert("teaser".into(), c.f("teaser").clone());
        }
        m.insert("version".into(), json!(c.object_version));
        if let Some(a) = &c.answer {
            m.insert("answered_version".into(), json!(a.bound_object_version));
            m.insert(
                "choice".into(),
                a.choices.first().cloned().unwrap_or(Value::Null),
            );
            m.insert("choices".into(), json!(a.choices));
            m.insert(
                "note".into(),
                if a.note.is_null() {
                    json!("")
                } else {
                    a.note.clone()
                },
            );
            if a.trusted {
                m.insert("trusted".into(), json!(true));
            }
        }
        if let Some(r) = &c.in_revision {
            m.insert("with_agent".into(), json!(r.by));
        }
        m.insert("multiple".into(), json!(truthy(c.f("allows_multiple"))));
        if open {
            m.insert(
                "body".into(),
                if c.f("body").is_null() {
                    json!("")
                } else {
                    c.f("body").clone()
                },
            );
            if truthy(c.f("html")) {
                m.insert("html".into(), c.f("html").clone());
            }
            m.insert(
                "options".into(),
                if c.f("options").is_null() {
                    json!([])
                } else {
                    c.f("options").clone()
                },
            );
            m.insert("recommended".into(), c.f("recommended").clone());
            if truthy(c.f("sections")) {
                m.insert("sections".into(), c.f("sections").clone());
            }
        }
        if truthy(c.f("merged_into_object_id")) {
            m.insert("merged_into".into(), c.f("merged_into_object_id").clone());
        }
        if c.f("merged_from_object_ids")
            .as_array()
            .is_some_and(|a| !a.is_empty())
        {
            m.insert("merged_from".into(), c.f("merged_from_object_ids").clone());
        }
        m
    }

    async fn revise(&self, args: &Map<String, Value>) -> Result<String> {
        let card = self.find_card(args.get("card_id")).await?;
        if card.object_state == "answered" {
            return Err(err(format!("card {} was already decided (choice: {}); the human answered the question as it stood, so act on that answer, or call close_card and ask anew with create_decision", card.object_id, card.answer.as_ref().and_then(|a| a.choices.first()).map(js_str).unwrap_or_default())));
        }
        if card.object_state != "open" {
            return Err(err(format!("card {} is already done", card.object_id)));
        }
        let fields_list = [
            "title",
            "teaser",
            "body",
            "options",
            "sections",
            "text",
            "multiple",
            "recommended",
            "urgency",
            "urgency_reason",
            "attachments",
            "html",
        ];
        if !fields_list.iter().any(|k| present(args.get(*k))) {
            return Err(err(format!(
                "nothing to revise: pass at least one of {}",
                fields_list.join(", ")
            )));
        }
        let info = card.card_type() == "info";
        let resection = present(args.get("sections")) || present(args.get("text"));
        let plain = present(args.get("body")) || present(args.get("options"));
        let options: Value = args
            .get("options")
            .filter(|v| !v.is_null())
            .cloned()
            .unwrap_or_else(|| card.f("options").clone());
        let multiple = args
            .get("multiple")
            .filter(|v| !v.is_null())
            .cloned()
            .unwrap_or_else(|| card.f("allows_multiple").clone());
        let opt_keys: Vec<String> = options
            .as_array()
            .map(|a| {
                a.iter()
                    .map(|o| {
                        o.get("key")
                            .map(js_str)
                            .unwrap_or_else(|| "undefined".into())
                    })
                    .collect()
            })
            .unwrap_or_default();
        let kept: Vec<String> = card
            .recommended_list()
            .into_iter()
            .filter(|k| opt_keys.contains(k))
            .collect();
        let urgency = args
            .get("urgency")
            .filter(|v| !v.is_null())
            .map(js_str)
            .unwrap_or_else(|| card.urgency.clone());
        let mut a = Map::new();
        a.insert(
            "title".into(),
            args.get("title")
                .filter(|v| !v.is_null())
                .cloned()
                .unwrap_or_else(|| card.f("title").clone()),
        );
        a.insert(
            "teaser".into(),
            args.get("teaser")
                .filter(|v| !v.is_null())
                .cloned()
                .unwrap_or_else(|| card.f("teaser").clone()),
        );
        if resection {
            if let Some(v) = args.get("sections") {
                a.insert("sections".into(), v.clone());
            }
            if let Some(v) = args.get("text") {
                a.insert("text".into(), v.clone());
            }
        } else if card.f("sections").as_array().is_some() && !plain {
            a.insert("sections".into(), card.f("sections").clone());
        } else {
            a.insert(
                "body".into(),
                args.get("body")
                    .filter(|v| !v.is_null())
                    .cloned()
                    .unwrap_or_else(|| card.f("body").clone()),
            );
            if !info {
                a.insert("options".into(), options.clone());
            }
        }
        let attachments: Vec<Value> = if args.get("attachments").is_none_or(|v| v.is_null()) {
            card.attachments()
        } else {
            self.upload_all(args.get("attachments")).await?
        };
        let names: Vec<String> = attachments.iter().map(|x| s(x.get("file_name"))).collect();
        if !info {
            a.insert("multiple".into(), multiple.clone());
        }
        a.insert("urgency".into(), json!(urgency));
        let html = if resection {
            args.get("html").cloned()
        } else {
            args.get("html")
                .filter(|v| !v.is_null())
                .cloned()
                .or_else(|| Some(card.f("html").clone()).filter(|v| !v.is_null()))
        };
        if let Some(h) = html {
            a.insert("html".into(), h);
        }
        a.insert(
            "urgency_reason".into(),
            args.get("urgency_reason")
                .filter(|v| !v.is_null())
                .cloned()
                .unwrap_or_else(|| {
                    if urgency == card.urgency {
                        card.f("urgency_reason").clone()
                    } else {
                        json!("")
                    }
                }),
        );
        let advice = if info {
            Advice::Absent
        } else if present(args.get("recommended")) {
            let r = &args["recommended"];
            let empty = match r {
                Value::String(x) => x.is_empty(),
                Value::Array(x) => x.is_empty(),
                _ => true,
            };
            if empty {
                Advice::None_
            } else {
                Advice::Given(r.clone())
            }
        } else if resection {
            Advice::Absent
        } else if truthy(&multiple) && card.f("recommended").is_array() {
            Advice::Given(json!(kept))
        } else {
            match kept.first() {
                Some(k) => Advice::Given(json!(k)),
                None => Advice::None_,
            }
        };
        let mut fields = if info {
            info_fields(&a, &names)?
        } else {
            question_fields(&a, &names, advice)?
        };
        fields.insert("attachments".into(), Value::Array(attachments));
        let note = trim(&s(args.get("note")));
        fields.insert(
            "change_note".into(),
            if note.is_empty() {
                Value::Null
            } else {
                json!(note)
            },
        );
        let urgency = fields
            .remove("urgency")
            .and_then(|v| v.as_str().map(String::from));
        self.client.revise(&card.object_id, fields, urgency).await?;
        let place = self.place_of(&card.object_id).await;
        Ok(format!(
            "card {} revised, now version {}, {place}{}{}",
            card.object_id,
            card.object_version + 1,
            if card.in_revision.is_some() {
                "; it is before the human again"
            } else {
                ""
            },
            stripped_hint()
        ))
    }

    // ---- Claude Code asks for approval: a permission request object ------------------------------------------
    pub async fn permission_request(&self, params: &Value) -> Result<Option<String>> {
        let rid = s(params.get("request_id"));
        {
            let st = self.state.lock().unwrap();
            if self.asking.lock().unwrap().contains(&rid)
                || st["permissions"]
                    .as_object()
                    .unwrap()
                    .values()
                    .any(|v| v.as_str() == Some(&rid))
            {
                return Ok(None);
            }
        }
        self.asking.lock().unwrap().insert(rid.clone());
        let res: Result<String> = async {
            let expires = params
                .get("expires_in_ms")
                .and_then(|v| v.as_u64())
                .unwrap_or(10 * 60 * 1000);
            let id = self
                .client
                .request_permission(
                    &s(params.get("tool_name")),
                    &s(params.get("description")),
                    &s(params.get("input_preview")),
                    expires,
                    None,
                )
                .await?;
            self.state.lock().unwrap()["permissions"]
                .as_object_mut()
                .unwrap()
                .insert(id.clone(), json!(rid));
            self.save_state();
            self.asking.lock().unwrap().remove(&rid);
            if self.dropped.lock().unwrap().remove(&rid) {
                let _ = self
                    .permission_withdraw(&rid, "answered in the terminal")
                    .await;
            }
            Ok(id)
        }
        .await;
        self.asking.lock().unwrap().remove(&rid);
        self.dropped.lock().unwrap().remove(&rid);
        res.map(Some)
    }
    /// The prompt was answered elsewhere (in the terminal): the request is withdrawn.
    pub fn permission_withdraw<'a>(
        &'a self,
        request_id: &'a str,
        reason: &'a str,
    ) -> BoxFut<'a, Result<bool>> {
        Box::pin(async move {
            if self.asking.lock().unwrap().contains(request_id) {
                self.dropped.lock().unwrap().insert(request_id.into());
                return Ok(false);
            }
            let id = self.state.lock().unwrap()["permissions"]
                .as_object()
                .unwrap()
                .iter()
                .find(|(_, v)| v.as_str() == Some(request_id))
                .map(|(k, _)| k.clone());
            let Some(id) = id else { return Ok(false) };
            self.state.lock().unwrap()["permissions"]
                .as_object_mut()
                .unwrap()
                .remove(&id);
            self.save_state();
            self.client.withdraw_permission(&id, reason).await
        })
    }

    // ---- a human's command (already verified and authorised by the core) -> a channel event -------------------
    pub async fn command(&self, cmd: &Command) {
        let c = &cmd.content;
        let card = match &cmd.object_id {
            Some(o) => self.client.core.lock().await.model.cards.get(o).cloned(),
            None => None,
        };
        let title = card
            .as_ref()
            .map(|k| k.title())
            .or_else(|| cmd.object_id.clone())
            .unwrap_or_default();
        let child = self
            .child_name(
                cmd.session_id
                    .clone()
                    .or_else(|| card.as_ref().and_then(|k| k.session_id.clone()))
                    .as_deref(),
            )
            .await;
        let mut flags = Map::new();
        if cmd.late {
            flags.insert("late".into(), json!("1"));
        }
        if cmd.history {
            flags.insert("history".into(), json!("1"));
        }
        if let Some(ch) = &child {
            flags.insert("session".into(), json!(ch));
        }
        let main_sid = self.client.core.lock().await.session_id();
        let about = About {
            session_id: cmd
                .session_id
                .clone()
                .or_else(|| card.as_ref().and_then(|k| k.session_id.clone()))
                .or(main_sid),
            envelope_number: Some(cmd.envelope_number),
        };
        let is_mine = match &card {
            Some(k) => {
                self.client
                    .core
                    .lock()
                    .await
                    .model
                    .holder_of(&k.agent_device_id, k.session_id.as_deref())
                    == self.me()
            }
            None => false,
        };
        // What the monitor's line may quote (connector/line.rs): the card's title and, set below, the human's own
        // words, the labels he chose and how many files he sent. Never `content`, which also holds what agents wrote.
        let echo: std::sync::Mutex<Map<String, Value>> = std::sync::Mutex::new(
            card.as_ref()
                .map(|k| {
                    [("title".to_string(), json!(k.title()))]
                        .into_iter()
                        .collect()
                })
                .unwrap_or_default(),
        );
        let said = |k: &str, v: Value| {
            echo.lock().unwrap().insert(k.to_string(), v);
        };
        let sent = |refs: Option<&Value>| {
            let list = list_arg(refs, "attachments").unwrap_or_default();
            let pictures = list
                .iter()
                .filter(|r| {
                    r.get("media_type")
                        .and_then(|v| v.as_str())
                        .is_some_and(|m| m.starts_with("image/"))
                })
                .count();
            said("pictures", json!(pictures));
            said("files", json!(list.len() - pictures));
        };
        let send = |content: String, meta: Map<String, Value>| {
            let mut m = meta;
            for (k, v) in &flags {
                m.insert(k.clone(), v.clone());
            }
            let content = if cmd.history {
                format!("(Earlier message, for context only; not a new request.)\n{content}")
            } else {
                content
            };
            (self.notify)(
                "notifications/claude/channel".into(),
                json!({ "content": content, "meta": m, "echo": echo.lock().unwrap().clone() }),
                Some(about.clone()),
            )
        };
        let meta = |pairs: Vec<(&str, Value)>| -> Map<String, Value> {
            pairs.into_iter().map(|(k, v)| (k.to_string(), v)).collect()
        };
        let unsupported = |what: &str| {
            let mut m = meta(vec![("kind", json!("unsupported"))]);
            if let (Some(card), true) = (card.as_ref(), is_mine) {
                m.insert("card_id".into(), json!(card.object_id));
            }
            m.insert("update_required".into(), json!("1"));
            send(format!("The human sent something on {} that this Trommi connector is too old to read ({what}). {NEEDS_UPDATE}", if card.is_some() { format!("\"{title}\"") } else { "the board".into() }), m)
        };
        match cmd.command.as_str() {
            "unsupported" => unsupported(cmd.what.as_deref().unwrap_or("a newer format")).await,
            "message" => {
                if let Some(u) = &cmd.unsupported {
                    if cmd
                        .timeline_key
                        .as_deref()
                        .is_some_and(|k| k.starts_with("chat:"))
                    {
                        return unsupported(u).await;
                    }
                }
                if let Some(ct) = c.get("content_type").filter(|v| truthy(v)) {
                    if ct.as_str() != Some("message") {
                        eprintln!("[trommi] timeline item {} not relayed", js_str(ct));
                        return;
                    }
                }
                if c.get("present_card").is_some_and(truthy) && is_mine {
                    let k = card.as_ref().unwrap();
                    return send(format!("The human took \"{title}\" back; there is no need to rework or explain it."), meta(vec![("kind", json!("handback_withdrawn")), ("card_id", json!(k.object_id))])).await;
                }
                let (paths, image, names) = self.download(c.get("attachments")).await;
                let about_card = card
                    .as_ref()
                    .filter(|k| is_mine && k.object_state == "open")
                    .map(|k| k.object_id.clone());
                let copied = list_arg(c.get("copied_cards"), "copied_cards").unwrap_or_default();
                let marks = list_arg(c.get("marks"), "marks").unwrap_or_default();
                let text = trim(&s(c.get("text")));
                said("text", json!(text));
                said("cards", json!(copied.len()));
                sent(c.get("attachments"));
                let first = if !text.is_empty() {
                    text
                } else if !names.is_empty() {
                    upload_line(&names)
                } else if !copied.is_empty() {
                    format!(
                        "The human passes {} on to you.",
                        if copied.len() == 1 {
                            "a card".to_string()
                        } else {
                            format!("{} cards", copied.len())
                        }
                    )
                } else {
                    "The human pinned notes to the card.".into()
                };
                let mut lines = vec![first];
                lines.extend(marks_block(card.as_ref(), &marks));
                for k in &copied {
                    lines.push(String::new());
                    lines.push(match k {
                        Value::String(x) => x.clone(),
                        k => k
                            .get("text")
                            .filter(|v| !v.is_null())
                            .map(js_str)
                            .unwrap_or_else(|| serde_json::to_string(k).unwrap()),
                    });
                }
                let mut m = meta(vec![("kind", json!("chat"))]);
                if let Some(id) = &about_card {
                    m.insert("card_id".into(), json!(id));
                    if c.get("hand_back").is_some_and(truthy) {
                        m.insert("handback".into(), json!("1"));
                    }
                    if c.get("explain").is_some_and(truthy) {
                        m.insert("explain".into(), json!("1"));
                    }
                }
                if c.get("note").is_some_and(|n| n.is_object()) {
                    m.insert("note".into(), json!("1"));
                }
                if !marks.is_empty() {
                    m.insert("marks".into(), json!(marks.len().to_string()));
                }
                if !copied.is_empty() {
                    m.insert(
                        "cards".into(),
                        json!(copied
                            .iter()
                            .map(|k| k
                                .get("object_id")
                                .filter(|v| !v.is_null())
                                .or(k.get("id"))
                                .map(|v| if v.is_null() {
                                    String::new()
                                } else {
                                    js_str(v)
                                })
                                .unwrap_or_default())
                            .collect::<Vec<_>>()
                            .join(",")),
                    );
                    m.insert(
                        "cards_json".into(),
                        json!(serde_json::to_string(&copied).unwrap()),
                    );
                }
                file_meta(&mut m, &paths, &image);
                send(lines.join("\n"), m).await
            }
            "answer" | "trust" => {
                let choices: Vec<String> = if !cmd.choices.is_empty() {
                    cmd.choices.clone()
                } else {
                    c.get("choices")
                        .and_then(|v| v.as_array())
                        .map(|a| a.iter().map(js_str).collect())
                        .unwrap_or_default()
                };
                let k = card.clone().unwrap_or_default();
                if cmd.command == "trust" || c.get("trusted").is_some_and(truthy) {
                    let advised = k.recommended_list();
                    let labels: Vec<String> = advised
                        .iter()
                        .map(|key| {
                            format!(
                                "{} [{key}]",
                                k.options()
                                    .iter()
                                    .find(|o| o.get("key").map(js_str).as_deref() == Some(key))
                                    .and_then(|o| o.get("label"))
                                    .map(js_str)
                                    .unwrap_or_else(|| key.clone())
                            )
                        })
                        .collect();
                    let mut lines = vec![format!("The human trusts you with \"{title}\": decide yourself ({}). Say in one line what you chose with reply and this card_id, then close_card; do not ask again.", if advised.is_empty() { "you gave no advice".to_string() } else { format!("your advice was: {}", labels.join(", ")) })];
                    if c.get("note").is_some_and(truthy) {
                        lines.push(String::new());
                        lines.push(format!("Their note: {}", js_str(&c["note"])));
                    }
                    let mut m = meta(vec![
                        ("kind", json!("decision")),
                        ("card_id", json!(cmd.object_id)),
                        (
                            "choice",
                            json!(choices
                                .first()
                                .or(advised.first())
                                .cloned()
                                .unwrap_or_default()),
                        ),
                    ]);
                    if card
                        .as_ref()
                        .is_some_and(|k| truthy(k.f("allows_multiple")))
                    {
                        m.insert(
                            "choices".into(),
                            json!(if choices.is_empty() {
                                advised.join(",")
                            } else {
                                choices.join(",")
                            }),
                        );
                    }
                    m.insert("trust".into(), json!("1"));
                    return send(lines.join("\n"), m).await;
                }
                let (paths, image, _names) = self.download(c.get("attachments")).await;
                let notes = c
                    .get("option_notes")
                    .filter(|v| v.is_object())
                    .cloned()
                    .unwrap_or(json!({}));
                let remarked: Vec<Value> = k
                    .options()
                    .into_iter()
                    .filter(|o| {
                        notes
                            .get(o.get("key").map(js_str).unwrap_or_default())
                            .is_some_and(truthy)
                    })
                    .collect();
                let marks = list_arg(c.get("marks"), "marks").unwrap_or_default();
                said(
                    "labels",
                    json!(choices
                        .iter()
                        .map(|key| k
                            .options()
                            .iter()
                            .find(|o| o.get("key").map(js_str).as_deref() == Some(key))
                            .and_then(|o| o.get("label"))
                            .map(js_str)
                            .unwrap_or_else(|| key.clone()))
                        .collect::<Vec<_>>()),
                );
                if c.get("note").is_some_and(truthy) {
                    said("text", json!(js_str(&c["note"])));
                }
                sent(c.get("attachments"));
                let mut lines = vec![if c.get("note").is_some_and(truthy) {
                    js_str(&c["note"])
                } else {
                    format!("Decision on \"{title}\": {}", choices.join(", "))
                }];
                if cmd.settled {
                    lines.push(String::new());
                    lines.push("This answer settled the card: you marked the choice as final, so the card is closed already. Nothing is expected of you: no close_card, no reply.".into());
                }
                if !remarked.is_empty() {
                    lines.push(String::new());
                    lines.push("Notes on options:".into());
                    let ws = regex::Regex::new(r"\s*\n\s*").unwrap();
                    for o in &remarked {
                        let key = o.get("key").map(js_str).unwrap_or_default();
                        lines.push(format!(
                            "- {} [{key}], {}: {}",
                            o.get("label")
                                .map(js_str)
                                .unwrap_or_else(|| "undefined".into()),
                            if choices.contains(&key) {
                                "chosen"
                            } else {
                                "not chosen"
                            },
                            ws.replace_all(&js_str(&notes[&key]), " ")
                        ));
                    }
                }
                lines.extend(marks_block(card.as_ref(), &marks));
                let mut m = meta(vec![
                    ("kind", json!("decision")),
                    ("card_id", json!(cmd.object_id)),
                    (
                        "choice",
                        json!(choices.first().cloned().unwrap_or_default()),
                    ),
                ]);
                if card
                    .as_ref()
                    .is_some_and(|k| truthy(k.f("allows_multiple")))
                {
                    m.insert("choices".into(), json!(choices.join(",")));
                }
                if cmd.settled {
                    m.insert("closed".into(), json!("1"));
                }
                if !remarked.is_empty() {
                    m.insert(
                        "option_notes".into(),
                        json!(remarked
                            .iter()
                            .map(|o| o.get("key").map(js_str).unwrap_or_default())
                            .collect::<Vec<_>>()
                            .join(",")),
                    );
                }
                if !marks.is_empty() {
                    m.insert("marks".into(), json!(marks.len().to_string()));
                }
                file_meta(&mut m, &paths, &image);
                send(lines.join("\n"), m).await
            }
            "read" => {
                send(
                    format!(
                        "The human read \"{title}\" and closed it. Nothing is expected of you."
                    ),
                    meta(vec![
                        ("kind", json!("info_read")),
                        ("card_id", json!(cmd.object_id)),
                    ]),
                )
                .await
            }
            "shred" => {
                let (paths, image, _) = self.download(c.get("attachments")).await;
                let marks = list_arg(c.get("marks"), "marks").unwrap_or_default();
                let mut lines = vec![if card.as_ref().is_some_and(|k| k.card_type() == "info") {
                    format!("The human threw \"{title}\" away unread. Do not send it again.")
                } else {
                    format!("The human threw the question \"{title}\" away unanswered. That is neither a yes nor a no. Do not ask it again, in these or other words; carry on without an answer, using your own judgement, or drop the matter.")
                }];
                if c.get("note").is_some_and(truthy) {
                    lines.push(String::new());
                    lines.push(format!("Their note: {}", js_str(&c["note"])));
                    said("text", json!(js_str(&c["note"])));
                }
                sent(c.get("attachments"));
                lines.extend(marks_block(card.as_ref(), &marks));
                let mut m = meta(vec![
                    ("kind", json!("shredded")),
                    ("card_id", json!(cmd.object_id)),
                ]);
                if !marks.is_empty() {
                    m.insert("marks".into(), json!(marks.len().to_string()));
                }
                file_meta(&mut m, &paths, &image);
                send(lines.join("\n"), m).await
            }
            "decide_again" => {
                let was = card.as_ref().and_then(|k| {
                    k.answers
                        .iter()
                        .rev()
                        .find(|a| a.taken_back_at.is_some())
                        .cloned()
                });
                if card.as_ref().is_some_and(|k| k.card_type() == "info")
                    && was.as_ref().is_some_and(|w| w.answer_action == "read")
                {
                    return;
                }
                let previous: Vec<String> = cmd.previous_choices.clone();
                let multiple = card
                    .as_ref()
                    .is_some_and(|k| truthy(k.f("allows_multiple")));
                if was.as_ref().is_some_and(|w| w.answer_action == "shred") {
                    let open_again = if card.as_ref().is_some_and(|k| k.card_type() == "info") {
                        ""
                    } else {
                        " and they may answer it after all"
                    };
                    return send(format!("The human took \"{title}\" back out of the shredder; it is open again{open_again}."), meta(vec![("kind", json!("decision_reopened")), ("card_id", json!(cmd.object_id)), ("previous_choice", json!("")), ("shredded", json!("1"))])).await;
                }
                if was.as_ref().is_some_and(|w| w.trusted) {
                    let mut m = meta(vec![
                        ("kind", json!("decision_reopened")),
                        ("card_id", json!(cmd.object_id)),
                        (
                            "previous_choice",
                            json!(previous.first().cloned().unwrap_or_default()),
                        ),
                    ]);
                    if multiple {
                        m.insert("previous_choices".into(), json!(previous.join(",")));
                    }
                    m.insert("trust".into(), json!("1"));
                    return send(format!("The human took back leaving \"{title}\" to you. Stop acting on what you chose, undo what you safely can, and wait for their answer."), m).await;
                }
                let label = previous
                    .iter()
                    .map(|key| {
                        card.as_ref()
                            .and_then(|k| {
                                k.options()
                                    .into_iter()
                                    .find(|o| o.get("key").map(js_str).as_deref() == Some(key))
                            })
                            .and_then(|o| o.get("label").map(js_str))
                            .unwrap_or_else(|| key.clone())
                    })
                    .collect::<Vec<_>>()
                    .join(", ");
                let mut m = meta(vec![
                    ("kind", json!("decision_reopened")),
                    ("card_id", json!(cmd.object_id)),
                    (
                        "previous_choice",
                        json!(previous.first().cloned().unwrap_or_default()),
                    ),
                ]);
                if multiple {
                    m.insert("previous_choices".into(), json!(previous.join(",")));
                }
                send(format!("The human took back their answer \"{label}\" on \"{title}\". Stop acting on it, undo what you safely can, and wait for the new choice."), m).await
            }
            "verdict" => {
                let oid = cmd.object_id.clone().unwrap_or_default();
                let rid = self.state.lock().unwrap()["permissions"]
                    .get(&oid)
                    .and_then(|v| v.as_str().map(String::from));
                let Some(rid) = rid else {
                    eprintln!("[trommi] verdict for an unknown permission request {oid}");
                    return;
                };
                self.state.lock().unwrap()["permissions"]
                    .as_object_mut()
                    .unwrap()
                    .remove(&oid);
                self.save_state();
                (self.notify)("notifications/claude/channel/permission".into(), json!({ "request_id": rid, "behavior": if cmd.allow || c.get("allow").is_some_and(truthy) { "allow" } else { "deny" } }), None).await
            }
            "selection_sent" => {
                let (paths, image, _) = self.download(c.get("attachments")).await;
                let text = trim(&s(c.get("text")));
                said("text", json!(text));
                sent(c.get("attachments"));
                let mut m = meta(vec![("kind", json!("scribble"))]);
                if let Some(b) = c.get("board").and_then(|v| v.as_str()).filter(|b| {
                    regex::Regex::new(r"^desk/[0-9a-f]{32}$")
                        .unwrap()
                        .is_match(b)
                }) {
                    m.insert("board".into(), json!(b));
                }
                m.insert("message_id".into(), json!(cmd.envelope_number.to_string()));
                m.insert(
                    "elements".into(),
                    json!(list_arg(c.get("stroke_ids"), "stroke_ids")
                        .unwrap_or_default()
                        .iter()
                        .map(|x| if x.is_null() {
                            String::new()
                        } else {
                            js_str(x)
                        })
                        .collect::<Vec<_>>()
                        .join(",")),
                );
                file_meta(&mut m, &paths, &image);
                send(if text.is_empty() { "The human selected part of the Scribble Board and sent it to you. image_path shows exactly the selection.".into() } else { text }, m).await
            }
            other => eprintln!("[trommi] command {other} not relayed"),
        }
    }
}

/// The longest `text` of a work trail step, in bytes (spec/v2.md 7.3).
const STEP_TEXT_MAX: usize = 30_000;

/// One item of a trail block as a step `{ text, tool? }`, and whether it tells of a bad end. None for an item
/// that says nothing.
fn trail_step(item: &Value) -> Option<(Value, bool)> {
    let field = |k: &str| {
        item.get(k)
            .filter(|v| !v.is_null())
            .map(js_str)
            .unwrap_or_default()
    };
    let cut = |text: String| {
        let mut end = text.len().min(STEP_TEXT_MAX);
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text[..end].to_string()
    };
    if item.get("kind").and_then(Value::as_str) == Some("text") {
        let text = field("text");
        return (!text.is_empty()).then(|| (json!({ "text": cut(text) }), false));
    }
    let state = field("state");
    let bad = matches!(state.as_str(), "failed" | "interrupted" | "denied")
        || item
            .get("exit")
            .and_then(Value::as_u64)
            .is_some_and(|code| code != 0);
    let mut lines = vec![[field("title"), field("subject")]
        .into_iter()
        .filter(|x| !x.is_empty())
        .collect::<Vec<_>>()
        .join(" · ")];
    if bad {
        let exit = item
            .get("exit")
            .and_then(Value::as_u64)
            .map(|code| format!(" (exit {code})"))
            .unwrap_or_default();
        lines[0] = format!(
            "{} · {}{exit}",
            lines[0],
            if state.is_empty() {
                "failed".to_string()
            } else {
                state
            }
        );
    }
    for key in ["input", "output"] {
        let more = field(key);
        if !more.is_empty() {
            lines.push(more);
        }
    }
    let text = cut(lines.join("\n"));
    if text.is_empty() && field("tool").is_empty() {
        return None;
    }
    let mut step = Map::new();
    step.insert("text".into(), json!(text));
    let tool: String = field("tool").chars().take(80).collect();
    if !tool.is_empty() {
        step.insert("tool".into(), json!(tool));
    }
    Some((Value::Object(step), bad))
}

fn upload_line(names: &[String]) -> String {
    format!(
        "The human sent {}: {}. The meta attribute files holds {}.",
        if names.len() == 1 {
            "a file".to_string()
        } else {
            format!("{} files", names.len())
        },
        names.join(", "),
        if names.len() == 1 {
            "its path"
        } else {
            "their paths"
        }
    )
}
fn file_meta(m: &mut Map<String, Value>, paths: &[String], image: &Option<String>) {
    if !paths.is_empty() {
        m.insert("files".into(), json!(paths.join(",")));
        if let Some(i) = image {
            m.insert("image_path".into(), json!(i));
        }
    }
}
fn brief(said: &str, max: usize) -> String {
    let line = regex::Regex::new(r"\s+")
        .unwrap()
        .replace_all(said, " ")
        .to_string();
    if utf16_len(&line) > max {
        format!("{}…", utf16_slice(&line, max - 1))
    } else {
        line
    }
}
/// The marks as the agent reads them: one line each, saying what it is pinned to.
fn marks_block(card: Option<&Card>, marks: &[Value]) -> Vec<String> {
    let ws = regex::Regex::new(r"\s*\n\s*").unwrap();
    let lines: Vec<String> = marks
        .iter()
        .filter(|m| {
            m.is_object()
                && (m.get("text").is_some_and(truthy) || m.get("strokes").is_some_and(truthy))
        })
        .map(|m| {
            let a = m
                .get("anchor")
                .filter(|v| v.is_object())
                .cloned()
                .unwrap_or(json!({}));
            let kind = a.get("kind").and_then(|v| v.as_str()).unwrap_or("");
            let akey = a.get("key").filter(|v| !v.is_null()).map(js_str);
            let option = akey.as_ref().and_then(|k| {
                card.and_then(|c| {
                    c.options()
                        .into_iter()
                        .find(|o| o.get("key").map(js_str).as_deref() == Some(k))
                })
            });
            let section = if kind == "section" {
                card.and_then(|c| {
                    a.get("index")
                        .and_then(|i| i.as_u64())
                        .and_then(|i| c.f("sections").get(i as usize).cloned())
                })
            } else {
                None
            };
            let where_ = match kind {
                "option" => format!(
                    "on option \"{}\" [{}]",
                    option
                        .as_ref()
                        .and_then(|o| o.get("label"))
                        .map(js_str)
                        .unwrap_or_else(|| akey.clone().unwrap_or_else(|| "undefined".into())),
                    akey.clone().unwrap_or_else(|| "undefined".into())
                ),
                "section" => match section
                    .as_ref()
                    .filter(|x| x.get("key").is_some_and(truthy))
                {
                    Some(x) => format!("on option \"{}\" [{}]", s(x.get("label")), s(x.get("key"))),
                    None => format!(
                        "on the paragraph \"{}\"",
                        brief(
                            &section
                                .as_ref()
                                .map(|x| s(x.get("text")))
                                .unwrap_or_default(),
                            50
                        )
                    ),
                },
                "picture" => {
                    let idx = a.get("index").and_then(|i| i.as_u64());
                    let name = idx
                        .and_then(|i| card.and_then(|c| c.attachments().get(i as usize).cloned()))
                        .and_then(|x| x.get("file_name").filter(|v| !v.is_null()).map(js_str));
                    format!(
                        "on the picture {}",
                        name.unwrap_or_else(|| (idx.unwrap_or(0) + 1).to_string())
                    )
                }
                "text" => format!("on the text \"{}\"", brief(&s(a.get("quote")), 80)),
                _ => "general".into(),
            };
            let drawn = if m.get("strokes").is_some_and(truthy) {
                if m.get("text").is_some_and(truthy) {
                    " (also drawn; see the picture)"
                } else {
                    "(drawn; see the picture)"
                }
            } else {
                ""
            };
            format!(
                "- {where_}: {}{drawn}",
                ws.replace_all(&s(m.get("text")), " ")
            )
        })
        .collect();
    if lines.is_empty() {
        return vec![];
    }
    let mut out = vec![String::new(), "Notes pinned to the card:".to_string()];
    out.extend(lines);
    out
}

fn abs(p: &str) -> PathBuf {
    let pb = PathBuf::from(p);
    let pb = if pb.is_absolute() {
        pb
    } else {
        std::env::current_dir().unwrap_or_default().join(pb)
    };
    normalize(&pb)
}
fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            c => out.push(c.as_os_str()),
        }
    }
    out
}
fn write_0600(file: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(file)?;
    f.write_all(bytes)?;
    Ok(())
}
fn iso(ms: u64) -> String {
    let secs = (ms / 1000) as i64;
    let (days, rem) = (secs.div_euclid(86400), secs.rem_euclid(86400));
    let (y, mo, d) = civil(days);
    format!(
        "{y:04}-{mo:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60,
        ms % 1000
    )
}
/// Days since 1970 to (year, month, day), proleptic Gregorian.
pub fn civil(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = z.div_euclid(146097);
    let doe = z.rem_euclid(146097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

pub fn unused(_: &HashMap<String, String>) {}
