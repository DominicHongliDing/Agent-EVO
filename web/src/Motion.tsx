import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion, MotionConfig, useReducedMotion, useAnimationControls } from 'motion/react'
export { AnimatePresence } from 'motion/react'

const ease = [0.22, 1, 0.36, 1] as const
const dialogs: HTMLElement[] = []
let dialogRootInert = false, dialogBodyOverflow = ''
export function MotionProvider({ children }: { children: ReactNode }) {
  return <MotionConfig reducedMotion="user" transition={{ duration: .22, ease }}>{children}</MotionConfig>
}
export function ContentTransition({ children, className, identity, variant = 'fade' }: { children: ReactNode; className?: string; identity?: string; variant?: 'fade' | 'page' | 'conversation' }) {
  const reduced = useReducedMotion()
  const controls = useAnimationControls()
  useEffect(() => {
    controls.set({ opacity: reduced ? 1 : .2, x: reduced || variant !== 'page' ? 0 : 18, y: reduced || variant === 'page' ? 0 : variant === 'conversation' ? 12 : 6, rotateY: reduced || variant !== 'page' ? 0 : -4 })
    void controls.start({ opacity: 1, x: 0, y: 0, rotateY: 0 })
    return () => controls.stop()
  }, [identity, variant, reduced, controls])
  return <motion.div className={`${className || ''} evo-transition evo-transition-${variant}`} animate={controls} transition={{ duration: reduced ? .01 : variant === 'page' ? .3 : .24, ease }} style={{ transformOrigin: 'left top' }}>{children}</motion.div>
}

export function MotionDisclosure({ summary, children, className, defaultOpen = false }: { summary: ReactNode; children: ReactNode; className?: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen), reduced = useReducedMotion(), id = useId()
  useEffect(() => { setOpen(defaultOpen) }, [defaultOpen])
  return <section className={`${className || ''} motion-disclosure ${open ? 'is-open' : ''}`}>
    <button className="motion-disclosure-trigger" id={`${id}-trigger`} aria-expanded={open} aria-controls={`${id}-body`} onClick={() => setOpen(value => !value)}>{summary}</button>
    <AnimatePresence initial={false}>{open && <motion.div id={`${id}-body`} role="region" aria-labelledby={`${id}-trigger`} initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: reduced ? .01 : .26, ease }} style={{ overflow: 'hidden' }}><div className="motion-disclosure-body">{children}</div></motion.div>}</AnimatePresence>
  </section>
}

/** Keep mounted through AnimatePresence exit; focus and scroll restore after exit. */
export function MotionDialog({ children, onClose, label, backdrop, panel, drawer = false, drawerSide = 'right' }: {
  children: ReactNode; onClose: () => void; label: string; backdrop: string; panel: string; drawer?: boolean; drawerSide?: 'left' | 'right'
}) {
  const ref = useRef<HTMLDivElement>(null)
  const close = useRef(onClose); close.current = onClose
  const reduced = useReducedMotion()
  useEffect(() => {
    const origin = document.activeElement as HTMLElement | null
    const root = document.getElementById('root')
    const element = ref.current!
    if (!dialogs.length) { dialogRootInert = root?.inert ?? false; dialogBodyOverflow = document.body.style.overflow }
    dialogs.forEach(dialog => { dialog.inert = true })
    dialogs.push(element)
    if (root) root.inert = true
    document.body.style.overflow = 'hidden'
    const focusables = () => [...(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]') || [])].filter(e => e.getClientRects().length > 0)
    ;(focusables()[0] || ref.current)?.focus()
    const keydown = (e: KeyboardEvent) => {
      if (dialogs[dialogs.length - 1] !== element) return
      if (e.key === 'Escape') { e.preventDefault(); close.current() }
      if (e.key === 'Tab') {
        const items = focusables(), first = items[0], last = items[items.length - 1]
        if (!first) { e.preventDefault(); ref.current?.focus(); return }
        if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { e.preventDefault(); last.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
      }
    }
    document.addEventListener('keydown', keydown)
    return () => {
      document.removeEventListener('keydown', keydown)
      const index = dialogs.indexOf(element)
      if (index >= 0) dialogs.splice(index, 1)
      const top = dialogs[dialogs.length - 1]
      if (top) top.inert = false
      if (root) root.inert = top ? true : dialogRootInert
      document.body.style.overflow = top ? 'hidden' : dialogBodyOverflow
      if (origin?.isConnected && (!top || top.contains(origin))) origin.focus()
    }
  }, [])
  return createPortal(<motion.div className={`${backdrop} evo-motion-overlay`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduced ? .01 : .18 }} onClick={e => { if (e.target === e.currentTarget) close.current() }}>
    <motion.div ref={ref} className={`${panel} evo-motion-panel`} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}
      initial={{ opacity: 0, x: reduced || !drawer ? 0 : drawerSide === 'left' ? -40 : 40, y: reduced || drawer ? 0 : 12, scale: reduced || drawer ? 1 : .975 }}
      animate={{ opacity: 1, x: 0, y: 0, scale: 1 }} exit={{ opacity: 0, x: reduced || !drawer ? 0 : drawerSide === 'left' ? -30 : 30, y: reduced || drawer ? 0 : 6, scale: reduced || drawer ? 1 : .985 }}
      transition={{ duration: reduced ? .01 : .24, ease }}>{children}</motion.div>
  </motion.div>, document.body)
}
