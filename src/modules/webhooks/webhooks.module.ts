import { Module } from '@nestjs/common';
import { PrismaModule } from 'prisma/prisma.module';
import { ChannelsModule } from '../channels/channels.module';
import { InboundModule } from '../inbound/inbound.module';
import { WebhookWhatsAppController } from './whatsapp.controller';
// import { WebhookInstagramController } from './instagram.controller';
import { MetaWebhookController } from './meta.controller';
import { WebhookMailgunController } from './mailgun.controller';

@Module({
    imports: [
        PrismaModule,
        ChannelsModule, // 👈 needed
        InboundModule,  // 👈 needed
    ],
    controllers: [WebhookWhatsAppController,MetaWebhookController,WebhookMailgunController],
})
export class WebhooksModule { }