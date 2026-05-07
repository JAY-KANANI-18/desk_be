import { WhatsAppProvider } from './whatsapp.adapter';

describe('WhatsAppProvider interactive replies', () => {
  it('uses the interactive reply id as the incoming answer payload', async () => {
    const provider = new WhatsAppProvider();

    const parsed = await provider.parseWebhook({
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: 'phone-number-1' },
                messages: [
                  {
                    from: '919999999999',
                    id: 'wamid.1',
                    timestamp: '1778141833',
                    type: 'interactive',
                    interactive: {
                      button_reply: {
                        id: 'Full Product Name',
                        title: 'Full Product Name'.slice(0, 20),
                      },
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(parsed[0]).toMatchObject({
      messageType: 'interactive',
      text: 'Full Product Name',
      metadata: {
        interactiveReply: {
          id: 'Full Product Name',
        },
      },
    });
  });
});
