import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { randomBytes } from 'node:crypto'
import { userInfo } from 'node:os'
import { ChromeLink, findPipe } from '../../bridge/chrome.mjs'

const NAME = `claude-mcp-browser-bridge-${userInfo().username}`

test('findPipe: exact name, any case, or a suffixed variant; null when absent', async () => {
  assert.equal(await findPipe(async () => ['other', NAME]), `\\\\.\\pipe\\${NAME}`)
  assert.equal(await findPipe(async () => [NAME.toUpperCase()]), `\\\\.\\pipe\\${NAME.toUpperCase()}`)
  assert.equal(await findPipe(async () => [`${NAME}-1234`]), `\\\\.\\pipe\\${NAME}-1234`)
  assert.equal(await findPipe(async () => ['mojo.123', 'something']), null)
  assert.equal(await findPipe(async () => { throw new Error('no pipes') }), null)
})

/** A stand-in native host on a private pipe: answers each frame with an echo. */
function fakeHost(path) {
  const seen = []
  const server = createServer((socket) => {
    let buf = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
        const len = buf.readUInt32LE(0)
        const msg = JSON.parse(buf.subarray(4, 4 + len).toString('utf8'))
        buf = buf.subarray(4 + len)
        seen.push(msg)
        const body = Buffer.from(JSON.stringify({ result: { content: [{ type: 'text', text: `ok ${msg.params.tool}` }] } }))
        const head = Buffer.alloc(4)
        head.writeUInt32LE(body.length)
        socket.write(Buffer.concat([head, body]))
      }
    })
  })
  return new Promise((resolve) => server.listen(path, () => resolve({ server, seen })))
}

test('the link speaks the native-host framing over a Windows pipe, with our client id', { skip: process.platform !== 'win32' && 'Windows named pipes only' }, async () => {
  const path = `\\\\.\\pipe\\vas-test-${randomBytes(6).toString('hex')}`
  const { server, seen } = await fakeHost(path)
  try {
    const link = new ChromeLink(async () => path)
    const a = await link.call('tabs_context_mcp', { createIfEmpty: false })
    const b = await link.call('get_page_text', { tabId: 7 })
    assert.equal(a.result.content[0].text, 'ok tabs_context_mcp')
    assert.equal(b.result.content[0].text, 'ok get_page_text')
    assert.equal(seen.length, 2)
    assert.equal(seen[0].method, 'execute_tool')
    assert.equal(seen[0].params.client_id, 'vas')
    assert.deepEqual(seen[1].params.args, { tabId: 7 })
    link.reset()
  } finally {
    server.close()
  }
})
