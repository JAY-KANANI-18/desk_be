// route-access.decorator.ts

import { SetMetadata } from "@nestjs/common";
import { OrgPermission, WorkspacePermission } from "../constants/permissions";

export type RouteAccessConfig =
  | { type: 'public' }
  | { type: 'jwt' }
  | { type: 'org';       permissions?: OrgPermission[] }
  | { type: 'workspace'; permissions?: WorkspacePermission[] };

export const ROUTE_ACCESS_KEY = 'route_access';

export const Access = (config: RouteAccessConfig) =>
  SetMetadata(ROUTE_ACCESS_KEY, config);

export const Public         = () => Access({ type: 'public' });
export const JwtOnly        = () => Access({ type: 'jwt' });
export const OrgRoute       = (...permissions: OrgPermission[]) =>
  Access({ type: 'org', permissions });
export const WorkspaceRoute = (...permissions: WorkspacePermission[]) =>
  Access({ type: 'workspace', permissions });