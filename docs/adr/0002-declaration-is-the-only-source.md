# 0002 决策点声明必须是运行时唯一来源

## 状态

已接受（2026-10-29）

## 背景

`docs/adr/0001` 把决策点定为扩展单元，并承诺「用户新增判断点不需要改插件代码」。但这次审计发现承诺没有兑现：

- `src/decision-points.mjs` 只被 `src/plugin.mjs` 引用一次，且只用来加载 `command.safety` 与用户自定义点。
- 两个记忆判断点的声明**从未在运行时被加载**。真正发问的问卷是 `src/adapters.mjs` 里的私有字符串字面量。
- `retention_gate` 的判据被抄了三份（`decision-points.mjs`、`adapters.mjs` 的 `addRetentionQuestions`、`adapters.mjs` 的 `decideRetention`），三份措辞互不相同。判据是准确率的全部来源，三份漂移的判据等于三套互不知情的准确率。
- `memory.read` 声明声明了 `stateFields: ['message','residentDigest']`，而 `host.mjs` 从不传 `residentDigest`，所以即便接上线，这条判断也看不到它的判据所依赖的常驻记忆。

同时 `docs/specs/decision-layer-generalization.md` 里「DSH 没有工具调用前的钩子」这句断言已过时。`tools/pre-execute` 是官方扩展点，可 allow / deny / cancel / ask，`ctx.tools.guard()` 在其后提供单调守卫。当初选 `agent/pre-step` 是产品选择（按意图判断比逐条命令拦更省 token、更少打断），不是平台限制。

## 决定

**决策点的声明是运行时唯一来源。** 编排层不再是「知道每个判断具体问什么」的代码，而退化为通用执行器：读声明、按声明生成问卷、按声明里的落点动作表解释答案。判据文本、选项、动作映射都只存在于声明里，其它任何位置重复书写同一个问题是错误。

具体地：

1. 记忆读写判断的问卷从 `adapters.mjs` 迁入声明，`adapters.mjs` 只保留「声明 → 请求 → 答案 → 动作」的翻译。翻译层每轮**重新读**声明（`points` 传的是函数不是快照），所以改判据不用重挂运行时。实现上记忆路径用适配器当翻译器，不走通用执行器（`askPoint`）——两者读的是同一份声明，这是刻意的：通用执行器的落点机制还不足以表达「按 scope 派发到该 scope 的候选」，硬塞会变成给插件写 DSL。**判据只有一个来源**这一点两条路都必须成立，实现是否共用执行器不影响这一点。
2. 落点动作仍是封闭集合。声明可以表达「选 `route` 时按 scope 派发到该 scope 的候选」这类带参数的落点，但扩展方式限于声明已有的字段，不引入声明内的小语言。
3. 判断点的可见状态必须是插件真的会提供的字段。声明了不看得到的字段，等于判据在骗自己。
4. 第二个非记忆判断点（工具安全）从「仅提醒」升级为「可拦截」，挂到 `tools/pre-execute`，用 `approval/request` 问用户，用 `ctx.tools.guard()` 做单调兜底。

## 备选方案与未选原因

**只把判据文本搬到声明，编排逻辑留在适配器。** 改动最小，能立刻消除三份漂移，但声明仍然不是扩展单元——新增一个记忆类判断仍然要动适配器代码，`0001` 的承诺依旧没兑现。

**把落点动作也完全声明化，做到「选 A 就查 project 库」。** 最彻底，但要求声明语言能表达带参数的落点，很快会退化成给插件写一个小 DSL。不合适作为验证抽象的第一步。

**继续让适配器当唯一来源，删掉声明层。** 诚实但放弃了 `0001` 整篇的前提：用户改不了判据，只能等发版。

## 后果

**收益**：判据只存在一处，用户可编辑；新增判断点真的只写声明；三份漂移不再可能。

**代价**：编排层失去针对记忆语义的优化空间。原先可以写死「`recall_gate` 通过后才问 `scope_*`」这类知识，现在必须由声明里的依赖关系表达——而依赖关系此前是惰性的（`planStages` 读的是 `after` 字段，声明里写的是 `depends`，两者从未对上）。执行顺序因此必须真的实现，否则声明的依赖只是装饰。

**必须守住的一条**：判断点的启用与否必须可验证。一个声明存在但运行时从不加载的判断点，是一种最难发现的失效——它看起来在，实际什么都没判过。审计里那两条记忆判断点正是这么静默失效的。

## 相关

- `GLOSSARY.md`：Decision point、Declaration source、Non-memory decision point、Judged state
- `docs/adr/0001-decision-points-as-declarative-extensions.md`：本 ADR 补的是它未回答的「声明与实现如何绑定」
- `docs/agents/decision-layer.md`：迁移路径第 3 步（用最小的第二 subject 验证抽象）
- `docs/agents/decision-scope.md`：自动化档位的取舍依据
