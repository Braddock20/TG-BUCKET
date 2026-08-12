// src/bucket.js
// High-level Bucket object — the thing your backend actually calls.
//
//   const bucket = await Bucket.connect({ apiId, apiHash, phone, passphrase });
//   await bucket.put('photos/cat.jpg', readFileStream('cat.jpg'), { mimeType: 'image/jpeg' });
//   const stream = await bucket.get('photos/cat.jpg');  // Readable stream of plaintext
//   await bucket.del('photos/cat.jpg');
//   await bucket.list('photos/');
//
// The bucket transparently:
//   - encrypts chunks (AES-256-GCM, scrypt-derived keys)
//   - uploads each chunk as a Document to your private channel
//   - uploads a small encrypted manifest Document
//   - on get, fetches the manifest, then chunks, decrypts and streams them
//   - sharding is per-file (one file == one logical object); we don't split a single file
//     across shards unless it exceeds MAX_FILE_SIZE (then the manifest references a shard chain)

import { Readable, PassThrough } from 'node:stream';
import { TGClient } from './client.js';
import {
  deriveMasterKey, encryptManifest, decryptManifest, decryptChunk,
  newFileId, contentHash, constants,
} from './crypto.js';
import { chunkStream, encryptChunkForUpload } from './stream.js';

const { CHUNK_SIZE, MAX_FILE_SIZE } = constants;

export class Bucket {
  /**
   * @param {object} cfg - see TGClient, plus:
   * @param {string|Uint8Array|Buffer} cfg.passphrase  encryption passphrase OR a 32-byte raw key
   * @param {Buffer} [cfg.salt]  if you have a previously-generated salt, pass it for key continuity
   * @param {string} [cfg.prefix='tg-bucket:']  namespace for this bucket inside the channel
   */
  constructor(cfg) {
    this.cfg = cfg;
    this.tg = new TGClient(cfg);
    this._connected = false;
    this._manifestCache = new Map(); // messageId -> decrypted manifest
  }

  static async connect(cfg) {
    const b = new Bucket(cfg);
    await b.tg.connect();
    b._connected = true;
    // Derive the master key
    if (cfg.rawKey) {
      if (cfg.rawKey.length !== 32) throw new Error('rawKey must be 32 bytes');
      b.masterKey = Buffer.from(cfg.rawKey);
      b.salt = null;
    } else {
      const { key, salt } = deriveMasterKey(cfg.passphrase, cfg.salt);
      b.masterKey = key;
      b.salt = salt;
    }
    return b;
  }

  getSalt() { return this.salt; }

  async disconnect() { await this.tg.disconnect(); this._connected = false; }

  /**
   * Upload a file. `data` can be a Buffer or a Readable stream.
   * @returns {{ key, fileId, size, chunks, totalUploadedBytes }}
   */
  async put(key, data, { mimeType = 'application/octet-stream', onProgress } = {}) {
    if (!this._connected) throw new Error('Bucket not connected');
    const fileId = newFileId();
    const manifestPrefix = this.cfg.prefix || 'tg-bucket:';
    const fullKey = manifestPrefix + key;

    // Collect chunks; for streams we read once into memory in CHUNK_SIZE pieces,
    // uploading each immediately so we never hold the full file.
    // We DO buffer each encrypted chunk in memory (it's at most 1 MiB + overhead)
    // so we can dedup across the same upload if it ever happens.

    const chunkRecords = []; // { idx, hash, nonce, ciphertext, len, messageId? }
    let totalPlaintext = 0;
    let idx = 0;

    const stream = Buffer.isBuffer(data) ? Readable.from([data]) : data;
    for await (const plain of chunkStream(stream)) {
      totalPlaintext += plain.length;
      const rec = encryptChunkForUpload(this.masterKey, fileId, idx, plain);

      // Upload encrypted chunk
      const up = await this.tg.uploadBuffer(rec.ciphertext, {
        fileName: `chunk-${idx}`,
        mimeType: 'application/octet-stream',
        caption: JSON.stringify({
          v: 1,
          kind: 'chunk',
          prefix: manifestPrefix,
          key: fullKey,
          fileId,
          idx: rec.idx,
          hash: rec.hash.toString('hex'),
          nonce: rec.nonce.toString('hex'),
          len: rec.len,
        }),
        progress: onProgress
          ? (uploaded, total) => onProgress({ phase: 'chunk', idx, uploaded, total })
          : undefined,
      });
      chunkRecords.push({ ...rec, messageId: up.messageId, documentId: up.documentId });
      idx++;
    }

    // Build manifest (plaintext JSON)
    const manifest = {
      v: 1,
      key: fullKey,
      fileId,
      mimeType,
      size: totalPlaintext,
      chunkSize: CHUNK_SIZE,
      chunks: chunkRecords.map(c => ({
        idx: c.idx,
        messageId: c.messageId,
        hash: c.hash.toString('hex'),
        nonce: c.nonce.toString('hex'),
        len: c.len,
      })),
    };

    // Encrypt + upload manifest
    const encManifest = encryptManifest(this.masterKey, fileId, manifest);
    const manifestUp = await this.tg.uploadBuffer(encManifest, {
      fileName: 'manifest.enc',
      mimeType: 'application/octet-stream',
      caption: JSON.stringify({
        v: 1,
        kind: 'manifest',
        prefix: manifestPrefix,
        key: fullKey,
        fileId,
        size: totalPlaintext,
        mimeType,
      }),
    });

    return {
      key,
      fileId,
      size: totalPlaintext,
      chunks: chunkRecords.length,
      manifestMessageId: manifestUp.messageId,
    };
  }

  /**
   * Fetch a file. Returns a Readable stream of plaintext bytes.
   * Also returns a promise resolving to the metadata via .meta after stream ends.
   */
  async get(key) {
    if (!this._connected) throw new Error('Bucket not connected');
    const manifestPrefix = this.cfg.prefix || 'tg-bucket:';
    const fullKey = manifestPrefix + key;

    // Find the manifest message
    const all = await this.tg.listObjects({ limit: 200 });
    const manifestMsg = all.find(m => m.meta && m.meta.kind === 'manifest' && m.meta.key === fullKey);
    if (!manifestMsg) throw new Error(`Object not found: ${key}`);

    // Download + decrypt manifest
    const packed = await this.tg.downloadByMessageId(manifestMsg.messageId);
    const { manifest } = decryptManifest(this.masterKey, packed);

    // Build a streaming output that yields each chunk's plaintext in order
    const out = new PassThrough({ objectMode: false });
    (async () => {
      try {
        const tg = this.tg;
        for (const c of manifest.chunks) {
          const buf = await tg.downloadByMessageId(c.messageId);
          // buf is the encrypted chunk bytes (ciphertext || tag)
          const ct = buf.subarray(0, buf.length - 16);
          const tag = buf.subarray(buf.length - 16);
          const nonce = Buffer.from(c.nonce, 'hex');
          const plain = decryptChunk(this.masterKey, manifest.fileId, c.idx, nonce, ct, tag);
          // Verify plaintext hash matches what we recorded (defence in depth)
          const expected = Buffer.from(c.hash, 'hex');
          const got = contentHash(plain);
          if (expected.compare(got) !== 0) {
            out.destroy(new Error(`Chunk ${c.idx} hash mismatch — possible tampering`));
            return;
          }
          // Respect backpressure
          if (!out.write(plain)) {
            await new Promise(r => out.once('drain', r));
          }
        }
        out.end();
      } catch (e) {
        out.destroy(e);
      }
    })();

    // Attach metadata for callers
    out.meta = { ...manifest, key };
    return out;
  }

  /**
   * List keys under a prefix. Returns [{ key, size, mimeType, date, manifestMessageId }]
   */
  async list(prefix = '') {
    if (!this._connected) throw new Error('Bucket not connected');
    const manifestPrefix = this.cfg.prefix || 'tg-bucket:';
    const fullPrefix = manifestPrefix + prefix;
    const out = [];
    let offsetId = 0;
    // Telegram caps getMessages at 100; paginate
    // (Telegram also returns a "next offset" implicit when more exist; we just loop.)
    // To avoid hammering for very large buckets, cap at 1000 by default.
    for (let safety = 0; safety < 200; safety++) {
      const msgs = await this.tg.listObjects({ limit: 100, offsetId });
      if (msgs.length === 0) break;
      for (const m of msgs) {
        if (m.meta && m.meta.kind === 'manifest' && m.meta.key?.startsWith(fullPrefix)) {
          out.push({
            key: m.meta.key.slice(manifestPrefix.length),
            size: m.meta.size,
            mimeType: m.meta.mimeType,
            date: m.date,
            manifestMessageId: m.messageId,
          });
        }
      }
      offsetId = msgs[msgs.length - 1].messageId;
      if (msgs.length < 100) break;
    }
    return out;
  }

  /**
   * Delete a key and all its chunk messages + the manifest.
   */
  async del(key) {
    if (!this._connected) throw new Error('Bucket not connected');
    const manifestPrefix = this.cfg.prefix || 'tg-bucket:';
    const fullKey = manifestPrefix + key;
    const all = await this.tg.listObjects({ limit: 200 });
    const matching = all.filter(m => m.meta?.key === fullKey);
    if (matching.length === 0) return false;
    for (const m of matching) {
      await this.tg.deleteByMessageId(m.messageId);
    }
    return true;
  }
}
