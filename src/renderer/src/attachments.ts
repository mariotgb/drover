import { REMOTE_ATTACHMENT_MAX_BYTES, REMOTE_ATTACHMENT_ROUTES, type RemoteAttachment } from '@shared/remote'
import { t } from './i18n'

export function remoteAttachmentUrl(path: string): string {
  const id = path.split('/').pop() ?? ''
  return REMOTE_ATTACHMENT_ROUTES.previewPrefix + encodeURIComponent(id)
}

export async function uploadAttachment(file: File): Promise<RemoteAttachment> {
  if (file.size > REMOTE_ATTACHMENT_MAX_BYTES) throw new Error(t('Files must be 20 MB or smaller.'))
  if (!file.size) throw new Error(t('The file is empty.'))
  const imageExt = file.type.startsWith('image/') ? file.type.slice(6).replace(/^jpeg$/, 'jpg') : 'png'
  const name = file.name || `screenshot.${imageExt}`
  const res = await fetch(REMOTE_ATTACHMENT_ROUTES.upload, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Drover-Filename': encodeURIComponent(name) },
    body: file, signal: AbortSignal.timeout(120_000)
  })
  if (!res.ok) {
    const code = (await res.json().catch(() => ({}))).error?.code
    if (res.status === 401) throw new Error(t('Sign in again to attach files.'))
    if (code === 'attachment_dimensions') throw new Error(t('The image is too large. Choose a smaller image.'))
    // Caddy can return plain text or HTML; don't depend on the backend JSON.
    if (res.status === 413 || code === 'attachment_too_large') throw new Error(t('Files must be 20 MB or smaller.'))
    if (code === 'unsupported_attachment') throw new Error(t('Choose an image or a UTF-8 text file.'))
    if (code === 'empty_attachment') throw new Error(t('The file is empty.'))
    if (code === 'attachment_quota') throw new Error(t('Attachment storage is full. Remove old files on your Mac and try again.'))
    throw new Error(t('Could not upload {name}. Try again.', { name: file.name }))
  }
  return res.json()
}
