//! check-emoji.mjs: the check code as emoji with a word under each (the Matrix SAS list). Never reorder.
pub const CHECK_EMOJI: [(&str, &str); 64] = [
    ("🐶", "dog"), ("🐱", "cat"), ("🦁", "lion"), ("🐎", "horse"), ("🦄", "unicorn"), ("🐷", "pig"), ("🐘", "elephant"), ("🐰", "rabbit"),
    ("🐼", "panda"), ("🐓", "rooster"), ("🐧", "penguin"), ("🐢", "turtle"), ("🐟", "fish"), ("🐙", "octopus"), ("🦋", "butterfly"), ("🌷", "flower"),
    ("🌳", "tree"), ("🌵", "cactus"), ("🍄", "mushroom"), ("🌏", "globe"), ("🌙", "moon"), ("☁️", "cloud"), ("🔥", "fire"), ("🍌", "banana"),
    ("🍎", "apple"), ("🍓", "strawberry"), ("🌽", "corn"), ("🍕", "pizza"), ("🎂", "cake"), ("❤️", "heart"), ("😀", "smiley"), ("🤖", "robot"),
    ("🎩", "hat"), ("👓", "glasses"), ("🔧", "spanner"), ("🎅", "santa"), ("👍", "thumbs up"), ("☂️", "umbrella"), ("⌛", "hourglass"), ("⏰", "clock"),
    ("🎁", "gift"), ("💡", "light bulb"), ("📕", "book"), ("✏️", "pencil"), ("📎", "paperclip"), ("✂️", "scissors"), ("🔒", "lock"), ("🔑", "key"),
    ("🔨", "hammer"), ("☎️", "telephone"), ("🏁", "flag"), ("🚂", "train"), ("🚲", "bicycle"), ("✈️", "aeroplane"), ("🚀", "rocket"), ("🏆", "trophy"),
    ("⚽", "ball"), ("🎸", "guitar"), ("🎺", "trumpet"), ("🔔", "bell"), ("⚓", "anchor"), ("🎧", "headphones"), ("📁", "folder"), ("📌", "pin"),
];

/// The check code ("07-33-12-05-60-01") as [(emoji, word)]; [] for anything that is no check code.
pub fn check_emoji(code: &str) -> Vec<(&'static str, &'static str)> {
    let parts: Vec<&str> = code.split('-').collect();
    if parts.len() < 2 || !parts.iter().all(|p| p.len() == 2 && p.bytes().all(|c| c.is_ascii_digit()) && p.parse::<usize>().unwrap() < 64) {
        return vec![];
    }
    parts.iter().map(|p| CHECK_EMOJI[p.parse::<usize>().unwrap()]).collect()
}
