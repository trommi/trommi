// Live dictation into a text field, for the server-rendered board (docs/turbo.md): the words appear as one speaks,
// and the board's final reading replaces them at the end. The same way as the old client's js/speech.js (whose
// dictation part this is, without its page state): the microphone's sound goes to the hub in pieces
// (POST /speech/live/<id>), the words come back as events of POST /speech/live. The controller "dictate" uses it.
const RATE = 16000
const SEND_EVERY = 200        // ms of sound per request
let run = null                // the one dictation that is running

const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n }

export function paintButton(button, state) {
  if (state) button.dataset.rec = state
  else delete button.dataset.rec
  button.setAttribute('aria-pressed', String(Boolean(state)))
  const label = state === 'finishing' ? 'Finishing the text' : state ? 'Stop dictating (Esc)' : 'Dictate: speak, the words appear as you talk'
  button.setAttribute('aria-label', label)
  button.title = label
  if (!state) button.style.removeProperty('--level')
}
export const isDictating = () => Boolean(run)
export const dictatingInto = () => run?.target.field ?? null
/** Start dictating into field (button shows it), or stop the one that runs. */
export function toggleDictation(field, button, onError) {
  if (run) return stopDictation()
  return startDictation(field, button, onError)
}

export async function startDictation(field, button, onError = () => {}) {
  if (run) return
  const target = { field, button, onError }
  // Browsers only hand out the microphone on https or localhost.
  if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) {
    return target.onError(window.isSecureContext ? 'This browser cannot record.' : 'The microphone only works over https or localhost.')
  }
  const me = run = { target, state: 'starting', abort: new AbortController(), queue: [], queued: 0, id: null, head: '', tail: '', live: '', edited: false, level: 0 }
  paintButton(target.button, 'starting')
  window.addEventListener('keydown', onKey, true)
  try {
    me.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
  } catch (err) {
    cleanup(me)
    return target.onError(err?.name === 'NotFoundError' ? 'No microphone found.' : 'No access to the microphone. Allow it in the browser\'s settings for this page.')
  }
  if (run !== me || me.state !== 'starting') return me.stream.getTracks().forEach(t => t.stop())   // stopped while the browser asked
  try {
    me.ctx = new AudioContext()
    me.ctx.resume().catch(() => {})
    await me.ctx.audioWorklet.addModule('/js/pcm-worklet.js')
    const tap = new AudioWorkletNode(me.ctx, 'pcm-tap', { numberOfOutputs: 0 })
    const resample = resampler(me.ctx.sampleRate)
    tap.port.onmessage = e => heard(me, resample(e.data))
    me.ctx.createMediaStreamSource(me.stream).connect(tap)
  } catch {
    cleanup(me)
    return target.onError('This browser cannot record.')
  }
  if (run !== me || me.state !== 'starting') return
  me.state = 'listening'
  anchor(me)
  paintButton(me.target.button, 'listening')
  paintField(me)
  listen(me)
  me.pump = setInterval(() => pump(me), SEND_EVERY)
  me.frame = requestAnimationFrame(function level() {
    me.target.button.style.setProperty('--level', me.level.toFixed(3))
    me.frame = requestAnimationFrame(level)
  })
}

/** Stop speaking. The text stays; the board sends its final reading a moment later. */
export function stopDictation() {
  const me = run
  if (!me) return
  if (me.state === 'starting') return cleanup(me)
  if (me.state !== 'listening') return
  if (!me.id) return cleanup(me)   // the board had not answered yet: nothing was heard
  me.state = 'finishing'
  quiet(me)
  paintButton(me.target.button, 'finishing')
  // The last piece of sound, then the word that it is over.
  me.sending = (me.sending ?? Promise.resolve()).then(() => send(me)).then(() => me.id && fetch(`/speech/live/${me.id}/stop`, { method: 'POST' })).catch(() => {})
  me.patience = setTimeout(() => cleanup(me), 15000)
}

function onKey(e) {
  if (e.key !== 'Escape' || !run) return
  e.preventDefault()
  e.stopImmediatePropagation()
  if (run.state === 'finishing') cleanup(run)   // a second Esc does not wait for the final reading
  else stopDictation()
}

// Any rate the browser records at, down (or up) to 16 kHz by linear interpolation, across pieces.
function resampler(from) {
  const step = from / RATE
  let at = 0, last = 0
  return sound => {
    const out = new Float32Array(Math.ceil((sound.length - at) / step))
    let n = 0
    for (; at < sound.length; at += step) {
      const i = Math.floor(at), a = i > 0 ? sound[i - 1] : last, b = sound[i]
      out[n++] = a + (b - a) * (at - i)
    }
    at -= sound.length
    last = sound[sound.length - 1]
    return out.subarray(0, n)
  }
}

function heard(me, sound) {
  if (me.state !== 'listening') return
  const pcm = new Int16Array(sound.length)
  let sum = 0
  for (let i = 0; i < sound.length; i++) {
    const v = Math.max(-1, Math.min(1, sound[i]))
    pcm[i] = v * 32767
    sum += v * v
  }
  // Loudness on a scale the eye reads as calm: quick up, slow down.
  const now = Math.max(0, Math.min(1, (20 * Math.log10(Math.sqrt(sum / (sound.length || 1)) + 1e-6) + 55) / 40))
  me.level += (now - me.level) * (now > me.level ? .5 : .12)
  // What is spoken before the board answers waits here, up to ten seconds of it.
  if (me.queued > RATE * 10) return
  me.queue.push(pcm)
  me.queued += pcm.length
}

async function send(me) {
  if (!me.id || !me.queue.length) return
  const all = new Int16Array(me.queued)
  let at = 0
  for (const part of me.queue.splice(0)) { all.set(part, at); at += part.length }
  me.queued = 0
  const res = await fetch(`/speech/live/${me.id}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: all.buffer })
  if (!res.ok && res.status !== 404 && res.status !== 409) throw new Error((await res.json().catch(() => ({}))).error || res.statusText)
}

// One request at a time, so the sound arrives in order.
function pump(me) {
  if (me.busy || me.state !== 'listening') return
  if (!me.target.field.isConnected) return stopDictation()   // its field is gone (another card, the window closed)
  me.busy = true
  me.sending = send(me).catch(() => lost(me)).finally(() => { me.busy = false })
}

function lost(me) {
  if (run !== me) return
  cleanup(me)
  me.target.onError('Dictation stopped: the connection was lost. The text so far stays.')
}

// The words, as events from the board.
async function listen(me) {
  let ended = false
  try {
    const res = await fetch('/speech/live', { method: 'POST', signal: me.abort.signal })
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText)
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      for (let cut; (cut = buf.indexOf('\n\n')) >= 0;) {
        const [first, second = ''] = buf.slice(0, cut).split('\n')
        buf = buf.slice(cut + 2)
        const event = first.slice(7), data = JSON.parse(second.slice(6) || '{}')
        if (run !== me) return
        if (event === 'ready') me.id = data.id
        else if (event === 'delta') { me.live += data.text; paintField(me) }
        else if (event === 'final') {
          ended = true
          settle(me, data.text)
          cleanup(me)
          if (data.reason === 'limit') me.target.onError(`Dictation stops after ${Math.round(data.seconds / 60)} minutes. Tap the microphone to go on.`)
        } else if (event === 'error') {
          ended = true
          cleanup(me)
          me.target.onError(`Dictation stopped: ${data.message}`)
        }
      }
    }
    if (!ended) throw new Error('ended early')
  } catch (err) {
    if (run !== me) return
    cleanup(me)
    me.target.onError(/not set up|Too many|Speech service/.test(err.message) ? `No dictation: ${err.message}` : 'Dictation stopped: the connection was lost. The text so far stays.')
  }
}

// ---- the field while it is dictated into ----

const spoken = me => me.live.replace(/\s+/g, ' ').trim()
const glued = (me, words) => (words ? (me.head && !/\s$/.test(me.head) ? ' ' : '') + words + (me.tail && !/^\s/.test(me.tail) ? ' ' : '') : '')

// Where the words go: at the caret if the field has the focus, else at its end.
function anchor(me) {
  const { field } = me.target
  const focused = document.activeElement === field
  const start = focused ? field.selectionStart ?? field.value.length : field.value.length
  const end = focused ? field.selectionEnd ?? start : start
  me.head = field.value.slice(0, start)
  me.tail = field.value.slice(end)
  me.live = ''
  me.onInput = () => {
    if (me.writing) return
    // The human typed in the middle of it: what stands is theirs now, new words follow the caret.
    const caret = field.selectionStart ?? field.value.length
    me.head = field.value.slice(0, caret)
    me.tail = field.value.slice(caret)
    me.live = ''
    me.edited = true
    paintGhost(me)
  }
  field.addEventListener('input', me.onInput)
  field.classList.add('is-dictating')
  me.placeholder = field.placeholder
  field.placeholder = 'Listening …'
}

function write(me, middle) {
  const { field } = me.target
  const focused = document.activeElement === field
  me.writing = true
  field.value = me.head + middle + me.tail
  if (focused) { try { field.setSelectionRange(me.head.length + middle.length, me.head.length + middle.length) } catch {} }
  field.dispatchEvent(new Event('input', { bubbles: true }))
  me.writing = false
  // Keep the newest words in sight.
  if (!me.tail) { field.scrollLeft = field.scrollWidth; field.scrollTop = field.scrollHeight }
}

function paintField(me) {
  me.middle = glued(me, spoken(me))
  write(me, me.middle)
  paintGhost(me)
}

// The final reading replaces the provisional words, unless the human has typed in between.
function settle(me, text) {
  const final = String(text ?? '').trim()
  if (me.edited || !final) return
  write(me, glued(me, final))
}

// A field cannot colour part of its text. So while words are provisional, its own text is
// made invisible and the same text is drawn over it, the provisional words lighter.
function paintGhost(me) {
  const { field } = me.target
  if (!field.isConnected) return
  let ghost = me.ghost
  if (!ghost || !ghost.isConnected) {
    ghost = me.ghost = el('span', 'dictate-ghost')
    ghost.setAttribute('aria-hidden', 'true')
    ghost.append(el('span', 'dictate-ghost-text'))
    field.after(ghost)
    me.onScroll = () => { ghost.firstChild.style.translate = `${-field.scrollLeft}px ${-field.scrollTop}px` }
    field.addEventListener('scroll', me.onScroll)
  }
  const cs = getComputedStyle(field)
  const multi = field.tagName === 'TEXTAREA'
  Object.assign(ghost.style, {
    left: `${field.offsetLeft}px`, top: `${field.offsetTop}px`, width: `${field.offsetWidth}px`, height: `${field.offsetHeight}px`,
    padding: cs.padding, borderWidth: cs.borderWidth, font: cs.font, letterSpacing: cs.letterSpacing, textAlign: cs.textAlign,
    lineHeight: multi ? cs.lineHeight : `${field.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)}px`,
    whiteSpace: multi ? 'pre-wrap' : 'pre', borderRadius: cs.borderRadius,
  })
  const middle = me.middle ?? ''
  const live = el('span', 'dictate-live', middle)
  ghost.firstChild.replaceChildren(me.head, live, me.tail)
  me.onScroll()
}

function quiet(me) {
  clearInterval(me.pump)
  cancelAnimationFrame(me.frame)
  me.stream?.getTracks().forEach(t => t.stop())
  me.ctx?.close().catch(() => {})
  me.target.button.style.removeProperty('--level')
}

function cleanup(me) {
  if (run !== me) return
  run = null
  quiet(me)
  clearTimeout(me.patience)
  me.abort.abort()
  window.removeEventListener('keydown', onKey, true)
  const { field, button } = me.target
  if (me.onInput) field.removeEventListener('input', me.onInput)
  if (me.onScroll) field.removeEventListener('scroll', me.onScroll)
  field.classList.remove('is-dictating')
  if (me.placeholder != null) field.placeholder = me.placeholder
  me.ghost?.remove()
  paintButton(button, null)
}
