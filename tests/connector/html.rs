//! The agent's HTML, cleaned before it is stored (connector/src/html.rs).
use trommi_connector::html::*;

#[test]
fn cleans_what_runs_and_fetches() {
    let out = clean_html(r#"<p onclick="x()">Hi <script>alert(1)</script><img src="https://x/y.png"><a href="javascript:alert(1)">l</a></p><style>a{background:url(https://evil/x)}</style>"#, "html").unwrap();
    assert!(
        !out.contains("script")
            && !out.contains("onclick")
            && !out.contains("https://x")
            && !out.contains("javascript")
            && !out.contains("evil"),
        "{out}"
    );
    assert!(stripped_hint().contains("<script>"));
    assert_eq!(
        fences_show(&fences_hide("a\n```\nx\n\ny\n```\n\nb")),
        "a\n```\nx\n\ny\n```\n\nb"
    );
    assert!(fences_hide("```\nx\n\ny\n```").contains('\u{1}'));
}
