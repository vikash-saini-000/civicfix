import type { AuthApi, AuthSession, AuthUser, LoginCredentials } from './authTypes';
import { ApiError } from './errors';

interface DemoAccount {
  email: string;
  password: string;
  user: AuthUser;
}

const DEMO_ACCOUNTS: DemoAccount[] = [
  {
    email: 'citizen@example.test',
    password: 'demo-password',
    user: { id: 'mock-citizen-001', email: 'citizen@example.test', displayName: 'Demo Citizen', role: 'citizen' },
  },
  {
    email: 'member@example.test',
    password: 'demo-password',
    user: {
      id: 'mock-member-001',
      email: 'member@example.test',
      displayName: 'Demo Department Member',
      role: 'department_member',
      departmentMemberships: [{ departmentId: 'roads', departmentName: 'Roads and Public Works', role: 'member' }],
    },
  },
  {
    email: 'manager@example.test',
    password: 'demo-password',
    user: {
      id: 'mock-manager-001',
      email: 'manager@example.test',
      displayName: 'Demo Department Manager',
      role: 'department_manager',
      departmentMemberships: [{ departmentId: 'roads', departmentName: 'Roads and Public Works', role: 'manager' }],
    },
  },
  {
    email: 'admin@example.test',
    password: 'demo-password',
    user: { id: 'mock-admin-001', email: 'admin@example.test', displayName: 'Demo Platform Admin', role: 'platform_admin' },
  },
];

export const MOCK_AUTH_MODE_LABEL = 'Development mock authentication';

export function createMockAuthApi(): AuthApi {
  let currentUser: AuthUser | null = null;

  return {
    async login(credentials: LoginCredentials): Promise<AuthSession> {
      const account = DEMO_ACCOUNTS.find(
        (candidate) => candidate.email === credentials.email.trim().toLowerCase() && candidate.password === credentials.password,
      );
      if (!account) {
        throw new ApiError('The email or password is incorrect.', 401, 'INVALID_CREDENTIALS');
      }
      currentUser = structuredClone(account.user);
      return { user: structuredClone(currentUser) };
    },

    async register(): Promise<AuthSession> {
      throw new ApiError('Registration needs the CivicFix backend.', 501, 'BACKEND_REQUIRED');
    },

    async getCurrentUser() {
      return currentUser ? structuredClone(currentUser) : null;
    },

    async logout() {
      currentUser = null;
    },
  };
}
