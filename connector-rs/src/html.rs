//! tools.mjs part 1: the agent's HTML, cleaned before it is stored (html fields and ```html fences). Nothing that
//! runs, loads or navigates; the board's sandboxed frame is what really holds, this keeps the stored content honest
//! and tells the agent what it lost.
use crate::error::{Result, ZError};
use indexmap::IndexMap;
use regex::Regex;
use std::sync::{Mutex, OnceLock};

/// The most one block may weigh, in bytes of UTF-8 (BOARD_MAX_HTML_KB, default 200).
pub fn html_max_kb() -> usize {
    std::env::var("BOARD_MAX_HTML_KB").ok().and_then(|v| v.parse::<f64>().ok()).filter(|v| *v > 0.0).map(|v| v as usize).unwrap_or(200)
}
pub fn html_max() -> usize {
    html_max_kb() * 1024
}

const PAIRED: [&str; 12] = ["script", "iframe", "frame", "frameset", "object", "embed", "applet", "noscript", "template", "audio", "video", "portal"];
const SINGLE: [&str; 18] = ["script", "meta", "link", "base", "iframe", "frame", "frameset", "object", "embed", "applet", "source", "track", "param", "portal", "audio", "video", "noscript", "template"];
const UNWRAPPED: [&str; 1] = ["form"];

static TAKEN: OnceLock<Mutex<IndexMap<String, usize>>> = OnceLock::new();
fn taken() -> &'static Mutex<IndexMap<String, usize>> {
    TAKEN.get_or_init(|| Mutex::new(IndexMap::new()))
}
fn took(what: &str, n: usize) {
    if n > 0 {
        *taken().lock().unwrap().entry(what.to_string()).or_insert(0) += n;
    }
}

/// A sentence naming what was removed since the last call, or ''.
pub fn stripped_hint() -> String {
    let mut t = taken().lock().unwrap();
    if t.is_empty() {
        return String::new();
    }
    let said: Vec<String> = t.iter().map(|(w, n)| if *n > 1 { format!("{w} ({n})") } else { w.clone() }).collect();
    t.clear();
    format!("\nRemoved from your html, because the board shows it without scripts and without network: {}. Send semantic HTML with inline CSS; pictures as data: URLs or as attachments; for a page that must run, use publish_asset.", said.join(", "))
}

fn re(p: &str) -> Regex {
    Regex::new(p).unwrap()
}
/// An attribute value as the browser reads it: character references resolved, blanks and control characters gone.
fn plain_of(value: &str) -> String {
    let cp = |n: u64| char::from_u32(n.min(0x10ffff) as u32).unwrap_or('\u{fffd}').to_string();
    let a = re(r"(?i)&#x([0-9a-f]+);?").replace_all(value, |c: &regex::Captures| cp(u64::from_str_radix(&c[1], 16).unwrap_or(0x10ffff)));
    let b = re(r"&#(\d+);?").replace_all(&a, |c: &regex::Captures| cp(c[1].parse::<u64>().unwrap_or(0x10ffff)));
    let d = re(r"(?i)&colon;?").replace_all(&b, ":");
    let e = re(r"(?i)&(tab|newline);?").replace_all(&d, "");
    e.chars().filter(|c| !c.is_whitespace() && (*c as u32) > 0x1f).collect()
}

/// The block as it is stored: without scripts, handlers, frames, forms, and without any address that would be fetched.
pub fn clean_html(source: &str, what: &str) -> Result<String> {
    let mut html = source.replace("\r\n", "\n").replace('\r', "\n").replace('\u{0}', "");
    html = crate::codec::js_trim(&html).to_string();
    if html.len() > html_max() {
        return Err(ZError::plain(format!("{what} is {} KB; one block may have at most {} KB. Shorten it (pictures as attachments instead of data: URLs), or publish a whole page with publish_asset and link it", html.len().div_ceil(1024), html_max_kb())));
    }
    let tag_re = re(r#"(?i)<([a-z][A-Za-z0-9_:-]*)((?:"[^"]*"|'[^']*'|[^<>"'])*)>"#);
    let attr_re = re(r#"([^\s=/"']+)(\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?"#);
    let href_ok = re(r"(?i)^(https?:|mailto:|#|[^:]*$)");
    let data_img = re(r"(?i)^data:image/");
    let fetched = fancy_regex::Regex::new(r#"(?i)@import\b[^;]*;?|url\(\s*(['"]?)(?!data:image/|#)[^)]*\)"#).unwrap();
    let mut round = 0;
    let mut before: Option<String> = None;
    while before.as_deref() != Some(html.as_str()) && round < 8 {
        before = Some(html.clone());
        for tag in PAIRED {
            let r = re(&format!(r"(?i)<{tag}(?-u:\b)[^>]*>[\s\S]*?</{tag}\s*>"));
            took(&format!("<{tag}>"), r.find_iter(&html).count());
            html = r.replace_all(&html, "").into_owned();
        }
        for tag in SINGLE {
            let open = re(&format!(r"(?i)<{tag}(?-u:\b)[^>]*>?"));
            took(&format!("<{tag}>"), open.find_iter(&html).count());
            html = open.replace_all(&html, "").into_owned();
            html = re(&format!(r"(?i)</{tag}\s*>")).replace_all(&html, "").into_owned();
        }
        for tag in UNWRAPPED {
            took(&format!("<{tag}>"), re(&format!(r"(?i)<{tag}(?-u:\b)[^>]*>")).find_iter(&html).count());
            html = re(&format!(r"(?i)</?{tag}(?-u:\b)[^>]*>")).replace_all(&html, "").into_owned();
        }
        html = tag_re.replace_all(&html, |c: &regex::Captures| {
            let name = &c[1];
            let rest = &c[2];
            let attrs = attr_re.replace_all(rest, |a: &regex::Captures| {
                let key = &a[1];
                let k = key.to_lowercase();
                let value = a.get(3).map(|m| m.as_str()).unwrap_or("");
                let mut b = value;
                if b.starts_with(['"', '\'']) {
                    b = &b[1..];
                }
                if b.ends_with(['"', '\'']) {
                    b = &b[..b.len() - 1];
                }
                let bare = crate::codec::js_trim(b);
                if k.starts_with("on") {
                    took("on… handlers", 1);
                    return String::new();
                }
                if ["srcdoc", "formaction", "ping", "background", "srcset", "poster"].contains(&k.as_str()) {
                    took(&format!("{k}="), 1);
                    return String::new();
                }
                if ["href", "xlink:href", "action"].contains(&k.as_str()) && !href_ok.is_match(&plain_of(bare)) {
                    took("script addresses", 1);
                    return format!("{key}=\"#\"");
                }
                if k == "src" && !data_img.is_match(bare) {
                    took("pictures from an address", 1);
                    return String::new();
                }
                a[0].to_string()
            });
            format!("<{name}{attrs}>")
        }).into_owned();
        let n = fetched.find_iter(&html).filter(|m| m.is_ok()).count();
        took("addresses in CSS", n);
        html = fetched.replace_all(&html, "").into_owned();
        round += 1;
    }
    let text_only = re(r"<[^>]*>").replace_all(&html, "");
    if crate::codec::js_trim(&text_only).is_empty() && !re(r"(?i)<(img|svg|table|hr)(?-u:\b)").is_match(&html) {
        let after = if taken().lock().unwrap().is_empty() { "" } else { " after cleaning" };
        return Err(ZError::plain(format!("{what} is empty{after}: send semantic HTML (tables, lists, headings, details) with inline CSS")));
    }
    Ok(html.replace("```", "&#96;&#96;&#96;"))
}

/// A text with its ```html blocks cleaned in place. Text without one comes back untouched.
pub fn clean_fences(text: &str, what: &str) -> Result<String> {
    if !text.to_lowercase().contains("```html") {
        return Ok(text.to_string());
    }
    let fence = re(r"(?i)```html[ \t]*\n([\s\S]*?)```");
    let mut out = String::new();
    let mut last = 0;
    for c in fence.captures_iter(text) {
        let m = c.get(0).unwrap();
        out.push_str(&text[last..m.start()]);
        out.push_str(&format!("```html\n{}\n```", clean_html(&c[1], &format!("an html block in {what}"))?));
        last = m.end();
    }
    out.push_str(&text[last..]);
    Ok(out)
}

/// Blank lines inside fenced blocks, hidden from a parser that splits a text at blank lines; show() brings them back.
pub fn fences_hide(text: &str) -> String {
    let block = re(r"```[\s\S]*?```");
    let blank = fancy_regex::Regex::new(r"\n[ \t]*(?=\n)").unwrap();
    block.replace_all(text, |c: &regex::Captures| blank.replace_all(&c[0], "\n\u{1}").into_owned()).into_owned()
}
pub fn fences_show(text: &str) -> String {
    text.replace('\u{1}', "")
}

/// The html beside a text, checked: cleaned, and never without words next to it.
pub fn html_beside(html: &serde_json::Value, text: &str, field: &str, beside: &str) -> Result<String> {
    match html {
        serde_json::Value::Null => Ok(String::new()),
        serde_json::Value::String(s) if s.is_empty() => Ok(String::new()),
        serde_json::Value::String(s) => {
            if crate::codec::js_trim(text).is_empty() {
                return Err(ZError::plain(format!("{field} needs {beside} beside it: say the same in plain words there. It is what read-aloud speaks and what clients that cannot show HTML display")));
            }
            clean_html(s, field)
        }
        _ => Err(ZError::plain(format!("{field} must be a string of HTML"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cleans_what_runs_and_fetches() {
        let out = clean_html(r#"<p onclick="x()">Hi <script>alert(1)</script><img src="https://x/y.png"><a href="javascript:alert(1)">l</a></p><style>a{background:url(https://evil/x)}</style>"#, "html").unwrap();
        assert!(!out.contains("script") && !out.contains("onclick") && !out.contains("https://x") && !out.contains("javascript") && !out.contains("evil"), "{out}");
        assert!(stripped_hint().contains("<script>"));
        assert_eq!(fences_show(&fences_hide("a\n```\nx\n\ny\n```\n\nb")), "a\n```\nx\n\ny\n```\n\nb");
        assert!(fences_hide("```\nx\n\ny\n```").contains('\u{1}'));
    }
}
