import type { OfficeEvent, OfficeEventEnvelope, OfficeNodeId, OfficeToolEvidence } from '@shared/office'

export interface OfficeToolCall {
  id: string
  name: string
  /** Original tool_use input, function_call arguments, or exec JS program. */
  input?: unknown
  /** Correlated tool_result/output, before display truncation. */
  output?: unknown
  ts?: number
  evidence?: OfficeToolEvidence
}
export interface ResolvedOfficeAgent {
  id: OfficeNodeId
  paneId: string
  name?: string
}
export interface OfficeAnalyzeContext {
  session: string
  /** Caller supplies this only for an exact transcript incarnation. */
  from: OfficeNodeId | null
  observedAt: number
  resolveAgent: (session: string, target: string) => ResolvedOfficeAgent | null
  resolveMachine?: (alias: string) => OfficeNodeId | null
  sshAliases?: readonly string[]
}
export interface OfficeEventCandidate extends OfficeEvent {
  commandIndex: number
  confidence: OfficeEventEnvelope['confidence']
}
