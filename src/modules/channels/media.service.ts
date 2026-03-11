// src/channels/media.service.ts

import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import { ChannelRegistry } from './channel-registry.service';
import { ParsedAttachment } from './channel-provider.interface';
import { randomUUID } from 'crypto';
import * as path from 'path';
import { R2Service } from 'src/common/storage/r2.service';

// ─── Limits ───────────────────────────────────────────────────────────────────

const MAX_BYTES: Record<string, number> = {
  image:     16_000_000,
  video:    100_000_000,
  audio:     16_000_000,
  voice:     16_000_000,
  document: 100_000_000,
  sticker:      500_000,
  gif:       16_000_000,
};

const ALLOWED_MIMES: Record<string, string[]> = {
  image:    ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/bmp', 'image/tiff'],
  video:    ['video/mp4', 'video/3gpp', 'video/quicktime', 'video/mpeg', 'video/webm', 'video/avi'],
  audio:    ['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/wav', 'audio/webm', 'audio/amr', 'audio/opus'],
  voice:    ['audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/amr', 'audio/opus', 'audio/wav'],
  sticker:  ['image/webp'],
  gif:      ['image/gif', 'video/mp4'],
  document: [], // accept all MIME types for documents
};

// ─── MIME → file extension map ────────────────────────────────────────────────

const MIME_EXT: Record<string, string> = {
  'image/jpeg':       'jpg',
  'image/png':        'png',
  'image/webp':       'webp',
  'image/gif':        'gif',
  'image/bmp':        'bmp',
  'image/tiff':       'tiff',
  'video/mp4':        'mp4',
  'video/3gpp':       '3gp',
  'video/quicktime':  'mov',
  'video/webm':       'webm',
  'audio/mpeg':       'mp3',
  'audio/mp4':        'm4a',
  'audio/aac':        'aac',
  'audio/ogg':        'ogg',
  'audio/wav':        'wav',
  'audio/amr':        'amr',
  'audio/opus':       'opus',
  'application/pdf':  'pdf',
};

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StoredMedia {
  url: string;
  key: string;
  mimeType: string;
  mediaType: string;
  filename?: string;
  size?: number;
  assetId?: string;
}

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ChannelRegistry,
    private readonly r2: R2Service,
  ) {}

  // ─── Process one attachment end-to-end ─────────────────────────────────────

  async processAttachment(
    channelId: string,
    workspaceId: string,
    attachment: ParsedAttachment,
  ): Promise<StoredMedia | null> {
    // Non-binary types (location, reaction, contact, etc.) need no upload
    if (this.isMetaOnly(attachment.type)) {
      return { url: '', key: '', mimeType: '', mediaType: attachment.type };
    }

    try {
      // 1. Download bytes from provider or direct URL
      const { buffer, mimeType, filename } = await this.acquire(channelId, attachment);

      // 2. Validate MIME + size
      this.validate(attachment.type, mimeType, buffer.byteLength);

      // 3. Dedup — if we've downloaded this provider media ID before, reuse it
      if (attachment.externalMediaId) {
        const existing = await this.findAsset(workspaceId, attachment.externalMediaId);
        if (existing) {
          this.logger.debug(`Media dedup hit: ${attachment.externalMediaId}`);
          return existing;
        }
      }

      // 4. Build R2 key and upload
      const resolvedFilename = filename ?? attachment.filename;
      const key = this.buildKey(workspaceId, attachment.type, mimeType, resolvedFilename);

      const { url } = await this.r2.uploadBuffer(
        key,
        Buffer.from(buffer),   // ArrayBuffer → Buffer
        mimeType,
      );

      // 5. Persist MediaAsset record for dedup + audit
      const assetId = await this.saveAsset({
        workspaceId,
        url,
        key,
        mimeType,
        mediaType: attachment.type,
        filename: resolvedFilename,
        size: buffer.byteLength,
        externalMediaId: attachment.externalMediaId,
        sourceChannelType: await this.getChannelType(channelId),
      });

      this.logger.debug(`Uploaded ${attachment.type} → ${url}`);

      return {
        url,
        key,
        mimeType,
        mediaType: attachment.type,
        filename: resolvedFilename,
        size: buffer.byteLength,
        assetId,
      };

    } catch (err) {
      this.logger.error(
        `Failed to process attachment type=${attachment.type} channel=${channelId}: ${err.message}`,
        err.stack,
      );
      return null;
    }
  }

  // ─── Process multiple attachments in parallel ───────────────────────────────

  async processAttachments(
    channelId: string,
    workspaceId: string,
    attachments: ParsedAttachment[],
  ): Promise<(StoredMedia | null)[]> {
    return Promise.all(
      attachments.map((a) => this.processAttachment(channelId, workspaceId, a)),
    );
  }

  // ─── Acquire bytes ──────────────────────────────────────────────────────────

  private async acquire(channelId: string, att: ParsedAttachment) {
    const channel = await this.prisma.channel.findUniqueOrThrow({
      where: { id: channelId },
    });
    const provider = this.registry.getProviderByType(channel.type);

    // Provider-auth-gated download (WhatsApp, Instagram)
    if (att.externalMediaId && provider.downloadMedia) {
      return provider.downloadMedia(channel, att.externalMediaId);
    }

    // Direct URL (Messenger CDN, Mailgun attachment URL, Telegram CDN)
    if (att.url) {
      const res = await fetch(att.url);
      if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${att.url}`);

      const buffer = await res.arrayBuffer();
      const mimeType =
        res.headers.get('content-type')?.split(';')[0].trim() ??
        att.mimeType ??
        'application/octet-stream';
      const filename = new URL(att.url).pathname.split('/').pop() || undefined;

      return { buffer, mimeType, filename };
    }

    throw new Error(`No download strategy for attachment type=${att.type}`);
  }

  // ─── Validate ───────────────────────────────────────────────────────────────

  private validate(type: string, mimeType: string, size: number): void {
    const allowed = ALLOWED_MIMES[type];
    if (allowed && allowed.length > 0 && !allowed.includes(mimeType)) {
      throw new BadRequestException(
        `MIME type "${mimeType}" not allowed for media type "${type}"`,
      );
    }

    const max = MAX_BYTES[type];
    if (max && size > max) {
      throw new BadRequestException(
        `File size ${(size / 1_000_000).toFixed(1)}MB exceeds ${max / 1_000_000}MB limit for type "${type}"`,
      );
    }
  }

  // ─── R2 key builder ─────────────────────────────────────────────────────────
  //
  // Pattern: media/{workspaceId}/{type}/{uuid}.{ext}
  // e.g.     media/ws_abc/image/3f2a1b.jpg

  private buildKey(
    workspaceId: string,
    mediaType: string,
    mimeType: string,
    filename?: string,
  ): string {
    const ext =
      filename
        ? path.extname(filename).replace('.', '') || MIME_EXT[mimeType] || 'bin'
        : MIME_EXT[mimeType] || 'bin';

    const uuid = randomUUID().replace(/-/g, '').substring(0, 12);
    return `media/${workspaceId}/${mediaType}/${uuid}.${ext}`;
  }

  // ─── DB helpers ─────────────────────────────────────────────────────────────

  private async findAsset(
    workspaceId: string,
    externalMediaId: string,
  ): Promise<StoredMedia | null> {
    const asset = await this.prisma.mediaAsset.findFirst({
      where: { workspaceId, externalMediaId },
      orderBy: { createdAt: 'desc' },
    });
    if (!asset) return null;

    return {
      url: asset.url,
      key: asset.key,
      mimeType: asset.mimeType,
      mediaType: asset.mediaType,
      filename: asset.filename ?? undefined,
      size: asset.size ?? undefined,
      assetId: asset.id,
    };
  }

  private async saveAsset(data: {
    workspaceId: string;
    url: string;
    key: string;
    mimeType: string;
    mediaType: string;
    filename?: string;
    size?: number;
    externalMediaId?: string;
    sourceChannelType?: string;
  }): Promise<string | undefined> {
    try {
      const asset = await this.prisma.mediaAsset.create({ data });
      return asset.id;
    } catch (err) {
      this.logger.warn(`Failed to persist MediaAsset: ${err.message}`);
      return undefined;
    }
  }

  private async getChannelType(channelId: string): Promise<string | undefined> {
    const ch = await this.prisma.channel.findUnique({
      where: { id: channelId },
      select: { type: true },
    });
    return ch?.type;
  }

  private isMetaOnly(type: string): boolean {
    return ['location', 'contact', 'reaction', 'story_mention', 'unsupported'].includes(type);
  }
}