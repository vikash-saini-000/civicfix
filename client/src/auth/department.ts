import type { AuthUser, DepartmentMembership } from '../api/authTypes';

export interface DepartmentContext {
  departmentId: string;
  departmentName?: string;
  membershipRole: DepartmentMembership['role'];
}

export function membershipsForUser(user: AuthUser): DepartmentMembership[] {
  return (user.departmentMemberships ?? []).filter((membership) => membership.departmentId.trim().length > 0);
}

/**
 * Select only from memberships supplied by the authenticated session.
 * A URL value can choose among trusted memberships, but cannot create context.
 */
export function selectDepartmentContext(user: AuthUser, requestedDepartmentId?: string | null): DepartmentContext | null {
  const memberships = membershipsForUser(user);
  if (memberships.length === 0) return null;

  const membership = requestedDepartmentId
    ? memberships.find((candidate) => candidate.departmentId === requestedDepartmentId)
    : memberships[0];
  if (!membership) return null;

  return {
    departmentId: membership.departmentId,
    ...(membership.departmentName ? { departmentName: membership.departmentName } : {}),
    membershipRole: membership.role,
  };
}
