# MemoryPilot

Decision-driven memory orchestration for [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness).

**English** | [简体中文](README.zh-CN.md)

MemoryPilot decides when an agent needs cross-session memory, which authorized scope to query, and what is worth retaining. It is an orchestration layer—not a memory database. Storage identities and permissions remain under server control.

## Why MemoryPilot?

A memory backend can store and search data, but an agent still needs a policy for **when**, **where**, and **how** to use it. MemoryPilot provides that policy layer across multiple backends and scopes.

Typical use cases:

- Recall repository decisions, constraints, failed attempts, and milestones.
- Preserve stable user preferences and standing instructions across workspaces.
- Share selected knowledge across repositories in one DSH workspace.
- Route different scopes to different memory systems.
- Avoid unconditional retrieval on self-contained requests.
- Keep memory failures from interrupting the main agent task.

## Features

- Decision-driven recall and retention with SystemOne or an OpenAI-compatible JSON endpoint.
- `global`, `workspace`, `project`, and `personal` memory scopes.
- Fast `recall` and deeper `reflect` retrieval modes.
- Independent read/write permissions for every backend binding.
- Native `memory_retrieve` and `memory_remember` agent tools.
- Web configuration with live updates and connection tests.
- Fail-open execution with bounded latency, output size, and audit metadata.

## Compatibility

| Component | Supported | Limitations |
| --- | --- | --- |
| Node.js | `>=22` | Earlier versions are unsupported |
| DeepSeek Harness | `@deepseek-ai/dsh-llm` and `dsh-tools` `>=0.2.0-rc.2 <0.3.0` | Compatibility with DSH `0.3.x` is not implied |
| [Hindsight](https://github.com/vectorize-io/hindsight) | search, reflect, and write through the standard HTTP API | Each binding uses a fixed bank; writes may be asynchronous |
| [MemOS local bridge](https://github.com/MemTensor/MemOS/tree/main/apps/memos-local-plugin) | search and write through `memos-local-plugin` stdio JSON-RPC | Requires a local plugin installation |
| MemOS local HTTP | search through the local-plugin Viewer API | Search-only; requires a dedicated, isolated instance |
| MemOS Server / Cloud | Not supported | Cube and Cloud APIs require dedicated adapters |

The MemOS adapters target `@memtensor/memos-local-plugin`, the local core shared by Hermes, OpenClaw, and DSH integrations. They do not implement the self-hosted Cube API or MemOS Cloud API.

## Requirements

- Node.js 22 or later
- An initialized DeepSeek Harness Web profile
- A decision endpoint:
  - SystemOne: `POST /v1/systemone`
  - OpenAI-compatible: `POST /v1/chat/completions` with JSON mode
- At least one supported memory backend

## Quick start

### 1. Install

```sh
dsh plugin --profile web add github:youluo1230/dsh-memory-pilot#v0.3.8
```

### 2. Enable

Add `dsh-memory-pilot` to `dsh.profile.bundles` in the Web profile's `package.json`:

```json
{
  "dsh": {
    "profile": {
      "bundles": ["dsh-memory-pilot"]
    }
  }
}
```

Restart DSH Web unless the profile uses `patchReload: "live"`.

### 3. Configure

Open **Settings → Memory Orchestration (MemoryPilot)** and configure:

1. **Decision model** — protocol, API root, model, and credential environment variable.
2. **Memory systems** — Hindsight or MemOS local-plugin connections.
3. **Scopes** — map global, workspace, or repository memory to a configured system.
4. **Advanced settings** — retrieval and background-capture budgets.
5. Enable MemoryPilot.

Configuration changes are applied live. For file-based configuration, start from [`examples/cordis-patch-minimal.yml`](examples/cordis-patch-minimal.yml).

### 4. Verify

In the MemoryPilot settings page:

- Run the decision-model and memory-system connection tests.
- Confirm that MemoryPilot shows as enabled.
- In a new session, ask a history-dependent question such as: “Why did we choose the current approach for this repository?” A self-contained question may correctly produce no retrieval.

## MemOS local setup

Install the official local plugin if you want to use `memos-bridge`:

```sh
curl -fsSL https://raw.githubusercontent.com/MemTensor/MemOS/main/apps/memos-local-plugin/install.sh \
  | bash -s -- --agent dsh --profile web
```

Review remote installation scripts before running them. The bridge defaults to `$DSH_HOME/memos-plugin` (normally `~/.dsh/memos-plugin`). Set `home` explicitly only for a legacy Hermes installation or another custom location.

Do not enable both MemoryPilot-managed MemOS capture and another automatic MemOS DSH plugin for the same store unless duplicate recall and retention are intentional.

## Resident memory

MemoryPilot complements dynamic backends with a small session-start snapshot:

| File | Scope | Maintenance |
| --- | --- | --- |
| `$DSH_HOME/SOUL.md` | DSH profile | Human-only agent identity and tone |
| `$DSH_HOME/memory/USER.md` | Global | Human editing and controlled agent upserts |
| `$DSH_HOME/memory/MEMORY.md` | Global | Human editing and controlled agent upserts |
| `$DSH_HOME/memory/projects/<project-key>/MEMORY.md` | Git repository | Human editing and controlled agent upserts |

The snapshot is frozen for a session; changes take effect in the next session. `SOUL.md` contributes trusted persona instructions. USER and MEMORY documents are bounded, untrusted memory data. Automated writes are restricted to a marked managed section and cannot overwrite human-authored notes.

The decision model sees resident memory when deciding whether external retrieval is still needed. For explicit retention, it chooses one authorized target: user profile, global resident memory, project resident memory, or an external backend. It never receives file paths and cannot write `SOUL.md`.

Edit these documents in **Settings → MemoryPilot → Resident memory**.

## How it works

```text
session event
    │
    ▼
capability inventory → decision model → plan validation
    │                                      │
    └──────── authorized actions only ─────┘
                           │
                           ▼
             bounded execution and rendering
                           │
                           ▼
                 untrusted memory context
```

1. MemoryPilot derives the active identity and authorized capabilities from server-side configuration.
2. The decision model chooses only among those capabilities.
3. The orchestrator validates backend, scope, permission, and write evidence.
4. Valid actions run within a shared deadline.
5. Retrieved text is size-bounded and injected as untrusted context; execution metadata is recorded separately.

## Scope model

| Scope | Intended use |
| --- | --- |
| `global` | Stable preferences, standing instructions, and cross-workspace history |
| `workspace` | Knowledge shared by repositories in one DSH workspace |
| `project` | Decisions, constraints, attempts, and milestones for the current Git repository |
| `personal` | Private, user-specific long-term memory |

Workspace membership comes from DSH. Project identity is detected from the nearest Git repository under the session `cwd`. See [`GLOSSARY.md`](GLOSSARY.md) for precise terminology.

## Agent tools

- **`memory_retrieve`** — retrieves prior memory when a task needs missing historical facts or rationale. In `auto` mode, SystemOne selects recall versus reflection and the relevant scopes.
- **`memory_remember`** — requests retention of an explicit decision, stable preference, verified fact, or milestone. Policy still determines whether and where it is stored.

Credentials, hidden reasoning, transient logs, and unverified claims must not be retained.

## Security model

- Default deny: only explicitly configured bindings enter the capability inventory.
- Storage identities are server-bound; the model cannot choose arbitrary scope IDs, banks, namespaces, or URLs.
- Read and write permissions are evaluated independently.
- Write actions require evidence from the current event.
- Retrieved content is treated as untrusted data and bounded before injection.
- Invalid plans, timeouts, and backend failures degrade to no memory action.
- Credentials should be supplied through `decisionKeyEnv`, `keyEnv`, or `cookieEnv`, not committed to configuration files.

## Limitations

- Memory writes may be asynchronous and are not guaranteed to be immediately searchable.
- Deduplication is process-local; there is no persistent outbox or cross-backend transaction.
- The MemOS HTTP adapter is search-only and compatible only with the local-plugin Viewer API.
- A decision-service outage disables memory for that turn; it does not trigger unconditional fallback retrieval.

## Development

```sh
pnpm install
npm test
npm run check
```

Live smoke tests require a configured DSH host. See `test/plugin-smoke.mjs` and the scripts under `scripts/` for their environment requirements.

## License

[MIT](LICENSE)
