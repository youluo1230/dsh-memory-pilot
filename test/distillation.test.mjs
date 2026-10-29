// Session distillation. The claims held here are the ones the ticket made
// load-bearing: candidates come from the plugin and never from the model, the coarse
// gate really stops the expensive second level, keys let a correction replace rather
// than duplicate, a full resident store degrades instead of failing, and a partial
// failure does not throw away what already landed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cutCandidates, distillTurn, factKey, residentKeys, isResidentFull, createDistillTrigger, MAX_CANDIDATES } from '../src/distillation.mjs';

const turn = { userText: '以后这个项目都用 pnpm，不要用 npm。', assistantText: '明白了，这个仓库统一用 pnpm。' };

test('candidates are cut by the plugin from the conversation, never invented', async () => {
  const candidates = cutCandidates(turn);
  assert.ok(candidates.length > 0);
  for (const candidate of candidates) {
    // Every candidate's text must actually occur in the turn. A model that wrote a
    // summary would fail this, which is the point: distillation selects, it does
    // not rewrite.
    const present = `${turn.userText}\n${turn.assistantText}`.includes(candidate.text.replace(/\s+/g, ' ').trim())
      || `${turn.userText}\n${turn.assistantText}`.replace(/\s+/g, ' ').includes(candidate.text.replace(/\s+/g, ' ').trim());
    assert.ok(present, `candidate must come from the turn: ${candidate.text}`);
  }
});

test('pleasantries are not worth a judgment slot', () => {
  const candidates = cutCandidates({ userText: '好的。谢谢！', assistantText: '不客气。' });
  assert.deepEqual(candidates, []);
});

test('the coarse gate stopping means the second level never runs', async () => {
  // This is the cost control the design depends on: most turns should be discarded
  // by one cheap question, not by judging every sentence.
  let requests = 0;
  const report = await distillTurn({
    turn,
    decideBatch: async ({ questions }) => { requests++; return { turn_worth_keeping: 'discard' }; },
    retain: async () => ({ target: 'user', status: 'ok' }),
  });
  assert.equal(requests, 1, 'only the gate may be asked');
  assert.equal(report.gate, 'discarded');
  assert.equal(report.retained.length, 0);
});

test('when the gate passes, each candidate is judged and only retains land', async () => {
  const asked = [];
  const retained = [];
  const report = await distillTurn({
    turn: { userText: '用 pnpm。锁文件提交。CI 在 GitHub。', assistantText: '' },
    candidates: [
      { id: 'c0', text: '这个项目用 pnpm 作为包管理器' },
      { id: 'c1', text: '好的我知道了' },
      { id: 'c2', text: 'CI 跑在 GitHub Actions 上' },
    ],
    decideBatch: async ({ questions }) => {
      asked.push(Object.keys(questions));
      if (asked.length === 1) return { turn_worth_keeping: 'keep' };
      return { candidate_c0: 'retain', candidate_c1: 'discard', candidate_c2: 'retain' };
    },
    retain: async ({ candidate }) => { retained.push(candidate.text); return { target: 'project-memory', status: 'ok' }; },
  });
  assert.equal(report.gate, 'keep');
  assert.equal(asked.length, 2);
  assert.deepEqual(retained, ['这个项目用 pnpm 作为包管理器', 'CI 跑在 GitHub Actions 上']);
  assert.equal(report.retained.length, 2);
});

test('every candidate shares one request rather than one call each', async () => {
  // Measured: several questions about one subject in one request costs about the
  // same as one. A round trip per candidate would pay that latency several times.
  let selectionQuestions = 0;
  await distillTurn({
    turn: { userText: 'a'.repeat(20), assistantText: '' },
    candidates: ['一', '二', '三', '四'].map((text, index) => ({ id: `c${index}`, text: `${text}${'x'.repeat(15)}` })),
    decideBatch: async ({ questions }) => {
      const names = Object.keys(questions);
      if (names.includes('turn_worth_keeping')) return { turn_worth_keeping: 'keep' };
      selectionQuestions = names.length;
      return Object.fromEntries(names.map(name => [name, 'retain']));
    },
    retain: async () => ({ target: 'user', status: 'ok' }),
  });
  assert.equal(selectionQuestions, 4, 'all candidates judged in one request');
});

test('the candidate count is bounded because a long state dilutes the criteria', () => {
  const many = Array.from({ length: 40 }, (_, index) => `第 ${index} 条结论，这条足够长可以构成一个候选。`);
  const candidates = cutCandidates({ userText: many.join(' '), assistantText: '' });
  assert.ok(candidates.length <= MAX_CANDIDATES);
});

test('a key derived from the subject lets a correction replace instead of duplicate', () => {
  // Explicit ticket requirement: a content hash would create a second entry when a
  // fact is corrected, and correction is the most common way memory changes.
  const before = factKey({ scope: 'project', text: '端口是 8080' });
  const after = factKey({ scope: 'project', text: '端口是 9090' });
  assert.equal(before, after, 'a corrected value keeps the key');
  const unrelated = factKey({ scope: 'project', text: '数据库是 sqlite' });
  assert.notEqual(before, unrelated);
  // A key the judgment names explicitly wins, so it can reuse one it was shown.
  assert.equal(factKey({ scope: 'project', text: '端口是 9090', explicit: 'runtime-port' }), 'runtime-port');
});

test('existing resident keys are offered to the judgment', () => {
  const resident = { user: '<!-- memory-pilot:managed:start -->\n<!-- id: name -->\n- 阿宝\n<!-- memory-pilot:managed:end -->' };
  assert.deepEqual(residentKeys(resident), ['name']);
  let offered;
  return distillTurn({
    turn: { userText: 'x'.repeat(20), assistantText: '' },
    candidates: [{ id: 'c0', text: '用户希望被叫做阿宝宝' }],
    resident,
    decideBatch: async ({ state }) => {
      offered = state.existingKeys;
      return { turn_worth_keeping: 'keep', candidate_c0: 'retain' };
    },
    retain: async () => ({ target: 'user', status: 'ok' }),
  }).then(() => assert.deepEqual(offered, ['name']));
});

test('a full resident store degrades to the external backend instead of losing the fact', async () => {
  const calls = [];
  const report = await distillTurn({
    turn: { userText: 'x'.repeat(20), assistantText: '' },
    candidates: [{ id: 'c0', text: '这个项目必须用 Node 22 以上' }],
    decideBatch: async () => ({ turn_worth_keeping: 'keep', candidate_c0: 'retain' }),
    retain: async ({ forceExternal }) => {
      calls.push(Boolean(forceExternal));
      if (!forceExternal) throw new Error('Resident memory content exceeds limit');
      return { target: 'external', status: 'ok' };
    },
  });
  assert.deepEqual(calls, [false, true]);
  assert.equal(report.failed.length, 0, 'a degraded write is not a failure');
  assert.equal(report.retained[0].target, 'external');
  assert.equal(report.retained[0].degraded, true);
});

test('one failed candidate does not discard the ones already written', async () => {
  const report = await distillTurn({
    turn: { userText: 'x'.repeat(20), assistantText: '' },
    candidates: [{ id: 'c0', text: '第一条结论足够长了' }, { id: 'c1', text: '第二条结论也足够长' }],
    decideBatch: async () => ({ turn_worth_keeping: 'keep', candidate_c0: 'retain', candidate_c1: 'retain' }),
    retain: async ({ candidate }) => {
      if (candidate.id === 'c1') throw new Error('revision conflict');
      return { target: 'project-memory', status: 'ok' };
    },
  });
  assert.equal(report.retained.length, 1);
  assert.equal(report.failed.length, 1);
  assert.equal(report.failed[0].reason, 'revision-conflict');
});

test('only a resident-full error degrades, not every failure', () => {
  assert.equal(isResidentFull(new Error('Resident memory content exceeds limit')), true);
  assert.equal(isResidentFull(new Error('revision conflict')), false);
});

test('a judgment failure is reported, never thrown into the turn', async () => {
  const report = await distillTurn({
    turn: { userText: 'x'.repeat(20), assistantText: '' },
    candidates: [{ id: 'c0', text: '一条足够长的结论内容' }],
    decideBatch: async () => { throw new Error('transport went away'); },
    retain: async () => ({ target: 'user', status: 'ok' }),
  });
  assert.equal(report.retained.length, 0);
  assert.equal(report.reason, 'gate-failed');
});

test('the archive signal triggers, the threshold triggers, and nothing else does', () => {
  // Archiving is the strong signal; the threshold is the fallback for a conversation
  // never archived. There is no idle timer, because the platform has no idle event.
  const trigger = createDistillTrigger({ threshold: 8 });
  for (let index = 1; index < 8; index++) assert.equal(trigger.countTurn('s'), false, `turn ${index} must not fire`);
  assert.equal(trigger.countTurn('s'), true, 'the eighth turn fires');
  assert.equal(trigger.countTurn('s'), false, 'the counter resets after firing');
  // An archived session stops being counted: the archive already did the work.
  trigger.markArchived('s');
  assert.equal(trigger.isArchived('s'), true);
  for (let index = 1; index < 9; index++) assert.equal(trigger.countTurn('s'), false);
});

test('a threshold of zero makes archiving the only trigger', () => {
  const trigger = createDistillTrigger({ threshold: 0 });
  for (let index = 0; index < 50; index++) assert.equal(trigger.countTurn('s'), false);
});

test('a disabled distillation never fires', () => {
  const trigger = createDistillTrigger({ threshold: 1, enabled: () => false });
  assert.equal(trigger.countTurn('s'), false);
});
