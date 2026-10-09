//! The committed vector files are exactly what the core produces now.

use trommi_tests::vectors::{directory, render, FILES};

#[test]
fn every_vector_file_is_current() {
    for (name, generate) in FILES {
        let made = render(&generate().expect("generate")).expect("render");
        let path = directory().join(format!("{name}.json"));
        let stored = std::fs::read_to_string(&path)
            .unwrap_or_else(|_| panic!("{} is missing: run the vectors program", path.display()));
        assert_eq!(
            stored, made,
            "{name}.json is stale: run `cargo run -p trommi-tests --bin vectors`"
        );
    }
}

#[test]
fn no_vector_file_is_left_over() {
    let Ok(entries) = std::fs::read_dir(directory()) else {
        return;
    };
    for entry in entries {
        let file = entry
            .expect("entry")
            .file_name()
            .to_string_lossy()
            .into_owned();
        let name = file
            .strip_suffix(".json")
            .unwrap_or_else(|| panic!("{file} is not a vector file"));
        assert!(
            FILES.iter().any(|(known, _)| *known == name),
            "{file} has no generator"
        );
    }
}
