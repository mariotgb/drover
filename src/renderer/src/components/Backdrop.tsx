import { GRADIENTS } from '@shared/themes'
import { REMOTE_APPEARANCE_ROUTES } from '@shared/remote'
import { isRemote } from '../api'
import { useStore } from '../store'

/** The background picture/video/gradient from the appearance settings, with its dim layer. */
function BackdropMedia({ still }: { still?: boolean }) {
  const bg = useStore((s) => s.settings.appearance.background)
  // In the browser the Mac serves its background file; the name changes with every new pick.
  const src = !bg.path ? undefined : isRemote
    ? `${REMOTE_APPEARANCE_ROUTES.background}?v=${encodeURIComponent(bg.path.split('/').pop() ?? '')}`
    : `hdfile://local/?p=${encodeURIComponent(bg.path)}`
  const gradient = GRADIENTS.find((g) => g.id === bg.gradient)
  return (
    <>
      {bg.kind === 'gradient' && <div className="app-bg-media" style={{ background: gradient?.css ?? GRADIENTS[0].css }} />}
      {bg.kind === 'image' && src && <img className="app-bg-media" src={src} alt="" style={{ objectFit: bg.fit }} />}
      {bg.kind === 'video' && src && !still && <video className="app-bg-media" src={src} autoPlay muted loop playsInline style={{ objectFit: bg.fit }} />}
      <div className="app-bg-dim" />
    </>
  )
}

export function AppBackground() {
  const kind = useStore((s) => s.settings.appearance.background.kind)
  if (kind === 'none') return null
  return <div className="app-bg" aria-hidden><BackdropMedia /></div>
}

/** Own copy of the background for phone panels that slide over the chat (WebKit cannot
 * blur through a nested backdrop-filter); a video stays a single element on the page. */
export function BackdropLayer() {
  const kind = useStore((s) => s.settings.appearance.background.kind)
  if (kind === 'none') return null
  return <div className="mw-backdrop" aria-hidden><BackdropMedia still /><div className="mw-backdrop-glass" /></div>
}
