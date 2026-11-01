// Minimal client for the Antigravity language server hub (Connect/gRPC-web over HTTP).
//
// Usage:
//   node tools/ls-rpc.mjs --status
//   node tools/ls-rpc.mjs --method GetStatus
//   node tools/ls-rpc.mjs --method SetCloudCodeURL --url http://127.0.0.1:57331
//   node tools/ls-rpc.mjs --method GetStatus --port 54034 --token <csrf>

import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const value = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

function discover() {
  const out = execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='agy.exe'\" | Select-Object -ExpandProperty CommandLine",
    ],
    { encoding: 'utf8' },
  );
  const lines = out.split(/\r?\n/).filter((l) => l.includes('--hub-port'));
  const results = lines.map((cmd) => ({
    port: Number(cmd.match(/--hub-port=(\d+)/)?.[1]),
    token: cmd.match(/--csrf_token=([^\s"]+)/)?.[1],
    cmd,
  }));
  return results;
}

// --- protobuf helpers -------------------------------------------------------
function varint(n) {
  const bytes = [];
  while (n > 0x7f) {
    bytes.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  bytes.push(n);
  return bytes;
}

function stringField(fieldNumber, text) {
  const payload = Buffer.from(text, 'utf8');
  return Buffer.concat([Buffer.from(varint((fieldNumber << 3) | 2)), Buffer.from(varint(payload.length)), payload]);
}

// --- RPC --------------------------------------------------------------------
const prefix = '/exa.language_server_pb.LanguageServerService/';
const method = value('method', flag('status') ? 'GetStatus' : undefined);
if (!method) {
  console.error('missing --method (or --status)');
  process.exit(1);
}

let port = Number(value('port', 0));
let token = value('token');

if (flag('status') || !port || !token) {
  const found = discover();
  if (found.length === 0) {
    console.error('no running agy.exe hub found');
    process.exit(1);
  }
  port = port || found[0].port;
  token = token || found[0].token;
  console.log(`hub: 127.0.0.1:${port} (token ${token.slice(0, 8)}…)`);
}

const url = value('url');
const body = url ? stringField(1, url) : Buffer.alloc(0);

const transports = [
  { name: 'connect-proto', contentType: 'application/proto', extra: { 'connect-protocol-version': '1' } },
  { name: 'connect-json', contentType: 'application/json', extra: { 'connect-protocol-version': '1' }, jsonBody: true },
  { name: 'grpc-web+proto', contentType: 'application/grpc-web+proto', extra: { 'x-grpc-web': '1' }, grpcFrame: true },
];

for (const t of transports) {
  const payload = t.jsonBody ? Buffer.from(JSON.stringify(url ? { url } : {})) : t.grpcFrame ? Buffer.concat([Buffer.from([0, 0, 0, 0, body.length]), body]) : body;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${prefix}${method}`, {
      method: 'POST',
      headers: {
        'content-type': t.contentType,
        'x-codeium-csrf-token': token,
        accept: 'application/proto, application/json',
        ...t.extra,
      },
      body: payload,
    });
    const buf = Buffer.from(await res.arrayBuffer());
    console.log(`\n[${t.name}] ${res.status} ${res.statusText} (${buf.length}B)`);
    for (const [k, v] of res.headers) console.log(`   ${k}: ${v}`);
    console.log(`   body(utf8): ${JSON.stringify(buf.toString('utf8').slice(0, 500))}`);
    console.log(`   body(hex) : ${buf.subarray(0, 120).toString('hex')}`);
  } catch (err) {
    console.log(`[${t.name}] failed: ${err.message}`);
  }
}
