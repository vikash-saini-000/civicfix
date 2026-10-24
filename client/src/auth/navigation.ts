import type { Role } from '../api/authTypes';

export interface NavigationItem {
  label: string;
  to: string;
  end?: boolean;
}

export const ROLE_LABELS: Record<Role, string> = {
  citizen: 'Citizen',
  department_member: 'Department member',
  department_manager: 'Department manager',
  platform_admin: 'Platform administrator',
};

const ROLE_DEFAULT_PATHS: Record<Role, string> = {
  citizen: '/citizen/dashboard',
  department_member: '/department',
  department_manager: '/manager',
  platform_admin: '/admin',
};

const ROLE_NAVIGATION: Record<Role, NavigationItem[]> = {
  citizen: [
    { label: 'Dashboard', to: '/citizen/dashboard', end: true },
    { label: 'My complaints', to: '/citizen/complaints' },
    { label: 'Report an issue', to: '/citizen/complaints/new' },
  ],
  department_member: [
    { label: 'Department workspace', to: '/department', end: true },
    { label: 'Department complaints', to: '/department/complaints' },
    { label: 'Assigned work', to: '/department/work' },
  ],
  department_manager: [
    { label: 'Department overview', to: '/manager', end: true },
    { label: 'Complaint review', to: '/manager/review' },
    { label: 'Assignment exceptions', to: '/manager/exceptions' },
    { label: 'Resolution review', to: '/manager/resolution-review' },
  ],
  platform_admin: [
    { label: 'Platform overview', to: '/admin', end: true },
    { label: 'Departments', to: '/admin/departments' },
    { label: 'Users', to: '/admin/users' },
  ],
};

export function defaultPathForRole(role: Role): string {
  return ROLE_DEFAULT_PATHS[role];
}

export function navigationForRole(role: Role): NavigationItem[] {
  return ROLE_NAVIGATION[role];
}

export function safeInternalPath(value: string | null | undefined): string | null {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return null;
  try {
    const url = new URL(value, window.location.origin);
    if (url.origin !== window.location.origin) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

export function loginPathForDestination(destination: string): string {
  return `/login?next=${encodeURIComponent(destination)}`;
}
