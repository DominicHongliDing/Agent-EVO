import { createRoot } from 'react-dom/client'
import App from './App'
import ClinicalShowcase from './ClinicalShowcase'
import LocalEvaluations from './LocalEvaluations'
import './style.css'
import './management.css'
import './conversation.css'
import './public-platform.css'
import './theme.css'
import './motion.css'
import './task-layout.css'
import { MotionProvider } from './Motion'

const query = new URLSearchParams(location.search)
createRoot(document.getElementById('root')!).render(<MotionProvider>{query.get('space') === 'local-results' ? <LocalEvaluations/> : query.get('space') === 'mine' || (!query.has('space') && !query.has('run') && !query.has('batch')) ? <App /> : <ClinicalShowcase />}</MotionProvider>)
