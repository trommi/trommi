//! Test control (HUB_TEST_CONTROL=1 only, never in the image): what the Node test suites reach inside a hub they
//! started in-process (prune(), sweepPending(), capStreams(), stats, ops.flow, ops.updateVersions, the clock …),
//! offered over HTTP under /__test/ so the same suites run against this hub (hub/external.mjs).

use crate::error::{fail, HResult};
use crate::http::{json, read_json, Resp};
use crate::server::{Ctx, Hub};
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

pub async fn handle(hub: &Arc<Hub>, ctx: &mut Ctx) -> HResult<Resp> {
    let path = ctx.path.clone();
    let body = if ctx.method == "POST" { read_json(ctx.take_body(), &ctx.headers, 1e9, Duration::from_secs(30), &ctx.conn).await? } else { Default::default() };
    let num = |k: &str| body.get(k).and_then(|v| v.as_f64());
    let v: Value = match path.as_str() {
        "/__test/now" => {
            crate::util::set_test_now(num("now").unwrap_or(0.0) as i64);
            json!({ "ok": true })
        }
        "/__test/prune" => hub.prune(num("days").unwrap_or(hub.cfg.limits.retention_days)),
        "/__test/sweep_pending" => json!(hub.sweep_pending(num("older_than_ms").unwrap_or(3600000.0) as i64)),
        "/__test/rebuild_derived" => {
            crate::db::rebuild_derived(&hub.db.w())?;
            json!({ "ok": true })
        }
        "/__test/cap_streams" => json!(hub.cap_streams()),
        "/__test/stats" => json!({
            "room_loads": hub.stats.lock().iter().map(|(id, ms)| json!({ "room_id": id, "ms": ms })).collect::<Vec<_>>(),
            "catch_up_slices": hub.catch_up_slices.load(Ordering::Relaxed),
        }),
        "/__test/flow" => {
            let streams: Vec<Value> = hub.streams.lock().values().map(|s| json!({ "room_id": s.room, "device_id": s.device_id, "writable_length": s.queued.load(Ordering::Acquire), "catching_up": s.catching_up(), "pending_bytes": s.pending_bytes() })).collect();
            json!({ "write_queue_depth": hub.flow.depth(), "membership_queue_depth": hub.flow.membership.load(Ordering::Acquire), "streams": streams, "counters": {
                "refusedWrites": hub.flow.refused_writes.load(Ordering::Relaxed), "refusedWritesPerIp": hub.flow.refused_per_ip.load(Ordering::Relaxed), "droppedStreams": hub.flow.dropped_streams.load(Ordering::Relaxed) } })
        }
        "/__test/versions" => {
            hub.update_versions(&Value::Object(body.clone()));
            json!({ "ok": true })
        }
        "/__test/test_rooms" => json!({ "enabled": hub.tests.enabled() }),
        "/__test/test_rooms/is" => json!(hub.tests.is_test_room(body.get("room_id").and_then(|v| v.as_str()).unwrap_or(""))),
        "/__test/test_rooms/expire" => {
            let ids = hub.tests.expired(&hub.db.w());
            for id in &ids {
                hub.remove_test_room(id);
            }
            json!(ids.len())
        }
        "/__test/metrics/sample" => {
            hub.metrics.sample(hub);
            json!({ "ok": true })
        }
        "/__test/metrics/flush" => {
            hub.metrics.flush();
            json!({ "ok": true })
        }
        "/__test/metrics/history" => json!(hub.metrics.history()),
        "/__test/wal/checkpoint" => {
            let w = crate::ops::checkpoint(&hub.db.w(), &hub.db.path, hub.cfg.wal_truncate_bytes, &hub.wal_last)?;
            json!({ "log_frames": w.log_frames, "checkpointed_frames": w.checkpointed_frames, "truncations": w.truncations, "last_ms": w.last_ms })
        }
        "/__test/accounts" => json!({ "expire": hub.accounts.expire, "ttl": hub.accounts.ttl, "transport": hub.accounts.mailer.transport }),
        "/__test/accounts/sweep" => json!(hub.accounts.sweep(hub)),
        "/__test/delete_test_rooms" => {
            let ids: Vec<String> = body.get("ids").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
            let by = body.get("by").and_then(|v| v.as_str()).unwrap_or("admin").to_string();
            match crate::delete_room::delete_rooms(hub, &ids, &by, false) {
                Ok(v) => v,
                Err(e) => return Err(crate::error::Fail::internal(e)),
            }
        }
        "/__test/close_room" => {
            hub.close_room(body.get("room_id").and_then(|v| v.as_str()).unwrap_or(""));
            json!({ "ok": true })
        }
        _ => return fail("not-found", "no such test route"),
    };
    Ok(json(200, &v))
}
