#!/usr/bin/env node
// bin/tg-bucket.js — minimal CLI for testing & ops.
// Usage:
//   tg-bucket login
//   tg-bucket put <localFile> <bucketKey>
//   tg-bucket get <bucketKey> <localFile>
//   tg-bucket ls [prefix]
//   tg-bucket rm <bucketKey>
//   tg-bucket stat

import fs from 'node:fs';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { Bucket } from '../src/index.js';

loadEnv();

function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name} (see .env.example)`);
  return v;
}

async function main() {
  const [, , cmd, ...args] = process.argv;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(`tg-bucket — encrypted Telegram object storage

Commands:
  login                              Authenticate and save session
  put <localFile> <bucketKey>        Upload a file
  get <bucketKey> <localFile>        Download a file
  ls [prefix]                        List objects
  rm <bucketKey>                     Delete an object
  stat                               Show channel & session info
`);
    return;
  }

  const cfg = {
    apiId: Number(need('TG_API_ID')),
    apiHash: need('TG_API_HASH'),
    phone: need('TG_PHONE'),
    passphrase: need('TG_BUCKET_PASSPHRASE'),
    bucketChannel: process.env.TG_BUCKET_CHANNEL,
    sessionPath: process.env.TG_BUCKET_SESSION_PATH || './tg-bucket.session',
    session: process.env.TG_BUCKET_SESSION,
  };

  const bucket = await Bucket.connect(cfg);
  try {
    switch (cmd) {
      case 'login':
        console.log('✅ Logged in. Session saved at', cfg.sessionPath);
        console.log('\nFor headless deploys (Render etc), set this env var:');
        console.log('  TG_BUCKET_SESSION=' + bucket.tg.client.session.save());
        break;

      case 'put': {
        const [local, key] = args;
        if (!local || !key) throw new Error('Usage: put <localFile> <bucketKey>');
        const stat = fs.statSync(local);
        console.log(`Uploading ${local} (${stat.size} bytes) -> ${key}`);
        const res = await bucket.put(key, fs.createReadStream(local), {
          mimeType: guessMime(local),
          onProgress: ({ phase, idx, uploaded, total }) => {
            if (phase === 'chunk') {
              const pct = ((uploaded / total) * 100).toFixed(1);
              process.stdout.write(`\r  chunk ${idx} ${pct}%   `);
            }
          },
        });
        console.log(`\n✅ ${res.chunks} chunks uploaded, ${res.size} bytes total. manifestId=${res.manifestMessageId}`);
        break;
      }

      case 'get': {
        const [key, local] = args;
        if (!key || !local) throw new Error('Usage: get <bucketKey> <localFile>');
        console.log(`Downloading ${key} -> ${local}`);
        const stream = await bucket.get(key);
        await new Promise((res, rej) => {
          const ws = fs.createWriteStream(local);
          stream.pipe(ws);
          ws.on('finish', res);
          ws.on('error', rej);
        });
        const st = fs.statSync(local);
        console.log(`✅ Wrote ${st.size} bytes to ${local}`);
        break;
      }

      case 'ls': {
        const prefix = args[0] || '';
        const rows = await bucket.list(prefix);
        for (const r of rows) {
          console.log(`${String(r.size).padStart(12)}  ${r.date}  ${r.key}`);
        }
        console.log(`(${rows.length} objects)`);
        break;
      }

      case 'rm': {
        const [key] = args;
        if (!key) throw new Error('Usage: rm <bucketKey>');
        const ok = await bucket.del(key);
        console.log(ok ? '✅ Deleted' : '❌ Not found');
        break;
      }

      case 'stat': {
        const tg = bucket.tg;
        const chat = await tg.resolveBucketChat();
        console.log('Bucket chat:', chat.className, chat.id?.toString?.(), chat.title || '(Saved Messages)');
        console.log('Salt (hex, save this to recover the key):', bucket.getSalt()?.toString('hex'));
        break;
      }

      default:
        throw new Error(`Unknown command: ${cmd}`);
    }
  } finally {
    await bucket.disconnect();
  }
}

function guessMime(p) {
  const ext = path.extname(p).toLowerCase();
  return ({
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.gif': 'image/gif', '.webp': 'image/webp', '.mp4': 'video/mp4',
    '.mp3': 'audio/mpeg', '.pdf': 'application/pdf', '.txt': 'text/plain',
    '.json': 'application/json', '.zip': 'application/zip',
  })[ext] || 'application/octet-stream';
}

main().catch(e => {
  console.error('💥', e.message);
  if (process.env.DEBUG) console.error(e.stack);
  process.exit(1);
});
