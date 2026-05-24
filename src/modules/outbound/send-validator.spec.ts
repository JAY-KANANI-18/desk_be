import { BadRequestException } from '@nestjs/common';
import { ProviderErrorNormaliser } from './send-validator';

describe('ProviderErrorNormaliser', () => {
  it('maps WhatsApp allowed-recipient errors to a user-facing message', () => {
    const error = {
      message: 'Request failed with status code 400',
      response: {
        status: 400,
        data: {
          error: {
            code: 131030,
            message: '(#131030) Recipient phone number not in allowed list',
          },
        },
      },
    };

    expect(ProviderErrorNormaliser.toSendError(error, 'whatsapp')).toEqual({
      code: 'WA_RECIPIENT_NOT_ALLOWED',
      message:
        'This phone number is not in the allowed recipients list for your WhatsApp test number. Add it in Meta or use a live WhatsApp Business number.',
      detail: '(#131030) Recipient phone number not in allowed list',
      retryable: false,
    });
  });

  it('keeps WhatsApp error_data details so invalid template parameters are debuggable', () => {
    const error = {
      message: 'Request failed with status code 400',
      response: {
        status: 400,
        data: {
          error: {
            code: 100,
            message: '(#100) Invalid parameter',
            error_data: {
              details: 'For component BODY, parameter at index 0 has invalid text format.',
            },
          },
        },
      },
    };

    expect(ProviderErrorNormaliser.toSendError(error, 'whatsapp')).toMatchObject({
      code: 'PROVIDER_ERROR',
      detail: 'For component BODY, parameter at index 0 has invalid text format. | (#100) Invalid parameter',
    });
  });

  it('keeps structured BadRequestException messages user-facing', () => {
    const error = new BadRequestException({
      code: 'CONTACT_NO_IDENTIFIER',
      message: 'This contact has no WhatsApp phone number. Add a phone number to the contact first.',
      retryable: false,
    });

    expect(ProviderErrorNormaliser.toSendError(error, 'whatsapp')).toMatchObject({
      code: 'CONTACT_NO_IDENTIFIER',
      message: 'This contact has no WhatsApp phone number. Add a phone number to the contact first.',
      retryable: false,
    });
  });
});
