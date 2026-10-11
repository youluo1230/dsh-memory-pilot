export const RESIDENT_TARGETS = Object.freeze({
  soul: Object.freeze({ revisionKey: null, maxLength: 12_000, agentWritable: false }),
  user: Object.freeze({ revisionKey: 'user', maxLength: 4_000, agentWritable: true }),
  'global-memory': Object.freeze({ revisionKey: 'global', maxLength: 8_000, agentWritable: true }),
  'project-memory': Object.freeze({ revisionKey: 'project', maxLength: 8_000, agentWritable: true, requiresProject: true }),
});

export const RETENTION_TARGETS = Object.freeze([...Object.keys(RESIDENT_TARGETS).filter(target => target !== 'soul'), 'external']);
export const isResidentTarget = target => Object.hasOwn(RESIDENT_TARGETS, target);
export const isRetentionTarget = target => RETENTION_TARGETS.includes(target);
