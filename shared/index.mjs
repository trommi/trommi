// index.mjs: the client core in one import. Browsers and Node alike; Node adds `./storage-file.mjs` itself
// (it needs node:fs and is not re-exported here). Contract: shared/README.md.
export { foundRoom, openRoom, joinRoom, recoverRoom, roomLink, parseRoomLink, joinWithRecoveryCode } from './room.mjs'
// Accounts (email + password, Emergency Kit): import './account.mjs' directly (it carries Argon2 and the word list).
export { Client, shareLink, parseShareLink, openShared, membersOf, isHumanRegisterKey, isAgentRegisterKey } from './client.mjs'
export { agentMethods } from './agent.mjs'
export { Hub, normaliseHubUrl } from './transport.mjs'
export * as codec from './codec.mjs'
export { emptyModel, emptyChange, timelineKey, parseTimelineKey, timelineItems, timelineEvents, stackOf, isExpired, answerRefusal, choicesFinal, linkState, cleanLink, heardBy, cardHeard, cardWaitsOn, ASLEEP_MS } from './model.mjs'
export { memoryStorage } from './storage-memory.mjs'
export { openRoomInTabs, adoptInTabs, overlayStorage } from './tabs.mjs'
export { idbStorage } from './storage-idb.mjs'
export * as z from './crypto/zcrypto.mjs'
export { CHECK_EMOJI, checkEmoji, checkEmojiLine } from './check-emoji.mjs'
