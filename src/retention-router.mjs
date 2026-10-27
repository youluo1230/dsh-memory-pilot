import { RESIDENT_TARGETS, RETENTION_TARGETS } from './resident-targets.mjs';

// Audit records land in the harness log, so a failure is reduced to a short,
// secret-free code instead of a message that may quote file content.
export const safeReason = error => {
  const text = error instanceof Error ? error.message : String(error ?? '');
  if (!text) return 'unknown';
  if (/revision conflict/i.test(text)) return 'revision-conflict';
  if (/exceeds limit/i.test(text)) return 'exceeds-limit';
  if (/reserved marker/i.test(text)) return 'reserved-marker';
  if (/human-managed/i.test(text)) return 'human-managed';
  if (/ENOENT/.test(text)) return 'missing-file';
  return 'write-failed';
};

const TARGETS = new Set([...RETENTION_TARGETS, 'none']);
const revisionFor = (target, revisions = {}) => revisions[RESIDENT_TARGETS[target]?.revisionKey];

// Concurrency fence.
//
// The revision fence below is optimistic: it reads `snapshot.writeRevisions`,
// applies, then writes the new revision back. Two concurrent remembers on the
// same snapshot and the same target both read the same revision, so the second
// one loses with `revision conflict` and the memory is silently dropped. DSH
// dispatches up to ten parallel tool calls per step, so a model emitting two
// `memory_remember` calls in one turn hits this every time.
//
// Serialising per target removes the overlap inside one process. The retry
// covers the remaining case the lock cannot: a revision advanced by someone
// outside this router (a human edit through the settings RPC, another plugin
// writing the same file). Re-reading is safe here because the fence protects
// the file, not the decision — the agent already decided to retain this content
// and the evidence check has passed.
const MAX_CONFLICT_RETRIES = 1;
const isRevisionConflict = error => /revision conflict/i.test(error instanceof Error ? error.message : String(error ?? ''));

export function createRetentionRouter({ decision, residentMemory, externalRetain, externalAvailable, onAudit = () => {} } = {}) {
  if (typeof decision?.decideRetention !== 'function' || typeof residentMemory?.apply !== 'function') throw new TypeError('Invalid retention router dependencies');
  const targetQueues = new Map();
  const serialized = (target, operation) => {
    const prior = targetQueues.get(target) ?? Promise.resolve();
    const current = prior.then(operation, operation);
    targetQueues.set(target, current.catch(() => {}));
    void current.catch(() => {}).finally(() => { if (targetQueues.get(target) === current) targetQueues.delete(target); });
    return current;
  };
  // Re-read the fence for one target so a retry is not handed the stale value
  // that caused the conflict. Falls back to the snapshot when the store cannot
  // produce a fresh revision, which then behaves exactly as before.
  const refreshRevision = async (target, identity) => {
    if (typeof residentMemory.inspect !== 'function') return undefined;
    try {
      const state = await residentMemory.inspect(identity);
      const key = RESIDENT_TARGETS[target].revisionKey;
      const document = { user: state.user, 'global-memory': state.globalMemory, 'project-memory': state.projectMemory }[target];
      return document?.revision ?? undefined;
    } catch { return undefined; }
  };
  return Object.freeze({
    async retain(event, snapshot, identity = {}, { signal } = {}) {
      if (!event || typeof event.id !== 'string' || typeof event.text !== 'string') return { status: 'denied', accepted: 0 };
      let plan;
      try {
        const availableTargets = ['user', 'global-memory', 'project-memory'];
        const mayUseExternal = externalAvailable === undefined ? typeof externalRetain === 'function'
          : (typeof externalAvailable === 'function' ? externalAvailable(identity) : externalAvailable);
        if (mayUseExternal) availableTargets.push('external');
        plan = await decision.decideRetention(Object.freeze({ event, resident: snapshot?.resident ?? {}, availableTargets: Object.freeze(availableTargets) }), { signal });
      } catch { return { status: 'error', accepted: 0 }; }
      if (!plan || !TARGETS.has(plan.target)) return { status: 'denied', accepted: 0 };
      if (plan.target === 'none') return { status: 'noop', accepted: 0 };
      if (plan.target === 'external') {
        if (typeof externalRetain !== 'function') return { status: 'noop', accepted: 0 };
        try { const result=await externalRetain(event,{signal});try{onAudit({kind:'resident-retention',actor:'agent',target:'external',eventId:event.id,status:result.status});}catch{}return result; }
        catch { try{onAudit({kind:'resident-retention',actor:'agent',target:'external',eventId:event.id,status:'error'});}catch{}return {status:'error',accepted:0}; }
      }
      const evidence = plan.evidence;
      if (typeof plan.key !== 'string' || !plan.key || typeof plan.content !== 'string' || !plan.content.trim()
        || evidence?.eventId !== event.id || typeof evidence.quote !== 'string' || !evidence.quote.trim() || !event.text.includes(evidence.quote)) {
        return { status: 'denied', accepted: 0 };
      }
      // Everything past this point touches one resident file and is serialised on
      // that file's target, so concurrent remembers cannot fence each other out.
      // The fence must be read INSIDE the critical section: reading it before
      // joining the queue hands every queued call the same stale revision, which
      // is precisely the race this lock exists to remove.
      const revisionKey = RESIDENT_TARGETS[plan.target].revisionKey;
      const fences = snapshot?.writeRevisions ?? snapshot?.revisions;
      return serialized(plan.target, async () => {
        // The audit row reports the fence that was actually asserted, so it is
        // captured before apply() mutates the shared revisions object in place.
        const expectedRevision = revisionFor(plan.target, fences);
        let previousRevision = expectedRevision;
        for (let attempt = 0; ; attempt++) {
          try {
            const saved = await residentMemory.apply({ target: plan.target, key: plan.key, content: plan.content, actor: 'agent' }, previousRevision, identity);
            if (fences && typeof saved?.revision === 'string') fences[revisionKey] = saved.revision;
            try { onAudit({kind:'resident-retention',actor:'agent',target:plan.target,eventId:event.id,status:'ok',previousRevision:expectedRevision,revision:saved?.revision,...(attempt?{retried:true}:{})}); } catch { /* audit must never fail the write */ }
            return { status: 'ok', accepted: 1, target: plan.target };
          } catch (failure) {
            if (attempt < MAX_CONFLICT_RETRIES && isRevisionConflict(failure)) {
              const fresh = await refreshRevision(plan.target, identity);
              if (fresh !== undefined) { previousRevision = fresh; if (fences) fences[revisionKey] = fresh; continue; }
            }
            try { onAudit({kind:'resident-retention',actor:'agent',target:plan.target,eventId:event.id,status:'error',reason:safeReason(failure)}); } catch { /* audit must never fail the write */ }
            return { status: 'error', accepted: 0 };
          }
        }
      });
    },
  });
}
