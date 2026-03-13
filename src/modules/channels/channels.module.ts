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
import { ChannelRegistry } from './channel-registry.service';
import { ChannelsController } from './channels.controller';
import { ChannelService } from './channel.service';
import { MediaService } from './media.service';

// ── WhatsApp ───────────────────────────────────────────────────────────────
import { WhatsAppProvider } from './providers/whatsapp/whatsapp.provider';
import { WhatsAppController } from './providers/whatsapp/whatsapp.controller';
import { WhatsAppTemplatesService } from './providers/whatsapp/whatsapp-templates.service';
import { WhatsAppTemplatesController } from './providers/whatsapp/whatsapp-templates.controller';

// ── Meta (Instagram + Messenger shared core) ───────────────────────────────
import { MetaProvider } from './providers/meta/meta.providers';

// Instagram feature layer
import { InstagramController } from './providers/meta/instagram/instagram.controller';
import { InstagramIcebreakersService } from './providers/meta/instagram/instagram-icebreakers.service';
import { InstagramIcebreakersController } from './providers/meta/instagram/instagram-icebreakers.controller';

// Messenger feature layer
import { MessengerController } from './providers/meta/messenger/messenger.controller';
import { MessengerMenuService } from './providers/meta/messenger/messenger-menu.service';
import { MessengerMenuController } from './providers/meta/messenger/messenger-menu.controller';

// ── Mailgun ────────────────────────────────────────────────────────────────
import { MailgunProvider } from './providers/email/mailgun.provider';
import { MailgunController } from './providers/email/mailgun.controller';


// ── Shared modules ─────────────────────────────────────────────────────────
import { PrismaModule } from 'prisma/prisma.module';
import { InboundModule } from '../inbound/inbound.module';
import { R2Service } from 'src/common/storage/r2.service';

@Module({
    imports: [
        PrismaModule,
        forwardRef(() => InboundModule), // ✅ fix
        
        ScheduleModule.forRoot(),
    ],

    // ── Providers (services + providers) ────────────────────────────────────
    providers: [
        // Registry
        ChannelRegistry,

        // Channel management
        ChannelService,
        MediaService,
        R2Service,

        // WhatsApp
        WhatsAppProvider,
        WhatsAppTemplatesService,

        // Meta (single instance, registered under 'instagram' AND 'messenger')
        MetaProvider,
        InstagramIcebreakersService,
        MessengerMenuService,

        // Mailgun
        MailgunProvider,
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

        // ── Feature endpoints (auth-guarded, called by agents) ────────────────
        WhatsAppTemplatesController, // GET/POST  channels/:channelId/whatsapp/templates
        InstagramIcebreakersController, // GET/POST channels/:channelId/instagram/icebreakers
        MessengerMenuController,     // GET/POST  channels/:channelId/messenger/menu
    ],

    exports: [
        ChannelRegistry,
        ChannelService,
        MediaService,
        R2Service,
    ],
})
export class ChannelsModule { }