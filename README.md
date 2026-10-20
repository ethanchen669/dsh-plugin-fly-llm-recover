# dsh-plugin-fly-llm-recover

把模型**写成文本**的工具调用还原成结构化 `tool-call` chunk。

## 为什么要有这一行

有的模型（实测：自建网关上的 mimo 系列）在"上下文里出现过 XML 工具调用模板"之后，
会把自己的调用写成文本而不是结构化 `function_call`：

```
<tool_call>{"name":"bash","arguments":{"command":"ls /tmp"}}</tool_call>
<function=bash><parameter=command>ls /tmp</parameter></function>
<function_calls><invoke name="bash"><parameter name="command">ls /tmp</parameter></invoke>
<tool_call> <invoke name="bash"> <parameter name="command">ls /tmp</parameter> </invoke> </tool_call>
```

而 `@earendil-works/pi-ai` 只解析结构化的 `function_call`
（`dist/api/openai-responses-shared.js:624`），文本就是文本 ⇒ 那一轮的工具永远不执行，
会话停在这一步。

## 它挂在哪

Host 平面的 `llm/stream` waterfall（引擎公开接缝，上游自己也在用）。
不换 adapter、不改上游：`dsh-agent-loop` 决定"要不要执行工具"读的是装配出来的
message 里有没有 `tool-call` 块（`dsh-agent-loop/lib/index.js:1150-1156`），
所以补一条 `tool-call-delta` + `block-end` 就够了。

## 三条纪律

1. **认不准就不动手**：工具名不在本次请求提供的工具里、参数不是对象、JSON 坏了 ——
   一律原样透传（宁可这一轮失败，也不许凭空造一个工具调用）。
2. **不把 XML 留在历史里**：还原成功时丢掉上游那条 text `block-end`，只发干净文本。
   否则下一轮模型会照着自己上一条输出继续吐 XML（实测：历史里一段 XML 就把退化率从
   0/12 拉到 6/12）。
3. **默认全开、可收窄**：`providers: [...]` 为空 = 所有 provider 都接管；
   模型正常发结构化调用时，这里一个字节都不改。

## 配置

```yaml
- id: fly-llm-recover
  name: dsh-plugin-fly-llm-recover
  config:
    enabled: true
    providers: []      # 空 = 全部；也可写 ['some-provider']
    holdback: 24       # 没有模板迹象时扣住的字符数（跨 chunk 标记的窗口）
```

环境变量：`FLY_LLM_RECOVER=off` 关闭；`FLY_LLM_RECOVER_PROVIDERS=a,b` 收窄；
`FLY_LLM_RECOVER_DEBUG=1` 往 stderr 打两行确凿回执 —— 挂载一行、每次命中 `llm/stream`
一行（默认 logger 的 info 级会被吞掉，"这个钩子在真会话里到底跑没跑"只能靠它回答）。

## 边界（实测）

- **只救文本**：模型把调用写成文本才有得还原。2026-10-19 还抓到另一种形状 ——
  结构化的 `function_call` 但 `name` 为空（`unknown tool ""`），那一轮没有可还原的
  文本，本包不处理。
- **认不出的模板不猜**：四种形状之外的写法（例如纯 JSON、裸 `invoke` 无包装且工具名
  不在本次请求里）一律透传，宁可这一轮失败也不凭空造调用。

## 测试

```bash
node --test scripts/tests/llm-recover.spec.mjs     # 在仓库根
```

fixture 全部是 2026-10-19 实测抓到的退化文本；装配断言用的是**引擎里那份真
`BlockAssembler`**，不是仿制品。
