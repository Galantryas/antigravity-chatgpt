import * as vscode from 'vscode';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Logger } from '../util/log';
import { removeCloudCodeUrl, setCloudCodeUrl } from './settingsFile';

const SECTION = 'jetski';
const KEY = 'cloudCodeUrl';

interface BackupRecord {
  /** Value the user had before we touched the setting. */
  previous: string | undefined;
  /** Value we wrote, so restore can refuse to clobber manual edits. */
  applied: string;
  at: string;
}

/**
 * Owns the `jetski.cloudCodeUrl` user setting.
 *
 * Writes go through the VS Code configuration API so the running window picks
 * the change up immediately. If the key is not registered (it is an internal
 * Antigravity setting), the API may refuse; in that case we edit settings.json
 * directly, which the configuration service also watches.
 */
export class SettingsAdapter {
  private readonly backupKey = 'antigravityChatGPT.settingsBackup';
  private readonly settingsPath: string;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: Logger,
  ) {
    // <userData>/User/globalStorage/<publisher>.<name>[/...]
    this.settingsPath = join(dirname(dirname(context.globalStorageUri.fsPath)), 'settings.json');
  }

  get current(): string | undefined {
    return vscode.workspace.getConfiguration(SECTION).get<string>(KEY);
  }

  get path(): string {
    return this.settingsPath;
  }

  get backup(): BackupRecord | undefined {
    return this.context.globalState.get<BackupRecord>(this.backupKey);
  }

  async apply(url: string): Promise<void> {
    const current = this.current;
    if (current !== url) {
      const previous = this.backup?.previous ?? (current === url ? undefined : current);
      this.writeFile(url);
      await this.context.globalState.update(this.backupKey, { previous, applied: url, at: new Date().toISOString() });
      this.log.info(`${SECTION}.${KEY}: ${previous ?? '<unset>'} -> ${url}`);
    } else if (!this.backup) {
      await this.context.globalState.update(this.backupKey, {
        previous: undefined,
        applied: url,
        at: new Date().toISOString(),
      });
    }
  }

  /** Removes our value and puts the user's original setting back. */
  async restore(): Promise<void> {
    const backup = this.backup;
    const current = this.current;
    if (current === undefined) return;

    if (backup && current !== backup.applied) {
      this.log.warn(`${SECTION}.${KEY} was changed outside the extension (${current}); leaving it alone`);
      return;
    }

    // A stored "previous" equal to our own URL means we found the setting
    // already pointing at us (e.g. left over from a crash); restore means
    // "remove the key", not "write our URL back".
    const previous = backup?.previous === backup?.applied ? undefined : backup?.previous;
    this.writeFile(previous);
    this.log.info(`${SECTION}.${KEY}: restored to ${previous ?? '<unset>'}`);
  }

  /**
   * `jetski.cloudCodeUrl` is an internal Antigravity setting, so VS Code refuses
   * to write it through the configuration API ("not a registered
   * configuration"). Editing settings.json directly works: the configuration
   * service watches the file and the main process reads the value live.
   */
  private writeFile(value: string | undefined): void {
    const text = existsSync(this.settingsPath) ? readFileSync(this.settingsPath, 'utf8') : '';
    const next = value === undefined ? removeCloudCodeUrl(text) : setCloudCodeUrl(text, value);

    mkdirSync(dirname(this.settingsPath), { recursive: true });
    writeFileSync(this.settingsPath, next, 'utf8');
  }
}
