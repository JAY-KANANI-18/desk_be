import { Controller, Get, NotFoundException } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { AppService } from './app.service';
import { Public } from './common/auth/route-access.decorator';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): string {
    console.log("heloooooo");
    
    return this.appService.getHello();
  }

  @Public()
  @Get('debug-sentry')
  getSentryError(): never {
    if (process.env.SENTRY_DEBUG_ENDPOINT_ENABLED !== 'true') {
      throw new NotFoundException();
    }

    Sentry.logger.info('User triggered test error', {
      action: 'test_error_endpoint',
    });
    Sentry.metrics.count('test_counter', 1);

    throw new Error('My first Sentry error!');
  }
}
