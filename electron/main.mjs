/**
 * VAS — the desktop app around JARVIS.
 *
 * One window (the face), one tray icon, one global hotkey, and the bridge (the
 * brain) running beside them as a supervised utility process. Nothing is
 * served on the network and nothing opens in a browser: the face loads from
 * app://vas, and talks to the bridge on loopback with a per-launch token.
 *
 *   npm run dev    # Vite + this, with live reload
 *   npm run app    # build the face, then run this against dist/
 */
import { BrowserWindow, Menu, app, globalShortcut, ipcMain, session, shell } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { APP_ORIGIN, registerAppScheme, serveApp } from './protocol.mjs'
import { startBridgeHost } from './bridge-host.mjs'
import { createTray, trayIconPath } from './tray.mjs'
import { loadConfig } from '../bridge/store/config.mjs'
import { dataDir } from '../bridge/store/files.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = join(here, '..')
const DEV_URL = process.env.VAS_DEV_URL || null
const START_HIDDEN = process.argv.includes('--hidden')

// One VAS at a time: a second launch just brings the first one forward.
if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}
app.setAppUserModelId('com.aswin.vas')
registerAppScheme()

let win = null
let tray = null
let bridge = null
let quitting = false
let listening = true
let hotkey = null

/** The origins allowed to be the face: our scheme, or the dev server. */
const trusted = (url) => {
  if (!url) return false
  try {
    const origin = new URL(url).origin
    return url.startsWith(`${APP_ORIGIN}/`) || origin === APP_ORIGIN || (DEV_URL && origin === new URL(DEV_URL).origin)
  } catch {
    return false
  }
}

function showWindow() {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function toggleWindow() {
  if (!win) return
  if (win.isVisible() && win.isFocused()) win.hide()
  else showWindow()
}

async function quit() {
  quitting = true
  globalShortcut.unregisterAll()
  bridge?.stop()
  tray?.destroy()
  app.quit()
}

/**
 * Locks on the window's browser session.
 *
 * - The bridge token rides on every request to the bridge, added here so the
 *   page never has to (and <img>/<iframe> loads, which cannot set headers,
 *   are covered too).
 * - Permissions: the microphone and camera (and the loopback access newer
 *   Chromium asks about) for our own origin only; everything else is refused.
 */
function installSessionGuards() {
  const ses = session.defaultSession
  ses.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (details, callback) => {
    if (bridge && details.url.startsWith(`${bridge.state.http}/`)) {
      details.requestHeaders['x-vas-token'] = bridge.state.token
    }
    callback({ requestHeaders: details.requestHeaders })
  })
  const ALLOWED = new Set(['media', 'local-network-access', 'local-network', 'loopback-network'])
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    callback(ALLOWED.has(permission) && trusted(details?.requestingUrl ?? wc.getURL()))
  })
  ses.setPermissionCheckHandler((_wc, permission, origin) => ALLOWED.has(permission) && trusted(origin))
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    show: !START_HIDDEN,
    title: 'VAS',
    icon: join(ROOT, 'build', 'icon.png'),
    backgroundColor: '#03080c',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      // JARVIS has to keep listening while the window is hidden in the tray.
      backgroundThrottling: false,
      // He also has to be able to speak without a click first.
      autoplayPolicy: 'no-user-gesture-required',
    },
  })

  const wc = win.webContents
  // Links the model shows open in the real browser, never inside VAS.
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  wc.on('will-navigate', (event, url) => {
    if (!trusted(url)) event.preventDefault()
  })
  wc.on('will-attach-webview', (event) => event.preventDefault())
  if (!app.isPackaged) {
    wc.on('before-input-event', (_e, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') wc.toggleDevTools()
    })
    // In development the face's console goes to the terminal too, so a broken
    // boot is visible without opening DevTools in a window that may be hidden.
    wc.on('console-message', (event) => {
      const level = event.level ?? 'log'
      if (level === 'debug') return
      console.log(`[face:${level}] ${event.message}`)
    })
  }

  win.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    win.hide()
  })

  // The bridge asks before using the camera while nobody can see the window.
  const reportVisibility = () => bridge?.setWindowHidden(!win.isVisible() || win.isMinimized())
  for (const event of ['show', 'hide', 'minimize', 'restore']) win.on(event, reportVisibility)

  void win.loadURL(DEV_URL ?? `${APP_ORIGIN}/index.html`)
}

function registerHotkey(accelerator) {
  const candidates = [accelerator, 'Control+Alt+Space', 'Control+Alt+J'].filter(Boolean)
  for (const key of [...new Set(candidates)]) {
    try {
      if (globalShortcut.register(key, () => win?.webContents.send('vas:hotkey'))) return key
    } catch {
      /* malformed accelerator in config — try the next */
    }
  }
  return null
}

ipcMain.on('vas:boot', (event) => {
  event.returnValue = {
    bridge: { ws: bridge.state.ws, http: bridge.state.http, token: bridge.state.token },
    startHidden: START_HIDDEN,
    version: app.getVersion(),
    hotkey,
  }
})
ipcMain.on('vas:listening', (_event, on) => {
  listening = Boolean(on)
  tray?.refresh()
})
ipcMain.on('vas:quit', () => void quit())
ipcMain.on('vas:show', () => showWindow())

app.on('second-instance', showWindow)
app.on('before-quit', () => {
  quitting = true
})
app.on('will-quit', () => globalShortcut.unregisterAll())
// A tray app lives on with no windows open.
app.on('window-all-closed', () => {})

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null)
  serveApp(join(ROOT, 'dist'))
  installSessionGuards()

  bridge = startBridgeHost({ root: ROOT })
  bridge.onListening(({ moved }) => {
    // The face holds the bridge address from boot; if a restart had to take a
    // new port, a reload hands it the new one.
    if (moved) win?.webContents.reload()
  })
  try {
    await bridge.start()
  } catch (err) {
    console.error('[vas] bridge failed to start:', err)
  }

  const config = await loadConfig().catch(() => null)
  hotkey = registerHotkey(config?.hotkey)

  createWindow()
  tray = createTray({
    iconPath: trayIconPath(here),
    dataDir: dataDir(),
    isListening: () => listening,
    onToggleWindow: toggleWindow,
    onSetListening: (on) => {
      listening = on
      win?.webContents.send('vas:tray', { cmd: 'listening', value: on })
    },
    onEnroll: () => {
      showWindow()
      win?.webContents.send('vas:tray', { cmd: 'enroll' })
    },
    onRestartBrain: () => bridge.restart(),
    onQuit: () => void quit(),
  })
  if (!hotkey) tray.tray.displayBalloon?.({ title: 'VAS', content: 'The push-to-talk hotkey is taken by another app. Say "Hey Jarvis" instead.' })
})
