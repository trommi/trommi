// palette.mjs: the Scribble Board's colours as tokens (README "Scribble strokes"). A stroke and a note carry a token
// name, never a colour value, so every client paints it in its own light and dark look: the web app here, the iOS app
// with the same table (UIColor(light:dark:) per token). One place for these values; they move to shared/visuals later.
//
//   PALETTE[token] = { pen: [light, dark], marker?: [light, dark] }   sRGB hex
//   pen    the pen's ink and a note's text colour
//   marker the marker's (highlighter's) colour, painted at MARKER_OPACITY (multiplied on light paper)
// An unknown token is painted as the tool's first colour (ink, yellow): a newer client may add tokens.

export const PALETTE = Object.freeze({
  ink: Object.freeze({ pen: ['#1b1f23', '#e9eeea'] }),
  red: Object.freeze({ pen: ['#e03131', '#ff6b6b'], marker: ['#ff8787', '#ff8787'] }),
  orange: Object.freeze({ pen: ['#f08c00', '#ffa94d'], marker: ['#ffa94d', '#ffa94d'] }),
  yellow: Object.freeze({ pen: ['#e8b400', '#ffd43b'], marker: ['#ffd43b', '#ffd43b'] }),
  green: Object.freeze({ pen: ['#2f9e44', '#51cf66'], marker: ['#69db7c', '#69db7c'] }),
  blue: Object.freeze({ pen: ['#1971c2', '#4dabf7'], marker: ['#66c2ff', '#66c2ff'] }),
  violet: Object.freeze({ pen: ['#9c36b5', '#cc5de8'], marker: ['#b197fc', '#b197fc'] }),
  pink: Object.freeze({ pen: ['#d6336c', '#f783ac'], marker: ['#ff8cc6', '#ff8cc6'] }),
})

/** The colours each tool offers, in the order of the picker. */
export const PEN_COLORS = Object.freeze(['ink', 'red', 'orange', 'green', 'blue', 'violet'])
export const MARKER_COLORS = Object.freeze(['yellow', 'green', 'pink', 'blue', 'orange'])
/** The marker's opacity on light and on dark paper (on light paper it is multiplied, as a felt marker on paper). */
export const MARKER_OPACITY = Object.freeze({ light: 0.5, dark: 0.38 })

/** A token's colour for a tool ('pen', 'marker'; a note's text is 'pen') on light or dark paper. */
export function colorOf(token, tool = 'pen', dark = false) {
  const set = tool === 'marker' ? 'marker' : 'pen'
  const c = PALETTE[token]?.[set] ?? PALETTE[set === 'marker' ? MARKER_COLORS[0] : PEN_COLORS[0]][set]
  return c[dark ? 1 : 0]
}
/** Is this a token of this palette? (Encoders refuse anything else; decoders paint it with the fallback.) */
export const isToken = token => typeof token === 'string' && Object.hasOwn(PALETTE, token)
