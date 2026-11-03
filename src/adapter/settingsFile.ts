/**
 * Text edits for settings.json. Kept free of the vscode API so it can be tested
 * against real settings files (JSONC with comments and trailing commas).
 */

export const SECTION = 'jetski';
export const KEY = 'cloudCodeUrl';
const FULL_KEY = `${SECTION}.${KEY}`;

function valuePattern(): RegExp {
  return new RegExp(`"${FULL_KEY.replace(/\./g, '\\.')}"\\s*:\\s*"([^"]*)"`);
}

/**
 * Antigravity parses settings.json with plain JSON.parse in a few places, and a
 * UTF-8 BOM makes that throw. Never write the BOM back.
 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function readCloudCodeUrl(text: string): string | undefined {
  return stripBom(text).match(valuePattern())?.[1];
}

export function setCloudCodeUrl(text: string, url: string): string {
  text = stripBom(text);
  const line = `"${FULL_KEY}": ${JSON.stringify(url)}`;
  if (valuePattern().test(text)) return text.replace(valuePattern(), line);

  if (text.trim() === '' || text.trim() === '{}') return `{\n  ${line}\n}\n`;

  const close = text.lastIndexOf('}');
  if (close < 0) throw new Error('settings.json is not a JSON object');
  const head = text.slice(0, close).replace(/\s*$/, '');
  const separator = head.endsWith('{') ? '' : ',';
  return `${head}${separator}\n  ${line}\n${text.slice(close)}`;
}

export function removeCloudCodeUrl(text: string): string {
  text = stripBom(text);
  const entry = new RegExp(`\\n?[ \\t]*"${FULL_KEY.replace(/\./g, '\\.')}"\\s*:\\s*"[^"]*"[ \\t]*,?`);
  let out = text.replace(entry, '');
  out = out.replace(/,(\s*})/, '$1');
  return out.replace(/\{\s*\}/, '{}');
}
