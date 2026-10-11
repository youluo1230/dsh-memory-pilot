# MemoryPilot

面向 [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) 的决策驱动型记忆编排插件。

[English](README.md) | **简体中文**

MemoryPilot 负责判断 Agent 是否需要跨会话记忆、应查询哪个授权范围，以及哪些内容值得长期保存。它是记忆编排层，不是记忆数据库；存储身份和权限始终由服务端控制。

## 为什么需要 MemoryPilot？

记忆后端解决“如何存取”，但 Agent 仍需要一层策略来决定**何时使用记忆、查询哪里、保存什么**。MemoryPilot 在多个记忆后端和作用域之上提供统一的决策与安全边界。

典型使用场景：

- 召回仓库的技术决策、约束、失败尝试和里程碑。
- 跨工作区保留稳定的用户偏好和长期指令。
- 在同一 DSH 工作区的多个仓库之间共享指定知识。
- 将不同作用域路由到不同记忆系统。
- 对自包含任务跳过无意义的记忆检索。
- 记忆服务异常时不影响 Agent 主任务。

## 核心能力

- 使用 SystemOne 或 OpenAI 兼容 JSON 接口决定召回与保留行为。
- 支持 `global`、`workspace`、`project` 和 `personal` 作用域。
- 支持快速 `recall` 和深度 `reflect` 两种检索模式。
- 每个后端绑定独立控制读写权限。
- 注册原生 `memory_retrieve` 和 `memory_remember` Agent 工具。
- 提供 Web 配置、热更新和连接测试。
- 对延迟、输出长度和审计字段设置边界，并采用故障放行策略。

## 兼容性

| 组件 | 支持范围 | 限制 |
| --- | --- | --- |
| Node.js | `>=22` | 不支持更低版本 |
| DeepSeek Harness | `@deepseek-ai/dsh-llm` 和 `dsh-tools` `>=0.2.0-rc.2 <0.3.0` | 不代表兼容 DSH `0.3.x` |
| [Hindsight](https://github.com/vectorize-io/hindsight) | 通过标准 HTTP API 搜索、深度回顾和写入 | 每个绑定使用固定 bank；写入可能异步完成 |
| [MemOS 本地桥接](https://github.com/MemTensor/MemOS/tree/main/apps/memos-local-plugin) | 通过 `memos-local-plugin` stdio JSON-RPC 搜索和写入 | 依赖本机安装插件 |
| MemOS 本地 HTTP | 通过本地插件 Viewer API 搜索 | 只支持搜索；要求专用、隔离的实例 |
| MemOS Server / Cloud | 不支持 | Cube API 和 Cloud API 需要单独适配器 |

当前 MemOS 适配器面向 `@memtensor/memos-local-plugin`，即 Hermes、OpenClaw 和 DSH 接入共享的本地核心；不支持独立部署版 Cube API 或 MemOS Cloud API。

## 环境要求

- Node.js 22 或更高版本
- 已初始化的 DeepSeek Harness Web profile
- 一个决策模型端点：
  - SystemOne：`POST /v1/systemone`
  - OpenAI 兼容接口：`POST /v1/chat/completions`，支持 JSON mode
- 至少一个受支持的记忆后端

## 快速开始

### 1. 安装

```sh
dsh plugin --profile web add github:youluo1230/dsh-memory-pilot#v0.3.8
```

### 2. 启用

在 Web profile 的 `package.json` 中，将 `dsh-memory-pilot` 加入 `dsh.profile.bundles`：

```json
{
  "dsh": {
    "profile": {
      "bundles": ["dsh-memory-pilot"]
    }
  }
}
```

如果 profile 没有启用 `patchReload: "live"`，请重启 DSH Web。

### 3. 配置

打开 **设置 → 记忆调度（MemoryPilot）**，依次配置：

1. **决策模型**：协议、API 根地址、模型和凭据环境变量。
2. **记忆系统**：添加 Hindsight 或 MemOS 本地插件连接。
3. **使用范围**：把全局、工作区或仓库记忆绑定到指定系统。
4. **高级设置**：调整检索和后台捕获预算。
5. 启用 MemoryPilot。

配置修改会实时生效。如需使用文件配置，可从 [`examples/cordis-patch-minimal.yml`](examples/cordis-patch-minimal.yml) 开始。

### 4. 验证

在 MemoryPilot 设置页中：

- 分别运行决策模型和记忆系统的连接测试。
- 确认 MemoryPilot 显示为已启用。
- 新建会话并询问依赖历史的问题，例如“这个仓库此前为什么选择当前方案？”自包含问题不触发召回属于正常行为。

## MemOS 本地插件

使用 `memos-bridge` 前，需要安装 MemOS 官方本地插件：

```sh
curl -fsSL https://raw.githubusercontent.com/MemTensor/MemOS/main/apps/memos-local-plugin/install.sh \
  | bash -s -- --agent dsh --profile web
```

执行远程安装脚本前，请先审阅脚本。桥接器默认查找 `~/.hermes/memos-plugin`；这是历史默认路径，并不表示它只能用于 Hermes。

除非明确需要重复召回和写入，否则不要让 MemoryPilot 管理的 MemOS 捕获与其他自动 MemOS DSH 插件同时操作同一个存储。

## 工作原理

```text
会话事件
   │
   ▼
能力清单 → 决策模型 → 计划校验
   │                    │
   └── 仅授权动作 ──────┘
              │
              ▼
       有界执行与结果渲染
              │
              ▼
        不可信记忆上下文
```

1. MemoryPilot 根据服务端配置推导当前身份及其授权能力。
2. 决策模型只能在这些能力中选择动作。
3. 编排器再次校验后端、作用域、权限和写入证据。
4. 合法动作在共享时间预算内执行。
5. 召回文本经限长后以不可信上下文注入，执行元数据单独记录。

## 作用域

| 作用域 | 适用内容 |
| --- | --- |
| `global` | 稳定偏好、长期指令和跨工作区历史 |
| `workspace` | 同一 DSH 工作区内多个仓库共享的知识 |
| `project` | 当前 Git 仓库的决策、约束、尝试和里程碑 |
| `personal` | 用户私有的长期记忆 |

工作区归属由 DSH 提供；项目身份从会话 `cwd` 下最近的 Git 仓库识别。详细术语见 [`GLOSSARY.md`](GLOSSARY.md)。

## Agent 工具

- **`memory_retrieve`**：当任务缺少历史事实或决策依据时查询记忆。`auto` 模式下由 SystemOne 选择普通召回、深度回顾和相关作用域。
- **`memory_remember`**：请求保存明确的决策、稳定偏好、已验证事实或里程碑；最终是否写入以及写入哪里仍由策略决定。

不得保存凭据、隐藏推理、临时日志和未经验证的内容。

## 安全模型

- 默认拒绝：只有显式配置的绑定才会进入能力清单。
- 存储身份由服务端绑定，模型不能选择任意 scope ID、bank、namespace 或 URL。
- 读写权限独立判断。
- 写入动作必须提供当前事件中的证据。
- 召回内容按不可信数据处理，并在注入前限长。
- 非法计划、超时和后端故障会退化为不执行记忆动作。
- 凭据应通过 `decisionKeyEnv`、`keyEnv` 或 `cookieEnv` 提供，不应提交到配置文件。

## 当前限制

- 记忆写入可能异步完成，成功受理后不一定能立即检索。
- 去重仅在当前进程内生效，尚无持久化 outbox 或跨后端事务。
- MemOS HTTP 适配器只支持本地插件 Viewer 的搜索接口。
- 决策服务不可用时，本轮不使用记忆，也不会退化为无条件检索。

## 开发

```sh
pnpm install
npm test
npm run check
```

真机冒烟测试需要已配置的 DSH 宿主。环境要求见 `test/plugin-smoke.mjs` 和 `scripts/` 下的脚本。

## 许可证

[MIT](LICENSE)
