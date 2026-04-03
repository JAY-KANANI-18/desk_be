// modules/channels/providers/meta/instagram/instagram-icebreakers.service.ts
//
// Ice-breakers are question buttons shown to new users before they message.
// Synced from Meta Graph API → stored in MetaPageTemplate table.

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../../../prisma/prisma.service';
import axios from 'axios';
import { Prisma } from '@prisma/client';

const GRAPH = 'https://graph.facebook.com/v19.0';

export interface IceBreakerItem {
  question: string;
  payload:  string;
}

@Injectable()
export class InstagramIcebreakersService {
  private readonly logger = new Logger(InstagramIcebreakersService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ─── Sync from Meta ────────────────────────────────────────────────────────

  async sync(channelId: string, workspaceId: string): Promise<{ synced: number; errors: number }> {
    const channel:any = await this.findChannel(channelId, workspaceId);
    const token   = channel.credentials?.accessToken;
    const pageId  = channel.identifier;

    let synced = 0;
    let errors = 0;

    try {
      const { data } = await axios.get(`${GRAPH}/${pageId}/ice_breakers`, {
        params:  { fields: 'call_to_actions' },
        headers: { Authorization: `Bearer ${token}` },
      });

      const actions: IceBreakerItem[] = data.data?.[0]?.call_to_actions ?? [];

      // Delete old and replace — ice-breakers are always replaced as a set
      await this.prisma.metaPageTemplate.deleteMany({
        where: { channelId, channelType: 'instagram', type: 'ice_breaker' },
      });

      for (const action of actions) {
        await this.prisma.metaPageTemplate.create({
          data: {
            workspaceId,
            channelId,
            channelType: 'instagram',
            type:        'ice_breaker',
            name:        action.question.substring(0, 60),
            payload:     action  as any,
            syncedAt:    new Date(),
          },
        });
        synced++;
      }

      this.logger.log(`Instagram ice-breakers synced channel=${channelId} count=${synced}`);
    } catch (err) {
      this.logger.error(`Ice-breaker sync failed channel=${channelId}: ${err.message}`);
      errors++;
    }

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

    await axios.post(
      `${GRAPH}/${pageId}/messenger_profile`,
      { ice_breakers: [{ call_to_actions: items }] },
      { headers: { Authorization: `Bearer ${token}` } },
    );

    this.logger.log(`Instagram ice-breakers pushed channel=${channelId} count=${items.length}`);
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