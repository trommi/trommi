//! The facade's data as JavaScript values, for the browser binding: bytes are a `Uint8Array`, a record is a plain
//! object with its fields in camel case, a list is an `Array`, nothing is `undefined`, a number is a `number`.
//!
//! Numbers: JavaScript's `number` holds integers exactly up to 2^53 − 1. Everything the protocol counts (epochs,
//! change numbers, milliseconds, lengths) stays far below that, so a `u64` crosses as a `number`. Coming in, a
//! number that is not a whole one in that range is refused. Going out, a larger one is handed over as 2^53 − 1:
//! only a value another device made up gets there (a clock, a lifetime), and a call whose work is already stored
//! must not fail over it.

use crate::CoreError;
use js_sys::{Array, Object, Reflect, Uint8Array};
use wasm_bindgen::{JsCast, JsValue};

/// The largest integer a JavaScript `number` holds exactly.
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

/// A value handed to JavaScript.
pub trait ToJs {
    /// The JavaScript value.
    fn to_js(&self) -> Result<JsValue, CoreError>;
}

/// A value taken from JavaScript. Anything of another type than the call takes is `bad-format`.
pub trait FromJs: Sized {
    /// The Rust value.
    fn from_js(value: &JsValue) -> Result<Self, CoreError>;
}

/// `snake_case` as `camelCase`: how a field or a call is spelled in JavaScript.
pub fn camel(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut upper = false;
    for character in name.chars() {
        if character == '_' {
            upper = true;
        } else if upper {
            out.extend(character.to_uppercase());
            upper = false;
        } else {
            out.push(character);
        }
    }
    out
}

/// A new object for a record: without a prototype, so that nothing a page did to `Object.prototype` (a setter,
/// a field that cannot be written) stands between a record and its own fields.
pub fn record() -> Result<Object, CoreError> {
    let object = Object::new();
    if Reflect::set_prototype_of(&object, &JsValue::NULL) == Ok(true) {
        Ok(object)
    } else {
        Err(CoreError::internal("a record could not be made"))
    }
}

/// Sets the field `name` of `object`.
pub fn set(object: &Object, name: &str, value: &impl ToJs) -> Result<(), CoreError> {
    match Reflect::set(object, &JsValue::from_str(&camel(name)), &value.to_js()?) {
        Ok(true) => Ok(()),
        _ => Err(CoreError::internal("a field could not be set")),
    }
}

/// Reads the field `name` of `object`.
pub fn get<T: FromJs>(object: &JsValue, name: &str) -> Result<T, CoreError> {
    let value = Reflect::get(object, &JsValue::from_str(&camel(name)))
        .map_err(|_| CoreError::bad_format(name))?;
    T::from_js(&value)
}

/// Refuses anything that is not an object with fields.
pub fn object(value: &JsValue) -> Result<(), CoreError> {
    if value.is_object() && !Array::is_array(value) {
        Ok(())
    } else {
        Err(CoreError::bad_format("not an object"))
    }
}

impl ToJs for () {
    fn to_js(&self) -> Result<JsValue, CoreError> {
        Ok(JsValue::UNDEFINED)
    }
}

impl ToJs for bool {
    fn to_js(&self) -> Result<JsValue, CoreError> {
        Ok(JsValue::from_bool(*self))
    }
}

impl FromJs for bool {
    fn from_js(value: &JsValue) -> Result<Self, CoreError> {
        value
            .as_bool()
            .ok_or_else(|| CoreError::bad_format("not a boolean"))
    }
}

impl ToJs for u64 {
    fn to_js(&self) -> Result<JsValue, CoreError> {
        Ok(JsValue::from_f64((*self).min(MAX_SAFE_INTEGER) as f64))
    }
}

impl FromJs for u64 {
    fn from_js(value: &JsValue) -> Result<Self, CoreError> {
        let number = value
            .as_f64()
            .ok_or_else(|| CoreError::bad_format("not a number"))?;
        // A whole number from 0 to 2^53 − 1: the cast below is then exact.
        if number >= 0.0 && number <= MAX_SAFE_INTEGER as f64 && number.fract() == 0.0 {
            Ok(number as u64)
        } else {
            Err(CoreError::bad_format(
                "not a whole number from 0 to 2^53 - 1",
            ))
        }
    }
}

impl ToJs for u32 {
    fn to_js(&self) -> Result<JsValue, CoreError> {
        Ok(JsValue::from_f64(f64::from(*self)))
    }
}

impl FromJs for u32 {
    fn from_js(value: &JsValue) -> Result<Self, CoreError> {
        u32::try_from(u64::from_js(value)?)
            .map_err(|_| CoreError::bad_format("a number above 2^32"))
    }
}

impl ToJs for u8 {
    fn to_js(&self) -> Result<JsValue, CoreError> {
        Ok(JsValue::from_f64(f64::from(*self)))
    }
}

impl FromJs for u8 {
    fn from_js(value: &JsValue) -> Result<Self, CoreError> {
        u8::try_from(u64::from_js(value)?).map_err(|_| CoreError::bad_format("a number above 255"))
    }
}

impl ToJs for String {
    fn to_js(&self) -> Result<JsValue, CoreError> {
        Ok(JsValue::from_str(self))
    }
}

impl FromJs for String {
    fn from_js(value: &JsValue) -> Result<Self, CoreError> {
        value
            .as_string()
            .ok_or_else(|| CoreError::bad_format("not a string"))
    }
}

/// Bytes are a `Uint8Array` of their own, never a view of the module's memory: what JavaScript holds stays valid
/// whatever the core does next.
impl ToJs for Vec<u8> {
    fn to_js(&self) -> Result<JsValue, CoreError> {
        Ok(Uint8Array::from(self.as_slice()).into())
    }
}

/// No argument is larger than the largest stored file. Checked before the bytes are copied in: an absurd length
/// is refused, not allocated.
impl FromJs for Vec<u8> {
    fn from_js(value: &JsValue) -> Result<Self, CoreError> {
        let bytes = value
            .dyn_ref::<Uint8Array>()
            .ok_or_else(|| CoreError::bad_format("not a Uint8Array"))?;
        if u64::from(bytes.length()) > trommi_core::files::MAX_STORED_LEN {
            return Err(trommi_core::Error::TooLarge.into());
        }
        Ok(bytes.to_vec())
    }
}

impl<T: ToJs> ToJs for Option<T> {
    fn to_js(&self) -> Result<JsValue, CoreError> {
        match self {
            Some(value) => value.to_js(),
            None => Ok(JsValue::NULL),
        }
    }
}

impl<T: FromJs> FromJs for Option<T> {
    fn from_js(value: &JsValue) -> Result<Self, CoreError> {
        if value.is_null() || value.is_undefined() {
            Ok(None)
        } else {
            T::from_js(value).map(Some)
        }
    }
}

/// A list of anything but bytes: `Vec<u8>` is a `Uint8Array`, above. Every path is written out, because the
/// records' own declarations use this macro from their modules.
macro_rules! list {
    ($($ty:ty),* $(,)?) => {$(
        impl $crate::js::ToJs for Vec<$ty> {
            fn to_js(&self) -> Result<wasm_bindgen::JsValue, $crate::CoreError> {
                let array = js_sys::Array::new();
                for item in self {
                    array.push(&$crate::js::ToJs::to_js(item)?);
                }
                Ok(array.into())
            }
        }

        impl $crate::js::FromJs for Vec<$ty> {
            fn from_js(value: &wasm_bindgen::JsValue) -> Result<Self, $crate::CoreError> {
                if !js_sys::Array::is_array(value) {
                    return Err($crate::CoreError::bad_format("not an array"));
                }
                js_sys::Array::from(value)
                    .iter()
                    .map(|item| <$ty as $crate::js::FromJs>::from_js(&item))
                    .collect()
            }
        }
    )*};
}
pub(crate) use list;

list!(Vec<u8>, u64, String);
