## summary
I checked every claim below against the code, with file:line citations. Kalliope (C:\Users\Aswin\Downloads\kalliope-master\kalliope-master, version 0.x, no .git folder, and not inside Collab-main) is a Linux-only Python framework. Its parts are a trigger (snowboy wake word), an order signal (a state machine that runs trigger -> STT -> OrderAnalyser), the brain (a YAML list of synapses = signals + neurons), neurons (one Python class per action), hooks (lifecycle events that run synapses), Cortex (short-term key/value memory), a LIFO buffer (runs synapses and handles waiting for an answer) and a Flask REST API.

Neuron model: a neuron is a class that subclasses NeuronModule and does all its work inside __init__(**kwargs). It speaks through self.say(dict | str | list). A dict is rendered with Jinja through the synapse's say_template or file_template. The spoken text goes back to API callers as generated_message (NeuronModule.serialize). Neurons are found by naming convention, with no registry. The module is kalliope.neurons.<name>.<name>, or <resource_directory.neuron>/<name>/<name>.py loaded with imp.load_source. The class name must equal name.capitalize(), so a neuron called vas_brain needs class Vas_brain. Every neuron named in brain.yml is imported when the brain loads, as a validation step.

Matching: OrderAnalyser lowercases the order. It applies per-signal stt-correction (plain substring replacement). It supports four match types: normal (a bag of words; extra words allowed), strict (same word count), ordered-strict (exact word sequence) and not-contain (normal plus excluded-words). Every synapse that matches runs, not just the first one. {{ var }} captures are filled by NeuronParameterLoader using the next literal word as the stop word.

Catch-all: there is no "default_synapse" setting. The real mechanism is hooks.on_order_not_found. It runs a named synapse in a new LIFO but passes no parameters, so the neuron must read the text from Cortex memory key kalliope_last_order (template: {{ kalliope_memory['kalliope_last_order'] }}). That key is saved before matching on the voice path (order.py:184). It is saved after matching on the REST path (synapses_views.py:259 then :264), so REST orders would forward the previous order. This is a real bug. A second option is a synapse whose order is just "{{ query }}". With normal matching it matches every sentence, but it also runs alongside any specific match.

Voice: STT goes through the SpeechRecognition library (google, wit, bing, apiai, houndify, cmusphinx). The only settings are language, a key, cmusphinx keyword_entries/grammar, and the microphone energy/timeout options. There is no training, adaptation or learning. The only personalization is the hand-written stt-correction dictionaries and a snowboy personal hotword model (.pmdl).

Windows 11 + Python 3.14 verdict: Kalliope cannot run natively. The package fails at import ('imp' was removed in 3.12; checked on the user's Python 3.14.2). Other blockers are audioop (removed in 3.13), pyalsaaudio/ansible in install_requires, Linux-only snowboy .so files for Python 3.6-3.9, cffi dlopen(None) in OrderListener, and /usr/bin players and TTS.

WSL2 is possible but fragile. Only the docker-desktop distro is installed. It would need Ubuntu, Python 3.9 and microphone audio over WSLg. Recommendation: reuse Kalliope's concepts (neuron plugin contract, order matching for fast local commands, stt-correction lexicon, hook names, neurotransmitter-style yes/no confirmation, kill_switch, brain enable/disable) by porting them into VAS/jarvis-main in Node, rather than running Kalliope. If the user really wants a Kalliope neuron, it is a small file: vas_brain/vas_brain.py talking to the bridge WebSocket ({type:'ask', text}). Or add a POST /ask endpoint to the bridge and reuse the core uri neuron.

## extension_points
A. HOW TO ADD A KALLIOPE NEURON (if the user wants it in Kalliope itself)
1. Folder: <resource_directory.neuron>/vas_brain/ containing __init__.py ('from .vas_brain import Vas_brain'), vas_brain.py, dna.yml, install.yml, README.md, tests/.
   - The class name must be exactly name.capitalize() = 'Vas_brain' (Utils.py:135-136, ConfigurationChecker.py:150-151). Existing examples: Kill_switch, Ansible_playbook.
2. settings.yml:
   - Enable 'resource_directory: {neuron: "resources/neurons"}'. The path must exist (SettingLoader.py:531-537).
   - Set 'hooks: on_order_not_found: "vas-fallback"' (settings.yml:115, HookManager.py:45-46).
   - Set 'rest_api: active: True' if VAS or Electron will drive Kalliope.
3. Code pattern (copy from say.py:4-28 and uri.py:13-61):
   - super(Vas_brain, self).__init__(**kwargs).
   - query = kwargs.get('query') or Cortex.get_from_key('kalliope_last_order').
   - Send it to the bridge, collect the 'text' deltas until 'done' or 'error', then self.say({'reply': text, 'query': query}).
   - Raise MissingParameterException (NeuronModule.py:32) if there is no query.
   - All work happens inside __init__ and blocks the LIFO. There is no streaming, so TTS starts only after the full reply.
4. brain.yml:
   - name: vas-fallback
   - signals: []
   - neurons: [{vas_brain: {query: "{{ kalliope_memory['kalliope_last_order'] }}", say_template: "{{ reply }}"}}]
   - Bracket-check note: kalliope_memory['x'] does not match the [\w\.]+ regex (Utils.py:272), so it skips the availability check and renders through NeuronLauncher.py:85-95. The dotted form kalliope_memory.x WOULD fail the check (NeuronLauncher.py:137-144).
   - Alternative catch-all: order "{{ query }}" with normal matching matches everything (OrderAnalyser.py:207-216) and receives query directly. But it also fires alongside specific synapses (L76-93).
5. Install:
   - Do not use 'kalliope install --git-url' (Ansible plus sudo, ResourcesManager.py:305-332). Copy the folder by hand.
   - dna.yml: {name: vas_brain, type: neuron, kalliope_supported_version: [0.7]}. Read the real version from kalliope/_version.py; it is checked at ResourcesManager.py:335-368.
6. Bridge transport, two options:
   - (a) WebSocket ws://127.0.0.1:8787/ws, sending {type:'ask', text, id}. Requires JARVIS_ALLOW_NO_ORIGIN=1 or sending an Origin listed in JARVIS_ALLOWED_ORIGINS (server.mjs:58-64, 77-78). The client must also handle server 'ask' requests and send 'reply' (server.mjs:1102-1114, 1434).
   - (b) Simpler: add a POST /ask JSON endpoint to bridge/server.mjs next to /tts (L809) or /stt (L894). Then use the CORE uri neuron with no new Python: {uri: {url: 'http://127.0.0.1:8787/ask', method: POST, data: '{"text": "..."}', say_template: '{{ content.reply }}'}} (uri.py:19-26, 55-61).
   - Caveat: uri's data must be a JSON string, and quotes in spoken text break it, so a custom neuron is safer.

B. FAST LOCAL COMMANDS (open apps) WITH A PERMISSION MODEL
- Pattern: synapse with order {text: "open {{ app }}", matching-type: ordered-strict} (OrderAnalyser.py:245-268), then a neuron.
- Do NOT reuse the shell neuron with templated text. shell.py:44-45 and :51 concatenate the captured words into a shell=True cmd.exe string, which is command injection.
- Write a neuron that maps {{ app }} to an allowlist (app name to exe path / AppUserModelID) and launches with subprocess list args or os.startfile.
- Confirmation: chain to a neurotransmitter synapse with from_answer_link yes/no and a default (neurotransmitter.py:14-60). Over the API the status becomes 'waiting_for_answer' (LIFOBuffer.py:162-168), and the next /synapses/start/order text is delivered as the answer (SynapseLauncher.py:90-92).
- Runtime enable/disable of capabilities: the core brain neuron {synapse_name, enabled} (neurons/brain/brain.py:16-17).

C. VOICE PERSONALIZATION HOOKS
- stt-correction and stt-correction-file per signal (OrderAnalyser.py:97-108, 341-365). These are per-signal only; there is no global setting.
- Port this as a global VAS 'personal lexicon': apply it before matching AND send it as vocabulary hints to the STT.
- Other knobs: STT language (settings.yml:38; google.py:22); cmusphinx keyword_entries/grammar (cmusphinx.py:21-23); recognizer_* mic options (settings.yml:164-167, SettingLoader.py:627-645, live through the settings neuron or REST /settings/recognizer_*/ at settings_views.py:29-44).

D. LIFECYCLE EVENTS FOR VAS UI/HUD (same names): on_start, on_waiting_for_trigger, on_triggered, on_start_listening, on_stop_listening, on_order_found, on_order_not_found, on_processed_synapses, on_deaf, on_undeaf, on_mute, on_unmute, on_start_speaking, on_stop_speaking, on_stt_error (HookManager.py:13-78; settings.yml:108-121).

E. HELPERS TO REUSE OR PORT
- OrderAnalyser.is_normal_matching / is_strict_matching / is_ordered_strict_matching / is_not_contain_matching (pure, about 100 lines).
- NeuronParameterLoader._associate_order_params_to_values (L26-66).
- NeuronModule._get_say_template / _get_file_template (Jinja phrasing, L203-228).
- Cortex keys kalliope_last_order / kalliope_last_tts_message ('what did you just say?').
- Event signal for cron routines (signals/event/event.py:4-5, 34).
- Signals neuron skip_trigger for continuous conversation (order.py:205-257).

## windows_and_desktop_issues
Blockers for running Kalliope on Windows 11 with Python 3.14.2 (the user's only Python, per py -0p). I checked the import failures directly.

1. 'imp' was removed in Python 3.12, and `python -c "import imp"` fails on this machine.
   - Used at Utils.py:4. kalliope/core/__init__.py imports Utils first, so `import kalliope.core` fails and even OrderAnalyser cannot be imported unmodified.
   - Also used at ConfigurationChecker.py:3, 147, 188 and snowboydetect.py:23-32.
   - Fix: replace with importlib.util.spec_from_file_location, or use Python 3.11 or older.
2. 'audioop' was removed in 3.13 (verified missing). Used at stt/SpeechRecognizer.py:19. The audioop-lts PyPI package provides the module.
3. setup.py declares only 'Operating System :: POSIX :: Linux' (L62) and Python 3.6-3.9 (L63-66).
4. pyalsaaudio (setup.py:103) is Linux/ALSA only, so `pip install .` fails on Windows. It is imported at players/pyalsaaudio/pyalsaaudio.py:2 and neurons/volume/volume.py:4.
5. ansible (setup.py:86) cannot be an Ansible control node on Windows. Community installs need Ansible plus a sudo password plus become root (ResourcesManager.py:305-332, getpass at L319). install.yml examples use apt/pip3 (docs/contribute/installation_file.md:14-27, 46-54). So `kalliope install` is unusable; neurons must be copied in by hand.
6. Snowboy is the ONLY core trigger (kalliope/trigger has only snowboy; settings.yml:11-19).
   - Binaries are Linux .so files only: x86_64/python36-39, armv7l/python37 and 39, armv6l/python37.
   - The loader path uses platform.machine() (Settings.py:44), which returns 'AMD64' on this laptop (verified), plus pythonXY (snowboydetect.py:13).
   - Result: no wake word, so the 'order' voice signal cannot start.
   - The training site in the docs (docs/settings/triggers/snowboy.md:3) is snowboy.kitt.ai, which (from outside knowledge) shut down around 2020.
7. cffi ffi.dlopen(None) runs in OrderListener.__init__ (OrderListener.py:39, 77-93) and in snowboy.py:119-139. On Windows/Python 3, cffi does not support dlopen(None); I could not check this locally because cffi is not installed. It breaks every STT path: voice, REST /synapses/start/audio, and neurotransmitter get_audio_from_stt. The text-only REST /synapses/start/order path avoids OrderListener.
8. Audio output:
   - Default player is mplayer at /usr/bin/mplayer (players/mplayer/mplayer.py:8; settings.yml:86).
   - pico2wave is at /usr/bin/pico2wave (tts/pico2wave/pico2wave.py:51); espeak at /usr/bin/espeak (tts/espeak/espeak.py:20).
   - The WAV conversion step needs ffmpeg (PlayerModule.py:54; synapses_views.py:378). ffmpeg, mplayer and espeak are not on PATH (verified).
   - sounddeviceplayer, pyaudioplayer and googletts (gTTS) are the only Windows-friendly options.
9. POSIX paths:
   - '/tmp/kalliope/tmp_uploaded_audio' at FlaskAPI.py:20, synapses_views.py:25, settings_views.py:14.
   - cache_path '/tmp/kalliope_tts_cache' at settings.yml:58.
   - '/etc/kalliope' lookup at Utils.py:191.
   - These resolve to C:\tmp and similar; they would work but are messy.
10. Wheel availability for cp314 on Windows (pyaudio, gevent, cffi): not verified. Assume a risk.
11. REST server issues:
    - FlaskAPI.run hardcodes WSGIServer(('', 5000)) (FlaskAPI.py:79-81). It ignores rest_api.port and binds 0.0.0.0, which exposes it on the LAN; default credentials are admin/secret (settings.yml:129-131).
    - /shutdown relies on werkzeug.server.shutdown (FlaskAPI.py:93), which modern Werkzeug removed (outside knowledge).
    - The REST order path saves kalliope_last_order after matching (synapses_views.py:259 vs 264), so a REST-driven on_order_not_found neuron gets the previous order.
12. Shell and script neurons:
    - shell=True plus string concatenation of spoken text (shell.py:44-45, 51) is injection-prone and runs cmd.exe on Windows.
    - The script neuron's os.access X_OK check (script.py:67) means nothing on Windows.
13. kill_switch calls os._exit(1) (kill_switch.py:12). Inside an Electron child process this looks like a crash with exit code 1, so VAS's own kill switch should exit cleanly and stop the child processes.
14. WSL2 is installed but only the docker-desktop distro exists (verified with `wsl -l -v`).
    - Viable only with: an Ubuntu distro, Python 3.9 via pyenv (to match the snowboy py39 .so), portaudio/mplayer/ffmpeg from apt, and microphone through WSLg PulseAudio (extra latency, flaky device selection).
    - Launching Windows apps would go through interop (cmd.exe /c start, powershell.exe).
    - Reaching the Windows-side bridge at 127.0.0.1:8787 needs WSL mirrored networking or the host IP.
    - Not a good base for a desktop app.
15. Electron packaging: Kalliope would need a bundled Python runtime plus PortAudio/ffmpeg as a sidecar. Reusing only the matching logic means porting about 150 lines (OrderAnalyser plus NeuronParameterLoader) to JS rather than importing Python.

Cross-repo items that affect goals (a) and (c). These are outside my focus; verify with the jarvis-main explorers:
- package.json script "bridge:writes": "JARVIS_ALLOW_WRITES=1 node bridge/server.mjs" uses POSIX env syntax and fails under cmd.exe (needs cross-env or setting it in code).
- bridge/chrome.mjs:56 SOCKET_DIR = `/tmp/claude-mcp-browser-bridge-${username}` is a Unix-domain socket. On Windows the Claude-in-Chrome native host likely uses a named pipe instead (not verified), so the Chrome tools probably cannot connect on Windows as written.
- The bridge WebSocket refuses clients with no Origin unless JARVIS_ALLOW_NO_ORIGIN=1 (server.mjs:64, 77-78). It also refuses origins outside localhost ports 5173-5199 and 4173-4199 unless they are listed in JARVIS_ALLOWED_ORIGINS (L74-75). An Electron renderer served from file:// or a custom protocol needs an explicit allowlist entry.

## jarvis_branding
Kalliope repo (only 3 hits from a case-insensitive grep over the whole tree):
- setup.py:72: keywords='assistant bot TTS STT jarvis'
- docs/settings/triggers/snowboy.md:55, 65, 110: jarvis.umdl universal hotword model example ("Jarvis" wake word with two sensitivities; apply_frontend True). jarvis.umdl itself is NOT bundled; only kalliope-FR-162samples.pmdl is in kalliope/trigger/snowboy/resources.
- No 'Jarvis' in Kalliope code, prompts or UI. Kalliope's own persona text is French and lives in kalliope/brain.yml:7, 15, 22-26, 33-38, 44 and the settings.yml language fields (L38, 45, 68, 71, 74, 79).

jarvis-main (seen while cross-checking; a full inventory belongs to the jarvis-main explorer):
- package.json: "name": "jarvis"; the description mentions an Iron Man holographic interface; script "bridge:writes" sets JARVIS_ALLOW_WRITES.
- bridge/server.mjs:
  - Env vars: JARVIS_BRIDGE_PORT (L31), JARVIS_ALLOWED_ORIGINS (L59), JARVIS_ALLOW_NO_ORIGIN (L64).
  - '[jarvis]' log prefixes (L973, 988, 993-994, 1003, 1265).
  - MCP server names 'jarvis' and 'jarvis_ui' (L263, L1210) and 'jarvis_chrome' (L276).
  - Deny message text 'JARVIS is running in read-only mode' (L1269-1271).
- bridge/chrome.mjs:45-46 comment ('rest of JARVIS').
- A rename to VAS should keep env-var aliases (for example VAS_BRIDGE_PORT with a fallback to JARVIS_BRIDGE_PORT). The MCP tool-name prefixes (mcp__jarvis_chrome__*) also appear in decideTool, so renaming them needs a coordinated change.

## open_questions
1. Which "existing repository" should get the new neuron? Kalliope is NOT inside Collab-main (Collab-main/Collab-main/collabb-main contains only jarvis-main, and neither folder is a git repo). The user said the Claude brain repo is Collab-main. This suggests the "neuron" should be a VAS/jarvis-main module (Node), using Kalliope only as the design reference. The user should confirm.
2. If a Kalliope Python neuron is truly wanted, would the user accept WSL2 Ubuntu + Python 3.9, or installing Python 3.11 next to 3.14 and patching imp/audioop/cffi for a headless, text-only REST Kalliope? Both are heavy for little gain over porting the matcher to Node.
3. How does the Claude-in-Chrome native host expose its socket on Windows (named pipe name and path)? bridge/chrome.mjs:56 assumes /tmp Unix sockets. This decides whether goal (c) works on Windows at all. It needs a check of the extension's native-messaging host manifest under %LOCALAPPDATA%/Google/Chrome/User Data/NativeMessagingHosts or the registry.
4. Does the bridge's per-connection session handle a second, headless client (a Kalliope neuron or Electron main process) at the same time as the HUD? Server-to-client 'ask' requests (capture, ui) with 20 s timeouts (server.mjs:1102-1114) would stall if the headless client never replies.
5. Which STT will VAS use for "understand my voice better"? The bridge has an ElevenLabs /stt endpoint (server.mjs:894). Kalliope offers only post-hoc stt-correction. The plan needs to decide on vocabulary hints (ElevenLabs keyterms, Whisper initial_prompt) plus a user-editable correction lexicon and a log of misrecognitions; none of this exists in either repo.
6. The exact Kalliope version for dna.yml kalliope_supported_version (kalliope/_version.py was not read).
7. Wheel availability of pyaudio, gevent and cffi for cp314-win_amd64 was not checked.
8. Permission model scope: allowlisted apps only, or arbitrary executables with a spoken confirmation? This affects whether to port Kalliope's neurotransmitter-style yes/no flow or reuse the bridge's canUseTool/decideTool (server.mjs:255-276, 1264).

## key_files
### C:\Users\Aswin\Downloads\kalliope-master\kalliope-master\kalliope\core\NeuronModule.py
Base class every neuron subclasses: TTS, templates, memory, chaining, re-listening
InvalidParameterException L22, MissingParameterException L32. NeuronModule.__init__(**kwargs) L70-103: loads SettingLoader/BrainLoader singletons (L80-83), default TTS (L85); reads say_template L89, file_template L91, is_api_call L95, kalliope_memory L101; sets is_waiting_for_answer=False L97; saves order params to memory L103. serialize() L110-121 returns {'neuron_name','generated_message'} (how the result reaches API callers). say(message) L123-181: str -> as-is, list -> random.choice, dict -> Jinja via say_template/file_template (L183-228); saves kalliope_last_tts_message L162; respects options.mute L165; fires on_start_speaking/on_stop_speaking hooks L169/L181; loads the TTS dynamically L174-180. run_synapse_by_name(...) L231-253 pushes a synapse onto the LIFO (chaining). is_order_matching L256-258 (normal matching). get_audio_from_stt(callback) L271-284 listens again for a follow-up utterance. _get_tts_object L294-322 lets a neuron override the TTS.

### C:\Users\Aswin\Downloads\kalliope-master\kalliope-master\kalliope\core\Utils\Utils.py
Dynamic plugin loader for neurons, STT, TTS, trigger, signals, players; file path resolution; bracket helpers
`import imp` L4 is the hard Py>=3.12 blocker, and kalliope/core/__init__.py imports this first. get_dynamic_class_instantiation(package_name, module_name, parameters, resources_dir) L101-153: core path 'kalliope.<pkg>.<name>.<name>' L115; resource-dir override <dir>/<name>/<name>.py through imp.load_source L117-124; class = getattr(mod, module_name.capitalize()) L135-136; class cache L127-145; instantiates klass(**parameters) L147-152. get_real_file_path L171-208 searches cwd, then /etc/kalliope (L191), then the package root. is_containing_bracket L248, find_all_matching_brackets L265-276 (regex [\w\.]+, so kalliope_memory['x'] skips the availability check), remove_spaces_in_brackets L279.

### C:\Users\Aswin\Downloads\kalliope-master\kalliope-master\kalliope\core\NeuronLauncher.py
Fills {{ }} in neuron parameters and instantiates the neuron
launch_neuron L28-44 uses resources.neuron_folder. start_neuron L47-68: on any exception prints 'Fail to execute neuron' and returns None, so failures are silent (L63-67). _replace_brackets_by_loaded_parameter L71-120: merges settings.variables plus kalliope_memory (L85-91), renders with Jinja (L95); reserved keys say_template/file_template/kalliope_memory/from_answer_link are not templated (L106-108).

### C:\Users\Aswin\Downloads\kalliope-master\kalliope-master\kalliope\core\OrderAnalyser.py
Matches spoken text to synapses; worth porting for fast local VAS commands
get_matching_synapse L33-59. get_list_match_synapse L72-94: lowercases (L74), loops over ALL enabled synapses and collects every match (break L93 only skips other signals of the same synapse); bug: corrected order is reassigned and leaks into later synapses (L85). order_correction L97-108 (stt-correction-file, then inline override). get_matching_type default 'normal' L147-155. is_not_contain_matching L174-194. is_normal_matching L197-216 (Counter subset; bracket words removed, so an order of only '{{ query }}' matches everything). is_strict_matching L219-242 (same token count after filling params). is_ordered_strict_matching L245-268. is_order_matching_signal dispatch L271-302. get_signal_order: 'text' key or a plain string, L305-315. override_order_with_correction L341-357 (substring replace, L353-355). load_stt_correction_file L360-365 (YAML list of {input, output}).

### C:\Users\Aswin\Downloads\kalliope-master\kalliope-master\kalliope\core\NeuronParameterLoader.py
Extracts {{ var }} values from the user's text
get_parameters L13-23 (also caches in Cortex.temp). _associate_order_params_to_values L26-66: walks the signal words; a variable takes words until the next literal 'stop word', or the rest of the sentence if it is last (L52-55). Two adjacent {{a}} {{b}} are unsupported (docs/brain/signals/order.md 'Important note').

### C:\Users\Aswin\Downloads\kalliope-master\kalliope-master\kalliope\core\SynapseLauncher.py
Entry point from order text to synapse execution, including the not-found hook
start_synapse_by_list_name L27-73 (overriding_parameter_dict L41-44, new_lifo L58-61, always is_api_call=True L72). run_matching_synapse_from_order(order, brain, settings, is_api_call) L76-108: if the LIFO is not empty, the text is treated as an ANSWER to a waiting neuron (L90-92); empty match returns HookManager.on_order_not_found() (L98-99); else on_order_found, then execute, then on_processed_synapses (L101-107).

### C:\Users\Aswin\Downloads\kalliope-master\kalliope-master\kalliope\core\HookManager.py
Lifecycle hooks that each run synapses listed in settings.hooks
on_start L14, on_waiting_for_trigger L18, on_triggered L22 (also sends Google tracking if enabled, L24-29), on_start_listening L33, on_stop_listening L37, on_order_found L41, on_order_not_found L45, on_processed_synapses L49, on_deaf/on_undeaf L53/57, on_mute/on_unmute L61/65, on_start_speaking/on_stop_speaking L69/73, on_stt_error L77. execute_synapses_in_hook_name L81-100: accepts a str or list; runs in a NEW LIFO with NO parameters (L100), so the hook synapse cannot receive the order as a parameter.

### C:\Users\Aswin\Downloads\kalliope-master\kalliope-master\kalliope\core\Cortex.py
Short-term memory singleton
memory dict L20, temp L23. save L37-47, get_from_key L50-55, add_parameters_from_order L58, save_neuron_parameter_in_memory L71-104, save_parameter_from_order_in_memory L107-129. Built-in keys: kalliope_last_order (order.py:184; synapses_views.py:264,360), kalliope_last_tts_message (NeuronModule.py:162).

### C:\Users\Aswin\Downloads\kalliope-master\kalliope-master\kalliope\core\Lifo\LIFOBuffer.py
Runs synapse lists; supports waiting for an answer over the API
execute(answer, is_api_call) L67-106 returns the serialized APIResponse. _process_neuron_list L130-185: injects 'answer' into the first waiting neuron (L150-153) and is_api_call (L155); status 'complete' or 'waiting_for_answer' (L162-168); restarts when a neuron queued a high-priority synapse (L177-182).

### C:\Users\Aswin\Downloads\kalliope-master\kalliope-master\kalliope\core\ResourcesManager.py
`kalliope install --git-url` for community neurons
DNA_FILE_NAME 'dna.yml' L23, INSTALL_FILE_NAME 'install.yml' L24. install() L64-126: git clone to tempdir (L58, L71, L270-284), is_repo_ok requires both files (L217-233), DnaLoader (L82), version check against kalliope_supported_version (L95-100, L335-368), target = settings.resources.<type>_folder (L104, L236-268), moves the folder to <dir>/<name> (L287-303), then run_ansible_playbook_module (L305-332), which asks a sudo password through getpass (L319) and runs the ansible_playbook neuron as root (L324-331). uninstall L128-169.

### C:\Users\Aswin\Downloads\kalliope-master\kalliope-master\kalliope\core\ConfigurationManager\ConfigurationChecker.py
Brain validation; imports every referenced neuron and signal at load time
import imp L3. check_neuron_exist L132-161 (resource-dir imp.load_source L147; raises KalliopeModuleNotFoundError). check_signal_dict, imp.load_source L188.

### C:\Users\Aswin\Downloads\kalliope-master\kalliope-master\kalliope\core\ConfigurationManager\SettingLoader.py
Parses settings.yml
FILE_NAME L20, path resolution L58-68. _get_resources L502-584 (resource_directory keys neuron/stt/tts/trigger/signal; each path must exist, L533-537). _get_options L610-655 (recognizer_multiplier 1.0, energy_ratio 1.5, recording_timeout 15, timeout_with_silence 3.0, L627-645). _get_hooks L660-695 (hook names list near L682). _get_rest_api L403-466.

### C:\Users\Aswin\Downloads\kalliope-master\kalliope-master\kalliope\core\ConfigurationManager\BrainLoader.py
Parses brain.yml into Synapse(name, neurons, signals)
load_brain L64-104 (skips 'includes' entries L88, which YAMLLoader expands, YAMLLoader.py:83-84). get_neurons L107-135 (dict {name: params} or bare name). get_signals L138-161.

### C:\Users\Aswin\Downloads\kalliope-master\kalliope-master\kalliope\signals\order\order.py
Voice loop state machine: trigger, STT, analyse
states L28-35 (transitions lib). start_trigger_process L91-102 (fires on_start L101). pause_trigger_process, on_triggered L148-157. start_order_listener_thread L159-171 (on_start_listening). order_listener_callback L173-184 (on_stop_listening; saves kalliope_last_order BEFORE analysis, L184). analysing_order_thread L186-203 (empty text fires on_stt_error L190-192; else run_matching_synapse_from_order L195-198). Notifications skip_trigger / skip_trigger_max_retry (continuous conversation) L205-257.

### C:\Users\Aswin\Downloads\kalliope-master\kalliope-master\kalliope\core\OrderListener.py
Loads the STT plugin for one utterance
__init__ calls _ignore_stderr (L39). load_stt_plugin L54-70 (passes callback and audio_file_path). _ignore_stderr L73-93 uses cffi ffi.dlopen(None) (L85), which does not work on Windows/Python 3.

### C:\Users\Aswin\Downloads\kalliope-master\kalliope-master\kalliope\stt\SpeechRecognizer.py
Microphone capture and VAD, adapted from Mycroft
import audioop L19 (removed in Py3.13), import pyaudio L25. MutableMicrophone L84-110 (16 kHz mono). NoiseTracker L116-219. ResponsiveRecognizer L221-366 (energy threshold * multiplier, L305-311); listen L326-356.

### C:\Users\Aswin\Downloads\kalliope-master\kalliope-master\kalliope\stt\google\google.py
Default STT (free Google Web Speech through SpeechRecognition)
key/language (default en-US)/show_all kwargs L21-23. recognize_google L35-38. Errors call the callback with None (L41-51), which triggers on_stt_error. No phrase hints or vocabulary support.

### C:\Users\Aswin\Downloads\kalliope-master\kalliope-master\kalliope\stt\cmusphinx\cmusphinx.py
Offline STT; the only vocabulary-biasing option
language, keyword_entries, grammar_file L20-23, passed to recognize_sphinx L35-38.

### C:\Users\Aswin\Downloads\kalliope-master\kalliope-master\kalliope\trigger\snowboy\snowboydetect.py
Snowboy wake-word SWIG loader; the only core trigger
module path '<platform.machine()>/python<maj><min>/_snowboydetect' L13 (machine comes from Settings.py:44; 'AMD64' on this laptop). imp.find_module/load_module L23-32. Binaries present: x86_64/python36..39, armv7l/python37,39, armv6l/python37, all Linux .so files.

### C:\Users\Aswin\Downloads\kalliope-master\kalliope-master\kalliope\core\RestAPI\FlaskAPI.py
REST server bootstrap
UPLOAD_FOLDER '/tmp/kalliope/tmp_uploaded_audio' L20. CORS when allowed_cors_origin L52-53. Routes GET / L56, POST /shutdown/ L57 (uses werkzeug.server.shutdown L93). Registers the synapses/settings/neurons blueprints L60-77. run() L79-81 hardcodes WSGIServer(('', 5000)): ignores settings.rest_api.port and binds all interfaces.

### C:\Users\Aswin\Downloads\kalliope-master\kalliope-master\kalliope\core\RestAPI\views\synapses_views.py
Endpoints an external app (VAS/Electron) can use to drive Kalliope
Routes L42-48: GET/POST /synapses, GET/DELETE /synapses/<name>, POST /synapses/start/id/<name> (L167-217; JSON {'mute','parameters'} at L191-198, becoming overriding_parameter at L209), POST /synapses/start/order (L220-275; JSON {'order','mute'}; is_api_call=True L259-262; kalliope_last_order saved AFTER matching, L264), POST /synapses/start/audio (L278-341; multipart file, wav only, ffmpeg conversion through os.system L378; needs OrderListener/STT). Response: APIResponse {user_order, matched_synapses[{synapse_name, matched_order, neuron_module_list[{neuron_name, generated_message}]}], status}.

### C:\Users\Aswin\Downloads\kalliope-master\kalliope-master\kalliope\core\RestAPI\utils.py
Basic auth and request helpers
check_auth L12-18, requires_auth L29-39 (skipped when password_protected is False). get_parameters_from_request L42-57. get_value_flag_from_request L60.

### C:\Users\Aswin\Downloads\kalliope-master\kalliope-master\kalliope\neurons\say\say.py
Smallest neuron example
class Say(NeuronModule) L4; message / file_template / parameters kwargs L7-9; _is_parameters_ok raises MissingParameterException L18-28; self.say(self.message) L16. __init__.py: 'from .say import Say'.

### C:\Users\Aswin\Downloads\kalliope-master\kalliope-master\kalliope\neurons\shell\shell.py
Runs a shell command; the 'open app' pattern and an injection risk
cmd/async/query kwargs L39-42; query concatenated into the command in quotes L44-45; Popen(shell=True) L51 (cmd.exe on Windows); returns {output, returncode} to say() L55-59; AsyncShell L10-28.

### C:\Users\Aswin\Downloads\kalliope-master\kalliope-master\kalliope\neurons\uri\uri.py
HTTP-call neuron; could call a VAS HTTP endpoint with no custom code
url/headers/data/method/user/password/timeout kwargs L19-26; method switch L38-53; say({status_code, content, response_header}) L55-61; tries to parse content as JSON (around L127-131), so say_template can use '{{ content.reply }}'.

### C:\Users\Aswin\Downloads\kalliope-master\kalliope-master\kalliope\neurons\neurotransmitter\neurotransmitter.py
Follow-up question / confirmation dialog (yes/no) and synapse redirect
from_answer_link/default/direct_link/answer kwargs L14-18. API mode: is_waiting_for_answer=True when there is no answer (L26-30). Voice mode: get_audio_from_stt (L33). callback L35-60 matches each answer with normal matching, else runs the default synapse.

### C:\Users\Aswin\Downloads\kalliope-master\kalliope-master\kalliope\neurons\kill_switch\kill_switch.py
Exits Kalliope
Kill_switch.__init__ calls os._exit(1) (L12): hard process exit with code 1.

### C:\Users\Aswin\Downloads\kalliope-master\kalliope-master\kalliope\settings.yml
Default config (French)
default_trigger snowboy + .pmdl L11-19. default_speech_to_text google, language fr-FR L26-49. default_text_to_speech pico2wave L56; cache_path /tmp L58; TTS list L66-80. default_player mplayer L86-102. hooks L108-121 (on_start, on_triggered, on_order_not_found pre-wired). rest_api L126-132 (inactive, admin/secret). resource_directory example commented out L145-150. var_files L156-158. options deaf/mute and recognizer_* L163-169.

### C:\Users\Aswin\Downloads\kalliope-master\kalliope-master\kalliope\brain.yml
Default brain
Synapse = {name, signals:[{order: ...}], neurons:[{say: {message}}]} L2-15. Hook-only synapses use 'signals: []' (order-not-found-synapse L17-26, on-triggered L28-38, on-start L40-44).

### C:\Users\Aswin\Downloads\kalliope-master\kalliope-master\setup.py
Packaging; the main evidence for platform blockers
Classifiers 'Operating System :: POSIX :: Linux' L62 and Python 3.6-3.9 only L63-66; python_requires >=3.6 L76 (no upper cap, but the code breaks on 3.12+). install_requires: SpeechRecognition L82, pyaudio L84, ansible L86, cffi L88, flask L90, GitPython L98, sounddevice/SoundFile L101-102, pyalsaaudio L103 (Linux only), gevent L108. keywords include 'jarvis' L72. Snowboy files bundled as package_data (package_files on kalliope/trigger/snowboy).

### C:\Users\Aswin\Downloads\kalliope-master\kalliope-master\docs\contribute\neuron.md
Neuron authoring rules; partly outdated
Repo layout: lowercase name, README, tests, dna.yml, install.yml (L7-19, L64-75). Class name capitalized, inherits NeuronModule, super().__init__(**kwargs), _is_parameters_ok (L22-54). Outdated: says 'Python 2.7' (L24) and 'from core.NeuronModule' (L30); the real import is 'from kalliope.core.NeuronModule import NeuronModule'.

### C:\Users\Aswin\Downloads\kalliope-master\kalliope-master\docs\contribute\dna.md
dna.yml schema
name (lowercase, becomes the folder name), type neuron|stt|tts (also trigger|signal in ResourcesManager.py:31-35), author, kalliope_supported_version (list of MAJOR.MINOR), tags (L8-14). Example L19-30.

### C:\Users\Aswin\Downloads\kalliope-master\kalliope-master\docs\brain\signals\order.md
Order signal documentation
Params text / matching-type / excluded-words / stt-correction / stt-correction-file (L14-17). Match type semantics L20-58. Arguments L61-90. stt-correction L92-138, correction file L140-168, precedence L170-207. Signals neuron skip_trigger (continuous listening) L209+.

### C:\Users\Aswin\Downloads\Collab-main\Collab-main\collabb-main\jarvis-main\bridge\server.mjs
(Cross-check only) the Claude brain a Kalliope neuron would call
PORT = JARVIS_BRIDGE_PORT ?? 8787 (L31). Origin gate: EXTRA_ORIGINS from JARVIS_ALLOWED_ORIGINS (L58-63), ALLOW_NO_ORIGIN = JARVIS_ALLOW_NO_ORIGIN==='1' (L64), originAllowed returns ALLOW_NO_ORIGIN when there is no Origin (L77-78), so a Python client is rejected by default. The WebSocket accepts only path / or /ws (L986-990). Inbound {type:'ask', text, id} L1406-1431, {type:'reply', id} L1434-1441, {type:'interrupt'} L1443. Outbound: 'ready' L1048, 'text' deltas L1303, 'tool' L1182/1190, 'done' L1347, 'error' L1357, 'panel'/'blade'/'ui' L1203-1210. Server-to-client requests through ask(kind, args, 20 s timeout) L1102-1114 (for example 'capture' in vision.mjs:99) expect a 'reply', so a headless client must answer or refuse them. canUseTool, decideTool L255-276 and L1264. The HTTP routes do not include a text 'ask' (only /health, /file, /img, /media, /page, /tts, /stt: L679-894).

