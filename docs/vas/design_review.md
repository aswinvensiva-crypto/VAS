# Adversarial review of the VAS implementation plan

The plan is close but not ready. Eight problems would break the core features: confirmation, the router, speaker check, the Electron transport and the agent sandbox. Line numbers refer to files under `jarvis-main`. I checked them against the real files. External claims were checked on the web, and the sources are cited.

## 1. Defects and fixes

### A. Confirm round-trip and router (would break)

**1. Everything said after a confirmation is silent.**
- Cause: `watchConfirm` calls `silence()` (`src/App.tsx:96-99`), which cancels the turn's speaker. Cancel is permanent: `enqueue` returns early once cancelled (`src/lib/tts.ts:355-356`, `:709-716`). `respond()` keeps pushing into that dead `spk` (`App.tsx:140-163`).
- Effect: Claude's "done, it's open" and a local neuron's `r.say` after `gate.check` are never heard.
- Fix: never cancel the turn speaker for a confirmation. Either speak the prompt through the same speaker, or have `respond()` use `out()`, which creates a new speaker when `speaker.current` was replaced. Only `onSpeechStart` and `goDormant` may cancel.

**2. The echo filter both drops real confirmations and can let the prompt approve itself.**
- `isEcho` (`src/lib/voice.ts:297-318`) runs for 1800 ms after speech ends (`tts.ts:54`, `:122`). Spoken inside that window, the user's "yes, confirm it" matches every word of the plan's re-prompt "Say 'yes, confirm it'" and is dropped.
- Simply skipping `isEcho` is worse. speechSynthesis (SAPI) plays outside Chromium's echo canceller, so the mic hears the prompt itself. A VAD segment that starts mid-prompt ("Yes, confirm it.") would then approve itself. With no voice enrolled, the plan's gate accepts that.
- Fix, while confirming:
  - Drop any segment whose VAD onset is earlier than prompt TTS end + 250 ms.
  - After that point, skip `isEcho`.
  - Require the speaker verdict to be anything but `other`.
  - Run `parseConfirm` on the raw transcript.
  - Check deny words before accept words.

**3. Confirmations wait an extra 1.6 s.** `holdFor` holds any one- or two-word utterance for 1600 ms (`voice.ts:178`, `:157`); "no" and "cancel" escape only because they are in `OVERRIDE`. Fix: in confirming mode, skip the assembler and emit as soon as the text matches the confirm grammar.

**4. Interrupt cancels only local confirmations.**
- The plan aborts `localTurn` only. A confirmation pending inside a Claude MCP handler stays open until its 30 s timeout. The handler's `extra` is typed `unknown` (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:6940`), so there is no reliable abort signal.
- Claude can also issue parallel `vas_neurons` calls, which would give two prompts but only one `confirmPrompt` in the UI.
- Fix: the gate keeps a per-connection registry of pending confirmations and a mutex so only one runs at a time. `interrupt`, socket `close` (`bridge/server.mjs:1443`, `:1457`) and `goDormant` abort all of them and send `confirm_cancel`.

**5. A stale local turn can hang the next answer.**
- The plan's router code never checks `ac.signal.aborted` after `await hit.run`. If a hand-off lands after a barge-in, `deliverToClaude` sets `answering` back to the old id (`server.mjs:1423`, `:1087`) while the new ask is queued.
- The new answer then carries the wrong id. The client filter drops it (`src/lib/bridge.ts:428`), and the turn hangs until the 120 s idle timeout (`bridge.ts:311`).
- Fix:
  - Check `aborted` before every send or delivery.
  - Replace the single `answering` value with a first-in-first-out queue of ids in the same order as `inbox`. Shift it on each `result` (`server.mjs:1339-1364`).

**6. Claude never hears about turns handled locally.** Example: "open Spotify" runs locally, then "close it" goes to Claude, which has no context. Fix: keep `conn.localLog` and put a short line at the start of the next message to Claude, e.g. `[Handled locally: "open spotify" → opened Spotify]`.

**7. The new `confirming` phase breaks the build and the keys.**
- `phaseColor` is `Record<Phase,string>` (`src/store.ts:419-428`), so `tsc` fails until it gets an entry. `Hud.tsx` and the scene need handling too.
- The Space handler (`App.tsx:672-681`) and the hotkey treat `confirming` like idle and call `onWake('')`, which orphans the pending confirmation.
- Fix: during confirming, Space and the hotkey do nothing, Escape cancels, and `clearIdle()` runs on entry.

**8. Local neurons go silent for 3-6 s.** A cold catalog refresh takes 3.6 s and launch verification another 2.5 s. With no `tool` frame there is no filler (`App.tsx:165-181`). Fix: say "Opening Spotify." at once, send a `tool` frame, and verify in the background.

### B. Speaker verification

**9. Owner checks on short clips are unrealistic as specified.**
- The threshold `p10(intra) - 0.05` is calibrated on clips of mixed length, some about 6 s, and anything under 800 ms is `unknown`. A 1 s "yes, confirm it" will often score `unknown`, then the re-prompt, then a denial.
- Fix:
  - Use separate thresholds by duration, calibrated from at least five short enrollment clips.
  - Accept a confirmation when its verdict is not `other` and the command utterance that triggered it (longer, within 60 s) was `owner`.
  - Never accept `other`.
  - Without enrollment, rely on the onset gating from item 2, and allow click confirmation.

**10. The embedding call throws in Electron.** sherpa-onnx's `SpeakerEmbeddingExtractor.compute(stream, enableExternalBuffer = true)` uses external buffers by default, and Electron 21+ rejects them (V8 memory cage; sherpa-onnx PR #925 says the fix is for "electron >= 21"). Fix: call `compute(stream, false)`, and `readWave(f, false)` in the probes. The step-5 probe must run inside a `utilityProcess` plus `worker_threads`, the real setup, not only with `ELECTRON_RUN_AS_NODE`.

**11. Enrollment triggers real actions.** The prompt "Hey VAS, open Chrome" goes through the live voice loop, wakes VAS and opens Chrome. Fix: put the loop in an `enroll`/deaf mode while the overlay is open, and have `captureSegment()` skip `transcribe()`.

**12. Other voices can still cut VAS off.** In guard mode, any speech onset interrupts at once, before any verdict exists (`voice.ts:532-539`). So a TV or another person still cuts VAS off even with `ownerGate:'all'`. Fix (optional): lower the volume on onset and cancel only once the verdict is not `other`.

### C. Wake word and speech-to-text

**13. Audio slicing after the wake word can clip the command.**
- The keyword model is real: release asset `sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20.tar.bz2` (32.9 MB). It ships ARPAbet phone tokens, `en.phone`, int8 encoder/joiner and an fp32-only decoder. The chunk-16 model has about 320 ms latency, so keyword timestamps can trail the audio. `text2token` is a Python tool, so JS phone lookup (`phonesFor`) is required.
- Problem: slicing at `keywordEnd + 150 ms` can cut the first command word.
- Fix:
  - Slice at keyword end minus about 200 ms and always strip leftover wake words with `LEADING_NAME`.
  - Also run the keyword spotter on command/guard segments and strip by timestamp, because Whisper spells "VAS" many ways ("Vaz", "bus", "V.A.S."). `LEADING_NAME` (`App.tsx:70`) misses those, and the ordered-strict router then fails.
  - The alias regex must accept dots in `v.a.s`.

**14. Whisper invents text from noise.** Short or noisy segments produce "Thank you." and similar, during the 11 s follow-up window (`App.tsx:56`) and on 600 ms trailing slices. That creates fake turns and fake confirmations. Fix: a blocklist of known hallucinations, a minimum amount of speech in the segment, and an energy check. Never take a confirmation from a flagged segment.

**15. One worker delays wake detection.** It runs every task in sequence, so keyword spotting waits behind a 2-3 s Whisper decode. Fix: two workers, one fast (keyword spotting and embeddings) and one for speech recognition.

**16. First run has no working voice path.**
- With models missing and no ElevenLabs key, `/health` reports `stt:false`. `startVoice` then picks the browser tier (`voice.ts:401-402`), which loops silently in Electron (`voice.ts:771-785`). The loop starts only once (`App.tsx:518`).
- Fix: in Electron, always start the VAD tier. `/stt` returns `{text:'', reason:'models-missing'}`, and the app re-reads capabilities and restarts the loop after the download.

### D. Electron and transport

**17. Electron may block the app's own bridge calls.** Electron 41+ passes `local-network-access` to the permission handlers (electron PR #53170; issue #50391 on Electron 41/Windows 11). The plan denies everything except `media`, so `app://vas` to `127.0.0.1` requests may be blocked. Fix: grant `local-network-access` for `app://vas` in both the request and check handlers, and test on the pinned Electron version. Fallback: route HTTP through the `app://` protocol handler (risk D10).

**18. Packaging gaps.**
- `new Worker('bridge/voice/worker.mjs')` will be inside `app.asar`. Add `bridge/voice/**` to `asarUnpack`.
- sherpa-onnx has reports of "Could not find sherpa-onnx-node" in packaged Windows apps (issues #1945, #2866; the second resolved once Python, and with it probably the VC++ runtime, was installed). Have the installer check for or ship `vcruntime140`/`msvcp140`.

**19. Two different `onnxruntime.dll` files will collide.** `sherpa-onnx-win-x64` ships one. `onnxruntime-node`, already installed for transformers, ships another version. Windows Machine Learning also puts one in System32. Plan B (transformers.js speech recognition) must run in a separate process, never next to sherpa.

**20. The preload can freeze the window at startup.** `ipcRenderer.sendSync('vas:bridge-sync')` blocks the renderer until the bridge is listening, which can take up to 15 s. Fix: create the window after `listening`, or use `invoke`.

**21. Models are in the wrong folder.** `%APPDATA%` is the roaming profile, which is wrong for about 0.5 GB of models. Use `%LOCALAPPDATA%\VAS\models`. Also, Electron's `userData` folder holds Chromium caches, so put VAS data files in a subfolder.

**22. The camera works silently while VAS is hidden.** `look`/`watch` (`server.mjs:1216`) run freely while the window is hidden in the tray at login. Fix: while the window is not visible, make them confirm-tier with a tray notice.

**What checked out:**
- Token auth: passing the WebSocket token as a subprotocol is sound. Injecting the header via webRequest covers `<img>`/`<video>`/`<iframe>`. Leakage through `/page` iframes is low risk, because they are sandboxed without `allow-same-origin` (`src/ui/Blades.tsx:173`) and scripts need a nonce (`bridge/page.mjs:419-425`).
- Audio format: dropping MediaRecorder for AudioWorklet PCM is correct. Running `decodeAudioData` on MediaRecorder segments would mean async decode and resampling on every segment for no benefit.

### E. Agent sandbox and security

**23. A deny-list of built-in tools leaks.**
- CLI 2.1.220 has `Monitor` (runs shell loops), `CronCreate`/`ScheduleWakeup` (inject future turns, `sdk.d.ts:6783`), `Agent`, `Skill`, `WebFetch` and others.
- Scheduled turns would arrive with stale ids and trigger confirmation prompts out of nowhere.
- Fix: use the `tools: [...]` allow-list (`sdk.d.ts:1431`), for example `['WebSearch','ToolSearch','TodoWrite']`, and keep `disallowedTools` as a second layer.
- Note: `env` replaces the whole environment (`sdk.d.ts:1438-1441`), so `scrubEnv` must spread `process.env` (PATH, USERPROFILE, APPDATA).

**24. Signed-in data can still be sent out.** Chrome reads are free, `chrome_navigate` is free, `WebFetch` is allowed (`server.mjs:133`), and the `/img` proxy, blades and `probe_url` can all carry a URL. Page text with an injected prompt can therefore leak signed-in data through a URL query string. The plan's statement that this injection path is closed is overstated. Fix: mark a turn as tainted once untrusted content is read. After that, navigating to a new site, `WebFetch`, `probe_url` and remote blade URLs need confirmation. Drop `WebFetch`.

**25. Chrome confirmation prompts can lie.** The prompt text is the model-written `intent`, and the site comes from a cached `activeOrigin()`. Fix: build the prompt from facts: a freshly read URL for the target tab, the action type, the element's accessible name (via `read_page`/`find`) and a preview of typed text. Tie the confirmation to that tab and URL, and re-check before acting.

**26. The search hand-off promotes page text to user authority.** Step 13 sends page text as a user message. `</page>` inside the text also breaks out of the framing. Fix: let Claude call `chrome_page_text` so the text arrives as a tool result, or at least escape `<page` and `</page`.

**27. Copying `client_id:'claude-code'` may merge VAS into the user's Claude Code browser session**, including the shared tab group and `tabs_close_mcp`. Default to `'vas'`, and fall back only if the native host rejects it.

**28. Search and open can wreck the user's tab.** They navigate the remembered tab (`bridge/chrome.mjs:369`, `:447`), which can wipe a draft. Use `tabs_create_mcp` instead.

**29. The fallback for "only the Claude tab group is visible" (risk D2) fails decision 5.** Better fallback: read the address bar of the foreground Chrome window with a fixed PowerShell UI Automation script, open that URL in the group tab (same profile, same cookies), then read it.

### F. Neurons, teach and corrections

**30. Taught routines lose to built-in synapses.** Ranking ordered-strict above strict lets the default `open {{app}}` beat a taught "open my stuff". Fix: rank first by how much of the input is matched by literal words (exact matches with no variables win), then user brain over default brain, then match type. Save taught routines as ordered-strict.

**31. Splitting a taught phrase at the first action verb breaks triggers that contain a verb** ("start my day", "say goodnight", "read mode"). Fix: split at the first comma if there is one. Otherwise try each split point and keep the one whose remainder fully resolves to actions. Otherwise ask what the trigger should be.

**32. Routines and triggers need limits.**
- Block triggers that are single words or overlap confirm/cancel words, wake words, or kill-switch and lockdown phrases.
- Only these may appear in a routine: `open_app`, `focus_app`, `close_app`, `chrome_open`, `chrome_search`, `say`, `time`. No `teach`, `correction`, `kill_switch`, `unlock` or `run_routine` (no nesting or loops).
- Saving a routine must not silently grant apps.
- Expose `teach_routine` and `add_correction` to Claude only with owner confirmation, or not at all.

**33. Corrections can be abused to fake a confirmation.** `parseConfirm` runs on corrected text, so a saved "X → confirm" makes approvals trivial. Fix: run accept/deny parsing on raw text. Refuse corrections whose heard or meant side contains confirm/deny words, wake aliases or kill-switch phrases. Escape regex characters in `heard`.

**34. `i said {{text}}` catches ordinary sentences** that start with "I said". Fix: require the previous utterance to be within 30 s and above a similarity floor; otherwise fall through to Claude.

### G. Apps

**35. Launch check reports false failures.** Apps that already run in the background (WhatsApp, Spotify) and broker processes show no new process, and 2.5 s is too short for a cold VS Code start. Fix: count a launch as successful unless explorer or spawn errors. Report failure only if the known process is still absent after 8 s.

**36. `AppActivate` from a background process is blocked** by the Windows foreground lock. Fix: focus by re-running `explorer shell:AppsFolder\<AUMID>`, which brings single-instance apps forward.

**37. Some Start-menu entries are scripts or URLs.** Allow direct spawn only for `.exe` paths. Treat `.bat`/`.cmd`/`.ps1`/`.vbs` entries as high risk, and send URL entries to `chrome_open`. Add to the probe: how explorer handles a quoted argument with a space (`D:\postgres sql\…`).

### H. Consistency

**38. Steps use pieces that don't exist yet.** Steps 6-7 read `config.json` (wake keywords, speech engine) and call `corrections.apply`, but the store arrives in step 9 and corrections in step 14. Fix: move `bridge/store/files.mjs` and the config schema into step 3, and stub `corrections.apply` in step 6.

**39. Wrong cross-references and a phantom server.**
- Persona is called "step 15" but is step 16.
- Packaging is called "step 16" but is step 17.
- Corrections are called "step 13" but are step 14.
- The policy allows `vas_os`, which is never created; the tools live in `vas_neurons`.
- `boot.cjs` must also call `startBridge`.

**40. The bridge can't share the wake-word list.** `src/lib/wakeWords.ts` can't be imported by the bridge's `.mjs` router. Fix: put the aliases in a shared JSON file that both read.

## 2. Missing steps

Some of these restate defects above as concrete work items.

- Local-turn context sent to Claude (item 6).
- Whisper hallucination filter (item 14).
- Enrollment mode (item 11).
- Restart the voice loop after model download (item 16).
- `local-network-access` grant (item 17).
- VC++ runtime check (item 18).
- Confirmation registry and mutex (item 4).
- Taint gating for outbound URLs (item 24).
- Camera confirmation while hidden (item 22).
- Routine and trigger allow/block lists (items 32-33).
- Address-bar fallback for the user's current tab (item 29).
- `tools` allow-list (item 23).
- Shared wake alias JSON (item 40).
- Compile direct mode (`VITE_BACKEND=direct`, which puts the API key in the renderer, `src/lib/anthropic.ts:10-13`) out of the Electron build.
- `setWindowOpenHandler`: send https links to `shell.openExternal` instead of plain deny.
- Write each test with its step instead of all in section C:
  - matcher and params tests with step 11;
  - gate tests with step 9;
  - security tests with step 3.

## 3. Corrected order

1. Step 0: git and baseline.
2. Feasibility probes, moved up:
   - Step 5's voice probe, expanded: `utilityProcess` + worker, `compute(..., false)`, DLL clash check, real-time-factor timing.
   - A read-only Chrome pipe probe from a scratch script.
3. Step 1: rename.
4. Step 2: Windows fixes.
5. Step 3: hardening, plus the store/config from step 9 and the `tools` allow-list.
6. Step 8: Electron shell, moved before the voice work. AudioWorklet, autoplay, `local-network-access` and hidden-window behaviour have to be checked in Electron; Chrome's background timer throttling makes step 6's "minimised" acceptance misleading. Include window-after-listening.
7. Step 4: Chrome fix.
8. Step 6: voice engine I.
9. Step 7: wake word.
10. Step 9: gate, with the fixes in items 1-5 and 7.
11. Step 10: speaker check.
12. Step 11: neurons.
13. Step 12: apps.
14. Step 14: corrections.
15. Step 13: Chrome neurons.
16. Step 15: teach.
17. Step 16: persona.
18. Step 17: packaging.

### Critical Files for Implementation
- C:\Users\Aswin\Downloads\Collab-main\Collab-main\collabb-main\jarvis-main\bridge\server.mjs (ask/interrupt 1398-1455, answering 1086-1087, ask() 1102-1114, query options 1193-1280, decideTool 255-291)
- C:\Users\Aswin\Downloads\Collab-main\Collab-main\collabb-main\jarvis-main\src\App.tsx (silence 96-99, respond 126-219, mode 224-237, onSpeechStart 270-290, keys 664-681)
- C:\Users\Aswin\Downloads\Collab-main\Collab-main\collabb-main\jarvis-main\src\lib\voice.ts (holdFor 169-180, isEcho 297-318, transcribe 448-505, guard barge-in 520-540)
- C:\Users\Aswin\Downloads\Collab-main\Collab-main\collabb-main\jarvis-main\src\lib\tts.ts (enqueue 355-356, cancel 709-734, ECHO_TAIL 54/122)
- C:\Users\Aswin\Downloads\Collab-main\Collab-main\collabb-main\jarvis-main\bridge\chrome.mjs (findSocket 84-105, call 245-263, activeTab/resolveTab 369-451)