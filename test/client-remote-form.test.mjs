import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');

test('non-loopback clients use the authenticated MemoryPilot RPC form', () => {
  assert.match(source, /const form = ctx\.connection\.isLoopback \? \{[\s\S]*?discover\(\)[\s\S]*?\} : createRemoteForm\(ctx\.connection\)/);
  assert.match(source, /connection\.rpc\.call\(SETTINGS_RPC_CHANNEL, "get", \{\}\)/);
  assert.match(source, /connection\.rpc\.call\(SETTINGS_RPC_CHANNEL, "mutate"/);
  assert.match(source, /connection\.rpc\.call\(SETTINGS_RPC_CHANNEL, "discover", \{\}\)/);
  assert.match(source, /connection\.rpc\.call\(SETTINGS_RPC_CHANNEL, "create-bank", \{ systemId, bank \}\)/);
});

test('loopback clients expose createBank through the same RPC channel', () => {
  assert.match(source, /ctx\.connection\.isLoopback \? \{[\s\S]*?createBank\(systemId, bank\)[\s\S]*?"create-bank", \{ systemId, bank \}/);
});

test('client declares connection runtime dependency', () => {
  assert.match(source, /const inject = \["slots", "locale", "configForms", "connection", "uiConversation"\]/);
});
