export const ROLES = ['citizen', 'department_member', 'department_manager', 'platform_admin'] as const;
export type Role = (typeof ROLES)[number];

export interface DepartmentMembership {
  departmentId: string;
  departmentName?: string;
  role: 'member' | 'manager';
}

/** Provisional client contract: the backend auth schema is proposed, not implemented yet. */
export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  departmentMemberships?: DepartmentMembership[];
}

export interface LoginCredentials {
  email: string;
  password: string;
}

export interface AuthSession {
  user: AuthUser;
}

export interface AuthApi {
  login(credentials: LoginCredentials, signal?: AbortSignal): Promise<AuthSession>;
  getCurrentUser(signal?: AbortSignal): Promise<AuthUser | null>;
  logout(signal?: AbortSignal): Promise<void>;
}
