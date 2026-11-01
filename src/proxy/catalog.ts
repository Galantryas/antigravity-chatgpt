import type { ModelEntry } from '../chatgpt/models';
import { pickerId } from '../chatgpt/ids';
import { Logger } from '../util/log';

/** The slice of the registry the catalog needs (keeps this module vscode-free). */
export interface CatalogModelSource {
  entries(): ModelEntry[];
  identityFor(alias: string): string;
}

interface CatalogModel {
  displayName?: string;
  supportsImages?: boolean;
  supportsThinking?: boolean;
  maxTokens?: number;
  maxOutputTokens?: number;
  model?: string;
  apiProvider?: string;
  modelProvider?: string;
  supportedMimeTypes?: Record<string, boolean>;
  thinkingLevel?: number;
  [key: string]: unknown;
}

interface CatalogResponse {
  models?: Record<string, CatalogModel>;
  agentModelSorts?: Array<{ displayName?: string; groups?: Array<{ displayName?: string; modelIds?: string[] }> }>;
  [key: string]: unknown;
}

const IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif',
];

const TEXT_MIME_TYPES = ['text/plain', 'text/markdown', 'application/json', 'application/pdf'];

/**
 * Adds the configured ChatGPT models to the Cloud Code catalog that builds
 * the native model picker.
 *
 * Fail-open: anything unexpected leaves the upstream catalog untouched.
 *
 * apiProvider/modelProvider reuse the Google values that are known to be
 * accepted by the language server; routing is decided by our own model id, so
 * the label only needs to parse and keep the model "agent capable".
 */
export function injectCatalogModels(raw: string, registry: CatalogModelSource, log: Logger): string {
  let catalog: CatalogResponse;
  try {
    catalog = JSON.parse(raw) as CatalogResponse;
  } catch (error) {
    log.warn(`catalog is not JSON, not injecting models: ${(error as Error).message}`);
    return raw;
  }

  const models = registry.entries();
  if (models.length === 0) return raw;
  if (!catalog.models || typeof catalog.models !== 'object') {
    log.warn('catalog has no models map, not injecting');
    return raw;
  }

  const injected: string[] = [];
  for (const entry of models) {
    const id = pickerId(entry.alias);
    catalog.models[id] = toCatalogModel(entry, registry.identityFor(entry.alias));
    injected.push(id);
  }

  const sort = catalog.agentModelSorts?.[0];
  if (sort) {
    sort.groups = sort.groups ?? [];
    const existing = sort.groups.find((group) => group.displayName === 'ChatGPT');
    if (existing) {
      existing.modelIds = injected;
    } else {
      sort.groups.unshift({ displayName: 'ChatGPT', modelIds: injected });
    }
  } else {
    catalog.agentModelSorts = [{ displayName: 'Recommended', groups: [{ displayName: 'ChatGPT', modelIds: injected }] }];
  }

  log.info(`injected ${injected.length} ChatGPT model(s) into the picker catalog`);
  return JSON.stringify(catalog);
}

function toCatalogModel(entry: ModelEntry, identity: string): CatalogModel {
  const mime: Record<string, boolean> = {};
  for (const type of TEXT_MIME_TYPES) mime[type] = true;
  if (entry.vision) for (const type of IMAGE_MIME_TYPES) mime[type] = true;

  return {
    displayName: entry.displayName,
    supportsImages: Boolean(entry.vision),
    supportsThinking: Boolean(entry.reasoning),
    recommended: false,
    maxTokens: entry.contextLength ?? 200_000,
    maxOutputTokens: entry.maxOutputTokens ?? 32_000,
    model: identity,
    apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
    modelProvider: 'MODEL_PROVIDER_GOOGLE',
    supportedMimeTypes: mime,
    ...(entry.reasoning ? { minThinkingBudget: 1024, thinkingLevel: 2 } : {}),
  };
}
