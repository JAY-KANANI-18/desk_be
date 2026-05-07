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
