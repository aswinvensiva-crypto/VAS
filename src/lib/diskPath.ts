/**
 * Is this src a file on this machine's disk, and if so which one?
 *
 * Images JARVIS shows often live on disk — a screenshot it just took, a render
 * a tool saved — and a page cannot load those directly, so the face routes
 * them through the bridge's /file endpoint. The hard part is telling a real
 * disk path from an app-relative URL that merely starts with a slash:
 * `/vite.svg` is one of our own assets, `/Users/you/shot.png` is a file.
 *
 * One test, shared by the panels, the blades and the orbit shelf, so the list
 * of roots cannot drift between them. Windows drive paths (`C:\…`, `C:/…`,
 * `file:///C:/…`) count; network shares (`\\server\…`) never do, because the
 * bridge has no business reaching across the network on a model's say-so.
 */
const POSIX_ROOT =
  /^\/(Users|home|root|Volumes|Applications|System|Library|private|tmp|var|opt|mnt|media|srv|data)\//

const DRIVE = /^[A-Za-z]:[\\/]/

/** The absolute disk path a src names, or null if it is not one. */
export function toDiskPath(raw: string): string | null {
  let s = String(raw ?? '').trim()
  if (!s) return null
  if (/^file:/i.test(s)) {
    s = s.replace(/^file:\/\//i, '')
    try {
      s = decodeURIComponent(s)
    } catch {
      return null
    }
    // file:///C:/x arrives here as /C:/x.
    if (/^\/[A-Za-z]:[\\/]/.test(s)) s = s.slice(1)
  }
  if (s.startsWith('\\\\') || s.startsWith('//')) return null
  if (DRIVE.test(s) || POSIX_ROOT.test(s)) return s
  return null
}
