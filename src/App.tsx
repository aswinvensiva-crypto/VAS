import { useEffect, useRef } from 'react'
import { Scene } from './scene/Scene'
import { Hud } from './ui/Hud'
import { Boot } from './ui/Boot'
import { Ignition } from './ui/Ignition'
import { Diagnostics } from './ui/Diagnostics'
import { Enroll } from './ui/Enroll'
import { ModelsBanner } from './ui/ModelsBanner'
import { Settings } from './ui/Settings'
import { useStore } from './store'
import { startVoice, type Heard, type Voice, type VoiceMode } from './lib/voice'
import { createSpeaker, cycleVoice, currentVoiceName, speakingNow, syncVoicePreference } from './lib/tts'
import * as sfx from './lib/sfx'
import * as music from './lib/music'
import * as hands from './lib/hands'
import { listenForClap } from './lib/clap'
import * as camera from './lib/camera'
import * as kokoro from './lib/kokoro'
import { TTS_ENGINE } from './config'
import { forTool, attention } from './lib/fillers'
import {
  ask,
  warm,
  interrupt,
  watchServers,
  watchPanels,
  watchBlades,
  watchCapture,
  watchConfirm,
  watchApp,
  watchUi,
  watchConnection,
  connectedLabels,
  usingBridge,
  type Msg,
} from './lib/brain'
import { startAnalyser, micLevel } from './lib/audio'
import { probeCapabilities } from './lib/capabilities'
import { env } from './config'
// The same mishearings the wake word accepts — otherwise a turn that woke him
// as "travis" gets that word sent on to the model as a question.
import { BARE_NAME, LEADING_NAME } from './lib/wakeWords'
import { desktop } from './lib/desktop'
import type { ConfirmAnswer, ConfirmRequest, HeardMeta } from './lib/bridge'
import { watchNotice } from './lib/bridge'

/**
 * The conversation.
 *
 * This used to be a sequential loop — greet, await a capture, await an answer,
 * repeat — with the microphone opened and closed around each step. That shape
 * cannot be interrupted: while it is awaiting the answer, nothing is listening,
 * so there is no way for the user to get a word in.
 *
 * It is an event machine now. The voice loop runs continuously and pushes
 * events at us; every one of them is legal in every phase. Saying anything at
 * all stops him talking, and whatever you say next becomes the new turn.
 */

/** How long to wait for someone to start speaking after he wakes. Generous:
 *  people say his name and *then* think about what they wanted. */
const AWAIT_SPEECH_MS = 14000

/** After an answer, how long the mic stays open for a follow-up before he
 *  drops back to standby. Long enough that you don't have to say the name
 *  again to continue a thought. */
const FOLLOW_UP_MS = 11000

/** crypto.randomUUID needs a secure context, which a LAN address over plain
 *  http is not. Not worth failing a whole turn over an id. */
const newId = () =>
  globalThis.crypto?.randomUUID?.() ??
  `id${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`

export default function App() {
  const store = useStore
  const phase = useStore((s) => s.phase)
  const history = useRef<Msg[]>([])
  const speaker = useRef<ReturnType<typeof createSpeaker> | null>(null)
  const voice = useRef<Voice | null>(null)

  /**
   * Monotonic turn counter. Every await in a turn checks it on the way out:
   * if it has moved, that turn was superseded by a barge-in and must not touch
   * the phase, the speaker, or the busy state on its way to the floor.
   */
  const turn = useRef(0)
  const booting = useRef(false)
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** When the open listening window closes (0: none is open). */
  const idleDeadline = useRef(0)
  /** The tray's "Listening for Hey Jarvis" switch. Off means the wake word is
   *  ignored; the hotkey and Space still start a turn, because those are an
   *  explicit request rather than something overheard. */
  const wakeListening = useRef(true)
  /** The permission gate's open question, if any, and how to settle it. */
  const pendingConfirm = useRef<{ id: string; finish: (a: ConfirmAnswer) => void } | null>(null)
  /** Speaks the question, separately from the turn's own voice. */
  const confirmVoice = useRef<ReturnType<typeof createSpeaker> | null>(null)
  /** When the open question finished playing (Infinity while it still is).
   *  The voice loop accepts only speech that began after it as the answer. */
  const questionEnd = useRef(0)
  const voicePoll = useRef<ReturnType<typeof setInterval> | null>(null)

  // -- helpers --------------------------------------------------------------

  const clearIdle = () => {
    if (idleTimer.current) clearTimeout(idleTimer.current)
    idleTimer.current = null
  }

  const silence = () => {
    speaker.current?.cancel()
    speaker.current = null
  }

  const goDormant = () => {
    pendingConfirm.current?.finish({ source: 'voice', cancelled: true })
    clearIdle()
    idleDeadline.current = 0
    silence()
    turn.current++
    const s = store.getState()
    s.setCaption('')
    s.setActiveTool(null)
    music.working(false)
    music.duck(false)
    sfx.duck(false)
    s.setPhase('dormant')
  }

  /** Open the mic and wait. `window` is how long before he gives up. */
  const listen = (window: number) => {
    clearIdle()
    const s = store.getState()
    s.setCaption('')
    s.setPhase('listening')
    sfx.play('listen')
    idleDeadline.current = Date.now() + window
    idleTimer.current = setTimeout(goDormant, window)
  }

  // -- one turn -------------------------------------------------------------

  /** `heard` is what the voice loop knew about the words (raw transcript and
   *  segment ids), handed to the bridge with them; absent for typed text. */
  const respond = async (said: string, heard?: HeardMeta): Promise<void> => {
    const mine = ++turn.current
    const stale = () => mine !== turn.current

    // The listening window this turn interrupts, handed back unchanged if it
    // turns out to be someone else's (see `ignored` below).
    const deadline = idleDeadline.current
    clearIdle()
    const s = store.getState()
    // Last turn's panels and blades go now, before the new answer starts
    // putting its own up. Anything the model marked sticky survives.
    s.clearPanels()
    s.clearBlades()
    s.setCaption('')
    const userTurnId = newId()
    s.pushTurn({ id: userTurnId, role: 'user', text: said })
    s.setPhase('thinking')

    // Whatever was still talking outside a turn — a notice, a voice demo —
    // stops: a new answer never plays over it, and nothing could stop it later.
    speaker.current?.cancel()
    const spk = createSpeaker()
    speaker.current = spk
    sfx.duck(true)
    music.duck(true)

    const turnId = newId()
    let started = false
    let filled = false
    /** What the turn asked for afterwards — "go to sleep" stands him down. */
    let after: string | undefined
    /** The bridge heard someone else's voice and answered nothing. */
    let ignoredTurn = false

    try {
      const { text, after: next, ignored } = await ask(said, history.current, {
        onText: (delta) => {
          if (stale()) return
          if (!started) {
            started = true
            store.getState().setPhase('speaking')
            // The answer arriving is what ends the tool phase — a timer would
            // clear the readout while a slow tool was still running.
            store.getState().setActiveTool(null)
            music.working(false)
            store.getState().pushTurn({ id: turnId, role: 'jarvis', text: '' })
          }
          store.getState().appendToLastTurn(delta)
          spk.push(delta)
        },
        onTool: (name) => {
          if (stale()) return
          // Only claim the tooling phase while he has nothing to say yet.
          // Setting it unconditionally pinned the machine in 'tooling' for the
          // rest of any answer that called a tool after it started talking,
          // which also broke the reactor's lip-sync for the remainder.
          if (!started) store.getState().setPhase('tooling')
          store.getState().setActiveTool(name)
          sfx.play('tool')
          music.working(true)
          // Say something the moment work starts — a tool can take ten seconds
          // and silence that long reads as a crash. Once per turn only; a
          // chain of five tools shouldn't produce five apologies.
          if (!filled && !started) {
            filled = true
            spk.say(forTool(name))
          }
        },
      }, heard)
      after = next
      ignoredTurn = Boolean(ignored)

      if (stale()) return

      // The bridge keeps conversation state in its own session, so history is
      // only threaded through on the direct path.
      if (!usingBridge) {
        history.current.push({ role: 'user', content: said })
        history.current.push({ role: 'assistant', content: text || '…' })
        if (history.current.length > 16) {
          history.current = history.current.slice(-16)
        }
      }

      await spk.end()
      if (stale()) return
      // The bridge heard someone else's voice and answered nothing. No chime
      // for a turn that never happened; just back to listening.
      if (!ignored) sfx.play('done')
    } catch (err) {
      if (stale()) return
      console.error(err)
      sfx.play('error')
      store
        .getState()
        .setError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      if (!stale()) {
        speaker.current = null
        sfx.duck(false)
        music.duck(false)
        store.getState().setActiveTool(null)
        music.working(false)
        if (ignoredTurn) {
          // Not a turn at all: their words come off the transcript, and the
          // window goes back to closing when it would have — no chime, and no
          // fresh follow-up, or a TV talking would keep him awake for good.
          store.getState().dropTurn(userTurnId)
          const left = deadline - Date.now()
          if (left <= 0) goDormant()
          else {
            store.getState().setPhase('listening')
            idleTimer.current = setTimeout(goDormant, left)
          }
        } else if (after === 'dormant') goDormant()
        // Stay open. Having to say his name again to add one more sentence is
        // the difference between a conversation and a vending machine —
        // unless the turn itself was "go to sleep".
        else listen(FOLLOW_UP_MS)
      }
    }
  }

  // -- voice events ---------------------------------------------------------

  /** What the voice loop should do with what it hears, derived from phase. */
  const mode = (): VoiceMode => {
    // The enrollment screen has the microphone; nothing said there is a command.
    if (store.getState().enrolling) return 'deaf'
    switch (store.getState().phase) {
      case 'offline':
      case 'boot':
        return 'deaf'
      case 'dormant':
        return wakeListening.current ? 'wake' : 'deaf'
      case 'waking':
      case 'listening':
        return 'command'
      case 'confirming':
        // Raised guard while the question is being spoken, so it is not heard
        // as its own answer; then wide open for the yes or no.
        return speakingNow() ? 'guard' : 'command'
      default:
        return 'guard' // thinking, tooling, speaking
    }
  }

  /** `heard` is what the bridge knew about the wake segment — its raw words,
   *  id, and voice — which the command riding on it carries to the bridge. */
  const onWake = (trailing: string, heard?: Heard) => {
    const phase = store.getState().phase
    if (phase === 'offline' || phase === 'boot') return

    store.getState().setError(null)
    sfx.play('wake')

    // "Jarvis, what's happening in AI this week" in one breath. Waiting for a
    // greeting he didn't need is the most common way an assistant wastes time.
    if (trailing) {
      void respond(trailing, heard)
      return
    }

    store.getState().setPhase('waking')

    // Answer to his name. Deliberately NOT awaited any more: the microphone is
    // already open and the echo filter knows his voice, so the user can talk
    // straight over the greeting instead of waiting it out.
    speaker.current?.cancel()
    const greeting = createSpeaker()
    speaker.current = greeting
    greeting.say(attention())
    void greeting.end().then(() => {
      if (speaker.current === greeting) speaker.current = null
    })

    listen(AWAIT_SPEECH_MS)
  }

  /**
   * Someone started talking. This is the whole point of the rewrite: he stops,
   * immediately, whatever he was doing.
   */
  const onSpeechStart = () => {
    clearIdle()
    const phase = store.getState().phase
    if (phase === 'offline' || phase === 'boot' || phase === 'dormant') return
    // Answering "shall I?" must not cut off the turn that is waiting for the
    // answer — nor the question itself any more. Speech that begins while the
    // question is still playing can never be taken as its answer (that is the
    // one way the question could approve itself; see answersQuestion), so
    // cutting the question short for it would leave the user unheard and
    // unasked. The question finishes, and the answer that follows it counts.
    if (phase === 'confirming') return

    const wasBusy =
      phase === 'thinking' || phase === 'tooling' || phase === 'speaking'

    silence()
    if (wasBusy) {
      // Abandon the answer in flight. The turn counter moves in respond()'s
      // replacement; bumping it here covers the case where nothing replaces it.
      turn.current++
      interrupt()
      store.getState().setActiveTool(null)
      music.working(false)
      sfx.duck(false)
      music.duck(false)
    }
    store.getState().setPhase('listening')
  }

  const onUtterance = (text: string, heard?: Heard) => {
    const phase = store.getState().phase
    if (phase === 'offline' || phase === 'boot' || phase === 'dormant') return
    if (pendingConfirm.current) {
      // The words go back as heard — raw, before any learned correction, with
      // the segment ids — and the bridge decides what they mean.
      pendingConfirm.current.finish({ source: 'voice', text, raw: heard?.raw, utts: heard?.utts })
      return
    }

    // People keep using his name as a vocative once they're already talking to
    // him. Strip it rather than sending "jarvis" to the model as a question.
    if (BARE_NAME.test(text)) {
      listen(AWAIT_SPEECH_MS)
      return
    }
    const said = text.replace(LEADING_NAME, '').trim()
    if (!said) {
      listen(AWAIT_SPEECH_MS)
      return
    }

    // The raw words lose the name the same way, or a correction learned from
    // them would see "jarvis" as one more word that was misheard.
    const raw = (heard?.raw ?? text).replace(LEADING_NAME, '').trim()
    void respond(said, { raw, utts: heard?.utts })
  }

  const onPartial = (text: string) => {
    store.getState().setCaption(text)
  }

  const onVoiceError = (message: string) => {
    store.getState().setError(message)
  }

  /**
   * The permission gate asking before JARVIS acts.
   *
   * The turn that wants to act is paused on the bridge, waiting for this. The
   * question is spoken and shown with Confirm / Cancel; the next thing said is
   * the answer (straight through, unassembled), and silence past the timeout
   * is a no. Afterwards the interface goes back to the turn in progress.
   */
  const askConfirm = (req: ConfirmRequest) =>
    new Promise<ConfirmAnswer>((resolve) => {
      pendingConfirm.current?.finish({ source: 'voice', cancelled: true })
      const s = store.getState()
      const resumeTo = s.phase === 'confirming' ? 'thinking' : s.phase
      let settled = false
      const finish = (a: ConfirmAnswer) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        confirmVoice.current?.cancel()
        confirmVoice.current = null
        pendingConfirm.current = null
        store.getState().setConfirm(null)
        if (store.getState().phase === 'confirming') store.getState().setPhase(resumeTo)
        resolve(a)
      }
      const timer = setTimeout(() => finish({ source: 'voice', cancelled: true }), req.timeoutMs)
      pendingConfirm.current = { id: req.id, finish }
      clearIdle()
      s.setConfirm({ id: req.id, prompt: req.prompt, answer: (a) => finish(a) })
      s.setPhase('confirming')
      sfx.play('listen')
      const q = createSpeaker()
      confirmVoice.current = q
      // Until it has finished playing, nothing heard can be its answer. A voice
      // that fails counts as finished: a question stuck "still playing" would
      // leave the user unable to answer it except by clicking.
      questionEnd.current = Infinity
      q.say(req.prompt)
      void q
        .end()
        .catch(() => {})
        .then(() => {
          if (confirmVoice.current === q) questionEnd.current = Date.now()
        })
    })

  const cancelConfirm = (id: string) => {
    const p = pendingConfirm.current
    if (p && (id === '*' || id === p.id)) p.finish({ source: 'voice', cancelled: true })
  }

  /**
   * Start a turn without the wake word — Space in the window, or the global
   * push-to-talk hotkey from anywhere. Powers him up if he is off, cuts in if
   * he is busy, and otherwise opens the microphone for a command.
   */
  const manualTrigger = () => {
    const phase = store.getState().phase
    if (phase === 'confirming') return // answer the question first
    if (phase === 'offline') {
      void powerOn()
    } else if (phase === 'boot') {
      /* ignore — the boot sequence owns the phase until it finishes */
    } else if (phase === 'thinking' || phase === 'tooling' || phase === 'speaking') {
      onSpeechStart()
      listen(AWAIT_SPEECH_MS)
    } else {
      onWake('')
    }
  }

  // -- power on -------------------------------------------------------------

  const powerOn = async () => {
    // The ignition button and the space bar can both land here, and the phase
    // only moves after the first await — so without this a double press boots
    // twice, arming two voice loops and two download polls.
    if (booting.current) return
    booting.current = true

    try {
      await ignite()
    } catch (err) {
      // The guard must not outlive a failed boot. Audio unlock can be refused,
      // the microphone prompt dismissed, the bridge unreachable at the wrong
      // moment — and with the flag still latched the ignition button was dead
      // for the rest of the page, recoverable only by reloading. Reset it and
      // put the button back so the user can simply press it again.
      booting.current = false
      console.error('[jarvis] power-up failed:', err)
      store.getState().setPhase('offline')
      store
        .getState()
        .setError(
          err instanceof Error
            ? `Power-up failed: ${err.message}`
            : 'Power-up failed. Click to try again.',
        )
    }
  }

  const ignite = async () => {
    const s = store.getState()

    // Must happen inside the click handler — browsers won't start an
    // AudioContext or speech synthesis without a user gesture.
    await sfx.unlockAudio()
    // Launched into the tray at login: come up silently, with no fanfare and
    // no boot sequence for a window nobody is looking at.
    const quiet = Boolean(desktop?.startHidden)
    if (!quiet) sfx.play('boot')
    // The score. Must be started from inside this click handler for the same
    // reason as the rest of the audio.
    music.enable()
    if (!quiet) {
      music.playBoot()
      music.startAmbient()
    }

    s.setPhase('boot')

    watchServers((servers) => store.getState().setConnected(servers))
    watchPanels((panel) => store.getState().pushPanel(panel))
    watchBlades((blade) => store.getState().pushBlade(blade))
    watchConfirm(askConfirm, cancelConfirm)
    watchApp((op) => {
      if (op === 'mute') {
        wakeListening.current = false
        desktop?.setListening(false)
      } else if (op === 'quit') {
        desktop?.quit()
      } else if (op === 'enroll') {
        desktop?.show()
        store.getState().setEnrolling(true)
      }
    })

    // Something to say outside any turn: an app that never showed up. Said
    // once he is idle, so it never talks over an answer or a question; one
    // that finds no quiet moment for half a minute goes on the error line.
    const sayNotice = (text: string, waited = 0) => {
      const s = store.getState()
      const idle = (s.phase === 'dormant' || s.phase === 'listening') && !speaker.current
      if (!idle) {
        if (waited < 30) setTimeout(() => sayNotice(text, waited + 1), 1000)
        else s.setError(text)
        return
      }
      s.pushTurn({ id: newId(), role: 'jarvis', text })
      const n = createSpeaker()
      speaker.current = n
      n.say(text)
      void n.end().then(() => {
        if (speaker.current === n) speaker.current = null
      })
    }
    watchNotice((text) => sayNotice(text))

    /**
     * JARVIS asking to see something.
     *
     * Announced on screen for as long as it takes, with whatever he said he was
     * looking for. The camera's own light is on too, but a hardware light that
     * appears with no explanation is exactly the thing that makes people
     * distrust an assistant — so the interface says it before they have to ask.
     */
    watchCapture(async (req) => {
      const note =
        req.mode === 'watch'
          ? req.when === 'past'
            ? req.reason || 'reviewing the last few seconds'
            : `${req.reason || 'watching'} · ${req.seconds}s`
          : req.reason || 'taking a look'
      store.getState().setLooking(note)

      // The past is only available if something has been remembering it, and
      // that only happens while the camera is on screen. Answering plainly
      // beats opening the camera and recording the next few seconds instead,
      // which is a different question from the one that was asked.
      if (req.mode === 'watch' && req.when === 'past' && camera.bufferedSeconds() < 1) {
        store.getState().setLooking(null)
        return {
          error:
            'There is no recent footage — the camera has to be open on screen ' +
            'for me to remember what just happened. Ask me to open the camera, ' +
            'and I can watch from then on.',
        }
      }

      // Held for the whole capture. Without this the stream can be torn down by
      // whoever else was using it half way through a six-second watch.
      let held = false
      try {
        await camera.holdCamera()
        held = true
        if (req.mode === 'look') return camera.grabFrame()
        if (req.when === 'past') {
          const grid = camera.recentGrid(req.seconds, 9)
          return grid ?? { error: 'There is not enough recent footage to review.' }
        }
        return await camera.watchAhead(req.seconds, 9)
      } catch (err) {
        return {
          error:
            (err as DOMException)?.name === 'NotAllowedError'
              ? 'The camera is not permitted, so I cannot see anything.'
              : `The camera could not be read: ${(err as Error)?.message ?? err}`,
        }
      } finally {
        if (held) camera.releaseCamera()
        store.getState().setLooking(null)
      }
    })

    // The interface is JARVIS's to drive. These arrive out of band, pushed
    // mid-turn the way panels are, so a command can retint the reactor or put
    // something into orbit while he is still speaking the sentence about it.
    watchUi((op, args) => {
      const s = store.getState()
      const a = (args ?? {}) as Record<string, never>
      switch (op) {
        case 'patch':
          s.applyUi(args)
          break
        case 'orbit':
          if (a.action === 'add') s.addOrbit(args)
          else if (a.action === 'remove') s.removeOrbit(String(a.id))
          else s.clearOrbits()
          break
        case 'effect':
          s.fireEffect(a.kind)
          break
        case 'reset':
          s.resetUi()
          break
        case 'screen':
          s.clearScreen(a.what ?? 'all')
          break
        default:
          console.warn('[jarvis] unknown ui op:', op, args)
      }
    })
    // In bridge mode the conversation lives in the agent session, which is tied
    // to the socket — so a drop silently wipes his memory while the transcript
    // on screen still shows it. Better to say so than to let him quietly forget.
    watchConnection((state) => {
      if (state === 'lost') {
        store.getState().setError('Bridge connection lost — reconnecting.')
      } else if (state === 'reconnected') {
        store
          .getState()
          .setError('Bridge reconnected. The previous conversation was not kept.')
      }
    })
    const warming = warm().catch((err: Error) => s.setError(err.message))

    if (!usingBridge && !env.anthropicKey) {
      s.setError(
        'No Anthropic API key — copy .env.example to .env.local and set VITE_ANTHROPIC_API_KEY.',
      )
    }

    // Pull the neural voice down during the boot sequence so the first
    // "Hey Jarvis" isn't waiting on an 86MB download. Deliberately not awaited
    // — if it's slow, JARVIS comes up on the system voice and swaps over the
    // moment the model is ready.
    if (TTS_ENGINE === 'kokoro') {
      void kokoro.load()
      voicePoll.current = setInterval(() => {
        const p = kokoro.loadProgress()
        if (kokoro.isReady() || kokoro.isUnavailable()) {
          store.getState().setBootNote('')
          if (voicePoll.current) clearInterval(voicePoll.current)
          voicePoll.current = null
        } else if (p > 0 && p < 1) {
          store.getState().setBootNote(`voice ${Math.round(p * 100)}%`)
        }
      }, 200)
    }

    // Long enough for the four-beat start-up sequence in Boot.tsx to play —
    // status bar, rings, suit schematic, reactor power-up — before the live
    // interface takes over. Kept a touch under the boot cue so the music is
    // still rising as the reactor lands.
    await new Promise((r) => setTimeout(r, quiet ? 0 : 9200)) // boot sequence
    await warming
    store.getState().setConnected(connectedLabels())
    // The preferred voice is a setting (config.json), read before the first word.
    await syncVoicePreference()
    store.getState().setVoice(currentVoiceName())

    // The analyser is what makes the reactor pulse with your voice. It needs a
    // getUserMedia stream; speech recognition does not, and gets its own. So a
    // failure here costs the animation and nothing else — saying "voice input
    // is unavailable" was both alarming and untrue.
    try {
      await startAnalyser()
    } catch {
      console.warn(
        '[jarvis] no microphone stream — the reactor will not pulse with your ' +
          'voice. Speech recognition is unaffected.',
      )
    }

    // Ask the bridge which speech engines exist before the loop starts, so the
    // first turn already uses ElevenLabs when a key is present and the browser
    // fallback when it is not — no flag, no reload.
    await probeCapabilities()

    // One voice loop, started once, running until the page closes.
    voice.current = await startVoice({
      mode,
      onWake,
      onSpeechStart,
      onPartial,
      onUtterance,
      onError: onVoiceError,
      urgent: () => pendingConfirm.current !== null,
      questionEnd: () => questionEnd.current,
    })

    store.getState().setPhase('dormant')
  }

  // -- clap to start --------------------------------------------------------

  /**
   * A clap brings him up, as an alternative to the button.
   *
   * Only while the ignition screen is showing, and torn down the moment he
   * boots — the microphone is about to belong to the voice loop, and two
   * analysers arguing over the same stream is how you get an assistant that
   * hears half of what you say.
   *
   * Deliberately silent about failure. If the microphone is refused, or has not
   * been granted yet, the button is still right there; announcing an error
   * about a feature nobody asked for would be worse than quietly doing without.
   */
  useEffect(() => {
    if (phase !== 'offline') return
    let live: { stop: () => void } | null = null
    let gone = false
    void listenForClap(() => {
      if (!gone) void powerOn()
    }).then((l) => {
      if (gone) l.stop()
      else live = l
    })
    return () => {
      gone = true
      live?.stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  // -- level pump + keys ----------------------------------------------------

  useEffect(() => {
    let raf = 0

    const pump = () => {
      const st = store.getState()
      // While speaking, follow JARVIS's own output rather than the mic, so the
      // orb lip-syncs instead of reacting to room noise.
      const lvl =
        st.phase === 'speaking' && speaker.current
          ? speaker.current.level()
          : micLevel()
      st.setLevel(lvl)
      raf = requestAnimationFrame(pump)
    }
    pump()

    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return

      // V auditions the next British voice installed on this machine. Which
      // ones exist varies per Mac, so hearing them beats trusting a ranking.
      // Bare V only — ⌘V and ⌃V are paste, and swallowing those was rude.
      if (
        e.key === 'v' &&
        !e.repeat &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        e.preventDefault()
        const name = cycleVoice()
        store.getState().setVoice(name)
        silence()
        const demo = createSpeaker()
        speaker.current = demo
        demo.say(`Voice set to ${name.replace(/\(.*?\)/g, '').trim()}. How's this?`)
        // Let go once done, or a notice would never find him idle.
        void demo.end().then(() => {
          if (speaker.current === demo) speaker.current = null
        })
        return
      }

      // G puts the camera on and starts tracking hands. Off by default and
      // never implicit: a webcam that turns itself on because an interface
      // thought it might be useful is not a trade anyone agreed to.
      if (e.key === 'g' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        const on = store.getState().gestures
        if (on) {
          hands.disableHands()
          store.getState().setGestures(false)
        } else {
          store.getState().setError(null)
          void hands
            .enableHands()
            .then(() => store.getState().setGestures(true))
            .catch((err: Error) => {
              store.getState().setGestures(false)
              store
                .getState()
                .setError(
                  err?.name === 'NotAllowedError'
                    ? 'Camera access denied — gesture control is unavailable.'
                    : `Gesture control failed to start: ${err?.message ?? err}`,
                )
            })
        }
        return
      }

      // T speaks a fixed line, bypassing the wake word, the recogniser and the
      // model entirely. When "I can't hear him" is the report, this is the one
      // keypress that separates a broken voice engine from a broken voice loop
      // — and it prints the verdict rather than making you infer it.
      if (e.key === 't' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        silence()
        const t = createSpeaker()
        speaker.current = t
        t.say('Audio test. If you can hear this, speech output is working.')
        void t.end().then(() => {
          if (speaker.current === t) speaker.current = null
          const d = (window as unknown as Record<string, Record<string, unknown>>).__tts
          console.info('[jarvis] audio test →', d)
          if (d && d.started === 0 && d.rescued === 0) {
            store.getState().setError(
              `No sound produced. engine=${d.engine} voice=${d.voice} error=${d.lastError || 'none'}`,
            )
          }
        })
        return
      }

      // Escape stands the whole thing down — the one thing the old build had
      // no key for at all.
      if (e.key === 'Escape') {
        e.preventDefault()
        if (pendingConfirm.current) {
          pendingConfirm.current.finish({ source: 'click', approved: false })
          return
        }
        if (store.getState().phase !== 'offline') goDormant()
        return
      }

      // Space starts a turn without the wake word. Worth using while filming so
      // a missed wake word doesn't cost a take.
      if (e.code !== 'Space' || e.repeat) return
      e.preventDefault()
      manualTrigger()
    }
    window.addEventListener('keydown', onKey)

    // The desktop app: the global push-to-talk hotkey does exactly what Space
    // does, from anywhere, window hidden or not; the tray can switch off
    // listening for the wake word; and there is no ignition button to press,
    // because the window may never have been shown.
    const unsubscribe = [
      desktop?.onHotkey(manualTrigger),
      desktop?.onTray((c) => {
        if (c.cmd === 'listening') wakeListening.current = c.value
        if (c.cmd === 'enroll') store.getState().setEnrolling(true)
      }),
    ]
    if (desktop) void powerOn()

    return () => {
      for (const off of unsubscribe) off?.()
      cancelAnimationFrame(raf)
      window.removeEventListener('keydown', onKey)
      clearIdle()
      if (voicePoll.current) clearInterval(voicePoll.current)
      voice.current?.stop()
      speaker.current?.cancel()
      // The camera must not outlive the page that turned it on.
      hands.disableHands()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <>
      <Scene />
      <Hud />
      <Boot />
      <Diagnostics />
      <Ignition onStart={() => void powerOn()} />
      <Enroll />
      <ModelsBanner />
      <Settings />
    </>
  )
}
