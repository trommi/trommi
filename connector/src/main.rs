//! trommi-connector: the Trommi connector as one binary. Without arguments the launcher of the MCP stdio server
//! `trommi` (`launch.rs`), which runs `trommi-connector serve` as its child and can swap in a new connector
//! without a reconnect; `serve` the server itself; with another command (connect, say, whoami, the plugin's
//! hooks, monitor, witness) that command (`cli.rs`).
#![forbid(unsafe_code)]

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // The launcher only passes lines through: one thread is enough, and it lives as long as the process.
    let launcher = args.is_empty() && std::env::var("TROMMI_LAUNCH").as_deref() != Ok("0");
    let runtime = if launcher {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
    } else {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
    };
    let runtime = match runtime {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("[trommi] no runtime: {error}");
            std::process::exit(1);
        }
    };
    let code = runtime.block_on(async move {
        if launcher {
            trommi_connector::launch::main_launcher().await
        } else if args.is_empty() || args == ["serve"] {
            trommi_connector::server::main_server().await;
            0
        } else if args == ["launch-abi"] {
            println!("{}", trommi_connector::launch::ABI);
            0
        } else {
            trommi_connector::cli::run(&args).await
        }
    });
    std::process::exit(code);
}
