// src/crypto.js
// Client-side encryption layer.
// - AES-256-GCM per chunk (authenticated encryption with associated data)
// - scrypt KDF for passphrase -> master key
// - HKDF-SHA256 for deriving per-file + per-chunk subkeys
// - Optional chunk-level deduplication via BLAKE3-style hash (we use built-in crypto since BLAKE3 isn't in node stdlib)

import crypto from 'node:crypto';

const SCRYPT_PARAMS = { N: 1 << 15, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const CHUNK_SIZE = 1024 * 1024;          // 1 MiB plaintext chunks
const MAX_FILE_SIZE = 1536 * 1024 * 1024; // 1.5 GiB per shard (under 2 GB MTProto limit, headroom for overhead)
const NONCE_LEN = 12;
const TAG_LEN = 16;
const MAGIC = Buffer.from('TGB1');      // 4-byte magic prefix to identify our format

/**
 * Derive a 32-byte master key from a passphrase using scrypt.
 * Salt is generated randomly and returned alongside the key.
 */
export function deriveMasterKey(passphrase, salt = crypto.randomBytes(16)) {
  const key = crypto.scryptSync(
    Buffer.from(passphrase, 'utf8'),
    salt,
    32,
    SCRYPT_PARAMS,
  );
  return { key, salt };
}

/**
 * HKDF-SHA256. info is a string descriptor (e.g. "file:abc123" or "chunk:5").
 */
function hkdf(masterKey, info, length = 32) {
  // Simple HKDF using node's crypto.hkdfSync (Node 15+).
  return crypto.hkdfSync('sha256', masterKey, Buffer.alloc(0), Buffer.from(info, 'utf8'), length);
}

/**
 * Encrypt a single chunk. Returns { nonce, ciphertext, tag }.
 * AAD binds the chunk to (fileId, chunkIndex) so chunks can't be swapped.
 */
export function encryptChunk(masterKey, fileId, chunkIndex, plaintext) {
  const fileKey = hkdf(masterKey, `file:${fileId}`, 32);
  const chunkKey = hkdf(fileKey, `chunk:${chunkIndex}`, 32);
  const nonce = crypto.randomBytes(NONCE_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', chunkKey, nonce);
  cipher.setAAD(Buffer.from(`${fileId}:${chunkIndex}`, 'utf8'));
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { nonce, ciphertext: enc, tag };
}

/**
 * Decrypt a single chunk. Throws on tag mismatch (= tamper / wrong key / wrong index).
 */
export function decryptChunk(masterKey, fileId, chunkIndex, nonce, ciphertext, tag) {
  const fileKey = hkdf(masterKey, `file:${fileId}`, 32);
  const chunkKey = hkdf(fileKey, `chunk:${chunkIndex}`, 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', chunkKey, nonce);
  decipher.setAAD(Buffer.from(`${fileId}:${chunkIndex}`, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Hash a buffer for dedup. Uses BLAKE3 if available (via crypto.hash blake3 if Node 22+),
 * otherwise falls back to SHA-256. Both are collision-resistant for our purposes.
 */
export function contentHash(buf) {
  // Node 22 has crypto.hash(alg, data) for blake3 in some builds; safest is sha256.
  return crypto.createHash('sha256').update(buf).digest();
}

/**
 * Build a file manifest (encrypted, small) that we store alongside the data chunks.
 * The manifest itself is encrypted with the fileKey and contains:
 *   { name, mime, size, chunkSize, chunks: [{ hash, nonce, tag, len }] }
 * Stored as a tiny Document in the same channel.
 */
export function encryptManifest(masterKey, fileId, manifest) {
  const fileKey = hkdf(masterKey, `file:${fileId}`, 32);
  const nonce = crypto.randomBytes(NONCE_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', fileKey, nonce);
  cipher.setAAD(Buffer.from(`manifest:${fileId}`, 'utf8'));
  const plaintext = Buffer.from(JSON.stringify(manifest), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Pack: MAGIC(4) | fileIdLen(1) | fileId | nonce(12) | tag(16) | ciphertext
  const fileIdBytes = Buffer.from(fileId, 'utf8');
  if (fileIdBytes.length > 255) throw new Error('fileId too long');
  return Buffer.concat([
    MAGIC,
    Buffer.from([fileIdBytes.length]),
    fileIdBytes,
    nonce,
    tag,
    ciphertext,
  ]);
}

export function decryptManifest(masterKey, packed) {
  if (packed.subarray(0, 4).compare(MAGIC) !== 0) {
    throw new Error('Not a tg-bucket manifest (bad magic)');
  }
  let off = 4;
  const fileIdLen = packed[off++];
  const fileId = packed.subarray(off, off + fileIdLen).toString('utf8');
  off += fileIdLen;
  const nonce = packed.subarray(off, off + NONCE_LEN); off += NONCE_LEN;
  const tag = packed.subarray(off, off + TAG_LEN); off += TAG_LEN;
  const ciphertext = packed.subarray(off);

  const fileKey = hkdf(masterKey, `file:${fileId}`, 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', fileKey, nonce);
  decipher.setAAD(Buffer.from(`manifest:${fileId}`, 'utf8'));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return { fileId, manifest: JSON.parse(plaintext.toString('utf8')) };
}

/**
 * Generate a new random fileId (16 bytes hex).
 */
export function newFileId() {
  return crypto.randomBytes(16).toString('hex');
}

export const constants = {
  CHUNK_SIZE,
  MAX_FILE_SIZE,
  NONCE_LEN,
  TAG_LEN,
  MAGIC,
};
