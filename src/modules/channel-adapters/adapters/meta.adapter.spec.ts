import { MetaProvider } from './meta.adapter';

describe('MetaProvider quick replies', () => {
  it('uses quick reply payload as the incoming answer', async () => {
    const provider = new MetaProvider();

    const parsed = await provider.parseWebhook({
      entry: [
        {
          id: 'page-1',
          messaging: [
            {
              sender: { id: 'customer-1' },
              recipient: { id: 'page-1' },
              timestamp: 1778141833,
              message: {
                mid: 'mid.1',
                text: 'Full Product Name'.slice(0, 20),
                quick_reply: {
                  payload: 'Full Product Name',
                },
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
        quickReply: {
          payload: 'Full Product Name',
        },
      },
    });
  });
});

describe('MetaProvider message direction', () => {
  it('keeps the recipient id on page-sent message echoes', async () => {
    const provider = new MetaProvider();

    const parsed = await provider.parseWebhook({
      entry: [
        {
          id: 'page-1',
          messaging: [
            {
              sender: { id: 'page-1' },
              recipient: { id: 'customer-1' },
              timestamp: 1778141833,
              message: {
                mid: 'mid.echo.1',
                text: 'Hello from the page',
              },
            },
          ],
        },
      ],
    });

    expect(parsed[0]).toMatchObject({
      externalId: 'mid.echo.1',
      contactIdentifier: 'page-1',
      recipientIdentifier: 'customer-1',
      direction: 'outgoing',
      messageType: 'text',
      text: 'Hello from the page',
    });
  });

  it('keeps customer-sent messages incoming for the connected page', async () => {
    const provider = new MetaProvider();

    const parsed = await provider.parseWebhook({
      entry: [
        {
          id: 'page-1',
          messaging: [
            {
              sender: { id: 'customer-1' },
              recipient: { id: 'page-1' },
              timestamp: 1778141834,
              message: {
                mid: 'mid.inbound.1',
                text: 'Hi',
              },
            },
          ],
        },
      ],
    });

    expect(parsed[0]).toMatchObject({
      externalId: 'mid.inbound.1',
      contactIdentifier: 'customer-1',
      recipientIdentifier: 'page-1',
      direction: 'incoming',
      messageType: 'text',
      text: 'Hi',
    });
  });
});
