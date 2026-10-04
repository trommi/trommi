// Pictures in the views: a stored picture at the size it is shown, not at the size it was made
// (server/thumbs.mjs, docs/turbo.md "Thumbnails").
//
//   html`<img${srcOf(a, 56)} alt="" loading="lazy" decoding="async" width="56" height="42">`
//
// width is the width the picture is shown at, in CSS pixels. The helper picks the allowed variant for a
// plain and for a dense screen (srcset 1x/2x). A file that is no stored picture, or whose size is not known,
// keeps its own address; so does one that is asked for larger than the largest variant.
import { attrs } from './html.mjs'
import { WIDTHS, sizeOfUrl } from '../app/node-stubs/thumbs.mjs'

const LARGEST = WIDTHS[WIDTHS.length - 1]

/**
 * file: an attachment record ({ url, width?, height? }); width: the shown width in CSS pixels.
 * -> { src, srcset, width, height }: srcset is '' when one address serves both densities; width and height
 * are the picture's size at that shown width (ratio kept, never above its own size), null when unknown.
 */
export function thumb(file, width) {
  const url = file?.url ?? ''
  const own = file?.width > 0 && file?.height > 0 ? { width: file.width, height: file.height, type: file.type } : sizeOfUrl(url)
  if (!own || /\.gif$/i.test(url) ||!url.startsWith('/files/') || !(width > 0)) return { src: url, srcset: '', width: own?.width ?? null, height: own?.height ?? null }
  // The smallest variant that covers what is needed. Beyond the largest: the variant if it is the whole
  // picture anyway (it is only smaller in bytes), else the original.
  const at = need => { const w = WIDTHS.find(w => w >= need); return w || own.width <= LARGEST ? `${url}?w=${w ?? LARGEST}` : url }
  const src = at(width), dense = at(width * 2)
  const shown = Math.min(width, own.width)
  return { src, srcset: dense === src ? '' : `${src} 1x, ${dense} 2x`, width: shown, height: Math.max(1, Math.round(shown * own.height / own.width)) }
}

/** The src (and srcset) attributes of an <img> for that file at that shown width. */
export function srcOf(file, width) {
  const t = thumb(file, width)
  return attrs({ src: t.src, srcset: t.srcset || null })
}
