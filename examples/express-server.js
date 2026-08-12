// examples/express-server.js
// Minimal HTTP gateway exposing the bucket as a S3-ish REST API.
//   PUT  /:key         body -> stored encrypted
//   GET  /:key         -> decrypted body
//   GET  /             -> JSON list of keys
//   DELETE /:key       -> remove
//
// Run with: node examples/express-server.js
// (requires `npm i express` first)

import express from 'express';
import 'dotenv/config';
import { Bucket } from '../src/index.js';

const cfg = {
  apiId: Number(process.env.TG_API_ID),
  apiHash: process.env.TG_API_HASH,
  phone: process.env.TG_PHONE,
  passphrase: process.env.TG_BUCKET_PASSPHRASE,
  bucketChannel: process.env.TG_BUCKET_CHANNEL,
};

const bucket = await Bucket.connect(cfg);
const app = express();

// Use raw bodies up to 2 GB. For real backends use streaming + a CDN.
app.use(express.raw({ type: '*/*', limit: '2gb' }));

app.put('/:key(*)', async (req, res) => {
  const key = req.params.key;
  if (!Buffer.isBuffer(req.body)) return res.status(400).send('Body required');
  const r = await bucket.put(key, req.body, { mimeType: req.get('content-type') || 'application/octet-stream' });
  res.json({ ok: true, ...r });
});

app.get('/:key(*)', async (req, res) => {
  try {
    const stream = await bucket.get(req.params.key);
    res.set('Content-Type', stream.meta.mimeType || 'application/octet-stream');
    res.set('Content-Length', stream.meta.size);
    stream.pipe(res);
  } catch (e) {
    res.status(404).send(e.message);
  }
});

app.get('/', async (_req, res) => {
  res.json(await bucket.list(''));
});

app.delete('/:key(*)', async (req, res) => {
  const ok = await bucket.del(req.params.key);
  res.json({ ok });
});

const port = Number(process.env.PORT) || 8787;
app.listen(port, '0.0.0.0', () => console.log(`tg-bucket HTTP gateway on :${port}`));
