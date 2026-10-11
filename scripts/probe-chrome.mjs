/**
 * Read-only probe of the Claude-in-Chrome native host.
 *
 * Answers the questions the Windows port of bridge/chrome.mjs depends on:
 *   1. Which endpoint does the native host expose here (named pipe on Windows,
 *      Unix socket elsewhere)?
 *   2. Does it accept our framing with and without a client_id?
 *   3. Does tabs_context_mcp list every tab, or only the extension's tab group?
 *   4. Can two clients talk to it at the same time?
 *
 * Nothing here clicks, types, navigates or opens tabs. Page titles and text are
 * never printed: only counts, origins and lengths.
 *
 *   npm run probe:chrome
 */
import { createConnection } from 'node:net'
import { readdir } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { join } from 'node:path'

const NAME = `claude-mcp-browser-bridge-${userInfo().username}`
const TIMEOUT_MS = 15_000

async function findEndpoint() {
  if (process.platform === 'win32') {
    const pipes = await readdir('\\\\.\\pipe\\').catch(() => [])
    const hit =
      pipes.find((n) => n.toLowerCase() === NAME.toLowerCase()) ??
      pipes.find((n) => n.toLowerCase().startsWith(NAME.toLowerCase()))
    return hit ? `\\\\.\\pipe\\${hit}` : null
  }
  const dir = `/tmp/${NAME}`
  const names = (await readdir(dir).catch(() => [])).filter((n) => n.endsWith('.sock'))
  return names.length ? join(dir, names[0]) : null
}

/** One framed request, one framed reply, on a fresh connection. */
function call(path, tool, args, clientId) {
  return new Promise((resolve) => {
    const socket = createConnection(path)
    let buf = Buffer.alloc(0)
    const done = (result) => {
      clearTimeout(timer)
      socket.destroy()
      resolve(result)
    }
    const timer = setTimeout(() => done({ error: 'timeout' }), TIMEOUT_MS)
    socket.on('error', (err) => done({ error: err.message }))
    socket.on('connect', () => {
      const params = { tool, args }
      if (clientId) params.client_id = clientId
      const body = Buffer.from(JSON.stringify({ method: 'execute_tool', params }), 'utf8')
      const header = Buffer.alloc(4)
      header.writeUInt32LE(body.length, 0)
      socket.write(Buffer.concat([header, body]))
    })
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      if (buf.length < 4) return
      const len = buf.readUInt32LE(0)
      if (buf.length < 4 + len) return
      try {
        done({ reply: JSON.parse(buf.subarray(4, 4 + len).toString('utf8')) })
      } catch (err) {
        done({ error: `unparseable reply: ${err.message}` })
      }
    })
  })
}

/** Text blocks of a reply, joined. */
const textOf = (reply) =>
  (reply?.result?.content ?? [])
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')

/** Summarise a tabs_context reply without printing titles or full URLs. */
function summariseTabs(reply) {
  if (reply?.error) return { error: JSON.stringify(reply.error).slice(0, 200) }
  const text = textOf(reply)
  try {
    const parsed = JSON.parse(text.split('\n')[0])
    const tabs = parsed?.availableTabs ?? []
    const origins = tabs.map((t) => {
      try {
        return new URL(t.url).origin
      } catch {
        return '(non-url)'
      }
    })
    return { tabCount: tabs.length, origins, keys: Object.keys(parsed ?? {}), firstTabId: tabs[0]?.tabId }
  } catch {
    return { rawLength: text.length, rawHead: text.slice(0, 120).replace(/https?:\/\/\S+/g, '<url>') }
  }
}

const endpoint = await findEndpoint()
console.log('platform :', process.platform)
console.log('endpoint :', endpoint ?? 'NOT FOUND (is Chrome running with the Claude extension?)')
if (!endpoint) process.exit(1)

for (const clientId of [undefined, 'vas', 'claude-code']) {
  const r = await call(endpoint, 'tabs_context_mcp', { createIfEmpty: false }, clientId)
  console.log(`\ntabs_context_mcp client_id=${clientId ?? '(none)'}:`)
  console.log(r.error ? `  transport error: ${r.error}` : `  ${JSON.stringify(summariseTabs(r.reply))}`)
}

const first = await call(endpoint, 'tabs_context_mcp', { createIfEmpty: false }, 'vas')
const tabId = first.reply ? summariseTabs(first.reply).firstTabId : undefined
if (tabId !== undefined) {
  const r = await call(endpoint, 'get_page_text', { tabId, max_chars: 300 }, 'vas')
  const text = r.reply ? textOf(r.reply) : ''
  const at = /^URL:\s*(\S+)/m.exec(text)
  let origin = '(no URL line)'
  try {
    if (at) origin = new URL(at[1]).origin
  } catch {}
  console.log(`\nget_page_text tab ${tabId}: ${r.error ?? (r.reply?.error ? 'tool error' : 'ok')}, ${text.length} chars, URL origin ${origin}`)
} else {
  console.log('\nget_page_text: skipped (no tab in the extension group)')
}

const [a, b] = await Promise.all([
  call(endpoint, 'tabs_context_mcp', { createIfEmpty: false }, 'vas'),
  call(endpoint, 'tabs_context_mcp', { createIfEmpty: false }, 'vas'),
])
console.log('\ntwo concurrent clients:', a.error ?? 'ok', '/', b.error ?? 'ok')
console.log('\nCompare tabCount above with the tabs you can see in Chrome to learn')
console.log('whether the extension reports every tab or only its own tab group.')
