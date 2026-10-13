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
 *
 * The lines come from the bridge (GET /voice/enroll), which also says how
 * many short (a word or two) and long recordings it needs: the voice check is
 * calibrated separately for each length, and a confirmation is usually one
 * word. If the lines run out before both counts are met, more of the missing
 * kind are added rather than failing at the end.
 */
type Plan = { prompts: string[]; need: { short: number; long: number } }

/** Used only if the bridge cannot be asked; mirrors its list. */
const FALLBACK: Plan = {
  prompts: [
    'Hey Jarvis, open Chrome for me.',
    'Yes.',
    'The quick brown fox jumps over the lazy dog while the sun goes down.',
    'No.',
    'Hey Jarvis.',
    'Go ahead.',
    'Could you remind me what I have planned for tomorrow afternoon?',
    'Stop.',
    'Hey Jarvis, what is the weather like today?',
    'Cancel that.',
    'Confirm.',
  ],
  need: { short: 5, long: 2 },
}

const isShortLine = (line: string) => line.trim().split(/\s+/).length <= 2

/** Another line of the kind still missing, taken in turn from the plan's own. */
function extraLine(plan: Plan, have: { short: number; long: number }, n: number): string | null {
  const kind = have.short < plan.need.short ? 'short' : have.long < plan.need.long ? 'long' : null
  if (!kind) return null
  const pool = plan.prompts.filter((l) => isShortLine(l) === (kind === 'short'))
  return pool.length ? pool[n % pool.length] : null
}

async function loadPlan(): Promise<Plan> {
  try {
    const res = await fetch(`${BRIDGE_HTTP_URL}/voice/enroll`)
    const body = (await res.json()) as Partial<Plan>
    if (Array.isArray(body.prompts) && body.prompts.length && body.need) {
      return { prompts: body.prompts, need: body.need }
    }
  } catch {
    /* fall back to the built-in lines */
  }
  return FALLBACK
}

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
  const vad = useRef<Vad | null>(null)
  const stepRef = useRef(0)
  // The lines being read: the plan's, plus any added to reach the counts.
  const [lines, setLines] = useState<string[]>(FALLBACK.prompts)
  const linesRef = useRef<string[]>(FALLBACK.prompts)
  const plan = useRef<Plan>(FALLBACK)
  const have = useRef({ short: 0, long: 0 })

  useEffect(() => {
    if (!enrolling) return
    setStage('record')
    setStep(0)
    stepRef.current = 0
    setNote('Read the line out loud, at your normal volume.')
    setResult(null)
    have.current = { short: 0, long: 0 }
    // This opening's own. A clip still uploading when the screen is cancelled
    // finishes into these and stops at the next `stopped` check, so it can
    // neither save a voice nobody finished nor write into a later session.
    let stopped = false
    let session: string | null = null
    let busy = false
    const showLines = (next: string[]) => {
      linesRef.current = next
      setLines(next)
    }
    showLines(FALLBACK.prompts)
    void loadPlan().then((p) => {
      if (stopped) return
      plan.current = p
      // Only swap the lines if nothing has been recorded against the old ones.
      if (stepRef.current === 0) showLines(p.prompts)
    })

    /** After the last line: add one of the missing kind, or say none is missing. */
    const extendIfShort = (): boolean => {
      const line = extraLine(plan.current, have.current, stepRef.current)
      if (!line) return false
      showLines([...linesRef.current, line])
      return true
    }

    const onClip = async (blob: Blob) => {
      if (busy || stopped) return
      busy = true
      try {
        if (stepRef.current < linesRef.current.length) {
          const q = session ? `?session=${session}` : ''
          const r = await post(`/voice/enroll${q}`, blob)
          if (stopped) return
          if (!r.ok) {
            setNote(r.reason ?? 'That one did not take — try the line again.')
            return
          }
          session = r.session
          if (typeof r.short === 'number' && typeof r.long === 'number') have.current = { short: r.short, long: r.long }
          const next = stepRef.current + 1
          stepRef.current = next
          setStep(next)
          if (next < linesRef.current.length || extendIfShort()) {
            setNote('Got it.')
            return
          }
          // Cancelled while that clip was uploading: nothing is finished, and
          // nothing saved.
          if (stopped) return
          setStage('saving')
          const done = await post(`/voice/enroll/finish?session=${session}`)
          if (stopped) return
          if (!done.ok && done.need && (done.need.short > 0 || done.need.long > 0)) {
            // The bridge counted differently (a clip near two seconds): keep going.
            have.current = {
              short: Math.max(0, plan.current.need.short - done.need.short),
              long: Math.max(0, plan.current.need.long - done.need.long),
            }
            extendIfShort()
            setStage('record')
            setNote(done.reason ?? 'A few more, please.')
            return
          }
          if (!done.ok) {
            setStage('error')
            setNote(done.reason ?? 'Saving your voice failed.')
            return
          }
          setStage('test')
          setNote('Saved. Now say anything — I will show whether it sounds like you.')
        } else {
          const r = await post('/voice/test', blob)
          if (!stopped && r.ok) setResult({ verdict: r.verdict, score: r.score })
        }
      } catch {
        if (!stopped) setNote('I could not reach the voice engine.')
      } finally {
        busy = false
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
            {step + 1} / {lines.length}
          </div>
          <div className="enroll-phrase">“{lines[step]}”</div>
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
