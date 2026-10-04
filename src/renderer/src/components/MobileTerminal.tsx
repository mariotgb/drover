import { useCallback, useRef, useState } from 'react'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Keyboard } from 'lucide-react'
import { t } from '../i18n'
import { TerminalView, type TerminalHandle } from './TerminalView'

/** Extra keys use the same terminal bridge as the software keyboard. */
export function MobileTerminal({ paneId }: { paneId: string }) {
  const terminal = useRef<TerminalHandle | null>(null)
  const [ready, setReady] = useState(false)
  const [control, setControl] = useState(false)
  const onReady = useCallback((handle: TerminalHandle | null) => {
    terminal.current = handle
    setReady(!!handle)
    setControl(false)
  }, [])
  const keys = [
    { label: 'Esc', data: '\x1b' }, { label: 'Tab', data: '\t' },
    { label: t('Arrow left'), data: '\x1b[D', icon: ArrowLeft },
    { label: t('Arrow down'), data: '\x1b[B', icon: ArrowDown },
    { label: t('Arrow up'), data: '\x1b[A', icon: ArrowUp },
    { label: t('Arrow right'), data: '\x1b[C', icon: ArrowRight }
  ]
  const press = (data: string) => {
    terminal.current?.key(data)
    terminal.current?.control(false)
    setControl(false)
  }
  return <div className="mobile-terminal-screen">
    <TerminalView paneId={paneId} onReady={onReady} />
    {control && <div className="mobile-control-keys">{['C', 'D', 'L', 'Z'].map(key => <button type="button" key={key} onMouseDown={e => e.preventDefault()} onClick={() => press(String.fromCharCode(key.charCodeAt(0) & 31))}>Ctrl+{key}</button>)}</div>}
    <div className="mobile-terminal-keys" role="group" aria-label={t('Extra terminal keys')}>
      <button type="button" aria-label={t('Show keyboard')} disabled={!ready} onMouseDown={e => e.preventDefault()} onClick={() => terminal.current?.focus()}><Keyboard size={19} /></button>
      {keys.slice(0, 2).map(({ label, data }) => <button type="button" key={label} disabled={!ready} onMouseDown={e => e.preventDefault()} onClick={() => press(data)}>{label}</button>)}
      <button type="button" disabled={!ready} aria-pressed={control} onMouseDown={e => e.preventDefault()} onClick={() => { const next = !control; setControl(next); terminal.current?.control(next, () => setControl(false)) }}>Ctrl</button>
      {keys.slice(2).map(({ label, data, icon: Icon }) => <button type="button" key={label} disabled={!ready} aria-label={label} onMouseDown={e => e.preventDefault()} onClick={() => press(data)}>{Icon && <Icon size={18} />}</button>)}
    </div>
  </div>
}
