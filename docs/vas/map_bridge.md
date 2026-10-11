## summary
The brain is one Node process, bridge/server.mjs. It serves HTTP and a WebSocket on the same port, PORT = JARVIS_BRIDGE_PORT, default 8787 (server.mjs:31, 663, 968-1001). Each WebSocket connection gets its own Claude Agent SDK query() (server.mjs:1193-1280). The prompt is an async generator that yields user messages as {type:'ask'} frames arrive (1056-1070, 1406-1432), so one SDK session lasts as long as the socket does. Nothing is persisted: there is no resume, sessionId or memory option, and session.close() runs on disconnect (1457-1462).
Options passed to query():
- model = JARVIS_MODEL ?? 'claude-opus-5' (105, 1247)
- effort = JARVIS_EFFORT ?? 'high' (122, 1248). The comment above it still says 'medium'.
- maxTurns 24, permissionMode 'default', includePartialMessages true (1249-1254)
- systemPrompt = a custom JARVIS persona string, not the claude_code preset (293-439, 1222)
- cwd = homedir() (1225)
- settingSources: [] (1238). No ~/.claude/settings.json, no CLAUDE.md, no allow-rules.
- No allowedTools or disallowedTools at all. Every permission decision goes through canUseTool -> decideTool(toolName) (1264-1278). It returns {behavior:'allow'} or {behavior:'deny', message:'Blocked: JARVIS is running in read-only mode...'}.
- mcpServers = everything in ~/.claude.json global mcpServers, plus projects[homedir()].mcpServers (161-176), plus 4 in-process SDK servers (1200-1217): jarvis (panels.mjs: display, blade, probe_url), jarvis_ui (ui.mjs: ui_* theme tools), jarvis_chrome (chrome.mjs) and jarvis_eyes (vision.mjs: look, watch).
The single master switch is JARVIS_ALLOW_WRITES=1 (99). It gates built-in Bash, Write and Edit, effectful MCP tools, and whether chrome.mjs builds its click/type tools at all (chrome.mjs:727).
Chrome access is not CDP, not --remote-debugging-port, not Playwright, and not a separate profile. chrome.mjs connects straight to the local IPC endpoint of Claude Code's own "Claude in Chrome" native messaging host (extension fcoeoabgfenejglbffodgkkbkcdhcgfn). It skips Anthropic's cloud relay and speaks the host's private framing: a 4-byte little-endian length, then JSON {method:'execute_tool', params:{tool,args}} (chrome.mjs:21-47, 204-263). That means it drives the user's real, signed-in Chrome.
It looks for the endpoint only as a POSIX Unix socket under /tmp/claude-mcp-browser-bridge-<user>/*.sock (chrome.mjs:56, 84-105). On Windows the native host listens on the named pipe \\.\pipe\claude-mcp-browser-bridge-<username> instead. That pipe exists on this machine right now (\\.\pipe\claude-mcp-browser-bridge-Aswin), so Chrome control is currently broken on Windows until findSocket() is fixed.
page.mjs and net.mjs do not touch Chrome. They fetch pages server-side with no cookies, behind an SSRF gate, to render /page reader or live blades and probe_url. vision.mjs is the webcam in the face, reached over a WebSocket request/reply.
No OS or app-launch tools exist. The only system-level reach is the SDK's built-in Bash/PowerShell, which is denied unless writes are on.
Wake word detection is a regex over transcripts (src/lib/voice.ts:81). Porcupine is declared in config only (src/config.ts:154-158) and never imported. STT is ElevenLabs Scribe via POST /stt (server.mjs:894-962), with the browser's SpeechRecognition as the fallback.

## extension_points
1. Pattern to copy for a new in-process tool such as open_app. It is the SDK's own API, used the same way in chrome.mjs:1-2, vision.mjs:1-2, panels.mjs:1-2 and ui.mjs.
   import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
   import { z } from 'zod'
   export function systemServer({ allowWrites, ask }) {
     return createSdkMcpServer({
       name: 'vas_os', version: '1.0.0',
       instructions: '...',
       alwaysLoad: true,
       tools: [
         tool('open_app', 'desc', { app: z.string().describe('...') }, async (args) => ({ content: [{ type: 'text', text: 'Opened.' }] })),
       ],
     })
   }
   - Signature: tool(name, description, zodRawShape, handler(args, extra) => Promise<CallToolResult>, extras?{annotations, searchHint, alwaysLoad}), from node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:6940-6944. createSdkMcpServer({name, version, instructions, alwaysLoad, tools}) is at sdk.d.ts:482-503.
   - Use loose schemas: .optional().catch(undefined), unions of number and string (chrome.mjs:499-526).
   - Return errors as {isError:true, content:[{type:'text', text: a plain sentence the model can speak}]} (chrome.mjs:481-491, vision.mjs:101-111).
   - Images come back as {type:'image', data: base64, mimeType} (vision.mjs:133-137).

2. Register the server in server.mjs inside the mcpServers object at 1200-1217, next to jarvis_chrome (1214) and jarvis_eyes (1216). Example: vas_os: systemServer({ allowWrites: ALLOW_WRITES, ask }).
   - ask() is in scope per connection (1102-1114).
   - The key becomes the mcp__<key>__ prefix.

3. Permissions. decideTool (255-291) must name the new server explicitly. Otherwise:
   - 'open_app' has no READ_VERB, so it falls to ALLOW_WRITES (288).
   - 'launch_app' hits EFFECTFUL_VERB 'launch' (236), so it also needs ALLOW_WRITES.
   Options:
   a. Mirror jarvis_chrome. Return true for the server at 266-280, and do the gating inside the server: build the risky tools only when allowWrites (chrome.mjs:727), and/or check a per-app allowlist file (for example ~/.vas/permissions.json) inside the handler.
   b. Add a confirmation round-trip. Reuse ask(kind, args, timeoutMs) (1102-1114) with a new kind such as 'confirm'. Handle it in src/lib/bridge.ts next to 'capture' (184-205) and reply {type:'reply', id, approved:true/false}. That gives a real permission model with on-screen or voice yes/no, not just the global env flag.
   - canUseTool (1264-1278) is the last gate. Per its own comment (1259-1263), the CLI can auto-approve some calls without ever asking it, so enforce inside the tool handler, not only in decideTool.
   - The deny message text is at 1273-1276.
   - Badge suppression for UI-only tools is in announceTool (1177-1181).

4. Windows app launching: there is no existing helper, and no child_process anywhere in bridge/ (grep). For the plan, prefer execFile or spawn with an allowlist that maps friendly names to exe paths, or Start-Process via powershell.exe -NoProfile -Command with an argument array. Never pass model text to a shell string. You can resolve installed apps from Start Menu .lnk files under %ProgramData% and %AppData%\Microsoft\Windows\Start Menu\Programs, or with Get-StartApps. The built-in Bash and PowerShell tools exist but go through WRITE_BUILTINS / the default branch (139-142, 290) and are all-or-nothing.

5. Chrome:
   - Fix transport. In chrome.mjs findSocket() (84-105), return `\\\\.\\pipe\\claude-mcp-browser-bridge-${userInfo().username}` when process.platform === 'win32'. net.createConnection(path) at 178 accepts pipe paths. chromeAvailable() (817-819) and chrome_status (562) also depend on findSocket.
   - Optionally add client_id to the params at 247. The current Claude Code binary sends {method:'execute_tool', params:{client_id:'claude-code', tool, args, session_scope?}}.
   - Add composite read tools such as chrome_search (navigate to a search URL, settle, then get_page_text) or chrome_get_info, modelled on chrome_navigate (594-617), which composes forward() (460-494) with settle() (423-439). Put read tools in the array before 714 and acting ones in the allowWrites block (727-799).
   - Reuse forward(), resolveTab() (442-451), toResult()/clean() (277-353) and samePage() (410-421).

6. Exposing the brain to a Kalliope neuron (Python):
   - Option A: connect as a WebSocket client to ws://localhost:8787/ws, send {type:'ask', text, id}, then read text/done/error frames whose ask field matches the id (1087, 1303, 1346). Native clients send no Origin and are refused (78, 991) unless JARVIS_ALLOW_NO_ORIGIN=1, which also lets any local process in. Each connection is a new SDK session (1193), so keep one socket open for conversational memory.
   - Option B: add an authenticated HTTP endpoint (for example POST /ask with a bearer token from an env var or file) in handleRequest before the 404 at 964. It must do its own auth, because handleRequest serves requests that send no Origin (667-671).

7. Voice and personalisation:
   - STT form fields are at server.mjs:938-944, currently only model_id 'scribe_v1'. Add language_code or vocabulary hints here, or swap in a local Whisper call with an initial prompt carrying the user's names and terms.
   - Wake word regex with misrecognition alternates: src/lib/voice.ts:81. Interrupt regex: voice.ts:270. Rename for VAS and add accent variants.
   - Persona and user profile: SYSTEM_PROMPT (293-439). It could be loaded from a file so it can hold user facts.
   - There is no persistent memory. Options: a remember/recall MCP tool writing JSON under homedir(), or SDK resume/session options in query() (1193-1280).

8. Ports and origins: PORT (31), originAllowed (77-89), JARVIS_ALLOWED_ORIGINS (59). For Electron, add the app's origin here.

## windows_and_desktop_issues
Windows issues, verified on this machine:
1. Chrome control is broken on Windows.
   - chrome.mjs:56 hard-codes SOCKET_DIR '/tmp/claude-mcp-browser-bridge-<user>', and findSocket() (84-105) runs readdir on it. On win32 that becomes C:\tmp\..., which does not exist, so findSocket returns null. Every chrome_* tool reports 'extension not running' and the boot log says 'browser control unavailable' (1016-1022).
   - The real endpoint here is the named pipe \\.\pipe\claude-mcp-browser-bridge-Aswin. It currently exists (found via [IO.Directory]::GetFiles('\\.\pipe\')).
   - The native host is registered at HKCU\Software\Google\Chrome\NativeMessagingHosts\com.anthropic.claude_code_browser_extension -> C:\Users\Aswin\AppData\Roaming\Claude Code\ChromeNativeHost\com.anthropic.claude_code_browser_extension.json. That manifest runs C:\Users\Aswin\.claude\chrome\chrome-native-host.bat, which calls '...\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe --chrome-native-host'.
   - The Claude binary's own logic is: if (platform()==='win32') use `\\.\pipe\claude-mcp-browser-bridge-${username}` (found in node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe strings).
   - The binary skips socket-permission checks on win32.
   - Its callTool also sends params.client_id:'claude-code', which chrome.mjs:247 omits.
   - chrome_key's description example 'cmd+a' (755) should be 'ctrl+a' on Windows.
2. Home-scoped MCP servers are missed. server.mjs:169 looks up cfg.projects?.[homedir()]. On Windows homedir() is 'C:\Users\Aswin', but ~/.claude.json stores 'C:/Users/Aswin' (verified: the forward-slash key hits, the backslash key misses). Normalise both forms.
   - This machine's global mcpServers has only 'github' (http), and that server currently fails auth with a 401.
3. The bridge:writes npm script (package.json:18) uses POSIX syntax 'JARVIS_ALLOW_WRITES=1 node ...', which fails under cmd.exe (npm's default shell on Windows). Use 'npm start -- --writes' (start.mjs:47, 108) or cross-env.
4. setup.mjs:41 spawnSync('claude', ...) without shell returns ENOENT on Windows. Verified: status null, error ENOENT. claude resolves to claude.cmd / claude.ps1 in AppData\Roaming\npm, so setup falsely reports 'Claude CLI not found'. The bridge itself does not need it, because the SDK bundles node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe (265 MB, present).
5. start.mjs:
   - It spawns 'node' by name at 117. That works when node.exe is on PATH, but process.execPath is safer and is already used at 120.
   - kill('SIGTERM') (84) is a hard TerminateProcess on Windows.
   - process.on('SIGTERM') (93) never fires on Windows.
   - It uses relative paths (34-35, 117, 120), so it needs cwd to be the project root.
6. FILE_ROOTS includes '/tmp' (488). On Windows that is C:\tmp, which is harmless.
7. Client-side paths. The src DISK_PATH regexes (src/ui/sanitise.ts:21-22, src/ui/Blades.tsx:45-46, src/scene/Orbits.tsx:33-34) only recognise POSIX roots (/Users, /home, /tmp ...). A Windows path such as C:\Users\... or file:///C:/... is never rewritten to /file?path=, so local images and screenshots will not render.
8. ui.mjs:414 and index.html CSP (lines 54-61) hard-code localhost:8787 / 127.0.0.1:8787. Changing PORT breaks them.
9. The SDK's built-in Bash on Windows depends on Git Bash. A PowerShell built-in, if exposed, falls to decideTool's default ALLOW_WRITES branch (290), which is acceptable.
10. net.mjs:33 PROXY_UA claims to be Mac Chrome 125. Cosmetic.

Electron / desktop concerns:
1. Origins. originAllowed (77-89) only accepts http://localhost, 127.0.0.1 or [::1] on ports 5173-5199 or 4173-4199, plus JARVIS_ALLOWED_ORIGINS, and refuses a missing Origin unless JARVIS_ALLOW_NO_ORIGIN=1.
   - An Electron renderer loaded from file:// sends Origin 'file://' or 'null'. new URL('null') throws -> refused.
   - A custom protocol such as app://vas can be allowed through EXTRA_ORIGINS, because that check runs before the http: protocol check (79 vs 86).
   - Simplest path: load the Vite dev URL in development. In production, serve dist/ over http on an allowed localhost port, or whitelist the custom origin.
2. CSP is a meta tag in index.html (49-61). Its connect-src already allows ws: and wss:, and frame/img/media allow localhost:8787. Keep it, or set it through session.webRequest.
3. Speech. The keyless STT path uses webkitSpeechRecognition (src/lib/voice.ts:593-604). That does not work in Electron, which has no Google speech service key. Electron needs /stt (an ElevenLabs key, server.mjs:894-962) or a local STT such as Whisper or Vosk.
   - The wake word is the transcript regex at voice.ts:81, so it also depends on STT.
   - Porcupine is only mentioned in config (src/config.ts:154-158) and is not imported anywhere in src.
4. Mic and camera. The renderer uses getUserMedia (src/lib/audio.ts:14, src/lib/camera.ts:69). Electron needs session.setPermissionRequestHandler / setPermissionCheckHandler to grant 'media'. On Windows 11, Settings > Privacy > Microphone/Camera 'Let desktop apps access' must be on.
5. The bridge can stay a child process of the Electron main process; spawn it with process.execPath plus ELECTRON_RUN_AS_NODE=1, or with system node. Notes:
   - It uses top-level await (server.mjs:663), so it must stay ESM.
   - The ws dependency is pure JavaScript. There are no native Node addons in the bridge.
   - claude.exe must be unpacked from asar if packaged.

## jarvis_branding
Environment variables (server.mjs unless noted):
- JARVIS_BRIDGE_PORT (31)
- JARVIS_ALLOWED_ORIGINS (59). Also start.mjs:110 and the comment at vite.config.ts:10.
- JARVIS_ALLOW_NO_ORIGIN (64)
- JARVIS_ALLOW_WRITES (99). Also package.json:18 and start.mjs:108.
- JARVIS_MODEL (105)
- JARVIS_EFFORT (122)
- JARVIS_VOICE_ID (460)
- JARVIS_FILE_ROOTS (489)
- JARVIS_DEBUG (1286)
- Log and banner mentions: 1010, 1019.

MCP server keys and names. Renaming these changes the mcp__<key>__ tool prefixes, so decideTool and announceTool must change in step:
- 'jarvis': panels.mjs:322, server.mjs:1202
- 'jarvis_ui': ui.mjs:339, server.mjs:1210
- 'jarvis_chrome': chrome.mjs:802, server.mjs:1214
- 'jarvis_eyes': vision.mjs:75, server.mjs:1216
- decideTool literals: 266, 275, 280
- announceTool literals 'mcp__jarvis__display' and 'mcp__jarvis_ui__': 1177, 1181

Prompts and model-facing text:
- SYSTEM_PROMPT 'You are JARVIS...' (server.mjs:293). The whole persona block is 293-439.
- Deny message 'Blocked: JARVIS is running in read-only mode' (1274).
- chrome.mjs tool descriptions: 'the tab JARVIS is already working in' (525), 'List the browser tabs JARVIS can act on' (581).
- panels.mjs: 'Put something on the JARVIS heads-up display' (187); instructions (325).
- ui.mjs instructions "JARVIS's control of his own interface" (342).
- The browser-direct prompt 'You are JARVIS, Tony Stark's assistant' (src/config.ts:279).

Log prefix '[jarvis]': server.mjs:40, 626, 669, 973, 988, 993, 1003-1028, 1043, 1266, 1352, 1379, 1385, 1458; panels.mjs:343; src/config.ts:34, 45.

Wake word and voice:
- WAKE regex /(hey|hi|ok|okay|yo)? (jarvis|jarvys|jervis|jarvis's|travis|jarviss|java's|jarv)/ at src/lib/voice.ts:81.
- Interrupt regex that includes 'jarvis' at voice.ts:270.
- Porcupine built-in 'Jarvis' keyword mentioned at src/config.ts:153-154.

User-visible UI and launcher text:
- index.html <title>J.A.R.V.I.S.</title> (65); comment at 17.
- start.mjs: 1, 116 ('J.A.R.V.I.S. starting'), 122-125 ('say "Hey Jarvis"').
- setup.mjs: 2, 23, 35, 72, 75, 102, 108-113.
- package.json: name 'jarvis' (2), description (4).
- README.md: 26 mentions.

Cross-file protocol keys: page.mjs SCROLL_SHIM {jarvis:'scroll'} / {jarvis:'ready'} (56, 65) must match the listener in src/ui/Blades.tsx.

Other src files with mentions (grep counts): App.tsx 15, store.ts 15, config.ts 9, voice.ts 9, tts.ts 7, Hud.tsx 6, bridge.ts 6, music.ts 6, kokoro.ts 5, anthropic.ts 5, and others. 235 occurrences in 42 files in total, excluding node_modules.

## open_questions
1. Does the Windows native-host pipe accept the exact framing and the {method:'execute_tool', params:{tool,args}} message without client_id? The current Claude Code binary sends client_id:'claude-code' and an optional session_scope. This needs a live test after the findSocket fix.
2. Can a second client (the bridge) share the single named pipe while Claude Code CLI or Desktop is also connected? On POSIX each host instance gets its own pid socket; on Windows there is one pipe name.
3. Does tabs_context_mcp return all of the user's open Chrome tabs, or only the extension's MCP tab group? chrome.mjs:581 implies 'tabs JARVIS can act on'. If it is the group only, then 'read whatever is on my current tab' needs a different approach.
4. chrome_navigate and resolveTab(createIfEmpty:true) run in read-only mode. Is opening logged-in pages an acceptable no-confirm action under VAS's permission model? GET requests to authenticated sites can have side effects.
5. Is the user's Claude account entitled to Claude-in-Chrome? chrome_find notes that some accounts fail with a permission error (chrome.mjs:651-655).
6. Is there an ElevenLabs key on this machine? /health reports stt/tts from it, but ~/.claude.json has no elevenlabs server (only github). Without a key, Electron has no working STT path, since SpeechRecognition is unavailable there.
7. Does ElevenLabs Scribe accept vocabulary or keyterm biasing beyond language_code? Check their docs before relying on it for 'understand my voice better'. Local Whisper with an initial prompt is the fallback.
8. For the Kalliope 'neuron', should the neuron call the bridge (a Python WebSocket or HTTP client to localhost:8787), or should the bridge gain a Kalliope-triggered endpoint? It depends on the Kalliope side, which was not explored here.
9. The effort default is 'high' (server.mjs:122) but the comment describes 'medium'. Confirm the intended value for voice latency.
10. claude-opus-5 as the default model (105): confirm the model is available on the user's plan.

## key_files
### C:\Users\Aswin\Downloads\Collab-main\Collab-main\collabb-main\jarvis-main\bridge\server.mjs
The brain: SDK query() per WebSocket connection, permission policy, HTTP endpoints, WebSocket protocol, persona prompt
PORT (31): JARVIS_BRIDGE_PORT or 8787.
unhandledRejection logger (39-41).
EXTRA_ORIGINS / ALLOW_NO_ORIGIN / LOCAL_HOSTS / isDevPort / originAllowed (58-89). Allows EXTRA_ORIGINS (JARVIS_ALLOWED_ORIGINS, comma-separated) first. Otherwise requires the http: protocol, host localhost, 127.0.0.1 or [::1], and port 5173-5199 or 4173-4199. A missing Origin is allowed only if JARVIS_ALLOW_NO_ORIGIN=1.
ALLOW_WRITES (99). MODEL (105). EFFORT (122).
READ_ONLY_BUILTINS (132-138): Read, Glob, Grep, WebFetch, WebSearch, TodoWrite, Task, Agent, ToolSearch, List/ReadMcpResource(Tool), BashOutput, TaskOutput.
WRITE_BUILTINS (139-142): Bash, Write, Edit, MultiEdit, NotebookEdit, KillShell, TaskStop.
configuredServers()/MCP_SERVERS (161-176): reads ~/.claude.json mcpServers plus projects[homedir()].mcpServers.
mcpServerOf / mcpToolOf (179-183): parse mcp__server__tool.
READ_ONLY_MCP allowlist (207-220): exa, exa-code, serper, serpapi, lottie-search, mcp-registry, openrouter, openrouter-image, Microsoft_Clarity, higgsfield, heygen, elevenlabs.
READ_VERB (227-228): anchored regex get|list|read|search|find|query|fetch|check|describe|inspect|show|view|explain|screenshot.
EFFECTFUL_VERB (235-236): unanchored regex send|call|post|create|delete|remove|update|edit|write|install|launch|tap|swipe|press|type|buy|pay|charge|publish|deploy|outbound|download.
VETO_EXEMPT (250-253): openrouter__send-message, openrouter__send-feedback.
decideTool(name) (255-291), in order:
1. READ_ONLY_BUILTINS -> allow.
2. WRITE_BUILTINS -> ALLOW_WRITES.
3. MCP server jarvis or jarvis_ui -> allow (266). jarvis_chrome -> allow, because it gates itself when built (275). jarvis_eyes -> allow (280).
4. If the tool name matches EFFECTFUL_VERB and is not VETO_EXEMPT -> ALLOW_WRITES (283-285). The veto also applies to allowlisted servers.
5. READ_ONLY_MCP or a server name starting ccd_session -> allow (287).
6. Else READ_VERB match -> allow, otherwise ALLOW_WRITES (288).
7. Any other non-MCP tool name (for example a built-in PowerShell tool) -> ALLOW_WRITES (290).
SYSTEM_PROMPT (293-439). Key persona lines:
- 293: 'You are JARVIS. You are speaking out loud to one person.'
- 295: 'Two sentences is the ceiling in conversation'
- 305-311: positional 'sir'; 311 'Never use their name.'
- 329-330: 'Never refuse. State a constraint once...'
- 340: 'BRITISH SERVICE REGISTER'
- 350-370: blades are the only display surface.
- 386-409: 'Their browser — ALWAYS the chrome_* tools, first'; 'Chrome is your HANDS, not your display'; 'NEVER use playwright, puppeteer'; 407: 'Before anything that sends, buys, deletes or posts, say in one sentence what you are about to do.'
- 411-427: camera rules.
- 429-439: tool-use rules (no narration, no URLs spoken).
elevenKey() (448-458): ELEVENLABS_API_KEY env, or ~/.claude.json mcpServers.elevenlabs.env.
VOICE_ID (460): JARVIS_VOICE_ID, default 'JBFqnCBsd6RMkjVDRZzb'.
IMAGE_TYPES / FILE_ROOTS / withinRoots (469-506). Roots are homedir, tmpdir, '/tmp' and JARVIS_FILE_ROOTS.
proxyRemote (552-639).
corsFor (652-660): reflects the Origin.
handleRequest (665-966): refuses unknown Origins with 403, but serves requests that send no Origin (667).
- GET /health (679-688) -> {ok, tts, stt}, both true when an ElevenLabs key exists.
- GET /file?path= (693-733): images only, under FILE_ROOTS, realpath'd, 25 MB cap.
- GET /img?url= (737-751): image proxy.
- GET /media?url= (755-769): video/audio proxy with Range support.
- GET /page?url=&mode=reader|live (779-807): renderPage.
- POST /tts (809-885): JSON {text} -> ElevenLabs eleven_flash_v2_5, streamed mp3.
- POST /stt (894-962): raw audio body -> ElevenLabs scribe_v1 (form fields 938-944) -> {text}.
- Otherwise 404 (964).
WebSocketServer verifyClient (979-999): path must be '/' or '/ws', and the origin must pass originAllowed.
server.listen(PORT) (1001). Boot banner and chromeAvailable() log (1003-1028).
RESULT_FAILURES (1034-1040).
WebSocket protocol:
- On connect the bridge sends {type:'ready', servers:[names]} (1047-1049). A second 'ready' with live status follows the SDK init message (1372-1380).
- Inbound from the face: {type:'ask', text, id} queued behind any interrupt (1406-1432); {type:'reply', id, ...} resolving an ask() request (1434-1441); {type:'interrupt'} -> session.interrupt() plus a settle wait (1443-1454).
- Outbound to the face: {type:'text', delta, ask} (1303); {type:'tool', name, ask} (1182, 1190); {type:'done', text, costUsd, ask} (1346-1350); {type:'error', message, ask?} (1356-1359, 1386); {type:'panel', panel} and {type:'blade', blade} (1203-1204); {type:'ui', op, args} (1210); {type:'capture', id, mode?, seconds?, when?, reason} sent through ask() (1102-1114).
ask(kind, args, timeoutMs=20000) (1102-1114): generic request/reply to the face, correlated by id.
announceTool / settleTool (1171-1191): drive the HUD tool badge.
Stream pump (1283-1396): stream_event text_delta and tool_use, assistant, user tool_result, result, system init.
Close handling (1457-1462).

### C:\Users\Aswin\Downloads\Collab-main\Collab-main\collabb-main\jarvis-main\bridge\chrome.mjs
jarvis_chrome in-process MCP server. It drives the user's real signed-in Chrome through the Claude-in-Chrome extension's native-host IPC endpoint, bypassing the cloud relay.
Imports createSdkMcpServer, tool and zod (1-2); net.createConnection (3).
SOCKET_DIR = `/tmp/claude-mcp-browser-bridge-${userInfo().username}` (56). POSIX only.
CALL_TIMEOUT_MS 45000 (66). CONNECT_TIMEOUT_MS 3000 (69).
findSocket() (84-105): readdir SOCKET_DIR, picks the newest *.sock and deprioritises 0.sock. Returns null on Windows.
class ChromeLink (116-264): one connection, one request in flight.
- onData (143-166): 4-byte LE length framing, 64 MB sanity cap.
- ensureConnected (168-201).
- request (204-234): writes the framed JSON, 45 s timeout.
- call(name,args) (245-263): sends {method:'execute_tool', params:{tool:name, args}}, serialised on a promise chain, retried once after a reset.
toResult (277-292) / normaliseImage (309-325): Anthropic image block -> MCP {type:'image', data, mimeType}.
clean (341-353): strips <\system-reminder> text from extension replies.
activeTab memory (369). readTab (372-388).
settle(tab,target) (405-439): polls get_page_text until its URL: line matches the target (16 x 400 ms).
resolveTab (442-451): uses tabs_context_mcp {createIfEmpty:true} when no tab is known.
forward(name,{needsTab}) (460-494): fills in tabId and retries on 'no tab available'. Errors come back as a spoken-friendly isError result.
tabId zod schema (519-526): union(number,string).optional().catch(undefined).
chromeServer({allowWrites}) (553-814). Always-on tools:
- chrome_status {} (556-577): checks findSocket, then tabs_context_mcp.
- chrome_tabs {createIfEmpty?} (580-591) -> tabs_context_mcp.
- chrome_navigate {url ('back'/'forward' allowed), tabId?} (594-617) -> navigate + settle.
- chrome_read_page {tabId?, filter? interactive|all, max_chars?} (620-636) -> read_page. Accessibility tree with ref_N.
- chrome_page_text {tabId?, max_chars?} (639-647) -> get_page_text.
- chrome_find {query, tabId?} (650-661) -> find. Runs a model inside the extension and may fail with a permission error.
- chrome_screenshot {tabId?} (664-670) -> computer{action:'screenshot'}. Returns an image.
- chrome_scroll {direction, amount?, tabId?} (673-689) -> computer scroll at [400,400].
- chrome_console {tabId?, onlyErrors?, limit?} (692-701) -> read_console_messages.
- chrome_network {tabId?, urlPattern?, requestId?, limit?} (704-713) -> read_network_requests.
Only when allowWrites (727-799):
- chrome_click {ref?, coordinate?, tabId?} -> computer left_click (730-744).
- chrome_type {text, tabId?} (747-751).
- chrome_key {text, tabId?} (754-758). Its description says 'cmd+a', which is Mac.
- chrome_form_input {ref, value, tabId?} (761-770).
- chrome_new_tab {} -> tabs_create_mcp (773-782).
- chrome_close_tab {tabId} -> tabs_close_mcp (785-797).
createSdkMcpServer({name:'jarvis_chrome', version, instructions, alwaysLoad:true, tools}) (801-813).
chromeAvailable() (817-819).
There is no dedicated search tool; searching means chrome_navigate to a search URL, or the built-in WebSearch. There is no 'list all of the user's open tabs' tool beyond tabs_context_mcp.

### C:\Users\Aswin\Downloads\Collab-main\Collab-main\collabb-main\jarvis-main\bridge\vision.mjs
jarvis_eyes in-process MCP server: the webcam in the face, through server.mjs ask(). The cleanest example of a tool that has to ask the UI and wait.
visionServer(ask) (73-213).
look {reason?} (83-140): ask('capture', {reason}) -> returns [{type:'text'}, {type:'image', data, mimeType}].
watch {seconds?, when? now|past, reason?} (141-210): ask('capture', {mode:'watch', ...}, 45000).
alwaysLoad:true (81).
Error results tell the model what to say (101-111).

### C:\Users\Aswin\Downloads\Collab-main\Collab-main\collabb-main\jarvis-main\bridge\panels.mjs
jarvis in-process MCP server: display, blade and probe_url, which push UI into the face
DESIGN_SYSTEM (21-139).
schema (141-185) for display.
displayServer(emit, emitBlade) (320-427):
- display (331-378): refuses an empty body and emits a markup blade.
- blade {title, kind article|image|gallery|video|embed|markup|camera, url?, images?, html?, mode?, size?, hold?} (380-414).
- probe_url {url} (416-424) -> page.mjs probeUrl.
refuse() helper (429).

### C:\Users\Aswin\Downloads\Collab-main\Collab-main\collabb-main\jarvis-main\bridge\ui.mjs
jarvis_ui in-process MCP server: retints and controls the HUD through {type:'ui'} frames
uiServer(emit) (337-494). Tools: ui_theme (349), ui_reactor (368), ui_orbit (382), ui_chrome (441), ui_effect (456-469), ui_screen (471-486), ui_reset (488).
ui_orbit hard-codes http://localhost:8787 as the only allowed http source (414).

### C:\Users\Aswin\Downloads\Collab-main\Collab-main\collabb-main\jarvis-main\bridge\page.mjs
Server-side page fetch and rewrite for the /page blade (reader or live) and for probe_url. Does not use Chrome or the user's cookies.
SCROLL_SHIM (53-66): postMessage keys {jarvis:'scroll'} and {jarvis:'ready'}.
stripDangerous (89-101). titleOf (137). stripFurniture (155). articleBody (185). readableText (232). toReader (264). toLive (369).
renderPage(url, mode, bridgeOrigin) (394-451): per-response CSP with a nonce.
probeUrl(url) (467-537): returns {kind, title, readableChars, leadImage, excerpt, suggestion}.

### C:\Users\Aswin\Downloads\Collab-main\Collab-main\collabb-main\jarvis-main\bridge\net.mjs
SSRF-guarded outbound HTTP client shared by /img, /media, /page and probe_url
PROXY_UA (33-35): a Mac Chrome 125 user agent.
BLOCKED_HOSTNAME (45). blockedAddress (55-105). guardedLookup (117-136). proxyError (139). vetTarget (150-170). requestOnce (173). openRemote (216). fetchText (248). peek (308).

### C:\Users\Aswin\Downloads\Collab-main\Collab-main\collabb-main\jarvis-main\scripts\start.mjs
npm start: spawns the bridge and the Vite dev server as child processes
vendorWasm() (33-45): copies node_modules/@mediapipe/tasks-vision/wasm to public/mediapipe (relative paths).
writes = argv --writes (47).
run(name, command, args, colour, env) (60-76): spawn with shell:false.
shutdown (79-90): kill('SIGTERM').
SIGINT/SIGTERM handlers (92-93).
PORT -> JARVIS_ALLOWED_ORIGINS (107-112).
run('bridge', 'node', ['bridge/server.mjs']) (117).
run('face', process.execPath, ['node_modules/vite/bin/vite.js']) (120).
Banner says 'open the URL ... in Chrome ... say "Hey Jarvis"' (122-125).

### C:\Users\Aswin\Downloads\Collab-main\Collab-main\collabb-main\jarvis-main\scripts\setup.mjs
npm run setup: advisory preflight, always exits 0
Node version check (27-36).
spawnSync('claude', ['--version']) (41): ENOENT on Windows.
Counts ~/.claude.json mcpServers, global only (57-76).
findElevenLabsKey (79-96).
Prints the run instructions (108-113).

### C:\Users\Aswin\Downloads\Collab-main\Collab-main\collabb-main\jarvis-main\src\lib\bridge.ts
Client side of the WebSocket protocol (outside the bridge folder, but it is the other half of the contract)
Handles ready (171), panel (180), blade (182), capture -> {type:'reply', id, ...} (184-205), ui (206).
Turn stream switch on text, tool, done, error (431-447).
Sends {type:'ask', text, id} (470) and {type:'interrupt'} (488).
BRIDGE_WS_URL default is ws://localhost:8787 (src/config.ts:74).

