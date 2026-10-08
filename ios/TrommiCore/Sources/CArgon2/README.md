Vendored: the Argon2 reference implementation (https://github.com/P-H-C/phc-winner-argon2, tag 20190702,
archive sha256 daf972a89577f8772602bf2eb38b6a3dd3d922bf5724d45e7f9589b5e830442c), CC0 1.0 or Apache 2.0 (LICENSE).
Files copied unchanged: include/argon2.h, src/{argon2,core,encoding,ref,thread}.c and their headers, src/blake2/
(blake2b.c, blake2.h, blake2-impl.h, blamka-round-ref.h). Portable reference code (ref.c, no SSE), built single-threaded
(ARGON2_NO_THREADS). Checked against RFC 9106 and against the app's hash-wasm Argon2id in the TrommiCore tests.
