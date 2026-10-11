import { Menu, Tray, app, nativeImage, shell } from 'electron'
import { join } from 'node:path'

/**
 * The tray icon: VAS's home when the window is hidden, which is most of the
 * time. Clicking it shows or hides the window; the menu holds the few things
 * worth doing without opening it.
 */
export function createTray({ iconPath, dataDir, isListening, onToggleWindow, onSetListening, onEnroll, onRestartBrain, onQuit }) {
  const tray = new Tray(nativeImage.createFromPath(iconPath))
  tray.setToolTip('VAS — say "Hey Jarvis" or press Ctrl+Alt+Space')

  const build = () =>
    Menu.buildFromTemplate([
      { label: 'Show / hide VAS', click: onToggleWindow },
      { type: 'separator' },
      {
        label: 'Listening for "Hey Jarvis"',
        type: 'checkbox',
        checked: isListening(),
        click: (item) => onSetListening(item.checked),
      },
      {
        label: app.isPackaged ? 'Start with Windows' : 'Start with Windows (installed app only)',
        type: 'checkbox',
        enabled: app.isPackaged,
        checked: app.isPackaged && app.getLoginItemSettings().openAtLogin,
        click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] }),
      },
      { label: 'Learn my voice…', click: onEnroll },
      { type: 'separator' },
      { label: 'Open data folder', click: () => void shell.openPath(dataDir) },
      { label: 'Restart JARVIS', click: onRestartBrain },
      { type: 'separator' },
      { label: 'Quit VAS', click: onQuit },
    ])

  tray.setContextMenu(build())
  tray.on('click', onToggleWindow)
  return {
    tray,
    refresh: () => tray.setContextMenu(build()),
    destroy: () => tray.destroy(),
  }
}

export const trayIconPath = (here) => join(here, 'assets', 'tray.png')
