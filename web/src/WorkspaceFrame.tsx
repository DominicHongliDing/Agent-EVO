import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { ChevronRight, PanelLeftClose, PanelLeftOpen, RefreshCw, X } from 'lucide-react'
import { AnimatePresence, ContentTransition, MotionDialog } from './Motion'
import './workspace-frame.css'

const storageKey = 'evo.workspace.sidebar.v1'
function savedSidebar() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || '{}')
    return { width: Math.min(336, Math.max(208, Number(saved.width) || 244)), collapsed: saved.collapsed === true }
  } catch { return { width: 244, collapsed: false } }
}

export default function WorkspaceFrame({ navigation, title, pageKey, onHome, onRefresh, children }: {
  navigation: ReactNode; title: string; pageKey: string; onHome: () => void; onRefresh: () => void; children: ReactNode
}) {
  const [sidebar, setSidebar] = useState(savedSidebar)
  const [compact, setCompact] = useState(() => matchMedia('(max-width: 820px)').matches)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [dragging, setDragging] = useState(false)
  const drag = useRef<{ x: number; width: number; original: typeof sidebar } | null>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const query = matchMedia('(max-width: 820px)')
    const update = () => { setCompact(query.matches); setMobileOpen(false); setDragging(false); drag.current = null }
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  useEffect(() => { try { localStorage.setItem(storageKey, JSON.stringify(sidebar)) } catch { /* Layout still works without browser storage. */ } }, [sidebar])
  useLayoutEffect(() => { scroll.current?.scrollTo({ top: 0, left: 0 }); setMobileOpen(false) }, [pageKey])
  const expanded = compact ? mobileOpen : !sidebar.collapsed
  const toggleSidebar = () => compact ? setMobileOpen(open => !open) : setSidebar(old => ({ ...old, collapsed: !old.collapsed }))
  const closeMobileNavigation = (event: React.MouseEvent) => {
    if ((event.target as HTMLElement).closest('button.nav, button.side-section')) { setMobileOpen(false); toggle.current?.focus() }
  }
  return <div data-page={pageKey} className={`app-shell workspace-frame ${dragging ? 'is-resizing' : ''} ${sidebar.collapsed ? 'sidebar-collapsed' : ''}`} style={{ '--sidebar-width': `${sidebar.width}px` } as CSSProperties}>
    {!compact && <>
      <div className="sidebar-slot" inert={sidebar.collapsed} aria-hidden={sidebar.collapsed}>
        <aside id="workspace-navigation" className="sidebar" aria-label="工作空间导航">{navigation}</aside>
      </div>
      <div className="sidebar-resize" role="separator" aria-label="调整侧栏宽度" aria-orientation="vertical" aria-controls="workspace-navigation" aria-valuemin={0} aria-valuemax={336} aria-valuenow={sidebar.collapsed ? 0 : sidebar.width} aria-valuetext={sidebar.collapsed ? '侧栏已隐藏' : `侧栏宽度 ${sidebar.width} 像素`} tabIndex={0}
        title="拖动调整宽度，向左拖到底隐藏；双击收起或展开"
        onDoubleClick={toggleSidebar}
        onPointerDown={e => { if (e.button !== 0) return; e.preventDefault(); e.currentTarget.focus(); e.currentTarget.setPointerCapture(e.pointerId); drag.current = { x: e.clientX, width: sidebar.collapsed ? 0 : sidebar.width, original: sidebar }; setDragging(true) }}
        onPointerMove={e => { if (!drag.current) return; const width = drag.current.width + e.clientX - drag.current.x; setSidebar(old => width < 120 ? { ...old, collapsed: true } : { width: Math.min(336, Math.max(208, width)), collapsed: false }) }}
        onPointerUp={e => { drag.current = null; setDragging(false); if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId) }}
        onPointerCancel={() => { if (drag.current) setSidebar(drag.current.original); drag.current = null; setDragging(false) }}
        onLostPointerCapture={() => { drag.current = null; setDragging(false) }}
        onKeyDown={e => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', ' ', 'Escape'].includes(e.key)) return
          e.preventDefault()
          if (e.key === 'Escape') { if (drag.current) setSidebar(drag.current.original); drag.current = null; setDragging(false); return }
          if (e.key === 'Enter' || e.key === ' ') { toggleSidebar(); return }
          setSidebar(old => e.key === 'Home' || e.key === 'ArrowLeft' && (old.collapsed || old.width <= 208) ? { ...old, collapsed: true } : { width: e.key === 'End' ? 336 : Math.min(336, Math.max(208, old.collapsed ? 244 : old.width + (e.key === 'ArrowLeft' ? -16 : 16))), collapsed: false })
        }}><span/></div>
    </>}
    <main className="workspace-main">
      <header className="topbar"><div className="workspace-location">
        <button ref={toggle} className="icon-button sidebar-toggle" aria-label={expanded ? '收起侧栏' : '展开侧栏'} title={expanded ? '收起侧栏' : '展开侧栏'} aria-expanded={expanded} aria-controls="workspace-navigation" onClick={toggleSidebar}>{expanded ? <PanelLeftClose size={18}/> : <PanelLeftOpen size={18}/>}</button>
        <button className="breadcrumb workspace-home" onClick={() => { onHome(); scroll.current?.scrollTo({ top: 0, left: 0 }) }} title="返回评测总览">工作空间</button><ChevronRight size={14}/><strong>{title}</strong>
      </div><div className="top-actions"><span className="today">{new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })}</span><button className="icon-button" aria-label="刷新" title="刷新" onClick={onRefresh}><RefreshCw size={17}/></button></div></header>
      <div className="workspace-scroll" ref={scroll} role="region" aria-label="工作区内容" tabIndex={0}>
        <ContentTransition className="content" identity={pageKey} variant="page">{children}</ContentTransition>
      </div>
    </main>
    <AnimatePresence>{compact && mobileOpen && <MotionDialog key="mobile-navigation" label="工作空间导航" backdrop="workspace-mobile-backdrop" panel="workspace-mobile-panel" drawer drawerSide="left" onClose={() => setMobileOpen(false)}>
      <button className="icon-button mobile-sidebar-close" aria-label="收起侧栏" onClick={() => setMobileOpen(false)}><X size={18}/></button>
      <aside id="workspace-navigation" className="sidebar" onClick={closeMobileNavigation}>{navigation}</aside>
    </MotionDialog>}</AnimatePresence>
  </div>
}
