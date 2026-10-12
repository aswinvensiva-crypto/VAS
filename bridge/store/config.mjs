import { userInfo } from 'node:os'
import { z } from 'zod'
import { readJson, readRawJson, writeJsonAtomic } from './files.mjs'

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
       *  actions ('actions'), or not at all ('off'). The one owner setting:
       *  the voice pipeline and the permission gate both read it. */
      require: z.enum(['actions', 'all', 'off']).default('all'),
    })
    .prefault({}),
  tts: z
    .object({
      /** The system voice JARVIS speaks with, by name ("Microsoft Ryan"). Used
       *  whenever it is installed; otherwise the best-ranked one is. */
      voice: z.string().min(1).max(200).optional(),
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

/**
 * The config as it is on disk right now, for applying a change while VAS
 * runs. Unlike loadConfig, a broken file throws instead of reading as the
 * defaults: half-way through a hand edit, the settings already in effect are
 * a far better answer than a sudden reset to factory.
 */
export async function readConfigStrict() {
  const cfg = ConfigSchema.parse((await readRawJson('config.json')) ?? {})
  return { ...cfg, userName: cfg.userName ?? accountName() }
}

export async function saveConfig(cfg) {
  await writeJsonAtomic('config.json', ConfigSchema.parse(cfg))
}

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** `patch` laid over `base`, object by object; a null removes that key. */
function merge(base, patch) {
  const out = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key]
    else if (isPlain(value) && isPlain(out[key])) out[key] = merge(out[key], value)
    else out[key] = value
  }
  return out
}

/**
 * Change a few settings and keep the rest exactly as written.
 *
 * Only what changed lands in the file: the result is checked against the
 * whole schema, but the defaults that check fills in are not written back, so
 * the file stays the short list of things the user actually chose — and a
 * later VAS with better defaults still gets to apply them. A null in `patch`
 * puts that setting back to its default. Throws (a ZodError naming the field)
 * when the result would not be a valid config, leaving the file untouched.
 *
 * @param {object} patch  e.g. { owner: { require: 'actions' } }
 * @returns the full config, as loadConfig would read it now
 */
export async function updateConfig(patch) {
  const written = (await readRawJson('config.json')) ?? {}
  const next = merge(isPlain(written) ? written : {}, patch)
  ConfigSchema.parse(next)
  await writeJsonAtomic('config.json', next)
  return readConfigStrict()
}

/**
 * Whose voice counts used to be two settings with different defaults:
 * owner.require here, for what is heard at all, and requireOwner in
 * permissions.json, for whose yes approves an action. It is one setting now,
 * this one, read by both. An old permissions.json value is carried over once
 * and then dropped from that file.
 *
 * Only 'all' is carried over. 'actions' was that file's default, written into
 * every permissions.json the first time anything saved it (a lockdown, say),
 * so finding it says nothing about what the user chose — and it judged a yes
 * exactly as the unified default does. 'off' there only relaxed whose yes
 * counts; here it would also stop ignoring everyone else's voice, which nobody
 * chose, so it is left at the default with a note in the log instead. A value
 * already set here wins; the old one is just removed.
 *
 * Never fatal: this runs before the bridge starts, and a config.json that
 * fails its schema is otherwise only a warning (loadConfig uses defaults).
 */
export async function migrateOwnerRequirement() {
  let permissions
  let config
  try {
    permissions = await readRawJson('permissions.json')
    config = (await readRawJson('config.json')) ?? {}
  } catch (err) {
    // A file being hand-edited into shape; try again next start.
    console.warn(`[jarvis] owner setting not migrated: ${err.message}`)
    return
  }
  if (!isPlain(permissions) || !Object.hasOwn(permissions, 'requireOwner')) return
  const legacy = permissions.requireOwner
  try {
    if (legacy === 'all' && config.owner?.require === undefined) {
      await updateConfig({ owner: { require: legacy } })
      console.log(`[jarvis] moved requireOwner "${legacy}" from permissions.json to config.json (owner.require)`)
    } else if (legacy === 'off' && config.owner?.require === undefined) {
      console.log(
        '[jarvis] permissions.json had requireOwner "off"; owner.require stays "all". ' +
          'Choose who can talk and approve in Settings > General.',
      )
    }
    delete permissions.requireOwner
    await writeJsonAtomic('permissions.json', permissions)
  } catch (err) {
    console.warn(`[jarvis] owner setting not migrated: ${err.message}`)
  }
}
