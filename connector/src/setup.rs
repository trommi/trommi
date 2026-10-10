//! `trommi-connector setup claude` and `setup codex`: the installed connector is made known to the program that
//! will start it. Both go through that program's own commands (`claude plugin …`, `codex mcp …`), never through
//! its files, and both can be run again: what is there already is left, and every line says what was done.
//!
//! **Claude Code** gets the Trommi plugin from the repository's marketplace (`.claude-plugin/marketplace.json`,
//! plugin folder `connector/plugin`). The plugin holds no program: its MCP server, hooks and monitor name the
//! installed connector, `~/.local/share/trommi/bin/trommi-connector`, so an update of the connector needs no
//! new plugin.
//!
//! **Codex** gets the connector as a plain MCP server `trommi`. Codex shows no channel events, so the server is
//! registered with `TROMMI_CHANNEL_EVENTS=off`: board events then wait for the `inbox` tool.
use serde_json::Value;
use std::path::Path;
use std::process::Command;

/// The marketplace's source: the repository on GitHub. `TROMMI_MARKETPLACE` names another one (a checkout).
const MARKETPLACE: &str = "trommi/trommi";
/// What of the repository a marketplace needs.
const SPARSE: [&str; 2] = [".claude-plugin", "connector/plugin"];

/// Runs a command of another program to its end; `Ok` is what it printed, when it ended well.
fn run(program: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new(program)
        .args(args)
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|error| format!("`{program}` does not start ({error})"))?;
    let said = |bytes: &[u8]| String::from_utf8_lossy(bytes).trim().to_string();
    if output.status.success() {
        Ok(said(&output.stdout))
    } else {
        let mut why = said(&output.stderr);
        if why.is_empty() {
            why = said(&output.stdout);
        }
        Err(format!("`{program} {}` failed: {why}", args.join(" ")))
    }
}

/// The installed connector, which must be there before anything is pointed at it.
fn program() -> Result<String, String> {
    let program = crate::update::installed_program().ok_or("HOME is not set to a folder")?;
    if !program.is_file() {
        return Err(format!(
            "no connector is installed at {}: run install.sh of github.com/{} first",
            program.display(),
            crate::update::REPOSITORY
        ));
    }
    program
        .to_str()
        .map(String::from)
        .ok_or_else(|| "the home folder's name is not plain text".to_string())
}

fn here(name: &str) -> Result<(), String> {
    let found = std::env::var_os("PATH").is_some_and(|path| {
        std::env::split_paths(&path)
            .any(|dir| !dir.as_os_str().is_empty() && dir.join(name).is_file())
    });
    if found {
        Ok(())
    } else {
        Err(format!(
            "`{name}` is not on the PATH: install it, then run this again"
        ))
    }
}

/// The program's name as people know it.
fn label(which: &str) -> &'static str {
    if which == "codex" {
        "Codex"
    } else {
        "Claude Code"
    }
}

/// What to do next, one line.
fn next(which: &str) -> &'static str {
    if which == "codex" {
        "start codex in a project folder and ask it to connect to Trommi with the link from \"Invite an agent\" in the Trommi app."
    } else {
        "start claude in a project folder and paste /trommi:connect '<link>' from \"Invite an agent\" in the Trommi app."
    }
}

/// Bold, green, red and dim, only when that stream is a terminal and `NO_COLOR` is not set.
fn paint(terminal: bool, code: &str, text: &str) -> String {
    let plain = !terminal
        || std::env::var_os("NO_COLOR").is_some_and(|value| !value.is_empty())
        || std::env::var("TERM").is_ok_and(|term| term == "dumb");
    if plain {
        text.to_string()
    } else {
        format!("\x1b[{code}m{text}\x1b[0m")
    }
}

/// Whether the per-step details are wanted: `--verbose` or `TROMMI_VERBOSE=1`.
fn verbose(flags: &[String]) -> bool {
    flags.iter().any(|flag| flag == "--verbose" || flag == "-v")
        || std::env::var("TROMMI_VERBOSE").is_ok_and(|value| !value.is_empty() && value != "0")
}

/// `setup claude|codex [--verbose]`: one ✓ line, the details under it when asked for, then what to do next.
/// `--details` prints only the details, one per line (install.sh frames them itself). Returns the exit code.
pub fn run_cli(which: Option<&str>, flags: &[String]) -> i32 {
    use std::io::IsTerminal;
    let done = match which {
        Some("claude") => claude(),
        Some("codex") => codex(),
        _ => Err("use `setup claude` or `setup codex` (add --verbose for the details)".to_string()),
    };
    let out = std::io::stdout().is_terminal();
    match done {
        Ok(lines) if flags.iter().any(|flag| flag == "--details") => {
            for line in lines {
                println!("{line}");
            }
            0
        }
        Ok(lines) => {
            let which = which.unwrap_or("claude");
            println!(
                "{} {}",
                paint(out, "32", "✓"),
                paint(out, "1", &format!("{} set up", label(which)))
            );
            if verbose(flags) {
                for line in lines {
                    println!("    {}", paint(out, "2", &line));
                }
            }
            println!("{} {}", paint(out, "1", "Next:"), next(which));
            0
        }
        Err(why) => {
            let err = std::io::stderr().is_terminal();
            eprintln!("{}", paint(err, "31", &format!("✗ [trommi] {why}")));
            1
        }
    }
}

/// `setup claude`. The lines say what was done.
pub fn claude() -> Result<Vec<String>, String> {
    let program = program()?;
    here("claude")?;
    let mut done = Vec::new();
    let source = std::env::var("TROMMI_MARKETPLACE")
        .ok()
        .filter(|source| !source.is_empty());
    let listed: Value = serde_json::from_str(&run("claude", &["plugin", "marketplace", "list", "--json"])?)
        .map_err(|_| "`claude plugin marketplace list --json` did not answer in JSON (is this Claude Code new enough? `claude update`)".to_string())?;
    let known = listed
        .as_array()
        .into_iter()
        .flatten()
        .find(|market| market["name"] == "trommi");
    match known {
        Some(market) => {
            let ours =
                source.is_some() || (market["source"] == "github" && market["repo"] == MARKETPLACE);
            if !ours {
                return Err(format!(
                    "a marketplace called trommi from another source is declared in this Claude Code ({}). Nothing was changed. If that is an earlier Trommi plugin, remove it yourself (`claude plugin uninstall trommi@trommi`, `claude plugin marketplace remove trommi`) and run this again.",
                    market["url"].as_str().or(market["path"].as_str()).or(market["repo"].as_str()).unwrap_or("unknown")
                ));
            }
            run("claude", &["plugin", "marketplace", "update", "trommi"])?;
            done.push("marketplace trommi: there already, read again".to_string());
        }
        None => {
            let mut args = vec!["plugin", "marketplace", "add"];
            match &source {
                Some(source) => args.push(source),
                None => {
                    args.push(MARKETPLACE);
                    args.push("--sparse");
                    args.extend(SPARSE);
                }
            }
            run("claude", &args)?;
            done.push(format!(
                "marketplace trommi: added ({})",
                source.as_deref().unwrap_or("github.com/trommi/trommi")
            ));
        }
    }
    let plugins: Value = serde_json::from_str(&run("claude", &["plugin", "list", "--json"])?)
        .map_err(|_| "`claude plugin list --json` did not answer in JSON".to_string())?;
    let installed = plugins
        .as_array()
        .into_iter()
        .flatten()
        .any(|plugin| plugin["id"] == "trommi@trommi");
    if installed {
        run("claude", &["plugin", "update", "trommi@trommi"])?;
        done.push("plugin trommi@trommi: there already, brought up to date".to_string());
    } else {
        run(
            "claude",
            &["plugin", "install", "trommi@trommi", "-s", "user", "-y"],
        )?;
        done.push("plugin trommi@trommi: installed for your user".to_string());
    }
    done.push(format!("the plugin starts {program}"));
    Ok(done)
}

/// `setup codex`. The lines say what was done.
pub fn codex() -> Result<Vec<String>, String> {
    let program = program()?;
    here("codex")?;
    let now = run("codex", &["mcp", "get", "trommi", "--json"])
        .ok()
        .and_then(|said| {
            // (Codex may print a warning before the JSON)
            let from = said.find('{')?;
            serde_json::from_str::<Value>(&said[from..]).ok()
        });
    let same = now.as_ref().is_some_and(|now| {
        now["transport"]["command"] == program.as_str()
            && now["transport"]["args"]
                .as_array()
                .is_none_or(|args| args.is_empty())
            && now["transport"]["env"]["TROMMI_CHANNEL_EVENTS"] == "off"
            && now["enabled"] != false
    });
    let mut done = Vec::new();
    if same {
        done.push("MCP server trommi: there already, unchanged".to_string());
    } else {
        run(
            "codex",
            &[
                "mcp",
                "add",
                "trommi",
                "--env",
                "TROMMI_CHANNEL_EVENTS=off",
                "--",
                &program,
            ],
        )?;
        done.push(
            if now.is_some() {
                "MCP server trommi: was set differently, now set again"
            } else {
                "MCP server trommi: added"
            }
            .to_string(),
        );
    }
    done.push(format!("Codex starts {program}"));
    done.push("board events wait for the `inbox` tool: Codex has no live events".to_string());
    Ok(done)
}

/// Whether `path` is the installed connector.
pub fn is_installed(path: &Path) -> bool {
    crate::update::installed_program().is_some_and(|program| {
        matches!((std::fs::canonicalize(path), std::fs::canonicalize(program)), (Ok(a), Ok(b)) if a == b)
    })
}
