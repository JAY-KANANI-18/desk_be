import { v4 as uuid } from 'uuid';
import { Injectable, NestMiddleware } from '@nestjs/common';

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
    use(req: any, res: any, next: () => void) {
        req.id = uuid();
        next();
    }
}