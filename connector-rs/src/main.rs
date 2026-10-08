//! trommi-connector: the Trommi connector as one binary. Without arguments the MCP stdio server `trommi`; with a
//! command (join, say, whoami, the plugin's hooks, monitor, witness, driver) that command (src/connector/cli.rs).
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("tokio runtime");
    let code = rt.block_on(async move {
        if args.is_empty() {
            trommi::connector::main_server().await;
            0
        } else {
            trommi::connector::cli::run(&args).await
        }
    });
    std::process::exit(code);
}
