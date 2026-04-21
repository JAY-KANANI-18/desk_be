import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import { aiAgentsDebug } from './ai-agents-debug.logger';
import { AiAgentsFeatureService } from './ai-agents-feature.service';

@Injectable()
export class AiAgentsFeatureGuard implements CanActivate {
  constructor(private readonly feature: AiAgentsFeatureService) {}

  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest();
    aiAgentsDebug.log('feature.guard', 'checking AI Agents route access', {
      method: req?.method,
      url: req?.url,
      workspaceId: req?.workspaceId,
      userId: req?.user?.id,
    });
    if (!this.feature.isEnabled()) {
      aiAgentsDebug.warn('feature.guard', 'blocking AI Agents route because feature is disabled', {
        method: req?.method,
        url: req?.url,
        workspaceId: req?.workspaceId,
        userId: req?.user?.id,
      });
      throw new NotFoundException('AI Agents are not enabled for this deployment');
    }

    aiAgentsDebug.log('feature.guard', 'AI Agents route allowed', {
      method: req?.method,
      url: req?.url,
      workspaceId: req?.workspaceId,
      userId: req?.user?.id,
    });
    return true;
  }
}
