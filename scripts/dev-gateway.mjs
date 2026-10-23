#!/usr/bin/env node
/**
 * Minimal stand-in for the local stack's Kong API gateway (the kong image cannot be pulled in this
 * environment). Listens on the API port (default 54321) and routes like Kong does:
 *   /auth/v1/*        -> auth (GoTrue) :9999
 *   /rest/v1/*        -> rest (PostgREST) :3000
 *   /rest-admin/v1/*  -> rest :3001
 *   /realtime/v1/api/*-> realtime :4000/api   (tenant from Host: realtime-dev)
 *   /realtime/v1/*    -> realtime :4000/socket (WebSocket upgrade)
 * Container IPs are resolved with `docker inspect supabase_<service>_<project_id>`, or, inside the
 * docker network (GB_GATEWAY_DNS=1, see scripts/kong-standin.sh), by the service aliases auth/rest/realtime.
 * In DNS mode it also serves the auth e-mail templates GoTrue fetches from Kong on :8088
 * (/email/magic_link.html and /email/confirmation.html -> supabase/templates/otp.html).
 * Start the stack without kong first:
 *   npx supabase start --ignore-health-check -x kong,studio,imgproxy,storage-api,logflare,vector,edge-runtime,supavisor,postgres-meta
 * Usage: node scripts/dev-gateway.mjs [port]
 * Only for local development and tests; it does no key checking (PostgREST, GoTrue and Realtime
 * verify the JWTs themselves).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';

const PORT = Number(process.argv[2] ?? process.env.GB_GATEWAY_PORT ?? 54321);
const PROJECT = process.env.GB_PROJECT_ID ?? 'goedboodschap';

function ipOf(service) {
  const out = execFileSync('docker', ['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}', `supabase_${service}_${PROJECT}`], {
    encoding: 'utf8',
  }).trim();
  const ip = out.split(/\s+/)[0];
  if (!ip) throw new Error(`no IP for supabase_${service}_${PROJECT}`);
  return ip;
}

const DNS = process.env.GB_GATEWAY_DNS === '1';
const hostOf = (service) => (DNS ? service : ipOf(service));
const upstream = {
  auth: { host: hostOf('auth'), port: 9999 },
  rest: { host: hostOf('rest'), port: 3000 },
  restAdmin: { host: hostOf('rest'), port: 3001 },
  realtime: { host: hostOf('realtime'), port: 4000 },
};

/** Returns [target, rewrittenPath, hostHeader] or null. */
function route(url) {
  const rules = [
    ['/auth/v1/', upstream.auth, '/'],
    ['/rest/v1/', upstream.rest, '/'],
    ['/rest-admin/v1/', upstream.restAdmin, '/'],
    ['/realtime/v1/api/', upstream.realtime, '/api/', 'realtime-dev.supabase-realtime'],
    ['/realtime/v1/', upstream.realtime, '/socket/', 'realtime-dev.supabase-realtime'],
  ];
  for (const [prefix, target, replacement, host] of rules) {
    if (url.startsWith(prefix)) return [target, replacement + url.slice(prefix.length), host];
    if (url === prefix.slice(0, -1)) return [target, replacement, host];
  }
  return null;
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type, prefer, range, accept-profile, content-profile, x-supabase-api-version',
  'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
};

const server = http.createServer((req, res) => {
  const r = route(req.url ?? '/');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }
  if (!r) {
    res.writeHead(404, { 'content-type': 'application/json', ...CORS });
    res.end(JSON.stringify({ message: 'no route' }));
    return;
  }
  const [target, path, host] = r;
  const headers = { ...req.headers, host: host ? `${host}:${target.port}` : `${target.host}:${target.port}` };
  // Kong forwards the client IP like this; the invite rate limits read it.
  headers['x-forwarded-for'] = req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '';
  const up = http.request({ host: target.host, port: target.port, method: req.method, path, headers }, (upRes) => {
    res.writeHead(upRes.statusCode ?? 502, { ...upRes.headers, ...CORS });
    upRes.pipe(res);
  });
  up.on('error', (e) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json', ...CORS });
    res.end(JSON.stringify({ message: `gateway: ${e.message}` }));
  });
  req.pipe(up);
});

server.on('upgrade', (req, socket, head) => {
  const r = route(req.url ?? '/');
  if (!r) {
    socket.destroy();
    return;
  }
  const [target, path, host] = r;
  const up = net.connect(target.port, target.host, () => {
    const lines = [`${req.method} ${path} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const k = req.rawHeaders[i];
      if (k.toLowerCase() === 'host') continue;
      lines.push(`${k}: ${req.rawHeaders[i + 1]}`);
    }
    lines.push(`Host: ${host ? `${host}:${target.port}` : `${target.host}:${target.port}`}`);
    up.write(lines.join('\r\n') + '\r\n\r\n');
    if (head?.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  const close = () => {
    up.destroy();
    socket.destroy();
  };
  up.on('error', close);
  socket.on('error', close);
  up.on('close', close);
  socket.on('close', close);
});

const TEMPLATES = process.env.GB_TEMPLATES_DIR;
if (TEMPLATES) {
  const files = { '/email/magic_link.html': 'otp.html', '/email/confirmation.html': 'otp.html' };
  http
    .createServer((req, res) => {
      const f = files[req.url ?? ''];
      if (!f) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(`${TEMPLATES}/${f}`));
    })
    .listen(8088, '0.0.0.0');
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`dev-gateway listening on :${PORT} -> auth ${upstream.auth.host}, rest ${upstream.rest.host}, realtime ${upstream.realtime.host}`);
});
