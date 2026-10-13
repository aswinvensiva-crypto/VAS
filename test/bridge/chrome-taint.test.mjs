import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The taint rule on its own (chrome.mjs createTaint), and where it applies
 * outside the browser tools: probe_url, blades and display markup
 * (panels.mjs). A scripted gate answers; nothing leaves the machine.
 */

let dir
let chrome
let panels

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'vas-taint-'))
  process.env.JARVIS_DATA_DIR = dir
  process.env.JARVIS_CHROME_PIPE = 'none'
  chrome = await import('../../bridge/chrome.mjs')
  panels = await import('../../bridge/panels.mjs')
})
after(() => rmSync(dir, { recursive: true, force: true }))

/** A scripted gate: answers in order (default no), recording each question. */
function fakeGate(...answers) {
  const asked = []
  return {
    asked,
    async check(action, details) {
      asked.push({ action, ...details })
      const a = answers.shift() ?? 'no'
      if (typeof a === 'function') return a()
      return a === 'yes' ? { allowed: true } : { allowed: false, reason: "Okay, I won't." }
    },
  }
}

const call = (server, name, args) => server.instance._registeredTools[name].handler(args, {})
const textOf = (out) => out.content.map((b) => b.text ?? '').join('\n')

test('destination: a host to name, or null for this machine and non-addresses', () => {
  const { destination } = chrome
  assert.equal(destination('https://www.evil.example/x?q=1'), 'evil.example')
  assert.equal(destination('http://evil.example:8080/'), 'evil.example:8080')
  assert.equal(destination('evil.example/?q=secret'), 'evil.example', 'no scheme still goes there')
  assert.equal(destination('//cdn.example/a.png'), 'cdn.example')
  assert.equal(destination('ht\ntps://evil.example/'), 'evil.example', 'URL parsers drop newlines')
  assert.equal(destination('HTTPS://EVIL.EXAMPLE/'), 'evil.example')
  for (const local of [
    'back',
    'forward',
    '',
    undefined,
    'file:///C:/Users/me/shot.png',
    'C:\\Users\\me\\shot.png',
    '/home/me/shot.png',
    'data:image/png;base64,AAAA',
    'about:blank',
    'http://localhost:5173/',
    'http://127.0.0.1:8787/health',
    'http://[::1]/',
    'http://vas.localhost/',
  ]) {
    assert.equal(destination(local), null, String(local))
  }
  assert.equal(destination('javascript:fetch(1)'), 'a javascript: address')
  assert.equal(destination('mailto:x@evil.example?body=secret'), 'a mailto: address')
})

test('destination: an address with no scheme is judged as the https the extension opens', () => {
  const { destination } = chrome
  // Each of these once parsed as "nothing" and walked past the question.
  assert.equal(destination('x_y.evil.example/?q=subjects'), 'x_y.evil.example')
  assert.equal(destination('evil.example./?q=subjects'), 'evil.example')
  assert.equal(destination('a@evil.example/?q=subjects'), 'evil.example')
  assert.equal(destination('evil\u3002example/?q=subjects'), 'evil.example')
  assert.equal(destination('evil.example:8080/x'), 'evil.example:8080', 'a port is not a scheme')
  assert.equal(destination('localhost:5173/x'), null)
  assert.equal(destination('intranet/x'), 'intranet')
  // Unreadable is asked about, never assumed to stay here.
  assert.equal(destination('http://[bad/'), 'an address I could not read')
})

test('nothing read this turn: nothing is asked', async () => {
  const gate = fakeGate()
  const taint = chrome.createTaint({ gate })
  assert.deepEqual(await taint.leave('https://evil.example/', 'Go to'), { allowed: true })
  assert.equal(gate.asked.length, 0)
})

test('after a read: same site and this machine are free, a different site asks naming both', async () => {
  const gate = fakeGate('no')
  const taint = chrome.createTaint({ gate })
  taint.noteRead('mail.google.com')
  assert.deepEqual(await taint.leave('https://mail.google.com/mail/u/0/#sent'), { allowed: true })
  assert.deepEqual(await taint.leave('https://www.mail.google.com/'), { allowed: true })
  assert.deepEqual(await taint.leave(['file:///C:/a.png', 'http://127.0.0.1:8787/x']), { allowed: true })
  assert.equal(gate.asked.length, 0)

  const verdict = await taint.leave('https://evil.example/?q=inbox', 'Go to')
  assert.equal(verdict.allowed, false)
  assert.equal(verdict.reason, "Okay, I won't.")
  assert.equal(gate.asked.length, 1)
  assert.equal(gate.asked[0].action, 'chrome.leave')
  assert.equal(gate.asked[0].prompt, 'You just read mail.google.com. Go to evil.example now?')
  assert.deepEqual(gate.asked[0].args, { from: ['mail.google.com'], to: ['evil.example'] })
})

test('a yes covers the sites it named; a no stands for the turn', async () => {
  const yes = fakeGate('yes', 'yes')
  const t1 = chrome.createTaint({ gate: yes })
  t1.noteRead('mail.google.com')
  assert.equal((await t1.leave('https://a.example/')).allowed, true)
  assert.equal((await t1.leave('https://a.example/more')).allowed, true)
  assert.equal(yes.asked.length, 1)
  // A yes to one site is not a yes to the next: that is the two-step leak.
  assert.equal((await t1.leave('https://b.example/?q=subjects')).allowed, true)
  assert.equal(yes.asked.length, 2)
  assert.deepEqual(yes.asked[1].args.to, ['b.example'])

  const no = fakeGate('no', 'yes')
  const t2 = chrome.createTaint({ gate: no })
  t2.noteRead('mail.google.com')
  assert.equal((await t2.leave('https://a.example/')).allowed, false)
  assert.equal((await t2.leave('https://b.example/')).allowed, false)
  assert.equal(no.asked.length, 1, 'one question per turn')
  // ...but a site the turn has only been reading is still free.
  assert.equal((await t2.leave('https://mail.google.com/')).allowed, true)
})

test('a new turn keeps what was read and asks afresh', async () => {
  // The agent session remembers every turn, so what it read last turn can be
  // carried out by this one.
  const gate = fakeGate('no', 'no', 'no')
  const taint = chrome.createTaint({ gate })
  taint.noteRead('mail.google.com')
  await taint.leave('https://evil.example/')
  taint.endTurn()
  assert.deepEqual(taint.hosts(), ['mail.google.com'])
  assert.equal((await taint.leave('https://evil.example/?q=subjects')).allowed, false)
  assert.equal(gate.asked.length, 2, 'the new turn asks afresh')
  assert.equal(gate.asked[1].prompt, 'Earlier you had me read mail.google.com. Go to evil.example now?')
  taint.noteRead('docs.google.com')
  taint.endTurn()
  taint.noteRead('docs.google.com')
  await taint.leave('https://evil.example/')
  assert.match(gate.asked[2].prompt, /^You just read mail\.google\.com and docs\.google\.com\./)
})

test('a page whose site could not be told still counts, and never matches', async () => {
  const gate = fakeGate('no')
  const taint = chrome.createTaint({ gate })
  taint.noteRead(null)
  await taint.leave('https://mail.google.com/')
  assert.equal(gate.asked[0].prompt, 'You just read a page. Go to mail.google.com now?')
})

test('several sites are named in the one question, a long list cut short', async () => {
  const gate = fakeGate('no')
  const taint = chrome.createTaint({ gate })
  taint.noteRead('mail.google.com')
  taint.noteRead('evil.example')
  await taint.leave(['https://evil.example/x', 'https://evil.example/y', 'https://cdn.example/z.png'], 'Open')
  assert.equal(gate.asked[0].prompt, 'You just read mail.google.com and evil.example. Open evil.example and cdn.example now?')
  const four = fakeGate('no')
  const t = chrome.createTaint({ gate: four })
  for (const h of ['a.example', 'b.example', 'c.example', 'd.example']) t.noteRead(h)
  await t.leave('https://e.example/')
  assert.equal(four.asked[0].prompt, 'You just read a.example, b.example and 2 more. Go to e.example now?')
})

test('calls made side by side wait for the question on screen, and share its answer', async () => {
  let release
  const held = new Promise((r) => (release = r))
  const gate = fakeGate(() => held.then(() => ({ allowed: true })), 'no')
  const taint = chrome.createTaint({ gate })
  taint.noteRead('mail.google.com')
  const all = Promise.all([
    taint.leave('https://a.example/'),
    taint.leave('https://a.example/logo.png'),
    taint.leave('https://b.example/'),
  ])
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(gate.asked.length, 1, 'one question at a time')
  release()
  const [a, logo, b] = await all
  assert.equal(a.allowed, true)
  assert.equal(logo.allowed, true, 'the same site rides on that yes')
  assert.equal(b.allowed, false, 'a different one is asked about on its own')
  assert.equal(gate.asked.length, 2)
})

test('an answer that arrives after its turn has ended is not carried into the next', async () => {
  let release
  const held = new Promise((r) => (release = r))
  const gate = fakeGate(() => held.then(() => ({ allowed: false, reason: 'Cancelled.' })), 'yes')
  const taint = chrome.createTaint({ gate })
  taint.noteRead('mail.google.com')
  const late = taint.leave('https://evil.example/')
  await new Promise((r) => setTimeout(r, 10))
  taint.endTurn()
  release()
  assert.equal((await late).allowed, false)
  taint.noteRead('docs.google.com')
  assert.equal((await taint.leave('https://news.example/')).allowed, true, 'asked afresh, and the yes counts')
  assert.equal(gate.asked.length, 2)
})

test('probe_url after a read asks first, and a no means no request at all', async () => {
  const gate = fakeGate('no')
  const taint = chrome.createTaint({ gate })
  const server = panels.displayServer(() => {}, () => {}, { taint })
  taint.noteRead('mail.google.com')
  const out = await call(server, 'probe_url', { url: 'https://evil.example/?q=subjects' })
  assert.equal(out.isError, true)
  assert.match(textOf(out), /^Not checked — Okay, I won't\./)
  assert.equal(gate.asked[0].prompt, 'You just read mail.google.com. Look up evil.example now?')
})

test('probe_url of an address on this machine is never asked about', async () => {
  const gate = fakeGate()
  const taint = chrome.createTaint({ gate })
  const server = panels.displayServer(() => {}, () => {}, { taint })
  taint.noteRead('mail.google.com')
  // Loopback is refused by the bridge's own SSRF guard before any connection.
  const out = await call(server, 'probe_url', { url: 'http://127.0.0.1:9/x' })
  assert.equal(gate.asked.length, 0)
  assert.equal(JSON.parse(textOf(out)).ok, false)
})

test('a remote blade after a read asks first; a no keeps it off the screen', async () => {
  const blades = []
  const gate = fakeGate('no')
  const taint = chrome.createTaint({ gate })
  const server = panels.displayServer(() => {}, (b) => blades.push(b), { taint })
  taint.noteRead('mail.google.com')
  const out = await call(server, 'blade', { title: 'NEWS', kind: 'article', url: 'https://evil.example/a?q=x' })
  assert.equal(out.isError, true)
  assert.match(textOf(out), /^Not opened — Okay, I won't\./)
  assert.equal(gate.asked[0].prompt, 'You just read mail.google.com. Open evil.example now?')
  assert.equal(blades.length, 0)
})

test('gallery pictures are addresses too', async () => {
  const gate = fakeGate('yes')
  const blades = []
  const taint = chrome.createTaint({ gate })
  const server = panels.displayServer(() => {}, (b) => blades.push(b), { taint })
  taint.noteRead('mail.google.com')
  const out = await call(server, 'blade', {
    title: 'PICTURES',
    kind: 'gallery',
    images: ['https://img.example/1.jpg', 'file:///C:/shot.png'],
  })
  assert.equal(out.isError, undefined, textOf(out))
  assert.equal(gate.asked[0].prompt, 'You just read mail.google.com. Open img.example now?')
  assert.equal(blades.length, 1)
})

test('local blades and the camera never ask, read or not', async () => {
  const blades = []
  const gate = fakeGate()
  const taint = chrome.createTaint({ gate })
  const server = panels.displayServer(() => {}, (b) => blades.push(b), { taint })
  taint.noteRead('mail.google.com')
  await call(server, 'blade', { title: 'SHOT', kind: 'image', url: 'file:///C:/Users/me/shot.png' })
  await call(server, 'blade', { title: 'SHOT', kind: 'image', url: 'C:\\Users\\me\\shot.png' })
  await call(server, 'blade', { title: 'CAMERA', kind: 'camera' })
  await call(server, 'blade', { title: 'NOTE', kind: 'markup', html: '<p class="hud-note">Three unread.</p>' })
  assert.equal(gate.asked.length, 0)
  assert.equal(blades.length, 4)
})

test('a remote picture in display markup asks, however its address is spelled', async () => {
  const gate = fakeGate('no', 'no')
  const blades = []
  const taint = chrome.createTaint({ gate })
  const server = panels.displayServer(() => {}, (b) => blades.push(b), { taint })
  taint.noteRead('mail.google.com')
  const plain = await call(server, 'display', {
    title: 'INBOX',
    html: '<div><img class="hud-img" src="https://evil.example/p.png?d=subjects"><span class="hud-caption">x</span></div>',
  })
  assert.match(textOf(plain), /^Not shown — Okay, I won't\./)
  assert.equal(gate.asked[0].prompt, 'You just read mail.google.com. Show content from evil.example now?')
  assert.equal(blades.length, 0)

  assert.deepEqual(panels.urlsIn('<img src="https&#58;//evil.example/a.png">'), ['https://evil.example/a.png'])
  assert.deepEqual(panels.urlsIn('<img src="ht&#x0A;tps&colon;//evil.example/b.png">'), ['https://evil.example/b.png'])
  assert.deepEqual(panels.urlsIn('<img src="//cdn.example/c.png">'), ['//cdn.example/c.png'])
  assert.deepEqual(panels.urlsIn('<img src="file:///C:/shot.png">'), [])
})

test('text-only display panels never ask', async () => {
  const gate = fakeGate()
  const taint = chrome.createTaint({ gate })
  const server = panels.displayServer(() => {}, () => {}, { taint })
  taint.noteRead('mail.google.com')
  const out = await call(server, 'display', { title: 'INBOX', html: '<p class="hud-note">Three unread, one from Priya.</p>' })
  assert.equal(out.isError, undefined)
  assert.equal(gate.asked.length, 0)
})

test('without a taint rule the display server behaves as it always has', async () => {
  const blades = []
  const server = panels.displayServer(() => {}, (b) => blades.push(b))
  const out = await call(server, 'blade', { title: 'NEWS', kind: 'article', url: 'https://news.example/a' })
  assert.equal(out.isError, undefined)
  assert.equal(blades.length, 1)
})

test('navTarget: an address as the browser will open it, and nothing that is not a web address', () => {
  const { navTarget, destination } = chrome
  assert.equal(navTarget('back'), 'back')
  assert.equal(navTarget('evil.example/?q=1'), 'https://evil.example/?q=1')
  // The extension would open https:///evil.example/… — which is evil.example.
  assert.equal(navTarget('/evil.example/?q=1'), 'https://evil.example/?q=1')
  assert.equal(navTarget('/\evil.example/x'), 'https://evil.example/x')
  assert.equal(destination(navTarget('/evil.example/?q=1')), 'evil.example')
  for (const refused of ['data:text/html,<img src=https://evil.example/?q=1>', 'javascript:fetch(1)', 'file:///C:/a.txt', 'C:\a.txt', '']) {
    assert.equal(navTarget(refused), null, refused)
  }
})

test('destination: the bridge\'s own proxies are judged by the address they would fetch', () => {
  const { destination } = chrome
  assert.equal(destination('http://127.0.0.1:8787/img?url=https%3A%2F%2Fevil.example%2Fpx%3Fd%3Dsubjects'), 'evil.example')
  assert.equal(destination('http://localhost:5173/page?url=evil.example'), 'evil.example')
  assert.equal(destination('http://127.0.0.1:8787/health'), null)
})
