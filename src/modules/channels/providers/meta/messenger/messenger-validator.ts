// modules/channels/providers/meta/messenger/messenger-validator.ts

import { BadRequestException } from '@nestjs/common';
import { ValidateOutboundOpts } from '../../../channel-provider.interface';

export class MessengerValidator {
  static validate({ channel, contactChannel }: ValidateOutboundOpts): void {

    // if (!channel.credentials?.accessToken) {
    //   throw new BadRequestException({
    //     code:      'CHANNEL_MISSING_CREDENTIAL',
    //     message:   'Messenger page access token is missing. Reconnect the channel in Settings.',
    //     retryable: false,
    //   });
    // }

    // Messenger requires a PSID — contact must have messaged first
    if (!contactChannel?.identifier) {
      throw new BadRequestException({
        code:      'CONTACT_NOT_ON_CHANNEL',
        message:   'This contact has no Messenger ID. You can only reply to contacts who have messaged you first on Messenger.',
        retryable: false,
      });
    }
  }
}