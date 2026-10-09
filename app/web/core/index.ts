// index.ts: the client core in one import. Browsers and Node alike; Node adds `./storage-file.ts` itself
// (it needs node:fs and is not re-exported here). Contract: core/README.md.
export { foundRoom, openRoom, joinRoom, recoverRoom, roomLink, parseRoomLink, joinWithRecoveryCode } from './room.ts'
// Accounts (email + password, Emergency Kit): import './account.ts' directly (it carries Argon2 and the word list).
export { Client, shareLink, parseShareLink, openShared, membersOf, isHumanRegisterKey, isAgentRegisterKey } from './client.ts'
export { agentMethods } from './agent.ts'
export { Hub, normaliseHubUrl } from './transport.ts'
export * as codec from './codec.ts'
export { emptyModel, emptyChange, timelineKey, parseTimelineKey, stackOf, answerRefusal, choicesFinal, linkState, cleanLink, heardBy, cardHeard, cardWaitsOn, ASLEEP_MS } from './model.ts'
export { memoryStorage } from './storage-memory.ts'
export { openRoomInTabs, adoptInTabs, overlayStorage } from './tabs.ts'
export { idbStorage } from './storage-idb.ts'
export * as z from './crypto/zcrypto.mjs'
export { CHECK_EMOJI, checkEmoji, checkEmojiLine } from './check-emoji.ts'
export { foldWork, isWork, workAnchor, WORK_ITEMS_MAX } from './work.ts'
