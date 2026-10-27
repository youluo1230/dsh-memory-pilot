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

## Decision layer

The part of the plugin that runs a questionnaire against a narrow-judgment model and turns validated answers into actions. It supplies transport, capability detection, ordering, timeout, and recording, and it does not know what any individual decision is about.

## Decision point

A configurable unit that binds a trigger location to a judging concern. A decision point declares what state the judgment may see, which questions it asks, and what action each answer authorizes. Decision points are the extension unit: adding a new capability means adding a decision point, not editing the decision layer.

## Questionnaire

The set of closed-choice questions a decision point puts to the judgment model, each with its criteria. A questionnaire is answered in one request when its questions are independent.

## Judgment subject

The concern a decision point judges, named as `domain.concern` (for example `memory.read`, `command.safety`). A subject is what the record and the viewer classify by.

## Automation tier

How a decision point's answer is acted on, ordered from most to least autonomous: silent execution, silent execution with after-the-fact visibility, and asking the user. An author sets the default; a user may tighten it but not loosen it, because loosening admits misjudgments the author did not design for.

## Judged state

The bounded data a decision point may show the judgment model. Judged state is an explicit allowlist — typically the current message plus the candidate set — and never the whole conversation history, because a narrow model has no reasoning to spend and long state dilutes its criteria.

## Retrieval admission

The first decision point, judging whether the current user request needs memory and, if so, which retrieval mode and enabled scopes may run. A no-retrieval answer takes precedence over all subordinate mode and scope decisions.

## Recall

A lightweight, latency-bounded retrieval that returns relevant stored observations or traces. Recall is suitable for routine automatic retrieval.

## Reflect

A slower, deeper synthesis over memory intended for questions that require historical reasoning, rationale, or aggregation. Reflect is distinct from recall and must be selected deliberately rather than used as an automatic fallback.

## Turn capture

The asynchronous recording of one completed user-to-assistant turn, including eligible tool activity, into global shared memory. Turn capture records the conversation stream; it is not a model-selected durable fact write and does not imply that repository memory must also be updated.

## Resident memory

A small, bounded memory snapshot loaded at the beginning of a session and kept unchanged for that session. Resident memory contains a global user profile, global facts, and repository facts. It is data rather than instruction and is distinct from dynamically retrieved external memory.

## Soul

A user-authored, profile-wide description of the agent's identity, tone, and persona. Soul is instruction, not memory. It is never an automatic retention target and has no repository-specific variant.

## User profile

Cross-project resident memory about the user's stable identity, preferences, communication style, and working habits. It does not contain repository rules or detailed historical events.

## Resident fact

A concise fact that must remain visible without retrieval. A resident fact may be global or repository-scoped. Detailed history and experience belong in an external memory system.

## Managed memory entry

A resident-memory entry maintained by MemoryPilot inside an explicitly marked section of a user-editable file. Automated retention may add or replace a managed entry but never rewrites human-authored text outside that section.
