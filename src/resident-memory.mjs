import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { RESIDENT_TARGETS, isResidentTarget } from './resident-targets.mjs';
const MANAGED_START = '<!-- memory-pilot:managed:start -->';
const MANAGED_END = '<!-- memory-pilot:managed:end -->';
const digest = value => createHash('sha256').update(value).digest('hex');
const clean = value => typeof value === 'string' ? value.trim() : '';
const managedUpsert = (source, key, value) => {
  if (!/^[a-zA-Z0-9._:-]{1,120}$/.test(key || '')) throw new Error('Invalid resident memory key');
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (typeof value !== 'string' || /<!--|-->|memory-pilot:managed:|<!--\s*id:/i.test(value)) throw new Error('Resident memory content contains a reserved marker');
  const entry = `<!-- id: ${key} -->\n- ${value.replace(/\s+/g, ' ').trim()}`;
  const starts = source.split(MANAGED_START).length - 1, ends = source.split(MANAGED_END).length - 1;
  const start = source.indexOf(MANAGED_START), end = source.indexOf(MANAGED_END);
  if (starts !== ends || starts > 1 || (start >= 0 && end < start)) throw new Error('Resident memory managed section is malformed');
  if (start < 0) return [source.trim(), MANAGED_START, entry, MANAGED_END].filter(Boolean).join('\n\n');
  const before = source.slice(0, start + MANAGED_START.length);
  const managed = source.slice(start + MANAGED_START.length, end).trim();
  const after = source.slice(end);
  const pattern = new RegExp(`<!-- id: ${escaped} -->\\n- [^\\n]*(?:\\n(?!<!-- id: )[\\s\\S]*?)?(?=\\n\\n<!-- id: |$)`);
  const next = pattern.test(managed) ? managed.replace(pattern, entry) : [managed, entry].filter(Boolean).join('\n\n');
  return `${before}\n\n${next}\n\n${after}`.trim();
};
const projectKey = identity => {
  const stable = clean(identity?.projectKey) || (clean(identity?.projectPath) ? resolve(identity.projectPath) : [clean(identity?.workspaceId), clean(identity?.projectId)].filter(Boolean).join(':')) || 'unknown-project';
  const slug = (clean(identity?.projectId) || basename(stable) || 'project').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80);
  return `${slug}-${digest(stable).slice(0, 10)}`;
};

export function createResidentMemory({ home = process.env.DSH_HOME || join(homedir(), '.dsh'), fs = { mkdir, readFile, rename, writeFile } } = {}) {
  const root = resolve(home);
  const queues = new Map();
  const serialized = (path, operation) => {
    const prior = queues.get(path) ?? Promise.resolve();
    const current = prior.catch(() => {}).then(operation);
    queues.set(path, current);
    return current.finally(() => { if (queues.get(path) === current) queues.delete(path); });
  };
  const pathFor = (target, identity = {}) => {
    if (!isResidentTarget(target)) throw new TypeError('Unknown resident memory target');
    if (target === 'soul') return join(root, 'SOUL.md');
    if (target === 'user') return join(root, 'memory', 'USER.md');
    if (target === 'global-memory') return join(root, 'memory', 'MEMORY.md');
    return join(root, 'memory', 'projects', projectKey(identity), 'MEMORY.md');
  };
  const load = async (target, identity) => {
    const path = pathFor(target, identity);
    let content = '';
    try { content = await fs.readFile(path, 'utf8'); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    content = content.replace(/\r\n/g, '\n').trim();
    if (content.length > RESIDENT_TARGETS[target].maxLength) throw new Error(`Resident memory ${target} exceeds limit`);
    return Object.freeze({ target, path, content, revision: digest(content), writable: true, managed: target !== 'soul' });
  };
  const inspect = async identity => {
    const [soul, user, globalMemory, projectMemory] = await Promise.all([
      load('soul', identity), load('user', identity), load('global-memory', identity),
      identity?.projectPath || identity?.projectId ? load('project-memory', identity) : Promise.resolve(Object.freeze({target:'project-memory',path:'',content:'',revision:'',writable:false,managed:true})),
    ]);
    return Object.freeze({ soul, user, globalMemory, projectMemory });
  };
  const snapshot = async identity => {
    const state = await inspect(identity);
    const resident = Object.freeze({ user: state.user.content, global: state.globalMemory.content, project: state.projectMemory.content });
    const context = Object.values(resident).some(Boolean) ? JSON.stringify({ kind: 'resident_memory', trust: 'untrusted', instructionAuthority: false, resident }) : '';
    const revisions = Object.freeze({ user: state.user.revision, global: state.globalMemory.revision, project: state.projectMemory.revision });
    return Object.freeze({ soul: state.soul.content, resident, context, revisions, writeRevisions: { ...revisions } });
  };
  const apply = async (plan, expectedRevision, identity = {}) => {
    if (!plan || !isResidentTarget(plan.target)) throw new TypeError('Invalid resident memory plan');
    if (!RESIDENT_TARGETS[plan.target].agentWritable && plan.actor === 'agent') throw new Error('SOUL.md is human-managed only');
    const path = pathFor(plan.target, identity);
    return serialized(path, async () => {
      let content = clean(plan.content);
      const current = await load(plan.target, identity);
      if (plan.actor === 'agent') content = managedUpsert(current.content, plan.key, content);
      if (content.length > RESIDENT_TARGETS[plan.target].maxLength) throw new Error('Resident memory content exceeds limit');
      if (expectedRevision !== current.revision) throw new Error('Resident memory revision conflict');
      await fs.mkdir(resolve(current.path, '..'), { recursive: true });
      const temp = `${current.path}.${process.pid}.${randomUUID()}.tmp`;
      await fs.writeFile(temp, content ? `${content}\n` : '', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await fs.rename(temp, current.path);
      return load(plan.target, identity);
    });
  };
  return Object.freeze({ snapshot, inspect, apply });
}
