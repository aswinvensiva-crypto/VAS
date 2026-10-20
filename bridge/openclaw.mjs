import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * OpenClaw, as VAS uses it: the local Gateway that holds your Gmail, WhatsApp
 * and Telegram sessions, asked to run one tool at a time.
 *
 * Only `POST /tools/invoke` is used, always as the `vas` agent — the one
 * agent OpenClaw is set up to let reach the messaging tools — so nothing here
 * starts an OpenClaw agent turn or asks its (absent) model anything. VAS does
 * the deciding, and every send has already been put to the permission gate
 * before it gets here (neurons/lib/messaging.mjs).
 *
 * The Gateway's token is full owner access to it, so it is read from
 * OpenClaw's own config when a call is made and kept nowhere else: not in
 * VAS's files, not in the environment Claude runs with (agent-env.mjs drops
 * OPENCLAW_*), never in a log line.
 */

const AGENT = 'vas'
const TIMEOUT_MS = 20_000

/** Where OpenClaw keeps its config: OPENCLAW_CONFIG_PATH, OPENCLAW_STATE_DIR, else ~/.openclaw. */
export function configPath(env = process.env) {
  if (env.OPENCLAW_CONFIG_PATH) return env.OPENCLAW_CONFIG_PATH
  return join(env.OPENCLAW_STATE_DIR || join(homedir(), '.openclaw'), 'openclaw.json')
}

/**
 * OpenClaw's config is JSON5. What it writes itself is plain JSON, but a hand
 * edit can add comments and trailing commas, so those are tolerated; anything
 * stranger is reported rather than guessed at.
 */
export function parseConfig(text) {
  try {
    return JSON.parse(text)
  } catch {
    const plain = String(text)
      .replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str ?? '')
      .replace(/,(\s*[}\]])/g, '$1')
    return JSON.parse(plain)
  }
}

/** The Gateway's address and token, or why they cannot be had. */
export async function gatewayAccess(env = process.env) {
  let cfg = {}
  try {
    cfg = parseConfig(await readFile(configPath(env), 'utf8'))
  } catch (err) {
    if (err?.code !== 'ENOENT') throw Object.assign(new Error("I couldn't read OpenClaw's settings."), { kind: 'config' })
    if (!env.OPENCLAW_GATEWAY_TOKEN) throw Object.assign(new Error("OpenClaw isn't set up on this PC yet."), { kind: 'missing' })
  }
  const port = Number(env.OPENCLAW_GATEWAY_PORT || cfg?.gateway?.port || 18789)
  const token = typeof cfg?.gateway?.auth?.token === 'string' ? cfg.gateway.auth.token : env.OPENCLAW_GATEWAY_TOKEN
  if (!token) throw Object.assign(new Error("OpenClaw has no gateway token VAS can use."), { kind: 'token' })
  return { url: `http://127.0.0.1:${port}`, token }
}

/** A failure worded to be said aloud, with a `kind` for the Settings drawer. */
const trouble = (kind, message) => Object.assign(new Error(message), { kind })

/**
 * @param {{ access?: typeof gatewayAccess, fetchImpl?: typeof fetch, timeoutMs?: number }} [deps]
 */
export function createOpenClaw({ access = gatewayAccess, fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  /**
   * Run one OpenClaw tool and return what it returned (`result.details`).
   * Throws an Error whose message can be spoken.
   */
  async function invoke(tool, args = {}) {
    const { url, token } = await access()
    let res
    try {
      res = await fetchImpl(`${url}/tools/invoke`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ tool, args, agentId: AGENT }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      if (err?.name === 'TimeoutError') throw trouble('timeout', 'OpenClaw took too long to answer.')
      throw trouble('down', "OpenClaw isn't running. Start it with: openclaw gateway start")
    }
    let body = null
    try {
      body = await res.json()
    } catch {
      /* a plain-text error page */
    }
    if (res.status === 401) throw trouble('token', "OpenClaw refused VAS's key. Its gateway token may have changed.")
    if (res.status === 429) throw trouble('busy', 'OpenClaw is rate-limiting requests; try again in a moment.')
    if (body?.ok === true) return body.result?.details ?? body.result
    const type = body?.error?.type
    const message = body?.error?.message ?? `OpenClaw answered ${res.status}.`
    if (res.status === 404 || type === 'not_found') {
      throw trouble('tool', `OpenClaw doesn't offer "${tool}" to VAS. Is the vas-mail plugin installed and the vas agent set up?`)
    }
    // A ToolInputError's message is written to be passed on as it is.
    throw trouble(type === 'tool_error' && res.status === 400 ? 'input' : 'error', message)
  }

  /**
   * The last messages of one conversation (`GET /sessions/<key>/history`),
   * oldest first, as `{ role, text, at }`. Text that came from another person
   * is theirs, not the user's: callers treat it as data.
   */
  async function history(sessionKey, limit = 10) {
    const { url, token } = await access()
    let res
    try {
      res = await fetchImpl(`${url}/sessions/${encodeURIComponent(sessionKey)}/history?limit=${limit}`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch {
      throw trouble('down', "OpenClaw isn't running. Start it with: openclaw gateway start")
    }
    if (res.status === 401) throw trouble('token', "OpenClaw refused VAS's key. Its gateway token may have changed.")
    if (!res.ok) throw trouble('error', `OpenClaw couldn't show that conversation (${res.status}).`)
    const body = await res.json().catch(() => ({}))
    const items = body.messages ?? body.items ?? body.history ?? []
    return items.slice(-limit).map((m) => ({
      role: m.role ?? m.message?.role ?? null,
      text: textOf(m.content ?? m.message?.content ?? m.text),
      at: m.timestamp ?? m.ts ?? m.createdAt ?? null,
    }))
  }

  /** Whether the Gateway answers at all, for the Settings drawer. */
  async function reachable() {
    try {
      const { url } = await access()
      const res = await fetchImpl(`${url}/health`, { signal: AbortSignal.timeout(3000) })
      return { ok: res.ok }
    } catch (err) {
      return { ok: false, reason: err?.message ?? String(err), kind: err?.kind ?? 'down' }
    }
  }

  return { invoke, history, reachable }
}

/** A transcript entry's words, whatever shape its content takes. */
function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((b) => (typeof b === 'string' ? b : b?.text ?? '')).join(' ').trim()
  return ''
}

/** The one client the bridge uses. */
export const openclaw = createOpenClaw()
