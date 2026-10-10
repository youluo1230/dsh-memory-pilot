import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const clientUrl = new URL("../lib/client.js", import.meta.url);

test("settings section registration is not gated by config namespace service timing", async () => {
  const source = await readFile(clientUrl, "utf8");
  const section = source.indexOf('ctx.slots.inject("settings.section"');
  const rowGate = source.indexOf('ctx.configForms.whileServed([ENTRY]');

  assert.notEqual(section, -1, "client must register a settings.section");
  assert.notEqual(rowGate, -1, "plugin-row configuration should remain namespace-gated");
  assert.ok(
    section < rowGate,
    "settings.section must be registered directly before any whileServed gate so the navigation entry is always visible",
  );
});

test("MemoryPilot uses a unique settings navigation order", async () => {
  const source = await readFile(clientUrl, "utf8");
  assert.match(source, /id:\s*"memory-pilot",\s*\n\s*order:\s*90,/);
});
