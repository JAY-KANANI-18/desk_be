export type IntegrationProviderKey =
  | 'meta_ads'
  | 'tiktok_ads'
  | 'shopify'
  | 'woocommerce'
  | 'bigcommerce'
  | 'magento'
  | 'stripe'
  | 'razorpay'
  | 'google_sheets'
  | 'hubspot'
  | 'salesforce';

export type IntegrationCategory =
  | 'Advertising'
  | 'Commerce'
  | 'Payments'
  | 'Productivity'
  | 'CRM';

export type IntegrationConnectMode = 'oauth_popup' | 'oauth_redirect' | 'api_key' | 'coming_soon';

export type IntegrationAvailability = 'available' | 'planned';

export interface IntegrationProviderCatalogEntry {
  id: IntegrationProviderKey;
  name: string;
  desc: string;
  icon: string;
  category: IntegrationCategory;
  providerCategory: string;
  availability: IntegrationAvailability;
  connectMode: IntegrationConnectMode;
  authType: 'oauth' | 'api_key' | 'webhook' | 'private_app';
  capabilities: string[];
  plannedDomains: string[];
}

export const INTEGRATION_PROVIDER_CATALOG: IntegrationProviderCatalogEntry[] = [
  {
    id: 'meta_ads',
    name: 'Meta Ads',
    desc: 'Capture ad leads and click events, enrich contacts, and trigger workflows from Meta campaigns.',
    icon: 'MA',
    category: 'Advertising',
    providerCategory: 'ads',
    availability: 'available',
    connectMode: 'oauth_popup',
    authType: 'oauth',
    capabilities: ['lead_capture', 'campaign_health', 'workflow_trigger', 'contact_enrichment'],
    plannedDomains: ['ads', 'automation'],
  },
  {
    id: 'tiktok_ads',
    name: 'TikTok Ads',
    desc: 'Sync lead forms, campaigns, and paid social audiences into AxoDesk automation.',
    icon: 'TT',
    category: 'Advertising',
    providerCategory: 'ads',
    availability: 'planned',
    connectMode: 'coming_soon',
    authType: 'oauth',
    capabilities: ['lead_capture', 'campaign_health', 'workflow_trigger'],
    plannedDomains: ['ads', 'automation'],
  },
  {
    id: 'shopify',
    name: 'Shopify',
    desc: 'Use customers, orders, products, and abandoned carts for support context and broadcasts.',
    icon: 'SH',
    category: 'Commerce',
    providerCategory: 'commerce',
    availability: 'available',
    connectMode: 'oauth_popup',
    authType: 'oauth',
    capabilities: ['customers', 'orders', 'carts', 'products', 'broadcast_audience', 'workflow_trigger'],
    plannedDomains: ['commerce', 'automation'],
  },
  {
    id: 'woocommerce',
    name: 'WooCommerce',
    desc: 'Bring WooCommerce customers, orders, and carts into normalized commerce workflows.',
    icon: 'WC',
    category: 'Commerce',
    providerCategory: 'commerce',
    availability: 'planned',
    connectMode: 'coming_soon',
    authType: 'api_key',
    capabilities: ['customers', 'orders', 'carts', 'products', 'broadcast_audience'],
    plannedDomains: ['commerce'],
  },
  {
    id: 'bigcommerce',
    name: 'BigCommerce',
    desc: 'Connect store customers, carts, products, and order lifecycle events.',
    icon: 'BC',
    category: 'Commerce',
    providerCategory: 'commerce',
    availability: 'planned',
    connectMode: 'coming_soon',
    authType: 'oauth',
    capabilities: ['customers', 'orders', 'carts', 'products'],
    plannedDomains: ['commerce'],
  },
  {
    id: 'magento',
    name: 'Magento',
    desc: 'Sync enterprise commerce customers, carts, and orders from Adobe Commerce.',
    icon: 'MG',
    category: 'Commerce',
    providerCategory: 'commerce',
    availability: 'planned',
    connectMode: 'coming_soon',
    authType: 'api_key',
    capabilities: ['customers', 'orders', 'carts', 'products'],
    plannedDomains: ['commerce'],
  },
  {
    id: 'stripe',
    name: 'Stripe',
    desc: 'Create customer payment links and react to payment status changes.',
    icon: 'ST',
    category: 'Payments',
    providerCategory: 'payments',
    availability: 'planned',
    connectMode: 'coming_soon',
    authType: 'oauth',
    capabilities: ['payment_links', 'payments', 'refunds', 'workflow_trigger'],
    plannedDomains: ['payments'],
  },
  {
    id: 'razorpay',
    name: 'Razorpay',
    desc: 'Generate customer payment links and track Indian payment gateway events.',
    icon: 'RZ',
    category: 'Payments',
    providerCategory: 'payments',
    availability: 'planned',
    connectMode: 'coming_soon',
    authType: 'api_key',
    capabilities: ['payment_links', 'payments', 'refunds', 'workflow_trigger'],
    plannedDomains: ['payments'],
  },
  {
    id: 'google_sheets',
    name: 'Google Sheets',
    desc: 'Export, sync, and automate workspace data with spreadsheets.',
    icon: 'GS',
    category: 'Productivity',
    providerCategory: 'productivity',
    availability: 'planned',
    connectMode: 'coming_soon',
    authType: 'oauth',
    capabilities: ['export', 'row_sync', 'workflow_action'],
    plannedDomains: ['productivity', 'automation'],
  },
  {
    id: 'hubspot',
    name: 'HubSpot',
    desc: 'Sync CRM contacts, companies, deals, lifecycle stages, and owner context.',
    icon: 'HS',
    category: 'CRM',
    providerCategory: 'crm',
    availability: 'planned',
    connectMode: 'coming_soon',
    authType: 'oauth',
    capabilities: ['contacts', 'companies', 'deals', 'workflow_trigger'],
    plannedDomains: ['crm'],
  },
  {
    id: 'salesforce',
    name: 'Salesforce',
    desc: 'Connect enterprise CRM leads, contacts, accounts, opportunities, and tasks.',
    icon: 'SF',
    category: 'CRM',
    providerCategory: 'crm',
    availability: 'planned',
    connectMode: 'coming_soon',
    authType: 'oauth',
    capabilities: ['leads', 'contacts', 'accounts', 'opportunities', 'workflow_trigger'],
    plannedDomains: ['crm'],
  },
];
