/** Recognize only Drover's complete generated prose, never user instructions. */
export function withoutMachinePointer(kind: string, args: string[]): string[] {
  const out: string[] = []
  const generated = (value: string) => /^(?:Before using remote machines for this project, read [^\r\n]+\/(?:agents|projects)\/[a-f0-9]{64}\.md\. Use only (?:its listed aliases and respect permissions and who may use each machine\. Do not read or use management\/tunnel keys\. Selected-project scope and machine usage rules are advisory\.|its listed aliases and respect permissions\. Do not read or use management\/tunnel keys\. Selected-project scope is advisory\.) )?Machine configuration requests use '[^\r\n]+'; Drover checks your project role and asks the desktop user for confirmation\.$/.test(value)
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]
    let value: string | undefined
    if (kind === 'claude' && flag === '--append-system-prompt') value = args[i + 1]
    if (kind === 'codex' && ['-c', '--config'].includes(flag) && args[i + 1]?.startsWith('developer_instructions=')) {
      try { const parsed = JSON.parse(args[i + 1].slice('developer_instructions='.length)); if (typeof parsed === 'string') value = parsed } catch { /* user TOML remains subject to normal sanitization */ }
    }
    if (value && generated(value.trim())) { i++; continue }
    out.push(flag)
  }
  return out
}

/** Preserve user-supplied native system instructions when appending the
 * project-scoped machine pointer. No prompt is sent to an existing agent.
 */
export function machineLaunchArgs(kind: string, args: string[], pointer: string): string[] {
  const result = [...args]
  if (kind === 'claude') {
    // Herdr's shell encoder rejects literal control characters in argv.
    // This generated prose pointer needs no paragraph boundaries.
    const inlinePointer = pointer.replace(/[\r\n\t]+/g, ' ').trim()
    const index = result.indexOf('--append-system-prompt')
    if (index >= 0 && result[index + 1]) result[index + 1] += ' ' + inlinePointer
    else result.unshift('--append-system-prompt', inlinePointer)
  } else if (kind === 'codex') {
    for (let i = 0; i < result.length - 1; i++) {
      if (['-c', '--config'].includes(result[i]) && result[i + 1].startsWith('developer_instructions=')) {
        const previous = result[i + 1].slice('developer_instructions='.length)
        try { result[i + 1] = 'developer_instructions=' + JSON.stringify(JSON.parse(previous) + '\n\n' + pointer) }
        catch { /* Unknown TOML syntax: retain it; the global pointer still applies. */ }
        return result
      }
    }
    result.unshift('-c', 'developer_instructions=' + JSON.stringify(pointer))
  }
  return result
}
