import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import LocalEvaluations from './LocalEvaluations'
import './style.css'
import './management.css'
import './conversation.css'
import './theme.css'
import './motion.css'
import './task-layout.css'
import { MotionProvider } from './Motion'

const space = new URLSearchParams(location.search).get('space')
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><MotionProvider>{space === 'local-results' ? <LocalEvaluations/> : <App />}</MotionProvider></React.StrictMode>)
