import type { MembershipRole, PlatformRole } from '../models/enums.js';

/**
 * Canonical role names used by guards. Platform roles come from User.platformRole;
 * department roles come from active DepartmentMembership records in active departments.
 */
export const ROLES = ['CITIZEN', 'DEPARTMENT_MEMBER', 'DEPARTMENT_MANAGER', 'PLATFORM_ADMIN'] as const;
export type Role = (typeof ROLES)[number];

export interface MembershipSummary {
  departmentId: string;
  role: MembershipRole;
}

/** The authenticated identity for one request. Built only from verified token + stored records. */
export interface Principal {
  userId: string;
  sessionId: string;
  name: string;
  email: string;
  platformRole: PlatformRole;
  memberships: MembershipSummary[];
  roles: ReadonlySet<Role>;
}

const PLATFORM_ROLE_MAP: Record<PlatformRole, Role> = { CITIZEN: 'CITIZEN', PLATFORM_ADMIN: 'PLATFORM_ADMIN' };
const MEMBERSHIP_ROLE_MAP: Record<MembershipRole, Role> = { MEMBER: 'DEPARTMENT_MEMBER', MANAGER: 'DEPARTMENT_MANAGER' };

/** Unknown stored values map to nothing, so they grant nothing. */
export function deriveRoles(platformRole: string, memberships: MembershipSummary[]): Set<Role> {
  const roles = new Set<Role>();
  const platform = PLATFORM_ROLE_MAP[platformRole as PlatformRole];
  if (platform) roles.add(platform);
  for (const m of memberships) {
    const role = MEMBERSHIP_ROLE_MAP[m.role];
    if (role) roles.add(role);
  }
  return roles;
}
