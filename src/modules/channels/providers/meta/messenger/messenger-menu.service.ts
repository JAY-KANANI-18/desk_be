// modules/channels/providers/meta/messenger/messenger-menu.service.ts
//
// Manages the Messenger Persistent Menu and Get Started button.
// Synced from Meta Graph API → stored in MetaPageTemplate table.

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import axios from 'axios';
import { PrismaService } from '../../../../../prisma/prisma.service';
import {
  MenuActionConfig,
  MetaAutomationService,
} from '../meta-automation.service';

const GRAPH = 'https://graph.facebook.com/v22.0';

export interface PersistentMenuItem {
  type: 'postback' | 'web_url';
  title: string;
  payload?: string;
  url?: string;
  actionType?: 'payload' | 'quick_reply' | 'url';
  replyText?: string;
  actionId?: string;
}

export interface PersistentMenuLocale {
  locale: string;
  composer_input_disabled: boolean;
  call_to_actions: PersistentMenuItem[];
}

export interface MessengerMenuState {
  persistentMenu: PersistentMenuLocale[];
  getStarted: { payload: string } | null;
  greeting: Array<{ locale: string; text: string }>;
  syncedAt: string;
}

@Injectable()
export class MessengerMenuService {
  private readonly logger = new Logger(MessengerMenuService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly automation: MetaAutomationService,
    private readonly events: EventEmitter2,
  ) {}

  // ─── Sync from Meta ────────────────────────────────────────────────────────

  async sync(channelId: string, workspaceId: string): Promise<MessengerMenuState> {
    const state = await this.fetchState(channelId, workspaceId);
    this.events.emit('channel.sync.completed', {
      workspaceId,
      channelId,
      feature: 'messenger_menu',
      syncedAt: state.syncedAt,
    });
    return state;
  }

  // ─── List from DB ──────────────────────────────────────────────────────────

  async list(channelId: string, workspaceId: string) {
    return this.fetchState(channelId, workspaceId);
  }

  // ─── Push persistent menu to Meta ─────────────────────────────────────────

  async pushMenu(
    channelId: string,
    workspaceId: string,
    menu: PersistentMenuLocale[],
  ): Promise<MessengerMenuState> {
    const channel: any = await this.findChannel(channelId, workspaceId);
    const token = channel.credentials?.accessToken;
    const menuActions: Record<string, MenuActionConfig> = {};

    const persistentMenu = menu.map((locale, localeIndex) => ({
      locale: locale.locale || 'default',
      composer_input_disabled: Boolean(locale.composer_input_disabled),
      call_to_actions: (locale.call_to_actions ?? []).map((item, itemIndex) => {
        if (item.type === 'web_url') {
          return {
            type: 'web_url',
            title: item.title,
            url: item.url,
          };
        }

        const actionType = item.actionType ?? 'payload';
        const actionId =
          item.actionId ??
          `${channelId}_${localeIndex}_${itemIndex}_${Date.now()}`;
        const payload =
          actionType === 'quick_reply'
            ? `AUTO_MENU:${actionId}`
            : item.payload ?? actionId;

        menuActions[payload] = {
          kind: actionType === 'quick_reply' ? 'quick_reply' : 'payload',
          title: item.title,
          replyText: item.replyText?.trim() || undefined,
        };

        return {
          type: 'postback',
          title: item.title,
          payload,
        };
      }),
    }));

    await axios.post(
      `${GRAPH}/me/messenger_profile`,
      { persistent_menu: persistentMenu },
      { params: { access_token: token } },
    );

    await this.automation.updateMenuActions(
      channel.id,
      channel.config,
      menuActions,
    );

    this.events.emit('channel.config.updated', {
      workspaceId,
      channelId,
      feature: 'messenger_menu',
      config: {
        persistentMenu,
      },
    });

    this.logger.log(`Messenger menu pushed channel=${channelId}`);
    return this.fetchState(channelId, workspaceId);
  }

  // ─── Push Get Started button to Meta ──────────────────────────────────────

  async pushGetStarted(
    channelId: string,
    workspaceId: string,
    payload: string,
  ): Promise<MessengerMenuState> {
    const channel: any = await this.findChannel(channelId, workspaceId);
    const token = channel.credentials?.accessToken;

    await axios.post(
      `${GRAPH}/me/messenger_profile`,
      { get_started: { payload } },
      { params: { access_token: token } },
    );

    this.events.emit('channel.config.updated', {
      workspaceId,
      channelId,
      feature: 'messenger_menu',
      config: {
        getStarted: { payload },
      },
    });

    this.logger.log(`Messenger get_started pushed channel=${channelId}`);
    return this.fetchState(channelId, workspaceId);
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private async fetchState(
    channelId: string,
    workspaceId: string,
  ): Promise<MessengerMenuState> {
    const channel: any = await this.findChannel(channelId, workspaceId);
    const token = channel.credentials?.accessToken;
    const automationConfig = ((channel.config ?? {}) as any)?.automation ?? {};
    const menuActions = (automationConfig.menuActions ?? {}) as Record<
      string,
      MenuActionConfig
    >;

    const { data } = await axios.get(`${GRAPH}/me/messenger_profile`, {
      params: {
        fields: 'persistent_menu,get_started,greeting',
        access_token: token,
      },
    });

    const persistentMenu = (data.persistent_menu ?? []).map((locale: any) => ({
      locale: locale.locale ?? 'default',
      composer_input_disabled: Boolean(locale.composer_input_disabled),
      call_to_actions: (locale.call_to_actions ?? []).map((item: any) => {
        const action = item.payload ? menuActions[item.payload] : undefined;
        return {
          type: item.type === 'web_url' ? 'web_url' : 'postback',
          title: item.title,
          payload: item.payload,
          url: item.url,
          actionType:
            item.type === 'web_url'
              ? 'url'
              : action?.kind === 'quick_reply'
                ? 'quick_reply'
                : 'payload',
          replyText: action?.replyText,
        } satisfies PersistentMenuItem;
      }),
    }));

    const state: MessengerMenuState = {
      persistentMenu,
      getStarted: data.get_started?.payload
        ? { payload: data.get_started.payload }
        : null,
      greeting: Array.isArray(data.greeting)
        ? data.greeting.map((entry: any) => ({
            locale: entry.locale,
            text: entry.text,
          }))
        : [],
      syncedAt: new Date().toISOString(),
    };

    await this.cacheState(workspaceId, channelId, state);
    return state;
  }

  private async cacheState(
    workspaceId: string,
    channelId: string,
    state: MessengerMenuState,
  ) {
    await this.prisma.metaPageTemplate.deleteMany({
      where: {
        workspaceId,
        channelId,
        channelType: 'messenger',
        type: { in: ['persistent_menu', 'get_started', 'greeting'] },
      },
    });

    await this.prisma.metaPageTemplate.create({
      data: {
        workspaceId,
        channelId,
        channelType: 'messenger',
        type: 'persistent_menu',
        name: 'Persistent Menu',
        payload: {
          persistent_menu: state.persistentMenu,
        } as unknown as Prisma.InputJsonValue,
        syncedAt: new Date(state.syncedAt),
      },
    });

    if (state.getStarted) {
      await this.prisma.metaPageTemplate.create({
        data: {
          workspaceId,
          channelId,
          channelType: 'messenger',
          type: 'get_started',
          name: 'Get Started',
          payload: state.getStarted,
          syncedAt: new Date(state.syncedAt),
        },
      });
    }
  }

  private async findChannel(channelId: string, workspaceId: string) {
    const channel = await this.prisma.channel.findUnique({ where: { id: channelId } });
    if (!channel || channel.workspaceId !== workspaceId || channel.type !== 'messenger') {
      throw new NotFoundException('Messenger channel not found');
    }
    return channel;
  }
}
