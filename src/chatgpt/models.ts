import * as vscode from 'vscode';
import { PICKER_PREFIX } from './ids';

export interface ModelEntry {
  /** Stable key used to build the picker id and to remember the native identity. */
  alias: string;
  displayName: string;
  /** ChatGPT model id, e.g. `gpt-6.1-sol`. */
  modelId: string;
  contextLength?: number;
  maxOutputTokens?: number;
  vision?: boolean;
  reasoning?: boolean;
}

export const CONFIG = 'antigravityChatGPT';
export { PICKER_PREFIX, pickerId, aliasForModelId } from './ids';

/**
 * Keeps the user's model list and the `MODEL_PLACEHOLDER_M###` identities we
 * hand out to them. Identities must stay stable across restarts, otherwise a
 * saved picker selection would silently point at a different model.
 */
export class ModelRegistry {
  private readonly identityKey = `${CONFIG}.identities`;

  constructor(private readonly context: vscode.ExtensionContext) {}

  entries(): ModelEntry[] {
    const configured = vscode.workspace.getConfiguration(CONFIG).get<ModelEntry[]>('models', []);
    return configured.filter((entry) => entry?.alias && entry?.modelId);
  }

  byAlias(alias: string): ModelEntry | undefined {
    return this.entries().find((entry) => entry.alias === alias);
  }

  byPickerId(id: string): ModelEntry | undefined {
    if (!id.startsWith(PICKER_PREFIX)) return undefined;
    return this.byAlias(id.slice(PICKER_PREFIX.length));
  }

  identityFor(alias: string): string {
    const map = this.identities;
    const existing = map[alias];
    if (existing) return existing;

    const used = new Set(Object.values(map));
    const start = vscode.workspace.getConfiguration(CONFIG).get<number>('identityPoolStart', 1600);
    let next = start;
    while (used.has(`MODEL_PLACEHOLDER_M${next}`) && next > 500) next--;
    const allocated = `MODEL_PLACEHOLDER_M${next}`;
    void this.context.globalState.update(this.identityKey, { ...map, [alias]: allocated });
    return allocated;
  }

  get identities(): Record<string, string> {
    return this.context.globalState.get<Record<string, string>>(this.identityKey, {});
  }
}
