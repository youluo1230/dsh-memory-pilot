// MemoryPilot browser configuration. This file is shipped directly to the DSH
// module loader, so it intentionally uses React.createElement and needs no build.
window.__ModuleLoader__.load({
  id: "dsh-memory-pilot",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require("react");
    const h = React.createElement;

    const NS = "dsh-memory-pilot-ui";
    const ENTRY = "dsh-memory-pilot";
    const ROW_KEY = "dsh-memory-pilot#dsh-memory-pilot";
    const SETTINGS_RPC_CHANNEL = "/dsh-memory-pilot-settings";
    const SCALAR_FIELDS = ["enabled", "decisionEnabled", "workspacePath", "projectId", "actorId", "workspaceId",
      "decisionProtocol", "decisionBaseUrl", "decisionModel", "decisionKeyEnv", "budgetMs", "captureBudgetMs"];
    // The labels are intentionally literals: settings remain understandable even
    // while the locale service is starting, and tests guard the required IA.
    const TABS = [["decision", "决策模型"], ["systems", "记忆系统"], ["scope", "使用范围"], ["resident", "常驻记忆"], ["advanced", "高级设置"]];
    const SYSTEM_FIELDS = ["id", "type", "baseUrl", "home", "agent", "keyEnv", "apiKey", "cookieEnv", "isolatedStore"];
    const number = value => Number.isFinite(value) ? new Intl.NumberFormat().format(Math.max(0, Math.round(value))) : "—";
    const seconds = value => Number.isFinite(value) ? `${(Math.max(0, value) / 1000).toFixed(value >= 1000 ? 1 : 3)}s` : "—";
    function memoryObservationDetail(trace) {
      const decision = trace?.decision || {};
      const gateClosed = trace?.kind === "retrieval" && decision.answers?.recall_gate?.choice === "none";
      const answers = Object.entries(decision.answers || {}).map(([name, answer]) => {
        const inactive = gateClosed && name !== "recall_gate" ? " (inactive; recall gate chose none)" : "";
        return `${name}: ${answer.choice}${inactive}`;
      }).join("\n");
      const candidates = (trace?.candidates || []).map(row => `${row.scope}: ${row.engine}${row.adapter ? ` / ${row.adapter}` : ""} · ${row.store?.display || "default store"} · ${(row.operations || []).join(", ")}`).join("\n");
      const executions = (trace?.executions || []).map(row => {
        const response = row.response || {};
        const hitDetail = Number.isFinite(response.explicitFactCount)
          ? `${number(response.hitCount)} hits (${number(response.explicitFactCount)} explicit facts + ${number(response.semanticHitCount)} semantic)`
          : `${number(response.hitCount)} hits`;
        const durability = row.operation === "write" ? ` · durable ${response.durable === true ? "yes" : "pending/unknown"}` : "";
        return `${row.scope}: ${row.engine}${row.adapter ? ` / ${row.adapter}` : ""} · ${row.store?.display || "default store"} · ${row.operation} · ${response.status || "unknown"} · ${hitDetail}${durability} · ${seconds(row.durationMs)}`;
      }).join("\n");
      const selectedScopes = new Set((trace?.plan?.actions || []).map(row => row.scope));
      const candidateScopes = [...new Set((trace?.candidates || []).map(row => row.scope))];
      const selection = `Selected scopes: ${[...selectedScopes].join(", ") || "none"}\nSkipped scopes: ${candidateScopes.filter(scope => !selectedScopes.has(scope)).join(", ") || "none"}`;
      const injection = trace?.injection || {};
      return [
        `MemoryPilot ${trace?.kind || "observation"} · ${trace?.status || "unknown"} · ${seconds(trace?.totalDurationMs)}`,
        `Decision: ${decision.protocol === "systemone" ? "SystemOne" : decision.protocol || "unknown"} / ${decision.model || "unknown"} · ${seconds(decision.durationMs)}`,
        answers && `Decision answers:\n${answers}`,
        candidates && `Authorized candidates (available for selection; not necessarily executed):\n${candidates}`,
        selection,
        executions && `Actual memory requests:\n${executions}`,
        `Main-model injection: ${number(injection.sourceCount)} sources · ${number(injection.contextChars)} chars (includes provenance/safety wrapping) · truncated ${injection.truncated === true ? "yes" : "no"}`,
        "This row covers pre-request automatic memory only; later memory_retrieve tool calls appear separately.",
      ].filter(Boolean).join("\n\n");
    }
    function memoryObservationNode(event) {
      if (event?.type !== "plugin/observation" || event.data?.plugin !== "dsh-memory-pilot" || !event.data.data) return null;
      const detail = memoryObservationDetail(event.data.data);
      return { kind: "context", seq: event.seq, time: event.time, content: [{ type: "text", text: detail }],
        source: { kind: "plugin:dsh-memory-pilot-observation" }, producer: { role: "inject", label: "MemoryPilot" }, form: null };
    }

    const CSS = `
.mp-section{box-sizing:border-box;display:flex;width:100%;max-width:820px;min-width:0;margin:0 auto;padding:2px 0 36px;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary)}
.mp-tabs{display:flex;overflow-x:auto;border-bottom:1px solid var(--dsw-alias-border-l2)}.mp-tab{flex:none;padding:9px 15px;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;cursor:pointer}.mp-tab-on{border-bottom-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-label-primary)}
.mp-summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}.mp-stat{padding:12px 14px;border-right:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:12px}.mp-stat:last-child{border-right:0}.mp-stat strong{display:block;color:var(--dsw-alias-label-primary);font-size:17px}
.mp-card{display:flex;min-width:0;flex-direction:column;gap:11px;padding:14px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}.mp-card-head,.mp-row,.mp-actions{display:flex;min-width:0;align-items:center;gap:10px;flex-wrap:wrap}.mp-card-head h2,.mp-card h3{margin:0;flex:1;font-size:14px}.mp-list{display:flex;flex-direction:column;gap:9px}.mp-system{display:grid;grid-template-columns:minmax(120px,1fr) 100px minmax(160px,1.4fr) max-content;align-items:center;gap:10px;padding:11px 13px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-1)}.mp-name{font-weight:650;overflow:hidden;text-overflow:ellipsis}.mp-muted,.mp-help{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px;overflow-wrap:anywhere}.mp-ok{color:var(--dsw-alias-state-success-primary)}.mp-warn,.mp-error{color:var(--dsw-alias-state-error-primary)}
.mp-field{display:flex;min-width:180px;flex:1;flex-direction:column;gap:5px;color:var(--dsw-alias-label-secondary);font-size:12px}.mp-control{box-sizing:border-box;width:100%;min-height:34px;padding:0 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}.mp-check{display:flex;align-items:center;gap:6px;font-size:12px}.mp-btn{box-sizing:border-box;display:inline-flex;min-height:32px;align-items:center;justify-content:center;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}.mp-btn-primary{border-color:transparent;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}.mp-btn-link{min-height:auto;padding:2px 4px;border:0;color:var(--dsw-alias-label-secondary)}.mp-btn:disabled{opacity:.45;cursor:default}.mp-actions{justify-content:flex-end}.mp-route-filters{display:grid;grid-template-columns:minmax(220px,1fr) 140px minmax(150px,1fr);gap:9px}.mp-table-wrap{width:100%;overflow-x:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-1)}.mp-table{width:100%;min-width:760px;border-collapse:collapse;font-size:12px}.mp-table th,.mp-table td{padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);text-align:left;vertical-align:middle}.mp-table th{color:var(--dsw-alias-label-secondary);font-weight:600}.mp-table tbody tr:last-child td{border-bottom:0}.mp-table-actions{display:flex;align-items:center;gap:6px;white-space:nowrap}.mp-scope-label{white-space:nowrap}.mp-tree-toggle{border:0;background:transparent;color:inherit;cursor:pointer;font:inherit}.mp-tree-child td:first-child{padding-left:30px}.mp-tree-leaf td:first-child{padding-left:52px}
.mp-adv{border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-1)}.mp-adv-head{display:flex;width:100%;min-height:40px;align-items:center;gap:8px;padding:0 11px;border:0;background:transparent;color:inherit;font:inherit;cursor:pointer}.mp-adv-body{display:flex;flex-direction:column;gap:11px;padding:12px;border-top:1px solid var(--dsw-alias-border-l1)}
.mp-resident-picker{display:flex;gap:7px;overflow-x:auto}.mp-resident-choice{flex:none}.mp-resident-choice[aria-pressed="true"]{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-label-primary)}.mp-resident-editor{box-sizing:border-box;width:100%;min-height:340px;resize:vertical;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:12px/1.6 var(--dsw-font-family-mono,monospace)}
.mp-mask{position:fixed;z-index:1100;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.62)}.mp-modal{box-sizing:border-box;display:flex;width:min(620px,100%);max-height:calc(100vh - 48px);overflow:auto;flex-direction:column;gap:14px;padding:22px;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-shadow-lv3)}.mp-modal h2{margin:0;font-size:17px}
@media(max-width:680px){.mp-summary,.mp-route-filters{grid-template-columns:1fr}.mp-stat{border-right:0;border-bottom:1px solid var(--dsw-alias-border-l1)}.mp-system{grid-template-columns:1fr}.mp-tabs{width:100%}}
`;

    function residentDocumentOptions(value) {
      const source = value || {};
      return [
        { target: "soul", label: "SOUL", manualOnly: true, document: source.soul || {} },
        { target: "user", label: "USER", manualOnly: false, document: source.user || {} },
        { target: "global-memory", label: "全局 MEMORY", manualOnly: false, document: source.globalMemory || {} },
        { target: "project-memory", label: "项目 MEMORY", manualOnly: false, document: source.projectMemory || {} },
      ];
    }

    function residentRpc(connection) { return {
      async residentGet(projectPath) { try { const result = await connection.rpc.call(SETTINGS_RPC_CHANNEL, "resident-get", projectPath ? { projectPath } : {}); return result?.ok ? result.value : null; } catch { return null; } },
      async residentPut(target, content, revision, projectPath) { try { const result = await connection.rpc.call(SETTINGS_RPC_CHANNEL, "resident-put", { target, content, revision, ...(projectPath ? { projectPath } : {}) }); return result?.ok ? result.value : null; } catch { return null; } },
    }; }

    function createRemoteForm(connection) {
      let snapshot = { status: "loading", value: undefined, revision: undefined, writable: false, mode: "remote" };
      const listeners = new Set();
      const publish = (next) => { snapshot = next; for (const listener of [...listeners]) listener(); };
      const accept = (view) => publish({ status: "ready", value: view.value, revision: view.revision, writable: view.writable === true, mode: "remote" });
      const load = async () => {
        publish({ ...snapshot, status: "loading" });
        try {
          const result = await connection.rpc.call(SETTINGS_RPC_CHANNEL, "get", {});
          result?.ok ? accept(result.value) : publish({ ...snapshot, status: "unavailable", writable: false });
        } catch { publish({ ...snapshot, status: "unavailable", writable: false }); }
      };
      const form = { getSnapshot: () => snapshot, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        async discover() { try { const result = await connection.rpc.call(SETTINGS_RPC_CHANNEL, "discover", {}); return result?.ok ? result.value : null; } catch { return null; } },
        async createBank(systemId, bank) { try { const result = await connection.rpc.call(SETTINGS_RPC_CHANNEL, "create-bank", { systemId, bank }); return result?.ok === true; } catch { return false; } },
        async test(kind, config) { try { const result = await connection.rpc.call(SETTINGS_RPC_CHANNEL, "test", { kind, config }); return result?.ok === true ? result.value : { ok: false, detail: result?.error?.message || "测试失败" }; } catch (error) { return { ok: false, detail: error instanceof Error ? error.message : "测试失败" }; } },
        ...residentRpc(connection),
        async mutate(ops) { try { const result = await connection.rpc.call(SETTINGS_RPC_CHANNEL, "mutate", { ops, revision: snapshot.revision }); if (!result?.ok) { await load(); return false; } accept(result.value); return true; } catch { await load(); return false; } } };
      void load();
      return form;
    }

    function connectionKey(item) {
      return JSON.stringify([item.type || "hindsight", item.baseUrl || "", item.home || "", item.agent || "", item.keyEnv || "", item.apiKey || "", item.cookieEnv || "", item.isolatedStore === true]);
    }
    function projectBackends(backends) {
      const systems = [], routes = [], seen = new Map();
      for (const item of backends || []) {
        const key = connectionKey(item);
        let system = seen.get(key);
        if (!system) {
          system = { id: item.id || `memory-${systems.length + 1}`, name: item.id || `记忆系统 ${systems.length + 1}`, type: item.type || "hindsight", baseUrl: item.baseUrl || "", home: item.home || "", agent: item.agent || "", keyEnv: item.keyEnv || "", apiKey: item.apiKey || "", cookieEnv: item.cookieEnv || "", isolatedStore: item.isolatedStore === true };
          systems.push(system); seen.set(key, system);
        }
        routes.push({ id: item.id || `binding-${routes.length + 1}`, systemId: system.id, scope: item.scope || "project", legacyScopeId: item.scopeId || "", bank: item.bank || "", read: item.read !== false, write: item.write === true });
      }
      return { systems, routes };
    }
    function filterRoutes(rows, filters) {
      const query = String(filters?.query || "").trim().toLocaleLowerCase();
      const scope = filters?.scope || "all";
      const systemId = filters?.systemId || "all";
      return (rows || []).filter(row => (scope === "all" || row.scope === scope)
        && (systemId === "all" || row.systemId === systemId)
        && (!query || [row.legacyScopeId, row.systemName, row.systemId, row.id, row.bank]
          .some(value => String(value || "").toLocaleLowerCase().includes(query))));
    }
    function upsertScopeOverride(overrides, override) {
      const rows = overrides || [];
      const index = rows.findIndex(item => item.scope === override.scope && item.scopeId === override.scopeId);
      return index < 0 ? [...rows, override] : rows.map((item, offset) => offset === index ? override : item);
    }
    function removeScopeOverride(overrides, scope, scopeId) {
      return (overrides || []).filter(item => item.scope !== scope || item.scopeId !== scopeId);
    }
    function scopeDiscoveryProjection(discovery, expanded) {
      if (!discovery) return { globalBindings: [], rows: [] };
      const globalBindings = (discovery.globalBindings || []).map((binding, index) => ({ key: `global:${binding.systemId}:${binding.bank}:${index}`, depth: 0, kind: "global-binding", label: "全局", scope: "global", scopeId: "global", autoBank: binding.bank || "", ...binding }));
      const rows = [];
      const projectRepositories = (workspace, workspaceKey) => {
        for (const repository of workspace.repositories || []) {
          const key = workspaceKey === "workspace" ? `repo:${repository.path}` : `repo:${workspace.id}:${repository.path}`;
          const targets = repository.targetBanks || [];
          const repositoryRow = { key, depth: 1, kind: "repository", label: repository.path, scope: "project", scopeId: repository.id || repository.path, autoBank: targets[0]?.bank || "", type: targets[0]?.type, expandable: targets.length > 1 };
          if (targets.length === 1) Object.assign(repositoryRow, targets[0]);
          rows.push(repositoryRow);
          if (targets.length > 1 && expanded?.[key]) for (const target of targets) rows.push({ key: `${key}:${target.systemId}:${target.bank}`, depth: 2, kind: "target", label: repository.id, scope: "project", scopeId: repository.id || repository.path, autoBank: target.bank || "", ...target });
        }
      };
      if (Array.isArray(discovery.workspaces)) {
        for (const workspace of discovery.workspaces) {
          const key = `workspace:${workspace.id}`;
          const targets = workspace.targets || [];
          const workspaceRow = { key, depth: 0, kind: "workspace", label: workspace.title || workspace.path || workspace.id || "工作区", scope: "workspace", scopeId: workspace.id || workspace.path, autoBank: targets[0]?.bank || "", type: targets[0]?.type, expandable: true };
          if (targets.length === 1) Object.assign(workspaceRow, targets[0]);
          rows.push(workspaceRow);
          if (!expanded?.[key]) continue;
          if (targets.length > 1) for (const target of targets) rows.push({ key: `${key}:${target.systemId}:${target.bank}`, depth: 1, kind: "target", label: workspaceRow.label, scope: "workspace", scopeId: workspace.id || workspace.path, autoBank: target.bank || "", ...target });
          projectRepositories(workspace, key);
        }
      } else {
        const workspaceTargets = discovery.workspaceTargets || [];
        const workspace = { key: "workspace", depth: 0, kind: "workspace", label: discovery.workspacePath || "工作区", scope: "workspace", scopeId: discovery.workspaceId || discovery.workspacePath || "workspace", autoBank: workspaceTargets[0]?.bank || "", type: workspaceTargets[0]?.type, expandable: true };
        if (workspaceTargets.length === 1) Object.assign(workspace, workspaceTargets[0]);
        else if (workspaceTargets.length > 1) Object.assign(workspace, { systemId: workspaceTargets.map(item => item.systemId).join(" / "), bank: workspaceTargets.map(item => item.bank).join(" / "), read: workspaceTargets.some(item => item.read), write: workspaceTargets.some(item => item.write), exists: workspaceTargets.every(item => item.exists === true) ? true : workspaceTargets.some(item => item.exists === false) ? false : null });
        rows.push(workspace);
        if (expanded?.workspace) projectRepositories({ repositories: discovery.repositories }, "workspace");
      }
      return { globalBindings, rows };
    }
    function scopeDiscoveryRows(discovery, expanded) { return scopeDiscoveryProjection(discovery, expanded).rows; }
    function flattenBackends(systems, routes, identity) {
      const byId = new Map((systems || []).map(item => [item.id, item]));
      const used = new Set();
      return (routes || []).flatMap((route, index) => {
        const system = byId.get(route.systemId); if (!system) return [];
        let id = route.id || system.id || `binding-${index + 1}`; let suffix = 2;
        while (used.has(id)) id = `${route.id || system.id}-${suffix++}`; used.add(id);
        const scopeId = route.scope === "global" ? "global" : route.scope === "project"
          ? (identity.projectId || route.legacyScopeId || "*")
          : route.scope === "workspace" ? (identity.workspaceId || route.legacyScopeId || "*")
          : (identity.actorId || route.legacyScopeId || "*");
        const out = { id, type: system.type, scope: route.scope, scopeId, bank: route.bank || "", read: route.read !== false, write: route.write === true };
        for (const key of SYSTEM_FIELDS) if (key !== "id" && key !== "type") out[key] = system[key] ?? (key === "isolatedStore" ? false : "");
        return [out];
      });
    }

    const zh = { nav: "记忆调度", summary: "MemoryPilot — 按范围编排 Hindsight 与 MemOS 的记忆读写。", loading: "正在读取配置…", unavailable: "MemoryPilot 未加载，暂时无法配置。", readOnly: "当前部署只读。", save: "保存", saving: "保存中…", saved: "已保存，插件正在重新加载。", failed: "保存被拒绝，请检查配置。" };
    const en = { nav: "MemoryPilot", summary: "MemoryPilot — orchestrates Hindsight and MemOS memory by scope.", loading: "Loading configuration…", unavailable: "MemoryPilot is unavailable.", readOnly: "This deployment is read-only.", save: "Save", saving: "Saving…", saved: "Saved; the plugin is reloading.", failed: "The configuration was rejected." };

    function useSnapshot(form) { const [snap, setSnap] = React.useState(() => form.getSnapshot()); React.useEffect(() => form.subscribe(() => setSnap(form.getSnapshot())), [form]); return snap; }
    function withTimeout(promise, ms = 10000) { return Promise.race([promise, new Promise(resolve => setTimeout(() => resolve(null), ms))]); }
    // One-shot connection test against the DRAFT config: { status, result }
    // with result = { ok, detail }. The probe goes through the settings RPC
    // "test" endpoint, so it validates exactly what the runtime will use.
    function useConnectionTest(form) {
      const [state, setState] = React.useState({ status: "idle", result: null });
      const run = async (kind, config) => {
        setState({ status: "running", result: null });
        const result = await form.test(kind, config);
        setState({ status: "done", result });
        return result;
      };
      const reset = () => setState({ status: "idle", result: null });
      return { state, run, reset };
    }
    function TestButton({ test, label }) {
      const running = test.state.status === "running";
      return h(Button, { onClick: () => test.runRef.current(), disabled: running || !test.canRun }, running ? "测试中…" : (label || "测试"));
    }
    function TestResult({ test }) {
      if (test.state.status !== "done" || !test.state.result) return null;
      const { ok, detail } = test.state.result;
      return h("p", { className: ok ? "mp-ok" : "mp-error", role: "status" }, detail || (ok ? "连接正常" : "测试失败"));
    }
    function Field({ label, hint, children }) { return h("label", { className: "mp-field" }, h("span", null, label), children, hint ? h("span", { className: "mp-help" }, hint) : null); }
    function Input({ value, onChange, type, placeholder }) { return h("input", { className: "mp-control", type: type || "text", value: value ?? "", placeholder: placeholder || "", onChange: e => onChange(e.target.value) }); }
    function Select({ value, onChange, options }) { return h("select", { className: "mp-control", value, onChange: e => onChange(e.target.value) }, options.map(option => h("option", { key: option[0], value: option[0] }, option[1]))); }
    function Check({ checked, onChange, label }) { return h("label", { className: "mp-check" }, h("input", { type: "checkbox", checked: !!checked, onChange: e => onChange(e.target.checked) }), label); }
    function Button({ children, onClick, primary, disabled }) { return h("button", { type: "button", disabled, className: `mp-btn${primary ? " mp-btn-primary" : ""}`, onClick }, children); }

    function systemEditorView(system) {
      return {
        fields: ["name", "id", "type", "baseUrl", "keyEnv", "apiKey"],
        displayType: system?.type === "memos-bridge" ? "memos" : (system?.type || "hindsight"),
      };
    }
    function systemConnectionSummary(system) {
      if (system?.baseUrl) return system.baseUrl;
      return system?.type === "memos-bridge" ? "旧版 MemOS 连接（待迁移）" : "未配置地址";
    }
    function SystemModal({ value, onSave, onClose }) {
      const [draft, setDraft] = React.useState(() => ({ ...value }));
      const set = key => next => setDraft(current => ({ ...current, [key]: next }));
      const view = systemEditorView(draft);
      const shows = field => view.fields.includes(field);
      return h("div", { className: "mp-mask", role: "presentation", onMouseDown: e => { if (e.target === e.currentTarget) onClose(); } },
        h("div", { className: "mp-modal", role: "dialog", "aria-modal": true, "aria-label": "编辑记忆系统" },
          h("h2", null, value.id ? "编辑记忆系统" : "添加记忆系统"),
          h("div", { className: "mp-row" },
            h(Field, { label: "名称" }, h(Input, { value: draft.name, onChange: set("name") })),
            h(Field, { label: "系统标识" }, h(Input, { value: draft.id, onChange: set("id"), placeholder: "hindsight-main" })),
            h(Field, { label: "类型" }, h(Select, { value: view.displayType, onChange: set("type"), options: [["hindsight", "Hindsight"], ["memos", "MemOS"]] }))
          ),
          h("p", { className: "mp-help" }, "连接服务实例，可访问该连接有权查看的全部记忆库"),
          shows("baseUrl") ? h(Field, { label: "地址 (baseUrl)" }, h(Input, { value: draft.baseUrl, onChange: set("baseUrl"), placeholder: "http://host:port" })) : null,
          shows("keyEnv") ? h("div", { className: "mp-adv" }, h("div", { className: "mp-adv-body" },
            h("strong", null, "底层连接与凭据"),
            h(Field, { label: "密钥环境变量" }, h(Input, { value: draft.keyEnv, onChange: set("keyEnv") })),
            h(Field, { label: "API Key（不建议明文）" }, h(Input, { value: draft.apiKey, onChange: set("apiKey"), type: "password" }))
          )) : null,
          h("div", { className: "mp-actions" }, h(Button, { onClick: onClose }, "取消"), h(Button, { primary: true, disabled: !draft.id, onClick: () => onSave(draft) }, "确定"))
        ));
    }

    function ScopeModal({ value, systems, banks, onSave, onRestore, onClose }) {
      const [draft, setDraft] = React.useState(() => ({ enabled: true, systemId: systems[0]?.id || "", bank: value.autoBank || "", ...value }));
      const set = key => next => setDraft(current => ({ ...current, [key]: next }));
      const system = systems.find(item => item.id === draft.systemId);
      const bankOptions = (banks || []).filter(item => item.systemId === draft.systemId);
      return h("div", { className: "mp-mask", role: "presentation", onMouseDown: e => { if (e.target === e.currentTarget) onClose(); } },
        h("div", { className: "mp-modal", role: "dialog", "aria-modal": true, "aria-label": "编辑记忆范围" },
          h("h2", null, "编辑记忆范围"),
          h(Check, { checked: draft.enabled, onChange: set("enabled"), label: "启用本地记忆" }),
          h(Field, { label: "记忆系统" }, h(Select, { value: draft.systemId, onChange: next => setDraft(current => ({ ...current, systemId: next, bank: "" })), options: systems.map(item => [item.id, item.name || item.id]) })),
          system?.type === "hindsight" ? h(Field, { label: "库 / bank", hint: "可选择已发现的库，也可自由输入" }, h("input", { className: "mp-control", list: "mp-scope-banks", value: draft.bank || "", placeholder: value.autoBank || "自动选择", onChange: e => set("bank")(e.target.value) }), h("datalist", { id: "mp-scope-banks" }, bankOptions.map(item => h("option", { key: item.bank, value: item.bank })))) : null,
          h("div", { className: "mp-actions" }, value.hasOverride ? h(Button, { onClick: onRestore }, "恢复自动") : null, h(Button, { onClick: onClose }, "取消"), h(Button, { primary: true, disabled: !draft.systemId, onClick: () => onSave({ scope: value.scope, scopeId: value.scopeId, enabled: draft.enabled, systemId: draft.systemId, ...(system?.type === "hindsight" && draft.bank ? { bank: draft.bank } : {}) }) }, "确定"))
        ));
    }

    function RouteModal({ value, systems, onSave, onClose }) {
      const [draft, setDraft] = React.useState(() => ({ ...value }));
      const set = key => next => setDraft(current => ({ ...current, [key]: next }));
      return h("div", { className: "mp-mask", role: "presentation", onMouseDown: e => { if (e.target === e.currentTarget) onClose(); } },
        h("div", { className: "mp-modal", role: "dialog", "aria-modal": true, "aria-label": value.__new ? "添加绑定" : "编辑绑定" },
          h("h2", null, value.__new ? "添加绑定" : "编辑绑定"),
          h("div", { className: "mp-row" },
            h(Field, { label: "范围" }, h(Select, { value: draft.scope, onChange: set("scope"), options: [["global", "全局"], ["project", "仓库"], ["workspace", "工作区"]] })),
            h(Field, { label: "范围标识", hint: "仓库/工作区留空即自动识别" }, h(Input, { value: draft.legacyScopeId === "*" ? "" : draft.legacyScopeId, onChange: set("legacyScopeId"), placeholder: "自动识别" }))
          ),
          h("div", { className: "mp-row" },
            h(Field, { label: "记忆系统" }, h(Select, { value: draft.systemId, onChange: set("systemId"), options: systems.map(system => [system.id, system.name || system.id]) })),
            h(Field, { label: "库 / bank" }, h(Input, { value: draft.bank, onChange: set("bank") }))
          ),
          h("div", { className: "mp-row" }, h(Check, { checked: draft.read, onChange: set("read"), label: "读取" }), h(Check, { checked: draft.write, onChange: set("write"), label: "写入" })),
          h("div", { className: "mp-actions" }, h(Button, { onClick: onClose }, "取消"), h(Button, { primary: true, disabled: !draft.systemId, onClick: () => onSave({ ...draft, legacyScopeId: draft.scope === "global" ? "global" : (draft.legacyScopeId || "") }) }, "确定"))
        ));
    }

    function MemoryPilotPage({ form, t }) {
      const snap = useSnapshot(form);
      const [revision, setRevision] = React.useState(undefined);
      const [draft, setDraft] = React.useState(null);
      const [active, setActive] = React.useState("decision");
      const [editing, setEditing] = React.useState(null);
      const [advancedOpen, setAdvancedOpen] = React.useState(false);
      const [saving, setSaving] = React.useState(false);
      const [message, setMessage] = React.useState("");
      const [discovery, setDiscovery] = React.useState({ status: "idle", value: null });
      const [expanded, setExpanded] = React.useState({});
      const [editingScope, setEditingScope] = React.useState(null);
      const [resident, setResident] = React.useState({ status: "idle", value: null });
      const [residentTarget, setResidentTarget] = React.useState("soul");
      const [residentContent, setResidentContent] = React.useState("");
      const [residentSaving, setResidentSaving] = React.useState(false);
      const [residentMessage, setResidentMessage] = React.useState("");
      const [residentProjectPath, setResidentProjectPath] = React.useState("");
      const decisionTest = useConnectionTest(form);
      const systemTest = useConnectionTest(form);
      const systemTestTarget = React.useRef(null);
      // keep the latest runner reachable from buttons rendered inside map()
      decisionTest.runRef = React.useRef(null); decisionTest.runRef.current = () => {
        const budget = Math.round(Number(draft.budgetMs)), capture = Math.round(Number(draft.captureBudgetMs));
        if (Number.isFinite(budget) && (budget < 100 || budget > 30000)) { setMessage("预算数值超出允许范围。"); return; }
        void decisionTest.run("decision", { ...draft });
      };
      systemTest.runRef = React.useRef(null); systemTest.runRef.current = () => {
        const system = draft.systems.find(item => item.id === systemTestTarget.current);
        if (!system) return;
        void systemTest.run("system", { ...system, keyEnv: system.keyEnv || "" });
      };
      const refreshDiscovery = React.useCallback(async () => {
        if (typeof form.discover !== "function") { setDiscovery({ status: "unavailable", value: null }); return; }
        setDiscovery(current => ({ ...current, status: "loading" }));
        const value = await form.discover();
        setDiscovery({ status: value ? "ready" : "failed", value });
      }, [form]);
      React.useEffect(() => { if ((active === "scope" || active === "resident") && discovery.status === "idle") void refreshDiscovery(); }, [active, discovery.status, refreshDiscovery]);
      const residentProjects = (discovery.value?.workspaces || []).flatMap(workspace => (workspace.repositories || []).map(repository => ({ path: repository.projectRef, label: `${workspace.title || workspace.id} / ${repository.path}` }))).filter(item => item.path);
      const selectedResidentPath = residentProjectPath || residentProjects[0]?.path || discovery.value?.projectPath || draft?.workspacePath;
      React.useEffect(() => { if (active !== "resident" || !draft || resident.status === "ready" || resident.status === "empty" || resident.status === "failed") return; let live = true; const projectPath = residentTarget === "project-memory" ? selectedResidentPath : undefined; if (residentTarget === "project-memory" && !projectPath) { setResident({status:"empty",value:null}); return; } setResident(current => ({ status: "loading", value: current.value })); void withTimeout(form.residentGet(projectPath)).then(value => { if (!live) return; setResident({ status: value ? "ready" : "failed", value }); const selected = residentDocumentOptions(value).find(item => item.target === residentTarget); setResidentContent(selected?.document.content || ""); }); return () => { live = false; }; }, [active, draft, form, resident.status, residentTarget, selectedResidentPath]);
      React.useEffect(() => { if (resident.status === "ready") { const selected = residentDocumentOptions(resident.value).find(item => item.target === residentTarget); setResidentContent(selected?.document.content || ""); setResidentMessage(""); } }, [residentTarget]);
      React.useEffect(() => { if (snap.status === "ready" && snap.revision !== revision) { const value = JSON.parse(JSON.stringify(snap.value || {})); const projected = projectBackends(value.backends); setRevision(snap.revision); setDraft({ ...value, systems: projected.systems, routes: projected.routes }); setMessage(""); } }, [snap, revision]);
      if (snap.status !== "ready" || !draft) return h("section", { className: "mp-section" }, h("style", null, CSS), h("p", null, snap.status === "loading" ? t("loading") : t("unavailable")));
      const set = key => next => setDraft(current => ({ ...current, [key]: next }));
      const updateSystem = system => setDraft(current => { const exists = current.systems.some(item => item.id === editing?.id); return { ...current, systems: exists ? current.systems.map(item => item.id === editing.id ? system : item) : [...current.systems, system], routes: editing?.id && editing.id !== system.id ? current.routes.map(route => route.systemId === editing.id ? { ...route, systemId: system.id } : route) : current.routes }; });
      const removeSystem = id => { if (!confirm("确定删除该记忆系统吗？它的所有范围绑定也会一并移除。")) return; setDraft(current => ({ ...current, systems: current.systems.filter(item => item.id !== id), routes: current.routes.filter(route => route.systemId !== id) })); if (editing?.id === id) setEditing(null); };
      const save = async () => {
        const budget = Math.round(Number(draft.budgetMs)), capture = Math.round(Number(draft.captureBudgetMs));
        if (!Number.isFinite(budget) || budget < 100 || budget > 30000 || !Number.isFinite(capture) || capture < 100 || capture > 300000) { setMessage("预算数值超出允许范围。"); return; }
        const backends = flattenBackends(draft.systems, draft.routes, draft);
        if (backends.some(item => !item.scopeId || !/^[a-zA-Z0-9_-]+$/.test(item.id))) { setMessage("请为使用中的项目/工作区设置可识别路径或手动标识，并检查系统标识。"); return; }
        const original = snap.value || {}, ops = [];
        for (const key of SCALAR_FIELDS) { const next = key === "budgetMs" ? budget : key === "captureBudgetMs" ? capture : draft[key]; if (JSON.stringify(next) !== JSON.stringify(original[key])) ops.push({ op: "set", path: [key], value: next }); }
        if (JSON.stringify(backends) !== JSON.stringify(original.backends || [])) ops.push({ op: "set", path: ["backends"], value: backends });
        if (JSON.stringify(draft.scopeOverrides || []) !== JSON.stringify(original.scopeOverrides || [])) ops.push({ op: "set", path: ["scopeOverrides"], value: draft.scopeOverrides || [] });
        if (!ops.length) { setMessage(t("saved")); return; }
        setSaving(true); const ok = await form.mutate(ops); setSaving(false); setMessage(ok ? t("saved") : t("failed"));
      };
      const tabKey = e => { const index = TABS.findIndex(item => item[0] === active); const next = e.key === "ArrowRight" ? (index + 1) % TABS.length : e.key === "ArrowLeft" ? (index + TABS.length - 1) % TABS.length : -1; if (next >= 0) { e.preventDefault(); setActive(TABS[next][0]); } };
      let page;
      if (active === "decision") page = h(React.Fragment, null,
        h("div", { className: "mp-summary" }, h("div", { className: "mp-stat" }, h("strong", null, draft.enabled ? "已启用" : "已停用"), "运行状态"), h("div", { className: "mp-stat" }, h("strong", null, draft.decisionEnabled === false ? "自主判断" : (draft.decisionModel || "未设置")), "决策模型"), h("div", { className: "mp-stat" }, h("strong", null, draft.systems.length), "记忆系统")),
        h("div", { className: "mp-card" },
          h("div", { className: "mp-card-head" }, h("h2", null, "决策模型"), h(Check, { checked: draft.enabled, onChange: set("enabled"), label: "启用 MemoryPilot" })),
          h("div", { className: "mp-card-head" }, h("span", { className: "mp-help" }, "记忆调度方式"), h(Check, { checked: draft.decisionEnabled !== false, onChange: set("decisionEnabled"), label: "使用决策模型" })),
          h("p", { className: "mp-help" }, draft.decisionEnabled === false
            ? "已关闭：不联系决策接口，由当前对话的模型自行决定何时调用 memory_retrieve / memory_remember。决策模型停用或内存不足时也能正常记忆。"
            : "已开启：每轮由决策模型判断是否召回、查哪个范围、保存什么。决策接口不可达时记忆工具会失败。"),
          h(Field, { label: "决策接口" }, h(Select, { value: draft.decisionProtocol || "systemone", onChange: set("decisionProtocol"), options: [["systemone", "Jev / SystemOne（推荐）"], ["openai", "OpenAI 兼容接口（旧配置）"]] })),
          h(Field, { label: draft.decisionProtocol === "openai" ? "OpenAI API 根地址" : "SystemOne API 根地址" }, h(Input, { value: draft.decisionBaseUrl, onChange: set("decisionBaseUrl"), placeholder: draft.decisionProtocol === "openai" ? "http://host:3233/v1" : "http://host:8009/v1" })),
          h("div", { className: "mp-row" },
            h(Field, { label: "模型" }, h(Input, { value: draft.decisionModel, onChange: set("decisionModel"), placeholder: "模型名称" })),
            h(Field, { label: "密钥环境变量（可选）" }, h(Input, { value: draft.decisionKeyEnv, onChange: set("decisionKeyEnv"), placeholder: "本地接口可留空" }))
          ),
          h("p", { className: "mp-help" }, draft.decisionProtocol === "openai" ? "旧的生成式 JSON 决策方式。" : "调用原生 POST /systemone；模型只在程序生成的已授权记忆动作中做结构化选择。"),
          h("div", { className: "mp-row" },
            h(TestButton, { test: { ...decisionTest, canRun: Boolean(draft.decisionBaseUrl && draft.decisionModel), runRef: decisionTest.runRef } }),
            h(TestResult, { test: decisionTest })
          )
        )
      );
      if (active === "systems") page = h("div", { className: "mp-card" }, h("div", { className: "mp-card-head" }, h("h2", null, "记忆系统"), h(Button, { onClick: () => setEditing({ id: "", name: "", type: "hindsight", baseUrl: "", home: "", agent: "", keyEnv: "", apiKey: "", cookieEnv: "", isolatedStore: false }) }, "添加系统")), h("p", { className: "mp-help" }, "卡片只展示连接摘要；底层字段在编辑弹窗中维护。测试按钮探测该系统连接（只读，不写任何记忆）。"), h("div", { className: "mp-list" }, draft.systems.map(system => h("div", { className: "mp-system", key: system.id },
        h("span", { className: "mp-name" }, system.name || system.id),
        h("span", null, systemEditorView(system).displayType === "memos" ? "MemOS" : "Hindsight"),
        h("span", { className: "mp-muted" }, systemConnectionSummary(system)),
        h(Button, { onClick: () => setEditing(system) }, "编辑"),
        h(Button, { onClick: () => removeSystem(system.id) }, "删除"),
        h(Button, { disabled: systemTest.state.status === "running", onClick: () => { systemTestTarget.current = system.id; systemTest.runRef.current(); } }, systemTest.state.status === "running" && systemTestTarget.current === system.id ? "测试中…" : "测试")
      )), !draft.systems.length ? h("p", { className: "mp-muted" }, "尚未添加记忆系统。") : null,
      systemTest.state.status === "done" && systemTest.state.result ? h("p", { className: systemTest.state.result.ok ? "mp-ok" : "mp-error", role: "status" }, `${systemTest.state.result.name || "系统"}：${systemTest.state.result.detail}`) : null));
      if (active === "scope") {
        const discoveryProjection = scopeDiscoveryProjection(discovery.value, expanded);
        const discoveredRows = discoveryProjection.rows;
        const globalRows = discoveryProjection.globalBindings;
        const toggleExpanded = key => setExpanded(current => ({ ...current, [key]: !current[key] }));
        const overrideFor = row => (draft.scopeOverrides || []).find(item => item.scope === row.scope && item.scopeId === row.scopeId);
        const effectiveRow = row => { const override = overrideFor(row); return override ? { ...row, ...override, hasOverride: true, autoBank: row.autoBank || row.bank || "" } : { ...row, enabled: true, hasOverride: false, autoBank: row.autoBank || row.bank || "" }; };
        const discoveryStatus = row => row.enabled === false ? "已关闭" : row.exists === true ? "已存在" : row.exists === false ? "尚未创建" : discovery.status === "loading" ? "检测中" : discovery.status === "failed" || row.exists === null ? "连接失败" : discovery.status === "unavailable" ? "未配置" : "正常";
        const discoveryPermission = row => [row.read ? "读" : "", row.write ? "写" : ""].filter(Boolean).join(" / ") || "—";
        const discoveryAction = row => h("span", { className: "mp-table-actions" },
          h(Button, { onClick: () => setEditingScope(effectiveRow(row)) }, "编辑"),
          row.systemId || row.hasOverride ? h(Button, { onClick: () => { if (!confirm(row.hasOverride ? "确定删除该范围绑定吗？将恢复自动路由。" : "确定删除该范围绑定吗？该记忆系统在此范围的接入将被移除。")) return; setDraft(current => ({ ...current, scopeOverrides: removeScopeOverride(current.scopeOverrides || [], row.scope, row.scopeId), routes: current.routes.filter(route => !(route.scope === row.scope && (route.scope === "global" ? "global" : route.legacyScopeId || "") === row.scopeId) ) })); } }, "删除") : null);
        page = h("div", { className: "mp-card" },
          h("div", { className: "mp-card-head" }, h("h2", null, "使用范围"), h(Button, { onClick: refreshDiscovery, disabled: discovery.status === "loading" }, discovery.status === "loading" ? "检测中" : "刷新")),
          discovery.status === "unavailable" ? h("p", { className: "mp-muted" }, "当前配置表单不支持自动发现。") : null,
          h("h2", null, "全局"),
          h("div", { className: "mp-table-wrap", "aria-label": "全局绑定" }, h("table", { className: "mp-table" },
            h("thead", null, h("tr", null, ...["范围", "记忆系统", "库/bank", "权限", "状态", "操作"].map(label => h("th", { key: label, scope: "col" }, label)))),
            h("tbody", null, ...(globalRows.length ? globalRows : [{ key: "global", kind: "global-binding", label: "全局", scope: "global", scopeId: "global", autoBank: "" }]).map(sourceRow => { const row = effectiveRow(sourceRow); return h("tr", { key: row.key },
              h("td", null, "全局"), h("td", null, row.systemId || "—"), h("td", null, row.bank || "—"), h("td", null, discoveryPermission(row)), h("td", null, discoveryStatus(row)), h("td", null, discoveryAction(row))
            ); })))),
          h("h2", null, "工作区与仓库"),
          h("div", { className: "mp-table-wrap" }, h("table", { className: "mp-table" },
            h("thead", null, h("tr", null, ...["范围", "记忆系统", "库/bank", "权限", "状态", "操作"].map(label => h("th", { key: label, scope: "col" }, label)))),
            h("tbody", null, ...discoveredRows.map(sourceRow => { const row = effectiveRow(sourceRow); return h("tr", { key: row.key, className: row.depth === 1 ? "mp-tree-child" : row.depth === 2 ? "mp-tree-leaf" : "" },
              h("td", null, row.expandable ? h("button", { type: "button", className: "mp-tree-toggle", onClick: () => toggleExpanded(row.key), "aria-expanded": !!expanded[row.key] }, expanded[row.key] ? "▾ " : "▸ ", row.label) : row.label),
              h("td", null, row.systemId || "—"), h("td", null, row.bank || "—"), h("td", null, discoveryPermission(row)), h("td", null, discoveryStatus(row)), h("td", null, discoveryAction(row))
            ); }), !discoveredRows.length ? h("tr", null, h("td", { colSpan: 6, className: "mp-muted" }, discovery.status === "loading" ? "检测中…" : "尚无发现结果。")) : null)))
        );
      }
      if (active === "resident") {
        const documents = residentDocumentOptions(resident.value);
        const selected = documents.find(item => item.target === residentTarget) || documents[0];
        const saveResident = async () => {
          if (!selected?.document.writable) return;
          setResidentSaving(true); setResidentMessage("");
          const result = await withTimeout(form.residentPut(selected.target, residentContent, selected.document.revision, selected.target === "project-memory" ? selectedResidentPath : undefined));
          if (!result) { setResidentSaving(false); setResidentMessage("保存失败；文档可能已被其他会话修改，请重新加载。"); return; }
          const value = await withTimeout(form.residentGet(selected.target === "project-memory" ? selectedResidentPath : undefined));
          setResidentSaving(false);
          if (!value) { setResident({ status: "idle", value: null }); setResidentMessage("已保存；重新加载文档失败。"); return; }
          setResident({ status: "ready", value }); setResidentMessage("已保存，修改将在新会话中生效。");
        };
        page = h("div", { className: "mp-card" },
          h("div", { className: "mp-card-head" }, h("h2", null, "常驻记忆"), h(Button, { disabled: resident.status === "loading", onClick: () => setResident({ status: "idle", value: null }) }, resident.status === "loading" ? "加载中…" : "重新加载")),
          h("p", { className: "mp-help" }, "SOUL 只能人工修改；修改将在新会话中生效。USER/MEMORY 可人工修改，也可由受控自动维护。"),
          residentTarget === "project-memory" ? h("div",{className:"mp-card"},h("div",{className:"mp-card-head"},h("h3",null,"项目 MEMORY 所属仓库"),h(Button,{onClick:refreshDiscovery,disabled:discovery.status==="loading"},discovery.status==="loading"?"正在发现…":"刷新仓库")),residentProjects.length ? h("select",{className:"mp-control",value:selectedResidentPath||"",onChange:event=>{if(residentContent&&resident.status==="ready"&&!confirm("有未保存的修改，确定切换仓库吗？"))return;setResidentProjectPath(event.target.value);setResident({status:"idle",value:null});}},residentProjects.map(project=>h("option",{key:project.path,value:project.path},project.label))) : h("p",{className:"mp-muted",role:"status"},discovery.status==="loading"?"正在查找工作区中的 Git 仓库…":"未发现可用的 Git 仓库。请确认工作区已注册且仓库包含 .git，然后重试。")) : null,
          h("div", { className: "mp-resident-picker", role: "group", "aria-label": "常驻记忆文档" }, documents.map(item => h("button", { key: item.target, type: "button", className: "mp-btn mp-resident-choice", "aria-pressed": item.target === residentTarget, onClick: () => setResidentTarget(item.target) }, item.label))),
          resident.status === "failed" ? h("div",{className:"mp-row",role:"alert"},h("span",{className:"mp-error"},"读取失败，请重试。当前运行的服务端可能尚未加载新版插件。"),h(Button,{onClick:()=>setResident({status:"idle",value:resident.value})},"重试")) : null,
          resident.status === "empty" ? h("p",{className:"mp-muted",role:"status"},"选择一个仓库后即可编辑项目 MEMORY。") : null,
          h("div", { className: "mp-row" }, h("strong", null, selected.label), h("span", { className: "mp-muted" }, selected.document.path || (resident.status === "ready" ? "尚未创建，首次保存时建立" : "等待读取文档…")), selected.document.managed === true ? h("span", { className: "mp-muted" }, "受控自动维护") : null),
          h("textarea", { className: "mp-resident-editor", value: residentContent, disabled: resident.status !== "ready", readOnly: selected.document.writable !== true, placeholder: resident.status === "loading" ? "正在读取文档…" : resident.status === "failed" ? "读取失败，请重试" : resident.status === "empty" ? "请先选择仓库" : "在这里输入内容…", "aria-label": `${selected.label} 内容`, "aria-busy":resident.status==="loading", onChange: event => {setResidentContent(event.target.value);setResidentMessage("有未保存的修改");} }),
          resident.status === "ready" && !selected.document.writable ? h("p", { className: "mp-warn" }, "当前文档只读。") : null,
          h("div", { className: "mp-actions" }, residentMessage ? h("span", { className: residentMessage.startsWith("已保存") ? "mp-ok" : residentMessage.startsWith("有未保存") ? "mp-muted" : "mp-error", role: "status" }, residentMessage) : null, h(Button, { primary: true, disabled: residentSaving || resident.status!=="ready" || selected.document.writable !== true || !(selected.target !== "project-memory" || selectedResidentPath), onClick: saveResident }, residentSaving ? "保存中…" : "保存文档"))
        );
      }
      if (active === "advanced") page = h("div", { className: "mp-card" }, h("h2", null, "高级设置"), h("div", { className: "mp-adv" }, h("button", { type: "button", className: "mp-adv-head", "aria-expanded": advancedOpen, onClick: () => setAdvancedOpen(value => !value) }, h("span", null, advancedOpen ? "▾" : "▸"), h("strong", null, "预算、身份与底层选项"), h("span", { className: "mp-muted" }, `${draft.budgetMs || 0} ms / ${draft.captureBudgetMs || 0} ms`)), advancedOpen ? h("div", { className: "mp-adv-body" }, h("div", { className: "mp-row" }, h(Field, { label: "交互召回预算 (ms)" }, h(Input, { type: "number", value: draft.budgetMs, onChange: set("budgetMs") })), h(Field, { label: "后台捕获预算 (ms)" }, h(Input, { type: "number", value: draft.captureBudgetMs, onChange: set("captureBudgetMs") }))), h(Field, { label: "Actor override" }, h(Input, { value: draft.actorId, onChange: set("actorId"), placeholder: "自动识别 / 可选" })), h("p", { className: "mp-help" }, "底层凭据变量、明文 API Key 与 isolated store 在各记忆系统的编辑弹窗中配置。")) : null));
      return h("section", { className: "mp-section" }, h("style", null, CSS), h("div", { className: "mp-tabs", role: "tablist", "aria-label": "MemoryPilot 配置", onKeyDown: tabKey }, TABS.map(item => h("button", { key: item[0], type: "button", role: "tab", "aria-selected": active === item[0], tabIndex: active === item[0] ? 0 : -1, className: `mp-tab${active === item[0] ? " mp-tab-on" : ""}`, onClick: () => setActive(item[0]) }, item[1]))), !snap.writable ? h("p", { className: "mp-warn" }, t("readOnly")) : null, h("div", { role: "tabpanel" }, page), h("div", { className: "mp-actions" }, message ? h("span", { className: message === t("saved") ? "mp-ok" : "mp-error" }, message) : null, h(Button, { primary: true, disabled: saving || !snap.writable, onClick: save }, saving ? t("saving") : t("save"))), editing ? h(SystemModal, { value: editing, onClose: () => setEditing(null), onSave: system => { updateSystem(system); setEditing(null); } }) : null, editingScope ? h(ScopeModal, { value: editingScope, systems: draft.systems, banks: discovery.value?.banks || [], onClose: () => setEditingScope(null), onSave: override => { setDraft(current => ({ ...current, scopeOverrides: upsertScopeOverride(current.scopeOverrides, override) })); setEditingScope(null); }, onRestore: () => { setDraft(current => ({ ...current, scopeOverrides: removeScopeOverride(current.scopeOverrides, editingScope.scope, editingScope.scopeId) })); setEditingScope(null); } }) : null);
    }

    const inject = ["slots", "locale", "configForms", "connection", "uiConversation"];
    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      ctx.effect(() => ctx.uiConversation.events.register({
        kind: "memory-pilot-observation", target: "trajectory",
        match(event) { return memoryObservationNode(event) ? { id: String(event.seq), role: "start" } : null; },
        start(_context, match) { return memoryObservationNode(match.event); },
        update(context) { return context.state; },
        buildViewNode(context) { return context.state ? { key: context.key, kind: context.kind, id: context.id,
          target: "trajectory", anchorSeq: context.state.seq, location: context.start?.location || { kind: "unresolved" },
          data: { kind: "node", node: context.state } } : null; },
      }), "dsh-memory-pilot: trajectory observations");
      const nativeForm = ctx.configForms.get(ENTRY);
      const form = ctx.connection.isLoopback ? { getSnapshot: () => nativeForm.getSnapshot(), subscribe: listener => nativeForm.subscribe(listener), mutate: ops => nativeForm.mutate(ops), async discover() { try { const result = await ctx.connection.rpc.call(SETTINGS_RPC_CHANNEL, "discover", {}); return result?.ok ? result.value : null; } catch { return null; } }, async createBank(systemId, bank) { try { const result = await ctx.connection.rpc.call(SETTINGS_RPC_CHANNEL, "create-bank", { systemId, bank }); return result?.ok === true; } catch { return false; } }, async test(kind, config) { try { const result = await ctx.connection.rpc.call(SETTINGS_RPC_CHANNEL, "test", { kind, config }); return result?.ok === true ? result.value : { ok: false, detail: result?.error?.message || "测试失败" }; } catch (error) { return { ok: false, detail: error instanceof Error ? error.message : "测试失败" }; } }, ...residentRpc(ctx.connection) } : createRemoteForm(ctx.connection);
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-memory-pilot: dictionaries");
      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "memory-pilot",
        order: 90,
        label: () => t("nav"), locale: NS, inject: () => ({ form, t })
      }, () => h(MemoryPilotPage, { form, t })));
      ctx.effect(() => ctx.configForms.whileServed([ENTRY], () => ctx.slots.inject("plugins.row.config", () => ctx.slots.register({ name: "plugins.row.config", key: ROW_KEY }, props => props && props.view === "summary" ? t("summary") : h(MemoryPilotPage, { form, t })))), "dsh-memory-pilot: row configuration");
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.projectBackends = projectBackends;
    exports.flattenBackends = flattenBackends;
    exports.scopeDiscoveryRows = scopeDiscoveryRows;
    exports.scopeDiscoveryProjection = scopeDiscoveryProjection;
    exports.upsertScopeOverride = upsertScopeOverride;
    exports.removeScopeOverride = removeScopeOverride;
    exports.filterRoutes = filterRoutes;
    exports.systemEditorView = systemEditorView;
    exports.systemConnectionSummary = systemConnectionSummary;
    exports.memoryObservationDetail = memoryObservationDetail;
    exports.memoryObservationNode = memoryObservationNode;
    exports.residentDocumentOptions = residentDocumentOptions;
    return module.exports;
  },
});
