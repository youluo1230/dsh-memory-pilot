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
      "decisionProtocol", "decisionBaseUrl", "decisionModel", "decisionKeyEnv", "decisionApiKey", "budgetMs", "captureBudgetMs",
      "safetyEnabled", "decisionPoints"];
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
    // Decisions reach the browser through the Host projection
    // `ctx.sessionProjections` (see src/trail.mjs), not through session events:
    // DSH's persistence path refuses unknown event types, so the old
    // `plugin/observation` rows silently stopped appearing. The projection key is
    // read here and rendered as a Trajectory row.
    const TRAIL_KEY = "memoryPilotTrail";
    // The decision model answers a questionnaire whose option ids are opaque
    // (`recall_gate`, `scope_global`, `q0`). Showing them verbatim made the
    // Trajectory read like an internal log dump. These maps turn each question
    // and option into the decision it actually stands for; anything unmapped
    // still renders verbatim so a new question name is never silently hidden.
    const QUESTION_LABELS = {
      recall_gate: "要不要查记忆",
      retrieval_mode: "查法",
      scope_global: "查哪个范围",
      scope_project: "查哪个范围",
      scope_workspace: "查哪个范围",
      scope_personal: "查哪个范围",
      retention_gate: "要不要记住",
      resident_target: "记到哪里",
      write_target: "写到哪里",
    };
    const CHOICE_LABELS = {
      none: "不查", memory: "要查", recall: "快速检索", deep: "深度回溯",
      skip: "不查", query: "查", discard: "不记", retain: "记住",
      external: "外部记忆库", user: "USER", "global-memory": "全局 MEMORY",
      "project-memory": "项目 MEMORY",
      // Non-memory subjects. A new decision point that shares a verb with these
      // reuses the label; one that invents a verb falls back to the raw choice,
      // which is readable enough and avoids guessing a translation.
      safe: "可执行", confirm: "先确认", proceed: "继续", ask: "询问用户",
      split: "拆解", whole: "不拆",
    };
    const OPERATION_LABELS = { search: "检索", deep: "深度检索", write: "写入" };
    const SCOPE_LABELS = { global: "全局", project: "项目", workspace: "工作区", personal: "个人" };
    // Scope questions all read "查哪个范围" in a row, which is unreadable: the
    // user cannot tell which answer belongs to which store. Name the scope in
    // the question itself.
    const SCOPE_OF_QUESTION = { scope_global: "全局", scope_project: "项目", scope_workspace: "工作区", scope_personal: "个人" };
    const questionLabel = name => (SCOPE_OF_QUESTION[name] ? `${SCOPE_OF_QUESTION[name]}记忆` : (QUESTION_LABELS[name] || name));
    // Backend ids are internal (`legacy-memos-global`, `hs-repository`). Show a
    // readable name and keep the id out of the user's way.
    const backendLabel = id => {
      const value = String(id || "unknown").replace(/^legacy-/, "");
      if (/memos/i.test(value)) return "MemOS";
      if (/hindsight|hs-/i.test(value)) return "Hindsight";
      return value;
    };
    // Option ids like q0/q1 index the authorized candidates rather than naming
    // them, so map an index back to the backend it stands for when possible.
    const choiceLabel = (name, choice, entry) => {
      if (CHOICE_LABELS[choice]) return CHOICE_LABELS[choice];
      // Scope questions answer with a candidate index (q0, q1, …). Resolve it
      // against the candidates the questionnaire offered; fall back to the
      // action list for entries recorded before candidates were published.
      const index = Number(String(choice).replace(/^[a-z]+/, ""));
      const candidate = Array.isArray(entry?.candidates) ? entry.candidates[index] : undefined;
      if (candidate?.backend) return `${backendLabel(candidate.backend)}（${SCOPE_LABELS[candidate.scope] || candidate.scope}）`;
      const action = Array.isArray(entry?.actions) && Number.isFinite(index) ? entry.actions[index] : undefined;
      if (action?.backend) return `${backendLabel(action.backend)}（${SCOPE_LABELS[action.scope] || action.scope}）`;
      return choice;
    };

    /**
     * Render one decision trail entry as readable lines.
     *
     * The question is the user's own text, and the answers/actions/executions are
     * the plugin's own trace, so this needs no untrusted-input handling beyond
     * the flattening the Host already did.
     *
     * @param entry - one entry from the published trail projection.
     * @returns the block of text shown in the Trajectory row.
     */
    function trailText(entry) {
      if (!entry) return "";
      const status = entry.status === "ok" ? "完成"
        : entry.status === "noop" ? "未调用记忆"
        : entry.status === "denied" ? "被策略拒绝"
        : entry.status === "timeout" ? "超时"
        : entry.status === "disabled" ? "未启用" : "失败";
      // A compact headline, then only the sections that carry information. The
      // row used to be one dense paragraph with raw questionnaire ids, which
      // read as a log dump rather than a decision record.
      // Lead with the answer to the only question a reader actually has:
      // did it consult memory, and did that succeed? Everything below is detail.
      const readAny = Array.isArray(entry.executions) ? entry.executions.length : 0;
      const wrote = Array.isArray(entry.executions) && entry.executions.some(row => row.operation === "write");
      const summary = entry.status !== "ok" ? status
        : readAny === 0 ? "未调用记忆（判定不需要）"
        : wrote ? `已调用记忆：查询 ${readAny} 个库并写入`
        : `已调用记忆：查询 ${readAny} 个库，命中 ${number((entry.executions || []).reduce((sum, row) => sum + (Number.isFinite(row.hitCount) ? row.hitCount : 0), 0))} 条`;
      const lines = [`**${summary}** · ${entry.protocol}/${entry.model} · 判定耗时 ${seconds(entry.decisionDurationMs)}`];
      if (entry.question) lines.push(`> ${entry.question}`);
      if (Array.isArray(entry.answers) && entry.answers.length) {
        // One line per question, named by the decision it stands for.
        lines.push("", "**决策**");
        for (const answer of entry.answers) {
          const confidence = Number.isFinite(answer.confidence) ? ` · ${Math.round(answer.confidence * 100)}%` : "";
          lines.push(`- ${questionLabel(answer.name)}：${choiceLabel(answer.name, answer.choice, entry)}${confidence}`);
        }
      }
      if (Array.isArray(entry.actions) && entry.actions.length) {
        lines.push("", "**动作**");
        for (const action of entry.actions) {
          lines.push(`- ${OPERATION_LABELS[action.operation] || action.operation} · ${SCOPE_LABELS[action.scope] || action.scope} · ${backendLabel(action.backend)}`);
        }
      } else if (entry.status === "noop") {
        // "No action" has several very different causes, and the generic line
        // hid all of them — the most common being that no backend was usable at
        // all, which is a configuration problem, not a model decision.
        lines.push("", {
          "no-capabilities": "没有可用的记忆后端（未配置可读写的作用域绑定），本轮未查询也未写入。",
          "no-actions-allowed": "本轮动作数量上限为 0，未查询也未写入。",
          "budget-exhausted": "本轮在预算内未完成，未产出动作。",
        }[entry.reason] || "模型判定无需记忆操作。");
      } else if (entry.status === "timeout") {
        lines.push("", "本轮在时间预算内未完成，已中止（记忆不可用，但对话继续）。");
      } else if (entry.status === "error") {
        lines.push("", "本轮记忆流程出错（详见上方日志），对话继续。");
      }
      if (Array.isArray(entry.executions) && entry.executions.length) {
        lines.push("", "**执行**");
        for (const row of entry.executions) {
          // Say what the backend did in words: a bare `ok` hid whether anything
          // was actually found or written.
          const what = row.operation === "write"
            ? (row.status === "ok" ? "已写入" : row.status === "deduplicated" ? "重复，已跳过" : "写入失败")
            : (row.status === "ok"
                ? `${Number.isFinite(row.hitCount) ? `命中 ${number(row.hitCount)} 条` : "已检索"}${Number.isFinite(row.droppedLowRelevance) && row.droppedLowRelevance > 0 ? `，另有 ${number(row.droppedLowRelevance)} 条不相关已丢弃` : ""}`
                : "检索失败");
          lines.push(`- ${backendLabel(row.backend)}（${SCOPE_LABELS[row.scope] || row.scope}）：${what} · ${seconds(row.durationMs)}`);
          // Show what came back, so a reader can judge relevance instead of
          // trusting a bare hit count.
          if (typeof row.preview === 'string' && row.preview.trim()) lines.push(`  > ${row.preview.trim().slice(0, 280)}`);
        }
      }
      if (entry.injectedChars > 0) lines.push("", `注入主模型 ${number(entry.injectedChars)} 字符`);
      return lines.join("\n");
    }

    const CSS = `
.mp-section{box-sizing:border-box;display:flex;width:100%;max-width:820px;min-width:0;margin:0 auto;padding:2px 0 36px;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary)}
.mp-tabs{display:flex;overflow-x:auto;border-bottom:1px solid var(--dsw-alias-border-l2)}.mp-tab{flex:none;padding:9px 15px;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;cursor:pointer}.mp-tab-on{border-bottom-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-label-primary)}
.mp-summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}.mp-stat{padding:12px 14px;border-right:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:12px}.mp-stat:last-child{border-right:0}.mp-stat strong{display:block;color:var(--dsw-alias-label-primary);font-size:17px}
.mp-card{display:flex;min-width:0;flex-direction:column;gap:11px;padding:14px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}.mp-card-head,.mp-row,.mp-actions{display:flex;min-width:0;align-items:center;gap:10px;flex-wrap:wrap}.mp-card-head h2,.mp-card h3{margin:0;flex:1;font-size:14px}.mp-list{display:flex;flex-direction:column;gap:9px}.mp-system{display:grid;grid-template-columns:minmax(120px,1fr) 100px minmax(160px,1.4fr) max-content;align-items:center;gap:10px;padding:11px 13px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-1)}.mp-name{font-weight:650;overflow:hidden;text-overflow:ellipsis}.mp-muted,.mp-help{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px;overflow-wrap:anywhere}.mp-ok{color:var(--dsw-alias-state-success-primary)}.mp-warn,.mp-error{color:var(--dsw-alias-state-error-primary)}
.mp-field{display:flex;min-width:180px;flex:1;flex-direction:column;gap:5px;color:var(--dsw-alias-label-secondary);font-size:12px}.mp-control{box-sizing:border-box;width:100%;min-height:34px;padding:0 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}.mp-check{display:flex;align-items:center;gap:6px;font-size:12px}.mp-secret{display:flex;min-width:0;flex-direction:column;gap:5px}.mp-secret-row{display:flex;min-width:0;align-items:center;gap:6px}.mp-secret-row .mp-control{flex:1;min-width:0;font-family:var(--dsw-font-family-mono,monospace)}.mp-btn{box-sizing:border-box;display:inline-flex;min-height:32px;align-items:center;justify-content:center;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}.mp-btn-primary{border-color:transparent;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}.mp-btn-link{min-height:auto;padding:2px 4px;border:0;color:var(--dsw-alias-label-secondary)}.mp-btn:disabled{opacity:.45;cursor:default}.mp-actions{justify-content:flex-end}.mp-route-filters{display:grid;grid-template-columns:minmax(220px,1fr) 140px minmax(150px,1fr);gap:9px}.mp-table-wrap{width:100%;overflow-x:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-1)}.mp-table{width:100%;min-width:760px;border-collapse:collapse;font-size:12px}.mp-table th,.mp-table td{padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);text-align:left;vertical-align:middle}.mp-table th{color:var(--dsw-alias-label-secondary);font-weight:600}.mp-table tbody tr:last-child td{border-bottom:0}.mp-table-actions{display:flex;align-items:center;gap:6px;white-space:nowrap}.mp-scope-label{white-space:nowrap}.mp-tree-toggle{border:0;background:transparent;color:inherit;cursor:pointer;font:inherit}.mp-tree-child td:first-child{padding-left:30px}.mp-tree-leaf td:first-child{padding-left:52px}
.mp-adv{border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-1)}.mp-adv-head{display:flex;width:100%;min-height:40px;align-items:center;gap:8px;padding:0 11px;border:0;background:transparent;color:inherit;font:inherit;cursor:pointer}.mp-adv-body{display:flex;flex-direction:column;gap:11px;padding:12px;border-top:1px solid var(--dsw-alias-border-l1)}
.mp-empty{display:flex;max-width:520px;margin:0 auto;padding:44px 24px;flex-direction:column;align-items:center;text-align:center;gap:10px}
.mp-empty-icon{display:flex;width:44px;height:44px;align-items:center;justify-content:center;border-radius:50%;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);font-size:20px}
.mp-empty-title{margin:0;color:var(--dsw-alias-label-primary);font-size:14px;font-weight:650}
.mp-empty-body{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.7}
.mp-empty-list{display:flex;margin:6px 0 0;padding:12px 16px;flex-direction:column;gap:7px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-2);list-style:none;text-align:left}
.mp-empty-list li{position:relative;padding-left:14px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6}
.mp-empty-list li:before{position:absolute;left:0;color:var(--dsw-alias-label-tertiary);content:"·"}
.mp-empty-note{margin:4px 0 0;color:var(--dsw-alias-label-tertiary);font-size:11px}
.mp-view{box-sizing:border-box;display:flex;width:100%;max-width:1000px;min-width:0;margin:0 auto;padding:16px 20px 40px;flex-direction:column;color:var(--dsw-alias-label-primary);font:var(--dsw-font-xs-13,13px)/1.5 system-ui,sans-serif}
.mp-log{display:flex;min-width:0;flex-direction:column;gap:12px}
.mp-log-head{display:flex;align-items:baseline;gap:10px}.mp-log-head h2{margin:0;font-size:15px;font-weight:650}.mp-log-sub{color:var(--dsw-alias-label-tertiary);font-size:12px}
.mp-chips{display:flex;gap:7px;overflow-x:auto;padding-bottom:2px;scrollbar-width:none}.mp-chips::-webkit-scrollbar{display:none}.mp-chip{flex:none;padding:4px 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}.mp-chip:hover{background:var(--dsw-alias-interactive-bg-hover)}.mp-chip-on{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary)}
.mp-table-wrap{width:100%;overflow-x:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.mp-table.mp-decisions{width:100%;min-width:720px;border-collapse:collapse;font-size:12px}
.mp-table.mp-decisions th,.mp-table.mp-decisions td{padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);text-align:left;vertical-align:middle}
.mp-table.mp-decisions th{color:var(--dsw-alias-label-secondary);font-weight:600;white-space:nowrap}
.mp-table.mp-decisions tbody tr:last-child td{border-bottom:0}.mp-table.mp-decisions tbody tr:hover td{background:var(--dsw-alias-bg-layer-2)}
.mp-dec-q{max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mp-dec-opt{max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:11px}
.mp-dec-act{width:64px;text-align:right}
.mp-tag{display:inline-block;padding:1px 7px;border-radius:5px;font-size:11px;font-weight:600;white-space:nowrap;line-height:18px}
.mp-k-read{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-state-business-primary);border:1px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 30%,transparent)}
.mp-k-deep{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 16%,transparent);color:var(--dsw-alias-state-business-primary)}
.mp-k-write{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 16%,transparent);color:var(--dsw-alias-state-success-primary)}
.mp-k-tool{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l2)}
.mp-k-skip{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);border:1px solid var(--dsw-alias-border-l1)}
.mp-k-bad{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 14%,transparent);color:var(--dsw-alias-state-error-primary)}
.mp-good{color:var(--dsw-alias-state-success-primary)}.mp-warn,.mp-bad{color:var(--dsw-alias-state-error-primary)}.mp-muted{color:var(--dsw-alias-label-tertiary)}
.mp-btn{box-sizing:border-box;display:inline-flex;min-height:30px;align-items:center;justify-content:center;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}.mp-btn-link{min-height:auto;padding:3px 6px;border:0;color:var(--dsw-alias-state-business-primary)}
.mp-drawer-layer{position:fixed;inset:0;z-index:60;display:flex;justify-content:flex-end}
.mp-drawer-scrim{position:absolute;inset:0;background:rgba(0,0,0,.32);animation:mpFade .14s ease-out}
.mp-drawer{position:relative;display:flex;width:min(520px,100vw);max-width:100%;height:100%;flex-direction:column;background:var(--dsw-alias-bg-layer-1);border-left:1px solid var(--dsw-alias-border-l2);box-shadow:var(--dsw-shadow-lv3);animation:mpSlide .18s cubic-bezier(.2,.8,.2,1)}
@keyframes mpFade{from{opacity:0}to{opacity:1}}@keyframes mpSlide{from{transform:translateX(16px);opacity:.6}to{transform:none;opacity:1}}
.mp-drawer-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:14px 16px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.mp-drawer-close{width:30px;height:30px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:14px;cursor:pointer}.mp-drawer-close:hover{background:var(--dsw-alias-interactive-bg-hover)}
.mp-drawer-body{display:flex;flex-direction:column;gap:16px;padding:16px;overflow-y:auto;flex:1;min-height:0}
.mp-block{display:flex;flex-direction:column;gap:7px}.mp-block-title{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:650}
.mp-plain{margin:0;color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.7;overflow-wrap:anywhere}
.mp-grid{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;overflow:hidden;background:var(--dsw-alias-bg-layer-2)}
.mp-grid-row{display:grid;grid-template-columns:minmax(110px,1fr) minmax(70px,auto) 44px minmax(80px,1fr);align-items:center;gap:9px;padding:7px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12px}.mp-grid-row:last-child{border-bottom:0}
.mp-grid-key{color:var(--dsw-alias-label-secondary)}.mp-grid-choice{color:var(--dsw-alias-label-primary);font-weight:650}.mp-grid-conf{color:var(--dsw-alias-label-tertiary);font-family:var(--dsw-font-family-mono,monospace)}.mp-grid-alt{color:var(--dsw-alias-label-tertiary);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mp-exec{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:7px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-size:12px}.mp-exec-target{color:var(--dsw-alias-label-primary)}.mp-exec-time{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-family:var(--dsw-font-family-mono,monospace)}
.mp-quote{margin:0;padding:8px 11px;border-left:2px solid var(--dsw-alias-border-l2);border-radius:0 6px 6px 0;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.65;overflow-wrap:anywhere}
.mp-note{margin:0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.6}
.mp-point-editor{display:flex;flex-direction:column;gap:8px;margin-top:10px}
.mp-json{box-sizing:border-box;width:100%;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:12px/1.6 var(--dsw-font-family-mono,monospace);resize:vertical}
.mp-empty{display:flex;max-width:460px;margin:0 auto;padding:56px 20px;flex-direction:column;align-items:center;text-align:center;gap:9px}
.mp-empty-icon{display:flex;width:42px;height:42px;align-items:center;justify-content:center;border-radius:50%;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);font-size:18px}
.mp-empty-title{margin:4px 0 0;color:var(--dsw-alias-label-primary);font-size:14px;font-weight:650}
.mp-empty-body{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.7}
.mp-empty-list{display:flex;width:100%;margin:4px 0 0;padding:12px 14px;flex-direction:column;gap:6px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-2);list-style:none;text-align:left}
.mp-empty-list li{position:relative;padding-left:13px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6}
.mp-empty-list li:before{position:absolute;left:2px;color:var(--dsw-alias-label-tertiary);content:"·"}
.mp-empty-note{margin:2px 0 0;color:var(--dsw-alias-label-tertiary);font-size:11px}
@media (max-width:600px){
 .mp-view{padding:12px 12px 32px}
 .mp-table.mp-decisions{min-width:0;font-size:12px}
 .mp-table.mp-decisions thead{display:none}
 .mp-table.mp-decisions tbody tr{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:4px 10px;padding:11px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}
 .mp-table.mp-decisions tbody tr td{padding:0;border:0}
 .mp-dec-q{white-space:normal;max-width:none;grid-column:1/-1;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}
 .mp-dec-opt{grid-column:1/-1;max-width:none;white-space:normal}
 .mp-dec-act{grid-column:2;grid-row:1;justify-self:end}
 .mp-drawer{width:100vw;border-left:0}
 .mp-grid-row{grid-template-columns:1fr auto;gap:4px 8px}
 .mp-grid-alt{grid-column:1/-1}
}
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
      // `secretValues` carries the stored secrets the settings view must omit;
      // dropping it here would leave a remote editor with empty password boxes.
      const accept = (view) => publish({ status: "ready", value: view.value, secretValues: view.secretValues, revision: view.revision, writable: view.writable === true, mode: "remote" });
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
    // Never resolve to `null` on timeout: every caller treats null as "no data",
    // so a slow probe looked like a dead button. This settles with an explicit
    // failure the caller can show, and only after a budget a real local MemOS
    // bridge (measured ~7.5 s for one search) fits inside.
    function withTimeout(promise, ms = 20000) {
      return Promise.race([promise, new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`超过 ${Math.round(ms / 1000)} 秒没有响应`)), ms))]);
    }
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
    // Compute the settings ops for a save. Extracted from the page component so
    // the secret-handling rule can be tested directly: the settings view the
    // draft was seeded from omits every `role('secret')` field, so a naive
    // "field differs from original" comparison both invents a change and writes
    // an empty string over a stored key. Secrets are therefore compared against
    // the values the Host reported, never against the redacted view — and an
    // empty box means "leave it alone", not "clear it".
    function savePlan({ draft, original, storedSecret, storedSystemSecrets, backends }) {
      const ops = [];
      const stored = storedSystemSecrets || {};
      for (const key of SCALAR_FIELDS) {
        if (key === "decisionApiKey") continue;
        if (JSON.stringify(draft[key]) !== JSON.stringify((original || {})[key])) ops.push({ op: "set", path: [key], value: draft[key] });
      }
      const typed = typeof draft.decisionApiKey === "string" ? draft.decisionApiKey : "";
      if (typed !== "" && typed !== (storedSecret || "")) ops.push({ op: "set", path: ["decisionApiKey"], value: typed });
      // A binding the draft never received a key for keeps the stored one, so
      // editing an unrelated field cannot silently clear a backend secret.
      // The persisted rows are redacted too, so they get the same backfill
      // before comparison — otherwise every save looks like a backend change.
      const withStoredKeys = rows => (rows || []).map(item => ({ ...item, apiKey: item.apiKey || stored[item.id] || "" }));
      const merged = withStoredKeys(backends);
      if (JSON.stringify(withStoredKeys((original || {}).backends)) !== JSON.stringify(merged)) ops.push({ op: "set", path: ["backends"], value: merged });
      if (JSON.stringify(draft.scopeOverrides || []) !== JSON.stringify((original || {}).scopeOverrides || [])) ops.push({ op: "set", path: ["scopeOverrides"], value: draft.scopeOverrides || [] });
      return ops;
    }

    // A stored secret never rides the redacted settings view, so this control
    // cannot simply be an <input type="password"> bound to the draft: it would
    // always render empty and look exactly like "the save did not work".
    //
    // Behaviour: an existing key is reported as stored and stays masked; the
    // eye reveals the real value (which the Host does send for these fields
    // only); typing replaces it. Clearing the box means "leave it alone", and
    // a separate button removes it — a password box cannot express "empty".
    function SecretInput({ value, stored, onChange, placeholder, label }) {
      const [revealed, setRevealed] = React.useState(false);
      const current = typeof value === "string" ? value : "";
      const dirty = current !== (typeof stored === "string" ? stored : "");
      const filled = Boolean(current);
      const hint = dirty
        ? "已修改，保存后生效。"
        : filled ? "已保存。点右侧按钮可查看明文。" : (stored ? "已保存。" : "尚未设置，可留空。");
      return h("div", { className: "mp-secret" },
        h("div", { className: "mp-secret-row" },
          h("input", {
            className: "mp-control", type: revealed ? "text" : "password",
            value: current, placeholder: placeholder || "可留空",
            "aria-label": label || "密钥", autoComplete: "off", spellCheck: false,
            onChange: e => onChange(e.target.value),
          }),
          h(Button, { onClick: () => setRevealed(open => !open), disabled: !filled, primary: false },
            revealed ? "隐藏" : "显示")),
        h("span", { className: dirty ? "mp-muted" : "mp-help" }, hint));
    }

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
    function SystemModal({ value, onSave, onClose, storedSecretFor = () => "" }) {
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
            h(Field, { label: "密钥" }, h(SecretInput, { value: draft.apiKey, stored: storedSecretFor(draft.id), onChange: set("apiKey"), label: `${draft.id || "记忆系统"}密钥`, placeholder: "可留空" }))
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
      // Secret values as persisted on the Host. They are not part of the
      // redacted settings view, so they ride `secretValues` on the RPC row.
      const [storedSecret, setStoredSecret] = React.useState("");
      const [storedSystemSecrets, setStoredSystemSecrets] = React.useState({});
      const [systemResults, setSystemResults] = React.useState({});
      const [discovery, setDiscovery] = React.useState({ status: "idle", value: null });
      const [expanded, setExpanded] = React.useState({});
      const [editingScope, setEditingScope] = React.useState(null);
      const [resident, setResident] = React.useState({ status: "idle", value: null });
      const [residentTarget, setResidentTarget] = React.useState("soul");
      const [residentContent, setResidentContent] = React.useState("");
      const [residentSaving, setResidentSaving] = React.useState(false);
      const [residentMessage, setResidentMessage] = React.useState("");
      const [residentProjectPath, setResidentProjectPath] = React.useState("");
      const [creatingBank, setCreatingBank] = React.useState(null);
      const [bankMessage, setBankMessage] = React.useState("");
      const decisionTest = useConnectionTest(form);
      const systemTest = useConnectionTest(form);
      // keep the latest runner reachable from buttons rendered inside map()
      decisionTest.runRef = React.useRef(null); decisionTest.runRef.current = () => {
        const budget = Math.round(Number(draft.budgetMs)), capture = Math.round(Number(draft.captureBudgetMs));
        if (Number.isFinite(budget) && (budget < 100 || budget > 30000)) { setMessage("预算数值超出允许范围。"); return; }
        // Probe the configuration the runtime would actually use: if the draft
        // carries no key (never touched since load), fall back to the stored one
        // so the button validates the real endpoint instead of a keyless request.
        void decisionTest.run("decision", {
          ...draft,
          decisionApiKey: draft.decisionApiKey || storedSecret,
        });
      };
      // Per-system probe state, keyed by system id: one row's test must never
      // disable or overwrite another's outcome.
      const runSystemTest = async system => {
        const id = system.id;
        setSystemResults(current => ({ ...current, [id]: { name: system.name || id, status: "running", result: null } }));
        const result = await form.test("system", { ...system, keyEnv: system.keyEnv || "",
          apiKey: system.apiKey || storedSystemSecrets[system.id] || "" });
        setSystemResults(current => ({ ...current, [id]: { name: system.name || id, status: "done", result } }));
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
      React.useEffect(() => { if (active !== "resident" || !draft || resident.status === "ready" || resident.status === "empty" || resident.status === "failed") return; let live = true; const projectPath = residentTarget === "project-memory" ? selectedResidentPath : undefined; if (residentTarget === "project-memory" && !projectPath) { setResident({status:"empty",value:null}); return; } setResident(current => ({ status: "loading", value: current.value })); void withTimeout(form.residentGet(projectPath)).catch(() => null).then(value => { if (!live) return; setResident({ status: value ? "ready" : "failed", value }); const selected = residentDocumentOptions(value).find(item => item.target === residentTarget); setResidentContent(selected?.document.content || ""); }); return () => { live = false; }; }, [active, draft, form, resident.status, residentTarget, selectedResidentPath]);
      React.useEffect(() => { if (resident.status === "ready") { const selected = residentDocumentOptions(resident.value).find(item => item.target === residentTarget); setResidentContent(selected?.document.content || ""); setResidentMessage(""); } }, [residentTarget]);
      // Seed the editable draft from the settings view. Every `role('secret')`
      // field is absent from that view (the platform deletes it), so backfill
      // the values the Host sent separately. Without this the draft has no key,
      // the password box renders empty after a successful save, and the "test"
      // probe sends a keyless request.
      React.useEffect(() => {
        if (snap.status !== "ready" || snap.revision === revision) return;
        const value = JSON.parse(JSON.stringify(snap.value || {}));
        const secrets = snap.secretValues || {};
        const projected = projectBackends(value.backends);
        if (secrets.decisionApiKey !== undefined) value.decisionApiKey = secrets.decisionApiKey;
        for (const system of projected.systems) {
          if (system.apiKey || !secrets.backends) continue;
          system.apiKey = secrets.backends[system.id] ?? "";
        }
        setRevision(snap.revision);
        setStoredSecret(typeof secrets.decisionApiKey === "string" ? secrets.decisionApiKey : "");
        setStoredSystemSecrets(secrets.backends && typeof secrets.backends === "object" ? secrets.backends : {});
        setDraft({ ...value, systems: projected.systems, routes: projected.routes });
        setMessage("");
      }, [snap, revision]);
      if (snap.status !== "ready" || !draft) return h("section", { className: "mp-section" }, h("style", null, CSS), h("p", null, snap.status === "loading" ? t("loading") : t("unavailable")));
      const set = key => next => setDraft(current => ({ ...current, [key]: next }));
      const updateSystem = system => setDraft(current => { const exists = current.systems.some(item => item.id === editing?.id); return { ...current, systems: exists ? current.systems.map(item => item.id === editing.id ? system : item) : [...current.systems, system], routes: editing?.id && editing.id !== system.id ? current.routes.map(route => route.systemId === editing.id ? { ...route, systemId: system.id } : route) : current.routes }; });
      const removeSystem = id => { if (!confirm("确定删除该记忆系统吗？它的所有范围绑定也会一并移除。")) return; setDraft(current => ({ ...current, systems: current.systems.filter(item => item.id !== id), routes: current.routes.filter(route => route.systemId !== id) })); if (editing?.id === id) setEditing(null); };
      const save = async () => {
        const budget = Math.round(Number(draft.budgetMs)), capture = Math.round(Number(draft.captureBudgetMs));
        if (!Number.isFinite(budget) || budget < 100 || budget > 30000 || !Number.isFinite(capture) || capture < 100 || capture > 300000) { setMessage("预算数值超出允许范围。"); return; }
        const backends = flattenBackends(draft.systems, draft.routes, draft);
        if (backends.some(item => !item.scopeId || !/^[a-zA-Z0-9_-]+$/.test(item.id))) { setMessage("请为使用中的项目/工作区设置可识别路径或手动标识，并检查系统标识。"); return; }
        const ops = savePlan({
          draft: { ...draft, budgetMs: budget, captureBudgetMs: capture },
          original: snap.value || {}, storedSecret, storedSystemSecrets, backends,
        });
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
            h(Field, { label: "密钥" },
              h(SecretInput, { value: draft.decisionApiKey, stored: storedSecret, onChange: set("decisionApiKey"), label: "决策模型密钥", placeholder: "可留空" }))
          ),
          h("p", { className: "mp-help" }, draft.decisionProtocol === "openai" ? "旧的生成式 JSON 决策方式。" : "调用原生 POST /systemone；模型只在程序生成的已授权记忆动作中做结构化选择。"),
          h("div", { className: "mp-row" },
            h(TestButton, { test: { ...decisionTest, canRun: Boolean(draft.decisionBaseUrl && draft.decisionModel), runRef: decisionTest.runRef } }),
            h(TestResult, { test: decisionTest })
          )
        ),
        h(DecisionPointsCard, { draft, set })
      );
      if (active === "systems") page = h("div", { className: "mp-card" },
        h("div", { className: "mp-card-head" },
          h("h2", null, "记忆系统"),
          h(Button, { onClick: () => setEditing({ id: "", name: "", type: "hindsight", baseUrl: "", home: "", agent: "", keyEnv: "", apiKey: "", cookieEnv: "", isolatedStore: false }) }, "添加系统")),
        h("p", { className: "mp-help" }, "卡片只展示连接摘要；底层字段在编辑弹窗中维护。测试按钮探测该系统连接（只读，不写任何记忆）。"),
        h("div", { className: "mp-list" }, draft.systems.map(system => {
          const state = systemResults[system.id];
          const running = state?.status === "running";
          return h("div", { className: "mp-system", key: system.id },
            h("span", { className: "mp-name" }, system.name || system.id),
            h("span", null, systemEditorView(system).displayType === "memos" ? "MemOS" : "Hindsight"),
            h("span", { className: "mp-muted" }, systemConnectionSummary(system)),
            h(Button, { onClick: () => setEditing(system) }, "编辑"),
            h(Button, { onClick: () => removeSystem(system.id) }, "删除"),
            // One shared probe state used to disable every row while any single
            // test ran, and only the last result was shown — with more than one
            // system the button looked dead and the outcome was ambiguous.
            h(Button, { disabled: running, onClick: () => runSystemTest(system) }, running ? "测试中…" : "测试"));
        })),
        !draft.systems.length ? h("p", { className: "mp-muted" }, "尚未添加记忆系统。") : null,
        h("div", { className: "mp-list" }, draft.systems.map(system => {
          const state = systemResults[system.id];
          if (!state || state.status !== "done" || !state.result) return null;
          const { ok, warning, detail } = state.result;
          return h("p", { key: `result-${system.id}`, className: ok ? (warning ? "mp-warn" : "mp-ok") : "mp-error", role: "status" },
            `${state.name || system.name || system.id}：${detail || (ok ? "连接正常" : "测试失败")}`);
        }))
      );
      if (active === "scope") {
        const discoveryProjection = scopeDiscoveryProjection(discovery.value, expanded);
        const discoveredRows = discoveryProjection.rows;
        const globalRows = discoveryProjection.globalBindings;
        const toggleExpanded = key => setExpanded(current => ({ ...current, [key]: !current[key] }));
        const overrideFor = row => (draft.scopeOverrides || []).find(item => item.scope === row.scope && item.scopeId === row.scopeId);
        const effectiveRow = row => { const override = overrideFor(row); return override ? { ...row, ...override, hasOverride: true, autoBank: row.autoBank || row.bank || "" } : { ...row, enabled: true, hasOverride: false, autoBank: row.autoBank || row.bank || "" }; };
        const discoveryStatus = row => row.enabled === false ? "已关闭" : row.exists === true ? "已存在" : row.exists === false ? "尚未创建" : discovery.status === "loading" ? "检测中" : discovery.status === "failed" || row.exists === null ? "连接失败" : discovery.status === "unavailable" ? "未配置" : "正常";
        const discoveryPermission = row => [row.read ? "读" : "", row.write ? "写" : ""].filter(Boolean).join(" / ") || "—";
        // A destination bank that does not exist yet is the single most common
        // reason a scope silently returns nothing: the backend answers 404 and the
        // retrieval is folded into an `error` status with no text. The server has
        // always implemented `create-bank`, but nothing ever called it, so the only
        // remedy was hand-provisioning the bank outside DSH. Creating it is now a
        // button on the row that reports the gap.
        const canCreateBank = row => row.exists === false && Boolean(row.systemId) && Boolean(row.bank) && typeof form.createBank === "function";
        const createBankFor = async row => {
          setCreatingBank(row.key);
          const ok = await form.createBank(row.systemId, row.bank);
          setCreatingBank(null);
          setBankMessage(ok ? `已创建库 ${row.bank}。` : `无法创建库 ${row.bank}；请检查该连接的地址与权限。`);
          if (ok) await refreshDiscovery();
        };
        const discoveryAction = row => h("span", { className: "mp-table-actions" },
          canCreateBank(row) ? h(Button, { disabled: creatingBank === row.key, onClick: () => void createBankFor(row) }, creatingBank === row.key ? "创建中…" : "创建库") : null,
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
          // A timeout now rejects rather than resolving null, so failures are
          // caught here and reported instead of surfacing as an unhandled error.
          const result = await withTimeout(form.residentPut(selected.target, residentContent, selected.document.revision, selected.target === "project-memory" ? selectedResidentPath : undefined)).catch(() => null);
          if (!result) { setResidentSaving(false); setResidentMessage("保存失败或超时；文档可能已被其他会话修改，请重新加载。"); return; }
          const value = await withTimeout(form.residentGet(selected.target === "project-memory" ? selectedResidentPath : undefined)).catch(() => null);
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
      return h("section", { className: "mp-section" }, h("style", null, CSS), h("div", { className: "mp-tabs", role: "tablist", "aria-label": "MemoryPilot 配置", onKeyDown: tabKey }, TABS.map(item => h("button", { key: item[0], type: "button", role: "tab", "aria-selected": active === item[0], tabIndex: active === item[0] ? 0 : -1, className: `mp-tab${active === item[0] ? " mp-tab-on" : ""}`, onClick: () => setActive(item[0]) }, item[1]))), !snap.writable ? h("p", { className: "mp-warn" }, t("readOnly")) : null, h("div", { role: "tabpanel" }, page), h("div", { className: "mp-actions" }, message ? h("span", { className: message === t("saved") ? "mp-ok" : "mp-error" }, message) : null, h(Button, { primary: true, disabled: saving || !snap.writable, onClick: save }, saving ? t("saving") : t("save"))), editing ? h(SystemModal, { value: editing, storedSecretFor: id => storedSystemSecrets[id] || "", onClose: () => setEditing(null), onSave: system => { updateSystem(system); setEditing(null); } }) : null, editingScope ? h(ScopeModal, { value: editingScope, systems: draft.systems, banks: discovery.value?.banks || [], onClose: () => setEditingScope(null), onSave: override => { setDraft(current => ({ ...current, scopeOverrides: upsertScopeOverride(current.scopeOverrides, override) })); setEditingScope(null); }, onRestore: () => { setDraft(current => ({ ...current, scopeOverrides: removeScopeOverride(current.scopeOverrides, editingScope.scope, editingScope.scopeId) })); setEditingScope(null); } }) : null);
    }


    /**
     * The decision points a user may tune.
     *
     * Built-in points are shown read-only except for their criteria text and their
     * automation tier, because those are the two things that change accuracy and
     * consent. Everything else about a point is structural and belongs to whoever
     * declared it. Custom points are edited as JSON: a form for an arbitrary
     * questionnaire would be a bigger surface than the declaration itself, and the
     * declaration is already the documentation.
     */
    function DecisionPointsCard({ draft, set }) {
      const [editing, setEditing] = React.useState(null);
      const [error, setError] = React.useState("");
      const custom = Array.isArray(draft.decisionPoints) ? draft.decisionPoints : [];
      const tiers = [["silent", "自动执行"], ["silent-visible", "自动执行，记录可见"], ["ask", "先询问我"]];
      const save = text => {
        try {
          const parsed = JSON.parse(text);
          if (!Array.isArray(parsed)) throw new Error("必须是一个数组");
          setError("");
          set("decisionPoints")(parsed);
          setEditing(null);
        } catch (cause) { setError(cause instanceof Error ? cause.message : "JSON 解析失败"); }
      };
      const rows = [
        { name: "memory.read", label: "记忆查询", note: "判断这条消息要不要查记忆、查哪个范围" },
        { name: "memory.write", label: "记忆录入", note: "判断这条消息有没有值得记住的内容" },
        { name: "command.safety", label: "命令安全", note: "判断本轮操作能否直接执行，还是先问你" },
      ];
      return h("div", { className: "mp-card" },
        h("div", { className: "mp-card-head" },
          h("h2", null, "判断能力"),
          h(Check, { checked: draft.safetyEnabled !== false, onChange: set("safetyEnabled"), label: "启用命令安全判断" })),
        h("p", { className: "mp-help" }, "每个判断点都是对一个封闭问题的选择。判据写清楚了它才判得准——同一句命令，判据模糊时会判错。"),
        h("div", { className: "mp-table-wrap" },
          h("table", { className: "mp-table" },
            h("thead", null, h("tr", null, h("th", null, "判断"), h("th", null, "用途"), h("th", null, "自动化程度"))),
            h("tbody", null, rows.map(row => h("tr", { key: row.name },
              h("td", null, h("span", { className: "mp-tag mp-k-read" }, row.label)),
              h("td", { className: "mp-dec-q" }, row.note),
              h("td", null, h("span", { className: "mp-muted" }, row.name === "command.safety" ? (draft.safetyEnabled !== false ? "先询问我" : "已关闭") : "自动执行"))))))),
        h("div", { className: "mp-row", style: { marginTop: "10px" } },
          h(Button, { onClick: () => { setError(""); setEditing(JSON.stringify(custom, null, 2)); } }, "编辑自定义判断点"),
          custom.length ? h("span", { className: "mp-help" }, `已配置 ${custom.length} 个`) : h("span", { className: "mp-help" }, "暂无自定义判断点")),
        editing !== null ? h("div", { className: "mp-point-editor" },
          h("textarea", { className: "mp-json", value: editing, spellCheck: false, rows: 14, onChange: event => setEditing(event.target.value) }),
          h("p", { className: "mp-help" }, "每个判断点需要 name、trigger、automation、questions（含至少两个选项的 criteria）和 actions。改动保存后生效。"),
          error ? h("p", { className: "mp-warn" }, error) : null,
          h("div", { className: "mp-row" },
            h(Button, { onClick: () => save(editing) }, "保存"),
            h(Button, { onClick: () => { setEditing(null); setError(""); } }, "取消"),
            h(Button, { onClick: () => setEditing(JSON.stringify([...custom, {
              name: "my.check", trigger: "before-turn", automation: "silent-visible",
              questions: { ask: { instructions: "判断这个问题。", criteria: { no: "不需要。", yes: "需要。" } } },
              actions: { ask: { no: "proceed", yes: "ask" } },
            }], null, 2)) }, "加一个示例"))) : null);
    }

    // A general decision table: one row per thing the decision model was asked,
    // whatever the subject. Columns are type, the question it answered, the
    // options offered, the choice made, and a detail action. Reading and writing
    // memory are separate rows of the same table because they are separate
    // decisions about the same message.
    // Classified by the judging concern, not by the memory verbs it happens to
    // use. A command-safety entry is a command-safety entry whether or not it
    // touched memory.
    const DECISION_KINDS = {
      "memory.read": ["记忆查询", "mp-k-read"], "memory.write": ["记忆录入", "mp-k-write"],
      "command.safety": ["命令安全", "mp-k-tool"], "task.routing": ["任务拆解", "mp-k-tool"],
    };
    const FALLBACK_KIND = ["其他判断", "mp-k-skip"];
    const decisionKindOf = entry => {
      const subject = typeof entry.subject === "string" && entry.subject ? entry.subject : null;
      if (subject) {
        // A capture row is a write even though its subject says memory.
        if (entry.capture) return "memory.write";
        return Object.prototype.hasOwnProperty.call(DECISION_KINDS, subject) ? subject : "other";
      }
      const rows = Array.isArray(entry.executions) ? entry.executions : [];
      if (entry.capture) return "memory.write";
      if (rows.some(row => row.operation === "write")) return "memory.write";
      return rows.length ? "memory.read" : "other";
    };
    const decisionOutcomeOf = entry => {
      if (entry.capture) return entry.capture.stored > 0 ? [`已存入 ${entry.capture.stored} 个库`, "mp-good"] : ["未留存", "mp-muted"];
      if (entry.status !== "ok" && entry.status !== "noop") return ["失败", "mp-bad"];
      const rows = Array.isArray(entry.executions) ? entry.executions : [];
      if (rows.some(row => row.operation === "write")) return ["已写入", "mp-good"];
      const hits = rows.reduce((sum, row) => sum + (Number.isFinite(row.hitCount) ? row.hitCount : 0), 0);
      if (rows.length) return hits > 0 ? [`命中 ${hits} 条`, "mp-good"] : ["无相关结果", "mp-warn"];
      // A judgment that authorizes an action but has no memory execution behind it
      // is still a result: report what was decided, not that nothing happened.
      const answers = Array.isArray(entry.answers) ? entry.answers : [];
      const last = answers[answers.length - 1];
      if (last && typeof last.choice === "string") {
        const label = choiceLabel(last.name, last.choice, entry);
        return [String(label), "mp-good"];
      }
      return entry.status === "noop" ? ["判定不需要", "mp-muted"] : ["无结果", "mp-muted"];
    };

    function DecisionDetail({ entry, onClose }) {
      React.useEffect(() => {
        const onKey = event => { if (event.key === "Escape") onClose(); };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
      }, [onClose]);
      const rows = Array.isArray(entry.executions) ? entry.executions : [];
      const options = entry.questionOptions || {};
      return h("div", { className: "mp-drawer-layer", role: "presentation" },
        h("div", { className: "mp-drawer-scrim", onClick: onClose }),
        h("aside", { className: "mp-drawer", role: "dialog", "aria-modal": "true", "aria-label": "决策详情" },
          h("header", { className: "mp-drawer-head" },
            h("strong", null, `第 ${entry.turn ?? "?"} 轮${entry.capture ? " · 轮末写入" : ` · 第 ${entry.step ?? "?"} 步`}`),
            h("button", { type: "button", className: "mp-drawer-close", "aria-label": "关闭", onClick: onClose }, "✕")),
          h("div", { className: "mp-drawer-body" },
            h("section", { className: "mp-block" },
              h("div", { className: "mp-block-title" }, "问题"),
              h("p", { className: "mp-plain" }, String(entry.question || "（未记录）"))),
            entry.capture ? h("section", { className: "mp-block" },
              h("div", { className: "mp-block-title" }, "写入"),
              h("p", { className: "mp-plain" }, `成功 ${entry.capture.stored} 个库${entry.capture.failed ? `，失败 ${entry.capture.failed} 个` : ""}。`),
              h("p", { className: "mp-note" }, "写入由留存策略判断，与检索判定相互独立。")) : null,
            (entry.answers || []).length ? h("section", { className: "mp-block" },
              h("div", { className: "mp-block-title" }, "判定"),
              h("div", { className: "mp-grid" }, (entry.answers || []).map(answer => {
                const alts = (options[answer.name] || []).map(opt => choiceLabel(answer.name, opt, entry));
                return h("div", { key: answer.name, className: "mp-grid-row" },
                  h("span", { className: "mp-grid-key" }, questionLabel(answer.name)),
                  h("span", { className: "mp-grid-choice" }, choiceLabel(answer.name, answer.choice, entry)),
                  Number.isFinite(answer.confidence) ? h("span", { className: "mp-grid-conf" }, `${Math.round(answer.confidence * 100)}%`) : h("span", null),
                  h("span", { className: "mp-grid-alt" }, alts.length ? alts.join(" / ") : "—"));
              }))) : null,
            rows.length ? h("section", { className: "mp-block" },
              h("div", { className: "mp-block-title" }, "实际执行"),
              rows.map((row, i) => h("div", { key: i, className: "mp-exec" },
                h("span", { className: `mp-tag ${row.status === "ok" ? "mp-k-read" : "mp-k-bad"}` }, OPERATION_LABELS[row.operation] || row.operation),
                h("span", { className: "mp-exec-target" }, `${backendLabel(row.backend)} · ${SCOPE_LABELS[row.scope] || row.scope}`),
                Number.isFinite(row.hitCount) ? h("span", { className: "mp-good" }, `命中 ${row.hitCount} 条`) : null,
                Number.isFinite(row.droppedLowRelevance) ? h("span", { className: "mp-warn" }, `丢弃 ${row.droppedLowRelevance} 条`) : null,
                h("span", { className: "mp-exec-time" }, `${((row.durationMs || 0) / 1000).toFixed(1)}s`)))) : null,
            rows.filter(row => typeof row.preview === "string" && row.preview.trim()).map((row, i) =>
              h("blockquote", { key: `p${i}`, className: "mp-quote" }, row.preview.trim().slice(0, 400))),
            Number.isFinite(entry.injectedChars) && entry.injectedChars > 0
              ? h("p", { className: "mp-note" }, `注入主模型 ${entry.injectedChars} 字符`) : null,
            entry.reason === "inferred" ? h("p", { className: "mp-note" }, "重建自会话日志：当时未记录判定过程，只保留执行结果。") : null)));
    }

    function DecisionLog({ face, t }) {
      const [kindFilter, setKindFilter] = React.useState("all");
      const [detail, setDetail] = React.useState(null);
      const snapshot = face && typeof face.getSnapshot === "function" ? useSnapshot(face) : null;
      const entries = snapshot?.entries ?? [];

      if (!entries.length) return h("div", { className: "mp-empty" },
        h("div", { className: "mp-empty-icon", "aria-hidden": "true" }, "◎"),
        h("h3", { className: "mp-empty-title" }, "还没有决策记录"),
        h("p", { className: "mp-empty-body" }, "MemoryPilot 每次收到消息都会判断：要不要查记忆、要不要把这条记住。结果会实时显示在这里。"),
        h("ul", { className: "mp-empty-list" },
          h("li", null, "需要回忆上下文：「我们上次改了什么」"),
          h("li", null, "提供新的稳定事实：「以后叫我阿宝」"),
          h("li", null, "纠正旧信息：「不对，那个端口是 8009」")),
        h("p", { className: "mp-empty-note" }, "只记录插件启用后产生的消息；更早的历史不会回溯。"));
      const counts = { all: entries.length };
      for (const entry of entries) { const k = decisionKindOf(entry); counts[k] = (counts[k] || 0) + 1; }
      const shown = entries.filter(entry => kindFilter === "all" ? true : decisionKindOf(entry) === kindFilter);
      const FILTERS = [["all", "全部"], ...Object.keys(DECISION_KINDS), "other"]
        .filter(key => key === "all" || counts[key])
        .map(key => [key, key === "all" ? "全部" : (DECISION_KINDS[key] || FALLBACK_KIND)[0]]);

      return h("div", { className: "mp-log" },
        h("div", { className: "mp-log-head" },
          h("h2", null, "决策记录"),
          h("span", { className: "mp-log-sub" }, `${entries.length} 次判断`)),
        h("div", { className: "mp-chips", role: "tablist", "aria-label": "按类型筛选" },
          FILTERS.map(([key, label]) => h("button", { key, type: "button", role: "tab", "aria-selected": kindFilter === key,
            className: `mp-chip${kindFilter === key ? " mp-chip-on" : ""}`, onClick: () => setKindFilter(key) }, `${label} ${counts[key]}`))),
        h("div", { className: "mp-table-wrap" },
          h("table", { className: "mp-table mp-decisions" },
            h("thead", null, h("tr", null,
              h("th", null, "类型"), h("th", null, "问题"), h("th", null, "选项"), h("th", null, "结果"), h("th", null, ""))),
            h("tbody", null, shown.map(entry => {
              const id = entry.id || `${entry.turn}:${entry.step}`;
              const [kindLabel, kindClass] = DECISION_KINDS[decisionKindOf(entry)] || FALLBACK_KIND;
              const [outcome, outcomeClass] = decisionOutcomeOf(entry);
              const first = (entry.answers || [])[0];
              const options = entry.questionOptions || {};
              const offered = first ? (options[first.name] || []).map(opt => choiceLabel(first.name, opt, entry)) : [];
              const chosen = first ? choiceLabel(first.name, first.choice, entry) : entry.capture ? "轮末写入" : "—";
              return h("tr", { key: id },
                h("td", null, h("span", { className: `mp-tag ${kindClass}` }, kindLabel)),
                h("td", { className: "mp-dec-q" }, String(entry.question || "（未记录）").slice(0, 110)),
                h("td", { className: "mp-dec-opt" }, offered.length ? offered.join(" / ") : "—"),
                h("td", null, h("span", { className: outcomeClass }, outcome)),
                h("td", { className: "mp-dec-act" }, h("button", { type: "button", className: "mp-btn mp-btn-link",
                  onClick: () => setDetail(entry) }, "详情")));
            })))),
        detail ? h(DecisionDetail, { entry: detail, onClose: () => setDetail(null) }) : null);
    }
    const inject = ["slots", "locale", "configForms", "connection", "uiConversation", "sessions"];
    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      // Decisions reach the browser through the Host projection
      // `ctx.sessionProjections` (src/trail.mjs), not through session events:
      // DSH's persistence path refuses unknown event types, which is why the old
      // `plugin/observation` rows silently stopped appearing. The projection is
      // published per Session, so this component subscribes to that Session's
      // Trajectory rows for memory decisions.
      //
      // The Trajectory partner renders only its own built-in cell kinds, and its
      // `buildViewNode` context carries no Session identity, so this definition
      // cannot read the per-Session projection. It therefore renders a `context`
      // cell whose text is looked up from a cache keyed by turn and step: every
      // projection change for any visible Session refreshes that cache, and a
      // decision is identified by the step that produced it.
      const trailTexts = new Map();
      const refreshTrailTexts = () => {
        trailTexts.clear();
        // `sessions.list` is a SnapshotStore, and its `ids` is the catalog membership
        // (the only reliable list; retained subagent fallbacks are not in it).
        const ids = ctx.sessions?.list?.getSnapshot?.()?.ids ?? [];
        for (const id of ids) {
          const session = ctx.sessions.binding?.(id)?.session;
          const entries = session?.projections?.faceOf?.(TRAIL_KEY)?.getSnapshot?.()?.entries ?? [];
          for (const entry of entries) trailTexts.set(`${entry.turn}:${entry.step}`, trailText(entry));
        }
      };
      ctx.effect(() => ctx.uiConversation.events.register({
        kind: "memory-pilot-decision",
        target: "trajectory",
        // Every step is a candidate anchor; a step whose decision never arrived
        // returns null below and produces no row.
        match(event) { return event?.type === "step/start" ? { id: `mp:${event.data?.turn}:${event.data?.step}`, role: "update" } : null; },
        start(_context, match) { return { turn: match.event.data?.turn ?? 0, step: match.event.data?.step ?? 0, seq: match.event.seq, time: match.event.time }; },
        update(context, match) { return { turn: match.event.data?.turn ?? 0, step: match.event.data?.step ?? 0, seq: match.event.seq, time: match.event.time }; },
        buildViewNode(context) {
          const state = context.state;
          if (state === undefined) return null;
          refreshTrailTexts();
          const text = trailTexts.get(`${state.turn}:${state.step}`);
          if (text === undefined) return null;
          return { key: context.key, kind: context.kind, id: context.id, target: "trajectory",
            anchorSeq: state.seq, location: context.start?.location || { kind: "unresolved" },
            data: { kind: "node", node: { kind: "context", seq: state.seq, time: state.time,
              content: [{ type: "text", text }],
              source: { kind: "plugin:dsh-memory-pilot" },
              producer: { role: "inject", label: "MemoryPilot" }, form: null } } };
        },
      }), "dsh-memory-pilot: decision trail");
      const nativeForm = ctx.configForms.get(ENTRY);
      // Secrets the platform never sends through a settings view. Fetched once
      // and refreshed after a save, so the password box can show a stored key
      // and the connection probe can reuse it.
      let secretValues;
      const loadSecrets = async () => {
        try {
          const result = await ctx.connection.rpc.call(SETTINGS_RPC_CHANNEL, "get", {});
          if (result?.ok === true && result.value?.secretValues) secretValues = result.value.secretValues;
        } catch { /* the panel falls back to an empty box */ }
      };
      void loadSecrets();
      // The native config form speaks the platform vocabulary, whose views are
      // redacted: `role('secret')` fields are deleted and only `secrets:[{path,set}]`
      // remains. That is why a stored key rendered as an empty box on loopback —
      // the one case the local UI always hits. Merge the Host's own secret
      // readback into every snapshot so both transports agree.
      const withSecrets = () => {
        const snapshot = nativeForm.getSnapshot();
        return { ...snapshot, ...(secretValues ? { secretValues } : {}) };
      };
      const form = ctx.connection.isLoopback ? { getSnapshot: () => withSecrets(), subscribe: listener => nativeForm.subscribe(listener), mutate: async ops => { const ok = await nativeForm.mutate(ops); await loadSecrets(); return ok; }, async discover() { try { const result = await ctx.connection.rpc.call(SETTINGS_RPC_CHANNEL, "discover", {}); return result?.ok ? result.value : null; } catch { return null; } }, async createBank(systemId, bank) { try { const result = await ctx.connection.rpc.call(SETTINGS_RPC_CHANNEL, "create-bank", { systemId, bank }); return result?.ok === true; } catch { return false; } }, async test(kind, config) { try { const result = await ctx.connection.rpc.call(SETTINGS_RPC_CHANNEL, "test", { kind, config }); return result?.ok === true ? result.value : { ok: false, detail: result?.error?.message || "测试失败" }; } catch (error) { return { ok: false, detail: error instanceof Error ? error.message : "测试失败" }; } }, ...residentRpc(ctx.connection) } : createRemoteForm(ctx.connection);
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-memory-pilot: dictionaries");
      // A sibling of Chat and Trajectory, not a replacement for either. The
      // Trajectory row answers "what happened in this step"; this view answers
      // "what has the gate been asked across the Session, and what did it pick" —
      // the question a reader has when checking whether memory is working at all.
      ctx.slots.inject("conversation.view", () => ctx.slots.register({
        name: "conversation.view",
        id: "memory-pilot",
        order: 20,
        label: () => "记忆决策",
        locale: NS,
        inject: sessionId => {
          const binding = ctx.sessions.binding?.(sessionId);
          const session = binding?.session;
          // Hand over the projection itself, not a one-shot array: the view has
          // to keep following decisions that arrive after it mounts, and a plain
          // array captured at registration time stays empty forever.
          return { face: session?.projections?.faceOf?.(TRAIL_KEY) ?? null, t };
        },
        // The view lives on a different slot than the settings page, so it has to
        // carry its own stylesheet: nothing else injects these rules there, which
        // is why the table rendered unstyled.
      }, props => h("section", { className: "mp-view" }, h("style", null, CSS), h(DecisionLog, { face: props.face, t: props.t }))));
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
    exports.trailText = trailText;
    exports.TRAIL_KEY = TRAIL_KEY;
    exports.residentDocumentOptions = residentDocumentOptions;
    exports.savePlan = savePlan;
    return module.exports;
  },
});
