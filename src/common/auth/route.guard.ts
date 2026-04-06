import {
    CanActivate,
    ExecutionContext,
    Injectable,
    UnauthorizedException,
    ForbiddenException,
    BadRequestException,
    OnModuleInit,
    Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { HttpAdapterHost } from '@nestjs/core';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import { ROUTE_ACCESS_KEY, RouteAccessConfig } from './route-access.decorator';
import {
    ORG_ROLE_PERMISSIONS,
    WS_ROLE_PERMISSIONS,
    OrgPermission,
    WorkspacePermission,
} from '../constants/permissions';

@Injectable()
export class RouteGuard implements CanActivate, OnModuleInit {
    private readonly logger = new Logger('RouteGuard');

    constructor(
        private reflector: Reflector,
        private discoveryService: DiscoveryService,
        private metadataScanner: MetadataScanner,
    ) { }

    // ── Boot log ───────────────────────────────────────────────────────────────
    onModuleInit() {
        this.logger.log('');
        this.logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        this.logger.log('  ROUTE ACCESS MANIFEST');
        this.logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        const controllers = this.discoveryService.getControllers();

        const rows: {
            type: string;
            route: string;
            permissions: string;
            handler: string;
        }[] = [];

        for (const wrapper of controllers) {
            const { instance } = wrapper;
            if (!instance || !Object.getPrototypeOf(instance)) continue;

            const controllerPath: string =
                Reflect.getMetadata('path', instance.constructor) ?? '';

            const methodNames = this.metadataScanner.getAllMethodNames(
                Object.getPrototypeOf(instance),
            );

            for (const methodName of methodNames) {
                const handler = instance[methodName];
                if (!handler) continue;

                // Get HTTP method + path from NestJS metadata
                const routePath: string =
                    Reflect.getMetadata('path', handler) ?? '';
                const httpMethod: string =
                    Reflect.getMetadata('method', handler) ?? '';

                if (!httpMethod) continue; // not an HTTP handler

                const access = this.reflector.getAllAndOverride<RouteAccessConfig>(
                    ROUTE_ACCESS_KEY,
                    [handler, instance.constructor],
                );

                const fullPath = `/${controllerPath}/${routePath}`
                    .replace(/\/+/g, '/')   // remove double slashes
                    .replace(/\/$/, '');    // remove trailing slash

                const httpVerb = this.methodToVerb(httpMethod);

                // add this small helper above the rows.push()
                const getPermissions = (access: RouteAccessConfig | undefined): string => {
                    if (!access) return '—';
                    if (access.type === 'org' || access.type === 'workspace') {
                        return access.permissions?.join(', ') || '—';
                    }
                    return '—';
                };

                // then in rows.push()
                rows.push({
                    type: access?.type?.toUpperCase() ?? '⚠ MISSING',
                    route: `${httpVerb} ${fullPath}`,
                    permissions: getPermissions(access),
                    handler: `${instance.constructor.name}.${methodName}`,
                });
            }
        }

        // Sort: missing first (so they're obvious), then by type, then by route
        rows.sort((a, b) => {
            if (a.type === '⚠ MISSING' && b.type !== '⚠ MISSING') return -1;
            if (b.type === '⚠ MISSING' && a.type !== '⚠ MISSING') return 1;
            return a.route.localeCompare(b.route);
        });

        // Print table
        for (const row of rows) {
            const typeLabel = this.colorType(row.type);
            const permLabel = row.permissions !== '—'
                ? `\x1b[90m[${row.permissions}]\x1b[0m`
                : '';

            this.logger.log(
                `  ${typeLabel.padEnd(20)} ${row.route.padEnd(55)} ${permLabel}`
            );
        }

        // Warn about unprotected routes
        const missing = rows.filter(r => r.type === '⚠ MISSING');
        if (missing.length) {
            this.logger.warn('');
            this.logger.warn(`  ⚠  ${missing.length} route(s) have no @Access decorator:`);
            for (const r of missing) {
                this.logger.warn(`     ${r.route}  →  ${r.handler}`);
            }
        }

        this.logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        this.logger.log('');
    }

    // ── Guard logic (unchanged) ────────────────────────────────────────────────
    async canActivate(ctx: ExecutionContext): Promise<boolean> {
        const access = this.reflector.getAllAndOverride<RouteAccessConfig>(
            ROUTE_ACCESS_KEY,
            [ctx.getHandler(), ctx.getClass()],
        );

        if (!access) {
            throw new ForbiddenException(
                'This route has no @Access decorator. Add one to the controller.',
            );
        }

        const request = ctx.switchToHttp().getRequest();
        return this.enforce(access, request);
    }

    private async enforce(access: RouteAccessConfig, request: any): Promise<boolean> {
        if (access.type === 'public') return true;

        if (!request.user) throw new UnauthorizedException('Authentication required');
        if (access.type === 'jwt') return true;

        if (access.type === 'org') {
            const organizationId =
                request.headers['x-organization-id'] ??
                request.params?.organizationId;

            if (!organizationId) {
                throw new BadRequestException('X-Organization-Id header is required');
            }

            const orgRole = request.user.orgRoles?.[organizationId];
            if (!orgRole) {
                throw new ForbiddenException('You are not a member of this organization');
            }

            request.organizationId = organizationId;
            request.orgRole = orgRole;

            if (access.permissions?.length) {
                const granted = ORG_ROLE_PERMISSIONS[orgRole] ?? [];
                const missing = (access.permissions as OrgPermission[])
                    .filter(p => !granted.includes(p));
                if (missing.length) {
                    throw new ForbiddenException(`Missing org permissions: ${missing.join(', ')}`);
                }
            }

            return true;
        }

        if (access.type === 'workspace') {
            const workspaceId =
                request.headers['x-workspace-id'] ??
                request.params?.workspaceId;

            if (!workspaceId) {
                throw new BadRequestException('X-Workspace-Id header is required');
            }

            const wsRole = request.user.workspaceRoles?.[workspaceId];
            if (!wsRole) {
                throw new ForbiddenException('You do not have access to this workspace');
            }

            request.workspaceId = workspaceId;
            request.workspaceRole = wsRole;

            const isOrgAdmin = Object.values(request.user.orgRoles ?? {})
                .includes('ORG_ADMIN');

            if (access.permissions?.length && !isOrgAdmin) {
                const granted = WS_ROLE_PERMISSIONS[wsRole] ?? [];
                const missing = (access.permissions as WorkspacePermission[])
                    .filter(p => !granted.includes(p));
                if (missing.length) {
                    throw new ForbiddenException(`Missing workspace permissions: ${missing.join(', ')}`);
                }
            }

            return true;
        }

        return false;
    }

    // ── Helpers ────────────────────────────────────────────────────────────────
    private methodToVerb(method: number | string): string {
        const map: Record<string, string> = {
            '0': 'GET', '1': 'POST', '2': 'PUT',
            '3': 'DELETE', '4': 'PATCH', '5': 'ALL',
            '6': 'OPTIONS', '7': 'HEAD',
        };
        return map[String(method)] ?? String(method);
    }

    private colorType(type: string): string {
        const colors: Record<string, string> = {
            'PUBLIC': '\x1b[32mPUBLIC\x1b[0m',       // green
            'JWT': '\x1b[36mJWT\x1b[0m',           // cyan
            'ORG': '\x1b[35mORG\x1b[0m',           // magenta
            'WORKSPACE': '\x1b[34mWORKSPACE\x1b[0m',     // blue
            '⚠ MISSING': '\x1b[31m⚠ MISSING\x1b[0m',    // red
        };
        return colors[type] ?? type;
    }
}