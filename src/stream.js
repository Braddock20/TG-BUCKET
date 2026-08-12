// src/stream.js
// Streaming-friendly chunked upload/download over Telegram.
//
// Why a custom chunker instead of one giant upload?
// - Memory: a 1.5 GB file in one Buffer is 1.5 GB of RAM. We want O(1) memory.
// - Reliability: per-chunk Documents can be retried independently.
// - Dedup: identical chunks across files only uploaded once.
//
// We split the input into 1 MiB plaintext chunks, encrypt each, and upload
// each encrypted blob as a separate Telegram Document. The manifest is
// uploaded last as a tiny Document too. On download we read the manifest
// first, then stream each chunk back to a consumer.

import { Readable, PassThrough } from 'node:stream';
import {
  encryptChunk, decryptChunk, encryptManifest, decryptManifest,
  newFileId, contentHash, constants,
} from './crypto.js';

const { CHUNK_SIZE } = constants;

/**
 * Split a Buffer/stream into 1 MiB chunks, yielding each as a Buffer.
 * For Buffer input only. For stream input use chunkStream().
 */
export function* chunkBuffer(buf) {
  let off = 0;
  while (off < buf.length) {
    yield buf.subarray(off, off + CHUNK_SIZE);
    off += CHUNK_SIZE;
  }
}

/**
 * Given a Readable stream of plaintext, yield successive chunks of <= CHUNK_SIZE.
 * Handles backpressure correctly.
 */
export async function* chunkStream(stream) {
  let buf = Buffer.alloc(0);
  for await (const piece of stream) {
    buf = Buffer.concat([buf, piece]);
    while (buf.length >= CHUNK_SIZE) {
      yield buf.subarray(0, CHUNK_SIZE);
      buf = buf.subarray(CHUNK_SIZE);
    }
  }
  if (buf.length > 0) yield buf;
}

/**
 * Encrypted upload of a single chunk, returning a metadata record.
 * Caller is responsible for actually uploading via the TGClient.
 *
 * @returns {{ idx, hash, nonce, ciphertext, tag, len }}
 */
export function encryptChunkForUpload(masterKey, fileId, idx, plaintext) {
  const { nonce, ciphertext, tag } = encryptChunk(masterKey, fileId, idx, plaintext);
  const hash = contentHash(plaintext);
  return { idx, hash, nonce, ciphertext: Buffer.concat([ciphertext, tag]), len: plaintext.length };
}
