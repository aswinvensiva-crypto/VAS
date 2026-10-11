import { protocol } from 'electron'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, relative, isAbsolute } from 'node:path'

/**
 * The face is served from app://vas — our own origin, not file:// and not a
 * localhost web server.
 *
 * file:// would break the build's absolute /assets, /mediapipe and /audio
 * paths, is not a secure context, and gives every page the same opaque origin.
 * A privileged custom scheme behaves like https: secure (so the microphone and
 * AudioWorklet are available), fetch-able, CORS-aware, streamable — and its
 * origin, app://vas, is one the bridge can recognise and nobody else can claim.
 */
export const APP_SCHEME = 'app'
export const APP_HOST = 'vas'
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`

/** Must run before app is ready. */
export function registerAppScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
    },
  ])
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.woff2': 'font/woff2',
  '.onnx': 'application/octet-stream',
  '.task': 'application/octet-stream',
  '.data': 'application/octet-stream',
}

/**
 * Serve the built face from `dist`. Only host "vas"; only files inside dist
 * (a path that normalises outside it is refused, whatever it was encoded as);
 * unknown paths fall back to index.html so client-side routes still load.
 */
export function serveApp(distDir) {
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url)
    if (url.host !== APP_HOST) return new Response('not found', { status: 404 })
    let rel
    try {
      rel = decodeURIComponent(url.pathname)
    } catch {
      return new Response('bad request', { status: 400 })
    }
    const file = normalize(join(distDir, rel === '/' ? 'index.html' : rel))
    const inside = relative(distDir, file)
    if (inside.startsWith('..') || isAbsolute(inside)) return new Response('forbidden', { status: 403 })
    try {
      const body = await readFile(file)
      return new Response(body, {
        headers: { 'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream' },
      })
    } catch {
      if (extname(file)) return new Response('not found', { status: 404 })
      const index = await readFile(join(distDir, 'index.html'))
      return new Response(index, { headers: { 'content-type': MIME['.html'] } })
    }
  })
}
