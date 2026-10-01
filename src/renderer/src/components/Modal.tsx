import { useEffect, useRef, useState, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { errorText } from '../api'
import { t } from '../i18n'
import { useStore, type DialogState } from '../store'
import { Spinner } from './primitives'

export function Modal({ title, onClose, children, width = 480 }: { title: string; onClose: () => void; children: ReactNode; width?: number }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // Capture phase: a focused terminal would otherwise swallow Escape.
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', k, true)
    return () => window.removeEventListener('keydown', k, true)
  }, [onClose])
  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div ref={ref} className="modal" style={{ width }} role="dialog" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t('Close')}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  )
}

export function PromptDialog({ d }: { d: Extract<DialogState, { type: 'prompt' }> }) {
  const [value, setValue] = useState(d.value)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const close = () => useStore.setState({ dialog: null })
  const invalid = d.validate?.(value) ?? null
  const submit = async () => {
    if (invalid) return
    setBusy(true)
    try {
      await d.onSubmit(value)
      close()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal title={d.title} onClose={close} width={420}>
      <div className="form">
        <div className="field">
          {d.label && <label>{d.label}</label>}
          <input
            autoFocus
            className="input"
            value={value}
            placeholder={d.placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit()
            }}
            spellCheck={false}
          />
          {invalid && value && <div className="field-hint warn">{invalid}</div>}
        </div>
        {error && <div className="form-error">{error}</div>}
        <div className="form-actions">
          <button type="button" className="btn" onClick={close}>
            {t('Cancel')}
          </button>
          <button type="button" className="btn btn-primary" disabled={busy || !!invalid} onClick={() => void submit()}>
            {busy && <Spinner size={13} />} {d.confirm}
          </button>
        </div>
      </div>
    </Modal>
  )
}

export function ConfirmDialog({ d }: { d: Extract<DialogState, { type: 'confirm' }> }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const close = () => useStore.setState({ dialog: null })
  const go = async () => {
    setBusy(true)
    try {
      await d.onConfirm()
      close()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal title={d.title} onClose={close} width={420}>
      <div className="form">
        <p className="confirm-text">{d.message}</p>
        {error && <div className="form-error">{error}</div>}
        <div className="form-actions">
          <button type="button" className="btn" onClick={close} autoFocus>
            {t('Cancel')}
          </button>
          <button type="button" className={d.danger ? 'btn btn-danger' : 'btn btn-primary'} disabled={busy} onClick={() => void go()}>
            {busy && <Spinner size={13} />} {d.confirm}
          </button>
        </div>
      </div>
    </Modal>
  )
}
