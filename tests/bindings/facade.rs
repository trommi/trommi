//! The facade both bindings share (`core/swift/src`), called from Rust as a host would call it.

use trommi_core_ffi::{self_test, versions};
use trommi_tests::now;

#[test]
fn the_self_test_passes_and_names_its_steps() {
    let report = self_test(now());
    for step in &report.steps {
        println!(
            "{:>9} µs  {}  {}",
            step.micros,
            if step.ok { "ok  " } else { "FAIL" },
            step.name
        );
        assert!(step.ok, "{}: {}", step.name, step.detail);
    }
    assert!(report.ok);
    assert_eq!(report.steps.len(), 11);
    assert_eq!(report.versions, versions());
}
