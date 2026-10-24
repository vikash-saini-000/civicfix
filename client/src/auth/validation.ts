import { ROLES, type AuthSession, type AuthUser, type DepartmentMembership, type Role } from '../api/authTypes';

export class AuthContractError extends Error {
  readonly name = 'AuthContractError';
}

export function parseAuthUser(value: unknown): AuthUser {
  if (!isRecord(value)) throw new AuthContractError('The authentication service returned an invalid user.');
  const id = stringField(value.id);
  const email = stringField(value.email);
  const displayName = stringField(value.displayName ?? value.name);
  const role = parseRole(value.role);
  if (!id || !email || !displayName || !role) {
    throw new AuthContractError('The authentication service returned an incomplete user.');
  }

  const memberships = value.departmentMemberships;
  return {
    id,
    email,
    displayName,
    role,
    ...(memberships === undefined ? {} : { departmentMemberships: parseMemberships(memberships) }),
  };
}

export function parseAuthSession(value: unknown): AuthSession {
  if (!isRecord(value) || !('user' in value)) {
    throw new AuthContractError('The authentication service returned an invalid session.');
  }
  return { user: parseAuthUser(value.user) };
}

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

function parseRole(value: unknown): Role | null {
  return isRole(value) ? value : null;
}

function parseMemberships(value: unknown): DepartmentMembership[] {
  if (!Array.isArray(value)) throw new AuthContractError('The authentication service returned invalid memberships.');
  return value.map((membership) => {
    if (!isRecord(membership) || typeof membership.departmentId !== 'string') {
      throw new AuthContractError('The authentication service returned invalid memberships.');
    }
    if (membership.role !== 'member' && membership.role !== 'manager') {
      throw new AuthContractError('The authentication service returned an invalid membership role.');
    }
    return {
      departmentId: membership.departmentId,
      ...(typeof membership.departmentName === 'string' ? { departmentName: membership.departmentName } : {}),
      role: membership.role,
    };
  });
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
