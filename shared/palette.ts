// palette.ts: the Scribble Board's colours as tokens (README "Scribble strokes"). A stroke and a note carry a token
// name, never a colour value, so every client paints it in its own light and dark look: the web app here, the iOS app
// with the same table (UIColor(light:dark:) per token). One place for these values; they move to shared/visuals later.
//
//   PALETTE[token] = { pen: [light, dark], marker?: [light, dark] }   sRGB hex
//   pen    the pen's ink and a note's text colour
//   marker the marker's (highlighter's) colour, painted at MARKER_OPACITY (multiplied on light paper)
// An unknown token is painted as the tool's first colour (ink, yellow): a newer client may add tokens.

/** A colour as sRGB hex, in its light and its dark look. */
export type Pair = readonly [light: string, dark: string]
export interface Swatch { readonly pen: Pair; readonly marker?: Pair }
export type Tool = 'pen' | 'marker'

export const PALETTE: Readonly<Record<string, Swatch>> = Object.freeze({
  ink: Object.freeze({ pen: ['#1b1f23', '#e9eeea'] as const }),
  red: Object.freeze({ pen: ['#e03131', '#ff6b6b'] as const, marker: ['#ff8787', '#ff8787'] as const }),
  orange: Object.freeze({ pen: ['#f08c00', '#ffa94d'] as const, marker: ['#ffa94d', '#ffa94d'] as const }),
  yellow: Object.freeze({ pen: ['#e8b400', '#ffd43b'] as const, marker: ['#ffd43b', '#ffd43b'] as const }),
  green: Object.freeze({ pen: ['#2f9e44', '#51cf66'] as const, marker: ['#69db7c', '#69db7c'] as const }),
  blue: Object.freeze({ pen: ['#1971c2', '#4dabf7'] as const, marker: ['#66c2ff', '#66c2ff'] as const }),
  violet: Object.freeze({ pen: ['#9c36b5', '#cc5de8'] as const, marker: ['#b197fc', '#b197fc'] as const }),
  pink: Object.freeze({ pen: ['#d6336c', '#f783ac'] as const, marker: ['#ff8cc6', '#ff8cc6'] as const }),
})

/** The colours each tool offers, in the order of the picker. */
export const PEN_COLORS: readonly string[] = Object.freeze(['ink', 'red', 'orange', 'green', 'blue', 'violet'])
export const MARKER_COLORS: readonly string[] = Object.freeze(['yellow', 'green', 'pink', 'blue', 'orange'])
/** The marker's opacity on light and on dark paper (on light paper it is multiplied, as a felt marker on paper). */
export const MARKER_OPACITY = Object.freeze({ light: 0.5, dark: 0.38 })

/** A token's colour for a tool ('pen', 'marker'; a note's text is 'pen') on light or dark paper. */
export function colorOf(token: string, tool: Tool | string = 'pen', dark = false): string {
  const set: Tool = tool === 'marker' ? 'marker' : 'pen'
  const c = PALETTE[token]?.[set] ?? PALETTE[set === 'marker' ? 'yellow' : 'ink']![set]!
  return c[dark ? 1 : 0]
}
/** Is this a token of this palette? (Encoders refuse anything else; decoders paint it with the fallback.) */
export const isToken = (token: unknown): token is string => typeof token === 'string' && Object.hasOwn(PALETTE, token)
