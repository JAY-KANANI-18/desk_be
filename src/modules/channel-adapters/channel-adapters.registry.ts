// modules/channels/channel-registry.service.ts

import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { MailgunProvider } from './adapters/mailgun.adapter';
import { MetaProvider } from './adapters/meta.adapter';
import { WebchatProvider } from './adapters/webchat.adapter';
import { WhatsAppProvider } from './adapters/whatsapp.adapter';
import { ChannelProvider } from './channel-adapter.interface';
import { Msg91Provider } from './adapters/msg91.adapter';
import { ExotelProvider } from './adapters/exotel.adapter';


@Injectable()
export class ChannelAdaptersRegistry implements OnModuleInit {
  private readonly logger = new Logger(ChannelAdaptersRegistry.name);
  private readonly map = new Map<string, ChannelProvider>();

  constructor(
    private readonly whatsapp: WhatsAppProvider,
    private readonly meta: MetaProvider,
    private readonly mailgun: MailgunProvider,
    private readonly webchat: WebchatProvider,
    private readonly msg91: Msg91Provider,
    private readonly exotel: ExotelProvider,
  ) {}

  onModuleInit() {
    this.register(this.whatsapp);
    // MetaProvider handles both — registered under two keys
    this.registerAs('instagram', this.meta);
    this.registerAs('messenger', this.meta);
    this.register(this.mailgun);
    this.registerAs('webchat', this.webchat);
    this.register(this.msg91);
    this.register(this.exotel);


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