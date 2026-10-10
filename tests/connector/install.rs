//! The installer (`install.sh` at the repository's root), the plugin's files, and `trommi-connector setup`.
//!
//! `install.sh` is run as it is, into a temporary home, from a release folder (`--from`) that was written with
//! `release/manifest.sh` and signed with a throwaway key by openssl; only the key in the script's copy is
//! exchanged. The connector in such a release is a stand-in that answers `--version`. `setup claude` and
//! `setup codex` are the built connector's, run against stand-ins for `claude` and `codex` on the PATH that
//! keep what they were told.
mod common;

use common::TempDir;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("the repository")
        .to_path_buf()
}

fn read(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

fn said(output: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

fn executable(path: &Path, text: &str) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::write(path, text).expect("written");
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).expect("mode");
}

/// The release name of the connector of this machine, as install.sh works it out.
fn asset_name() -> Option<String> {
    let uname = |flag: &str| {
        let output = Command::new("uname").arg(flag).output().expect("uname");
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    };
    let target = match (uname("-s").as_str(), uname("-m").as_str()) {
        ("Linux", "x86_64" | "amd64") => "x86_64-unknown-linux-musl",
        ("Linux", "aarch64" | "arm64") => "aarch64-unknown-linux-musl",
        ("Darwin", "arm64" | "aarch64") => "aarch64-apple-darwin",
        ("Darwin", "x86_64") => "x86_64-apple-darwin",
        _ => return None,
    };
    Some(format!("trommi-connector-{target}"))
}

/// A throwaway release key, the installer with that key in place of the repository's, and a home to install
/// into.
struct Bench {
    dir: TempDir,
    asset: String,
}

impl Bench {
    /// `None` where this machine has no openssl that knows Ed25519: the installer itself would stop there.
    fn new() -> Option<Bench> {
        let dir = TempDir::new("install");
        let asset = asset_name()?;
        let key = dir.path().join("key.pem");
        let made = Command::new("openssl")
            .args(["genpkey", "-algorithm", "ed25519", "-out"])
            .arg(&key)
            .output()
            .is_ok_and(|output| output.status.success());
        if !made {
            eprintln!("skipped: no openssl with Ed25519 on this machine");
            return None;
        }
        let public = Command::new("openssl")
            .args(["pkey", "-pubout", "-in"])
            .arg(&key)
            .output()
            .expect("the public key");
        let public = String::from_utf8(public.stdout).expect("PEM");
        let body = |pem: &str| -> String {
            pem.lines()
                .filter(|line| !line.starts_with("-----") && !line.is_empty())
                .collect()
        };
        let script = read(&root().join("install.sh"));
        let ours = body(&read(&root().join("release/public-key.pem")));
        assert_eq!(
            script.matches(&ours).count(),
            1,
            "install.sh holds release/public-key.pem, once"
        );
        std::fs::write(
            dir.path().join("install.sh"),
            script.replace(&ours, &body(&public)),
        )
        .expect("the installer's copy");
        std::fs::create_dir_all(dir.path().join("home")).expect("a home");
        Some(Bench { dir, asset })
    }

    fn home(&self) -> PathBuf {
        self.dir.path().join("home")
    }

    fn installed(&self, name: &str) -> PathBuf {
        self.home().join(".local/share/trommi/bin").join(name)
    }

    /// A release folder: a stand-in connector that says `words` for `--version`, the manifest of
    /// `release/manifest.sh` for `product` and `version`, signed with `key` (the bench's when `None`).
    fn release(
        &self,
        name: &str,
        product: &str,
        version: u64,
        words: &str,
        key: Option<&Path>,
    ) -> PathBuf {
        let folder = self.dir.path().join(name);
        std::fs::create_dir_all(&folder).expect("a release folder");
        executable(
            &folder.join(&self.asset),
            &format!(
                "#!/bin/sh\nif [ \"$1\" = setup ]; then echo \"setup $2\" >> \"$HOME/setup-calls\"; [ ! -f \"$HOME/setup-fails\" ]; exit; fi\necho 'trommi-connector 0.0.0 (stand-in; {words})'\n"
            ),
        );
        let manifest = Command::new("sh")
            .arg(root().join("release/manifest.sh"))
            .args([product, &version.to_string(), &"a".repeat(40)])
            .arg(folder.join(&self.asset))
            .env("GITHUB_REPOSITORY", "trommi/trommi")
            .output()
            .expect("release/manifest.sh runs");
        assert!(manifest.status.success(), "{}", said(&manifest));
        std::fs::write(folder.join("manifest.json"), &manifest.stdout).expect("the manifest");
        self.sign(&folder, key);
        folder
    }

    fn sign(&self, folder: &Path, key: Option<&Path>) {
        let own = self.dir.path().join("key.pem");
        let signed = Command::new("openssl")
            .args(["pkeyutl", "-sign", "-rawin", "-inkey"])
            .arg(key.unwrap_or(&own))
            .arg("-in")
            .arg(folder.join("manifest.json"))
            .arg("-out")
            .arg(folder.join("manifest.json.sig"))
            .output()
            .expect("openssl signs");
        assert!(signed.status.success(), "{}", said(&signed));
    }

    /// Runs the installer with nothing of this machine but its PATH.
    /// The machine's own claude and codex are never reached: the folders that hold them are left out.
    fn install(&self, args: &[&str], path_first: Option<&Path>) -> Output {
        let mut dirs: Vec<PathBuf> = path_first.into_iter().map(Path::to_path_buf).collect();
        dirs.extend(
            std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
                .filter(|dir| !dir.join("claude").exists() && !dir.join("codex").exists()),
        );
        let path = std::env::join_paths(dirs).expect("a PATH");
        Command::new("sh")
            .arg(self.dir.path().join("install.sh"))
            .args(args)
            .env_clear()
            .env("HOME", self.home())
            .env("PATH", path)
            .current_dir(self.dir.path())
            .output()
            .expect("install.sh runs")
    }

    fn install_from(&self, folder: &Path) -> Output {
        self.install(&["--from", folder.to_str().expect("a plain path")], None)
    }
}

fn verified(version: u64) -> String {
    format!("release {version}, signature verified")
}

#[test]
fn a_signed_release_is_installed_and_says_what_was_verified() {
    let Some(bench) = Bench::new() else { return };
    let release = bench.release("seven", "trommi-connector", 7, &verified(7), None);
    let output = bench.install_from(&release);
    let text = said(&output);
    assert!(output.status.success(), "{text}");
    assert!(
        text.contains("release 7 (connector-v7), signature verified"),
        "{text}"
    );
    let manifest = std::fs::read(release.join("manifest.json")).expect("the manifest");
    let sum = trommi_connector::util::hex(&trommi_connector::util::sha256(&manifest));
    assert!(
        text.contains(&format!("manifest.json SHA-256: {sum}")),
        "the manifest's SHA-256 is said: {text}"
    );
    assert_eq!(
        std::fs::read(bench.installed("trommi-connector")).expect("the program"),
        std::fs::read(release.join(&bench.asset)).expect("the asset")
    );
    assert_eq!(
        std::fs::read(bench.installed("manifest.json")).expect("its manifest"),
        manifest
    );
    assert!(bench.installed("manifest.json.sig").is_file());
    use std::os::unix::fs::PermissionsExt;
    let mode = |path: &Path| std::fs::metadata(path).expect("there").permissions().mode() & 0o777;
    assert_eq!(mode(&bench.installed("trommi-connector")), 0o755);
    // the command on the PATH is a link to the program
    let link = bench.home().join(".local/bin/trommi-connector");
    assert_eq!(
        std::fs::read_link(&link).expect("a link"),
        bench.installed("trommi-connector")
    );
    let answer = Command::new(&link)
        .arg("--version")
        .output()
        .expect("it runs");
    assert!(said(&answer).contains("signature verified"));
    // nothing of the installer's work is left behind
    let left: Vec<String> = std::fs::read_dir(bench.home().join(".local/share/trommi"))
        .expect("the folder")
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(left, ["bin"], "only the program's folder is there");

    // A second run with the same release changes nothing and ends well; a newer one replaces it.
    assert!(bench.install_from(&release).status.success());
    // (a release of the whole repository: product trommi, tag v8)
    let next = bench.release("eight", "trommi-connector", 8, &verified(8), None);
    let manifest = read(&next.join("manifest.json"))
        .replace(
            "\"product\": \"trommi-connector\"",
            "\"product\": \"trommi\"",
        )
        .replace("\"tag\": \"connector-v8\"", "\"tag\": \"v8\"");
    assert!(manifest.contains("\"product\": \"trommi\",") && manifest.contains("\"tag\": \"v8\","));
    std::fs::write(next.join("manifest.json"), manifest).expect("rewritten");
    bench.sign(&next, None);
    let output = bench.install_from(&next);
    assert!(output.status.success(), "{}", said(&output));
    assert!(said(&output).contains("release 8 (v8), signature verified"));
    assert!(read(&bench.installed("manifest.json")).contains("\"version\": 8"));
}

#[test]
fn what_does_not_check_is_refused_and_nothing_is_installed() {
    let Some(bench) = Bench::new() else { return };
    let nothing_there = |why: &str| {
        assert!(
            !bench
                .home()
                .join(".local/share/trommi/bin/trommi-connector")
                .exists()
                && !bench.home().join(".local/bin/trommi-connector").exists(),
            "{why}: nothing was installed"
        );
    };
    let refused = |folder: &Path, word: &str| {
        let output = bench.install_from(folder);
        let text = said(&output);
        assert!(!output.status.success(), "{word}: {text}");
        assert!(text.contains(word), "expected {word:?} in: {text}");
        assert!(
            !text.contains("ran-before-the-checks"),
            "the downloaded file was run: {text}"
        );
    };
    // A stand-in that would leave a trace if it were ever started.
    let trace = bench.dir.path().join("ran");
    let tracer = |folder: &Path| {
        executable(
            &folder.join(&bench.asset),
            &format!(
                "#!/bin/sh\necho ran-before-the-checks\ntouch '{}'\necho 'release 7, signature verified'\n",
                trace.display()
            ),
        );
    };

    // the binary changed after the manifest was signed
    let tampered = bench.release("tampered", "trommi-connector", 7, &verified(7), None);
    tracer(&tampered);
    refused(&tampered, "not the file the manifest names");
    nothing_there("a changed binary");

    // the manifest changed after it was signed
    let edited = bench.release("edited", "trommi-connector", 7, &verified(7), None);
    let manifest = read(&edited.join("manifest.json")).replace("\"version\": 7", "\"version\": 9");
    std::fs::write(edited.join("manifest.json"), manifest).expect("rewritten");
    tracer(&edited);
    refused(&edited, "signature");
    nothing_there("a changed manifest");

    // signed by another key
    let other_key = bench.dir.path().join("other.pem");
    let made = Command::new("openssl")
        .args(["genpkey", "-algorithm", "ed25519", "-out"])
        .arg(&other_key)
        .output()
        .expect("openssl");
    assert!(made.status.success());
    let foreign = bench.release(
        "foreign",
        "trommi-connector",
        7,
        &verified(7),
        Some(&other_key),
    );
    refused(&foreign, "signature");
    nothing_there("another key");

    // no signature at all, and one of the wrong length
    let unsigned = bench.release("unsigned", "trommi-connector", 7, &verified(7), None);
    std::fs::write(unsigned.join("manifest.json.sig"), b"").expect("emptied");
    refused(&unsigned, "signature");
    std::fs::remove_file(unsigned.join("manifest.json.sig")).expect("removed");
    refused(&unsigned, "holds no manifest.json.sig");
    nothing_there("no signature");

    // another product, properly signed
    let hub = bench.release("hub", "trommi-hub", 7, &verified(7), None);
    refused(&hub, "another product");
    nothing_there("another product");

    // another repository, properly signed
    let elsewhere = bench.release("elsewhere", "trommi-connector", 7, &verified(7), None);
    let manifest = read(&elsewhere.join("manifest.json")).replace("trommi/trommi", "someone/else");
    std::fs::write(elsewhere.join("manifest.json"), manifest).expect("rewritten");
    bench.sign(&elsewhere, None);
    refused(&elsewhere, "another repository");

    // a tag that is not the version's
    let mistagged = bench.release("mistagged", "trommi-connector", 7, &verified(7), None);
    let manifest = read(&mistagged.join("manifest.json")).replace("connector-v7", "connector-v8");
    std::fs::write(mistagged.join("manifest.json"), manifest).expect("rewritten");
    bench.sign(&mistagged, None);
    refused(&mistagged, "tag is not its version");

    // the connector itself does not find the release verified (its compiled-in key says no)
    let doubted = bench.release(
        "doubted",
        "trommi-connector",
        7,
        "REFUSED as a release: no",
        None,
    );
    refused(&doubted, "does not find itself verified");
    nothing_there("a connector that doubts its release");
    assert!(!trace.exists(), "no refused file was ever started");

    // An older release after a newer one: refused, and the newer one stays.
    let nine = bench.release("nine", "trommi-connector", 9, &verified(9), None);
    assert!(bench.install_from(&nine).status.success());
    let seven = bench.release("seven", "trommi-connector", 7, &verified(7), None);
    refused(&seven, "older than the installed one");
    assert!(read(&bench.installed("manifest.json")).contains("\"version\": 9"));
    assert_eq!(
        std::fs::read(bench.installed("trommi-connector")).expect("the program"),
        std::fs::read(nine.join(&bench.asset)).expect("nine's")
    );
    // and a refused newer one leaves it as well
    let ten = bench.release("ten", "trommi-connector", 10, &verified(10), None);
    tracer(&ten);
    refused(&ten, "not the file the manifest names");
    assert!(read(&bench.installed("manifest.json")).contains("\"version\": 9"));
}

#[test]
fn the_installer_refuses_root_and_unknown_arguments_and_goes_nowhere_but_github() {
    let Some(bench) = Bench::new() else { return };
    let release = bench.release("seven", "trommi-connector", 7, &verified(7), None);
    // root: `id -u` answers 0
    let fake = bench.dir.path().join("fake");
    std::fs::create_dir_all(&fake).expect("a folder");
    executable(&fake.join("id"), "#!/bin/sh\necho 0\n");
    let output = bench.install(&["--from", release.to_str().expect("plain")], Some(&fake));
    assert!(!output.status.success());
    assert!(said(&output).contains("root"), "{}", said(&output));
    assert!(!bench.installed("trommi-connector").exists());

    for args in [
        &["--key", "x"][..],
        &["--tag", "../../x"],
        &["--tag", "v0"],
        &["--from"],
    ] {
        let output = bench.install(args, None);
        assert!(!output.status.success(), "{args:?}");
    }
    let both = bench.install(&["--from", "x", "--tag", "v7"], None);
    assert!(!both.status.success());

    // Every address in the script is https and of GitHub; every curl goes through the one function that pins
    // the protocol and follows no redirect.
    let script = read(&root().join("install.sh"));
    let code: String = script
        .lines()
        .filter(|line| !line.trim_start().starts_with('#'))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(!code.contains("http://"));
    let mut hosts: Vec<&str> = code
        .split("https://")
        .skip(1)
        .map(|rest| rest.split(['/', '"', '\'', ' ']).next().unwrap_or(""))
        .collect();
    hosts.sort();
    hosts.dedup();
    assert_eq!(
        hosts,
        [
            "github.com",
            "objects.githubusercontent.com",
            "release-assets.githubusercontent.com"
        ]
    );
    let curls: Vec<&str> = code
        .lines()
        .filter(|line| line.contains("curl ") && !line.contains("command -v curl"))
        .collect();
    assert_eq!(curls.len(), 1, "{curls:?}");
    assert!(curls[0].contains("--proto '=https'") && curls[0].contains("--max-redirs 0"));
    assert!(!code.contains("| sh") && !code.contains("eval "));
    assert!(
        script.trim_end().ends_with("main \"$@\""),
        "the whole script is read before it runs"
    );
}

/// The installer finds its release in GitHub's feed, where the releases of other parts share the numbers
/// (hub-v34 beside connector-v34): run against a stand-in `curl` that serves the feed and the release files
/// from folders, as github.com and its release store answer.
#[test]
fn the_newest_connector_release_is_found_beside_other_parts_of_the_same_number() {
    let Some(bench) = Bench::new() else { return };
    let stage = bench.dir.path().join("github");
    std::fs::create_dir_all(&stage).expect("a folder");
    // connector-v34 holds the connector; connector-v29 an older one; the hub's releases hold none
    let newest = bench.release("connector-v34", "trommi-connector", 34, &verified(34), None);
    let older = bench.release("connector-v29", "trommi-connector", 29, &verified(29), None);
    for (tag, folder) in [("connector-v34", &newest), ("connector-v29", &older)] {
        std::fs::rename(folder, stage.join(tag)).expect("moved");
    }
    for tag in ["hub-v34", "hub-v29"] {
        std::fs::create_dir_all(stage.join(tag)).expect("a folder");
        std::fs::write(stage.join(tag).join("manifest.json"), "{}").expect("written");
    }
    let entry = |tag: &str| {
        format!(
            "  <entry>\n    <link rel=\"alternate\" type=\"text/html\" href=\"https://github.com/trommi/trommi/releases/tag/{tag}\"/>\n  </entry>\n"
        )
    };
    let feed = format!(
        "<feed>\n{}</feed>\n",
        [
            "hub-v34",
            "connector-v34",
            "hub-v29",
            "connector-v29",
            "nightly"
        ]
        .map(entry)
        .concat()
    );
    std::fs::write(stage.join("releases.atom"), feed).expect("the feed");
    let fake = bench.dir.path().join("fake");
    std::fs::create_dir_all(&fake).expect("a folder");
    executable(
        &fake.join("curl"),
        &format!(
            r#"#!/bin/sh
stage='{stage}'
echo "curl $*" >> "$stage/calls"
out= format= url=
while [ $# -gt 0 ]; do
  case $1 in
    -o) out=$2; shift 2 ;;
    -w) format=$2; shift 2 ;;
    -H|--proto|--max-time|--max-filesize|--max-redirs) shift 2 ;;
    https://*) url=$1; shift ;;
    *) shift ;;
  esac
done
case $url in
  https://github.com/trommi/trommi/releases.atom) cp "$stage/releases.atom" "$out" ;;
  https://github.com/trommi/trommi/releases/download/*)
    file=${{url#https://github.com/trommi/trommi/releases/download/}}
    case $format in
      '%{{http_code}}') if [ -f "$stage/$file" ]; then printf 302; else printf 404; fi ;;
      '%{{redirect_url}}') if [ -f "$stage/$file" ]; then printf 'https://release-assets.githubusercontent.com/%s' "$file"; fi ;;
    esac ;;
  https://release-assets.githubusercontent.com/*) cp "$stage/${{url#https://release-assets.githubusercontent.com/}}" "$out" ;;
  *) echo "unexpected: $url" >&2; exit 22 ;;
esac
"#,
            stage = stage.display()
        ),
    );
    let output = bench.install(&[], Some(&fake));
    let text = said(&output);
    assert!(output.status.success(), "{text}");
    assert!(
        text.contains("release 34 (connector-v34), signature verified"),
        "{text}"
    );
    let calls = read(&stage.join("calls"));
    assert!(
        !calls.contains("hub-v"),
        "a release of another part is not asked for a connector: {calls}"
    );
}

/// After the program is in place the installer sets up claude and codex, those of them that are on the PATH,
/// through `trommi-connector setup`; with none it says how to do it later. A setup that fails leaves the
/// connector installed.
#[test]
fn the_installer_sets_up_the_programs_it_finds() {
    let Some(bench) = Bench::new() else { return };
    let release = bench.release("seven", "trommi-connector", 7, &verified(7), None);
    let from = ["--from", release.to_str().expect("plain")];
    let calls = || {
        let file = bench.home().join("setup-calls");
        let said = std::fs::read_to_string(&file).unwrap_or_default();
        let _ = std::fs::remove_file(&file);
        said.lines().map(String::from).collect::<Vec<_>>()
    };
    let programs = |names: &[&str]| {
        let dir = bench
            .dir
            .path()
            .join(format!("programs-{}", names.join("-")));
        std::fs::create_dir_all(&dir).expect("a folder");
        for name in names {
            executable(&dir.join(name), "#!/bin/sh\nexit 0\n");
        }
        dir
    };

    // both
    let output = bench.install(&from, Some(&programs(&["claude", "codex"])));
    let text = said(&output);
    assert!(output.status.success(), "{text}");
    assert_eq!(calls(), ["setup claude", "setup codex"], "{text}");
    assert!(
        text.contains("Setting up claude:") && text.contains("Setting up codex:"),
        "{text}"
    );
    assert!(text.contains("/trommi:connect"), "{text}");
    // one
    let output = bench.install(&from, Some(&programs(&["codex"])));
    assert!(output.status.success(), "{}", said(&output));
    assert_eq!(calls(), ["setup codex"]);
    // none: how to do it later
    let output = bench.install(&from, Some(&programs(&[])));
    let text = said(&output);
    assert!(output.status.success(), "{text}");
    assert!(calls().is_empty(), "{text}");
    assert!(
        text.contains("Neither claude nor codex is on your PATH"),
        "{text}"
    );
    assert!(text.contains("trommi-connector setup claude"), "{text}");
    // a setup that fails (a marketplace of another source, say) leaves the connector installed
    std::fs::write(bench.home().join("setup-fails"), "").expect("written");
    let output = bench.install(&from, Some(&programs(&["claude"])));
    let text = said(&output);
    assert!(output.status.success(), "{text}");
    assert_eq!(calls(), ["setup claude"]);
    assert!(text.contains("claude was not set up"), "{text}");
    assert!(bench.installed("trommi-connector").is_file());
}

// ---- the plugin's files ------------------------------------------------------------------------------------

const INSTALLED: &str = "${HOME}/.local/share/trommi/bin/trommi-connector";

#[test]
fn the_marketplace_and_the_plugin_name_the_installed_connector() {
    let market: Value =
        serde_json::from_str(&read(&root().join(".claude-plugin/marketplace.json"))).expect("JSON");
    assert_eq!(market["name"], "trommi");
    let plugins = market["plugins"].as_array().expect("plugins");
    assert_eq!(plugins.len(), 1);
    assert_eq!(plugins[0]["name"], "trommi");
    let source = plugins[0]["source"]
        .as_str()
        .expect("a folder of this repository");
    assert_eq!(source, "./connector/plugin");
    let folder = root().join(source);
    let plugin: Value =
        serde_json::from_str(&read(&folder.join(".claude-plugin/plugin.json"))).expect("JSON");
    assert_eq!(plugin["name"], "trommi");
    assert!(plugin["version"]
        .as_str()
        .is_some_and(|version| !version.is_empty()));
    // the plugin holds no program
    let files: Vec<String> = std::fs::read_dir(&folder)
        .expect("the plugin")
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    assert!(!files.iter().any(|name| name == "bin"), "{files:?}");

    // the MCP server and its channel
    assert_eq!(plugin["mcpServers"]["trommi"]["command"], INSTALLED);
    assert_eq!(
        plugin["mcpServers"]["trommi"]["args"],
        serde_json::json!([])
    );
    assert_eq!(plugin["channels"][0]["server"], "trommi");
    assert_eq!(
        plugin["experimental"]["monitors"][0]["command"],
        format!("\"{INSTALLED}\" monitor")
    );

    // every hook: an event Claude Code has, and a command of the connector
    let events = [
        "PermissionRequest",
        "PostToolUse",
        "PostToolUseFailure",
        "PermissionDenied",
        "Notification",
        "UserPromptSubmit",
        "Stop",
        "PreToolUse",
        "MessageDisplay",
        "SubagentStart",
        "SubagentStop",
        "StopFailure",
        "SessionEnd",
    ];
    let commands = [
        "permission",
        "resolved",
        "denied",
        "notice",
        "prompt",
        "stop",
        "trail",
    ];
    let hooks = plugin["hooks"].as_object().expect("hooks");
    let mut seen = std::collections::BTreeSet::new();
    for (event, groups) in hooks {
        assert!(events.contains(&event.as_str()), "unknown event {event}");
        for group in groups.as_array().expect("groups") {
            for hook in group["hooks"].as_array().expect("hooks") {
                assert_eq!(hook["type"], "command");
                let command = hook["command"].as_str().expect("a command");
                let prefix = format!("p=\"{INSTALLED}\"; [ -x \"$p\" ] || exit 0; exec \"$p\" ");
                let verb = command
                    .strip_prefix(&prefix)
                    .unwrap_or_else(|| panic!("{event}: {command}"));
                assert!(commands.contains(&verb), "{event}: {verb}");
                assert!(hook["timeout"].as_u64().is_some_and(|seconds| seconds > 0));
                seen.insert(verb.to_string());
            }
        }
    }
    assert_eq!(
        seen.len(),
        commands.len(),
        "every hook command is used: {seen:?}"
    );
    for event in events {
        assert!(hooks.contains_key(event), "no hook for {event}");
    }
    // PreToolUse may decide and so cannot run async; the permission hook waits for the human
    assert!(plugin["hooks"]["PreToolUse"][0]["hooks"][0]["async"].is_null());
    assert!(plugin["hooks"]["PermissionRequest"][0]["hooks"][0]["timeout"].as_u64() >= Some(3600));
}

/// A hook of a session whose connector is not installed ends well and says nothing, and one whose connector is
/// there runs it with the hook's word.
#[test]
fn a_hook_without_an_installed_connector_is_silent() {
    let dir = TempDir::new("hook");
    let plugin: Value = serde_json::from_str(&read(
        &root().join("connector/plugin/.claude-plugin/plugin.json"),
    ))
    .expect("JSON");
    let command = plugin["hooks"]["Stop"][0]["hooks"][0]["command"]
        .as_str()
        .expect("a command");
    let run = || {
        Command::new("sh")
            .args(["-c", command])
            .env_clear()
            .env("HOME", dir.path())
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .output()
            .expect("sh")
    };
    let output = run();
    assert!(output.status.success());
    assert_eq!(said(&output), "");
    let bin = dir.path().join(".local/share/trommi/bin");
    std::fs::create_dir_all(&bin).expect("a folder");
    executable(
        &bin.join("trommi-connector"),
        "#!/bin/sh\necho \"hook: $*\"\n",
    );
    assert_eq!(said(&run()), "hook: stop\n");
}

// ---- setup ---------------------------------------------------------------------------------------------------

/// A home with an "installed" connector, and stand-ins for `claude` and `codex` that keep their state in files
/// and write every call into `calls`.
struct Desk {
    dir: TempDir,
}

const CLAUDE: &str = r#"#!/bin/sh
state=$(dirname "$0")/..
echo "claude $*" >> "$state/calls"
case "$*" in
  "plugin marketplace list --json") if [ -f "$state/markets" ]; then cat "$state/markets"; else echo '[]'; fi ;;
  "plugin marketplace add trommi/trommi --sparse .claude-plugin connector/plugin")
    echo '[{"name":"trommi","source":"github","repo":"trommi/trommi","installLocation":"/x"}]' > "$state/markets" ;;
  "plugin marketplace update trommi") [ -f "$state/markets" ] || exit 1 ;;
  "plugin list --json") if [ -f "$state/plugins" ]; then cat "$state/plugins"; else echo '[]'; fi ;;
  "plugin install trommi@trommi -s user -y")
    [ -f "$state/markets" ] || { echo "no such marketplace" >&2; exit 1; }
    echo '[{"id":"trommi@trommi","version":"2.0.0","scope":"user","enabled":true}]' > "$state/plugins" ;;
  "plugin update trommi@trommi") [ -f "$state/plugins" ] || exit 1 ;;
  *) echo "unexpected: $*" >&2; exit 2 ;;
esac
"#;

const CODEX: &str = r#"#!/bin/sh
state=$(dirname "$0")/..
echo "codex $*" >> "$state/calls"
case "$1 $2" in
  "mcp get")
    [ -f "$state/codex-command" ] || { echo "Error: No MCP server named 'trommi' found." >&2; exit 1; }
    echo "WARNING: a line before the JSON"
    printf '{"name":"trommi","enabled":true,"transport":{"type":"stdio","command":"%s","args":[],"env":{%s}}}\n' \
      "$(cat "$state/codex-command")" "$(cat "$state/codex-env")" ;;
  "mcp add")
    [ "$3 $4 $5 $6" = "trommi --env TROMMI_CHANNEL_EVENTS=off --" ] || { echo "unexpected: $*" >&2; exit 2; }
    printf '%s' "$7" > "$state/codex-command"
    printf '"TROMMI_CHANNEL_EVENTS":"off"' > "$state/codex-env" ;;
  *) echo "unexpected: $*" >&2; exit 2 ;;
esac
"#;

impl Desk {
    fn new(installed: bool) -> Desk {
        let dir = TempDir::new("setup");
        let tools = dir.path().join("tools");
        std::fs::create_dir_all(&tools).expect("a folder");
        executable(&tools.join("claude"), CLAUDE);
        executable(&tools.join("codex"), CODEX);
        if installed {
            let bin = dir.path().join(".local/share/trommi/bin");
            std::fs::create_dir_all(&bin).expect("a folder");
            executable(&bin.join("trommi-connector"), "#!/bin/sh\n");
        }
        Desk { dir }
    }
    fn program(&self) -> String {
        self.dir
            .path()
            .join(".local/share/trommi/bin/trommi-connector")
            .display()
            .to_string()
    }
    fn setup(&self, which: &str, with_tools: bool) -> Output {
        let mut dirs = vec![];
        if with_tools {
            dirs.push(self.dir.path().join("tools"));
        }
        dirs.extend(
            std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
                // (the machine's own claude and codex are never reached: the stand-ins come first, and
                // without them the folders that hold the real ones are left out)
                .filter(|dir| {
                    with_tools || (!dir.join("claude").exists() && !dir.join("codex").exists())
                }),
        );
        Command::new(common::process::connector_binary())
            .args(["setup", which])
            .env_clear()
            .env("HOME", self.dir.path())
            .env("PATH", std::env::join_paths(dirs).expect("a PATH"))
            .current_dir(self.dir.path())
            .output()
            .expect("the connector runs")
    }
    fn calls(&self) -> Vec<String> {
        std::fs::read_to_string(self.dir.path().join("calls"))
            .unwrap_or_default()
            .lines()
            .map(String::from)
            .collect()
    }
}

#[test]
fn setup_claude_adds_the_marketplace_and_the_plugin_once() {
    let desk = Desk::new(true);
    let first = desk.setup("claude", true);
    let text = said(&first);
    assert!(first.status.success(), "{text}");
    assert!(text.contains("marketplace trommi: added"), "{text}");
    assert!(text.contains("plugin trommi@trommi: installed"), "{text}");
    assert!(text.contains(&desk.program()), "{text}");
    assert_eq!(
        desk.calls(),
        [
            "claude plugin marketplace list --json",
            "claude plugin marketplace add trommi/trommi --sparse .claude-plugin connector/plugin",
            "claude plugin list --json",
            "claude plugin install trommi@trommi -s user -y",
        ]
    );
    // again: nothing is added a second time
    let second = desk.setup("claude", true);
    let text = said(&second);
    assert!(second.status.success(), "{text}");
    assert!(text.contains("marketplace trommi: there already"), "{text}");
    assert!(
        text.contains("plugin trommi@trommi: there already"),
        "{text}"
    );
    assert_eq!(
        desk.calls()[4..],
        [
            "claude plugin marketplace list --json",
            "claude plugin marketplace update trommi",
            "claude plugin list --json",
            "claude plugin update trommi@trommi",
        ]
    );
}

#[test]
fn setup_claude_leaves_a_marketplace_of_another_source_alone() {
    let desk = Desk::new(true);
    std::fs::write(
        desk.dir.path().join("markets"),
        r#"[{"name":"trommi","source":"url","url":"https://elsewhere.example/plugins/marketplace.json"}]"#,
    )
    .expect("written");
    let output = desk.setup("claude", true);
    let text = said(&output);
    assert!(!output.status.success(), "{text}");
    assert!(
        text.contains("another source") && text.contains("elsewhere.example"),
        "{text}"
    );
    assert!(text.contains("Nothing was changed"), "{text}");
    assert_eq!(desk.calls(), ["claude plugin marketplace list --json"]);
}

#[test]
fn setup_codex_registers_the_connector_as_a_plain_mcp_server_once() {
    let desk = Desk::new(true);
    let first = desk.setup("codex", true);
    let text = said(&first);
    assert!(first.status.success(), "{text}");
    assert!(text.contains("MCP server trommi: added"), "{text}");
    assert!(text.contains("inbox"), "the plain path is named: {text}");
    assert_eq!(
        desk.calls(),
        [
            "codex mcp get trommi --json".to_string(),
            format!(
                "codex mcp add trommi --env TROMMI_CHANNEL_EVENTS=off -- {}",
                desk.program()
            ),
        ]
    );
    let second = desk.setup("codex", true);
    assert!(second.status.success());
    assert!(
        said(&second).contains("there already, unchanged"),
        "{}",
        said(&second)
    );
    assert_eq!(
        desk.calls().len(),
        3,
        "the second run only looks: {:?}",
        desk.calls()
    );
    // set differently (another program): set again
    std::fs::write(desk.dir.path().join("codex-command"), "/somewhere/else").expect("written");
    let third = desk.setup("codex", true);
    assert!(
        said(&third).contains("was set differently, now set again"),
        "{}",
        said(&third)
    );
    assert_eq!(read(&desk.dir.path().join("codex-command")), desk.program());
}

#[test]
fn setup_says_what_is_missing() {
    // no connector installed: nothing is asked of claude or codex
    let desk = Desk::new(false);
    for which in ["claude", "codex"] {
        let output = desk.setup(which, true);
        assert!(!output.status.success());
        assert!(said(&output).contains("install.sh"), "{}", said(&output));
    }
    assert!(desk.calls().is_empty());
    // installed, but the other program is not on the PATH
    let desk = Desk::new(true);
    for which in ["claude", "codex"] {
        let output = desk.setup(which, false);
        assert!(!output.status.success());
        assert!(
            said(&output).contains(&format!("`{which}` is not on the PATH")),
            "{}",
            said(&output)
        );
    }
    let output = desk.setup("emacs", true);
    assert!(!output.status.success());
    assert!(said(&output).contains("setup claude"), "{}", said(&output));
}
