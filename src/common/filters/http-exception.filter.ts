import {
    ExceptionFilter,
    Catch,
    Logger,
    ArgumentsHost,
    HttpException,
} from '@nestjs/common';
import { SentryExceptionCaptured } from '@sentry/nestjs';
import type { Response } from 'express';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
    private readonly logger = new Logger(HttpExceptionFilter.name);

    @SentryExceptionCaptured()
    catch(exception: unknown, host: ArgumentsHost): void {
        const ctx = host.switchToHttp();
                        console.dir({ exception:exception },{ depth: null });

        const response = ctx.getResponse<Response>();

        if (response.headersSent) {
            this.logger.error(
                'Unhandled exception after response was sent',
                exception instanceof Error ? exception.stack : String(exception),
            );
            return;
        }

        const status =
            exception instanceof HttpException ? exception.getStatus() : 500;

        const exceptionResponse =
            exception instanceof HttpException ? exception.getResponse() : null;
        const exceptionBody =
            exceptionResponse && typeof exceptionResponse === 'object'
                ? exceptionResponse as Record<string, unknown>
                : {};
        const rawMessage =
            exceptionBody.message ??
            (typeof exceptionResponse === 'string' ? exceptionResponse : null) ??
            (exception instanceof HttpException ? exception.message : null) ??
            'Internal Server Error';
        const message = Array.isArray(rawMessage) ? rawMessage.join(', ') : String(rawMessage);
        const code =
            typeof exceptionBody.code === 'string' && exceptionBody.code.trim()
                ? exceptionBody.code
                : exception instanceof Error && exception.name ? exception.name : 'SERVER_ERROR';

        response.status(status).json({
            success: false,
            data: null,
            meta: {
                timestamp: new Date().toISOString(),
            },
            error: {
                ...exceptionBody,
                code,
                message,
            },
        });
    }
}
