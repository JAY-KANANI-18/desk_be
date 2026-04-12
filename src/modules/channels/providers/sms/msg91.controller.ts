import { Controller, HttpCode, Logger, Param, Post, Req } from '@nestjs/common';
import { Public } from 'src/common/auth/route-access.decorator';
import { ChannelAdaptersRegistry } from 'src/modules/channel-adapters/channel-adapters.registry';
import { InboundService } from 'src/modules/inbound/inbound.service';
import { OutboundService } from 'src/modules/outbound/outbound.service';
import { MessageProcessingQueueService } from 'src/modules/outbound/message-processing-queue.service';
import { PrismaService } from 'src/prisma/prisma.service';

@Controller('api/channels/sms/msg91')
export class Msg91Controller {
  private readonly logger = new Logger(Msg91Controller.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ChannelAdaptersRegistry,
    private readonly inbound: InboundService,
    private readonly outbound: OutboundService,
    private readonly processingQueue: MessageProcessingQueueService,
  ) {}

  @Post('webhook/:channelId')
  @Public()
  @HttpCode(200)
  async handle(@Param('channelId') channelId: string, @Req() req: any) {
    const channel = await this.prisma.channel.findUnique({ where: { id: channelId } });
    if (!channel || channel.type !== 'sms') return { status: 'channel_not_found' };

    const provider = this.registry.getProviderByType('sms');
    const parsedList = await provider.parseWebhook(req.body);

    for (const parsed of parsedList) {
      if (parsed.direction === 'outgoing') {
        const status = parsed.metadata?.status;
        if (status === 'delivered' || status === 'read' || status === 'failed') {
          await this.processingQueue.enqueueWhatsappStatusUpdate({
            channelId: channel.id,
            channelType: 'sms',
            externalId: parsed.externalId,
            status,
          });
        }
        continue;
      }

      await this.processingQueue.enqueueInboundProcess({
        channelId: channel.id,
        workspaceId: channel.workspaceId,
        channelType: 'sms',
        contactIdentifier: parsed.contactIdentifier,
        channelMsgId: parsed.externalId,
        direction: parsed.direction,
        messageType: parsed.messageType,
        text: parsed.text,
        attachments: parsed.attachments,
        replyToChannelMsgId: parsed.replyToChannelMsgId,
        metadata: parsed.metadata,
        raw: parsed.raw,
      });
    }

    this.logger.debug(`MSG91 webhook handled for channel=${channelId} events=${parsedList.length}`);
    return { status: 'ok' };
  }
}

