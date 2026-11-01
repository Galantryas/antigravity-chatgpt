// Prints the structure of a captured fetchAvailableModels response.
//
// Usage: node tools/inspect-catalog.mjs [captures-dir]

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dir = resolve(process.argv[2] ?? 'captures');
const file = readdirSync(dir).find((f) => f.includes('fetchAvailableModels') && f.endsWith('.res.txt'));
if (!file) {
  console.error('no fetchAvailableModels capture found');
  process.exit(1);
}

const res = JSON.parse(readFileSync(join(dir, file), 'utf8'));
const modelIds = Object.keys(res.models ?? {});

console.log(`file: ${file}`);
console.log(`top-level keys: ${Object.keys(res).join(', ')}`);
console.log(`models: ${modelIds.length}`);
console.log(`defaultAgentModelId: ${res.defaultAgentModelId}`);
console.log(`\nmodel ids:\n  ${modelIds.join('\n  ')}`);

const sampleIds = [res.defaultAgentModelId, modelIds[0], modelIds[modelIds.length - 1]].filter(Boolean);
for (const id of [...new Set(sampleIds)]) {
  console.log(`\n--- models[${id}] ---`);
  console.log(JSON.stringify(res.models[id], null, 2).slice(0, 3000));
}

console.log('\n--- agentModelSorts ---');
console.log(JSON.stringify(res.agentModelSorts, null, 2).slice(0, 6000));

console.log('\n--- tieredModelIds ---');
console.log(JSON.stringify(res.tieredModelIds, null, 2).slice(0, 3000));

for (const key of ['commandModelIds', 'tabModelIds', 'imageGenerationModelIds', 'mqueryModelIds', 'webSearchModelIds', 'commitMessageModelIds']) {
  if (res[key]) console.log(`\n${key}: ${JSON.stringify(res[key])}`);
}
console.log(`\nexperimentIds: ${res.experimentIds?.length ?? 0}`);
