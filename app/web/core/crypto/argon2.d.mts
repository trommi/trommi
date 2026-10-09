// argon2.d.mts: the TypeScript view of argon2.mjs (hash-wasm's Argon2id, vendored as it is).
export function argon2id(opts: { password: Uint8Array | string; salt: Uint8Array; iterations: number; parallelism: number; memorySize: number; hashLength: number; outputType: 'binary' }): Promise<Uint8Array<ArrayBuffer>>
