import { type ChangeEvent, useCallback, useEffect, useRef, useState } from 'react'
import { getDocument, GlobalWorkerOptions, TextLayer, type PDFDocumentProxy } from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import OutlinePanel from './OutlinePanel'
import ThumbnailPanel from './ThumbnailPanel'
import AiPanel, { type AiPanelHandle } from './AiPanel'

GlobalWorkerOptions.workerSrc = pdfWorkerUrl

const DEFAULT_PDF = 'https://arxiv.org/pdf/2607.11881'
const ZOOM_STEPS = [0.7, 0.85, 1, 1.15, 1.3, 1.5]

type IconName =
  | 'search' | 'left' | 'right' | 'minus' | 'plus'
  | 'download' | 'upload' | 'copy' | 'more' | 'close' | 'file'
  | 'list' | 'grid' | 'sparkle'

const ICON_PATHS: Record<IconName, React.ReactNode> = {
  search: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="m16 16 4 4" />
    </>
  ),
  left: <path d="m15 18-6-6 6-6" />,
  right: <path d="m9 18 6-6-6-6" />,
  minus: <path d="M5 12h14" />,
  plus: (
    <>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </>
  ),
  download: (
    <>
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 21h14" />
    </>
  ),
  upload: (
    <>
      <path d="M12 16V3" />
      <path d="m7 8 5-5 5 5" />
      <path d="M5 21h14" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="1" fill="currentColor" />
      <circle cx="12" cy="12" r="1" fill="currentColor" />
      <circle cx="19" cy="12" r="1" fill="currentColor" />
    </>
  ),
  close: (
    <>
      <path d="m6 6 12 12" />
      <path d="m18 6-12 12" />
    </>
  ),
  file: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <path d="M14 2v6h6" />
      <path d="M8 13h8M8 17h6" />
    </>
  ),
  list: (
    <>
      <path d="M8 6h13" />
      <path d="M8 12h13" />
      <path d="M8 18h13" />
      <path d="M3 6h.01" />
      <path d="M3 12h.01" />
      <path d="M3 18h.01" />
    </>
  ),
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </>
  ),
  sparkle: (
    <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Z" />
  ),
}

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICON_PATHS[name]}
    </svg>
  )
}

/** 规整 PDF 文字层复制出来的文本：去软换行、合并断词、压缩多余空白。 */
function normalizePdfText(value: string) {
  return value
    .replace(/­/g, '')
    .replace(/ /g, ' ')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/([A-Za-z])-\n([a-z])/g, '$1$2')
    .replace(/([A-Za-z0-9])\n([A-Za-z0-9])/g, '$1 $2')  // 英文/数字跨行：加空格
    .replace(/([一-龥])\n([一-龥])/g, '$1$2')  // 中文跨行：不加空格
    .replace(/[\t ]*\n[\t ]*/g, '\n')           // 换行周围空白归并
    .replace(/\n{3,}/g, '\n\n')                  // 多空行压成最多一个空行
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

type TextSelection = { text: string; left: number; top: number }


function PdfPage({ pdf, pageNumber, scale, onAsk }: {
  pdf: PDFDocumentProxy
  pageNumber: number
  scale: number
  onAsk?: (text: string, prompt: string) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textLayerRef = useRef<HTMLDivElement>(null)
  const pageRef = useRef<HTMLElement>(null)

  const [error, setError] = useState(false)
  const [selection, setSelection] = useState<TextSelection | null>(null)
  // selection 的 ref 镜像：effect deps 不含 selection，闭包里读 ref 拿到最新值
  const selectionRef = useRef<TextSelection | null>(null)
  const commitSelection = useCallback((next: TextSelection | null) => {
    selectionRef.current = next
    setSelection(next)
  }, [])
  const [copied, setCopied] = useState(false)
  // 选区 AI 输入框：点工具条「问AI」才展开
  const [prompt, setPrompt] = useState('')
  const [askOpen, setAskOpen] = useState(false)
  const askInputRef = useRef<HTMLInputElement>(null)
  // 正在拖选标记：拖选过程中不弹层，松手选区稳定后再显示（避免边选边弹/闪烁）
  const selectingRef = useRef(false)

  // 渲染单页：canvas 绘制 + 文字层覆盖，缩放或翻页时重渲。
  useEffect(() => {
    let cancelled = false
    let task: ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | undefined

    const canvas = canvasRef.current as HTMLCanvasElement
    const textLayer = textLayerRef.current as HTMLDivElement
    if (!canvas || !textLayer) return

    async function render() {
      try {
        setError(false)
        const page = await pdf.getPage(pageNumber)
        if (cancelled) return

        const viewport = page.getViewport({ scale })
        const ratio = window.devicePixelRatio || 1

        canvas.width = Math.floor(viewport.width * ratio)
        canvas.height = Math.floor(viewport.height * ratio)
        canvas.style.width = `${Math.floor(viewport.width)}px`
        canvas.style.height = `${Math.floor(viewport.height)}px`

        textLayer.replaceChildren()
        textLayer.style.width = `${Math.floor(viewport.width)}px`
        textLayer.style.height = `${Math.floor(viewport.height)}px`
        textLayer.style.setProperty('--total-scale-factor', `${scale}`)
        textLayer.style.setProperty('--scale-round-x', '1px')
        textLayer.style.setProperty('--scale-round-y', '1px')

        const context = canvas.getContext('2d', { alpha: false })
        if (!context) return

        task = page.render({ canvas, canvasContext: context, viewport, transform: [ratio, 0, 0, ratio, 0, 0] })
        await task.promise
        if (cancelled) return

        await new TextLayer({
          textContentSource: page.streamTextContent(),
          container: textLayer,
          viewport,
        }).render()
      } catch (cause) {
        if (!cancelled && (cause as Error).name !== 'RenderingCancelledException') setError(true)
      }
    }

    void render()
    return () => {
      cancelled = true
      task?.cancel()
    }
  }, [pdf, pageNumber, scale])

  // 跟踪文字选区位置，并接管 Ctrl+C 复制规整后的文本。
  useEffect(() => {
    const layer = textLayerRef.current
    const pageElement = pageRef.current
    if (!layer || !pageElement) return

    // 用当前原生选区计算并【显示】弹层。只在「应该显示」的时机调用（mouseup 后等）。
    const syncSelection = () => {
      const browserSelection = window.getSelection()
      if (
        !browserSelection ||
        browserSelection.isCollapsed ||
        !browserSelection.anchorNode ||
        !layer.contains(browserSelection.anchorNode)
      ) {
        return // 无有效选区：这里不主动清空。清空交给明确取消动作。
      }
      if (selectingRef.current) return // 拖选中：不弹，等松手

      const text = normalizePdfText(browserSelection.toString())
      if (!text) return

      const rect = browserSelection.getRangeAt(0).getBoundingClientRect()
      const pageRect = pageElement.getBoundingClientRect()
      const halfWidth = onAsk ? 150 : 44 // 弹层预估半宽（ask 模式 ~300/2，纯复制按钮更窄）
      const popH = onAsk ? 96 : 40       // 弹层预估高度，用于上方回退判定
      const gap = 8

      // 水平：居中于选区中心，clamp 不溢出页面左右
      const centerX = rect.left - pageRect.left + rect.width / 2
      const left = Math.max(halfWidth + 4, Math.min(centerX, pageRect.width - halfWidth - 4))

      // 垂直：默认在选区【下方】（贴近释放点），下方空间不足则回退【上方】
      const belowTop = rect.bottom - pageRect.top + gap
      const aboveTop = rect.top - pageRect.top - gap - popH
      // 保守判定：下方空间要 >= popH + 20px 余量，避免溢出压到下一页
      const useBelow = belowTop + popH + 20 <= pageRect.height
      const top = Math.max(8, useBelow ? belowTop : aboveTop)

      commitSelection({ text, left, top })
      setCopied(false)
    }

    // 明确取消：集中一处关弹层
    const clearSelection = () => {
      commitSelection(null)
      setPrompt('')
      setAskOpen(false)
    }

    const handleCopy = (event: ClipboardEvent) => {
      const browserSelection = window.getSelection()
      // input 打字可能让原生选区塌缩：弹层仍在时，回退用已固化的 selection.text
      if (!browserSelection?.anchorNode || !layer.contains(browserSelection.anchorNode)) {
        const fixed = selectionRef.current?.text
        if (fixed) {
          event.preventDefault()
          event.clipboardData?.setData('text/plain', fixed)
          setCopied(true)
        }
        return
      }
      const text = normalizePdfText(browserSelection.toString())
      if (!text) return
      event.preventDefault()
      event.clipboardData?.setData('text/plain', text)
      setCopied(true)
    }

    // 开始拖选 / 双击：标记拖选中，并关掉旧弹层让位
    const onDown = () => {
      selectingRef.current = true
      clearSelection()
    }
    const onUp = () => {
      selectingRef.current = false
      // 延迟一帧再同步，避开双击第二次 mousedown 的时序窗口，防止提前弹层闪烁
      requestAnimationFrame(() => {
        if (!selectingRef.current) syncSelection()
      })
    }

    // selectionchange：拖选中或弹层已开 → 不动 state；否则尝试用当前选区显示
    const onSelectionChange = () => {
      if (selectingRef.current) return
      if (selectionRef.current) return // 弹层已开，不因塌缩清空（修复 input 打字关闭弹层）
      syncSelection()
    }

    // 点击弹层外空白收起（mousedown 落在 layer 外 且 弹层外）
    const isInsidePopover = (target: EventTarget | null): boolean => {
      if (!(target instanceof Node)) return false
      return !!(target as HTMLElement).closest?.('.selection-pop')
    }
    const onDocDown = (event: MouseEvent | TouchEvent) => {
      if (!selectionRef.current) return
      const target = (event as MouseEvent).target
      if (target instanceof Node && layer.contains(target)) return // layer 内交给 onDown
      if (isInsidePopover(target)) return // 弹层内：JSX 已 stopPropagation，兜底
      clearSelection()
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && selectionRef.current) clearSelection()
    }

    document.addEventListener('selectionchange', onSelectionChange)
    layer.addEventListener('mousedown', onDown)
    document.addEventListener('mouseup', onUp)
    document.addEventListener('mousedown', onDocDown)
    document.addEventListener('touchstart', onDocDown, { passive: true }) // 移动端点空白收起
    document.addEventListener('keydown', onKeyDown)
    layer.addEventListener('copy', handleCopy)
    return () => {
      document.removeEventListener('selectionchange', onSelectionChange)
      layer.removeEventListener('mousedown', onDown)
      document.removeEventListener('mouseup', onUp)
      document.removeEventListener('mousedown', onDocDown)
      document.removeEventListener('touchstart', onDocDown)
      document.removeEventListener('keydown', onKeyDown)
      layer.removeEventListener('copy', handleCopy)
      clearSelection() // 翻页/缩放重挂：收起弹层，避免坐标错位
    }
  }, [pageNumber, scale, onAsk, commitSelection])

  const copySelectedText = async () => {
    if (!selection) return
    await navigator.clipboard.writeText(selection.text)
    setCopied(true)
  }

  if (error) return <div className="page-error">此页无法渲染</div>

  return (
    <article className="pdf-page" ref={pageRef}>
      <canvas ref={canvasRef} />
      <div className="textLayer" ref={textLayerRef} />
      {selection && (
        <div
          className="selection-pop"
          style={{ left: selection.left, top: selection.top }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {onAsk && askOpen ? (
            // 展开态：输入框（点「问AI」后出现）
            <div className="selection-ask">
              <div className="selection-ask-presets">
                {['解释这段', '翻译为中文', '提炼要点'].map((p) => (
                  <button
                    key={p}
                    type="button"
                    className="selection-preset"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      onAsk(selection.text, p)
                      setPrompt('')
                      setAskOpen(false)
                    }}
                  >
                    {p}
                  </button>
                ))}
              </div>
              <input
                ref={askInputRef}
                className="selection-ask-input"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    if (onAsk) {
                      onAsk(selection.text, prompt)
                      setPrompt('')
                      setAskOpen(false)
                    }
                  }
                  if (e.key === 'Escape') {
                    setAskOpen(false)
                    setPrompt('')
                  }
                }}
                placeholder="问点什么…（回车发送，Esc 收起）"
              />
            </div>
          ) : (
            // 默认态：轻量工具条（图标按钮，preventDefault 不破坏选中高亮）
            <div className="selection-bar">
              <button
                type="button"
                className="selection-tool"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => void copySelectedText()}
                title="复制选中文字"
              >
                <Icon name="copy" size={14} />
                {copied ? '已复制' : '复制'}
              </button>
              {onAsk && (
                <>
                  <span className="selection-tool-sep" />
                  {[
                    { label: '解释', prompt: '解释这段' },
                    { label: '翻译', prompt: '翻译为中文' },
                    { label: '要点', prompt: '提炼要点' },
                  ].map((a) => (
                    <button
                      key={a.label}
                      type="button"
                      className="selection-tool"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => onAsk(selection.text, a.prompt)}
                      title={a.prompt}
                    >
                      {a.label}
                    </button>
                  ))}
                  <span className="selection-tool-sep" />
                  <button
                    type="button"
                    className="selection-tool primary"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      setAskOpen(true)
                      requestAnimationFrame(() => askInputRef.current?.focus())
                    }}
                    title="自定义提问"
                  >
                    <Icon name="sparkle" size={14} /> 问 AI
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </article>
  )
}

function LazyPdfPage({ pdf, pageNumber, scale, scrollRoot, onAsk }: {
  pdf: PDFDocumentProxy
  pageNumber: number
  scale: number
  scrollRoot: HTMLElement | null
  onAsk?: (text: string, prompt: string) => void
}) {
  const slotRef = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(pageNumber <= 2)

  // 滚动接近视口时才真正渲染该页，避免一次性渲染整本 PDF。
  useEffect(() => {
    const slot = slotRef.current
    if (!slot || !scrollRoot || visible) return

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setVisible(true)
      },
      { root: scrollRoot, rootMargin: '900px 0px' },
    )
    observer.observe(slot)
    return () => observer.disconnect()
  }, [scrollRoot, visible])

  return (
    <div
      className="pdf-page-slot"
      ref={slotRef}
      data-page-number={pageNumber}
      style={{ '--page-scale': scale } as React.CSSProperties}
    >
      {visible ? (
        <PdfPage pdf={pdf} pageNumber={pageNumber} scale={scale} onAsk={onAsk} />
      ) : (
        <div className="pdf-page-placeholder"><span>第 {pageNumber} 页</span></div>
      )}
    </div>
  )
}

export default function App() {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [source, setSource] = useState(DEFAULT_PDF)
  const [url, setUrl] = useState(DEFAULT_PDF)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [page, setPage] = useState(1)
  const [pages, setPages] = useState(0)
  const [zoom, setZoom] = useState(1)
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)
  const [panelTab, setPanelTab] = useState<'outline' | 'thumbs'>('outline')
  const [aiOpen, setAiOpen] = useState(false)
  const [fileName, setFileName] = useState('2607.11881.pdf')

  const fileInput = useRef<HTMLInputElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const aiRef = useRef<AiPanelHandle>(null)

  // 加载 PDF 源（URL 或本地 blob），切换 source 时重新加载。
  useEffect(() => {
    let active = true
    let task: ReturnType<typeof getDocument> | undefined

    async function load() {
      setLoading(true)
      setError('')
      setPdf(null)
      setPage(1)
      try {
        task = getDocument({ url: source })
        const doc = await task.promise
        if (!active) return
        const meta = await doc.getMetadata().catch(() => null)
        const info = (meta?.info ?? {}) as Record<string, unknown>
        console.log('[PDF] 文档加载完成:', {
          source,
          fingerprints: doc.fingerprints,
          总页数: doc.numPages,
          标题: (info.Title as string) ?? '(无)',
          作者: (info.Author as string) ?? '(无)',
        })
        setPdf(doc)
        setPages(doc.numPages)
      } catch (cause) {
        console.error('[PDF] 加载失败:', cause)
        if (active) setError('无法加载这份 PDF。请检查链接，或直接上传本地文件。')
      } finally {
        if (active) setLoading(false)
      }
    }

    void load()
    return () => {
      active = false
      task?.destroy()
    }
  }, [source])

  // 根据滚动位置同步工具栏里的当前页码。
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
        return Math.abs(slot.getBoundingClientRect().top - stageTop) <
          Math.abs(best.getBoundingClientRect().top - stageTop)
          ? slot
          : best
      }, null)

      const nextPage = Number(closest?.dataset.pageNumber)
      if (nextPage) setPage((current) => (current === nextPage ? current : nextPage))
    }

    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(updateCurrentPage)
    }

    stage.addEventListener('scroll', onScroll, { passive: true })
    updateCurrentPage()
    return () => {
      stage.removeEventListener('scroll', onScroll)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [pdf, pages, zoom])

  const updateZoom = (direction: -1 | 1) => {
    const index = ZOOM_STEPS.findIndex((item) => item >= zoom - 0.01)
    setZoom(ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, index + direction))])
  }

  const goToPage = (nextPage: number) => {
    const target = Math.max(1, Math.min(pages, nextPage))
    setPage(target)
    requestAnimationFrame(() =>
      stageRef.current
        ?.querySelector<HTMLElement>(`[data-page-number="${target}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
    )
  }

  // 缩略图点击：只在目标页不可见时滚动最小距离，避免强制顶到顶部造成突兀
  const goToPageSoft = (nextPage: number) => {
    const target = Math.max(1, Math.min(pages, nextPage))
    setPage(target)
    requestAnimationFrame(() =>
      stageRef.current
        ?.querySelector<HTMLElement>(`[data-page-number="${target}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }),
    )
  }

  // 悬浮摘要：确保 AI 面板已展开，再调用对应摘要动作
  const triggerSummary = (mode: 'page' | 'all') => {
    if (!aiOpen) setAiOpen(true)
    requestAnimationFrame(() => {
      // 面板挂载需要一帧，再延一帧调用
      requestAnimationFrame(() => {
        const handle = aiRef.current
        if (!handle) return
        if (mode === 'page') handle.summarizePage()
        else handle.summarizeAll()
      })
    })
  }

  // 选中文字 → 打开面板，用用户自写的 prompt（或预设）处理选中文本
  const askSelection = (text: string, prompt: string) => {
    if (!aiOpen) setAiOpen(true)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => aiRef.current?.askWithPrompt(text, prompt))
    })
  }

  const openUrl = () => {
    if (!url.trim()) return
    setFileName(url.split('/').pop() || 'online-document.pdf')
    setSource(url.trim())
    setOpen(false)
  }

  const loadFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setFileName(file.name)
    setSource(URL.createObjectURL(file))
    setOpen(false)
  }

  const download = () => {
    const a = document.createElement('a')
    a.href = source
    a.download = fileName
    a.click()
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">T</span>
          <span className="brand-token">okenPub</span>
          <i />
          <small>Reader</small>
        </div>
      </header>

      <main className="workspace">
        <aside className="sidebar">
          <div className="paper-id"><b /> PAPER</div>
          <h1>AI在线阅读</h1>
          <p className="paper-description">保留原始排版与可选择文字的浏览体验，适合论文、报告与长文档阅读。</p>
          <hr />
          <div className="side-section">
            <p>文档导航</p>
            <button className="side-link active"><Icon name="file" size={16} /> PDF 阅读器</button>
            <button className="side-link" onClick={() => setOpen(true)}><Icon name="upload" size={16} /> 打开其他 PDF</button>
          </div>
        </aside>

        <section className="reader-area">
          <div className="reader-toolbar">
            <div className="document-name">
              <button
                className={`icon-button outline-toggle${panelOpen ? ' active' : ''}`}
                onClick={() => setPanelOpen((v) => !v)}
                title="目录"
                aria-label="目录"
              >
                <Icon name="list" size={16} />
              </button>
              <Icon name="file" size={17} />
              <span>{fileName}</span>
              <b />
              {pdf && !error && (
                <button
                  type="button"
                  className="summarize-btn"
                  onClick={() => triggerSummary('all')}
                  title="用 AI 生成全文摘要"
                >
                  <Icon name="sparkle" size={14} /> 全文摘要
                </button>
              )}
            </div>
            <div className="toolbar-controls">
              <div className="pager">
                <button onClick={() => goToPage(page - 1)} disabled={page === 1}><Icon name="left" /></button>
                <span>
                  <input
                    aria-label="页码"
                    value={page}
                    onChange={(e) => {
                      const number = Number(e.target.value)
                      if (number >= 1 && number <= pages) goToPage(number)
                    }}
                  />{' '}/ {pages || '—'}
                </span>
                <button onClick={() => goToPage(page + 1)} disabled={page === pages}><Icon name="right" /></button>
              </div>
              <div className="zoom">
                <button onClick={() => updateZoom(-1)}><Icon name="minus" size={16} /></button>
                <span>{Math.round(zoom * 100)}%</span>
                <button onClick={() => updateZoom(1)}><Icon name="plus" size={16} /></button>
              </div>
              <button className={`icon-button ai-toggle${aiOpen ? ' active' : ''}`} onClick={() => setAiOpen((v) => !v)} title="AI 助手" aria-label="AI 助手">
                <Icon name="sparkle" size={17} />
              </button>
              <button className="icon-button" onClick={download}><Icon name="download" /></button>
              <button className="icon-button"><Icon name="more" /></button>
            </div>
          </div>

          <div className="reader-body">
            {panelOpen && pdf && !error && (
              <aside className="side-panel" role="navigation" aria-label="文档导航">
                <div className="panel-tabs">
                  <button
                    type="button"
                    className={`panel-tab${panelTab === 'outline' ? ' active' : ''}`}
                    onClick={() => setPanelTab('outline')}
                  >
                    <Icon name="list" size={14} /> 目录
                  </button>
                  <button
                    type="button"
                    className={`panel-tab${panelTab === 'thumbs' ? ' active' : ''}`}
                    onClick={() => setPanelTab('thumbs')}
                  >
                    <Icon name="grid" size={14} /> 缩略图
                  </button>
                  <button
                    type="button"
                    className="icon-button panel-close"
                    onClick={() => setPanelOpen(false)}
                    title="收起"
                    aria-label="收起"
                  >
                    <Icon name="close" size={15} />
                  </button>
                </div>
                <div className="panel-content">
                  {panelTab === 'outline'
                    ? <OutlinePanel pdf={pdf} onNavigate={goToPage} hideHeader />
                    : <ThumbnailPanel pdf={pdf} pages={pages} page={page} onNavigate={goToPageSoft} hideHeader />}
                </div>
              </aside>
            )}

            <div className="document-stage" ref={stageRef}>
              {loading && (
                <div className="loading-card"><i /><p>正在加载 PDF…</p></div>
              )}
              {error && (
                <div className="error-card">
                  <Icon name="file" size={28} />
                  <h2>暂时无法预览</h2>
                  <p>{error}</p>
                  <button onClick={() => setOpen(true)}>打开 PDF</button>
                </div>
              )}
              {pdf && !error && (
                <div className="pdf-scroll-list">
                  {Array.from({ length: pages }, (_, index) => (
                    <LazyPdfPage
                      key={`${index + 1}-${zoom}`}
                      pdf={pdf}
                      pageNumber={index + 1}
                      scale={zoom}
                      scrollRoot={stageRef.current}
                      onAsk={askSelection}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>

          {pdf && !error && (
            <AiPanel
              ref={aiRef}
              pdf={pdf}
              page={page}
              visible={aiOpen}
              onClose={() => setAiOpen(false)}
            />
          )}
        </section>
      </main>

      {open && (
        <div className="modal-backdrop" onMouseDown={() => setOpen(false)}>
          <section className="open-modal" onMouseDown={(e) => e.stopPropagation()}>
            <button className="close-button" onClick={() => setOpen(false)}><Icon name="close" /></button>
            <div className="modal-icon"><Icon name="file" size={25} /></div>
            <h2>打开 PDF 文档</h2>
            <p>粘贴一个 PDF 直链，或从设备中选择文件。</p>
            <label>
              PDF 链接
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && openUrl()}
              />
            </label>
            <button className="primary-button" onClick={openUrl}>在线预览</button>
            <div className="or"><i /> 或 <i /></div>
            <button className="upload-button" onClick={() => fileInput.current?.click()}>
              <Icon name="upload" size={17} /> 选择本地 PDF
            </button>
            <input
              ref={fileInput}
              className="hidden-input"
              type="file"
              accept="application/pdf"
              onChange={loadFile}
            />
          </section>
        </div>
      )}

      {search && (
        <div className="modal-backdrop" onMouseDown={() => setSearch(false)}>
          <section className="search-modal" onMouseDown={(e) => e.stopPropagation()}>
            <Icon name="search" />
            <input autoFocus placeholder="搜索论文、作者或 arXiv ID" />
            <kbd>ESC</kbd>
          </section>
        </div>
      )}
    </div>
  )
}
