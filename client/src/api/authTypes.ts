export const ROLES = ['citizen', 'department_member', 'department_manager', 'platform_admin'] as const;
export type Role = (typeof ROLES)[number];

export interface DepartmentMembership {
  departmentId: string;
  departmentName?: string;
  role: 'member' | 'manager';
}

/** Client view of the signed-in user. The HTTP adapter maps the backend user (docs/api/AUTHENTICATION.md) to this shape. */
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

export interface RegisterInput {
  name: string;
  email: string;
  password: string;
}

export interface AuthApi {
  login(credentials: LoginCredentials, signal?: AbortSignal): Promise<AuthSession>;
  /** Creates a citizen account and signs in. Absent in adapters without registration. */
  register?(input: RegisterInput, signal?: AbortSignal): Promise<AuthSession>;
  getCurrentUser(signal?: AbortSignal): Promise<AuthUser | null>;
  logout(signal?: AbortSignal): Promise<void>;
}
