import { BACKEND, BRIDGE_HTTP_URL } from '../config'

/**
 * The bridge's Settings endpoints (bridge/settings.mjs), as the face sees
 * them. Every change answers with the whole new picture, so the drawer simply
 * re-renders what comes back rather than patching its own copy and hoping the
 * two agree.
 */

export type OwnerRequirement = 'all' | 'actions' | 'off'
export type SttEngine = 'auto' | 'local' | 'scribe'
export type Tier = 'free' | 'remember' | 'confirm' | 'deny'

export type SettingsSnapshot = {
  general: {
    userName: string
    stt: { engine: SttEngine; language: string }
    owner: { require: OwnerRequirement }
    tts: { voice: string | null }
    hotkey: string
  }
  corrections: Array<{ heard: string; meant: string; count: number; createdAt: string; source: string }>
  apps: {
    allowed: Array<{ appId: string; name: string; grantedAt: string }>
    aliases: Array<{ alias: string; appId: string; name: string }>
  }
  routines: Array<{ name: string; triggers: string[]; steps: string[]; source: string | null; created: string | null }>
  permissions: {
    lockdown: boolean
    allowClickConfirm: boolean
    actions: Array<{ action: string; label: string; tier: Tier; default: Tier; alwaysAsks?: boolean }>
  }
  voice: { available: boolean; enrolled: boolean; clips: number; enrolledAt: string | null }
}

export type GeneralPatch = {
  userName?: string
  stt?: { engine?: SttEngine; language?: string }
  owner?: { require: OwnerRequirement }
  tts?: { voice: string | null }
}

/** Settings live in the bridge; the direct (no-bridge) build has none. */
export const settingsAvailable = BACKEND === 'bridge'

async function reply(res: Response): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> = {}
  try {
    body = (await res.json()) as Record<string, unknown>
  } catch {
    /* an empty or non-JSON error body: the status says enough */
  }
  if (!res.ok || body.ok === false) {
    throw new Error(typeof body.reason === 'string' ? body.reason : `Settings request failed (${res.status}).`)
  }
  return body
}

export async function loadSettings(timeoutMs = 5000): Promise<SettingsSnapshot> {
  const res = await fetch(`${BRIDGE_HTTP_URL}/settings`, { signal: AbortSignal.timeout(timeoutMs) })
  return (await reply(res)) as unknown as SettingsSnapshot
}

/**
 * One change: `section` is the path under /settings ("general",
 * "corrections", "apps/aliases"…). Throws with the bridge's own reason —
 * worded to be shown as it is — when the change is refused.
 */
export async function changeSettings(method: 'POST' | 'DELETE', section: string, body: unknown): Promise<SettingsSnapshot> {
  const res = await fetch(`${BRIDGE_HTTP_URL}/settings/${section}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return (await reply(res)).settings as SettingsSnapshot
}

export const saveGeneral = (patch: GeneralPatch) => changeSettings('POST', 'general', patch)

/** The voice-enrollment endpoint the drawer's "Forget my voice" reuses. */
export async function forgetVoice(): Promise<void> {
  await reply(await fetch(`${BRIDGE_HTTP_URL}/voice/enroll`, { method: 'DELETE' }))
}
