import { Injectable, Logger } from '@nestjs/common';
import {
  ChannelProvider,
  ParsedInbound,
  ParsedAttachment,
  DownloadResult,
  ContactProfile,
} from '../channel-adapter.interface';

@Injectable()
export class WebchatProvider implements ChannelProvider {
  readonly type = 'webchat';
  private readonly logger = new Logger(WebchatProvider.name);

  // No parsing needed — widget posts already-normalized data
  // But we implement it for interface compliance
  async parseWebhook(body: any): Promise<ParsedInbound[]> {
    const { sessionId, text, attachments = [], messageType } = body;

    const parsed: ParsedInbound = {
      externalId: `wc_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      contactIdentifier: sessionId,
      direction: 'incoming',
      messageType: messageType ?? (attachments.length ? attachments[0].type : 'text'),
      text: text ?? null,
      attachments: attachments.map((a: any): ParsedAttachment => ({
        type: a.type ?? 'document',
        url: a.url,
        mimeType: a.mimeType,
        filename: a.filename,
        size: a.size,
      })),
      raw: body,
    };

    return [parsed];
  }

  // Webchat outbound = push via Socket.io in the gateway
  // OutboundService calls this but for webchat we just return a mock externalId
  // The actual delivery is handled by WidgetGateway listening to message.outbound event
  async sendMessage(
    channel: any,
    payload: any,
  ): Promise<{ externalId: string }> {
    // No HTTP call needed — real-time delivery is via Socket.io
    // Return a synthetic externalId so OutboundService can save it
    return { externalId: `wc_out_${Date.now()}` };
  }

  async downloadMedia(channel: any, mediaId: string): Promise<DownloadResult> {
    // Webchat media is uploaded directly to R2 by the widget controller
    // Nothing to download from a third-party CDN
    throw new Error('downloadMedia not applicable for webchat');
  }

  async getContactProfile(
    identifier: string,
    channel: any,
  ): Promise<ContactProfile> {
    // Profile comes from widget registration payload, not an external API
    return {};
  }

  validateOutbound(opts: any): void {
    // No 24-hour window or messaging window restrictions for webchat
  }

  normaliseError(err: any): never {
    throw err;
  }
}