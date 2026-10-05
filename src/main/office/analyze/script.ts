/** Static subset of exec JS: unconditional awaited shell calls with literal options. */
interface Token { value: string; literal?: string }

function lex(code: string): Token[] | null {
  const tokens: Token[] = []
  for (let i = 0; i < code.length;) {
    const c = code[i]
    if (/\s/.test(c)) { i++; continue }
    if (code.startsWith('//', i)) { i = code.indexOf('\n', i); if (i < 0) break; continue }
    if (code.startsWith('/*', i)) { const end = code.indexOf('*/', i + 2); if (end < 0) return null; i = end + 2; continue }
    if (["'", '"', '`'].includes(c)) {
      let value = '', closed = false
      for (i++; i < code.length; i++) {
        if (code[i] === c) { i++; closed = true; break }
        if (c === '`' && code.startsWith('${', i)) return null
        if (code[i] === '\\') {
          const next = code[++i]
          if (next === undefined) return null
          const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' }
          if (next === '\n') continue
          if (next === 'u' || next === 'x') {
            const count = next === 'u' ? 4 : 2
            const hex = code.slice(i + 1, i + 1 + count)
            if (!new RegExp(`^[0-9a-fA-F]{${count}}$`).test(hex)) return null
            value += String.fromCharCode(parseInt(hex, 16)); i += count
          } else if (escapes[next] !== undefined) value += escapes[next]
          else if (/[1-9]/.test(next)) return null
          else value += next
        } else {
          if (c !== '`' && /[\r\n]/.test(code[i])) return null
          value += code[i]
        }
      }
      if (!closed) return null
      tokens.push({ value: '<string>', literal: value }); continue
    }
    const identifier = code.slice(i).match(/^[A-Za-z_$][\w$]*|^-?\d+(?:\.\d+)?/)
    if (identifier) { tokens.push({ value: identifier[0] }); i += identifier[0].length; continue }
    if ('{}[]().,:;='.includes(c)) { tokens.push({ value: c }); i++; continue }
    return null
  }
  return tokens
}

export function commandsFromExecScript(code: string): (string | string[])[] {
  const tokens = lex(code)
  if (!tokens || tokens.length > 20_000) return []
  let i = 0
  const commands: (string | string[])[] = []
  const vars = new Set<string>()
  const take = (value: string) => tokens[i]?.value === value ? (i++, true) : false
  const value = (): unknown => {
    const t = tokens[i++]
    if (!t) throw new Error('missing literal')
    if (t.literal !== undefined) return t.literal
    if (t.value === 'true' || t.value === 'false') return t.value === 'true'
    if (t.value === 'null') return null
    if (/^-?\d+(\.\d+)?$/.test(t.value)) return Number(t.value)
    if (t.value === '[') {
      const out: unknown[] = []
      while (!take(']')) { out.push(value()); if (take(']')) break; if (!take(',')) throw new Error('array') }
      return out
    }
    throw new Error('dynamic option')
  }
  const call = () => {
    if (!take('tools') || !take('.') || !take('exec_command') || !take('(') || !take('{')) throw new Error('call')
    const options: Record<string, unknown> = {}
    while (!take('}')) {
      const key = tokens[i++]
      if (!key || !take(':')) throw new Error('key')
      const name = key.literal ?? key.value
      if (Object.hasOwn(options, name)) throw new Error('duplicate key')
      options[name] = value()
      if (take('}')) break
      if (!take(',')) throw new Error('object')
    }
    if (!take(')')) throw new Error('call end')
    const command = options.cmd ?? options.command
    if (typeof command === 'string' || (Array.isArray(command) && command.every((v) => typeof v === 'string'))) commands.push(command)
  }
  const awaited = () => {
    if (!take('await')) throw new Error('not awaited')
    if (tokens[i]?.value === 'tools') { call(); return }
    if (!take('Promise') || !take('.') || !(take('all') || take('allSettled')) || !take('(') || !take('[')) throw new Error('await')
    while (!take(']')) { call(); if (take(']')) break; if (!take(',')) throw new Error('promise list') }
    if (!take(')')) throw new Error('promise end')
  }
  const observation = () => {
    const t = tokens[i++]
    // Only actual shell-call return values may be emitted. A literal text() could
    // fabricate a successful CLI receipt next to a failed herdr invocation.
    if (!t || !vars.has(t.value)) throw new Error('observation')
    while (take('.')) {
      const field = tokens[i++]
      if (!field || !/^[A-Za-z_$][\w$]*$/.test(field.value)) throw new Error('field')
    }
  }
  try {
    while (i < tokens.length) {
      if (take(';')) continue
      if (take('const') || take('let')) {
        const name = tokens[i++]?.value
        if (!name || !/^[A-Za-z_$][\w$]*$/.test(name) || vars.has(name) || ['tools', 'Promise', 'text', 'JSON'].includes(name) || !take('=')) return []
        awaited(); vars.add(name)
      } else if (take('text')) {
        if (!take('(')) return []
        if (tokens[i]?.value === 'await') awaited()
        else if (take('JSON')) {
          if (!take('.') || !take('stringify') || !take('(')) return []
          observation(); if (!take(')')) return []
        } else observation()
        if (!take(')')) return []
      } else if (vars.has(tokens[i]?.value) && tokens[i + 1]?.value === '.') {
        i++
        if (!take('.') || !take('forEach') || !take('(') || !take('text') || !take(')')) return []
      } else awaited()
      take(';')
    }
  } catch { return [] }
  return commands
}
