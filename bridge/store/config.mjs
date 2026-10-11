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

const Keyword = z.object({
  name: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  phones: z.array(z.string().min(1)).min(1),
  boost: z.number().min(0).max(10).default(1.5),
  threshold: z.number().min(0).max(1).default(0.25),
  enabled: z.boolean().default(true),
})

export const ConfigSchema = z.object({
  /** What JARVIS calls you. Defaults to your Windows account name. */
  userName: z.string().min(1).max(40).optional(),
  /** Global push-to-talk shortcut, in Electron accelerator syntax. */
  hotkey: z.string().default('Control+Alt+Space'),
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
