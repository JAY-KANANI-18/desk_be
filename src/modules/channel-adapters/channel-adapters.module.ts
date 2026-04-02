import { MailgunProvider } from "./adapters/mailgun.adapter";
import { MetaProvider } from "./adapters/meta.adapter";
import { WebchatProvider } from "./adapters/webchat.adapter";
import { WhatsAppProvider } from "./adapters/whatsapp.adapter";
import { ChannelAdaptersRegistry } from "./channel-adapters.registry";
import {  Module } from '@nestjs/common';
import { MediaService } from "../media/media.service";

@Module({
  imports: [],
  providers: [
    ChannelAdaptersRegistry,
    WebchatProvider,

    WhatsAppProvider,
    // Meta (single instance, registered under 'instagram' AND 'messenger')
    MetaProvider,
    MailgunProvider,
     
    

  ],
  exports: [ChannelAdaptersRegistry,        
  ],
})


export class ChannelAdaptersModule { }