import { app, Menu, shell, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import { mt } from './i18n'
import { appAccelerator } from './platform'

export function buildMenu(getWindow: () => BrowserWindow | null, command: (cmd: string) => void) {
  const cmd = (id: string) => () => command(id)
  const isMac = process.platform === 'darwin'
  const accelerator = (key: string) => appAccelerator(process.platform, key)
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
        { label: mt('New Agent…'), accelerator: accelerator('N'), click: cmd('new-agent') },
        { label: mt('New Project…'), accelerator: accelerator('Shift+N'), click: cmd('new-workspace') },
        { label: mt('New Terminal Tab'), accelerator: accelerator('T'), click: cmd('new-terminal') },
        { type: 'separator' },
        { label: mt('Attach Files…'), accelerator: accelerator('Shift+A'), click: cmd('attach') },
        ...(process.platform === 'linux' ? [{ label: mt('Settings…'), accelerator: 'Ctrl+,', click: cmd('settings') }] : []),
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
        { label: mt('Find Thread…'), accelerator: accelerator('K'), click: cmd('command-palette') }
      ]
    },
    {
      label: mt('View'),
      submenu: [
        { label: mt('Toggle Sidebar'), accelerator: accelerator('B'), click: cmd('toggle-sidebar') },
        { label: mt('Toggle Terminal Panel'), accelerator: accelerator('J'), click: cmd('toggle-terminal') },
        { label: mt('Switch Chat / Terminal'), accelerator: accelerator('Shift+T'), click: cmd('toggle-view') },
        { label: mt('Toggle Preview'), accelerator: accelerator('Shift+P'), click: cmd('toggle-preview') },
        { label: mt('Pick Element in Preview'), accelerator: accelerator('Shift+C'), click: cmd('pick-element') },
        { type: 'separator' },
        { label: mt('Stop Agent'), accelerator: accelerator('.'), click: cmd('interrupt') },
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
        { label: mt('Next Thread'), accelerator: accelerator(']'), click: cmd('next-thread') },
        { label: mt('Previous Thread'), accelerator: accelerator('['), click: cmd('prev-thread') },
        { label: mt('Next Needing Attention'), accelerator: accelerator('Shift+]'), click: cmd('next-attention') },
        { type: 'separator' },
        ...Array.from({ length: 9 }, (_, i) => ({
          label: mt('Thread {n}', { n: i + 1 }),
          accelerator: accelerator(String(i + 1)),
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
