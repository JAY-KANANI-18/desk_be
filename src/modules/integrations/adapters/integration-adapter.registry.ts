import { Injectable, NotFoundException } from '@nestjs/common';
import { IntegrationProviderKey } from '../integration-catalog';
import { MetaAdsIntegrationAdapter } from '../providers/meta-ads.integration-adapter';
import { ShopifyIntegrationAdapter } from '../providers/shopify.integration-adapter';
import { IntegrationProviderAdapter } from './integration-adapter.interface';

@Injectable()
export class IntegrationAdapterRegistry {
  private readonly adapters: Map<IntegrationProviderKey, IntegrationProviderAdapter>;

  constructor(
    metaAds: MetaAdsIntegrationAdapter,
    shopify: ShopifyIntegrationAdapter,
  ) {
    this.adapters = new Map<IntegrationProviderKey, IntegrationProviderAdapter>([
      [metaAds.provider, metaAds],
      [shopify.provider, shopify],
    ]);
  }

  get(provider: string): IntegrationProviderAdapter {
    const adapter = this.adapters.get(provider as IntegrationProviderKey);
    if (!adapter) {
      throw new NotFoundException('Integration provider is not implemented yet');
    }
    return adapter;
  }

  maybeGet(provider: string): IntegrationProviderAdapter | null {
    return this.adapters.get(provider as IntegrationProviderKey) ?? null;
  }
}
