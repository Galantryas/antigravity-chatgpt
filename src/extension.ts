import * as vscode from 'vscode';
import { SettingsAdapter } from './adapter/settings';
import { LanguageServerHub } from './adapter/lsHub';
import { ProxyServer } from './proxy/server';
import { ChatRouter } from './proxy/router';
import { ChatGptClient } from './chatgpt/client';
import { CONFIG, ModelRegistry } from './chatgpt/models';
import { registerModelCommands } from './commands/models';
import { SettingsPanel } from './ui/settingsPanel';
import { Logger } from './util/log';

const ENABLED_KEY = 'antigravityChatGPT.enabled';
const KEEPALIVE_MS = 15_000;
const HUB_RETRY_DELAYS = [0, 2_000, 5_000, 10_000, 20_000];

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  await vscode.workspace.fs.createDirectory(context.globalStorageUri);
  const log = new Logger('Antigravity ChatGPT', vscode.Uri.joinPath(context.globalStorageUri, 'chatgpt.log').fsPath);
  context.subscriptions.push(log);

  const config = () => vscode.workspace.getConfiguration(CONFIG);
  const settings = new SettingsAdapter(context, log);
  const hub = new LanguageServerHub(log);
  const registry = new ModelRegistry(context);
  const client = new ChatGptClient();
  const router = new ChatRouter(registry, client, log);
  const panel = new SettingsPanel(client, registry, log, () => render());
  const proxy = new ProxyServer({
    log,
    upstream: config().get<string>('upstream', 'https://daily-cloudcode-pa.googleapis.com'),
    captureDir: config().get<boolean>('recordCaptures', false) ? captureDir(context) : undefined,
    interceptor: (ctx) => router.intercept(ctx),
    transformers: [
      {
        matches: (url) => router.isCatalogRequest(url),
        transform: (body) => router.transformCatalog(body),
      },
    ],
  });

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'antigravityChatGPT.menu';
  context.subscriptions.push(status);

  let enabled = false;
  let keepalive: NodeJS.Timeout | undefined;
  let hubRetry: NodeJS.Timeout | undefined;

  const stopHubRetries = () => {
    if (hubRetry) clearTimeout(hubRetry);
    hubRetry = undefined;
  };

  /**
   * The language server may still be booting when the extension activates, so
   * the first SetCloudCodeURL can race it. Retry with backoff instead of
   * failing the whole enable flow.
   */
  const pushHub = async (url: string, attempt = 0): Promise<void> => {
    stopHubRetries();
    if (!enabled) return;
    if (await hub.setCloudCodeUrl(url)) return;
    if (attempt >= HUB_RETRY_DELAYS.length - 1) {
      log.warn('language server is still not reachable; native models keep working, generation routing is pending');
      return;
    }
    hubRetry = setTimeout(() => void pushHub(url, attempt + 1), HUB_RETRY_DELAYS[attempt]);
    hubRetry.unref();
  };

  const render = () => {
    const port = proxy.listening;
    const count = registry.entries().length;
    status.text = enabled ? `$(plug) ChatGPT ${count} :${port}` : '$(debug-disconnect) ChatGPT';
    status.tooltip = enabled
      ? `Antigravity ChatGPT is routing through ${proxy.url}\n${count} ChatGPT model(s) in the picker\nNative models forward to ${config().get('upstream')}`
      : 'Antigravity ChatGPT is off. Click to enable.';
    status.show();
  };

  const attach = async (): Promise<boolean> => {
    try {
      enabled = true;
      await settings.apply(proxy.url);
      await context.globalState.update(ENABLED_KEY, true);
      render();
      void pushHub(proxy.url);
      log.info('routing enabled');

      keepalive?.unref();
      keepalive = setInterval(() => {
        if (enabled) void pushHub(proxy.url);
      }, KEEPALIVE_MS);
      keepalive.unref();
      return true;
    } catch (error) {
      log.error('could not enable routing', error);
      void vscode.window.showErrorMessage(`Antigravity ChatGPT: ${(error as Error).message}`);
      return false;
    }
  };

  const detach = async (): Promise<void> => {
    enabled = false;
    stopHubRetries();
    if (keepalive) clearInterval(keepalive);
    keepalive = undefined;
    await context.globalState.update(ENABLED_KEY, false);
    try {
      await settings.restore();
      await hub.setCloudCodeUrl(config().get<string>('upstream', 'https://daily-cloudcode-pa.googleapis.com'));
    } catch (error) {
      log.error('could not restore native routing', error);
    }
    render();
    log.info('routing disabled; native endpoint restored');
  };

  const ensureProxy = async (): Promise<void> => {
    const port = config().get<number>('port', 57333);
    await proxy.start(port);
  };

  context.subscriptions.push(
    ...registerModelCommands({ context, client, registry, log, onChanged: render }),

    vscode.commands.registerCommand('antigravityChatGPT.openSettings', () => panel.show()),

    vscode.commands.registerCommand('antigravityChatGPT.enable', async () => {
      await ensureProxy();
      const ok = await attach();
      if (ok) {
        const action = await vscode.window.showInformationMessage(
          'ChatGPT routing enabled. Reload the window so the chat panel re-reads the model catalog.',
          'Reload Window',
        );
        if (action === 'Reload Window') void vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
    }),

    vscode.commands.registerCommand('antigravityChatGPT.disable', async () => {
      await detach();
      const action = await vscode.window.showInformationMessage(
        'ChatGPT routing disabled. Native Antigravity models are back.',
        'Reload Window',
      );
      if (action === 'Reload Window') void vscode.commands.executeCommand('workbench.action.reloadWindow');
    }),

    vscode.commands.registerCommand('antigravityChatGPT.restart', async () => {
      await ensureProxy();
      if (enabled) await attach();
      void vscode.window.showInformationMessage(`Proxy restarted on ${proxy.url}`);
    }),

    vscode.commands.registerCommand('antigravityChatGPT.showLog', () => log.show()),
    vscode.commands.registerCommand('antigravityChatGPT.reloadWindow', () =>
      vscode.commands.executeCommand('workbench.action.reloadWindow'),
    ),

    vscode.commands.registerCommand('antigravityChatGPT.menu', async () => {
      const items: vscode.QuickPickItem[] = [
        { label: enabled ? '$(debug-disconnect) Disable' : '$(plug) Enable', description: enabled ? 'restore native routing' : 'route chat through ChatGPT' },
        { label: '$(settings-gear) Open settings panel', description: 'sign-in and model list' },
        { label: '$(account) Sign in with ChatGPT' },
        { label: '$(check) Check sign-in' },
        { label: '$(add) Add models…', description: `${registry.entries().length} configured` },
        { label: '$(trash) Remove models…' },
        { label: '$(refresh) Restart proxy' },
        { label: '$(output) Show log' },
        { label: '$(bank) Open settings' },
      ];
      const picked = await vscode.window.showQuickPick(items, { placeHolder: `Antigravity ChatGPT — ${enabled ? 'enabled' : 'disabled'}` });
      if (!picked) return;
      if (picked.label.includes('Open settings panel')) void vscode.commands.executeCommand('antigravityChatGPT.openSettings');
      else if (picked.label.includes('Enable')) void vscode.commands.executeCommand('antigravityChatGPT.enable');
      else if (picked.label.includes('Disable')) void vscode.commands.executeCommand('antigravityChatGPT.disable');
      else if (picked.label.includes('Sign in')) void vscode.commands.executeCommand('antigravityChatGPT.signIn');
      else if (picked.label.includes('Check sign-in')) void vscode.commands.executeCommand('antigravityChatGPT.checkAuth');
      else if (picked.label.includes('Add models')) void vscode.commands.executeCommand('antigravityChatGPT.addModel');
      else if (picked.label.includes('Remove models')) void vscode.commands.executeCommand('antigravityChatGPT.removeModel');
      else if (picked.label.includes('Restart')) void vscode.commands.executeCommand('antigravityChatGPT.restart');
      else if (picked.label.includes('log')) log.show();
      else void vscode.commands.executeCommand('workbench.action.openSettings', CONFIG);
    }),

    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration(`${CONFIG}.port`)) return;
      void (async () => {
        await ensureProxy();
        if (enabled) await attach();
      })();
    }),
  );

  await ensureProxy();
  render();

  const wasEnabled = context.globalState.get<boolean>(ENABLED_KEY, false);
  if (wasEnabled && config().get<boolean>('autoEnable', true)) {
    await attach();
  } else if (settings.current && settings.current === proxy.url) {
    // We probably crashed last time; keep the loop alive so the IDE is not left
    // pointing at a dead port.
    await attach();
  }

  const auth = await client.auth.status();
  if (!auth.signedIn) {
    const action = await vscode.window.showWarningMessage(
      'Antigravity ChatGPT: not signed in yet — injected models will only answer after signing in with ChatGPT.',
      'Sign in',
    );
    if (action) void vscode.commands.executeCommand('antigravityChatGPT.signIn');
  } else if (registry.entries().length > 0 && !enabled && config().get<boolean>('autoEnable', true)) {
    // First run with a working session: point the IDE at the proxy so the
    // models are usable without a trip to the Command Palette.
    await attach();
  }
}

export async function deactivate(): Promise<void> {
  // Deliberately keep `jetski.cloudCodeUrl` in place: the window that replaces
  // this extension host re-attaches on activation. `Antigravity ChatGPT:
  // Disable` is the supported way to restore the native endpoint.
}

function captureDir(context: vscode.ExtensionContext): string {
  return vscode.Uri.joinPath(context.globalStorageUri, 'captures').fsPath;
}
