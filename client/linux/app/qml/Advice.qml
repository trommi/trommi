// The mark of the agent's advice: a swipe of a highlighter behind the words
// of the option it would pick, one pass per line, a little uneven. Put it
// into the Text it marks; it lies behind the words and never on them.
import QtQuick

Scribble {
    id: mark
    property Item words: parent          // the Text whose words it lies behind
    property bool filled: false          // the tile is filled with colour: a pale band would vanish on it
    property color tint: ui.urgNormal    // that tile's colour
    readonly property var swipe: visible ? board.adviceMark(words.contentWidth, words.contentHeight, words.lineCount) : ({})

    z: -1
    x: words.horizontalAlignment === Text.AlignHCenter ? (words.width - words.contentWidth) / 2 : 0
    y: (words.height - words.contentHeight) / 2
    width: Math.max(1, words.contentWidth)
    height: Math.max(1, words.contentHeight)
    box: width
    boxHeight: height
    rotation: 0
    flat: true
    path: swipe.path || ""
    pen: swipe.pen || 0
    color: filled ? ui.mix(tint, theme.dark ? Qt.color("white") : Qt.color("black"), theme.dark ? 0.55 : 0.40) : ui.urgHigh
    opacity: filled ? (theme.dark ? 0.55 : 0.5) : (theme.dark ? 0.34 : 0.26)
}
