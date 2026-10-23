import { useEffect, useRef, useState } from 'react'
import { createTimeline, scrambleText, stagger, utils } from 'animejs'
import { useStore } from '../store'
import { desktop } from '../lib/desktop'
import { BOOT } from '../scene/bootTiming'

/**
 * The start-up overlay, in anime.js. It is a vignette with a clear centre: the
 * scene assembles the live orb in the middle (reactor.ts, same BOOT clock)
 * while this covers the HUD around it with a status line, the J.A.R.V.I.S
 * wordmark and a rainbow progress line. It holds its last frame for as long as
 * start-up takes after BOOT_MS, and dissolves only when the phase really leaves
 * 'boot', so the boot ends inside the live visual with no cut.
 *
 * Mounted only for a window someone can see: a quiet tray start never builds it.
 */

const WORD = Array.from('J.A.R.V.I.S')
/** Letters cycle the pop palette (classes in index.css); the dots are white. */
const tone = (ch: string, i: number) => (ch === '.' ? 'cd' : `c${(i / 2) % 6}`)

export function Boot() {
  const phase = useStore((s) => s.phase)
  const booting = phase === 'boot' && !desktop?.startHidden
  // Stays mounted after 'boot' for the exit dissolve; derived, so the first
  // 'boot' render already shows the overlay (no HUD flash as Ignition leaves).
  const [lingering, setLingering] = useState(false)
  useEffect(() => { if (booting) setLingering(true) }, [booting])
  if (!booting && !lingering) return null
  return <BootOverlay booting={booting} setLingering={setLingering} />
}

function BootOverlay({ booting, setLingering }: { booting: boolean; setLingering: (on: boolean) => void }) {
  const note = useStore((s) => s.bootNote)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = root.current
    if (!el) return
    const chars = el.querySelectorAll<HTMLElement>('.boot-char')
    const status = el.querySelector<HTMLElement>('.boot-status')
    const bar = el.querySelector<HTMLElement>('.boot-bar')
    if (!status || !bar) return
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches

    if (!booting) {
      // The phase has moved on: dissolve onto the live orb, then unmount.
      const out = createTimeline({ onComplete: () => setLingering(false) })
        .add(el, { opacity: 0, duration: reduce ? 300 : 650, ease: 'out(2)' }, 0)
      if (!reduce) out.add(chars, { translateY: '-0.6em', duration: 480, ease: 'in(2)', delay: stagger(25, { from: 'center' }) }, 0)
      return () => { out.cancel() }
    }

    // Intro. Also replays if 'boot' comes back mid-dissolve (a failed power-up, then a retry).
    utils.set(el, { opacity: 1 })
    utils.set(bar, { scaleX: 0 })
    status.textContent = ''
    const tl = createTimeline({ defaults: { ease: 'out(3)' } })
    if (reduce) {
      utils.set(chars, { opacity: 0, translateY: '0em', scale: 1 })
      status.textContent = 'SYSTEMS ONLINE'
      tl.set(bar, { scaleX: 1 }, 0).add(chars, { opacity: 1, duration: 400 }, 150)
    } else {
      utils.set(chars, { opacity: 0, translateY: '1.1em', scale: 0.3 })
      tl.add(status, { textContent: scrambleText({ text: 'INITIATING', chars: 'uppercase' }) }, 0)
        .add(bar, { scaleX: [0, 1], duration: BOOT.total - 400, ease: 'inOut(2)' }, 200)
        .add(chars, {
          opacity: [0, 1], translateY: ['1.1em', '0em'], scale: [0.3, 1],
          duration: 620, ease: 'outBack(2.2)', delay: stagger(55, { from: 'center' }),
        }, 700)
        // On the orb's pop: the letters hop and the status resolves.
        .add(chars, {
          translateY: [{ to: '-0.35em', duration: 120, ease: 'out(2)' }, { to: '0em', duration: 620, ease: 'outElastic(1, .45)' }],
          delay: stagger(22, { from: 'center' }),
        }, BOOT.pop)
        .add(status, { textContent: scrambleText({ text: 'SYSTEMS ONLINE', chars: 'uppercase' }) }, BOOT.pop)
    }
    return () => { tl.cancel() }
  }, [booting, setLingering])

  return (
    <div className="boot" ref={root} aria-hidden="true">
      {/* No React children: scrambleText owns this text node (constant strings only, never JARVIS text). */}
      <div className="boot-status" />
      <div className="boot-word">
        {WORD.map((ch, i) => <span key={i} className={`boot-char ${tone(ch, i)}`}>{ch}</span>)}
      </div>
      <div className="boot-bar" />
      <div className="boot-note">{note}</div>
    </div>
  )
}
