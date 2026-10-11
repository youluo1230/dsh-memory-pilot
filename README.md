# MemoryPilot — 智能记忆调度

[![tests](https://img.shields.io/badge/tests-144%20passing-brightgreen)]() [![node](https://img.shields.io/badge/node-%E2%89%A518-blue)]()

决策模型驱动的统一记忆编排插件(v0.3.8)。决策模型在每轮选择是否召回、查哪个后端、查多深、何时写入;程序只负责授权、能力校验、预算和审计。

**架构一览：**

pnpm install        # 或 npm install
npm test            # 144 项单元测试
```

作为 DSH 插件挂载见下文「安装」；独立集成可直接使用导出的
`createOrchestrator` / `createSystemOneDecision` / `createHindsightBackend` 等
工厂函数（见 `package.json` 的 `exports`）。

## 原则

- 模型生成读写行动计划,程序只做授权、能力校验、执行预算和审计。
- backend 与 scope 分开:personal、global、project、workspace。scopeId 由服务端从身份推导,模型不能选择任意 bank、namespace 或 URL。
- 默认拒绝:只有配置里显式授权的绑定才出现在决策输入中;读写权限按绑定独立。
- 决策失败、超时或计划非法时静默跳过(noop/timeout),不影响回合。
- 注入文本是带 `trust: untrusted` 标记的有界 JSON,绝不当作权威。

## 后端

| 类型 | 传输 | 能力 | 说明 |
|---|---|---|---|
| `hindsight` | HTTP(固定 bank) | search / deep / write | write 为异步 retain,受理≠提取完成 |
| [`memos-bridge`](https://github.com/MemTensor/MemOS/tree/main/apps/memos-local-plugin)（`@memtensor/memos-local-plugin` 自带） | 子进程 stdio JSON-RPC | search / write | write 为 `turn.start`+`turn.end` 回合捕获,后台归纳;搜索结果按设计含 hub 共享内容 |
| `memos` | HTTP `/api/v1/memory/search` | search | 仅限真正隔离实例;viewer 密码模式下不可用(当前部署未用) |

## 工作原理

```
会话事件(message/checkpoint/turn_end)
        │
        ▼
┌──────────────────────────────────────────────┐
│ Orchestrator (src/core.mjs)                  │
│  快照冻结 → 能力清单 → 决策模型 → 计划校验   │
│  → 执行(去重/预算/中止) → 渲染注入           │
└──────────────────────────────────────────────┘
   │ 决策适配器              │ 后端适配器
   ▼                        ▼
┌──────────────┐   ┌──────────────────────────────┐
│ SystemOne    │   │ hindsight   (HTTP, 固定 bank)│
│ (类型化决策) │   │ memos-bridge (stdio JSON-RPC)│
│ OpenAI 兼容  │   │ memos       (HTTP, 隔离实例) │
└──────────────┘   └──────────────────────────────┘
```

## 开发与测试

```sh
pnpm install
npm test                     # 144 项单元测试
npm run check
```

完整冒烟与真机端到端（`test/plugin-smoke.mjs`、`scripts/e2e-live.mjs`）需要已安装的 DSH 宿主环境，见脚本头部注释。

## 目录结构

```
src/
  plugin.mjs          入口：配置 schema、运行时组装、DSH 钩子注册
  core.mjs            编排核心：快照/校验/去重/预算/渲染(零依赖)
  adapters.mjs        SystemOne + OpenAI 兼容决策适配器；Hindsight/MemOS 后端
  memos-bridge.mjs    MemOS 子进程 stdio JSON-RPC 适配器(turn 捕获)
  memos-http.mjs      MemOS HTTP 搜索适配器(仅隔离实例)
  host.mjs            DSH 生命周期适配(agent 钩子、回合捕获、dispose)
  registry.mjs        绑定→后端实例注册表(权限过滤、描述符)
  configuration.mjs   身份检测(cwd→仓库)、legacy 配置归一化
  discovery.mjs       Hindsight bank 发现与创建
  settings-rpc.mjs    浏览器配置页的受信 RPC(get/mutate/discover/create-bank)
  tools.mjs           memory_retrieve / memory_remember 工具注册
lib/client.js         浏览器端配置页(设置导航 + 插件面板)
test/                 144 项单元测试 + 可选真机冒烟(plugin-smoke.mjs)
scripts/              e2e-live / bench-decision / probe-memos-write
cordis.patch.yml      随包分发的 bundle patch(声明插件加载入口)
examples/             cordis-patch-minimal.yml 最小绑定示例
GLOSSARY.md           术语表(memory system / library / scope 等)
```

## 源码导读（5 分钟版）

1. **`core.mjs`** — 整个安全模型在这一个文件：`snapshot()` 冻结事件并校验形状；
   `inventory()` 从**服务端绑定**推导能力清单（模型拿到的 backend/scope 都是不透明 id）；
   `validate()` 把模型计划逐条对照能力清单，越权字段直接整体拒绝；
   `perform()` 用 `Promise.race` 实现硬预算，写入先占去重槽再执行（超时绝不自动重试）；
   `render()` 双重限长（单条 + 总包），注入永远是 `trust: untrusted` 的有界 JSON。
2. **`adapters.mjs`** — `createSystemOneDecision` 把能力清单翻译成类型化问题
   （recall_gate / retrieval_mode / scope_* / retention_gate），
   并按「门控优先」合并答案；HTTP 后端全部拒绝模型控制的 bank/namespace 字段。
3. **`plugin.mjs`** — 配置全部 `volatile()`：设置面板热改不重启；运行时按
   身份（actorId/projectId/workspaceId）缓存实例，配置哈希变化时整体重建并 dispose。
4. **`host.mjs`** — 每会话只「准入」一次（首个含用户消息的 step-1），随后按
   `turn/end` 捕获回合文本；所有异步任务挂 `pending`，dispose 时 `allSettled` 等待收尾。

## 配置面板

浏览器端配置页随包分发（`lib/client.js`、`dsh.client` 声明），挂在两处：

- **设置 → 左侧导航「MemoryPilot 记忆调度」**：按任务分成「决策模型 / 记忆系统 / 使用范围 / 高级设置」四个页签。
- **侧栏「插件」→ dsh-memory-pilot 行的「配置」按钮**：打开同一配置页。

记忆系统与作用范围分开管理：系统卡片只显示连接摘要，连接细节在编辑弹窗中维护。使用范围页以可筛选表格展示全局、工作区和仓库绑定，包括范围标识、记忆系统、bank、读写权限及编辑/删除操作。普通界面不暴露 `scopeId`。工作区是管理范围，Git 仓库是记忆隔离范围；默认从会话 `cwd` 自动识别，只有需要时才填写 override。

回环访问使用宿主 `configForms`；受信任的远程访问使用专用、鉴权的 MemoryPilot connection RPC，并保留 revision fencing 和服务端字段白名单。设置导航会立即注册，不再受配置 namespace 的服务时序影响。

## 安装（DSH 插件）

> 前置条件：已安装 DSH（`@deepseek-ai/dsh`）并至少启动过一次 `dsh web`，
> 使 `web` profile 完成初始化。插件版本需与 `dsh --version` 显示的 peer
> 范围兼容。

### 安装

```sh
dsh plugin --profile web add github:youluo1230/dsh-memory-pilot
# 或锁定版本：
dsh plugin --profile web add github:youluo1230/dsh-memory-pilot#v0.3.8
```

`dsh plugin` 会在 profile 目录内转发给 pnpm 完成安装，并把插件写入
profile 的 `package.json` 依赖。

### 启用

在 profile 的 `dsh.profile.bundles` 中加入 `"dsh-memory-pilot"`
（编辑 profile 目录下的 `package.json`）。随后：

- 若 profile 启用了配置热重载（`patchReload: "live"`），改动会自动重载；
- 否则重启 DSH web 生效。

### 配置

安装并启用后打开 DSH Web：

1. **设置 → 左侧导航「MemoryPilot 记忆调度」**：按「决策模型 / 记忆系统 /
   使用范围 / 高级设置」四个页签填写；改动即时生效（配置全 volatile，无需重启）。
2. 也可以在 profile 的 `cordis.patch.yml` 中预置绑定，参考
   [`examples/cordis-patch-minimal.yml`](examples/cordis-patch-minimal.yml)。

### 最低要求

- Node.js ≥ 18
- 一个决策模型端点：SystemOne 类型化接口（`POST /v1/systemone`）或
  OpenAI 兼容 `POST /v1/chat/completions`（JSON mode）
- 至少一个记忆后端：
  [Hindsight](https://github.com/vectorize-io/hindsight)（HTTP 服务）、
  [MemOS memos-local-plugin](https://github.com/MemTensor/MemOS/tree/main/apps/memos-local-plugin)
  （一键装进 DSH：`curl -fsSL https://raw.githubusercontent.com/MemTensor/MemOS/main/apps/memos-local-plugin/install.sh | bash -s -- --agent dsh --profile web`）
  或 MemOS 隔离 HTTP 实例
- 决策模型 API key 通过环境变量注入（`decisionKeyEnv`），**不要**写进配置文件

### 卸载 / 回退

```sh
dsh plugin --profile web remove dsh-memory-pilot
# 并从 dsh.profile.bundles 移除该名称，重启 DSH。
```

## 限制

- 决策模型不可用(网关 503 等)时该轮无召回,不兜底;网关波动已实测存在。
- 写入是异步的:Hindsight 需提取、MemOS 需后台归纳,写入成功≠立即可检索。
- 幂等仅进程内;持久化 outbox、冲突合并、跨后端事务未实现。
- SystemOne 是类型化决策模型，不生成任意文本；MemoryPilot 只让它在程序生成的已授权召回/写入候选中选择。
- `workspacePath` 是包含其子目录的工作区根；仓库身份从会话真实 `cwd` 独立识别，两者互不干扰。
