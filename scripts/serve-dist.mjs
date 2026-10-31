#!/usr/bin/env node
// Serve the production build (dist/) the way a static host would, for the
// production e2e (playwright.prod.config.ts). Response headers come from the
// real vercel.json `headers` rules, so the test checks the deploy config, not
// a copy of it. SPA fallback: unknown paths under the base get index.html.
//
//   PORT=4173 PUBLIC_PATH=/flac-player/ node scripts/serve-dist.mjs
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const port = Number(process.env.PORT || 4173);
const base = (process.env.PUBLIC_PATH || '/').replace(/\/?$/, '/');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.data': 'application/octet-stream',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.txt': 'text/plain; charset=utf-8',
};

/** Vercel `source` → RegExp for the patterns vercel.json uses: `(.*)` and `:name*`. */
function sourceToRegExp(source) {
  let re = '';
  for (let i = 0; i < source.length;) {
    if (source.startsWith('(.*)', i)) {
      re += '.*';
      i += 4;
    } else if (source.startsWith('/:', i)) {
      const m = /^\/:([A-Za-z0-9_]+)([*+?]?)/.exec(source.slice(i));
      const seg = '(?:/[^/]+)';
      re += m[2] === '*' ? `${seg}*` : m[2] === '+' ? `${seg}+` : m[2] === '?' ? `${seg}?` : seg;
      i += m[0].length;
    } else {
      re += source[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      i += 1;
    }
  }
  return new RegExp(`^${re}$`);
}

const vercel = JSON.parse(await readFile(path.join(root, 'vercel.json'), 'utf8'));
const headerRules = (vercel.headers || []).map((rule) => ({
  test: sourceToRegExp(rule.source),
  headers: rule.headers,
}));

async function fileFor(urlPath) {
  if (!urlPath.startsWith(base)) return null;
  const rel = decodeURIComponent(urlPath.slice(base.length));
  const file = path.join(dist, rel);
  if (!file.startsWith(dist)) return null;
  try {
    const s = await stat(file);
    return s.isFile() ? file : null;
  } catch {
    return null;
  }
}

createServer(async (req, res) => {
  const urlPath = new URL(req.url, 'http://localhost').pathname;
  let file = await fileFor(urlPath);
  if (!file && urlPath.startsWith(base) && !path.extname(urlPath)) {
    file = path.join(dist, 'index.html');
  }
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }
  // Rules see the full path, base included (a subpath deploy serves `<base>/service-worker.js`).
  for (const rule of headerRules) {
    if (!rule.test.test(urlPath)) continue;
    for (const { key, value } of rule.headers) res.setHeader(key, value);
  }
  res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
  res.writeHead(200);
  res.end(req.method === 'HEAD' ? undefined : await readFile(file));
}).listen(port, () => {
  console.log(`dist/ on http://localhost:${port}${base} (headers from vercel.json)`);
});
