export type BillingProvider = 'razorpay' | 'stripe';

export type SubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'cancelled'
  | 'expired'
  | 'paused'
  | 'unpaid';

export type BillingMetric =
  | 'contacts'
  | 'agents'

export type BillingFeature =
  | 'analytics'
  | 'workflows'
  | 'broadcasts'
  | 'sla'
  | 'apiAccess'
  | 'customRoles';

export interface PlanDefinition {
  name: string;
  isTrial?: boolean;
  trialDays?: number;
  priceMonthly: number;
  monthlyAmount: number;
  stripePriceId?: string;
  razorpayPlanId?: string;
  limits: Record<BillingMetric, number>;
  features: Record<BillingFeature, boolean>;
    addons?: {
        extraAgent?: { pricePerUnit: number; label: string } | null;   // null means unlimited agents with no extra charge
        extraContacts?: { pricePerSlab: number; slabSize: number; label: string } | null; // null means unlimited contacts with no extra charge
    };
}