// src/client.js
// Thin wrapper around GramJS that gives us the operations we need:
//   - connect / login (with session persistence)
//   - resolveBucketChannel() -> the channel/chat that holds our objects
//   - uploadBigBuffer(buf, name, caption) -> Telegram message with Document
//   - downloadDocument(message) -> Buffer
//   - listObjects(prefix?) -> Array<{ key, size, messageId, date }>
//
// Uploads use the parallel-queue strategy recommended by Telegram:
// multiple chunks in flight across one or more TCP connections.

// teleproto is a CommonJS package; we use the default import for the surface
// and named imports for the subpath modules (sessions).
import teleproto from 'teleproto';
const { TelegramClient, Api } = teleproto;
import { CustomFile } from 'teleproto/client/uploads.js';
import fs from 'node:fs';
import { StringSession } from 'teleproto/sessions/index.js';
import readline from 'node:readline/promises';

async function promptOnce(query) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(query)).trim();
  } finally {
    rl.close();
  }
}

export class TGClient {
  /**
   * @param {object} cfg
   * @param {number} cfg.apiId
   * @param {string} cfg.apiHash
   * @param {string} cfg.phone
   * @param {string} [cfg.session]   saved StringSession to skip re-login
   * @param {string} [cfg.bucketChannel]  @username or numeric id; if omitted, uses "Saved Messages"
   * @param {string} [cfg.sessionPath='./tg-bucket.session']  where to persist the StringSession
   */
  constructor(cfg) {
    if (!cfg.apiId || !cfg.apiHash) throw new Error('apiId and apiHash required');
    this.cfg = cfg;
    this.sessionPath = cfg.sessionPath || './tg-bucket.session';
    this.bucketChannelRef = cfg.bucketChannel || null; // resolved lazily
    this._resolvedChat = null;
  }

  async connect() {
    let sessionStr = '';
    if (fs.existsSync(this.sessionPath)) {
      sessionStr = fs.readFileSync(this.sessionPath, 'utf8').trim();
    } else if (this.cfg.session) {
      sessionStr = this.cfg.session;
    }
    const hasUsableSession = !!(sessionStr && sessionStr.length > 0);

    // Fail FAST on headless deploys instead of looping against Telegram forever.
    // process.stdin.isTTY is not a reliable "can a human type here" check on
    // platforms like Render — don't rely on it to decide whether to bail.
    const canPrompt = !!process.stdin.isTTY;
    if (!hasUsableSession && !this.cfg.phoneCode && !process.env.TG_PHONE_CODE && !canPrompt) {
      throw new Error(
        '[tg] No saved session and no way to get a login code (no TTY, no phoneCode, no TG_PHONE_CODE). ' +
        'Run `node bin/tg-bucket.js login` locally first, then set the printed session string as ' +
        'TG_BUCKET_SESSION on your server.'
      );
    }

    const session = new StringSession(sessionStr);
    this.client = new TelegramClient(session, this.cfg.apiId, this.cfg.apiHash, {
      connectionRetries: 5,
      retryDelay: 1000,
      useWSS: false,
    });

    let authError = null;
    await this.client.start({
      phoneNumber: async () => this.cfg.phone,
      password: async () => {
        if (this.cfg.password) return String(this.cfg.password);
        if (canPrompt) return promptOnce('[tg] 2FA password (leave blank if none): ');
        return '';
      },
      // phoneCode MUST be an async function — teleproto calls it, it does not
      // accept a raw string. Passing cfg.phoneCode directly (the old bug) meant
      // this always resolved to undefined, which Telegram rejects as an empty code.
      phoneCode: async () => {
        if (this.cfg.phoneCode) return String(this.cfg.phoneCode);
        if (process.env.TG_PHONE_CODE) return process.env.TG_PHONE_CODE;
        if (canPrompt) return promptOnce('[tg] Enter the login code Telegram sent you: ');
        throw new Error('No phoneCode available and no interactive TTY to prompt for one');
      },
      onError: (err) => {
        authError = err;
        console.error('[tg] auth error:', err.message);
        return true; // REQUIRED: stop the retry loop. Without this, teleproto
                      // retries the same failing attempt indefinitely.
      },
    });

    if (authError && !hasUsableSession) {
      throw new Error(`[tg] Authentication failed: ${authError.message}`);
    }

    // Persist the new session string
    const newSession = this.client.session.save();
    if (newSession && (!sessionStr || newSession !== sessionStr)) {
      fs.writeFileSync(this.sessionPath, newSession, { mode: 0o600 });
      console.log('[tg] session saved to', this.sessionPath);
      console.log('[tg] For headless deploys, set this as TG_BUCKET_SESSION:', newSession);
    }
    return this;
  }

  async disconnect() {
    if (this.client) await this.client.disconnect();
  }

  /**
   * Resolve where to put objects. If a bucketChannel is set, ensure it exists
   * (creating a private supergroup if needed) and return its entity.
   * Otherwise return "me" (Saved Messages).
   */
  async resolveBucketChat() {
    if (this._resolvedChat) return this._resolvedChat;

    if (!this.bucketChannelRef) {
      this._resolvedChat = await this.client.getEntity('me');
      return this._resolvedChat;
    }

    // Try to resolve as-is
    try {
      this._resolvedChat = await this.client.getEntity(this.bucketChannelRef);
      return this._resolvedChat;
    } catch (e) {
      // If it looks like a username and isn't found, try to create it
      if (typeof this.bucketChannelRef === 'string' && this.bucketChannelRef.startsWith('@')) {
        console.log('[tg] bucket channel not found, creating…');
        const title = `tg-bucket-${Date.now()}`;
        const created = await this.client.invoke(
          new Api.channels.CreateChannel({
            title,
            about: 'Encrypted object storage bucket (tg-bucket). Do not post here manually.',
            megagroup: true,
            forImport: false,
          }),
        );
        // We get a Channel with no username yet; convert to private supergroup
        const ch = new Api.Channel({
          ...created.chats[0],
          access_hash: created.chats[0].access_hash,
        });
        // For simplicity, just use it as-is. You can later set a username via channels.updateUsername.
        this._resolvedChat = ch;
        console.log('[tg] created bucket channel id', ch.id, '(set a username later if you want)');
        return ch;
      }
      throw e;
    }
  }

  /**
   * Upload a buffer as a Document to the bucket chat.
   * Returns { messageId, documentId, date }.
   *
   * Uses parallel chunked upload (SaveBigFilePart) with multiple in-flight requests.
   */
  async uploadBuffer(buf, { fileName = 'blob.bin', mimeType = 'application/octet-stream', caption = '', progress, workers = 8 } = {}) {
    const chat = await this.resolveBucketChat();

    // CustomFile's path arg can be empty when we pass the buffer directly (CJS style).
    // Use a buffer-backed CustomFile so we don't touch disk.
    const size = buf.length;
    const tmpName = `tg-up-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const file = new CustomFile(fileName, size, '', buf);

    const uploaded = await this.client.uploadFile({
      file,
      workers,
      onProgress: progress
        ? (frac) => progress(Math.floor(frac * size), size)
        : undefined,
    });

    // Send as document to the bucket chat
    const sent = await this.client.sendMessage(chat, {
      file: uploaded,
      mimeType,
      fileName,
      caption,
      forceDocument: true,
    });
    return {
      messageId: sent.id,
      documentId: sent.media?.document?.id?.toString() || null,
      date: sent.date,
      size,
    };
  }

  /**
   * Download a Document by its message id in the bucket chat.
   */
  async downloadByMessageId(messageId) {
    const chat = await this.resolveBucketChat();
    const msgs = await this.client.getMessages(chat, { ids: [messageId] });
    if (!msgs || !msgs[0]) throw new Error(`Message ${messageId} not found`);
    const msg = msgs[0];
    if (!msg.media || !msg.document) throw new Error(`Message ${messageId} has no document`);
    const buf = await this.client.downloadMedia(msg, {});
    return buf;
  }

  /**
   * List recent object messages in the bucket chat. Parses the caption for
   * the JSON metadata we stored. Returns newest first.
   */
  async listObjects({ limit = 100, offsetId = 0 } = {}) {
    const chat = await this.resolveBucketChat();
    const opts = { limit };
    if (offsetId) opts.offsetId = offsetId;
    const msgs = await this.client.getMessages(chat, opts);
    const out = [];
    for (const m of msgs) {
      if (!m || !m.document) continue;
      let meta = null;
      if (m.message) {
        try { meta = JSON.parse(m.message); } catch {}
      }
      out.push({
        messageId: m.id,
        documentId: m.document.id?.toString() || null,
        size: Number(m.document.size?.toString() || 0),
        date: m.date,
        meta,           // { kind: 'manifest' | 'chunk', key, idx, ... } or null
        fileName: m.document.attributes?.find(a => a.className === 'DocumentAttributeFilename')?.fileName,
        mimeType: m.document.mimeType,
      });
    }
    return out;
  }

  /**
   * Delete a message (= the object) by id.
   */
  async deleteByMessageId(messageId) {
    const chat = await this.resolveBucketChat();
    await this.client.deleteMessages(chat, [messageId], { revoke: true });
  }
}
