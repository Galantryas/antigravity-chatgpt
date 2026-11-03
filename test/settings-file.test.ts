import assert from 'node:assert/strict';
import test from 'node:test';
import { readCloudCodeUrl, removeCloudCodeUrl, setCloudCodeUrl } from '../src/adapter/settingsFile.ts';

const URL = 'http://127.0.0.1:57331';

test('creates a settings file from nothing', () => {
  const out = setCloudCodeUrl('', URL);
  assert.equal(out, `{\n  "jetski.cloudCodeUrl": "${URL}"\n}\n`);
  assert.equal(readCloudCodeUrl(out), URL);
});

test('replaces an existing value in place', () => {
  const before = `{\n  "jetski.cloudCodeUrl": "https://old.example",\n  "editor.fontSize": 14\n}\n`;
  const after = setCloudCodeUrl(before, URL);
  assert.equal(readCloudCodeUrl(after), URL);
  assert.match(after, /"editor\.fontSize": 14/);
  assert.equal((after.match(/jetski\.cloudCodeUrl/g) ?? []).length, 1);
});

test('appends to a settings file with comments and a trailing comma', () => {
  const before = `{\n  // my settings\n  "editor.fontSize": 14,\n}\n`;
  const after = setCloudCodeUrl(before, URL);
  assert.match(after, /\/\/ my settings/);
  assert.match(after, /"editor\.fontSize": 14,/);
  assert.equal(readCloudCodeUrl(after), URL);
});

test('appends to an empty object', () => {
  const after = setCloudCodeUrl('{}', URL);
  assert.equal(readCloudCodeUrl(after), URL);
});

test('removal leaves valid JSON and keeps other settings', () => {
  const before = `{\n  "editor.fontSize": 14,\n  "jetski.cloudCodeUrl": "${URL}"\n}\n`;
  const after = removeCloudCodeUrl(before);
  assert.equal(after.trim(), `{\n  "editor.fontSize": 14\n}`);
  assert.equal(readCloudCodeUrl(after), undefined);
  assert.deepEqual(JSON.parse(after), { 'editor.fontSize': 14 });
});

test('removal when the key is first', () => {
  const before = `{\n  "jetski.cloudCodeUrl": "${URL}",\n  "editor.fontSize": 14\n}\n`;
  const after = removeCloudCodeUrl(before);
  assert.deepEqual(JSON.parse(after), { 'editor.fontSize': 14 });
});

test('removal of the only key leaves an empty object', () => {
  const after = removeCloudCodeUrl(`{\n  "jetski.cloudCodeUrl": "${URL}"\n}\n`);
  assert.equal(after.trim(), '{}');
});

test('round trip is stable', () => {
  const base = `{\n  "a": 1\n}\n`;
  const once = setCloudCodeUrl(base, URL);
  const twice = setCloudCodeUrl(once, URL);
  assert.equal(once, twice);
  assert.equal(removeCloudCodeUrl(twice), base);
});

test('a UTF-8 BOM is removed instead of being written back', () => {
  const before = `\uFEFF{\n  "jetski.cloudCodeUrl": "https://old.example"\n}\n`;
  assert.equal(readCloudCodeUrl(before), 'https://old.example');

  const after = setCloudCodeUrl(before, URL);
  assert.equal(after.charCodeAt(0), '{'.charCodeAt(0));
  assert.equal(readCloudCodeUrl(after), URL);
  assert.doesNotThrow(() => JSON.parse(after));
});

test('removal also drops a UTF-8 BOM', () => {
  const before = `\uFEFF{\n  "jetski.cloudCodeUrl": "${URL}"\n}\n`;
  const after = removeCloudCodeUrl(before);
  assert.equal(after.charCodeAt(0), '{'.charCodeAt(0));
  assert.deepEqual(JSON.parse(after), {});
});
