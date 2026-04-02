// modules/channels/providers/meta/messenger/messenger-menu.service.ts
//
// Manages the Messenger Persistent Menu and Get Started button.
// Synced from Meta Graph API → stored in MetaPageTemplate table.

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import axios from 'axios';

const GRAPH = 'https://graph.facebook.com/v19.0';

export interface PersistentMenuItem {
  type: 'postback' | 'web_url' | 'nested';
  title: string;
  payload?: string;
  url?: string;
  call_to_actions?: PersistentMenuItem[];
}

export interface PersistentMenuLocale {
  locale: string;
  composer_input_disabled: boolean;
  call_to_actions: PersistentMenuItem[];
}

@Injectable()
export class MessengerMenuService {
  private readonly logger = new Logger(MessengerMenuService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ─── Sync from Meta ────────────────────────────────────────────────────────

  async sync(channelId: string, workspaceId: string): Promise<{ synced: number; errors: number }> {
    const channel :any= await this.findChannel(channelId, workspaceId);
    const token   = channel.credentials?.accessToken;

    let synced = 0;
    let errors = 0;

    try {
      // Fetch persistent menu
      const { data } = await axios.get(`${GRAPH}/me/messenger_profile`, {
        params:  { fields: 'persistent_menu,get_started,greeting', access_token: token },
      });

      // Delete old records and replace
      await this.prisma.metaPageTemplate.deleteMany({
        where: { channelId, channelType: 'messenger' },
      });

      for (const item of data.data ?? []) {
        if (item.persistent_menu) {
          await this.prisma.metaPageTemplate.create({
            data: {
              workspaceId,
              channelId,
              channelType: 'messenger',
              type:        'persistent_menu',
              name:        'Persistent Menu',
              payload:     { persistent_menu: item.persistent_menu },
              syncedAt:    new Date(),
            },
          });
          synced++;
        }

        if (item.get_started) {
          await this.prisma.metaPageTemplate.create({
            data: {
              workspaceId,
              channelId,
              channelType: 'messenger',
              type:        'get_started',
              name:        'Get Started',
              payload:     item.get_started,
              syncedAt:    new Date(),
            },
          });
          synced++;
        }

        for (const greeting of item.greeting ?? []) {
          await this.prisma.metaPageTemplate.create({
            data: {
              workspaceId,
              channelId,
              channelType: 'messenger',
              type:        'greeting',
              name:        `Greeting (${greeting.locale})`,
              payload:     greeting,
              syncedAt:    new Date(),
            },
          });
          synced++;
        }
      }

      this.logger.log(`Messenger menu synced channel=${channelId} items=${synced}`);
    } catch (err) {
      this.logger.error(`Messenger menu sync failed channel=${channelId}: ${err.message}`);
      errors++;
    }

    return { synced, errors };
  }

  // ─── List from DB ──────────────────────────────────────────────────────────

  async list(channelId: string, workspaceId: string, type?: string) {
    return this.prisma.metaPageTemplate.findMany({
      where: {
        channelId,
        workspaceId,
        channelType: 'messenger',
        ...(type ? { type } : {}),
      },
      orderBy: { type: 'asc' },
    });
  }

  // ─── Push persistent menu to Meta ─────────────────────────────────────────

  async pushMenu(channelId: string, workspaceId: string, menu: PersistentMenuLocale[]): Promise<void> {
    const channel:any = await this.findChannel(channelId, workspaceId);
    const token   = channel.credentials?.accessToken;

    await axios.post(
      `${GRAPH}/me/messenger_profile`,
      { persistent_menu: menu },
      { params: { access_token: token } },
    );

    this.logger.log(`Messenger menu pushed channel=${channelId}`);
  }

  // ─── Push Get Started button to Meta ──────────────────────────────────────

  async pushGetStarted(channelId: string, workspaceId: string, payload: string): Promise<void> {
    const channel:any = await this.findChannel(channelId, workspaceId);
    const token   = channel.credentials?.accessToken;

    await axios.post(
      `${GRAPH}/me/messenger_profile`,
      { get_started: { payload } },
      { params: { access_token: token } },
    );

    this.logger.log(`Messenger get_started pushed channel=${channelId}`);
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private async findChannel(channelId: string, workspaceId: string) {
    const channel = await this.prisma.channel.findUnique({ where: { id: channelId } });
    if (!channel || channel.workspaceId !== workspaceId || channel.type !== 'messenger') {
      throw new NotFoundException('Messenger channel not found');
    }
    return channel;
  }
}