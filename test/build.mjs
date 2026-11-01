import * as esbuild from 'esbuild';
import { readdirSync } from 'node:fs';

const tests = readdirSync('test')
  .filter((file) => file.endsWith('.test.ts'))
  .map((file) => `test/${file}`);

await esbuild.build({
  entryPoints: tests,
  outdir: 'out/test',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: true,
  external: ['vscode', 'node:*'],
  outExtension: { '.js': '.mjs' },
  logLevel: 'info',
});

console.log(`bundled ${tests.length} test file(s)`);
