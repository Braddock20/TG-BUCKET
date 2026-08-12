// test/crypto.test.js
// Pure-crypto tests — no Telegram needed. These verify the encryption
// layer is correct: roundtrip, tamper detection, chunk binding, manifest.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveMasterKey, encryptChunk, decryptChunk,
  encryptManifest, decryptManifest, newFileId, contentHash, constants,
} from '../src/crypto.js';

test('roundtrip: encrypt + decrypt a chunk yields the original bytes', () => {
  const { key } = deriveMasterKey('correct horse battery staple');
  const fileId = newFileId();
  const plain = Buffer.from('the quick brown fox jumps over the lazy dog');
  const { nonce, ciphertext, tag } = encryptChunk(key, fileId, 0, plain);
  const back = decryptChunk(key, fileId, 0, nonce, ciphertext, tag);
  assert.equal(back.compare(plain), 0);
});

test('wrong key fails decryption (auth tag mismatch)', () => {
  const { key: k1 } = deriveMasterKey('passphrase-A');
  const { key: k2 } = deriveMasterKey('passphrase-B');
  const fileId = newFileId();
  const { nonce, ciphertext, tag } = encryptChunk(k1, fileId, 0, Buffer.from('secret'));
  assert.throws(() => decryptChunk(k2, fileId, 0, nonce, ciphertext, tag));
});

test('wrong chunk index fails decryption (AAD binding)', () => {
  const { key } = deriveMasterKey('pw');
  const fileId = newFileId();
  const { nonce, ciphertext, tag } = encryptChunk(key, fileId, 0, Buffer.from('data'));
  // Same ciphertext+tag, but we claim it is chunk 1 instead of 0 -> must fail
  assert.throws(() => decryptChunk(key, fileId, 1, nonce, ciphertext, tag));
});

test('tampered ciphertext is detected (GCM auth tag)', () => {
  const { key } = deriveMasterKey('pw');
  const fileId = newFileId();
  const { nonce, ciphertext, tag } = encryptChunk(key, fileId, 0, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
  // Flip a bit
  ciphertext[0] ^= 0x01;
  assert.throws(() => decryptChunk(key, fileId, 0, nonce, ciphertext, tag));
});

test('manifest roundtrip preserves structure', () => {
  const { key } = deriveMasterKey('pw');
  const fileId = newFileId();
  const manifest = {
    key: 'photos/cat.jpg',
    size: 12345,
    chunkSize: 1024 * 1024,
    chunks: [
      { idx: 0, messageId: 100, hash: 'aaaa', nonce: 'bbbb', len: 1048576 },
      { idx: 1, messageId: 101, hash: 'cccc', nonce: 'dddd', len: 6789 },
    ],
  };
  const packed = encryptManifest(key, fileId, manifest);
  const { fileId: fid2, manifest: m2 } = decryptManifest(key, packed);
  assert.equal(fid2, fileId);
  assert.deepEqual(m2, manifest);
});

test('newFileId is 32 hex chars and unique', () => {
  const ids = new Set();
  for (let i = 0; i < 1000; i++) ids.add(newFileId());
  assert.equal(ids.size, 1000);
  assert.equal([...ids][0].length, 32);
});

test('contentHash is deterministic and 32 bytes (SHA-256 output)', () => {
  const a = contentHash(Buffer.from('hello'));
  const b = contentHash(Buffer.from('hello'));
  assert.equal(a.compare(b), 0);
  assert.equal(a.length, 32);
});

test('two different files -> different manifest ciphertexts (random nonces)', () => {
  const { key } = deriveMasterKey('pw');
  const fileId = newFileId();
  const m = { key: 'x', chunks: [] };
  const a = encryptManifest(key, fileId, m);
  const b = encryptManifest(key, fileId, m);
  assert.notEqual(a.compare(b), 0);
});

test('decryptManifest rejects bad magic', () => {
  const { key } = deriveMasterKey('pw');
  const fake = Buffer.concat([Buffer.from('NOPE'), Buffer.alloc(100)]);
  assert.throws(() => decryptManifest(key, fake));
});
