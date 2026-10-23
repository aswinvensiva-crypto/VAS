import {
  animate, createAnimatable, createDrawable, createTimeline, createTimer, stagger, utils,
  type JSAnimation, type Timeline, type Timer,
} from 'animejs'
import { useStore, accentFor, phaseColor, type Phase, type UiState } from '../store'
import { BOOT } from './bootTiming'

/**
 * The Pop Orb: a liquid metaball core in a neon conic ring, with eight flat
 * "pips" riding the inner track. Everything here is driven by ONE anime.js
 * timer on anime's global engine; React renders the markup once and never
 * again. Discrete changes (phase, style, visibility, knobs, effects) are
 * detected inside that timer by comparing against the last value seen, so
 * nothing is ever created while the engine is frozen (window hidden).
 */

type Style = UiState['reactor']['style']

export type ReactorEls = {
  root: HTMLElement
  stage: HTMLElement
  halo: HTMLElement
  ringGlow: HTMLElement
  ring: HTMLElement
  ticksSvg: SVGSVGElement
  ticks: SVGPathElement
  chase: SVGGElement
  chaseArc: SVGCircleElement
  comet: SVGCircleElement
  beacon: SVGGElement
  beaconRing: SVGCircleElement
  wires: SVGGElement[]
  pips: HTMLElement[]
  pulse: HTMLElement
  core: SVGCircleElement
  blobs: SVGCircleElement[]
  rim: SVGCircleElement
  ripples: HTMLElement[]
}

/*
 * Energy per phase, eased by createAnimatable. NO key here (or on `d` below)
 * may share a name with an anime default parameter (duration, delay, ease,
 * loop, autoplay, frameRate, modifier, ...): anime would read it as an option
 * instead of a tweenable property (core/helpers isKey).
 */
type Kit = {
  spin: number     // ring rotation: the old spinFor value, x24 deg/s
  swirl: number    // droplet orbit rate
  spread: number   // droplet distance from centre, goo units (core r 58)
  breathe: number  // breathing amplitude, fraction of size
  hz: number       // breathing rate
  gain: number     // share of the voice level that reaches the orb
  core: number     // orb size
  open: number     // how far the bold ring is assembled
  bounce: number   // how hard the voice throws the pips outward
  orbit: number    // pip orbit rate, relative to the ring
  counter: number  // odd pips' orbit multiplier (< 0 counter-rotates: thinking's gears)
}

const KIT: Record<Phase, Kit> = {
  offline:    { spin: 0.08, swirl: 0.05, spread: 26, breathe: 0.015, hz: 0.12, gain: 0.2,  core: 0.62, open: 0.35, bounce: 0,   orbit: 0.5, counter: 1 },
  boot:       { spin: 3.2,  swirl: 1.6,  spread: 40, breathe: 0.03,  hz: 0.5,  gain: 0.4,  core: 1,    open: 1,    bounce: 0.4, orbit: 0.5, counter: 1 },
  dormant:    { spin: 0.25, swirl: 0.15, spread: 34, breathe: 0.03,  hz: 0.18, gain: 0.35, core: 0.86, open: 1,    bounce: 0.3, orbit: 0.6, counter: 1 },
  waking:     { spin: 4.5,  swirl: 2.2,  spread: 42, breathe: 0.04,  hz: 0.9,  gain: 0.6,  core: 1.04, open: 1,    bounce: 0.6, orbit: 0.5, counter: 1 },
  listening:  { spin: 1.1,  swirl: 0.5,  spread: 36, breathe: 0.025, hz: 0.35, gain: 1,    core: 1,    open: 1,    bounce: 1,   orbit: 0.5, counter: 1 },
  thinking:   { spin: 2.8,  swirl: 2.6,  spread: 30, breathe: 0.02,  hz: 0.6,  gain: 0.3,  core: 0.94, open: 1,    bounce: 0.3, orbit: 0.6, counter: -1.4 },
  tooling:    { spin: 3.6,  swirl: 1.2,  spread: 40, breathe: 0.05,  hz: 1.6,  gain: 0.3,  core: 0.98, open: 1,    bounce: 0.3, orbit: 0,   counter: 1 },
  speaking:   { spin: 1.4,  swirl: 0.7,  spread: 36, breathe: 0.02,  hz: 0.4,  gain: 1,    core: 1,    open: 1,    bounce: 1,   orbit: 0.5, counter: 1 },
  confirming: { spin: 0.6,  swirl: 0.3,  spread: 32, breathe: 0,     hz: 0,    gain: 0.5,  core: 1,    open: 1,    bounce: 0.3, orbit: 0.3, counter: 1 },
}
const KIT_KEYS = Object.keys(KIT.dormant) as (keyof Kit)[]

/** Entry flourish: [punch, ripples]. Confirming has its own knock instead. */
const POP: Partial<Record<Phase, readonly [number, number]>> = {
  dormant: [-0.05, 0], waking: [0.2, 3], listening: [0.08, 1], thinking: [-0.04, 0], tooling: [0.06, 1], speaking: [0.1, 1],
}

/** Pip formation: r = share of the style's track, s = size, odd = odd pips' radius factor, gap = stagger ms. */
type Formation = { r: number; s: number; odd: number; ease: string; gap: number }
const PIP: Record<Phase, Formation> = {
  offline:    { r: 0.5,  s: 0,    odd: 1,   ease: 'inOut(3)',            gap: 0 },
  boot:       { r: 1,    s: 1,    odd: 1,   ease: 'outElastic(1, .6)',   gap: 45 },
  dormant:    { r: 1,    s: 0.7,  odd: 1,   ease: 'outBack(1.4)',        gap: 30 },
  waking:     { r: 1.45, s: 1.25, odd: 1,   ease: 'outElastic(1.1, .4)', gap: 25 },
  listening:  { r: 1,    s: 1,    odd: 1,   ease: 'outElastic(1, .55)',  gap: 35 },
  thinking:   { r: 1,    s: 0.9,  odd: 0.8, ease: 'outElastic(1, .65)',  gap: 40 },
  tooling:    { r: 1,    s: 0.9,  odd: 1,   ease: 'outBack(2)',          gap: 0 },
  speaking:   { r: 1,    s: 1,    odd: 1,   ease: 'outElastic(1, .55)',  gap: 35 },
  confirming: { r: 0.9,  s: 1.05, odd: 1,   ease: 'outBack(2.2)',        gap: 0 },
}

/** track = pip orbit radius as a share of the stage size (ring outer edge is 0.5). */
const STYLE: Record<Style, { core: number; bulge: number; glow: number; track: number }> = {
  ring:   { core: 1,   bulge: 1,    glow: 1,    track: 0.4 },
  sphere: { core: 1.3, bulge: 0.55, glow: 1.15, track: 0.53 },
  wire:   { core: 1,   bulge: 1,    glow: 0.55, track: 0.46 },
}

/** Droplets just under the core's surface; at rest they lift it into gentle lumps. */
export const BLOBS = [
  { a: 0.0, r: 26, w: 0.0 }, { a: 1.05, r: 22, w: 1.7 }, { a: 2.1, r: 30, w: 3.1 },
  { a: 3.14, r: 24, w: 4.4 }, { a: 4.2, r: 28, w: 5.2 }, { a: 5.25, r: 22, w: 2.6 },
]
export const WIRE = [
  { r: 40, rate: 1.6, dash: '2 5' }, { r: 56, rate: -1.1, dash: '28 8 4 8' },
  { r: 72, rate: 0.7, dash: 'none' }, { r: 86, rate: -0.45, dash: '1 3' },
]
export const PIP_COUNT = 8
export const CORE_R = 58
/** Per-pip voice throw, mirrored about the vertical axis (pip 0 is 12 o'clock). */
const BOUNCE = [0.1, 0.07, 0.12, 0.06, 0.09, 0.06, 0.12, 0.07]
/** .orb-stage is 60vmin square; pips are placed in vmin so nothing reads layout. */
const STAGE_VMIN = 60
const SPECTRUM = (['dormant', 'thinking', 'waking', 'tooling', 'confirming', 'speaking', 'listening', 'boot'] as const)
  .map((p) => phaseColor[p])
const TAU = Math.PI * 2
const wrap180 = (deg: number) => utils.wrap(deg, -180, 180)

/** Style/attribute writes that skip the DOM when the string has not changed. */
const memo = new WeakMap<Element, Record<string, string>>()
function slot(el: Element) {
  let m = memo.get(el)
  if (!m) memo.set(el, (m = {}))
  return m
}
function put(el: HTMLElement | SVGElement, prop: 'transform' | 'opacity', v: string) {
  const m = slot(el)
  if (m[prop] !== v) { m[prop] = v; el.style[prop] = v }
}
function putAttr(el: SVGElement, name: string, v: string) {
  const m = slot(el)
  const key = '@' + name
  if (m[key] !== v) { m[key] = v; el.setAttribute(name, v) }
}

export function startReactor(els: ReactorEls, reduce: boolean): () => void {
  const s0 = useStore.getState()
  const r0 = s0.ui.reactor
  const st0 = STYLE[r0.style] ?? STYLE.ring
  /** Every eased number lives here; the timer only composes them into geometry. */
  const d = {
    ...KIT[s0.phase],
    scale: r0.scale, intensity: r0.intensity, spinK: r0.spin,
    styleCore: st0.core, bulge: st0.bulge, track: st0.track,
    punch: 0, flash: 0, knock: 0, ring: 1, coreIn: 1, vis: r0.visible ? 1 : 0, swap: 1,
  }
  const blobs = BLOBS.map((b) => ({ a: b.a, w: b.w, d: 0, s: 1 }))
  const f0 = PIP[s0.phase]
  const pips = els.pips.map((_el, i) => ({ r: f0.r * (i % 2 ? f0.odd : 1), s: f0.s }))

  // Retargetable smoothing. A number per property is that property's duration.
  // Setters reset their tween, so they are called only when a target changes.
  const energy = createAnimatable(d, {
    spin: 900, swirl: 900, spread: 700, breathe: 700, hz: 700, gain: 350, core: 700,
    open: 900, bounce: 500, orbit: 700, counter: 900, ease: 'inOut(2)',
  })
  const knobs = createAnimatable(d, {
    scale: 600, intensity: 500, spinK: 700, styleCore: 520, bulge: 520, track: 520, ease: 'out(3)',
  })

  // createDrawable sets pathLength=1000 and only writes `draw` the first time it
  // meets an element, so a scope refresh (reduced-motion flip) restates it here.
  const [rimD] = createDrawable(els.rim, 0, 1)
  const [ticksD] = createDrawable(els.ticks, 0, 1)
  const [chaseD] = createDrawable(els.chaseArc, 0, 0.14)
  const [cometD] = createDrawable(els.comet, 0, 0)
  rimD.setAttribute('draw', '0 1')
  ticksD.setAttribute('draw', '0 1')
  chaseD.setAttribute('draw', '0 0.14')
  // An animation renders its from-values when it is created, even with
  // autoplay:false, so the loader only exists when it may move.
  const comet: JSAnimation | null = reduce
    ? null
    : animate(cometD, { draw: ['0 0', '0 1', '1 1'], duration: 1600, ease: 'inOutSine', loop: true, autoplay: false })
  cometD.setAttribute('draw', reduce ? '0 0.3' : '0 0')

  let bootColour: string | null = null
  let bootTl: Timeline | null = null
  let knockAnim: JSAnimation | null = null
  let swapTl: Timeline | null = null
  let pipAnim: JSAnimation | null = null
  let lv = 0, slow = 0, last = 0, lastRipple = 0, lastGoo = -1e9, ri = 0, knockHi = false
  // Accumulated, never wrapped: they are multiplied by per-layer rates below.
  let ringA = 0, swirlA = 0, breathP = 0, chaseA = 0, pipA = 0, pipB = 0
  const wl = WIRE.map(() => 0)
  const still = reduce ? 0 : 1
  const lit = { comet: false, chase: false, beacon: false }
  const cur = {
    phase: null as Phase | null, style: null as Style | null, visible: null as boolean | null,
    raw: undefined as string | null | undefined, ok: null as string | null,
    colour: '', scale: NaN, intensity: NaN, spin: NaN, glow: '', coreIn: '', fx: s0.ui.effect?.at ?? 0,
  }

  const fade = (key: keyof typeof lit, el: Element, on: boolean) => {
    if (lit[key] === on) return
    lit[key] = on
    animate(el, { opacity: on ? 1 : 0, duration: on ? 320 : 220, ease: 'out(2)' })
  }

  function ripple(strength: number, delay = 0) {
    if (reduce || d.vis < 0.5) return
    const el = els.ripples[ri++ % els.ripples.length]
    animate(el, { scale: [0.72, 1 + 0.55 * strength], opacity: [0.9, 0], duration: 900, delay, ease: 'out(3)' })
  }

  function punch(amount: number, rings: number) {
    if (reduce) return
    animate(d, { punch: [{ to: amount, duration: 140, ease: 'out(2)' }, { to: 0, duration: 680, ease: 'outElastic(1, .45)' }] })
    if (amount > 0) animate(d, { flash: [{ to: Math.min(1, amount * 4), duration: 120 }, { to: 0, duration: 800, ease: 'out(2)' }] })
    for (let i = 0; i < rings; i++) ripple(0.5 + amount * 2, i * 90)
  }

  /** Confirming: knock-knock ... rest. One looping keyframe tween; ripples are edge-detected in the frame. */
  function knock(on: boolean) {
    knockAnim?.cancel()
    knockAnim = null
    if (!on || reduce) {
      if (d.knock !== 0) animate(d, { knock: 0, duration: 200, ease: 'out(2)' })
      return
    }
    knockAnim = animate(d, {
      knock: [
        { to: 1, duration: 110, ease: 'out(2)' }, { to: 0, duration: 190, ease: 'in(2)' },
        { to: 1, duration: 110, ease: 'out(2)' }, { to: 0, duration: 190, ease: 'in(2)' },
      ],
      loop: true,
      loopDelay: 950,
    })
  }

  /** Regroup the pips into the phase's formation with an elastic stagger. */
  function regroup(p: Phase) {
    pipAnim?.cancel()
    pipAnim = null
    const f = PIP[p]
    const r = (_t: unknown, i = 0) => f.r * (i % 2 ? f.odd : 1)
    // utils.set defaults to composition 'none' (it does not override running
    // tweens), which is why pipAnim is cancelled first.
    if (reduce) { utils.set(pips, { r, s: f.s }); return }
    pipAnim = animate(pips, {
      r, s: f.s, duration: 900, ease: f.ease,
      delay: f.gap ? stagger(f.gap, { from: 'center' }) : 0,
    })
  }

  /** The power-up: rim and bezel draw on, the ring springs open, droplets merge, pips dock, the orb pops. */
  function boot() {
    bootTl?.cancel()
    bootTl = null
    if (reduce) return
    pipAnim?.cancel()
    pipAnim = null
    utils.set(blobs, { d: 60, s: 0 })
    utils.set(pips, { r: 2.2, s: 0 })
    rimD.setAttribute('draw', '0 0')
    ticksD.setAttribute('draw', '0 0')
    d.ring = 0
    d.coreIn = 0
    const tl = createTimeline({ defaults: { ease: 'out(3)' } })
      .add(rimD, { draw: ['0 0', '0 1'], duration: 900, ease: 'inOutQuart' }, 0)
      .add(ticksD, { draw: ['0 0', '0 1'], duration: 1100, ease: 'inOutQuart' }, 120)
      .add(d, { ring: [0, 1], duration: 800, ease: 'outBack(1.6)' }, 350)
      .add(blobs, { d: 0, s: 1, duration: 1100, ease: 'outElastic(1, .55)', delay: stagger(120, { from: 'random', seed: 7 }) }, 500)
      .add(d, { coreIn: [0, 1], duration: 800, ease: 'outBack(1.8)' }, 1200)
      .add(pips, { r: 1, s: 1, duration: 900, ease: 'outElastic(1, .6)', delay: stagger(45) }, 1300)
      .call(() => punch(0.22, 3), BOOT.pop)
      .call(() => { bootColour = null }, BOOT.settle)
    // Eight colour steps 260 ms apart; the 650 ms @property transition on --orb
    // blends them into one continuous rainbow sweep.
    SPECTRUM.forEach((c, i) => tl.call(() => { bootColour = c }, i * 260))
    bootTl = tl
  }

  function applyStyle(s: Style) {
    els.stage.dataset.style = s
    const st = STYLE[s]
    knobs.styleCore(st.core)
    knobs.bulge(st.bulge)
    knobs.track(st.track)
  }
  function swapStyle(s: Style, pop: boolean) {
    cur.style = s
    swapTl?.cancel()
    swapTl = null
    if (!pop || reduce) { applyStyle(s); d.swap = 1; return }
    swapTl = createTimeline()
      .add(d, { swap: 0, duration: 160, ease: 'in(2)' })
      .call(() => applyStyle(s))
      .add(d, { swap: 1, duration: 440, ease: 'outBack(1.8)' })
  }
  function setVisible(on: boolean, tween: boolean) {
    cur.visible = on
    if (on) els.stage.style.visibility = ''
    if (!tween || reduce) {
      d.vis = on ? 1 : 0
      if (!on) els.stage.style.visibility = 'hidden'
      return
    }
    animate(d, {
      vis: on ? 1 : 0, duration: on ? 520 : 360, ease: on ? 'outBack(1.4)' : 'in(2)',
      // Checks the live flag, so a quick hide-then-show can never strand it hidden.
      onComplete: () => { if (!cur.visible) els.stage.style.visibility = 'hidden' },
    })
  }

  function enter(p: Phase, prev: Phase | null) {
    cur.phase = p
    els.root.dataset.phase = p // CSS: confirming narrows its derived hues to a warm monochrome
    const k = KIT[p]
    for (const key of KIT_KEYS) energy[key](k[key])
    if (comet) { if (p === 'thinking') comet.play(); else comet.pause() }
    fade('comet', els.comet, p === 'thinking')
    fade('chase', els.chaseArc, p === 'tooling')
    fade('beacon', els.beaconRing, p === 'confirming')
    knock(p === 'confirming')
    if (p === 'boot') {
      if (reduce) regroup(p)
      boot()
      return
    }
    if (bootTl) {
      // Muted: the colour hand-back and the pop must not fire late.
      bootTl.complete(true)
      bootTl = null
      bootColour = null
    }
    regroup(p)
    const pop = prev === null ? undefined : POP[p]
    if (pop) punch(pop[0], pop[1])
  }

  const frame = (self: Timer) => {
    const t = self.currentTime
    const dt = Math.min(64, Math.max(0, t - last))
    last = t
    const { phase, level, ui } = useStore.getState() // imperative read: React never re-renders for this
    const r = ui.reactor
    const style: Style = r.style in STYLE ? r.style : 'ring'

    if (phase !== cur.phase) enter(phase, cur.phase)
    if (style !== cur.style) swapStyle(style, cur.style !== null)
    if (r.visible !== cur.visible) setVisible(r.visible, cur.visible !== null)
    if (r.scale !== cur.scale) { cur.scale = r.scale; knobs.scale(r.scale) }
    if (r.intensity !== cur.intensity) { cur.intensity = r.intensity; knobs.intensity(r.intensity) }
    if (r.spin !== cur.spin) { cur.spin = r.spin; knobs.spinK(r.spin) }
    const fx = ui.effect
    if (fx && fx.at !== cur.fx) {
      cur.fx = fx.at
      if (fx.kind === 'pulse') punch(0.12, 3)
      else if (fx.kind === 'flash' && !reduce) animate(d, { flash: [{ to: 1, duration: 90 }, { to: 0, duration: 700, ease: 'out(2)' }] })
    }

    // A colour JARVIS sends that CSS cannot parse is treated as "follow the phase",
    // checked once per new string, never per frame and never with a console line.
    if (r.color !== cur.raw) { cur.raw = r.color; cur.ok = r.color && CSS.supports('color', r.color) ? r.color : null }
    const colour = bootColour ?? cur.ok ?? accentFor(phase, ui)
    if (colour !== cur.colour) {
      cur.colour = colour
      if (CSS.supports('color', colour)) els.root.style.setProperty('--orb', colour)
    }
    const glow = d.intensity.toFixed(2)
    if (glow !== cur.glow) { cur.glow = glow; els.root.style.setProperty('--glow', glow) }

    // Voice: fast attack, slow release; syllable onsets throw a ripple.
    const want = utils.clamp((Number.isFinite(level) ? level : 0) * d.gain, 0, 1)
    lv = utils.damp(lv, want, dt, want > lv ? 0.55 : 0.1)
    slow = utils.damp(slow, want, dt, 0.025)
    if ((phase === 'listening' || phase === 'speaking') && lv - slow > 0.14 && t - lastRipple > 220) {
      lastRipple = t
      ripple(0.3 + lv)
    }
    if (phase === 'confirming') {
      if (!knockHi && d.knock > 0.6) { knockHi = true; ripple(0.4) }
      else if (knockHi && d.knock < 0.3) knockHi = false
    }

    const turn = dt * 0.024 * d.spin * d.spinK * still // deg this frame: 24 deg/s per unit of spin
    ringA += turn
    swirlA += dt * 0.0006 * d.swirl * d.spinK * still
    breathP = (breathP + dt * 0.001 * d.hz * TAU) % TAU
    const breath = Math.sin(breathP) * d.breathe * still
    pipA += turn * d.orbit
    pipB += turn * d.orbit * d.counter
    if (d.counter > 0.95) pipB += wrap180(pipA - pipB) * Math.min(1, dt * 0.004) // re-mesh the gears after thinking
    const punchAll = d.punch + 0.08 * d.knock

    const sScale = d.scale * (reduce ? 1 : (0.8 + 0.2 * d.vis) * (0.86 + 0.14 * d.swap))
    put(els.stage, 'transform', `scale(${sScale.toFixed(4)})`)
    // ui.reactor.intensity is brightness as well as glow: below 1 the whole orb
    // dims (0.3 reads as standby), above 1 only the glow grows. Never quite
    // gone at 0 — hiding it is what `visible` is for.
    const bright = utils.clamp(0.15 + 0.85 * d.intensity, 0, 1)
    put(els.stage, 'opacity', utils.clamp(d.vis * d.swap * bright, 0, 1).toFixed(3))
    if (d.vis <= 0.001) return

    // Compositor-only layers (each has will-change in CSS). Under reduced
    // motion the voice still brightens the orb but no longer moves or swells it.
    const I = d.intensity * STYLE[style].glow
    const open = d.ring * d.open
    put(els.halo, 'opacity', utils.clamp(I * (0.22 + 0.6 * lv + 0.7 * d.flash), 0, 1).toFixed(3))
    put(els.halo, 'transform', `scale(${(0.86 + 0.06 * Math.min(I, 3) + 0.28 * lv * still + 0.12 * d.flash).toFixed(4)})`)
    put(els.ring, 'transform', `rotate(${ringA.toFixed(2)}deg) scale(${((0.8 + 0.2 * open) * (1 + 0.3 * punchAll)).toFixed(4)})`)
    put(els.ring, 'opacity', utils.clamp(open, 0, 1).toFixed(3))
    put(els.ringGlow, 'opacity', utils.clamp(I * 0.45 * open * (0.6 + 0.9 * lv + d.flash), 0, 1).toFixed(3))
    put(els.ticksSvg, 'transform', `rotate(${(-ringA * 0.4).toFixed(2)}deg)`)
    if (phase === 'tooling') {
      chaseA = (chaseA + dt * 0.36 * d.spinK * still) % 360
      putAttr(els.chase, 'transform', `rotate(${chaseA.toFixed(1)})`)
    }
    if (phase === 'confirming') putAttr(els.beacon, 'transform', `rotate(${(ringA * 0.5).toFixed(1)})`)

    // Pips: rotate(orbit angle) translateX(radius) rotate(tumble) scale(size).
    const chaseAt = chaseA + 25.2 - ringA * 0.4 // screen angle of the chase arc's middle
    for (let i = 0; i < els.pips.length; i++) {
      const p = pips[i]
      const ang = i * 45 - 90 + (i % 2 ? pipB : pipA)
      const near = phase === 'tooling' ? Math.exp(-(wrap180(ang - chaseAt) ** 2) / 400) : 0
      const rad = (d.track * p.r + lv * d.bounce * still * (BOUNCE[i] ?? 0.08)) * STAGE_VMIN
      const k = Math.max(0, p.s * (1 + 0.9 * near + 3 * punchAll) * (1 + 0.3 * lv * d.bounce * still))
      const tumble = (i % 2 ? -0.8 : 0.8) * ringA - ang
      put(els.pips[i], 'transform',
        `rotate(${ang.toFixed(2)}deg) translateX(${rad.toFixed(3)}vmin) rotate(${tumble.toFixed(1)}deg) scale(${k.toFixed(3)})`)
    }

    if (style === 'wire') {
      for (let i = 0; i < els.wires.length; i++) {
        wl[i] = utils.damp(wl[i], lv, dt, 0.5 / (i + 1)) // inner rings answer first: a swell travelling out
        const k = d.core * (1 + breath + wl[i] * 0.1 * still + punchAll)
        putAttr(els.wires[i], 'transform', `rotate(${(ringA * WIRE[i].rate).toFixed(1)}) scale(${k.toFixed(4)})`)
      }
      return
    }

    // The liquid core is the one layer that repaints every frame; 30 fps is plenty while nothing happens.
    const calm = (phase === 'dormant' || phase === 'offline') && lv < 0.04 && punchAll === 0
    if (calm && t - lastGoo < 33) return
    lastGoo = t
    put(els.pulse, 'transform', `scale(${(d.core * d.styleCore * (1 + breath + lv * (reduce ? 0.04 : 0.16) + punchAll)).toFixed(4)})`)
    // Geometry goes in cx/cy/r, not transform: a transform would carry the
    // userSpaceOnUse gradient with each droplet, and the liquid must share one.
    putAttr(els.core, 'r', (CORE_R * d.coreIn).toFixed(2))
    const coreIn = d.coreIn.toFixed(2)
    if (coreIn !== cur.coreIn) { cur.coreIn = coreIn; els.pulse.style.setProperty('--core-in', coreIn) } // gloss waits for the core
    for (let i = 0; i < blobs.length; i++) {
      const b = blobs[i]
      const ang = b.a + swirlA * (i % 2 ? -1 : 1) * (1 + i * 0.12)
      const dist = (d.spread + (lv * 18 + Math.sin(t * 0.0011 + b.w) * 4) * still) * d.bulge + b.d
      const el = els.blobs[i]
      putAttr(el, 'cx', (Math.cos(ang) * dist).toFixed(2))
      putAttr(el, 'cy', (Math.sin(ang) * dist).toFixed(2))
      putAttr(el, 'r', (BLOBS[i].r * b.s * (0.9 + 0.25 * lv * still)).toFixed(2))
    }
  }

  // The single per-frame owner, on anime's global engine (the Scene gate freezes it).
  // Created inside the scope, so scope.revert() reverts it.
  createTimer({ frameRate: 60, onUpdate: frame })

  return () => {
    bootTl?.cancel()
    knockAnim?.cancel()
    swapTl?.cancel()
    pipAnim?.cancel()
    // One-shots fired from the timer are deliberately NOT scope-registered (the
    // scope's revertibles array would grow for the whole session); stop any
    // still in flight by target.
    utils.remove([d, ...blobs, ...pips, ...els.ripples, els.comet, els.chaseArc, els.beaconRing])
    // remove() stops a tween where it stands. A reduced-motion flip restarts the
    // reactor, which never fires a ripple under reduce, so anything caught
    // mid-flight would stay on screen; the next start fades the right ones in.
    for (const el of [...els.ripples, els.comet, els.chaseArc, els.beaconRing]) (el as HTMLElement | SVGElement).style.opacity = '0'
  }
}
