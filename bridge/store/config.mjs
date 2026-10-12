import { userInfo } from 'node:os'
import { z } from 'zod'
import { readJson, writeJsonAtomic } from './files.mjs'

/**
 * VAS settings — %APPDATA%\VAS\data\config.json.
 *
 * Every field has a default, so an empty or missing file is a valid config and
 * the user only ever writes down what they want to change.
 */

/**
 * "Hey Jarvis", written as the ARPAbet phones the keyword spotter listens for.
 * The second spelling covers the unstressed final vowel most people actually
 * say. Thresholds are starting points; voice enrollment tunes them per user.
 */
export const DEFAULT_WAKE_KEYWORDS = [
  {
    name: 'HEY_JARVIS',
    phones: ['HH EY1 JH AA1 R V AH0 S', 'HH EY1 JH AA1 R V IH0 S'],
    boost: 1.5,
    threshold: 0.25,
    enabled: true,
  },
]

const KeywordEntry = z
  .object({
    name: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    /** ARPAbet phones, one string per way of saying it. */
    phones: z.array(z.string().min(1)).default([]),
    /** Or plain words ("hey friday"), turned into phones from the keyword
     *  model's own dictionary when the keywords file is built. */
    phrases: z.array(z.string().min(1).max(80)).default([]),
    boost: z.number().min(0).max(10).default(1.5),
    threshold: z.number().min(0).max(1).default(0.25),
    enabled: z.boolean().default(true),
  })
  .refine((k) => k.phones.length + k.phrases.length > 0, 'a wake keyword needs phones or phrases')

/** "hey friday" -> HEY_FRIDAY, the name the spotter reports it by. */
function keywordName(phrase) {
  const name = phrase.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return /^[A-Z]/.test(name) ? name : `WAKE_${name}`
}

/**
 * One wake keyword: in full, or just the words — "hey friday" in the list is
 * { name: 'HEY_FRIDAY', phrases: ['hey friday'] } with the default boost and
 * threshold.
 */
const Keyword = z.union([
  z
    .string()
    .trim()
    .min(1)
    .max(80)
    .transform((phrase) => ({ name: keywordName(phrase), phrases: [phrase] }))
    .pipe(KeywordEntry),
  KeywordEntry,
])

export const ConfigSchema = z.object({
  /** What JARVIS calls you. Defaults to your Windows account name. */
  userName: z.string().min(1).max(40).optional(),
  /** Global push-to-talk shortcut, in Electron accelerator syntax. */
  hotkey: z.string().default('Control+Alt+Space'),
  /** Your own names for sites, for "open … in chrome": spoken name -> address,
   *  e.g. { "hn": "news.ycombinator.com" }. Laid over the built-in list. */
  sites: z.record(z.string(), z.string()).default({}),
  wake: z
    .object({ keywords: z.array(Keyword).default(DEFAULT_WAKE_KEYWORDS) })
    .prefault({}),
  stt: z
    .object({
      /** auto = ElevenLabs Scribe when a key exists, else local Whisper. */
      engine: z.enum(['auto', 'local', 'scribe']).default('auto'),
      model: z.enum(['whisper-base', 'whisper-small']).default('whisper-base'),
      /** Whisper language hint; 'auto' lets it detect per utterance. */
      language: z.string().default('en'),
    })
    .prefault({}),
  owner: z
    .object({
      /** Once a voice is enrolled: ignore everyone else entirely ('all', the
       *  default — what "only respond to my voice" means), only for approving
       *  actions ('actions'), or not at all ('off'). */
      require: z.enum(['actions', 'all', 'off']).default('all'),
    })
    .prefault({}),
})

/** The capitalised Windows account name — "aswin" becomes "Aswin". */
function accountName() {
  const n = userInfo().username || 'there'
  return n.charAt(0).toUpperCase() + n.slice(1)
}

export async function loadConfig() {
  const cfg = await readJson('config.json', ConfigSchema)
  return { ...cfg, userName: cfg.userName ?? accountName() }
}

export async function saveConfig(cfg) {
  await writeJsonAtomic('config.json', ConfigSchema.parse(cfg))
}
