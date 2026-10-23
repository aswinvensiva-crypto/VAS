import { animate, createTimer, utils } from 'animejs'
import { useStore, type OrbitObject } from '../store'
import { BRIDGE_HTTP_URL } from '../config'
import { toDiskPath } from '../lib/diskPath'

/**
 * JARVIS's shelf: images circling the orb, as plain <img> elements moved by
 * transform only. React never sees the list; it is reconciled from an anime
 * timer by array identity, exactly as the three.js version did in useFrame.
 */

/**
 * A page served over http cannot load `file:///…`, and everything interesting
 * lands on disk as an absolute path. Route those through the bridge, which can
 * read them; leave data: URIs and anything else exactly as given, since the
 * page CSP is the thing deciding what is loadable. (Unchanged from the three.js shelf.)
 */
function resolveSrc(src: string): string {
  const path = toDiskPath(src)
  if (!path) return src
  return `${BRIDGE_HTTP_URL}/file?path=${encodeURIComponent(path)}`
}

type Entry = {
  def: OrbitObject
  el: HTMLImageElement
  /** Accumulated, not derived from the clock: a speed change never teleports. */
  angle: number
  aspect: number
  ready: boolean
  /** The current source failed and the image faded out; the next good load brings it back. */
  dead: boolean
  /** Bumped on every load, so the slower of two in-flight sources never wins. */
  token: number
  pop: { v: number }
  w: number
  h: number
  front: boolean | null
}

const DEG = Math.PI / 180
const RPM = (Math.PI * 2) / 60

export function startOrbits(layer: HTMLElement, reduce: boolean): () => void {
  const entries = new Map<string, Entry>()
  const leaving = new Set<Entry>()
  let seen: OrbitObject[] | null = null
  let half = Math.min(innerWidth, innerHeight) / 2
  const onResize = () => { half = Math.min(innerWidth, innerHeight) / 2 }
  addEventListener('resize', onResize)

  /** `size` is the longer edge in CSS px; layout is written only when it changes. */
  const fit = (e: Entry) => {
    const s = e.def.size
    const wide = e.aspect >= 1
    const w = wide ? s : s * e.aspect
    const h = wide ? s / e.aspect : s
    if (w === e.w && h === e.h) return
    e.w = w
    e.h = h
    e.el.style.width = `${w}px`
    e.el.style.height = `${h}px`
  }
  const pop = (e: Entry, on: boolean, done?: () => void) => {
    if (reduce) { e.pop.v = on ? 1 : 0; done?.(); return }
    if (on) animate(e.pop, { v: 1, duration: 560, ease: 'outBack(1.7)' })
    else animate(e.pop, { v: 0, duration: 260, ease: 'in(2)', onComplete: () => done?.() })
  }
  const attach = (e: Entry, src: string) => {
    const mine = ++e.token
    e.el.onload = () => {
      if (e.token !== mine || entries.get(e.def.id) !== e) return
      const { naturalWidth: w, naturalHeight: h } = e.el
      e.aspect = w && h ? w / h : 1
      fit(e)
      if (!e.ready || e.dead) { e.ready = true; e.dead = false; pop(e, true) }
    }
    e.el.onerror = () => {
      if (e.token !== mine) return
      // One line, once; the entry stays invisible until a later source loads.
      // Chromium has already dropped the old picture by now, so this is a quiet
      // scale-down of an empty box; `ready` stays set so drop() still animates.
      console.warn('[jarvis] orbit image failed to load', e.def.id, src)
      e.dead = true
      pop(e, false)
    }
    // An <img> keeps showing the old picture until the new one decodes: a swap never blinks.
    e.el.src = resolveSrc(src)
  }
  const spawn = (def: OrbitObject): Entry => {
    const el = document.createElement('img')
    el.className = 'orb-orbit'
    el.alt = ''
    el.decoding = 'async'
    el.draggable = false
    layer.appendChild(el)
    return { def, el, angle: def.phase * DEG, aspect: 1, ready: false, dead: false, token: 0, pop: { v: 0 }, w: 0, h: 0, front: null }
  }
  const drop = (e: Entry) => {
    e.token++
    e.el.onload = e.el.onerror = null
    if (!e.ready) { e.el.remove(); return }
    leaving.add(e)
    pop(e, false, () => { e.el.remove(); leaving.delete(e) })
  }
  const sync = (list: OrbitObject[]) => {
    const alive = new Set<string>()
    for (const def of list) {
      alive.add(def.id)
      const e = entries.get(def.id)
      if (!e) {
        const n = spawn(def)
        entries.set(def.id, n) // registered before the load starts: onload looks itself up
        attach(n, def.src)
        continue
      }
      if (e.def.src !== def.src) attach(e, def.src)
      if (e.def.phase !== def.phase) e.angle = def.phase * DEG // a re-stated phase repositions
      e.def = def
      fit(e)
    }
    for (const [id, e] of entries) if (!alive.has(id)) { entries.delete(id); drop(e) }
  }
  const place = (e: Entry, dt: number) => {
    if (!e.ready) return
    const def = e.def
    if (!reduce) e.angle += (dt / 1000) * def.speed * RPM
    // radius is a share of the shorter axis, as before: 0.6 lands on the bold ring (60vmin stage).
    const dist = def.radius * half
    const tilt = def.tilt * DEG
    const sin = Math.sin(e.angle)
    const x = Math.cos(e.angle) * dist
    const y = -sin * dist * Math.cos(tilt) // y up, so direction and phase read exactly as the three.js shelf did
    const depth = sin * Math.sin(tilt) // +1 = nearest the viewer
    const v = e.pop.v
    e.el.style.transform =
      `translate3d(${(x - e.w / 2).toFixed(1)}px, ${(y - e.h / 2).toFixed(1)}px, 0) scale(${(Math.max(0, v) * (1 + 0.14 * depth)).toFixed(3)})`
    e.el.style.opacity = (def.opacity * utils.clamp(v, 0, 1) * (0.82 + 0.18 * depth)).toFixed(3)
    const front = depth >= 0
    if (front !== e.front) {
      e.front = front
      e.el.style.zIndex = front ? '3' : '1' // .orb-stage is z 2: the far half passes behind the orb
    }
  }

  let last = 0
  createTimer({
    frameRate: 60,
    onUpdate: (self) => {
      const t = self.currentTime
      const dt = Math.min(64, Math.max(0, t - last))
      last = t
      const list = useStore.getState().ui.orbits
      if (list !== seen) { seen = list; sync(list) } // identity check: free while idle
      for (const e of entries.values()) place(e, dt)
      for (const e of leaving) place(e, dt)
    },
  })

  return () => {
    removeEventListener('resize', onResize)
    for (const e of [...entries.values(), ...leaving]) {
      utils.remove(e.pop)
      e.el.onload = e.el.onerror = null
      e.el.remove()
    }
    entries.clear()
    leaving.clear()
  }
}
