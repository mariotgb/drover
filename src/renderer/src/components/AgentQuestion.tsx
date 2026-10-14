import { useEffect, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Check, CircleAlert, MessageCircleQuestion, SquareTerminal } from 'lucide-react'
import { t } from '../i18n'
import { api, errorText } from '../api'
import type { Thread } from '../model'
import type { SendPromptResult } from '@shared/types'
import { Spinner } from './primitives'

type Answer = { questionId: string; choiceId: string; phase: 'sending' | 'sent' | 'error'; error?: string }

function answerError(r: SendPromptResult): string {
  switch (r.code) {
    case 'question_changed':
    case 'question_gone': return t('The question changed. Check the new one before answering.')
    case 'agent_busy': return t('The agent is busy right now. Try again when it finishes.')
    case 'pane_changed':
    case 'occupant_changed': return t('A different program is in this pane now. Nothing was sent.')
    default: return r.error || t('Could not send the answer. Try again.')
  }
}

/**
 * A dialog Drover detected in the agent's terminal (approval, question). Each choice is a button;
 * the answer is sent only on that click, once, and only while the same question is still showing.
 */
export function QuestionCard({ thread, compact, footer }: { thread: Thread; compact?: boolean; footer?: ReactNode }) {
  const q = thread.pane.agent_question
  const [answer, setAnswer] = useState<Answer | null>(null)
  // Clicks can arrive before React re-renders (double click): this ref closes the gate at once.
  const sending = useRef<string | null>(null)
  // A new question (new id) starts clean; the same question keeps the clicked state.
  useEffect(() => { setAnswer((a) => (a && a.questionId === q?.id ? a : null)) }, [q?.id])
  if (!q) return null
  const current = answer?.questionId === q.id ? answer : null
  const locked = current?.phase === 'sending' || current?.phase === 'sent'
  const pick = async (choiceId: string) => {
    if (locked || sending.current === q.id) return
    sending.current = q.id
    setAnswer({ questionId: q.id, choiceId, phase: 'sending' })
    try {
      const r = await api.answerAgentQuestion({ paneId: thread.paneId, questionId: q.id, choiceId })
      setAnswer(r.ok ? { questionId: q.id, choiceId, phase: 'sent' } : { questionId: q.id, choiceId, phase: 'error', error: answerError(r) })
      // A refused answer may be tried again; a delivered one stays locked for this question.
      if (!r.ok) sending.current = null
    } catch (e) {
      setAnswer({ questionId: q.id, choiceId, phase: 'error', error: errorText(e) })
      sending.current = null
    }
  }
  return (
    <div className={clsx('aq', compact && 'compact')} role="group" aria-label={t('{name} asks', { name: thread.name })}>
      <div className="aq-head">
        <MessageCircleQuestion size={compact ? 15 : 16} />
        <div className="aq-text">
          <div className="aq-title">{t('{name} asks', { name: thread.name })}</div>
          <div className="aq-question">{q.question}</div>
        </div>
      </div>
      {q.choices.length > 0 ? (
        <div className="aq-choices">
          {q.choices.map((c, i) => {
            const picked = current?.choiceId === c.id
            return (
              <button key={c.id} type="button" className={clsx('aq-choice', picked && 'picked', picked && current?.phase)} disabled={locked} aria-pressed={picked}
                onClick={() => void pick(c.id)}>
                <span className="aq-num">{picked && current?.phase === 'sending' ? <Spinner size={11} /> : picked && current?.phase === 'sent' ? <Check size={12} strokeWidth={3} /> : i + 1}</span>
                <span className="aq-label">{c.label}</span>
              </button>
            )
          })}
        </div>
      ) : (
        <p className="aq-note">{t('This question has no buttons. Answer it in the agent’s terminal.')}</p>
      )}
      {current?.phase === 'sent' && <p className="aq-note ok" role="status">{t('Answer sent. Waiting for {name}…', { name: thread.name })}</p>}
      {current?.phase === 'error' && <p className="aq-note bad" role="alert">{current.error}</p>}
      {footer}
    </div>
  )
}

/** "Starting…" while Drover brings an agent back, and a clear "did not start" when it could not. */
export function RestoreBanner({ thread, onTerminal }: { thread: Thread; onTerminal?: () => void }) {
  const state = thread.pane.restore_state
  if (!state) return null
  // restore_error is announced by the backend; read it loosely until it lands in the shared type.
  const reason = (thread.pane as { restore_error?: { message?: string } }).restore_error?.message
  if (state === 'starting') {
    return (
      <div className="restore-banner starting" role="status">
        <Spinner size={13} />
        <div><div className="restore-title">{t('Starting {name}…', { name: thread.name })}</div><div className="restore-sub">{t('Drover is bringing this agent back. This usually takes a few seconds.')}</div></div>
      </div>
    )
  }
  return (
    <div className="restore-banner failed" role="alert">
      <CircleAlert size={16} />
      <div className="restore-body">
        <div className="restore-title">{t('{name} did not start', { name: thread.name })}</div>
        <div className="restore-sub">{reason || t('Drover could not bring this agent back. Open its terminal to see what happened.')}</div>
      </div>
      {onTerminal && <button type="button" className="btn btn-sm" onClick={onTerminal}><SquareTerminal size={13} />{t('Open terminal')}</button>}
    </div>
  )
}
