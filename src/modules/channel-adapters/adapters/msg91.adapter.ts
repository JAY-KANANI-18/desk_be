import { BadRequestException, Injectable } from '@nestjs/common';
import axios from 'axios';
import { ChannelProvider, ParsedInbound, ValidateOutboundOpts } from '../channel-adapter.interface';

@Injectable()
export class Msg91Provider implements ChannelProvider {
  readonly type = 'sms';

  async parseWebhook(body: any): Promise<ParsedInbound[]> {
    if (!body) return [];

    const externalId = body?.requestId || body?.id || body?.messageId || `msg91-${Date.now()}`;
    const to = body?.mobile || body?.to || body?.number || '';
    const text = body?.message || body?.text || body?.content || '';
    const dlrStatus = String(body?.status || body?.dlr || '').toLowerCase();

    // DLR/status callbacks from MSG91 are treated as outgoing status events.
    if (dlrStatus) {
      return [{
        externalId,
        contactIdentifier: to,
        direction: 'outgoing',
        messageType: 'status',
        text: '',
        attachments: [],
        metadata: { status: this.mapStatus(dlrStatus), rawStatus: dlrStatus, provider: 'msg91' },
        raw: body,
      }];
    }

    // Inbound SMS fallback
    return [{
      externalId,
      contactIdentifier: to || body?.sender || '',
      direction: 'incoming',
      messageType: 'text',
      text,
      attachments: [],
      metadata: { provider: 'msg91' },
      raw: body,
    }];
  }

  async sendMessage(channel: any, payload: any): Promise<{ externalId: string }> {
    const authKey = channel?.credentials?.authKey;
    const config = channel?.config || {};

    if (!authKey) {
      throw new BadRequestException('MSG91 auth key missing in channel credentials.');
    }

    const apiUrl = config.apiUrl || 'https://api.msg91.com/api/v2/sendsms';
    const body = {
      sender: config.senderId || channel.identifier,
      route: config.route || '4',
      country: payload.country || '91',
      sms: [
        {
          message: payload.text || '',
          to: [String(payload.to || '')],
        },
      ],
      ...(config.dltTemplateId ? { dlt_template_id: config.dltTemplateId } : {}),
    };

    const { data } = await axios.post(apiUrl, body, {
      headers: {
        'Content-Type': 'application/json',
        authkey: authKey,
      },
    });

    return { externalId: data?.request_id || data?.requestId || `msg91-${Date.now()}` };
  }

  validateOutbound({ channel, contactChannel, contact, payload }: ValidateOutboundOpts): void {
    if (!channel?.credentials?.authKey) {
      throw new BadRequestException({
        code: 'CHANNEL_MISSING_CREDENTIAL',
        message: 'MSG91 auth key is missing. Reconnect SMS channel.',
        retryable: false,
      });
    }
    const to = contactChannel?.identifier ?? contact?.phone;
    if (!to) {
      throw new BadRequestException({
        code: 'CONTACT_NO_IDENTIFIER',
        message: 'Contact phone number is required for SMS.',
        retryable: false,
      });
    }
    if (!payload?.text) {
      throw new BadRequestException({
        code: 'EMPTY_MESSAGE',
        message: 'SMS text is required.',
        retryable: false,
      });
    }
  }

  normaliseError(err: any): never {
    const detail = err?.response?.data || err?.message || 'MSG91 provider error';
    throw new BadRequestException({
      code: 'PROVIDER_ERROR',
      message: 'SMS could not be sent via MSG91.',
      detail,
      retryable: true,
    });
  }

  private mapStatus(status: string): 'delivered' | 'read' | 'failed' {
    if (status.includes('deliv')) return 'delivered';
    if (status.includes('read')) return 'read';
    return 'failed';
  }
}

