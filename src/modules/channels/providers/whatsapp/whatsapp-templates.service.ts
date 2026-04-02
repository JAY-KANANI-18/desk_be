// modules/channels/providers/whatsapp/whatsapp-templates.service.ts

import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import { Cron, CronExpression } from '@nestjs/schedule';
import axios from 'axios';

const GRAPH = 'https://graph.facebook.com/v22.0';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TemplatePreviewResult {
  header?: string;
  body:    string;
  footer?: string;
  buttons?: Array<{ type: string; text: string; url?: string }>;
  /** Ready-to-send components array for OutboundService */
  components: any[];
}

@Injectable()
export class WhatsAppTemplatesService {
  private readonly logger = new Logger(WhatsAppTemplatesService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ─── Sync ──────────────────────────────────────────────────────────────────

  async sync(channel: any): Promise<{ synced: number; errors: number }> {
    const token  = channel.credentials?.accessToken;
    const wabaId = channel.config?.wabaId;
    console.log({token,wabaId});
    

    if (!token)  throw new BadRequestException('WhatsApp channel missing accessToken');
    if (!wabaId) throw new BadRequestException('WhatsApp channel missing wabaId');

    let synced = 0;
    let errors = 0;
    let url: string | null =
      `${GRAPH}/${wabaId}/message_templates?fields=id,name,language,category,status,components,rejected_reason&limit=100`;

    while (url) {

      const { data } = await axios.get(url, {
        headers: { Authorization: `Bearer ${token}` },
      });

      for (const t of data.data ?? []) {
        try {
          const variables = this.extractVariables(t.components ?? []);

          await this.prisma.whatsAppTemplate.upsert({
            where: {
              workspaceId_channelId_name_language: {
                workspaceId: channel.workspaceId,
                channelId:   channel.id,
                name:        t.name,
                language:    t.language,
              },
            },
            create: {
              workspaceId:     channel.workspaceId,
              channelId:       channel.id,
              metaId:          t.id,
              name:            t.name,
              language:        t.language,
              category:        t.category,
              status:          t.status,
              components:      t.components ?? [],
              variables,
              rejectedReason:  t.rejected_reason ?? null,
              syncedAt:        new Date(),
            },
            update: {
              metaId:          t.id,
              category:        t.category,
              status:          t.status,
              components:      t.components ?? [],
              variables,
              rejectedReason:  t.rejected_reason ?? null,
              syncedAt:        new Date(),
            },
          });
          synced++;
        } catch (err) {
          this.logger.error(`Failed to upsert template ${t.name}/${t.language}: ${err.message}`);
          errors++;
        }
      }

      url = data.paging?.next ?? null;
    }

    this.logger.log(`WA template sync channel=${channel.id} synced=${synced} errors=${errors}`);
    return { synced, errors };
  }

  // ─── Scheduled sync every 6 hours ─────────────────────────────────────────

  @Cron(CronExpression.EVERY_6_HOURS)
  async scheduledSync() {
    this.logger.log('Running scheduled WhatsApp template sync...');
    const channels = await this.prisma.channel.findMany({
      where: { type: 'whatsapp', status: 'connected' },
    });
    for (const channel of channels) {
      try {
        await this.sync(channel);
      } catch (err) {
        this.logger.error(`Scheduled sync failed channel=${channel.id}: ${err.message}`);
      }
    }
  }

  // ─── List ──────────────────────────────────────────────────────────────────

  async list(
    channelId: string,
    workspaceId: string,
    filters: { status?: string; category?: string; language?: string; search?: string } = {},
  ) {
    console.log({channelId,workspaceId});
    
    return this.prisma.whatsAppTemplate.findMany({
      where: {
        channelId,
        workspaceId,
        ...(filters.status   ? { status: filters.status }   : {}),
        ...(filters.category ? { category: filters.category } : {}),
        ...(filters.language ? { language: filters.language } : {}),
        ...(filters.search   ? { name: { contains: filters.search, mode: 'insensitive' as const } } : {}),
      },
      orderBy: [{ status: 'asc' }, { name: 'asc' }],
    });
  }

  // ─── Get variable names ────────────────────────────────────────────────────

  async getVariables(templateId: string): Promise<string[]> {
    const t = await this.prisma.whatsAppTemplate.findUnique({
      where: { id: templateId },
      select: { variables: true },
    });
    if (!t) throw new NotFoundException('Template not found');
    return t.variables as string[];
  }

  // ─── Preview ───────────────────────────────────────────────────────────────

  async preview(
    templateId: string,
    variables: Record<string, string>,
  ): Promise<TemplatePreviewResult> {
    const t = await this.prisma.whatsAppTemplate.findUnique({ where: { id: templateId } });
    if (!t) throw new NotFoundException('Template not found');
    return this.render(t.components as any[], variables);
  }

  // ─── Build (returns components ready for OutboundService) ─────────────────

  async build(
    templateId: string,
    variables: Record<string, string>,
  ): Promise<any[]> {
    const result = await this.preview(templateId, variables);
    return result.components;
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  private render(components: any[], vars: Record<string, string>): TemplatePreviewResult {
    const sub = (text: string) =>
      text.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? `{{${k}}}`);

    const result: TemplatePreviewResult = { body: '', components: [] };
    const built: any[] = [];

    for (const c of components) {
      switch (c.type?.toUpperCase()) {
        case 'HEADER': {
          if (c.format === 'TEXT' && c.text) {
            result.header = sub(c.text);
            const params = this.textParams(c.text, vars);
            if (params.length) built.push({ type: 'header', parameters: params });
          } else if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(c.format)) {
            const mediaUrl = vars['header_url'];
            result.header = `[${c.format}${mediaUrl ? `: ${mediaUrl}` : ''}]`;
            if (mediaUrl) {
              const k = c.format.toLowerCase();
              built.push({ type: 'header', parameters: [{ type: k, [k]: { link: mediaUrl } }] });
            }
          }
          break;
        }
        case 'BODY': {
          result.body = sub(c.text ?? '');
          const params = this.textParams(c.text ?? '', vars);
          if (params.length) built.push({ type: 'body', parameters: params });
          break;
        }
        case 'FOOTER':
          result.footer = c.text;
          break;
        case 'BUTTONS': {
          result.buttons = [];
          for (let i = 0; i < (c.buttons ?? []).length; i++) {
            const btn = c.buttons[i];
            result.buttons.push({ type: btn.type, text: btn.text, url: btn.url ? sub(btn.url) : undefined });
            if (btn.type === 'URL' && btn.url?.includes('{{')) {
              const suffix = vars[`url_${i + 1}`] ?? vars['1'];
              if (suffix) built.push({ type: 'button', sub_type: 'url', index: String(i), parameters: [{ type: 'text', text: suffix }] });
            }
            if (btn.type === 'COPY_CODE') {
              const code = vars['coupon_code'];
              if (code) built.push({ type: 'button', sub_type: 'copy_code', index: String(i), parameters: [{ type: 'coupon_code', coupon_code: code }] });
            }
          }
          break;
        }
      }
    }

    result.components = built;
    return result;
  }

  private textParams(text: string, vars: Record<string, string>) {
    const out: { type: 'text'; text: string }[] = [];
    const re = /\{\{(\w+)\}\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const v = vars[m[1]];
      if (v !== undefined) out.push({ type: 'text', text: v });
    }
    return out;
  }

  // ─── Variable extraction ───────────────────────────────────────────────────

  private extractVariables(components: any[]): string[] {
    const vars = new Set<string>();
    const re   = /\{\{(\w+)\}\}/g;

    for (const c of components) {
      for (const text of [c.text, ...(c.buttons ?? []).map((b: any) => b.url)].filter(Boolean)) {
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) vars.add(m[1]);
      }
    }

    return Array.from(vars).sort((a, b) => {
      const na = parseInt(a), nb = parseInt(b);
      return !isNaN(na) && !isNaN(nb) ? na - nb : a.localeCompare(b);
    });
  }
}