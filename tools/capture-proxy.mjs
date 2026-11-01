// Transparent capture proxy for Antigravity IDE.
//
// Forwards every request to Google's Cloud Code endpoint byte-for-byte and
// records request/response bodies so we can learn the wire format.
//
// Usage:
//   node tools/capture-proxy.mjs [--port 57331] [--upstream https://daily-cloudcode-pa.googleapis.com] [--out captures]
//
// Point the IDE at it with tools/set-cloudcode-url.mjs.

import http from 'node:http';
import https from 'node:https';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const PORT = Number(arg('port', process.env.CAPTURE_PORT ?? 57331));
const UPSTREAM = arg('upstream', 'https://daily-cloudcode-pa.googleapis.com');
const OUT_DIR = resolve(arg('out', 'captures'));
const MAX_LOG_BYTES = Number(arg('max-log-bytes', 400_000));

const upstreamUrl = new URL(UPSTREAM);
mkdirSync(OUT_DIR, { recursive: true });

const REDACT = new Set(['authorization', 'cookie', 'x-csrf-token']);

function redactHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (REDACT.has(k.toLowerCase())) {
      const s = String(v);
      out[k] = s.length > 24 ? `${s.slice(0, 12)}…<redacted ${s.length} chars>` : '<redacted>';
    } else {
      out[k] = v;
    }
  }
  return out;
}

function safeName(s) {
  return s.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
}

function isEventStream(contentType) {
  return String(contentType ?? '').includes('text/event-stream');
}

const server = http.createServer((req, res) => {
  const start = Date.now();
  const id = randomUUID().slice(0, 8);
  const chunks = [];

  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const headers = { ...req.headers };
    delete headers['content-length'];
    delete headers['accept-encoding']; // keep upstream responses uncompressed
    headers.host = upstreamUrl.host;
    if (body.length > 0) headers['content-length'] = String(body.length);

    const target = new URL(req.url ?? '/', upstreamUrl);
    const options = {
      protocol: upstreamUrl.protocol,
      hostname: upstreamUrl.hostname,
      port: upstreamUrl.port || 443,
      path: target.pathname + target.search,
      method: req.method,
      headers,
    };

    const label = `${id}-${safeName((req.url ?? '/').replace(/^\//, ''))}`;
    const startedAt = new Date().toISOString();

    const up = (upstreamUrl.protocol === 'http:' ? http : https).request(options, (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);

      const respChunks = [];
      let logged = 0;
      upRes.on('data', (c) => {
        res.write(c);
        if (logged < MAX_LOG_BYTES) {
          respChunks.push(c);
          logged += c.length;
        }
      });
      upRes.on('end', () => {
        res.end();
        const elapsed = Date.now() - start;
        const meta = {
          id,
          startedAt,
          method: req.method,
          url: req.url,
          upstream: options.path,
          status: upRes.statusCode,
          elapsedMs: elapsed,
          requestHeaders: redactHeaders(req.headers),
          responseHeaders: upRes.headers,
          requestBytes: body.length,
          responseBytes: logged,
        };
        writeFileSync(join(OUT_DIR, `${label}.meta.json`), JSON.stringify(meta, null, 2));
        writeFileSync(join(OUT_DIR, `${label}.req.txt`), prettyBody(body, req.headers['content-type']));
        writeFileSync(join(OUT_DIR, `${label}.res.txt`), prettyResponse(Buffer.concat(respChunks), upRes.headers['content-type']));
        console.log(
          `[${id}] ${meta.status} ${(req.url ?? '').slice(0, 60)} → ${elapsed}ms req=${body.length}B res=${logged}B`,
        );
      });
    });

    up.on('error', (err) => {
      console.error(`[${id}] upstream error: ${err.message}`);
      if (!res.headersSent) res.writeHead(502);
      res.end(`upstream error: ${err.message}`);
    });

    res.on('close', () => {
      if (!res.writableEnded) up.destroy();
    });

    if (body.length > 0) up.write(body);
    up.end();
  });
});

function prettyBody(buf, contentType) {
  if (buf.length === 0) return '<empty>';
  const text = buf.toString('utf8');
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return isEventStream(contentType) ? formatSse(text) : text;
  }
}

function prettyResponse(buf, contentType) {
  if (buf.length === 0) return '<empty>';
  const text = buf.toString('utf8');
  if (isEventStream(contentType) || text.startsWith('data:')) return formatSse(text);
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function formatSse(text) {
  return text
    .split(/\r?\n/)
    .map((line) => {
      if (!line.startsWith('data:')) return line;
      const payload = line.slice(5).trim();
      try {
        return `data: ${JSON.stringify(JSON.parse(payload))}`;
      } catch {
        return line;
      }
    })
    .join('\n');
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`capture proxy listening on http://127.0.0.1:${PORT}`);
  console.log(`upstream: ${UPSTREAM}`);
  console.log(`captures: ${OUT_DIR}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\nstopping…');
    server.close(() => process.exit(0));
  });
}
