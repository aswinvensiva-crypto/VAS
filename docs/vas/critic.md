- [CONFIRMED] chrome.mjs reaches the user's real Chrome by connecting directly to the Claude-in-Chrome native host's local IPC endpoint. Framing is a 4-byte LE length plus JSON {method:'execute_tool', params:{tool,args}}. Discovery is POSIX-only (/tmp/claude-mcp-browser-bridge-<user>/*.sock), so it is broken on Windows, where the endpoint is the named pipe \\.\pipe\claude-mcp-browser-bridge-Aswin.
  chrome.mjs:21-28 (the comment describes a Unix socket only), :56 SOCKET_DIR=`/tmp/claude-mcp-browser-bridge-${userInfo().username}`, :84-105 findSocket readdir -> null on failure, :178 createConnection(path), :225-228 writeUInt32LE header, :247 message has no client_id. Live check: [IO.Directory]::GetFiles('\\.\pipe\') returns \\.\pipe\claude-mcp-browser-bridge-Aswin. The registry key HKCU\Software\Google\Chrome\NativeMessagingHosts\com.anthropic.claude_code_browser_extension points to C:\Users\Aswin\AppData\Roaming\Claude Code\ChromeNativeHost\com.anthropic.claude_code_browser_extension.json. That manifest's path is C:\Users\Aswin\.claude\chrome\chrome-native-host.bat, which runs ...\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe --chrome-native-host. chrome_status (chrome.mjs:562) and chromeAvailable (:817) also depend on findSocket.
- [CONFIRMED] decideTool order: READ_ONLY_BUILTINS allow; WRITE_BUILTINS -> ALLOW_WRITES; jarvis/jarvis_ui/jarvis_chrome/jarvis_eyes allowed by name; then the EFFECTFUL_VERB veto; then READ_ONLY_MCP/ccd_session; then READ_VERB; otherwise ALLOW_WRITES. canUseTool wraps it.
  server.mjs:255-291 (266 jarvis|jarvis_ui, 275 jarvis_chrome, 280 jarvis_eyes, 283-285 veto, 287 allowlist, 288 READ_VERB, 290 non-MCP default). READ_VERB is anchored at :227-228; EFFECTFUL_VERB is unanchored at :235-236. canUseTool at :1264-1278, deny text at :1273-1276. A new tool named open_app matches no verb, so it falls to ALLOW_WRITES at :288.
- [WRONG] Built-in Bash/PowerShell are denied unless JARVIS_ALLOW_WRITES=1, so system reach is all-or-nothing behind the flag.
  The bridge's own comments say canUseTool is only a last gate. The CLI's classifier auto-approves harmless Bash such as `echo` without ever calling canUseTool (server.mjs:1127-1130 and 1259-1263: 'an absence of a call here is not proof nothing ran'). So read-only shell commands can still run with writes off. Any app-launch permission model must be enforced inside the new tool's handler, and/or by passing disallowedTools for Bash/PowerShell. The bridge sets neither allowedTools nor disallowedTools (grep finds no matches in server.mjs).
- [CONFIRMED] In-process MCP tools are defined with the SDK's tool(name, desc, zodRawShape, handler, extras?) and createSdkMcpServer({name, version, instructions, tools, alwaysLoad}), and registered in the per-connection mcpServers object. The chrome server builds write tools only when allowWrites is set.
  node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:482 (createSdkMcpServer), :484-503 (options name/version/instructions/tools/alwaysLoad), :6940-6944 (tool signature with extras annotations/searchHint/alwaysLoad). SDK version 0.3.220 (package.json:22). chrome.mjs:553 chromeServer({allowWrites}), :727 if (allowWrites), :801-813 createSdkMcpServer name 'jarvis_chrome' alwaysLoad. server.mjs:1200-1217 registration. vision.mjs:73 visionServer(ask) shows the ask/reply pattern.
- [CONFIRMED] The wake word is a transcript regex. Porcupine is declared but never imported.
  src/lib/voice.ts:80-81 WAKE regex (jarvis|jarvys|jervis|jarvis's|travis|jarviss|java's|jarv). A case-insensitive grep for porcupine|picovoice|WAKE_ENGINE outside node_modules matches only package.json:25-26 (deps), src/config.ts:136 (VITE_PICOVOICE_ACCESS_KEY) and src/config.ts:154-160 (WAKE_ENGINE export). Nothing imports either. voice.ts:763 hard-codes rec.lang='en-GB'.
- [CONFIRMED] Scribe STT sends only model_id='scribe_v1' plus the file, with no language or vocabulary biasing. The route check is a strict equality, so a query string would 404.
  server.mjs:894 `req.method === 'POST' && req.url === '/stt'`; :922-925 returns empty text below 1200 bytes; :938-944 FormData model_id 'scribe_v1' + file only; :946-950 POST https://api.elevenlabs.io/v1/speech-to-text with the xi-api-key header. elevenKey() at :448-458 reads ELEVENLABS_API_KEY or ~/.claude.json mcpServers.elevenlabs.env. Global mcpServers on this machine contains only 'github' (key names inspected, no values printed), so stt/tts are currently false.
- [WRONG] Nothing is persisted: no resume or sessionId, and session.close() on disconnect.
  There is indeed no resume, sessionId or persistSession in server.mjs (grep: the only 'resume' hits are stream .resume() at 573-633). However, the SDK option persistSession defaults to true (sdk.d.ts:1580-1587), and the bridge runs with cwd=homedir() (server.mjs:1225). So every voice session's transcript, including page text read from signed-in sites through the chrome tools, is written to ~/.claude/projects/C--Users-Aswin/ (that folder exists). The SDK also offers resume (sdk.d.ts:1803), sessionId (:1809) and continue (:1385), which the plan can use for memory. Otherwise it should set persistSession:false for privacy.
- [CONFIRMED] Home-scoped MCP servers are missed on Windows because ~/.claude.json stores the project key with forward slashes.
  server.mjs:169 cfg.projects?.[homedir()]. Live check: homedir()='C:\Users\Aswin', projects has 'C:/Users/Aswin' (forward-slash key present, backslash key absent). No project currently defines mcpServers, so the miss is latent rather than active today. MCP_SERVERS is computed once at boot (server.mjs:176).
- [WRONG] Native (non-browser) clients such as a Kalliope Python neuron are refused by the origin gate unless JARVIS_ALLOW_NO_ORIGIN=1, so the gate protects the agent socket.
  server.mjs:77-89 only checks the client-supplied Origin header. A non-browser client can simply send 'Origin: http://localhost:5173' and pass. Also, server.listen(PORT) at :1001 has no host argument, so it binds all interfaces, and Windows Firewall will prompt for node.exe. HTTP requests with no Origin are served (:649-650, :667), which exposes /file (images under homedir/tmpdir, FILE_ROOTS :482-499), /stt and /tts (spending the ElevenLabs key), /page, /img and /media to the LAN. The WS can be driven from the LAN with a forged Origin. The plan needs listen(PORT,'127.0.0.1') plus a bearer token for any Kalliope or Electron-main client, not JARVIS_ALLOW_NO_ORIGIN.
- [CONFIRMED] Kalliope neurons are found by convention: kalliope.neurons.<name>.<name>, or <resource_dir>/<name>/<name>.py loaded through imp.load_source. The class must equal name.capitalize() (vas_brain -> Vas_brain). NeuronModule does its work in __init__ and serialize() returns generated_message.
  kalliope/core/Utils/Utils.py:115 package path lowercased, :117-124 resource dir + imp.load_source at :121, :135-136 getattr(mod, module_name.capitalize()), :147-152 klass(**parameters). NeuronModule.py:70-103 __init__ (TTS loaded at :85), :110-121 serialize {'neuron_name','generated_message'}. Reference neuron neurons/say/say.py:1-16, __init__.py 'from .say import Say'. Version kalliope/_version.py version_str='0.7.2', so dna kalliope_supported_version is [0.7].
- [CONFIRMED] There is no default_synapse setting. The catch-all is hooks.on_order_not_found, which runs a synapse in a new LIFO with no parameters, so the neuron must read kalliope_last_order from Cortex. The REST path saves that key after matching (bug); the voice path saves it before.
  HookManager.py:45-46 on_order_not_found; :81-100 start_synapse_by_list_name(list_synapse, new_lifo=True) with no parameters. settings.yml:108-121 hooks with on_order_not_found: 'order-not-found-synapse' (brain.yml:17-26, French replies). default_synapse appears only as a legacy attribute in Tests/test_api/base.py:41 and in docs/api/synapses.md:262,337 sample output. synapses_views.py:259-262 run_matching_synapse_from_order, then :264 Cortex.save('kalliope_last_order'). signals/order/order.py:184 saves before analysis. Also HookManager.py:22-30: on_triggered sends Google Analytics tracking when a tracker id is set.
- [CONFIRMED] Kalliope cannot run natively on this Windows 11 / Python 3.14 machine (imp and audioop removed, Linux-only deps, cffi dlopen(None), hard-coded REST port).
  Live check: `python -I -c "import imp"` -> ModuleNotFoundError; `import audioop` -> ModuleNotFoundError (Python 3.14.2 is the only interpreter per py -0p). imp is used at Utils.py:4/121, ConfigurationChecker.py:3/147/188 and snowboydetect.py:26. audioop at stt/SpeechRecognizer.py:19, pyaudio at :25. setup.py:62 'POSIX :: Linux', :63-66 Python 3.6-3.9, :86 ansible, :103 pyalsaaudio. OrderListener.py:39/85 ffi.dlopen(None). FlaskAPI.py:80 WSGIServer(('', 5000)), which ignores rest_api.port and binds all interfaces, with default admin/secret at settings.yml:126-132.
- [CONFIRMED] setup.mjs spawnSync('claude') fails on Windows. The bridge does not need the global CLI because the SDK uses its bundled claude.exe.
  scripts/setup.mjs:41 spawnSync('claude', ['--version']) with no shell. Get-Command claude -All resolves only to C:\Users\Aswin\AppData\Roaming\npm\claude.ps1, claude.cmd and claude (sh shim), and no .exe is on PATH. The bridge never sets pathToClaudeCodeExecutable (grep finds none; sdk.d.ts:1727-1730 'Uses the built-in executable'). node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe is present (265,720,480 bytes; SDK manifest.json version 2.1.220). Electron packaging must unpack it from asar.
- [CONFIRMED] JARVIS_EFFORT defaults to 'high' while the comment says 'medium'. bridge:writes uses POSIX env syntax. start.mjs spawns 'node' by name and uses kill('SIGTERM').
  server.mjs:116-122 (comment says medium, code says 'high'). package.json:18 'JARVIS_ALLOW_WRITES=1 node bridge/server.mjs'. scripts/start.mjs:47 --writes, :108 JARVIS_ALLOW_WRITES, :110 JARVIS_ALLOWED_ORIGINS, :117 run('bridge','node',...), :120 process.execPath for vite, :84 c.kill('SIGTERM'), :93 SIGTERM handler, :34-35/117/120 relative paths.
- [CONFIRMED] Client-side DISK_PATH rewriting is POSIX-only. page.mjs does listen for the {jarvis:'scroll'} postMessage (the voice explorer had left this open).
  src/ui/sanitise.ts:21-22, src/ui/Blades.tsx:45-46 and src/scene/Orbits.tsx:33-34 all use /^\/(Users|home|root|...|data)\// with no drive-letter form. bridge/page.mjs:56 `if (!d || d.jarvis !== 'scroll') return` and :65 posts {jarvis:'ready'}, matching Blades.tsx:278. index.html:54-61 CSP hard-codes localhost:8787 / 127.0.0.1:8787 and :65 has the J.A.R.V.I.S. title.
- [CONFIRMED] Collab-main is the existing git repository, and Kalliope sits elsewhere.
  Neither is a git repo. A find under C:\Users\Aswin\Downloads\Collab-main found no .git, .gitignore, .env*, .oxlintrc* or CLAUDE.md. Collab-main contains only Collab-main/README.md (8 bytes) -> collabb-main/README.md (9 bytes) -> jarvis-main. kalliope-master\kalliope-master has .gitignore and .github but no .git, and lives outside Collab-main (it is this session's primary working directory). So 'the existing repository' for the new neuron is ambiguous and needs confirming with the user.

## missing
Plan-relevant items none of the three maps covered, or covered incorrectly:

1. Security and network exposure:
- server.mjs:1001 calls server.listen(PORT) with no host, so it binds all interfaces. A desktop app must listen on 127.0.0.1.
- The Origin header is forgeable by any native client (server.mjs:77-89), so it is not an auth boundary. A Kalliope neuron or Electron-main client should use a bearer token, not JARVIS_ALLOW_NO_ORIGIN=1.
- The CLI auto-approves harmless Bash without calling canUseTool (server.mjs:1127-1130, 1259-1263). App-launch permissions must be enforced inside the tool handler, and Bash/PowerShell should be added to disallowedTools if they must be fully off. The bridge sets no allowedTools or disallowedTools.

2. Persistence:
- The SDK's persistSession defaults to true (sdk.d.ts:1580-1587), so transcripts, including text from signed-in pages, are written to ~/.claude/projects/C--Users-Aswin/.
- resume, continue and sessionId (sdk.d.ts:1803, 1385, 1809) are the ready-made route to cross-session memory. Otherwise set persistSession:false.

3. Tool-naming gotcha: EFFECTFUL_VERB is unanchored (server.mjs:235-236), so planned names like 'recall' (contains 'call'), 'get_app_type' ('type') or 'update_profile' get vetoed unless the new server key is allowed explicitly before line 282, the way jarvis_chrome is at :275.

4. Shared state across sessions:
- chrome.mjs:266 `link` and :369 `activeTab` are module-level singletons. A second WS client (Kalliope neuron or Electron main) shares the same Chrome tab and the same serialized call queue.
- The ask handler (server.mjs:1420-1431) re-tags `answering` immediately when a second ask arrives without an interrupt, so frames of the running turn get mislabelled. A headless client must send one ask at a time and wait for 'done', or interrupt first.
- vision.mjs capture requests go through ask() with a 20-45 s timeout (server.mjs:1102-1114), and a headless client must reply or refuse them.

5. Chrome tool coverage: this Claude Code session exposes more claude-in-chrome tools than chrome.mjs wraps: list_connected_browsers, select_browser, switch_browser, javascript_tool, shortcuts_list/execute, file_upload, upload_image, gif_creator. chrome.mjs only wraps tabs_context_mcp, navigate, read_page, get_page_text, find, computer, console, network, form_input and tabs_create/close (chrome.mjs:553-799).
- Multi-browser selection may matter once the Windows pipe works.
- Still unverified (I did not call them, read-only): whether the pipe accepts the frame without client_id, whether a second client can attach while Claude Code CLI/Desktop is connected, and whether tabs_context_mcp returns only the MCP tab group.

6. Tooling and config:
- jarvis-main has no tests: no test script (package.json:11-20) and no test files. Kalliope has unittest suites under Tests/.
- Lint is 'oxlint' (package.json:15) with no config file.
- tsc only covers src and vite.config.ts (tsconfig.app.json include ['src'], tsconfig.node.json include ['vite.config.ts']). bridge/*.mjs and scripts/*.mjs are not type-checked, and tsconfig.app.json has no 'strict'.
- Build is 'tsc -b && vite build' with noUnusedLocals.
- jarvis-main has no .env.example, .env.local, .gitignore or CLAUDE.md, although README.md:220-221 tells users to copy .env.example. The bridge has no dotenv.
- README has no Windows instructions.
- Electron is not a dependency (package.json:21-52).

7. Platform handling:
- There is no process.platform branch anywhere in jarvis-main outside node_modules.
- child_process appears only in scripts/start.mjs:13 and scripts/setup.mjs:9, never in bridge/.
- vite.config.ts sets no server.host (localhost only) and no base.

8. ~/.claude.json dependency (key names checked only; no secrets read or printed):
- It is read once at boot for MCP servers (server.mjs:161-176) and on every request for the ElevenLabs key (server.mjs:448-458).
- On this machine the global mcpServers contains only 'github', which currently fails auth with HTTP 401 per this session's MCP status. So /health reports stt:false and tts:false, and in Electron the keyless STT path has nothing to fall back on. A local STT or an ElevenLabs key is required.
- SDK auth relies on the Claude Code login (setup.mjs:53).

9. Kalliope extras:
- Version is 0.7.2 (kalliope/_version.py).
- The default brain and settings are French (brain.yml:1-44; the STT language is fr-FR).
- on_triggered sends Google Analytics when a tracker id is set (HookManager.py:22-30).
- `kalliope install` requires Ansible plus sudo, so a neuron must be copied in by hand.

10. Ambiguity to raise with the user: neither folder is a git repo, and Kalliope is outside Collab-main. 'A new neuron in the existing repository' could mean (a) a Kalliope Python neuron, which cannot run natively here without Python 3.11 or older plus patches, or WSL; or (b) a new in-process MCP 'neuron' module in jarvis-main/bridge, which is the natural fit.