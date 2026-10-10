# Third-party material in the Rust workspace

Every crate of `Cargo.lock` that is a dependency of a client library on a target it ships for: the web app
(`core/wasm`, wasm32-unknown-unknown), the iOS app (`core/swift`, aarch64-apple-ios and its simulator) and the
connector (`core`, Linux musl and macOS, both architectures). The tables are what `cargo tree` reports per package
and target (`-e normal,no-proc-macro` for what is linked; `-e normal,build` minus that for what only runs at build
time), with the licence each crate declares. The tables are written by `node .github/scripts/third_party.mjs`; the
build checks that they are current. The web app's own third-party material:
[`app/web/THIRD-PARTY.md`](app/web/THIRD-PARTY.md).

## MPL-2.0

The `hpke-rs` crates (HPKE, in every client) and the `uniffi` crates (the Swift bridge, iOS only) are under the
Mozilla Public License 2.0. Whoever distributes a client built from them must:

- make the source of those crates available to whoever receives the binary, and say where: unchanged crates are
  their published sources on crates.io at the versions below; a changed file must be published under MPL-2.0;
- tell recipients that those files are under MPL-2.0, and leave their licence notices in place;
- not restrict, by the terms of the whole, the rights MPL-2.0 gives recipients in those files.

The licence is per file: it asks nothing of Trommi's own code, which is linked with those crates and not changed
into them.

## Linked into a client

Licences that ask for their notice in a binary distribution (MIT, BSD, Apache-2.0, Unicode-3.0) are met by shipping
the crates' licence texts with the client.

| Crate | Version | Licence | In |
| --- | --- | --- | --- |
| aead | 0.5.2 | MIT OR Apache-2.0 | all |
| aes | 0.8.4 | MIT OR Apache-2.0 | all |
| aes-gcm | 0.10.3 | Apache-2.0 OR MIT | all |
| anyhow | 1.0.104 | MIT OR Apache-2.0 | iOS |
| argon2 | 0.5.3 | MIT OR Apache-2.0 | all |
| base16ct | 0.2.0 | Apache-2.0 OR MIT | all |
| base64ct | 1.8.3 | Apache-2.0 OR MIT | all |
| bitflags | 2.13.2 | MIT OR Apache-2.0 | iOS |
| blake2 | 0.10.6 | MIT OR Apache-2.0 | all |
| block-buffer | 0.10.4 | MIT OR Apache-2.0 | all |
| block-buffer | 0.12.1 | MIT OR Apache-2.0 | all |
| bytes | 1.12.1 | MIT | iOS |
| camino | 1.2.6 | MIT OR Apache-2.0 | iOS |
| cargo-platform | 0.3.3 | MIT OR Apache-2.0 | iOS |
| cargo_metadata | 0.23.1 | MIT | iOS |
| cfg-if | 1.0.5 | MIT OR Apache-2.0 | all |
| chacha20 | 0.9.1 | Apache-2.0 OR MIT | all |
| chacha20poly1305 | 0.10.1 | Apache-2.0 OR MIT | all |
| cipher | 0.4.4 | MIT OR Apache-2.0 | all |
| cmov | 0.5.4 | Apache-2.0 OR MIT | all |
| const-oid | 0.9.6 | Apache-2.0 OR MIT | all |
| const-oid | 0.10.2 | Apache-2.0 OR MIT | all |
| cpufeatures | 0.2.17 | MIT OR Apache-2.0 | iOS, connector |
| cpufeatures | 0.3.1 | MIT OR Apache-2.0 | iOS, connector |
| crossbeam-deque | 0.8.8 | MIT OR Apache-2.0 | all |
| crossbeam-epoch | 0.9.21 | MIT OR Apache-2.0 | all |
| crossbeam-utils | 0.8.23 | MIT OR Apache-2.0 | all |
| crypto-bigint | 0.5.5 | Apache-2.0 OR MIT | all |
| crypto-common | 0.1.7 | MIT OR Apache-2.0 | all |
| crypto-common | 0.2.2 | MIT OR Apache-2.0 | all |
| ctr | 0.9.2 | MIT OR Apache-2.0 | all |
| ctutils | 0.4.3 | Apache-2.0 OR MIT | all |
| curve25519-dalek | 4.1.3 | BSD-3-Clause | all |
| curve25519-dalek | 5.0.0 | BSD-3-Clause | all |
| der | 0.7.10 | Apache-2.0 OR MIT | all |
| der | 0.8.2 | Apache-2.0 OR MIT | all |
| digest | 0.10.7 | MIT OR Apache-2.0 | all |
| digest | 0.11.3 | MIT OR Apache-2.0 | all |
| ecdsa | 0.16.9 | Apache-2.0 OR MIT | all |
| ed25519 | 2.2.3 | Apache-2.0 OR MIT | all |
| ed25519-dalek | 2.2.0 | BSD-3-Clause | all |
| either | 1.19.0 | MIT OR Apache-2.0 | all |
| elliptic-curve | 0.13.8 | Apache-2.0 OR MIT | all |
| equivalent | 1.0.2 | Apache-2.0 OR MIT | iOS |
| errno | 0.3.14 | MIT OR Apache-2.0 | iOS |
| fastrand | 2.5.0 | Apache-2.0 OR MIT | iOS |
| ff | 0.13.1 | MIT/Apache-2.0 | all |
| futures-core | 0.3.34 | MIT OR Apache-2.0 | web |
| futures-task | 0.3.34 | MIT OR Apache-2.0 | web |
| futures-util | 0.3.34 | MIT OR Apache-2.0 | web |
| generic-array | 0.14.7 | MIT | all |
| getrandom | 0.2.17 | MIT OR Apache-2.0 | all |
| getrandom | 0.4.3 | MIT OR Apache-2.0 | all |
| ghash | 0.5.1 | Apache-2.0 OR MIT | all |
| group | 0.13.0 | MIT/Apache-2.0 | all |
| hashbrown | 0.17.1 | MIT OR Apache-2.0 | iOS |
| hax-lib | 0.3.7 | Apache-2.0 | all |
| heck | 0.5.0 | MIT OR Apache-2.0 | iOS |
| hkdf | 0.12.4 | MIT OR Apache-2.0 | all |
| hkdf | 0.13.0 | MIT OR Apache-2.0 | all |
| hmac | 0.12.1 | MIT OR Apache-2.0 | all |
| hmac | 0.13.0 | MIT OR Apache-2.0 | all |
| hpke-rs | 0.7.0 | **MPL-2.0** | all |
| hpke-rs-crypto | 0.7.0 | **MPL-2.0** | all |
| hpke-rs-rust-crypto | 0.7.0 | **MPL-2.0** | all |
| hybrid-array | 0.4.15 | MIT OR Apache-2.0 | all |
| indexmap | 2.14.2 | Apache-2.0 OR MIT | iOS |
| inout | 0.1.4 | MIT OR Apache-2.0 | all |
| itoa | 1.0.18 | MIT OR Apache-2.0 | all |
| js-sys | 0.3.106 | MIT OR Apache-2.0 | web |
| k256 | 0.13.4 | Apache-2.0 OR MIT | all |
| keccak | 0.2.2 | Apache-2.0 OR MIT | all |
| kem | 0.3.0 | Apache-2.0 OR MIT | all |
| libc | 0.2.190 | MIT OR Apache-2.0 | all |
| libcrux-intrinsics | 0.0.8 | Apache-2.0 | all |
| libcrux-platform | 0.0.3 | Apache-2.0 | all |
| libcrux-secrets | 0.0.6 | Apache-2.0 | all |
| libcrux-sha3 | 0.0.10 | Apache-2.0 | all |
| libcrux-traits | 0.0.8 | Apache-2.0 | all |
| log | 0.4.34 | MIT OR Apache-2.0 | all |
| memchr | 2.8.3 | Unlicense OR MIT | all |
| ml-dsa | 0.1.1 | Apache-2.0 OR MIT | all |
| ml-kem | 0.3.2 | Apache-2.0 OR MIT | all |
| module-lattice | 0.2.3 | Apache-2.0 OR MIT | all |
| num-traits | 0.2.19 | MIT OR Apache-2.0 | all |
| once_cell | 1.21.4 | MIT OR Apache-2.0 | web, iOS |
| opaque-debug | 0.3.1 | MIT OR Apache-2.0 | all |
| openmls | 0.9.1 | MIT | all |
| openmls_basic_credential | 0.6.0 | MIT | all |
| openmls_memory_storage | 0.6.0 | MIT | all |
| openmls_rust_crypto | 0.6.0 | MIT | all |
| openmls_traits | 0.6.0 | MIT | all |
| p256 | 0.13.2 | Apache-2.0 OR MIT | all |
| p384 | 0.13.1 | Apache-2.0 OR MIT | all |
| pem-rfc7468 | 0.7.0 | Apache-2.0 OR MIT | all |
| pin-project-lite | 0.2.17 | Apache-2.0 OR MIT | web |
| pkcs8 | 0.10.2 | Apache-2.0 OR MIT | all |
| pkcs8 | 0.11.0 | Apache-2.0 OR MIT | all |
| poly1305 | 0.8.0 | Apache-2.0 OR MIT | all |
| polyval | 0.6.2 | Apache-2.0 OR MIT | all |
| ppv-lite86 | 0.2.21 | MIT OR Apache-2.0 | all |
| primeorder | 0.13.6 | Apache-2.0 OR MIT | all |
| rand | 0.10.3 | MIT OR Apache-2.0 | all |
| rand_chacha | 0.3.1 | MIT OR Apache-2.0 | all |
| rand_chacha | 0.10.0 | MIT OR Apache-2.0 | all |
| rand_core | 0.6.4 | MIT OR Apache-2.0 | all |
| rand_core | 0.10.1 | MIT OR Apache-2.0 | all |
| rayon | 1.12.0 | MIT OR Apache-2.0 | all |
| rayon-core | 1.13.0 | MIT OR Apache-2.0 | all |
| rfc6979 | 0.4.0 | Apache-2.0 OR MIT | all |
| rustix | 1.1.5 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | iOS |
| sec1 | 0.7.3 | Apache-2.0 OR MIT | all |
| semver | 1.0.28 | MIT OR Apache-2.0 | iOS |
| serde | 1.0.229 | MIT OR Apache-2.0 | all |
| serde_bytes | 0.11.19 | MIT OR Apache-2.0 | all |
| serde_core | 1.0.229 | MIT OR Apache-2.0 | all |
| serde_json | 1.0.151 | MIT OR Apache-2.0 | all |
| sha2 | 0.10.9 | MIT OR Apache-2.0 | all |
| sha2 | 0.11.0 | MIT OR Apache-2.0 | all |
| sha3 | 0.11.0 | MIT OR Apache-2.0 | all |
| sha3 | 0.12.0 | MIT OR Apache-2.0 | all |
| shake | 0.1.0 | MIT OR Apache-2.0 | all |
| signature | 2.2.0 | Apache-2.0 OR MIT | all |
| signature | 3.0.0 | Apache-2.0 OR MIT | all |
| slab | 0.4.12 | MIT | web |
| spki | 0.7.3 | Apache-2.0 OR MIT | all |
| spki | 0.8.1 | Apache-2.0 OR MIT | all |
| sponge-cursor | 0.1.0 | MIT OR Apache-2.0 | all |
| static_assertions | 1.1.0 | MIT OR Apache-2.0 | iOS |
| subtle | 2.6.1 | BSD-3-Clause | all |
| tempfile | 3.27.0 | MIT OR Apache-2.0 | iOS |
| thiserror | 2.0.21 | MIT OR Apache-2.0 | all |
| tinyvec | 1.13.3 | Zlib OR Apache-2.0 OR MIT | all |
| tls_codec | 0.5.0 | Apache-2.0 OR MIT | all |
| typenum | 1.20.1 | MIT OR Apache-2.0 | all |
| unicode-ident | 1.0.26 | (MIT OR Apache-2.0) AND Unicode-3.0 | web |
| unicode-normalization | 0.1.25 | MIT OR Apache-2.0 | all |
| uniffi | 0.32.2 | **MPL-2.0** | iOS |
| uniffi_core | 0.32.2 | **MPL-2.0** | iOS |
| uniffi_pipeline | 0.32.2 | **MPL-2.0** | iOS |
| universal-hash | 0.5.1 | MIT OR Apache-2.0 | all |
| wasm-bindgen | 0.2.129 | MIT OR Apache-2.0 | web |
| wasm-bindgen-shared | 0.2.129 | MIT OR Apache-2.0 | web |
| web-time | 1.1.0 | MIT OR Apache-2.0 | web |
| x-wing | 0.1.1 | Apache-2.0 OR MIT | all |
| x25519-dalek | 2.0.1 | BSD-3-Clause | all |
| x25519-dalek | 3.0.0 | BSD-3-Clause | all |
| zerocopy | 0.8.62 | BSD-2-Clause OR Apache-2.0 OR MIT | all |
| zeroize | 1.9.1 | Apache-2.0 OR MIT | all |
| zmij | 1.0.23 | MIT | all |

## Used only while building

Procedural macros, build scripts and what they need: compiled for the build machine, never part of a client.

| Crate | Version | Licence |
| --- | --- | --- |
| autocfg | 1.5.1 | Apache-2.0 OR MIT |
| bumpalo | 3.20.3 | MIT OR Apache-2.0 |
| curve25519-dalek-derive | 0.1.1 | MIT/Apache-2.0 |
| fs-err | 3.3.2 | MIT OR Apache-2.0 |
| hax-lib-macros | 0.3.7 | Apache-2.0 |
| linux-raw-sys | 0.12.1 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| openmls_serialization_helpers | 0.1.0 | MIT |
| proc-macro2 | 1.0.107 | MIT OR Apache-2.0 |
| quote | 1.0.47 | MIT OR Apache-2.0 |
| rustc_version | 0.4.1 | MIT OR Apache-2.0 |
| rustversion | 1.0.23 | MIT OR Apache-2.0 |
| serde_derive | 1.0.229 | MIT OR Apache-2.0 |
| serde_spanned | 1.1.2 | MIT OR Apache-2.0 |
| siphasher | 1.0.4 | MIT OR Apache-2.0 |
| syn | 2.0.119 | MIT OR Apache-2.0 |
| syn | 3.0.6 | MIT OR Apache-2.0 |
| thiserror-impl | 2.0.21 | MIT OR Apache-2.0 |
| tls_codec_derive | 0.5.0 | Apache-2.0 OR MIT |
| toml | 1.1.8+spec-1.1.0 | MIT OR Apache-2.0 |
| toml_datetime | 1.1.2+spec-1.1.0 | MIT OR Apache-2.0 |
| toml_parser | 1.1.5+spec-1.1.0 | MIT OR Apache-2.0 |
| toml_writer | 1.1.3+spec-1.1.0 | MIT OR Apache-2.0 |
| uniffi_internal_macros | 0.32.2 | **MPL-2.0** |
| uniffi_macros | 0.32.2 | **MPL-2.0** |
| uniffi_meta | 0.32.2 | **MPL-2.0** |
| version_check | 0.9.5 | MIT/Apache-2.0 |
| wasm-bindgen-macro | 0.2.129 | MIT OR Apache-2.0 |
| wasm-bindgen-macro-support | 0.2.129 | MIT OR Apache-2.0 |
| winnow | 1.0.4 | MIT |
| zeroize_derive | 1.5.0 | Apache-2.0 OR MIT |

The binding generator (`core/swift/bindgen`, a tool of the build machine that writes the Swift file and the C header)
adds: anstyle 1.0.14 (MIT OR Apache-2.0), askama 0.16.1 (MIT OR Apache-2.0), askama_derive 0.16.1 (MIT OR Apache-2.0), askama_macros 0.16.1 (MIT OR Apache-2.0), askama_parser 0.16.1 (MIT OR Apache-2.0), basic-toml 0.1.10 (MIT OR Apache-2.0), clap 4.6.7 (MIT OR Apache-2.0), clap_builder 4.6.7 (MIT OR Apache-2.0), clap_derive 4.6.7 (MIT OR Apache-2.0), clap_lex 1.1.1 (MIT OR Apache-2.0), glob 0.3.4 (MIT OR Apache-2.0), goblin 0.8.2 (MIT), minimal-lexical 0.2.1 (MIT/Apache-2.0), nom 7.1.3 (MIT), plain 0.2.3 (MIT/Apache-2.0), rustc-hash 2.1.3 (Apache-2.0 OR MIT), scroll 0.12.0 (MIT), scroll_derive 0.12.1 (MIT), smawk 0.3.3 (MIT), strsim 0.11.1 (MIT), textwrap 0.16.4 (MIT), uniffi_bindgen 0.32.2 (MPL-2.0), uniffi_udl 0.32.2 (MPL-2.0), weedle2 5.0.0 (MIT).
