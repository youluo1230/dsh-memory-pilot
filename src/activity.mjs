/**
 * The recent-memory-activity record.
 *
 * Every failure on the memory path used to be silent: a retrieval that threw and a
 * retrieval that found nothing produced the same empty context, so a user could not
 * tell whether memory was working, broken, or never consulted. This module keeps a
 * bounded, in-process list of what was attempted, so the settings panel can answer
 * "is this thing doing anything".
 *
 * Two rules are load-bearing:
 *
 * - Rows are SHORT and carry a reason CODE, never a message from a dependency. A
 *   store's error text can quote file content or, worse, an auth header.
 * - The list is bounded. It is a diagnostic, not a log; unbounded growth in a
 *   long-lived session is a leak with a friendly name.
 */

/** How many rows to keep. Enough to see a pattern, small enough to render. */
export const MAX_ACTIVITY = 50;

/** The kinds a row may have. `query` and `retain` are the two the ticket requires
 * to be distinguishable, since "did it read" and "did it write" are the questions a
 * user actually asks. */
const KINDS = new Set(['query', 'retain', 'distill']);

/** Strip a row down to the fields that are safe to show and useful to read. */
function sanitize(row, at) {
  const kind = KINDS.has(row?.kind) ? row.kind : 'query';
  const status = typeof row?.status === 'string' ? row.status.slice(0, 24) : 'unknown';
  const scopes = Array.isArray(row?.scopes)
    ? row.scopes.filter(scope => ['personal', 'global', 'project', 'workspace', 'external'].includes(scope)).slice(0, 4)
    : [];
  const durationMs = Number.isFinite(row?.durationMs) ? Math.max(0, Math.round(row.durationMs)) : 0;
  const out = { at, kind, status, scopes, durationMs };
  if (Number.isSafeInteger(row?.hitCount) && row.hitCount >= 0) out.hitCount = row.hitCount;
  if (typeof row?.reason === 'string' && row.reason) out.reason = row.reason.slice(0, 32);
  if (typeof row?.target === 'string' && row.target) out.target = row.target.slice(0, 32);
  if (typeof row?.tool === 'string' && row.tool) out.tool = row.tool.slice(0, 48);
  if (typeof row?.severity === 'string' && row.severity) out.severity = row.severity.slice(0, 24);
  return out;
}

export function createActivityLog({ limit = MAX_ACTIVITY, now = () => new Date().toISOString() } = {}) {
  const rows = [];
  const safeLimit = Number.isSafeInteger(limit) && limit > 0 ? limit : MAX_ACTIVITY;
  return Object.freeze({
    record(row) {
      if (!row || typeof row !== 'object') return;
      let entry;
      try { entry = sanitize(row, now()); }
      catch { return; /* an unusable row must never break the caller */ }
      rows.push(entry);
      // Drop from the front: the oldest row is the least interesting, and a
      // splice keeps the array the single source of "recent" order.
      if (rows.length > safeLimit) rows.splice(0, rows.length - safeLimit);
    },
    list() { return rows.slice().reverse(); },
    clear() { rows.length = 0; },
  });
}

/**
 * Summarize a list of activity rows for a settings surface.
 *
 * The counts are what a user needs before reading any row: a plugin whose queries
 * all failed is a different problem from one that never queried.
 */
export function summarizeActivity(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const of = kind => list.filter(row => row.kind === kind);
  const failed = row => row.status === 'error' || row.status === 'denied' || row.status === 'failed';
  const successful = row => row.status === 'ok' || row.status === 'allowed' || row.status === 'approved' || row.status === 'degraded';
  const queries = of('query');
  const retains = of('retain').concat(of('distill'));
  return {
    total: list.length,
    queries: queries.length,
    retains: retains.length,
    failures: list.filter(failed).length,
    lastSuccess: list.find(successful)?.at ?? null,
    lastFailure: list.find(failed)?.at ?? null,
  };
}
