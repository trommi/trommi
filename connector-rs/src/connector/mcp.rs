//! The MCP side: JSON-RPC 2.0 over stdio, newline-delimited, as @modelcontextprotocol/sdk's Server speaks it
//! (initialize with protocol version negotiation, ping, tools/list, tools/call, notifications both ways).
//! Written here rather than with rmcp: the connector needs exact control over the tool list's JSON (`_meta`, key
//! order), custom notification methods (`notifications/claude/channel`, `…/permission`, `…/permission_request`) and
//! the experimental capabilities, which an SDK's typed model would have to be bent for.
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

pub const LATEST_PROTOCOL_VERSION: &str = "2025-11-25";
pub const SUPPORTED_PROTOCOL_VERSIONS: [&str; 5] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];

pub struct Out {
    w: tokio::sync::Mutex<tokio::io::Stdout>,
    closed: std::sync::atomic::AtomicBool,
}
impl Out {
    pub fn new() -> Arc<Out> {
        Arc::new(Out { w: tokio::sync::Mutex::new(tokio::io::stdout()), closed: std::sync::atomic::AtomicBool::new(false) })
    }
    pub async fn send(&self, v: &Value) -> Result<(), String> {
        if self.closed.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("Not connected".into());
        }
        let mut w = self.w.lock().await;
        let line = format!("{v}\n");
        if let Err(e) = w.write_all(line.as_bytes()).await {
            self.closed.store(true, std::sync::atomic::Ordering::SeqCst);
            return Err(e.to_string());
        }
        w.flush().await.map_err(|e| e.to_string())
    }
    pub async fn notification(&self, method: &str, params: Value) -> Result<(), String> {
        let mut m = serde_json::Map::new();
        m.insert("method".into(), json!(method));
        if !params.is_null() {
            m.insert("params".into(), params);
        }
        m.insert("jsonrpc".into(), json!("2.0"));
        self.send(&Value::Object(m)).await
    }
    pub async fn result(&self, id: &Value, result: Value) {
        let _ = self.send(&json!({ "result": result, "jsonrpc": "2.0", "id": id })).await;
    }
    pub async fn error(&self, id: &Value, code: i64, message: &str) {
        let _ = self.send(&json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })).await;
    }
    pub fn close(&self) {
        self.closed.store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

/// What the server does with the client's messages.
pub trait Server: Send + Sync + 'static {
    fn initialize(&self, params: &Value) -> Value;
    fn initialized(self: Arc<Self>);
    fn list_tools(&self) -> crate::client::BoxFut<'_, Value>;
    fn call_tool(self: Arc<Self>, name: String, args: Value) -> crate::client::BoxFut<'static, Value>;
    fn notification(self: Arc<Self>, method: String, params: Value);
    fn closed(self: Arc<Self>, why: &'static str);
}

/// Read stdin until it ends; every request is answered on `out`, concurrently.
pub async fn serve<S: Server>(server: Arc<S>, out: Arc<Out>) {
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    loop {
        let line = match lines.next_line().await {
            Ok(Some(l)) => l,
            Ok(None) => break,
            Err(_) => break,
        };
        let trimmed = line.trim_end_matches('\r');
        if trimmed.trim().is_empty() {
            continue;
        }
        let Ok(msg) = serde_json::from_str::<Value>(trimmed) else { continue };
        let method = msg.get("method").and_then(|m| m.as_str()).map(String::from);
        let id = msg.get("id").cloned();
        match (method, id) {
            (Some(m), Some(id)) if !id.is_null() => {
                let params = msg.get("params").cloned().unwrap_or(Value::Null);
                let s = server.clone();
                let o = out.clone();
                tokio::spawn(async move {
                    match m.as_str() {
                        "initialize" => o.result(&id, s.initialize(&params)).await,
                        "ping" => o.result(&id, json!({})).await,
                        "tools/list" => {
                            let r = s.list_tools().await;
                            o.result(&id, r).await
                        }
                        "tools/call" => {
                            let Some(name) = params.get("name").and_then(|n| n.as_str()).map(String::from) else {
                                return o.error(&id, -32602, "Invalid tools/call request: name is required").await;
                            };
                            let args = params.get("arguments").cloned().unwrap_or(json!({}));
                            let r = s.call_tool(name, args).await;
                            o.result(&id, r).await
                        }
                        _ => o.error(&id, -32601, "Method not found").await,
                    }
                });
            }
            (Some(m), _) => {
                if m == "notifications/initialized" {
                    server.clone().initialized();
                } else {
                    server.clone().notification(m, msg.get("params").cloned().unwrap_or(Value::Null));
                }
            }
            _ => {}
        }
    }
    out.close();
    server.closed("stdin ended");
}

pub fn negotiate(params: &Value) -> String {
    let req = params.get("protocolVersion").and_then(|v| v.as_str()).unwrap_or("");
    if SUPPORTED_PROTOCOL_VERSIONS.contains(&req) { req.to_string() } else { LATEST_PROTOCOL_VERSION.to_string() }
}
