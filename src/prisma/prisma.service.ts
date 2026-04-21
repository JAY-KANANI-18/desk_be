import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

function buildDatabaseUrl() {
    const rawUrl = process.env.DATABASE_URL;
    if (!rawUrl) return undefined;

    try {
        const url = new URL(rawUrl);
        const connectionLimit = process.env.PRISMA_CONNECTION_LIMIT || process.env.DATABASE_CONNECTION_LIMIT;
        const poolTimeout = process.env.PRISMA_POOL_TIMEOUT || process.env.DATABASE_POOL_TIMEOUT;

        if (connectionLimit && !url.searchParams.has('connection_limit')) {
            url.searchParams.set('connection_limit', connectionLimit);
        }

        if (poolTimeout && !url.searchParams.has('pool_timeout')) {
            url.searchParams.set('pool_timeout', poolTimeout);
        }

        return url.toString();
    } catch {
        return rawUrl;
    }
}

function buildPrismaOptions(): Prisma.PrismaClientOptions {
    const url = buildDatabaseUrl();
    return url ? { datasources: { db: { url } } } : {};
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
    constructor() {
        super(buildPrismaOptions());
    }

    async onModuleInit() {
        await this.$connect();
    }

    async onModuleDestroy() {
        await this.$disconnect();
    }
}
