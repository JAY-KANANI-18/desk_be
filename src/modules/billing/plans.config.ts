import { PlanDefinition } from './types/billing.types';

export const PLANS: Record<string, PlanDefinition> = {
  trial: {
    name: 'Trial',
    isTrial: true,
    trialDays: 14,
    priceMonthly: 0,
    monthlyAmount: 0,
      limits: { agents: 100, contacts: 1000 },

    features: {
      analytics: true,
      workflows: false,
      broadcasts: false,
      sla: false,
      apiAccess: false,
      customRoles: false,
    },
  },

  starter: {
    name: 'Starter',
    priceMonthly: 999,
    monthlyAmount: 999,
    stripePriceId: process.env.STRIPE_PRICE_STARTER,
    razorpayPlanId: process.env.STRIPE_PRICE_STARTER,
    limits: {
      agents: 2,
      contacts: 1000,
    },
     addons: {
      extraAgent:    { pricePerUnit: 29900, label: '₹299/extra agent/mo' },   // paise
      extraContacts: { pricePerSlab: 14900, slabSize: 1000, label: '₹149 per 1,000 contacts/mo' },
    },
    features: {
      analytics: true,
      workflows: false,
      broadcasts: false,
      sla: false,
      apiAccess: false,
      customRoles: false,
    },
  },

  growth: {
    name: 'Growth',
    priceMonthly: 2999,
    monthlyAmount: 2999,
    stripePriceId: process.env.STRIPE_PRICE_GROWTH,
    razorpayPlanId: process.env.STRIPE_PRICE_GROWTH,
    limits: {
      agents: 5,
  
      contacts: 10000,
    },
    
     addons: {
      extraAgent:    { pricePerUnit: 24900, label: '₹249/extra agent/mo' },
      extraContacts: { pricePerSlab: 9900, slabSize: 1000, label: '₹99 per 1,000 contacts/mo' },
        },
    features: {
      analytics: true,
      workflows: true,
      broadcasts: true,
      sla: true,
      apiAccess: true,
      customRoles: true,
    },
  },

  pro: {
    name: 'Pro',
    priceMonthly: 9999,
    monthlyAmount: 9999,
    stripePriceId: process.env.STRIPE_PRICE_PRO,
    razorpayPlanId: process.env.STRIPE_PRICE_PRO,
    limits: {
      agents: 999999,
    
      contacts: 100000,
    },
     addons: {
      extraAgent:    null,          // unlimited agents, no extra charge
      extraContacts: { pricePerSlab: 4900, slabSize: 1000, label: '₹49 per 1,000 contacts/mo' },
    },
    features: {
      analytics: true,
      workflows: true,
      broadcasts: true,
      sla: true,
      apiAccess: true,
      customRoles: true,
    },
  },
};

// {
//     "product": {
//         "planName": "Growth",
//         "version": 3,
//         "isSelfService": true,
//         "interval": "month",
//         "intervalCount": 1,
//         "price": {
//             "usd": {
//                 "priceId": "price_1PJSrKAKth9zjIhrzfVWfCMg",
//                 "billingScheme": "perUnit",
//                 "cost": 19900,
//                 "overchargeCost": 1200
//             }
//         },
//         "meta": {
//             "id": 388795,
//             "status": "trial",
//             "domainId": null,
//             "stripeId": "cus_UFVVD7rIRn5Uz7",
//             "invoicesStatus": "paid",
//             "domain": null,
//             "domainConfig": null,
//             "creatorId": 1057936,
//             "creatorEmail": "vappaugregroma-5490@yopmail.com",
//             "name": "gidora",
//             "allowViewImpersonate": 0,
//             "creatorFullName": "Vappaugregroma Kalano",
//             "macLimit": 1000,
//             "userLimit": 10,
//             "api": null,
//             "broadcastMessagesLimit": 0,
//             "contactLimit": 100000,
//             "respondAI": 1000,
//             "respondAIBuilderRateLimit": 60,
//             "respondAICharacter": 50000,
//             "ksSizeLimit": 1,
//             "webhook": 0,
//             "workflowLimit": null,
//             "workflowsInvocation": 300,
//             "workspaceLimit": 1,
//             "broadcastSendRate": true,
//             "customChannel": false,
//             "dataExport": true,
//             "dialogflow": true,
//             "googleSheets": true,
//             "httpRequest": false,
//             "incomingWebhook": false,
//             "isWhiteLabel": false,
//             "isWorkflowsEnabled": true,
//             "make": true,
//             "n8n": true,
//             "isAiAgentEnabled": true,
//             "phoneEmailMasking": false,
//             "reports": true,
//             "respondVoiceAiAgent": false,
//             "shortcut": true,
//             "singleSignOn": false,
//             "workspaceManagement": false,
//             "callsRecording": true,
//             "callsTranscriptAndSummary": true,
//             "zapier": true,
//             "hubspot": true,
//             "salesforce": false,
//             "aiAgentHttpRequest": false,
//             "apiRateLimit": {
//                 "contact": 1,
//                 "conversation": 1,
//                 "messaging": 1,
//                 "comment": 1,
//                 "space": {
//                     "user": 1,
//                     "channel": 1,
//                     "closing_notes": 1,
//                     "contact_field": 1
//                 }
//             },
//             "mac": 1000,
//             "users": 10,
//             "contacts": 100000,
//             "broadcastMessages": 0,
//             "workflows": null,
//             "workspaces": 1,
//             "whiteLabel": false
//         }
//     },
//     "subscription": {
//         "priceId": "price_1PJSrKAKth9zjIhrzfVWfCMg",
//         "active": false,
//         "planName": "Growth",
//         "status": "trial",
//         "paymentStatus": "paid",
//         "currency": "usd",
//         "nextBillingDate": 1775561416,
//         "prevBillingDate": 1774956616,
//         "nextMacBillingDate": null,
//         "prevMacBillingDate": null,
//         "billingCycleId": null,
//         "trialEndDate": 1775561416,
//         "hideBanner": false,
//         "paymentTerm": 5,
//         "card": {
//             "card_brand": null,
//             "card_last_four": null
//         },
//         "eligibleForDiscount": true,
//         "inChurnDiscount": false,
//         "isTrialExtended": false,
//         "wabaChannelLimit": 5,
//         "whatsappCalls": 0,
//         "messengerCalls": 0
//     }
// }