import { Controller, Get, HttpCode, Logger, Param, Post, Req, Res } from '@nestjs/common';
import { Public } from 'src/common/auth/route-access.decorator';
import { ChannelAdaptersRegistry } from 'src/modules/channel-adapters/channel-adapters.registry';
import { InboundService } from 'src/modules/inbound/inbound.service';
import { OutboundService } from 'src/modules/outbound/outbound.service';
import { PrismaService } from 'src/prisma/prisma.service';

@Controller('api/channels/calling/exotel')
export class ExotelController {
  private readonly logger = new Logger(ExotelController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ChannelAdaptersRegistry,
    private readonly inbound: InboundService,
    private readonly outbound: OutboundService,
  ) {}

@Get('webhook/:channelId')
@Public()
async getConfig(@Param('channelId') channelId: string, @Req() req: any, @Res() res: any) {
  console.log('Incoming Exotel GET:', req.query);

  res.json({
    destination: {
      numbers: ['sip:jayk7019e42d@axorainfotech1.voip.exotel.com'],
    },
    record: true,
  });
}

  @Post('webhook/:channelId')
  @Public()
  @HttpCode(200)
  async handle(@Param('channelId') channelId: string, @Req() req: any) {
    const channel = await this.prisma.channel.findUnique({ where: { id: channelId } });
    if (!channel || channel.type !== 'exotel_call') return { status: 'channel_not_found' };

    const provider = this.registry.getProviderByType('exotel_call');
    const parsedList = await provider.parseWebhook(req.body);

    for (const parsed of parsedList) {
      if (parsed.direction === 'outgoing') {
        const status = parsed.metadata?.status;
        if (status === 'delivered' || status === 'read' || status === 'failed') {
          await this.outbound.processWhatsappStatusUpdate({
            channelId: channel.id,
            channelType: 'exotel_call',
            externalId: parsed.externalId,
            status,
          });
        }
        continue;
      }

      await this.inbound.process({
        channelId: channel.id,
        workspaceId: channel.workspaceId,
        channelType: 'exotel_call',
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

    this.logger.debug(`Exotel webhook handled for channel=${channelId} events=${parsedList.length}`);
    return { status: 'ok' };
  }
}

