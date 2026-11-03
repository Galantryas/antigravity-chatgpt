import * as vscode from 'vscode';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Logger } from '../util/log';
import { readCloudCodeUrl, removeCloudCodeUrl, setCloudCodeUrl, stripBom } from './settingsFile';

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
    const configured = vscode.workspace.getConfiguration(SECTION).get<string>(KEY);
    if (configured !== undefined) return configured;

    // If the configuration service could not parse the file (a BOM is enough
    // to break Antigravity's JSON.parse), read the value directly so restore
    // still knows what the user had before we touched it.
    try {
      return readCloudCodeUrl(this.readFile());
    } catch {
      return undefined;
    }
  }

  get path(): string {
    return this.settingsPath;
  }

  get backup(): BackupRecord | undefined {
    return this.context.globalState.get<BackupRecord>(this.backupKey);
  }

  async apply(url: string): Promise<void> {
    const current = this.current;
    // Always rewrite: this also strips a UTF-8 BOM that Antigravity's
    // JSON.parse rejects, even when the value is already correct.
    this.writeFile(url);
    if (current !== url) {
      const previous = this.backup?.previous ?? current;
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

  /**
   * Removes a UTF-8 BOM without changing any setting. Antigravity's own JSON
   * parsing fails on the BOM, which is enough to make sign-in and settings
   * reads fail before this extension ever gets a chance to run.
   */
  normalize(): void {
    try {
      if (!existsSync(this.settingsPath)) return;
      const text = readFileSync(this.settingsPath, 'utf8');
      const clean = stripBom(text);
      if (clean !== text) {
        writeFileSync(this.settingsPath, clean, 'utf8');
        this.log.info('removed a UTF-8 BOM from settings.json so Antigravity can parse it');
      }
    } catch (error) {
      this.log.warn(`could not normalize settings.json: ${(error as Error).message}`);
    }
  }

  /** Removes our value and puts the user's original setting back. */
  async restore(): Promise<void> {
    const backup = this.backup;
    const current = this.current;
    if (current === undefined) {
      this.normalize();
      return;
    }

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
  private readFile(): string {
    return existsSync(this.settingsPath) ? readFileSync(this.settingsPath, 'utf8') : '';
  }

  private writeFile(value: string | undefined): void {
    const text = this.readFile();
    const next = value === undefined ? removeCloudCodeUrl(text) : setCloudCodeUrl(text, value);

    mkdirSync(dirname(this.settingsPath), { recursive: true });
    writeFileSync(this.settingsPath, stripBom(next), 'utf8');
  }
}
