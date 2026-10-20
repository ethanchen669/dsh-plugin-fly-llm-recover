# 安装

三种装法，按你的场景挑一个。装完**都要重启那个进程** —— 引擎把客户端包与插件行缓存在
进程内，刷新页面不够。

## 1. 自建的 web profile（有 npm 包之后）

```bash
cd ~/.dsh                                  # cwd 必须是 DSH_HOME
dsh plugin --profile=web add @dsh-fly/dsh-plugin-fly-llm-recover@0.1.0 \
  --registry=https://registry.npmjs.org/   # 默认 registry 可能是内网镜像，公开 scoped 包务必带上
```

`dsh plugin add` 会同时写 `profiles/web/package.json` 的两处：`dependencies` 与
`dsh.profile.bundles`。只写进 `dependencies` 不会开机（bundle 层不参与装配）。

## 2. 从 tarball 装（npm 包还没发出来时）

```bash
npm pack                                  # 在本仓根目录，得到 dsh-fly-dsh-plugin-fly-llm-recover-0.1.0.tgz
cd ~/.dsh
dsh plugin --profile=web add /绝对路径/dsh-fly-dsh-plugin-fly-llm-recover-0.1.0.tgz
```

路径必须**绝对或 `./` 开头** —— 裸文件名会被当成 registry 上的包名去找。

## 3. 官方桌面版（`profiles/desktop`）

这一边 **`dsh plugin` 会被拒**（`profile "desktop" is managed exclusively by the Electron
application`，引擎 `bin.js` 里写死）。实测可用的绕法是：

```bash
# ① 退出 DeepSeek Harness.app（app 会在退出/启动时重写这个 profile）
osascript -e 'quit app "DeepSeek Harness"'

# ② 备份
D=~/.dsh/profiles/desktop
cp -p "$D/package.json" "$D/package.json.bak-$(date +%Y%m%d-%H%M%S)"
cp -p "$D/pnpm-lock.yaml" "$D/pnpm-lock.yaml.bak-$(date +%Y%m%d-%H%M%S)"

# ③ 装依赖（用 tarball 或版本号）
cd "$D"
pnpm add /绝对路径/dsh-fly-dsh-plugin-fly-llm-recover-0.1.0.tgz

# ④ 把包名追加进 dsh.profile.bundles（只装依赖不开机：bundle 层不参与装配）
#    编辑 package.json，在 dsh.profile.bundles 数组末尾加一行：
#      "@dsh-fly/dsh-plugin-fly-llm-recover"

# ⑤ 重启 app
open -a "DeepSeek Harness"
```

## 验证装上了没有

`FLY_LLM_RECOVER_DEBUG=1` 启动进程（或 `FLY_LLM_RECOVER_LOG=/tmp/recover.log` 落文件——
**官方桌面版的 stderr 看不到**，必须用后者），会出现两行：

```
fly-llm-recover: 已挂载（providers=全部，holdback=24）
fly-llm-recover: 命中 llm/stream（<provider>/<model>，N 个工具）
```

只有第一行、没有第二行 = 行挂上了但这个会话没走模型调用；两行都没有 = **没装上**
（最常见的原因是只加了 `dependencies` 没加 `bundles`，或者行名与包名不一致）。

命中兜底时会多一行：

```
fly-llm-recover: <provider>/<model> 把文本工具调用还原成结构化调用（bash）
```

## 关掉 / 换 provider

行配置（`profiles/<profile>/cordis.patch.yml`）：

```yaml
- id: fly-llm-recover
  config:
    enabled: false
    providers: []      # 空 = 全部；也可写 ['some-provider']
    holdback: 24
```

或环境变量 `FLY_LLM_RECOVER=off`、`FLY_LLM_RECOVER_PROVIDERS=a,b`。
