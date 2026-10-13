/** Preserve user-supplied native system instructions when appending the
 * project-scoped machine pointer. No prompt is sent to an existing agent.
 */
export function machineLaunchArgs(kind: string, args: string[], pointer: string): string[] {
  const result = [...args]
  if (kind === 'claude') {
    const index = result.indexOf('--append-system-prompt')
    if (index >= 0 && result[index + 1]) result[index + 1] += '\n\n' + pointer
    else result.unshift('--append-system-prompt', pointer)
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
