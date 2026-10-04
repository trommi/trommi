// In this repository the core uses crypto/session-grants.mjs. dev/sync-app.sh copies the real file over this one in
// the app's public/vendor/ (next to zcrypto.mjs, which it imports as './zcrypto.mjs'), so the import path is the same everywhere.
export * from '../../crypto/session-grants.mjs'
