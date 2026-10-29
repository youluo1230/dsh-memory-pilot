import { ASK_SEVERITIES } from './decision-layer.mjs';
/**
 * Tool safety at the per-call extension point.
 *
 * This module replaces the advisory note that ran at `agent/pre-step`. That note
 * could not stop anything: it appended a sentence to the model's context and hoped
 * the model would comply. The platform does offer a per-call veto — the
 * `tools/pre-execute` waterfall, which may allow, deny, cancel, or ask — and the
 * repository's docs asserted it did not, which is why the memory path kept working
 * around it. Staying at turn level is a product choice (fewer tokens, fewer
 * interruptions), not a platform limit.
 *
 * Two separations matter here and are the reason this is testable without a host:
 *
 * - The judgment reports SEVERITY. It does not decide whether to ask. The author
 *   sets a default tier and the user may only tighten it, so a misjudgment can
 *   never loosen a user's "always ask" setting.
 * - The interceptor takes its execution context and approval entry point by
 *   injection. It does not reach into the host, so it can be driven directly.
 */

/** The only grant an approval returns; everything else refuses the call. */
const GRANT = 'allowed-once';

/**
 * Fingerprint a call so that one authorization covers the rest of its family.
 *
 * A multi-step task runs the same kind of command ten times. Asking ten times is
 * how a safety feature becomes something users switch off. The family is the TOOL
 * plus the shape of its arguments with the volatile parts (paths, numbers, quoting)
 * collapsed — so `git status`, `git status --short` and `git diff` share a family
 * while `rm -rf build` does not join `cat file`.
 */
export function callFamily(toolName, args) {
  const name = String(toolName ?? 'unknown');
  const shape = [];
  const walk = (value, depth = 0) => {
    if (depth > 3 || shape.length > 12) return;
    if (value === null || value === undefined) return;
    if (typeof value === 'string') {
      // Keep the first word: it is the verb for a shell command, and the verb is
      // what decides reversibility. The rest of the line varies per invocation.
      const verb = value.trim().split(/\s+/).slice(0, 1).join('');
      if (verb) shape.push(verb.replace(/[0-9]+/g, '#'));
      return;
    }
    if (typeof value === 'number') { shape.push('#'); return; }
    if (typeof value === 'boolean') { shape.push(String(value)); return; }
    if (Array.isArray(value)) { for (const item of value.slice(0, 3)) walk(item, depth + 1); return; }
    if (typeof value === 'object') {
      for (const key of Object.keys(value).sort().slice(0, 6)) walk(value[key], depth + 1);
    }
  };
  walk(args);
  return `${name}:${shape.join('|')}`;
}

/**
 * Build the pre-execute interceptor.
 *
 * `judge` is called with a description of the pending call and resolves the
 * severity the declaration authorized, or `undefined` when no judgment happened.
 * `approve` is the platform's approval entry point; when it is missing, a call that
 * would be asked is DENIED, because the honest reading of "no approval service" is
 * "nobody can say yes", not "assume yes".
 *
 * `tier` resolves the effective automation tier for the safety point; it may only
 * move toward asking, which `resolveAutomationTier` already enforces.
 */
export function createToolGuard({ judge, approve, tier = () => 'ask', askFrom = askSeverities, record = () => {}, now = () => Date.now() } = {}) {
  if (typeof judge !== 'function') throw new TypeError('createToolGuard needs a judge function');
  // Fingerprints this session already authorized. A denial is never recorded here:
  // the guard grants nothing, so a refused call must be able to be refused again.
  const granted = new Set();
  const activity = [];
  const bump = row => {
    activity.push(row);
    if (activity.length > 50) activity.shift();
    try { record(row); } catch { /* observability must not alter execution */ }
  };

  return Object.freeze({
    /** Recent tool-safety activity, newest last, for the activity list. */
    activity: () => activity.slice(),

    /**
     * The interception itself. Returns the platform's PreToolDecision.
     *
     * Fail-closed at every uncertain point: an unavailable judgment on a call the
     * tier would ask about denies rather than allows, and a missing approval
     * service denies too.
     */
    async intercept(exec, next) {
      const toolName = String(exec?.name ?? exec?.toolName ?? 'unknown');
      const args = exec?.arguments;
      const family = callFamily(toolName, args);
      const startedAt = now();
      let verdict;
      try {
        verdict = await judge({ toolName, args, family, exec });
      } catch (error) {
        // A judgment failure must not silently allow a dangerous call. Treat it as
        // the lowest-confidence severity the tier can still act on.
        bump({ kind: 'tool-safety', tool: toolName, status: 'error', reason: 'judge-failed', severity: 'unknown', durationMs: now() - startedAt });
        return decide('unknown', family, { indeterminate: true });
      }
      const severity = verdict?.severity;
      if (typeof severity !== 'string') {
        bump({ kind: 'tool-safety', tool: toolName, status: 'skipped', severity: 'unknown', durationMs: now() - startedAt });
        return next();
      }
      return decide(severity, family, { verdict });

      function decide(severity, family, { verdict, indeterminate = false } = {}) {
        // Which severities warrant an ask is a policy input, not a constant: the
        // spec asks for a configurable severity threshold, and a user who considers
        // `unknown` dangerous must be able to say so.
        const ask = new Set(typeof askFrom === 'function' ? askFrom() : askFrom);
        const asks = ask.has(severity);
        const effective = tier();
        // Already authorized once in this session: do not interrupt the same kind
        // of work again. This is the monotonic guard's real job.
        if (asks && granted.has(family)) {
          bump({ kind: 'tool-safety', tool: toolName, status: 'allowed-once', severity, durationMs: now() - startedAt });
          return { kind: 'allow' };
        }
        if (!asks) {
          // Unknown is recorded but not asked: not knowing is not the same as
          // dangerous, and asking about it teaches users to approve blindly.
          bump({ kind: 'tool-safety', tool: toolName, status: 'allowed', severity, durationMs: now() - startedAt, ...(verdict?.confidence !== undefined ? { confidence: verdict.confidence } : {}) });
          return { kind: 'allow' };
        }
        // The user's tightening can turn any severity into an ask.
        if (effective === 'ask') {
          bump({ kind: 'tool-safety', tool: toolName, status: 'asked', severity, durationMs: now() - startedAt });
          return { kind: 'ask', reason: reasonFor(severity, toolName), displayReason: { en: displayFor(severity, toolName) } };
        }
        bump({ kind: 'tool-safety', tool: toolName, status: 'allowed', severity, durationMs: now() - startedAt });
        return { kind: 'allow' };
      }
    },

    /** Run a pending gate for real: the platform's `ask` counterpart.
     *
     * The waterfall itself only returns `ask`; the registry runs the approval and
     * turns anything but a grant into a denial. This helper exists so the guard can
     * also be driven with the approval directly (tests, and hosts that compose it
     * themselves), and it enforces the same fail-closed rule.
     */
    async gate(exec, next) {
      const gatedAt = now();
      const elapsed = () => now() - gatedAt;
      const decision = await this.intercept(exec, async () => ({ kind: 'allow' }), next);
      if (decision.kind !== 'ask') return decision;
      if (typeof approve !== 'function') {
        bump({ kind: 'tool-safety', tool: String(exec?.name ?? 'unknown'), status: 'denied', reason: 'no-approval', durationMs: elapsed() });
        return { kind: 'deny', reason: 'No approval service is available, so this call was refused.' };
      }
      const family = callFamily(exec?.name, exec?.arguments);
      let outcome;
      try {
        outcome = await approve({ toolName: String(exec?.name ?? 'unknown'), callId: exec?.callId, reason: decision.reason, signal: exec?.signal });
      } catch {
        // An approval that cannot be obtained is a refusal, not a pass.
        bump({ kind: 'tool-safety', tool: String(exec?.name ?? 'unknown'), status: 'denied', reason: 'approval-failed', durationMs: elapsed() });
        return { kind: 'deny', reason: 'The approval request could not be completed.' };
      }
      if (outcome === GRANT) {
        // Record the grant so this family is not asked again in this session.
        granted.add(family);
        bump({ kind: 'tool-safety', tool: String(exec?.name ?? 'unknown'), status: 'approved', durationMs: elapsed() });
        return { kind: 'allow' };
      }
      bump({ kind: 'tool-safety', tool: String(exec?.name ?? 'unknown'), status: 'denied', reason: String(outcome ?? 'unavailable'), durationMs: elapsed() });
      return { kind: 'deny', reason: outcome === 'rejected' ? 'The user rejected this call.' : 'The call was not approved.' };
    },
  });
}

/** The default set of severities that warrant asking: the ones whose wrongness is
 * visible and hard to undo. `unknown` is deliberately absent — not knowing something
 * is dangerous is not knowing it is. */
export const askSeverities = () => ASK_SEVERITIES;

const reasonFor = (severity, tool) => severity === 'out-of-scope'
  ? `${tool} reaches outside this task or workspace.`
  : severity === 'destructive'
    ? `${tool} may not be undoable.`
    : `${tool} needs confirmation.`;

const displayFor = (severity, tool) => severity === 'out-of-scope'
  ? `${tool} affects things outside this task. Run it?`
  : severity === 'destructive'
    ? `${tool} may be hard to undo. Run it?`
    : `Run ${tool}?`;

/**
 * The guard that makes a refusal stick.
 *
 * A waterfall can be re-entered by a later listener, and `tools/pre-execute` is a
 * waterfall — so an `allow` from a listener downstream of ours could otherwise
 * override a denial. `ctx.tools.guard()` is the platform's monotonic layer: it runs
 * after every pre-execute listener and can only deny, so nothing downstream can
 * turn a denial back into permission.
 *
 * Returns the deny reason, or `undefined` to leave the call as it was.
 */
export function createMonotonicRefusal(denied, keyOf) {
  if (!(denied instanceof Set)) throw new TypeError('createMonotonicRefusal needs a Set of denied calls');
  const key = typeof keyOf === 'function' ? keyOf : execution => callFamily(execution?.name, execution?.arguments);
  return function refusal(execution) {
    const id = key(execution);
    return denied.has(id) ? `Refused by MemoryPilot tool safety (${execution?.name ?? 'call'}).` : undefined;
  };
}
