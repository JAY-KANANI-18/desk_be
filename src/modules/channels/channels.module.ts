// modules/channels/channels.module.ts
//
// Single module for ALL channel concerns:
//   - Provider registration
//   - Webhook controllers (public, no auth)
//   - Feature controllers (templates, menus — auth-guarded)
//   - Channel CRUD
//
// webhooks.module.ts is DELETED — those controllers now live inside each
// provider's folder and are registered here.

import { forwardRef, Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';

// ── Shared ─────────────────────────────────────────────────────────────────
import { ChannelsController } from './channels.controller';
import { ChannelService } from './channel.service';

// ── WhatsApp ───────────────────────────────────────────────────────────────
import { WhatsAppController } from './providers/whatsapp/whatsapp.controller';
import { WhatsAppTemplatesService } from './providers/whatsapp/whatsapp-templates.service';
import { WhatsAppTemplatesController } from './providers/whatsapp/whatsapp-templates.controller';

// ── Meta (Instagram + Messenger shared core) ───────────────────────────────

// Instagram feature layer
import { InstagramController } from './providers/meta/instagram/instagram.controller';
import { InstagramIcebreakersService } from './providers/meta/instagram/instagram-icebreakers.service';
import { InstagramIcebreakersController } from './providers/meta/instagram/instagram-icebreakers.controller';

// Messenger feature layer
import { MessengerController } from './providers/meta/messenger/messenger.controller';
import { MessengerMenuService } from './providers/meta/messenger/messenger-menu.service';
import { MessengerMenuController } from './providers/meta/messenger/messenger-menu.controller';

// ── Mailgun ────────────────────────────────────────────────────────────────
import { MailgunController } from './providers/email/mailgun.controller';
import { Msg91Controller } from './providers/sms/msg91.controller';
import { ExotelController } from './providers/calling/exotel.controller';
import { MetaAdsController } from './providers/meta/meta-ads.controller';


// ── Shared modules ─────────────────────────────────────────────────────────
import { PrismaModule } from '../../prisma/prisma.module';
import { InboundModule } from '../inbound/inbound.module';
import { R2Service } from 'src/common/storage/r2.service';
import { OutboundService } from '../outbound/outbound.service';
import { WebchatSessionService } from './providers/webchat/webchat-session.service';
import { WebchatManageController } from './providers/webchat/webchat-manage.controller';
import { WebchatController } from './providers/webchat/webchat.controller';
import { OutboundModule } from '../outbound/outbound.module';
import { ChannelAdaptersModule } from '../channel-adapters/channel-adapters.module';
import { MediaModule } from '../media/media.module';

@Module({
    imports: [
        PrismaModule,
        InboundModule,
        OutboundModule,
        ChannelAdaptersModule,
        MediaModule,
        
        ScheduleModule.forRoot()
    ],

    // ── Providers (services + providers) ────────────────────────────────────
    providers: [
        // Registry

        // Channel management
        ChannelService,

        // WhatsApp
      
        WhatsAppTemplatesService,

          
        InstagramIcebreakersService,
        MessengerMenuService,

        // Mailgun
              

      
        WebchatSessionService
    ],

    // ── Controllers ──────────────────────────────────────────────────────────
    controllers: [
        // Channel CRUD
        ChannelsController,

        // ── Webhook endpoints (public, no auth, called by providers) ──────────
        WhatsAppController,          // POST/GET webhooks/whatsapp
        InstagramController,         // POST/GET webhooks/instagram
        MessengerController,         // POST/GET webhooks/messenger
        MailgunController,           // POST      webhooks/mailgun
        Msg91Controller,             // POST      channels/sms/msg91/webhook/:channelId
        ExotelController,            // POST      channels/calling/exotel/webhook/:channelId
        MetaAdsController,           // GET/POST  integrations/meta-ads/* + public webhook

        // ── Feature endpoints (auth-guarded, called by agents) ────────────────
        WhatsAppTemplatesController, // GET/POST  channels/:channelId/whatsapp/templates
        InstagramIcebreakersController, // GET/POST channels/:channelId/instagram/icebreakers
        MessengerMenuController,     // GET/POST  channels/:channelId/messenger/menu
        WebchatManageController,      // POST/PATCH channels/:channelId/webchat
        WebchatController
    ],

    exports: [
        ChannelService,
    ],
})
export class ChannelsModule { }