// Summarises capture-proxy output: endpoints, statuses, and payload shapes.
//
// Usage: node tools/analyze-captures.mjs [captures-dir] [--full <substring>]

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const dir = resolve(args.find((a) => !a.startsWith('--')) ?? 'captures');
const fullIdx = args.indexOf('--full');
const fullNeedle = fullIdx >= 0 ? args[fullIdx + 1] : undefined;

const files = readdirSync(dir).filter((f) => f.endsWith('.meta.json')).sort();
if (files.length === 0) {
  console.log(`no captures in ${dir}`);
  process.exit(0);
}

const groups = new Map();
for (const file of files) {
  const meta = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  const label = file.replace(/\.meta\.json$/, '');
  const key = `${meta.method} ${meta.url}`;
  const entry = groups.get(key) ?? { key, count: 0, statuses: new Set(), times: [], samples: [] };
  entry.count++;
  entry.statuses.add(meta.status);
  entry.times.push(meta.elapsedMs);
  if (entry.samples.length < 3) entry.samples.push(label);
  groups.set(key, entry);
}

console.log(`${files.length} request(s), ${groups.size} distinct endpoint(s)\n`);
for (const { key, count, statuses, times, samples } of [...groups.values()].sort((a, b) => b.count - a.count)) {
  const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
  const max = Math.max(...times);
  console.log(`${String(count).padStart(3)}× ${key}`);
  console.log(`     status ${[...statuses].join('/')}, avg ${avg}ms, max ${max}ms`);
  for (const s of samples) {
    const req = readFileSync(join(dir, `${s}.req.txt`), 'utf8').trim();
    const res = readFileSync(join(dir, `${s}.res.txt`), 'utf8').trim();
    console.log(`     ${s}`);
    console.log(`       req: ${shape(req)}`);
    console.log(`       res: ${shape(res)}`);
    if (fullNeedle && key.includes(fullNeedle)) {
      console.log('   --- request ---');
      console.log(indent(req.slice(0, 8000)));
      console.log('   --- response (first 8000 chars) ---');
      console.log(indent(res.slice(0, 8000)));
    }
  }
  console.log();
}

function shape(text) {
  if (!text || text === '<empty>') return '<empty>';
  try {
    return describe(JSON.parse(text));
  } catch {
    const lines = text.split('\n').length;
    return `<non-json, ${text.length} chars, ${lines} lines>`;
  }
}

function describe(v, depth = 0) {
  if (v === null) return 'null';
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    return `[${v.length}× ${describe(v[0], depth + 1)}]`;
  }
  if (typeof v === 'object') {
    if (depth > 2) return '{…}';
    const keys = Object.keys(v);
    if (keys.length === 0) return '{}';
    const inner = keys.slice(0, 12).map((k) => {
      const child = v[k];
      const t = Array.isArray(child) ? describe(child, depth + 1) : typeof child === 'object' && child !== null ? '{…}' : typeof child;
      return `${k}:${t}`;
    });
    return `{${inner.join(', ')}${keys.length > 12 ? ', …' : ''}}`;
  }
  if (typeof v === 'string') return v.length > 40 ? `"${v.slice(0, 40)}…"` : `"${v}"`;
  return String(v);
}

function indent(text) {
  return text.split('\n').map((l) => `   ${l}`).join('\n');
}
