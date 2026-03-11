/**
 * Matrix channel for nanoclaw — with E2E encryption.
 *
 * Uses matrix-bot-sdk + @matrix-org/matrix-sdk-crypto-nodejs (Rust, native)
 * for full end-to-end encryption. All messages in encrypted rooms are
 * automatically encrypted/decrypted by the SDK.
 *
 * Setup:
 *   1. Run apply-matrix.py from the project root
 *   2. Add to .env:
 *        MATRIX_HOMESERVER_URL=https://matrix.example.org
 *        MATRIX_ACCESS_TOKEN=syt_xxxxx
 *   3. Restart nanoclaw
 *   4. Invite the bot to a room → send !chatid to get the JID
 *   5. Register with the main group
 *
 * JID format:  mx:!roomId:server  (e.g. mx:!abc123:matrix.org)
 */

import fs from 'fs';
import { spawn } from 'child_process';
import path from 'path';
import https from 'https';
import http from 'http';
import {
  MatrixClient,
  SimpleFsStorageProvider,
  RustSdkCryptoStorageProvider,
  RustSdkCryptoStoreType,
  AutojoinRoomsMixin,
} from 'matrix-bot-sdk';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { DATA_DIR, GROUPS_DIR } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const JID_PREFIX = 'mx:';
const MAX_CHUNK = 32768;
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
const STARTUP_GRACE_MS = 10_000; // ignore events older than this on startup

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Best-effort Markdown → Matrix HTML conversion. */
function mdToHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`{3}([\s\S]*?)`{3}/g, '<pre><code>$1</code></pre>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br/>');
}

function mimeType(ext: string): string {
  const map: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.mp4': 'video/mp4',
    '.mp3': 'audio/mpeg',
  };
  return map[ext.toLowerCase()] ?? 'application/octet-stream';
}

function chunkText(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += max) out.push(text.slice(i, i + max));
  return out;
}

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const out = fs.createWriteStream(dest);
    protocol
      .get(url, (res) => {
        res.pipe(out);
        out.on('finish', resolve);
      })
      .on('error', (err) => {
        fs.unlink(dest, () => {});
        reject(err);
      });
  });
}

// ─── Channel ──────────────────────────────────────────────────────────────────

export interface MatrixChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class MatrixChannel implements Channel {
  name = 'matrix';
  private client: MatrixClient | null = null;
  private botUserId: string | null = null;
  private startedAt = Date.now();
  private opts: MatrixChannelOpts;
  private homeserverUrl: string;
  private accessToken: string;

  constructor(
    homeserverUrl: string,
    accessToken: string,
    opts: MatrixChannelOpts,
  ) {
    this.homeserverUrl = homeserverUrl;
    this.accessToken = accessToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    const matrixDir = path.join(DATA_DIR, 'matrix');
    fs.mkdirSync(matrixDir, { recursive: true });

    // Sync store (room state, timeline)
    const storage = new SimpleFsStorageProvider(
      path.join(matrixDir, 'sync-store.json'),
    );

    const cryptoStore = new RustSdkCryptoStorageProvider(
      path.join(matrixDir, 'crypto-store'),
      RustSdkCryptoStoreType.Sqlite,
    );

    this.client = new MatrixClient(
      this.homeserverUrl,
      this.accessToken,
      storage,
      cryptoStore,
    );

    // Auto-join rooms when invited (needed to receive messages)
    AutojoinRoomsMixin.setupOnClient(this.client);

    this.botUserId = await this.client.getUserId();
    this.startedAt = Date.now();

    // ── Inbound messages ──────────────────────────────────────────────────────
    this.client.on('room.message', async (roomId: string, event: any) => {
      await this.handleMessage(roomId, event);
    });

    // ── Built-in commands ─────────────────────────────────────────────────────
    this.client.on('room.message', async (roomId: string, event: any) => {
      if (!this.client) return;
      if (event.sender === this.botUserId) return;
      const text = ((event.content?.body as string) ?? '').trim();
      if (text === '!chatid') {
        await this.client.sendMessage(roomId, {
          msgtype: 'm.text',
          body: `Chat ID: mx:${roomId}`,
        });
      }
      if (text === '!ping') {
        await this.client.sendMessage(roomId, {
          msgtype: 'm.text',
          body: `${ASSISTANT_NAME} is online. Room is${(await this.isEncrypted(roomId)) ? '' : ' NOT'} end-to-end encrypted.`,
        });
      }
      if (text === '!usage') {
        await this.client.sendMessage(roomId, {
          msgtype: 'm.text',
          body: 'https://claude.ai/settings/usage',
        });
      }
      if (text === '!model' || text.startsWith('!model ')) {
        const chatJid = `mx:${roomId}`;
        const sender = event.sender as string;
        const senderName = sender.split(':')[0].replace('@', '');
        const args = text.slice('!model'.length).trim();
        const content = args ? `/model ${args}` : '/model';
        this.opts.onMessage(chatJid, {
          id: event.event_id,
          chat_jid: chatJid,
          sender,
          sender_name: senderName,
          content,
          timestamp: new Date(
            event.origin_server_ts ?? Date.now(),
          ).toISOString(),
          is_from_me: false,
        });
      }
    });

    // ── Inbound reactions ────────────────────────────────────────────────────
    this.client.on('room.event', async (roomId: string, event: any) => {
      if (event.type !== 'm.reaction') return;
      if (event.sender === this.botUserId) return;

      // Skip old events on startup
      const age = Date.now() - (event.origin_server_ts ?? 0);
      if (
        age > STARTUP_GRACE_MS &&
        Date.now() - this.startedAt < STARTUP_GRACE_MS
      )
        return;

      const chatJid = `${JID_PREFIX}${roomId}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const relates = event.content?.['m.relates_to'];
      if (!relates || relates.rel_type !== 'm.annotation') return;

      const emoji = relates.key as string;
      const sender = event.sender as string;
      const senderName = sender.split(':')[0].replace('@', '');
      const timestamp = new Date(
        event.origin_server_ts ?? Date.now(),
      ).toISOString();

      this.opts.onMessage(chatJid, {
        id: event.event_id,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content: `[Reaction: ${emoji}]`,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, sender: senderName, emoji },
        'Matrix reaction received',
      );
    });

    await this.client.start();

    logger.info(
      { userId: this.botUserId, homeserver: this.homeserverUrl },
      'Matrix bot connected',
    );
    console.log(`\n  Matrix bot: ${this.botUserId}`);
    console.log(`  Send !chatid to a room to get its registration ID\n`);
  }

  private async handleMessage(roomId: string, event: any): Promise<void> {
    if (!this.client) return;
    if (event.sender === this.botUserId) return;

    // Skip old events replayed on startup
    const age = Date.now() - (event.origin_server_ts ?? 0);
    if (
      age > STARTUP_GRACE_MS &&
      Date.now() - this.startedAt < STARTUP_GRACE_MS
    )
      return;

    const chatJid = `${JID_PREFIX}${roomId}`;
    const content = event.content ?? {};
    const msgtype = content.msgtype as string;
    if (!msgtype) return;

    const timestamp = new Date(
      event.origin_server_ts ?? Date.now(),
    ).toISOString();
    const sender = event.sender as string;
    const senderName = sender.split(':')[0].replace('@', '');

    // Chat metadata
    const roomName = await this.getRoomName(roomId);
    const isGroup = await this.isGroupRoom(roomId);
    this.opts.onChatMetadata(chatJid, timestamp, roomName, 'matrix', isGroup);

    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      logger.debug({ chatJid }, 'Message from unregistered Matrix room');
      return;
    }

    let messageContent: string;

    if (msgtype === 'm.text') {
      let text = (content.body as string) ?? '';

      // Normalise @bot mention → trigger pattern
      const botLocal = this.botUserId?.split(':')[0].replace('@', '') ?? '';
      if (text.includes(`@${botLocal}`) && !TRIGGER_PATTERN.test(text)) {
        text = `@${ASSISTANT_NAME} ${text}`;
      }
      messageContent = text;
    } else if (msgtype === 'm.image') {
      try {
        let imageBuffer: Buffer;
        // Detect mime type for file extension
        const mime = (content.info?.mimetype as string) ?? 'image/jpeg';
        const extMap: Record<string, string> = {
          'image/png': '.png',
          'image/gif': '.gif',
          'image/webp': '.webp',
          'image/jpeg': '.jpg',
        };
        const ext = extMap[mime] ?? '.jpg';

        if (content.file) {
          // E2E encrypted room: use SDK's built-in decryption
          imageBuffer = await this.client!.crypto.decryptMedia(content.file);
        } else if (content.url) {
          // Unencrypted room: direct download
          const httpUrl = this.client!.mxcToHttp(content.url as string);
          const { data } = await this.client!.downloadContent(
            content.url as string,
          );
          imageBuffer = Buffer.from(data);
        } else {
          throw new Error('No url or file in image event');
        }

        const saveDir = path.join(GROUPS_DIR, group.folder, 'received_photos');
        fs.mkdirSync(saveDir, { recursive: true });
        const filename = `photo_${Date.now()}${ext}`;
        fs.writeFileSync(path.join(saveDir, filename), imageBuffer);
        messageContent = `[Photo saved: /workspace/group/received_photos/${filename}]${content.body ? ` ${content.body}` : ''}`;
      } catch (err) {
        logger.warn({ err }, 'Failed to download Matrix image');
        messageContent = `[Image: ${content.body ?? 'photo'}]`;
      }
    } else if (msgtype === 'm.file') {
      messageContent = `[File: ${content.body ?? 'file'}]`;
    } else if (msgtype === 'm.audio') {
      try {
        let audioBuffer: Buffer;
        if (content.file) {
          // E2E encrypted room
          audioBuffer = await this.client!.crypto.decryptMedia(content.file);
        } else if (content.url) {
          const { data } = await this.client!.downloadContent(
            content.url as string,
          );
          audioBuffer = Buffer.from(data);
        } else {
          throw new Error('No url or file in audio event');
        }

        const audioDir = path.join(GROUPS_DIR, group.folder, 'received_audio');
        fs.mkdirSync(audioDir, { recursive: true });
        const audioFilename = `audio_${Date.now()}.ogg`;
        const audioPath = path.join(audioDir, audioFilename);
        fs.writeFileSync(audioPath, audioBuffer);

        // Transcribe locally with faster-whisper (non-blocking)
        const scriptPath = path.resolve('scripts/transcribe.py');
        const transcribedText = await new Promise<string>((resolve, reject) => {
          const proc = spawn('python3', [scriptPath, audioPath]);
          let stdout = '';
          let stderr = '';
          proc.stdout.on('data', (d: Buffer) => {
            stdout += d.toString();
          });
          proc.stderr.on('data', (d: Buffer) => {
            stderr += d.toString();
          });
          const timer = setTimeout(() => {
            proc.kill();
            reject(new Error('Transcription timeout'));
          }, 120_000);
          proc.on('close', (code: number | null) => {
            clearTimeout(timer);
            if (code === 0 && stdout.trim()) resolve(stdout.trim());
            else reject(new Error(stderr.trim() || 'Transcription failed'));
          });
        });

        messageContent = `[Sprachnachricht: ${transcribedText}]`;

        // Keep only the last 5 audio files
        const audioFiles = fs
          .readdirSync(audioDir)
          .filter((f: string) => f.startsWith('audio_') && f.endsWith('.ogg'))
          .sort();
        audioFiles
          .slice(0, Math.max(0, audioFiles.length - 5))
          .forEach((f: string) => fs.unlinkSync(path.join(audioDir, f)));
      } catch (err) {
        logger.warn({ err }, 'Failed to process Matrix audio');
        messageContent = `[Sprachnachricht: ${content.body ?? 'audio'} — Transkription fehlgeschlagen]`;
      }
    } else if (msgtype === 'm.video') {
      messageContent = `[Video: ${content.body ?? 'video'}]`;
    } else {
      return;
    }

    this.opts.onMessage(chatJid, {
      id: event.event_id,
      chat_jid: chatJid,
      sender,
      sender_name: senderName,
      content: messageContent,
      timestamp,
      is_from_me: false,
    });

    logger.info(
      {
        chatJid,
        roomName,
        sender: senderName,
        encrypted: event.type === 'm.room.encrypted',
      },
      'Matrix message received',
    );
  }

  // ─── Sending ───────────────────────────────────────────────────────────────

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn('Matrix client not initialized');
      return;
    }
    try {
      const roomId = jid.replace(/^mx:/, '');
      for (const chunk of chunkText(text, MAX_CHUNK)) {
        await this.client.sendMessage(roomId, {
          msgtype: 'm.text',
          body: chunk,
          format: 'org.matrix.custom.html',
          formatted_body: mdToHtml(chunk),
        });
      }
      logger.info({ jid }, 'Matrix message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Matrix message');
    }
  }

  async sendDocument(
    jid: string,
    filePath: string,
    filename?: string,
    caption?: string,
  ): Promise<void> {
    if (!this.client) {
      logger.warn('Matrix client not initialized');
      return;
    }
    try {
      const roomId = jid.replace(/^mx:/, '');
      const name = filename ?? path.basename(filePath);
      const ext = path.extname(name).toLowerCase();
      const mime = mimeType(ext);
      const buffer = fs.readFileSync(filePath);

      // Upload to Matrix content repository (encrypted if room is encrypted)
      const mxcUrl = await this.client.uploadContent(buffer, mime, name);

      const isImage = IMAGE_EXTS.has(ext);
      await this.client.sendMessage(roomId, {
        msgtype: isImage ? 'm.image' : 'm.file',
        body: caption ?? name,
        url: mxcUrl,
        info: { mimetype: mime, size: buffer.length },
      });

      logger.info(
        { jid, filename: name },
        `Matrix ${isImage ? 'photo' : 'file'} sent`,
      );
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Matrix file');
    }
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  isConnected(): boolean {
    return this.client !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(JID_PREFIX);
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.stop();
      this.client = null;
      logger.info('Matrix bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client || !isTyping) return;
    try {
      await this.client.setTyping(jid.replace(/^mx:/, ''), true, 5000);
    } catch {
      /* non-fatal */
    }
  }

  // ─── Utilities ─────────────────────────────────────────────────────────────

  private async getRoomName(roomId: string): Promise<string> {
    try {
      const state = await this.client!.getRoomStateEvent(
        roomId,
        'm.room.name',
        '',
      );
      return state?.name ?? roomId;
    } catch {
      return roomId;
    }
  }

  private async isGroupRoom(roomId: string): Promise<boolean> {
    try {
      const members = await this.client!.getJoinedRoomMembers(roomId);
      return members.length > 2;
    } catch {
      return true;
    }
  }

  private async isEncrypted(roomId: string): Promise<boolean> {
    try {
      await this.client!.getRoomStateEvent(roomId, 'm.room.encryption', '');
      return true;
    } catch {
      return false;
    }
  }
}

// ─── Registration ─────────────────────────────────────────────────────────────

registerChannel('matrix', (opts: ChannelOpts) => {
  const env = readEnvFile(['MATRIX_HOMESERVER_URL', 'MATRIX_ACCESS_TOKEN']);
  if (!env.MATRIX_HOMESERVER_URL || !env.MATRIX_ACCESS_TOKEN) {
    logger.debug(
      'Matrix channel not configured (MATRIX_HOMESERVER_URL / MATRIX_ACCESS_TOKEN missing)',
    );
    return null;
  }
  return new MatrixChannel(env.MATRIX_HOMESERVER_URL, env.MATRIX_ACCESS_TOKEN, {
    onMessage: opts.onMessage,
    onChatMetadata: opts.onChatMetadata,
    registeredGroups: opts.registeredGroups,
  });
});
