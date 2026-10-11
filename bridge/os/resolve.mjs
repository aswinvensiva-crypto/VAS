/**
 * "Open VS Code" -> which Start menu entry.
 *
 * Pure: a spoken name and the catalog in, a scored best guess out. Names are
 * normalised the way speech arrives — "Notepad++" is "notepad plus plus",
 * nobody says the ® — and then tried from the most to the least certain kind
 * of match. The scores are a ladder, not a probability: what matters is that
 * an alias beats an exact name beats a prefix beats a fuzzy guess.
 *
 * Two results matter as much as the winner. When two different apps score
 * nearly the same, the caller should ask which one ("the insiders one?")
 * rather than guess. And below 0.6 nothing is close enough: "open the pod bay
 * doors" is a question for Claude, not a launch.
 */

/** Below this, nothing in the Start menu is what was asked for. */
const MIN_SCORE = 0.6
/** Two candidates this close are a coin toss, so the user is asked. */
const AMBIGUOUS_GAP = 0.05
/** …but only when both are plausible at all. */
const AMBIGUOUS_FLOOR = 0.75
/** Choices read aloud: more than a handful cannot be held in the head. */
const MAX_CHOICES = 5
/** Float slack, so 0.9 - 0.05 still counts 0.85 as "within". */
const EPS = 1e-9

/**
 * A name as it would be spoken.
 *
 * "++" is spelled out before punctuation is dropped, or Notepad++ would become
 * plain "notepad" and collide with Notepad. Accents are folded because speech
 * recognisers drop them as often as not. "the"/"my" in front and "app" behind
 * are filler ("open my Spotify app").
 */
export function normalizeName(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[®™©]/g, '')
    .replace(/\+\+/g, ' plus plus ')
    .replace(/\+/g, ' plus ')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:the|my) /, '')
    .replace(/ (?:app|application)$/, '')
}

/**
 * What people call their apps, mapped to the catalog name it means.
 *
 * `name` must match exactly; `prefix` takes the first entry starting with it,
 * so "vs code" finds Visual Studio Code or, on a machine with only the
 * Insiders build, "Visual Studio Code - Insiders". PowerShell and VLC are
 * pinned to the exact name because their Start menus also list (x86), ISE and
 * "reset preferences" entries nobody means by the bare word.
 */
export const DEFAULT_ALIASES = Object.freeze({
  'vs code': { prefix: 'Visual Studio Code' },
  'vscode': { prefix: 'Visual Studio Code' },
  'visual studio code': { prefix: 'Visual Studio Code' },
  'code': { prefix: 'Visual Studio Code' },
  'my editor': { prefix: 'Visual Studio Code' },
  'chrome': { name: 'Google Chrome' },
  'browser': { name: 'Google Chrome' },
  'google': { name: 'Google Chrome' },
  'edge': { name: 'Microsoft Edge' },
  'cmd': { name: 'Command Prompt' },
  'command prompt': { name: 'Command Prompt' },
  'command line': { name: 'Command Prompt' },
  'powershell': { name: 'Windows PowerShell' },
  'explorer': { name: 'File Explorer' },
  'files': { name: 'File Explorer' },
  'file manager': { name: 'File Explorer' },
  'calc': { name: 'Calculator' },
  'zoom': { prefix: 'Zoom' },
  'vlc': { name: 'VLC media player' },
  'settings': { name: 'Settings' },
  'store': { name: 'Microsoft Store' },
})

/** Alias tables keyed by normalised phrase, so "My Editor" and "my editor" are one key. */
const normalizeKeys = (map) => {
  const out = new Map()
  for (const [k, v] of Object.entries(map ?? {})) out.set(normalizeName(k), v)
  return out
}
const DEFAULTS = normalizeKeys(DEFAULT_ALIASES)

const findByMatcher = (apps, { name, prefix }) => {
  if (name) {
    const want = normalizeName(name)
    return apps.find((a) => a.norm === want)
  }
  const want = normalizeName(prefix)
  return apps.find((a) => a.norm.startsWith(want))
}

/** Jaro-Winkler similarity, 0..1, with the usual 0.1 prefix weight over at most 4 characters. */
export function jaroWinkler(a, b) {
  if (a === b) return 1
  if (!a.length || !b.length) return 0
  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1)
  const aHit = Array.from({ length: a.length }, () => false)
  const bHit = Array.from({ length: b.length }, () => false)
  let matches = 0
  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - window)
    const hi = Math.min(b.length - 1, i + window)
    for (let j = lo; j <= hi; j++) {
      if (bHit[j] || a[i] !== b[j]) continue
      aHit[i] = bHit[j] = true
      matches++
      break
    }
  }
  if (!matches) return 0
  let half = 0
  for (let i = 0, j = 0; i < a.length; i++) {
    if (!aHit[i]) continue
    while (!bHit[j]) j++
    if (a[i] !== b[j]) half++
    j++
  }
  const m = matches
  const jaro = (m / a.length + m / b.length + (m - half / 2) / m) / 3
  let prefix = 0
  while (prefix < 4 && prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++
  return jaro + prefix * 0.1 * (1 - jaro)
}

/** Every query token is the start of a name token, in order ("code ins" ~ "visual studio code insiders"). */
function tokensInOrder(q, n, from = 0) {
  let j = from
  for (const tok of q) {
    while (j < n.length && !n[j].startsWith(tok)) j++
    if (j === n.length) return false
    j++
  }
  return true
}

/** "vs code" ~ "visual studio code": the first spoken token spells the name's leading initials. */
function acronymMatch(q, n) {
  const [head, ...rest] = q
  if (!head || head.length < 2 || head.length > n.length) return false
  for (let i = 0; i < head.length; i++) if (n[i][0] !== head[i]) return false
  return tokensInOrder(rest, n, head.length)
}

/**
 * The best rule this app satisfies, from exact name down to a fuzzy guess.
 * Spacing is ignored for an exact match, since recognisers split compound
 * names as often as not ("power point").
 */
function scoreName(query, qTokens, app) {
  if (app.norm === query || app.norm.replaceAll(' ', '') === query.replaceAll(' ', '')) return 0.98
  if (app.norm.startsWith(query)) return 0.9
  if (tokensInOrder(qTokens, app.tokens)) return 0.85
  if (acronymMatch(qTokens, app.tokens)) return 0.8
  return jaroWinkler(query, app.norm) * 0.8
}

/**
 * Which app a spoken name means.
 *
 * `aliases` are the user's own, learned after they picked from an ambiguous
 * list: normalised phrase -> AppID. They outrank everything, since they are
 * the user saying exactly what they meant once already.
 *
 * Each app keeps only its best score; ties go to the shorter name, which is
 * nearly always the plain app over its variants ("Windows PowerShell" over
 * "Windows PowerShell (x86)").
 *
 * @param {string} query
 * @param {{ apps: Array<{ name: string, appId: string }> } | Array<{ name: string, appId: string }>} catalog
 * @param {{ aliases?: Record<string, string> }} [opts]
 * @returns {{ best: { app: object, score: number } | null,
 *             ambiguous: Array<{ app: object, score: number }> | null }}
 */
export function resolveApp(query, catalog, { aliases = {} } = {}) {
  const none = { best: null, ambiguous: null }
  const q = normalizeName(query)
  if (!q) return none
  const list = Array.isArray(catalog) ? catalog : catalog?.apps ?? []
  const apps = list
    .filter((a) => a && typeof a.name === 'string' && typeof a.appId === 'string')
    .map((app) => {
      const norm = normalizeName(app.name)
      return { app, norm, tokens: norm.split(' ').filter(Boolean) }
    })
  if (!apps.length) return none

  /** @type {Map<string, { app: object, score: number }>} best score per AppID */
  const scores = new Map()
  const offer = (entry, score) => {
    const prev = scores.get(entry.app.appId)
    if (!prev || score > prev.score) scores.set(entry.app.appId, { app: entry.app, score })
  }

  const userAppId = normalizeKeys(aliases).get(q)
  if (typeof userAppId === 'string') {
    const hit = apps.find((a) => a.app.appId === userAppId)
    if (hit) offer(hit, 1)
  }
  const matcher = DEFAULTS.get(q)
  if (matcher) {
    const hit = findByMatcher(apps, matcher)
    if (hit) offer(hit, 0.99)
  }
  const qTokens = q.split(' ')
  for (const entry of apps) offer(entry, scoreName(q, qTokens, entry))

  const ranked = [...scores.values()].sort(
    (x, y) => y.score - x.score || x.app.name.length - y.app.name.length,
  )
  const [top, second] = ranked
  if (!top || top.score < MIN_SCORE) return none

  const near = (c) => c.score >= top.score - AMBIGUOUS_GAP - EPS && c.score >= AMBIGUOUS_FLOOR
  const ambiguous = second && near(second) && top.score >= AMBIGUOUS_FLOOR
    ? ranked.filter(near).slice(0, MAX_CHOICES)
    : null
  return { best: top, ambiguous }
}
