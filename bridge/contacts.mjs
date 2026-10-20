import { z } from 'zod'
import { readJson, writeJsonAtomic } from './store/files.mjs'

/**
 * The people JARVIS can message by name: "email Alex", "WhatsApp Mum".
 * contacts.json in the data folder, edited in Settings → Contacts.
 *
 * Any address can still be used by saying it ("email alex at gmail dot com",
 * "WhatsApp plus nine one …"); a contact only saves saying it. Either way the
 * send is read back and needs a yes (neurons/lib/messaging.mjs).
 */

export const CHANNELS = ['email', 'whatsapp', 'telegram']

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PHONE = /^\+\d{8,15}$/
const TELEGRAM = /^(@[A-Za-z][A-Za-z0-9_]{4,31}|-?\d{5,15})$/

const Contact = z.object({
  name: z.string().trim().min(1).max(60),
  email: z.string().regex(EMAIL, 'an email address').optional(),
  whatsapp: z.string().regex(PHONE, 'a number with its country code, like +919876543210').optional(),
  telegram: z.string().regex(TELEGRAM, 'a Telegram @username or chat id').optional(),
})
const ContactsFile = z.object({
  version: z.literal(1).default(1),
  contacts: z.array(Contact).default([]),
})

export const loadContacts = async () => (await readJson('contacts.json', ContactsFile)).contacts
export const saveContacts = (contacts) => writeJsonAtomic('contacts.json', ContactsFile.parse({ version: 1, contacts }))
export const validateContact = (c) => Contact.safeParse(c)

const key = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ')

/**
 * Speech to an address: "alex at gmail dot com" → alex@gmail.com,
 * "plus nine one nine eight …" → +9198…, "at alex underscore k" → @alex_k.
 */
export function spokenAddress(channel, spoken) {
  let s = key(spoken)
  const DIGITS = { zero: '0', oh: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9' }
  if (channel === 'email') {
    s = s.replace(/\s+at\s+/g, '@').replace(/\s+dot\s+/g, '.').replace(/\s+underscore\s+/g, '_').replace(/\s+dash\s+/g, '-').replace(/\s+/g, '')
    return EMAIL.test(s) ? s : null
  }
  if (channel === 'whatsapp') {
    s = s.replace(/\bplus\b/g, '+').replace(/\b(zero|oh|one|two|three|four|five|six|seven|eight|nine)\b/g, (w) => DIGITS[w]).replace(/[\s().-]/g, '')
    return PHONE.test(s) ? s : null
  }
  if (channel === 'telegram') {
    s = s.replace(/^at\s+/, '@').replace(/\s+underscore\s+/g, '_').replace(/\s+/g, '')
    return TELEGRAM.test(s) ? s : null
  }
  return null
}

/**
 * Who `spoken` is on `channel`: a saved contact by name, or an address said
 * out loud. Returns { to, label } or { problem } worded to be said.
 */
export function resolveRecipient(channel, spoken, contacts) {
  const name = key(spoken).replace(/^(to|my)\s+/, '')
  const contact = contacts.find((c) => key(c.name) === name)
  if (contact) {
    const to = contact[channel]
    if (!to) return { problem: `I don't have ${contact.name}'s ${channel === 'email' ? 'email address' : channel} — add it in Settings → Contacts.` }
    return { to, label: `${contact.name} (${to})` }
  }
  const to = spokenAddress(channel, spoken)
  if (to) return { to, label: to }
  return {
    problem:
      channel === 'email'
        ? `I don't know who "${spoken}" is. Say their email address, or add them in Settings → Contacts.`
        : channel === 'whatsapp'
          ? `I don't know who "${spoken}" is. Say their number with the country code, or add them in Settings → Contacts.`
          : `I don't know who "${spoken}" is. Say their Telegram username, or add them in Settings → Contacts.`,
  }
}
