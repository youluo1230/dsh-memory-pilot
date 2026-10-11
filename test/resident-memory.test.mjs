import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createResidentMemory } from '../src/resident-memory.mjs';

const identity = projectPath => ({ projectId: 'repo', projectPath });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'memory-pilot-resident-'));
  const home = join(root, 'dsh');
  const repo = join(root, 'repo');
  await mkdir(join(repo, '.git'), { recursive: true });
  return { root, home, repo, memory: createResidentMemory({ home }) };
}

test('resident memory snapshot separates trusted soul from untrusted bounded memory', async () => {
  const f = await fixture();
  await mkdir(join(f.home, 'memory'), { recursive: true });
  await writeFile(join(f.home, 'SOUL.md'), 'Calm and direct.');
  await writeFile(join(f.home, 'memory', 'USER.md'), 'Prefers concise Chinese.');
  await writeFile(join(f.home, 'memory', 'MEMORY.md'), 'Uses pnpm globally.');
  const inspected = await f.memory.inspect(identity(f.repo));
  await f.memory.apply({ target: 'project-memory', content: 'Repository targets Node.js 22.' }, inspected.projectMemory.revision, identity(f.repo));

  const snapshot = await f.memory.snapshot(identity(f.repo));
  assert.equal(snapshot.soul, 'Calm and direct.');
  assert.deepEqual(snapshot.resident, {
    user: 'Prefers concise Chinese.',
    global: 'Uses pnpm globally.',
    project: 'Repository targets Node.js 22.',
  });
  assert.match(snapshot.context, /"trust":"untrusted"/);
  assert.match(snapshot.context, /Repository targets Node\.js 22/);
  assert.equal(snapshot.context.includes('Calm and direct.'), false);
  assert.ok(Object.isFrozen(snapshot));
});

test('same-named repositories in different workspaces have isolated project memory',async()=>{
 const f=await fixture();const a={projectId:'repo',projectPath:join(f.root,'one','repo'),workspaceId:'one'};const b={projectId:'repo',projectPath:join(f.root,'two','repo'),workspaceId:'two'};
 const first=await f.memory.inspect(a),second=await f.memory.inspect(b);
 const savedA=await f.memory.apply({target:'project-memory',content:'Workspace one.'},first.projectMemory.revision,a);
 const savedB=await f.memory.apply({target:'project-memory',content:'Workspace two.'},second.projectMemory.revision,b);
 assert.notEqual(savedA.path,savedB.path);assert.equal((await f.memory.inspect(a)).projectMemory.content,'Workspace one.');assert.equal((await f.memory.inspect(b)).projectMemory.content,'Workspace two.');
});

test('resident memory apply fences revisions and confines project files under DSH home', async () => {
  const f = await fixture();
  const before = await f.memory.inspect(identity(f.repo));
  const saved = await f.memory.apply({ target: 'user', content: 'Call the user Alex.' }, before.user.revision, identity(f.repo));
  assert.equal(saved.content, 'Call the user Alex.');
  await assert.rejects(f.memory.apply({ target: 'user', content: 'Stale overwrite.' }, before.user.revision, identity(f.repo)), /revision/i);

  const project = await f.memory.apply({ target: 'project-memory', content: 'Use ESM.' }, before.projectMemory.revision, identity(f.repo));
  assert.ok(project.path.startsWith(join(f.home, 'memory', 'projects')));
  assert.equal(project.path.startsWith(f.repo), false);
  assert.equal(await readFile(project.path, 'utf8'), 'Use ESM.\n');
});

test('resident limits and managed markers fail closed',async()=>{
 const f=await fixture();const before=await f.memory.inspect(identity(f.repo));
 await assert.rejects(f.memory.apply({target:'user',content:'x'.repeat(4001),actor:'human'},before.user.revision,identity(f.repo)),/limit/i);
 await assert.rejects(f.memory.apply({target:'user',content:'fact <!-- memory-pilot:managed:end -->',key:'evil',actor:'agent'},before.user.revision,identity(f.repo)),/reserved marker/i);
});

test('agent plans update only managed entries and never soul or human notes', async () => {
  const f = await fixture();
  const before = await f.memory.inspect(identity(f.repo));
  await assert.rejects(f.memory.apply({ target: 'soul', content: 'Changed persona.', actor: 'agent' }, before.soul.revision, identity(f.repo)), /human/i);
  await f.memory.apply({ target: 'global-memory', content: '# Notes\n\nHuman-owned fact.' }, before.globalMemory.revision, identity(f.repo));
  const current = await f.memory.inspect(identity(f.repo));
  const saved = await f.memory.apply({ target: 'global-memory', actor: 'agent', key: 'stable-fact', content: 'Stable agent fact.' }, current.globalMemory.revision, identity(f.repo));
  assert.match(saved.content, /Human-owned fact/);
  assert.match(saved.content, /memory-pilot:managed:start/);
  assert.match(saved.content, /<!-- id: stable-fact -->\n- Stable agent fact\./);
  const updated = await f.memory.apply({ target: 'global-memory', actor: 'agent', key: 'stable-fact', content: 'Updated fact.' }, saved.revision, identity(f.repo));
  assert.equal((updated.content.match(/id: stable-fact/g) ?? []).length, 1);
  assert.match(updated.content, /Updated fact/);
});
