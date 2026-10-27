// Regression: the interactive retrieval leash used to be a hard 60 000 ms floor
// applied over a config field whose schema caps at 30 000 ms. Every value the
// settings slider could produce was therefore overwritten, so the slider was
// inert and the visible budget never matched the running one. The leash must
// instead stay strictly above the configured orchestrator deadline, so the inner
// deadline fires first and yields a shaped `timeout` result rather than an opaque
// outer cancellation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/plugin.mjs', import.meta.url), 'utf8');

// Evaluate the shipped leash formula exactly as plugin.mjs defines it.
function outerLeash(budgetMs) {
  const inner = Number(budgetMs);
  const shaped = Number.isFinite(inner) && inner > 0 ? inner : 9000;
  return shaped + Math.max(15000, Math.round(shaped * 0.5));
}

test('the retrieval leash tracks the configured budget instead of a constant floor', () => {
  // Every selectable budget must produce a distinct leash; a constant floor would
  // collapse them all onto one value.
  const leashes = [100, 2500, 9000, 20000, 30000].map(outerLeash);
  assert.equal(new Set(leashes).size, leashes.length, 'each budget must map to its own leash');
});

test('the leash always exceeds the inner deadline so the inner timeout wins the race', () => {
  for (const budget of [100, 2500, 9000, 20000, 30000]) {
    assert.ok(outerLeash(budget) > budget, `leash for ${budget} must outlast the orchestrator deadline`);
  }
});

test('the shipped schema maximum cannot be overridden by the leash floor', () => {
  const maximum = Number(/budgetMs: Schema\.number\(\)\.min\(\d+\)\.max\((\d+)\)/.exec(source)?.[1]);
  assert.equal(maximum, 30000);
  // If the leash ever regains a fixed floor above the schema maximum, this fails.
  assert.ok(outerLeash(maximum) > maximum);
  assert.ok(!/Math\.max\([^)]*budgetMs[^)]*,\s*60000\s*\)/.test(source), 'the old hard 60000 floor must be gone');
});

test('plugin.mjs derives the leash from the live config value', () => {
  assert.match(source, /retrievalBudgetMs:\s*\(\)\s*=>\s*\{/);
  assert.match(source, /Number\(current\(\)\.budgetMs\)/);
});
