//! How the facade's data is declared: once, for both bindings.
//!
//! A [`record!`] is a struct of plain fields. For Swift it derives UniFFI's record; for the browser it becomes a
//! plain JavaScript object with the same fields in camel case. A [`choice!`] is an enum without data. For Swift
//! it derives UniFFI's enum; for the browser each case is the text given beside it.

/// A struct of plain fields that crosses the edge by value. `secret` in front keeps its fields out of `Debug`.
macro_rules! record {
    (
        $(#[$meta:meta])*
        pub struct $name:ident {
            $($(#[$field_meta:meta])* pub $field:ident: $ty:ty,)*
        }
    ) => {
        $(#[$meta])*
        #[derive(Debug, Clone, PartialEq, Eq)]
        #[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
        pub struct $name {
            $($(#[$field_meta])* pub $field: $ty,)*
        }
        record!(@js $name { $($field,)* });
    };
    (
        $(#[$meta:meta])*
        secret pub struct $name:ident {
            $($(#[$field_meta:meta])* pub $field:ident: $ty:ty,)*
        }
    ) => {
        $(#[$meta])*
        #[derive(Clone, PartialEq, Eq)]
        #[cfg_attr(feature = "uniffi", derive(uniffi::Record))]
        pub struct $name {
            $($(#[$field_meta])* pub $field: $ty,)*
        }
        impl std::fmt::Debug for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(concat!(stringify!($name), "(<redacted>)"))
            }
        }
        record!(@js $name { $($field,)* });
    };
    (@js $name:ident { $($field:ident,)* }) => {
        #[cfg(feature = "js")]
        impl $crate::js::ToJs for $name {
            fn to_js(&self) -> Result<wasm_bindgen::JsValue, $crate::CoreError> {
                let object = js_sys::Object::new();
                $($crate::js::set(&object, stringify!($field), &self.$field)?;)*
                Ok(object.into())
            }
        }
        #[cfg(feature = "js")]
        impl $crate::js::FromJs for $name {
            fn from_js(value: &wasm_bindgen::JsValue) -> Result<Self, $crate::CoreError> {
                $crate::js::object(value)?;
                Ok(Self {
                    $($field: $crate::js::get(value, stringify!($field))?,)*
                })
            }
        }
        #[cfg(feature = "js")]
        $crate::js::list!($name);
    };
}

/// An enum without data. Each case names the text it is in JavaScript.
macro_rules! choice {
    (
        $(#[$meta:meta])*
        pub enum $name:ident {
            $($(#[$case_meta:meta])* $case:ident = $text:literal,)*
        }
    ) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq)]
        #[cfg_attr(feature = "uniffi", derive(uniffi::Enum))]
        pub enum $name {
            $($(#[$case_meta])* $case,)*
        }

        impl $name {
            /// Every case, in the order of the declaration.
            pub const ALL: &'static [$name] = &[$($name::$case,)*];

            /// The case as text: what the browser binding hands out.
            pub fn text(self) -> &'static str {
                match self {
                    $($name::$case => $text,)*
                }
            }

            /// The case this text names.
            pub fn from_text(text: &str) -> Option<Self> {
                match text {
                    $($text => Some($name::$case),)*
                    _ => None,
                }
            }
        }

        #[cfg(feature = "js")]
        impl $crate::js::ToJs for $name {
            fn to_js(&self) -> Result<wasm_bindgen::JsValue, $crate::CoreError> {
                Ok(wasm_bindgen::JsValue::from_str(self.text()))
            }
        }
        #[cfg(feature = "js")]
        impl $crate::js::FromJs for $name {
            fn from_js(value: &wasm_bindgen::JsValue) -> Result<Self, $crate::CoreError> {
                value
                    .as_string()
                    .and_then(|text| Self::from_text(&text))
                    .ok_or_else(|| $crate::CoreError::bad_format(concat!("not a ", stringify!($name))))
            }
        }
        #[cfg(feature = "js")]
        $crate::js::list!($name);
    };
}
