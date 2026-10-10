# MemoryPilot Glossary

## Memory system

An external memory service connection available to DSH. A memory system is configured with its type, base URL, and optional API key. It is not a user, agent, workspace, repository, or individual memory library.

## Memory library

A storage partition exposed by a memory system. Hindsight calls a memory library a bank. Memory libraries are discovered from the connected service rather than entered as connection details.

## Scope route

A rule that makes one or more memory libraries available in the global, workspace, or repository scope. A route may select a specific library, all libraries visible through the connection, or a dynamically named library derived from the workspace or repository.

## Global scope

Memory shared across all DSH workspaces and repositories. The configured memory service, not a user or agent identity, determines which libraries are visible.

## Workspace scope

Memory shared within one DSH workspace. A workspace may contain multiple repositories.

## Repository scope

Memory isolated to the nearest Git repository. Repository-scoped Hindsight routes can derive a bank name from the detected repository.

## Scope override

An explicit setting for one global, workspace, or repository scope that can disable its local memory route or replace the automatically selected memory system and memory library. Disabling a workspace or repository scope does not disable global memory or cascade to a more specific scope.

## Automatic library

The memory library derived from the current scope when no scope override selects another library. For Hindsight this is usually a bank derived from the workspace or repository name. A memory system that does not expose libraries has no automatic library selection.

## Retrieval admission

A decision made before automatic memory retrieval that determines whether the current user request needs memory and, if so, which retrieval mode and enabled scopes may run. A no-retrieval decision takes precedence over all subordinate mode and scope decisions.

## Recall

A lightweight, latency-bounded retrieval that returns relevant stored observations or traces. Recall is suitable for routine automatic retrieval.

## Reflect

A slower, deeper synthesis over memory intended for questions that require historical reasoning, rationale, or aggregation. Reflect is distinct from recall and must be selected deliberately rather than used as an automatic fallback.

## Turn capture

The asynchronous recording of one completed user-to-assistant turn, including eligible tool activity, into global shared memory. Turn capture records the conversation stream; it is not a model-selected durable fact write and does not imply that repository memory must also be updated.
