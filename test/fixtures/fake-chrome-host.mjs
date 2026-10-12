import { createServer } from 'node:net'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A stand-in for the Claude extension's native host, for tests that drive the
 * real bridge/chrome.mjs. Same wire as the real one — a 4-byte little-endian
 * length and a JSON body, on a private named pipe (a Unix socket elsewhere) —
 * answering the extension tools the bridge uses from a small in-memory
 * browser: tabs with URLs, one page text, one accessibility tree.
 *
 * Point the code under test at it with JARVIS_CHROME_PIPE=<path>. Every
 * request lands in `seen` as { tool, args }, and `browser` is plain data a
 * test may change at any moment — between calls, or while a question is being
 * asked — which is the whole point: a page that moves under a confirmation.
 *
 * No real browser, tab or network is involved.
 */
export async function startFakeHost() {
  const id = randomBytes(6).toString('hex')
  const path =
    process.platform === 'win32' ? `\\\\.\\pipe\\vas-test-${id}` : join(tmpdir(), `vas-test-${id}.sock`)
  const browser = {
    /** @type {{ tabId: number, url: string }[]} */
    tabs: [],
    nextId: 1001,
    /** What get_page_text says is on any page, under its URL: line. */
    text: 'Nothing much here.',
    /** What read_page returns. */
    tree: '',
  }
  const seen = []

  const ok = (body) => ({
    result: { content: [{ type: 'text', text: typeof body === 'string' ? body : JSON.stringify(body) }] },
  })
  const noTab = { error: { content: 'No tab available' } }
  const tabOf = (args) => browser.tabs.find((t) => t.tabId === Number(args?.tabId))

  function answer(tool, args) {
    switch (tool) {
      case 'tabs_context_mcp':
        if (!browser.tabs.length && args?.createIfEmpty) {
          browser.tabs.push({ tabId: browser.nextId++, url: 'chrome://newtab/' })
        }
        return ok({ availableTabs: browser.tabs.map(({ tabId, url }) => ({ tabId, url, title: 'A page' })) })
      case 'tabs_create_mcp': {
        const tab = { tabId: browser.nextId++, url: 'chrome://newtab/' }
        browser.tabs.push(tab)
        return ok(`Created a new tab in the group. Tab ID: ${tab.tabId}`)
      }
      case 'tabs_close_mcp': {
        const tab = tabOf(args)
        if (!tab) return noTab
        browser.tabs.splice(browser.tabs.indexOf(tab), 1)
        return ok(`Closed tab ${tab.tabId}`)
      }
      case 'navigate': {
        const tab = tabOf(args)
        if (!tab) return noTab
        tab.url = /^[a-z][a-z0-9+.-]*:/i.test(args.url) ? args.url : `https://${args.url}`
        return ok(`Navigated to ${tab.url}`)
      }
      case 'get_page_text': {
        const tab = tabOf(args)
        return tab ? ok(`Title: A page\nURL: ${tab.url}\n\n${browser.text}`) : noTab
      }
      case 'read_page':
        return tabOf(args) ? ok(browser.tree) : noTab
      default:
        return tabOf(args) ? ok(`ok ${tool}`) : noTab
    }
  }

  const sockets = new Set()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    let buf = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
        const len = buf.readUInt32LE(0)
        const msg = JSON.parse(buf.subarray(4, 4 + len).toString('utf8'))
        buf = buf.subarray(4 + len)
        const { tool, args } = msg.params ?? {}
        seen.push({ tool, args, client: msg.params?.client_id })
        const body = Buffer.from(JSON.stringify(answer(tool, args)), 'utf8')
        const head = Buffer.alloc(4)
        head.writeUInt32LE(body.length)
        socket.write(Buffer.concat([head, body]))
      }
    })
  })
  await new Promise((resolve) => server.listen(path, resolve))

  return {
    path,
    browser,
    seen,
    /** The tools called since request number `from`, in order. */
    tools: (from = 0) => seen.slice(from).map((s) => s.tool),
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy()
        server.close(() => resolve())
      }),
  }
}
