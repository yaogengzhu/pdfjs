import { type ChangeEvent, useEffect, useRef, useState } from 'react'
import { getDocument, GlobalWorkerOptions, TextLayer, type PDFDocumentProxy } from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

GlobalWorkerOptions.workerSrc = pdfWorkerUrl

const DEFAULT_PDF = 'https://arxiv.org/pdf/2607.11881'
const ZOOM_STEPS = [0.7, 0.85, 1, 1.15, 1.3, 1.5]

type IconName = 'search' | 'left' | 'right' | 'minus' | 'plus' | 'download' | 'upload' | 'copy' | 'more' | 'close' | 'file'
function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, React.ReactNode> = {
    search: <><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></>, left: <path d="m15 18-6-6 6-6" />, right: <path d="m9 18 6-6-6-6" />, minus: <path d="M5 12h14" />, plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>, download: <><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></>, upload: <><path d="M12 16V3" /><path d="m7 8 5-5 5 5" /><path d="M5 21h14" /></>, copy: <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>, more: <><circle cx="5" cy="12" r="1" fill="currentColor" /><circle cx="12" cy="12" r="1" fill="currentColor" /><circle cx="19" cy="12" r="1" fill="currentColor" /></>, close: <><path d="m6 6 12 12" /><path d="m18 6-12 12" /></>, file: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6" /><path d="M8 13h8M8 17h6" /></>,
  }
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
}

function normalizePdfText(value: string) {
  return value.replace(/\u00ad/g, '').replace(/\u00a0/g, ' ').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/([A-Za-z])-\n([a-z])/g, '$1$2').replace(/\n+/g, ' ').replace(/[ \t]{2,}/g, ' ').trim()
}

function PdfPage({ pdf, pageNumber, scale }: { pdf: PDFDocumentProxy; pageNumber: number; scale: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null); const textLayerRef = useRef<HTMLDivElement>(null); const pageRef = useRef<HTMLElement>(null); const [error, setError] = useState(false); const [selection, setSelection] = useState<{ text: string; left: number; top: number } | null>(null); const [copied, setCopied] = useState(false)
  useEffect(() => {
    let cancelled = false; let task: ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | undefined
    if (!canvasRef.current || !textLayerRef.current) return
    const canvas = canvasRef.current as HTMLCanvasElement; const textLayer = textLayerRef.current as HTMLDivElement
    async function render() { try {
      setError(false); const page = await pdf.getPage(pageNumber); if (cancelled) return; const viewport = page.getViewport({ scale }); const ratio = window.devicePixelRatio || 1
      canvas.width = Math.floor(viewport.width * ratio); canvas.height = Math.floor(viewport.height * ratio); canvas.style.width = `${Math.floor(viewport.width)}px`; canvas.style.height = `${Math.floor(viewport.height)}px`
      textLayer.replaceChildren(); textLayer.style.width = `${Math.floor(viewport.width)}px`; textLayer.style.height = `${Math.floor(viewport.height)}px`; textLayer.style.setProperty('--total-scale-factor', `${scale}`); textLayer.style.setProperty('--scale-round-x', '1px'); textLayer.style.setProperty('--scale-round-y', '1px')
      const context = canvas.getContext('2d', { alpha: false }); if (!context) return
      task = page.render({ canvas, canvasContext: context, viewport, transform: [ratio, 0, 0, ratio, 0, 0] }); await task.promise; if (cancelled) return
      await new TextLayer({ textContentSource: page.streamTextContent(), container: textLayer, viewport }).render()
    } catch (cause) { if (!cancelled && (cause as Error).name !== 'RenderingCancelledException') setError(true) } }
    void render(); return () => { cancelled = true; task?.cancel() }
  }, [pdf, pageNumber, scale])
  useEffect(() => {
    const layer = textLayerRef.current; const pageElement = pageRef.current
    if (!layer || !pageElement) return
    const syncSelection = () => {
      const browserSelection = window.getSelection()
      if (!browserSelection || browserSelection.isCollapsed || !browserSelection.anchorNode || !layer.contains(browserSelection.anchorNode)) { setSelection(null); return }
      const text = normalizePdfText(browserSelection.toString())
      if (!text) { setSelection(null); return }
      const rect = browserSelection.getRangeAt(0).getBoundingClientRect(); const pageRect = pageElement.getBoundingClientRect()
      setSelection({ text, left: Math.max(10, Math.min(rect.left - pageRect.left + rect.width / 2, pageRect.width - 54)), top: Math.max(8, rect.top - pageRect.top - 42) }); setCopied(false)
    }
    const handleCopy = (event: ClipboardEvent) => {
      const browserSelection = window.getSelection()
      if (!browserSelection?.anchorNode || !layer.contains(browserSelection.anchorNode)) return
      const text = normalizePdfText(browserSelection.toString())
      if (!text) return
      event.preventDefault(); event.clipboardData?.setData('text/plain', text); setCopied(true)
    }
    document.addEventListener('selectionchange', syncSelection); layer.addEventListener('copy', handleCopy)
    return () => { document.removeEventListener('selectionchange', syncSelection); layer.removeEventListener('copy', handleCopy) }
  }, [pageNumber, scale])
  const copySelectedText = async () => { if (!selection) return; await navigator.clipboard.writeText(selection.text); setCopied(true) }
  return error ? <div className="page-error">此页无法渲染</div> : <article className="pdf-page" ref={pageRef}><canvas ref={canvasRef} /><div className="textLayer" ref={textLayerRef} />{selection && <button className="selection-copy" style={{ left: selection.left, top: selection.top }} onMouseDown={(event) => event.preventDefault()} onClick={() => void copySelectedText()}><Icon name="copy" size={14} />{copied ? '已复制' : '复制文字'}</button>}</article>
}

function LazyPdfPage({ pdf, pageNumber, scale, scrollRoot }: { pdf: PDFDocumentProxy; pageNumber: number; scale: number; scrollRoot: HTMLElement | null }) {
  const slotRef = useRef<HTMLDivElement>(null); const [visible, setVisible] = useState(pageNumber <= 2)
  useEffect(() => {
    const slot = slotRef.current
    if (!slot || !scrollRoot || visible) return
    const observer = new IntersectionObserver(([entry]) => { if (entry.isIntersecting) setVisible(true) }, { root: scrollRoot, rootMargin: '900px 0px' })
    observer.observe(slot)
    return () => observer.disconnect()
  }, [scrollRoot, visible])
  return <div className="pdf-page-slot" ref={slotRef} data-page-number={pageNumber} style={{ '--page-scale': scale } as React.CSSProperties}>{visible ? <PdfPage pdf={pdf} pageNumber={pageNumber} scale={scale} /> : <div className="pdf-page-placeholder"><span>第 {pageNumber} 页</span></div>}</div>
}

export default function App() {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null); const [source, setSource] = useState(DEFAULT_PDF); const [url, setUrl] = useState(DEFAULT_PDF)
  const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [page, setPage] = useState(1); const [pages, setPages] = useState(0); const [zoom, setZoom] = useState(1); const [open, setOpen] = useState(false); const [search, setSearch] = useState(false); const [fileName, setFileName] = useState('2607.11881.pdf'); const fileInput = useRef<HTMLInputElement>(null); const stageRef = useRef<HTMLDivElement>(null)
  useEffect(() => { let active = true; let task: ReturnType<typeof getDocument> | undefined
    async function load() { setLoading(true); setError(''); setPdf(null); setPage(1); try { task = getDocument({ url: source }); const doc = await task.promise; if (active) { setPdf(doc); setPages(doc.numPages) } } catch { if (active) setError('无法加载这份 PDF。请检查链接，或直接上传本地文件。') } finally { if (active) setLoading(false) } }
    void load(); return () => { active = false; task?.destroy() }
  }, [source])
  useEffect(() => {
    const stage = stageRef.current
    if (!stage || !pdf) return
    let frame = 0
    const updateCurrentPage = () => {
      frame = 0
      const stageTop = stage.getBoundingClientRect().top
      const slots = Array.from(stage.querySelectorAll<HTMLElement>('[data-page-number]'))
      const closest = slots.reduce<HTMLElement | null>((best, slot) => {
        if (!best) return slot
        return Math.abs(slot.getBoundingClientRect().top - stageTop) < Math.abs(best.getBoundingClientRect().top - stageTop) ? slot : best
      }, null)
      const nextPage = Number(closest?.dataset.pageNumber)
      if (nextPage) setPage((currentPage) => currentPage === nextPage ? currentPage : nextPage)
    }
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(updateCurrentPage) }
    stage.addEventListener('scroll', onScroll, { passive: true }); updateCurrentPage()
    return () => { stage.removeEventListener('scroll', onScroll); if (frame) cancelAnimationFrame(frame) }
  }, [pdf, pages, zoom])
  const updateZoom = (direction: -1 | 1) => { const index = ZOOM_STEPS.findIndex((item) => item >= zoom - .01); setZoom(ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, index + direction))]) }
  const goToPage = (nextPage: number) => { const target = Math.max(1, Math.min(pages, nextPage)); setPage(target); requestAnimationFrame(() => stageRef.current?.querySelector<HTMLElement>(`[data-page-number="${target}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })) }
  const openUrl = () => { if (!url.trim()) return; setFileName(url.split('/').pop() || 'online-document.pdf'); setSource(url.trim()); setOpen(false) }
  const loadFile = (e: ChangeEvent<HTMLInputElement>) => { const file = e.target.files?.[0]; if (!file) return; setFileName(file.name); setSource(URL.createObjectURL(file)); setOpen(false) }
  const download = () => { const a = document.createElement('a'); a.href = source; a.download = fileName; a.click() }
  return <div className="app-shell">
    <header className="topbar"><div className="brand"><span className="brand-mark">T</span><span className="brand-token">okenPub</span><i /><small>Reader</small></div></header>
    <main className="workspace"><aside className="sidebar"><div className="paper-id"><b /> PAPER</div><h1>PDF 文档在线阅读</h1><p className="paper-description">保留原始排版与可选择文字的浏览体验，适合论文、报告与长文档阅读。</p><div className="paper-meta">arXiv: 2607.11881　•　Jul 2026</div><div className="author-list"><span>Y</span>你的文档空间</div><hr /><div className="side-section"><p>文档导航</p><button className="side-link active"><Icon name="file" size={16} /> PDF 阅读器</button><button className="side-link" onClick={() => setOpen(true)}><Icon name="upload" size={16} /> 打开其他 PDF</button></div></aside>
      <section className="reader-area"><div className="reader-toolbar"><div className="document-name"><Icon name="file" size={17} /><span>{fileName}</span><b /></div><div className="toolbar-controls"><div className="pager"><button onClick={() => goToPage(page - 1)} disabled={page === 1}><Icon name="left" /></button><span><input aria-label="页码" value={page} onChange={(e) => { const number = Number(e.target.value); if (number >= 1 && number <= pages) goToPage(number) }} /> / {pages || '—'}</span><button onClick={() => goToPage(page + 1)} disabled={page === pages}><Icon name="right" /></button></div><div className="zoom"><button onClick={() => updateZoom(-1)}><Icon name="minus" size={16} /></button><span>{Math.round(zoom * 100)}%</span><button onClick={() => updateZoom(1)}><Icon name="plus" size={16} /></button></div><button className="icon-button" onClick={download}><Icon name="download" /></button><button className="icon-button"><Icon name="more" /></button></div></div>
      <div className="document-stage" ref={stageRef}>{loading && <div className="loading-card"><i /><p>正在加载 PDF…</p></div>}{error && <div className="error-card"><Icon name="file" size={28} /><h2>暂时无法预览</h2><p>{error}</p><button onClick={() => setOpen(true)}>打开 PDF</button></div>}{pdf && !error && <div className="pdf-scroll-list">{Array.from({ length: pages }, (_, index) => <LazyPdfPage key={`${index + 1}-${zoom}`} pdf={pdf} pageNumber={index + 1} scale={zoom} scrollRoot={stageRef.current} />)}</div>}</div></section></main>
    {open && <div className="modal-backdrop" onMouseDown={() => setOpen(false)}><section className="open-modal" onMouseDown={(e) => e.stopPropagation()}><button className="close-button" onClick={() => setOpen(false)}><Icon name="close" /></button><div className="modal-icon"><Icon name="file" size={25} /></div><h2>打开 PDF 文档</h2><p>粘贴一个 PDF 直链，或从设备中选择文件。</p><label>PDF 链接<input value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && openUrl()} /></label><button className="primary-button" onClick={openUrl}>在线预览</button><div className="or"><i /> 或 <i /></div><button className="upload-button" onClick={() => fileInput.current?.click()}><Icon name="upload" size={17} /> 选择本地 PDF</button><input ref={fileInput} className="hidden-input" type="file" accept="application/pdf" onChange={loadFile} /></section></div>}
    {search && <div className="modal-backdrop" onMouseDown={() => setSearch(false)}><section className="search-modal" onMouseDown={(e) => e.stopPropagation()}><Icon name="search" /><input autoFocus placeholder="搜索论文、作者或 arXiv ID" /><kbd>ESC</kbd></section></div>}
  </div>
}
