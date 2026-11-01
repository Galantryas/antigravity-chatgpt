import { execFile } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { Logger } from '../util/log';

const run = promisify(execFile);

export interface HubInfo {
  port: number;
  csrfToken: string;
}

const SERVICE = '/exa.language_server_pb.LanguageServerService';

/**
 * The Antigravity language server (`agy.exe --hub --hub-port=… --csrf_token=…`)
 * performs the actual model calls. Its --cloud_code_endpoint flag cannot be
 * changed after launch, but the hub exposes SetCloudCodeURL, which is what we
 * use to point generation traffic at the local proxy.
 */
export class LanguageServerHub {
  private cached?: { hub: HubInfo; at: number };

  constructor(private readonly log: Logger) {}

  async discover(force = false): Promise<HubInfo | undefined> {
    if (!force && this.cached && Date.now() - this.cached.at < 10_000) return this.cached.hub;

    const hubs = process.platform === 'win32' ? await this.discoverWindows() : this.discoverPosix();
    const hub = hubs[0];
    if (hub) this.cached = { hub, at: Date.now() };
    return hub;
  }

  async setCloudCodeUrl(url: string): Promise<boolean> {
    let hub = await this.discover();
    if (!hub) {
      hub = await this.discover(true);
      if (!hub) {
        this.log.warn('language server hub not found; generation traffic will still use the native endpoint');
        return false;
      }
    }

    const ok = await this.call(hub, 'SetCloudCodeURL', { url });
    if (!ok) {
      // The hub may have restarted with a new port/token.
      this.cached = undefined;
      const fresh = await this.discover(true);
      if (fresh && fresh.port !== hub.port) return this.call(fresh, 'SetCloudCodeURL', { url });
    }
    return ok;
  }

  private async call(hub: HubInfo, method: string, body: unknown): Promise<boolean> {
    try {
      const response = await fetch(`http://127.0.0.1:${hub.port}${SERVICE}/${method}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'connect-protocol-version': '1',
          'x-codeium-csrf-token': hub.csrfToken,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) {
        this.log.warn(`${method} failed: HTTP ${response.status} ${await response.text().catch(() => '')}`);
        return false;
      }
      return true;
    } catch (error) {
      this.log.error(`${method} to hub :${hub.port} failed`, error);
      return false;
    }
  }

  private async discoverWindows(): Promise<HubInfo[]> {
    try {
      const { stdout } = await run(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "Get-CimInstance Win32_Process -Filter \"Name='agy.exe'\" | Select-Object -ExpandProperty CommandLine",
        ],
        { timeout: 10_000, windowsHide: true },
      );
      return parseCommandLines(stdout.split(/\r?\n/));
    } catch (error) {
      this.log.error('could not enumerate language server processes', error);
      return [];
    }
  }

  private discoverPosix(): HubInfo[] {
    const found: HubInfo[] = [];
    try {
      for (const pid of readdirSync('/proc').filter((p) => /^\d+$/.test(p))) {
        try {
          const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ');
          found.push(...parseCommandLines([cmd]));
        } catch {
          // process vanished or not readable
        }
      }
    } catch (error) {
      this.log.error('could not scan /proc for the language server', error);
    }
    return found;
  }
}

export function parseCommandLines(lines: string[]): HubInfo[] {
  const hubs: HubInfo[] = [];
  for (const line of lines) {
    if (!line.includes('--hub-port')) continue;
    const port = Number(line.match(/--hub-port=(\d+)/)?.[1]);
    const csrfToken = line.match(/--csrf_token=([^\s"]+)/)?.[1];
    if (Number.isFinite(port) && port > 0 && csrfToken) hubs.push({ port, csrfToken });
  }
  return hubs;
}
