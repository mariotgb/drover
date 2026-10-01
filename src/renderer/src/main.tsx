import { createRoot } from 'react-dom/client'
import '@xterm/xterm/css/xterm.css'
import './styles/tokens.css'
import './styles/app.css'
import './styles/chat.css'
import './styles/dialogs.css'
import { App } from './components/App'
import { bootstrap } from './store'

void bootstrap()
createRoot(document.getElementById('root')!).render(<App />)
