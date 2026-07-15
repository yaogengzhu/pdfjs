import { useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'

// 缩略图渲染宽度（CSS 像素），高度按页面比例自适应
const THUMB_WIDTH = 168

type ThumbnailPanelProps = {
  pdf: PDFDocumentProxy
  pages: number
  page: number
  onNavigate: (pageNumber: number) => void
  onClose?: () => void
  hideHeader?: boolean
}

export default function ThumbnailPanel({ pdf, pages, page, onNavigate, onClose, hideHeader }: ThumbnailPanelProps) {
  const list = (
    <ul className="thumb-list">
      {Array.from({ length: pages }, (_, i) => (
        <ThumbItem key={i} pdf={pdf} pageNumber={i + 1} active={page === i + 1} onNavigate={onNavigate} />
      ))}
    </ul>
  )

  // 嵌入模式：仅返回内容
  if (hideHeader) {
    return <div className="outline-scroll thumb-scroll">{list}</div>
  }

  return (
    <aside className="outline-panel thumb-panel" role="navigation" aria-label="页面缩略图">
      <div className="outline-header">
        <span className="outline-header-title">页面</span>
        {pages > 0 && <span className="outline-count">{pages} 页</span>}
        {onClose && (
          <button className="icon-button outline-close" onClick={onClose} title="收起" aria-label="收起缩略图">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m6 6 12 12" /><path d="m18 6-12 12" />
            </svg>
          </button>
        )}
      </div>
      <div className="outline-scroll thumb-scroll">{list}</div>
    </aside>
  )
}

function ThumbItem({ pdf, pageNumber, active, onNavigate }: {
  pdf: PDFDocumentProxy
  pageNumber: number
  active: boolean
  onNavigate: (pageNumber: number) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLButtonElement>(null)
  const [visible, setVisible] = useState(pageNumber <= 3) // 头几页先渲染，其余懒加载
  const [ratio, setRatio] = useState(0) // 渲染高度 / 宽度

  // 进入视口附近才开始渲染
  useEffect(() => {
    const el = wrapRef.current
    if (!el || visible) return
    const observer = new IntersectionObserver(
      ([entry]) => entry.isIntersecting && setVisible(true),
      { rootMargin: '600px 0px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [visible])

  // 渲染缩略图到 canvas
  useEffect(() => {
    if (!visible) return
    let cancelled = false
    let task: ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | undefined

    void (async () => {
      const canvas = canvasRef.current
      if (!canvas) return
      try {
        const page = await pdf.getPage(pageNumber)
        if (cancelled) return
        const base = page.getViewport({ scale: 1 })
        const scale = THUMB_WIDTH / base.width
        const viewport = page.getViewport({ scale })
        const dpr = window.devicePixelRatio || 1
        canvas.width = Math.floor(viewport.width * dpr)
        canvas.height = Math.floor(viewport.height * dpr)
        canvas.style.width = `${Math.floor(viewport.width)}px`
        canvas.style.height = `${Math.floor(viewport.height)}px`
        setRatio(viewport.height / viewport.width)
        const ctx = canvas.getContext('2d', { alpha: false })
        if (!ctx) return
        task = page.render({ canvas, canvasContext: ctx, viewport, transform: [dpr, 0, 0, dpr, 0, 0] })
        await task.promise
      } catch (cause) {
        if (!cancelled && (cause as Error).name !== 'RenderingCancelledException') {
          // 忽略，缩略图失败不阻塞
        }
      }
    })()

    return () => {
      cancelled = true
      task?.cancel()
    }
  }, [pdf, pageNumber, visible])

  return (
    <li className="thumb-item">
      <button
        type="button"
        ref={wrapRef}
        className={`thumb-card${active ? ' active' : ''}`}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onNavigate(pageNumber)}
        title={`第 ${pageNumber} 页`}
        // 未渲染时用预估比例占位，避免列表跳动
        style={{ height: ratio ? THUMB_WIDTH * ratio : THUMB_WIDTH * 1.3 }}
      >
        {visible ? (
          <canvas ref={canvasRef} />
        ) : (
          <span className="thumb-placeholder">第 {pageNumber} 页</span>
        )}
      </button>
      <span className={`thumb-page${active ? ' active' : ''}`}>{pageNumber}</span>
    </li>
  )
}
