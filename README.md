# tg-bucket

> Turn your Telegram account into an **encrypted, almost-unlimited object storage** backend.
> Client-side AES-256-GCM, scrypt-derived keys, MTProto chunked uploads. Your files are
> never readable by Telegram — only ciphertext goes through their servers.

```
┌──────────────┐    put/get    ┌────────────────┐
│  Your app    │  ──────────▶  │   tg-bucket    │
│  (backend)   │  ◀──────────  │   (this lib)   │
└──────────────┘               └───────┬────────┘
                                       │ AES-256-GCM chunks
                                       ▼
                              ┌────────────────┐
                              │  Telegram DCs  │   (1.5 GB/file,
                              │  Saved Msgs or │    4000+ parts OK,
                              │  private chan  │    parallel queues)
                              └────────────────┘
```

## Why

- Telegram's MTProto API accepts uploads up to **2 GB per file** (4 GB for premium)
  from a user account. There is no published per-account storage cap.
- You keep full control: encryption happens on your machine, Telegram only sees
  opaque byte blobs.
- Drop-in `Bucket` object with `put`, `get`, `del`, `list` — same shape as S3 / R2.

## Install

```bash
git clone <this-repo> tg-bucket
cd tg-bucket
npm install
cp .env.example .env
# edit .env with TG_API_ID, TG_API_HASH, TG_PHONE, TG_BUCKET_PASSPHRASE
```

Get `TG_API_ID` and `TG_API_HASH` from <https://my.telegram.org/apps>.

## Quick start

```js
import 'dotenv/config';
import { Bucket } from 'tg-bucket';

const bucket = await Bucket.connect({
  apiId:    Number(process.env.TG_API_ID),
  apiHash:  process.env.TG_API_HASH,
  phone:    process.env.TG_PHONE,
  passphrase: process.env.TG_BUCKET_PASSPHRASE,
  // bucketChannel: '@my_private_channel',   // optional, defaults to Saved Messages
});

await bucket.put('photos/cat.jpg', fs.createReadStream('cat.jpg'), { mimeType: 'image/jpeg' });

const stream = await bucket.get('photos/cat.jpg');
stream.pipe(fs.createWriteStream('cat-back.jpg'));

console.log(await bucket.list('photos/'));
```

## CLI

```bash
node bin/tg-bucket.js login
node bin/tg-bucket.js put ./movie.mp4 videos/movie.mp4
node bin/tg-bucket.js get videos/movie.mp4 ./movie-copy.mp4
node bin/tg-bucket.js ls videos/
node bin/tg-bucket.js rm videos/movie.mp4
node bin/tg-bucket.js stat
```

## Security model

| Layer | Mechanism |
|---|---|
| Passphrase → master key | **scrypt** (N=2¹⁵, r=8, p=1) — memory-hard, GPU-unfriendly |
| Per-file subkey | **HKDF-SHA256** over `file:<fileId>` |
| Per-chunk subkey | **HKDF-SHA256** over `chunk:<index>` (distinct keys per chunk) |
| Chunk encryption | **AES-256-GCM** with random 12-byte nonce, 16-byte auth tag |
| Chunk binding | AAD = `"<fileId>:<index>"` → chunks can't be reordered or swapped across files |
| Manifest | Tiny encrypted Document describing all chunks (name, mime, hash, nonce, size) |
| Key continuity | The scrypt **salt** is returned by `bucket.getSalt()` — **save it** alongside your passphrase or you can't decrypt later |

**Threats mitigated:**
- Telegram operators reading your data → only ciphertext reaches their servers
- Reused IVs → every chunk has its own random nonce
- Chunk swapping attacks → AAD binds chunks to their position; GCM tag detects any tampering
- Brute force on weak passphrases → scrypt makes each guess cost ~100 ms + 256 MB RAM
- Passphrase leak without salt → salt doesn't help the attacker much (scrypt is the work factor); but always keep them separate

**Threats NOT mitigated (be aware):**
- Anyone with both the passphrase AND the salt can decrypt — that's by design
- Telegram will still see *that* you uploaded, when, and how much (metadata channel)
- Telegram can theoretically delete your data (they store it; you don't have a backup). For truly durable storage, replicate to a second channel or pair with a real object store

## Architecture notes

- One Telegram **Document** per chunk (1 MiB plaintext → ~1 MiB + 16 bytes ciphertext + 12 bytes nonce, packed into a CustomFile).
- One extra **Document** for the encrypted manifest.
- The bucket chat (your "Saved Messages" or a private channel) is the namespace.
- We tag each Document's `caption` with a small JSON header (`{ kind, key, fileId, idx, … }`) so listing is metadata-only — no need to download anything to list.
- Telegram's MTProto supports up to ~4000 file parts per upload for non-premium, more for premium. At our 512 KB part size (which is the Telegram-recommended part size), 4000 parts = 2 GB. So a single upload of a 1.5 GiB file fits comfortably.

## Limits

| | Non-premium | Premium |
|---|---|---|
| Single file | 2 GB | 4 GB |
| Parts per upload | ~4000 | more |
| Daily upload cap | soft; FLOOD_WAIT possible | higher |

For >2 GB files, the bucket will (in a future version) auto-shard across multiple Telegram uploads. Today you can split manually with `split -b 1500m`.

## Tests

```bash
npm test
```

The crypto and streaming layers are fully tested. The MTProto client itself requires real Telegram credentials to exercise end-to-end.

## Files

```
src/
  crypto.js     AES-256-GCM, scrypt, HKDF, manifest packing
  stream.js     plaintext chunking for streams and buffers
  client.js     GramJS wrapper: auth, upload, download, list
  bucket.js     put/get/del/list — the high-level API
  index.js      re-exports
bin/
  tg-bucket.js  CLI
examples/
  basic.js          local roundtrip demo
  express-server.js S3-ish HTTP gateway
test/
  crypto.test.js    roundtrip, tamper, AAD, manifest
  stream.test.js    chunking correctness
```

## License

MIT

## HTTP API (Render / headless server)

The repository includes a dependency-light production API in `api.js`.
It uses Node's built-in HTTP server and streams uploads into `Bucket.put`, so it does not load a whole upload into RAM.

Set these variables on Render:

```bash
TG_API_ID=...
TG_API_HASH=...
TG_PHONE=...
TG_BUCKET_PASSPHRASE=...
TG_BUCKET_SESSION=...
TG_BUCKET_API_KEY=... # optional but strongly recommended
```

Set the Render start command to:

```bash
npm start
```

Endpoints:

```text
GET    /health             health check
GET    /api                API information
GET    /files              list objects
PUT    /files/:key         upload (request body is the file)
GET    /files/:key         download
DELETE /files/:key         delete
```

If `TG_BUCKET_API_KEY` is set, send:

```text
Authorization: Bearer YOUR_API_KEY
```

Example upload:

```bash
curl -X PUT \
  'https://YOUR-RENDER-URL.onrender.com/files/hello.txt' \
  -H 'Authorization: Bearer YOUR_API_KEY' \
  -H 'Content-Type: text/plain' \
  --data-binary 'Hello from TG-BUCKET'
```

Example list:

```bash
curl 'https://YOUR-RENDER-URL.onrender.com/files' \
  -H 'Authorization: Bearer YOUR_API_KEY'
```

Example download:

```bash
curl 'https://YOUR-RENDER-URL.onrender.com/files/hello.txt' \
  -H 'Authorization: Bearer YOUR_API_KEY' \
  -o hello.txt
```

The original CLI and `examples/express-server.js` are left in place; the new API is an additional entry point.
