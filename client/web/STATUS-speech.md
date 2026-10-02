# Speech worker log (live dictation in the question window)

Nothing here is committed by the worker. Newest at the bottom.

## What was found (2 Oct 2026)
- Tinfoil speech-to-text models today: `whisper-large-v3-turbo` (file upload), `voxtral-small-24b` (file upload),
  `voxtral-mini-4b-realtime` (streaming). Source: docs.tinfoil.sh/models/audio.md and guides/processing-audio.md,
  and `GET /v1/models` with the board's key lists all three.
- `voxtral-mini-4b-realtime` truly streams: WebSocket `wss://inference.tinfoil.sh/v1/realtime?intent=transcription`
  (OpenAI Realtime transcription dialect), PCM16 mono base64 in `input_audio_buffer.append`, words back as
  `conversation.item.input_audio_transcription.delta`, `input_audio_buffer.commit` ends the utterance and
  `...completed` carries the transcript. Append-only, never revised. No server-side silence detection (push to talk).
  Verified with a real call: 24-28 delta events per 8-9 s clip, spread over the time the audio was sent.
- The "native" mode (`?model=...`) gave no events with my guess at its messages; not used.
- Quality: the realtime model misheard the start of German clips ("Bitten in die zweite" for "Bitte nimm die zweite",
  "Beta-Option" for "bitte Option"); Whisper and voxtral-small got all three clips right (0.5-1.7 s per clip).
  German, English and mixed in one sentence all work in both.

## What was built
- Server (`server/server.mjs`): `POST /speech/live` (event stream: ready, delta, final, error),
  `POST /speech/live/ID` (PCM16 16 kHz mono, raw), `POST /speech/live/ID/stop`. The hub holds the socket to Tinfoil.
  On stop the whole recording also goes through the file model (`whisper-large-v3-turbo`) and that text is the final one
  (`polished: true`); if that fails the streamed text stands. Limits: 180 s per dictation, 2 MB per piece, 4 at once,
  15 s without audio ends it, 10 s to open/finish. Env: `BOARD_STT_LIVE_MODEL`, `BOARD_STT_LIVE_POLISH=off`,
  `BOARD_STT_LIVE_SECONDS`, `BOARD_STT_LIVE_IDLE_MS`, `BOARD_STT_LIVE_WAIT_MS`.
- Client: `js/speech.js` (`dictationMic`, `micInField`, `toggleDictation`, `startDictation`, `stopDictation`,
  `isDictating`), `js/pcm-worklet.js`, `css/speech.css`. Provisional words are drawn lighter over the field
  (a field cannot colour part of its text); the final reading replaces them unless the human typed meanwhile.
- Mounted on: the composer of the question window (`.focus-ask-field`, the one field that is both the question
  back and the note), between field and send button. The old separate note field no longer exists.
- Shared files touched: `focus.js` (import line; one line after `ask.append(askOpen, field, send)`;
  `stopDictation()` in `close()`), `ui.js` (a `mic` entry in `SKETCH`), `index.html` (stylesheet link).
- Tests: `server/test.mjs` with a local fake of the socket and the file model (no key). `dev/speech-test.mjs` drives
  the whole thing in headless Chromium with a WAV file as microphone (needs a board with a key).

## Measured (real key, through the board server)
- Server path, clips sent at speaking pace: first word after 1.15-1.64 s, final text 0.9-1.9 s after stop.
- Browser (fake microphone): first words in the field 1.3-2.2 s after the tap (includes opening the microphone),
  final text 1.4-1.5 s after Esc.

## Open
- The live hub on 8790 runs old code: the routes exist only after a restart.
- Hold-a-key-to-talk is for the Keyboard worker to bind: `startDictation()` on keydown, `stopDictation()` on keyup,
  or `toggleDictation()` for a tap.
- Not tried on a real phone or in Safari/Firefox (AudioWorklet and `-webkit-text-fill-color` are supported there on paper).
- The chat composer of a session still uses the old record-then-transcribe microphone (`mountDictation`).
