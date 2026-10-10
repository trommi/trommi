//! The admin page's graphs: the in-memory history (10 s for an hour, minute averages for a day) and the overview
//! drawing it as inline SVG.

mod common;

use common::*;
use trommi_hub::metrics::{History, Sample, Series, COARSE_MS, FINE_MS, SERIES, STEP_MS};

fn sample(at: u64, cpu: f64) -> Sample {
    let mut v = [f64::NAN; SERIES];
    v[Series::Cpu as usize] = cpu;
    v[Series::Streams as usize] = (at / STEP_MS % 7) as f64;
    Sample { at, v }
}

#[test]
fn the_history_keeps_an_hour_at_ten_seconds_and_a_day_by_the_minute() {
    let mut h = History::default();
    assert!(h.is_empty());
    let start = 1_800_000_000_000u64 - 1_800_000_000_000 % 60_000;
    // two days of samples every 10 s
    let end = start + 2 * COARSE_MS;
    let mut at = start;
    while at < end {
        h.push(sample(at, (at / 60_000 % 100) as f64));
        at += STEP_MS;
    }
    let last = end - STEP_MS;
    let (fine, coarse) = h.len();
    // the fine ring holds an hour (and the sample at its edge), the coarse one a day of minutes
    assert_eq!(fine, (FINE_MS / STEP_MS) as usize + 1);
    assert!((1439..=1441).contains(&coarse), "{coarse}");
    let hour = h.since(FINE_MS, last);
    assert!(hour.iter().all(|s| s.at + FINE_MS >= last));
    assert!(hour.windows(2).all(|w| w[1].at - w[0].at == STEP_MS));
    assert_eq!(hour.last().unwrap().at, last);
    let day = h.since(COARSE_MS, last);
    assert!(day.len() >= 1439 && day.len() <= 1442, "{}", day.len());
    assert!(day.windows(2).all(|w| w[1].at - w[0].at == 60_000));
    // a minute average is the mean of its six samples, stamped at the minute's start
    let m = day[10];
    assert_eq!(m.at % 60_000, 0);
    assert_eq!(m.get(Series::Cpu), (m.at / 60_000 % 100) as f64);
    let streams: f64 = (0..6).map(|k| ((m.at + k * STEP_MS) / STEP_MS % 7) as f64).sum::<f64>() / 6.0;
    assert!((m.get(Series::Streams) - streams).abs() < 1e-9);
    // a value never read stays unknown in the average
    assert!(m.get(Series::Mem).is_nan());
    // a short history gives what there is
    let mut short = History::default();
    short.push(sample(start, 5.0));
    short.push(sample(start + STEP_MS, 6.0));
    assert_eq!(short.since(FINE_MS, start + STEP_MS).len(), 2);
    assert_eq!(short.since(COARSE_MS, start + STEP_MS).len(), 1);
}

fn text(reply: &Reply) -> String {
    String::from_utf8_lossy(&reply.body).into_owned()
}

#[test]
fn the_overview_draws_the_history_as_graphs() {
    let hash = trommi_hub::admin::hash_password("graphs please");
    let hub = TestHub::start_with(&[("HUB_ADMIN_PASSWORD_HASH", &hash)]);
    let admin = hub.admin();
    // forty minutes of made-up samples, then two the sampler takes of the server and the hub
    let now = trommi_hub::util::now();
    for k in (0..240u64).rev() {
        let mut v = [f64::NAN; SERIES];
        v[Series::Cpu as usize] = 20.0 + (k % 9) as f64;
        v[Series::Rps as usize] = 3.5;
        hub.app.metrics.push(Sample { at: now - (k + 3) * STEP_MS, v });
    }
    hub.app.metrics.sample(&hub.app);
    hub.app.metrics.sample(&hub.app);
    let taken = hub.app.metrics.since(FINE_MS, trommi_hub::util::now());
    assert_eq!(taken.len(), 242);
    assert_eq!(taken[241].get(Series::Streams), 0.0);
    assert_eq!(taken[241].get(Series::Sessions), 0.0);
    assert!(taken[241].get(Series::Rps).is_finite());
    let signed = request(
        admin,
        "POST",
        "/login",
        &[
            ("origin", "http://127.0.0.1".to_string()),
            ("content-type", "application/x-www-form-urlencoded".to_string()),
        ],
        b"username=admin&password=graphs+please",
    );
    assert_eq!(signed.status, 303);
    let cookie = vec![(
        "cookie",
        signed.header("set-cookie").unwrap().split(';').next().unwrap().to_string(),
    )];
    let page = request(admin, "GET", "/", &cookie, b"");
    assert_eq!(page.status, 200);
    let html = text(&page);
    assert!(html.contains("<meta http-equiv=\"refresh\" content=\"10\">"));
    assert!(html.contains("<a href=\"/\" class=\"on\" aria-current=\"true\">1 h</a>"));
    assert!(html.matches("<svg class=\"spark\"").count() >= 7, "a graph in each tile that has one");
    // the CPU graph: a line through the samples, its peak, and "since start" (the hub is younger than an hour)
    let cpu = &html[html.find(">CPU<").unwrap()..];
    let cpu = &cpu[..cpu.find("</div></div>").unwrap()];
    let line = cpu.split("class=\"line\" d=\"").nth(1).unwrap().split('"').next().unwrap();
    assert!(line.starts_with('M') && line.matches('L').count() >= 200, "{line}");
    assert!(cpu.contains("max ") && cpu.contains("since start"));
    // a day: the minute averages
    let day = text(&request(admin, "GET", "/?range=24h", &cookie, b""));
    assert!(day.contains("<a href=\"/?range=24h\" class=\"on\" aria-current=\"true\">24 h</a>"));
    let cpu = &day[day.find(">CPU<").unwrap()..];
    let line = cpu.split("class=\"line\" d=\"").nth(1).unwrap().split('"').next().unwrap();
    assert!((30..=60).contains(&line.matches('L').count()), "{line}");
}
