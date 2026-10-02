# Speech worker log (live dictation, read aloud on every message)

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

## Round two: read aloud on every message (2 Oct 2026)

### What was found about the voice
- The hub's `speak()` sent no voice and no language. `qwen3-tts` reads German well that way: a German and an
  English sentence, spoken through the board (`POST /speech/say`) and transcribed back (`POST /speech/transcribe`),
  came back word for word, with and without a language named. About 1.5-2.7 s for 75-115 letters, MP3.
- The API takes a `language` ("German", "English") and it matters when the text is mixed: with the voice
  `serena` and no language, "Der Deploy ist fertig, der Pull Request wartet noch auf ein Review von dir" came back
  as "Their deploy is fetish, their pull request ..."; with `language: German` it came back right.
  So the page guesses the language of each piece (stop words and umlauts, `guessLanguage`) and the hub names it.
- Voices exist (`qwen3-tts`: aiden, dylan, eric, ono_anna, ryan, serena, sohee, uncle_fu, vivian, none of them
  German; `voxtral-tts` has `de_female`/`de_male`). `voxtral-tts` with `de_female` also came back word for word and
  was a little faster for German (1.0-1.6 s). Not switched to: the default voice is fine and one model is simpler.
  It can be set without code: `BOARD_TTS_VOICE`, and per language `BOARD_TTS_MODEL_DE`, `BOARD_TTS_VOICE_DE`,
  `BOARD_TTS_LANGUAGE_DE` (the same with `_EN`).

### What was built
- Server: `POST /speech/say {text, lang}` returns the sound (MP3, or WAV if the service sends that). `speak(text,
  instructions, lang)` names the language and keys its cache by model, voice and language. Tests in `server/test.mjs`
  with the fake service ("read aloud"). **The live hub needs a restart for the route.**
- Client, all in `js/speech.js` and `css/speech.css`. speech.js finds the messages on the page by itself (a
  MutationObserver; `.msg`, `.ask-open`, `.focus-card`), so neither chat.js nor focus.js mounts anything:
  - agent message: the speaker stands beside the time in its head; a follow-up without a head: at the end of its
    first line (or on a line of its own above a code block);
  - the human's own message: to the left of the bubble;
  - an open question in the conversation: after its age in the row's head; in the question window: at the end of the title;
  - the conversation in the question window uses the same `.msg` nodes, so it has the same controls.
- Quiet at rest (shown on hover or focus, always but pale where nothing hovers). One click reads, the control
  becomes a stop with a ring that closes as the message is read; another message takes over; Esc stops (and is
  swallowed, so the question window stays open). Shift+click, or a long press on touch, reads from here on.
- What is read: the rendered text of the message, not its source. Bold, code ticks, headings and bullets leave
  no trace; a code block is "Code block, 3 lines."; a link is its words, a bare address "link to github.com";
  a published page its title; a table row its cells; "Details:" and the details; pictures, files and the time
  are left out. A question: title, why it is urgent, text, then "The options: A, B or C." (German: "Zur Auswahl").
  German numbers are smoothed as before (48.210, 14:30).
- Pieces: the first up to 100 letters, the second up to 220, then 400, cut at sentence ends; the next two are
  fetched while one plays; 80 pieces are kept in the page, the hub keeps its files as before.
  First sound after 2-4 s (the service's time for the first piece).
- `readCard(cardId, button)` (the switch in the question window) now runs through the same pieces and cache.
  `GET /speech/card/ID` is still there for other clients.
- The chat composer of a session has the live microphone (`dictationMic`) in place of the old one.

### For the Keyboard worker
- `readAloud(node, { following })`: node is a `.msg`, an open question in the log (`.ask-open`), the card of the
  question window (`.focus-card`) or anything inside one. Starts; on the one being read it stops. Resolves at the end.
- `stopReading()`, `isReading()`, `spokenText(node)`, `guessLanguage(text)`.

### Verified (headless Chromium, demo board with the key, `dev/say-test.mjs PORT SESSION`)
- 1440x900 and 390x844, light and dark: click on an agent message, an own message, a question row, the title in
  the question window and a message of its conversation; the sound plays and moves on (progress grows);
  a click elsewhere takes over; the same click, Esc and `stopReading()` stop; Shift+click goes on to the next message.
- A board without a key: no controls, no microphone.
- Not verified: how it sounds (only that the words come back), a real phone, Safari/Firefox, the long press on a
  real touch screen, hover on a real pointer (headless Chromium reports no hover, so the controls showed as on touch).
