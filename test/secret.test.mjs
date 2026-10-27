import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLiteralSecret, resolveApiKey, describeKeySource } from '../src/secret.mjs';

test('env var names are treated as names, never as literal secrets', () => {
  assert.equal(isLiteralSecret('MEMORY_DECISION_API_KEY'), false);
  assert.equal(isLiteralSecret('_PRIVATE'), false);
  assert.equal(isLiteralSecret('KEY2'), false);
  // Real API keys carry characters an env var name cannot hold.
  assert.equal(isLiteralSecret('clef-98k9ZchyQROQ43Co-9mvf7oCYVfU1naC'), true);
  assert.equal(isLiteralSecret('sk-proj.abc'), true);
  assert.equal(isLiteralSecret(''), false);
});

test('a valid env var name resolves from the environment', () => {
  const resolved = resolveApiKey({ keyEnv: 'MEMORY_DECISION_API_KEY' }, { MEMORY_DECISION_API_KEY: 'from-env' });
  assert.deepEqual(resolved, { value: 'from-env', source: 'env' });
});

test('a literal key pasted into the env-var field is still used (regression)', () => {
  // The production bug: decisionKeyEnv held the key itself, so
  // process.env[key] was undefined and the Authorization header was dropped.
  const resolved = resolveApiKey({ keyEnv: 'clef-98k9ZchyQROQ43Co-9mvf7oCYVfU1naC' }, {});
  assert.equal(resolved.value, 'clef-98k9ZchyQROQ43Co-9mvf7oCYVfU1naC');
  assert.equal(resolved.source, 'literal');
});

test('a literal apiKey field is used when no env var is configured', () => {
  assert.deepEqual(resolveApiKey({ apiKey: 'sk-literal' }, {}), { value: 'sk-literal', source: 'apiKey' });
});

test('a configured but unset env var falls back to the literal field', () => {
  const resolved = resolveApiKey({ keyEnv: 'MISSING_KEY', apiKey: 'sk-fallback' }, {});
  assert.equal(resolved.value, 'sk-fallback');
  assert.equal(resolved.source, 'apiKey');
});

test('missing key reports the env var the user must set', () => {
  assert.deepEqual(resolveApiKey({ keyEnv: 'MISSING_KEY' }, {}), { value: undefined, source: 'none', missingEnv: 'MISSING_KEY' });
  assert.deepEqual(resolveApiKey({}, {}), { value: undefined, source: 'none' });
});

test('the real environment object is used by default', () => {
  const name = 'MEMORY_PILOT_TEST_KEY_XYZ';
  process.env[name] = 'from-real-env';
  try { assert.equal(resolveApiKey({ keyEnv: name }).value, 'from-real-env'); }
  finally { delete process.env[name]; }
});

test('key source descriptions never leak the secret', () => {
  const key = 'clef-98k9ZchyQROQ43Co-9mvf7oCYVfU1naC';
  for (const resolved of [resolveApiKey({ keyEnv: key }), resolveApiKey({ apiKey: key }), resolveApiKey({ keyEnv: 'A' }, { A: key })]) {
    const text = describeKeySource(resolved);
    assert.equal(text.includes(key), false);
  }
  assert.match(describeKeySource({ value: undefined, source: 'none', missingEnv: 'FOO' }), /FOO/);
});
