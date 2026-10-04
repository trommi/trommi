// index.mjs: the client core in one import. Browsers and Node alike; Node adds `./storage-file.mjs` itself
// (it needs node:fs and is not re-exported here). Contract: core/README.md.
export { foundRoom, openRoom, joinRoom, recoverRoom, roomLink, parseRoomLink, loginWithPassphrase, joinWithRecoveryCode } from './room.mjs'
// Accounts (email + password, Emergency Kit): import './account.mjs' directly (it carries Argon2 and the word list).
export { passphraseProblem, generatePassphrase, openEscrow, sealEscrowV2, openEscrowV2, escrowKeyAndId, ESCROW_ITERATIONS, ESCROW_V2_ITERATIONS } from './escrow.mjs'
export { Client, shareLink, parseShareLink, openShared, membersOf, isHumanRegisterKey, isAgentRegisterKey } from './client.mjs'
export { agentMethods } from './agent.mjs'
export { Hub, normaliseHubUrl } from './transport.mjs'
export * as codec from './codec.mjs'
export { emptyModel, emptyChange, timelineKey, parseTimelineKey, timelineItems, timelineEvents, stackOf, isExpired, answerRefusal } from './model.mjs'
export { memoryStorage } from './storage-memory.mjs'
export { idbStorage } from './storage-idb.mjs'
export * as z from './zcrypto.mjs'
