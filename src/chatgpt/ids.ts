export const PICKER_PREFIX = 'gpt/';

export function pickerId(alias: string): string {
  return `${PICKER_PREFIX}${alias}`;
}

export function aliasForModelId(modelId: string): string {
  return modelId
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}
