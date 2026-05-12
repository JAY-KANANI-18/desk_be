import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtOnly } from 'src/common/auth/route-access.decorator';
import { PlatformAdminRoute } from './platform-admin-access.decorator';
import {
  PlatformAdminGuard,
  type PlatformAdminRequest,
} from './platform-admin.guard';
import { PlatformPermission } from './platform-admin.permissions';
import { PlatformAdminService } from './platform-admin.service';
import { PlatformAdminListQueryDto } from './dto/platform-admin-list-query.dto';

@Controller('api/platform-admin')
@JwtOnly()
@UseGuards(PlatformAdminGuard)
export class PlatformAdminController {
  constructor(private readonly platformAdminService: PlatformAdminService) {}

  @Get('me')
  @PlatformAdminRoute()
  getMe(@Req() request: PlatformAdminRequest) {
    return this.platformAdminService.getMe(request.platformAdmin);
  }

  @Get('dashboard')
  @PlatformAdminRoute(PlatformPermission.DASHBOARD_VIEW)
  getDashboard() {
    return this.platformAdminService.getDashboard();
  }

  @Get('organizations')
  @PlatformAdminRoute(PlatformPermission.ORGANIZATIONS_VIEW)
  listOrganizations(@Query() query: PlatformAdminListQueryDto) {
    return this.platformAdminService.listOrganizations(query);
  }

  @Get('organizations/:organizationId')
  @PlatformAdminRoute(PlatformPermission.ORGANIZATIONS_VIEW)
  async getOrganization(@Param('organizationId') organizationId: string) {
    return this.requireFound(
      await this.platformAdminService.getOrganization(organizationId),
      'Organization',
    );
  }

  @Get('workspaces')
  @PlatformAdminRoute(PlatformPermission.WORKSPACES_VIEW)
  listWorkspaces(@Query() query: PlatformAdminListQueryDto) {
    return this.platformAdminService.listWorkspaces(query);
  }

  @Get('workspaces/:workspaceId')
  @PlatformAdminRoute(PlatformPermission.WORKSPACES_VIEW)
  async getWorkspace(@Param('workspaceId') workspaceId: string) {
    return this.requireFound(
      await this.platformAdminService.getWorkspace(workspaceId),
      'Workspace',
    );
  }

  @Get('users')
  @PlatformAdminRoute(PlatformPermission.USERS_VIEW)
  listUsers(@Query() query: PlatformAdminListQueryDto) {
    return this.platformAdminService.listUsers(query);
  }

  @Get('users/:userId')
  @PlatformAdminRoute(PlatformPermission.USERS_VIEW)
  async getUser(@Param('userId') userId: string) {
    return this.requireFound(
      await this.platformAdminService.getUser(userId),
      'User',
    );
  }

  @Get('billing')
  @PlatformAdminRoute(PlatformPermission.BILLING_VIEW)
  listBilling(@Query() query: PlatformAdminListQueryDto) {
    return this.platformAdminService.listBilling(query);
  }

  @Get('usage')
  @PlatformAdminRoute(PlatformPermission.USAGE_VIEW)
  listUsage(@Query() query: PlatformAdminListQueryDto) {
    return this.platformAdminService.listUsage(query);
  }

  @Get('channels')
  @PlatformAdminRoute(PlatformPermission.CHANNELS_VIEW)
  listChannels(@Query() query: PlatformAdminListQueryDto) {
    return this.platformAdminService.listChannels(query);
  }

  @Get('system')
  @PlatformAdminRoute(PlatformPermission.SYSTEM_VIEW)
  listSystemHealth() {
    return this.platformAdminService.listSystemHealth();
  }

  @Get('audit')
  @PlatformAdminRoute(PlatformPermission.AUDIT_VIEW)
  listAuditLogs(@Query() query: PlatformAdminListQueryDto) {
    return this.platformAdminService.listAuditLogs(query);
  }

  @Get('settings')
  @PlatformAdminRoute(PlatformPermission.SETTINGS_VIEW)
  getSettings(@Req() request: PlatformAdminRequest) {
    return {
      admin: this.platformAdminService.getMe(request.platformAdmin),
      envAccess:
        'Platform roles are currently resolved from PLATFORM_*_EMAILS environment variables.',
    };
  }

  private requireFound<T>(value: T | null, entityName: string): T {
    if (!value) {
      throw new NotFoundException(`${entityName} not found`);
    }

    return value;
  }
}
