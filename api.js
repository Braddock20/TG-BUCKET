// api.js
// Production-friendly HTTP API for TG-BUCKET.
// No extra web framework is required; Node's built-in http module is used.
//
// Endpoints:
//   GET    /                  API info
//   GET    /health            health/status
//   GET    /files             list stored objects
//   PUT    /files/:key        stream-upload an object
//   GET    /files/:key        stream-download an object
//   DELETE /files/:key        delete an object
//
// Optional protection:
//   TG_BUCKET_API_KEY=your-secret
// If set, every endpoint except /health requires:
//   Authorization: Bearer your-secret

import 'dotenv/config';
import http from 'node:http';
import { Transform } from 'node:stream';
import { Bucket } from './src/index.js';

const cfg = {
  apiId: Number(process.env.TG_API_ID),
  apiHash: process.env.TG_API_HASH,
  phone: process.env.TG_PHONE,
  passphrase: process.env.TG_BUCKET_PASSPHRASE,
  bucketChannel: process.env.TG_BUCKET_CHANNEL,
  session: process.env.TG_BUCKET_SESSION,
};

function failConfig() {
  const missing = [];
  if (!cfg.apiId) missing.push('TG_API_ID');
  if (!cfg.apiHash) missing.push('TG_API_HASH');
  if (!cfg.phone) missing.push('TG_PHONE');
  if (!cfg.passphrase) missing.push('TG_BUCKET_PASSPHRASE');
  if (!cfg.session) missing.push('TG_BUCKET_SESSION');
  return missing;
}

const missing = failConfig();
if (missing.length) {
  console.error(`[tg-bucket] Missing environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

let bucket;
try {
  bucket = await Bucket.connect(cfg);
  console.log('[tg-bucket] Telegram storage connected');
} catch (err) {
  console.error('[tg-bucket] Failed to connect:', err?.stack || err);
  process.exit(1);
}

const API_KEY = process.env.TG_BUCKET_API_KEY || '';
const MAX_BODY_BYTES = 1536 * 1024 * 1024;
const port = Number(process.env.PORT) || 8787;

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendError(res, status, message) {
  sendJson(res, status, { ok: false, error: message });
}

function authorized(req) {
  if (!API_KEY) return true;
  const header = req.headers.authorization || '';
  return header === `Bearer ${API_KEY}`;
}

function getKey(url) {
  const prefix = '/files/';
  if (!url.pathname.startsWith(prefix)) return null;
  const raw = url.pathname.slice(prefix.length);
  if (!raw) return '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

function validateKey(key) {
  if (!key || key.length > 1024) return 'A non-empty key up to 1024 characters is required';
  if (key.includes('\x00')) return 'Invalid key';
  return null;
}

async function upload(req, res, key, url) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_BODY_BYTES) return sendError(res, 413, 'File exceeds the 1.5 GiB per-object limit');

  let received = 0;
  const limited = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > MAX_BODY_BYTES) {
        callback(new Error('File exceeds the 1.5 GiB per-object limit'));
        req.destroy();
        return;
      }
      callback(null, chunk);
    },
  });
  req.on('error', err => limited.destroy(err));
  req.pipe(limited);

  const mimeType = req.headers['content-type'] || 'application/octet-stream';
  let result;
  try {
    result = await bucket.put(key, limited, {
      mimeType: String(mimeType).split(';')[0],
    });
  } catch (err) {
    if (/1.5 GiB per-object limit/i.test(err?.message || '')) {
      if (!res.headersSent) return sendError(res, 413, err.message);
    }
    throw err;
  }

  sendJson(res, 200, { ok: true, ...result });
}

async function download(res, key) {
  const stream = await bucket.get(key);
  const mimeType = stream.meta?.mimeType || 'application/octet-stream';
  const size = Number(stream.meta?.size || 0);
  res.writeHead(200, {
    'Content-Type': mimeType,
    ...(Number.isSafeInteger(size) ? { 'Content-Length': size } : {}),
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(key.split('/').pop() || 'download')}`,
    'Cache-Control': 'no-store',
  });
  stream.on('error', err => {
    console.error('[tg-bucket] download stream error:', err.message);
    if (!res.headersSent) sendError(res, 500, 'Download failed');
    else res.destroy(err);
  });
  stream.pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, { ok: true, service: 'tg-bucket-api' });
    }

    if (!authorized(req)) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      return sendError(res, 401, 'Unauthorized');
    }

    if (req.method === 'GET' && url.pathname === '/') {
      // Preserve the original gateway behaviour: GET / returns the object list.
      // The richer API description is available at GET /api.
      const files = await bucket.list('');
      return sendJson(res, 200, files);
    }

    if (req.method === 'GET' && url.pathname === '/api') {
      return sendJson(res, 200, {
        ok: true,
        service: 'tg-bucket-api',
        version: '1',
        endpoints: {
          health: 'GET /health',
          info: 'GET /api',
          list: 'GET /files',
          upload: 'PUT /files/:key',
          download: 'GET /files/:key',
          delete: 'DELETE /files/:key',
        },
        authentication: API_KEY ? 'Bearer token required' : 'disabled',
      });
    }

    if (req.method === 'GET' && url.pathname === '/files') {
      const prefix = url.searchParams.get('prefix') || '';
      const files = await bucket.list(prefix);
      return sendJson(res, 200, { ok: true, files });
    }

    const key = getKey(url);
    if (key === null) return sendError(res, 400, 'Invalid URL-encoded key');
    if (key !== null && key !== '') {
      const keyError = validateKey(key);
      if (keyError) return sendError(res, 400, keyError);

      if (req.method === 'PUT') return await upload(req, res, key, url);
      if (req.method === 'GET') return await download(res, key);
      if (req.method === 'DELETE') {
        const ok = await bucket.del(key);
        return sendJson(res, ok ? 200 : 404, { ok, ...(ok ? {} : { error: 'Object not found' }) });
      }
    }

    sendError(res, 404, 'Route not found');
  } catch (err) {
    console.error('[tg-bucket] request error:', err?.stack || err);
    const status = /Object not found/i.test(err?.message || '') ? 404 : 500;
    sendError(res, status, status === 404 ? 'Object not found' : 'Internal server error');
  }
});

server.on('clientError', (err, socket) => {
  console.error('[tg-bucket] client error:', err.message);
  socket.end('HTTP/1.1 400 Bad Request\\r\\n\\r\\n');
});

const shutdown = async signal => {
  console.log(`[tg-bucket] ${signal}; shutting down`);
  server.close(async () => {
    try { await bucket.disconnect(); } catch {}
    process.exit(0);
  });
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.listen(port, '0.0.0.0', () => {
  console.log(`[tg-bucket] API listening on 0.0.0.0:${port}`);
});
