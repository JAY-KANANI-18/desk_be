import { Controller, Get } from '@nestjs/common';
import { JwtOnly } from 'src/common/auth/route-access.decorator';
import { AiAgentsFeatureService } from './ai-agents-feature.service';

@Controller('api/features')
export class FeatureFlagsController {
  constructor(private readonly aiAgentsFeature: AiAgentsFeatureService) {}

  @Get()
  @JwtOnly()
  getFeatures() {
    return {
      aiAgents: this.aiAgentsFeature.isEnabled(),
    };
  }
}
