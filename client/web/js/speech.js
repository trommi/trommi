// Voice in both directions: dictate into a text field, and have a card read out.

import { transcribe, cardAudioUrl } from './store.js'

// ---- read aloud ------------------------------------------------------------

let player = null     // the one Audio element; only one card speaks at a time
let speaking = null   // { cardId, button }

function stopSpeaking() {
  if (!speaking) return
  player.pause()
  speaking.button?.removeAttribute('data-speaking')
  speaking = null
}

/** Read a card aloud, or stop if it is the one being read. The button, if given,
 *  gets data-speaking="loading" | "playing" while it runs. Resolves when playback ends. */
export function readCard(cardId, button) {
  const same = speaking?.cardId === cardId
  stopSpeaking()
  if (same) return Promise.resolve()
  player ??= new Audio()
  speaking = { cardId, button }
  button?.setAttribute('data-speaking', 'loading')
  player.src = cardAudioUrl(cardId)
  return new Promise(resolve => {
    const done = () => {
      if (speaking?.cardId === cardId) stopSpeaking()
      resolve()
    }
    player.onplaying = () => button?.setAttribute('data-speaking', 'playing')
    player.onended = done
    player.onerror = done
    player.play().catch(done)
  })
}

export const stopReading = stopSpeaking
export const readingCard = () => speaking?.cardId ?? null

// ---- dictation -------------------------------------------------------------

/** Turn a button into a microphone for a textarea or input: first tap records,
 *  second tap stops and inserts the transcript at the cursor.
 *  onError(message) is called with readable German text. */
export function mountDictation(button, field, { onError = () => {} } = {}) {
  let recorder = null
  let stream = null

  const setState = state => {
    if (state) button.dataset.rec = state
    else delete button.dataset.rec
    button.setAttribute('aria-pressed', String(state === 'recording'))
    button.setAttribute('aria-label', state === 'recording' ? 'Aufnahme beenden' : 'Nachricht diktieren')
  }

  function insert(text) {
    if (!text) return
    const start = field.selectionStart ?? field.value.length
    const end = field.selectionEnd ?? field.value.length
    const before = field.value.slice(0, start)
    const glue = before && !/\s$/.test(before) ? ' ' : ''
    field.value = before + glue + text + field.value.slice(end)
    const caret = (before + glue + text).length
    field.setSelectionRange?.(caret, caret)
    field.dispatchEvent(new Event('input', { bubbles: true }))
    field.focus()
  }

  async function begin() {
    // Browsers only hand out the microphone on https or localhost.
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      return onError(window.isSecureContext
        ? 'Dieser Browser kann nicht aufnehmen.'
        : 'Das Mikrofon geht nur über HTTPS oder localhost. Öffne die Seite über eine https-Adresse.')
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      return onError('Kein Zugriff auf das Mikrofon. Erlaube ihn in den Browser-Einstellungen.')
    }
    const chunks = []
    recorder = new MediaRecorder(stream)
    recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data) }
    recorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop())
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })
      recorder = null
      if (!blob.size) return setState(null)
      setState('working')
      try {
        insert(await transcribe(blob))
      } catch (err) {
        onError(`Nicht erkannt: ${err.message}`)
      }
      setState(null)
    }
    recorder.start()
    setState('recording')
  }

  button.addEventListener('click', () => {
    if (button.dataset.rec === 'working') return
    if (recorder) recorder.stop()
    else begin()
  })
  setState(null)
}
