import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sendMail } from '../dist/mail.js'

/**
 * The parts of vas-mail that decide before anything is sent: the account
 * settings, the addresses, and refusing a repeat. A stand-in transport records
 * what would have gone to smtp.gmail.com; nothing leaves the machine.
 */
const account = { user: 'me@gmail.com', appPassword: 'app-password-for-tests' }

function recorder() {
  const sent = []
  const opened = []
  return {
    sent,
    opened,
    create: (options) => {
      opened.push({ host: options.host, port: options.port, secure: options.secure, user: options.auth.user })
      return { sendMail: async (m) => (sent.push(m), { messageId: `<m${sent.length}@test>`, accepted: m.to, rejected: [] }) }
    },
  }
}

test('a message goes out over TLS to smtp.gmail.com, from the account, as plain text', async () => {
  const r = recorder()
  const out = await sendMail(account, { to: ['alex@example.com'], subject: 'Lunch', body: 'Free at one?' }, r.create)
  assert.deepEqual(r.opened, [{ host: 'smtp.gmail.com', port: 465, secure: true, user: 'me@gmail.com' }])
  assert.deepEqual(r.sent, [{ from: 'me@gmail.com', to: ['alex@example.com'], cc: undefined, subject: 'Lunch', text: 'Free at one?' }])
  assert.equal(out.messageId, '<m1@test>')
})

test('the same message twice within a minute is refused, a different one is not', async () => {
  const r = recorder()
  const msg = { to: ['sam@example.com'], subject: 'Hi', body: 'Repeat me' }
  await sendMail(account, msg, r.create)
  await assert.rejects(sendMail(account, msg, r.create), (e) => e.name === 'ToolInputError' && /just sent/.test(e.message))
  await sendMail(account, { ...msg, body: 'Something else' }, r.create)
  assert.equal(r.sent.length, 2)
})

test('missing settings and bad addresses are refused in words, before any connection', async () => {
  const r = recorder()
  const msg = { to: ['alex@example.com'], subject: 's', body: 'b' }
  await assert.rejects(sendMail({ appPassword: 'x' }, msg, r.create), /no Gmail address set/)
  // An unresolved SecretRef arrives as an object: fail closed.
  await assert.rejects(
    sendMail({ user: 'me@gmail.com', appPassword: { source: 'store', provider: 'default', id: 'GMAIL_APP_PASSWORD' } }, msg, r.create),
    /app password isn't set/,
  )
  await assert.rejects(sendMail(account, { ...msg, to: ['not an address'] }, r.create), /"not an address" isn't an email address/)
  assert.deepEqual(r.opened, [])
})
