import * as vscode from 'vscode';
import { appendFileSync } from 'node:fs';

const SECRET_HEADERS = /^(authorization|cookie|x-codeium-csrf-token|x-goog-api-key|api-key)$/i;

export function redactHeaders(headers: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = SECRET_HEADERS.test(key) ? redactToken(String(value)) : value;
  }
  return out;
}

export function redactToken(value: string): string {
  const token = value.replace(/^Bearer\s+/i, '');
  if (token.length <= 12) return '<redacted>';
  return `${token.slice(0, 6)}…<redacted ${token.length}>`;
}

export class Logger {
  private readonly channel: vscode.OutputChannel;

  constructor(
    name = 'Antigravity ChatGPT',
    private readonly logPath?: string,
  ) {
    this.channel = vscode.window.createOutputChannel(name);
  }

  info(message: string): void {
    this.write('info', message);
  }

  warn(message: string): void {
    this.write('warn', message);
  }

  error(message: string, error?: unknown): void {
    const detail = error instanceof Error ? `: ${error.message}` : error ? `: ${String(error)}` : '';
    this.write('error', message + detail);
    if (error instanceof Error && error.stack) this.write('error', error.stack);
  }

  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
  }

  private write(level: string, message: string): void {
    const stamp = new Date().toISOString().slice(11, 23);
    const line = `[${stamp}] ${level.toUpperCase().padEnd(5)} ${message}`;
    this.channel.appendLine(line);
    if (!this.logPath) return;
    try {
      appendFileSync(this.logPath, `${new Date().toISOString()} ${level.toUpperCase()} ${message}\n`);
    } catch {
      // logging must never break the extension
    }
  }
}
