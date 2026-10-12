#!/usr/bin/env node
// Repair session logs poisoned by dsh-memory-pilot's `plugin/observation`
// appends (GitHub issue #1) so DSH 0.2.0-rc.2 can load session history again.
//
// For every event whose type is outside the rc.2 read-path vocabulary, insert
// `"ignorable":true` into the top-level envelope via a byte-level splice on
// the decompressed JSONL line (no float re-serialization drift), then rewrite
// the multi-frame zstd artifact one flush frame at a time.
//
// Usage: node scripts/repair-session-logs.mjs [--dry-run] [--root /root/.dsh/sessions]
import { readdirSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { zstdDecompressSync, zstdCompressSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const rootIndex = args.indexOf('--root');
const ROOT = rootIndex >= 0 ? args[rootIndex + 1] : '/root/.dsh/sessions';

const WORKER_PATHS = [
  '/root/.dsh/profiles/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/worker.cjs',
  '/www/server/nodejs/v25.0.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/worker.cjs',
];

// Vocabulary exactly as the rc.2 persistence read path enforces it.
function workerVocabulary() {
  for (const path of WORKER_PATHS) {
    try {
      const src = readFileSync(path, 'utf8');
      const match = src.match(/const KNOWN_SESSION_EVENT_TYPES = new Set\(\[([\s\S]*?)\]\);/);
      if (match) return new Set([...match[1].matchAll(/"([^"]+)"/g)].map(x => x[1]));
    } catch { /* next path */ }
  }
  throw new Error('no dsh-session-persistence-jsonl worker.cjs found');
}

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

// rc.2 flushes the JSONL in batch frames; each frame is a standalone zstd stream.
function decodeFrames(buf) {
  const parts = [];
  let start = 0;
  while (start < buf.length) {
    const idx = buf.indexOf(ZSTD_MAGIC, start + 1);
    const end = idx === -1 ? buf.length : idx;
    parts.push(zstdDecompressSync(buf.subarray(start, end)));
    start = end;
  }
  return Buffer.concat(parts);
}

// Byte-level envelope splice: `{"type":...}` → `{"type":...,"ignorable":true}`.
// Only applied when the key is absent (idempotent).
function markIgnorable(line) {
  return line.slice(0, -1) + ',"ignorable":true}';
}

const KNOWN = workerVocabulary();
const roots = readdirSync(ROOT, { withFileTypes: true }).filter(d => d.isDirectory());
let scanned = 0, repaired = 0, totalMarked = 0;
const failures = [];

for (const r of roots) {
  const dir = join(ROOT, r.name);
  let sessionDirs;
  try { sessionDirs = readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()); }
  catch { continue; }
  for (const s of sessionDirs) {
    const file = join(dir, s.name, 'session.v4.jsonl.zstd');
    let buf;
    try { buf = readFileSync(file); } catch { continue; }
    scanned++;
    let text;
    try { text = decodeFrames(buf).toString('utf8'); }
    catch (error) { failures.push([file, `decode: ${error.message}`]); continue; }
    const lines = text.trim().split('\n');
    let marked = 0;
    const fixed = lines.map(line => {
      let event;
      try { event = JSON.parse(line); } catch { return line; }
      if (event.type === 'session') return line; // v4 header row — not an event
      if (KNOWN.has(event.type) || event.ignorable === true) return line;
      marked++;
      return markIgnorable(line);
    });
    if (!marked) continue;
    totalMarked += marked;
    if (!dryRun) {
      // Read contract (dsh-session-persistence-jsonl assertZstdHeaderFrame): frame 1
      // must contain exactly the v4 header row; the writer then emits one zstd
      // frame per flush batch (see dsh-session-manager encodeArtifact). Never
      // recompress the whole log into a single frame — persistence.list() would
      // silently drop the session from the sidebar and the registry.
      const [header, ...events] = fixed;
      const FRAMES = 100;
      const chunks = [header.endsWith('\n') ? header : header + '\n'];
      for (let i = 0; i < events.length; i += FRAMES) chunks.push(events.slice(i, i + FRAMES).join('\n') + '\n');
      const next = Buffer.concat(chunks.map(c => zstdCompressSync(Buffer.from(c))));
      const tmp = file + '.repair';
      writeFileSync(tmp, next);
      renameSync(tmp, file);
    }
    repaired++;
    console.log(`${dryRun ? '[dry-run] ' : ''}repaired ${marked} event(s) in ${file}`);
  }
}

console.log(`\nscanned ${scanned} logs, ${repaired} needed repair, ${totalMarked} events marked ignorable${dryRun ? ' (dry-run, nothing written)' : ''}`);
if (failures.length) {
  console.error('failures:');
  for (const [file, message] of failures) console.error(`  ${file}: ${message}`);
  process.exitCode = 1;
}
