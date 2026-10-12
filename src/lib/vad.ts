import { getMic } from './audio'
import { encodeWav } from './wav'

/**
 * Voice-activity detection and segment capture.
 *
 * This is the piece that makes the assistant reliable, and it exists because
 * the browser's SpeechRecognition does not. That API dies silently under
 * always-on use — Chrome throttles it, it stops firing events, and nothing you
 * can catch tells you it has gone deaf. Detecting that a human is speaking is
 * not a language problem, though; it is an energy problem, and energy on the
 * microphone signal is something we can measure ourselves, every frame, with no
 * black box that can quietly stop answering.
 *
 * So: a running-mean noise floor, a threshold above it, and a hysteresis gate.
 * When the signal crosses the threshold a segment starts (with a little audio
 * from just before, so the first syllable is not clipped); when it falls quiet
 * for long enough the segment ends and is handed back as one 16 kHz WAV for
 * the bridge to transcribe.
 *
 * The clock is the audio itself: an AudioWorklet delivers 20 ms frames on the
 * audio thread, and every decision below happens per frame. It used to run on
 * requestAnimationFrame, which stops when the window is hidden — so an
 * assistant living in the tray went deaf the moment it was out of sight. The detection is instant and local
 * — that is what makes barge-in feel natural — and the words come back a moment
 * later from a real transcriber that cannot silently fail the way the browser
 * one did.
 *
 * Hearing himself is the one hard part. The microphone picks up JARVIS's own
 * voice through the speakers, and raw energy cannot tell that from the user.
 * Two things handle it: getUserMedia is asked for echo cancellation, which
 * removes most of the playback, and while he is speaking the trigger threshold
 * is raised so the residue that leaks through does not cross it. A text check
 * after transcription is the final backstop, in voice.ts.
 */

export type VadHandlers = {
  /** The signal crossed into speech. Instant; this is the barge-in trigger. */
  onStart: () => void
  /** Speech ended. The blob is one complete, decodable audio file. */
  onEnd: (audio: Blob, ms: number) => void
  /** 0..1 smoothed input level, for the caption/orb while capturing. */
  onLevel: (v: number) => void
  /** Capture is impossible — no microphone, or no audio worklet support. */
  onError: (message: string) => void
}

export type Vad = {
  stop: () => void
  /** Raise the trigger bar while JARVIS speaks, so his own playback leaking
   *  past echo cancellation does not register as the user talking. */
  setGuard: (on: boolean) => void
  live: () => boolean
  /** Live internals, for the diagnostics panel. */
  meter: () => { energy: number; floor: number; threshold: number; speaking: boolean }
}

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** How far above the noise floor the signal must rise to count as speech.
 *  The floor tracks the room, so this is a ratio, not an absolute level. */
const TRIGGER_OVER_FLOOR = 2.6
/** While he is speaking, demand this much more, so residual echo is ignored. */
const GUARD_BOOST = 2.4
/** Falling back below trigger×this ends the segment. Hysteresis stops a single
 *  dip mid-word from cutting a sentence in half. */
const RELEASE_RATIO = 0.6

/** Sustained energy for this long confirms speech rather than a knock or click. */
const START_MS = 110
/**
 * Quiet for this long ends the SEGMENT — which is no longer the same thing as
 * ending the turn.
 *
 * It used to be both, which is why this number was impossible to set: long
 * enough not to clip someone thinking mid-sentence meant every completed
 * question also sat waiting for nothing. Deciding whether the thought is
 * actually finished now happens a layer up, on the words rather than the
 * energy (see makeAssembler in assembler.ts), so this can go back to being what it
 * should always have been — a cheap "have they stopped making noise" — and the
 * shorter window gets the transcript moving sooner.
 */
const SILENCE_MS = 650
/** Nobody speaks one segment for this long; cut it and transcribe what we have. */
const MAX_MS = 20000

/** The floor adapts slowly upward (a fan spinning up) and quickly downward (a
 *  door closing), so it settles to genuine ambient noise without chasing speech. */
const FLOOR_UP = 0.0008
const FLOOR_DOWN = 0.02

/** Each frame from the capture worklet: 20 ms at 16 kHz. */
const FRAME_MS = 20
const RATE = 16000
/** Audio kept from just before the onset, so the first syllable survives. */
const PRE_ROLL_FRAMES = 15 // 300 ms

const dead: Vad = {
  stop: () => {},
  setGuard: () => {},
  live: () => false,
  meter: () => ({ energy: 0, floor: 0, threshold: 0, speaking: false }),
}

/** An AudioContext at 16 kHz where the engine allows it, so nothing resamples twice. */
function openContext(stream: MediaStream): { ctx: AudioContext; source: MediaStreamAudioSourceNode } {
  try {
    const ctx = new AudioContext({ sampleRate: RATE })
    return { ctx, source: ctx.createMediaStreamSource(stream) }
  } catch {
    // Some engines refuse to connect a microphone to a context at another rate;
    // run at the device rate and let the worklet decimate.
    const ctx = new AudioContext()
    return { ctx, source: ctx.createMediaStreamSource(stream) }
  }
}

function rms(frame: Float32Array): number {
  let sum = 0
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i]
  return Math.sqrt(sum / frame.length)
}

function concat(frames: Float32Array[]): Float32Array {
  const out = new Float32Array(frames.reduce((n, f) => n + f.length, 0))
  let at = 0
  for (const f of frames) {
    out.set(f, at)
    at += f.length
  }
  return out
}

export async function startVad(h: VadHandlers): Promise<Vad> {
  let stream: MediaStream
  try {
    stream = await getMic()
  } catch (err) {
    h.onError(
      err instanceof DOMException && err.name === 'NotAllowedError'
        ? 'Microphone access denied — voice input is unavailable.'
        : 'No microphone available.',
    )
    return dead
  }

  const { ctx, source } = openContext(stream)
  // Some engines start an AudioContext suspended even after a gesture; resume
  // is a no-op when it is already running.
  void ctx.resume()
  try {
    await ctx.audioWorklet.addModule('/worklets/pcm-capture.js')
  } catch {
    h.onError('Audio capture could not start — voice input is unavailable.')
    void ctx.close()
    return dead
  }
  const node = new AudioWorkletNode(ctx, 'vas-pcm-capture')
  // The worklet has to be pulled by the graph to run, so it feeds a silent
  // gain into the speakers rather than nothing at all.
  const sink = ctx.createGain()
  sink.gain.value = 0
  source.connect(node)
  node.connect(sink)
  sink.connect(ctx.destination)

  let stopped = false
  let guard = false
  let floor = 0.01
  let smoothEnergy = 0
  let threshold = 0

  // Time, in milliseconds of audio heard — not wall-clock, so a busy main
  // thread cannot make silence look longer or shorter than it was.
  let t = 0
  let armedAt = 0 // energy first rose; the segment may be pre-rolling
  let speaking = false
  let speechStartedAt = 0
  let lastLoud = 0
  let preRoll: Float32Array[] = []
  let segment: Float32Array[] = []

  const endSegment = () => {
    const frames = segment
    const startedAt = speechStartedAt
    segment = []
    speaking = false
    speechStartedAt = 0
    if (!frames.length) return
    h.onEnd(encodeWav(concat(frames), RATE), startedAt ? t - startedAt : 0)
  }

  const onFrame = (frame: Float32Array) => {
    if (stopped) return
    t += FRAME_MS

    const energy = rms(frame)
    smoothEnergy += (energy - smoothEnergy) * 0.5
    h.onLevel(Math.min(1, smoothEnergy * 12))

    // Adapt the floor only when we are confident this is not speech.
    if (!speaking && armedAt === 0) {
      const rate = smoothEnergy > floor ? FLOOR_UP : FLOOR_DOWN
      floor += (smoothEnergy - floor) * rate
      floor = Math.max(floor, 0.0015)
    }

    threshold = floor * TRIGGER_OVER_FLOOR * (guard ? GUARD_BOOST : 1)
    const release = threshold * RELEASE_RATIO

    if (!speaking) {
      if (smoothEnergy > threshold) {
        if (armedAt === 0) {
          // Onset: start the segment now, with the pre-roll, before we have
          // even confirmed this is speech. A blip is simply thrown away.
          armedAt = t
          segment = [...preRoll, frame]
          preRoll = []
        } else {
          segment.push(frame)
          if (t - armedAt >= START_MS) {
            // Confirmed. This is the moment barge-in fires.
            speaking = true
            speechStartedAt = armedAt
            lastLoud = t
            h.onStart()
          }
        }
      } else if (armedAt !== 0) {
        // Rose and fell without confirming — a knock, a click, a lip smack.
        armedAt = 0
        preRoll = segment.slice(-PRE_ROLL_FRAMES)
        segment = []
      } else {
        preRoll.push(frame)
        if (preRoll.length > PRE_ROLL_FRAMES) preRoll.shift()
      }
    } else {
      segment.push(frame)
      if (smoothEnergy > release) lastLoud = t
      if (t - lastLoud >= SILENCE_MS || t - speechStartedAt >= MAX_MS) {
        armedAt = 0
        endSegment()
      }
    }
  }

  node.port.onmessage = (e: MessageEvent<Float32Array>) => onFrame(e.data)

  return {
    stop: () => {
      stopped = true
      node.port.onmessage = null
      try {
        source.disconnect()
        node.disconnect()
        void ctx.close()
      } catch {
        /* noop */
      }
    },
    setGuard: (on) => {
      guard = on
    },
    live: () => !stopped,
    meter: () => ({ energy: smoothEnergy, floor, threshold, speaking }),
  }
}
