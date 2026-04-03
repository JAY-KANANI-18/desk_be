import {
    CanActivate,
    ExecutionContext,
    Injectable,
    UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { verifySupabaseToken } from './supabase-jwt';
import { ForbiddenException } from '@nestjs/common';

@Injectable()
export class JwtGuard implements CanActivate {
    constructor(private prisma: PrismaService) { }

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const req = context.switchToHttp().getRequest();
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {

            throw new UnauthorizedException('Missing token');
        }

        const token = authHeader.replace('Bearer ', '');

        let payload: any;

        try {
            payload = await verifySupabaseToken(token);
        } catch {
            throw new UnauthorizedException('Invalid token');
        }
        // console.log({ payload });

        const userId = payload.sub;
        const email = payload.email;

        const dbUser = await this.prisma.user.upsert({
            where: { email: email },
            update: {  status: 'ACTIVE' }, // Set to ACTIVE if password is already set, otherwise PENDING),},
            create: {
                id: userId,
                email,
                firstName: email?.split('@')[0] ?? 'User',
             status: 'ACTIVE' // Set to ACTIVE if password is already set, otherwise PENDING),
            },

            // get workspace
            include: {
                organizationMemberships: true,
                workspaceMemberships: true,
            },
        });

        req.user = dbUser;


        // allow password setup route
        const route = req.route?.path;


        // block pending users everywhere else
        if (dbUser.status !== 'ACTIVE') {
            throw new ForbiddenException(
                'Account not activated. Please set your password.'
            );
        }

        return true;
    }
}