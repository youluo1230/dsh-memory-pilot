// Optional local smoke: resolves peers from an existing DSH profile without installing it.
// Run: DSH_TEST_PROFILE=/root/.dsh/profiles/web/package.json node test/plugin-smoke.mjs
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const profile = process.env.DSH_TEST_PROFILE;
if (!profile) {
  console.log('SKIP host peer smoke: set DSH_TEST_PROFILE to a profile package.json');
} else {
  const require = createRequire(profile);
  registerHooks({ resolve(specifier, context, next) {
    if (['@deepseek-ai/dsh-llm', '@deepseek-ai/schemastery', '@deepseek-ai/dsh-tools'].includes(specifier)) {
      return { url: pathToFileURL(require.resolve(specifier)).href, shortCircuit: true };
    }
    return next(specifier, context);
  } });
  const { apply } = await import('../src/plugin.mjs');
  apply({ on(){return()=>{}}, tools:{register(){return()=>{}}}, logger:{info(){},warn(){}} }, { enabled: false });
  const events = [];
  apply({ on(name) { events.push(name); return () => {}; }, tools:{register(){return()=>{}}}, logger: { info() {}, warn() {} } }, {
    enabled: true, actorId: 'alice', projectId: 'p', workspaceId: 'w', workspacePath: '/test',
    decisionBaseUrl: 'https://example.invalid/v1', decisionModel: 'mock', decisionKeyEnv: 'UNSET_TEST_KEY',
    budgetMs: 1000,
    backends: [{ id: 'history', type: 'hindsight', baseUrl: 'http://localhost:8889', bank: 'test-only', scope: 'project', scopeId: 'p', read: true, write: false }],
  });
  assert.deepEqual(events, ['agent/created', 'session/event', 'session/disposed', 'dispose']);
  console.log('PASS peer import and hook registration (no network)');
}
