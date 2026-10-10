# MemoryPilot — 智能记忆调度

决策模型驱动的统一记忆编排插件(0.1.0)。决策模型在每轮选择是否召回、查哪个后端、查多深、何时写入;程序只负责授权、能力校验、预算和审计。

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
npm test                     # 67 项单元测试(全部通过)
npm run check
node scripts/e2e-live.mjs    # 真机端到端:8/8 通过(决策/Hindsight 读写/MemOS bridge 读写/全链路)
node scripts/bench-decision.mjs  # 决策模型基准
```

E2E 实测(2026-10-10):决策 2.6s;Hindsight 项目/全局召回 1.4/3.3s;MemOS bridge 搜索 3.4s;Hindsight 写入→回流 ~10s;MemOS 回合捕获 11.6s;完整 orchestrator status=ok。

## 配置面板（0.2.12）

浏览器端配置页随包分发（`lib/client.js`、`dsh.client` 声明），挂在两处：

- **设置 → 左侧导航「MemoryPilot 记忆调度」**：按任务分成「决策模型 / 记忆系统 / 使用范围 / 高级设置」四个页签。
- **侧栏「插件」→ dsh-memory-pilot 行的「配置」按钮**：打开同一配置页。

记忆系统与作用范围分开管理：系统卡片只显示连接摘要，连接细节在编辑弹窗中维护。使用范围页以可筛选表格展示全局、工作区和仓库绑定，包括范围标识、记忆系统、bank、读写权限及编辑/删除操作。普通界面不暴露 `scopeId`。工作区是管理范围，Git 仓库是记忆隔离范围；默认从会话 `cwd` 自动识别，只有需要时才填写 override。

回环访问使用宿主 `configForms`；受信任的远程访问使用专用、鉴权的 MemoryPilot connection RPC，并保留 revision fencing 和服务端字段白名单。设置导航会立即注册，不再受配置 namespace 的服务时序影响。

## 安装(已完成于本 profile)

```sh
npm pack
cd /root/.dsh/profiles/web && pnpm add file:/vol1/1000/code/dsh-memory-pilot/dsh-memory-pilot-0.2.0.tgz
# package.json 的 dsh.profile.bundles 加入 "dsh-memory-pilot"
# 重启 DSH web 生效(dsh-bridge 辅助进程托管,约 3-7s)
```

验证插件可加载:`import('dsh-memory-pilot/plugin')` 并 `apply()`——生产配置已离线验证通过(4 个钩子注册,无网络调用)。

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
