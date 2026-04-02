// modules/channels/providers/meta/instagram/instagram-validator.ts

import { BadRequestException } from '@nestjs/common';
import { ValidateOutboundOpts } from 'src/modules/channel-adapters/channel-adapter.interface';

export class InstagramValidator {
  static validate({ channel, contactChannel }: ValidateOutboundOpts): void {

    if (!channel.config?.accessToken) {
      throw new BadRequestException({
        code:      'CHANNEL_MISSING_CREDENTIAL',
        message:   'Instagram page access token is missing. Reconnect the channel in Settings.',
        retryable: false,
      });
    }

    // Instagram has NO cold outreach — contact must have messaged first
    if (!contactChannel?.identifier) {
      throw new BadRequestException({
        code:      'CONTACT_NOT_ON_CHANNEL',
        message:   'This contact has never messaged via Instagram. You can only reply to contacts who messaged you first.',
        retryable: false,
      });
    }
  }
}