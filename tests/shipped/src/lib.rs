//! The protocol core as it ships. This package depends on `trommi-core` with its default features, so that
//! `cargo test -p trommi-tests-shipped` builds and tests the core without the cargo feature `vectors`, which
//! the scenario tests beside it turn on for their seeded devices.
