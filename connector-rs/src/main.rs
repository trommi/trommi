//! trommi-connector: the Trommi connector as one binary. Without arguments the MCP stdio server; see `connector.rs`.
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("tokio runtime");
    let code = rt.block_on(async move {
        match args.first().map(|s| s.as_str()) {
            Some("driver") => {
                let home = args.iter().position(|a| a == "--home").and_then(|i| args.get(i + 1)).map(std::path::PathBuf::from).unwrap_or_else(|| std::env::temp_dir().join("trommi-driver"));
                match trommi::driver::run(home).await {
                    Ok(()) => 0,
                    Err(e) => {
                        eprintln!("[trommi] driver: {}", e.text());
                        1
                    }
                }
            }
            _ => {
                eprintln!("[trommi] unknown command");
                1
            }
        }
    });
    rt.shutdown_timeout(std::time::Duration::from_millis(500));
    std::process::exit(code);
}
