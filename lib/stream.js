/**
 * 流式改写层：把上游 chunk 流里"写成文本的工具调用"换成结构化 `tool-call` chunk。
 *
 * 契约来自 `@deepseek-ai/dsh-llm` 的 chunk 协议（`lib/index.js` 的 `BlockAssembler`）：
 *   block-start `{ index, blockType }` / text-delta `{ index, text }` /
 *   reasoning-delta / tool-call-delta `{ index, id, name?, argumentsDelta }` /
 *   block-end `{ index, block }` / usage / finish `{ reason, replayState? }`。
 *
 * 为什么补一条 `tool-call-delta` + `block-end` 就够了：`dsh-agent-loop` 决定"要不要
 * 执行工具"读的是装配出来的 message（`lib/index.js:1150-1156`，
 * `message.content.filter(block => block.type === 'tool-call')`），而不是 finish 的 reason。
 * 所以这里不动 finish、不换 adapter，只补块。
 *
 * 两条"不伤人"的纪律：
 *   1. **认不准就原样透传**：解析失败时把扣住的文本按原顺序补发，一个字节都不改。
 *   2. **不把 XML 留在历史里**：还原成功时丢掉上游那条 text `block-end`
 *      （它的 `block.text` 是 XML 原文），只发干净文本 —— 否则下一轮模型会照着
 *      自己上一条输出继续吐 XML（实测：历史里一段 XML 就把退化率从 0/12 拉到 6/12）。
 *
 * @module dsh-plugin-fly-llm-recover/stream
 */

import { randomUUID } from 'node:crypto'
import { markerStart, parseToolCalls } from './recover.js'

/** 还原出来的调用 id 前缀，便于在会话日志里一眼认出"这是兜底来的"。 */
const ID_PREFIX = 'call_fly_'

/** 没有模板迹象时扣住的字符数：跨 chunk 的标记最多这么多字符，再多就是纯延迟。 */
const DEFAULT_HOLDBACK = 24

/** finish 之后不再有块，这里只保留一个自述用的常量。 */
export const RECOVER_ID_PREFIX = ID_PREFIX

/**
 * 改写一条模型调用的 chunk 流。
 *
 * @param upstream - 上游（`next()` 返回的）chunk 异步可迭代对象。
 * @param options - `{ toolNames, holdback?, report? }`。
 * @returns 改写后的 chunk 异步生成器。
 */
export async function* recoverAssistantStream(upstream, options = {}) {
  const toolNames = options.toolNames
  const holdback = Number.isInteger(options.holdback) && options.holdback >= 0 ? options.holdback : DEFAULT_HOLDBACK
  const report = typeof options.report === 'function' ? options.report : () => {}

  /** index → 尚未转发的文本（只对 text 块）。 */
  const held = new Map()
  /** 新块一律排在所有见过的块之后。 */
  let nextIndex = 0

  function* recoveredChunks(textIndex, result) {
    if (result.clean.length > 0) yield { type: 'text-delta', index: textIndex, text: result.clean }
    for (const call of result.calls) {
      const index = nextIndex++
      const id = `${ID_PREFIX}${randomUUID().replace(/-/gu, '').slice(0, 24)}`
      const args = JSON.stringify(call.arguments ?? {})
      yield { type: 'tool-call-delta', index, id, name: call.name, argumentsDelta: args }
      yield { type: 'block-end', index, block: { type: 'tool-call', id, name: call.name, arguments: args } }
    }
    report({ calls: result.calls })
  }

  for await (const chunk of upstream) {
    if (chunk === null || typeof chunk !== 'object') {
      yield chunk
      continue
    }
    if (Number.isInteger(chunk.index)) nextIndex = Math.max(nextIndex, chunk.index + 1)

    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      const state = held.get(chunk.index) ?? { text: '' }
      held.set(chunk.index, state)
      state.text += chunk.text
      // 模板起点之前是安全文本；之后必须扣住，才有机会整段换成结构化块。
      const start = markerStart(state.text)
      const cut = start === null ? Math.max(0, state.text.length - holdback) : start
      if (cut > 0) {
        yield { ...chunk, text: state.text.slice(0, cut) }
        state.text = state.text.slice(cut)
      }
      continue
    }

    if (chunk.type === 'block-end' && chunk.block?.type === 'text') {
      const state = held.get(chunk.index)
      held.delete(chunk.index)
      // 有的适配器只发 block-end（不发 delta）：那时原文就在 block.text 里。
      const raw = state === undefined ? String(chunk.block.text ?? '') : state.text
      const result = parseToolCalls(raw, toolNames)
      if (result === null) {
        if (state !== undefined && state.text.length > 0) {
          yield { type: 'text-delta', index: chunk.index, text: state.text }
        }
        yield chunk
        continue
      }
      yield* recoveredChunks(chunk.index, result)
      // 故意丢掉上游的 text block-end：它带着 XML 原文。
      continue
    }

    if (chunk.type === 'finish') {
      for (const [index, state] of held) {
        const result = parseToolCalls(state.text, toolNames)
        if (result === null) {
          if (state.text.length > 0) yield { type: 'text-delta', index, text: state.text }
          continue
        }
        yield* recoveredChunks(index, result)
      }
      held.clear()
      yield chunk
      continue
    }

    yield chunk
  }

  // 上游没发 finish 就结束了（连接断掉等）：手里扣着的文本仍按同一套规则收尾。
  for (const [index, state] of held) {
    const result = parseToolCalls(state.text, toolNames)
    if (result === null) {
      if (state.text.length > 0) yield { type: 'text-delta', index, text: state.text }
      continue
    }
    yield* recoveredChunks(index, result)
  }
  held.clear()
}
