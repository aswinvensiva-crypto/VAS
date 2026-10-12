/**
 * JARVIS local bridge.
 *
 * Runs the Claude Agent SDK — Claude Code as a library — and exposes one turn
 * of conversation over a WebSocket. The browser stays the face and the voice;
 * this process is the brain and the hands.
 *
 * Two things this buys over calling the Claude API from the browser:
 *   1. No API key. It authenticates exactly the way `claude` does, off your
 *      existing login, and bills to that same account.
 *   2. Every MCP server in your Claude Code config is available, including the
 *      local stdio ones a browser could never reach — higgsfield, elevenlabs,
 *      android, playwright, palmier-pro and the rest.
 *
 *   node bridge/server.mjs
 */

import { WebSocketServer } from 'ws'
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk'
import { displayServer } from './panels.mjs'
import { uiServer } from './ui.mjs'
import { chromeAvailable, chromeServer } from './chrome.mjs'
import { visionServer } from './vision.mjs'
import { createPolicy, sessionTools } from './policy.mjs'
import { createGate } from './gate.mjs'
import { buildSystemPrompt } from './persona.mjs'
import { createBrain } from './neurons/brain.mjs'
import { registry as NEURONS } from './neurons/registry.mjs'
import { createLocal } from './neurons/local.mjs'
import { neuronsServer } from './neurons/mcp.mjs'
import { loadCorrections } from './corrections/store.mjs'
import { dataDir } from './store/files.mjs'
import { loadConfig } from './store/config.mjs'
import { createVoiceEngine } from './voice/engine.mjs'
import { handleSegment } from './voice/stt.mjs'
import { parseWav } from './voice/wav.mjs'
import { scribeTranscribe } from './voice/scribe.mjs'
import { loadSpeaker } from './voice/speaker.mjs'
import { createEnrollment } from './voice/enroll.mjs'
import { utterances } from './voice/utterances.mjs'
import { fetchModels, MODELS, status as modelStatus } from './voice/models.mjs'
import { homedir, tmpdir } from 'node:os'
import { mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { timingSafeEqual } from 'node:crypto'
import { isAbsolute, join, relative, resolve as resolvePath } from 'node:path'
import { openRemote, proxyError, vetTarget, PROXY_UA } from './net.mjs'
import { probeUrl, renderPage } from './page.mjs'

/**
 * Which port to listen on. 0 asks the OS for a free one, which is what the
 * desktop app does; the real port is read back once the server is listening.
 */
let PORT = Number(process.env.JARVIS_BRIDGE_PORT ?? 8787)

/**
 * The SDK entry point. Tests swap in a fake that records the options and
 * echoes text back, so the bridge's own behaviour can be checked without
 * spending a Claude turn.
 */
const query =
  process.env.JARVIS_FAKE_SDK === '1'
    ? (await import('../test/fixtures/fake-query.mjs')).query
    : sdkQuery

/**
 * A shared secret for this run, handed to the bridge by whoever started it.
 *
 * The Origin header keeps other web pages out, but any program on this machine
 * can claim any Origin it likes. The desktop app generates a fresh token at
 * every launch and presents it on every request (a header for HTTP, a
 * subprotocol for the socket), so only the window it opened can drive JARVIS.
 *
 * Running without one is only for the browser debug setup (npm start), and it
 * has to be asked for by name with --insecure-dev: a missing variable is a
 * mistake, not a mode, and an unauthenticated bridge must never be what a
 * mistake produces.
 */
const TOKEN = process.env.JARVIS_BRIDGE_TOKEN || null
const INSECURE_DEV = process.argv.includes('--insecure-dev')
if (!TOKEN && !INSECURE_DEV) {
  console.error(
    '[jarvis] refusing to start: JARVIS_BRIDGE_TOKEN is not set. The VAS app sets it; ' +
      'for browser debugging run `npm start`, which starts the bridge with --insecure-dev.',
  )
  process.exit(1)
}

/** VAS settings (%APPDATA%\VAS\data\config.json), and the local voice engine. */
const CONFIG = await loadConfig()
const VOICE = createVoiceEngine({ config: CONFIG })

/**
 * JARVIS's neurons: spoken orders that run here without Claude (bridge/neurons),
 * and the mishearings he has learned to fix (bridge/corrections).
 */
const BRAIN = createBrain({ known: new Set(NEURONS.keys()) })
const CORRECTIONS = await loadCorrections()

/**
 * "Only respond to my voice": the enrolled voiceprint (null until you enroll),
 * and whose voice the latest segment was in — which the permission gate reads
 * when it judges a spoken yes.
 */
let SPEAKER = loadSpeaker()
const HEARD = { verdict: 'unknown', at: 0, ownerAt: 0 }
const voiceCheck = () => {
  if (!SPEAKER) return { verdict: 'unenrolled', ownerRecently: false }
  const fresh = Date.now() - HEARD.at < 30_000
  return { verdict: fresh ? HEARD.verdict : 'unknown', ownerRecently: Date.now() - HEARD.ownerAt < 60_000 }
}
/**
 * Downloading the voice models, from the face's "Download voice models"
 * button — never on its own. One download at a time; the face polls progress.
 */
const DOWNLOAD = { running: false, progress: null, error: null, done: false }
/** What a first install needs; Whisper small is an optional upgrade. */
const ESSENTIAL_MODELS = ['kws', 'whisper-base', 'speaker']
function startModelDownload(names) {
  if (DOWNLOAD.running) return
  Object.assign(DOWNLOAD, { running: true, progress: null, error: null, done: false })
  fetchModels(names, (p) => {
    DOWNLOAD.progress = p
  })
    .then(() => {
      // The keyword file can only be written once the model is there.
      VOICE.setConfig(CONFIG)
      DOWNLOAD.done = true
    })
    .catch((err) => {
      DOWNLOAD.error = err.message
    })
    .finally(() => {
      DOWNLOAD.running = false
    })
}

const ENROLL = createEnrollment({
  engine: VOICE,
  // Finishing tunes the wake word to the voice: into CONFIG, live, and config.json.
  config: CONFIG,
  onChange: () => {
    SPEAKER = loadSpeaker()
  },
})

function tokenOk(presented) {
  if (!TOKEN) return true
  if (typeof presented !== 'string') return false
  const a = Buffer.from(presented)
  const b = Buffer.from(TOKEN)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** The token as the socket presents it: one of its offered subprotocols. */
function socketToken(req) {
  const offered = String(req.headers['sec-websocket-protocol'] ?? '')
    .split(',')
    .map((s) => s.trim())
  const entry = offered.find((p) => p.startsWith('vas.token.'))
  return entry ? entry.slice('vas.token.'.length) : null
}

/**
 * A crash here takes the whole assistant down mid-sentence, and most of what
 * can reject is out of our hands — a socket dying under a write, an upstream
 * fetch aborting. Log it and keep serving; the turn that failed will surface
 * its own error to the browser.
 */
process.on('unhandledRejection', (err) => {
  console.error('[jarvis] unhandled rejection:', err)
})

/**
 * Who is allowed to talk to this bridge.
 *
 * A WebSocket handshake is not subject to the same-origin policy: the browser
 * sends it on behalf of whatever page asked, no preflight stands in the way,
 * and the page reads every byte that comes back. Without a check here, any tab
 * the user happens to have open could open a socket to ws://localhost:8787,
 * drive the agent with every MCP server on this machine, and read back every
 * token and panel. The Origin header is the only thing that separates our own
 * dev server from someone else's page, so it is checked explicitly.
 *
 * A missing Origin means a non-browser client — curl, a script, a native app.
 * That is also exactly what local malware looks like, so it is refused on the
 * socket unless JARVIS_ALLOW_NO_ORIGIN=1 says otherwise.
 */
const EXTRA_ORIGINS = new Set(
  (process.env.JARVIS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean),
)
const ALLOW_NO_ORIGIN = process.env.JARVIS_ALLOW_NO_ORIGIN === '1'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Vite takes the next free port when 5173 is busy and `vite preview` starts at
 * 4173, so the dev ranges are allowed rather than two exact numbers. Anything
 * else — including localhost on a port some other app is serving — has to be
 * named in JARVIS_ALLOWED_ORIGINS.
 */
const isDevPort = (port) =>
  (port >= 5173 && port <= 5199) || (port >= 4173 && port <= 4199)

/** The desktop app serves the face from its own privileged scheme. */
const APP_ORIGIN = 'app://vas'
/** An installed VAS has no dev server: only its own face may connect. */
const APP_ONLY = process.env.JARVIS_APP_ONLY === '1'

function originAllowed(origin) {
  if (!origin) return ALLOW_NO_ORIGIN
  if (origin.replace(/\/+$/, '') === APP_ORIGIN) return true
  if (EXTRA_ORIGINS.has(origin.replace(/\/+$/, ''))) return true
  if (APP_ONLY) return false
  let url
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (url.protocol !== 'http:') return false
  if (!LOCAL_HOSTS.has(url.hostname)) return false
  return isDevPort(Number(url.port))
}

/**
 * Voice is a bad interface for a confirmation dialog: there is no window to
 * click and the model can't pause for one. So the bridge decides.
 *
 * Read-only and generative tools run freely. Anything that writes to disk,
 * runs a shell, or changes the world waits for JARVIS_ALLOW_WRITES=1. Start
 * without it, and turn it on once you trust what you're demoing.
 */
const ALLOW_WRITES =
  process.env.JARVIS_ALLOW_WRITES === '1' || process.argv.includes('--writes')

const { decideTool } = createPolicy({ allowWrites: ALLOW_WRITES })

/**
 * The orchestrator model. Override with JARVIS_MODEL to trade quality for pace
 * — claude-sonnet-5 is noticeably snappier on camera if Opus feels slow.
 */
const MODEL = process.env.JARVIS_MODEL ?? 'claude-opus-5'

/**
 * How hard the model thinks before answering.
 *
 * This was 'low', on the reasoning that a voice assistant is judged on latency
 * — and that is true right up until the answer is thin. Low effort scopes the
 * work tightly to what was literally asked: fewer tool calls, less
 * cross-referencing, no second look. On a model of this tier that is leaving
 * most of it on the table.
 *
 * 'medium' is the compromise worth having here. It reasons and reaches for
 * tools noticeably more than 'low' while still answering inside the window a
 * spoken conversation tolerates. Raise it to 'high' or 'xhigh' when quality
 * matters more than pace; drop back to 'low' when filming and every second of
 * dead air shows.
 */
const EFFORT = process.env.JARVIS_EFFORT ?? 'medium'

/**
 * Where the agent runs. Its own empty folder rather than the home directory:
 * file tools are switched off by default anyway (see sessionTools), and if
 * --writes turns them back on, an empty working folder is a far better place
 * for a misheard instruction to land than the root of the user's files.
 */
const WORKSPACE = join(dataDir(), 'workspace')
mkdirSync(WORKSPACE, { recursive: true })


/**
 * Every MCP server Claude Code has configured, read out of its own config.
 *
 * This does two jobs. The HUD wants the names while the boot animation plays,
 * and the agent doesn't emit its init message — and therefore its server
 * list — until the first user message flows through, which is far too late.
 * More importantly, this bridge turns filesystem settings off (see
 * settingSources below) and the SDK stops discovering these servers on its
 * own, so handing them over explicitly is what keeps the local stdio ones —
 * the whole reason the bridge exists — in play.
 *
 * Only the global block and the home-directory project scope, because
 * homedir() is our cwd. That makes the list a close but not exact match for
 * the agent's own: the 'ready' sent on connect comes from here and the second
 * one, sent from the init message a turn later, carries live status. Expect
 * the two to differ, and treat the later one as authoritative.
 */
function configuredServers() {
  try {
    const cfg = JSON.parse(
      readFileSync(join(homedir(), '.claude.json'), 'utf8'),
    )
    // Claude Code keys projects by path with forward slashes even on Windows
    // ("C:/Users/you"), while homedir() returns backslashes, so compare both
    // spellings, case-insensitively as Windows paths are.
    const home = homedir().replace(/\\/g, '/').toLowerCase()
    const homeProject = Object.entries(cfg.projects ?? {}).find(
      ([path]) => path.replace(/\\/g, '/').toLowerCase() === home,
    )?.[1]
    return {
      ...(cfg.mcpServers ?? {}),
      // Servers scoped to the home directory apply too, since that's our cwd.
      ...(homeProject?.mcpServers ?? {}),
    }
  } catch {
    return {}
  }
}

const MCP_SERVERS = configuredServers()


/**
 * The system prompt, built when a conversation starts so it carries what VAS
 * knows about this PC at that moment: the apps the user has let JARVIS open,
 * the routines they taught, and the mishearings it has learned. Read straight
 * from memory and one small file, so starting a session stays instant.
 */
function systemPromptNow() {
  let apps = []
  try {
    const saved = JSON.parse(readFileSync(join(dataDir(), 'apps.json'), 'utf8'))
    apps = Object.values(saved.allow ?? {}).map((a) => a?.name).filter(Boolean)
  } catch {
    /* nothing allowed yet */
  }
  const routines = BRAIN.userSynapses()
    .map((s) => s.signals?.[0]?.order)
    .map((o) => (typeof o === 'string' ? o : o?.text))
    .filter(Boolean)
  const corrections = CORRECTIONS.list().map(({ heard, meant }) => ({ heard, meant }))
  return buildSystemPrompt({ userName: CONFIG.userName, apps, routines, corrections })
}

/**
 * ElevenLabs credentials, borrowed from the MCP server config.
 *
 * If you've set up the elevenlabs MCP server, the key is already on this
 * machine — no reason to make you paste it into a second .env file. The browser
 * never sees it: it POSTs text to /tts here and gets audio back.
 */
function elevenKey() {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY
  try {
    const cfg = JSON.parse(
      readFileSync(join(homedir(), '.claude.json'), 'utf8'),
    )
    return cfg.mcpServers?.elevenlabs?.env?.ELEVENLABS_API_KEY ?? null
  } catch {
    return null
  }
}

const VOICE_ID = process.env.JARVIS_VOICE_ID ?? 'JBFqnCBsd6RMkjVDRZzb'

/**
 * Where /file is permitted to read from, and how big a read may get.
 *
 * The roots are realpath'd once at boot so the containment check below compares
 * like with like — on macOS os.tmpdir() is a symlink into /private/var, and a
 * string prefix test against the unresolved form would reject every screenshot.
 */
const IMAGE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  // .svg is deliberately absent. An SVG is a scriptable document, and this
  // endpoint serves it from the bridge's own origin — the one origin allowed
  // to open the agent socket. A picture is not worth that.
}

const MAX_FILE_BYTES = 25 * 1024 * 1024

const FILE_ROOTS = [
  homedir(),
  // Both temp directories, because on macOS os.tmpdir() is the per-user
  // $TMPDIR under /var/folders while half the tools that take a screenshot
  // still write it to /tmp. Dropping one of them loses real panels.
  tmpdir(),
  // On Windows '/tmp' resolves to C:\tmp, which nothing writes to.
  ...(process.platform === 'win32' ? [] : ['/tmp']),
  ...(process.env.JARVIS_FILE_ROOTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
].map((root) => {
  try {
    return realpathSync(root)
  } catch {
    return resolvePath(root)
  }
})

/** True when `real` sits inside one of the roots, after both are resolved. */
const withinRoots = (real) =>
  FILE_ROOTS.some((root) => {
    const rel = relative(root, real)
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
  })

// ---------------------------------------------------------------------------

/**
 * Remote media, fetched by the bridge instead of by the page.
 *
 * JARVIS used to refuse to show anything he found on the web, and the refusal
 * was not squeamishness — a bare <img src="https://some-cdn/..."> in a panel
 * genuinely did not work. Three reasons, and all three are fixed by moving the
 * fetch to this side of the wire:
 *
 *   1. Hotlink blocking. News sites and image CDNs check Referer and User-Agent
 *      and hand a browser-that-isn't-their-page a 403 or a placeholder. That is
 *      why thumbnails rendered as empty rectangles. A server-side fetch that
 *      looks like an ordinary browser and sends no referrer gets the bytes.
 *   2. Privacy. Panel HTML is authored by a model that has just been reading
 *      untrusted web pages, so a remote URL in it is a prompt-injection beacon:
 *      load it directly and the user's IP, and the fact they asked, go to a host
 *      the page chose. Proxying means the browser only ever talks to localhost
 *      and the page CSP can stay tight.
 *   3. One place to cap size, set timeouts and insist the bytes really are the
 *      media type they claim.
 *
 * The cost is that this process — unlike a browser tab — can reach the user's
 * LAN, their router's admin page, and cloud metadata endpoints. So everything
 * below is an SSRF gate first and a proxy second.
 */

const MAX_IMG_BYTES = 15 * 1024 * 1024
const MAX_MEDIA_BYTES = 200 * 1024 * 1024
const IMG_TIMEOUT_MS = 10_000
const MEDIA_TIMEOUT_MS = 30_000

// The SSRF gate and the guarded outbound clients now live in ./net.mjs, so the
// media proxy below and the page proxy share one implementation of the rules
// rather than two that can drift apart.

/**
 * The shared body of /img and /media.
 *
 * `kinds` is the list of content-type prefixes we are willing to hand back.
 * That check is load-bearing: without it this is an open proxy that will serve
 * an attacker's HTML from the bridge's own origin — the one origin allowed to
 * open the agent socket — which is the same reason IMAGE_TYPES has no .svg.
 */
async function proxyRemote(req, res, cors, { kinds, maxBytes, timeoutMs, ranged }) {
  const asked = new URL(req.url, 'http://x').searchParams.get('url') ?? ''
  const target = vetTarget(asked)

  const headers = {
    'user-agent': PROXY_UA,
    accept: ranged ? '*/*' : 'image/*,*/*;q=0.8',
    // Identity encoding so the byte cap counts the bytes we actually stream and
    // content-length means what it says. Media is already compressed anyway.
    'accept-encoding': 'identity',
  }
  // Range is the difference between a <video> that seeks and one Safari refuses
  // to play at all, so the browser's request is passed through verbatim.
  if (ranged && typeof req.headers.range === 'string') {
    headers.range = req.headers.range
  }

  const { res: upstream } = await openRemote(target, headers, timeoutMs)
  const status = upstream.statusCode ?? 0

  if (status !== 200 && status !== 206) {
    upstream.resume()
    throw proxyError(status === 404 ? 404 : 502, `upstream said ${status}`)
  }

  const type = String(upstream.headers['content-type'] ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase()
  if (!kinds.some((kind) => type.startsWith(kind))) {
    upstream.resume()
    throw proxyError(415, `not ${kinds.join(' or ')} (got ${type || 'nothing'})`)
  }

  const declared = Number(upstream.headers['content-length'])
  if (Number.isFinite(declared) && declared > maxBytes) {
    upstream.resume()
    throw proxyError(413, 'too large')
  }

  const out = {
    ...cors,
    'content-type': type,
    'x-content-type-options': 'nosniff',
    // Thumbnails get looked at, panelled again, and re-rendered on every HUD
    // repaint; re-fetching from the CDN each time is slow and rude.
    'cache-control': 'private, max-age=600',
  }
  if (Number.isFinite(declared)) out['content-length'] = String(declared)
  if (ranged) {
    // Only claim range support when the origin actually demonstrated it — a
    // 206, or an explicit accept-ranges of its own. Plenty of hosts ignore the
    // Range header and hand back the whole file with a 200; advertising
    // accept-ranges on top of that tells the video element it may seek by
    // issuing byte requests that will never be honoured, and the scrub bar
    // then misbehaves in a way that looks like our bug rather than theirs.
    if (status === 206 || upstream.headers['accept-ranges'] === 'bytes') {
      out['accept-ranges'] = 'bytes'
    }
    if (upstream.headers['content-range']) {
      out['content-range'] = upstream.headers['content-range']
    }
  }
  res.writeHead(status, out)

  // Stream with a running cap. Buffering a 200 MB video into this process
  // would stall the token stream the voice is riding on, and trusting
  // content-length would let a host that lies about it eat the heap.
  let sent = 0
  upstream.on('data', (chunk) => {
    sent += chunk.length
    if (sent > maxBytes) {
      // Headers went out long ago, so a truncated body is the only way left to
      // say no. The player sees a short read; we see this line in the log.
      console.warn(`[jarvis] proxy cut ${target.href} at ${maxBytes} bytes`)
      upstream.destroy()
      res.destroy()
      return
    }
    if (!res.write(chunk)) {
      upstream.pause()
      res.once('drain', () => upstream.resume())
    }
  })
  upstream.on('end', () => res.end())
  upstream.on('error', () => res.destroy())
  req.on('close', () => upstream.destroy())
}

// ---------------------------------------------------------------------------

/**
 * CORS, reflected rather than wildcarded.
 *
 * `*` on this origin means any page on the internet can read whatever the
 * bridge serves, so the same allowlist that guards the socket picks the
 * header. A request carrying an Origin we don't know is refused outright —
 * but a request with no Origin at all is served, because an <img src> load
 * (which is how panels fetch screenshots) never sends one.
 */
function corsFor(req) {
  const origin = req.headers.origin
  const headers = { vary: 'origin' }
  if (origin) {
    headers['access-control-allow-origin'] = origin
    headers['access-control-allow-headers'] = 'content-type, x-vas-token'
  }
  return headers
}

// One HTTP server for both the speech proxy and the WebSocket upgrade.
const http = await import('node:http')

const handleRequest = async (req, res) => {
  const origin = req.headers.origin
  if (origin && !originAllowed(origin)) {
    console.warn(`[jarvis] refused http request from origin ${origin}`)
    res.writeHead(403, { vary: 'origin' })
    return res.end('forbidden')
  }
  const cors = corsFor(req)

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors)
    return res.end()
  }

  if (!tokenOk(req.headers['x-vas-token'])) {
    res.writeHead(401, { vary: 'origin' })
    return res.end('unauthorized')
  }

  // Routes are matched on the path alone, so a query string never turns a real
  // endpoint into a 404.
  const pathname = new URL(req.url ?? '/', 'http://x').pathname

  if (req.method === 'GET' && pathname === '/health') {
    // The face reads this once at boot to decide how to listen and speak.
    // Transcription is available when the local Whisper model is installed or
    // an ElevenLabs key exists; the wake word when the keyword model is. The
    // ElevenLabs voice tracks the key. With nothing at all, the browser face
    // falls back to the browser's own recogniser and voice.
    const eleven = Boolean(elevenKey())
    const voice = VOICE.status()
    const sttEngine = eleven && CONFIG.stt.engine !== 'local' ? 'scribe' : voice.asr ? voice.whisper : null
    res.writeHead(200, { ...cors, 'content-type': 'application/json' })
    return res.end(
      JSON.stringify({
        ok: true,
        tts: eleven,
        stt: Boolean(sttEngine),
        sttEngine,
        kws: voice.kws,
        speaker: { available: voice.speaker, enrolled: Boolean(SPEAKER), require: CONFIG.owner.require },
        modelsMissing: voice.missing,
        user: { name: CONFIG.userName },
      }),
    )
  }

  // Serve local image files to the page. Screenshots and generated art land on
  // disk as absolute paths, and a page served over http can't read file:// —
  // so the bridge, which can, hands them over.
  if (req.method === 'GET' && pathname === '/file') {
    const asked = new URL(req.url, 'http://x').searchParams.get('path') ?? ''
    // Resolve symlinks BEFORE judging anything. A name ending in .png can be a
    // link pointing at /etc/hosts, and checking the suffix the caller supplied
    // would wave that straight through — which is exactly how this endpoint
    // used to serve the contents of arbitrary system files.
    let real = null
    try {
      if (isAbsolute(asked)) real = await realpath(asked)
    } catch {
      real = null
    }
    const dot = real ? real.lastIndexOf('.') : -1
    const ext = dot === -1 ? '' : real.slice(dot).toLowerCase()
    // Images only, absolute paths only, and only under roots we expect things
    // to be written to. This endpoint exists to show pictures, not to be a
    // general file read for whatever the model — or another page — asks for.
    if (!real || !Object.hasOwn(IMAGE_TYPES, ext) || !withinRoots(real)) {
      res.writeHead(400, cors)
      return res.end('images only')
    }
    try {
      const info = await stat(real)
      if (!info.isFile() || info.size > MAX_FILE_BYTES) {
        res.writeHead(413, cors)
        return res.end('too large')
      }
      // Asynchronous because this process is also pumping the agent's token
      // stream; a synchronous read of a large screenshot stalls the voice.
      const body = await readFile(real)
      res.writeHead(200, {
        ...cors,
        'content-type': IMAGE_TYPES[ext],
        'x-content-type-options': 'nosniff',
      })
      return res.end(body)
    } catch {
      res.writeHead(404, cors)
      return res.end('not found')
    }
  }

  // Remote images, fetched here so the page never talks to the wider web. The
  // renderer rewrites every http(s) <img src> in a panel to this endpoint.
  if (req.method === 'GET' && pathname === '/img') {
    try {
      await proxyRemote(req, res, cors, {
        kinds: ['image/'],
        maxBytes: MAX_IMG_BYTES,
        timeoutMs: IMG_TIMEOUT_MS,
        ranged: false,
      })
    } catch (err) {
      if (res.headersSent) return res.destroy()
      res.writeHead(err.status ?? 502, cors)
      return res.end(err.message ?? 'proxy failed')
    }
    return
  }

  // The same, for video and audio. Separate from /img because the limits and
  // the Range handling are genuinely different, not because the code is.
  if (req.method === 'GET' && pathname === '/media') {
    try {
      await proxyRemote(req, res, cors, {
        kinds: ['video/', 'audio/'],
        maxBytes: MAX_MEDIA_BYTES,
        timeoutMs: MEDIA_TIMEOUT_MS,
        ranged: true,
      })
    } catch (err) {
      if (res.headersSent) return res.destroy()
      res.writeHead(err.status ?? 502, cors)
      return res.end(err.message ?? 'proxy failed')
    }
    return
  }

  // A whole web page, fetched here and served from this origin so it can be
  // framed. The publisher's X-Frame-Options and CORS rules are enforced against
  // the browser, and from the browser's point of view this document is ours —
  // so an article that refuses to be embedded anywhere still opens on the
  // display. See page.mjs for what each mode does to the markup.
  //
  // No Origin header arrives on an iframe navigation, so this rides the same
  // path as an <img> load through the check at the top of this handler.
  if (req.method === 'GET' && pathname === '/page') {
    const asked = new URL(req.url, 'http://x')
    const target = asked.searchParams.get('url') ?? ''
    const mode = asked.searchParams.get('mode') === 'live' ? 'live' : 'reader'
    try {
      const page = await renderPage(target, mode, `http://127.0.0.1:${PORT}`)
      res.writeHead(200, { ...cors, ...page.headers })
      return res.end(page.body)
    } catch (err) {
      // Rendered as a page rather than returned as a status, because this lands
      // inside an iframe: a bare 502 body is a blank rectangle on the display,
      // which reads as the interface being broken rather than as the article
      // being unavailable.
      res.writeHead(err.status ?? 502, {
        ...cors,
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
      })
      return res.end(
        `<!doctype html><meta charset="utf-8"><style>
           body{margin:0;padding:26px;background:transparent;color:#7fb6bf;
                font:400 13px/1.6 ui-monospace,monospace}
           b{color:#cfe9ee;font-weight:500;display:block;margin-bottom:6px}
         </style><b>This page could not be opened.</b>${
           String(err?.message ?? 'unknown error').replace(/[<&]/g, '')
         }`,
      )
    }
  }

  if (req.method === 'POST' && pathname === '/tts') {
    const key = elevenKey()
    if (!key) {
      res.writeHead(503, cors)
      return res.end('no elevenlabs key')
    }
    // A spoken line is a few hundred bytes. Anything approaching this is not a
    // sentence, and buffering it unbounded would let one request eat the heap.
    let body = ''
    let overflowed = false
    for await (const chunk of req) {
      body += chunk
      if (body.length > 64 * 1024) {
        overflowed = true
        break
      }
    }
    if (overflowed) {
      req.destroy()
      res.writeHead(400, cors)
      return res.end('body too large')
    }
    // Inside a try: this handler is async with nothing catching its rejection,
    // so a malformed body used to take the entire bridge down with it.
    let text
    try {
      ;({ text } = JSON.parse(body || '{}'))
    } catch {
      res.writeHead(400, cors)
      return res.end('bad json')
    }
    if (!text) {
      res.writeHead(400, cors)
      return res.end('no text')
    }
    try {
      const upstream = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream` +
          // 22kHz mono is half the bytes of 44kHz and indistinguishable through
          // a laptop speaker; optimize_streaming_latency=3 trades a little
          // prosody for a much earlier first byte.
          `?output_format=mp3_22050_32&optimize_streaming_latency=3`,
        {
          method: 'POST',
          headers: { 'xi-api-key': key, 'content-type': 'application/json' },
          body: JSON.stringify({
            text,
            // Flash is the low-latency model — a conversation needs speed more
            // than it needs the last few percent of quality.
            model_id: 'eleven_flash_v2_5',
            voice_settings: {
              stability: 0.4,
              similarity_boost: 0.75,
              speed: 1.05,
            },
          }),
        },
      )
      if (!upstream.ok) {
        res.writeHead(upstream.status, cors)
        return res.end(await upstream.text())
      }

      // Pipe it through rather than buffering. Waiting for the whole file here
      // would throw away everything the streaming endpoint just bought us.
      res.writeHead(200, {
        ...cors,
        'content-type': 'audio/mpeg',
        'cache-control': 'no-cache',
      })
      for await (const chunk of upstream.body) res.write(Buffer.from(chunk))
      return res.end()
    } catch (err) {
      res.writeHead(502, cors)
      return res.end(String(err?.message ?? err))
    }
  }

  // Speech to text. The face posts one spoken segment — a 16 kHz WAV from its
  // own voice-activity detector — with what it is listening for (?mode=wake,
  // command or guard). Local keyword spotting and Whisper do the work; Scribe
  // is used when an ElevenLabs key exists and the settings allow it. See
  // bridge/voice/stt.mjs. Detecting that the user is speaking at all happens
  // in the face and never touches this endpoint.
  if (req.method === 'POST' && pathname === '/stt') {
    const mode = new URL(req.url, 'http://x').searchParams.get('mode') ?? 'command'
    const type = String(req.headers['content-type'] || '')
    const chunks = []
    let size = 0
    // A few seconds of 16 kHz audio is a few hundred kilobytes; 25 MB is a
    // generous ceiling that still refuses a runaway stream before it eats the heap.
    for await (const chunk of req) {
      chunks.push(chunk)
      size += chunk.length
      if (size > 25 * 1024 * 1024) {
        req.destroy()
        res.writeHead(413, cors)
        return res.end('audio too large')
      }
    }
    const json = (status, body) => {
      res.writeHead(status, { ...cors, 'content-type': 'application/json' })
      return res.end(JSON.stringify(body))
    }
    // Silence, or a click. Nothing to transcribe.
    if (size < 1200) return json(200, { text: '' })
    const audio = Buffer.concat(chunks)

    if (!type.includes('wav')) {
      // A compressed segment from an older face: only Scribe can read it —
      // and dormant audio never goes there, so a wake-mode one is refused.
      if (mode === 'wake') return json(415, { text: '', reason: 'send 16 kHz WAV' })
      const key = elevenKey()
      if (!key) return json(415, { text: '', reason: 'send 16 kHz WAV' })
      try {
        const text = await scribeTranscribe(audio, type, key, CONFIG.stt.language)
        const utt = utterances.put({ text, owner: SPEAKER ? 'unknown' : 'unenrolled', mode })
        return json(200, { text, engine: 'scribe', utt })
      } catch (err) {
        return json(502, { text: '', reason: String(err?.message ?? err) })
      }
    }

    let wav
    try {
      wav = parseWav(audio)
    } catch (err) {
      return json(400, { text: '', reason: err.message })
    }
    if (wav.sampleRate !== 16000) return json(415, { text: '', reason: 'expected 16 kHz audio' })
    const key = elevenKey()
    try {
      const out = await handleSegment({
        samples: wav.samples,
        wav: audio,
        mode,
        engine: VOICE,
        config: CONFIG,
        speaker: SPEAKER,
        scribe: key ? (buf) => scribeTranscribe(buf, 'audio/wav', key, CONFIG.stt.language) : null,
      })
      if (out.owner) {
        HEARD.verdict = out.owner.verdict
        HEARD.at = Date.now()
        if (out.owner.verdict === 'owner') HEARD.ownerAt = HEARD.at
      }
      // Mishearings you have corrected before are fixed here, before anything
      // acts on the words. The raw transcript rides along for learning.
      if (out.text) {
        out.raw = out.text
        out.text = CORRECTIONS.apply(out.text)
        if (out.wake) out.wake.trailing = out.text
      }
      // An id for this segment, so whatever it becomes — an ask, a spoken yes —
      // can be traced back to whose voice it was and what was really heard.
      out.utt = utterances.put({
        text: out.text,
        raw: out.raw ?? out.text,
        owner: out.owner?.verdict ?? (SPEAKER ? 'unknown' : 'unenrolled'),
        score: out.owner?.score,
        durationMs: Math.round(wav.samples.length / 16),
        mode,
      })
      return json(200, out)
    } catch (err) {
      console.error('[jarvis] transcription failed:', err)
      return json(500, { text: '', reason: 'transcription failed' })
    }
  }

  if (pathname === '/models/status' && req.method === 'GET') {
    const installed = await modelStatus()
    const missing = ESSENTIAL_MODELS.filter((m) => !installed[m])
    const bytes = missing.reduce((n, m) => n + MODELS[m].size, 0)
    res.writeHead(200, { ...cors, 'content-type': 'application/json' })
    return res.end(JSON.stringify({ installed, missing, bytes, ...DOWNLOAD }))
  }
  if (pathname === '/models/fetch' && req.method === 'POST') {
    const installed = await modelStatus()
    const want = ESSENTIAL_MODELS.filter((m) => !installed[m])
    if (want.length) startModelDownload(want)
    res.writeHead(202, { ...cors, 'content-type': 'application/json' })
    return res.end(JSON.stringify({ started: want }))
  }

  if (pathname.startsWith('/voice/')) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      chunks.push(chunk)
      size += chunk.length
      if (size > 25 * 1024 * 1024) return req.destroy()
    }
    try {
      const out = await ENROLL(req, pathname, new URL(req.url, 'http://x').searchParams, Buffer.concat(chunks))
      if (out) {
        res.writeHead(out[0], { ...cors, 'content-type': 'application/json' })
        return res.end(JSON.stringify(out[1]))
      }
    } catch (err) {
      res.writeHead(err.status ?? 400, { ...cors, 'content-type': 'application/json' })
      return res.end(JSON.stringify({ ok: false, reason: err.message }))
    }
  }

  res.writeHead(404, cors)
  res.end()
}

const server = http.createServer((req, res) => {
  // The handler is async, so anything it throws would otherwise become an
  // unhandled rejection and leave the browser waiting on a socket that is
  // never going to answer.
  handleRequest(req, res).catch((err) => {
    console.error('[jarvis] request failed:', err)
    if (!res.headersSent) res.writeHead(500)
    res.end()
  })
})

const wss = new WebSocketServer({
  server,
  // The handshake is the only place a page can be turned away, so it happens
  // here rather than after the socket is open. Rejections are logged loudly:
  // the likeliest cause is a dev server on an unexpected port, and a silent
  // 403 would look like the bridge simply isn't running.
  verifyClient: ({ origin, req }, done) => {
    const path = (req.url ?? '/').split('?')[0]
    if (path !== '/' && path !== '/ws') {
      console.warn(`[jarvis] rejected websocket on path ${path}`)
      return done(false, 403, 'Forbidden')
    }
    if (!originAllowed(origin)) {
      console.warn(
        `[jarvis] rejected websocket from origin ${origin ?? '(none)'}` +
          ' — set JARVIS_ALLOWED_ORIGINS to permit it',
      )
      return done(false, 403, 'Forbidden')
    }
    if (!tokenOk(socketToken(req))) {
      console.warn('[jarvis] rejected websocket without the session token')
      return done(false, 401, 'Unauthorized')
    }
    done(true)
  },
  // A browser that offers subprotocols must get one back or it drops the
  // socket. The token rides in as one of them; the reply names only the
  // protocol, so the secret is never echoed.
  handleProtocols: (protocols) => (protocols.has('vas.v1') ? 'vas.v1' : false),
})

/**
 * Loopback only. Listening on every interface put the agent socket — and
 * /file, /stt and /tts — on the local network, behind nothing but an Origin
 * header any program can forge.
 */
server.listen(PORT, '127.0.0.1', () => {
  PORT = server.address().port
  console.log(`[jarvis] bridge listening on ws://127.0.0.1:${PORT}`)
  console.log(
    TOKEN
      ? '[jarvis] session token required on every request'
      : '[jarvis] INSECURE DEV MODE: no session token — any program on this PC can drive JARVIS',
  )
  // The desktop app starts the bridge as a utility/child process and waits
  // for this before it opens the window.
  const listening = { type: 'listening', port: PORT }
  process.parentPort?.postMessage(listening)
  process.send?.(listening)
})

/**
 * Leaving cleanly: every open conversation closed (which stops its claude.exe),
 * then the process. Used for signals and for the watchdog below.
 */
let shuttingDown = false
function shutdown(why) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[jarvis] shutting down: ${why}`)
  for (const client of wss.clients) client.close(1001, 'bridge shutting down')
  server.close()
  setTimeout(() => process.exit(0), 500).unref()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

/**
 * Watchdog. If VAS is killed outright (Task Manager, a crash) nothing tells
 * this process, and it would sit on its port with a Claude session open. So
 * look for the parent every few seconds and leave when it is gone. The app
 * passes its own pid; anything else that starts the bridge is watched by ppid.
 */
const PARENT_PID = Number(process.env.JARVIS_PARENT_PID) || process.ppid
if (PARENT_PID > 0) {
  setInterval(() => {
    try {
      process.kill(PARENT_PID, 0)
    } catch (err) {
      if (err?.code === 'ESRCH') shutdown(`parent ${PARENT_PID} is gone`)
    }
  }, 5_000).unref()
}

/**
 * Whether the VAS window is on screen. The main process says so on every
 * show/hide (the face cannot tell: backgroundThrottling is off so JARVIS keeps
 * listening, which also pins document.visibilityState to "visible"). Used to
 * ask before the camera is used while nobody can see the window.
 */
let WINDOW_HIDDEN = process.env.JARVIS_START_HIDDEN === '1'
process.parentPort?.on('message', (event) => {
  const msg = event?.data
  if (msg?.type === 'window') WINDOW_HIDDEN = Boolean(msg.hidden)
})

console.log(
  (() => {
    const v = VOICE.status()
    const ears = elevenKey() && CONFIG.stt.engine !== 'local' ? 'ElevenLabs Scribe' : v.asr ? `local ${v.whisper}` : 'none (run npm run models)'
    const wake = v.kws ? 'on-device "Hey Jarvis"' : 'transcript match (keyword model missing)'
    const mouth = elevenKey() ? 'ElevenLabs voice' : 'system voice'
    return `[jarvis] hearing: ${ears} · wake word: ${wake} · speaking: ${mouth}`
  })(),
)
console.log(`[jarvis] model ${MODEL} · effort ${EFFORT}`)
console.log(
  `[jarvis] writes ${ALLOW_WRITES ? 'ENABLED' : 'disabled'}` +
    (ALLOW_WRITES ? '' : ' — start with --writes to permit shell/file/device actions'),
)
// Asynchronous, so it lands a beat after the rest of the banner. Worth printing
// at all because an extension that is simply not running is indistinguishable
// at the tool boundary from one that is broken, and this is the one place the
// difference can be stated before anybody asks a question that depends on it.
void chromeAvailable().then((ok) => {
  console.log(
    ok
      ? `[jarvis] browser control ready${ALLOW_WRITES ? ' (acting freely — --writes)' : ' (reading is free; clicking and typing ask first)'}`
      : '[jarvis] browser control unavailable — open Chrome with the Claude extension enabled',
  )
})

console.log(
  (APP_ONLY ? '[jarvis] accepting only the VAS window' : '[jarvis] accepting local dev origins') +
    (EXTRA_ORIGINS.size ? ` plus ${[...EXTRA_ORIGINS].join(', ')}` : '') +
    (ALLOW_NO_ORIGIN ? ' and clients that send no origin' : ''),
)

/**
 * What to tell the browser when a turn ends badly. Plain sentences, because
 * whatever reaches the client is liable to be spoken.
 */
const RESULT_FAILURES = {
  error_during_execution: 'The turn failed part way through.',
  error_max_turns: 'The turn ran too long and was stopped.',
  error_max_budget_usd: 'The budget for this turn ran out.',
  error_max_structured_output_retries: 'The answer could not be assembled.',
  default: 'The turn ended without an answer.',
}

wss.on('connection', (socket) => {
  console.log('[jarvis] client connected')

  // Answer the HUD straight away rather than making it wait for the agent's
  // first turn. Refined later by the real init message.
  socket.send(
    JSON.stringify({ type: 'ready', servers: Object.keys(MCP_SERVERS) }),
  )

  /** Resolves the pending user message into the SDK's input generator. */
  let deliver = null
  let closed = false
  const inbox = []

  async function* userMessages() {
    while (!closed) {
      const text =
        inbox.shift() ??
        (await new Promise((resolve) => {
          deliver = resolve
        }))
      if (closed || text == null) return
      yield {
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
      }
    }
  }

  const send = (msg) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg))
  }

  /**
   * Which question the agent is currently answering.
   *
   * The stream carries no notion of a turn, so without this the client cannot
   * tell the tail of an abandoned answer from the start of the new one — it
   * attaches a listener and receives whatever is on the socket. Echoing the
   * id the client sent lets it ignore anything that is not its own, which is
   * the only reliable fix: no amount of waiting on this side changes what a
   * listener over there has already heard.
   *
   * A queue, not a single slot: a second question can reach the agent while
   * it is still answering the first, and the agent answers them in order, one
   * `result` each. With one slot the second id overwrote the first and the
   * rest of the first answer went out tagged as the second. The head of the
   * queue is the turn being produced; each `result` retires it.
   */
  const turnIds = []
  const sendTurn = (msg) => send({ ...msg, ask: turnIds[0] ?? null })

  /**
   * Asking the browser for something and waiting for the answer.
   *
   * Every other tool here pushes — a panel, a blade, a retint — and never needs
   * a reply. The camera is the exception: the hardware is over there and the
   * model is here, so a frame has to come back. Correlated by id because a turn
   * can have more than one request in flight, and timed out because a browser
   * that has been closed mid-question would otherwise hang the turn until the
   * two-minute idle timer noticed.
   */
  const waiting = new Map()
  let asks = 0

  const ask = (kind, args, timeoutMs = 20_000) =>
    new Promise((resolve, reject) => {
      if (socket.readyState !== socket.OPEN) {
        return reject(new Error('the interface is not connected'))
      }
      const id = `q${++asks}`
      const timer = setTimeout(() => {
        waiting.delete(id)
        reject(new Error('the interface did not answer in time'))
      }, timeoutMs)
      waiting.set(id, { resolve, timer, kind })
      send({ type: kind, id, ...args })
    })

  /**
   * The permission gate for this connection. Its questions travel as 'confirm'
   * asks; cancelling settles every open one as "cancelled" and tells the face
   * to take the question down.
   */
  const gate = createGate({
    ask,
    owner: voiceCheck,
    cancel: () => {
      for (const [id, slot] of waiting) {
        if (slot.kind !== 'confirm') continue
        waiting.delete(id)
        clearTimeout(slot.timer)
        slot.resolve({ cancelled: true })
        send({ type: 'confirm_cancel', id })
      }
    },
  })

  /**
   * Handing a question to Claude: tag the turn with its id and feed it to the
   * agent's input — prefixed with anything handled locally since its last
   * turn, so it knows what just happened on this PC.
   */
  function deliverToClaude(text, id) {
    startSession()
    turnIds.push(id)
    const message = localTurns.takeLog() + text
    if (deliver) {
      const resolve = deliver
      deliver = null
      resolve(message)
    } else {
      inbox.push(message)
    }
  }

  /** Neurons first: an order that matches runs here, instantly. */
  const localTurns = createLocal({
    send,
    ask,
    gate,
    brain: BRAIN,
    corrections: CORRECTIONS,
    toClaude: deliverToClaude,
    onVoiceChange: () => {
      SPEAKER = loadSpeaker()
    },
  })

  /**
   * Announcing a tool on the HUD, once, and only if it actually runs.
   *
   * A tool_use block surfaces twice — as a partial stream event and again on
   * the completed assistant message — so ids are remembered. The harder part
   * is timing, because a refused tool that lights the badge, plays the sound
   * and provokes a "working on it" line, for work that never happens, reads as
   * a bug on camera.
   *
   * The SDK's order is: the block starts streaming, then canUseTool is asked,
   * then the tool runs. So nothing is known at content_block_start. Announcing
   * from inside canUseTool would know the verdict but miss tools entirely —
   * measured on this SDK, the callback is consulted only for calls the CLI
   * hasn't already settled, so a `Bash: echo` its own classifier waves through
   * never reaches us at all.
   *
   * So: announce immediately for anything decideTool permits, since those run.
   * Hold the rest, and let the tool_result settle it — a refusal comes back as
   * is_error, anything else really did execute and has earned its badge, a
   * beat late. Nothing is ever announced for work that didn't happen.
   */
  const seenTools = new Set()
  const heldTools = new Map()

  /**
   * Resolves when the turn in flight has actually finished.
   *
   * Waiting on session.interrupt() alone is not enough. It resolves when the
   * agent has been *told* to stop, not when it has, so the last tokens of the
   * abandoned answer are still on their way — and since nothing on the wire
   * identifies which question a delta belongs to, they land on the next turn's
   * listener. Measured: ask for ALPHA, interrupt, ask for BRAVO, and BRAVO's
   * answer arrives as "ALPHA\nBRAVO".
   *
   * The SDK emits exactly one `result` per turn, so that is the boundary worth
   * waiting for. Raced against a timeout because a turn that never reports one
   * must not wedge the conversation for ever — a stray word is a blemish, a
   * deadlocked assistant is not.
   */
  let settling = Promise.resolve()
  let finishTurn = null

  const turnFinished = () =>
    new Promise((resolve) => {
      finishTurn = resolve
    })

  /**
   * A brief pause so the abandoned turn's frames are tagged with the OLD id
   * before the new one is adopted. Short, because correctness now comes from
   * the tag rather than from the wait — this only has to cover the gap, not
   * outlast the whole turn.
   */
  const SETTLE_CAP_MS = 400

  const announceTool = (id, name) => {
    if (!name || (id && seenTools.has(id))) return
    if (id) seenTools.add(id)
    // The display tool isn't work being done, it's the HUD drawing itself —
    // announcing it would put "jarvis · display" in the tool badge and trigger
    // a "working on it" filler for something already on screen.
    if (name === 'mcp__jarvis__display') return
    // The ui_* tools are the same case one step further: retinting the
    // interface is the interface talking about itself, not work being done for
    // the user, and the badge would be describing the very thing they can see.
    if (name.startsWith('mcp__jarvis_ui__')) return
    if (decideTool(name)) return sendTurn({ type: 'tool', name })
    if (id) heldTools.set(id, name)
  }

  const settleTool = (id, failed) => {
    const name = heldTools.get(id)
    if (name === undefined) return
    heldTools.delete(id)
    if (!failed) sendTurn({ type: 'tool', name })
  }

  /**
   * Claude Code itself, started a moment after the face connects rather than
   * the instant it does — or at once, if a question for Claude comes first.
   *
   * Starting it spawns claude.exe, and on Windows that one call blocks this
   * whole process for 1.5–2.5 s while the 200 MB executable is mapped and
   * scanned. Done in the connection handler it landed exactly on the face's
   * boot: /health timed out, the first wake-word segments queued, and "what
   * time is it" — answered locally in 2 ms — took two seconds. Deferred, the
   * pause falls in the quiet after boot, and the session is still warm before
   * anyone needs it.
   */
  let session = null
  const PREWARM_MS = Number(process.env.JARVIS_PREWARM_MS ?? 2500)
  const prewarm = setTimeout(() => startSession(), PREWARM_MS)

  function startSession() {
    if (session || closed) return
    clearTimeout(prewarm)
    session = query({
      prompt: userMessages(),
      options: {
        // Everything Claude Code has configured, plus the HUD as an in-process
        // server. The HUD's handler closes over this socket, so a `display` call
        // lands on screen directly — which is also why this object is built per
        // connection rather than once.
        mcpServers: {
          ...MCP_SERVERS,
          jarvis: displayServer(
            (panel) => send({ type: 'panel', panel }),
            (blade) => send({ type: 'blade', blade }),
          ),
          // The interface controls, on the same socket. A separate key because
          // MCP tool names are `mcp__<key>__<tool>` and one key can only carry
          // one server; the underscore in it is why decideTool and announceTool
          // both name `jarvis_ui` explicitly.
          jarvis_ui: uiServer((op, args) => send({ type: 'ui', op, args })),
          // The user's own Chrome, over the extension's native-host socket. It
          // holds no per-connection state, but it is built here with the rest so
          // the write gate is read once, at the same point as everything else.
          jarvis_chrome: chromeServer({ allowWrites: ALLOW_WRITES, gate }),
          // The camera, which unlike everything else here has to ask and wait.
          jarvis_eyes: visionServer(ask, { gate, hidden: () => WINDOW_HIDDEN }),
          // Apps and sites through the catalog and the permission gate, for the
          // requests no fixed order matches ("can you get WhatsApp up?").
          jarvis_neurons: neuronsServer(() => localTurns.toolContext()),
        },
        // A plain system prompt, not the claude_code preset. The preset is
        // tuned for a coding agent — verbose, file-oriented, and a large chunk
        // of input tokens on every turn. Replacing it makes the persona stick,
        // keeps answers short enough to speak, and cuts cost per turn.
        systemPrompt: systemPromptNow(),
        cwd: WORKSPACE,
        // Built-in tools: search and planning only, unless --writes. Removing a
        // tool from the model's context is stronger than refusing it in
        // canUseTool, which the CLI does not consult for every call.
        ...sessionTools({ allowWrites: ALLOW_WRITES }),
        // Nothing written to ~/.claude/projects. A voice session routinely reads
        // pages from signed-in sites — mail, banking, work dashboards — and the
        // transcript of that has no reason to outlive the conversation.
        persistSession: false,
        // The SDK replaces the child's environment when this is set, so the
        // parent's is carried over — minus the session token, which the agent
        // never needs and must not be able to read back out.
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(([k]) => k !== 'JARVIS_BRIDGE_TOKEN'),
          ),
          CLAUDE_AGENT_SDK_CLIENT_APP: 'vas/0.1',
        },
        // The packaged app points this at the claude.exe it unpacked from asar.
        ...(process.env.JARVIS_CLAUDE_EXE
          ? { pathToClaudeCodeExecutable: process.env.JARVIS_CLAUDE_EXE }
          : {}),
        // No filesystem settings at all. Left to its default the SDK loads
        // ~/.claude/settings.json and settings.local.json exactly as the CLI
        // does — which on a working machine means a bypassPermissions default
        // and a pile of allow-rules for Bash. Allow-rules are matched before the
        // permission callback, so decideTool below would never even be asked
        // about the tools it most needs to refuse. Empty makes this bridge the
        // only authority. It also stops the global CLAUDE.md riding along on
        // every voice turn, carrying instructions written for a coding agent
        // into a conversation that is meant to be two sentences long.
        //
        // The cost is that MCP servers stop being discovered too, which is why
        // mcpServers above passes them in by hand.
        settingSources: [],
        // Stated explicitly, and it has to be.
        //
        // With no `model` here the SDK falls back to its own default, which on
        // this machine resolved to claude-opus-4-8[1m] — not what src/config.ts
        // declares for the browser-direct path, and not anything anyone chose.
        // Normally your own `/model` preference would decide, but that lives in
        // the settings files `settingSources: []` deliberately stops loading, so
        // without this line nothing in the project has a say at all.
        model: MODEL,
        effort: EFFORT,
        maxTurns: 24,
        permissionMode: 'default',
        // Without this the SDK only emits whole assistant messages, and JARVIS
        // would sit silent until the entire answer was written. Partial events
        // are what let speech start on the first finished sentence.
        includePartialMessages: true,
        // Signature is (toolName, input, options) and it must return a
        // PermissionResult object. Returning a bare boolean silently denies
        // everything, with the tool name arriving undefined.
        //
        // Worth knowing: this is a last gate, not the only one. Calls the CLI
        // has already settled never arrive here — its own classifier waves
        // through a `Bash: echo hello` without asking, and only reaches us for
        // something with a consequence, like a `touch`. So a deny here is
        // reliable; an absence of a call here is not proof nothing ran.
        canUseTool: async (toolName) => {
          const ok = decideTool(toolName)
          console.log(`[jarvis] tool ${toolName} -> ${ok ? 'allow' : 'deny'}`)
          return ok
            ? { behavior: 'allow' }
            : {
                behavior: 'deny',
                // Every word of this can end up spoken, so it carries no command
                // to read out — the persona is forbidden from saying one aloud.
                message:
                  'Blocked: JARVIS is running in read-only mode and cannot take' +
                  ' actions that change anything. Tell the user this action is' +
                  ' unavailable until they enable write access on the machine.',
              }
        },
      },
    })

    // Pump the session's output stream to the browser for as long as it lives.
    ;(async () => {
      try {
        for await (const msg of session) {
          if (process.env.JARVIS_DEBUG === '1') {
            console.log('[msg]', msg.type, msg.event?.type ?? '')
          }

          switch (msg.type) {
            // Raw Anthropic stream events, surfaced by includePartialMessages.
            // This is the ONLY place spoken text arrives: there is no top-level
            // text_delta message in the SDK union and the 'assistant' message
            // carries no deltas either. Turn includePartialMessages off and
            // JARVIS goes completely mute.
            case 'stream_event': {
              const ev = msg.event
              if (
                ev?.type === 'content_block_delta' &&
                ev.delta?.type === 'text_delta' &&
                ev.delta.text
              ) {
                sendTurn({ type: 'text', delta: ev.delta.text })
              }
              if (
                ev?.type === 'content_block_start' &&
                ev.content_block?.type === 'tool_use'
              ) {
                announceTool(ev.content_block.id, ev.content_block.name)
              }
              break
            }

            case 'assistant': {
              // Fallback for builds that emit whole assistant messages rather
              // than partial events. Deduped against the stream_event path.
              for (const block of msg.content ?? msg.message?.content ?? []) {
                if (block.type === 'tool_use') {
                  announceTool(block.id, block.name)
                }
              }
              break
            }

            case 'user': {
              // Tool results come back as a user message. This is the only place
              // a held announcement can be resolved: a refused tool arrives with
              // is_error set and stays off the HUD, anything else ran.
              const blocks = msg.message?.content
              if (!Array.isArray(blocks)) break
              for (const block of blocks) {
                if (block?.type === 'tool_result') {
                  settleTool(block.tool_use_id, block.is_error === true)
                }
              }
              break
            }

            case 'result':
              // A result is not automatically a success. The error subtypes
              // carry no `result` field at all, so reporting them as 'done' with
              // empty text is indistinguishable from a turn that simply had
              // nothing to say — the HUD stops spinning and JARVIS stands there
              // silent. Say what happened instead.
              if (msg.subtype === 'success') {
                sendTurn({
                  type: 'done',
                  text: msg.result ?? '',
                  costUsd: msg.total_cost_usd ?? null,
                })
              } else {
                console.error(
                  `[jarvis] turn failed: ${msg.subtype}`,
                  msg.errors ?? '',
                )
                sendTurn({
                  type: 'error',
                  message: RESULT_FAILURES[msg.subtype] ?? RESULT_FAILURES.default,
                })
              }
              // Whatever was waiting on this turn to finish can go now. This is
              // the only place a turn is genuinely over.
              turnIds.shift()
              finishTurn?.()
              finishTurn = null
              // One turn's tool ids are never referred to again, and these
              // otherwise grow for as long as the socket is open.
              seenTools.clear()
              heldTools.clear()
              break

            case 'system':
              if (msg.subtype === 'init') {
                // Servers report 'pending' until first use — they connect
                // lazily — so only drop the ones that are actually unusable.
                const usable = (msg.mcp_servers ?? [])
                  .filter((s) => s.status !== 'needs-auth' && s.status !== 'failed')
                  .map((s) => s.name)
                send({ type: 'ready', servers: usable })
                console.log(`[jarvis] ${usable.length} MCP servers available`)
              }
              break
          }
        }
      } catch (err) {
        console.error('[jarvis] session error:', err)
        send({ type: 'error', message: String(err?.message ?? err) })
        // The stream is finished either way — nothing will ever be read from it
        // again. Leaving the socket open would leave the client believing it has
        // a working bridge, and every later question would hang for ever waiting
        // on a pump that has already stopped. Close it so it reconnects.
        closed = true
        deliver?.(null)
        session.close?.()
        socket.close()
      }
    })()
  }

  socket.on('message', (raw) => {
    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }

    if (msg.type === 'ask' && typeof msg.text === 'string') {
      /**
       * Queued behind any interrupt that is still settling.
       *
       * A barge-in is two messages in quick succession — interrupt, then the
       * new question — and session.interrupt() is asynchronous. Delivering the
       * question the instant it arrives means the agent can still be winding
       * down the previous turn, so its last tokens are emitted after the new
       * one has begun and land on the new turn's listener. Measured: ask "one",
       * interrupt, ask "two", and the answer to "two" comes back as "One."
       *
       * Waiting costs nothing when nothing is interrupting — the chain is an
       * already-resolved promise — and removes the cross-talk when there is.
       */
      const text = msg.text
      const id = typeof msg.id === 'string' ? msg.id : null
      void settling.then(() => localTurns.handle(text, id))
    }

    if (msg.type === 'reply' && typeof msg.id === 'string') {
      const slot = waiting.get(msg.id)
      if (slot) {
        waiting.delete(msg.id)
        clearTimeout(slot.timer)
        slot.resolve(msg)
      }
    }

    if (msg.type === 'interrupt') {
      // Standing down or barging in withdraws any "shall I?" still open, and
      // drops a local turn in progress.
      gate.abortAll()
      localTurns.abort()
      // Held so the next question can wait for it rather than racing it.
      const stopped = turnFinished()
      settling = Promise.resolve(session?.interrupt?.())
        .catch(() => {})
        .then(() =>
          Promise.race([
            stopped,
            new Promise((r) => setTimeout(r, SETTLE_CAP_MS)),
          ]),
        )
    }
  })

  socket.on('close', () => {
    gate.abortAll()
    localTurns.abort()
    console.log('[jarvis] client disconnected')
    closed = true
    clearTimeout(prewarm)
    deliver?.(null)
    session?.close?.()
  })
})
