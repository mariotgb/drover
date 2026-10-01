import { app, Menu, shell, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import { mt } from './i18n'

export function buildMenu(getWindow: () => BrowserWindow | null, command: (cmd: string) => void) {
  const cmd = (id: string) => () => command(id)
  const isMac = process.platform === 'darwin'
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              { label: mt('Settings…'), accelerator: 'Cmd+,', click: cmd('settings') },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const }
            ]
          }
        ]
      : []),
    {
      label: mt('File'),
      submenu: [
        { label: mt('New Agent…'), accelerator: 'CmdOrCtrl+N', click: cmd('new-agent') },
        { label: mt('New Project…'), accelerator: 'CmdOrCtrl+Shift+N', click: cmd('new-workspace') },
        { label: mt('New Terminal Tab'), accelerator: 'CmdOrCtrl+T', click: cmd('new-terminal') },
        { type: 'separator' },
        { label: mt('Attach Files…'), accelerator: 'CmdOrCtrl+Shift+A', click: cmd('attach') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: mt('Edit'),
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: mt('Find Thread…'), accelerator: 'CmdOrCtrl+K', click: cmd('command-palette') }
      ]
    },
    {
      label: mt('View'),
      submenu: [
        { label: mt('Toggle Sidebar'), accelerator: 'CmdOrCtrl+B', click: cmd('toggle-sidebar') },
        { label: mt('Toggle Terminal Panel'), accelerator: 'CmdOrCtrl+J', click: cmd('toggle-terminal') },
        { label: mt('Switch Chat / Terminal'), accelerator: 'CmdOrCtrl+Shift+T', click: cmd('toggle-view') },
        { label: mt('Toggle Preview'), accelerator: 'CmdOrCtrl+Shift+P', click: cmd('toggle-preview') },
        { label: mt('Pick Element in Preview'), accelerator: 'CmdOrCtrl+Shift+C', click: cmd('pick-element') },
        { type: 'separator' },
        { label: mt('Stop Agent'), accelerator: 'CmdOrCtrl+.', click: cmd('interrupt') },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'reload' },
        { role: 'toggleDevTools' }
      ]
    },
    {
      label: mt('Go'),
      submenu: [
        { label: mt('Next Thread'), accelerator: 'CmdOrCtrl+]', click: cmd('next-thread') },
        { label: mt('Previous Thread'), accelerator: 'CmdOrCtrl+[', click: cmd('prev-thread') },
        { label: mt('Next Needing Attention'), accelerator: 'CmdOrCtrl+Shift+]', click: cmd('next-attention') },
        { type: 'separator' },
        ...Array.from({ length: 9 }, (_, i) => ({
          label: mt('Thread {n}', { n: i + 1 }),
          accelerator: `CmdOrCtrl+${i + 1}`,
          click: cmd(`thread-${i + 1}`)
        }))
      ]
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: mt('herdr Documentation'), click: () => void shell.openExternal('https://herdr.dev') },
        {
          label: mt('Show Window'),
          click: () => {
            const w = getWindow()
            w?.show()
            w?.focus()
          }
        }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
