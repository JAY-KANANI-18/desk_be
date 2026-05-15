import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { normalizePhoneIdentifier } from '../../common/utils/contact-identifier.util';
import { PrismaService } from '../../prisma/prisma.service';

type JsonRecord = Record<string, unknown>;

export type CommerceEventType =
  | 'commerce.customer_created'
  | 'commerce.customer_updated'
  | 'commerce.cart_created'
  | 'commerce.cart_updated'
  | 'commerce.cart_abandoned'
  | 'commerce.order_created'
  | 'commerce.order_paid'
  | 'commerce.order_fulfilled'
  | 'commerce.order_cancelled'
  | 'commerce.refund_created';

export interface CommerceCustomerInput {
  externalCustomerId: string;
  email?: string | null;
  phone?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  company?: string | null;
  status?: string;
  marketingOptIn?: boolean | null;
  totalOrders?: number;
  totalSpentAmount?: number | null;
  currency?: string | null;
  firstSeenAt?: Date | string | null;
  lastSeenAt?: Date | string | null;
  metadata?: JsonRecord | null;
}

export interface CommerceProductInput {
  externalProductId: string;
  externalVariantId?: string | null;
  externalKey?: string;
  title: string;
  sku?: string | null;
  handle?: string | null;
  productType?: string | null;
  vendor?: string | null;
  status?: string;
  imageUrl?: string | null;
  priceAmount?: number | null;
  currency?: string | null;
  inventoryQuantity?: number | null;
  metadata?: JsonRecord | null;
}

export interface CommerceLineItemInput {
  externalLineItemId?: string | null;
  externalProductId?: string | null;
  externalVariantId?: string | null;
  sku?: string | null;
  title: string;
  quantity?: number;
  unitPriceAmount?: number | null;
  totalAmount?: number | null;
  metadata?: JsonRecord | null;
}

export interface CommerceOrderInput {
  externalOrderId: string;
  orderNumber?: string | null;
  status?: string;
  financialStatus?: string | null;
  fulfillmentStatus?: string | null;
  currency?: string | null;
  subtotalAmount?: number | null;
  discountAmount?: number | null;
  taxAmount?: number | null;
  shippingAmount?: number | null;
  totalAmount?: number | null;
  email?: string | null;
  phone?: string | null;
  placedAt?: Date | string | null;
  paidAt?: Date | string | null;
  fulfilledAt?: Date | string | null;
  cancelledAt?: Date | string | null;
  lineItems?: CommerceLineItemInput[];
  metadata?: JsonRecord | null;
}

export interface CommerceCartInput {
  externalCartId: string;
  externalCheckoutId?: string | null;
  status?: string;
  currency?: string | null;
  subtotalAmount?: number | null;
  totalAmount?: number | null;
  itemCount?: number;
  checkoutUrl?: string | null;
  email?: string | null;
  phone?: string | null;
  providerCreatedAt?: Date | string | null;
  providerUpdatedAt?: Date | string | null;
  abandonedAt?: Date | string | null;
  recoveredAt?: Date | string | null;
  expiresAt?: Date | string | null;
  lineItems?: CommerceLineItemInput[];
  metadata?: JsonRecord | null;
}

export interface RecordCommerceEventInput {
  workspaceId: string;
  integrationId: string;
  integrationResourceId?: string | null;
  provider: string;
  eventType: CommerceEventType;
  externalEventId?: string | null;
  idempotencyKey?: string | null;
  occurredAt?: Date | string | null;
  customer?: CommerceCustomerInput | null;
  products?: CommerceProductInput[];
  order?: CommerceOrderInput | null;
  cart?: CommerceCartInput | null;
  raw?: JsonRecord | null;
}

export interface SyncCommerceProductsInput {
  workspaceId: string;
  integrationId: string;
  integrationResourceId?: string | null;
  provider: string;
  products: CommerceProductInput[];
}

type CommerceContactContext = {
  contactId: string | null;
  commerceCustomerId: string | null;
};

@Injectable()
export class CommerceService {
  private readonly logger = new Logger(CommerceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  @OnEvent('integration.commerce.event')
  async onIntegrationCommerceEvent(event: RecordCommerceEventInput) {
    await this.recordEvent(event);
  }

  async recordEvent(input: RecordCommerceEventInput) {
    const integration = await this.prisma.integration.findFirst({
      where: {
        id: input.integrationId,
        workspaceId: input.workspaceId,
        status: { not: 'disconnected' },
      },
      select: { id: true, workspaceId: true, provider: true },
    });

    if (!integration) {
      throw new NotFoundException('Integration not found');
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const event = await this.createIntegrationEvent(tx, input);
      const products = await this.upsertProducts(tx, input);
      const contactContext = await this.resolveCommerceContact(tx, input);

      const orderId = input.order
        ? await this.upsertOrder(tx, input, contactContext, products)
        : null;
      const cartId = input.cart
        ? await this.upsertCart(tx, input, contactContext, products)
        : null;

      const integrationSyncData: Prisma.IntegrationUpdateInput =
        input.raw?.source === 'initial_sync'
          ? { lastSyncedAt: new Date() }
          : { lastSyncedAt: new Date(), lastWebhookAt: new Date() };

      await tx.integration.update({
        where: { id: input.integrationId },
        data: integrationSyncData,
      });

      return {
        eventId: event.id,
        contactId: contactContext.contactId,
        commerceCustomerId: contactContext.commerceCustomerId,
        orderId,
        cartId,
      };
    });

    const shouldEmitRealtimeEvent = input.raw?.source !== 'initial_sync';
    if (shouldEmitRealtimeEvent && result.contactId) {
      this.events.emit('commerce.event', {
        workspaceId: input.workspaceId,
        contactId: result.contactId,
        eventType: input.eventType,
        triggerData: this.buildWorkflowTriggerData(input, result),
      });
    }

    return result;
  }

  private buildWorkflowTriggerData(
    input: RecordCommerceEventInput,
    result: {
      commerceCustomerId: string | null;
      orderId: string | null;
      cartId: string | null;
    },
  ) {
    const order = input.order ?? null;
    const cart = input.cart ?? null;
    const customer = input.customer ?? null;
    const currency = order?.currency ?? cart?.currency ?? customer?.currency ?? null;

    return {
      eventType: input.eventType,
      provider: input.provider,
      integrationId: input.integrationId,
      integrationResourceId: input.integrationResourceId ?? null,
      externalEventId: input.externalEventId ?? null,
      commerceCustomerId: result.commerceCustomerId,
      orderId: result.orderId,
      cartId: result.cartId,
      orderNumber: order?.orderNumber ?? null,
      orderStatus: order?.status ?? null,
      financialStatus: order?.financialStatus ?? null,
      fulfillmentStatus: order?.fulfillmentStatus ?? null,
      orderTotalAmount: order?.totalAmount ?? null,
      orderPlacedAt: order?.placedAt ?? null,
      orderPaidAt: order?.paidAt ?? null,
      cartStatus: cart?.status ?? null,
      cartTotalAmount: cart?.totalAmount ?? null,
      cartItemCount: cart?.itemCount ?? null,
      cartAbandonedAt: cart?.abandonedAt ?? null,
      checkoutUrl: cart?.checkoutUrl ?? null,
      currency,
      totalAmount: order?.totalAmount ?? cart?.totalAmount ?? null,
      customerEmail: customer?.email ?? order?.email ?? cart?.email ?? null,
      customerPhone: customer?.phone ?? order?.phone ?? cart?.phone ?? null,
      order,
      cart,
      customer,
    };
  }

  async syncProducts(input: SyncCommerceProductsInput) {
    if (input.products.length === 0) {
      return { productCount: 0 };
    }

    const integration = await this.prisma.integration.findFirst({
      where: {
        id: input.integrationId,
        workspaceId: input.workspaceId,
        status: { not: 'disconnected' },
      },
      select: { id: true },
    });

    if (!integration) {
      throw new NotFoundException('Integration not found');
    }

    const productCount = await this.prisma.$transaction(async (tx) => {
      const products = await this.upsertProducts(tx, {
        workspaceId: input.workspaceId,
        integrationId: input.integrationId,
        integrationResourceId: input.integrationResourceId ?? null,
        provider: input.provider,
        eventType: 'commerce.customer_updated',
        products: input.products,
        raw: { source: 'sync_products' },
      });

      await tx.integration.update({
        where: { id: input.integrationId },
        data: { lastSyncedAt: new Date() },
      });

      return products.size;
    });

    return { productCount };
  }

  async getContactCommerceContext(workspaceId: string, contactId: string) {
    const [customers, orders, carts] = await Promise.all([
      this.prisma.commerceCustomer.findMany({
        where: { workspaceId, contactId },
        orderBy: [{ lastSeenAt: 'desc' }, { updatedAt: 'desc' }],
        take: 5,
        select: {
          id: true,
          provider: true,
          externalCustomerId: true,
          email: true,
          phone: true,
          status: true,
          totalOrders: true,
          totalSpentAmount: true,
          currency: true,
          lastSeenAt: true,
        },
      }),
      this.prisma.commerceOrder.findMany({
        where: { workspaceId, contactId },
        orderBy: [{ placedAt: 'desc' }, { createdAt: 'desc' }],
        take: 10,
        include: {
          lineItems: {
            take: 5,
            orderBy: { createdAt: 'asc' },
            select: {
              id: true,
              title: true,
              sku: true,
              quantity: true,
              totalAmount: true,
            },
          },
        },
      }),
      this.prisma.commerceCart.findMany({
        where: { workspaceId, contactId },
        orderBy: [{ abandonedAt: 'desc' }, { updatedAt: 'desc' }],
        take: 5,
        include: {
          lineItems: {
            take: 5,
            orderBy: { createdAt: 'asc' },
            select: {
              id: true,
              title: true,
              sku: true,
              quantity: true,
              totalAmount: true,
            },
          },
        },
      }),
    ]);

    return { customers, orders, carts };
  }

  private async createIntegrationEvent(
    tx: Prisma.TransactionClient,
    input: RecordCommerceEventInput,
  ) {
    const idempotencyKey =
      input.idempotencyKey ??
      this.hash(
        [
          input.integrationId,
          input.eventType,
          input.externalEventId,
          input.order?.externalOrderId,
          input.cart?.externalCartId,
          input.customer?.externalCustomerId,
        ]
          .filter(Boolean)
          .join(':'),
      );

    const eventData = {
      resourceId: input.integrationResourceId ?? null,
      provider: input.provider,
      eventType: input.eventType,
      externalEventId: input.externalEventId ?? null,
      status: 'projected',
      occurredAt: this.toDate(input.occurredAt),
      processedAt: new Date(),
      payload: this.toInputJson(input.raw ?? {}),
    };

    return tx.integrationEvent.upsert({
      where: {
        integrationId_idempotencyKey: {
          integrationId: input.integrationId,
          idempotencyKey,
        },
      },
      update: eventData,
      create: {
        workspaceId: input.workspaceId,
        integrationId: input.integrationId,
        idempotencyKey,
        ...eventData,
      },
    });
  }

  private async upsertProducts(
    tx: Prisma.TransactionClient,
    input: RecordCommerceEventInput,
  ) {
    const productInputs = [
      ...(input.products ?? []),
      ...(input.order?.lineItems ?? []).map((item) => this.lineItemToProductInput(item)),
      ...(input.cart?.lineItems ?? []).map((item) => this.lineItemToProductInput(item)),
    ].filter((product): product is CommerceProductInput => !!product);

    const products = new Map<string, string>();
    for (const product of productInputs) {
      const externalKey = this.productExternalKey(product);
      const row = await tx.commerceProduct.upsert({
        where: {
          integrationId_externalKey: {
            integrationId: input.integrationId,
            externalKey,
          },
        },
        update: {
          title: product.title,
          sku: this.emptyToNull(product.sku),
          handle: this.emptyToNull(product.handle),
          productType: this.emptyToNull(product.productType),
          vendor: this.emptyToNull(product.vendor),
          status: product.status ?? 'active',
          imageUrl: this.emptyToNull(product.imageUrl),
          priceAmount: product.priceAmount ?? null,
          currency: this.emptyToNull(product.currency),
          inventoryQuantity: product.inventoryQuantity ?? null,
          metadata: this.toInputJson(product.metadata ?? {}),
        },
        create: {
          workspaceId: input.workspaceId,
          integrationId: input.integrationId,
          integrationResourceId: input.integrationResourceId ?? null,
          provider: input.provider,
          externalKey,
          externalProductId: product.externalProductId,
          externalVariantId: this.emptyToNull(product.externalVariantId),
          title: product.title,
          sku: this.emptyToNull(product.sku),
          handle: this.emptyToNull(product.handle),
          productType: this.emptyToNull(product.productType),
          vendor: this.emptyToNull(product.vendor),
          status: product.status ?? 'active',
          imageUrl: this.emptyToNull(product.imageUrl),
          priceAmount: product.priceAmount ?? null,
          currency: this.emptyToNull(product.currency),
          inventoryQuantity: product.inventoryQuantity ?? null,
          metadata: this.toInputJson(product.metadata ?? {}),
        },
      });
      products.set(externalKey, row.id);
    }
    return products;
  }

  private async resolveCommerceContact(
    tx: Prisma.TransactionClient,
    input: RecordCommerceEventInput,
  ): Promise<CommerceContactContext> {
    const customer = this.customerFromInput(input);
    if (!customer) {
      return { contactId: null, commerceCustomerId: null };
    }

    const normalizedPhone = this.normalizePhone(customer.phone);
    const email = this.emptyToNull(customer.email)?.toLowerCase() ?? null;

    const existingIdentity = await tx.contactIntegration.findUnique({
      where: {
        integrationId_externalId: {
          integrationId: input.integrationId,
          externalId: customer.externalCustomerId,
        },
      },
      select: { id: true, contactId: true },
    });

    let contactId = existingIdentity?.contactId ?? null;

    if (!contactId) {
      const contact = await tx.contact.findFirst({
        where: {
          workspaceId: input.workspaceId,
          mergedIntoContactId: null,
          OR: [
            ...(email ? [{ email }] : []),
            ...(normalizedPhone ? [{ phone: normalizedPhone }] : []),
          ],
        },
        select: { id: true },
      });
      contactId = contact?.id ?? null;
    }

    if (!contactId) {
      const created = await tx.contact.create({
        data: {
          workspaceId: input.workspaceId,
          firstName: this.contactFirstName(customer),
          lastName: this.emptyToNull(customer.lastName),
          email,
          phone: normalizedPhone,
          company: this.emptyToNull(customer.company),
          marketingOptOut: customer.marketingOptIn === false,
        },
        select: { id: true },
      });
      contactId = created.id;
    }

    const contactIntegration = await tx.contactIntegration.upsert({
      where: {
        integrationId_externalId: {
          integrationId: input.integrationId,
          externalId: customer.externalCustomerId,
        },
      },
      update: {
        workspaceId: input.workspaceId,
        contactId,
        resourceId: input.integrationResourceId ?? null,
        provider: input.provider,
        email,
        phone: normalizedPhone,
        profile: this.toInputJson(customer.metadata ?? {}),
        lastSeenAt: this.toDate(customer.lastSeenAt) ?? new Date(),
      },
      create: {
        workspaceId: input.workspaceId,
        contactId,
        integrationId: input.integrationId,
        resourceId: input.integrationResourceId ?? null,
        provider: input.provider,
        externalId: customer.externalCustomerId,
        role: 'customer',
        email,
        phone: normalizedPhone,
        profile: this.toInputJson(customer.metadata ?? {}),
        lastSeenAt: this.toDate(customer.lastSeenAt) ?? new Date(),
      },
      select: { id: true },
    });

    const commerceCustomer = await tx.commerceCustomer.upsert({
      where: {
        integrationId_externalCustomerId: {
          integrationId: input.integrationId,
          externalCustomerId: customer.externalCustomerId,
        },
      },
      update: {
        integrationResourceId: input.integrationResourceId ?? null,
        contactId,
        contactIntegrationId: contactIntegration.id,
        provider: input.provider,
        email,
        phone: normalizedPhone,
        firstName: this.emptyToNull(customer.firstName),
        lastName: this.emptyToNull(customer.lastName),
        company: this.emptyToNull(customer.company),
        status: customer.status ?? 'active',
        marketingOptIn: customer.marketingOptIn ?? null,
        totalOrders: customer.totalOrders ?? 0,
        totalSpentAmount: customer.totalSpentAmount ?? null,
        currency: this.emptyToNull(customer.currency),
        firstSeenAt: this.toDate(customer.firstSeenAt),
        lastSeenAt: this.toDate(customer.lastSeenAt) ?? new Date(),
        metadata: this.toInputJson(customer.metadata ?? {}),
      },
      create: {
        workspaceId: input.workspaceId,
        integrationId: input.integrationId,
        integrationResourceId: input.integrationResourceId ?? null,
        contactId,
        contactIntegrationId: contactIntegration.id,
        provider: input.provider,
        externalCustomerId: customer.externalCustomerId,
        email,
        phone: normalizedPhone,
        firstName: this.emptyToNull(customer.firstName),
        lastName: this.emptyToNull(customer.lastName),
        company: this.emptyToNull(customer.company),
        status: customer.status ?? 'active',
        marketingOptIn: customer.marketingOptIn ?? null,
        totalOrders: customer.totalOrders ?? 0,
        totalSpentAmount: customer.totalSpentAmount ?? null,
        currency: this.emptyToNull(customer.currency),
        firstSeenAt: this.toDate(customer.firstSeenAt),
        lastSeenAt: this.toDate(customer.lastSeenAt) ?? new Date(),
        metadata: this.toInputJson(customer.metadata ?? {}),
      },
      select: { id: true },
    });

    return { contactId, commerceCustomerId: commerceCustomer.id };
  }

  private async upsertOrder(
    tx: Prisma.TransactionClient,
    input: RecordCommerceEventInput,
    contactContext: CommerceContactContext,
    products: Map<string, string>,
  ) {
    if (!input.order) return null;
    const order = input.order;
    const row = await tx.commerceOrder.upsert({
      where: {
        integrationId_externalOrderId: {
          integrationId: input.integrationId,
          externalOrderId: order.externalOrderId,
        },
      },
      update: {
        integrationResourceId: input.integrationResourceId ?? null,
        contactId: contactContext.contactId,
        commerceCustomerId: contactContext.commerceCustomerId,
        provider: input.provider,
        orderNumber: this.emptyToNull(order.orderNumber),
        status: order.status ?? this.statusFromEvent(input.eventType, 'created'),
        financialStatus: this.emptyToNull(order.financialStatus),
        fulfillmentStatus: this.emptyToNull(order.fulfillmentStatus),
        currency: this.emptyToNull(order.currency),
        subtotalAmount: order.subtotalAmount ?? null,
        discountAmount: order.discountAmount ?? null,
        taxAmount: order.taxAmount ?? null,
        shippingAmount: order.shippingAmount ?? null,
        totalAmount: order.totalAmount ?? null,
        email: this.emptyToNull(order.email)?.toLowerCase() ?? null,
        phone: this.normalizePhone(order.phone),
        placedAt: this.toDate(order.placedAt),
        paidAt: this.toDate(order.paidAt),
        fulfilledAt: this.toDate(order.fulfilledAt),
        cancelledAt: this.toDate(order.cancelledAt),
        metadata: this.toInputJson(order.metadata ?? {}),
      },
      create: {
        workspaceId: input.workspaceId,
        integrationId: input.integrationId,
        integrationResourceId: input.integrationResourceId ?? null,
        contactId: contactContext.contactId,
        commerceCustomerId: contactContext.commerceCustomerId,
        provider: input.provider,
        externalOrderId: order.externalOrderId,
        orderNumber: this.emptyToNull(order.orderNumber),
        status: order.status ?? this.statusFromEvent(input.eventType, 'created'),
        financialStatus: this.emptyToNull(order.financialStatus),
        fulfillmentStatus: this.emptyToNull(order.fulfillmentStatus),
        currency: this.emptyToNull(order.currency),
        subtotalAmount: order.subtotalAmount ?? null,
        discountAmount: order.discountAmount ?? null,
        taxAmount: order.taxAmount ?? null,
        shippingAmount: order.shippingAmount ?? null,
        totalAmount: order.totalAmount ?? null,
        email: this.emptyToNull(order.email)?.toLowerCase() ?? null,
        phone: this.normalizePhone(order.phone),
        placedAt: this.toDate(order.placedAt),
        paidAt: this.toDate(order.paidAt),
        fulfilledAt: this.toDate(order.fulfilledAt),
        cancelledAt: this.toDate(order.cancelledAt),
        metadata: this.toInputJson(order.metadata ?? {}),
      },
    });

    await tx.commerceOrderLineItem.deleteMany({ where: { orderId: row.id } });
    const lineItems = (order.lineItems ?? []).map((item) => ({
      workspaceId: input.workspaceId,
      orderId: row.id,
      productId: this.productIdForLineItem(item, products),
      externalLineItemId: this.emptyToNull(item.externalLineItemId),
      externalProductId: this.emptyToNull(item.externalProductId),
      externalVariantId: this.emptyToNull(item.externalVariantId),
      sku: this.emptyToNull(item.sku),
      title: item.title,
      quantity: item.quantity ?? 1,
      unitPriceAmount: item.unitPriceAmount ?? null,
      totalAmount: item.totalAmount ?? null,
      metadata: this.toInputJson(item.metadata ?? {}),
    }));
    if (lineItems.length) {
      await tx.commerceOrderLineItem.createMany({ data: lineItems });
    }
    return row.id;
  }

  private async upsertCart(
    tx: Prisma.TransactionClient,
    input: RecordCommerceEventInput,
    contactContext: CommerceContactContext,
    products: Map<string, string>,
  ) {
    if (!input.cart) return null;
    const cart = input.cart;
    const row = await tx.commerceCart.upsert({
      where: {
        integrationId_externalCartId: {
          integrationId: input.integrationId,
          externalCartId: cart.externalCartId,
        },
      },
      update: {
        integrationResourceId: input.integrationResourceId ?? null,
        contactId: contactContext.contactId,
        commerceCustomerId: contactContext.commerceCustomerId,
        provider: input.provider,
        externalCheckoutId: this.emptyToNull(cart.externalCheckoutId),
        status: cart.status ?? this.statusFromEvent(input.eventType, 'active'),
        currency: this.emptyToNull(cart.currency),
        subtotalAmount: cart.subtotalAmount ?? null,
        totalAmount: cart.totalAmount ?? null,
        itemCount: cart.itemCount ?? cart.lineItems?.length ?? 0,
        checkoutUrl: this.emptyToNull(cart.checkoutUrl),
        email: this.emptyToNull(cart.email)?.toLowerCase() ?? null,
        phone: this.normalizePhone(cart.phone),
        providerCreatedAt: this.toDate(cart.providerCreatedAt),
        providerUpdatedAt: this.toDate(cart.providerUpdatedAt),
        abandonedAt: this.toDate(cart.abandonedAt),
        recoveredAt: this.toDate(cart.recoveredAt),
        expiresAt: this.toDate(cart.expiresAt),
        metadata: this.toInputJson(cart.metadata ?? {}),
      },
      create: {
        workspaceId: input.workspaceId,
        integrationId: input.integrationId,
        integrationResourceId: input.integrationResourceId ?? null,
        contactId: contactContext.contactId,
        commerceCustomerId: contactContext.commerceCustomerId,
        provider: input.provider,
        externalCartId: cart.externalCartId,
        externalCheckoutId: this.emptyToNull(cart.externalCheckoutId),
        status: cart.status ?? this.statusFromEvent(input.eventType, 'active'),
        currency: this.emptyToNull(cart.currency),
        subtotalAmount: cart.subtotalAmount ?? null,
        totalAmount: cart.totalAmount ?? null,
        itemCount: cart.itemCount ?? cart.lineItems?.length ?? 0,
        checkoutUrl: this.emptyToNull(cart.checkoutUrl),
        email: this.emptyToNull(cart.email)?.toLowerCase() ?? null,
        phone: this.normalizePhone(cart.phone),
        providerCreatedAt: this.toDate(cart.providerCreatedAt),
        providerUpdatedAt: this.toDate(cart.providerUpdatedAt),
        abandonedAt: this.toDate(cart.abandonedAt),
        recoveredAt: this.toDate(cart.recoveredAt),
        expiresAt: this.toDate(cart.expiresAt),
        metadata: this.toInputJson(cart.metadata ?? {}),
      },
    });

    await tx.commerceCartLineItem.deleteMany({ where: { cartId: row.id } });
    const lineItems = (cart.lineItems ?? []).map((item) => ({
      workspaceId: input.workspaceId,
      cartId: row.id,
      productId: this.productIdForLineItem(item, products),
      externalLineItemId: this.emptyToNull(item.externalLineItemId),
      externalProductId: this.emptyToNull(item.externalProductId),
      externalVariantId: this.emptyToNull(item.externalVariantId),
      sku: this.emptyToNull(item.sku),
      title: item.title,
      quantity: item.quantity ?? 1,
      unitPriceAmount: item.unitPriceAmount ?? null,
      totalAmount: item.totalAmount ?? null,
      metadata: this.toInputJson(item.metadata ?? {}),
    }));
    if (lineItems.length) {
      await tx.commerceCartLineItem.createMany({ data: lineItems });
    }
    return row.id;
  }

  private customerFromInput(input: RecordCommerceEventInput): CommerceCustomerInput | null {
    if (input.customer) return input.customer;
    const email = input.order?.email ?? input.cart?.email ?? null;
    const phone = input.order?.phone ?? input.cart?.phone ?? null;
    if (!email && !phone) return null;
    return {
      externalCustomerId: email ?? phone ?? this.hash(`${input.integrationId}:${input.eventType}`),
      email,
      phone,
      firstName: null,
      lastName: null,
      metadata: {},
    };
  }

  private lineItemToProductInput(item: CommerceLineItemInput): CommerceProductInput | null {
    if (!item.externalProductId) return null;
    return {
      externalProductId: item.externalProductId,
      externalVariantId: item.externalVariantId ?? null,
      title: item.title,
      sku: item.sku ?? null,
      priceAmount: item.unitPriceAmount ?? null,
      metadata: item.metadata ?? {},
    };
  }

  private productIdForLineItem(item: CommerceLineItemInput, products: Map<string, string>) {
    if (!item.externalProductId) return null;
    return products.get(this.productExternalKey({
      externalProductId: item.externalProductId,
      externalVariantId: item.externalVariantId ?? null,
    })) ?? null;
  }

  private productExternalKey(product: Pick<CommerceProductInput, 'externalProductId' | 'externalVariantId' | 'externalKey'>) {
    return product.externalKey ?? [product.externalProductId, product.externalVariantId].filter(Boolean).join(':');
  }

  private statusFromEvent(eventType: CommerceEventType, fallback: string) {
    switch (eventType) {
      case 'commerce.order_paid':
        return 'paid';
      case 'commerce.order_fulfilled':
        return 'fulfilled';
      case 'commerce.order_cancelled':
        return 'cancelled';
      case 'commerce.cart_abandoned':
        return 'abandoned';
      default:
        return fallback;
    }
  }

  private contactFirstName(customer: CommerceCustomerInput) {
    return (
      this.emptyToNull(customer.firstName) ??
      this.emptyToNull(customer.email)?.split('@')[0] ??
      this.emptyToNull(customer.phone) ??
      'Commerce Customer'
    );
  }

  private normalizePhone(value?: string | null) {
    const normalized = this.emptyToNull(value);
    return normalized ? normalizePhoneIdentifier(normalized) ?? normalized : null;
  }

  private emptyToNull(value?: string | null) {
    const normalized = value?.trim();
    return normalized ? normalized : null;
  }

  private toDate(value?: Date | string | null) {
    if (!value) return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  private toInputJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? {})) as Prisma.InputJsonValue;
  }

  private hash(value: string) {
    return createHash('sha256').update(value).digest('hex');
  }

}
