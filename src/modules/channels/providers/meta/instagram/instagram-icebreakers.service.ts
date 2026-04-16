// modules/channels/providers/meta/instagram/instagram-icebreakers.service.ts
//
// Ice-breakers are question buttons shown to new users before they message.
// Synced from Meta Graph API → stored in MetaPageTemplate table.

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../../../../prisma/prisma.service';
import axios from 'axios';
import { Prisma } from '@prisma/client';

const GRAPH = 'https://graph.instagram.com/v21.0';

export interface IceBreakerItem {
  question: string;
  payload:  string;
}

@Injectable()
export class InstagramIcebreakersService {
  private readonly logger = new Logger(InstagramIcebreakersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  // ─── Sync from Meta ────────────────────────────────────────────────────────

  async sync(
  channelId: string,
  workspaceId: string
): Promise<{ synced: number; errors: number }> {
  const channel: any = await this.findChannel(channelId, workspaceId);

  const token = channel.credentials?.accessToken;
  const pageId = channel.identifier;

  let synced = 0;
  let errors = 0;

  if (!token) {
    this.logger.error(`Missing access token for channel=${channelId}`);
    return { synced: 0, errors: 1 };
  }

  try {
    // ✅ Correct endpoint
    const { data } = await axios.get(
      `${GRAPH}/me/messenger_profile`,
      {
        params: {
          fields: 'ice_breakers',
          access_token: token,
        },
      }
    );

    // console debug
    console.dir({ messengerProfile: data }, { depth: null });

    const raw = data?.data?.[0]?.ice_breakers ?? [];

    let actions: IceBreakerItem[] = [];

    // ✅ Handle BOTH formats
    if (raw.length && raw[0]?.call_to_actions) {
      // locale-based
      actions = raw.flatMap((r: any) => r.call_to_actions || []);
    } else {
      // simple format
      actions = raw;
    }

    // ✅ Normalize + validate
    const validActions: IceBreakerItem[] = actions
      .filter((a) => a?.question && a?.payload)
      .map((a) => ({
        question: String(a.question),
        payload: String(a.payload),
      }));

    // ✅ Safe transaction
    await this.prisma.$transaction(async (tx) => {
      // delete old
      await tx.metaPageTemplate.deleteMany({
        where: {
          channelId,
          channelType: 'instagram',
          type: 'ice_breaker',
        },
      });

      // insert new
      for (const action of validActions) {
        await tx.metaPageTemplate.create({
          data: {
            workspaceId,
            channelId,
            channelType: 'instagram',
            type: 'ice_breaker',
            name: action.question?.substring(0, 60) || 'Ice Breaker',
            payload: action as any,
            // @ts-expect-error legacy payload marker; replace with metaId in the next schema-safe cleanup.
            externalId: action.payload, // 👈 useful for future diff updates
            syncedAt: new Date(),
          },
        });

        synced++;
      }
    });

    this.logger.log(
      `Instagram ice-breakers synced channel=${channelId} count=${synced}`
    );
  } catch (err: any) {
    console.dir({ err }, { depth: null });

    this.logger.error(
      `Ice-breaker sync failed channel=${channelId}: ${err?.message}`
    );

    errors++;
  }

  // ✅ Emit event always
  this.events.emit('channel.sync.completed', {
    workspaceId,
    channelId,
    feature: 'instagram_icebreakers',
    synced,
    errors,
    syncedAt: new Date().toISOString(),
  });

  return { synced, errors };
}

  // ─── List from DB ──────────────────────────────────────────────────────────

  async list(channelId: string, workspaceId: string): Promise<IceBreakerItem[]> {
    const rows = await this.prisma.metaPageTemplate.findMany({
      where: { channelId, workspaceId, type: 'ice_breaker' },
      orderBy: { createdAt: 'asc' },
    });

    return rows.map(r =>r.payload as unknown as IceBreakerItem); 
  }

  // ─── Push to Meta ──────────────────────────────────────────────────────────
  // Used when agent updates ice-breakers from the dashboard

  async push(channelId: string, workspaceId: string, items: IceBreakerItem[]): Promise<void> {
    const channel:any = await this.findChannel(channelId, workspaceId);
    const token   = channel.credentials?.accessToken;
    const pageId  = channel.identifier;
    console.log({items});
    
await axios.post(
  `${GRAPH}/${pageId}/messenger_profile`,
  {
    ice_breakers: [
      {
              locale: "default",

        call_to_actions: items.map((i) => ({
          question: i.question,
          payload: i.payload, // 👈 REQUIRED
        })),
      },
    ],
  },
  {
    headers: { Authorization: `Bearer ${token}` },
  }
);

    this.logger.log(`Instagram ice-breakers pushed channel=${channelId} count=${items.length}`);
    this.events.emit('channel.config.updated', {
      workspaceId,
      channelId,
      feature: 'instagram_icebreakers',
      items,
    });
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private async findChannel(channelId: string, workspaceId: string) {
    const channel = await this.prisma.channel.findUnique({ where: { id: channelId } });
    if (!channel || channel.workspaceId !== workspaceId || channel.type !== 'instagram') {
      throw new NotFoundException('Instagram channel not found');
    }
    return channel;
  }
}
