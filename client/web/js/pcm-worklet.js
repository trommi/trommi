// The microphone as raw samples, for live dictation (see speech.js). Runs on the audio
// thread and hands the page about 40 ms of sound at a time.
class PcmTap extends AudioWorkletProcessor {
  constructor() {
    super()
    this.held = new Float32Array(2048)
    this.fill = 0
  }

  process(inputs) {
    const sound = inputs[0]?.[0]
    if (!sound) return true
    for (let i = 0; i < sound.length; i++) {
      this.held[this.fill++] = sound[i]
      if (this.fill === this.held.length) {
        this.port.postMessage(this.held.slice())
        this.fill = 0
      }
    }
    return true
  }
}

registerProcessor('pcm-tap', PcmTap)
