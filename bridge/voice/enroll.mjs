import { randomBytes } from 'node:crypto'
import { parseWav } from './wav.mjs'
import { MIN_SECONDS, cosine, forgetSpeaker, loadSpeaker, saveSpeaker, verdict } from './speaker.mjs'
import { MODELS } from './models.mjs'

/**
 * The voice-enrollment endpoints the face's "Learn my voice" screen talks to.
 *
 *   POST   /voice/enroll?session=…   one recorded clip (16 kHz WAV)
 *   POST   /voice/enroll/finish?session=…
 *   GET    /voice/status
 *   POST   /voice/test               a clip, scored against the saved voice
 *   DELETE /voice/enroll             forget the voice
 *
 * Clips are held in memory only until the session finishes; what is saved is
 * the averaged voiceprint, not the recordings.
 */
const MIN_CLIPS = 5
const sessions = new Map()

export function createEnrollment({ engine, onChange }) {
  return async function handle(req, pathname, query, body) {
    if (pathname === '/voice/status' && req.method === 'GET') {
      const s = loadSpeaker()
      return [200, { enrolled: Boolean(s), clips: s?.clips ?? 0, enrolledAt: s?.enrolledAt ?? null, thresholds: s?.thresholds ?? null, available: engine.status().speaker }]
    }
    if (pathname === '/voice/enroll' && req.method === 'DELETE') {
      forgetSpeaker()
      onChange()
      return [200, { ok: true }]
    }
    if (!engine.status().speaker) return [503, { ok: false, reason: 'The voice model is not installed — run npm run models.' }]

    const clip = () => {
      const wav = parseWav(body)
      if (wav.sampleRate !== 16000) throw Object.assign(new Error('expected 16 kHz audio'), { status: 415 })
      return { samples: wav.samples, seconds: wav.samples.length / 16000 }
    }

    if (pathname === '/voice/enroll' && req.method === 'POST') {
      const id = query.get('session') || randomBytes(6).toString('hex')
      const { samples, seconds } = clip()
      if (seconds < MIN_SECONDS) return [200, { ok: false, session: id, reason: 'That was too short — say the whole phrase.' }]
      const v = await engine.embed(samples)
      const list = sessions.get(id) ?? []
      list.push({ v, seconds })
      sessions.set(id, list)
      return [200, { ok: true, session: id, count: list.length, seconds: Math.round(seconds * 10) / 10 }]
    }
    if (pathname === '/voice/enroll/finish' && req.method === 'POST') {
      const id = query.get('session')
      const clips = sessions.get(id) ?? []
      if (clips.length < MIN_CLIPS) return [200, { ok: false, reason: `I need at least ${MIN_CLIPS} recordings; I have ${clips.length}.` }]
      sessions.delete(id)
      const saved = await saveSpeaker({ model: MODELS.speaker.file, clips })
      onChange()
      return [200, { ok: true, clips: saved.clips, thresholds: saved.thresholds }]
    }
    if (pathname === '/voice/test' && req.method === 'POST') {
      const s = loadSpeaker()
      if (!s) return [200, { ok: false, reason: 'No voice is enrolled yet.' }]
      const { samples, seconds } = clip()
      const score = cosine(await engine.embed(samples), s.centroid)
      return [200, { ok: true, score: Math.round(score * 1000) / 1000, verdict: verdict(score, seconds, s.thresholds), seconds }]
    }
    return null
  }
}
