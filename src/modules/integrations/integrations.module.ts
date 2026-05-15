import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { MessageProcessingModule } from '../outbound/message-processing.module';
import { CommerceModule } from '../commerce/commerce.module';
import { IntegrationAdapterRegistry } from './adapters/integration-adapter.registry';
import { IntegrationJobQueue } from './integration-job.queue';
import { IntegrationJobWorker } from './integration-job.worker';
import { IntegrationSecretService } from './integration-secret.service';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';
import { MetaAdsIntegrationAdapter } from './providers/meta-ads.integration-adapter';
import { MetaAdsIntegrationController } from './providers/meta-ads-integration.controller';
import { ShopifyIntegrationAdapter } from './providers/shopify.integration-adapter';
import { ShopifyIntegrationController } from './providers/shopify-integration.controller';

@Module({
  imports: [PrismaModule, MessageProcessingModule, CommerceModule],
  controllers: [IntegrationsController, MetaAdsIntegrationController, ShopifyIntegrationController],
  providers: [
    IntegrationsService,
    IntegrationSecretService,
    IntegrationJobQueue,
    IntegrationJobWorker,
    IntegrationAdapterRegistry,
    MetaAdsIntegrationAdapter,
    ShopifyIntegrationAdapter,
  ],
  exports: [IntegrationsService, IntegrationSecretService, IntegrationJobQueue],
})
export class IntegrationsModule {}
