//! trommi-core for Swift. The device's interface follows the core's, one function for one; until it does, the
//! library answers one question.

uniffi::setup_scaffolding!();

/// The version of the core this library was built from.
#[uniffi::export]
pub fn core_version() -> String {
    trommi_core::VERSION.to_string()
}
