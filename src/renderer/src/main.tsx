import { createRoot } from 'react-dom/client'
import '@xterm/xterm/css/xterm.css'
import './styles/tokens.css'
import './styles/app.css'
import './styles/chat.css'
import './styles/dialogs.css'
import './styles/remote.css'
import './styles/mobile.css'
import { trackMobileViewport } from './mobile'
import { App } from './components/App'
import { bootstrap } from './store'

trackMobileViewport()
void bootstrap()
createRoot(document.getElementById('root')!).render(<App />)
