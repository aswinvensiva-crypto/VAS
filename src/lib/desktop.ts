/**
 * The VAS desktop app, as the face sees it.
 *
 * `window.vas` is put there by the Electron preload and exists only inside the
 * desktop app. Everything that behaves differently there — the token on the
 * bridge connection, booting without a click, the global hotkey, the tray —
 * keys off `desktop` being non-null, so the same build still runs in a plain
 * browser tab for development.
 */
export type TrayCommand = { cmd: 'listening'; value: boolean } | { cmd: 'enroll' }

export interface VasDesktop {
  bridge: { ws: string; http: string; token: string }
  /** Launched at login straight into the tray. */
  startHidden: boolean
  version: string
  /** The push-to-talk shortcut that was actually registered, if any. */
  hotkey: string | null
  onHotkey(fn: () => void): () => void
  onTray(fn: (command: TrayCommand) => void): () => void
  setListening(on: boolean): void
  /** Bring the VAS window to the front. */
  show(): void
  quit(): void
}

declare global {
  interface Window {
    vas?: VasDesktop
  }
}

export const desktop: VasDesktop | null =
  typeof window !== 'undefined' && window.vas ? window.vas : null
