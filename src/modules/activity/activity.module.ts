// src/activity/activity.module.ts

import { Module } from '@nestjs/common';
import { ActivityService } from './activity.service';

@Module({
  providers: [ActivityService],
  exports:   [ActivityService],   // imported by ConversationModule, InboundModule, etc.
})
export class ActivityModule {}