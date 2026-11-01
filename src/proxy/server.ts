import http from 'node:http';
import https from 'node:https';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Logger, redactHeaders } from '../util/log';

export const HEALTH_PATH = '/__antigravity_chatgpt/health';

export interface ProxyContext {
  method: string;
  url: string;
  body: Buffer;
  headers: http.IncomingHttpHeaders;
  res: http.ServerResponse;
}

/**
 * A request interceptor may fully answer the request (return true) or decline
 * (return false) so the proxy forwards it upstream untouched.
 */
export type Interceptor = (ctx: ProxyContext) => Promise<boolean> | boolean;

/** Rewrites a JSON response that was fetched from upstream. */
export interface ResponseTransformer {
  matches(url: string): boolean;
  transform(body: string, ctx: ProxyContext): string;
}

export interface ProxyOptions {
  log: Logger;
  upstream: string;
  interceptor?: Interceptor;
  transformers?: ResponseTransformer[];
  captureDir?: string;
}

export class ProxyServer {
  private server?: http.Server;
  private port = 0;
  private readonly upstream: URL;
  private readonly agent: http.Agent;

  constructor(private readonly options: ProxyOptions) {
    this.upstream = new URL(options.upstream);
    this.agent = new https.Agent({ keepAlive: true, maxSockets: 64 });
  }

  get listening(): number | undefined {
    return this.server ? this.port : undefined;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  setInterceptor(interceptor: Interceptor | undefined): void {
    this.options.interceptor = interceptor;
  }

  /**
   * Binds the preferred port. A previous window keeps it for a moment during a
   * reload, so wait for it briefly before falling back to the next free port.
   */
  async start(preferredPort: number, attempts = 10, waitMs = 5_000): Promise<number> {
    await this.stop();
    const deadline = Date.now() + waitMs;

    for (let offset = 0; offset < attempts; offset++) {
      const port = preferredPort + offset;
      for (;;) {
        try {
          await this.bind(port);
          this.port = port;
          this.options.log.info(`proxy listening on ${this.url} → ${this.options.upstream}`);
          return port;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          this.server = undefined;
          if (code !== 'EADDRINUSE') throw error;
          if (offset === 0 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 300));
            continue;
          }
          break;
        }
      }
    }
    throw new Error(`no free port between ${preferredPort} and ${preferredPort + attempts - 1}`);
  }

  private bind(port: number): Promise<void> {
    const server = this.createServer();
    this.server = server;
    return new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.removeListener('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private createServer(): http.Server {
    const server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
    server.keepAliveTimeout = 65_000;
    server.headersTimeout = 70_000;
    server.requestTimeout = 0;
    return server;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const started = Date.now();
    const id = randomUUID().slice(0, 8);
    const url = req.url ?? '/';

    if (url.startsWith(HEALTH_PATH)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, upstream: this.options.upstream, port: this.port }));
      return;
    }

    try {
      const body = await readBody(req);
      const ctx: ProxyContext = { method: req.method ?? 'GET', url, body, headers: req.headers, res };

      if (this.options.interceptor && (await this.options.interceptor(ctx))) {
        this.options.log.info(`[${id}] intercepted ${shortUrl(url)} (${body.length}B)`);
        return;
      }

      await this.forward(id, ctx, res, started);
    } catch (error) {
      this.options.log.error(`[${id}] proxy error for ${shortUrl(url)}`, error);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 502, message: 'proxy failure', status: 'INTERNAL' } }));
    }
  }

  private forward(id: string, ctx: ProxyContext, res: http.ServerResponse, started: number): Promise<void> {
    const target = new URL(ctx.url, this.upstream);
    const transformer = this.options.transformers?.find((item) => item.matches(ctx.url));
    const headers: http.OutgoingHttpHeaders = { ...ctx.headers };
    delete headers.host;
    delete headers['content-length'];
    // Keep responses as plain text so later phases can rewrite them.
    delete headers['accept-encoding'];
    headers.host = this.upstream.host;
    if (ctx.body.length > 0) headers['content-length'] = String(ctx.body.length);

    return new Promise<void>((resolve) => {
      const request = (this.upstream.protocol === 'http:' ? http : https).request(
        {
          protocol: this.upstream.protocol,
          hostname: this.upstream.hostname,
          port: this.upstream.port || undefined,
          path: target.pathname + target.search,
          method: ctx.method,
          headers,
          agent: this.upstream.protocol === 'https:' ? this.agent : undefined,
        },
        (upstreamRes) => {
          const contentType = String(upstreamRes.headers['content-type'] ?? '');
          const rewrite = Boolean(transformer) && contentType.includes('application/json');

          if (!rewrite) res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);

          const chunks: Buffer[] = [];
          let size = 0;
          upstreamRes.on('data', (chunk: Buffer) => {
            if (!rewrite) res.write(chunk);
            size += chunk.length;
            if (rewrite || (this.options.captureDir && size < 2_000_000)) {
              if (size < 50_000_000) chunks.push(chunk);
            }
          });
          upstreamRes.on('end', () => {
            if (rewrite && transformer) {
              const original = Buffer.concat(chunks).toString('utf8');
              let rewritten = original;
              try {
                rewritten = transformer.transform(original, ctx);
              } catch (error) {
                this.options.log.warn(`response transformer failed for ${shortUrl(ctx.url)}: ${(error as Error).message}`);
              }
              const payload = Buffer.from(rewritten, 'utf8');
              const responseHeaders = { ...upstreamRes.headers };
              delete responseHeaders['content-encoding'];
              delete responseHeaders['transfer-encoding'];
              responseHeaders['content-length'] = String(payload.length);
              res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
              res.end(payload);
            } else {
              res.end();
            }
            this.options.log.info(
              `[${id}] ${upstreamRes.statusCode} ${shortUrl(ctx.url)} ${Date.now() - started}ms ` +
                `req=${ctx.body.length}B res=${size}B${rewrite ? ' (rewritten)' : ''}`,
            );
            this.capture(id, ctx, res, size, chunks);
            resolve();
          });
        },
      );

      request.setTimeout(600_000, () => request.destroy(new Error('upstream timeout')));
      request.on('error', (error) => {
        this.options.log.error(`[${id}] upstream request failed`, error);
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 502, message: error.message, status: 'UNAVAILABLE' } }));
        resolve();
      });

      // The IDE cancels streams often; do not keep talking to Google for nothing.
      res.on('close', () => {
        if (!res.writableEnded) request.destroy();
      });

      if (ctx.body.length > 0) request.write(ctx.body);
      request.end();
    });
  }

  private capture(id: string, ctx: ProxyContext, res: http.ServerResponse, size: number, chunks: Buffer[]): void {
    const dir = this.options.captureDir;
    if (!dir) return;
    try {
      mkdirSync(dir, { recursive: true });
      const label = `${Date.now()}-${id}-${shortUrl(ctx.url).replace(/[^a-z0-9]+/gi, '_')}`;
      writeFileSync(
        join(dir, `${label}.meta.json`),
        JSON.stringify(
          {
            method: ctx.method,
            url: ctx.url,
            status: res.statusCode,
            responseBytes: size,
            requestHeaders: redactHeaders(ctx.headers as Record<string, unknown>),
            responseHeaders: res.getHeaders(),
          },
          null,
          2,
        ),
      );
      writeFileSync(join(dir, `${label}.req.txt`), ctx.body.toString('utf8'));
      writeFileSync(join(dir, `${label}.res.txt`), Buffer.concat(chunks).toString('utf8'));
    } catch (error) {
      this.options.log.warn(`could not write capture: ${(error as Error).message}`);
    }
  }
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function shortUrl(url: string): string {
  const path = url.split('?')[0] ?? url;
  return path.replace('/v1internal', '').replace(/^\/+/, '') || '/';
}
