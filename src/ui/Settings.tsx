import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { useStore } from '../store'
import { desktop } from '../lib/desktop'
import {
  changeSettings,
  forgetVoice,
  loadSettings,
  saveGeneral,
  settingsAvailable,
  type OwnerRequirement,
  type SettingsSnapshot,
  type SttEngine,
  type Tier,
} from '../lib/settings'
import { currentVoiceName, setPreferredVoice } from '../lib/tts'
import { rankVoices } from '../lib/voiceRank'

/**
 * Settings: everything VAS has learned about you and been allowed to do.
 *
 * A drawer down the right-hand side, so the reactor and the conversation stay
 * in view while you change how JARVIS behaves. Opened from the tray
 * ("Settings…") or with S, closed with Escape or S again. Everything shown
 * comes from the bridge (GET /settings) and every change goes straight back
 * to it; what comes back is what is drawn, so the drawer can never show a
 * list the bridge no longer has. Nothing here needs a restart.
 *
 * Keys pressed inside the drawer stay inside it: Space on a button presses the
 * button rather than waking JARVIS, and Escape closes the drawer rather than
 * standing him down.
 */

type Tab = 'general' | 'corrections' | 'apps' | 'routines' | 'voice' | 'permissions'

const TABS: Array<[Tab, string]> = [
  ['general', 'General'],
  ['corrections', 'Corrections'],
  ['apps', 'Apps'],
  ['routines', 'Routines'],
  ['voice', 'Voice'],
  ['permissions', 'Permissions'],
]

/** Runs one change and draws what the bridge answers with. */
type Run = (change: () => Promise<SettingsSnapshot>, done?: string) => Promise<boolean>

export function Settings() {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<Tab>('general')
  const [data, setData] = useState<SettingsSnapshot | null>(null)
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  // S toggles the drawer, like D does the diagnostics; the tray opens it.
  useEffect(() => {
    if (!settingsAvailable) return
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (e.key === 's' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    const offTray = desktop?.onTray((c) => {
      if (c.cmd === 'settings') setOpen(true)
    })
    return () => {
      window.removeEventListener('keydown', onKey)
      offTray?.()
    }
  }, [])

  const show = (next: SettingsSnapshot) => {
    setData(next)
    // A voice chosen here, or by hand in config.json, is the one he speaks with.
    setPreferredVoice(next.general.tts.voice)
    if (useStore.getState().voice) useStore.getState().setVoice(currentVoiceName())
  }

  useEffect(() => {
    if (!open) return
    setNote(null)
    root.current?.focus()
    loadSettings()
      .then(show)
      .catch((err: Error) => setNote({ text: `Could not read the settings: ${err.message}`, bad: true }))
  }, [open])

  const run: Run = async (change, done = 'Saved.') => {
    setBusy(true)
    try {
      show(await change())
      setNote({ text: done })
      return true
    } catch (err) {
      setNote({ text: (err as Error).message, bad: true })
      return false
    } finally {
      setBusy(false)
    }
  }

  const close = () => {
    setOpen(false)
    root.current?.blur()
  }

  const onKeyDown = (e: ReactKeyboardEvent) => {
    e.stopPropagation()
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
      return
    }
    // The window's own S handler never sees keys pressed in here, so the
    // drawer closes itself — except while typing, or in a list, where S picks
    // the option that starts with it.
    const tag = (e.target as HTMLElement).tagName
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
    if (e.key === 's' && !typing && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault()
      close()
    }
  }

  if (!open) return null

  return (
    <div
      className="settings"
      role="dialog"
      aria-label="Settings"
      tabIndex={-1}
      ref={root}
      onKeyDown={onKeyDown}
      aria-busy={busy}
    >
      <div className="settings-head">
        <span className="settings-title">Settings</span>
        <button type="button" className="settings-close" onClick={close} aria-label="Close settings">
          ×
        </button>
      </div>
      <div className="settings-tabs" role="tablist">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? 'settings-tab settings-tab-on' : 'settings-tab'}
            onClick={() => {
              setTab(id)
              setNote(null)
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="settings-body" role="tabpanel">
        {!data ? (
          <div className="settings-empty">Reading the settings…</div>
        ) : tab === 'general' ? (
          <GeneralTab data={data} run={run} />
        ) : tab === 'corrections' ? (
          <CorrectionsTab data={data} run={run} />
        ) : tab === 'apps' ? (
          <AppsTab data={data} run={run} />
        ) : tab === 'routines' ? (
          <RoutinesTab data={data} run={run} />
        ) : tab === 'voice' ? (
          <VoiceTab data={data} run={run} onLearn={close} />
        ) : (
          <PermissionsTab data={data} run={run} />
        )}
      </div>
      <div className={note?.bad ? 'settings-note settings-note-bad' : 'settings-note'} role="status">
        {note?.text ?? ''}
      </div>
    </div>
  )
}

/* ----------------------------------------------------------------- pieces */

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="settings-field">
      <span className="settings-label">{label}</span>
      {children}
      {hint && <span className="settings-hint">{hint}</span>}
    </label>
  )
}

/**
 * A button for things that cannot be taken back with a click: the first press
 * arms it, the second (within a few seconds) does it.
 */
function ConfirmButton({ label, armed: armedLabel, onConfirm }: { label: string; armed: string; onConfirm: () => void }) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 4000)
    return () => clearTimeout(t)
  }, [armed])
  return (
    <button
      type="button"
      className={armed ? 'settings-btn settings-btn-danger' : 'settings-btn'}
      onClick={() => {
        if (!armed) return setArmed(true)
        setArmed(false)
        onConfirm()
      }}
    >
      {armed ? armedLabel : label}
    </button>
  )
}

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : '')

/* ---------------------------------------------------------------- general */

const OWNER_CHOICES: Array<[OwnerRequirement, string]> = [
  ['all', 'Only my voice — ignore everyone else'],
  ['actions', 'Anyone can talk — only my voice approves actions'],
  ['off', 'Anyone — no voice check'],
]

const ENGINES: Array<[SttEngine, string]> = [
  ['auto', 'Automatic — ElevenLabs Scribe if a key is set'],
  ['local', 'On this PC only (Whisper)'],
  ['scribe', 'ElevenLabs Scribe, this PC as fallback'],
]

const LANGUAGES: Array<[string, string]> = [
  ['auto', 'Detect automatically'],
  ['en', 'English'],
  ['ml', 'Malayalam'],
  ['hi', 'Hindi'],
  ['ta', 'Tamil'],
  ['te', 'Telugu'],
  ['kn', 'Kannada'],
  ['bn', 'Bengali'],
  ['mr', 'Marathi'],
  ['ur', 'Urdu'],
  ['ar', 'Arabic'],
  ['es', 'Spanish'],
  ['fr', 'French'],
  ['de', 'German'],
  ['zh', 'Chinese'],
  ['ja', 'Japanese'],
]

/** The English system voices, best-ranked first, then the rest by name. */
function useSystemVoices(): string[] {
  const read = () => {
    if (typeof speechSynthesis === 'undefined') return []
    const english = speechSynthesis.getVoices().filter((v) => /^en/i.test(v.lang))
    const ranked = rankVoices(english).map((v) => v.name)
    const rest = english.map((v) => v.name).filter((n) => !ranked.includes(n)).sort()
    return [...ranked, ...rest]
  }
  const [voices, setVoices] = useState(read)
  useEffect(() => {
    if (typeof speechSynthesis === 'undefined') return
    const update = () => setVoices(read())
    speechSynthesis.addEventListener('voiceschanged', update)
    return () => speechSynthesis.removeEventListener('voiceschanged', update)
  }, [])
  return voices
}

function GeneralTab({ data, run }: { data: SettingsSnapshot; run: Run }) {
  const g = data.general
  const [name, setName] = useState(g.userName)
  useEffect(() => setName(g.userName), [g.userName])
  const voices = useSystemVoices()
  const voiceChoices = g.tts.voice && !voices.includes(g.tts.voice) ? [...voices, g.tts.voice] : voices
  const languages: Array<[string, string]> = LANGUAGES.some(([code]) => code === g.stt.language)
    ? LANGUAGES
    : [...LANGUAGES, [g.stt.language, g.stt.language]]

  const saveName = () => {
    const next = name.trim()
    if (next && next !== g.userName) void run(() => saveGeneral({ userName: next }))
  }

  return (
    <>
      <Field label="Your name" hint="What JARVIS calls you.">
        <input
          className="settings-input"
          value={name}
          maxLength={40}
          onChange={(e) => setName(e.target.value)}
          onBlur={saveName}
          onKeyDown={(e) => e.key === 'Enter' && saveName()}
        />
      </Field>
      <Field
        label="Whose voice counts"
        hint={data.voice.enrolled ? undefined : 'Applies once your voice is learned (Voice tab).'}
      >
        <select
          className="settings-input"
          value={g.owner.require}
          onChange={(e) => void run(() => saveGeneral({ owner: { require: e.target.value as OwnerRequirement } }))}
        >
          {OWNER_CHOICES.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Speech recognition">
        <select
          className="settings-input"
          value={g.stt.engine}
          onChange={(e) => void run(() => saveGeneral({ stt: { engine: e.target.value as SttEngine } }))}
        >
          {ENGINES.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Language" hint="Mixing English with another language? Detect automatically.">
        <select
          className="settings-input"
          value={g.stt.language}
          onChange={(e) => void run(() => saveGeneral({ stt: { language: e.target.value } }))}
        >
          {languages.map(([code, label]) => (
            <option key={code} value={code}>
              {label}
            </option>
          ))}
        </select>
      </Field>
      <Field
        label="JARVIS's voice"
        hint={currentVoiceName() === 'ElevenLabs' ? 'ElevenLabs is speaking now; this is the voice without it.' : 'Press V to hear the next one.'}
      >
        <select
          className="settings-input"
          value={g.tts.voice ?? ''}
          onChange={(e) => void run(() => saveGeneral({ tts: { voice: e.target.value || null } }))}
        >
          <option value="">Best available</option>
          {voiceChoices.map((v) => (
            <option key={v} value={v}>
              {voices.includes(v) ? v : `${v} (not installed)`}
            </option>
          ))}
        </select>
      </Field>
    </>
  )
}

/* ------------------------------------------------------------ corrections */

function CorrectionsTab({ data, run }: { data: SettingsSnapshot; run: Run }) {
  const [heard, setHeard] = useState('')
  const [meant, setMeant] = useState('')

  const add = async (e: FormEvent) => {
    e.preventDefault()
    if (await run(() => changeSettings('POST', 'corrections', { heard, meant }), 'Learned.')) {
      setHeard('')
      setMeant('')
    }
  }

  return (
    <>
      <p className="settings-lead">Words JARVIS keeps mishearing, and what you meant. Fixed before anything acts on them.</p>
      {data.corrections.length === 0 ? (
        <div className="settings-empty">None yet. Say “no, I said…” after a mishearing, or add one here.</div>
      ) : (
        <ul className="settings-list">
          {data.corrections.map((c) => (
            <li key={c.heard} className="settings-item">
              <span className="settings-item-main">
                “{c.heard}” → “{c.meant}”
                <span className="settings-sub">
                  {c.source === 'voice' ? 'learned by voice' : 'added here'}
                  {c.count ? ` · used ${c.count}×` : ''}
                </span>
              </span>
              <button
                type="button"
                className="settings-btn"
                onClick={() => void run(() => changeSettings('DELETE', 'corrections', { heard: c.heard }), 'Removed.')}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className="settings-add" onSubmit={(e) => void add(e)}>
        <input className="settings-input" placeholder="What he hears" value={heard} maxLength={60} onChange={(e) => setHeard(e.target.value)} />
        <input className="settings-input" placeholder="What you mean" value={meant} maxLength={60} onChange={(e) => setMeant(e.target.value)} />
        <button type="submit" className="settings-btn" disabled={!heard.trim() || !meant.trim()}>
          Add
        </button>
      </form>
    </>
  )
}

/* ------------------------------------------------------------------- apps */

function AppsTab({ data, run }: { data: SettingsSnapshot; run: Run }) {
  const { allowed, aliases } = data.apps
  const [alias, setAlias] = useState('')
  const [appId, setAppId] = useState('')
  const target = allowed.some((a) => a.appId === appId) ? appId : (allowed[0]?.appId ?? '')

  const addAlias = async (e: FormEvent) => {
    e.preventDefault()
    if (await run(() => changeSettings('POST', 'apps/aliases', { alias, appId: target }), 'Alias added.')) setAlias('')
  }

  return (
    <>
      <div className="settings-section">Apps he may open without asking</div>
      {allowed.length === 0 ? (
        <div className="settings-empty">None yet. The first time you ask for an app, he asks once and remembers.</div>
      ) : (
        <ul className="settings-list">
          {allowed.map((a) => (
            <li key={a.appId} className="settings-item">
              <span className="settings-item-main">
                {a.name}
                <span className="settings-sub">allowed {day(a.grantedAt)}</span>
              </span>
              <button
                type="button"
                className="settings-btn"
                onClick={() => void run(() => changeSettings('DELETE', 'apps/allow', { appId: a.appId }), `He will ask before opening ${a.name} again.`)}
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="settings-section">Your names for apps</div>
      {aliases.length === 0 ? (
        <div className="settings-empty">No aliases yet.</div>
      ) : (
        <ul className="settings-list">
          {aliases.map((a) => (
            <li key={a.alias} className="settings-item">
              <span className="settings-item-main">
                “{a.alias}” → {a.name}
              </span>
              <button
                type="button"
                className="settings-btn"
                onClick={() => void run(() => changeSettings('DELETE', 'apps/aliases', { alias: a.alias }), 'Alias removed.')}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {allowed.length > 0 && (
        <form className="settings-add" onSubmit={(e) => void addAlias(e)}>
          <input className="settings-input" placeholder="Say “open …”" value={alias} maxLength={60} onChange={(e) => setAlias(e.target.value)} />
          <select className="settings-input" value={target} onChange={(e) => setAppId(e.target.value)} aria-label="App">
            {allowed.map((a) => (
              <option key={a.appId} value={a.appId}>
                {a.name}
              </option>
            ))}
          </select>
          <button type="submit" className="settings-btn" disabled={!alias.trim()}>
            Add
          </button>
        </form>
      )}
    </>
  )
}

/* --------------------------------------------------------------- routines */

function RoutinesTab({ data, run }: { data: SettingsSnapshot; run: Run }) {
  if (data.routines.length === 0) {
    return <div className="settings-empty">No routines yet. Try “when I say work mode, open VS Code and Chrome”.</div>
  }
  return (
    <ul className="settings-list">
      {data.routines.map((r) => (
        <li key={r.name} className="settings-item">
          <span className="settings-item-main">
            “{r.triggers.join('” / “')}”
            <span className="settings-sub">
              {r.steps.join(' → ')}
              {r.created ? ` · taught ${day(r.created)}` : ''}
            </span>
          </span>
          <ConfirmButton
            label="Delete"
            armed="Really delete?"
            onConfirm={() => void run(() => changeSettings('DELETE', 'routines', { name: r.name }), 'Routine deleted.')}
          />
        </li>
      ))}
    </ul>
  )
}

/* ------------------------------------------------------------------ voice */

function VoiceTab({ data, run, onLearn }: { data: SettingsSnapshot; run: Run; onLearn: () => void }) {
  const v = data.voice
  const learn = () => {
    onLearn()
    useStore.getState().setEnrolling(true)
  }
  const forget = () =>
    void run(async () => {
      await forgetVoice()
      return loadSettings()
    }, 'Your voice is forgotten.')

  return (
    <>
      <p className="settings-lead">
        {v.enrolled
          ? `Your voice is learned (${v.clips} recordings, ${day(v.enrolledAt)}). Other voices can't wake JARVIS or approve actions, depending on “Whose voice counts” in General.`
          : 'JARVIS answers anyone until he has learned your voice. It takes eight short sentences.'}
      </p>
      {!v.available && <div className="settings-empty">The voice model isn't installed yet — download the voice models first.</div>}
      <div className="settings-actions">
        <button type="button" className="settings-btn" disabled={!v.available} onClick={learn}>
          {v.enrolled ? 'Learn it again' : 'Learn my voice'}
        </button>
        {v.enrolled && <ConfirmButton label="Forget my voice" armed="Anyone could talk to him. Forget?" onConfirm={forget} />}
      </div>
    </>
  )
}

/* ------------------------------------------------------------ permissions */

const TIERS: Array<[Tier, string]> = [
  ['free', 'Just do it'],
  ['remember', 'Ask once'],
  ['confirm', 'Ask every time'],
  ['deny', 'Never'],
]

function PermissionsTab({ data, run }: { data: SettingsSnapshot; run: Run }) {
  const p = data.permissions
  const save = (patch: object, done?: string) => void run(() => changeSettings('POST', 'permissions', patch), done)
  return (
    <>
      <label className="settings-check">
        <input type="checkbox" checked={p.lockdown} onChange={(e) => save({ lockdown: e.target.checked }, e.target.checked ? 'Locked down.' : 'Lockdown lifted.')} />
        <span>
          Lockdown
          <span className="settings-sub">Nothing runs except unlocking. Talking still works.</span>
        </span>
      </label>
      <label className="settings-check">
        <input type="checkbox" checked={p.allowClickConfirm} onChange={(e) => save({ allowClickConfirm: e.target.checked })} />
        <span>
          Clicking Confirm counts as a yes
          <span className="settings-sub">Off: only a spoken yes approves an action.</span>
        </span>
      </label>
      <div className="settings-section">What JARVIS asks before doing</div>
      <ul className="settings-list">
        {p.actions.map((a) => (
          <li key={a.action} className="settings-item">
            <span className="settings-item-main">
              {a.label}
              {a.tier !== a.default && (
                <button type="button" className="settings-link" onClick={() => save({ tiers: { [a.action]: null } }, 'Back to the default.')}>
                  reset
                </button>
              )}
            </span>
            <select
              className="settings-input settings-tier"
              value={a.tier}
              aria-label={a.label}
              onChange={(e) => save({ tiers: { [a.action]: e.target.value } })}
            >
              {TIERS.map(([tier, label]) => (
                <option key={tier} value={tier}>
                  {label}
                  {tier === a.default ? ' (default)' : ''}
                </option>
              ))}
            </select>
          </li>
        ))}
      </ul>
    </>
  )
}
