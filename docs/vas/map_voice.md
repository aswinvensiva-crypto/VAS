## summary
Face/voice pipeline of jarvis-main (React 19 + Vite 8, no StrictMode: src/main.tsx:5-8). App.tsx is an event-driven state machine (phases in store.ts:3-11). You click Ignition, press Space, or clap on the offline screen (App.tsx:544-559, clap.ts). ignite() (App.tsx:349-528) then unlocks audio (needs a user gesture, App.tsx:352-354), registers the bridge watchers, waits a fixed 9.2 s boot animation (App.tsx:494), starts the mic analyser, calls probeCapabilities() (GET /health), and starts ONE long-lived voice loop with startVoice() (App.tsx:518-525).

Voice mode comes from the phase (App.tsx:224-237): offline/boot = deaf, dormant = wake, waking/listening = command, thinking/tooling/speaking = guard (barge-in).

There are two STT tiers, picked by caps().stt (voice.ts:401-402). caps().stt is true only when the bridge has an ElevenLabs key (server.mjs:685-687).
- Tier A (ElevenLabs): an energy VAD (vad.ts) records each speech segment with MediaRecorder (webm/opus) and POSTs the raw blob to bridge /stt (voice.ts:448-505). The bridge forwards it to ElevenLabs Scribe with ONLY model_id=scribe_v1 plus the file (server.mjs:938-950). No language, keyterms, or biasing.
- Tier B: browser webkitSpeechRecognition with lang hard-coded to 'en-GB' (voice.ts:763), continuous + interim results, only the top alternative (voice.ts:697), a 900 ms silence endpoint (voice.ts:683), and a 15 s heartbeat restart (voice.ts:798-814).

Both tiers share the same post-processing:
- isEcho bag-of-words self-echo filter against what TTS is currently saying (voice.ts:297-318, tts.ts:136-139).
- WAKE regex in wake mode (voice.ts:80-81). The wake word is text matching on transcripts, NOT Porcupine.
- makeAssembler, which merges segments into turns using English function-word heuristics (voice.ts:125-251).
- App.onUtterance then strips a bare or leading name (App.tsx:66-70, 292-309) and calls respond() -> brain.ask() (App.tsx:126-219).

@picovoice/porcupine-web is a dead dependency. config.ts reads VITE_PICOVOICE_ACCESS_KEY (config.ts:136) and exports WAKE_ENGINE (config.ts:158-160), but nothing imports it.

TTS (tts.ts) splits streamed text into sentences and runs one queue, generating one sentence ahead. Engine order: ElevenLabs via bridge /tts when caps().tts or VITE_USE_ELEVENLABS is set, otherwise Kokoro (WebGPU ONNX) if VITE_TTS_ENGINE=kokoro, otherwise speechSynthesis. A failed cloud or Kokoro call falls back to speechSynthesis. If the OS voice produces no sound, a latch switches everything to the cloud voice.

bridge.ts keeps one WebSocket (default ws://localhost:8787). The socket IS the Claude Agent SDK session (server.mjs:1193-1280). Turn frames text/tool/done/error are tagged with the ask id. Panel/blade/ui frames and capture requests come through the dispatcher outside any turn.

Direct mode (VITE_BACKEND=direct) calls the Anthropic Messages API from the browser with a bundled API key, remote MCP servers only, and keeps history client-side. Personalization today: none. There is no user profile, no vocabulary, no per-mic VAD calibration, and no persisted settings except the chosen TTS voice name in localStorage (tts.ts:165, 232-263).

## extension_points
PERSONALIZATION ("understand my voice better"): every hook, in pipeline order.
1. Mic capture. audio.ts:14-20 has getUserMedia constraints with no deviceId. Add a chosen mic deviceId and optionally turn autoGainControl off. AGC fights the energy VAD.
2. VAD calibration. vad.ts:57-85 holds the constants and vad.ts:134 the initial floor. Add a calibrate() that records 3 s of room tone plus a sample phrase, then derives floor and TRIGGER_OVER_FLOOR. Persist the result (localStorage, or an Electron userData JSON) and pass it into startVad(h, opts) (vad.ts:102). meter() at vad.ts:271 already exposes energy/floor/threshold. Show them in Diagnostics.tsx:21-33/106-120.
3. Scribe request (bridge). server.mjs:938-944 sends only model_id and file. Add language_code (e.g. 'en'), keyterm/vocabulary biasing if the chosen Scribe model supports it, and tag_audio_events=false. CAUTION: the route check is a strict `req.url === '/stt'` (server.mjs:894). Any client query string (?lang=, ?mode=wake) gets a 404 unless it changes to a startsWith + URL parse. Same pattern for /tts at 809.
4. Client STT call. voice.ts:453-457 sends only content-type. A header or query could carry mode (wake vs command) so the bridge can bias toward the wake word in wake mode.
5. Transcript normalization (the single best insertion point). voice.ts:465-466 (`const said = ...`) in the ElevenLabs tier and voice.ts:650 / 697-701 in the browser tier. Run a user phrase-correction map here (misheard -> intended, e.g. app names, contact names, 'bass'->'VAS'), before isEcho (476/654) and WAKE (484/662/710).
6. Browser tier. voice.ts:763 hard-codes rec.lang='en-GB'. Make it configurable (e.g. 'en-IN'). Set rec.maxAlternatives and re-score alternatives against the vocabulary (voice.ts:697 reads only [0]). Newer Chrome contextual-biasing APIs could also go in spin() (758-792).
7. Wake aliases. The WAKE regex (voice.ts:80-81), the OVERRIDE regex (voice.ts:269-270), and the duplicate NAME/BARE_NAME/LEADING_NAME (App.tsx:66-70) should come from ONE config list, e.g. VAS aliases. Near-misses are already recorded via drop(`heard "..." — not his name`) (voice.ts:492, 669). That is a ready-made feedback source for learning new aliases.
8. Turn assembly. CONTINUES/STOP/holdFor and SETTLE/CONTINUE/MAX_HOLD (voice.ts:125-180, 155-163, 281-288) are English and fixed. Expose them as per-user pause tolerance.
9. Final utterance hook. App.onUtterance (App.tsx:292-309) and respond() (App.tsx:126). Detect corrections ('no, I said X') here and write them to the correction map. Here you can also attach n-best or recent mishearings as context to the prompt.
10. LLM-side correction. The bridge SYSTEM_PROMPT (server.mjs:293+) can take a 'user profile + vocabulary + known mishearings' block so Claude repairs ASR errors semantically. Cheapest win.
11. Local STT alternative. Add a whisper/faster-whisper path behind the same /stt contract (server.mjs:894-962) and report it via /health (server.mjs:685-687 -> capabilities.ts:59-60). voice.ts:401-402 then picks the VAD tier with no keys. That also fixes the Electron SpeechRecognition problem.

NEW FACE<->BRIDGE CAPABILITIES (e.g. permission prompts for opening Windows apps, a Chrome-info result view):
- Push-only UI frame. Add the field to Frame (bridge.ts:21-38), add an else-if in dispatch() (bridge.ts:171-210), add a watchX() in bridge.ts (pattern 98-101) plus a brain.ts wrapper (pattern 68-70), and register it in App.ignite (App.tsx:364-463). The bridge emits via send({type:...}) inside the per-connection closure (server.mjs:1072-1074, 1200-1217).
- Request/response (voice or on-screen confirmation before opening an app, etc.). Reuse the capture pattern. Bridge side: ask(kind,args,timeoutMs) (server.mjs:1102-1114) and the reply resolver (server.mjs:1434-1441). Client side: the dispatch branch with reply({...}) (bridge.ts:184-205). A 'confirm' kind would show a panel or HUD prompt and speak the question. App.onUtterance (App.tsx:292) would then route the next yes/no to the reply instead of respond(), possibly with a 'confirm' VoiceMode added to mode() (App.tsx:224-237).
- Display results. Existing in-process MCP servers push panels and blades (server.mjs:1202-1205, store.pushPanel/pushBlade store.ts:299-328). A new Chrome/Kalliope neuron result can reuse the display/blade tools rather than inventing new frames.
- Filler phrasing for new tools. Add a Rule to BY_TOOL (fillers.ts:96-163). Note that announceTool hides mcp__jarvis__display and mcp__jarvis_ui__* (server.mjs:1177-1181).
- Capability flags. Extend /health JSON (server.mjs:687) and Capabilities (capabilities.ts:20-25).
- Persisted user settings. Only localStorage 'jarvis.voice' exists (tts.ts:165, 232-263). Use localStorage the same way, or in Electron a preload IPC to a JSON file in app.getPath('userData').
- TTS voice for the user's locale. Extend score() (tts.ts:176-205), which today only knows macOS/Chrome names (Daniel, Google UK English Male, ...). Windows voices (Microsoft David/Zira/Mark/Hazel/George, Ravi/Heera en-IN) never pass USABLE=40 (tts.ts:209).

## windows_and_desktop_issues
WINDOWS 11 (as is):
- package.json:18 `"bridge:writes": "JARVIS_ALLOW_WRITES=1 node bridge/server.mjs"` uses POSIX inline-env syntax and fails in cmd/PowerShell. Use `npm start -- --writes` (start.mjs:47,108) or cross-env.
- start.mjs:117 spawn('node', ..., {shell:false}) works because node.exe is on PATH. Vite is spawned with process.execPath (120). OK. c.kill('SIGTERM') becomes a hard kill on Windows (fine).
- Local-image rendering is broken on Windows. DISK_PATH is POSIX-only: /Users|home|tmp|... in sanitise.ts:21-22, Blades.tsx:45-46, Orbits.tsx:33-34. Paths like C:\Users\Aswin\AppData\Local\Temp\x.png or file:///C:/... are never rewritten to the bridge /file route, so panels and orbits show broken images. Add a drive-letter pattern (^[A-Za-z]:[\\/] and ^/[A-Za-z]:/).
- FILE_ROOTS includes '/tmp' (server.mjs:488), which resolves to C:\tmp. Harmless. homedir() + tmpdir() are correct.
- No .env.example or .env.local exists in this checkout, though config.ts:5 and README.md:220-221 reference them. The bridge reads process.env directly with no dotenv (server.mjs:31,58-64,99,105,122,449,460,489), so Windows users must set vars in PowerShell ($env:X='1') or via the launcher.
- TTS voice ranking: Windows voices don't match score() (tts.ts:176-205), so candidateVoices() is empty and pickVoice falls back to the first English voice (tts.ts:239). V-key cycling returns 'default' (tts.ts:257-258).
- Changing JARVIS_BRIDGE_PORT breaks the face. The CSP hard-codes :8787 in connect-src for http (index.html:59), so /health, /stt and /tts fetches are blocked. It also hard-codes :8787 in img-src/media-src/frame-src (54-61).

ELECTRON:
1. SpeechRecognition. Electron exposes webkitSpeechRecognition, but it has no Google speech-service key, so sessions fail (typically error 'network'). voice.ts:771-778 only treats not-allowed/service-not-allowed as fatal. Every other error falls to onend -> respin after 80 ms (voice.ts:779-785): a silent infinite restart loop with diag.lastError='network'. The keyless tier is effectively dead in Electron. Requires ElevenLabs (caps().stt) or a new local STT behind /stt.
2. Mic/camera permissions. Need session.setPermissionRequestHandler / setPermissionCheckHandler granting 'media' for getUserMedia (audio.ts:14, camera.ts:69). Windows Settings > Privacy > Microphone/Camera > 'Let desktop apps access' must be on. Errors surface as the NotAllowedError text at voice.ts:394-398 and vad.ts:107-111.
3. Background throttling. VAD (vad.ts:203-205), clap (clap.ts:99-101) and the level pumps all run on requestAnimationFrame. rAF stops when the window is minimized, hidden or occluded, so VAS goes deaf in the tray or behind Chrome. That already happens today when the Chrome tab is in the background. Set webPreferences.backgroundThrottling=false and preferably move the VAD tick into an AudioWorklet or setInterval. Same issue for a tray-only app.
4. Autoplay/gesture. ignite() needs a click (App.tsx:352-354, Ignition). Set webPreferences.autoplayPolicy='no-user-gesture-required' so it can auto-boot at login. The 9.2 s boot animation (App.tsx:494) runs on every launch.
5. Origin gate. originAllowed() accepts only http://localhost|127.0.0.1|[::1] on ports 5173-5199/4173-4199 (server.mjs:74-89). A file:// page (Origin 'file://' or 'null') or a custom app:// scheme is refused for both WS (server.mjs:991-997) and HTTP /health, /stt, /tts (server.mjs:666-671). Fixes: (a) serve the renderer from http://localhost on a port in 4173-4199 (or Vite dev 5173 in development); (b) set JARVIS_ALLOWED_ORIGINS to the exact origin string. It is compared raw with trailing slashes stripped, before URL parsing (server.mjs:79), so 'app://vas' or 'null' would match. (c) Or add an explicit Electron origin rule.
6. file:// asset paths. vite.config.ts sets no `base`, so the build emits absolute /assets/... (broken under file://). Other absolute paths break too: hands.ts:40 WASM_BASE='/mediapipe', music.ts:86 and sfx.ts:87 '/audio/*.mp3', index.html:69 '/src/main.tsx' in dev. Module scripts from file:// can also hit CORS. Prefer a localhost static server or a privileged custom protocol (registerSchemesAsPrivileged standard+secure+supportFetchAPI) over file://.
7. MediaPipe. The WASM must exist in public/mediapipe. Only scripts/start.mjs:33-45 copies it, so an Electron build script must do the same. Weights are fetched from storage.googleapis.com (hands.ts:48-49) and need a network connection.
8. Kokoro / transformers.js. The default onnxruntime wasmPaths is the jsdelivr CDN (node_modules/@huggingface/transformers/dist/transformers.web.js: `wasmPaths = https://cdn.jsdelivr.net/npm/@huggingface/transformers@.../dist/`). The CSP script-src has no https: (index.html:56), so a dynamically imported ort .mjs from the CDN may be blocked. Kokoro then silently falls back to the system voice (kokoro.ts:99-103). The Cache API may not persist the 86 MB model under non-http schemes. Kokoro is not the default (config.ts:110-115).
9. CSP itself. connect-src already allows ws: and https: (index.html:59), so ws://localhost:8787 is fine in Electron. Porcupine is unused, so there are no worker/wasm path issues from it. If it were enabled, worker-src blob: and 'wasm-unsafe-eval' are already present (index.html:56,60).
10. Secure context. Fine on http://localhost or a secure custom scheme. crypto.randomUUID has a fallback (App.tsx:60-62).
11. The renderer is a normal Chromium page, so MediaRecorder webm/opus (vad.ts:87-100) and speechSynthesis (Windows OneCore/SAPI voices) work in Electron.
12. Direct mode bundles VITE_ANTHROPIC_API_KEY into the renderer (anthropic.ts:10-13, config.ts:132). Do not use it in a distributed desktop app. The user has a Claude Code login, so stay on bridge mode.

## jarvis_branding
WAKE WORD / RECOGNITION (functional, must change for 'VAS'):
- WAKE regex aliases jarvis|jarvys|jervis|jarvis's|travis|jarviss|java's|jarv (src/lib/voice.ts:80-81)
- OVERRIDE regex includes 'jarvis' (voice.ts:270)
- NAME/BARE_NAME/LEADING_NAME (src/App.tsx:66-70)
- Error text 'not his name' (voice.ts:492, 669)
- Note: 'VAS' is short and collides with common words ('was', 'vast', 'bus', 'fast'), so plan a mandatory 'hey VAS' prefix and a learned alias list.

PERSONA / PROMPTS:
- Bridge SYSTEM_PROMPT 'You are JARVIS...' with heavy 'sir' rules (bridge/server.mjs:293-~440)
- Direct SYSTEM_PROMPT 'You are JARVIS, Tony Stark's assistant' (src/config.ts:279-304)
- Filler lines with 'sir' (src/lib/fillers.ts:21-49)
- shape() inserts the comma before 'sir' (src/lib/tts.ts:326)
- Spoken strings: T audio test (App.tsx:641), V voice demo (App.tsx:599), 'that turn was lost, sir' (bridge.ts:401), anthropic.ts lines 144/154
- Read-only deny message 'JARVIS is running in read-only mode' (server.mjs:1273-1276)

UI TEXT:
- index.html:65 <title>J.A.R.V.I.S.</title>
- src/ui/Hud.tsx:13 'STANDBY — SAY “HEY JARVIS”', Hud.tsx:193 brand-mark 'J.A.R.V.I.S.', Hud.tsx:276 log label 'JARVIS', Hud.tsx:315 'say “hey jarvis”'
- src/ui/Suggestions.tsx:55 '“hey jarvis, …”'
- src/ui/Boot.tsx:149 'J.A.R.V.I.S'
- store.ts Turn role 'jarvis' (store.ts:57), used in App.tsx:160 and Hud.tsx:276-281 (internal identifier)

ENV VARS (bridge): JARVIS_BRIDGE_PORT (server.mjs:31), JARVIS_ALLOWED_ORIGINS (59), JARVIS_ALLOW_NO_ORIGIN (64), JARVIS_ALLOW_WRITES (99), JARVIS_MODEL (105), JARVIS_EFFORT (122), JARVIS_VOICE_ID (460), JARVIS_FILE_ROOTS (489), JARVIS_DEBUG (1286); also scripts/start.mjs:108-110 and package.json:18. Frontend VITE_* vars carry no JARVIS prefix (config.ts).

INTERNAL IDS (rename consistently or leave):
- MCP server keys jarvis, jarvis_ui, jarvis_chrome, jarvis_eyes (server.mjs:1202-1216), referenced in decideTool (server.mjs:266-280) and announceTool 'mcp__jarvis__display' / 'mcp__jarvis_ui__' (server.mjs:1177-1181). Tool names the model sees change if these are renamed.
- localStorage key 'jarvis.voice' (tts.ts:165)
- window.__jarvis dev proxy (store.ts:455)
- postMessage {jarvis:'scroll'} (src/ui/Blades.tsx:278); its listener is presumably in bridge/page.mjs, so rename both together
- Console prefixes '[jarvis]' throughout (config.ts:34,45; tts.ts:450,549,560,571; kokoro.ts:56,100,128,136; App.tsx:337,449,507; server.mjs many)

PACKAGE / LAUNCHER: package.json:2 name 'jarvis' and :5 description; scripts/start.mjs:116 'J.A.R.V.I.S. starting', 123-124 'say "Hey Jarvis"'; README.md (28 hits); project folder name jarvis-main. Grep counts: 243 case-insensitive hits across 42 non-node_modules files.

## open_questions
1. Which ElevenLabs Scribe model/version the user's key can use, and whether it accepts keyterm or vocabulary biasing. The code only sends model_id=scribe_v1 (server.mjs:939). Check the current ElevenLabs STT API for language_code, keyterms, and scribe_v2 availability before relying on biasing.
2. Does the user even have an ElevenLabs key? Without one the bridge reports stt:false (server.mjs:685-687). In Electron the browser fallback is effectively non-functional, so a no-key setup needs a local STT engine (whisper.cpp / faster-whisper; Python 3.14 wheel availability for ctranslate2/torch is uncertain) or Porcupine/openWakeWord plus a local recogniser.
3. The user's language and accent ("Aswin" suggests Indian English, possibly mixed Tamil/Malayalam/Hindi). This decides rec.lang (voice.ts:763, currently en-GB), Scribe language_code, and TTS voice choice. Ask the user.
4. Wake word. Should 'VAS' be wake-by-transcript (current approach; in the ElevenLabs tier it uploads every dormant VAD segment to Scribe, voice.ts:484-495) or a real on-device wake engine? The bundled @picovoice/porcupine-web is unused. A custom 'Hey VAS' keyword would need a Picovoice-trained .ppn and an access key. Kalliope has its own trigger (Porcupine-based), which may be the intended path if Kalliope is integrated.
5. Whether Electron should embed the bridge in the main process or spawn bridge/server.mjs as a child. Also which origin the renderer will have (localhost port vs custom scheme). This determines the originAllowed / JARVIS_ALLOWED_ORIGINS change (server.mjs:77-89).
6. Whether bridge/page.mjs listens for the {jarvis:'scroll'} postMessage (Blades.tsx:278). Not verified; matters only for renaming.
7. Whether Electron's backgroundThrottling=false keeps requestAnimationFrame firing while minimized on Windows. Not verified. Moving the VAD to an AudioWorklet avoids the question.
8. Whether Kokoro actually works under the current CSP, given transformers.js loads onnxruntime from jsdelivr by default. Not tested; only relevant if VITE_TTS_ENGINE=kokoro.
9. How Kalliope 'neurons' should talk to this face. Over the bridge as an MCP tool, as a new WS frame, or as Kalliope calling the bridge HTTP API? This is outside the face code examined here.

## key_files
### C:\Users\Aswin\Downloads\Collab-main\Collab-main\collabb-main\jarvis-main\src\lib\voice.ts
Voice loop: engine selection, wake-word matching, echo rejection, utterance assembly, both STT tiers
VoiceMode (27-35) wake/command/guard/deaf; VoiceHandlers (37-52) onWake/onSpeechStart/onPartial/onUtterance/onError; WAKE_DEBOUNCE=1500 (65); WAKE regex (80-81) /\b(?:hey|hi|ok|okay|yo)?\s*(?:jarvis|jarvys|jervis|jarvis's|travis|jarviss|java's|jarv)\b(?!'s)/i, the only wake mechanism; afterWake() (84-91) returns the text after the wake word as the inline command; CONTINUES function-word regex (125-126), TRAILS (129); SELF_GUARD_MS=350 (143); SETTLE_MS=250, CONTINUE_MS=1600, MAX_HOLD_MS=6000 (155-163); holdFor() (169-180); makeAssembler() (192-251); norm() (257-262); OVERRIDE regex incl. 'jarvis' (269-270); STOP word set (281-288); isEcho() (297-318); diag published as window.__voice (334-374); drop() records why a transcript was ignored, e.g. 'heard "..." — not his name' (492, 669); startVoice() (389-403) opens the mic via getMic and picks the tier from caps().stt; startElevenVoice() (406-586): pendingAudio queue plus single-flight drain (423-518), transcribe() POSTs the blob to `${BRIDGE_HTTP_URL}/stt` with only a content-type header (448-457), reads {text} (465-466), runs the echo check (476), wake check (484-495), assemble.feed (499); VAD onStart barge-in (520-540); guardPoll 200ms setGuard (567-575); startBrowserVoice() (602-831): Ctor = window.SpeechRecognition ?? webkitSpeechRecognition (603-608), 900ms silence emit (679-684), onResult takes only e.results[i][0] (686-756), spin() sets continuous/interimResults/lang='en-GB' (758-792), onerror handles only not-allowed/service-not-allowed (771-778), onend respins after 80ms (779-785), heartbeat 15s idle -> abort and respin (798-814)

### C:\Users\Aswin\Downloads\Collab-main\Collab-main\collabb-main\jarvis-main\src\lib\vad.ts
Energy-based VAD and segment recorder for the ElevenLabs tier
TRIGGER_OVER_FLOOR=2.6 (57); GUARD_BOOST=2.4 (59); RELEASE_RATIO=0.6 (62); START_MS=110 (65); SILENCE_MS=650 (78); MAX_MS=20000 (80); FLOOR_UP=0.0008 / FLOOR_DOWN=0.02 (84-85); pickMime() webm/opus->webm->ogg->mp4 (87-100); startVad() (102-273): new AudioContext + AnalyserNode fftSize 1024 (121-130), initial floor 0.01 (134), rms() (147-152), startRecorder pre-roll on onset (154-165), tick() runs on requestAnimationFrame (203-251), floor adapts only when idle (211-216, min 0.0015), threshold = floor*2.6*(guard?2.4:1) (218), confirm after 110ms -> onStart (230-236), end after 650ms of quiet (242-250); returns stop/setGuard/live/meter (255-272). No persistence, no calibration routine, no device selection

### C:\Users\Aswin\Downloads\Collab-main\Collab-main\collabb-main\jarvis-main\src\lib\audio.ts
Single shared getUserMedia stream plus a level analyser
getMic() (12-22) getUserMedia({audio:{echoCancellation,noiseSuppression,autoGainControl: true}}), no deviceId; startAnalyser() (24-34); micLevel() (37-46); attachOutputAnalyser() (49-64)

### C:\Users\Aswin\Downloads\Collab-main\Collab-main\collabb-main\jarvis-main\src\lib\capabilities.ts
Boot-time probe that decides the STT/TTS tier
Capabilities {stt,tts} (20-25); caps() (33-35); probeCapabilities() (47-68): direct mode -> browser only (48-53), otherwise GET `${BRIDGE_HTTP_URL}/health` with a 3s timeout (55-61), failure keeps the browser tier; engineLabel() (71-78)

### C:\Users\Aswin\Downloads\Collab-main\Collab-main\collabb-main\jarvis-main\src\lib\tts.ts
Streaming sentence-chunked speech output with three engines and fallbacks; tracks what is being spoken for echo rejection
Speaker type push/say/end/cancel/level (30-42); ECHO_TAIL_MS=1800 (54); diag -> window.__tts (64-94); nativeBroken latch (104); speakingSince() (110-112); speakingNow() (136-139); SENTENCE_END (147), ABBREVIATION (151-152), MAX_UNSPOKEN=220 (159); VOICE_PREF_KEY='jarvis.voice' (165); score() ranks macOS/Chrome British male voice names (176-205); USABLE=40 (209); candidateVoices() (212-220); pickVoice() falls back to the first en voice (224-241); currentVoiceName() (246-252); cycleVoice() (256-265); shared outputContext() (288-298); shape() strips markdown/URLs and adds the comma before 'sir' (310-330); createSpeaker() (338-737): synthesise() picks the tier (375-396), pump() one-ahead priming (403-424), speakOne() fallback/rescue (426-460), speakNative rate 0.92 pitch 0.95 lang en-GB, 700ms+1500ms watchdog, 5s pause/resume keepalive (462-582), playUrl via <audio> + analyser (584-658); fetchCloudAudio() bridge /tts first, then direct ElevenLabs with VITE_ELEVENLABS_API_KEY, eleven_flash_v2_5 (741-784)

### C:\Users\Aswin\Downloads\Collab-main\Collab-main\collabb-main\jarvis-main\src\lib\kokoro.ts
Optional in-browser neural TTS (kokoro-js / transformers.js, WebGPU)
VOICES bm_george/bm_fable/bm_lewis/bm_daniel (45); resolveVoice() (53-59); MAX_FAILURES=3 (69); load() KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX',{dtype:'q8',device:'webgpu'}) (72-110); speak() speed 0.95 -> blob URL (113-141); availableVoices() (144-147)

### C:\Users\Aswin\Downloads\Collab-main\Collab-main\collabb-main\jarvis-main\src\lib\bridge.ts
WebSocket client for the bridge: turns, interrupts, out-of-band panels/blades/ui, capture request/reply
Frame type (21-38); watchServers (53-55), watchPanels (60-62), CaptureRequest/Result (71-79), watchCapture (82-84), watchBlades (89-91), watchUi (98-101), ConnectionState open/lost/reconnected (111-115), isConnected (117-119); RECONNECT_DELAYS [500,1000,2000,4000,8000,8000] (142), scheduleReconnect (146-154); dispatch() handles ready/panel/blade/capture(->reply)/ui (162-212); connect() new WebSocket(BRIDGE_WS_URL), 6s timeout (214-288), error message mentions allowed ports 5173-5199/4173-4199 (266-273), onclose -> 'lost' + reconnect (275-284); warmBridge() (291-299); IDLE_TIMEOUT_MS=120000 (311); ask() supersedes the in-flight turn, sends {type:'ask',text,id}, filters frames by msg.ask id, handles text/tool/done/error (316-476); cancel() sends {type:'interrupt'} (486-491); prettyToolName mcp__a__b -> 'a · b' (499-503)

### C:\Users\Aswin\Downloads\Collab-main\Collab-main\collabb-main\jarvis-main\src\lib\brain.ts
Backend switch between bridge and direct
usingBridge (23); ask(prompt, history, handlers) (27-35); warm (37-39); watchServers/Panels/Blades/Ui/Capture/Connection are no-ops in direct mode (43-85, 122-126); cancel (93-96); connectedLabels (129-131)

### C:\Users\Aswin\Downloads\Collab-main\Collab-main\collabb-main\jarvis-main\src\lib\anthropic.ts
Direct mode: browser calls the Claude Messages API
client = new Anthropic({apiKey: env.anthropicKey, dangerouslyAllowBrowser:true}) (10-13); AskHandlers onText/onTool (17-22); MAX_CONTINUATIONS=3 (38); ask() betas mcp-client-2025-11-20 + fast-mode, model MODEL, thinking adaptive, effort low, mcp_servers from activeServers(), tools web_search_20260209 + mcp_toolset (48-86), streaming text + mcp_tool_use/server_tool_use detection (99-120), pause_turn/refusal/max_tokens handling (135-159); cancel() aborts the stream (170-173); connectedLabels (183-185)

### C:\Users\Aswin\Downloads\Collab-main\Collab-main\collabb-main\jarvis-main\src\lib\clap.ts
Clap detector, used only on the offline/ignition screen to power on (not a wake word)
PEAK_OVER_FLOOR=7, MIN_PEAK=0.055, QUIET_BEFORE=0.16, DECAY_TO=0.35, DECAY_MS=130, GIVE_UP_MS=260, COOLDOWN_MS=1200 (21-40); diag -> window.__clap (44-53); listenForClap() own AudioContext + rAF tick (63-167)

### C:\Users\Aswin\Downloads\Collab-main\Collab-main\collabb-main\jarvis-main\src\lib\fillers.ts
Persona filler lines and tool-name -> phrase mapping
WORKING (21-30), ACKNOWLEDGE (33-40), ATTENTION 'Yes, sir?' etc. (43-49); makePicker (55-64); BY_TOOL rules incl. server /playwright|puppeteer|browserbase|chrome/ -> 'Opening the browser.' (96-163, chrome rule 108-112); split() parses both raw and prettified names (177-187); forTool() (190-201)

### C:\Users\Aswin\Downloads\Collab-main\Collab-main\collabb-main\jarvis-main\src\App.tsx
Conversation state machine, boot, watcher wiring, keyboard controls
AWAIT_SPEECH_MS=14000 (51), FOLLOW_UP_MS=11000 (56); NAME/BARE_NAME/LEADING_NAME regexes duplicating the wake aliases (66-70); goDormant (101-112); listen (115-122); respond(said) -> ask(said, history, {onText,onTool}), direct history capped at 16 (126-219); mode() phase->VoiceMode (224-237); onWake (239-264); onSpeechStart barge-in (270-290); onUtterance strips the name then respond (292-309), which is the last hook before the brain; ignite(): sfx.unlockAudio (354), watchServers/Panels/Blades (364-366), watchCapture camera handler (376-422), watchUi ops patch/orbit/effect/reset/screen (427-451), watchConnection (455-463), kokoro preload (476-488), 9.2s boot wait (494), startAnalyser (503-510), probeCapabilities (515), startVoice (518-525); clap-to-start effect (544-559); keys V voice cycle (586-602), G hands (607-630), T audio test (636-652), Escape (656-660), Space (664-681)

### C:\Users\Aswin\Downloads\Collab-main\Collab-main\collabb-main\jarvis-main\src\config.ts
Vite env parsing and constants
str() treats blank as unset (15-18); choice() (24-37); flag() (40-47); BACKEND 'bridge'|'direct' default bridge (61-66); BRIDGE_WS_URL = VITE_BRIDGE_URL ?? 'ws://localhost:8787', BRIDGE_HTTP_URL ws->http (74-75); USE_ELEVENLABS (88-92); TTS_ENGINE 'system'|'kokoro' (110-115); KOKORO_VOICE (124-129); env {anthropicKey, elevenKey, elevenVoiceId, porcupineKey} (131-137); MODEL='claude-opus-5' (141); FAST_MODE=true (148); WAKE_ENGINE (158-160), unused anywhere; MCP_SERVERS remote list for direct mode (198-270); SYSTEM_PROMPT for direct mode 'You are JARVIS, Tony Stark's assistant' (279-304)

### C:\Users\Aswin\Downloads\Collab-main\Collab-main\collabb-main\jarvis-main\src\store.ts
Zustand store: phases, panels, blades, transcript, UI override layer
Phase (3-11); Panel (19-27); Blade (39-53); Turn role 'user'|'jarvis' (55-61); OrbitObject (71-91); UiEffect (101-105); UiState/UI_DEFAULTS (116-152); UiPatch (160-166); useStore actions pushPanel (299-309), clearPanels (312-313), pushBlade (321-328), applyUi deep-merge (370-380), addOrbit (385-392), fireEffect (396-397), resetUi (398), clearScreen (403-415); phaseColor (419-428); window.__jarvis dev proxy (450-464)

### C:\Users\Aswin\Downloads\Collab-main\Collab-main\collabb-main\jarvis-main\index.html
CSP meta and title
CSP (48-63): default-src 'self'; frame-src youtube/vimeo + http://localhost:8787 + 127.0.0.1:8787 (54); img-src/media-src 'self' data: blob: + localhost:8787 only (55, 61); script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob: (56); connect-src 'self' data: blob: https: ws: wss: http://localhost:8787 http://127.0.0.1:8787 (59); worker-src 'self' blob: (60); <title>J.A.R.V.I.S.</title> (65); module entry /src/main.tsx (69)

### C:\Users\Aswin\Downloads\Collab-main\Collab-main\collabb-main\jarvis-main\vite.config.ts
Vite config
port = PORT || 5173 (11); optimizeDeps.exclude kokoro-js, phonemizer, @huggingface/transformers (20). No `base` set, so built asset URLs are absolute '/assets/...'

### C:\Users\Aswin\Downloads\Collab-main\Collab-main\collabb-main\jarvis-main\bridge\server.mjs
(Bridge side of the face contract) HTTP speech proxy, origin gate, WS session
PORT=JARVIS_BRIDGE_PORT ?? 8787 (31); EXTRA_ORIGINS/ALLOW_NO_ORIGIN (58-64); isDevPort 5173-5199|4173-4199 (74-75); originAllowed() requires http: + localhost + dev port unless the exact string is in JARVIS_ALLOWED_ORIGINS (77-89); SYSTEM_PROMPT 'You are JARVIS...' (293+); elevenKey() from ELEVENLABS_API_KEY or ~/.claude.json mcpServers.elevenlabs.env (448-458); VOICE_ID (460); GET /health -> {ok,tts,stt} (679-688); POST /tts eleven_flash_v2_5 stream (809-885); POST /stt strict `req.url === '/stt'` (894), <1200 bytes -> empty text (922-925), FormData model_id='scribe_v1' + file only (938-944), POST api.elevenlabs.io/v1/speech-to-text (946-957); WS verifyClient path '/' or '/ws' + origin (985-1000); per-connection ready frame (1047-1049); ask(kind,args) request/reply helper (1102-1114); mcpServers jarvis/jarvis_ui/jarvis_chrome/jarvis_eyes (1200-1217); stream pump text/tool/done/error/ready (1283-1396); inbound ask/reply/interrupt (1398-1455)

### C:\Users\Aswin\Downloads\Collab-main\Collab-main\collabb-main\jarvis-main\scripts\start.mjs
npm start launcher: bridge + vite, vendors the mediapipe wasm
vendorWasm() copies node_modules/@mediapipe/tasks-vision/wasm -> public/mediapipe (33-45); --writes -> JARVIS_ALLOW_WRITES=1 (47, 108); PORT -> JARVIS_ALLOWED_ORIGINS (107-112); spawn bridge 'node' (117) and vite via process.execPath (120)

### C:\Users\Aswin\Downloads\Collab-main\Collab-main\collabb-main\jarvis-main\src\ui\Diagnostics.tsx
D-key diagnostics panel reading window.__voice / window.__tts
VoiceDiag fields (21-33), with no VAD energy/floor/threshold even though vad.meter() exists; verdicts earsOk/mouthOk (90-91)

### C:\Users\Aswin\Downloads\Collab-main\Collab-main\collabb-main\jarvis-main\src\ui\sanitise.ts
Panel HTML sanitiser and media URL rewriting to the bridge
DISK_PATH POSIX-only regex (21-22), mirrored in Blades.tsx:45-46 and Orbits.tsx:33-34; rewriteSrc -> /file, /img, /media (44-58)

### C:\Users\Aswin\Downloads\Collab-main\Collab-main\collabb-main\jarvis-main\src\lib\hands.ts
MediaPipe hand tracking (G key)
WASM_BASE='/mediapipe' absolute path (40); MODEL_URL remote storage.googleapis.com hand_landmarker.task (48-49); FilesetResolver.forVisionTasks(WASM_BASE) GPU then CPU (571-588)

