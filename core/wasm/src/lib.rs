//! trommi-core for the browser: a plain ES module over the core. The device's interface follows the core's, one
//! function for one; until it does, the module answers one question.

use wasm_bindgen::prelude::*;

/// The version of the core this module was built from.
#[wasm_bindgen(js_name = coreVersion)]
pub fn core_version() -> String {
    trommi_core::VERSION.to_string()
}
