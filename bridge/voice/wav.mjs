/**
 * The one audio format the face sends: WAV, 16 kHz, mono, 16-bit PCM — exactly
 * what the speech models want, so nothing on either side has to decode,
 * resample or depend on a codec. Parsing is tolerant of what a WAV writer may
 * legitimately produce (extra chunks, float samples, stereo) and strict about
 * the rate, which is the one thing that would silently ruin recognition.
 */
export class WavError extends Error {}

/** @returns {{ sampleRate: number, samples: Float32Array }} */
export function parseWav(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new WavError('not a WAV file')
  }
  let fmt = null
  let data = null
  let off = 12
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    const body = off + 8
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      }
    } else if (id === 'data') {
      data = buf.subarray(body, Math.min(buf.length, body + size))
      break
    }
    off = body + size + (size & 1)
  }
  if (!fmt || !data) throw new WavError('WAV file has no audio')
  const float = fmt.format === 3 || (fmt.format === 0xfffe && fmt.bits === 32)
  const pcm16 = (fmt.format === 1 || fmt.format === 0xfffe) && fmt.bits === 16
  if (!float && !pcm16) throw new WavError(`unsupported WAV encoding (format ${fmt.format}, ${fmt.bits}-bit)`)
  const bytes = fmt.bits / 8
  const ch = Math.max(1, fmt.channels)
  const frames = Math.floor(data.length / (bytes * ch))
  const samples = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    let sum = 0
    for (let c = 0; c < ch; c++) {
      const at = (i * ch + c) * bytes
      sum += float ? data.readFloatLE(at) : data.readInt16LE(at) / 32768
    }
    samples[i] = sum / ch
  }
  return { sampleRate: fmt.sampleRate, samples }
}

/** Float samples in [-1, 1] to a 16-bit mono WAV file. */
export function encodeWav(samples, sampleRate = 16000) {
  const data = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    data.writeInt16LE(Math.round(s < 0 ? s * 32768 : s * 32767), i * 2)
  }
  const head = Buffer.alloc(44)
  head.write('RIFF', 0, 'ascii')
  head.writeUInt32LE(36 + data.length, 4)
  head.write('WAVE', 8, 'ascii')
  head.write('fmt ', 12, 'ascii')
  head.writeUInt32LE(16, 16)
  head.writeUInt16LE(1, 20) // PCM
  head.writeUInt16LE(1, 22) // mono
  head.writeUInt32LE(sampleRate, 24)
  head.writeUInt32LE(sampleRate * 2, 28)
  head.writeUInt16LE(2, 32)
  head.writeUInt16LE(16, 34)
  head.write('data', 36, 'ascii')
  head.writeUInt32LE(data.length, 40)
  return Buffer.concat([head, data])
}

/** Root-mean-square level of a block of samples. */
export function rms(samples) {
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  return samples.length ? Math.sqrt(sum / samples.length) : 0
}
