jest.mock('../media/media.service', () => ({
  MediaService: class MediaService {},
}));

import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';
import { ChannelAdaptersRegistry } from '../channel-adapters/channel-adapters.registry';
import { MediaService } from '../media/media.service';
import { OutboundService } from './outbound.service';

type QuickReply = { title: string; payload: string };

type OutboundPayloadTestApi = {
  buildPayload(
    channelType: string,
    dto: {
      to: string;
      text?: string;
      htmlBody?: string;
      quickReplies?: QuickReply[];
      quickReplyTextPrepared?: boolean;
    },
  ): Promise<any>;
};

function createService() {
  return new OutboundService(
    {} as PrismaService,
    {} as ChannelAdaptersRegistry,
    {} as EventEmitter2,
    {} as MediaService,
  ) as unknown as OutboundPayloadTestApi;
}

const productReplies: QuickReply[] = [
  { title: 'Product 1', payload: 'Product 1' },
  { title: 'Product 2', payload: 'Product 2' },
  { title: 'Product 3', payload: 'Product 3' },
];

describe('OutboundService quick reply payloads', () => {
  it('maps WhatsApp quick replies to native interactive buttons', async () => {
    const payload = await createService().buildPayload('whatsapp', {
      to: '919999999999',
      text: 'what is product?',
      quickReplies: productReplies,
    });

    expect(payload).toMatchObject({
      messaging_product: 'whatsapp',
      to: '919999999999',
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: 'what is product?' },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'Product 1', title: 'Product 1' } },
            { type: 'reply', reply: { id: 'Product 2', title: 'Product 2' } },
            { type: 'reply', reply: { id: 'Product 3', title: 'Product 3' } },
          ],
        },
      },
    });
  });

  it('uses a WhatsApp interactive list when there are more than three options', async () => {
    const replies = [
      ...productReplies,
      { title: 'Product 4', payload: 'Product 4' },
    ];

    const payload = await createService().buildPayload('whatsapp', {
      to: '919999999999',
      text: 'what is product?',
      quickReplies: replies,
    });

    expect(payload.interactive.type).toBe('list');
    expect(payload.interactive.action.sections[0].rows).toHaveLength(4);
    expect(payload.interactive.action.sections[0].rows[3]).toEqual({
      id: 'Product 4',
      title: 'Product 4',
    });
  });

  it('falls back to WhatsApp text when options exceed the native list limit', async () => {
    const replies = Array.from({ length: 11 }, (_, index) => ({
      title: `Product ${index + 1}`,
      payload: `Product ${index + 1}`,
    }));

    const payload = await createService().buildPayload('whatsapp', {
      to: '919999999999',
      text: 'what is product?',
      quickReplies: replies,
    });

    expect(payload.type).toBe('text');
    expect(payload.text.body).toContain('Options:\n1. Product 1');
    expect(payload.text.body).toContain('11. Product 11');
  });

  it('keeps Meta quick replies native without adding text fallback', async () => {
    const payload = await createService().buildPayload('instagram', {
      to: 'ig-user-1',
      text: 'what is product?',
      quickReplies: productReplies,
    });

    expect(payload.message.text).toBe('what is product?');
    expect(payload.message.quick_replies).toEqual([
      { content_type: 'text', title: 'Product 1', payload: 'Product 1' },
      { content_type: 'text', title: 'Product 2', payload: 'Product 2' },
      { content_type: 'text', title: 'Product 3', payload: 'Product 3' },
    ]);
  });

  it('adds readable option text for SMS', async () => {
    const payload = await createService().buildPayload('sms', {
      to: '919999999999',
      text: 'what is product?',
      quickReplies: productReplies,
    });

    expect(payload.text).toBe(
      'what is product?\n\nOptions:\n1. Product 1\n2. Product 2\n3. Product 3',
    );
  });

  it('adds readable option text and escaped option HTML for email', async () => {
    const payload = await createService().buildPayload('email', {
      to: 'customer@example.com',
      text: 'what is product?',
      htmlBody: '<p>what is product?</p>',
      quickReplies: [
        { title: 'Product 1', payload: 'Product 1' },
        { title: '<Product 2>', payload: '<Product 2>' },
      ],
    });

    expect(payload.text).toBe('what is product?\n\nOptions:\n1. Product 1\n2. <Product 2>');
    expect(payload.html).toContain('<li>Product 1</li>');
    expect(payload.html).toContain('<li>&lt;Product 2&gt;</li>');
  });

  it('adds readable option text and metadata for webchat', async () => {
    const payload = await createService().buildPayload('webchat', {
      to: 'session-1',
      text: 'what is product?',
      quickReplies: productReplies,
    });

    expect(payload.text).toBe(
      'what is product?\n\nOptions:\n1. Product 1\n2. Product 2\n3. Product 3',
    );
    expect(payload.quickReplies).toEqual(productReplies);
  });
});
