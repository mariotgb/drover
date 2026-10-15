import { withoutMachinePointer } from './machines/launch'
import { bypassArgs, modelArgs, type ModelChoice } from '@shared/models'
import type { AgentLaunch } from '@shared/agentRestart'

export const bypassFlags = new Set(['--dangerously-skip-permissions', '--dangerously-bypass-approvals-and-sandbox', '--yolo'])
const permissionFlags = new Set([...bypassFlags, '--full-auto', '--approve-for-me'])
export type Kind = 'claude' | 'codex'
type Arity = 0 | 1 | 'optional' | 'many'
const flags = (groups: [Arity, string][]): Map<string, Arity> => new Map(groups.flatMap(([arity, names]) => names.split(' ').map(name => [name, arity] as const)))
const CLAUDE_FLAGS = flags([
  [0, '-c --continue -p --print --fork-session --dangerously-skip-permissions --allow-dangerously-skip-permissions --bare --brief --chrome --no-chrome --ide --disable-slash-commands --strict-mcp-config --safe-mode --restricted --no-session-persistence --verbose --ax-screen-reader'],
  [1, '--model --effort --permission-mode --session-id --settings --setting-sources --append-system-prompt --append-system-prompt-file --system-prompt --system-prompt-file --agent --agents --fallback-model --plugin-dir --plugin-url -n --name --debug-file --output-format --input-format --json-schema --max-budget-usd --permission-prompts --permission-prompt-tool --autocompact'],
  ['optional', '-r --resume -d --debug --from-pr --prompt-suggestions --remote-control'],
  ['many', '--add-dir --mcp-config --allowedTools --allowed-tools --disallowedTools --disallowed-tools --tools --betas --file']
])
const CODEX_FLAGS = flags([
  [0, '--last --all --full-auto --yolo --dangerously-bypass-approvals-and-sandbox --approve-for-me --dangerously-bypass-hook-trust --oss --search --no-alt-screen --no-daemon --strict-config --include-non-interactive --worktree'],
  [1, '-c --config -m --model -s --sandbox -a --ask-for-approval --approval-policy -p --profile -C --cd --add-dir --enable --disable --local-provider --remote --remote-auth-token-env'],
  ['many', '-i --image']
])
interface LaunchOption { flag: string; tokens: string[]; value?: string }
/** Native argv has different meanings for -c/-p; never consume a following flag as a value. */
export function launchOptions(kind: Kind, args: string[]): LaunchOption[] {
  const table = kind === 'claude' ? CLAUDE_FLAGS : CODEX_FLAGS, out: LaunchOption[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') break
    if (kind === 'codex' && ['resume', 'fork'].includes(arg)) { if (args[i + 1] && !args[i + 1].startsWith('-')) i++; continue }
    if (!arg.startsWith('-')) continue // Launch/session prompts are never replayed.
    const equals = arg.indexOf('='), short = /^-[^-].+/.test(arg) && (table.get(arg.slice(0, 2)) === 1 || kind === 'claude' && arg.startsWith('-r'))
    const flag = short ? arg.slice(0, 2) : equals < 0 ? arg : arg.slice(0, equals)
    const arity = table.get(flag), tokens = [arg]
    let value = short ? arg.slice(2) : equals < 0 ? undefined : arg.slice(equals + 1)
    if (!short && equals < 0 && arity !== 0 && args[i + 1] && !args[i + 1].startsWith('-')) {
      value = args[++i]; tokens.push(value)
      if (arity === 'many') while (args[i + 1] && !args[i + 1].startsWith('-')) tokens.push(args[++i])
    }
    if (arity === 1 && value === undefined) continue // Do not preserve dangling options.
    out.push({ flag, tokens, value })
  }
  return out
}

/** Keep launch options, replacing conversation, model and permission settings. Never append a prompt. */
export function restartArgs(kind: 'claude' | 'codex', original: string[], sessionId: string | null, choice: ModelChoice, bypass: boolean): string[] {
  const rest: string[] = []
  const replace = kind === 'claude'
    ? new Set(['-c', '--continue', '-r', '--resume', '--session-id', '--model', '--effort', '--permission-mode', '--fork-session', '--from-pr', '-p', '--print', '--output-format', '--input-format', '--allow-dangerously-skip-permissions'])
    : new Set(['--last', '--all', '-m', '--model', '-a', '--ask-for-approval', '--approval-policy', '-s', '--sandbox', '-i', '--image', '--worktree'])
  for (const option of launchOptions(kind, withoutMachinePointer(kind, original))) {
    if (permissionFlags.has(option.flag) || replace.has(option.flag)) continue
    if (kind === 'codex' && ['-c', '--config'].includes(option.flag) && /^(model|model_reasoning_effort|approval_policy|sandbox_mode)\s*=/.test(option.value ?? '')) continue
    rest.push(...option.tokens)
  }
  const effectiveChoice = { ...launchChoice(kind, original), ...Object.fromEntries(Object.entries(choice).filter(([, v]) => v)) }
  const permissions = bypass ? bypassArgs(kind, true) : kind === 'claude' ? ['--permission-mode', 'manual'] : ['--ask-for-approval', 'on-request', '--sandbox', 'workspace-write']
  return [...(sessionId ? kind === 'claude' ? ['--resume', sessionId] : ['resume', sessionId] : []), ...rest, ...modelArgs(kind, effectiveChoice), ...permissions]
}

export function launchChoice(kind: Kind, args: string[]): ModelChoice {
  const choice: ModelChoice = {}
  for (const { flag, value } of launchOptions(kind, args)) {
    if (flag === '--model' || kind === 'codex' && flag === '-m') choice.model = value
    else if (kind === 'claude' && flag === '--effort') choice.effort = value
    else if (kind === 'codex' && (flag === '-c' || flag === '--config')) {
      const m = value?.match(/^(model|model_reasoning_effort)\s*=\s*["']?([^"']+)["']?$/)
      if (m) choice[m[1] === 'model' ? 'model' : 'effort'] = m[2]
    }
  }
  return safeLaunchChoice(choice)
}

const secret = /(?:api[_-]?key|authorization|bearer|password|secret|token|^sk-)/i
const slug = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_./:-]{0,159}$/.test(value) && !secret.test(value)
const efforts = new Set(['minimal', 'none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
export function safeLaunchChoice(choice: ModelChoice | null | undefined): ModelChoice {
  return { ...(slug(choice?.model) ? { model: choice.model } : {}),
    ...(typeof choice?.effort === 'string' && efforts.has(choice.effort) ? { effort: choice.effort } : {}) }
}
const safePath = (value: string): boolean => /^(?:\/|\.\.?\/|~\/|[a-zA-Z]:[\\/])/.test(value) &&
  !/[\p{Cc}{}=<>`$]/u.test(value) && !/\w+:\/\//.test(value)
const safeBooleans = new Set([...permissionFlags, '--allow-dangerously-skip-permissions', '--no-daemon', '--search', '--oss', '--no-alt-screen', '--strict-config', '--bare', '--brief', '--chrome', '--no-chrome', '--ide', '--disable-slash-commands', '--strict-mcp-config', '--safe-mode', '--restricted', '--no-session-persistence', '--verbose', '--ax-screen-reader'])
const paths = new Set(['--settings', '--mcp-config', '--plugin-dir', '--add-dir', '-C', '--cd'])
const permissions: Record<string, Set<string>> = {
  '--permission-mode': new Set(['default', 'manual', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto']),
  '-s': new Set(['read-only', 'workspace-write', 'danger-full-access']),
  '--sandbox': new Set(['read-only', 'workspace-write', 'danger-full-access']),
  '-a': new Set(['untrusted', 'on-failure', 'on-request', 'never']),
  '--ask-for-approval': new Set(['untrusted', 'on-failure', 'on-request', 'never']),
  '--approval-policy': new Set(['untrusted', 'on-failure', 'on-request', 'never'])
}
/** The single disk/report boundary. Never retain prompts, arbitrary config,
 * inline JSON/env, or an unknown value. File references are safe to replay. */
export function sanitizeLaunchArgs(kind: Kind, original: string[]): { args: string[]; unavailable: boolean } {
  const args: string[] = []
  let unavailable = false
  const selectors = new Set(kind === 'claude' ? ['-c', '--continue', '-r', '--resume', '--session-id', '--fork-session', '--from-pr', '-p', '--print', '--output-format', '--input-format', '--json-schema'] : ['--last', '--all'])
  for (const option of launchOptions(kind, withoutMachinePointer(kind, original))) {
    const { flag, value, tokens } = option
    if (selectors.has(flag)) continue
    if (kind === 'codex' && ['-c', '--config'].includes(flag)) {
      // These two scalars are proven non-secret; retain them as metadata only.
      const match = value?.match(/^(model|model_reasoning_effort)\s*=\s*["']?([^"']+)["']?$/)
      if (!match || (match[1] === 'model' ? !slug(match[2]) : !efforts.has(match[2]))) unavailable = true
      continue
    }
    // Variadic file options can be followed by the initial positional prompt.
    // Keep file references only; inline structured/secret values still block replay.
    if (paths.has(flag) && tokens.length > 2 && value && safePath(value)) {
      args.push(tokens[0])
      let prompt = false
      for (const token of tokens.slice(1)) {
        if (!prompt && safePath(token)) args.push(token)
        else { prompt = true; if (/[{}=]/.test(token) || secret.test(token)) unavailable = true }
      }
      continue
    }
    const valid = safeBooleans.has(flag) ? value === undefined
      : paths.has(flag) ? tokens.slice(1).length > 1 ? tokens.slice(1).every(safePath) : !!value && safePath(value)
      : permissions[flag] ? !!value && permissions[flag].has(value)
      : flag === '--effort' && kind === 'claude' ? !!value && efforts.has(value)
      : flag === '--model' || kind === 'codex' && ['-m', '-p', '--profile'].includes(flag) ? slug(value)
      : false
    if (valid) args.push(...tokens)
    else unavailable = true
  }
  return { args, unavailable }
}
/** Whitelist record fields too: old caches may contain private extra fields. */
export function sanitizeAgentLaunch(launch: AgentLaunch): AgentLaunch {
  const clean = sanitizeLaunchArgs(launch.kind, launch.args)
  const inferred = launchChoice(launch.kind, launch.args)
  const choice = safeLaunchChoice({ ...inferred, ...safeLaunchChoice(launch), ...safeLaunchChoice(launch.choice) })
  return { kind: launch.kind, terminalId: launch.terminalId, args: clean.args, bypass: launch.bypass,
    ...(launch.sessionId ? { sessionId: launch.sessionId } : {}), name: launch.name ?? null, cwd: launch.cwd ?? null,
    ...(launch.processId ? { processId: launch.processId } : {}), ...choice,
    ...(Object.keys(choice).length ? { choice } : {}),
    ...(clean.unavailable || launch.restoreUnavailable ? { restoreUnavailable: true } : {}) }
}

/** Restore the same launch policy. Only conversation selectors and prompt/print mode conflict. */
export function resumeArgs(kind: Kind, original: string[], sessionId: string, choice: ModelChoice = {}): string[] {
  const replace = kind === 'claude'
    ? new Set(['-c', '--continue', '-r', '--resume', '--session-id', '--fork-session', '--from-pr', '-p', '--print', '--output-format', '--input-format', '--json-schema'])
    : new Set(['--last', '--all'])
  const rest: string[] = []
  // Infer only safe Codex -c scalars here; existing native model/effort flags
  // retain their order unless the caller explicitly supplies an override.
  const config = kind === 'codex' ? launchOptions(kind, original).filter(o => ['-c', '--config'].includes(o.flag)).flatMap(o => o.tokens) : []
  choice = { ...launchChoice(kind, config), ...safeLaunchChoice(choice) }
  for (const option of launchOptions(kind, sanitizeLaunchArgs(kind, original).args)) {
    if (replace.has(option.flag)) continue
    if (choice.model && (option.flag === '--model' || kind === 'codex' && option.flag === '-m')) continue
    if (choice.effort && kind === 'claude' && option.flag === '--effort') continue
    if (kind === 'codex' && ['-c', '--config'].includes(option.flag) &&
      (choice.model && /^model\s*=/.test(option.value ?? '') || choice.effort && /^model_reasoning_effort\s*=/.test(option.value ?? ''))) continue
    rest.push(...option.tokens)
  }
  const launch = [...rest, ...modelArgs(kind, choice)]
  return kind === 'codex' ? [...launch, 'resume', sessionId] : ['--resume', sessionId, ...launch]
}

/** The constraints enforced by Herdr 0.9.2+ for self-reported resume commands. */
export function acceptsResumeArgv(argv: string[]): boolean {
  return argv.length > 0 && argv.length <= 64 && /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(argv[0]) &&
    argv.reduce((n, arg) => n + Buffer.byteLength(arg), 0) <= 8192 &&
    argv.every(arg => !/[\p{Cc}']/u.test(arg))
}
export function supportsResumeArgv(version: string | undefined | null): boolean {
  const v = version?.match(/^(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number)
  return !!v && (v[0] > 0 || v[1] > 9 || v[1] === 9 && v[2] >= 2)
}
