import { useEffect, useRef } from 'react'
import { animate, createScope, stagger } from 'animejs'
import { useStore } from '../store'

/**
 * The start gate.
 *
 * Browsers refuse to play audio or start speech synthesis until the user has
 * interacted with the page, so something has to be clicked before JARVIS can
 * make a sound. Rather than hide that behind a permissions banner, it's the
 * cold open: the pop orb's palette waiting to be switched on — a gradient
 * ring, six coloured dots and a word whose letters hop in turn.
 *
 * Deliberately a plain conditional, never wrapped in AnimatePresence. It used
 * to be, for a fade on the way out, and the exit never completed: an
 * invisible `position: fixed; inset: 0` button stayed on top of everything and
 * swallowed every click and every pinch (hand control hit-tests with
 * elementFromPoint). A plain conditional cannot strand anything, and the boot
 * sequence takes the screen immediately anyway.
 *
 * Motion is anime.js, scoped to this node and reverted when it unmounts, and
 * none of it runs under prefers-reduced-motion.
 */
const WORD = Array.from('POWER UP')
const DOTS = 6

export function Ignition({ onStart }: { onStart: () => void }) {
  const phase = useStore((s) => s.phase)
  const root = useRef<HTMLButtonElement>(null)
  const offline = phase === 'offline'

  useEffect(() => {
    if (!offline || !root.current) return
    const scope = createScope({ root: root.current, mediaQueries: { reduce: '(prefers-reduced-motion: reduce)' } }).add((self) => {
      if (self?.matches.reduce) return
      // The word arrives letter by letter, then hops in a wave every couple of seconds.
      // The hop moves an inner span: two animations on one element's `y` replace
      // each other, and the loop would restart from the arrival's 18px offset.
      animate('.ign-char', {
        opacity: [0, 1],
        y: [{ from: 18, to: 0, duration: 620, ease: 'outBack(2)' }],
        delay: stagger(55),
      })
      animate('.ign-hop', {
        y: [
          { to: -7, duration: 260, ease: 'out(3)' },
          { to: 0, duration: 520, ease: 'outElastic(1, .55)' },
        ],
        delay: stagger(60, { start: 900 }),
        loop: true,
        loopDelay: 1700,
      })
      animate('.ign-ring', { rotate: 360, duration: 12000, ease: 'linear', loop: true })
      animate('.ign-dot', {
        scale: [0.55, 1.15],
        opacity: [0.45, 1],
        duration: 900,
        delay: stagger(150),
        ease: 'inOutSine',
        alternate: true,
        loop: true,
      })
      animate('.ign-glow', { scale: [0.92, 1.06], opacity: [0.55, 0.9], duration: 2400, ease: 'inOutSine', alternate: true, loop: true })
    })
    return () => scope.revert()
  }, [offline])

  if (!offline) return null

  return (
    <button className="ignition" onClick={onStart} ref={root} aria-label="Power up JARVIS">
      <span className="ign-glow" aria-hidden="true" />
      <span className="ign-ringwrap" aria-hidden="true">
        <span className="ign-ring" />
      </span>
      <span className="ign-dots" aria-hidden="true">
        {Array.from({ length: DOTS }, (_, i) => (
          // Placed by the arm, animated on the dot: anime.js owns the dot's whole transform.
          <span key={i} className="ign-arm" style={{ transform: `rotate(${(360 / DOTS) * i}deg) translateY(-148px)` }}>
            <span className={`ign-dot c${i}`} />
          </span>
        ))}
      </span>
      <span className="ignition-label">
        <span className="ignition-word" aria-hidden="true">
          {WORD.map((ch, i) => (
            <span key={i} className={`ign-char c${i % 6}`}>
              <span className="ign-hop">{ch === ' ' ? ' ' : ch}</span>
            </span>
          ))}
        </span>
        <span className="ignition-sub">click, or clap, to power up</span>
      </span>
    </button>
  )
}
