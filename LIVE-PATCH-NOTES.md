# Live deployment patch

This patch is based directly on the uploaded live project archive.

## Fixed
- Telegram document discovery now accepts both `message.document` and `message.media.document`.
- File download lookup uses the same normalized document handling.
- Filename extraction is tolerant of Teleproto/GramJS attribute shapes.
- Bucket list pagination safety ceiling increased from 50 to 200 pages.

## Intentionally unchanged
- Upload/encryption/chunking logic
- Telegram session/authentication
- API routes and CORS
- CLI
- Environment variable names

## Validation
Node syntax checks passed for:
- api.js
- src/client.js
- src/bucket.js
- src/index.js

A real Telegram end-to-end test still requires deployment with the live Telegram session.
