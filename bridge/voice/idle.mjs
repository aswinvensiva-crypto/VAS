/**
 * Let something expensive go once it has gone unused for a while.
 *
 * Whisper is the bridge's biggest tenant: the model plus onnxruntime's memory
 * arena, which grows to fit the largest input it has seen and never shrinks,
 * comes to most of a gigabyte. A dormant JARVIS needs none of it — the wake
 * word runs on the small spotter in the other worker — so after a few quiet
 * minutes the Whisper thread is ended, and the next command starts it again
 * (about a second, under the wake chime).
 *
 * `touch()` at the start and end of each use; `release` runs `ms` after the
 * last one, unless a use is still in flight.
 *
 * @param {{ ms: number, release: () => void, setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout }} opts
 */
export function createIdleRelease({ ms, release, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer = null
  let busy = 0
  const arm = () => {
    if (timer) clearTimer(timer)
    timer = null
    if (busy > 0 || !(ms > 0)) return
    timer = setTimer(() => {
      timer = null
      if (busy === 0) release()
    }, ms)
    timer?.unref?.()
  }
  return {
    /** Wrap one use: the clock stops while it runs and restarts when it ends. */
    async use(fn) {
      busy++
      if (timer) clearTimer(timer)
      timer = null
      try {
        return await fn()
      } finally {
        busy--
        arm()
      }
    },
    cancel() {
      if (timer) clearTimer(timer)
      timer = null
    },
  }
}
