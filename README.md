# MemoryPilot — 智能记忆调度

[![tests](https://img.shields.io/badge/tests-143%20passing-brightgreen)]() [![node](https://img.shields.io/badge/node-%E2%89%A518-blue)]()

决策模型驱动的统一记忆编排插件(v0.3.8)。决策模型在每轮选择是否召回、查哪个后端、查多深、何时写入;程序只负责授权、能力校验、预算和审计。

**架构一览：**

```
会话事件(message/checkpoint/turn_end)
        │
        ▼
┌──────────────────────────────────────────────┐
│ Orchestrator (src/core.mjs)                  │
│  快照冻结 → 能力清单 → 决策模型 → 计划校验   │
│  → 执行(去重/预算/中止) → 渲染注入            │
└──────────────────────────────────────────────┘
   │ 决策适配器              │ 后端适配器
   ▼                        ▼
┌──────────────┐   ┌──────────────────────────────┐
│ SystemOne    │   │ hindsight   (HTTP, 固定 bank)│
│ (类型化决策) │   │ memos-bridge (stdio JSON-RPC)│
│ OpenAI 兼容  │   │ memos       (HTTP, 隔离实例) │
└──────────────┘   └──────────────────────────────┘
```

## 快速开始

```sh
pnpm install        # 或 npm install
npm test            # 143 项单元测试
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
| `memos-bridge` | 子进程 stdio JSON-RPC(与 Hermes 同款机器接口) | search / write | write 为 `turn.start`+`turn.end` 回合捕获,后台归纳;搜索结果按设计含 hub 共享内容 |
| `memos` | HTTP `/api/v1/memory/search` | search | 仅限真正隔离实例;viewer 密码模式下不可用(当前部署未用) |

## 生产绑定(/vol1/1000/code)

见 `cordis.patch.yml`(随包分发,DSH bundle patch 自动装配):

- **project `code`** → Hindsight `coding-agent::code`(读写,沿用既有库)+ MemOS 共享库 bridge(读写,turn 捕获)
- **global** → Hindsight `hermes`(只读,Hermes 长期记忆)
- 决策模型：DGX4 上的 `clef-flash`，通过原生 Jev/SystemOne `POST /v1/systemone` 接口做类型化选择；不是 OpenAI Chat Completions。
- `budgetMs: 9000`（交互召回），`captureBudgetMs: 60000`（后台捕获）。
- `/vol1/1000/code` 是工作区根；其下会话按真实 `cwd` 识别最近 Git 仓库，不会误匹配相邻路径。

## 检查与验收

```sh
npm test                     # 143 项单元测试(全部通过)
npm run check
DSH_TEST_PROFILE=/root/.dsh/profiles/web/package.json node test/plugin-smoke.mjs
node scripts/e2e-live.mjs    # 真机端到端:8/8 通过(决策/Hindsight 读写/MemOS bridge 读写/全链路)
node scripts/bench-decision.mjs  # 决策模型基准
```

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
test/                 143 项单元测试 + 可选真机冒烟(plugin-smoke.mjs)
scripts/              e2e-live / bench-decision / probe-memos-write
cordis.patch.yml      生产绑定示例(/vol1/1000/code 工作区)
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

E2E 实测(2026-10-10):决策 2.6s;Hindsight 项目/全局召回 1.4/3.3s;MemOS bridge 搜索 3.4s;Hindsight 写入→回流 ~10s;MemOS 回合捕获 11.6s;完整 orchestrator status=ok。

## 配置面板（0.2.12）

浏览器端配置页随包分发（`lib/client.js`、`dsh.client` 声明），挂在两处：

- **设置 → 左侧导航「MemoryPilot 记忆调度」**：按任务分成「决策模型 / 记忆系统 / 使用范围 / 高级设置」四个页签。
- **侧栏「插件」→ dsh-memory-pilot 行的「配置」按钮**：打开同一配置页。

记忆系统与作用范围分开管理：系统卡片只显示连接摘要，连接细节在编辑弹窗中维护。使用范围页以可筛选表格展示全局、工作区和仓库绑定，包括范围标识、记忆系统、bank、读写权限及编辑/删除操作。普通界面不暴露 `scopeId`。工作区是管理范围，Git 仓库是记忆隔离范围；默认从会话 `cwd` 自动识别，只有需要时才填写 override。

回环访问使用宿主 `configForms`；受信任的远程访问使用专用、鉴权的 MemoryPilot connection RPC，并保留 revision fencing 和服务端字段白名单。设置导航会立即注册，不再受配置 namespace 的服务时序影响。

## 安装（DSH 插件）

### 方式一：从 GitHub 直接安装（推荐）

在目标机器上确认已认证 GitHub（`gh auth login`）或已配置 git 凭据，然后：

```sh
# 1. 把插件装入 DSH web profile
cd /root/.dsh/profiles/web
pnpm add github:youluo1230/dsh-memory-pilot

# 2. 在 profile 的 package.json 里把 "dsh-memory-pilot" 加入 dsh.profile.bundles
#    (若已存在 dsh.profile.bundles 数组则追加)

# 3. 重启 DSH web 生效（dsh-bridge 辅助进程托管，约 3-7s）
```

也可以锁定版本（推荐，便于回退）：

```sh
pnpm add github:youluo1230/dsh-memory-pilot#v0.3.8
```

### 方式二：本地 tgz 安装

```sh
git clone https://github.com/youluo1230/dsh-memory-pilot.git
cd dsh-memory-pilot && npm pack
cd /root/.dsh/profiles/web && pnpm add file:/path/to/dsh-memory-pilot-0.3.8.tgz
# 同样把 "dsh-memory-pilot" 加入 dsh.profile.bundles 后重启
```

### 安装后配置（三选一）

1. **配置面板**（推荐）：重启后打开 DSH Web → 设置 → 左侧导航「MemoryPilot 记忆调度」，按「决策模型 / 记忆系统 / 使用范围 / 高级设置」四个页签填写；改动即时生效（全 volatile，无需重启）。
2. **cordis patch**：参考 [`examples/cordis-patch-minimal.yml`](examples/cordis-patch-minimal.yml) 或本仓库 [`cordis.patch.yml`](cordis.patch.yml)（生产实例）追加到 profile 的 `cordis.patch.yml`。
3. **首次启动即生效**：patch 中 `enabled: true` + 完整绑定，重启后自动装配（本机生产即此形态）。

### 最低要求

- Node.js ≥ 18（开发环境 Node 25）
- 一个决策模型端点：SystemOne 类型化接口（`POST /v1/systemone`）或 OpenAI 兼容 `POST /v1/chat/completions`（JSON mode）
- 至少一个记忆后端：Hindsight（`http(s)://host:8889`）、MemOS bridge（本机 Hermes memos 插件目录）或 MemOS 隔离实例
- 决策模型 API key 通过环境变量注入（`decisionKeyEnv`），**不要**写进配置文件

### 验证安装

```sh
# 插件可加载且钩子注册成功（无需网络）：
DSH_TEST_PROFILE=/root/.dsh/profiles/web/package.json node test/plugin-smoke.mjs
# 或在 DSH 日志中观察 MemoryPilot 审计记录：
#   MemoryPilot {"phase":"decision","status":"started",...}
```

### 卸载 / 回退

```sh
cd /root/.dsh/profiles/web
pnpm remove dsh-memory-pilot
# 并从 package.json 的 dsh.profile.bundles 移除该名称，重启 DSH。
```

## 切换与回退

- **停用旧插件**(MemoryPilot 验证正常后):在 profile `cordis.patch.yml` 追加覆盖条目——`dsh-memos-memory` 对应 insert 条目改 `enabled:false`;`@vectorize-io/hindsight-coding-agents` 同理。需再次重启。
- **回退 MemoryPilot**:把 bundles 里的 `dsh-memory-pilot` 移除(或把 patch 中 `enabled` 改 false),重启即恢复原状。旧插件未做任何改动。
- 注意:新旧并存期间同一轮会有多路捕获与注入(试用窗口内可接受,尽快完成切换)。

## 限制

- 决策模型不可用(网关 503 等)时该轮无召回,不兜底;网关波动已实测存在。
- 写入是异步的:Hindsight 需提取、MemOS 需后台归纳,写入成功≠立即可检索。
- 幂等仅进程内;持久化 outbox、冲突合并、跨后端事务未实现。
- SystemOne 是类型化决策模型，不生成任意文本；MemoryPilot 只让它在程序生成的已授权召回/写入候选中选择。
- Legacy 配置仍以 `backends[]` 持久化；UI 与运行时会投影为记忆系统和作用范围。显式 `workspacePath` 是包含其子目录的工作区根，仓库身份仍从真实会话 `cwd` 独立识别。
