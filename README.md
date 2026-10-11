# MemoryPilot

> 面向 DeepSeek Harness 的决策驱动型记忆编排插件。

MemoryPilot 在每轮会话中判断**是否需要跨会话记忆、应查询哪些作用域、采用普通召回还是深度回顾，以及哪些内容值得长期保存**。决策模型只在服务端提供的已授权候选中做选择；后端地址、存储分区和身份边界始终由程序控制。

当前版本：`0.3.8`

## 核心能力

- **按需召回**：只有当前请求确实依赖历史信息时才查询记忆，避免无意义的上下文注入。
- **分层作用域**：支持全局、工作区、仓库和个人作用域，并由服务端解析实际身份。
- **两种检索模式**：`recall` 用于低延迟事实召回，`reflect` 用于跨历史记录的深度综合。
- **受控写入**：仅保留明确、稳定且未来仍有价值的偏好、决策、约束、里程碑和可复用结论。
- **多后端编排**：支持 Hindsight，以及 MemOS `memos-local-plugin` 的本地桥接接口。
- **可视化配置**：在 DSH Web 中管理决策模型、记忆系统、作用范围和高级参数。
- **显式工具**：向 Agent 注册 `memory_retrieve` 与 `memory_remember`，支持主动查询和保留记忆。
- **安全失败**：决策超时、响应非法或后端不可用时，本轮记忆操作会被跳过，不阻塞正常对话。

## 工作原理

```text
会话事件（message / checkpoint / turn_end）
                    │
                    ▼
┌─────────────────────────────────────────────────────┐
│ MemoryPilot Orchestrator                            │
│                                                     │
│ 事件快照 → 能力清单 → 决策模型 → 计划校验          │
│          → 预算控制与执行 → 安全渲染与审计          │
└─────────────────────────────────────────────────────┘
          │                              │
          ▼                              ▼
┌─────────────────────┐       ┌────────────────────────┐
│ 决策适配器           │       │ 记忆后端               │
│                     │       │                        │
│ SystemOne 类型化决策 │       │ Hindsight              │
│ OpenAI 兼容 JSON     │       │ MemOS local bridge     │
└─────────────────────┘       │ MemOS local HTTP*      │
                              └────────────────────────┘
```

MemoryPilot 将“做什么”和“允许做什么”分开处理：

1. 程序根据当前会话身份和配置生成能力清单。
2. 决策模型只能从清单中选择召回或写入动作。
3. 编排器再次校验每个动作的后端、作用域、权限和证据。
4. 合法动作在时间预算内执行；召回结果经过限长后以不可信上下文注入。
5. 执行结果写入审计轨迹，供排查和观测使用。

## 支持的记忆后端

| 后端类型 | 实际协议 | 能力 | 兼容范围 |
| --- | --- | --- | --- |
| [`hindsight`](https://github.com/vectorize-io/hindsight) | Hindsight HTTP API，绑定固定 bank | `search` / `deep` / `write` | 标准 Hindsight 服务 |
| [`memos-bridge`](https://github.com/MemTensor/MemOS/tree/main/apps/memos-local-plugin) | `memos-local-plugin` 的 stdio JSON-RPC | `search` / `write` | Hermes、OpenClaw 和 DSH 共用的 MemOS 本地插件；这是当前推荐的 MemOS 接入方式 |
| `memos` | `memos-local-plugin` Viewer 的 `POST /api/v1/memory/search` | `search` | 仅用于运行同一本地插件 HTTP Viewer API 的专用、隔离实例；属于兼容/旧式接入 |

### MemOS 兼容性说明

这里的两个 MemOS 适配器都是围绕 **`@memtensor/memos-local-plugin`** 实现的，并不是面向所有 MemOS 产品的通用适配器：

- `memos-bridge` 会启动插件目录中的 `dist/bridge.mjs`，调用 `core.health`、`memory.search`、`turn.start` 和 `turn.end`。它依赖本机安装好的 `memos-local-plugin`，默认目录为 `~/.hermes/memos-plugin`；目录名来自该插件的历史默认安装位置，并不意味着只能在 Hermes 中使用。
- `memos` 调用的是该本地插件 Viewer 暴露的 `POST /api/v1/memory/search`，而且目前只支持搜索。它要求操作者确认服务及其数据库是专用、隔离的，不能直接指向共享 Hub。
- MemOS 官方的**独立开源服务**使用 `/product/create_cube`、`/product/add`、`/product/search` 等 Cube API；**MemOS Cloud** 使用 `/api/openmem/v1/add/message`、`/api/openmem/v1/search/memory` 等 API。它们与上述本地插件协议不同，当前版本的 MemoryPilot **不能直接连接**。
- 如果用户安装的是 MemOS 官方 DSH 本地插件或云插件，也可以让该插件独立负责自动召回和回合写入；但这不等于它已成为 MemoryPilot 可调度的后端，两套自动记忆机制同时启用还可能造成重复召回或重复写入。

因此，只有独立部署 MemOS Server 或只持有 MemOS Cloud API Key、但没有兼容 `memos-local-plugin` 接口的用户，目前不能直接把它配置成 MemoryPilot 的 `memos` 后端。要纳入统一编排，需要另行实现对应的 `memos-server` 或 `memos-cloud` 适配器。

> Hindsight 和 MemOS 本地插件的写入均可能包含异步处理。“已受理”不代表内容已经完成提取，也不保证能够立即检索到。

## 系统要求

- Node.js `>= 22`
- 已安装并至少启动过一次的 DeepSeek Harness Web profile
- 与本插件 peer dependency 范围兼容的 DSH 版本
- 一个决策模型端点：
  - SystemOne：`POST /v1/systemone`
  - OpenAI 兼容接口：`POST /v1/chat/completions`，并支持 JSON mode
- 至少一个受支持的记忆后端

如需使用 `memos-bridge`，可按 MemOS 官方脚本安装本地插件：

```sh
curl -fsSL https://raw.githubusercontent.com/MemTensor/MemOS/main/apps/memos-local-plugin/install.sh \
  | bash -s -- --agent dsh --profile web
```

执行远程安装脚本前，请先审阅脚本内容并确认来源可信。

## 安装

### 1. 安装插件

```sh
dsh plugin --profile web add github:youluo1230/dsh-memory-pilot
```

如需锁定当前版本：

```sh
dsh plugin --profile web add github:youluo1230/dsh-memory-pilot#v0.3.8
```

### 2. 启用插件

在 Web profile 的 `package.json` 中，将插件加入 `dsh.profile.bundles`：

```json
{
  "dsh": {
    "profile": {
      "bundles": ["dsh-memory-pilot"]
    }
  }
}
```

如果 profile 启用了 `patchReload: "live"`，配置会自动重载；否则请重启 DSH Web。

### 3. 完成配置

打开 DSH Web，进入：

**设置 → 记忆调度（MemoryPilot）**

依次配置以下内容：

1. **决策模型**：协议、API 根地址、模型名称和密钥环境变量名。
2. **记忆系统**：添加 Hindsight 或 MemOS 连接，并测试连通性。
3. **使用范围**：为全局、工作区或仓库绑定记忆系统和存储分区。
4. **高级设置**：按需调整交互检索与后台捕获的时间预算。
5. 确认配置后启用 MemoryPilot。

所有可编辑字段均支持热更新，通常不需要重启插件。

也可以通过 profile 的 `cordis.patch.yml` 预置配置。最小模板见 [`examples/cordis-patch-minimal.yml`](examples/cordis-patch-minimal.yml)。包内自带的 [`cordis.patch.yml`](cordis.patch.yml) 只注册禁用状态的安全默认值，不包含端点、凭据或后端绑定。

## 凭据配置

决策模型密钥应通过环境变量提供：

```sh
export MEMORY_DECISION_API_KEY="your-api-key"
```

随后将 `decisionKeyEnv` 配置为环境变量名 `MEMORY_DECISION_API_KEY`。

后端密钥也应优先通过对应的 `keyEnv` 或 `cookieEnv` 引用。不要将 API key、Cookie 或其他凭据直接提交到配置文件和版本库。

## 作用域模型

| 作用域 | 含义 | 典型内容 |
| --- | --- | --- |
| `global` | 跨工作区共享 | 长期偏好、固定指令、项目组合信息 |
| `workspace` | 同一 DSH 工作区内共享 | 多个仓库共同使用的事实和约束 |
| `project` | 当前 Git 仓库隔离 | 技术决策、失败尝试、里程碑、仓库约束 |
| `personal` | 用户私有身份范围 | 私有且长期稳定的个人信息或偏好 |

工作区是 DSH 的管理范围，仓库则是记忆隔离范围。插件会根据会话的真实 `cwd` 识别最近的 Git 仓库；通常无需手动填写身份覆盖项。

完整术语说明见 [`GLOSSARY.md`](GLOSSARY.md)。

## Agent 工具

启用后，MemoryPilot 注册两个工具：

### `memory_retrieve`

按需查询跨会话记忆。`mode: "auto"` 会让 SystemOne 在普通召回与深度回顾之间选择，并决定应查询的作用域。

适合以下问题：

- “我们之前为什么选择这个实现？”
- “上次排查这个故障时尝试过什么？”
- “这个用户对输出格式有什么长期偏好？”

### `memory_remember`

请求长期保存一条明确的决策、偏好、已验证事实或里程碑。最终是否写入以及写入哪些作用域，仍由策略和决策模型控制。

不得用该工具保存凭据、密钥、隐藏推理、临时日志或未经验证的猜测。

## 安全设计

MemoryPilot 默认采用拒绝策略：

- 只有配置中明确授权的绑定才会出现在决策输入中。
- 读权限和写权限按绑定分别控制。
- `scopeId`、Hindsight bank 和 MemOS namespace 均由服务端确定，模型不能自行指定。
- 模型返回的计划必须通过结构、能力、权限和写入证据校验。
- 召回内容以 `trust: untrusted` 标记，并受单条长度和总长度限制。
- 决策失败、超时或计划非法时返回 `noop` 或 `timeout`，不执行兜底式跨范围检索。
- HTTP 适配器不会把第三方响应正文、请求头或凭据写入错误信息。

## 配置入口

浏览器配置页随插件发布，可从两个入口打开：

- **设置 → 记忆调度（MemoryPilot）**
- **侧栏 → 插件 → dsh-memory-pilot → 配置**

配置页将“记忆系统”和“使用范围”分开管理：记忆系统负责连接信息，使用范围负责决定某个系统及其记忆库在哪些会话身份下可读或可写。

## 开发

```sh
pnpm install
npm test
npm run check
```

- `npm test`：运行 Node.js 测试套件。
- `npm run check`：对服务端与浏览器端入口执行语法检查。

真机冒烟测试和端到端脚本需要可用的 DSH 宿主环境：

- `test/plugin-smoke.mjs`
- `scripts/e2e-live.mjs`
- `scripts/bench-decision.mjs`
- `scripts/probe-memos-write.mjs`

运行前请阅读对应脚本中的环境变量和前置条件说明。

## 项目结构

```text
src/
  plugin.mjs          DSH 插件入口、配置 schema 与运行时组装
  core.mjs            编排核心：快照、校验、预算、去重与渲染
  adapters.mjs        决策适配器与 Hindsight / MemOS 后端适配器
  registry.mjs        后端实例注册、权限过滤与能力描述
  host.mjs            DSH 生命周期、会话钩子与回合捕获
  configuration.mjs   配置归一化与工作区、仓库身份识别
  discovery.mjs       Hindsight bank 发现与创建
  settings-rpc.mjs    浏览器配置页使用的受信 RPC
  connection-test.mjs 决策模型与记忆系统连接测试
  tools.mjs           memory_retrieve / memory_remember 工具
  memos-bridge.mjs    memos-local-plugin stdio JSON-RPC 适配器
  memos-http.mjs      memos-local-plugin Viewer HTTP 搜索适配器
lib/
  client.js           DSH Web 配置界面
examples/             配置示例
test/                 单元测试、集成测试与可选宿主冒烟测试
scripts/              真机端到端、基准和诊断脚本
cordis.patch.yml       随包发布的安全默认 bundle patch
GLOSSARY.md            领域术语说明
```

## 已知限制

- 决策模型不可用时，本轮不会自动召回记忆，也不会降级为无条件搜索。
- 后端写入通常是异步操作，成功受理不等于立即可检索。
- 去重状态目前仅存在于当前进程；尚未实现持久化 outbox、跨进程幂等和跨后端事务。
- 当前 MemOS HTTP 后端只兼容 `memos-local-plugin` Viewer 的搜索接口，不兼容 MemOS 独立服务的 Cube API 或 MemOS Cloud API；并且只适用于明确隔离的实例。
- `workspacePath` 表示包含其子目录的工作区根路径；仓库身份仍根据会话 `cwd` 独立识别。

## 常见问题

### 安装时报 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`

pnpm 可能启用了依赖发布冷却期。只要 profile 锁文件中的任意依赖版本过新，插件安装就可能被整体拒绝。

可以对本次安装临时关闭冷却期：

```sh
dsh plugin --profile web add github:youluo1230/dsh-memory-pilot \
  --config.minimum-release-age=0
```

或者安装一个已经发布足够久的固定版本：

```sh
dsh plugin --profile web add github:youluo1230/dsh-memory-pilot#v0.3.8
```

临时关闭冷却期会降低这一次安装的供应链保护强度。安装完成后应恢复原策略；如需长期豁免，建议只将确认可信的具体包加入 `minimumReleaseAgeExclude`。

### 配置后没有触发记忆召回

依次检查：

1. 插件是否已启用。
2. 当前会话 `cwd` 是否位于已注册的 DSH 工作区内。
3. 决策模型地址和模型名是否完整，并且连接测试通过。
4. 当前身份是否匹配至少一个具有读取权限的作用域绑定。
5. 当前请求是否真的依赖缺失的跨会话信息；自包含任务不会触发召回。

### 写入成功后为什么立即搜索不到？

Hindsight 需要异步提取，MemOS 也可能在后台归纳完整回合。请等待后端处理完成后再检索；MemoryPilot 的“写入成功”只表示后端已经接受请求。

## 卸载

```sh
dsh plugin --profile web remove dsh-memory-pilot
```

随后从 `dsh.profile.bundles` 中移除 `"dsh-memory-pilot"`。如果 profile 未启用热重载，请重启 DSH Web。

## License

[MIT](LICENSE)
