//! The read-only admin page (hub/admin.mjs + admin-view.mjs). Phase 2: see admin_view.rs.

use crate::server::Hub;
use std::sync::Arc;

pub async fn start(_hub: Arc<Hub>, _host: &str, _port: u16) -> Result<u16, String> { Err("the admin page is not built yet".into()) }

pub fn hash_command() -> i32 {
    eprintln!("not yet");
    1
}
