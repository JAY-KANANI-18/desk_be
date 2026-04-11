import { BadRequestException, Injectable } from '@nestjs/common';
import axios from 'axios';
import { ChannelProvider, ParsedInbound, ValidateOutboundOpts } from '../channel-adapter.interface';

@Injectable()
export class ExotelProvider implements ChannelProvider {
  readonly type = 'exotel_call';

  async parseWebhook(body: any): Promise<ParsedInbound[]> {
    if (!body) return [];

    const callSid = body?.CallSid || body?.call_sid || body?.id || `exotel-${Date.now()}`;
    const from = body?.From || body?.from || '';
    const to = body?.To || body?.to || '';
    const statusRaw = String(body?.CallStatus || body?.status || '').toLowerCase();
    const hasStatus = Boolean(statusRaw);

    // Call lifecycle/status webhook
    if (hasStatus) {
      return [{
        externalId: callSid,
        contactIdentifier: from || to,
        direction: 'outgoing',
        messageType: 'status',
        text: '',
        attachments: [],
        metadata: {
          status: this.mapStatus(statusRaw),
          rawStatus: statusRaw,
          callSid,
          to,
          from,
          provider: 'exotel',
        },
        raw: body,
      }];
    }

    // Incoming call event fallback
    return [{
      externalId: callSid,
      contactIdentifier: from || to,
      direction: 'incoming',
      messageType: 'call_event',
      text: `Incoming call ${from ? `from ${from}` : ''}`.trim(),
      attachments: [],
      metadata: { callSid, to, from, provider: 'exotel' },
      raw: body,
    }];
  }

  async sendMessage(channel: any, payload: any): Promise<{ externalId: string }> {
    const creds = channel?.credentials || {};
    const config = channel?.config || {};
    const sid = creds.sid;
    const apiKey = creds.apiKey;
    const apiToken = creds.apiToken;

    if (!sid || !apiKey || !apiToken) {
      throw new BadRequestException('Exotel credentials missing in channel configuration.');
    }

    const apiUrl = config.apiUrl || `https://api.exotel.com/v1/Accounts/${sid}/Calls/connect`;
    const form = new URLSearchParams({
      From: payload.from || config.callerId || channel.identifier,
      To: String(payload.to || ''),
      CallerId: config.callerId || channel.identifier,
      Record: String(payload.record ?? false),
    });

    const { data } = await axios.post(apiUrl, form.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      auth: { username: apiKey, password: apiToken },
    });

    const externalId = data?.Call?.Sid || data?.Sid || `exotel-${Date.now()}`;
    return { externalId };
  }

  validateOutbound({ channel, contactChannel, contact }: ValidateOutboundOpts): void {
    if (!channel?.credentials?.apiKey || !channel?.credentials?.apiToken || !channel?.credentials?.sid) {
      throw new BadRequestException({
        code: 'CHANNEL_MISSING_CREDENTIAL',
        message: 'Exotel credentials are incomplete.',
        retryable: false,
      });
    }

    const to = contactChannel?.identifier ?? contact?.phone;
    if (!to) {
      throw new BadRequestException({
        code: 'CONTACT_NO_IDENTIFIER',
        message: 'Contact phone number is required to place a call.',
        retryable: false,
      });
    }
  }

  normaliseError(err: any): never {
    throw new BadRequestException({
      code: 'PROVIDER_ERROR',
      message: 'Call initiation failed via Exotel.',
      detail: err?.response?.data || err?.message,
      retryable: true,
    });
  }

  private mapStatus(status: string): 'delivered' | 'read' | 'failed' {
    if (status.includes('completed') || status.includes('answered')) return 'delivered';
    if (status.includes('in-progress') || status.includes('ongoing')) return 'read';
    return 'failed';
  }
}

