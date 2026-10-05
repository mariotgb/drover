export function formatBossAssignment(id: string, project: string, boss: string, text: string, helper?: string): string {
  const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`
  return `[Поручение от Главного босса · ${id}]\n${text}\n\nSend your result or progress to the Main boss:\n${helper ? `${quote(helper)} reply ${quote(project)} ${quote(id)} ${quote('Your result or progress')}\nFallback only if the helper is unavailable:\n` : ''}herdr agent prompt ${boss} ${quote(`[Ответ ${project} · ${id}] …`)}`
}
export function parseBossReply(text: string): { project: string; id: string } | null {
  const match = text.match(/^\[Ответ ([^\r\n]+) · ([a-zA-Z0-9_-]{1,80})\](?:\s|$)/)
  return match ? { project: match[1], id: match[2] } : null
}
