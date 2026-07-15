import { useEffect, useMemo, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'

export type OutlineNode = {
  title: string
  pageNumber: number | null
  items: OutlineNode[]
}

/** 解析 outline 单个 dest，返回其起始页码（1-based），失败返回 null。 */
async function resolveDestPage(pdf: PDFDocumentProxy, dest: string | unknown[] | null): Promise<number | null> {
  try {
    const explicit = typeof dest === 'string' ? await pdf.getDestination(dest) : dest
    if (!Array.isArray(explicit) || !explicit[0]) return null
    // 显式 dest 的第 0 项是目标页面的引用对象
    const index = await pdf.getPageIndex(explicit[0] as { num: number; gen: number })
    return index + 1
  } catch {
    return null
  }
}

/** 递归读取 PDF 书签树，把每个 dest 解析为页码，过滤掉无法定位页码的空节点。 */
async function resolveOutline(
  raw: Awaited<ReturnType<PDFDocumentProxy['getOutline']>>,
  pdf: PDFDocumentProxy,
): Promise<OutlineNode[]> {
  const nodes: OutlineNode[] = []
  for (const item of raw) {
    const pageNumber = await resolveDestPage(pdf, item.dest)
    const children = item.items?.length ? await resolveOutline(item.items, pdf) : []
    if (pageNumber === null && children.length === 0) continue
    nodes.push({ title: item.title, pageNumber, items: children })
  }
  return nodes
}

/** 折叠箭头图标。 */
function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      className="outline-chevron"
      viewBox="0 0 24 24"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ transform: open ? 'rotate(90deg)' : 'none' }}
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  )
}

/** 扁平化书签树，记录每个节点的 key 与页码。 */
type FlatEntry = { key: string; pageNumber: number }
function flatten(nodes: OutlineNode[], prefix: string, out: FlatEntry[]): void {
  nodes.forEach((node, i) => {
    const key = `${prefix}/${i}`
    if (node.pageNumber !== null) out.push({ key, pageNumber: node.pageNumber })
    if (node.items.length) flatten(node.items, key, out)
  })
}

/** 收集某 key 的所有祖先 key（含自身），用于展开定位。 */
function ancestorsOf(target: string): string[] {
  const parts = target.split('/')
  const result: string[] = []
  for (let i = 1; i < parts.length; i++) {
    result.push(parts.slice(0, i + 1).join('/'))
  }
  return result
}

type TreeRowProps = {
  node: OutlineNode
  nodeKey: string
  depth: number
  activeKey: string | null
  expanded: Set<string>
  onNavigate: (pageNumber: number, nodeKey: string) => void
  onToggle: (key: string) => void
}

function OutlineRow({ node, nodeKey, depth, activeKey, expanded, onNavigate, onToggle }: TreeRowProps) {
  const hasChildren = node.items.length > 0
  const isOpen = expanded.has(nodeKey)
  const active = activeKey === nodeKey

  // 点击整行：只跳转页码（并带上被点击节点 key，用于高亮跟随点击），不折叠
  const handleRowClick = () => {
    if (node.pageNumber !== null) onNavigate(node.pageNumber, nodeKey)
  }
  // 点击箭头：只展开/收起
  const handleToggleClick = (event: React.MouseEvent) => {
    event.stopPropagation()
    onToggle(nodeKey)
  }

  return (
    <li className="outline-node" role="none">
      <button
        type="button"
        className={`outline-row${active ? ' active' : ''}`}
        style={{ paddingLeft: 8 + depth * 16 }}
        // 阻止按钮获焦后的默认滚动行为，避免点击时面板内出现额外抖动
        onMouseDown={(event) => event.preventDefault()}
        onClick={handleRowClick}
        title={node.title}
        role="treeitem"
        aria-expanded={hasChildren ? isOpen : undefined}
      >
        <span
          className={`outline-toggle${hasChildren ? '' : ' leaf'}`}
          onClick={hasChildren ? handleToggleClick : undefined}
          aria-hidden={!hasChildren}
        >
          {hasChildren ? <Chevron open={isOpen} /> : null}
        </span>
        <span className="outline-title">{node.title}</span>
        {node.pageNumber !== null && <span className="outline-page">{node.pageNumber}</span>}
      </button>
      {hasChildren && isOpen && (
        <ul className="outline-list" role="group">
          {node.items.map((child, index) => (
            <OutlineRow
              key={`${nodeKey}/${index}`}
              node={child}
              nodeKey={`${nodeKey}/${index}`}
              depth={depth + 1}
              activeKey={activeKey}
              expanded={expanded}
              onNavigate={onNavigate}
              onToggle={onToggle}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

export type OutlinePanelProps = {
  pdf: PDFDocumentProxy | null
  onNavigate: (pageNumber: number) => void
  onClose?: () => void
}

export default function OutlinePanel({ pdf, onNavigate, onClose }: OutlinePanelProps) {
  const [nodes, setNodes] = useState<OutlineNode[]>([])
  const [loading, setLoading] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())

  // 加载书签树，默认全部展开；文档切换时重置。
  useEffect(() => {
    let active = true
    if (!pdf) {
      setNodes([])
      return
    }
    setLoading(true)
    void (async () => {
      try {
        const raw = await pdf.getOutline()
        if (!active) return
        console.log('[Outline] 原始书签树 getOutline():', raw)
        const resolved = raw?.length ? await resolveOutline(raw, pdf) : []
        if (!active) return
        console.log('[Outline] 解析后的目录（含页码）:', resolved)
        setNodes(resolved)
        // 初始展开第一层
        setExpanded(new Set(resolved.map((_, i) => `/${i}`)))
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => { active = false }
  }, [pdf])

  // 激活节点：只由点击决定，点击哪条高亮哪条并保持，翻页不会自动跳走。
  const [activeKey, setActiveKey] = useState<string | null>(null)

  // 文档切换后默认选中第一个有页码的条目
  useEffect(() => {
    if (nodes.length === 0) {
      setActiveKey(null)
      return
    }
    const flat: FlatEntry[] = []
    flatten(nodes, '', flat)
    setActiveKey(flat.length ? flat[0].key : null)
  }, [nodes])

  // 点击条目：高亮跟随点击并跳转
  const handleNavigate = (pageNumber: number, nodeKey: string) => {
    setActiveKey(nodeKey)
    onNavigate(pageNumber)
  }

  // 当前页变化时，自动展开激活节点的祖先链，保证可见。
  useEffect(() => {
    if (!activeKey) return
    setExpanded((prev) => {
      const ancestors = ancestorsOf(activeKey)
      if (ancestors.every((k) => prev.has(k))) return prev
      const next = new Set(prev)
      ancestors.forEach((k) => next.add(k))
      return next
    })
  }, [activeKey])

  const toggle = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const totalCount = useMemo(() => {
    const count = (list: OutlineNode[]): number =>
      list.reduce((sum, n) => sum + 1 + count(n.items), 0)
    return count(nodes)
  }, [nodes])

  return (
    <aside className="outline-panel" role="navigation" aria-label="文档目录">
      <div className="outline-header">
        <span className="outline-header-title">目录</span>
        {totalCount > 0 && <span className="outline-count">{totalCount} 项</span>}
        {onClose && (
          <button className="icon-button outline-close" onClick={onClose} title="收起目录" aria-label="收起目录">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m6 6 12 12" /><path d="m18 6-12 12" />
            </svg>
          </button>
        )}
      </div>
      <div className="outline-scroll">
        {loading ? (
          <div className="outline-empty">正在读取目录…</div>
        ) : nodes.length === 0 ? (
          <div className="outline-empty">这份 PDF 没有内置目录</div>
        ) : (
          <ul className="outline-list root" role="tree">
            {nodes.map((node, index) => (
              <OutlineRow
                key={`/${index}`}
                node={node}
                nodeKey={`/${index}`}
                depth={0}
                activeKey={activeKey}
                expanded={expanded}
                onNavigate={handleNavigate}
                onToggle={toggle}
              />
            ))}
          </ul>
        )}
      </div>
    </aside>
  )
}
