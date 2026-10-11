import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeWav } from '../../src/lib/wav.ts'
import { parseWav } from '../../bridge/voice/wav.mjs'

test('the face writes exactly the WAV the bridge reads', async () => {
  const samples = new Float32Array(1600).map((_, i) => Math.sin(i / 10) * 0.5)
  const blob = encodeWav(samples, 16000)
  assert.equal(blob.type, 'audio/wav')
  const parsed = parseWav(Buffer.from(await blob.arrayBuffer()))
  assert.equal(parsed.sampleRate, 16000)
  assert.equal(parsed.samples.length, samples.length)
  for (let i = 0; i < samples.length; i += 97) {
    assert.ok(Math.abs(parsed.samples[i] - samples[i]) < 1e-3, `sample ${i}`)
  }
})
