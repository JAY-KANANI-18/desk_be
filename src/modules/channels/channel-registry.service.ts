// modules/channels/channel-registry.service.ts

import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ChannelProvider } from './channel-provider.interface';
import { WhatsAppProvider } from './providers/whatsapp/whatsapp.provider';
import { MetaProvider } from './providers/meta/meta.providers';
import { MailgunProvider } from './providers/email/mailgun.provider';


@Injectable()
export class ChannelRegistry implements OnModuleInit {
  private readonly logger = new Logger(ChannelRegistry.name);
  private readonly map = new Map<string, ChannelProvider>();

  constructor(
    private readonly whatsapp: WhatsAppProvider,
    private readonly meta: MetaProvider,
    private readonly mailgun: MailgunProvider,
  ) {}

  onModuleInit() {
    this.register(this.whatsapp);
    // MetaProvider handles both — registered under two keys
    this.registerAs('instagram', this.meta);
    this.registerAs('messenger', this.meta);
    this.register(this.mailgun);

    this.logger.log(
      `Channel registry ready: [${Array.from(this.map.keys()).join(', ')}]`,
    );
  }

  private register(provider: ChannelProvider) {
    this.map.set(provider.type, provider);
  }

  private registerAs(type: string, provider: ChannelProvider) {
    this.map.set(type, provider);
  }

  getProviderByType(type: string): ChannelProvider {
    const p = this.map.get(type);
    if (!p) throw new Error(`No provider registered for channel type: "${type}"`);
    return p;
  }

  hasProvider(type: string): boolean {
    return this.map.has(type);
  }

  getAllTypes(): string[] {
    return Array.from(this.map.keys());
  }
}