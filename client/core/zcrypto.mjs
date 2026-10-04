// In this repository the core uses the one crypto library at crypto/zcrypto.mjs.
// dev/sync-app.sh copies the real file over this one in the app's public/vendor/, so the import path is the same everywhere.
export * from '../../crypto/zcrypto.mjs'
