import 'dotenv/config';
import * as bodyParser from 'body-parser';
import * as cors from 'cors';
import * as helmet from 'helmet';

import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';

import { AppModule } from './app.module';

import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger:
      process.env.NODE_ENV === 'production'
        ? ['error', 'warn', 'log']   // no verbose/debug in prod
        : ['error', 'warn', 'log', 'verbose', 'debug'], // everything in dev
  });

  /**
   * Security headers
   */
  app.use(helmet.default());

  /**
   * CORS
   */
  const allowedOrigins = (process.env.AUTH_ALLOWED_ORIGINS ?? process.env.CORS_ORIGINS ?? 'http://localhost:5173')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(new Error('Origin not allowed by CORS'));
      },
      credentials: true,
    }),
  );

  /**
   * Request ID middleware
   */
  app.use(new RequestIdMiddleware().use);

  /**
   * Raw body for webhooks
   */
  app.use(
    bodyParser.json({
      verify: (req: any, res, buf) => {
        req.rawBody = buf;
      },
    }),
  );

   /**
   * Parse Mailgun form-data
   */
  app.use(bodyParser.urlencoded({ extended: true }));

  /**

  /**
   * Global Validation
   */
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  /**
   * Global Response Wrapper
   */
  app.useGlobalInterceptors(new ResponseInterceptor());

  /**
   * Global Error Handler
   */
  app.useGlobalFilters(new HttpExceptionFilter());
  app.enableShutdownHooks();

  await app.listen(process.env.PORT ?? 3000);
}

bootstrap();
