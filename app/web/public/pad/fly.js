// The swoosh: a cut-out piece of the paper lifts off, flies in an arc to a session's mark and is
// swallowed there. Used by the pad itself (to a row of its chooser) and by the board around it
// (js/padlink.js, to a strip of session marks at the edge), so both look the same.
//
//   await flySheet(layer, { png, rect: { x, y, w, h }, target: node })
//
// layer: a positioned element that covers the screen; rect and the target's box are in its
// coordinates (both are full-screen layers, so: viewport coordinates). About 650 ms; with
// reduced motion the sheet fades where it is and the mark blinks once.

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches
const done = anim => anim.finished.catch(() => {})

/** The mark takes it in: a small bounce (or one blink). */
export function gulp(target) {
  if (!target?.animate) return Promise.resolve()
  if (reduced()) return done(target.animate([{ opacity: 1 }, { opacity: 0.25 }, { opacity: 1 }], { duration: 320 }))
  return done(target.animate(
    [{ scale: '1' }, { scale: '1.32', offset: 0.3 }, { scale: '0.9', offset: 0.62 }, { scale: '1.06', offset: 0.82 }, { scale: '1' }],
    { duration: 380, easing: 'ease-out' },
  ))
}

export async function flySheet(layer, { png, rect, target }) {
  const sheet = document.createElement('div')
  Object.assign(sheet.style, {
    position: 'absolute', left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px`,
    background: `#fff url("${png}") center / 100% 100% no-repeat`, borderRadius: '2px', pointerEvents: 'none',
    transformOrigin: '50% 50%', willChange: 'transform, opacity', zIndex: '9',
  })
  layer.append(sheet)
  try {
    if (reduced()) {
      await done(sheet.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 260, easing: 'ease-out' }))
      sheet.remove()
      return gulp(target)
    }
    // The snip: the piece comes loose, tilts a little and casts a shadow.
    const lift = 'translate(0px, -6px) rotate(-2.5deg) scale(1.03)'
    const shadowUp = '0 0 0 1px rgb(20 30 25 / .18), 0 18px 36px -10px rgb(20 30 25 / .45)'
    await done(sheet.animate(
      [{ transform: 'none', boxShadow: '0 0 0 1.5px rgb(20 30 25 / .5)' }, { transform: lift, boxShadow: shadowUp }],
      { duration: 170, easing: 'cubic-bezier(.2, .9, .3, 1.3)', fill: 'forwards' },
    ))
    // The flight: an arc to the middle of the mark, shrinking to its size.
    const to = target.getBoundingClientRect(), base = layer.getBoundingClientRect()
    const dx = to.left - base.left + to.width / 2 - (rect.x + rect.w / 2)
    const dy = to.top - base.top + to.height / 2 - (rect.y + rect.h / 2)
    const end = Math.max(0.04, Math.min(1, (Math.min(to.width, to.height) * 0.9) / Math.max(rect.w, rect.h)))
    const rise = Math.min(160, 40 + Math.hypot(dx, dy) * 0.22)   // how far the arc bows upward
    const N = 14, frames = []
    for (let i = 0; i <= N; i++) {
      const t = i / N, k = t * t * (3 - 2 * t)            // slow out of the paper, quick into the mark
      const x = dx * k, y = dy * k - rise * Math.sin(Math.PI * k) - 6 * (1 - k)
      const s = 1.03 + (end - 1.03) * k ** 1.4
      frames.push({ transform: `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) rotate(${(-2.5 - 14 * Math.sin(Math.PI * k)).toFixed(1)}deg) scale(${s.toFixed(3)})`, boxShadow: shadowUp, opacity: 1, offset: t })
    }
    await done(sheet.animate(frames, { duration: 430, easing: 'cubic-bezier(.45, 0, .7, .6)', fill: 'forwards' }))
    const bounce = gulp(target)
    await done(sheet.animate([{ opacity: 1 }, { opacity: 0, transform: `${frames.at(-1).transform} scale(.2)` }], { duration: 90, easing: 'ease-in', fill: 'forwards' }))
    sheet.remove()
    await bounce
  } finally {
    sheet.remove()
  }
}
