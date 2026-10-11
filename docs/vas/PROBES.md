# Feasibility probe results

Measured on the development laptop (Windows 11, Node 24.14), 2026-10-11.
Re-run with `npm run probe:chrome` and `npm run probe:voice`.

## Claude-in-Chrome native host (`npm run probe:chrome`)

| Question | Answer |
|---|---|
| Endpoint on Windows | Named pipe `\\.\pipe\claude-mcp-browser-bridge-<user>` (not `/tmp/*.sock`) |
| Framing | 4-byte LE length + JSON `{method:'execute_tool', params:{tool,args}}` works as-is |
| `client_id` | Accepted with none, `vas` or `claude-code` |
| Concurrent clients | Two simultaneous connections both answered |
| Tab visibility | `tabs_context_mcp` reports only the extension's own MCP tab group ("No MCP tab groups found"), not every tab — "what's on my current tab" needs the address-bar fallback (plan step 6) |

## Local voice stack (`npm run probe:voice`)

sherpa-onnx 1.13.8, onnxruntime 1.28.2, 4 threads. Clips synthesised at 16 kHz
by two Windows SAPI voices (David, Zira). All engines were called the way
Electron requires (`readWave(f, false)`, `compute(stream, false)`).

**Wake word** (zh-en 3M KWS, phones `HH EY1 JH AA1 R V AH0 S` / `…IH0 S`,
boost 1.5, threshold 0.25): 4/4 hits on "Hey Jarvis" and "Hey Jarvis, open
Spotify" for both voices; 0 false hits on "The service was slow, so Travis
went home early" and on a 5.5 s command. ~40 ms per clip; the keyword ends at
~0.8 s, which is where the command audio starts.

**Whisper** (multilingual int8):

| Model | Load | Per utterance | RTF | Errors on these clips |
|---|---|---|---|---|
| base | 0.7 s | 0.2–0.35 s | 0.06 | "Kochi"→"Cochie/Kachi", "Spotify"→"Spatifiy" (one voice) |
| small | 1.6 s | 0.6–1.1 s | 0.20 | same words wrong |

`language: 'en'` and auto-detect gave identical results on English. Decision:
**base by default**, small selectable in settings. Mixed-language accuracy
still has to be checked on the owner's own voice.

**Speaker embeddings** (CAM++ VoxCeleb, dim 512): clip-to-clip cosine
overlaps (same voice 0.24–0.73, different 0.12–0.84), but against a centroid
enrolled from three clips the owner scores 0.54–0.82 and the other voice
0.30–0.45. Verification therefore works only with centroid enrollment and
length-aware thresholds plus an "unknown" band, as planned; short clips are
the weak case, which is why a confirmation also leans on the owner verdict of
the command that triggered it.

## Native runtime dependencies (installer)

The plan asked the installer to check for the Visual C++ runtime. The DLLs VAS
ships were inspected for the names they import (2026-10-11):

| File | Imports |
|---|---|
| `sherpa-onnx.node` | KERNEL32, node.dll, sherpa-onnx-c-api.dll |
| `sherpa-onnx-c-api.dll` | ADVAPI32, KERNEL32, onnxruntime.dll |
| `onnxruntime.dll` | ADVAPI32, KERNEL32, SETUPAPI, dbghelp, dxcore, dxgi, api-ms-win-core-path |

None import `vcruntime140.dll` or `msvcp140.dll`: the C runtime is linked in
statically. Electron and `claude.exe` carry their own. So no VC++
redistributable check is needed in the installer; if a future sherpa-onnx
build starts importing it, this table is the thing to re-check.
