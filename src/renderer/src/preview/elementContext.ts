import type { PickedElement } from '@shared/types'

// Picked preview elements travel to the agent as plain-text blocks inside the
// prompt, so any agent can read them. The chat view folds them back into chips.

export function elementBlock(el: PickedElement, imageIndex?: number): string {
  const lines = [`<selected_element page="${el.url.replace(/"/g, '%22')}">`, `selector: ${el.selector}`]
  if (el.component) lines.push(`component: ${el.component}`)
  if (el.source) lines.push(`source: ${el.source}`)
  lines.push(`html: ${el.html}`)
  if (el.text) lines.push(`text: ${el.text}`)
  lines.push(`box: ${el.rect.width}×${el.rect.height} at ${el.rect.x},${el.rect.y} in a ${el.viewport.width}×${el.viewport.height} viewport`)
  if (el.styles) lines.push(`styles: ${el.styles}`)
  if (imageIndex) lines.push(`screenshot: attached image ${imageIndex}`)
  lines.push('</selected_element>')
  return lines.join('\n')
}

export interface ParsedElement {
  page: string
  fields: Record<string, string>
}

const BLOCK_RE = /<selected_element(?:\s+page="([^"]*)")?>\s*([\s\S]*?)<\/selected_element>/g

export function splitElementBlocks(text: string): { elements: ParsedElement[]; rest: string } {
  const elements: ParsedElement[] = []
  const rest = text
    .replace(BLOCK_RE, (_m, page: string | undefined, body: string) => {
      const fields: Record<string, string> = {}
      for (const line of body.split('\n')) {
        const i = line.indexOf(':')
        if (i > 0) fields[line.slice(0, i).trim()] = line.slice(i + 1).trim()
      }
      elements.push({ page: page ?? '', fields })
      return ''
    })
    .trim()
  return { elements, rest }
}

export function elementTitle(fields: Record<string, string>): string {
  const tag = fields.html?.match(/^<([a-z0-9-]+)/i)?.[1] ?? 'element'
  const text = fields.text ? ` “${fields.text.length > 40 ? fields.text.slice(0, 39) + '…' : fields.text}”` : ''
  return `<${tag}>${text}`
}
