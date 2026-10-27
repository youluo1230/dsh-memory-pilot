// Regression for the automatic-capture gate.
//
// The host asks `capture()` whether a finished turn is worth handing to a
// backend. That predicate used to answer by looking only at the configured
// bindings:
//
//   backends.some(b => b.scope === 'global' && b.write === true)
//
// which is a statement about configuration, not about whether anything will
// actually happen. With the plugin disabled — or with no global writable binding
// — the answer was still "yes": every turn end paid the full capture budget
// resolving to nothing, and nothing told the user automatic capture was inert.
//
// The predicate is now an exported policy function plus a runtime check in the
// wired gate: capture is admitted only if config *and* runtime both allow it.
import test from 'node:test';
import assert from 'node:assert/strict';

test('the policy gate refuses a disabled plugin even with a global writable binding', async () => {
  const { shouldCapture } = await import('../src/plugin.mjs');
  const backends = [{ id: 'mb', scope: 'global', write: true }];
  assert.equal(shouldCapture({ enabled: false, backends }), false);
  assert.equal(shouldCapture({ enabled: true, backends }), true);
  assert.equal(shouldCapture({ enabled: true, backends, disposed: true }), false);
});

test('the policy gate requires a global writable binding', async () => {
  const { shouldCapture } = await import('../src/plugin.mjs');
  assert.equal(shouldCapture({ enabled: true, backends: [] }), false);
  assert.equal(shouldCapture({ enabled: true, backends: [{ id: 'p', scope: 'project', write: true }] }), false);
  assert.equal(shouldCapture({ enabled: true, backends: [{ id: 'g', scope: 'global', write: false }] }), false);
});

test('the wired gate also requires a buildable runtime, not just config', async () => {
  // Source guard: the predicate the host actually receives must consult
  // `runtimeFor`, so a config that cannot build a runtime never admits a
  // capture. The old bindings-only form must be gone.
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/plugin.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /capture: \(\) => \(prepared\(\)\.backends \?\? \[\]\)/);
  const gate = source.match(/capture: \(\) => \{[\s\S]*?\n    \},/);
  assert.ok(gate, 'the capture gate must remain an inspectable function');
  assert.match(gate[0], /shouldCapture\(/, 'capture gate must use the exported policy gate');
  assert.match(gate[0], /runtimeFor\(/, 'capture gate must agree with runtime construction');
});
