import { useEffect, useState } from 'react'
import { BRIDGE_HTTP_URL } from '../config'
import { desktop } from '../lib/desktop'

/**
 * First run: JARVIS's ears are not installed yet.
 *
 * The voice models (wake word, Whisper, the voice check) are a few hundred MB,
 * so they are not in the installer and never download by themselves — this
 * asks, says how big, shows progress, and reloads the face when they are in
 * place so listening starts at once.
 */
type Status = {
  missing: string[]
  bytes: number
  running: boolean
  done: boolean
  error: string | null
  progress: { file: string; received: number; total: number } | null
}

const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`

export function ModelsBanner() {
  const [status, setStatus] = useState<Status | null>(null)

  useEffect(() => {
    if (!desktop) return
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const s = (await (await fetch(`${BRIDGE_HTTP_URL}/models/status`)).json()) as Status
        if (!alive) return
        setStatus(s)
        if (s.done && !s.missing.length) {
          window.location.reload()
          return
        }
        timer = setTimeout(poll, s.running ? 700 : 5000)
      } catch {
        timer = setTimeout(poll, 5000)
      }
    }
    void poll()
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [])

  if (!status || (!status.missing.length && !status.running)) return null
  const start = () => {
    void fetch(`${BRIDGE_HTTP_URL}/models/fetch`, { method: 'POST' })
    setStatus({ ...status, running: true })
  }
  const p = status.progress
  return (
    <div className="models-banner" role="status">
      {status.running ? (
        <>
          <div>Downloading JARVIS's voice models…</div>
          {p && (
            <div className="models-progress">
              <div style={{ width: `${Math.round((p.received / p.total) * 100)}%` }} />
            </div>
          )}
          {p && <div className="models-file">{p.file} · {mb(p.received)} of {mb(p.total)}</div>}
        </>
      ) : (
        <>
          <div>JARVIS can't hear you yet — his voice models aren't installed.</div>
          {status.error && <div className="models-file">Last try failed: {status.error}</div>}
          <button type="button" onClick={start}>
            Download voice models ({mb(status.bytes)})
          </button>
        </>
      )}
    </div>
  )
}
