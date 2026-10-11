/**
 * The only bridge between the VAS window and the desktop. Sandboxed preload,
 * so CommonJS and nothing but contextBridge/ipcRenderer.
 *
 * `window.vas` exists only inside the desktop app; the face checks for it to
 * know it is running there (token-authenticated bridge, hotkey, tray) rather
 * than in a browser tab.
 */
const { contextBridge, ipcRenderer } = require('electron')

// Synchronous on purpose: the face reads the bridge address while its modules
// load. The window is created only after the bridge is listening, so this
// answers immediately.
const boot = ipcRenderer.sendSync('vas:boot')

const subscribe = (channel, fn) => {
  const handler = (_event, payload) => fn(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld('vas', {
  bridge: boot.bridge,
  startHidden: boot.startHidden,
  version: boot.version,
  hotkey: boot.hotkey,
  onHotkey: (fn) => subscribe('vas:hotkey', () => fn()),
  onTray: (fn) => subscribe('vas:tray', fn),
  setListening: (on) => ipcRenderer.send('vas:listening', Boolean(on)),
  quit: () => ipcRenderer.send('vas:quit'),
})
