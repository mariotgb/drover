/** A deliberately small shell grammar. This module never executes or expands input. */
export interface ShellCommand {
  argv: string[]
  /** undefined = caller's session; null = an unresolved session expression. */
  session?: string | null
}

interface Word { value: string; dynamic: boolean }
type Segment = Word[]
const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s
const controlWords = new Set(['if', 'then', 'else', 'elif', 'fi', 'for', 'while',
  'until', 'do', 'done', 'case', 'esac', 'function', 'eval', 'source', '.', 'exec'])

export interface ShellCommandChain {
  commands: ShellCommand[]
  /** False if any segment was skipped, including inside shell wrappers. */
  complete: boolean
}

function tokenize(source: string): Segment[] | null {
  const segments: Segment[] = []
  let words: Segment = []
  let value = '', dynamic = false, started = false
  let quote: "'" | '"' | null = null
  const word = () => {
    if (started) words.push({ value, dynamic })
    value = ''; dynamic = false; started = false
  }
  const segment = () => { word(); if (words.length) segments.push(words); words = [] }
  for (let i = 0; i < source.length; i++) {
    const c = source[i]
    if (quote === "'") {
      if (c === "'") quote = null
      else value += c
      continue
    }
    if (c === '\\') {
      const next = source[++i]
      if (next === undefined) return null
      if (next === '\n') continue
      // Inside double quotes, only these characters are escaped by POSIX shells.
      if (quote === '"' && !['$', '`', '"', '\\'].includes(next)) value += '\\'
      value += next; started = true
      continue
    }
    if (quote === '"') {
      if (c === '"') quote = null
      else {
        value += c
        if (c === '$' || c === '`') dynamic = true
      }
      continue
    }
    if (c === "'" || c === '"') { quote = c; started = true; continue }
    if (c === '#' && !started) {
      while (i < source.length && source[i] !== '\n') i++
      segment(); continue
    }
    if (c === '\n' || c === ';') { segment(); continue }
    if (c === '&' && source[i + 1] === '&') { segment(); i++; continue }
    if (/\s/.test(c)) { word(); continue }
    // Pipes, redirections (including heredocs), groups, substitutions and background
    // jobs need execution context. Reject the script, including their quoted bodies.
    if ('|&<>(){}'.includes(c)) return null
    if (c === '$' || c === '`' || '*?[~'.includes(c)) dynamic = true
    value += c; started = true
  }
  if (quote) return null
  segment()
  return segments
}

function unwrap(words: Segment, inherited: string | null | undefined, depth: number, chain: ShellCommandChain): ShellCommand[] {
  const unsupported = (): ShellCommand[] => { chain.complete = false; return [] }
  if (depth > 4) return unsupported()
  let i = 0, session = inherited
  const takeAssignments = () => {
    while (i < words.length) {
      const m = assignment.exec(words[i].value)
      if (!m) break
      if (words[i].dynamic) chain.complete = false
      if (m[1] === 'HERDR_SESSION') session = words[i].dynamic ? null : m[2]
      i++
    }
  }
  takeAssignments()
  if (words[i]?.value === 'env' && !words[i].dynamic) {
    i++
    while (i < words.length) {
      const w = words[i]
      if (w.dynamic) return unsupported()
      if (w.value === '--') { i++; break }
      if (w.value === '-i' || w.value === '--ignore-environment') { session = 'default'; i++; continue }
      if (w.value === '-u' || w.value === '--unset') {
        if (!words[i + 1] || words[i + 1].dynamic) return unsupported()
        if (words[i + 1].value === 'HERDR_SESSION') session = 'default'
        i += 2; continue
      }
      if (w.value.startsWith('--unset=')) {
        if (w.value === '--unset=HERDR_SESSION') session = 'default'
        i++; continue
      }
      if (w.value.startsWith('-')) return unsupported()
      if (assignment.test(w.value)) { takeAssignments(); continue }
      break
    }
    takeAssignments()
  }
  const args = words.slice(i)
  if (!args.length || args.some((w) => w.dynamic)) return unsupported()
  const argv = args.map((w) => w.value)
  if (/^(?:\/bin\/)?(?:bash|sh)$/.test(argv[0])) {
    if (!['-c', '-lc'].includes(argv[1]) || argv.length !== 3) return unsupported()
    const nested = tokenize(argv[2])
    if (!nested?.length || nested.some((s) => controlWords.has(s[0]?.value))) return unsupported()
    return nested.flatMap((s) => unwrap(s, session, depth + 1, chain))
  }
  // Assignments alone and shell control words aren't executable evidence.
  if (controlWords.has(argv[0])) return unsupported()
  return [{ argv, ...(session !== undefined ? { session } : {}) }]
}

export function parseShellCommandChain(command: string): ShellCommandChain {
  const chain: ShellCommandChain = { commands: [], complete: true }
  const segments = tokenize(command)
  // Reject control flow for the entire script; a later literal may be unexecuted.
  if (!segments || segments.some((s) => ['if', 'then', 'else', 'elif', 'fi', 'for',
    'while', 'until', 'do', 'done', 'case', 'esac', 'function', 'eval', 'source', '.'].includes(s[0]?.value))) {
    chain.complete = false
    return chain
  }
  chain.commands = segments.flatMap((s) => unwrap(s, undefined, 0, chain))
  return chain
}

export function parseShellCommands(command: string): ShellCommand[] {
  return parseShellCommandChain(command).commands
}

export interface RecognizeOptions { session: string; sshAliases?: readonly string[] }
export type OfficeCommand =
  | { kind: 'prompt'; target: string; session: string; commandIndex: number; wait: boolean }
  | { kind: 'ssh_attempt'; alias: string; commandIndex: number }

const sshValues = new Set(['-B', '-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J',
  '-L', '-l', '-m', '-O', '-o', '-p', '-Q', '-R', '-S', '-W', '-w'])
const sshFlags = /^-[1246AaCfGgKkMNnqsTtVvXxYy]+$/

export function recognizeOfficeCommands(command: string, options: RecognizeOptions): OfficeCommand[] {
  const aliases = new Set(['pc', 'homeserver', ...(options.sshAliases ?? [])])
  const out: OfficeCommand[] = []
  parseShellCommands(command).forEach(({ argv, session: inherited }, commandIndex) => {
    if (argv[0] === 'herdr') {
      let i = 1, session = inherited === undefined ? options.session : inherited
      if (argv[i] === '--session') { session = argv[i + 1] ?? null; i += 2 }
      else if (argv[i]?.startsWith('--session=')) { session = argv[i].slice(10); i++ }
      if (!session || argv[i] !== 'agent' || argv[i + 1] !== 'prompt') return
      const target = argv[i + 2], prompt = argv[i + 3]
      if (!target || target.startsWith('-') || prompt === undefined) return
      const rest = argv.slice(i + 4)
      let wait = false
      for (let n = 0; n < rest.length; n++) {
        if (rest[n] === '--wait') wait = true
        else if (rest[n] === '--until' || rest[n] === '--timeout') {
          if (!rest[++n] || rest[n].startsWith('-')) return
        } else return
      }
      out.push({ kind: 'prompt', target, session, commandIndex, wait })
    } else if (argv[0] === 'ssh') {
      let i = 1
      for (; i < argv.length && argv[i].startsWith('-'); i++) {
        if (argv[i] === '--') { i++; break }
        if (sshValues.has(argv[i])) { if (!argv[++i]) return }
        else if (sshFlags.test(argv[i])) continue
        else if ([...sshValues].some((o) => argv[i].startsWith(o) && argv[i].length > 2)) continue
        else return
      }
      const alias = argv[i]
      if (aliases.has(alias)) out.push({ kind: 'ssh_attempt', alias, commandIndex })
    }
  })
  return out
}
