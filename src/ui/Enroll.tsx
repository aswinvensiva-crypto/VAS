import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { BRIDGE_HTTP_URL } from '../config'
import { startVad, type Vad } from '../lib/vad'

/**
 * "Learn my voice": record a few phrases so JARVIS can tell you from the TV.
 *
 * While this is open the main voice loop is deaf (App's mode() checks
 * `enrolling`), so nothing said here is taken as a command — "Hey Jarvis,
 * open Chrome" is a sample sentence, not an order. Each phrase is captured by
 * its own voice detector, posted to the bridge, and turned into a speaker
 * embedding there; only the averaged voiceprint is kept. Afterwards a live
 * test shows how each new thing you say scores, so you can see it works for
 * your voice — or start again in a quieter room.
 */
const PHRASES = [
  'Hey Jarvis, open Chrome for me.',
  'Hey Jarvis, what is the weather like today?',
  'Yes, confirm it.',
  'No, cancel that.',
  'The quick brown fox jumps over the lazy dog while the sun goes down.',
  'I usually start my day with a coffee and a look at my calendar.',
  'Hey Jarvis, play some music.',
  'Could you remind me what I have planned for tomorrow afternoon?',
]

type Stage = 'record' | 'saving' | 'test' | 'error'

async function post(path: string, body?: Blob) {
  const res = await fetch(`${BRIDGE_HTTP_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'audio/wav' },
    body,
  })
  return (await res.json()) as Record<string, any>
}

export function Enroll() {
  const enrolling = useStore((s) => s.enrolling)
  const setEnrolling = useStore((s) => s.setEnrolling)
  const [stage, setStage] = useState<Stage>('record')
  const [step, setStep] = useState(0)
  const [note, setNote] = useState('')
  const [level, setLevel] = useState(0)
  const [result, setResult] = useState<{ verdict: string; score: number } | null>(null)
  const session = useRef<string | null>(null)
  const vad = useRef<Vad | null>(null)
  const busy = useRef(false)
  const stepRef = useRef(0)

  useEffect(() => {
    if (!enrolling) return
    setStage('record')
    setStep(0)
    stepRef.current = 0
    setNote('Read the line out loud, at your normal volume.')
    setResult(null)
    session.current = null
    let stopped = false

    const onClip = async (blob: Blob) => {
      if (busy.current || stopped) return
      busy.current = true
      try {
        if (stepRef.current < PHRASES.length) {
          const q = session.current ? `?session=${session.current}` : ''
          const r = await post(`/voice/enroll${q}`, blob)
          if (!r.ok) {
            setNote(r.reason ?? 'That one did not take — try the line again.')
            return
          }
          session.current = r.session
          const next = stepRef.current + 1
          stepRef.current = next
          setStep(next)
          if (next < PHRASES.length) {
            setNote('Got it.')
            return
          }
          setStage('saving')
          const done = await post(`/voice/enroll/finish?session=${session.current}`)
          if (!done.ok) {
            setStage('error')
            setNote(done.reason ?? 'Saving your voice failed.')
            return
          }
          setStage('test')
          setNote('Saved. Now say anything — I will show whether it sounds like you.')
        } else {
          const r = await post('/voice/test', blob)
          if (r.ok) setResult({ verdict: r.verdict, score: r.score })
        }
      } catch {
        setNote('I could not reach the voice engine.')
      } finally {
        busy.current = false
      }
    }

    void startVad({
      onStart: () => {},
      onEnd: (blob) => void onClip(blob),
      onLevel: (v) => setLevel(v),
      onError: (m) => {
        setStage('error')
        setNote(m)
      },
    }).then((v) => {
      if (stopped) v.stop()
      else vad.current = v
    })

    return () => {
      stopped = true
      vad.current?.stop()
      vad.current = null
    }
  }, [enrolling])

  if (!enrolling) return null
  const verdictText =
    result?.verdict === 'owner' ? 'That sounds like you.' : result?.verdict === 'other' ? 'That does not sound like you.' : 'Too close to call.'

  return (
    <div className="enroll" role="dialog" aria-label="Learn my voice">
      <div className="enroll-title">Learn my voice</div>
      {stage === 'record' && (
        <>
          <div className="enroll-count">
            {step + 1} / {PHRASES.length}
          </div>
          <div className="enroll-phrase">“{PHRASES[step]}”</div>
        </>
      )}
      {stage === 'saving' && <div className="enroll-phrase">Saving your voice…</div>}
      {stage === 'test' && result && (
        <div className={`enroll-result enroll-${result.verdict}`}>
          {verdictText} <span className="enroll-score">({Math.round(result.score * 100)}%)</span>
        </div>
      )}
      <div className="enroll-meter">
        <div style={{ width: `${Math.round(level * 100)}%` }} />
      </div>
      <div className="enroll-note">{note}</div>
      <div className="enroll-actions">
        <button type="button" onClick={() => setEnrolling(false)}>
          {stage === 'test' ? 'Done' : 'Cancel'}
        </button>
      </div>
    </div>
  )
}
