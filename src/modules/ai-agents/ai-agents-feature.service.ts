import { Injectable } from '@nestjs/common';
import { aiAgentsDebug } from './ai-agents-debug.logger';

@Injectable()
export class AiAgentsFeatureService {
  isEnabled() {
    const value = String(
      process.env.AI_AGENTS_ENABLED ??
        process.env.FEATURE_AI_AGENTS_ENABLED ??
        'true',
    ).toLowerCase();

    const enabled = !['0', 'false', 'off', 'disabled', 'no'].includes(value);
    aiAgentsDebug.log('feature', 'AI Agents feature flag evaluated', {
      enabled,
      rawValue: value,
      debug: aiAgentsDebug.enabled(),
      verbose: aiAgentsDebug.verbose(),
    });
    return enabled;
  }
}
