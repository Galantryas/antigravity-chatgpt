// Reads or writes the `jetski.cloudCodeUrl` user setting of the Antigravity IDE
// profile, keeping a timestamped backup next to the file.
//
// Usage:
//   node tools/set-cloudcode-url.mjs --show
//   node tools/set-cloudcode-url.mjs --url http://127.0.0.1:57331
//   node tools/set-cloudcode-url.mjs --restore
//   [--user-data-dir "C:\path\to\user-data"] [--dry-run]

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const KEY = 'jetski.cloudCodeUrl';
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const value = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

// The IDE names its profile after `product.json:nameLong` on Windows
// ("Antigravity IDE"), while `dataFolderName` (".antigravity-ide") is used by
// the CLI/server. Resolve whichever profile actually exists.
function defaultUserDataDir() {
  const roaming = process.env.APPDATA ?? join(process.env.USERPROFILE ?? '.', 'AppData', 'Roaming');
  const candidates = [join(roaming, 'Antigravity IDE'), join(roaming, '.antigravity-ide')];
  return candidates.find((p) => existsSync(join(p, 'User'))) ?? candidates[1];
}

const userDataDir = resolve(value('user-data-dir', defaultUserDataDir()));
const settingsPath = join(userDataDir, 'User', 'settings.json');
const backupDir = join(dirname(settingsPath), 'settings.backups');
const dryRun = flag('dry-run');

function readSettings() {
  if (!existsSync(settingsPath)) return '';
  return readFileSync(settingsPath, 'utf8');
}

function findValue(text) {
  const re = new RegExp(`"${KEY.replace(/\./g, '\\.')}"\\s*:\\s*"([^"]*)"`);
  const m = text.match(re);
  return m ? m[1] : undefined;
}

function backup(text) {
  if (!existsSync(settingsPath)) return undefined;
  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = join(backupDir, `settings.${stamp}.json`);
  writeFileSync(target, text, 'utf8');
  return target;
}

function setKey(text, url) {
  const line = `"${KEY}": ${JSON.stringify(url)}`;
  const re = new RegExp(`"${KEY.replace(/\./g, '\\.')}"\\s*:\\s*"[^"]*"`);
  if (re.test(text)) return text.replace(re, line);
  if (text.trim() === '' || text.trim() === '{}') return `{\n  ${line}\n}\n`;
  const close = text.lastIndexOf('}');
  if (close < 0) throw new Error('settings.json is not a JSON object');
  const before = text.slice(0, close).replace(/\s*$/, '');
  const needsComma = !before.endsWith('{');
  return `${before}${needsComma ? ',' : ''}\n  ${line}\n${text.slice(close)}`;
}

function removeKey(text) {
  const re = new RegExp(`\\n?\\s*"${KEY.replace(/\./g, '\\.')}"\\s*:\\s*"[^"]*"\\s*,?`);
  let out = text.replace(re, '');
  out = out.replace(/,(\s*})/, '$1');
  return out;
}

const current = readSettings();

if (flag('show') || args.length === 0) {
  console.log(`settings: ${settingsPath}`);
  console.log(`${KEY}: ${findValue(current) ?? '<unset>'}`);
  if (existsSync(backupDir)) {
    const backups = readdirSync(backupDir).sort();
    console.log(`backups: ${backups.length}${backups.length ? ` (latest ${backups[backups.length - 1]})` : ''}`);
  }
  process.exit(0);
}

mkdirSync(dirname(settingsPath), { recursive: true });

if (flag('restore')) {
  const next = removeKey(current);
  const path = dryRun ? undefined : backup(current);
  if (!dryRun) writeFileSync(settingsPath, next, 'utf8');
  console.log(`restored (removed ${KEY})${path ? ` backup=${path}` : ''}`);
  console.log(`now: ${findValue(next) ?? '<unset>'}`);
  process.exit(0);
}

const url = value('url');
if (!url) {
  console.error('missing --url');
  process.exit(1);
}

const next = setKey(current, url);
const path = dryRun ? undefined : backup(current);
if (!dryRun) writeFileSync(settingsPath, next, 'utf8');
console.log(`${dryRun ? 'would set' : 'set'} ${KEY} = ${url}`);
console.log(`settings: ${settingsPath}${path ? `\nbackup: ${path}` : ''}`);
