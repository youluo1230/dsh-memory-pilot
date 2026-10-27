import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');

function loadClient() {
  let definition;
  const context = {
    window: { __ModuleLoader__: { load(value) { definition = value; } } },
    console,
  };
  vm.runInNewContext(source, context);
  const fakeReact = { createElement() {}, useState() {}, useEffect() {} };
  return definition.factory((id) => id === 'react' ? fakeReact : { jsx() {} });
}

test('the trajectory row renders one decision trail entry with its questionnaire', () => {
  const client = loadClient();
  // The Trajectory row now reads the Host projection (src/trail.mjs) instead of a
  // `plugin/observation` session event, because DSH's persistence path refuses
  // unknown event types — the reason those rows silently disappeared (issue #1).
  const text = client.trailText({
    id: 's:3:1:retrieval', turn: 3, step: 1, question: '帮我看看记忆插件',
    kind: 'retrieval', status: 'ok', totalDurationMs: 1234, protocol: 'systemone',
    model: 'clef-flash', decisionDurationMs: 250,
    questions: ['recall_gate', 'scope_global'],
    answers: [{ name: 'recall_gate', choice: 'memory', confidence: 0.7 }, { name: 'scope_global', choice: 'query', confidence: 0.85 }],
    actions: [{ backend: 'memos-global', scope: 'global', operation: 'search' }],
    executions: [{ backend: 'memos-global', scope: 'global', operation: 'search', status: 'ok', hitCount: 2, durationMs: 900 }],
    injectedChars: 2048,
  });
  // What the user asked, which is the whole point of the row.
  assert.match(text, /问题：帮我看看记忆插件/);
  // Which decision model ran and what it was asked, with the chosen levels.
  assert.match(text, /systemone\/clef-flash/);
  assert.match(text, /recall_gate → memory \(70%\)/);
  assert.match(text, /scope_global → query \(85%\)/);
  // What was authorized and what actually happened.
  assert.match(text, /已授权动作/);
  assert.match(text, /global · memos-global · search/);
  assert.match(text, /2 命中/);
  assert.match(text, /2,048 字符/);
  assert.equal(client.TRAIL_KEY, 'memoryPilotTrail');
});

test('a noop decision explains itself instead of showing an empty action list', () => {
  const client = loadClient();
  const text = client.trailText({
    id: 's:1:1:retrieval', turn: 1, step: 1, question: '你好', status: 'noop',
    kind: 'retrieval', protocol: 'systemone', model: 'clef-flash',
    totalDurationMs: 10, decisionDurationMs: 5, injectedChars: 0,
    answers: [{ name: 'recall_gate', choice: 'none', confidence: 0.9 }],
    actions: [], executions: [],
  });
  assert.match(text, /无需记忆/);
  assert.match(text, /模型判定无需记忆操作/);
  assert.match(text, /recall_gate → none/);
});

test('noop trajectory marks subordinate answers inactive instead of implying recall ran', () => {
  const client = loadClient();
  const detail = client.memoryObservationDetail({ kind: 'retrieval', status: 'noop', totalDurationMs: 10,
    candidates: [{ scope: 'global', engine: 'memos', operations: ['search'], store: { display: 'MemOS shared store' } }],
    decision: { protocol: 'systemone', model: 'clef-flash', durationMs: 5, answers: { recall_gate: { choice: 'none' }, retrieval_mode: { choice: 'recall' }, scope_global: { choice: 'skip' } } },
    plan: { actions: [] }, executions: [], injection: { sourceCount: 0, contextChars: 0, truncated: false } });
  assert.match(detail, /recall_gate: none/);
  assert.match(detail, /retrieval_mode: recall \(inactive; recall gate chose none\)/);
  assert.match(detail, /Selected scopes: none/);
});

test('resident memory public document contract names all editable targets and maintenance policies', () => {
  const { residentDocumentOptions } = loadClient();
  const documents = residentDocumentOptions({
    soul: { content: '# Soul', revision: 's1', path: '/home/SOUL.md', writable: true },
    user: { content: '# User', revision: 'u1', path: '/home/USER.md', writable: true, managed: true },
    globalMemory: { content: '# Memory', revision: 'g1', path: '/home/MEMORY.md', writable: true, managed: true },
    projectMemory: { content: '# Project', revision: 'p1', path: '/repo/MEMORY.md', writable: false },
  });

  assert.deepEqual(Array.from(documents, item => item.target), ['soul', 'user', 'global-memory', 'project-memory']);
  assert.deepEqual(Array.from(documents, item => item.label), ['SOUL', 'USER', '全局 MEMORY', '项目 MEMORY']);
  assert.equal(documents[0].manualOnly, true);
  assert.equal(documents[1].manualOnly, false);
  assert.equal(documents[2].document.revision, 'g1');
  assert.equal(documents[3].document.writable, false);
});

test('resident memory tab DOM contract explains lifecycle and controlled maintenance', () => {
  assert.match(source, /\["resident",\s*"常驻记忆"\]/);
  assert.match(source, /SOUL 只能人工修改/);
  assert.match(source, /修改将在新会话中生效/);
  assert.match(source, /USER\/MEMORY 可人工修改，也可由受控自动维护/);
  assert.match(source, /"aria-label":\s*"常驻记忆文档"/);
  assert.match(source, /className:\s*"mp-resident-editor"/);
  assert.match(source, /withTimeout\(form\.residentGet\(projectPath\)/);
  assert.match(source, /withTimeout\(form\.residentPut\(selected\.target, residentContent, selected\.document\.revision/);
  assert.match(source, /项目 MEMORY 所属仓库/);
  assert.match(source, /active === "scope" \|\| active === "resident"/);
  assert.match(source, /读取失败，请重试/);
  assert.match(source, /withTimeout\(form\.residentGet/);
  assert.match(source, /未发现可用的 Git 仓库/);
  assert.match(source, /selected\.target !== "project-memory" \|\| selectedResidentPath/);
});

test('configuration page exposes the required horizontal tabs and DSH-token CSS', () => {
  assert.match(source, /\["decision",\s*"决策模型"\]/);
  assert.match(source, /\["systems",\s*"记忆系统"\]/);
  assert.match(source, /\["scope",\s*"使用范围"\]/);
  assert.match(source, /\["resident",\s*"常驻记忆"\]/);
  assert.match(source, /\["advanced",\s*"高级设置"\]/);
  assert.match(source, /max-width:\s*820px/);
  assert.match(source, /var\(--dsw-alias-border-l2\)/);
  assert.match(source, /role:\s*"tablist"/);
  assert.match(source, /decisionProtocol/);
  assert.match(source, /SystemOne/);
});

test('legacy backends project to deduplicated systems and scoped routes then round-trip', () => {
  const client = loadClient();
  const input = [
    { id: 'shared', type: 'hindsight', baseUrl: 'http://h', bank: 'project-bank', scope: 'project', scopeId: 'repo', read: true, write: true },
    { id: 'shared', type: 'hindsight', baseUrl: 'http://h', bank: 'global-bank', scope: 'global', scopeId: 'global', read: true, write: false },
  ];
  const view = client.projectBackends(input);
  assert.equal(view.systems.length, 1);
  assert.equal(view.routes.length, 2);
  assert.deepEqual(Array.from(view.routes, route => route.scope), ['project', 'global']);
  const output = client.flattenBackends(view.systems, view.routes, { projectId: 'repo', workspaceId: '' });
  assert.equal(output.length, 2);
  assert.equal(output[0].scopeId, 'repo');
  assert.equal(output[1].scopeId, 'global');

  const automatic = client.flattenBackends(view.systems, [{ ...view.routes[0], legacyScopeId: '' }], {
    projectId: '', workspaceId: '', workspacePath: '', actorId: '',
  });
  assert.equal(automatic[0].scopeId, '*', 'an automatic project route must remain usable before a session cwd is known');
});

test('system editor presents Hindsight, MemOS, and legacy bridge through one connection model', () => {
  const { systemEditorView } = loadClient();
  const fields = ['name', 'id', 'type', 'baseUrl', 'keyEnv', 'apiKey'];
  assert.deepEqual(Array.from(systemEditorView({ type: 'hindsight' }).fields), fields);
  assert.deepEqual(Array.from(systemEditorView({ type: 'memos' }).fields), fields);
  assert.deepEqual(Array.from(systemEditorView({ type: 'memos-bridge' }).fields), fields);
  assert.equal(systemEditorView({ type: 'memos-bridge' }).displayType, 'memos');
});

test('legacy bridge running fields survive an unchanged UI projection and save', () => {
  const client = loadClient();
  const legacy = { id: 'legacy', type: 'memos-bridge', home: '/hermes', agent: 'Hermes', cookieEnv: 'COOKIE', isolatedStore: true, scope: 'global', scopeId: 'global' };
  const view = client.projectBackends([legacy]);
  const [saved] = client.flattenBackends(view.systems, view.routes, {});
  assert.equal(saved.type, 'memos-bridge');
  assert.equal(saved.home, '/hermes');
  assert.equal(saved.agent, 'Hermes');
  assert.equal(saved.cookieEnv, 'COOKIE');
  assert.equal(saved.isolatedStore, true);
});

test('memory system summary uses baseUrl and identifies an unmigrated legacy MemOS connection', () => {
  const { systemConnectionSummary } = loadClient();
  assert.equal(systemConnectionSummary({ type: 'hindsight', baseUrl: 'http://hindsight' }), 'http://hindsight');
  assert.equal(systemConnectionSummary({ type: 'memos-bridge', baseUrl: 'http://memos' }), 'http://memos');
  assert.equal(systemConnectionSummary({ type: 'memos-bridge', home: '/custom/home' }), '旧版 MemOS 连接（待迁移）');
  assert.equal(systemConnectionSummary({ type: 'memos-bridge' }), '旧版 MemOS 连接（待迁移）');
});

test('system modal DOM contract exposes only service connection fields and two product types', () => {
  assert.match(source, /\[\["hindsight", "Hindsight"\], \["memos", "MemOS"\]\]/);
  assert.doesNotMatch(source, /\["memos-bridge", "MemOS Bridge"\]/);
  for (const label of ['名称', '系统标识', '类型', '地址 (baseUrl)', '密钥']) assert.match(source, new RegExp(label.replace(/[()]/g, '\\$&')));
  // Credentials are one field: users should not have to know what an env var is.
  for (const label of ['本地目录 (home)', 'Cookie 环境变量', '显示兼容设置', '密钥环境变量', 'API Key（不建议明文）']) assert.doesNotMatch(source, new RegExp(label.replace(/[()]/g, '\\$&')));
  assert.match(source, /连接服务实例，可访问该连接有权查看的全部记忆库/);
});

test('decision tab asks for one key and never mentions environment variables', () => {
  const decision = source.slice(source.indexOf('if (active === "decision")'), source.indexOf('if (active === "systems")'));
  assert.match(decision, /h\(Field, \{ label: "密钥"/);
  assert.doesNotMatch(decision, /密钥环境变量/);
  assert.doesNotMatch(decision, /环境变量优先/);
  assert.doesNotMatch(decision, /MEMORY_DECISION_API_KEY/);
  // The field still writes the literal key the runtime resolves.
  assert.match(decision, /onChange: set\("decisionApiKey"\)/);
  assert.match(decision, /type: "password"/);
});

test('ordinary UI never renders a scopeId field and supports automatic identity overrides', () => {
  assert.doesNotMatch(source, /label:\s*t\("scopeId"\)/);
  assert.match(source, /自动识别/);
  assert.match(source, /projectId/);
  assert.match(source, /workspaceId/);
  assert.match(source, /workspacePath/);
});

test('filterRoutes searches route identity, system name/id, and bank through the client interface', () => {
  const { filterRoutes } = loadClient();
  const rows = [
    { id: 'project-route', scope: 'project', legacyScopeId: 'alpha-repo', systemId: 'hindsight-main', systemName: '团队记忆', bank: 'coding-bank' },
    { id: 'workspace-route', scope: 'workspace', legacyScopeId: '', systemId: 'memos-shared', systemName: '共享 MemOS', bank: 'team-bank' },
    { id: 'global-route', scope: 'global', legacyScopeId: 'global', systemId: 'archive', systemName: 'Archive', bank: 'history' },
  ];

  assert.deepEqual(Array.from(filterRoutes(rows, { query: 'ALPHA' }), row => row.id), ['project-route']);
  assert.deepEqual(Array.from(filterRoutes(rows, { query: '共享 memos' }), row => row.id), ['workspace-route']);
  assert.deepEqual(Array.from(filterRoutes(rows, { query: 'coding-bank' }), row => row.id), ['project-route']);
  assert.deepEqual(Array.from(filterRoutes(rows, { query: 'archive' }), row => row.id), ['global-route']);
});

test('scope tab renders separate global and workspace tables without route-management UI', () => {
  const scopeRender = source.slice(source.indexOf('if (active === "scope") {'), source.indexOf('if (active === "advanced")'));

  assert.match(source, /function RouteModal/, 'legacy route code remains available for configuration compatibility');
  for (const removedLabel of ['现有绑定', '添加绑定', '搜索绑定']) assert.doesNotMatch(scopeRender, new RegExp(removedLabel));
  assert.doesNotMatch(scopeRender, /mp-route-filters/);
  assert.doesNotMatch(scopeRender, /setEditingRoute|removeRoute/);

  assert.match(scopeRender, /h\("h2", null, "全局"\)/);
  assert.match(scopeRender, /"aria-label": "全局绑定"/);
  assert.match(scopeRender, /h\("h2", null, "工作区与仓库"\)/);
  assert.equal((scopeRender.match(/h\("table", \{ className: "mp-table" \}/g) || []).length, 2);
  assert.equal((scopeRender.match(/\["范围", "记忆系统", "库\/bank", "权限", "状态", "操作"\]/g) || []).length, 2);
  assert.match(scopeRender, /"未配置"/);
  assert.match(source, /overflow-x:auto/);
});

test('scope override helpers upsert by scope identity and restore automatic selection', () => {
  const { upsertScopeOverride, removeScopeOverride } = loadClient();
  const original = [
    { scope: 'workspace', scopeId: 'one', enabled: false, systemId: 'old' },
    { scope: 'project', scopeId: 'repo', enabled: true, systemId: 'hs', bank: 'old-bank' },
  ];
  const replacement = { scope: 'workspace', scopeId: 'one', enabled: true, systemId: 'memos' };
  const updated = upsertScopeOverride(original, replacement);
  assert.deepEqual(JSON.parse(JSON.stringify(updated)), [replacement, original[1]]);
  assert.deepEqual(JSON.parse(JSON.stringify(removeScopeOverride(updated, 'project', 'repo'))), [replacement]);
  assert.deepEqual(JSON.parse(JSON.stringify(original)), [
    { scope: 'workspace', scopeId: 'one', enabled: false, systemId: 'old' },
    { scope: 'project', scopeId: 'repo', enabled: true, systemId: 'hs', bank: 'old-bank' },
  ], 'scope override updates do not mutate the draft source');
});

test('scope discovery separates global bindings and projects workspace and single-target repositories inline', () => {
  const { scopeDiscoveryProjection } = loadClient();
  const value = {
    workspacePath: 'code',
    globalBindings: [{ systemId: 'shared', type: 'hindsight', bank: 'global-bank', read: true, write: false }],
    workspaceTargets: [{ systemId: 'hs', bank: 'coding-code', read: true, write: true, exists: true }],
    repositories: [{ path: 'alpha', id: 'alpha', targetBanks: [{ systemId: 'hs', bank: 'coding-alpha', read: true, write: true, exists: false }] }],
    banks: [{ systemId: 'hs', bank: 'coding-alpha', matched: true }, { systemId: 'hs', bank: 'old', matched: false }],
  };
  const projected = scopeDiscoveryProjection(value, { workspace: true, 'other-banks': true });
  assert.deepEqual(Array.from(projected.globalBindings, row => row.kind), ['global-binding']);
  assert.equal(projected.globalBindings[0].bank, 'global-bank');
  assert.deepEqual(Array.from(projected.rows, row => row.kind), ['workspace', 'repository']);
  assert.equal(projected.rows[0].bank, 'coding-code', 'workspace target is shown on the workspace root row');
  assert.equal(projected.rows[1].bank, 'coding-alpha', 'single repository target is shown on the repository row');
  assert.equal(projected.rows[1].exists, false);
  assert.ok(!projected.rows.some(row => row.label === '工作区默认'));
  for (const label of ['记忆系统', '状态', '连接失败', '检测中']) assert.match(source, new RegExp(label));
  assert.doesNotMatch(source.slice(source.indexOf('function scopeDiscoveryProjection'), source.indexOf('function scopeDiscoveryRows')), /其他已有库/);
});

test('new discovery shape projects independently expandable workspaces with collision-safe repository keys', () => {
  const { scopeDiscoveryProjection } = loadClient();
  const value = {
    workspaces: [
      {
        id: 'one', title: 'Workspace One', path: 'fallback-one',
        targets: [{ systemId: 'hs', bank: 'workspace-one', exists: true }],
        repositories: [{ path: 'shared', id: 'repo-one', targetBanks: [{ systemId: 'hs', bank: 'repo-one', exists: true }] }],
      },
      {
        id: 'two', title: '', path: 'Workspace Two',
        targets: [{ systemId: 'hs', bank: 'workspace-two-a', exists: true }, { systemId: 'archive', bank: 'workspace-two-b', exists: false }],
        repositories: [{ path: 'shared', id: 'repo-two', targetBanks: [{ systemId: 'hs', bank: 'repo-two', exists: false }] }],
      },
    ],
    banks: [
      { systemId: 'hs', bank: 'workspace-one', matched: true },
      { systemId: 'hs', bank: 'unmatched', matched: false },
      { systemId: 'archive', bank: 'also-unmatched', matched: false },
    ],
  };

  const collapsed = scopeDiscoveryProjection(value, {});
  assert.deepEqual(Array.from(collapsed.rows, row => row.key), ['workspace:one', 'workspace:two']);
  assert.deepEqual(Array.from(collapsed.rows, row => row.label), ['Workspace One', 'Workspace Two']);
  assert.equal(collapsed.rows[0].bank, 'workspace-one', 'a single workspace target is inline');
  assert.equal(collapsed.rows[1].bank, undefined, 'multiple workspace targets are not merged into a synthetic cell');
  assert.ok(collapsed.rows.slice(0, 2).every(row => row.expandable), 'every workspace can expand independently');

  const expanded = scopeDiscoveryProjection(value, { 'workspace:one': true, 'workspace:two': true, 'other-banks': true }).rows;
  assert.deepEqual(Array.from(expanded, row => row.kind), ['workspace', 'repository', 'workspace', 'target', 'target', 'repository']);
  assert.deepEqual(Array.from(expanded.filter(row => row.kind === 'target'), row => row.bank), ['workspace-two-a', 'workspace-two-b']);
  assert.deepEqual(Array.from(expanded.filter(row => row.kind === 'repository'), row => row.key), ['repo:one:shared', 'repo:two:shared']);
  assert.ok(!expanded.some(row => row.kind === 'bank' || row.kind === 'other'), 'service bank inventory is not projected as scope rows');
  assert.doesNotMatch(source, /useState\(\{ workspace: true \}\)/, 'initial expansion must not assume a single workspace');
});

test('multi-target repositories retain one expandable target level', () => {
  const { scopeDiscoveryProjection } = loadClient();
  const value = { workspacePath: 'code', repositories: [{ path: 'alpha', id: 'alpha', targetBanks: [
    { systemId: 'hs-1', bank: 'one', exists: true }, { systemId: 'hs-2', bank: 'two', exists: true },
  ] }] };
  const collapsed = scopeDiscoveryProjection(value, { workspace: true }).rows;
  assert.deepEqual(Array.from(collapsed, row => row.kind), ['workspace', 'repository']);
  assert.equal(collapsed[1].expandable, true);
  const expanded = scopeDiscoveryProjection(value, { workspace: true, 'repo:alpha': true }).rows;
  assert.deepEqual(Array.from(expanded, row => row.kind), ['workspace', 'repository', 'target', 'target']);
});

test('scope editing UI uses one override modal for global, workspace, and repository rows', () => {
  const scopeRender = source.slice(source.indexOf('if (active === "scope") {'), source.indexOf('if (active === "advanced")'));
  assert.match(source, /编辑记忆范围/);
  assert.match(source, /启用本地记忆/);
  assert.match(source, /恢复自动/);
  assert.match(scopeRender, /"编辑"/);
  assert.match(source, /scopeOverrides/);
  assert.match(source, /autoBank/);
  assert.match(source, /type/);
  assert.match(source, /discovery\.value\?\.banks/);
  assert.match(source, /system\?\.type === "hindsight"/);
});

test('filterRoutes combines scope and system filters and preserves source rows', () => {
  const { filterRoutes } = loadClient();
  const rows = [
    { id: 'one', scope: 'project', systemId: 'hindsight-main', systemName: 'Hindsight', bank: 'alpha' },
    { id: 'two', scope: 'workspace', systemId: 'hindsight-main', systemName: 'Hindsight', bank: 'beta' },
    { id: 'three', scope: 'project', systemId: 'memos', systemName: 'MemOS', bank: 'alpha' },
  ];

  const filtered = filterRoutes(rows, { query: 'alpha', scope: 'project', systemId: 'memos' });
  assert.deepEqual(Array.from(filtered, row => row.id), ['three']);
  assert.equal(rows.length, 3);
  assert.deepEqual(Array.from(filterRoutes(rows, { scope: 'all', systemId: 'all' }), row => row.id), ['one', 'two', 'three']);
});

test('systems and scope tabs expose delete actions that remove systems, routes, and overrides', () => {
  // Source-level guards: the systems tab renders a delete button wired to
  // removeSystem, and removeSystem drops the system plus its routes.
  const systemsRender = source.slice(source.indexOf('if (active === "systems")'), source.indexOf('if (active === "scope")'));
  assert.match(systemsRender, /"删除"/);
  assert.match(source, /removeSystem = id =>/);
  assert.match(source, /systems: current\.systems\.filter\(item => item\.id !== id\)/);
  assert.match(source, /routes: current\.routes\.filter\(route => route\.systemId !== id\)/);
  // The scope tab renders delete for concrete bindings and drops overrides + routes.
  const scopeRender = source.slice(source.indexOf('if (active === "scope") {'), source.indexOf('if (active === "resident")'));
  assert.match(scopeRender, /"删除"/);
  assert.match(scopeRender, /removeScopeOverride\(current\.scopeOverrides/);
  assert.match(scopeRender, /routes: current\.routes\.filter/);
});

test('resident tab reloads when a dependency changes mid-flight instead of deadlocking', () => {
  // Regression: the effect early-returned unless status === 'idle', so a
  // discovery-driven re-render during the fetch (live=false) deadlocked the tab
  // on 永久"等待读取文档…" — the resident effect must re-issue while loading.
  const residentEffect = source.slice(source.indexOf('const [resident, setResident]'), source.indexOf('if (snap.status !== "ready" || !draft)'));
  assert.match(residentEffect, /resident\.status === "ready" \|\| resident\.status === "empty" \|\| resident\.status === "failed"/);
  assert.doesNotMatch(residentEffect, /resident\.status !== "idle"/);
});

test('decision panel exposes the decision-model switch and reflects autonomous mode', () => {
  // The switch must be reachable from the UI (not only the YAML), and the
  // summary must show "自主判断" when it is off.
  assert.match(source, /decisionEnabled/);
  assert.match(source, /使用决策模型/);
  assert.match(source, /自主判断/);
  // Field must be part of the scalar save list, or toggling it never persists.
  assert.match(source, /const SCALAR_FIELDS = \["enabled", "decisionEnabled"/);
});

test('the trajectory definition anchors a decision to its step and skips steps without one', () => {
  const client = loadClient();
  // Build the definition the way `apply` does, against a minimal fake of the
  // services it touches: one Session carrying a trail projection.
  let registered;
  const entries = [{ id: 'e1', turn: 2, step: 1, question: '帮我查记忆', status: 'ok',
    protocol: 'systemone', model: 'clef-flash', decisionDurationMs: 10, totalDurationMs: 20,
    answers: [], actions: [], executions: [], injectedChars: 0 }];
  const face = { getSnapshot: () => ({ entries }), subscribe: () => () => {} };
  const ctx = {
    locale: { bind: () => () => '', register: () => () => {} },
    effect: body => { body(); return () => {}; },
    slots: { inject: () => () => {}, register: () => () => {} },
    configForms: { get: () => ({ getSnapshot: () => ({}), subscribe: () => () => {}, mutate: () => {} }), whileServed: () => () => {} },
    connection: { isLoopback: false, rpc: { call: async () => ({ ok: true }) } },
    uiConversation: { events: { register: definition => { registered = definition; return () => {}; } } },
    sessions: {
      list: { getSnapshot: () => ({ ids: ['s1'] }) },
      binding: id => id === 's1' ? { session: { projections: { faceOf: () => face } } } : undefined,
    },
  };
  client.apply(ctx);
  assert.ok(registered, 'the trajectory definition must be registered');
  assert.equal(registered.target, 'trajectory');

  // A step that carries a decision yields a context cell carrying its text.
  const match = registered.match({ type: 'step/start', seq: 42, time: 1000, data: { turn: 2, step: 1 } });
  // Field-by-field: the definition lives in the vm realm, so deepEqual's
  // prototype check would fail on otherwise identical plain objects.
  assert.equal(match.id, 'mp:2:1');
  assert.equal(match.role, 'update');
  const state = registered.start({}, { event: { type: 'step/start', seq: 42, time: 1000, data: { turn: 2, step: 1 } }, location: { kind: 'unresolved' } });
  const node = registered.buildViewNode({ key: 'k', kind: 'memory-pilot-decision', id: 'mp:2:1', state,
    start: { location: { kind: 'unresolved' } } });
  assert.equal(node.target, 'trajectory');
  assert.equal(node.anchorSeq, 42);
  assert.equal(node.data.kind, 'node');
  assert.equal(node.data.node.kind, 'context');
  assert.match(node.data.node.content[0].text, /帮我查记忆/);

  // A step with no recorded decision produces no row, so ordinary steps stay clean.
  const plain = registered.start({}, { event: { type: 'step/start', seq: 43, time: 1001, data: { turn: 9, step: 1 } }, location: { kind: 'unresolved' } });
  assert.equal(registered.buildViewNode({ key: 'k2', kind: 'memory-pilot-decision', id: 'mp:9:1', state: plain,
    start: { location: { kind: 'unresolved' } } }), null);

  // Only step starts are anchors; a stray event must not claim the target.
  assert.equal(registered.match({ type: 'assistant/message', seq: 44, data: {} }), null);
});
