/**
 * Microphone audio as 16 kHz mono PCM, in 20 ms frames (320 samples).
 *
 * Runs on the audio rendering thread, so it keeps going whether or not the
 * window is visible — which requestAnimationFrame, the old clock for voice
 * detection, does not. If the AudioContext is not already at 16 kHz the input
 * is decimated here: each output sample is the average of the input samples it
 * covers, a box filter that is crude but plenty for speech recognition.
 */
const RATE = 16000
const FRAME = 320

class VasPcmCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.ratio = sampleRate / RATE
    this.frame = new Float32Array(FRAME)
    this.n = 0
    this.acc = 0
    this.count = 0
    this.t = 0
  }

  push(s) {
    this.frame[this.n++] = s
    if (this.n === FRAME) {
      this.port.postMessage(this.frame, [this.frame.buffer])
      this.frame = new Float32Array(FRAME)
      this.n = 0
    }
  }

  process(inputs) {
    const input = inputs[0]
    const ch = input && input[0]
    if (!ch) return true
    if (this.ratio === 1) {
      for (let i = 0; i < ch.length; i++) this.push(ch[i])
      return true
    }
    for (let i = 0; i < ch.length; i++) {
      this.acc += ch[i]
      this.count++
      this.t += 1
      if (this.t >= this.ratio) {
        this.push(this.acc / this.count)
        this.acc = 0
        this.count = 0
        this.t -= this.ratio
      }
    }
    return true
  }
}

registerProcessor('vas-pcm-capture', VasPcmCapture)
