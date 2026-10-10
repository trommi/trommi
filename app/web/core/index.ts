// index.ts: the client core in one import, for a page that runs it without the worker and for the views' helpers
// (the build gives it to the views as gen/vendor/index.mjs). Contract: README.md. Everything here is protocol v1;
// the core itself (core-wasm.ts) is loaded only when a function needs it.
import { openShared as openSharedWith } from './client.ts'
import type { Hub } from './hub.ts'

export { foundRoom, openRoom, joinRoom, joinWithCode, roomLink, parseRoomLink } from './room.ts'
// Accounts (e-mail and password, passkeys, the Emergency Kit): './account-remote.ts' for a page, './account.ts' in the worker.
export { Client, ClientError, parseShareLink, isHumanRegisterKey, isAgentRegisterKey } from './client.ts'
export { Hub, HubError, hubAddress } from './hub.ts'
export * as codec from './codec.ts'
export { emptyModel, emptyChange, timelineKey, parseTimelineKey, stackOf, choicesFinal, linkState, cleanLink, heardBy, cardHeard, cardWaitsOn, ASLEEP_MS } from './model.ts'
export { openRoomInTabs, adoptInTabs } from './tabs.ts'
export { CHECK_EMOJI, checkEmoji, checkEmojiLine } from './check-emoji.ts'
export { foldWork, isWork, workAnchor, WORK_ITEMS_MAX } from './work.ts'

/** The shared file's bytes for whoever holds a Share link (the viewer page `/artifact/<share id>`): no room, no sign-in. */
export async function openShared(hub: Hub, link: string): Promise<Uint8Array> {
  const { loadCore } = await import('./core-wasm.ts')
  return openSharedWith(await loadCore(), hub, link)
}
