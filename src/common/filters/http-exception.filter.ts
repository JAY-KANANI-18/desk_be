import {
    ExceptionFilter,
    Catch,
    ArgumentsHost,
    HttpException,
} from '@nestjs/common';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
    catch(exception: any, host: ArgumentsHost) {
        
        console.dir({ exception:exception },{ depth: null });
        const ctx = host.switchToHttp();
        const response = ctx.getResponse();

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
                : exception.name || 'SERVER_ERROR';

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
