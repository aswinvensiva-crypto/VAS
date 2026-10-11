# VAS — desktop app for your JARVIS voice assistant (new repo, built from jarvis-main)

## Context
The Claude Code brain came from `C:\Users\Aswin\Downloads\Collab-main\Collab-main\collabb-main\jarvis-main`, which has a Node bridge on Claude Agent SDK 0.3.220 and a React/Vite face that today runs as a localhost website in Chrome. It moves into a **new repository, VAS**: `C:\Users\Aswin\Downloads\VAS` (written `<root>` below), pushed to a new **private** GitHub repo `aswinvensiva-crypto/VAS`. The original jarvis-main folder goes back to exactly how you downloaded it.

**Naming:** the app (window, tray, installer, `VAS.exe`) is **VAS**. The assistant inside it stays **JARVIS**: it calls itself JARVIS and you wake it with **"Hey Jarvis"**.

VAS runs as a **desktop app**. JARVIS will **open Windows apps by voice** with permission, **get information from your real signed-in Chrome**, grow **Kalliope-style neurons** that you can teach by voice, and **understand your voice better**.

Your choices:
- Neurons live inside VAS.
- Voice: learn from corrections, the **"Hey Jarvis"** wake word only, and only respond to your voice.
- Speech-to-text: local Whisper, plus ElevenLabs Scribe when a key exists. You speak English mixed with another language.
- Chrome: reading is free; actions need a spoken "confirm".
- Persona: friendly and casual.
- Wake engine: must be permanently free, and a hotkey must wake it too.

Verified on this PC:
- **Chrome control is broken on Windows today.** `bridge/chrome.mjs:56` (`SOCKET_DIR`, `findSocket()` :84) looks for `/tmp/...sock`, but the Claude extension's native host listens on the named pipe `\\.\pipe\claude-mcp-browser-bridge-Aswin`. The pipe is live and the extension is installed.
- **The wake word is text matching.** It is a regex over transcripts (`src/lib/voice.ts:81`, `src/App.tsx:66`). Porcupine is installed but never used.
- **Picovoice ended its free tier on 30 June 2026.** So the engine is **sherpa-onnx**: Apache-2.0, offline, prebuilt `sherpa-onnx-win-x64` 1.13.8. It provides keyword spotting, speaker identification and Whisper speech recognition from one Node addon.
- **There is no keyless speech path in the desktop app.** No ElevenLabs key is configured, and `webkitSpeechRecognition` does not work in Electron. Local Whisper is therefore required.
- **The bridge is exposed to the network.** `server.listen(PORT)` (server.mjs:1001) binds all interfaces. The Origin check can be forged. The CLI can auto-approve "harmless" Bash without calling `canUseTool` (server.mjs:1259-1263). The SDK saves session transcripts, including text read from your signed-in pages, to `~/.claude/projects` (`persistSession` defaults to true).
- **Kalliope can't run natively here.** It is GPL-3.0, Linux-only and needs Python ≤3.9 (`imp`/`audioop` are gone in 3.14). We **reimplement its ideas in JS** and use its tests (`Tests/test_order_analyser.py`, `test_neuron_parameter_loader.py`) as a behaviour spec. The Kalliope folder is not modified.
- **Neither folder is a git repo**, and jarvis-main has no tests.
- **Already done before this change:** `git init` plus a baseline commit (`1ae510b`, branch `vas`) inside jarvis-main, with `.gitattributes` and `docs/vas/` not yet committed. `npm run build` passes. A test bridge boot confirms "browser control unavailable" (the pipe bug).
- **Your own `npm start` from jarvis-main is running right now** (PID 34984, `node bridge/server.mjs`, listening on `0.0.0.0:8787`). It is left alone. VAS dev and tests use other ports (ephemeral, or 8788).

## What you get
- `VAS.exe` runs in a window plus the tray and starts with Windows.
- "Hey Jarvis…" or **Ctrl+Alt+Space** wakes JARVIS, even while VAS is hidden.
- "Open Spotify": the first time, it asks once and remembers. "Close Spotify" asks every time.
- "What's in my Gmail?", "search for…", "what's on this tab?": it reads your real Chrome and answers aloud. Clicking or typing asks "say confirm".
- "No, I said Spotify": it learns the mishearing. "When I say work mode, open VS Code and Chrome": it saves a new neuron (routine) that runs instantly next time.
- Other voices (TV, other people) can't wake it or confirm actions once you enroll your voice.

## Key decisions
| Topic | Decision |
|---|---|
| Window ↔ brain | The bridge runs as an Electron `utilityProcess` (`bridge/boot.cjs` → `startBridge()`). It listens on **127.0.0.1** with an ephemeral port. A per-launch 256-bit token is required: the WebSocket sends it as a subprotocol (`vas.v1`, `vas.token.<hex>`), and HTTP gets an `x-vas-token` header injected by main via `webRequest.onBeforeSendHeaders`. Nothing opens in a browser and nothing is reachable from the network. Full IPC would mean rewriting `src/lib/bridge.ts`, and `<img>`/`<iframe>` blades need real URLs. Fallback: `spawn(process.execPath)` with `ELECTRON_RUN_AS_NODE=1`. |
| Renderer origin | A privileged custom scheme `app://vas` serves `dist/`, so absolute `/assets`, `/mediapipe` and `/audio` paths keep working. In development, Electron loads the Vite dev URL in its own window. |
| Audio | An **AudioWorklet** delivers 16 kHz PCM. This replaces MediaRecorder and the `requestAnimationFrame` VAD tick (vad.ts:203), so VAS keeps hearing while hidden. Each segment is sent to the bridge as a 16 kHz mono WAV. |
| Engines (bridge) | **sherpa-onnx**, in two worker threads: **fast** (keyword spotting plus speaker embedding) and **slow** (multilingual Whisper `base` or `small`, picked by a latency probe). Scribe is used automatically when `ELEVENLABS_API_KEY` exists, with local Whisper as the fallback. Call `compute(stream, false)`, because Electron rejects external buffers. |
| Wake | Keyword spotting runs per VAD segment with the zh-en phone model. The only phrase is **"Hey Jarvis"**: `HH EY1 JH AA1 R V AH0 S`, plus the variant `HH EY1 JH AA1 R V IH0 S`. Dormant speech never leaves the PC and never reaches Whisper. The hotkey always works. The existing transcript-regex aliases (`jarvis|jarvys|jervis|travis|…`, voice.ts:81) remain as the fallback when the models are missing. |
| Naming | Product, package, window title, tray, installer, appId (`com.aswin.vas`) and data folders are **VAS**. The persona, HUD brand mark (`J.A.R.V.I.S.`), wake word, transcript labels, `JARVIS_*` env vars and MCP keys (`jarvis`, `jarvis_ui`, `jarvis_chrome`, `jarvis_eyes`) **stay JARVIS**, which avoids renaming churn. New in-process servers are `jarvis_neurons`. |
| Owner voice | sherpa CAM++ embeddings, with thresholds calibrated per clip length. `other` is never accepted. |
| Neurons | `bridge/neurons/`: a matcher (normal, strict, ordered-strict, not-contain, `{{var}}`) and `brain.yml`. Exactly one synapse runs. The router sits in the WebSocket `ask` handler. A matched order runs locally and replies with the existing `text`/`done` frames. Anything unmatched goes to Claude. Neurons are also exposed to Claude as the `jarvis_neurons` MCP server. |
| Agent SDK | `persistSession:false`. `cwd` is `%APPDATA%\VAS\data\workspace`. An allow-list `tools: ['WebSearch','ToolSearch','TodoWrite']`, plus `disallowedTools` for Bash, PowerShell, Read, Glob, Grep, Write, Edit, MultiEdit, NotebookEdit, KillShell and WebFetch. `effort` defaults to `medium`. `model` stays configurable via `JARVIS_MODEL`; the default is checked in the baseline step. |
| Data | `%APPDATA%\VAS\data\` holds `config.json`, `permissions.json`, `apps.json`, `apps-catalog.json`, `corrections.json`, `brain.yml`, `speaker.json` and `audit.log`. `%LOCALAPPDATA%\VAS\models\` holds the models, about 0.3–0.6 GB, downloaded only after you click. |

## Implementation steps
Commit once per step. Write each step's tests in that step. Line numbers are as of today; the function names are given in case they shift.

### M0 — Safety net and probes
**0. Create the VAS repository and restore jarvis-main.**
1. **New local repo.** `git clone --no-hardlinks <jarvis-main> C:\Users\Aswin\Downloads\VAS`. This keeps the baseline commit `1ae510b` as VAS's first commit. Then, in VAS:
   - `git branch -m main`, so `main` holds the baseline; work happens on `main` with one commit per step.
   - `git remote remove origin`.
   - `git config core.autocrlf false`.
   - Commit `.gitattributes` (`* text=auto eol=lf`, plus binary for wasm/mp3/png/ico/onnx), `docs/vas/` (PLAN.md and the design notes) and `.env.example`.
2. **Dependencies.** Copy `node_modules` from jarvis-main with `robocopy /E /MT:16`, which needs no network. Then run `npm run build` in VAS to confirm.
3. **Private GitHub repo.**
   - Pre-push secret check: `git ls-files` has no `.env*`, and `git grep` finds no `sk-ant-`, `xi-api-key:` values, `gho_` or `ghp_`.
   - `gh repo create aswinvensiva-crypto/VAS --private --source . --remote origin --push --description "VAS - desktop app for the JARVIS voice assistant"`.
   - Push after each milestone, not after every commit.
4. **Restore jarvis-main** exactly as downloaded. Remove only what this session added: `.git/`, `.gitignore`, `.gitattributes`, `docs/vas/`. The `dist/` folder from the baseline build is also removed. Your running `npm start` there is untouched.
5. **Baseline smoke test in VAS.** A bridge on port 8788 boots. A real "what time is it" ask, sent through a small WS script, proves the SDK login and model. It costs one Claude turn.

**1. Feasibility probes. These are read-only and decide the later choices.**
- `scripts/probe-chrome.mjs` (`npm run probe:chrome`):
  - Connect to the named pipe.
  - Send `tabs_context_mcp {createIfEmpty:false}` with `client_id:'vas'`, then `'claude-code'`.
  - Check whether **all** your tabs come back or only the Claude tab group.
  - Call `get_page_text`.
  - Try two clients at once, with Claude Code's own Chrome session connected and then disconnected.
- `npm i sherpa-onnx-node@1.13.8` (exact versions pinned). `scripts/fetch-models.mjs` downloads, with sha256 hashes pinned in `bridge/voice/models.lock.json`:
  - Keyword model: `sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20`
  - Whisper: `sherpa-onnx-whisper-base` and `-small`, int8
  - Speaker model: `3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx`
- `scripts/probe-voice.mjs` runs keyword spotting on a recorded "hey jarvis" and both Whisper sizes. Before your own recordings exist, it uses clips generated with Windows SAPI TTS on a 5 s mixed-language clip of yours, with `language` set to `en` and then to auto. It prints the real-time factor, memory use, keyword timestamps and the embedding dimension.
- Run `probe-voice` under system Node **and** inside an Electron `utilityProcess` plus a worker. Check for an `onnxruntime.dll` clash: transformers.js must never load in the same process.

### M1 — Foundation
**2. App naming: VAS outside, JARVIS inside.** This is a small step now.
- `package.json`: `"name":"vas"`, `"productName":"VAS"`, a new description. The launcher banners say "VAS: starting JARVIS".
- `index.html:65` `<title>VAS</title>`. That is the window title; the HUD keeps `J.A.R.V.I.S.`.
- README rewritten for VAS: Windows desktop install, "Hey Jarvis", Ctrl+Alt+Space, and credit to the jarvis-main origin.
- **Unchanged:** the persona name, wake aliases, `JARVIS_*` env vars, MCP keys, `[jarvis]` log prefixes and the `jarvis.voice` localStorage key.
- New shared `config/wake-aliases.json` (jarvis aliases), read by both the bridge (to strip wake words before neuron matching) and `src/lib/wakeWords.ts`. It replaces the duplicated `WAKE` (voice.ts:80), `OVERRIDE` (voice.ts:270) and `NAME`/`BARE_NAME`/`LEADING_NAME` (App.tsx:66-70) lists, with the same behaviour.
- Acceptance: `npm run build` passes, the window title is VAS, and "Hey Jarvis" still works via the regex fallback.

**3. Windows fixes.**
- `setup.mjs:41`: check the bundled `claude-agent-sdk-win32-x64/claude.exe`, plus the `claude` CLI with `shell:true` on win32.
- `package.json:18` `bridge:writes` → `node bridge/server.mjs --writes`.
- `start.mjs`: use `process.execPath`, a `ROOT`-based path, and `cwd:ROOT`.
- `configuredServers()` (server.mjs:169): match `homedir()` against both slash forms of the `projects` key.
- `FILE_ROOTS`: no `/tmp` on win32.
- New `src/lib/diskPath.ts`, adding drive-letter and `file:///C:/` support. Used by sanitise.ts:21, Blades.tsx:45 and Orbits.tsx:33.
- CSP (index.html:54-61): `http://127.0.0.1:*`.
- `config.ts:74`: the bridge URL comes from `window.vas`.
- ui.mjs:414 and `renderPage` origin: take the real port.
- `tts.ts score()` :176: rank the Windows voices (Microsoft Mark/David/Zira/Hazel/George/Ravi/Heera), plus a preferred-voice setting.
- chrome.mjs:755: `ctrl+a`.

**4. Bridge hardening, store, policy.** Run security tests alongside this step.
- `bridge/core.mjs`: the server.mjs body becomes `export startBridge(opts)` with `opts.queryImpl` injectable. `JARVIS_FAKE_SDK=1` loads a fake for tests. The bridge token is passed in as `JARVIS_BRIDGE_TOKEN`.
- `listen(port, '127.0.0.1')`, then post `{type:'listening', port}` to the parent.
- Token check in `handleRequest` (:665) and `verifyClient` (:985), with `handleProtocols`. `originAllowed` (:77) allows `app://vas`.
- Parse routes by `pathname`. This fixes the strict `req.url ===` at :679/:809/:894.
- `query()` options (:1193): the SDK settings from the decisions table. Also `env:{...process.env}` minus the token, and `pathToClaudeCodeExecutable` from `JARVIS_CLAUDE_EXE`.
- `bridge/policy.mjs`: move `decideTool` here and **allow the in-process servers `jarvis`, `jarvis_ui`, `jarvis_chrome`, `jarvis_eyes` and `jarvis_neurons` by name before the `EFFECTFUL_VERB` veto**. Those servers enforce their own gates.
- `bridge/store/files.mjs`: zod-validated JSON with atomic writes and watch-reload, plus the `config.json` schema (wake keywords, speech engine and language, hotkey, user name, owner gate). `bridge/store/audit.mjs`: JSONL, with typed text redacted to its length.
- `scripts/web.mjs`: browser debug mode with `--insecure-dev`.

### M2 — Desktop app
**5. Electron shell.**
- `npm i -D electron electron-builder`, pinned.
- `electron/main.mjs`:
  - Single-instance lock, `setAppUserModelId('com.aswin.vas')`.
  - `app://` protocol handler with path-escape guard, wasm MIME type and SPA fallback.
  - `bridge-host.mjs`: token, `utilityProcess.fork`, wait for `listening` **before creating the window**, restart with backoff, log to `bridge.log`, parent watchdog.
  - Token header injection.
- Permission handlers grant `media` and `local-network-access` to `app://vas` only. `setWindowOpenHandler` sends https links to `shell.openExternal`.
- `webPreferences`: `contextIsolation`, `sandbox`, `backgroundThrottling:false`, `autoplayPolicy:'no-user-gesture-required'`.
- Close hides to the tray.
- `tray.mjs` menu: Show, Listening on/off, Enroll my voice, Settings, Open data folder, Start with Windows (`setLoginItemSettings({openAtLogin, args:['--hidden']})`), Quit.
- `globalShortcut` `Control+Alt+Space` → `vas:hotkey`, falling back to `Control+Alt+J`. Never Ctrl+Alt+V.
- `electron/preload.cjs`: `contextBridge` `window.vas {bridge (via invoke), onHotkey, onTray, startHidden, quit}`.
- `bridge.ts connect()` (:221): pass the subprotocol token.
- `App.tsx`:
  - Factor Space (:664) into `manualTrigger()` and also bind it to the hotkey.
  - Boot automatically under `window.vas`, skipping the 9.2 s animation when hidden.
  - A tray "deaf" setting makes `mode()` return `deaf`.
- Electron builds compile out direct mode (`anthropic.ts`, the API key in the renderer).
- Scripts: `dev` (Vite, then Electron), `app`, `web`, `prebuild` → `vendor-wasm` (from start.mjs:33).

### M3 — Chrome
**6. Chrome pipe and gated actions.**
- `findSocket()` on win32: `readdir('\\\\.\\pipe\\')`, then the case-insensitive pipe name.
- `ChromeLink.call` (:247): add `client_id`, `'vas'` by default, falling back to `'claude-code'` per the probe. Add a connect-per-call mode in case the pipe is shared.
- Export `chromeOps` (navigate+settle, pageText, screenshot, tabs, newTab).
- `chromeServer({gate})`: the acting tools are always built (remove `if (allowWrites)` at :727). The click/type/key/form_input/close_tab handlers call `gate.check('chrome.act')`.
- **The confirmation is built from facts:** a freshly read tab URL, the action, the element's accessible name, and a preview of the text to type. The confirmation is bound to that tab and URL and re-checked before acting.
- Taint rule: once a turn has read page text, navigating to a **different site**, `probe_url` and remote blade URLs ask once (blocks data exfiltration via URLs).
- Search and open always use a **new tab** (`tabs_create_mcp`), never your current tab.
- If the probe shows only the Claude tab group is visible: a fixed PowerShell UI Automation script reads the foreground Chrome window's address bar, and VAS opens that URL in its group tab (same profile and cookies).

### M4 — Voice
**7. PCM capture, local Whisper, Scribe.**
- `public/worklets/pcm-capture.js`, an AudioWorklet producing 20 ms frames at 16 kHz, resampling if the context rate differs.
- `src/lib/wav.ts`.
- Rewrite the internals of `vad.ts startVad()` (:102-273): frame-driven RMS with the same floor/threshold constants and a 300 ms pre-roll, emitting a WAV. Add `captureSegment()`. The `VadHandlers` interface is unchanged.
- `voice.ts transcribe()` (:448): call `/stt?mode=` and get back `{text, raw, utt, wake, owner, engine, reason}`.
- In Electron, **always** use the VAD tier. If `reason:'models-missing'`, re-probe capabilities and restart the voice loop after the download.
- Extract `makeAssembler` (:192) to `assembler.ts`.
- Bridge files:
  - `bridge/voice/wav.mjs`
  - `worker-fast.mjs` and `worker-asr.mjs`
  - `scribe.mjs` (moved from server.mjs:927)
  - `engine.mjs` (Scribe when a key exists, otherwise local Whisper)
  - `utterances.mjs` (`utt` id → text, raw, owner verdict, duration; 2 min TTL)
- **Whisper hallucination filter:** a blocklist ("thank you.", "thanks for watching", …), a minimum speech-energy ratio, and segments under 400 ms dropped. A flagged segment can never confirm anything.
- `/health` adds `sttEngine`, `kws`, `speaker.enrolled`, `user.name` and `modelsMissing`. The UI has a "Download voice models" button (explicit click).

**8. "Hey Jarvis" wake word.**
- `bridge/voice/keywords.mjs`: build the keywords file from `config.wake`, validate the phones against `tokens.txt`, and `phonesFor()` looks up user phrases in `en.phone`.
- In wake mode: no keyword hit means no speech recognition at all. On a hit:
  1. Get the owner verdict.
  2. Slice at **keyword end − 200 ms**.
  3. Run Whisper on the rest.
  4. Strip leftover wake words with `LEADING_NAME`.
- Also run keyword spotting on command-mode segments to strip the "Jarvis" variants Whisper misspells ("Travis", "Jervis", "Java's").
- `App.onWake` (:239) passes the `utt` metadata through.
- Acceptance: "hey jarvis" wakes it 3/3, including "hey jarvis, open chrome" said in one breath. "Travis is here", "service" and normal conversation do not wake it.

**9. Permission gate and spoken confirm.**
- `bridge/gate.mjs`, per connection, with tiers `free | remember | confirm | deny` from `permissions.json`. Defaults:
  - **free:** Chrome reads, navigate and search, `list_apps`, time, say.
  - **remember:** `open_app` and `focus_app`, remembered per AppID.
  - **confirm:** `close_app`, Chrome actions, saving a routine or correction, quit/unlock, high-risk apps (cmd, PowerShell, Terminal, regedit, `.msc`, `.bat`/`.cmd`/`.ps1`/`.vbs` entries), and the camera while the window is hidden.
- The confirmation uses the existing `ask(kind, args, timeout)` (server.mjs:1102) with `reply` (:1434). A registry plus mutex allows **one pending confirmation at a time**. `interrupt`, socket `close` and `goDormant` abort every pending confirmation and send `confirm_cancel`. Timeout is 25 s, then deny.
- Renderer, `store.ts`:
  - New `confirming` phase, with a `phaseColor` entry (:419) and HUD handling.
  - Speak the prompt **without** `silence()` (App.tsx:96); `respond()` uses `out()`, so the turn's own speaker stays alive.
  - `mode()` returns `command` while confirming. `onSpeechStart` does not interrupt. `onUtterance` routes to the confirmation.
  - Ignore any segment whose start falls before the prompt's TTS end + 250 ms. After that, skip `isEcho`.
  - Skip the 1.6 s assembler hold.
  - Parse the **raw** text, checking deny words before accept words.
  - Space and the hotkey do nothing; Escape cancels.
  - HUD Confirm and Cancel buttons; a click counts as a confirmation.
- Everything is written to the audit log.

**10. Voice enrollment ("only my voice").**
- `bridge/voice/speaker.mjs`: cosine similarity, a centroid, and **thresholds by clip length** calibrated from at least 5 short and 2 long enrollment clips.
- Verdicts are `owner | unknown | other`. A confirmation is accepted if it is not `other` **and** the command that triggered it was `owner` within the last 60 s.
- Endpoints `/voice/enroll`, `/voice/enroll/finish`, `/voice/status`, `/voice/test`, `DELETE`. Enrollment also sweeps the keyword-spotting threshold on your "hey Jarvis" clips.
- `src/ui/Enroll.tsx` overlay, run with the voice loop in **enroll mode**, so nothing is acted on. It records 8 prompts, then shows a live score test.
- `speaker.json` is optionally encrypted with a DPAPI key from `safeStorage`.
- Settings toggle `requireOwner: actions | all | off`.

### M5 — Neurons
**11. Neurons core.**
- `npm i yaml` (round-trip keeps comments).
- `bridge/neurons/matcher.mjs`:
  - `normalize`: strips fillers and wake words, keeping an `orig` copy for captured values.
  - `parseTemplate` and the four match types.
  - `extractParams` captures each variable up to the first stop word.
  - Rejected: empty captures, adjacent `{{a}} {{b}}`, and templates made only of variables unless `default:true`.
- Ranking: **literal-word coverage** first (exact routines win), then user brain over default brain, then match type, then file order.
- `brain.mjs` merges `brain.default.yml` with the user `brain.yml`, validates with zod, hot-reloads, and keeps the last good brain.
- Neuron contract `{name, description, tier, params (zod), run(params, ctx) → {say, handoff, fallthrough, after}}`. `ctx` = gate, say, send, apps, chromeOps, memory, voice verdict, signal, audit, route.
- **Router** in the `ask` handler (server.mjs:1406-1432). The old body becomes `deliverToClaude`. Replace the single `answering` (:1086) with a **FIFO of ask ids**, shifted on each `result` (:1339). Local turns:
  - send `text`/`done` with an explicit `ask:id`;
  - check `signal.aborted` before every send;
  - speak "Opening Spotify." at once and send a `tool` frame (fillers);
  - append to `conn.localLog`, which is prefixed to the next Claude message, e.g. `[Handled locally: "open spotify" → opened Spotify]`.
- The bridge ignores asks whose utterances are all `other`.
- First neurons: `say`, `time`, `repeat`, `kill_switch` (sleep, mute, quit with confirm, lockdown/unlock), and `ask_claude` (the default). `fillers.ts BY_TOOL` (:96) gets the `jarvis_neurons` rules.

**12. Windows app neurons.**
- `bridge/os/catalog.mjs`: a constant `Get-StartApps | ConvertTo-Json` via `execFile(powershell.exe, [...])`. It is cached in `apps-catalog.json` (measured 3.6 s cold), refreshed in the background every 24 h, and at most once per 10 min on a miss. High-risk entries are tagged.
- `resolve.mjs` matches by alias, exact name, prefix, token prefix, acronym ("vs code" → Insiders) and Jaro-Winkler.
  - Ambiguous → a spoken choice.
  - Below 0.6 → falls through to Claude.
  - Site words go to `chrome_open`.
- `launch.mjs`:
  - Only catalog AppIDs, run as `execFile(explorer.exe, ['shell:AppsFolder\\'+id])` (it exits with 1 on success).
  - A direct spawn is used only for existing `.exe` paths, e.g. `D:\Notepad++\notepad++.exe`.
  - Never `shell:true`, never a string built from speech.
  - Success unless an error occurs. A failure is reported only if the known process is still absent after 8 s.
  - Focus re-runs `shell:AppsFolder`, because `AppActivate` from a background process is blocked by Windows.
  - Close: `close-app.ps1` with `CloseMainWindow()`; process names come only from `apps.json`.
- Neurons: `open_app` (remember), `close_app` (confirm), `focus_app`, `list_apps` (blade), `refresh_apps`.
- Default synapses: `open|launch|start {{app}}`, `close|quit {{app}}`, `switch to {{app}}`, `what apps do i have`.
- `bridge/neurons/mcp.mjs`: the per-connection `jarvis_neurons` server. Its tools share `ctx`, so the same gate applies.

**13. Learn from corrections.**
- `bridge/corrections/store.mjs`: `apply()` is a single-pass, word-boundary Unicode regex, longest entry first, with escaped input. Applied in `engine.transcribe`. Confirm and deny parsing always use the raw text.
- `learn.mjs`: word-level alignment of the previous **raw** utterance against what you meant, extracting one differing span of 1–4 words. There is a letter-similarity fallback ("spot if i" → "Spotify").
- `correction` neuron: `no i said {{text}}` / `i meant {{text}}`. It requires the previous utterance to be under 30 s old and similar to what you said; otherwise it falls through to Claude.
- Save flow: confirm → save → `ctx.route()` re-runs your corrected command.
- Corrections touching confirm/deny words, wake aliases or kill phrases are refused.
- `src/ui/Settings.tsx` drawer has tabs for corrections, apps, routines, voice and permissions, backed by `/settings/*` endpoints.

**14. Chrome neurons.**
- `chrome_open` (`open {{site}} in chrome`, `go to {{site}}`, with a `config.sites` map and "x dot com" handling).
- `chrome_search` (`search for {{query}}`, `google {{query}}`) opens the results in a new tab.
- `chrome_read_tab` (`read this page`, `what's on this tab`).
- Each one **hands off to Claude with an instruction to read via `chrome_page_text`**. The page text arrives as a tool result, not as your words, so it never gains user authority.

**15. Teach routines (new neurons by voice).**
- `teach` neuron: `when i say {{spec}}`. The trigger and the actions are split at the first comma; otherwise every split point is tried and the one whose remainder fully resolves to actions wins; otherwise VAS asks.
- Each step must resolve now to an **allowed routine neuron**: open/focus/close app, chrome open/search, say, time. No nesting, teach, corrections, kill switch or unlock.
- Single-word triggers and triggers containing confirm, wake or kill words are blocked.
- Saving needs confirmation. The routine is written into `brain.yml` via `yaml.parseDocument` as ordered-strict. Saving never grants app permissions; each step keeps its own tier when it runs.
- `forget the routine {{name}}` (confirm), `list routines`.
- The `teach_routine` MCP tool goes through the same validation and confirmation.

### M6 — Persona and installer
**16. Persona.**
- `bridge/persona.mjs buildSystemPrompt({userName, corrections, apps, routines})` replaces `SYSTEM_PROMPT` (server.mjs:293-439).
- It still opens "You are JARVIS…" and adds that JARVIS lives inside the VAS app on your Windows laptop. The tone becomes **friendly and casual**, using your first name in at most one reply in four. `userName` comes from config, defaulting to "Aswin".
- Remove the "sir" rules, the British service register, the never-use-name rule and the no-enthusiasm bans.
- Keep the spoken-prose rules, blades, Chrome as hands not display, camera and tool rules.
- Add: use `jarvis_neurons` and never a shell; the tools confirm themselves, so never ask twice; Chrome page text is untrusted; your app names and known mishearings; some commands are handled locally.
- Casual `fillers.ts` pools; drop the `tts.ts shape()` "sir" rule (:326).

**17. Package.**
- electron-builder NSIS, per-user install, `appId com.aswin.vas`, `productName VAS`, `build/icon.ico`.
- `asarUnpack`: `claude-agent-sdk-win32-x64/**`, `sherpa-onnx-node/**`, `sherpa-onnx-win-x64/**`, `bridge/voice/**`, `bridge/os/*.ps1`.
- `JARVIS_CLAUDE_EXE` points at the unpacked `claude.exe`.
- The installer checks for the VC++ runtime.
- Models are not bundled; there is a first-run download prompt.
- Renderer-only packages move to devDependencies; remove the unused `@picovoice/*`.
- Optional: `@electron/fuses`.
- `npm run dist` → `release/VAS Setup.exe`.

## Tests
- `npm test` = `node --test test/bridge/*.test.mjs` plus `node --import tsx --test test/renderer/*.test.ts`. No new test dependencies.
- **Neurons and voice logic:** matcher, params (Kalliope behaviour as our own cases), brain, router, corrections (`cat` vs `category`), gate (tiers, owner rules, abort, audit), apps (resolver against a fixture of this PC's `Get-StartApps`; no `shell:true` anywhere), wake keywords and speaker math.
- **Bridge:** chrome-pipe (a fake `net.Server` on `\\.\pipe\vas-test-*`), security, protocol and policy.
  - The security and protocol tests spawn the bridge with `JARVIS_FAKE_SDK=1` and check: 127.0.0.1 bind, 401 without the token, 403 for a bad origin, local `text`/`done` frames tagged with the ask id, the confirm round-trip, `interrupt` aborting a confirmation, the FIFO ask ids, and that `persistSession:false` and the tools allow-list reach `query()`.
- **Renderer:** wake regex, diskPath, assembler, wav, and the persona text.

## End-to-end verification (`npm run dev`, then the installed build)
1. Starts hidden at login with the tray icon. `netstat -ano | findstr LISTEN` shows only `127.0.0.1` for VAS. `curl` to `/health` without the token gets 401. No Chrome tab is opened.
2. "Hey Jarvis, what time is it" is answered locally (under 300 ms, with no SDK turn when `JARVIS_DEBUG=1`). "Hey Jarvis, tell me something fun" gets a casual reply from Claude, with no "sir".
3. Ctrl+Alt+Space works while VAS is hidden. After 10 minutes minimized, "hey Jarvis" still works.
4. "Open Spotify" asks once, then opens it. Next time it opens without asking. "Close Spotify" asks every time, and "cancel" leaves it open. "Open VS Code" opens Insiders. "Open command prompt" always asks. "Hey Jarvis, can you get WhatsApp up for me" goes to Claude, which uses `jarvis_neurons.open_app` (shown in the audit log).
5. "Search for Kochi weather" uses a new tab in your Chrome and gives a spoken summary. "What's on this tab" gives a summary. Asking it to click something in Gmail triggers a spoken confirmation naming the site and the button.
6. Mishear something, then "no, I said …": confirm, saved, and the command re-runs. Next time it is corrected automatically.
7. "When I say work mode, open VS Code and Chrome", then confirm: "work mode" runs without Claude. "Forget the routine work mode" removes it.
8. Enroll your voice. Another voice or a phone recording can't wake JARVIS or confirm anything.
9. "Run echo hi in a terminal" is refused. No new VAS files appear in `~/.claude/projects`.
10. Add `ELEVENLABS_API_KEY`: `/health` shows `scribe`, and dormant audio still never leaves the PC.
11. "Go to sleep", "mute yourself" and "shut down VAS" (with confirmation) work, and no bridge process is orphaned.
12. Quit Chrome, then ask about a tab: it gives a one-sentence "browser isn't available".

## Risks and fallbacks
| Risk | Fallback |
|---|---|
| The named pipe refuses a second client, or the Claude Code session conflicts | Connect-per-call mode, `client_id` variants; if neither works, close Claude Code's Chrome session while VAS runs |
| Only the Claude tab group is visible | UI Automation address-bar read, then open the same URL in the group tab |
| False wakes or missed wakes | Threshold and boost sweep from enrollment, owner check on wake, cooldown, extra phone variants, hotkey always available |
| Owner falsely rejected (cold, new mic, short words) | Thresholds by clip length, recalibration per mic, click confirm, `requireOwner:off` |
| Whisper too slow on CPU | `base`/`tiny`, thread tuning, Scribe; plan B transformers.js in a **separate** process (DLL clash) |
| Mixed-language speech transliterated or translated | Pick `en` or auto from the probe clip; corrections; Scribe |
| sherpa addon fails to load in Electron | asarUnpack, absolute path, `ELECTRON_RUN_AS_NODE` spawn, `asar:false` |
| `local-network-access` or header injection blocks bridge calls | Grant for `app://vas`; else proxy through a second privileged scheme with the token added in main |
| Prompt injection from web pages | Tools allow-list, no shell or file tools, taint rule, fact-based confirmations, owner voice, lockdown |

## Critical files
- `<root>\bridge\server.mjs` → `core.mjs`: `decideTool` 255, `SYSTEM_PROMPT` 293, `/stt` 894, `listen` 1001, `ask()` 1102, `query()` 1193, ask/reply/interrupt 1398-1455.
- `<root>\bridge\chrome.mjs`: `findSocket` 84, `call` 245, `resolveTab` 442, `chromeServer` 553, acting block 727.
- `<root>\src\lib\voice.ts`: WAKE 81, `isEcho` 297, `startVoice` 389, `transcribe` 448. `<root>\src\lib\vad.ts`: `startVad` 102.
- `<root>\src\App.tsx`: `silence` 96, `respond` 126, `mode` 224, `onSpeechStart` 270, `onUtterance` 292, `ignite` 349, keys 664.
- `<root>\src\lib\bridge.ts`: `dispatch` 162, `connect` 214, `ask` 316. `<root>\src\store.ts`: `Phase` 3, `phaseColor` 419.
- Reference only, unmodified: `kalliope\core\OrderAnalyser.py`, `NeuronParameterLoader.py`, `Tests\test_order_analyser.py`.
