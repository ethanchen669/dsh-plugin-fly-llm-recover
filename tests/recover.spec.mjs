/**
 * `dsh-plugin-fly-llm-recover` 的闸门测试。
 *
 * 三件事必须在这里证明，否则这个包就是在"看起来救回来了"的路上：
 *   1. **真样本能还原**：fixture 全部来自 2026-10-19 实测抓到的退化文本（不是我编的形状）；
 *   2. **认不准不伤人**：模型编的工具名、正常段落，一个字节都不许改；
 *   3. **装配结果真的带 tool-call 块**：用**引擎里那份真 `BlockAssembler`** 装配，
 *      因为 `dsh-agent-loop` 决定的正是"装配出来的 message 里有没有 tool-call 块"
 *      （`dsh-agent-loop/lib/index.js:1150-1156`）。自己写一个仿制装配器只能证明
 *      "我以为的协议"。
 *
 * @module tests/recover.spec
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { BlockAssembler } from '@deepseek-ai/dsh-llm'

import { markerStart, parseToolCalls } from '../lib/recover.js'
import { recoverAssistantStream } from '../lib/stream.js'

/**
 * 真装配器来自**发布的引擎包**（devDependency 钉版本），不是本仓仿制的。
 * 独立仓没有"钉住的闭包"可找，所以这条断言的价值完全靠这个 import 撑着：
 * 引擎一旦改了 chunk 协议，这里先红。
 */
async function loadBlockAssembler() {
  assert.equal(typeof BlockAssembler, 'function', '@deepseek-ai/dsh-llm 里没有 BlockAssembler —— 引擎协议变了')
  return BlockAssembler
}

/**
 * 2026-10-19 实测抓到的退化文本，逐字抄录（含多余空格、含带后缀的闭合标签）。
 * 来源：/tmp/fly-diag/out-xml2-*.txt、out-rate-*.txt。
 */
const FIXTURES = [
  {
    label: 'responses 流式（首轮）',
    text: '<tool_call> {"id": "call_bash_ls_tmp", "name": "bash", "arguments": {"command": "ls /tmp", "description": "List files under /tmp"}} </tool_call>',
  },
  {
    label: 'responses 非流式',
    text: '<tool_call> {"name": "bash", "arguments": {"command": "ls /tmp", "description": "List files under /tmp"}, "id": "call_1"} </tool_call>',
  },
  {
    label: 'responses 非流式（function= 形状 + 带后缀闭合）',
    text: '<function=bash><parameter=command>ls /tmp</parameter><parameter=description>List files under /tmp</parameter></function></tool_call_36a8b94076c558de0938f7e4f3cd4f18c5490ca0>',
  },
  {
    label: 'chat 流式（tool_call 包 function= 形状）',
    text: '<tool_call> <function=bash><parameter=command>ls /tmp</parameter><parameter=description>List files under /tmp</parameter></function> </tool_call_36a8b94076c558de0938f7e4f3cd4f18c5490ca0>',
  },
  {
    label: 'chat 流式（tool_calls + invoke）',
    text: '<tool_calls> <invoke name="bash"> <parameter name="command">ls /tmp</parameter> </invoke> ',
  },
  {
    label: 'responses 非流式（function_calls + invoke）',
    text: '<function_calls> <invoke name="bash"> <parameter name="command">ls /tmp</parameter> </invoke>',
  },
]

const NORMAL_TEXT = '我先看一下 /tmp 里有什么，然后用 bash 列出来。'

/**
 * 造一条与上游同形的 chunk 流。
 *
 * @param text - 文本块内容。
 * @param options - `{ blockOnly, chunkSize, finish }`。
 * @returns chunk 数组。
 */
function textChunks(text, { blockOnly = false, chunkSize = 7, finish = true } = {}) {
  const chunks = [{ type: 'block-start', index: 0, blockType: 'text' }]
  if (blockOnly) {
    chunks.push({ type: 'block-end', index: 0, block: { type: 'text', text } })
  } else {
    for (let at = 0; at < text.length; at += chunkSize) chunks.push({ type: 'text-delta', index: 0, text: text.slice(at, at + chunkSize) })
    chunks.push({ type: 'block-end', index: 0, block: { type: 'text', text } })
  }
  if (finish) chunks.push({ type: 'finish', reason: { kind: 'stop' } })
  return chunks
}

/**
 * 把 chunk 数组喂给改写层。
 *
 * @param chunks - 上游 chunk。
 * @param toolNames - 工具名集合。
 * @returns 改写后的 chunk 数组。
 */
async function run(chunks, toolNames) {
  async function* upstream() {
    for (const chunk of chunks) yield chunk
  }
  const out = []
  for await (const chunk of recoverAssistantStream(upstream(), { toolNames: new Set(toolNames) })) out.push(chunk)
  return out
}

const BASH = ['bash', 'read', 'write']

test('真样本：每种退化形状都能还原出 bash 调用', () => {
  for (const fixture of FIXTURES) {
    const result = parseToolCalls(fixture.text, new Set(BASH))
    assert.ok(result !== null, `${fixture.label}: 没还原出来`)
    assert.equal(result.calls.length, 1, `${fixture.label}: 应恰有一条调用`)
    assert.equal(result.calls[0].name, 'bash', `${fixture.label}: 工具名`)
    assert.equal(result.calls[0].arguments.command, 'ls /tmp', `${fixture.label}: 参数`)
    assert.ok(!result.clean.includes('<'), `${fixture.label}: clean 里还留着标签：${result.clean}`)
  }
})

test('认不准不伤人：编造的工具名、正常段落都返回 null', () => {
  const invented = '<tool_call> {"name": "execute_bash", "arguments": {"command": "ls /tmp"}, "id": "call_36a8"} </tool_call>'
  assert.equal(parseToolCalls(invented, new Set(BASH)), null, '本次请求没提供 execute_bash，不许还原')
  assert.equal(parseToolCalls(NORMAL_TEXT, new Set(BASH)), null, '正常段落不该被当成调用')
  assert.equal(parseToolCalls('<tool_call> {not json} </tool_call>', new Set(BASH)), null, '坏 JSON 不许还原')
})

test('流式改写：装配出来的 message 里真有 tool-call 块，且文本里没有 XML', async () => {
  const BlockAssembler = await loadBlockAssembler()
  for (const fixture of FIXTURES) {
    const out = await run(textChunks(fixture.text), BASH)
    const assembler = new BlockAssembler()
    for (const chunk of out) assembler.push(chunk)
    const blocks = assembler.blocks()
    const calls = blocks.filter(block => block.type === 'tool-call')
    assert.equal(calls.length, 1, `${fixture.label}: 装配后没有 tool-call 块（blocks=${JSON.stringify(blocks)}）`)
    assert.equal(calls[0].name, 'bash', `${fixture.label}: 块里的工具名`)
    assert.equal(JSON.parse(calls[0].arguments).command, 'ls /tmp', `${fixture.label}: 块里的参数`)
    const text = blocks.filter(block => block.type === 'text').map(block => block.text).join('')
    assert.ok(!/<\/?(?:tool_call|tool_calls|function_calls|function=|invoke)/u.test(text), `${fixture.label}: 文本里还留着模板：${text}`)
  }
})

test('流式改写：只发 block-end 的适配器也能还原', async () => {
  const BlockAssembler = await loadBlockAssembler()
  const out = await run(textChunks(FIXTURES[0].text, { blockOnly: true }), BASH)
  const assembler = new BlockAssembler()
  for (const chunk of out) assembler.push(chunk)
  assert.equal(assembler.blocks().filter(block => block.type === 'tool-call').length, 1)
})

test('正常文本一个字节都不改', async () => {
  const out = await run(textChunks(NORMAL_TEXT), BASH)
  const text = out.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
  assert.equal(text, NORMAL_TEXT, '正常文本被改写了')
  assert.ok(out.some(chunk => chunk.type === 'block-end' && chunk.block?.type === 'text'), '正常文本的 block-end 被吞了')
  assert.equal(out.at(-1)?.type, 'finish', 'finish 必须原样透传')
})

test('工具不在本次请求里时：不还原、原文照样完整落地', async () => {
  const BlockAssembler = await loadBlockAssembler()
  const out = await run(textChunks(FIXTURES[0].text), ['read'])
  const assembler = new BlockAssembler()
  for (const chunk of out) assembler.push(chunk)
  const blocks = assembler.blocks()
  assert.equal(blocks.filter(block => block.type === 'tool-call').length, 0, '不该凭空造调用')
  const text = blocks.filter(block => block.type === 'text').map(block => block.text).join('')
  assert.ok(text.includes('<tool_call>'), '不可信时原文必须原样保留，便于人工排查')
})

test('markerStart 能看见跨 chunk 的"半个标记"', () => {
  assert.equal(markerStart('hello <tool_ca'), 6)
  assert.equal(markerStart('nothing here'), null)
  assert.equal(markerStart('x <invoke name="bash">'), 2)
})

test('行装配：apply() 只拦 llm/stream，且没有工具时原样放行', async () => {
  const { apply } = await import('../index.js')
  const handlers = new Map()
  const logged = []
  apply({ on: (event, handler) => handlers.set(event, handler), logger: { info: message => logged.push(message) } }, {})
  const handler = handlers.get('llm/stream')
  assert.equal(typeof handler, 'function', 'apply() 没挂上 llm/stream')

  const chunks = textChunks(FIXTURES[0].text)
  async function* upstream() {
    for (const chunk of chunks) yield chunk
  }
  const out = []
  for await (const chunk of handler({ provider: 'any', model: 'm', tools: [{ name: 'bash' }] }, upstream)) out.push(chunk)
  assert.ok(out.some(chunk => chunk.type === 'tool-call-delta' && chunk.name === 'bash'), '有工具时没还原')
  assert.ok(logged.some(line => line.includes('把文本工具调用还原')), '还原了却没有日志')

  async function* again() {
    for (const chunk of chunks) yield chunk
  }
  const passthrough = []
  for await (const chunk of handler({ provider: 'any', model: 'm', tools: [] }, again)) passthrough.push(chunk)
  assert.deepEqual(passthrough, chunks, '没有工具时不该改任何一个 chunk')
})

test('行装配：providers 收窄后，别的 provider 一个字节都不动', async () => {
  const { apply } = await import('../index.js')
  const handlers = new Map()
  apply({ on: (event, handler) => handlers.set(event, handler), logger: { info: () => {} } }, { providers: ['only-this-one'] })
  const handler = handlers.get('llm/stream')
  const chunks = textChunks(FIXTURES[0].text)
  async function* upstream() {
    for (const chunk of chunks) yield chunk
  }
  const out = []
  for await (const chunk of handler({ provider: 'other', model: 'm', tools: [{ name: 'bash' }] }, upstream)) out.push(chunk)
  assert.deepEqual(out, chunks, '收窄的 provider 名单没生效')
})
