//! trommi-connector: the Trommi connector as one binary. Without arguments the MCP stdio server `trommi`; with a
//! command (connect, say, whoami, the plugin's hooks, monitor, witness) that command (`cli.rs`).
#![forbid(unsafe_code)]

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("[trommi] no runtime: {error}");
            std::process::exit(1);
        }
    };
    let code = runtime.block_on(async move {
        if args.is_empty() {
            trommi_connector::server::main_server().await;
            0
        } else {
            trommi_connector::cli::run(&args).await
        }
    });
    std::process::exit(code);
}
