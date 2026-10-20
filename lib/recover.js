/**
 * 纯解析层：把模型**写在文本里**的工具调用模板还原成 `{ name, arguments }`。
 *
 * 为什么需要它：`@earendil-works/pi-ai` 的 `openai-responses` / `openai-completions`
 * 适配器只认结构化的 `function_call`（`dist/api/openai-responses-shared.js:624`
 * 只对 `item.type === "function_call"` 调 `parseToolCallArguments`），文本一律当
 * `text` 落进 assistant 消息。于是 mimo-v2.6-pro 在这种"模板漂移"里写出来的
 * `<tool_call>{…}</tool_call>` 不会执行，轮次直接停住（实测 2026-10-19：单轮 8/8
 * 结构化；历史里带一段 XML 后 12 次里 6 次退化成文本）。
 *
 * 这个模块**不碰网络、不碰 Cordis**，所以可以直接拿真样本做单测。它只回答一个
 * 问题："这段文本是不是一个（或几个）可执行的工具调用？"——拿不准就返回 `null`，
 * 由调用方原样透传。宁可这一轮没救回来，也不许凭空造一个工具调用。
 *
 * 认得的形状全部来自实测（2026-10-19 的六个退化样本）：
 *   1. `<tool_call>{"name":"bash","arguments":{…},"id":"…"}</tool_call>`
 *   2. `<function=bash><parameter=command>ls /tmp</parameter></function></tool_call_36a8…>`
 *   3. `<function_calls><invoke name="bash"><parameter name="command">ls /tmp</parameter></invoke>`
 *   4. `<tool_calls><invoke name="bash">…</invoke></tool_calls>`
 *
 * @module dsh-plugin-fly-llm-recover/recover
 */

/** 模板的起始标记（小写）。用于"文本里出现了调用模板"的早期判定与流式 holdback。 */
export const TOOL_CALL_MARKERS = Object.freeze([
  '<tool_call',
  '<tool_calls',
  '<function_call',
  '<function_calls',
  '<function=',
  '<invoke ',
])

/** `<parameter=NAME>VALUE</parameter>`（实测形状 2）。 */
const PARAM_EQUALS = /<parameter=([A-Za-z0-9_.:-]+)\s*>([\s\S]*?)<\/parameter>/gi

/** `<parameter name="NAME">VALUE</parameter>`（实测形状 3/4）。 */
const PARAM_NAMED = /<parameter\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/parameter>/gi

/** `<function=NAME>…</function>`（实测形状 2）。 */
const FUNCTION_TAG = /<function=([A-Za-z0-9_.:-]+)\s*>([\s\S]*?)<\/function\s*>/gi

/** `<invoke name="NAME">…</invoke>`（实测形状 3/4）。 */
const INVOKE_TAG = /<invoke\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/invoke\s*>/gi

/**
 * `<tool_call>…</tool_call>` 这一族。闭合标签有时带后缀（实测 `</tool_call_36a8b9…>`），
 * 所以只要求它以 `</标签` 开头。
 */
const JSON_TAG = /<(tool_call|tool_calls|function_call|function_calls)>([\s\S]*?)<\/\1[^>]*>/gi

/**
 * 文本里第一个"可能是模板"的位置。
 *
 * 流式转发要在这里切一刀：这一刀之前是安全文本（可以直接吐给用户），之后必须扣住，
 * 因为那里起可能是 XML 工具调用 —— 扣住才有机会把它换成结构化块、并且不让 XML 落进历史。
 * 结尾处的"半个标记"（`<tool_ca`）也算，否则跨 chunk 的标记会被漏掉。
 *
 * @param text - 已累积但尚未转发的文本。
 * @returns 需要扣住的起始下标；整段都没有模板迹象时返回 `null`。
 */
export function markerStart(text) {
  if (typeof text !== 'string' || text.length === 0) return null
  const low = text.toLowerCase()
  let best = null
  for (const marker of TOOL_CALL_MARKERS) {
    const at = low.indexOf(marker)
    if (at >= 0 && (best === null || at < best)) best = at
  }
  // 结尾最多 12 个字符里找"某标记的前缀"：`<tool_ca`、`<inv` ……
  const tail = low.slice(Math.max(0, low.length - 12))
  for (const marker of TOOL_CALL_MARKERS) {
    for (let k = 2; k < marker.length; k += 1) {
      if (!tail.endsWith(marker.slice(0, k))) continue
      const at = low.length - k
      if (best === null || at < best) best = at
    }
  }
  return best
}

/**
 * 这段文本里是否**可能**藏着工具调用（历史消毒用，只判有没有）。
 *
 * @param text - 任意文本。
 * @returns 命中任一模板起始标记时为 true。
 */
export function isToolCallTemplate(text) {
  return markerStart(text) !== null
}

/**
 * `<parameter>` 的值：像 JSON 就按 JSON 收，否则按原文字符串收。
 *
 * 为什么需要这一步：`command` 这类参数值本身就是一段 shell（`ls /tmp`），
 * 强行 `JSON.parse` 只会抛错；而 `{"paths":[…]}` 这种值又必须保持结构，
 * 否则工具拿到的是字符串而不是数组。
 *
 * @param raw - 标签之间的原文。
 * @returns 解析后的值。
 */
function coerceParameter(raw) {
  const text = raw.trim()
  if (text.length === 0) return ''
  if (/^[[{]/.test(text) || /^(?:true|false|null|-?\d)/.test(text)) {
    try {
      return JSON.parse(text)
    } catch {
      // 不是 JSON：按原样当字符串（例如 `2>/dev/null`）
    }
  }
  return text
}

/**
 * 把一段 `<parameter…>` 序列读成参数对象。
 *
 * @param body - 标签体。
 * @param pattern - 已带 `g` 的标志正则（调用前会重置 lastIndex）。
 * @returns 参数对象。
 */
function parameterMap(body, pattern) {
  const args = {}
  pattern.lastIndex = 0
  let match
  while ((match = pattern.exec(body)) !== null) args[match[1]] = coerceParameter(match[2])
  return args
}

/**
 * 一条候选调用是否可信。
 *
 * 三道闸：名字非空、参数是普通对象、名字在**本次请求真的提供**的工具里。
 * 最后一道是关键 —— 模型会写 `execute_bash` 这种它自己编的名字（实测出现过），
 * 还原它会换来一次 "unknown tool" 的失败，不如原样透传。
 *
 * @param name - 候选工具名。
 * @param args - 候选参数。
 * @param toolNames - 本次请求提供的工具名集合（空集合表示"不校验"）。
 * @returns 可信时为 true。
 */
function accepts(name, args, toolNames) {
  if (typeof name !== 'string' || name.length === 0) return false
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return false
  if (toolNames !== undefined && toolNames.size > 0 && !toolNames.has(name)) return false
  return true
}

/**
 * `<tool_call>{JSON}</tool_call>` 里的 JSON → 一条或多条调用。
 *
 * 兼容三种写法：裸 `{name, arguments}`、OpenAI 的 `{function:{name, arguments}}`、
 * 以及把参数放在 `input` 里的写法。
 *
 * @param body - 标签体原文。
 * @returns 调用数组；不是 JSON 时返回空数组。
 */
function callsFromJson(body) {
  const text = body.trim()
  if (text.length === 0) return []
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  const list = Array.isArray(parsed) ? parsed : [parsed]
  const calls = []
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue
    const inner = item.function ?? item
    const name = inner.name ?? item.tool ?? item.tool_name
    const args = inner.arguments ?? inner.input ?? item.arguments ?? item.parameters
    let value = args
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value)
      } catch {
        continue
      }
    }
    calls.push({ name, arguments: value === undefined ? {} : value })
  }
  return calls
}

/**
 * 从整段文本里还原工具调用。
 *
 * @param text - assistant 文本（可能混着解释性文字）。
 * @param toolNames - 本次请求提供的工具名集合。
 * @returns `{ calls, clean }`：可执行的调用与去掉模板片段后的文本；认不出返回 `null`。
 */
export function parseToolCalls(text, toolNames) {
  if (typeof text !== 'string' || !text.includes('<')) return null
  const spans = []
  const calls = []

  const collect = (start, end, entries) => {
    const accepted = entries.filter(entry => accepts(entry.name, entry.arguments, toolNames))
    if (accepted.length === 0) return
    spans.push([start, end])
    calls.push(...accepted)
  }

  let match
  FUNCTION_TAG.lastIndex = 0
  while ((match = FUNCTION_TAG.exec(text)) !== null) {
    collect(match.index, match.index + match[0].length, [
      { name: match[1], arguments: parameterMap(match[2], PARAM_EQUALS) },
    ])
  }

  INVOKE_TAG.lastIndex = 0
  while ((match = INVOKE_TAG.exec(text)) !== null) {
    collect(match.index, match.index + match[0].length, [
      { name: match[1], arguments: parameterMap(match[2], PARAM_NAMED) },
    ])
  }

  JSON_TAG.lastIndex = 0
  while ((match = JSON_TAG.exec(text)) !== null) {
    const entries = callsFromJson(match[2])
    if (entries.length === 0) continue
    // 已经被 `<function=…>` / `<invoke …>` 收走的那一段不再重复计算
    if (spans.some(([start, end]) => match.index >= start && match.index < end)) continue
    collect(match.index, match.index + match[0].length, entries)
  }

  if (calls.length === 0) return null
  return { calls, clean: stripStrayTags(stripSpans(text, spans)) }
}

/**
 * 去掉还原后残留的孤立标签。
 *
 * 实测样本里外层包装与内层内容是混着写的：
 *   `<function=bash>…</function></tool_call_36a8b9…>`
 * 内层由 `<function=…>` 收走，外层那个"带后缀的闭合标签"就成了孤儿。
 * 它留在文本里既难看、也会继续当"XML 示例"喂给下一轮，所以一并清掉。
 *
 * 只在**已经还原出调用**之后调用本函数 —— 认不准的文本原样保留。
 *
 * @param text - 去掉模板区间后的文本。
 * @returns 干净文本。
 */
function stripStrayTags(text) {
  return text
    .replace(/<\/?(?:tool_call|tool_calls|function_call|function_calls|invoke|function=[^>]*)[^>]*>/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

/**
 * 去掉模板片段，剩下的文字当解释性文本保留。
 *
 * @param text - 原文。
 * @param spans - 已消费的 `[start, end)` 区间。
 * @returns 归一化空白后的文本。
 */
function stripSpans(text, spans) {
  const ordered = [...spans].sort((a, b) => a[0] - b[0])
  let out = ''
  let cursor = 0
  for (const [start, end] of ordered) {
    if (start < cursor) continue
    out += text.slice(cursor, start)
    cursor = end
  }
  out += text.slice(cursor)
  return out.replace(/\s+/gu, ' ').trim()
}
