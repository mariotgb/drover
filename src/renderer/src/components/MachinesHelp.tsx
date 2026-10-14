import { useEffect } from 'react'
import { Cable, KeyRound, Route, Server, Smartphone, X } from 'lucide-react'
import { t } from '../i18n'

/** Short "How machines work" sheet, linked from the Machines header, the add flow and first run. */
export function MachinesHelp({ onClose, onAdd }: { onClose: () => void; onAdd?: () => void }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])
  const items = [
    { icon: <Server size={15} />, title: t('Machine'), text: t('Any computer your agents can work on: a server on the internet, a PC at home, another Mac.') },
    { icon: <Route size={15} />, title: t('How Drover reaches it'), text: t('Through your home network when you are at home, over the internet when the machine has a public address, and through the bridge when neither works, for example away from home. Drover picks the route by itself and shows which one it uses.') },
    { icon: <Cable size={15} />, title: t('Bridge'), text: t('A small server on the internet. Through it any of your devices and machines away from home reach this computer. No router setup is needed.') },
    { icon: <Smartphone size={15} />, title: t('Device'), text: t('Any browser — on a phone, a tablet or another computer — opens Drover at a secure address on the bridge. This computer has to stay on.') },
    { icon: <Route size={15} />, title: 'herdr', text: t('Drover and herdr share one list of machines. Add a machine in herdr and it appears here, and the other way round.') },
    { icon: <KeyRound size={15} />, title: t('Safety'), text: t('Agents sign in with their own key. Passwords are used once and never stored. For each machine you choose what agents may do.') }
  ]
  return (
    <div className="mhelp-backdrop" onClick={onClose}>
      <aside className="mhelp" role="dialog" aria-modal="true" aria-labelledby="mhelp-title" onClick={(e) => e.stopPropagation()}>
        <div className="mhelp-head">
          <h3 id="mhelp-title">{t('How machines work')}</h3>
          <button type="button" className="icon-btn icon-btn-sm" aria-label={t('Close')} onClick={onClose} autoFocus><X size={14} /></button>
        </div>
        {items.map((i) => (
          <section key={i.title}>
            <h4>{i.icon}{i.title}</h4>
            <p>{i.text}</p>
          </section>
        ))}
        {onAdd && <button type="button" className="btn btn-sm btn-primary" onClick={() => { onClose(); onAdd() }}>{t('Add machine')}</button>}
      </aside>
    </div>
  )
}
