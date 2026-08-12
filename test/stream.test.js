// test/stream.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { chunkStream, chunkBuffer, encryptChunkForUpload } from '../src/stream.js';
import { deriveMasterKey, decryptChunk, newFileId, contentHash, constants } from '../src/crypto.js';

const { CHUNK_SIZE } = constants;

test('chunkBuffer yields exact 1 MiB pieces plus a tail', () => {
  const buf = Buffer.alloc(CHUNK_SIZE * 2 + 123);
  const chunks = [...chunkBuffer(buf)];
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].length, CHUNK_SIZE);
  assert.equal(chunks[1].length, CHUNK_SIZE);
  assert.equal(chunks[2].length, 123);
});

test('chunkStream handles a multi-piece Readable correctly', async () => {
  // Simulate a stream that emits in random-sized pieces
  const total = CHUNK_SIZE * 3 + 7;
  const big = Buffer.alloc(total);
  for (let i = 0; i < total; i++) big[i] = i & 0xff;
  // Build a stream that walks the whole buffer in randomized piece sizes
  const stream = Readable.from((function* () {
    let off = 0;
    while (off < total) {
      const s = Math.min(total - off, Math.floor(Math.random() * 900_000) + 1);
      yield big.subarray(off, off + s);
      off += s;
    }
  })());
  const out = [];
  for await (const c of chunkStream(stream)) out.push(c);
  const reassembled = Buffer.concat(out);
  assert.equal(reassembled.length, total);
  assert.equal(reassembled.compare(big), 0);
});

test('encryptChunkForUpload roundtrips via decryptChunk', () => {
  const { key } = deriveMasterKey('pw');
  const fileId = newFileId();
  const plain = Buffer.from('hello world');
  const rec = encryptChunkForUpload(key, fileId, 0, plain);
  assert.equal(rec.idx, 0);
  // rec.ciphertext = ciphertext || tag
  const ct = rec.ciphertext.subarray(0, rec.ciphertext.length - 16);
  const tag = rec.ciphertext.subarray(rec.ciphertext.length - 16);
  const back = decryptChunk(key, fileId, 0, rec.nonce, ct, tag);
  assert.equal(back.compare(plain), 0);
  assert.equal(contentHash(plain).compare(rec.hash), 0);
});
