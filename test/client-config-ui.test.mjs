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

test('client projects model-hidden MemoryPilot observations into the trajectory target', () => {
  const client = loadClient();
  const trace = {
    schemaVersion: 1, kind: 'retrieval', status: 'ok', totalDurationMs: 1234,
    candidates: [{ backendId: 'memos-global', engine: 'memos', adapter: 'memos-bridge', scope: 'global', operations: ['search'], store: { kind: 'shared-hub', display: 'MemOS shared store' } }],
    decision: { protocol: 'systemone', model: 'clef-flash', durationMs: 250, questionNames: ['recall_gate'], answers: { recall_gate: { choice: 'memory' } } },
    plan: { validation: 'accepted', actions: [{ backendId: 'memos-global', scope: 'global', operation: 'search' }] },
    executions: [{ backendId: 'memos-global', engine: 'memos', adapter: 'memos-bridge', scope: 'global', operation: 'search', store: { kind: 'shared-hub', display: 'MemOS shared store' }, response: { status: 'ok', hitCount: 2 }, durationMs: 900 }],
    injection: { sourceCount: 1, contextChars: 2048, truncated: false },
  };
  const node = client.memoryObservationNode({ type: 'plugin/observation', seq: 7, time: 1000, data: { plugin: 'dsh-memory-pilot', kind: 'retrieval', version: 1, turn: 1, summary: 'MemoryPilot ok', data: trace } });
  assert.equal(node.kind, 'context');
  assert.equal(node.seq, 7);
  const detail = node.content[0].text;
  assert.match(detail, /SystemOne \/ clef-flash/);
  assert.match(detail, /global.*MemOS shared store/i);
  assert.match(detail, /Selected scopes: global/);
  assert.match(detail, /Skipped scopes: none/);
  assert.match(detail, /2 hits/);
  assert.match(detail, /2,048 chars/);
  assert.match(detail, /Authorized candidates \(available for selection; not necessarily executed\)/);
  assert.match(detail, /pre-request automatic memory only/);
  assert.equal(detail.includes('memory result body'), false);
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
  for (const label of ['名称', '系统标识', '类型', '地址 (baseUrl)', '密钥环境变量', 'API Key（不建议明文）']) assert.match(source, new RegExp(label.replace(/[()]/g, '\\$&')));
  for (const label of ['本地目录 (home)', 'Cookie 环境变量', '显示兼容设置']) assert.doesNotMatch(source, new RegExp(label.replace(/[()]/g, '\\$&')));
  assert.match(source, /连接服务实例，可访问该连接有权查看的全部记忆库/);
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
