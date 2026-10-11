/**
 * ElevenLabs Scribe, for when the user has a key and prefers it to local
 * Whisper. The audio goes to ElevenLabs; the key never leaves the bridge.
 *
 * @param {Buffer} audio
 * @param {string} type      the audio's content type (wav, webm, ogg, mp4)
 * @param {string} key
 * @param {string} language  'auto' or an ISO code
 */
export async function scribeTranscribe(audio, type, key, language = 'auto') {
  // The filename extension is the only hint Scribe gets about the codec.
  const ext = type.includes('wav')
    ? 'wav'
    : type.includes('ogg')
      ? 'ogg'
      : type.includes('mp4') || type.includes('mpeg')
        ? 'mp4'
        : 'webm'
  const form = new FormData()
  form.append('model_id', 'scribe_v1')
  if (language && language !== 'auto') form.append('language_code', language)
  form.append('tag_audio_events', 'false')
  form.append('file', new Blob([audio], { type: type || 'audio/wav' }), `speech.${ext}`)
  const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST',
    headers: { 'xi-api-key': key },
    body: form,
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`Scribe HTTP ${res.status}`)
  const data = await res.json()
  return String(data.text ?? '').trim()
}
