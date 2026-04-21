import { Injectable } from '@nestjs/common';
import { aiAgentsDebug } from '../ai-agents-debug.logger';

export interface GuardrailInput {
  customerText?: string | null;
  draftedReply?: string | null;
  confidence?: number | null;
  autoReplyCount?: number;
  maxAutoReplies?: number;
  groundedKnowledgeCount?: number;
  guardrails?: Record<string, any>;
  contact?: Record<string, any> | null;
}

export interface GuardrailResult {
  allowed: boolean;
  handoffRequired: boolean;
  reasons: string[];
  redactions: Array<{ type: string; value: string }>;
}

@Injectable()
export class AgentGuardrailsService {
  validate(input: GuardrailInput): GuardrailResult {
    aiAgentsDebug.log('guardrails', 'validate start', input);
    const reasons: string[] = [];
    const redactions: Array<{ type: string; value: string }> = [];
    const customerText = input.customerText || '';
    const reply = input.draftedReply || '';
    const guardrails = input.guardrails || {};
    const confidenceThreshold = Number(guardrails.confidenceThreshold ?? 0.65);
    const maxAutoReplies = Number(input.maxAutoReplies ?? guardrails.maxAutoReplies ?? 5);

    if (this.hasPromptInjection(customerText)) {
      reasons.push('prompt_injection_detected');
    }

    if ((input.confidence ?? 1) < confidenceThreshold) {
      reasons.push('low_confidence');
    }

    if ((input.autoReplyCount || 0) >= maxAutoReplies) {
      reasons.push('max_auto_replies_reached');
    }

    if (this.customerRequestsHuman(customerText)) {
      reasons.push('customer_requested_human');
    }

    if (this.isRefundOrLegalTopic(customerText)) {
      reasons.push('refund_or_legal_topic');
    }

    if (this.isMedicalTopic(customerText)) {
      reasons.push('medical_topic');
    }

    if (this.hasAngrySentiment(customerText)) {
      reasons.push('angry_sentiment');
    }

    if (this.containsProfanity(reply) && guardrails.profanity !== 'allow') {
      reasons.push('profanity_in_reply');
    }

    if (this.containsUnverifiedPricing(reply) && !input.groundedKnowledgeCount) {
      reasons.push('unverified_pricing_claim');
    }

    for (const value of this.findSensitiveValues(reply)) {
      redactions.push(value);
    }

    const blockingReasons = new Set([
      'prompt_injection_detected',
      'profanity_in_reply',
      'unverified_pricing_claim',
    ]);

    const result = {
      allowed: reasons.every((reason) => !blockingReasons.has(reason)) && redactions.length === 0,
      handoffRequired: reasons.length > 0 || redactions.length > 0,
      reasons,
      redactions,
    };
    aiAgentsDebug.log('guardrails', 'validate result', {
      result,
      confidenceThreshold,
      maxAutoReplies,
      groundedKnowledgeCount: input.groundedKnowledgeCount,
    });
    return result;
  }

  sanitizeReply(reply: string, redactions: Array<{ value: string }>) {
    const result = redactions.reduce((text, item) => text.replace(item.value, '[redacted]'), reply);
    aiAgentsDebug.log('guardrails', 'sanitizeReply result', {
      originalReply: reply,
      redactionCount: redactions.length,
      result,
    });
    return result;
  }

  private hasPromptInjection(text: string) {
    return /ignore (all )?(previous|above|system)|developer message|system prompt|reveal.*prompt|forget instructions/i.test(text);
  }

  private customerRequestsHuman(text: string) {
    return /\b(human|agent|representative|manager|supervisor|real person|call me)\b/i.test(text);
  }

  private isRefundOrLegalTopic(text: string) {
    return /\b(refund|chargeback|lawsuit|lawyer|legal|police|court|sue|fraud|compliance)\b/i.test(text);
  }

  private isMedicalTopic(text: string) {
    return /\b(diagnosis|medical advice|prescription|dosage|symptom|treatment|doctor)\b/i.test(text);
  }

  private hasAngrySentiment(text: string) {
    return /\b(angry|furious|terrible|worst|scam|cheated|hate|useless)\b|!{3,}/i.test(text);
  }

  private containsProfanity(text: string) {
    return /\b(fuck|shit|bitch|asshole|bastard)\b/i.test(text);
  }

  private containsUnverifiedPricing(text: string) {
    return /(?:₹|\$|€|£)\s?\d+|\b\d+(?:\.\d+)?\s?(?:usd|inr|eur|gbp|dollars|rupees)\b/i.test(text);
  }

  private findSensitiveValues(text: string) {
    const findings: Array<{ type: string; value: string }> = [];
    const emailMatches = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
    const cardMatches = text.match(/\b(?:\d[ -]*?){13,16}\b/g) || [];

    for (const value of emailMatches) findings.push({ type: 'email', value });
    for (const value of cardMatches) findings.push({ type: 'payment_card', value });

    return findings;
  }
}
