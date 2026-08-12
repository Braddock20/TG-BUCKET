// examples/basic.js
// Run after copying .env.example to .env and filling it in.

import 'dotenv/config';
import fs from 'node:fs';
import { Bucket } from '../src/index.js';

const cfg = {
  apiId: Number(process.env.TG_API_ID),
  apiHash: process.env.TG_API_HASH,
  phone: process.env.TG_PHONE,
  passphrase: process.env.TG_BUCKET_PASSPHRASE,
  bucketChannel: process.env.TG_BUCKET_CHANNEL, // omit to use Saved Messages
};

const bucket = await Bucket.connect(cfg);
console.log('Connected. Salt (hex, save it!):', bucket.getSalt()?.toString('hex'));

// 1) Upload a text file
const data = Buffer.from('Hello from tg-bucket! ' + new Date().toISOString());
const r = await bucket.put('hello.txt', data, { mimeType: 'text/plain' });
console.log('Uploaded hello.txt', r);

// 2) Download it back as a stream
const stream = await bucket.get('hello.txt');
const chunks = [];
for await (const c of stream) chunks.push(c);
const roundtrip = Buffer.concat(chunks).toString('utf8');
console.log('Roundtrip:', roundtrip);
console.log('Meta:', stream.meta.size, 'bytes;', stream.meta.chunks.length, 'chunks');

// 3) List
const all = await bucket.list('');
console.log('All objects:', all);

// 4) Delete
const ok = await bucket.del('hello.txt');
console.log('Deleted hello.txt:', ok);

await bucket.disconnect();
