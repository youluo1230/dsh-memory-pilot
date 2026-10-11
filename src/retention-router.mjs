import { RESIDENT_TARGETS, RETENTION_TARGETS } from './resident-targets.mjs';
const TARGETS = new Set([...RETENTION_TARGETS, 'none']);
const revisionFor = (target, revisions = {}) => revisions[RESIDENT_TARGETS[target]?.revisionKey];

export function createRetentionRouter({ decision, residentMemory, externalRetain, externalAvailable, onAudit = () => {} } = {}) {
  if (typeof decision?.decideRetention !== 'function' || typeof residentMemory?.apply !== 'function') throw new TypeError('Invalid retention router dependencies');
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
      try {
        const fences = snapshot?.writeRevisions ?? snapshot?.revisions;
        const saved = await residentMemory.apply({ target: plan.target, key: plan.key, content: plan.content, actor: 'agent' }, revisionFor(plan.target, fences), identity);
        const revisionKey = RESIDENT_TARGETS[plan.target].revisionKey;
        const previousRevision = revisionFor(plan.target, fences);
        if (snapshot?.writeRevisions && typeof saved?.revision === 'string') snapshot.writeRevisions[revisionKey] = saved.revision;
        try { onAudit({kind:'resident-retention',actor:'agent',target:plan.target,eventId:event.id,status:'ok',previousRevision,revision:saved?.revision}); } catch {}
        return { status: 'ok', accepted: 1, target: plan.target };
      } catch { try { onAudit({kind:'resident-retention',actor:'agent',target:plan.target,eventId:event.id,status:'error'}); } catch {} return { status: 'error', accepted: 0 }; }
    },
  });
}
