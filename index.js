/**
 * DSH Fly llm-recover — Host 半边。
 *
 * 一个普通的 Cordis 行：挂在引擎公开的 `llm/stream` waterfall 上
 * （`dsh-llm/lib/index.js:2397` 的 `ctx.waterfall(this, "llm/stream", options, …)`），
 * 只做一件事 —— 把模型**写成文本**的工具调用还原成结构化 `tool-call` chunk。
 *
 * 为什么在 Host 平面：`llm/stream` 由 Host 的 `LlmRuntime` 发出；按会话挂载的
 * agent 平面行（`presets/fly/agent.cordis.yml` 里那些）永远不是一个 Host Loader
 * 条目，监听不到这个事件。这和 `dsh-plugin-fly-netops` 里记的那条"哪一班岗"
 * 是同一件事。
 *
 * 为什么不是 adapter：`ctx.llm.registerAdapter()` 对已被 pi-ai 占用的 provider
 * 直接抛 `DUPLICATE_ADAPTER`（`dsh-llm/lib/index.js:1871`），而 `llm/stream` 是
 * 上游自己也在用的公开接缝（`dsh-session-checkpoint-policy`、`dsh-repeat-tool-reminder`
 * 都在这上面挂）—— 用它既不改上游，也不用另造一个 provider。
 *
 * 缺省对**所有** provider 生效，也可以按行配置收窄（`providers: [...]`）。
 * 为什么不是"只认某一条路由"：那会把用户机器上的内网 provider id 写进交付字节
 * （`scripts/tests/shipping-hygiene.spec.mjs` 的规矩：别人装不到它）。兜底本身是
 * 幂等的 —— 模型正常发结构化调用时，这里一个字节都不改。
 *
 * @module dsh-plugin-fly-llm-recover
 */

import { recoverAssistantStream } from './lib/stream.js'

/** Cordis 插件名，和 bundle patch 里的行 `name` 对齐。 */
export const name = 'fly-llm-recover'

/** 行配置的缺省值：全开、不限 provider、24 字符 holdback。 */
const DEFAULTS = Object.freeze({ enabled: true, providers: Object.freeze([]), holdback: 24 })

/**
 * 读一个配置值：Cordis 的 volatile 字段是引用盒，必须 `.get()`（本仓 2026-10 的坑）。
 *
 * @param value - 原始配置值。
 * @param fallback - 缺省值。
 * @returns 解引用后的值。
 */
function read(value, fallback) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') return value.get() ?? fallback
  return value ?? fallback
}

/**
 * 归一化行配置。
 *
 * @param config - Loader 行上的 `config`（可缺省）。
 * @returns `{ enabled, providers, holdback }`。
 */
function normalize(config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  const envOff = process.env.FLY_LLM_RECOVER === 'off'
  const envProviders = (process.env.FLY_LLM_RECOVER_PROVIDERS ?? '').split(',').map(part => part.trim()).filter(Boolean)
  const configured = read(raw.providers, undefined)
  // 空数组 = 不限制（所有 provider 都接管）
  const providers = Array.isArray(configured) && configured.length > 0
    ? configured.map(entry => String(read(entry, entry)))
    : envProviders
  const holdback = Number.isInteger(read(raw.holdback, DEFAULTS.holdback)) ? read(raw.holdback, DEFAULTS.holdback) : DEFAULTS.holdback
  return { enabled: read(raw.enabled, DEFAULTS.enabled) === true && !envOff, providers, holdback }
}

/**
 * 挂载这一行。
 *
 * @param ctx - Cordis 插件上下文。
 * @param config - 行配置。
 */
export function apply(ctx, config) {
  const settings = normalize(config)
  if (!settings.enabled) {
    ctx.logger?.info?.('fly-llm-recover: 已关闭（FLY_LLM_RECOVER=off 或 enabled: false）')
    return
  }

  // 装没装上要能一眼看见：这个仓最常见的失败形状就是"门禁全绿、会话里没有这个包"。
  const debug = process.env.FLY_LLM_RECOVER_DEBUG === '1'
  const mounted = `fly-llm-recover: 已挂载（providers=${settings.providers.length === 0 ? '全部' : settings.providers.join(',')}，holdback=${settings.holdback}）`
  ctx.logger?.info?.(mounted)
  // 默认的 logger 级别可能把 info 吞掉；排障时用 `FLY_LLM_RECOVER_DEBUG=1` 拿到确凿的回执
  // （挂载一行 + 每次命中 llm/stream 一行 —— 后者回答"这个钩子在真会话里到底跑没跑"）。
  if (debug) console.error(mounted)

  ctx.on('llm/stream', (options, next) => {
    const provider = options?.provider
    if (typeof provider !== 'string') return next()
    if (settings.providers.length > 0 && !settings.providers.includes(provider)) return next()
    const toolNames = new Set(
      (options.tools ?? []).map(tool => tool?.name).filter(toolName => typeof toolName === 'string' && toolName.length > 0),
    )
    // 本次请求没有提供任何工具：纯文本调用无处可还原，别去改写任何字节。
    if (toolNames.size === 0) return next()
    if (debug) console.error(`fly-llm-recover: 命中 llm/stream（${provider}/${options.model}，${toolNames.size} 个工具）`)
    return recoverAssistantStream(next(), {
      toolNames,
      holdback: settings.holdback,
      report: ({ calls }) => {
        const names = calls.map(call => call.name).join(', ')
        ctx.logger?.info?.(`fly-llm-recover: ${provider}/${options.model} 把文本工具调用还原成结构化调用（${names}）`)
      },
    })
  })
}
