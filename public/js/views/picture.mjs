// Pictures in the views. The app has no thumbnail service (attachments are /att/<id>, decrypted in the page), so
// every picture keeps its own address and its own size.
//
//   html`<img${srcOf(a, 56)} alt="" loading="lazy" decoding="async" width="56" height="42">`
import { attrs } from './html.mjs'

/** file: an attachment record ({ url, width?, height? }) -> { src, srcset: '', width, height } (null when unknown). */
export function thumb(file) {
  const own = file?.width > 0 && file?.height > 0
  return { src: file?.url ?? '', srcset: '', width: own ? file.width : null, height: own ? file.height : null }
}

/** The src attribute of an <img> for that file (the shown width is the caller's; there are no variants). */
export const srcOf = file => attrs({ src: thumb(file).src })
