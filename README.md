# VAS

**VAS** is a Windows desktop app for **JARVIS**, a voice assistant whose brain is
Claude Code. It grew out of [jarvis-main](#jarvis-main-the-original-project)
(documented further down) and now runs as a real laptop app:

- its own window and a tray icon, not a localhost web page in a browser;
- wakes on **"Hey Jarvis"** (on-device, free, offline) or a hotkey, even while
  hidden in the tray;
- opens, switches to and closes Windows apps by voice, asking you first;
- reads your real, signed-in Chrome, and asks you to say "confirm" before it
  clicks or types anything;
- answers everyday orders on the PC in milliseconds (Kalliope-style "neurons"),
  and hands everything else to Claude;
- learns from corrections ("no, I said Spotify") and from routines you teach it
  ("when I say work mode, open VS Code and Chrome");
- can be told to act only on your voice once it has learned it.

The design and the step-by-step plan are in [docs/vas/PLAN.md](docs/vas/PLAN.md).

## Install

```bash
npm install
npm run dist
```

That builds `release\VAS Setup 0.1.0.exe`. Run it: it installs for your user
only (no admin), adds Start-menu and desktop shortcuts, and starts VAS. The
installer is not code-signed, so Windows SmartScreen may say it "protected your
PC": choose **More info → Run anyway**.

What it needs:

- **Windows 10 or 11, 64-bit.**
- **Claude Code, logged in.** VAS ships its own copy of the Claude Code engine
  but uses your existing login: run `claude` once and sign in. No API key.
- **Chrome with the Claude extension**, for anything to do with web pages.
- **Optional: an ElevenLabs key** (`ELEVENLABS_API_KEY`) for Scribe
  transcription and the ElevenLabs voice. Without it everything runs locally.

**First launch:** JARVIS can't hear until his voice models are installed. The
window shows a **Download voice models** button (about 260 MB: the wake word,
Whisper *base* and the voice check). Nothing downloads until you click it.
Whisper *small* (610 MB, more accurate, slower) is optional:
`npm run models -- whisper-small`, then set `"stt": { "model": "whisper-small" }`
in `config.json`.

## Using it

| Say or press | What happens |
|---|---|
| **"Hey Jarvis"** | He wakes and listens |
| **Ctrl+Alt+Space** | Push to talk, from anywhere. If another app owns that keyboard shortcut, VAS uses **Ctrl+Alt+J** instead |
| "what time is it" / "what's the date today" | Answered on the PC, instantly |
| "open Spotify" / "switch to VS Code" / "close Spotify" | Opening asks once per app and remembers; closing asks every time |
| "what apps do I have" | Lists what the Start menu knows |
| "search for Kochi weather" / "go to youtube" | A new tab in your Chrome, then a spoken summary |
| "what's on this tab" | Reads the tab you're looking at (needs a Chrome window open) |
| "no, I said Spotify" | Learns the mishearing, asks before saving, then does it |
| "when I say work mode, open VS Code and Chrome" | Teaches a routine; "work mode" then runs without Claude. A comma marks where the trigger ends, and a step can be a spoken line ("…, say good morning") |
| "list my routines" / "forget the routine work mode" | Manage routines |
| "learn my voice" | Opens voice enrollment (also in the tray menu) |
| "go to sleep" / "mute yourself" / "shut down VAS" | Stand down, stop listening for the name, or quit (asks first) |
| "lock down" / "unlock" | Refuse every action until unlocked; unlocking asks, in your voice |
| **S** | Opens Settings (also in the tray menu) |
| Anything else | Goes to Claude, friendly and casual |

**Tray menu:** show or hide the window, listening on/off, Start with Windows,
Settings…, Learn my voice…, open the data folder, restart JARVIS, quit.

**Settings** has tabs for your name and speech options, learned corrections,
apps you've allowed, taught routines, your voice, and permissions. Changes take
effect immediately; so do hand edits to the files under `%APPDATA%\VAS\data`.

**Your voice only.** "Learn my voice" asks you to read about a dozen lines:
one- and two-word answers as well as full sentences, because the voice check is
calibrated separately for short and long speech. It also tunes the wake word to
how you say "Hey Jarvis". After that, the owner setting (Settings → General, or
`owner.require`) decides what other voices can do: `all` (default: nothing,
not even a wake), `actions` (they can talk, not act) or `off`.

## Permissions

Every action passes a gate with four tiers, kept in `permissions.json`:

| Tier | Used for |
|---|---|
| free | Reading Chrome, searching, opening a site in a new tab, time, lists |
| remember | Opening or switching to an app: asked once per app |
| confirm | Closing apps, clicking or typing in Chrome, saving corrections and routines, quitting, unlocking, risky apps (Terminal, PowerShell, cmd, regedit…) |
| deny | Anything set to deny |

A question is answered by saying "yes"/"confirm" or "no"/"cancel", or with the
buttons on screen. Claude never gets a shell or file tools: it can only use
VAS's own tools, which ask for themselves.

A few rules sit on top of the tiers:

- **After JARVIS reads a page, going to a different site asks first.** Following
  a link, searching, looking up a URL, showing a remote page or picture, or
  saving a routine that opens a site asks "You just read mail.google.com. Go to
  example.com now?". A yes covers the sites it named for that answer; a no
  covers the whole answer. What was read counts for the rest of the
  conversation, because Claude remembers it. A page can't quietly send what
  JARVIS read somewhere else.
- **Reading Chrome and opening sites follow their tiers too.** Set them to ask
  or never in Settings → Permissions, and lockdown stops them like everything
  else. Listing tabs gives Claude only their sites, never their titles.
- **A click or typing is tied to the page you approved.** If the tab navigates
  while JARVIS is asking, nothing happens.
- **The camera asks first while VAS is hidden.**
- **Stopping JARVIS withdraws every pending question,** including any queued
  behind the one on screen.
- **Settings can't be the way around a safeguard.** While locked down, or with
  "Clicking Confirm counts as a yes" off, loosening anything in the drawer
  (lifting lockdown, a tier toward "just do it", who can talk) asks first, out
  loud. With clicks off, only a spoken yes approves it.

## Where things live

| Path | Holds |
|---|---|
| `%APPDATA%\VAS\data\` | `config.json`, `permissions.json`, `apps.json`, `corrections.json`, `brain.yml` (your routines), `speaker.json` (your voiceprint), `audit.log`, `bridge.log` |
| `%LOCALAPPDATA%\VAS\models\` | The voice models |

`config.json` settings: `userName`, `hotkey`, `stt.model`, `stt.language`
(`en`, or `auto` for mixed-language speech), `owner.require`, `tts.voice` (the
Windows voice you prefer), `sites` (your own names for websites, e.g.
`{ "jira": "mycompany.atlassian.net" }` for "open jira"), and the wake keywords
(phones, or plain words such as `"hey friday"`).

## How VAS is put together

```
  ┌─ VAS window (Electron) ─────────┐  loopback + per-launch token  ┌─ bridge (utility process) ───────────┐
  │  the face: React + Three.js     │ ◄───────────────────────────► │  neurons: local orders, routines     │
  │  microphone → 16 kHz segments   │   ws://127.0.0.1:<random>     │  sherpa-onnx: "Hey Jarvis", Whisper, │
  │  speaks with the Windows voice  │                               │    voice check (worker threads)      │
  │  tray, hotkey                   │                               │  permission gate, corrections        │
  └─────────────────────────────────┘                               │  Claude Agent SDK → claude.exe       │
                                                                    │  Chrome via the extension's pipe     │
                                                                    └──────────────────────────────────────┘
```

Nothing listens on the network: the bridge binds `127.0.0.1` on a random port
and refuses any request without the token, and an installed VAS accepts only
its own window. Speech before "Hey Jarvis" never leaves the PC and is never
transcribed. Claude sessions are not saved to `~/.claude/projects`.

## Developing

```bash
npm install
npm run dev        # Vite + the Electron window, with live reload
npm run app        # build the face, run Electron against dist/
npm test           # bridge tests + renderer tests
npm run dist       # the installer, in release/
npm run e2e:app    # end-to-end check of release/win-unpacked/VAS.exe
npm run models     # all voice models from the command line (about 0.9 GB)
npm run probe:chrome   # read-only check of the Chrome extension link
npm run probe:voice    # wake-word and Whisper timings on this PC
npm start          # browser debug mode: the face in a browser tab (also: npm run web)
```

The bridge refuses to start without the session token the app gives it.
Browser debug mode has no app to hand one over, so it runs the bridge with
`--insecure-dev`, which says so loudly. Never use it on a shared machine. The
old "direct" mode (the browser calling the Claude API with a key) is compiled
out of every build unless you build with `VAS_DIRECT=1`.

### Status

| Area | State |
|---|---|
| Desktop app, tray, hotkey, installer | Done |
| Bridge hardening (loopback, token, locked-down Claude session) | Done |
| Local voice: wake word, Whisper, Scribe when keyed | Done |
| Chrome over the Claude extension's named pipe | Done |
| Permission gate with spoken confirmation | Done |
| Neurons: apps, Chrome, corrections, taught routines | Done |
| Voice enrollment ("only my voice"), wake-word tuning | Done; check it with the live test on the enrollment screen |
| Friendly, casual persona | Done |
| Settings drawer, live config reload | Done |
| Chrome safety: tab-bound confirmations, leave-site rule | Done |

Known limits: "what's on this tab" needs a visible Chrome window; the voice
check and wake tuning are verified on synthetic voices until you enroll your
own; the installer is unsigned. Checks that need you in person: wake and
confirm with your real voice, another person or a phone recording being
refused, mixed-language accuracy on your speech, a Chrome action in your
signed-in browser, and Scribe with a real ElevenLabs key.

---

## jarvis-main: the original project

> Everything from here down describes the original browser version and is kept
> for reference. Where it differs from VAS (port 8787, browser speech, local dev
> origins, `npm start` in Chrome), the sections above are what VAS does.

A browser voice assistant with an Iron Man holographic interface. Say
**"Hey Jarvis"**, he wakes, listens, and does real things through your tools —
searches the web, generates images, drives your phone, reads your mail. The face
is a web page (React + Vite + Three.js + custom GLSL). The brain is Claude Code,
run headless as a library.

**The only subscription you need is Claude Code.** No API keys, no OpenAI
account, no cloud bill — the brain runs on your existing Claude Code login, and
the heavy work (the model itself) runs on Anthropic's servers, so even a low-end
laptop only has to draw the interface. **ElevenLabs is an optional add-on** that
gives JARVIS a much better voice and sharper hearing; without it he speaks and
listens through the browser's own speech, and everything still works.

---

## Requirements

**In one line:** a Claude Code subscription, plus two free things every computer
can have — Node.js and Chrome. That's the whole list.

- **Claude Code, installed and logged in** — this is the only account you need.
  Install it with the official method — `npm install -g @anthropic-ai/claude-code`,
  or the platform installer at <https://docs.claude.com/en/docs/claude-code> —
  then run `claude` once and complete login. The bridge reuses that login. **No
  API key**, and usage is billed to your existing Claude account.
- **Node.js 20 or newer** — free, one installer from <https://nodejs.org>. This
  is a Node web app, so it is the one unavoidable tool.
- **Google Chrome or Microsoft Edge**, in a **real browser window** — not an
  embedded preview pane. Preview panes (including the one inside editors and
  Claude Code) block microphone access, so the page loads and looks right but
  never hears you. JARVIS also needs WebGL, which these browsers provide.
- **Optional: an ElevenLabs API key** — a good add-on, not a requirement. It
  gives a better voice and sharper transcription; the free tier is plenty for a
  demo. Without it, everything runs on the browser's own speech.

Run `npm run setup` after cloning and it checks all of this for you, in plain
language.

---

## Quick start

First, install, then start it:

```bash
npm install
npm start          # runs the brain and the face together
```

Then open the URL it prints (http://localhost:5173) in **Chrome**, click **INITIALISE**, and say **“Hey Jarvis”**.

Prefer two terminals? Run them separately instead:

```bash
npm install
```

Terminal 1 — the brain:

```bash
npm run bridge
```

Terminal 2 — the face:

```bash
npm run dev
```

Then open the app in a **real Chrome or Edge window**:

```bash
open http://localhost:5173
```

Click **INITIALISE**, allow the microphone when asked, and say **"Hey Jarvis"**.

> It has to be a real browser window. Embedded preview panes block the
> microphone, so JARVIS will look perfectly alive and simply never respond.

---

## How it works

JARVIS is two processes. The browser is the face and the voice; the bridge is
the brain and the hands.

```
  ┌─ browser (the face) ───────────────┐        ┌─ bridge (the brain) ─────────────┐
  │  "Hey Jarvis" wake word            │        │  Node · bridge/server.mjs        │
  │  local VAD  →  speech to text      │   ws   │  Claude Agent SDK                │
  │  reactor UI (Three.js + GLSL)      │◄─────► │   = Claude Code, headless        │
  │  text to speech                    │  8787  │  spawns your MCP servers         │
  │  heads-up display                  │        │  permission gate (decideTool)    │
  └────────────────────────────────────┘        └──────────────────────────────────┘
```

Everything you see and hear happens in the browser. The bridge is a single Node
process (`bridge/server.mjs`) that runs the **Claude Agent SDK**
(`@anthropic-ai/claude-agent-sdk`) — this spawns the real `claude` CLI as a child
process, so **the brain literally is Claude Code, headless.** They talk over a
WebSocket (plus a few HTTP endpoints) on `ws://localhost:8787`.

**Why a bridge at all?** A browser tab cannot spawn the local stdio MCP servers —
`higgsfield`, `elevenlabs`, `android`, `playwright`, `exa`, `serper`, and the
rest. The bridge can. And because it is the Agent SDK, it authenticates off your
existing Claude Code login: no API key, billed to that same Claude account.

**The model.** `claude-opus-5` at effort `medium` by default. Override with the
`JARVIS_MODEL` and `JARVIS_EFFORT` environment variables. On startup the bridge
prints its choice, e.g. `[jarvis] model claude-opus-5 · effort medium`.

### The voice pipeline

The loop is designed so that nothing silently dies and barge-in feels natural.

- **Detection is local.** An energy-based voice-activity detector
  (`src/lib/vad.ts`) decides when you are speaking. It is instant, cannot quietly
  fail, and is what makes **barge-in** work — speak while JARVIS is talking and he
  stops.
- **Transcription has two tiers, chosen automatically at boot.** The browser asks
  the bridge `/health` and picks the best available:
  - **ElevenLabs key present** → ElevenLabs Scribe, via the bridge `/stt` endpoint.
  - **Nothing configured** → the browser's own `SpeechRecognition` (Chrome/Edge),
    guarded by a heartbeat so it recovers when Chrome throttles it.
- **Speaking** uses the **ElevenLabs voice when a key is present**, and the
  browser's `speechSynthesis` otherwise. If a cloud call fails it falls back to
  the browser voice, and if the OS voice itself is broken it latches over to the
  cloud voice.

So it works with no keys and auto-upgrades when a key appears — there is no flag
to set. Capability detection lives in `src/lib/capabilities.ts`, which probes the
bridge's `GET /health` (returning `{ ok, tts, stt }`, both tracking the
ElevenLabs key) once at boot and picks the engines.

---

## What JARVIS can do

Beyond answering, JARVIS reaches every MCP server in your Claude Code
configuration, and can drive his own interface.

### Your tools

Every server in your `~/.claude.json` is handed to the SDK explicitly. Depending
on what you have installed, that is roughly:

- **Web & search** — `exa`, `serper`, `serpapi`
- **Images & video** — `higgsfield`, `openrouter-image`, `palmier-pro`
- **Voice** — `elevenlabs`
- **Your phone** — `android`
- **The browser** — `playwright`

A few things you can say:

- *"What's happening in AI this week?"*
- *"Generate an image of the Mark VII suit."*
- *"Take a screenshot of my phone."*
- *"Open my GitHub notifications."*

> **Note on account connectors.** Servers you added through your **claude.ai
> account** are not stored on disk, so the bridge cannot see them — it works from
> the servers in `~/.claude.json` (about 14), not the claude.ai ones.

### JARVIS controls the interface

He drives the UI through MCP tools the bridge exposes:

- `ui_theme` — accent, background, per-phase colours
- `ui_reactor` — colour, scale, intensity, spin, and style (`ring` | `sphere` | `wire`), visibility
- `ui_orbit` — put images in orbit around the reactor
- `ui_chrome` — show or hide rails, transcript, badges
- `ui_effect` — `glitch` | `pulse` | `scan` | `shake` | `flash`
- `ui_screen` — clear
- `ui_reset` — back to defaults

So *"make it red, hide the systems list, put that render in orbit"* is a spoken
command.

### The heads-up display

JARVIS authors panels with a `display` tool against a fixed `.hud-*` design
system. The browser sanitises the markup (DOMPurify, a class allowlist and a
strict CSP) before rendering. Rich media works — images, `<video>`, and
YouTube/Vimeo embeds. Remote images and video are fetched **server-side** through
the bridge (`/img` and `/media`, both SSRF-guarded), so hotlink-blocked news
thumbnails still appear and the page never beacons your IP to a host the model
chose.

---

## Controls

| Key / phrase | Does |
|---|---|
| **"Hey Jarvis"** | Wake him |
| **Space** | Talk without the wake word |
| Just speak | Interrupt him mid-sentence (barge-in) |
| **V** | Cycle the browser voice |
| **Escape** | Stand down |
| **D** | Live diagnostics panel |
| **T** | One-line audio self-test |

---

## The boot sequence

Power-up plays a four-beat Iron Man start-up (`src/ui/Boot.tsx`): an
"INITIATING SYSTEM" status bar with a segmented progress bar and boot log; then
concentric reticle rings resolving into "J.A.R.V.I.S"; then a suit schematic;
then the triangular arc reactor lighting up — with a start-up sound under it
(`public/audio/boot-music.mp3`).

---

## Configuration

Everything is optional in bridge mode. Frontend settings live in `.env.local`
(copy `.env.example`); bridge settings are environment variables.

### Bridge

| Variable | Default | Effect |
|---|---|---|
| `JARVIS_BRIDGE_PORT` | `8787` | Port for the WebSocket + HTTP endpoints |
| `JARVIS_MODEL` | `claude-opus-5` | Model to run |
| `JARVIS_EFFORT` | `medium` | Reasoning effort |
| `JARVIS_ALLOW_WRITES` | off | `1` allows effectful tools (see below) |
| `JARVIS_ALLOWED_ORIGINS` | local dev | Extra WebSocket origins to accept |
| `JARVIS_ALLOW_NO_ORIGIN` | off | Accept connections with no `Origin` header |
| `JARVIS_FILE_ROOTS` | — | Roots the `/file` endpoint may serve from |
| `JARVIS_VOICE_ID` | — | ElevenLabs voice id |
| `ELEVENLABS_API_KEY` | — | Optional; enables the ElevenLabs voice + Scribe |

### Frontend (`.env.local`)

| Variable | Effect |
|---|---|
| `VITE_BACKEND` | `bridge` (default) or `direct` |
| `VITE_BRIDGE_URL` | Where to reach the bridge |
| `VITE_TTS_ENGINE` | `system` or `kokoro` |
| `VITE_KOKORO_VOICE` | Voice for the Kokoro engine |
| `VITE_USE_ELEVENLABS` | Force the ElevenLabs voice on |
| `VITE_ANTHROPIC_API_KEY` | Direct mode only |

### Adding an ElevenLabs key

You do not have to touch a flag. Either:

- Set `ELEVENLABS_API_KEY` on the bridge before starting it, **or**
- Add the key to your `elevenlabs` MCP server's env in `~/.claude.json` — the
  bridge reads it from there too.

Either way, `/health` starts reporting the capability, the browser picks it up on
the next boot, and both the voice and transcription upgrade automatically.

---

## Enabling actions

The tool gate starts **read-only**. Search, generation and lookups run freely;
anything effectful — send, tap, delete, install, pay — is denied. Voice is a poor
interface for a confirmation dialog, so the decision is made ahead of time in
`decideTool()` in `bridge/server.mjs`, not at the moment of use. The bridge sets
`settingSources: []`, which makes its own gate the only authority — filesystem
settings and any global `bypassPermissions` cannot override it.

To allow effectful tools (phone, browser driving, sending), run the bridge this
way instead:

```bash
npm run bridge:writes
```

> Read `decideTool()` before you do. *"Hey Jarvis, clean up my downloads folder"*
> means something rather different with writes enabled.

---

## Troubleshooting

**I can't hear him, or he can't hear me.** Press **D** for the diagnostics panel
— it states plainly whether he is hearing you and whether he is producing sound.
Press **T** for a one-line audio self-test.

**No voice at all.** You must be in **Chrome or Edge**, in a **real browser
window** (not an embedded preview), and you must have **allowed the microphone**.

**Bridge not reachable.** Check that `npm run bridge` is still running in its
terminal, and that nothing else is holding port `8787`.

---

## Security

All of this lives in `bridge/server.mjs`:

- The WebSocket accepts only local dev origins (add more with
  `JARVIS_ALLOWED_ORIGINS`).
- `/file`, `/img` and `/media` validate the scheme, confine to allowed roots,
  resolve the real path, and refuse private and loopback addresses (SSRF guard).
- The tool gate (`decideTool`) is default-deny for effectful MCP tools.
- A strict CSP in `index.html`; model-authored panel HTML is sanitised.

---

## Credits & licence

MIT.

The boot sound and any tracks in `public/audio/` ship with the project for the
demo. If you go on to monetise something built on this, clearing the rights to
that audio is your responsibility.
