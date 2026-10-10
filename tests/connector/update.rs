//! The check a connector release must pass (connector/src/update.rs), with a throwaway key: one signed manifest
//! for all files of a release, in the form of `release/manifest.sh` and `release/sign.sh`.
use ed25519_dalek::{Signer, SigningKey};
use trommi_connector::update::{
    check, install, installed_version, tag_number, tags_in_feed, verify_file, Expect, Release,
    RELEASE_KEY,
};

const TARGET: &str = "x86_64-unknown-linux-musl";

fn hex(bytes: &[u8]) -> String {
    trommi_connector::util::hex(bytes)
}

/// A manifest as release/manifest.sh writes it.
fn manifest(
    product: &str,
    repository: &str,
    version: u64,
    tag: &str,
    files: &[(&str, &[u8])],
) -> Vec<u8> {
    let assets: Vec<String> = files
        .iter()
        .map(|(name, bytes)| {
            format!(
                "\n    {{ \"name\": \"{name}\", \"sha256\": \"{}\", \"size\": {} }}",
                hex(&trommi_connector::util::sha256(bytes)),
                bytes.len()
            )
        })
        .collect();
    format!(
        "{{\n  \"product\": \"{product}\",\n  \"repository\": \"{repository}\",\n  \"version\": {version},\n  \"tag\": \"{tag}\",\n  \"commit\": \"{}\",\n  \"assets\": [{}\n  ]\n}}\n",
        "0".repeat(40),
        assets.join(",")
    )
    .into_bytes()
}

struct Case {
    key: SigningKey,
    binary: Vec<u8>,
}

impl Case {
    fn new() -> Case {
        Case {
            key: SigningKey::from_bytes(&trommi_connector::util::random().expect("random")),
            binary: b"the connector's bytes".to_vec(),
        }
    }
    fn good(&self, version: u64) -> Vec<u8> {
        manifest(
            "trommi-connector",
            "trommi/trommi",
            version,
            &format!("connector-v{version}"),
            &[
                ("trommi-connector-x86_64-unknown-linux-musl", &self.binary),
                (
                    "trommi-connector-aarch64-apple-darwin",
                    b"another machine's",
                ),
            ],
        )
    }
    fn sign(&self, manifest: &[u8]) -> Vec<u8> {
        self.key.sign(manifest).to_bytes().to_vec()
    }
    fn check(&self, manifest: &[u8], signature: &[u8], running: u64) -> Result<u64, &'static str> {
        let public = self.key.verifying_key().to_bytes();
        let expect = Expect {
            key: &public,
            target: TARGET,
            running,
        };
        check(&expect, manifest, signature, &self.binary)
    }
}

#[test]
fn a_release_signed_with_the_key_is_taken() {
    let case = Case::new();
    let manifest = case.good(7);
    assert_eq!(case.check(&manifest, &case.sign(&manifest), 0), Ok(7));
    assert_eq!(
        case.check(&manifest, &case.sign(&manifest), 7),
        Ok(7),
        "the same version is no step back"
    );
}

#[test]
fn a_wrong_or_missing_signature_is_refused() {
    let case = Case::new();
    let manifest = case.good(7);
    let other = Case::new();
    assert!(
        case.check(&manifest, &other.sign(&manifest), 0).is_err(),
        "another key"
    );
    assert!(case.check(&manifest, &[], 0).is_err(), "no signature");
    assert!(
        case.check(&manifest, &[0u8; 64], 0).is_err(),
        "no signature of anything"
    );
    // One byte of the manifest changed after signing.
    let signature = case.sign(&manifest);
    let mut changed = manifest.clone();
    let at = changed
        .iter()
        .position(|b| *b == b'7')
        .expect("the version");
    changed[at] = b'8';
    assert!(case.check(&changed, &signature, 0).is_err());
}

#[test]
fn an_older_version_another_product_and_another_repository_are_refused() {
    let case = Case::new();
    let signed = |manifest: Vec<u8>, running: u64| {
        let signature = case.sign(&manifest);
        case.check(&manifest, &signature, running)
    };
    assert_eq!(
        signed(case.good(6), 7),
        Err("the release is older than the connector that runs")
    );
    let files: &[(&str, &[u8])] = &[("trommi-connector-x86_64-unknown-linux-musl", &case.binary)];
    assert_eq!(
        signed(
            manifest("trommi-hub", "trommi/trommi", 7, "hub-v7", files),
            0
        ),
        Err("the manifest is of another product")
    );
    assert_eq!(
        signed(
            manifest("trommi-connector", "someone/else", 7, "connector-v7", files),
            0
        ),
        Err("the manifest is of another repository")
    );
    assert_eq!(
        signed(
            manifest(
                "trommi-connector",
                "trommi/trommi",
                7,
                "connector-v8",
                files
            ),
            0
        ),
        Err("the manifest's tag is not its version's")
    );
}

#[test]
fn a_binary_the_manifest_does_not_name_is_refused() {
    let mut case = Case::new();
    let manifest = case.good(7);
    let signature = case.sign(&manifest);
    case.binary.push(0);
    assert_eq!(
        case.check(&manifest, &signature, 0),
        Err("the binary is not the file the manifest names")
    );
    // A release without a binary for this machine.
    let case = Case::new();
    let other = manifest_for_another_machine(&case);
    assert_eq!(
        case.check(&other, &case.sign(&other), 0),
        Err("the manifest names no binary for this machine")
    );
}

fn manifest_for_another_machine(case: &Case) -> Vec<u8> {
    manifest(
        "trommi-connector",
        "trommi/trommi",
        7,
        "connector-v7",
        &[("trommi-connector-aarch64-apple-darwin", &case.binary)],
    )
}

#[test]
fn the_compiled_in_key_is_the_repositorys_and_a_binary_without_a_manifest_is_said_to_be_unverified()
{
    // release/public-key.pem: the last 32 bytes of the key's SubjectPublicKeyInfo, base64 in the PEM body.
    let pem = include_str!("../../release/public-key.pem");
    let body: String = pem
        .lines()
        .filter(|line| !line.starts_with("-----"))
        .collect();
    let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut bits = String::new();
    for c in body.bytes().filter(|c| *c != b'=') {
        let value = alphabet.iter().position(|a| *a == c).expect("base64");
        bits.push_str(&format!("{value:06b}"));
    }
    let der: Vec<u8> = bits
        .as_bytes()
        .chunks(8)
        .filter(|chunk| chunk.len() == 8)
        .map(|chunk| {
            u8::from_str_radix(std::str::from_utf8(chunk).expect("bits"), 2).expect("a byte")
        })
        .collect();
    assert_eq!(der.len(), 44);
    assert_eq!(RELEASE_KEY, der[12..]);

    // A binary with nothing beside it; then with a manifest that is not signed with the repository's key.
    let dir = std::env::temp_dir().join(format!(
        "trommi-update-{}",
        trommi_connector::util::random_hex(4)
    ));
    std::fs::create_dir_all(&dir).expect("a folder");
    let binary = dir.join("trommi-connector");
    std::fs::write(&binary, b"bytes").expect("written");
    assert_eq!(verify_file(&binary), Release::Unverified);
    let case = Case::new();
    let manifest = case.good(7);
    std::fs::write(dir.join("manifest.json"), &manifest).expect("written");
    std::fs::write(dir.join("manifest.json.sig"), case.sign(&manifest)).expect("written");
    assert!(matches!(verify_file(&binary), Release::Refused(_)));
    let _ = std::fs::remove_dir_all(&dir);
}

/// The form is the one `release/sign.sh` makes with OpenSSL (`pkeyutl -sign -rawin`): checked against the real
/// tool where it is installed.
#[test]
fn a_signature_made_by_openssl_as_the_release_script_makes_it_is_taken() {
    let dir = std::env::temp_dir().join(format!(
        "trommi-sign-{}",
        trommi_connector::util::random_hex(4)
    ));
    std::fs::create_dir_all(&dir).expect("a folder");
    let run = |args: &[&str]| {
        std::process::Command::new("openssl")
            .args(args)
            .current_dir(&dir)
            .output()
            .ok()
            .filter(|output| output.status.success())
    };
    if run(&["genpkey", "-algorithm", "ed25519", "-out", "key.pem"]).is_none() {
        eprintln!("skipped: no openssl with Ed25519 on this machine");
        let _ = std::fs::remove_dir_all(&dir);
        return;
    }
    let case = Case::new();
    let manifest = case.good(9);
    std::fs::write(dir.join("manifest.json"), &manifest).expect("written");
    run(&[
        "pkeyutl",
        "-sign",
        "-rawin",
        "-inkey",
        "key.pem",
        "-in",
        "manifest.json",
        "-out",
        "manifest.json.sig",
    ])
    .expect("openssl signs");
    let public =
        run(&["pkey", "-in", "key.pem", "-pubout", "-outform", "DER"]).expect("the public key");
    let key: [u8; 32] = public.stdout[public.stdout.len() - 32..]
        .try_into()
        .expect("32 bytes");
    let signature = std::fs::read(dir.join("manifest.json.sig")).expect("the signature");
    let expect = Expect {
        key: &key,
        target: TARGET,
        running: 0,
    };
    assert_eq!(check(&expect, &manifest, &signature, &case.binary), Ok(9));
    let _ = std::fs::remove_dir_all(&dir);
}

/// One tag series for the whole repository (`v<N>`, product `trommi`) is taken as well as the connector's own.
#[test]
fn a_release_of_the_whole_repository_is_taken_by_its_own_tag() {
    let case = Case::new();
    let files: &[(&str, &[u8])] = &[
        ("trommi-connector-x86_64-unknown-linux-musl", &case.binary),
        ("trommi-hub-x86_64-unknown-linux-musl", b"the hub"),
    ];
    let signed = |manifest: Vec<u8>| {
        let signature = case.sign(&manifest);
        case.check(&manifest, &signature, 0)
    };
    assert_eq!(
        signed(manifest("trommi", "trommi/trommi", 31, "v31", files)),
        Ok(31)
    );
    assert_eq!(
        signed(manifest("trommi", "trommi/trommi", 31, "v32", files)),
        Err("the manifest's tag is not its version's")
    );
    assert_eq!(
        signed(manifest("trommi", "trommi/trommi", 31, "hub-v31", files)),
        Err("the manifest's tag is not its version's")
    );
}

#[test]
fn a_checked_release_is_put_in_place_and_a_refused_one_changes_nothing() {
    let dir = std::env::temp_dir().join(format!(
        "trommi-install-{}",
        trommi_connector::util::random_hex(4)
    ));
    let mut case = Case::new();
    let public = case.key.verifying_key().to_bytes();
    let expect = Expect {
        key: &public,
        target: TARGET,
        running: 0,
    };
    assert_eq!(installed_version(&public, &dir), 0, "nothing is there yet");
    let manifest = case.good(7);
    let signature = case.sign(&manifest);
    assert_eq!(
        install(&expect, &dir, &manifest, &signature, &case.binary),
        Ok(7)
    );
    let read = |name: &str| std::fs::read(dir.join(name)).expect(name);
    assert_eq!(read("trommi-connector"), case.binary);
    assert_eq!(read("manifest.json"), manifest);
    assert_eq!(read("manifest.json.sig"), signature);
    use std::os::unix::fs::PermissionsExt;
    let mode = std::fs::metadata(dir.join("trommi-connector"))
        .expect("the program")
        .permissions()
        .mode();
    assert_eq!(mode & 0o777, 0o755);
    assert_eq!(installed_version(&public, &dir), 7);
    assert_eq!(
        installed_version(&RELEASE_KEY, &dir),
        0,
        "a manifest another key signed counts for nothing"
    );

    // An older release is refused against what is installed, whatever the process itself was built as.
    let older = case.good(6);
    assert_eq!(
        install(&expect, &dir, &older, &case.sign(&older), &case.binary),
        Err("the release is older than the connector that runs".to_string())
    );
    // A newer manifest with a binary that is not the one it names: refused, and the installed one stays.
    let newer = case.good(8);
    let newer_signature = case.sign(&newer);
    assert!(install(&expect, &dir, &newer, &newer_signature, b"something else").is_err());
    assert_eq!(read("trommi-connector"), case.binary);
    assert_eq!(
        read("manifest.json"),
        manifest,
        "the installed manifest stays"
    );
    // The same release with its own binary is taken.
    case.binary = b"the next connector".to_vec();
    let next = case.good(8);
    let next_signature = case.sign(&next);
    assert_eq!(
        install(&expect, &dir, &next, &next_signature, &case.binary),
        Ok(8)
    );
    assert_eq!(read("trommi-connector"), case.binary);
    let left: Vec<String> = std::fs::read_dir(&dir)
        .expect("the folder")
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with(".new."))
        .collect();
    assert!(left.is_empty(), "nothing half written is left: {left:?}");
    let _ = std::fs::remove_dir_all(&dir);
}

/// The release tags are read from GitHub's feed of releases, highest number first, whatever the series is
/// called; what is not a release tag of this repository is left out.
#[test]
fn the_release_tags_are_read_from_githubs_feed_newest_first() {
    let entry = |href: &str| {
        format!("<entry><link rel=\"alternate\" type=\"text/html\" href=\"{href}\"/></entry>")
    };
    let ours = |tag: &str| {
        entry(&format!(
            "https://github.com/trommi/trommi/releases/tag/{tag}"
        ))
    };
    let feed = [
        ours("hub-v40"),
        ours("connector-v19"),
        ours("connector-v9"),
        ours("v21"),
        ours("v021"),
        ours("nightly"),
        ours("Connector-v99"),
        ours("-v98"),
        ours("connector-v19"),
        entry("https://github.com/someone/else/releases/tag/connector-v97"),
    ]
    .concat();
    assert_eq!(
        tags_in_feed(&feed),
        ["hub-v40", "v21", "connector-v19", "connector-v9"]
    );
    assert!(tags_in_feed("<html>rate limited</html>").is_empty());
    assert_eq!(tag_number("connector-v22"), Some(22));
    assert_eq!(tag_number("v7"), Some(7));
    assert_eq!(tag_number("v0"), None);
    assert_eq!(tag_number("connector-v"), None);
}
