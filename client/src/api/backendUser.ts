import type { AuthUser, DepartmentMembership, Role } from './authTypes';
import { AuthContractError } from '../auth/validation';

/**
 * Maps the backend user (docs/api/AUTHENTICATION.md):
 *   { id, name, email, platformRole, roles[], memberships: [{ departmentId, role: 'MEMBER' | 'MANAGER' }] }
 * to the client's AuthUser. The client shows one primary workspace per user:
 * platform admin > department manager > department member > citizen.
 */
export function mapBackendUser(value: unknown, departmentNames: ReadonlyMap<string, string> = new Map()): AuthUser {
  if (!isRecord(value)) throw new AuthContractError('The authentication service returned an invalid user.');
  const id = stringField(value.id);
  const email = stringField(value.email);
  const displayName = stringField(value.name ?? value.displayName);
  if (!id || !email || !displayName) throw new AuthContractError('The authentication service returned an incomplete user.');

  const memberships = parseMemberships(value.memberships, departmentNames);
  const roles = Array.isArray(value.roles) ? value.roles.filter((r): r is string => typeof r === 'string') : [];
  const platformRole = stringField(value.platformRole);

  return {
    id,
    email,
    displayName,
    role: primaryRole(platformRole, roles, memberships),
    departmentMemberships: memberships,
  };
}

function primaryRole(platformRole: string | null, roles: string[], memberships: DepartmentMembership[]): Role {
  if (platformRole === 'PLATFORM_ADMIN' || roles.includes('PLATFORM_ADMIN')) return 'platform_admin';
  if (memberships.some((m) => m.role === 'manager')) return 'department_manager';
  if (memberships.length > 0) return 'department_member';
  return 'citizen';
}

function parseMemberships(value: unknown, names: ReadonlyMap<string, string>): DepartmentMembership[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new AuthContractError('The authentication service returned invalid memberships.');
  return value.flatMap((m): DepartmentMembership[] => {
    if (!isRecord(m) || typeof m.departmentId !== 'string' || !m.departmentId) return [];
    const role = m.role === 'MANAGER' ? 'manager' : m.role === 'MEMBER' ? 'member' : null;
    if (!role) return [];
    const departmentName = names.get(m.departmentId);
    return [{ departmentId: m.departmentId, role, ...(departmentName ? { departmentName } : {}) }];
  });
}

/** Department IDs the user belongs to, read from a raw backend user. */
export function membershipDepartmentIds(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.memberships)) return [];
  return value.memberships.flatMap((m) => (isRecord(m) && typeof m.departmentId === 'string' ? [m.departmentId] : []));
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
