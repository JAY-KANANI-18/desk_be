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

        const message =
            exception instanceof HttpException
                ? exception.message
                : 'Internal Server Error';

        response.status(status).json({
            success: false,
            data: null,
            meta: {
                timestamp: new Date().toISOString(),
            },
            error: {
                code: exception.name || 'SERVER_ERROR',
                message,
            },
        });
    }
}