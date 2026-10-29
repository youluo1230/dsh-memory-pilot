/**
 * Memory landings: what a `memory.*` declaration's authorized verbs actually do.
 *
 * A landing is the seam between a declaration and a real effect. The declaration
 * says "choosing `memory` on `recall_gate` authorizes `route`"; this module decides
 * that `route` means "query whichever readable scopes the scope questions also
 * chose". It is the only place that knows memory vocabulary, and it reaches the
 * memory path only through the orchestrator the caller supplies.
 *
 * Nothing here restates a criterion. The questionnaire came from the declaration;
 * this file only reads answers.
 */

/** Resident-memory text as a digest the recall criterion can actually use.
 *
 * The point declares `residentDigest` because its criterion explicitly defers to
 * what resident memory already states. The host never supplied it, so the point was
 * answering "is this already in resident memory?" against a field that was always
 * absent. A digest is a bounded projection: the criteria only need to recognise
 * that a fact is already visible, not to read the file.
 */
export function residentDigestOf(resident) {
  if (!resident || typeof resident !== 'object') return undefined;
  const parts = [];
  const labels = { user: 'user', global: 'global-memory', project: 'project-memory' };
  for (const [scope, label] of Object.entries(labels)) {
    const value = resident[scope];
    if (typeof value !== 'string' || !value.trim()) continue;
    // Strip the managed-section markers, which carry no meaning to the model and
    // would otherwise eat the character budget the digest exists to respect.
    const body = value.replace(/<!--\s*memory-pilot:managed:(?:start|end)\s*-->/g, '')
      .replace(/<!--\s*id:\s*[^>]*?-->/g, '')
      .replace(/\s+/g, ' ').trim();
    if (body) parts.push(`[${label}] ${body}`);
  }
  if (!parts.length) return undefined;
  const digest = parts.join('\n');
  return { text: digest, scopes: parts.length };
}

/**
 * Build the memory-read landing.
 *
 * `readable` is the set of scopes the runtime can actually query, so the scope
 * questions ask only about scopes that could answer. `retrieve` is the function that
 * runs one query and returns text; `onActivity` records what happened for the
 * activity list.
 */
export function createReadLanding({ readableScopes = [], retrieve, onActivity = () => {} } = {}) {
  if (typeof retrieve !== 'function') throw new TypeError('createReadLanding needs a retrieve function');
  return async function readLanding({ verb, answers, signal }) {
    if (verb.verb !== 'route') return { verb: 'route', acted: false };
    const at = (name, choice) => answers.some(answer => answer.name === name && answer.choice === choice);
    // The mode is chosen by the declaration; `reflect` is the deeper one and
    // degrades to search inside the backend when the store has no reflect endpoint.
    const mode = at('retrieval_mode', 'reflect') ? 'reflect' : 'recall';
    const scopes = readableScopes.filter(scope => at(`scope_${scope}`, 'query'));
    if (!scopes.length) return { verb: 'route', acted: false, reason: 'no-scope-selected' };
    const startedAt = Date.now();
    try {
      const result = await retrieve({ scopes, mode, signal });
      onActivity({
        kind: 'query', status: result?.status === 'error' ? 'error' : 'ok',
        scopes, mode, durationMs: Date.now() - startedAt,
        hitCount: Number.isFinite(result?.hitCount) ? result.hitCount : undefined,
        ...(result?.reason ? { reason: result.reason } : {}),
      });
      return { verb: 'route', acted: true, scopes, mode, context: result?.context ?? '' };
    } catch (error) {
      // A failed retrieval used to be silent, so "no memory" and "memory broke"
      // looked the same to the user.
      onActivity({ kind: 'query', status: 'error', scopes, mode, durationMs: Date.now() - startedAt, reason: reasonOf(error) });
      throw error;
    }
  };
}

/** Build the memory-write landing.
 *
 * `writableScopes` is the set of scopes with a store behind them, and `retain` is
 * the call that performs one write. Writing is independent of reading, so this
 * landing never consults the read outcome.
 */
export function createWriteLanding({ writableScopes = [], retain, residentFull = () => false, onActivity = () => {} } = {}) {
  if (typeof retain !== 'function') throw new TypeError('createWriteLanding needs a retain function');
  return async function writeLanding({ verb, answers, signal, event }) {
    if (verb.verb !== 'store') return { verb: 'store', acted: false };
    const at = (name, choice) => answers.some(answer => answer.name === name && answer.choice === choice);
    const scopes = writableScopes.filter(scope => at(`write_scope_${scope}`, 'write'));
    if (!scopes.length) return { verb: 'store', acted: false, reason: 'no-scope-selected' };
    const results = [];
    for (const scope of scopes) {
      const startedAt = Date.now();
      try {
        const outcome = await retain({ scope, event, signal });
        results.push({ scope, ...outcome });
        onActivity({ kind: 'retain', status: 'ok', scopes: [scope], durationMs: Date.now() - startedAt, target: outcome?.target });
      } catch (error) {
        // Resident memory has a hard size limit. Hitting it must degrade to the
        // external store rather than lose the fact, because "the file is full" is
        // not a reason the user's correction should vanish.
        const degraded = residentFull(error) ? await degrade(scope, event, signal) : undefined;
        results.push({ scope, status: degraded ? 'degraded' : 'error', reason: reasonOf(error) });
        onActivity({ kind: 'retain', status: degraded ? 'degraded' : 'error', scopes: [scope], durationMs: Date.now() - startedAt, reason: reasonOf(error) });
      }
    }
    return { verb: 'store', acted: results.some(row => row.status !== 'error'), results };

    async function degrade(scope, event, signal) {
      try { return await retain({ scope: 'external', event, signal, degradedFrom: scope }); }
      catch { return undefined; }
    }
  };
}

/** A short, credential-free reason for an activity row. */
export function reasonOf(error) {
  const text = error instanceof Error ? error.message : String(error ?? '');
  if (!text) return 'unknown';
  if (/exceeds limit/i.test(text)) return 'resident-full';
  if (/revision conflict/i.test(text)) return 'revision-conflict';
  if (/abort/i.test(text)) return 'aborted';
  if (/timeout|budget|expired/i.test(text)) return 'timeout';
  if (/evidence/i.test(text)) return 'evidence-mismatch';
  if (/HTTP|request failed|fetch/i.test(text)) return 'transport';
  if (/Invalid|refus|denied/i.test(text)) return 'rejected';
  return 'failed';
}
