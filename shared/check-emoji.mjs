// check-emoji.mjs: the check code as emoji. Both sides of an invite (the device or connector that joins, and the
// device that made the link) show the same six emoji with a word under each; the human compares them.
// The code itself comes from the crypto core (zcrypto.mjs, inviteCode): six numbers 0–63 = 36 bits. The table is the
// 64 emoji of the Matrix SAS list (distinct shapes, all in Unicode 6–9, so every current platform draws them), each
// with one English word for terminals that draw emoji badly. The index is the number in the code: never reorder.

export const CHECK_EMOJI = Object.freeze([
  ['🐶', 'dog'], ['🐱', 'cat'], ['🦁', 'lion'], ['🐎', 'horse'], ['🦄', 'unicorn'], ['🐷', 'pig'], ['🐘', 'elephant'], ['🐰', 'rabbit'],
  ['🐼', 'panda'], ['🐓', 'rooster'], ['🐧', 'penguin'], ['🐢', 'turtle'], ['🐟', 'fish'], ['🐙', 'octopus'], ['🦋', 'butterfly'], ['🌷', 'flower'],
  ['🌳', 'tree'], ['🌵', 'cactus'], ['🍄', 'mushroom'], ['🌏', 'globe'], ['🌙', 'moon'], ['☁️', 'cloud'], ['🔥', 'fire'], ['🍌', 'banana'],
  ['🍎', 'apple'], ['🍓', 'strawberry'], ['🌽', 'corn'], ['🍕', 'pizza'], ['🎂', 'cake'], ['❤️', 'heart'], ['😀', 'smiley'], ['🤖', 'robot'],
  ['🎩', 'hat'], ['👓', 'glasses'], ['🔧', 'spanner'], ['🎅', 'santa'], ['👍', 'thumbs up'], ['☂️', 'umbrella'], ['⌛', 'hourglass'], ['⏰', 'clock'],
  ['🎁', 'gift'], ['💡', 'light bulb'], ['📕', 'book'], ['✏️', 'pencil'], ['📎', 'paperclip'], ['✂️', 'scissors'], ['🔒', 'lock'], ['🔑', 'key'],
  ['🔨', 'hammer'], ['☎️', 'telephone'], ['🏁', 'flag'], ['🚂', 'train'], ['🚲', 'bicycle'], ['✈️', 'aeroplane'], ['🚀', 'rocket'], ['🏆', 'trophy'],
  ['⚽', 'ball'], ['🎸', 'guitar'], ['🎺', 'trumpet'], ['🔔', 'bell'], ['⚓', 'anchor'], ['🎧', 'headphones'], ['📁', 'folder'], ['📌', 'pin'],
].map(([emoji, word]) => Object.freeze({ emoji, word })))

/** The check code ("07-33-12-05-60-01") as [{ emoji, word }, …]; [] for anything that is no check code. */
export function checkEmoji(code) {
  const parts = String(code ?? '').split('-')
  if (parts.length < 2 || !parts.every(p => /^\d{2}$/.test(p) && Number(p) < CHECK_EMOJI.length)) return []
  return parts.map(p => CHECK_EMOJI[Number(p)])
}

/** One line for a terminal: emoji and word side by side ("🐶 dog · 🎂 cake · …"). */
export const checkEmojiLine = code => checkEmoji(code).map(e => `${e.emoji} ${e.word}`).join(' · ')
