// CheckEmoji.swift: the check code as emoji (shared/check-emoji.mjs): the 64 Matrix SAS emoji, each with an English word.
// The index is the number in the code: never reorder. Generated from check-emoji.mjs; the tests compare with it.

public let CHECK_EMOJI: [(emoji: String, word: String)] = [
  ("🐶", "dog"),
  ("🐱", "cat"),
  ("🦁", "lion"),
  ("🐎", "horse"),
  ("🦄", "unicorn"),
  ("🐷", "pig"),
  ("🐘", "elephant"),
  ("🐰", "rabbit"),
  ("🐼", "panda"),
  ("🐓", "rooster"),
  ("🐧", "penguin"),
  ("🐢", "turtle"),
  ("🐟", "fish"),
  ("🐙", "octopus"),
  ("🦋", "butterfly"),
  ("🌷", "flower"),
  ("🌳", "tree"),
  ("🌵", "cactus"),
  ("🍄", "mushroom"),
  ("🌏", "globe"),
  ("🌙", "moon"),
  ("☁️", "cloud"),
  ("🔥", "fire"),
  ("🍌", "banana"),
  ("🍎", "apple"),
  ("🍓", "strawberry"),
  ("🌽", "corn"),
  ("🍕", "pizza"),
  ("🎂", "cake"),
  ("❤️", "heart"),
  ("😀", "smiley"),
  ("🤖", "robot"),
  ("🎩", "hat"),
  ("👓", "glasses"),
  ("🔧", "spanner"),
  ("🎅", "santa"),
  ("👍", "thumbs up"),
  ("☂️", "umbrella"),
  ("⌛", "hourglass"),
  ("⏰", "clock"),
  ("🎁", "gift"),
  ("💡", "light bulb"),
  ("📕", "book"),
  ("✏️", "pencil"),
  ("📎", "paperclip"),
  ("✂️", "scissors"),
  ("🔒", "lock"),
  ("🔑", "key"),
  ("🔨", "hammer"),
  ("☎️", "telephone"),
  ("🏁", "flag"),
  ("🚂", "train"),
  ("🚲", "bicycle"),
  ("✈️", "aeroplane"),
  ("🚀", "rocket"),
  ("🏆", "trophy"),
  ("⚽", "ball"),
  ("🎸", "guitar"),
  ("🎺", "trumpet"),
  ("🔔", "bell"),
  ("⚓", "anchor"),
  ("🎧", "headphones"),
  ("📁", "folder"),
  ("📌", "pin"),
]

/** "07-33-12-05-60-01" as [(emoji, word)]; [] for anything that is no check code. */
public func checkEmoji(_ code: String) -> [(emoji: String, word: String)] {
  let parts = code.split(separator: "-", omittingEmptySubsequences: false)
  if parts.count < 2 { return [] }
  var out = [(emoji: String, word: String)]()
  for p in parts {
    guard p.count == 2, p.allSatisfy({ $0.isASCII && $0.isNumber }), let n = Int(p), n < CHECK_EMOJI.count else { return [] }
    out.append(CHECK_EMOJI[n])
  }
  return out
}
/** One line for a terminal: emoji and word side by side. */
public func checkEmojiLine(_ code: String) -> String { checkEmoji(code).map { "\($0.emoji) \($0.word)" }.joined(separator: " · ") }
