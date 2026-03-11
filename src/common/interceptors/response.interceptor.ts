import {
    CallHandler,
    ExecutionContext,
    Injectable,
    NestInterceptor,
} from '@nestjs/common';
import { map } from 'rxjs/operators';

@Injectable()
export class ResponseInterceptor implements NestInterceptor {
    intercept(context: ExecutionContext, next: CallHandler) {
        const req = context.switchToHttp().getRequest();

        return next.handle().pipe(
            map((data) => ({
                success: true,
                data: data,
                meta: {
                    requestId: req.id || null,
                    timestamp: new Date().toISOString(),
                },
                error: null,
            })),
        );
    }
}