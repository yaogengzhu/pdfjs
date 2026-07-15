import { forwardRef, useCallback, useImperativeHandle, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import type { PDFDocumentProxy } from 'pdfjs-dist'

const DEEPSEEK_URL = 'https://api.deepseek.com/v1/chat/completions'
const DEEPSEEK_MODEL = 'deepseek-chat'

/** 技能作用范围：page=当前页，all=全文。 */
type SkillScope = 'page' | 'all'
/** 技能等级：basic=基础单轮，advanced=高级分析。用于「更多」菜单分组。 */
type SkillLevel = 'basic' | 'advanced'

/** 单段技能：一段 prompt 模板，单轮调用。kind 可选，缺省即 single（兼容历史无 kind 的定义）。 */
type SingleSkill = {
  kind?: 'single'
  id: string
  name: string
  /** 一句话副标题，显示在「更多」菜单里。 */
  desc?: string
  /** 按钮里是否默认展示（true）；false 则只进下拉的“更多”。 */
  pinned?: boolean
  level: SkillLevel
  scope: SkillScope
  /** {{text}} 会被替换为对应范围的正文；{{page}} 替换为页码。 */
  userPrompt: string
  systemPrompt?: string
}

/** 工具步骤：确定性取数，不调 LLM。 */
type ToolStep = {
  kind: 'tool'
  id: string
  title: string
  tool: 'page' | 'allText' | 'search' | 'translate'
  args: { page?: number; maxChars?: number; query?: string; topK?: number; perSnippet?: number; text?: string; to?: 'zh' }
  /** 可选：参数需要引用前序产出时（如 search 的 query 来自前序），在此解析。 */
  resolveArgs?: (outputs: Record<string, string>) => ToolStep['args']
}

/** LLM 调用步骤（非流式，用于中间步骤）。 */
type ChatStep = {
  kind: 'chat'
  id: string
  title: string
  /** 支持 {{page}} {{text}} {{step.<id>}} {{snippets}} {{item}}。 */
  userPrompt: string
  systemPrompt?: string
  /** 从模型输出抽取结构化结果（如子问题数组）供后续扇出消费。 */
  extract?: (raw: string) => string[]
  /** 指向某个带 extract 的前序 chat 步骤 id：对本步每条产出各跑一次（并行）。 */
  fanOver?: string
}

/** 流式综合步：流水线终点，结果流式追加到最终 assistant 消息。 */
type SynthStep = {
  kind: 'synth'
  id: string
  title: string
  userPrompt: string
  systemPrompt?: string
  stream: true
}

type Step = ToolStep | ChatStep | SynthStep

/** 多步流水线技能：声明式编排若干步骤。 */
type PipelineSkill = {
  kind: 'pipeline'
  id: string
  name: string
  desc?: string
  pinned?: boolean
  level: SkillLevel
  /** pipeline 各步自带取数；scope 仅用于菜单「全文/当前页」标签。 */
  scope: SkillScope
  steps: Step[]
}

type Skill = SingleSkill | PipelineSkill

/** 内置技能包。新增技能只要往这里加一条即可，UI 会自动渲染。 */
const SKILLS: Skill[] = [
  // —— 基础技能 ——
  {
    id: 'summarize-page',
    name: '总结当前页',
    pinned: true,
    level: 'basic',
    scope: 'page',
    userPrompt:
      '请对当前页（第 {{page}} 页）的内容生成摘要：核心观点、关键结论、值得注意的方法或数据。',
  },
  {
    id: 'summarize-all',
    name: '全文摘要',
    pinned: true,
    level: 'basic',
    scope: 'all',
    userPrompt:
      '请对这篇论文生成全文摘要：研究问题、核心方法、主要贡献、关键结论与局限。用 Markdown 分点呈现。',
  },
  {
    id: 'translate',
    name: '翻译为中文',
    level: 'basic',
    scope: 'page',
    desc: '把当前页译成流畅中文',
    userPrompt:
      '请把下面这一页内容翻译成流畅的中文。保留原文的结构与编号；如有人名/专有名词，首次出现时在括号内保留原文。',
    systemPrompt: '你是一位专业的学术翻译。用户会提供一页论文文本，请翻译成准确、流畅的中文。',
  },
  {
    id: 'keypoints',
    name: '提炼要点/术语',
    level: 'basic',
    scope: 'page',
    desc: '要点清单 + 术语解释',
    userPrompt:
      '请基于下面这一页内容：1) 提炼 3–6 条要点清单；2) 列出其中的专业术语并逐一用一句话解释。用 Markdown 排版。',
    systemPrompt: '你是一位学术阅读助手。请用清晰的中文、Markdown 分点排版输出要点与术语解释。',
  },

  // —— 高级技能 ——
  {
    id: 'review',
    name: '批判性审稿',
    level: 'advanced',
    scope: 'all',
    desc: '假设漏洞、方法局限、可反驳点',
    userPrompt:
      '请作为一位严格但公正的同行评审，对这篇论文做批判性审稿，输出：\n' +
      '1. **核心主张**：用一两句话概括作者声称的贡献。\n' +
      '2. **假设与前提**：列出未经验证或隐含的假设。\n' +
      '3. **方法局限**：实验设计、样本、基线、评估指标上的弱点。\n' +
      '4. **逻辑漏洞**：从数据到结论之间站不住脚的推理链。\n' +
      '5. **可反驳点**：给出 3 条具体的、可被反驳或质疑的点。\n' +
      '6. **改进建议**：针对最严重的两个问题给出可操作建议。\n' +
      '请坦诚、具体，避免泛泛而谈；信息不足处请标注「原文未提供」。用 Markdown 排版。',
    systemPrompt:
      '你是一位资深的学术同行评审专家，擅长批判性分析。请基于用户提供的论文全文，给出严谨、具体、可操作的审稿意见，使用 Markdown 排版。如果文本被截断，请基于已有内容分析并说明。',
  },
  {
    id: 'methodology',
    name: '方法论拆解',
    level: 'advanced',
    scope: 'all',
    desc: '研究设计、数据、流程、可复现性',
    userPrompt:
      '请把这篇论文的研究方法拆解为结构化报告：\n' +
      '1. **研究类型**：实验/观测/理论/综述/案例等。\n' +
      '2. **研究问题与假设**：要回答什么、假设是什么。\n' +
      '3. **数据**：来源、规模、采集方式、是否有偏。\n' +
      '4. **方法与模型**：核心算法/模型/流程，输入输出是什么。\n' +
      '5. **实验设置**：基线、评估指标、超参与关键参数。\n' +
      '6. **可复现性评估**：凭论文信息能否复现，缺哪些关键细节。\n' +
      '用 Markdown 排版；信息不足处请标注「未说明」。',
    systemPrompt:
      '你是一位科研方法学专家。请把用户提供的论文方法部分拆解为清晰的结构化报告，使用 Markdown 排版。诚实标注论文中未交代的细节。',
  },
  {
    id: 'concept-map',
    name: '概念地图',
    level: 'advanced',
    scope: 'all',
    desc: '核心概念 + 关系图（Mermaid）',
    userPrompt:
      '请基于这篇论文构建概念地图：\n' +
      '1. **核心概念表**：用 Markdown 表格列出 5–10 个关键概念及其一句话定义。\n' +
      '2. **关系说明**：用简短文字说明这些概念之间的影响/依赖/对比关系。\n' +
      '3. **Mermaid 关系图**：用合法的 ```` ```mermaid flowchart ```` 代码块画出概念关系（节点用中文短词，边标注关系）。\n' +
      '注意：Mermaid 代码必须语法正确、可直接渲染。',
    systemPrompt:
      '你擅长把学术论文的概念体系可视化。请输出 Markdown，其中的 Mermaid 代码块必须语法正确可渲染。',
  },
  {
    id: 'quotes',
    name: '金句与数据卡',
    level: 'advanced',
    scope: 'page',
    desc: '关键论断 + 关键数字 + 可引用句',
    userPrompt:
      '请从下面这一页内容中抽取一张「数据卡」：\n' +
      '1. **关键论断**：2–4 条最重要的陈述（每条一句）。\n' +
      '2. **关键数字**：所有出现的重要数值/百分比/规模，带含义。\n' +
      '3. **可引用句**：1–2 句最适合直接引用的原文（用引号，并注明指代对象）。\n' +
      '用 Markdown 排版；只基于本页内容，不要编造。',
    systemPrompt:
      '你是一位严谨的研究助理。只从用户提供的文本中抽取信息，绝不编造；用 Markdown 排版。',
  },
  {
    id: 'elevator',
    name: '电梯演讲',
    level: 'advanced',
    scope: 'all',
    desc: '30 秒讲清这篇论文',
    userPrompt:
      '请用「电梯演讲」格式概括这篇论文，要求精炼到 30 秒内能讲完：\n' +
      '- **一句话概括**：这篇论文做了什么。\n' +
      '- **为什么重要**：解决了什么问题 / 填补了什么空白。\n' +
      '- **怎么做**：核心方法（一句话）。\n' +
      '- **结果亮点**：最有说服力的一个结果。\n' +
      '- **一句话局限**：最大的 caveat。\n' +
      '全部用 Markdown，总字数控制在 150 字以内。',
    systemPrompt: '你擅长把复杂的学术论文浓缩成极简、有冲击力的电梯演讲。用简体中文、Markdown 排版。',
  },
  {
    id: 'further',
    name: '延伸阅读',
    level: 'advanced',
    scope: 'all',
    desc: '该跟进的子领域与关键词',
    userPrompt:
      '请基于这篇论文，为想继续深入的读者规划「延伸阅读」：\n' +
      '1. **核心关键词**：5–8 个用于检索的关键术语（中英对照）。\n' +
      '2. **相关子领域**：3–5 个值得跟进的研究方向，每个一句话说明为什么相关。\n' +
      '3. **入门 vs 进阶**：把上述方向标注为「入门」或「进阶」。\n' +
      '用 Markdown 排版。注意：不要编造具体论文标题，只给方向和关键词。',
    systemPrompt:
      '你是一位熟悉学术脉络的研究导师。基于用户提供的论文给出延伸阅读方向，使用 Markdown 排版。不要编造不存在的具体文献标题。',
  },

  // —— 多步流水线技能（真正的“技能”：多步推理 + 工具）——
  {
    kind: 'pipeline',
    id: 'deep-dive',
    name: '深挖问答',
    level: 'advanced',
    scope: 'all',
    desc: '生成子问题 → 检索证据 → 逐个作答 → 综合',
    steps: [
      {
        kind: 'tool', id: 'full', title: '读取全文', tool: 'allText', args: { maxChars: 6000 },
      },
      {
        kind: 'chat', id: 'questions', title: '生成 3 个深究子问题',
        systemPrompt: '你是一位学术导师。',
        userPrompt:
          '基于这篇论文正文，提出 3 个「最值得深究、原文未充分回答」的子问题。' +
          '每条一行，以「Q: 」开头，不要编号不要多余解释。正文：\n\n{{step.full}}',
        extract: (raw) =>
          raw.split('\n').map((s) => s.trim()).filter((s) => s.startsWith('Q:')).map((s) => s.replace(/^Q:\s*/, '').trim()).slice(0, 3),
      },
      {
        kind: 'tool', id: 'search', title: '检索相关段落',
        tool: 'search', args: { topK: 3, perSnippet: 600 },
        resolveArgs: (outputs) => ({ query: outputs.questions ?? '', topK: 3, perSnippet: 600 }),
      },
      {
        kind: 'chat', id: 'answer', title: '回答子问题', fanOver: 'questions',
        systemPrompt: '你是一位严谨的学术阅读助手。基于提供的段落作答；信息不足处请明确标注「原文未提及」。用 Markdown。',
        userPrompt:
          '针对以下子问题，结合检索到的相关段落作答。\n\n' +
          '子问题：{{item}}\n\n相关段落：\n{{snippets}}',
      },
      {
        kind: 'synth', id: 'report', title: '综合报告',
        systemPrompt: '你是一位学术阅读助手，用 Markdown 分点综合。',
        userPrompt:
          '把以下 3 个子问题及其作答综合成一份「深挖报告」：开篇一句话总览；随后每个子问题一个小节（问题 + 回答 + 一句评注）；结尾给一条后续行动建议。\n\n{{step.answer}}',
        stream: true,
      },
    ],
  },
  {
    kind: 'pipeline',
    id: 'review-deep',
    name: '批判性审稿(深度)',
    level: 'advanced',
    scope: 'all',
    desc: '抽取主张 → 检索证据 → 逐条评审 → 报告',
    steps: [
      {
        kind: 'tool', id: 'full', title: '读取全文', tool: 'allText', args: {},
      },
      {
        kind: 'chat', id: 'claims', title: '抽取核心主张',
        systemPrompt: '你是一位严谨的分析师。',
        userPrompt:
          '列出这篇论文 3–5 条最核心、可证伪的主张，每条一行，以「C: 」开头，不要编号。正文：\n\n{{step.full}}',
        extract: (raw) =>
          raw.split('\n').map((s) => s.trim()).filter((s) => s.startsWith('C:')).map((s) => s.replace(/^C:\s*/, '').trim()).slice(0, 5),
      },
      {
        kind: 'tool', id: 'search', title: '检索证据段落',
        tool: 'search', args: { topK: 3, perSnippet: 600 },
        resolveArgs: (outputs) => ({ query: outputs.claims ?? '', topK: 3, perSnippet: 600 }),
      },
      {
        kind: 'chat', id: 'critique', title: '逐条评审', fanOver: 'claims',
        systemPrompt: '你是资深同行评审。针对每条主张，先在段落里找支持证据，再给至少 1 个反例/局限/可反驳点。用 Markdown。',
        userPrompt:
          '针对以下主张评审：先列支持证据，再给反例/局限/可反驳点。\n\n主张：{{item}}\n\n相关段落：\n{{snippets}}',
      },
      {
        kind: 'synth', id: 'report', title: '审稿报告',
        systemPrompt: '你是资深同行评审，用 Markdown 排版。',
        userPrompt:
          '把以下逐条评审综合成一份审稿报告：整体评价（一段）+ 分主张小节 + 优先改进建议（2–3 条）。\n\n{{step.critique}}',
        stream: true,
      },
    ],
  },
]

// 配置 marked：启用 GFM、换行转 <br>，渲染更贴近聊天体验
marked.setOptions({ gfm: true, breaks: true })

/** 把 markdown 文本渲染为安全的 HTML。 */
function renderMarkdown(text: string): string {
  if (!text) return ''
  return DOMPurify.sanitize(marked.parse(text, { async: false }) as string)
}
const STORAGE_KEY = 'pdfreader.deepseek.key'

type Role = 'system' | 'user' | 'assistant'

/** 思考过程的单个步骤状态（pipeline 技能中间步骤展示用）。 */
type ThinkStepState = {
  id: string
  title: string
  status: 'running' | 'done' | 'error'
  content?: string
}

type Message =
  | { role: Role; content: string }
  | { role: 'assistant'; kind: 'thinking'; steps: ThinkStepState[]; done: boolean }

/** 类型谓词：判断是否思考过程消息。 */
function isThinking(m: Message): m is Extract<Message, { kind: 'thinking' }> {
  return 'kind' in m && m.kind === 'thinking'
}

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
  /** 用用户自写的 prompt 处理选中文本（选中后弹输入框场景）。 */
  askWithPrompt: (selected: string, userPrompt: string) => void
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

/** 调用 DeepSeek 非流式（用于 pipeline 中间步骤），返回完整文本。 */
async function chatOnce(messages: Message[], apiKey: string): Promise<string> {
  const response = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: DEEPSEEK_MODEL, messages, stream: false }),
  })
  if (!response.ok) {
    const errText = await response.text().catch(() => response.statusText)
    throw new Error(`DeepSeek 接口错误 (${response.status})：${errText.slice(0, 200)}`)
  }
  const data = await response.json()
  return data.choices?.[0]?.message?.content ?? ''
}

/**
 * 占位符插值。支持：
 * - {{page}} {{text}} {{snippets}} {{item}}：来自 map 直取
 * - {{step.<id>}}：取 outputs[<id>]
 */
function interpolate(template: string, map: Record<string, string>): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_, key: string) => {
    const k = key.trim()
    if (k.startsWith('step.')) return map[k.slice(5)] ?? ''
    return map[k] ?? ''
  })
}

/** 剥离 <think>...</think> 推理块，返回结论部分。 */
function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^\s+/, '').trim()
}

/** 把含 <think> 的步骤内容渲染为 HTML：推理块用淡色样式，结论正常排版。 */
function renderStepContent(text: string): string {
  if (!text) return ''
  const parts: string[] = []
  const re = /<think>([\s\S]*?)<\/think>/gi
  let last = 0
  let m: RegExpExecArray | null
  let hasThink = false
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(`<div class="cot-conclusion">${renderMarkdown(text.slice(last, m.index))}</div>`)
    parts.push(`<div class="cot-reasoning"><div class="cot-label">🧠 推理</div>${renderMarkdown(m[1])}</div>`)
    last = m.index + m[0].length
    hasThink = true
  }
  if (!hasThink) return renderMarkdown(text)
  if (last < text.length) parts.push(`<div class="cot-conclusion"><div class="cot-label">✓ 结论</div>${renderMarkdown(text.slice(last))}</div>`)
  return parts.join('')
}

/** 把 query 与文本切成词项：英文按空格，中文按 2-gram。统一小写。 */
function tokenize(s: string): string[] {
  const lower = s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  if (!lower) return []
  const words = lower.split(/\s+/).filter(Boolean)
  const tokens: string[] = []
  for (const w of words) {
    // 纯 ASCII 词直接用；含 CJK 的切成 2-gram
    if (/^[\x00-\x7f]+$/.test(w)) {
      tokens.push(w)
    } else {
      for (let i = 0; i < w.length - 1; i++) tokens.push(w.slice(i, i + 2))
      if (w.length === 1) tokens.push(w)
    }
  }
  return tokens
}

/**
 * 全文检索：按页分块 + 关键词召回（TF × 覆盖度），突破 6000 字截断。
 * pageCache 由调用方传入（useRef(Map)），随组件生命周期缓存。
 */
async function searchPages(
  pdf: PDFDocumentProxy,
  query: string,
  pageCache: Map<number, string>,
  opts: { topK?: number; perSnippet?: number; maxChars?: number } = {},
): Promise<string> {
  const topK = opts.topK ?? 3
  const perSnippet = opts.perSnippet ?? 600
  const maxChars = opts.maxChars ?? 4000
  const qTokens = tokenize(query)
  if (qTokens.length === 0) return ''

  // 取（或复用缓存的）每页文本
  const pages: { n: number; text: string }[] = []
  for (let n = 1; n <= pdf.numPages; n++) {
    let text = pageCache.get(n)
    if (text === undefined) {
      text = await getPageText(pdf, n)
      pageCache.set(n, text)
    }
    pages.push({ n, text })
  }

  // 打分：TF × 覆盖度
  const scored = pages
    .map(({ n, text }) => {
      const lower = text.toLowerCase()
      let tf = 0
      const hit = new Set<string>()
      for (const tk of qTokens) {
        const cnt = lower.split(tk).length - 1
        if (cnt > 0) {
          tf += cnt
          hit.add(tk)
        }
      }
      const coverage = hit.size / qTokens.length
      return { n, text, score: tf * coverage }
    })
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
  if (scored.length === 0) return ''

  // 裁出每页含首个命中的片段
  const parts: string[] = []
  let total = 0
  for (const { n, text } of scored) {
    const lower = text.toLowerCase()
    const firstHit = qTokens.map((tk) => lower.indexOf(tk)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0
    const start = Math.max(0, firstHit - Math.floor(perSnippet / 2))
    const snippet = text.slice(start, start + perSnippet)
    const piece = `### 第 ${n} 页（相关片段）\n${start > 0 ? '…' : ''}${snippet}${start + perSnippet < text.length ? '…' : ''}`
    if (total + piece.length > maxChars) break
    parts.push(piece)
    total += piece.length
  }
  return parts.join('\n\n')
}

/** 思考过程卡片：展示 pipeline 各中间步骤，可折叠。 */
function ThinkingCard({ steps, done }: { steps: ThinkStepState[]; done: boolean }) {
  return (
    <div className="ai-thinking">
      <div className="ai-thinking-head">
        {!done && <span className="spin" aria-hidden="true" />}
        {done ? '✓ 思考完成' : '思考中…'}
      </div>
      {steps.map((s) => (
        <details key={s.id} className="ai-think-step" open={s.status === 'running'}>
          <summary>
            {s.status === 'running' ? (
              <span className="spin small" aria-hidden="true" />
            ) : s.status === 'error' ? (
              <span className="tick err">✕</span>
            ) : (
              <span className="tick">✓</span>
            )}
            <span className="ai-think-step-title">{s.title}</span>
          </summary>
          {s.content && (
            <div
              className="ai-think-step-content"
              dangerouslySetInnerHTML={{ __html: renderStepContent(s.content) }}
            />
          )}
        </details>
      ))}
    </div>
  )
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
  // 全文检索的页文本缓存（随组件生命周期，切文档随重挂载清空）
  const pageCacheRef = useRef<Map<number, string>>(new Map())
  // 是否「粘底」：用户在底部附近时为 true，AI 输出时自动滚；用户上滑后变 false，停止自动滚
  const stickBottomRef = useRef(true)
  const [error, setError] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const [moreOpen, setMoreOpen] = useState(false)
  const moreRef = useRef<HTMLDivElement>(null)
  const moreBtnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  // 「全部技能」菜单用 Portal 渲染到 body，这里存按钮的屏幕坐标用于定位
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null)
  // 深度思考开关：开启后给 LLM 步骤注入思维链 prompt 并流式展示推理过程
  const [deepThink, setDeepThink] = useState(() => localStorage.getItem('pdfreader.deepthink') === '1')
  // 面板宽度（px）：拖拽右边缘自由调整，或点放大按钮快捷占屏。存 localStorage。
  const [panelWidth, setPanelWidth] = useState<number>(() => Number(localStorage.getItem('pdfreader.panelwidth')) || 440)
  // 放大态：true 时面板居中并占屏 70%；false 时贴右侧、用 panelWidth。不持久化（每次打开默认贴右）。
  const [wide, setWide] = useState(false)

  // 读取本地存的 key
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) setApiKey(saved)
    else setShowKeyInput(true)
  }, [])

  // 粘底滚动：仅当用户已在底部附近时，新内容才自动滚动；用户上滑查看时不打断。
  useEffect(() => {
    if (stickBottomRef.current) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
    }
  }, [messages, loading])

  // 监听滚动：判断用户是否在底部附近（底部 40px 内视为「粘底」）
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => {
      // 离底部 80px 内都算「粘底」：宽容微小上滑与内容增长撑出的偏移，
      // 只有用户明显往上滚（超过 80px）才停止跟随。
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight
      stickBottomRef.current = distance < 80
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  // 窗口缩放时把面板宽度限制在视口内
  useEffect(() => {
    const onResize = () => setPanelWidth((w) => Math.max(300, Math.min(window.innerWidth - 36, w)))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // 计算菜单定位：默认向上展开（贴按钮左上角）；上方空间不足时回退向下。
  const updateMenuPos = useCallback(() => {
    const btn = moreBtnRef.current
    if (!btn) return
    const r = btn.getBoundingClientRect()
    const menuW = 280 // 介于 min-width 230 与 max-width 320 之间，用于边界估算
    const left = Math.max(8, Math.min(r.left, window.innerWidth - menuW - 8))
    const menuH = menuRef.current?.offsetHeight ?? 360
    const gap = 6
    // 上方空间够 → 向上；否则向下展开
    const top = r.top - menuH - gap >= 8 ? r.top - menuH - gap : r.bottom + gap
    setMenuPos({ left, top })
  }, [])

  // 打开/关闭「全部技能」菜单（打开时计算坐标）
  const toggleMore = useCallback(() => {
    setMoreOpen((v) => {
      if (!v) updateMenuPos()
      return !v
    })
  }, [updateMenuPos])

  // 点菜单外部时收起（菜单与按钮都不在目标内才关）
  useEffect(() => {
    if (!moreOpen) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (moreRef.current?.contains(t)) return
      if (menuRef.current?.contains(t)) return
      setMoreOpen(false)
    }
    const onReposition = () => updateMenuPos()
    document.addEventListener('mousedown', onDown)
    window.addEventListener('resize', onReposition)
    window.addEventListener('scroll', onReposition, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('resize', onReposition)
      window.removeEventListener('scroll', onReposition, true)
    }
  }, [moreOpen, updateMenuPos])

  // 菜单挂载后测量真实高度，重算定位（解决向上展开时初始高度未知的问题）
  useLayoutEffect(() => {
    if (moreOpen && menuRef.current) updateMenuPos()
  }, [moreOpen, updateMenuPos])

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

  const toggleDeepThink = () => {
    setDeepThink((v) => {
      const next = !v
      localStorage.setItem('pdfreader.deepthink', next ? '1' : '0')
      return next
    })
  }

  const clampWidth = (w: number) => Math.max(300, Math.min(window.innerWidth - 36, Math.round(w)))

  // 放大/缩小按钮：点击在「原位」与「居中放大 70%」间切换。拖动调宽由右边缘手柄负责。
  const toggleWide = () => setWide((v) => !v)

  // 拖拽面板右边缘自由调整宽度
  const onResizePointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return
    const panel = panelRef.current
    if (!panel) return
    const startX = event.clientX
    const startW = panel.getBoundingClientRect().width
    // 锁定本次拖拽开始时的态：贴右 vs 居中，两者拖动方向相反
    const wasWide = wide
    panel.setPointerCapture(event.pointerId)
    panel.classList.add('resizing')

    const onMove = (e: PointerEvent) => {
      const dx = e.clientX - startX
      // 贴右态：向左拖(dx<0)变宽 → startW - dx；居中态：拖右边缘向右拖(dx>0)变宽 → startW + dx
      const clamped = clampWidth(wasWide ? startW + dx : startW - dx)
      setPanelWidth(clamped)
    }
    const onUp = (e: PointerEvent) => {
      panel.releasePointerCapture(e.pointerId)
      panel.classList.remove('resizing')
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      // 拖完持久化
      localStorage.setItem('pdfreader.panelwidth', String(panel.getBoundingClientRect().width))
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
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
    // 用户发起的新一轮：强制粘底
    stickBottomRef.current = true
    // 预留一条空的 assistant 消息，流式填充
    setMessages([...history, { role: 'assistant', content: '' }])

    try {
      const ctx = contextText ?? (await getPageText(pdf, page))
      const baseSystem =
        systemPrompt ??
        '你是一位学术阅读助手。用户会提供 PDF 论文的文字内容，请基于这些内容回答问题或生成摘要。' +
          '回答用简洁的中文，使用 Markdown 分点排版。如果内容不足以回答，请如实说明。以下是相关内容：\n\n' +
          (ctx || '(未能提取到文字)')
      // 深度思考：注入思维链指令，让模型先 <think>推理</think> 再给结论
      const systemMsg: Message = {
        role: 'system',
        content: deepThink
          ? baseSystem +
            '\n\n重要：回答前必须先用 <think>...</think> 标签写出推理过程（分析依据、权衡、中间判断），' +
            '然后在标签外给出最终结论。推理要具体、可见思维链，不要空泛。'
          : baseSystem,
      }
      await chat([systemMsg, ...history], apiKey, (delta) => {
        setMessages((prev) => {
          const next = [...prev]
          const last = next[next.length - 1]
          if (!last || isThinking(last)) return prev
          next[next.length - 1] = { role: 'assistant', content: last.content + delta }
          return next
        })
      })
    } catch (cause) {
      setError((cause as Error).message)
      // 移除空的 assistant 占位
      setMessages((prev) => {
        const last = prev[prev.length - 1]
        return last && !isThinking(last) && last.content === '' ? prev.slice(0, -1) : prev
      })
    } finally {
      setLoading(null)
    }
  }

  // 通用技能执行器：按技能声明的 scope 取当前页或全文，套用对应 prompt
  /** 向最后一条 thinking 消息追加 / 更新一个思考步骤。 */
  const updateThink = useCallback((id: string, patch: Partial<ThinkStepState>, pushIfMissing?: ThinkStepState) => {
    setMessages((prev) => {
      const idx = [...prev].reverse().findIndex((m) => 'kind' in m && m.kind === 'thinking')
      if (idx < 0) return prev
      const realIdx = prev.length - 1 - idx
      const msg = prev[realIdx]
      if (!('kind' in msg) || msg.kind !== 'thinking') return prev
      const steps = [...msg.steps]
      const i = steps.findIndex((s) => s.id === id)
      if (i >= 0) steps[i] = { ...steps[i], ...patch }
      else if (pushIfMissing) steps.push(pushIfMissing)
      const next = [...prev]
      next[realIdx] = { ...msg, steps }
      return next
    })
  }, [])

  /** 标记最近的 thinking 消息完成。 */
  const finalizeThinking = useCallback(() => {
    setMessages((prev) => {
      const idx = [...prev].reverse().findIndex((m) => 'kind' in m && m.kind === 'thinking')
      if (idx < 0) return prev
      const realIdx = prev.length - 1 - idx
      const msg = prev[realIdx]
      if (!('kind' in msg) || msg.kind !== 'thinking') return prev
      const next = [...prev]
      next[realIdx] = { ...msg, done: true }
      return next
    })
  }, [])

  /** 把流式增量实时追加到某个思考卡片（让用户看到模型逐字推理）。 */
  const appendThink = useCallback((id: string, delta: string) => {
    updateThink(id, {})
    setMessages((prev) => {
      const idx = [...prev].reverse().findIndex((m) => 'kind' in m && m.kind === 'thinking')
      if (idx < 0) return prev
      const realIdx = prev.length - 1 - idx
      const msg = prev[realIdx]
      if (!('kind' in msg) || msg.kind !== 'thinking') return prev
      const steps = msg.steps.map((s) => (s.id === id ? { ...s, content: (s.content ?? '') + delta } : s))
      const next = [...prev]
      next[realIdx] = { ...msg, steps }
      return next
    })
  }, [updateThink])

  /**
   * 流式调用 LLM，每个 delta 实时追加到思考卡片 id。
   * deepThink 开启时注入思维链指令（先 <think>推理</think> 再结论）；关闭时仅普通流式。
   */
  const chatStreamToThink = useCallback(
    async (thinkId: string, userPrompt: string, systemPrompt?: string): Promise<string> => {
      const base = systemPrompt ?? '你是一位严谨的学术阅读助手。'
      const cotSystem = deepThink
        ? base +
          '\n\n重要：回答前必须先用 <think>...</think> 标签写出你的推理过程（分析依据、权衡、中间判断），' +
          '然后再在标签外给出最终结论。推理要具体、可见思维链，不要空泛。'
        : base
      const messages: Message[] = [
        { role: 'system', content: cotSystem },
        { role: 'user', content: userPrompt },
      ]
      let full = ''
      await chat(messages, apiKey, (delta) => {
        full += delta
        appendThink(thinkId, delta)
      })
      return full
    },
    [apiKey, appendThink, deepThink],
  )

  /** 执行多步流水线技能。 */
  const runPipeline = useCallback(
    async (skill: PipelineSkill) => {
      if (!apiKey) {
        setShowKeyInput(true)
        return
      }
      setError('')
      setLoading('summary')
      // 用户发起的新一轮：强制粘底
      stickBottomRef.current = true

      const thinkMsg: Message = { role: 'assistant', kind: 'thinking', steps: [], done: false }
      setMessages((prev) => [...prev, thinkMsg, { role: 'assistant', content: '' }])

      const outputs: Record<string, string> = { page: String(page) }
      const arrays: Record<string, string[]> = {}
      let snippets = ''

      // 把当前 outputs + 上下文做成插值 map
      const buildMap = (extra: Record<string, string> = {}): Record<string, string> => ({
        ...outputs,
        snippets,
        page: String(page),
        ...extra,
      })

      try {
        for (const step of skill.steps) {
          // —— 工具步骤 ——
          if (step.kind === 'tool') {
            updateThink(step.id, {}, { id: step.id, title: step.title, status: 'running' })
            const args = step.resolveArgs ? step.resolveArgs(outputs) : step.args
            let out = ''
            if (step.tool === 'page') {
              out = await getPageText(pdf, args.page ?? page)
            } else if (step.tool === 'allText') {
              out = await getAllText(pdf, args.maxChars)
            } else if (step.tool === 'search') {
              out = await searchPages(pdf, args.query ?? '', pageCacheRef.current, { topK: args.topK, perSnippet: args.perSnippet })
              snippets = out
            } else if (step.tool === 'translate') {
              out = await chatOnce(
                [{ role: 'system', content: '你是专业翻译，译成流畅中文。' }, { role: 'user', content: args.text ?? '' }],
                apiKey,
              )
            }
            outputs[step.id] = out
            updateThink(step.id, { status: 'done', content: step.tool === 'allText' || step.tool === 'search' ? `已获取 ${out.length} 字相关内容` : out.slice(0, 200) })
            continue
          }

          // —— chat 步骤（扇出，串行流式 + 思维链）：一条一条来，避免眼花 ——
          if (step.kind === 'chat' && step.fanOver) {
            const items = arrays[step.fanOver] ?? []
            if (items.length === 0) {
              updateThink(step.id, { status: 'done' }, { id: step.id, title: step.title, status: 'done', content: '（无内容可处理）' })
              continue
            }
            const results: string[] = []
            for (let idx = 0; idx < items.length; idx++) {
              const item = items[idx]
              const sid = `${step.id}-${idx}`
              updateThink(sid, {}, { id: sid, title: `${step.title} (${idx + 1}/${items.length})`, status: 'running' })
              const filled = interpolate(step.userPrompt, buildMap({ item, [step.fanOver!]: item }))
              const raw = await chatStreamToThink(sid, filled, step.systemPrompt)
              updateThink(sid, { status: 'done' })
              results.push(stripThink(raw))
            }
            outputs[step.id] = results.map((r, i) => `### ${items[i]}\n\n${r}`).join('\n\n---\n\n')
            arrays[step.id] = results
            continue
          }

          // —— chat 步骤（普通，流式 + 思维链）——
          if (step.kind === 'chat') {
            updateThink(step.id, {}, { id: step.id, title: step.title, status: 'running' })
            const filled = interpolate(step.userPrompt, buildMap())
            const raw = await chatStreamToThink(step.id, filled, step.systemPrompt)
            // 结论部分 = 剥离 <think>...</think> 后的内容
            const conclusion = stripThink(raw)
            outputs[step.id] = conclusion
            if (step.extract) {
              let arr = step.extract(conclusion)
              // 兜底：解析失败则按非空行取前 N 行
              if (arr.length === 0) arr = conclusion.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 5)
              arrays[step.id] = arr
            }
            updateThink(step.id, { status: 'done' })
            continue
          }

          // —— synth 步骤（流式到最终 assistant 消息）——
          if (step.kind === 'synth') {
            finalizeThinking()
            const filled = interpolate(step.userPrompt, buildMap())
            const sys: Message[] = step.systemPrompt
              ? [{ role: 'system', content: step.systemPrompt }]
              : [{ role: 'system', content: '你是一位学术阅读助手，用简洁的中文、Markdown 排版回答。' }]
            await chat(
              [...sys, { role: 'user', content: filled }],
              apiKey,
              (delta) => {
                setMessages((prev) => {
                  const next = [...prev]
                  const last = next[next.length - 1]
                  if (last && !('kind' in last)) next[next.length - 1] = { role: 'assistant', content: last.content + delta }
                  return next
                })
              },
            )
          }
        }
        finalizeThinking()
      } catch (cause) {
        setError((cause as Error).message)
        // 移除空的 assistant 占位
        setMessages((prev) => {
          const last = prev[prev.length - 1]
          if (last && !('kind' in last) && last.content === '') return prev.slice(0, -1)
          return prev
        })
      } finally {
        setLoading(null)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [apiKey, pdf, page],
  )

  const runSkill = useCallback(
    (skill: Skill) => {
      // pipeline 技能走多步引擎
      if ('kind' in skill && skill.kind === 'pipeline') {
        void runPipeline(skill)
        return
      }
      const s = skill as SingleSkill
      void (async () => {
        if (!apiKey) {
          setShowKeyInput(true)
          return
        }
        let contextText: string | undefined
        if (s.scope === 'all') {
          contextText = await getAllText(pdf)
        }
        const userContent = s.userPrompt
          .replace('{{page}}', String(page))
          .replace('{{text}}', contextText ?? '')
        await runChat(
          [{ role: 'user', content: userContent }],
          'summary',
          contextText,
          s.systemPrompt,
        )
      })()
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [pdf, page, apiKey, runPipeline],
  )

  // 当前页摘要（保留 ref 对外接口，内部转走技能）
  const runSummaryPage = useCallback(() => {
    runSkill(SKILLS[0])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runSkill])

  // 全文摘要（保留 ref 对外接口，内部转走技能）
  const runSummaryAll = useCallback(() => {
    runSkill(SKILLS[1])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runSkill])

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

  // 用用户自写的 prompt 处理选中文本（选中后弹输入框场景）
  const runAskWithPrompt = useCallback(
    (selected: string, userPrompt: string) => {
      const quote = selected.length > 1200 ? `${selected.slice(0, 1200)}…` : selected
      const prompt = (userPrompt || '').trim() || '请解释下面这段文字'
      void runChat(
        [
          {
            role: 'user',
            content: `${prompt}\n\n选中的文字：\n"""\n${quote}\n"""`,
          },
        ],
        'ask',
        undefined,
        '你是一位学术阅读助手。用户会从论文中选取一段文字，并给出指令。请按指令基于选中文字回答，用清晰的中文、Markdown 排版。',
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
    askWithPrompt: runAskWithPrompt,
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
    // 居中放大态下拖动 → 退出居中，回到自由定位态
    if (wide) setWide(false)
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
    <>
    <aside
      ref={panelRef as React.RefObject<HTMLElement>}
      className={`ai-panel${wide ? ' centered' : ''}`}
      style={
        wide
          ? { left: '50%', right: 'auto', top: '64px', transform: 'translateX(-50%)', width: `${clampWidth(window.innerWidth * 0.7)}px` }
          : { ...(pos ? { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' } : null), transform: 'none', width: `${panelWidth}px` }
      }
      role="complementary"
      aria-label="AI 阅读助手"
    >
      {/* 右边缘拖拽手柄：自由调整宽度 */}
      <div className="ai-resize-handle" onPointerDown={onResizePointerDown} title="拖动调整宽度" aria-hidden="true" />
      <div className="ai-header" onPointerDown={onHeaderPointerDown}>
        <span className="ai-title">
          <span className="ai-dot" /> <em>AI</em> 阅读助手
        </span>
        <button
          type="button"
          className="icon-button ai-size"
          onClick={toggleWide}
          title={wide ? '缩小回原位' : '居中放大占屏 70%'}
          aria-label={wide ? '缩小' : '放大'}
        >
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {wide ? (
              <>
                <path d="M9 4H5a1 1 0 0 0-1 1v4" />
                <path d="M15 4h4a1 1 0 0 1 1 1v4" />
                <path d="M9 20H5a1 1 0 0 1-1-1v-4" />
                <path d="M15 20h4a1 1 0 0 0 1-1v-4" />
              </>
            ) : (
              <>
                <path d="M8 3H5a2 2 0 0 0-2 2v3" />
                <path d="M16 3h3a2 2 0 0 1 2 2v3" />
                <path d="M8 21H5a2 2 0 0 1-2-2v-3" />
                <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
              </>
            )}
          </svg>
        </button>
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
        {messages.map((msg, i) => {
          // 思考过程消息
          if (isThinking(msg)) {
            return <ThinkingCard key={i} steps={msg.steps} done={msg.done} />
          }
          const content = msg.content
          return (
            <div key={i} className={`ai-msg ${msg.role}`}>
              <div className="ai-msg-role">{msg.role === 'user' ? '我' : 'AI'}</div>
              {msg.role === 'assistant' ? (
                <div
                  className="ai-msg-content markdown cot-msg"
                  dangerouslySetInnerHTML={{ __html: (content.includes('<think>') ? renderStepContent(content) : renderMarkdown(content)) || '…' }}
                />
              ) : (
                <div className="ai-msg-content">{content || '…'}</div>
              )}
            </div>
          )
        })}
        {error && <div className="ai-error">{error}</div>}
      </div>

      <div className="ai-input-bar">
        {/* 技能包：pinned 的做成横向滚动的轻量胶囊，其余收进「更多」悬浮菜单 */}
        <div className="ai-skills">
          {SKILLS.filter((s) => s.pinned).map((s) => (
            <button
              key={s.id}
              type="button"
              className="ai-skill-chip"
              disabled={loading !== null}
              onClick={() => runSkill(s)}
              title={s.scope === 'all' ? `${s.name}（全文）` : `${s.name}（当前页）`}
            >
              {s.name}
            </button>
          ))}
          {SKILLS.some((s) => !s.pinned) && (
            <div className={`ai-skill-more${moreOpen ? ' open' : ''}`} ref={moreRef}>
              <button
                ref={moreBtnRef}
                type="button"
                className="ai-skill-chip ghost"
                disabled={loading !== null}
                onClick={toggleMore}
                aria-expanded={moreOpen}
              >
                全部技能 <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m18 15-6-6-6 6" /></svg>
              </button>
            </div>
          )}
        </div>
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
          <button
            type="button"
            className={`ai-key-toggle deep-think${deepThink ? ' on' : ''}`}
            onClick={toggleDeepThink}
            title={deepThink ? '深度思考已开启：回答前先展示推理过程' : '开启深度思考：回答前展示推理过程'}
            aria-pressed={deepThink}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 3a4.5 4.5 0 0 0-2.5 8.2c.6.4 1 .9 1 1.6v.7h3v-.7c0-.7.4-1.2 1-1.6A4.5 4.5 0 0 0 12 3Z" />
              <path d="M10.5 17.5h3" /><path d="M11 20.5h2" />
            </svg>
            深度思考
          </button>
          <button type="button" className="ai-send" onClick={handleAsk} disabled={!input.trim() || loading !== null}>
            发送
          </button>
        </div>
      </div>
    </aside>

    {/* 「全部技能」菜单：用 Portal 渲染到 body，避免被面板的 overflow:hidden 裁切 */}
    {moreOpen && menuPos && createPortal(
      <div
        ref={menuRef}
        className="ai-skill-menu floating"
        role="menu"
        style={{ left: menuPos.left, top: menuPos.top }}
      >
        {(['basic', 'advanced'] as const).map((lv) => {
          const items = SKILLS.filter((s) => !s.pinned && s.level === lv)
          if (items.length === 0) return null
          return (
            <div key={lv} className="ai-skill-menu-group">
              <div className="ai-skill-menu-title">
                {lv === 'advanced' ? '高级' : '基础'}
              </div>
              {items.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className="ai-skill-menu-item"
                  onClick={() => { runSkill(s); setMoreOpen(false) }}
                  role="menuitem"
                >
                  <span className="ai-skill-menu-text">
                    <span className="ai-skill-menu-name">{s.name}</span>
                    {s.desc && <span className="ai-skill-menu-desc">{s.desc}</span>}
                  </span>
                  <span className="ai-skill-menu-scope">{s.scope === 'all' ? '全文' : '当前页'}</span>
                </button>
              ))}
            </div>
          )
        })}
      </div>,
      document.body,
    )}
    </>,
    document.body,
  )
})

export default AiPanel
