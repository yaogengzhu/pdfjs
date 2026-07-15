import { forwardRef, useCallback, useImperativeHandle, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import type { PDFDocumentProxy } from 'pdfjs-dist'

const DEEPSEEK_URL = 'https://api.deepseek.com/v1/chat/completions'
const DEEPSEEK_MODEL = 'deepseek-chat'

// 配置 marked：启用 GFM、换行转 <br>，渲染更贴近聊天体验
marked.setOptions({ gfm: true, breaks: true })

/** 把 markdown 文本渲染为安全的 HTML。 */
function renderMarkdown(text: string): string {
  if (!text) return ''
  return DOMPurify.sanitize(marked.parse(text, { async: false }) as string)
}
const STORAGE_KEY = 'pdfreader.deepseek.key'

type Role = 'system' | 'user' | 'assistant'
type Message = { role: Role; content: string }

type AiPanelProps = {
  pdf: PDFDocumentProxy
  page: number
  visible?: boolean
  onClose?: () => void
}

/** 暴露给父组件的命令：生成当前页摘要 / 全文摘要 / 解释选中文本。 */
export type AiPanelHandle = {
  summarizePage: () => void
  summarizeAll: () => void
  explain: (text: string) => void
  hasKey: () => boolean
  busy: () => boolean
}

/** 取指定页的可读纯文本（pdf.js textContent 拼接）。 */
async function getPageText(pdf: PDFDocumentProxy, pageNumber: number): Promise<string> {
  const page = await pdf.getPage(pageNumber)
  const content = await page.getTextContent()
  return content.items
    .map((item) => ('str' in item ? item.str : ''))
    .join('')
    .replace(/­/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

/** 取全文文本（首页起拼接到上限，超长则截断）。 */
async function getAllText(pdf: PDFDocumentProxy, maxChars = 6000): Promise<string> {
  const parts: string[] = []
  let total = 0
  for (let i = 1; i <= pdf.numPages; i++) {
    const text = await getPageText(pdf, i)
    parts.push(text)
    total += text.length
    if (total >= maxChars) break
  }
  const full = parts.join('\n\n')
  return full.length > maxChars ? full.slice(0, maxChars) + '\n\n（内容过长，已截断）' : full
}

/** 调用 DeepSeek（OpenAI 兼容格式）。 */
async function chat(messages: Message[], apiKey: string, onDelta: (text: string) => void) {
  const response = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages,
      stream: true,
    }),
  })

  if (!response.ok || !response.body) {
    const errText = await response.text().catch(() => response.statusText)
    throw new Error(`DeepSeek 接口错误 (${response.status})：${errText.slice(0, 200)}`)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let full = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    // SSE 按 \n\n 分块
    const blocks = buffer.split('\n\n')
    buffer = blocks.pop() ?? ''
    for (const block of blocks) {
      const line = block.split('\n').find((l) => l.startsWith('data:'))
      if (!line) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') return full
      try {
        const delta = JSON.parse(data).choices?.[0]?.delta?.content
        if (delta) {
          full += delta
          onDelta(delta)
        }
      } catch {
        // 跳过不完整 JSON
      }
    }
  }
  return full
}

const AiPanel = forwardRef<AiPanelHandle, AiPanelProps>(function AiPanel({ pdf, page, visible = true, onClose }, ref) {
  const [apiKey, setApiKey] = useState('')
  const [showKeyInput, setShowKeyInput] = useState(false)
  const [keyDraft, setKeyDraft] = useState('')
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState<null | 'summary' | 'ask'>(null)
  // 拖动位置：null 时使用 CSS 默认定位，拖动后覆盖为绝对坐标
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const panelRef = useRef<HTMLElement>(null)
  const [error, setError] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  // 读取本地存的 key
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) setApiKey(saved)
    else setShowKeyInput(true)
  }, [])

  // 新消息后滚到底
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages, loading])

  const saveKey = () => {
    const trimmed = keyDraft.trim()
    if (!trimmed) return
    localStorage.setItem(STORAGE_KEY, trimmed)
    setApiKey(trimmed)
    setShowKeyInput(false)
    setKeyDraft('')
    setError('')
  }

  const clearKey = () => {
    localStorage.removeItem(STORAGE_KEY)
    setApiKey('')
    setShowKeyInput(true)
  }

  const runChat = async (
    history: Message[],
    mode: 'summary' | 'ask',
    contextText?: string,
    systemPrompt?: string,
  ) => {
    if (!apiKey) {
      setShowKeyInput(true)
      return
    }
    setError('')
    setLoading(mode)
    // 预留一条空的 assistant 消息，流式填充
    setMessages([...history, { role: 'assistant', content: '' }])

    try {
      const ctx = contextText ?? (await getPageText(pdf, page))
      const systemMsg: Message = {
        role: 'system',
        content:
          systemPrompt ??
          '你是一位学术阅读助手。用户会提供 PDF 论文的文字内容，请基于这些内容回答问题或生成摘要。' +
            '回答用简洁的中文，使用 Markdown 分点排版。如果内容不足以回答，请如实说明。以下是相关内容：\n\n' +
            (ctx || '(未能提取到文字)'),
      }
      await chat([systemMsg, ...history], apiKey, (delta) => {
        setMessages((prev) => {
          const next = [...prev]
          const last = next[next.length - 1]
          next[next.length - 1] = { role: 'assistant', content: last.content + delta }
          return next
        })
      })
    } catch (cause) {
      setError((cause as Error).message)
      // 移除空的 assistant 占位
      setMessages((prev) =>
        prev[prev.length - 1]?.content === '' ? prev.slice(0, -1) : prev,
      )
    } finally {
      setLoading(null)
    }
  }

  // 当前页摘要
  const runSummaryPage = useCallback(() => {
    void runChat(
      [{ role: 'user', content: `请对当前页（第 ${page} 页）的内容生成摘要：核心观点、关键结论、值得注意的方法或数据。` }],
      'summary',
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, apiKey])

  // 全文摘要
  const runSummaryAll = useCallback(() => {
    void (async () => {
      if (!apiKey) {
        setShowKeyInput(true)
        return
      }
      const allText = await getAllText(pdf)
      void runChat(
        [{ role: 'user', content: '请对这篇论文生成全文摘要：研究问题、核心方法、主要贡献、关键结论与局限。用 Markdown 分点呈现。' }],
        'summary',
        allText,
      )
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdf, apiKey])

  // 解释选中文本（从 PDF 选区触发）
  const runExplain = useCallback(
    (selected: string) => {
      const quote = selected.length > 1200 ? `${selected.slice(0, 1200)}…` : selected
      void runChat(
        [
          {
            role: 'user',
            content:
              `请解释下面这段从论文中选取的文字：背景含义、关键术语、为什么重要。先用一句话概括，再分点展开。使用 Markdown 排版。\n\n` +
              `"""\n${quote}\n"""`,
          },
        ],
        'ask',
        undefined,
        '你是一位学术阅读助手。用户会从论文中选取一段文字请你解释。请用清晰的中文回答，使用 Markdown 分点排版；如有专业术语请简要说明。',
      )
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [apiKey, messages],
  )

  // 暴露给父组件调用
  useImperativeHandle(ref, () => ({
    summarizePage: runSummaryPage,
    summarizeAll: runSummaryAll,
    explain: runExplain,
    hasKey: () => !!apiKey,
    busy: () => loading !== null,
  }))

  const handleAsk = () => {
    const text = input.trim()
    if (!text || loading) return
    setInput('')
    void runChat([...messages, { role: 'user', content: text }], 'ask')
  }

  // 拖动：面板用 fixed 定位，坐标即视口坐标（clientX/Y），无父级换算
  const onHeaderPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return
    if ((event.target as HTMLElement).closest('button')) return
    const panel = panelRef.current
    if (!panel) return
    const panelRect = panel.getBoundingClientRect()
    const grabX = event.clientX - panelRect.left
    const grabY = event.clientY - panelRect.top
    setPos({ x: panelRect.left, y: panelRect.top })
    panel.setPointerCapture(event.pointerId)
    panel.classList.add('dragging')

    const onMove = (e: PointerEvent) => {
      const maxX = window.innerWidth - 80
      const maxY = window.innerHeight - 50
      const x = e.clientX - grabX
      const y = e.clientY - grabY
      setPos({ x: Math.max(0, Math.min(maxX, x)), y: Math.max(0, Math.min(maxY, y)) })
    }
    const onUp = (e: PointerEvent) => {
      panel.releasePointerCapture(e.pointerId)
      panel.classList.remove('dragging')
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // 关闭时不渲染（但组件实例保留，对话内容 state 不丢失）
  if (!visible) return null

  return createPortal(
    <aside
      ref={panelRef as React.RefObject<HTMLElement>}
      className="ai-panel"
      style={pos ? { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' } : undefined}
      role="complementary"
      aria-label="AI 阅读助手"
    >
      <div className="ai-header" onPointerDown={onHeaderPointerDown}>
        <span className="ai-title">
          <span className="ai-dot" /> <em>AI</em> 阅读助手
        </span>
        {onClose && (
          <button type="button" className="icon-button ai-close" onClick={onClose} title="收起" aria-label="收起">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m6 6 12 12" /><path d="m18 6-12 12" />
            </svg>
          </button>
        )}
      </div>

      <div className="ai-messages" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="ai-empty">
            在论文上方的「全文摘要」按钮可快速通读全文，<br />或在下方就当前页内容提问。
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`ai-msg ${msg.role}`}>
            <div className="ai-msg-role">{msg.role === 'user' ? '我' : 'AI'}</div>
            {msg.role === 'assistant' ? (
              <div
                className="ai-msg-content markdown"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) || '…' }}
              />
            ) : (
              <div className="ai-msg-content">{msg.content || '…'}</div>
            )}
          </div>
        ))}
        {error && <div className="ai-error">{error}</div>}
      </div>

      <div className="ai-input-bar">
        {showKeyInput && (
          <div className="ai-key-box">
            <p>填入你的 DeepSeek API Key，仅保存在本机浏览器。</p>
            <input
              type="password"
              placeholder="sk-..."
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && saveKey()}
            />
            <div className="ai-key-actions">
              <button type="button" className="ai-key-save" onClick={saveKey} disabled={!keyDraft.trim()}>保存</button>
              {apiKey && <button type="button" className="ai-key-clear" onClick={clearKey}>清除已存 Key</button>}
              <button type="button" className="ai-key-cancel" onClick={() => setShowKeyInput(false)}>取消</button>
            </div>
            <a className="ai-key-help" href="https://platform.deepseek.com/api_keys" target="_blank" rel="noreferrer">如何获取 Key →</a>
          </div>
        )}
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              handleAsk()
            }
          }}
          placeholder={loading ? 'AI 正在回答…' : '就当前页提问（Enter 发送，Shift+Enter 换行）'}
          rows={2}
          disabled={loading !== null}
        />
        <div className="ai-input-actions">
          <button
            type="button"
            className={`ai-key-toggle${apiKey ? ' set' : ''}`}
            onClick={() => { setKeyDraft(''); setShowKeyInput((v) => !v) }}
            title={apiKey ? '更换 DeepSeek Key（已设置）' : '设置 DeepSeek Key'}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" />
            </svg>
            {apiKey ? 'Key 已设置' : '设置 Key'}
          </button>
          <button type="button" className="ai-send" onClick={handleAsk} disabled={!input.trim() || loading !== null}>
            发送
          </button>
        </div>
      </div>
    </aside>,
    document.body,
  )
})

export default AiPanel
