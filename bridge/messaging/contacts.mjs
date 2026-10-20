import { z } from 'zod'
import { readJson, writeJsonAtomic } from '../store/files.mjs'

/**
 * Who you message, by the name you say: contacts.json in the data folder,
 * edited in Settings → Contacts. Each entry can carry an email address, a
 * WhatsApp number (E.164, "+919876543210") and a Telegram chat (a numeric id
 * or @username) — whichever you use with that person.
 *
 * Anyone else can still be reached by saying or typing the address itself;
 * every send is read back and confirmed first either way.
 */
const Email = z.string().trim().toLowerCase().regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'an email address like alex@example.com')
const Phone = z
  .string()
  .transform((s) => s.replace(/[\s().-]/g, ''))
  .pipe(z.string().regex(/^\+[1-9]\d{6,14}$/, 'a number with its country code, like +919876543210'))
const TelegramChat = z.string().trim().regex(/^(@[A-Za-z0-9_]{5,32}|-?\d{3,20})$/, 'an @username or a numeric chat id')

export const Contact = z
  .object({
    name: z.string().trim().min(1).max(60),
    email: Email.optional(),
    whatsapp: Phone.optional(),
    telegram: TelegramChat.optional(),
  })
  .strict()

const ContactsFile = z.object({
  version: z.literal(1).default(1),
  contacts: z.array(Contact).default([]),
})

export const CHANNELS = {
  email: { field: 'email', literal: Email, label: 'email address' },
  whatsapp: { field: 'whatsapp', literal: Phone, label: 'WhatsApp number' },
  telegram: { field: 'telegram', literal: TelegramChat, label: 'Telegram chat' },
}

export const loadContacts = async () => (await readJson('contacts.json', ContactsFile)).contacts
export const saveContacts = (contacts) => writeJsonAtomic('contacts.json', ContactsFile.parse({ version: 1, contacts }))

const key = (s) => String(s ?? '').trim().toLowerCase().replace(/[.,!?]+$/, '').replace(/\s+/g, ' ')

/** "alex dot smith at gmail dot com" → "alex.smith@gmail.com"; "plus nine one 98…" is left to the face's digits. */
export function spokenAddress(s) {
  return String(s ?? '')
    .trim()
    .replace(/\s+at\s+/gi, '@')
    .replace(/\s+dot\s+/gi, '.')
    .replace(/\s*@\s*/g, '@')
}

/**
 * Who `spoken` is on `channel`: a saved contact by name, or the address itself.
 * @returns {{ to: string, name: string | null } | { problem: string }}
 */
export async function resolveRecipient(spoken, channel, contacts) {
  const c = CHANNELS[channel]
  const list = contacts ?? (await loadContacts())
  const wanted = key(spoken).replace(/^(to )/, '')
  const byName = list.find((p) => key(p.name) === wanted)
  if (byName) {
    if (byName[c.field]) return { to: byName[c.field], name: byName.name }
    return { problem: `I don't have a ${c.label} for ${byName.name}. Add one in Settings, under Contacts.` }
  }
  const literal = c.literal.safeParse(channel === 'email' ? spokenAddress(spoken) : spoken)
  if (literal.success) return { to: literal.data, name: null }
  return { problem: `I don't know who "${String(spoken).trim()}" is. Add them in Settings, under Contacts, or say their ${c.label}.` }
}
