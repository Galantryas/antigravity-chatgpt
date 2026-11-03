import * as vscode from 'vscode';
import { ChatGptClient } from '../chatgpt/client';
import { AUTH_FILE, AuthState } from '../chatgpt/auth';
import { CONFIG, ModelEntry, ModelRegistry, aliasForModelId } from '../chatgpt/models';
import { Logger } from '../util/log';

export interface ModelCommandDeps {
  context: vscode.ExtensionContext;
  client: ChatGptClient;
  registry: ModelRegistry;
  log: Logger;
  /** Called after the model list changes so the catalog can be re-served. */
  onChanged: () => void;
}

const SIGN_IN_POLL_MS = 3_000;
const SIGN_IN_TIMEOUT_MS = 10 * 60_000;

export function registerModelCommands(deps: ModelCommandDeps): vscode.Disposable[] {
  const { client, registry, log } = deps;

  const saveEntries = async (entries: ModelEntry[]): Promise<void> => {
    await vscode.workspace.getConfiguration(CONFIG).update('models', entries, vscode.ConfigurationTarget.Global);
    deps.onChanged();
  };

  return [
    vscode.commands.registerCommand('antigravityChatGPT.signIn', async () => {
      const terminal = vscode.window.createTerminal({ name: 'Codex sign-in' });
      terminal.show();
      const watch = watchLoginTerminal(terminal);
      terminal.sendText(codexCommand('login'), true);

      let outcome: LoginOutcome = { ok: false, message: 'Sign-in did not start.' };
      try {
        outcome = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'Waiting for ChatGPT sign-in in the browser…',
            cancellable: true,
          },
          async (progress, token) => {
            const started = Date.now();
            while (Date.now() - started < SIGN_IN_TIMEOUT_MS && !token.isCancellationRequested) {
              await delay(SIGN_IN_POLL_MS);
              if (token.isCancellationRequested) break;

              const state = await client.auth.status();

              // A failed command is a failed login even if an older session
              // still exists; the user asked to sign in again.
              if (watch.state.ended && watch.state.code !== 0) {
                return {
                  ok: false,
                  message:
                    `codex login exited with code ${watch.state.code ?? 'unknown'}. ` +
                    'Check the "Codex sign-in" terminal for details.',
                };
              }

              if (state.signedIn && !state.needsRefresh) {
                const check = await client.validate();
                if (check.ok) return { ok: true, message: accountLabel(state) };

                // Tokens exist but the backend rejected them. If codex has
                // already exited, waiting longer cannot help.
                if (watch.state.ended) return { ok: false, message: check.message };
                progress.report({ message: 'Waiting for the session to become usable…' });
                continue;
              }

              if (watch.state.ended) {
                // codex exited cleanly. Give an expired-but-refreshable
                // session one chance to renew before calling it a failure.
                const check = await client.validate();
                if (check.ok) return { ok: true, message: accountLabel(await client.auth.status()) };
                return {
                  ok: false,
                  message: state.error ?? check.message ?? 'codex login finished without creating a session.',
                };
              }

              if (watch.state.closed) {
                return { ok: false, message: 'The sign-in terminal was closed before the login completed.' };
              }
            }

            if (token.isCancellationRequested) return { ok: false, cancelled: true, message: 'Sign-in cancelled.' };
            return {
              ok: false,
              message:
                'Sign-in was not detected. If the browser flow is still open, finish it and run ' +
                `"Antigravity ChatGPT: Check sign-in". Credentials: ${AUTH_FILE}`,
            };
          },
        );
      } catch (error) {
        outcome = { ok: false, message: `Unexpected sign-in error: ${(error as Error).message}` };
      } finally {
        watch.dispose();
      }

      if (outcome.ok) {
        log.info(outcome.message);
        const action = await vscode.window.showInformationMessage(
          `${outcome.message}. Reload the window to use the models.`,
          'Reload Window',
        );
        if (action === 'Reload Window') void vscode.commands.executeCommand('workbench.action.reloadWindow');
        return;
      }

      if (outcome.cancelled) {
        log.info(outcome.message);
        return;
      }

      log.warn(`ChatGPT sign-in failed: ${outcome.message}`);
      const action = await vscode.window.showErrorMessage(
        `ChatGPT sign-in failed: ${outcome.message}`,
        'Show log',
        'Retry',
      );
      if (action === 'Show log') log.show();
      else if (action === 'Retry') void vscode.commands.executeCommand('antigravityChatGPT.signIn');
    }),

    vscode.commands.registerCommand('antigravityChatGPT.signOut', async () => {
      const terminal = vscode.window.createTerminal({ name: 'Codex sign-out' });
      terminal.show();
      terminal.sendText(codexCommand('logout'), true);
      void vscode.window.showInformationMessage(
        'Signed out. Native Antigravity models are unaffected; the injected ChatGPT models will stop answering.',
      );
    }),

    vscode.commands.registerCommand('antigravityChatGPT.checkAuth', async () => {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Checking the ChatGPT session…' },
        () => client.validate(),
      );
      if (result.ok) void vscode.window.showInformationMessage(`ChatGPT: ${result.message}.`);
      else void vscode.window.showErrorMessage(`ChatGPT: ${result.message}`);
    }),

    vscode.commands.registerCommand('antigravityChatGPT.addModel', async () => {
      const catalog = await client.listModels().catch(() => []);
      const existing = new Set(registry.entries().map((entry) => entry.modelId));
      const items = [
        ...catalog
          .filter((model) => !existing.has(model.id))
          .map((model) => ({
            label: model.name,
            description: model.id,
            detail: model.reasoning ? 'reasoning' : undefined,
            modelId: model.id,
            displayName: model.name,
            contextLength: model.context_length,
          })),
        {
          label: '$(edit) Enter a model id manually…',
          description: 'for ids not listed here',
          modelId: '',
          displayName: '',
          contextLength: undefined,
        },
      ];

      const picked = await vscode.window.showQuickPick(items, {
        title: 'Add ChatGPT models to the Antigravity picker',
        placeHolder: 'Search by name or id, select one or more',
        canPickMany: true,
        matchOnDescription: true,
      });
      if (!picked || picked.length === 0) return;

      let entries = [...registry.entries()];
      const manual = picked.find((item) => !item.modelId);
      if (manual) {
        const input = await vscode.window.showInputBox({
          title: 'ChatGPT model id',
          placeHolder: 'e.g. gpt-6.1-sol',
          ignoreFocusOut: true,
          validateInput: (value) => (value.trim().length < 3 ? 'Enter the id the Codex backend expects' : undefined),
        });
        if (!input) return;
        const id = input.trim();
        entries.push(toEntry({ id, name: prettyName(id) }, entries));
      }
      for (const item of picked) {
        if (!item.modelId) continue;
        entries.push(toEntry({ id: item.modelId, name: item.displayName, context_length: item.contextLength }, entries));
      }

      await saveEntries(entries);
      log.info(`saved models; picker now has ${entries.length}`);
      const action = await vscode.window.showInformationMessage(
        'Model list saved. Reload the window to see them in the Antigravity model picker.',
        'Reload Window',
      );
      if (action === 'Reload Window') void vscode.commands.executeCommand('workbench.action.reloadWindow');
    }),

    vscode.commands.registerCommand('antigravityChatGPT.removeModel', async () => {
      const entries = registry.entries();
      if (entries.length === 0) {
        void vscode.window.showInformationMessage('No ChatGPT models are configured.');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        entries.map((entry) => ({ label: entry.displayName, description: entry.modelId, entry })),
        { title: 'Remove ChatGPT models', canPickMany: true },
      );
      if (!picked || picked.length === 0) return;

      const remove = new Set(picked.map((item) => item.entry.alias));
      await saveEntries(entries.filter((entry) => !remove.has(entry.alias)));
      void vscode.window.showInformationMessage(`Removed ${picked.length} model(s). Reload the window to refresh the picker.`);
    }),

    vscode.commands.registerCommand('antigravityChatGPT.listModels', async () => {
      const entries = registry.entries();
      if (entries.length === 0) {
        void vscode.window.showInformationMessage('No ChatGPT models are configured.');
        return;
      }
      const state = await client.auth.status();
      const who = state.signedIn ? (state.email ?? 'signed in') : 'not signed in';
      const picked = await vscode.window.showQuickPick(
        entries.map((entry) => ({
          label: entry.displayName,
          description: entry.modelId,
          detail: `${registry.identityFor(entry.alias)} · ${who}`,
        })),
        { title: 'Configured ChatGPT models' },
      );
      if (picked) log.show();
    }),
  ];
}

function accountLabel(state: AuthState): string {
  return state.email
    ? `Signed in to ChatGPT as ${state.email}${state.plan ? ` (${state.plan})` : ''}`
    : 'Signed in to ChatGPT';
}

interface LoginOutcome {
  ok: boolean;
  cancelled?: boolean;
  message: string;
}

interface LoginWatch {
  state: { ended: boolean; code?: number; closed: boolean };
  dispose: () => void;
}

/**
 * Watches the sign-in terminal so a failed `codex login` is reported
 * immediately instead of polling for ten minutes. Shell integration is
 * optional; when it is unavailable the auth polling and the terminal-close
 * event still cover the common failure modes.
 */
function watchLoginTerminal(terminal: vscode.Terminal): LoginWatch {
  const state: LoginWatch['state'] = { ended: false, code: undefined, closed: false };
  const disposables: vscode.Disposable[] = [];

  const onEnd = vscode.window.onDidEndTerminalShellExecution;
  if (typeof onEnd === 'function') {
    disposables.push(
      onEnd((event) => {
        if (event.terminal !== terminal) return;
        if (!/login/i.test(event.execution.commandLine.value)) return;
        state.ended = true;
        state.code = event.exitCode;
      }),
    );
  }

  disposables.push(
    vscode.window.onDidCloseTerminal((closed) => {
      if (closed === terminal) state.closed = true;
    }),
  );

  return { state, dispose: () => disposables.forEach((item) => item.dispose()) };
}

function codexCommand(subcommand: string): string {
  const exe = process.platform === 'win32' ? 'codex.cmd' : 'codex';
  return `${exe} ${subcommand}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function prettyName(id: string): string {
  return id.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function toEntry(
  model: { id: string; name?: string; context_length?: number },
  existing: ModelEntry[],
): ModelEntry {
  const base = aliasForModelId(model.id) || 'model';
  let alias = base;
  let suffix = 2;
  while (existing.some((entry) => entry.alias === alias)) alias = `${base}-${suffix++}`;

  return {
    alias,
    displayName: model.name || model.id,
    modelId: model.id,
    contextLength: model.context_length ?? 272_000,
    maxOutputTokens: 32_000,
    vision: true,
    reasoning: true,
  };
}
