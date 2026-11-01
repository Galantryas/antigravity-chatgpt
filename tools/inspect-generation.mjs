// Inspects captured streamGenerateContent exchanges.
//
// Usage: node tools/inspect-generation.mjs [captures-dir] [regex-filter]

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dir = resolve(process.argv[2] ?? 'captures');
const filter = process.argv[3] ? new RegExp(process.argv[3]) : null;
const files = readdirSync(dir)
  .filter((f) => f.includes('streamGenerateContent') && f.endsWith('.req.txt'))
  .sort();

for (const f of files) {
  const label = f.replace(/\.req\.txt$/, '');
  if (filter && !filter.test(label)) continue;
  const req = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  const resRaw = readFileSync(join(dir, `${label}.res.txt`), 'utf8');

  console.log('\n============================================================');
  console.log(`capture: ${label}`);
  console.log(`top-level: ${Object.keys(req).join(', ')}`);
  console.log(`model=${JSON.stringify(req.model)}  requestType=${JSON.stringify(req.requestType)}  userAgent=${JSON.stringify(req.userAgent)}`);
  console.log(`requestId=${JSON.stringify(req.requestId)}  project=${JSON.stringify(req.project)}`);

  const r = req.request ?? {};
  console.log(`request keys: ${Object.keys(r).join(', ')}`);
  if (r.systemInstruction) {
    const text = (r.systemInstruction.parts ?? []).map((p) => p.text ?? `<${Object.keys(p).join('|')}>`).join('');
    console.log(`\nsystemInstruction (${text.length} chars, first 400):\n${text.slice(0, 400)}`);
  }
  if (r.generationConfig) console.log(`\ngenerationConfig: ${JSON.stringify(r.generationConfig)}`);
  if (r.tools) {
    console.log(`\ntools: ${r.tools.length}`);
    for (const t of r.tools) {
      const decls = t.functionDeclarations ?? [];
      console.log(`  tool keys=${Object.keys(t).join(',')} declarations=${decls.length}: ${decls.map((d) => d.name).join(', ')}`);
      if (decls[0]) console.log(`  sample declaration: ${JSON.stringify(decls[0]).slice(0, 600)}`);
    }
  }
  console.log(`\ncontents: ${r.contents?.length ?? 0}`);
  for (const [i, c] of (r.contents ?? []).entries()) {
    const parts = (c.parts ?? []).map((p) => {
      const kind = Object.keys(p).filter((k) => k !== 'thoughtSignature')[0];
      if (kind === 'text') return `text(${p.text.length})`;
      if (kind === 'functionCall') return `functionCall(${p.functionCall?.name})`;
      if (kind === 'functionResponse') return `functionResponse(${p.functionResponse?.name})`;
      if (kind === 'inlineData') return `inlineData(${p.inlineData?.mimeType})`;
      return kind ?? '?';
    });
    const sig = (c.parts ?? []).some((p) => p.thoughtSignature);
    console.log(`  [${i}] role=${c.role} parts=${parts.join(', ')}${sig ? ' (has thoughtSignature)' : ''}`);
  }
  const otherKeys = Object.keys(r).filter((k) => !['contents', 'systemInstruction', 'tools', 'generationConfig'].includes(k));
  if (otherKeys.length) console.log(`other request fields: ${otherKeys.map((k) => `${k}=${JSON.stringify(r[k]).slice(0, 120)}`).join('  ')}`);

  console.log(`\n--- response (${resRaw.length} chars) ---`);
  console.log(resRaw.slice(0, 2500));
}
