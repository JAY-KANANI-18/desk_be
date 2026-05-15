import type { PrismaService } from '../../../prisma/prisma.service';
import type { CommerceService } from '../../commerce/commerce.service';
import type { IntegrationJobQueue } from '../integration-job.queue';
import type { IntegrationSecretService } from '../integration-secret.service';
import { ShopifyIntegrationAdapter } from './shopify.integration-adapter';

type ShopifyAdapterInternals = {
  productPayloadFromGraphql(node: Record<string, unknown>): Record<string, unknown>;
  customerPayloadFromGraphql(node: Record<string, unknown>): Record<string, unknown>;
  orderPayloadFromGraphql(node: Record<string, unknown>): Record<string, unknown>;
  providerActions(): Array<{ key: string; mode: string }>;
  buildSyncJob(
    integration: {
      id: string;
      provider: string;
      status: string;
      externalAccountId: string | null;
      externalAccountName: string | null;
      metadata: null;
      settings: { primaryResourceId?: string };
    },
    options?: {
      mode?: 'manual_sync' | 'backfill';
      resources?: string[];
      since?: string;
      until?: string;
    },
  ): { type: string; resourceId?: string | null; input?: Record<string, unknown> } | null;
  buildActionJob(params: {
    integration: {
      id: string;
      provider: string;
      status: string;
      externalAccountId: string | null;
      externalAccountName: string | null;
      metadata: null;
      settings: { primaryResourceId?: string };
    };
    action: string;
  }): { type: string; resourceId?: string | null; input?: Record<string, unknown> } | null;
};

function createAdapter() {
  return new ShopifyIntegrationAdapter(
    {} as PrismaService,
    {} as IntegrationSecretService,
    {} as CommerceService,
    {} as IntegrationJobQueue,
  ) as unknown as ShopifyAdapterInternals;
}

describe('ShopifyIntegrationAdapter GraphQL payload mapping', () => {
  it('exposes provider actions for health checks and webhook resubscription', () => {
    const adapter = createAdapter();

    expect(adapter.providerActions()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'test_connection', mode: 'immediate' }),
        expect.objectContaining({ key: 'resubscribe_webhooks', mode: 'job' }),
      ]),
    );
    expect(
      adapter.buildSyncJob(
        {
          id: 'integration-1',
          provider: 'shopify',
          status: 'connected',
          externalAccountId: 'demo.myshopify.com',
          externalAccountName: 'Demo',
          metadata: null,
          settings: { primaryResourceId: 'resource-1' },
        },
        {
          mode: 'backfill',
          resources: ['orders', 'carts'],
          since: '2026-05-01T00:00:00.000Z',
          until: '2026-05-14T23:59:59.999Z',
        },
      ),
    ).toEqual(
      expect.objectContaining({
        type: 'shopify.initial_sync',
        resourceId: 'resource-1',
        input: expect.objectContaining({
          mode: 'backfill',
          resources: ['orders', 'carts'],
          since: '2026-05-01T00:00:00.000Z',
          until: '2026-05-14T23:59:59.999Z',
        }),
      }),
    );
    expect(
      adapter.buildActionJob({
        integration: {
          id: 'integration-1',
          provider: 'shopify',
          status: 'connected',
          externalAccountId: 'demo.myshopify.com',
          externalAccountName: 'Demo',
          metadata: null,
          settings: { primaryResourceId: 'resource-1' },
        },
        action: 'resubscribe_webhooks',
      }),
    ).toEqual(
      expect.objectContaining({
        type: 'shopify.resubscribe_webhooks',
        resourceId: 'resource-1',
        input: expect.objectContaining({ mode: 'resubscribe_webhooks' }),
      }),
    );
  });

  it('maps GraphQL products into the REST-like product payload used by commerce sync', () => {
    const adapter = createAdapter();

    const payload = adapter.productPayloadFromGraphql({
      id: 'gid://shopify/Product/123',
      title: 'Canvas Bag',
      handle: 'canvas-bag',
      productType: 'Bags',
      vendor: 'Axo',
      status: 'ACTIVE',
      featuredImage: { url: 'https://cdn.example.com/bag.jpg' },
      variants: {
        edges: [
          {
            node: {
              id: 'gid://shopify/ProductVariant/456',
              title: 'Black',
              sku: 'BAG-BLK',
              price: '29.50',
              inventoryQuantity: 12,
            },
          },
        ],
      },
    });

    expect(payload).toEqual(
      expect.objectContaining({
        id: '123',
        title: 'Canvas Bag',
        product_type: 'Bags',
        status: 'active',
        image: { src: 'https://cdn.example.com/bag.jpg' },
        variants: [
          expect.objectContaining({
            id: '456',
            sku: 'BAG-BLK',
            price: '29.50',
            inventory_quantity: 12,
          }),
        ],
      }),
    );
  });

  it('maps GraphQL customers and orders into normalized Shopify payloads', () => {
    const adapter = createAdapter();

    const customer = adapter.customerPayloadFromGraphql({
      id: 'gid://shopify/Customer/111',
      email: 'buyer@example.com',
      phone: '+15551234567',
      firstName: 'Buyer',
      lastName: 'Person',
      numberOfOrders: 3,
      amountSpent: { amount: '120.25', currencyCode: 'USD' },
      defaultAddress: { company: 'Buyer Co' },
      createdAt: '2026-05-01T10:00:00Z',
      updatedAt: '2026-05-10T10:00:00Z',
    });

    expect(customer).toEqual(
      expect.objectContaining({
        id: '111',
        email: 'buyer@example.com',
        first_name: 'Buyer',
        orders_count: 3,
        total_spent: '120.25',
        currency: 'USD',
        billing_address: { company: 'Buyer Co' },
      }),
    );

    const order = adapter.orderPayloadFromGraphql({
      id: 'gid://shopify/Order/222',
      name: '#1001',
      email: 'buyer@example.com',
      currencyCode: 'USD',
      displayFinancialStatus: 'PAID',
      displayFulfillmentStatus: 'FULFILLED',
      subtotalPriceSet: { shopMoney: { amount: '100.00', currencyCode: 'USD' } },
      totalDiscountsSet: { shopMoney: { amount: '10.00', currencyCode: 'USD' } },
      totalTaxSet: { shopMoney: { amount: '8.00', currencyCode: 'USD' } },
      totalShippingPriceSet: { shopMoney: { amount: '5.00', currencyCode: 'USD' } },
      totalPriceSet: { shopMoney: { amount: '103.00', currencyCode: 'USD' } },
      customer: {
        id: 'gid://shopify/Customer/111',
        email: 'buyer@example.com',
      },
      lineItems: {
        edges: [
          {
            node: {
              id: 'gid://shopify/LineItem/333',
              title: 'Canvas Bag',
              sku: 'BAG-BLK',
              quantity: 2,
              product: { id: 'gid://shopify/Product/123' },
              variant: { id: 'gid://shopify/ProductVariant/456' },
              originalUnitPriceSet: { shopMoney: { amount: '50.00' } },
              discountedTotalSet: { shopMoney: { amount: '90.00' } },
            },
          },
        ],
      },
    });

    expect(order).toEqual(
      expect.objectContaining({
        id: '222',
        financial_status: 'paid',
        fulfillment_status: 'fulfilled',
        subtotal_price: '100.00',
        total_price: '103.00',
        shipping_lines: [{ price: '5.00' }],
        customer: expect.objectContaining({ id: '111' }),
        line_items: [
          expect.objectContaining({
            id: '333',
            product_id: '123',
            variant_id: '456',
            price: '50.00',
            line_price: '90.00',
          }),
        ],
      }),
    );
  });
});
