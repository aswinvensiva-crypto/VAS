import { useEffect, useRef, useState } from 'react'
import { createScope, engine } from 'animejs'
import { desktop } from '../lib/desktop'
import { startReactor, BLOBS, CORE_R, WIRE, PIP_COUNT, type ReactorEls } from './reactor'
import { startOrbits } from './orbits'

/**
 * Whether the window can be seen. The desktop app keeps Chromium's background
 * throttling off so the microphone never stalls, which also means a hidden
 * window would go on animating at full rate. In a browser tab anime pauses
 * itself on document.hidden.
 */
function useWindowShown(): boolean {
  const [shown, setShown] = useState(() => !desktop?.startHidden)
  useEffect(() => desktop?.onVisibility(({ hidden }) => setShown(!hidden)), [])
  return shown
}

/**
 * One global anime engine drives every anime.js animation in the app.
 * Electron (backgroundThrottling off) never reports the document hidden, so
 * anime's pauseOnDocumentHidden never fires there; this does its job.
 *
 * Verified in 4.5.0 engine.js / timer.js: engine.pause() returns early while
 * the engine is idle (reqId 0), and any later play()/resume()/animatable
 * setter calls engine.wake(), which checks only useDefaultMainLoop, never
 * `paused`. So the flag is what stops a new rAF while hidden. Forcing
 * paused = true before resume() makes resume() re-base every live clock
 * (resetTime), so nothing jumps forward after a long stay in the tray.
 */
function runEngine(on: boolean) {
  if (on) {
    engine.useDefaultMainLoop = true
    engine.paused = true
    engine.resume()
  } else {
    engine.useDefaultMainLoop = false
    engine.pause()
  }
}

/** 72-tick bezel; every sixth tick is long. viewBox units (-100..100). */
const TICKS = (() => {
  let p = ''
  for (let i = 0; i < 72; i++) {
    const a = (i / 72) * Math.PI * 2
    const r0 = i % 6 === 0 ? 87.5 : 90
    const c = Math.cos(a)
    const s = Math.sin(a)
    p += `M${(c * r0).toFixed(2)} ${(s * r0).toFixed(2)}L${(c * 94).toFixed(2)} ${(s * 94).toFixed(2)}`
  }
  return p
})()

export function Scene() {
  const shown = useWindowShown()
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => { runEngine(shown) }, [shown])
  // Never leave the rest of the app with a stopped engine.
  useEffect(() => () => runEngine(true), [])

  useEffect(() => {
    const el = root.current
    if (!el) return
    const scope = createScope({ root: el, mediaQueries: { reduce: '(prefers-reduced-motion: reduce)' } })
    // anime re-runs this constructor whenever the media query flips, reverting
    // everything registered in it (the timers, animatables, the comet loop) first.
    scope.add((self) => {
      const reduce = Boolean(self?.matches.reduce)
      const one = <T extends Element>(sel: string) => el.querySelector(sel) as T
      const all = <T extends Element>(sel: string) => Array.from(el.querySelectorAll<T>(sel))
      const els: ReactorEls = {
        root: el,
        stage: one('.orb-stage'),
        halo: one('.orb-halo'),
        ringGlow: one('.orb-ringglow'),
        ring: one('.orb-ring'),
        ticksSvg: one('.orb-ticks'),
        ticks: one('.orb-tickmarks'),
        chase: one('.orb-chase'),
        chaseArc: one('.orb-chase-arc'),
        comet: one('.orb-comet'),
        beacon: one('.orb-beacon'),
        beaconRing: one('.orb-beacon-ring'),
        wires: all('.orb-wire'),
        pips: all('.orb-pip'),
        pulse: one('.orb-pulse'),
        core: one('.orb-core'),
        blobs: all('.orb-blob'),
        rim: one('.orb-rim'),
        ripples: all('.orb-ripple'),
      }
      const stopReactor = startReactor(els, reduce)
      const stopOrbits = startOrbits(one<HTMLElement>('.orb-orbits'), reduce)
      return () => {
        stopOrbits()
        stopReactor()
      }
    })
    return () => scope.revert()
  }, [])

  // Every prop below is constant: a re-render (visibility only) can never
  // overwrite the imperatively written transforms, data-style, dasharrays or
  // the children of .orb-orbits.
  return (
    <div className="scene" ref={root} aria-hidden="true">
      <div className="orb-stage">
        <div className="orb-halo" />
        <div className="orb-ringglow" />
        <div className="orb-ring" />
        <svg className="orb-ticks" viewBox="-100 -100 200 200">
          <path className="orb-tickmarks" d={TICKS} />
          <g className="orb-chase"><circle className="orb-chase-arc" r="91" /></g>
        </svg>
        <svg className="orb-lines" viewBox="-100 -100 200 200">
          <circle className="orb-comet" r="70" transform="rotate(-90)" />
          <g className="orb-beacon"><circle className="orb-beacon-ring" r="98" /></g>
          {WIRE.map((w, i) => (
            <g key={i} className="orb-wire"><circle className={`w${i}`} r={w.r} strokeDasharray={w.dash} /></g>
          ))}
        </svg>
        <div className="orb-pips">
          {Array.from({ length: PIP_COUNT }, (_, i) => <div key={i} className={`orb-pip k${i % 3} t${i % 4}`} />)}
        </div>
        <div className="orb-pulse">
          <svg className="orb-goo" viewBox="-100 -100 200 200">
            <defs>
              <radialGradient id="vas-fill" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="90" fx="-26" fy="-30">
                <stop offset="0" className="st-hi" />
                <stop offset="0.36" className="st-orb" />
                <stop offset="0.74" className="st-pop" />
                <stop offset="1" className="st-deep" />
              </radialGradient>
              <radialGradient id="vas-gloss">
                <stop offset="0" stopColor="#fff" stopOpacity="0.95" />
                <stop offset="1" stopColor="#fff" stopOpacity="0" />
              </radialGradient>
              {/* Metaball: blur, then an alpha threshold, then the crisp source composited atop. */}
              <filter id="vas-goo" x="-30%" y="-30%" width="160%" height="160%" colorInterpolationFilters="sRGB">
                <feGaussianBlur in="SourceGraphic" stdDeviation="6" result="blur" />
                <feColorMatrix in="blur" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 20 -8" result="goo" />
                <feComposite in="SourceGraphic" in2="goo" operator="atop" />
              </filter>
            </defs>
            <g filter="url(#vas-goo)">
              <circle className="orb-core" r={CORE_R} fill="url(#vas-fill)" />
              {BLOBS.map((b, i) => <circle key={i} className="orb-blob" r={b.r} fill="url(#vas-fill)" />)}
            </g>
            <ellipse className="orb-gloss" cx="-22" cy="-28" rx="26" ry="15" transform="rotate(-32 -22 -28)" fill="url(#vas-gloss)" />
            <circle className="orb-rim" r="70" />
          </svg>
        </div>
        {[0, 1, 2, 3].map((i) => <div key={i} className="orb-ripple" />)}
      </div>
      <div className="orb-orbits" />
    </div>
  )
}
