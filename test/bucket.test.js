// test/bucket.test.js
// Mocked end-to-end test of the bucket pipeline: put -> get roundtrip
// with a fake TGClient, exercising encryption, chunking, manifest, streaming
// decryption and tamper detection.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { Bucket } from '../src/bucket.js';
import { deriveMasterKey } from '../src/crypto.js';

// In-memory fake of a Telegram bucket chat.
// Each upload stores { id, document (Buffer), caption (string) }.
function makeFakeTelegram() {
  const store = new Map(); // messageId -> { id, document, caption }
  let nextId = 1;
  const getCaption = (s) => { try { return JSON.parse(s); } catch { return null; } };

  const tg = {
    _list: () => [...store.values()].sort((a, b) => b.id - a.id),
    _connectCalled: false,
    async connect() { this._connectCalled = true; },
    async disconnect() {},
    async resolveBucketChat() { return { className: 'User', id: 1 }; },
    async uploadBuffer(buf, { fileName, mimeType, caption, progress } = {}) {
      const id = nextId++;
      const rec = { id, document: { id: BigInt(id), size: BigInt(buf.length), mimeType, attributes: [{ className: 'DocumentAttributeFilename', fileName }] }, caption, message: caption, media: { document: { id: BigInt(id) } }, date: Math.floor(Date.now()/1000) };
      store.set(id, rec);
      return { messageId: id, documentId: String(id), date: rec.date, size: buf.length };
    },
    async downloadByMessageId(id) {
      const r = store.get(id);
      if (!r) throw new Error('not found ' + id);
      return r.document && Buffer.isBuffer(r.document) ? r.document : (r._buf || Buffer.alloc(0));
    },
    async listObjects({ limit = 100, offsetId = 0 } = {}) {
      const all = this._list();
      return all.filter(m => (!offsetId || m.id < offsetId) && m.document)
        .slice(0, limit)
        .map(m => {
          const meta = getCaption(m.caption);
          return {
            messageId: m.id,
            documentId: m.document.id?.toString(),
            size: Number(m.document.size?.toString() || (m._buf?.length || 0)),
            date: m.date,
            meta,
            fileName: m.document.attributes?.find(a => a.className === 'DocumentAttributeFilename')?.fileName,
            mimeType: m.document.mimeType,
          };
        });
    },
    async deleteByMessageId(id) { store.delete(id); },
  };
  // Patch downloadByMessageId to return _buf when present
  const origDownload = tg.downloadByMessageId.bind(tg);
  tg.downloadByMessageId = async (id) => {
    const r = store.get(id);
    if (!r) throw new Error('not found ' + id);
    return r._buf || Buffer.alloc(0);
  };
  // Patch uploadBuffer to actually keep the bytes
  const origUpload = tg.uploadBuffer.bind(tg);
  tg.uploadBuffer = async (buf, opts = {}) => {
    const id = nextId++;
    const rec = { id, _buf: buf, caption: opts.caption || '', message: opts.caption || '', document: { id: BigInt(id), size: BigInt(buf.length), mimeType: opts.mimeType, attributes: [{ className: 'DocumentAttributeFilename', fileName: opts.fileName }] }, media: { document: { id: BigInt(id) } }, date: Math.floor(Date.now()/1000) };
    store.set(id, rec);
    return { messageId: id, documentId: String(id), date: rec.date, size: buf.length };
  };
  return tg;
}

// Helper: build a Bucket wired to the fake TG.
function makeBucket(tg) {
  // The Bucket constructor expects cfg and calls new TGClient(cfg).
  // We bypass by injecting a partial config + reaching into the instance.
  const cfg = {
    apiId: 1, apiHash: 'x', phone: '+1',
    bucketChannel: null,
    passphrase: 'unit-test-passphrase',
  };
  const b = Object.create(Bucket.prototype);
  b.cfg = cfg;
  b.tg = tg;
  b._connected = true;
  // Derive the same key the real connect() would
  const { key } = deriveMasterKey(cfg.passphrase);
  b.masterKey = key;
  b.salt = null;
  b._manifestCache = new Map();
  return b;
}

test('bucket.put + bucket.get roundtrip a small buffer', async () => {
  const tg = makeFakeTelegram();
  const b = await makeBucket(tg);
  const data = Buffer.from('Hello encrypted bucket! ' + 'x'.repeat(100));
  const r = await b.put('hello.txt', data, { mimeType: 'text/plain' });
  assert.equal(r.key, 'hello.txt');
  assert.equal(r.size, data.length);
  assert.ok(r.chunks >= 1);

  const stream = await b.get('hello.txt');
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  const out = Buffer.concat(chunks);
  assert.equal(out.compare(data), 0);
  assert.equal(stream.meta.size, data.length);
});

test('bucket.put + bucket.get roundtrip a 3 MiB buffer (multi-chunk)', async () => {
  const tg = makeFakeTelegram();
  const b = await makeBucket(tg);
  const data = Buffer.alloc(3 * 1024 * 1024 + 17);
  for (let i = 0; i < data.length; i++) data[i] = i & 0xff;
  const r = await b.put('big.bin', data);
  // 1 MiB chunks => 4 chunks
  assert.equal(r.chunks, 4);
  const stream = await b.get('big.bin');
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  const out = Buffer.concat(chunks);
  assert.equal(out.length, data.length);
  assert.equal(out.compare(data), 0);
});

test('bucket.put from a Readable stream', async () => {
  const tg = makeFakeTelegram();
  const b = await makeBucket(tg);
  const data = Buffer.from('streamed payload that is bigger than one chunk?'.repeat(50000));
  const stream = Readable.from((function* () {
    let off = 0;
    while (off < data.length) {
      const n = Math.min(data.length - off, 100_000);
      yield data.subarray(off, off + n);
      off += n;
    }
  })());
  await b.put('streamed.bin', stream);
  const out = await b.get('streamed.bin');
  const got = [];
  for await (const c of out) got.push(c);
  assert.equal(Buffer.concat(got).compare(data), 0);
});

test('bucket.get detects chunk tampering', async () => {
  const tg = makeFakeTelegram();
  const b = await makeBucket(tg);
  const data = Buffer.alloc(2 * 1024 * 1024 + 5, 0x42);
  await b.put('tamper.bin', data);
  // Tamper: find a chunk record and flip a byte in the stored ciphertext
  const all = await tg.listObjects({ limit: 100 });
  const chunkRec = all.find(m => m.meta?.kind === 'chunk');
  assert.ok(chunkRec, 'expected to find a chunk record');
  // Mutate the fake's stored buf
  // The fake stores _buf keyed by messageId. We need a hook.
  // Instead, re-derive: the TGClient downloadByMessageId returns the buf.
  // We can find the message by documentId / messageId and mutate it via the test's own backdoor.
  // Easiest: read the original buf, flip a byte, and override the fake's _store.
  // We didn't expose _store; we exposed tg._list(). Let's add a tamper helper:
  tg._tamper = (id) => {
    const r = [...tg._list()].find(x => x.id === id);
    if (r && r._buf) r._buf[0] ^= 0xff;
  };
  tg._tamper(chunkRec.messageId);

  const stream = await b.get('tamper.bin');
  await new Promise((res, rej) => {
    stream.on('error', (err) => {
      // Either the GCM auth tag fails first (preferred) or our defence-in-depth
      // content-hash check kicks in. Both prove tampering was detected.
      assert.ok(
        /hash mismatch|authenticate data|Unsupported state/i.test(err.message),
        `unexpected error: ${err.message}`,
      );
      res();
    });
    stream.on('end', () => rej(new Error('stream ended without error — tamper not detected!')));
    stream.resume();
  });
});

test('bucket.list returns manifest entries only', async () => {
  const tg = makeFakeTelegram();
  const b = await makeBucket(tg);
  await b.put('a.txt', Buffer.from('A'));
  await b.put('b.txt', Buffer.from('B'));
  const list = await b.list('');
  const keys = list.map(x => x.key).sort();
  assert.deepEqual(keys, ['a.txt', 'b.txt']);
});

test('bucket.del removes all messages for a key', async () => {
  const tg = makeFakeTelegram();
  const b = await makeBucket(tg);
  await b.put('gone.bin', Buffer.alloc(2 * 1024 * 1024, 7));
  const before = (await b.list('')).length;
  assert.equal(before, 1);
  const ok = await b.del('gone.bin');
  assert.equal(ok, true);
  const after = (await b.list('')).length;
  assert.equal(after, 0);
});
