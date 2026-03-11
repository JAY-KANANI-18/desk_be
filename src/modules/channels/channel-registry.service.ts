import { Injectable } from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import { WhatsAppProvider } from './providers/whatsapp.provider';
import { ChannelProvider } from './channel-provider.interface';

import { EmailMailgunProvider } from './providers/mailgun.provider';
import { MetaMessagingProvider } from './providers/meta.providers';

@Injectable()
export class ChannelRegistry {
    private providers = new Map<string, ChannelProvider>();

    constructor(private prisma: PrismaService) {

        // ALERT: uncomment this line in future
        this.providers.set(
            'whatsapp',
            new WhatsAppProvider(),
        );

        this.providers.set(
            'instagram',
            new MetaMessagingProvider('instagram'),
        );
      
        this.providers.set(
            'messenger',
            new MetaMessagingProvider('messenger'),
        );
        this.providers.set(
            'email',
            new EmailMailgunProvider(),
        );

    }

    getProviderByType(type: string): ChannelProvider {
        const provider = this.providers.get(type);

        if (!provider) {
            throw new Error(`Provider not found for type: ${type}`);
        }

        return provider;
    }
}